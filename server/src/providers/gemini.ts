import type { Usage } from '@controltower/shared';
import { SseParser } from '../streaming/sse.js';
import { normalizeHttpError, type AdapterResult, type ProviderAdapter, type SendOptions, type UpstreamCtx, type UpstreamEvent } from './adapter.js';
import { readBodyText, sendUpstream } from './http.js';
import type { ProviderRecord } from '../registry.js';
import { GeminiToOaStream, geminiResponseToOa, oaRequestToGemini } from '../translate/openai-gemini.js';
import { mapUsage } from './openai-compat.js';

/**
 * Google Gemini API (generativelanguage.googleapis.com). OpenAI-native from
 * the pipeline's point of view: the request is translated to generateContent
 * and the SSE stream is synthesised back into OpenAI chunks.
 */
const DEFAULT_BASE = 'https://generativelanguage.googleapis.com';

function baseUrl(p: ProviderRecord): string {
  return (p.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
}

/** Shared by Gemini and Vertex: turn a Gemini SSE body into OpenAI-shaped events. */
export async function* geminiStreamToOa(body: AsyncIterable<Uint8Array | Buffer>, ctx: UpstreamCtx, model: string): AsyncIterable<UpstreamEvent> {
  const parser = new SseParser();
  const x = new GeminiToOaStream(model, true);
  const enc = new TextEncoder();
  const emit = (r: ReturnType<GeminiToOaStream['feed']>): UpstreamEvent[] =>
    r.frames.map((f) => ({ t: 'frame' as const, raw: enc.encode(f.text), hasContent: r.hasContent && typeof (f.parsed.choices as Array<{ delta?: { content?: string; tool_calls?: unknown } }> | undefined)?.[0]?.delta?.content === 'string' ? true : !!(f.parsed.choices as Array<{ delta?: { tool_calls?: unknown } }> | undefined)?.[0]?.delta?.tool_calls, parsed: f.parsed }));
  for await (const chunk of body) {
    if (ctx.signal.aborted) return;
    for (const f of parser.push(chunk)) {
      if (!f.data) continue;
      let j: Record<string, unknown>;
      try {
        j = JSON.parse(f.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (j.error) {
        const e = j.error as { message?: string };
        yield { t: 'error', err: { code: 'provider_stream_error', message: e.message ?? 'gemini stream error', httpStatus: 502, fallback: false, cooldown: false } };
        return;
      }
      for (const ev of emit(x.feed(j))) yield ev;
    }
  }
  for (const f of parser.end()) {
    try {
      for (const ev of emit(x.feed(JSON.parse(f.data) as Record<string, unknown>))) yield ev;
    } catch {
      /* ignore trailing garbage */
    }
  }
  const u = mapUsage(x.usage as Parameters<typeof mapUsage>[0]);
  if (u) yield { t: 'usage', usage: u, final: true };
  for (const f of x.finishFrames()) yield { t: 'frame', raw: enc.encode(f.text), hasContent: false, usageOnly: f.usageOnly ?? false, parsed: f.parsed };
  yield { t: 'done' };
}

export class GeminiAdapter implements ProviderAdapter {
  readonly kind = 'gemini' as const;
  readonly nativeDialects: ReadonlySet<'openai-chat' | 'anthropic-messages'> = new Set(['openai-chat']);
  readonly caps = { streamUsage: 'yes' as const, embeddings: false, listModels: true };

  async send(ctx: UpstreamCtx, body: Record<string, unknown>, opts: SendOptions): Promise<AdapterResult> {
    const p = ctx.provider;
    const { request } = oaRequestToGemini(body);
    const method = opts.stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    const url = `${baseUrl(p)}/v1beta/models/${encodeURIComponent(opts.upstreamModel)}:${method}`;
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: opts.stream ? 'text/event-stream' : 'application/json' };
    if (p.creds.api_key) headers['x-goog-api-key'] = p.creds.api_key;
    const r = await sendUpstream(p.slug, { url, method: 'POST', headers, body: JSON.stringify(request) }, ctx.signal);
    if (!r.ok) return { kind: 'error', err: r.err };
    const res = r.res;
    if (res.status < 200 || res.status >= 300) {
      const text = await readBodyText(res.body);
      return { kind: 'error', err: normalizeHttpError(res.status, text, p.slug) };
    }
    ctx.onFirstByte?.();
    if (!opts.stream) {
      const text = await readBodyText(res.body, 32 * 1024 * 1024);
      const j = JSON.parse(text) as Record<string, unknown>;
      const oa = geminiResponseToOa(j, opts.upstreamModel);
      const usage = mapUsage(oa.usage as Parameters<typeof mapUsage>[0]) as Usage | undefined;
      return { kind: 'json', status: 200, contentType: 'application/json', body: Buffer.from(JSON.stringify(oa)), usage };
    }
    return { kind: 'stream', status: 200, contentType: 'text/event-stream', events: geminiStreamToOa(res.body, ctx, opts.upstreamModel) };
  }

  async listModels(provider: ProviderRecord): Promise<Array<{ id: string; context?: number }>> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (provider.creds.api_key) headers['x-goog-api-key'] = provider.creds.api_key;
    const r = await sendUpstream(provider.slug, { url: `${baseUrl(provider)}/v1beta/models?pageSize=200`, method: 'GET', headers }, AbortSignal.timeout(15_000));
    if (!r.ok) throw new Error(r.err.message);
    const text = await readBodyText(r.res.body);
    if (r.res.status >= 300) throw new Error(normalizeHttpError(r.res.status, text, provider.slug).message);
    const j = JSON.parse(text) as { models?: Array<{ name: string; inputTokenLimit?: number; supportedGenerationMethods?: string[] }> };
    return (j.models ?? [])
      .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
      .map((m) => ({ id: m.name.replace(/^models\//, ''), ...(m.inputTokenLimit ? { context: m.inputTokenLimit } : {}) }))
      .sort((a, b) => a.id.localeCompare(b.id));
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
