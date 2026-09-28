import { once } from 'node:events';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FlightKind } from '@controltower/shared';
import type { AppContext } from '../context.js';
import { E } from '../gateway/errors.js';
import { newFlight, type Flight, type FlightRunner } from '../pipeline/flight.js';
import type { AttemptPlan } from '../pipeline/attempts.js';
import type { DeploymentRecord, ProviderRecord } from '../registry.js';
import { normalizeHttpError, type NormalizedError } from '../providers/adapter.js';
import { readBodyText, sendUpstream } from '../providers/http.js';
import { buildHeaders, buildUrl, mapUsage } from '../providers/openai-compat.js';
import { computeApiCost, computeCost, imagePriceKeys, type ModalTokens, type PriceEntry, type Units } from '../pricing/index.js';
import { SseParser } from '../streaming/sse.js';
import { inspect } from '../guardrails/inspect.js';
import { blockedMessage, emitInspectOutcomes } from '../guardrails/emit.js';
import { boundaryOf, buildMultipart, parseMultipart, type Part } from './multipart.js';

/**
 * Model APIs other than chat, passed through to OpenAI-wire providers: images, audio, moderations,
 * rerank and legacy completions. Each call is a flight like any other — key, limits, budgets, gates,
 * approvals and inspection apply — and is billed on what it made: images, characters, seconds of
 * audio, searches, or tokens where the provider reports them.
 */
export interface ApiSpec {
  kind: FlightKind;
  /** The path after /v1/, as the provider serves it. */
  endpoint: string;
  body: 'json' | 'multipart';
  /** Fields holding what the agent sends, for inspect gates. */
  inspect: string[];
  /** Image models can take minutes to answer. */
  headersTimeoutMs?: number;
  /** Used when the request names no model (moderations). */
  defaultModel?: string;
}

export const OPENAI_APIS: ApiSpec[] = [
  { kind: 'images', endpoint: 'images/generations', body: 'json', inspect: ['prompt'], headersTimeoutMs: 300_000 },
  { kind: 'images', endpoint: 'images/edits', body: 'multipart', inspect: ['prompt'], headersTimeoutMs: 300_000 },
  { kind: 'images', endpoint: 'images/variations', body: 'multipart', inspect: [], headersTimeoutMs: 300_000 },
  { kind: 'audio', endpoint: 'audio/speech', body: 'json', inspect: ['input', 'instructions'], headersTimeoutMs: 120_000 },
  { kind: 'audio', endpoint: 'audio/transcriptions', body: 'multipart', inspect: ['prompt'], headersTimeoutMs: 300_000 },
  { kind: 'audio', endpoint: 'audio/translations', body: 'multipart', inspect: ['prompt'], headersTimeoutMs: 300_000 },
  { kind: 'moderations', endpoint: 'moderations', body: 'json', inspect: ['input'], defaultModel: 'omni-moderation-latest' },
  { kind: 'rerank', endpoint: 'rerank', body: 'json', inspect: ['query', 'documents'] },
  { kind: 'completions', endpoint: 'completions', body: 'json', inspect: ['prompt', 'suffix'] },
];

/** Providers that speak OpenAI's wire format for these endpoints. */
export const OPENAI_WIRE = new Set(['openai', 'azure-openai', 'openai-compatible']);

const MAX_JSON_BYTES = 64 * 1024 * 1024;

function textLength(v: unknown): number {
  if (typeof v === 'string') return v.length;
  if (Array.isArray(v)) return v.reduce((n: number, x) => n + textLength(x), 0);
  if (v && typeof v === 'object') return Object.values(v as Record<string, unknown>).reduce((n: number, x) => n + textLength(x), 0);
  return 0;
}

export async function runApi(runner: FlightRunner, ctx: AppContext, req: FastifyRequest, reply: FastifyReply, spec: ApiSpec): Promise<void> {
  const f = newFlight(spec.kind, 'openai-api' as never, {});
  f.endpoint = spec.endpoint;
  reply.header('x-ct-flight-id', f.id);
  reply.raw.on('close', () => {
    if (!reply.raw.writableFinished) {
      f.clientGone = true;
      f.abort.abort(new Error('client disconnected'));
    }
  });
  let parts: Part[] | undefined;
  let boundary: string | undefined;
  try {
    if (ctx.shuttingDown) throw E.shuttingDown();
    // ---- ingress ----
    if (spec.body === 'multipart') {
      boundary = boundaryOf(req.headers['content-type']);
      parts = Buffer.isBuffer(req.body) && boundary ? parseMultipart(req.body, boundary) : undefined;
      if (!parts) throw E.badRequest(`Send ${spec.endpoint} as multipart/form-data, with the file and a model field.`);
      f.body = Object.fromEntries(parts.filter((p) => p.name && p.filename === undefined).map((p) => [p.name!, p.data.toString('utf8')]));
    } else {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Buffer.isBuffer(req.body)) throw E.badRequest('Request body must be a JSON object.');
      f.body = req.body as Record<string, unknown>;
    }
    const body = f.body;
    if (typeof body.model !== 'string' || !body.model) {
      if (!spec.defaultModel) throw E.badRequest('Missing required field: model.');
      body.model = spec.defaultModel;
    }
    f.modelRequested = body.model as string;
    f.stream = body.stream === true || body.stream === 'true' || body.stream_format === 'sse';
    f.estInput = Math.max(1, Math.round(spec.inspect.reduce((n, k) => n + textLength(body[k]), 0) / 4));

    const g = await runner.gate(f, req, reply, {
      args: () => ({ model: f.modelRequested, endpoint: spec.endpoint, ...pick(body, ['size', 'n', 'quality', 'voice', 'response_format', 'top_n']) }),
      servedBy: (p) => OPENAI_WIRE.has(p.kind),
      project: (price) => projectApi(spec, body, price.entry, f.estInput),
    });
    await runner.inspectInput(f, g, spec.inspect);
    // Inspection may have masked a field: carry it into the upload too.
    if (parts && boundary) for (const k of spec.inspect) if (typeof body[k] === 'string') setField(parts, k, body[k] as string);
    const maxTokens = typeof body.max_tokens === 'number' ? body.max_tokens : 0;
    await forward(ctx, f, reply, {
      plan: runner.newPlan(f, g, spec.kind === 'completions' ? f.estInput + maxTokens : 0, (p) => OPENAI_WIRE.has(p.kind)),
      headersTimeoutMs: spec.headersTimeoutMs,
      inspectJson: spec.kind !== 'images',
      build: async (prov, dep) => {
        const headers = buildHeaders(prov);
        const accept = req.headers.accept;
        if (typeof accept === 'string' && accept) headers.accept = accept;
        if (parts && boundary) {
          headers['content-type'] = `multipart/form-data; boundary=${boundary}`;
          return { url: upstreamUrl(prov, spec.endpoint, dep), headers, body: buildMultipart(parts, boundary, { model: dep.upstreamModel }) };
        }
        return { url: upstreamUrl(prov, spec.endpoint, dep), headers, body: JSON.stringify({ ...f.body, model: dep.upstreamModel, ct: undefined }) };
      },
      bill: (r) => bill(ctx, f, spec, r.json ?? (r.lastUsageEvent ? { usage: r.lastUsageEvent.usage ?? (r.lastUsageEvent.response as Record<string, unknown> | undefined)?.usage } : undefined)),
    });
  } catch (err) {
    await runner.fail(f, reply, err);
  } finally {
    runner.record(f);
  }
}

function pick(o: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
}

function setField(parts: Part[], name: string, value: string): void {
  const p = parts.find((x) => x.name === name && x.filename === undefined);
  if (p) p.data = Buffer.from(value);
}

/** What a call may cost before it is made: for budgets that stop a call before it runs. */
function projectApi(spec: ApiSpec, body: Record<string, unknown>, entry: PriceEntry | undefined, estInput: number): number {
  if (!entry) return 0;
  const n = typeof body.n === 'number' ? body.n : Number(body.n ?? 1) || 1;
  if (spec.kind === 'images') return computeApiCost(entry, { images: n, pixels: pixels(body.size) }) ?? computeApiCost(entry, {}, { textIn: estInput, imageOut: 1500 * n }) ?? 0;
  if (spec.endpoint === 'audio/speech') return computeApiCost(entry, { characters: textLength(body.input) }) ?? computeApiCost(entry, {}, { textIn: estInput, audioOut: estInput * 20 }) ?? 0;
  if (spec.kind === 'rerank') return computeApiCost(entry, { queries: 1 }) ?? 0;
  return computeApiCost(entry, {}, { textIn: estInput }) ?? 0;
}

function pixels(size: unknown): number {
  const m = typeof size === 'string' ? /^(\d+)x(\d+)$/.exec(size) : null;
  return m ? Number(m[1]) * Number(m[2]) : 1024 * 1024;
}

function upstreamUrl(p: ProviderRecord, endpoint: string, dep: DeploymentRecord): string {
  // Cohere and others serve rerank at their own path; a provider can say where.
  const path = endpoint === 'rerank' && typeof p.extra.rerank_path === 'string' ? p.extra.rerank_path : endpoint;
  return buildUrl(p, path, dep.upstreamModel);
}

/** The request to send to one deployment's provider. */
export interface Upstream {
  url: string;
  headers: Record<string, string>;
  body: Buffer | string;
}

/** What came back, for billing: the JSON answer, the last streamed event that reported usage, or the raw stream. */
export interface Received {
  json: Record<string, unknown> | undefined;
  /** The last server-sent event carrying usage (OpenAI `usage`, Gemini `usageMetadata`). */
  lastUsageEvent: Record<string, unknown> | undefined;
  /** A stream that isn't server-sent events (Bedrock's event stream, Gemini's JSON array), up to 16 MB. */
  raw: Buffer | undefined;
  headers: Record<string, string>;
}

export interface ForwardOptions {
  /** Which deployment to try next (retries, busy deployments, fallback models). */
  plan: AttemptPlan;
  build: (prov: ProviderRecord, dep: DeploymentRecord) => Promise<Upstream>;
  bill: (r: Received) => void | Promise<void>;
  headersTimeoutMs?: number | undefined;
  /** Inspect gates may read (and block) JSON answers: not image data. */
  inspectJson: boolean;
  /** Provider response headers the client should see (Bedrock reports token counts in them). */
  exposeHeaders?: RegExp;
}

const MAX_RAW = 16 * 1024 * 1024;

/**
 * Send the call to the first candidate that answers, falling back while nothing has reached the client; pass
 * the answer through — JSON whole (inspected), anything else as it arrives — and bill it.
 */
export async function forward(ctx: AppContext, f: Flight, reply: FastifyReply, o: ForwardOptions): Promise<void> {
  let lastErr: NormalizedError | undefined;
  let last: { dep: DeploymentRecord; err: NormalizedError } | undefined;
  for (let a = await o.plan.next(); a; a = await o.plan.next(last)) {
    const { dep, prov } = a;
    f.attempts++;
    f.deployment = dep;
    f.provider = prov;
    f.t.upstreamSent = Date.now();
    let up: Upstream;
    try {
      up = await o.build(prov, dep);
    } catch (e) {
      throw { code: 'provider_auth_error', message: (e as Error).message, httpStatus: 502, fallback: false, cooldown: false } satisfies NormalizedError;
    }
    const r = await sendUpstream(prov.slug, { url: up.url, method: 'POST', headers: up.headers, body: up.body }, f.abort.signal, {
      headersTimeoutMs: typeof dep.caps.headers_timeout_ms === 'number' ? dep.caps.headers_timeout_ms : o.headersTimeoutMs,
    });
    let err: NormalizedError | undefined;
    if (!r.ok) err = r.err;
    else if (r.res.status < 200 || r.res.status >= 300) err = normalizeHttpError(r.res.status, await readBodyText(r.res.body), prov.slug);
    if (err || !r.ok) {
      lastErr = err!;
      last = { dep, err: lastErr };
      ctx.bus.emit({ t: 'flight.upstream', flight_id: f.id, ts: Date.now(), attempt: f.attempts, deployment_id: dep.id, provider_id: prov.id, upstream_model: dep.upstreamModel, outcome: 'error', status: lastErr.upstreamStatus, error_code: lastErr.code });
      if (lastErr.cooldown) ctx.registry.markCooldown(dep.id);
      continue;
    }
    const res = r.res;
    f.t.ttfb = Date.now();
    ctx.registry.clearCooldown(dep.id);
    f.route!.price = ctx.pricing.resolve(prov.kind, dep.upstreamModel, dep.pricingOverride, prov.slug);
    ctx.bus.emit({ t: 'flight.upstream', flight_id: f.id, ts: Date.now(), attempt: f.attempts, deployment_id: dep.id, provider_id: prov.id, upstream_model: dep.upstreamModel, outcome: 'ok', status: res.status, ttfb_ms: f.t.ttfb - f.t.start });
    f.httpStatus = res.status;
    const ctype = res.headers['content-type'] ?? 'application/octet-stream';
    const exposed: Record<string, string> = {};
    if (o.exposeHeaders) for (const [k, v] of Object.entries(res.headers)) if (o.exposeHeaders.test(k)) exposed[k] = v;

    if (/json/i.test(ctype) && !/event-stream|eventstream/i.test(ctype) && !f.stream) {
      const text = await readBodyText(res.body, MAX_JSON_BYTES);
      let parsed: Record<string, unknown> | undefined;
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = undefined;
      }
      f.status = 'ok';
      await o.bill({ json: parsed, lastUsageEvent: undefined, raw: undefined, headers: res.headers });
      let out = text;
      if (parsed && f.inspectOut.length && o.inspectJson) {
        const ins = await inspect(ctx, f.key, f.inspectOut, 'output', parsed);
        emitInspectOutcomes(ctx.bus, f.id, ins.outcomes, 'in the response');
        if (ins.blocked) {
          f.status = 'denied';
          throw E.contentBlocked(blockedMessage(ins.blocked, 'response'), ins.blocked.ruleId, ins.blocked.findings);
        }
        if (ins.value !== parsed) out = JSON.stringify(ins.value);
      }
      f.bytesWritten = Buffer.byteLength(out);
      await reply.status(res.status).headers(exposed).header('content-type', ctype).send(out);
      return;
    }

    // Audio, or a stream: passed through as it arrives, with any usage it reports read on the way.
    reply.hijack();
    const raw = reply.raw;
    const fwd: Record<string, string> = { ...exposed, 'content-type': ctype, 'x-ct-flight-id': f.id };
    if (res.headers['content-disposition']) fwd['content-disposition'] = res.headers['content-disposition'];
    const sse = /event-stream/i.test(ctype) ? new SseParser() : undefined;
    if (sse) Object.assign(fwd, { 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' });
    raw.writeHead(res.status, fwd);
    let lastUsageEvent: Record<string, unknown> | undefined;
    const kept: Buffer[] = [];
    let keptBytes = 0;
    const audio = /^audio\//i.test(ctype);
    try {
      for await (const chunk of res.body) {
        if (f.clientGone) break;
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        if (sse) {
          for (const fr of sse.push(b)) {
            if (!fr.data || fr.data === '[DONE]' || !/usage/i.test(fr.data)) continue;
            try {
              const j = JSON.parse(fr.data) as Record<string, unknown>;
              if (j.usage || j.usageMetadata || (j.response as Record<string, unknown> | undefined)?.usage) lastUsageEvent = j;
            } catch {
              /* not JSON */
            }
          }
        } else if (!audio && keptBytes < MAX_RAW) {
          kept.push(b);
          keptBytes += b.byteLength;
        }
        f.bytesWritten += b.byteLength;
        if (!raw.write(b)) await Promise.race([once(raw, 'drain'), once(raw, 'close')]);
      }
      f.status = f.clientGone ? 'client_aborted' : 'ok';
    } catch (e) {
      f.status = f.clientGone ? 'client_aborted' : 'error';
      if (!f.clientGone) f.error = { code: 'provider_stream_error', message: (e as Error).message, httpStatus: 502, fallback: false, cooldown: false };
    } finally {
      if (!raw.writableEnded) raw.end();
    }
    await o.bill({ json: undefined, lastUsageEvent, raw: kept.length ? Buffer.concat(kept) : undefined, headers: res.headers });
    return;
  }
  throw lastErr ?? o.plan.refusal() ?? E.modelNotFound(f.modelRequested);
}

/**
 * Cost and usage from the response: token counts where the provider gives them (each modality at its own
 * price), otherwise what the call made — images, characters, seconds of audio, searches.
 */
function bill(ctx: AppContext, f: Flight, spec: ApiSpec, res: Record<string, unknown> | undefined): void {
  const prov = f.provider;
  const dep = f.deployment;
  if (!prov || !dep) return;
  const body = f.body;
  const price = (model: string) => ctx.pricing.resolve(prov.kind, model, dep.pricingOverride, prov.slug);
  let entry = f.route?.price.entry;
  const units: Units = {};
  let tokens: ModalTokens | undefined;
  const u = (res?.usage ?? undefined) as
    | { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; type?: string; seconds?: number; input_tokens_details?: { text_tokens?: number; image_tokens?: number; audio_tokens?: number; cached_tokens?: number }; input_token_details?: { text_tokens?: number; audio_tokens?: number } }
    | undefined;
  let exact = false;

  if (spec.kind === 'images') {
    const made = Array.isArray(res?.data) ? (res!.data as unknown[]).length : typeof body.n === 'number' ? body.n : Number(body.n ?? 1) || 1;
    units.images = made;
    units.pixels = pixels(body.size);
    if (u && typeof u.input_tokens === 'number') {
      const d = u.input_tokens_details ?? {};
      tokens = { textIn: d.text_tokens ?? (d.image_tokens == null ? u.input_tokens : u.input_tokens - d.image_tokens), imageIn: d.image_tokens ?? 0, imageOut: u.output_tokens ?? 0 };
    }
    // Tokens reported are billed at the model's token prices (gpt-image-1); otherwise per image, priced by
    // quality and size (dall-e-3's `hd/1024-x-1792/…` entries).
    const tokenPriced = !!tokens && (entry?.image_output != null || (entry?.output ?? 0) > 0);
    if (!tokenPriced) {
      tokens = undefined;
      for (const k of imagePriceKeys(dep.upstreamModel, typeof body.size === 'string' ? body.size : undefined, typeof body.quality === 'string' ? body.quality : undefined)) {
        const p = price(k);
        if (p.entry && (p.entry.per_image != null || p.entry.per_pixel != null)) {
          entry = p.entry;
          break;
        }
      }
    }
    exact = Array.isArray(res?.data);
  } else if (spec.endpoint === 'audio/speech') {
    units.characters = textLength(body.input);
    if (u && typeof u.input_tokens === 'number') tokens = { textIn: u.input_tokens, audioOut: u.output_tokens ?? 0 };
    exact = true;
  } else if (spec.kind === 'audio') {
    // Transcriptions report their tokens, or the audio's length; verbose_json always has the duration.
    if (u?.type === 'duration' && typeof u.seconds === 'number') units.seconds = u.seconds;
    else if (u && typeof u.input_tokens === 'number') {
      const d = u.input_token_details ?? u.input_tokens_details ?? {};
      tokens = { textIn: d.text_tokens ?? 0, audioIn: d.audio_tokens ?? u.input_tokens - (d.text_tokens ?? 0), textOut: u.output_tokens ?? 0 };
    }
    if (units.seconds == null && typeof res?.duration === 'number') units.seconds = res.duration;
    exact = units.seconds != null || !!tokens;
  } else if (spec.kind === 'rerank') {
    const billed = (res?.meta as { billed_units?: { search_units?: number } } | undefined)?.billed_units?.search_units;
    units.queries = typeof billed === 'number' ? billed : 1;
    if (u && typeof u.total_tokens === 'number' && entry?.per_query == null) tokens = { textIn: u.total_tokens };
    exact = typeof billed === 'number' || !!tokens;
  } else if (spec.kind === 'completions' && u && typeof u.prompt_tokens === 'number') {
    const usage = mapUsage(u as never);
    if (usage) {
      f.usage = usage;
      f.usageSource = 'provider';
      f.cost = computeCost(usage, entry);
      f.costConfidence = f.cost == null ? 'unknown' : 'exact';
      return;
    }
  }

  let cost = computeApiCost(entry, units, tokens);
  // Speech priced by the second, for a model that reported nothing: about 15 characters are spoken a second.
  if (cost == null && units.characters && entry?.per_second != null) {
    cost = computeApiCost(entry, { seconds: units.characters / 15 });
    exact = false;
  }
  if (cost == null && !tokens && entry) {
    cost = computeApiCost(entry, {}, { textIn: f.estInput });
    exact = false;
  }
  f.units = Object.fromEntries(Object.entries(units).filter(([k, v]) => k !== 'pixels' && v != null)) as Units;
  if (!Object.keys(f.units).length) f.units = undefined;
  if (tokens) {
    f.usage = { input: (tokens.textIn ?? 0) + (tokens.imageIn ?? 0) + (tokens.audioIn ?? 0), output: (tokens.textOut ?? 0) + (tokens.imageOut ?? 0) + (tokens.audioOut ?? 0), cacheRead: 0, cacheWrite: 0 };
    f.usageSource = 'provider';
  } else {
    f.usage = { input: f.estInput, output: 0, cacheRead: 0, cacheWrite: 0 };
    f.usageSource = 'estimated';
  }
  f.cost = cost;
  f.costConfidence = cost == null ? 'unknown' : exact ? 'exact' : 'estimated';
}

