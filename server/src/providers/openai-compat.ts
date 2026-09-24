import type { Usage } from '@controltower/shared';
import { SseParser } from '../streaming/sse.js';
import {
  normalizeHttpError,
  type AdapterResult,
  type ProviderAdapter,
  type SendOptions,
  type UpstreamCtx,
  type UpstreamEvent,
  type WireDialect,
} from './adapter.js';
import { readBodyText, sendUpstream } from './http.js';
import type { ProviderRecord } from '../registry.js';

/**
 * One adapter for every OpenAI-wire provider: OpenAI, Azure OpenAI, Groq,
 * Together, Fireworks, Mistral, DeepSeek, xAI, OpenRouter, Perplexity,
 * Ollama, vLLM, LM Studio and any custom base URL. Differences are confined
 * to URL shape and auth header. Bodies are forwarded as-is (plus a model
 * rename and `stream_options.include_usage`), responses are tapped for usage
 * and forwarded byte-for-byte.
 */
export type AuthStyle = 'bearer' | 'api-key-header' | 'azure' | 'none';

const DEFAULT_BASE: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
};

function baseUrl(p: ProviderRecord): string {
  const b = (p.baseUrl ?? DEFAULT_BASE[p.kind] ?? '').replace(/\/+$/, '');
  return b;
}

function authStyle(p: ProviderRecord): AuthStyle {
  if (p.kind === 'azure-openai') return 'azure';
  const s = p.extra.auth_style as AuthStyle | undefined;
  if (s) return s;
  return p.creds.api_key ? 'bearer' : 'none';
}

export function buildUrl(p: ProviderRecord, path: 'chat/completions' | 'embeddings' | 'responses' | 'models', model?: string): string {
  const base = baseUrl(p);
  if (p.kind === 'azure-openai') {
    // Azure serves the Responses API on its v1 surface, addressed by deployment name in the body.
    if (path === 'responses') return `${base}/openai/v1/responses`;
    const ver = (p.extra.api_version as string | undefined) ?? '2024-10-21';
    if (path === 'models') return `${base}/openai/models?api-version=${ver}`;
    return `${base}/openai/deployments/${encodeURIComponent(model ?? '')}/${path}?api-version=${ver}`;
  }
  return `${base}/${path}`;
}

export function buildHeaders(p: ProviderRecord): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  const key = p.creds.api_key;
  switch (authStyle(p)) {
    case 'bearer':
      if (key) h.authorization = `Bearer ${key}`;
      break;
    case 'api-key-header':
      if (key) h['api-key'] = key;
      break;
    case 'azure':
      if (key) h['api-key'] = key;
      break;
    case 'none':
      break;
  }
  if (p.kind === 'openai' && typeof p.extra.organization === 'string') h['openai-organization'] = p.extra.organization;
  const extraHeaders = p.extra.headers as Record<string, string> | undefined;
  if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) h[k.toLowerCase()] = v;
  return h;
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  // Some providers (DeepSeek) use these.
  prompt_cache_hit_tokens?: number;
}

export function mapUsage(u: OpenAIUsage | undefined | null): Usage | undefined {
  if (!u || typeof u.prompt_tokens !== 'number') return undefined;
  const cached = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0;
  const out: Usage = {
    input: Math.max(0, u.prompt_tokens - cached),
    output: u.completion_tokens ?? 0,
    cacheRead: cached,
    cacheWrite: 0,
  };
  const reasoning = u.completion_tokens_details?.reasoning_tokens;
  if (typeof reasoning === 'number' && reasoning > 0) {
    out.reasoning = reasoning;
    out.output = Math.max(0, out.output - reasoning);
  }
  return out;
}

/** Responses API usage: input/output tokens with cached and reasoning details. */
interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

export function mapResponsesUsage(u: ResponsesUsage | undefined | null): Usage | undefined {
  if (!u || typeof u.input_tokens !== 'number') return undefined;
  return mapUsage({
    prompt_tokens: u.input_tokens,
    completion_tokens: u.output_tokens ?? 0,
    prompt_tokens_details: { cached_tokens: u.input_tokens_details?.cached_tokens ?? 0 },
    completion_tokens_details: { reasoning_tokens: u.output_tokens_details?.reasoning_tokens ?? 0 },
  });
}

export class OpenAICompatAdapter implements ProviderAdapter {
  readonly nativeDialects: ReadonlySet<WireDialect> = new Set(['openai-chat', 'openai-responses']);
  readonly caps = { streamUsage: 'probe' as const, embeddings: true, listModels: true };

  constructor(readonly kind: 'openai' | 'azure-openai' | 'openai-compatible') {}

  async send(ctx: UpstreamCtx, body: Record<string, unknown>, opts: SendOptions): Promise<AdapterResult> {
    const p = ctx.provider;
    const responses = opts.inboundDialect === 'openai-responses';
    const path = responses ? 'responses' : opts.stream || Array.isArray(body.messages) ? 'chat/completions' : 'embeddings';
    const url = buildUrl(p, !responses && body.input !== undefined && body.messages === undefined ? 'embeddings' : path, opts.upstreamModel);
    const headers = buildHeaders(p);

    // The Responses API always reports usage (in response.completed); stream_options is chat-only.
    const wantUsage = opts.stream && !responses && p.streamUsageSupported !== false;
    const outBody: Record<string, unknown> = { ...body, model: opts.upstreamModel };
    if (opts.stream && wantUsage) {
      outBody.stream_options = { ...((body.stream_options as Record<string, unknown>) ?? {}), include_usage: true };
    }
    // Never forward our own control fields.
    delete outBody.ct;

    let r = await sendUpstream(p.slug, { url, method: 'POST', headers, body: JSON.stringify(outBody) }, ctx.signal, {
      headersTimeoutMs: typeof ctx.deployment.caps.headers_timeout_ms === 'number' ? ctx.deployment.caps.headers_timeout_ms : undefined,
    });
    if (!r.ok) return { kind: 'error', err: r.err };

    // Probe: some OpenAI-compatible servers reject stream_options.
    if (r.res.status === 400 && opts.stream && wantUsage) {
      const text = await readBodyText(r.res.body);
      if (/stream_options/i.test(text)) {
        p.streamUsageSupported = false;
        delete outBody.stream_options;
        r = await sendUpstream(p.slug, { url, method: 'POST', headers, body: JSON.stringify(outBody) }, ctx.signal);
        if (!r.ok) return { kind: 'error', err: r.err };
      } else {
        return { kind: 'error', err: normalizeHttpError(400, text, p.slug) };
      }
    }

    const res = r.res;
    if (res.status < 200 || res.status >= 300) {
      const text = await readBodyText(res.body);
      return { kind: 'error', err: normalizeHttpError(res.status, text, p.slug) };
    }

    ctx.onFirstByte?.();
    const ctype = res.headers['content-type'] ?? '';
    if (!opts.stream || !ctype.includes('text/event-stream')) {
      const text = await readBodyText(res.body, 32 * 1024 * 1024);
      let usage: Usage | undefined;
      try {
        const j = JSON.parse(text) as { usage?: OpenAIUsage & ResponsesUsage };
        usage = responses ? mapResponsesUsage(j.usage) : mapUsage(j.usage);
      } catch {
        /* pass through as-is */
      }
      return { kind: 'json', status: res.status, contentType: ctype || 'application/json', body: Buffer.from(text), usage };
    }

    return { kind: 'stream', status: res.status, contentType: 'text/event-stream', events: responses ? this.tapResponses(res.body, ctx) : this.tap(res.body, ctx) };
  }

  private async *tap(body: AsyncIterable<Uint8Array | Buffer>, ctx: UpstreamCtx): AsyncIterable<UpstreamEvent> {
    const parser = new SseParser();
    let sawUsage = false;
    const handle = (f: { raw: Uint8Array; data: string }): UpstreamEvent[] => {
      const out: UpstreamEvent[] = [];
      if (!f.data) {
        out.push({ t: 'frame', raw: f.raw, hasContent: false }); // comment / keepalive
        return out;
      }
      if (f.data === '[DONE]') {
        out.push({ t: 'frame', raw: f.raw, hasContent: false });
        return out;
      }
      let j: { choices?: Array<{ delta?: { content?: unknown; tool_calls?: unknown } }>; usage?: OpenAIUsage; error?: { message?: string } } | undefined;
      try {
        j = JSON.parse(f.data) as typeof j;
      } catch {
        out.push({ t: 'frame', raw: f.raw, hasContent: false });
        return out;
      }
      if (j?.error) {
        out.push({ t: 'error', err: { code: 'provider_stream_error', message: j.error.message ?? 'upstream stream error', httpStatus: 502, fallback: false, cooldown: false } });
        return out;
      }
      const choices = j?.choices ?? [];
      const hasContent = choices.some((c) => (typeof c.delta?.content === 'string' && c.delta.content.length > 0) || !!c.delta?.tool_calls);
      const usage = mapUsage(j?.usage);
      if (usage) {
        sawUsage = true;
        out.push({ t: 'usage', usage, final: true });
      }
      out.push({ t: 'frame', raw: f.raw, hasContent, usageOnly: choices.length === 0 && !!usage, parsed: j });
      return out;
    };
    try {
      for await (const chunk of body) {
        if (ctx.signal.aborted) return;
        for (const f of parser.push(chunk)) for (const ev of handle(f)) yield ev;
      }
      for (const f of parser.end()) for (const ev of handle(f)) yield ev;
    } finally {
      if (!sawUsage) {
        // Usage stays unknown → the pipeline estimates and labels it.
      }
    }
    yield { t: 'done' };
  }

  /** Responses API stream: typed events; usage arrives in response.completed (or .incomplete / .failed). */
  private async *tapResponses(body: AsyncIterable<Uint8Array | Buffer>, ctx: UpstreamCtx): AsyncIterable<UpstreamEvent> {
    const parser = new SseParser();
    const handle = (f: { raw: Uint8Array; data: string }): UpstreamEvent[] => {
      if (!f.data) return [{ t: 'frame', raw: f.raw, hasContent: false }];
      let j: { type?: string; delta?: unknown; response?: { usage?: ResponsesUsage; error?: { message?: string } | null }; message?: string } | undefined;
      try {
        j = JSON.parse(f.data) as typeof j;
      } catch {
        return [{ t: 'frame', raw: f.raw, hasContent: false }];
      }
      const out: UpstreamEvent[] = [];
      if (j?.type === 'error') {
        out.push({ t: 'error', err: { code: 'provider_stream_error', message: j.message ?? 'upstream stream error', httpStatus: 502, fallback: false, cooldown: false } });
        return out;
      }
      const usage = mapResponsesUsage(j?.response?.usage);
      if (usage) out.push({ t: 'usage', usage, final: true });
      const hasContent = typeof j?.type === 'string' && j.type.endsWith('.delta') && typeof j.delta === 'string' && j.delta.length > 0;
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
    const r = await sendUpstream(provider.slug, { url: buildUrl(provider, 'models'), method: 'GET', headers: buildHeaders(provider) }, AbortSignal.timeout(15_000));
    if (!r.ok) throw new Error(r.err.message);
    const text = await readBodyText(r.res.body);
    if (r.res.status >= 300) throw new Error(normalizeHttpError(r.res.status, text, provider.slug).message);
    const j = JSON.parse(text) as { data?: Array<{ id: string; context_length?: number }>; models?: Array<{ name: string }> };
    if (Array.isArray(j.data)) return j.data.map((m) => ({ id: m.id, ...(m.context_length ? { context: m.context_length } : {}) })).sort((a, b) => a.id.localeCompare(b.id));
    if (Array.isArray(j.models)) return j.models.map((m) => ({ id: m.name })); // Ollama native
    return [];
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
