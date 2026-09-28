import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Usage } from '@controltower/shared';
import type { AppContext } from '../context.js';
import { E } from '../gateway/errors.js';
import { contentDigest, newFlight, type FlightRunner } from '../pipeline/flight.js';
import type { ModelResolution, ProviderRecord } from '../registry.js';
import { computeCost } from '../pricing/index.js';
import { endpoint as vertexEndpoint, vertexAccessToken } from '../providers/vertex.js';
import { eventStreamMessages, runtimeBase, signedHeaders } from '../providers/bedrock.js';
import { forward, type Received } from './api.js';

/**
 * Providers' own APIs, for agents built on their SDKs: Gemini's (google-genai, Gemini CLI — point the SDK's
 * base URL at /gemini) and Bedrock's runtime (boto3 and the AWS SDKs with an endpoint URL of /bedrock and a
 * Control Tower key as the Bedrock API key). The request goes as it came; Control Tower signs it with the
 * provider's credentials, records it, and applies the same keys, limits, budgets, gates and inspection.
 */

const GEMINI_PATH = /^(v1beta|v1|v1alpha)\/models\/([^:/]+):([A-Za-z]+)$/;
const GEMINI_METHODS = new Set(['generateContent', 'streamGenerateContent', 'countTokens', 'embedContent', 'batchEmbedContents', 'predict']);
const BEDROCK_OPS = new Set(['converse', 'converse-stream', 'invoke', 'invoke-with-response-stream']);
const BODY_LIMIT = 32 * 1024 * 1024;

export function nativeRoutes(app: FastifyInstance, ctx: AppContext, runner: FlightRunner): void {
  app.post('/gemini/*', { bodyLimit: BODY_LIMIT }, (req, reply) => gemini(ctx, runner, req, reply));
  app.post('/bedrock/model/:modelId/:op', { bodyLimit: BODY_LIMIT }, (req, reply) => bedrock(ctx, runner, req, reply));
}

function bodyOf(req: FastifyRequest): Record<string, unknown> {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Buffer.isBuffer(req.body)) throw E.badRequest('Request body must be a JSON object.');
  return req.body as Record<string, unknown>;
}

function textChars(v: unknown): number {
  if (typeof v === 'string') return v.length;
  if (Array.isArray(v)) return v.reduce((n: number, x) => n + textChars(x), 0);
  if (v && typeof v === 'object') return Object.values(v as Record<string, unknown>).reduce((n: number, x) => n + textChars(x), 0);
  return 0;
}

// ---------------------------------------------------------------- Gemini

async function gemini(ctx: AppContext, runner: FlightRunner, req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const path = (req.params as { '*': string })['*'];
  const m = GEMINI_PATH.exec(path);
  const method = m?.[3] ?? '';
  const f = newFlight('native', 'gemini' as never, {});
  f.endpoint = `gemini:${method || path}`;
  reply.header('x-ct-flight-id', f.id);
  reply.raw.on('close', () => {
    if (!reply.raw.writableFinished) {
      f.clientGone = true;
      f.abort.abort(new Error('client disconnected'));
    }
  });
  // Google's SDKs send the key as x-goog-api-key; REST examples put it in ?key=.
  const url = new URL(req.url, 'http://x');
  const qkey = url.searchParams.get('key');
  if (qkey && !req.headers['x-goog-api-key'] && !req.headers.authorization) req.headers['x-goog-api-key'] = qkey;
  url.searchParams.delete('key');
  const query = url.searchParams.toString();
  try {
    if (ctx.shuttingDown) throw E.shuttingDown();
    if (!m || !GEMINI_METHODS.has(method)) throw E.badRequest(`Control Tower passes through Gemini's models/{model}:{method} calls (${[...GEMINI_METHODS].join(', ')}); got /gemini/${path}.`);
    f.body = bodyOf(req);
    f.modelRequested = decodeURIComponent(m[2]!);
    f.stream = method === 'streamGenerateContent';
    f.estInput = Math.max(1, Math.round(textChars([f.body.contents, f.body.systemInstruction, f.body.requests, f.body.content, f.body.instances]) / 4));
    const g = await runner.gate(f, req, reply, {
      args: () => ({ model: f.modelRequested, endpoint: f.endpoint, content: contentDigest(f.body, ['contents', 'systemInstruction', 'content', 'requests']) }),
      servedBy: (p) => p.kind === 'gemini' || p.kind === 'vertex',
    });
    await runner.inspectInput(f, g, ['contents', 'systemInstruction', 'content', 'requests']);
    const maxOut = Number((f.body.generationConfig as { maxOutputTokens?: number } | undefined)?.maxOutputTokens ?? 0) || 0;
    await forward(ctx, f, reply, {
      plan: runner.newPlan(f, g, method === 'generateContent' || method === 'streamGenerateContent' ? f.estInput + maxOut : 0, (p) => p.kind === 'gemini' || p.kind === 'vertex'),
      inspectJson: method !== 'predict',
      headersTimeoutMs: 300_000,
      build: async (prov, dep) => {
        const suffix = `models/${encodeURIComponent(dep.upstreamModel)}:${method}${query ? `?${query}` : ''}`;
        const { ct: _ct, ...rest } = f.body;
        const body = JSON.stringify(rest);
        if (prov.kind === 'vertex') {
          const ep = vertexEndpoint(prov);
          return { url: `${ep.base}/v1/projects/${ep.project}/locations/${ep.location}/publishers/google/${suffix}`, headers: { 'content-type': 'application/json', authorization: `Bearer ${await vertexAccessToken(prov, prov.slug)}` }, body };
        }
        const base = (prov.baseUrl ?? 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
        return { url: `${base}/${m[1]}/${suffix}`, headers: { 'content-type': 'application/json', ...(prov.creds.api_key ? { 'x-goog-api-key': prov.creds.api_key } : {}) }, body };
      },
      bill: (r) => billGemini(f, r),
    });
  } catch (err) {
    await runner.fail(f, reply, err);
  } finally {
    runner.record(f);
  }
}

interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
}

export function geminiUsage(u: GeminiUsage | undefined): Usage | undefined {
  if (!u || typeof u.promptTokenCount !== 'number') return undefined;
  const cached = u.cachedContentTokenCount ?? 0;
  return { input: Math.max(0, u.promptTokenCount - cached), output: u.candidatesTokenCount ?? 0, cacheRead: cached, cacheWrite: 0, ...(u.thoughtsTokenCount ? { reasoning: u.thoughtsTokenCount } : {}) };
}

function billGemini(f: import('../pipeline/flight.js').Flight, r: Received): void {
  let u: GeminiUsage | undefined = (r.json?.usageMetadata ?? r.lastUsageEvent?.usageMetadata) as GeminiUsage | undefined;
  if (!u && r.raw) {
    // A stream without ?alt=sse is one JSON array, arriving in pieces: the last element has the totals.
    try {
      const arr = JSON.parse(r.raw.toString('utf8')) as Array<{ usageMetadata?: GeminiUsage }>;
      u = [...arr].reverse().find((x) => x.usageMetadata)?.usageMetadata;
    } catch {
      /* cut short */
    }
  }
  const usage = geminiUsage(u);
  finishTokens(f, usage);
}

/** Tokens reported → exact cost; none → the prompt's estimated size, labelled so. */
function finishTokens(f: import('../pipeline/flight.js').Flight, usage: Usage | undefined): void {
  const entry = f.route?.price.entry;
  if (usage) {
    f.usage = usage;
    f.usageSource = 'provider';
    f.cost = computeCost(usage, entry);
    f.costConfidence = f.cost == null ? 'unknown' : 'exact';
  } else {
    f.usage = { input: f.estInput, output: 0, cacheRead: 0, cacheWrite: 0 };
    f.usageSource = 'estimated';
    f.cost = computeCost(f.usage, entry);
    f.costConfidence = f.cost == null ? 'unknown' : 'estimated';
  }
}

// ---------------------------------------------------------------- Bedrock

async function bedrock(ctx: AppContext, runner: FlightRunner, req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { modelId, op } = req.params as { modelId: string; op: string };
  const f = newFlight('native', 'bedrock' as never, {});
  f.endpoint = `bedrock:${op}`;
  reply.header('x-ct-flight-id', f.id);
  reply.raw.on('close', () => {
    if (!reply.raw.writableFinished) {
      f.clientGone = true;
      f.abort.abort(new Error('client disconnected'));
    }
  });
  try {
    if (ctx.shuttingDown) throw E.shuttingDown();
    if (!BEDROCK_OPS.has(op)) throw E.badRequest(`Control Tower passes through Bedrock's ${[...BEDROCK_OPS].join(', ')}; got ${op}.`);
    f.body = bodyOf(req);
    f.modelRequested = decodeURIComponent(modelId);
    f.stream = op.endsWith('stream');
    f.estInput = Math.max(1, Math.round(textChars([f.body.messages, f.body.system, f.body.prompt, f.body.inputText]) / 4));
    const g = await runner.gate(f, req, reply, {
      args: () => ({ model: f.modelRequested, endpoint: f.endpoint, content: contentDigest(f.body, ['messages', 'system', 'prompt', 'inputText']) }),
      servedBy: (p) => p.kind === 'bedrock',
      resolve: () => resolveBedrock(ctx, f.modelRequested),
    });
    await runner.inspectInput(f, g, ['messages', 'system', 'prompt', 'inputText']);
    const maxOut = Number((f.body.inferenceConfig as { maxTokens?: number } | undefined)?.maxTokens ?? f.body.max_tokens ?? 0) || 0;
    await forward(ctx, f, reply, {
      plan: runner.newPlan(f, g, f.estInput + maxOut, (p) => p.kind === 'bedrock'),
      inspectJson: true,
      headersTimeoutMs: 300_000,
      exposeHeaders: /^x-amzn-(bedrock-|requestid)/i,
      build: async (prov, dep) => {
        if (!prov.creds.access_key_id || !prov.creds.secret_access_key) throw new Error('Bedrock provider needs access_key_id and secret_access_key');
        const url = `${runtimeBase(prov)}/model/${encodeURIComponent(dep.upstreamModel)}/${op}`;
        const { ct: _ct, ...rest } = f.body;
        const body = JSON.stringify(rest);
        return { url, headers: await signedHeaders(prov, 'bedrock', 'POST', url, body), body };
      },
      bill: (r) => billBedrock(f, r),
    });
  } catch (err) {
    await runner.fail(f, reply, err);
  } finally {
    runner.record(f);
  }
}

/** A Bedrock model id (or inference profile) → the deployment serving it, added on first use like any model. */
async function resolveBedrock(ctx: AppContext, modelId: string): Promise<ModelResolution> {
  const r = ctx.registry;
  const onBedrock = (res: ModelResolution): ModelResolution => ({ ...res, candidates: res.candidates.filter((d) => r.providers.get(d.providerId)?.kind === 'bedrock') });
  const named = onBedrock(r.resolveModel(modelId));
  if (named.candidates.length) return named;
  const providers: ProviderRecord[] = [...r.providers.values()].filter((p) => p.kind === 'bedrock' && !p.demo);
  for (const p of providers) {
    const res = r.resolveModel(`${p.slug}/${modelId}`);
    if (res.candidates.length) return res;
  }
  if (providers[0] && (await ctx.autoModels.ensure(`${providers[0].slug}/${modelId}`))) return r.resolveModel(`${providers[0].slug}/${modelId}`);
  return { alias: undefined, candidates: [] };
}

async function billBedrock(f: import('../pipeline/flight.js').Flight, r: Received): Promise<void> {
  const n = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v ? Number(v) : undefined);
  // Converse answers carry usage; InvokeModel reports token counts in headers.
  const cu = r.json?.usage as { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheWriteInputTokens?: number } | undefined;
  let usage: Usage | undefined;
  if (cu && typeof cu.inputTokens === 'number') usage = { input: cu.inputTokens, output: cu.outputTokens ?? 0, cacheRead: cu.cacheReadInputTokens ?? 0, cacheWrite: cu.cacheWriteInputTokens ?? 0 };
  const hin = n(r.headers['x-amzn-bedrock-input-token-count']);
  if (!usage && hin != null) usage = { input: hin, output: n(r.headers['x-amzn-bedrock-output-token-count']) ?? 0, cacheRead: n(r.headers['x-amzn-bedrock-cache-read-input-token-count']) ?? 0, cacheWrite: n(r.headers['x-amzn-bedrock-cache-write-input-token-count']) ?? 0 };
  if (!usage && r.raw) {
    // Streams: ConverseStream's metadata event, or InvokeModelWithResponseStream's last chunk's invocation metrics.
    try {
      for await (const msg of eventStreamMessages((async function* () {
        yield r.raw!;
      })())) {
        const j = JSON.parse(Buffer.from(msg.body).toString('utf8')) as { usage?: typeof cu; bytes?: string };
        if (j.usage && typeof j.usage.inputTokens === 'number') usage = { input: j.usage.inputTokens, output: j.usage.outputTokens ?? 0, cacheRead: j.usage.cacheReadInputTokens ?? 0, cacheWrite: j.usage.cacheWriteInputTokens ?? 0 };
        if (typeof j.bytes === 'string') {
          const inner = JSON.parse(Buffer.from(j.bytes, 'base64').toString('utf8')) as { 'amazon-bedrock-invocationMetrics'?: { inputTokenCount?: number; outputTokenCount?: number; cacheReadInputTokenCount?: number; cacheWriteInputTokenCount?: number } };
          const im = inner['amazon-bedrock-invocationMetrics'];
          if (im && typeof im.inputTokenCount === 'number') usage = { input: im.inputTokenCount, output: im.outputTokenCount ?? 0, cacheRead: im.cacheReadInputTokenCount ?? 0, cacheWrite: im.cacheWriteInputTokenCount ?? 0 };
        }
      }
    } catch {
      /* a stream cut short */
    }
  }
  finishTokens(f, usage);
}
