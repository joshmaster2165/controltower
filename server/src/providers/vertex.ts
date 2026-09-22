import crypto from 'node:crypto';
import type { Usage } from '@controltower/shared';
import { normalizeHttpError, type AdapterResult, type ProviderAdapter, type SendOptions, type UpstreamCtx, type UpstreamEvent } from './adapter.js';
import { readBodyText, sendUpstream } from './http.js';
import type { ProviderRecord } from '../registry.js';
import { geminiResponseToOa, oaRequestToGemini } from '../translate/openai-gemini.js';
import { AnthropicToOaStream, anthropicResponseToOa, oaRequestToAnthropic } from '../translate/openai-anthropic.js';
import { geminiStreamToOa } from './gemini.js';
import { mapUsage } from './openai-compat.js';
import { SseParser } from '../streaming/sse.js';

/**
 * Google Vertex AI. Auth is a service-account JSON (RS256 JWT → OAuth2
 * access token, cached) or a static access token. Gemini models go through
 * the Gemini translation; Claude models through the Anthropic publisher
 * endpoint (`rawPredict` / `streamRawPredict`). OpenAI-native to the pipeline.
 *
 * creds: { service_account_json } | { access_token }
 * extra: { project, location (default us-central1), endpoint?, token_url? }
 */
interface TokenCache {
  token: string;
  expiresAt: number;
}
const tokens = new Map<string, TokenCache>();

function b64url(b: Buffer | string): string {
  return Buffer.from(b).toString('base64url');
}

export async function vertexAccessToken(p: ProviderRecord, slug: string): Promise<string> {
  if (p.creds.access_token) return p.creds.access_token;
  const cached = tokens.get(p.id);
  if (cached && cached.expiresAt > Date.now() + 5 * 60_000) return cached.token;
  const saRaw = p.creds.service_account_json;
  if (!saRaw) throw new Error('Vertex: provide service_account_json or access_token');
  const sa = JSON.parse(saRaw) as { client_email: string; private_key: string; token_uri?: string };
  const tokenUrl = (p.extra.token_url as string | undefined) ?? sa.token_uri ?? 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: tokenUrl, iat: now, exp: now + 3600 }));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), sa.private_key);
  const assertion = `${header}.${claims}.${b64url(sig)}`;
  const form = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString();
  const r = await sendUpstream(slug, { url: tokenUrl, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form }, AbortSignal.timeout(15_000));
  if (!r.ok) throw new Error(`Vertex token: ${r.err.message}`);
  const text = await readBodyText(r.res.body);
  if (r.res.status >= 300) throw new Error(`Vertex token: HTTP ${r.res.status} ${text.slice(0, 200)}`);
  const j = JSON.parse(text) as { access_token: string; expires_in?: number };
  tokens.set(p.id, { token: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 });
  return j.access_token;
}

function endpoint(p: ProviderRecord): { base: string; project: string; location: string } {
  const project = String(p.extra.project ?? '');
  const location = String(p.extra.location ?? 'us-central1');
  const base = ((p.extra.endpoint as string | undefined) ?? (location === 'global' ? 'https://aiplatform.googleapis.com' : `https://${location}-aiplatform.googleapis.com`)).replace(/\/+$/, '');
  return { base, project, location };
}

function isClaude(model: string): boolean {
  return /^claude/i.test(model);
}

async function* anthropicStreamToOa(body: AsyncIterable<Uint8Array | Buffer>, ctx: UpstreamCtx, model: string): AsyncIterable<UpstreamEvent> {
  const parser = new SseParser();
  const x = new AnthropicToOaStream(model, true);
  const enc = new TextEncoder();
  let usage: Partial<Usage> = {};
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
      if (j.type === 'message_start') {
        const u = (j.message as { usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } } | undefined)?.usage;
        if (u) usage = { ...usage, input: u.input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 };
      } else if (j.type === 'message_delta') {
        const u = j.usage as { output_tokens?: number } | undefined;
        if (u?.output_tokens != null) usage = { ...usage, output: u.output_tokens };
      } else if (j.type === 'error') {
        yield { t: 'error', err: { code: 'provider_stream_error', message: String((j.error as { message?: string } | undefined)?.message ?? 'stream error'), httpStatus: 502, fallback: false, cooldown: false } };
        return;
      }
      const r = x.feed(j);
      for (const fr of r.frames) yield { t: 'frame', raw: enc.encode(fr), hasContent: r.hasContent, usageOnly: fr.includes('"choices":[]'), parsed: undefined };
    }
  }
  if (usage.input != null || usage.output != null) yield { t: 'usage', usage: { input: usage.input ?? 0, output: usage.output ?? 0, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0 }, final: true };
  yield { t: 'done' };
}

export class VertexAdapter implements ProviderAdapter {
  readonly kind = 'vertex' as const;
  readonly nativeDialects: ReadonlySet<'openai-chat' | 'anthropic-messages'> = new Set(['openai-chat']);
  readonly caps = { streamUsage: 'yes' as const, embeddings: false, listModels: false };

  async send(ctx: UpstreamCtx, body: Record<string, unknown>, opts: SendOptions): Promise<AdapterResult> {
    const p = ctx.provider;
    const { base, project, location } = endpoint(p);
    if (!project) return { kind: 'error', err: { code: 'provider_misconfigured', message: 'Vertex provider needs a project id', httpStatus: 502, fallback: false, cooldown: false } };
    let token: string;
    try {
      token = await vertexAccessToken(p, p.slug);
    } catch (err) {
      return { kind: 'error', err: { code: 'provider_auth_error', message: (err as Error).message, httpStatus: 502, fallback: true, cooldown: false } };
    }
    const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${token}`, accept: opts.stream ? 'text/event-stream' : 'application/json' };
    const model = opts.upstreamModel;
    const claude = isClaude(model);
    const publisher = claude ? 'anthropic' : 'google';
    const method = claude ? (opts.stream ? 'streamRawPredict' : 'rawPredict') : opts.stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    const url = `${base}/v1/projects/${project}/locations/${location}/publishers/${publisher}/models/${encodeURIComponent(model)}:${method}`;
    let reqBody: Record<string, unknown>;
    if (claude) {
      reqBody = oaRequestToAnthropic(body);
      delete reqBody.model;
      reqBody.anthropic_version = 'vertex-2023-10-16';
      reqBody.stream = opts.stream;
    } else {
      reqBody = oaRequestToGemini(body).request;
    }
    const r = await sendUpstream(p.slug, { url, method: 'POST', headers, body: JSON.stringify(reqBody) }, ctx.signal);
    if (!r.ok) return { kind: 'error', err: r.err };
    const res = r.res;
    if (res.status < 200 || res.status >= 300) {
      const text = await readBodyText(res.body);
      if (res.status === 401) tokens.delete(p.id);
      return { kind: 'error', err: normalizeHttpError(res.status, text, p.slug) };
    }
    ctx.onFirstByte?.();
    if (!opts.stream) {
      const text = await readBodyText(res.body, 32 * 1024 * 1024);
      const j = JSON.parse(text) as Record<string, unknown>;
      const oa = claude ? anthropicResponseToOa(j, model) : geminiResponseToOa(j, model);
      const usage = mapUsage(oa.usage as Parameters<typeof mapUsage>[0]) as Usage | undefined;
      return { kind: 'json', status: 200, contentType: 'application/json', body: Buffer.from(JSON.stringify(oa)), usage };
    }
    return { kind: 'stream', status: 200, contentType: 'text/event-stream', events: claude ? anthropicStreamToOa(res.body, ctx, model) : geminiStreamToOa(res.body, ctx, model) };
  }

  async healthCheck(provider: ProviderRecord): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    const t0 = Date.now();
    try {
      await vertexAccessToken(provider, provider.slug);
      const { project, location } = endpoint(provider);
      return { ok: true, latencyMs: Date.now() - t0, detail: `token ok · ${project} / ${location}` };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - t0, detail: (err as Error).message };
    }
  }
}
