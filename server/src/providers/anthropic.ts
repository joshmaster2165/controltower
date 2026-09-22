import type { Usage } from '@controltower/shared';
import { SseParser } from '../streaming/sse.js';
import {
  normalizeHttpError,
  type AdapterResult,
  type ProviderAdapter,
  type SendOptions,
  type UpstreamCtx,
  type UpstreamEvent,
} from './adapter.js';
import { readBodyText, sendUpstream } from './http.js';
import type { ProviderRecord } from '../registry.js';

/**
 * Anthropic Messages API. Native dialect is `anthropic-messages`: a request
 * that arrives on /v1/messages is forwarded byte-for-byte (auth + model
 * rename), which is what keeps Claude Code's cache_control / thinking /
 * tool_use semantics intact. OpenAI-dialect requests are translated by the
 * pipeline before they reach `send`.
 */
const DEFAULT_BASE = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';

/** Headers a client may pass through to Anthropic (beta flags etc.). */
export const ANTHROPIC_PASSTHROUGH_HEADERS = ['anthropic-beta', 'anthropic-version'];

export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export function mapAnthropicUsage(u: AnthropicUsage | undefined | null): Partial<Usage> | undefined {
  if (!u) return undefined;
  const out: Partial<Usage> = {};
  if (typeof u.input_tokens === 'number') out.input = u.input_tokens;
  if (typeof u.output_tokens === 'number') out.output = u.output_tokens;
  if (typeof u.cache_read_input_tokens === 'number') out.cacheRead = u.cache_read_input_tokens;
  if (typeof u.cache_creation_input_tokens === 'number') out.cacheWrite = u.cache_creation_input_tokens;
  return Object.keys(out).length ? out : undefined;
}

function baseUrl(p: ProviderRecord): string {
  return (p.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
}

function headers(p: ProviderRecord, passthrough?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    'anthropic-version': API_VERSION,
  };
  if (p.creds.api_key) h['x-api-key'] = p.creds.api_key;
  if (passthrough) for (const [k, v] of Object.entries(passthrough)) h[k.toLowerCase()] = v;
  return h;
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly kind = 'anthropic' as const;
  readonly nativeDialects: ReadonlySet<'openai-chat' | 'anthropic-messages'> = new Set(['anthropic-messages']);
  readonly caps = { streamUsage: 'yes' as const, embeddings: false, listModels: true };

  async send(ctx: UpstreamCtx, body: Record<string, unknown>, opts: SendOptions): Promise<AdapterResult> {
    const p = ctx.provider;
    const outBody: Record<string, unknown> = { ...body, model: opts.upstreamModel };
    const passthrough = (outBody.ct as { passthrough_headers?: Record<string, string> } | undefined)?.passthrough_headers;
    delete outBody.ct;
    if (typeof outBody.max_tokens !== 'number') outBody.max_tokens = 4096; // required by the API

    const r = await sendUpstream(p.slug, { url: `${baseUrl(p)}/v1/messages`, method: 'POST', headers: headers(p, passthrough), body: JSON.stringify(outBody) }, ctx.signal, {
      headersTimeoutMs: typeof ctx.deployment.caps.headers_timeout_ms === 'number' ? ctx.deployment.caps.headers_timeout_ms : undefined,
    });
    if (!r.ok) return { kind: 'error', err: r.err };
    const res = r.res;
    if (res.status < 200 || res.status >= 300) {
      const text = await readBodyText(res.body);
      const err = normalizeHttpError(res.status, text, p.slug);
      // Anthropic returns 529 when overloaded; treat like 503.
      if (res.status === 529) err.code = 'provider_overloaded';
      return { kind: 'error', err };
    }
    ctx.onFirstByte?.();
    const ctype = res.headers['content-type'] ?? '';
    if (!opts.stream || !ctype.includes('text/event-stream')) {
      const text = await readBodyText(res.body, 32 * 1024 * 1024);
      let usage: Usage | undefined;
      try {
        const u = mapAnthropicUsage((JSON.parse(text) as { usage?: AnthropicUsage }).usage);
        if (u) usage = { input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0 };
      } catch {
        /* pass through */
      }
      return { kind: 'json', status: res.status, contentType: ctype || 'application/json', body: Buffer.from(text), usage };
    }
    return { kind: 'stream', status: res.status, contentType: 'text/event-stream', events: this.tap(res.body, ctx) };
  }

  private async *tap(body: AsyncIterable<Uint8Array | Buffer>, ctx: UpstreamCtx): AsyncIterable<UpstreamEvent> {
    const parser = new SseParser();
    let acc: Partial<Usage> = {};
    const handle = (f: { raw: Uint8Array; data: string; event: string | undefined }): UpstreamEvent[] => {
      const out: UpstreamEvent[] = [];
      if (!f.data) {
        out.push({ t: 'frame', raw: f.raw, hasContent: false });
        return out;
      }
      let j: Record<string, unknown> | undefined;
      try {
        j = JSON.parse(f.data) as Record<string, unknown>;
      } catch {
        out.push({ t: 'frame', raw: f.raw, hasContent: false });
        return out;
      }
      const type = (j.type as string) ?? f.event;
      let hasContent = false;
      switch (type) {
        case 'message_start': {
          const u = mapAnthropicUsage((j.message as { usage?: AnthropicUsage } | undefined)?.usage);
          if (u) {
            acc = { ...acc, ...u };
            out.push({ t: 'usage', usage: acc, final: false });
          }
          break;
        }
        case 'content_block_delta':
          hasContent = true;
          break;
        case 'message_delta': {
          const u = mapAnthropicUsage(j.usage as AnthropicUsage | undefined);
          if (u) {
            acc = { ...acc, ...u }; // output_tokens is cumulative: take last
            out.push({ t: 'usage', usage: acc, final: true });
          }
          break;
        }
        case 'error': {
          const e = j.error as { message?: string; type?: string } | undefined;
          out.push({ t: 'error', err: { code: 'provider_stream_error', message: e?.message ?? 'upstream stream error', httpStatus: 502, fallback: false, cooldown: e?.type === 'overloaded_error' } });
          return out;
        }
      }
      out.push({ t: 'frame', raw: f.raw, hasContent, parsed: j });
      return out;
    };
    for await (const chunk of body) {
      if (ctx.signal.aborted) return;
      for (const f of parser.push(chunk)) for (const ev of handle(f)) yield ev;
    }
    for (const f of parser.end()) for (const ev of handle(f)) yield ev;
    yield { t: 'done' };
  }

  async listModels(provider: ProviderRecord): Promise<Array<{ id: string; context?: number }>> {
    const r = await sendUpstream(provider.slug, { url: `${baseUrl(provider)}/v1/models?limit=100`, method: 'GET', headers: headers(provider) }, AbortSignal.timeout(15_000));
    if (!r.ok) throw new Error(r.err.message);
    const text = await readBodyText(r.res.body);
    if (r.res.status >= 300) throw new Error(normalizeHttpError(r.res.status, text, provider.slug).message);
    const j = JSON.parse(text) as { data?: Array<{ id: string }> };
    return (j.data ?? []).map((m) => ({ id: m.id })).sort((a, b) => a.id.localeCompare(b.id));
  }

  async healthCheck(provider: ProviderRecord): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    const t0 = Date.now();
    try {
      const models = await this.listModels(provider);
      return { ok: true, latencyMs: Date.now() - t0, detail: `${models.length} models visible` };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - t0, detail: (err as Error).message };
    }
  }
}
