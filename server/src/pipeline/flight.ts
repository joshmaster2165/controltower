import { once } from 'node:events';
import { capMaxTokens, gateLimitRefusal } from '../policy/limits.js';
import { inspect } from '../guardrails/inspect.js';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ulid } from 'ulid';
import type { FlightKind, FlightStatus, Usage, UsageSource, CostConfidence } from '@controltower/shared';
import type { AppContext } from '../context.js';
import type { AliasRecord, DeploymentRecord, KeyRecord, ModelResolution, ProviderRecord } from '../registry.js';
import { byTier } from '../registry.js';
import type { NormalizedError, WireDialect } from '../providers/adapter.js';
import type { PriceRef, Units } from '../pricing/index.js';
import { computeCost, projectCost } from '../pricing/index.js';
import { E, errorBody, errorFrame, type GatewayError } from '../gateway/errors.js';
import { extractApiKey, keyProblem } from '../gateway/key.js';
import type { InspectGate, PolicyDecision, PolicyTarget } from '../policy/engine.js';
import { MAX_SCAN_CHARS } from '../guardrails/scan.js';
import { blockedMessage, emitInspectOutcomes } from '../guardrails/emit.js';
import { AnthropicToOaStream, anthropicResponseToOa, oaRequestToAnthropic } from '../translate/openai-anthropic.js';
import { OaToAnthropicStream, anRequestToOa, oaResponseToAnthropic } from '../translate/anthropic-openai.js';
import { headerToken, flagIgnoredToken, resolveDelegation } from '../policy/delegation.js';
import { capsOf, requestMeta, routeCandidates } from './routing.js';
import { cacheControl, cacheKey } from '../cache/response-cache.js';
import { AttemptPlan } from './attempts.js';
import { ChatToResponsesStream, ResponsesTranslationError, chatResponseToResponses, requestTools, responsesRequestToChat } from '../translate/responses-chat.js';

/** Extract the JSON payload of a raw SSE frame; null for comments, [DONE] and non-JSON. */
function parseSseData(raw: Uint8Array | string): Record<string, unknown> | null {
  const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
  const data: string[] = [];
  for (const line of text.split(/\r?\n/)) if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  const joined = data.join('\n');
  if (!joined || joined === '[DONE]') return null;
  try {
    return JSON.parse(joined) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * One request = one Flight. The stage order is a security property; read it
 * top to bottom in `runChat`:
 *   ingress → auth → admission → resolve → policy → dispatch → egress → account → record
 */
export interface Flight {
  id: string;
  kind: FlightKind;
  dialect: WireDialect;
  stream: boolean;
  t: { start: number; upstreamSent?: number; ttfb?: number; ttft?: number; end?: number };
  key: KeyRecord | undefined;
  body: Record<string, unknown>;
  modelRequested: string;
  estInput: number;
  route:
    | {
        alias: AliasRecord | undefined;
        candidates: DeploymentRecord[];
        price: PriceRef;
        projected: number;
        budgetScopes: string[];
      }
    | undefined;
  decision: PolicyDecision | undefined;
  approvalId: string | undefined;
  /** Inspect gates on this path that look at what comes back. */
  inspectOut: InspectGate[];
  /** Set when the upstream adapter speaks a different dialect than the client: its native dialect. */
  translateTo: WireDialect | undefined;
  /** A Responses API request served through Chat Completions: the reply is translated back. */
  viaChat: boolean;
  /** Agents this call is made on behalf of (origin first), from a verified delegation token. */
  chain: string[];
  /** The call that led to this one: the one that issued its delegation token. */
  parentFlightId: string | undefined;
  /** The key of the agent that started the chain this call is part of, when it is made on someone's behalf. */
  originKeyId: string | undefined;
  attempts: number;
  deployment: DeploymentRecord | undefined;
  provider: ProviderRecord | undefined;
  usage: Usage | undefined;
  usageSource: UsageSource;
  cost: number | null;
  costConfidence: CostConfidence;
  status: FlightStatus | undefined;
  httpStatus: number;
  error: NormalizedError | GatewayError | undefined;
  started: boolean;
  bytesWritten: number;
  abort: AbortController;
  releaseSlot: (() => void) | undefined;
  clientGone: boolean;
  /** Model calls other than chat: the endpoint called (images/generations, gemini:generateContent, …). */
  endpoint: string | undefined;
  /** Tags the request carried. */
  tags: string[];
  /** The end customer the agent was serving. */
  customer: string | undefined;
  /** What a non-token call was billed on. */
  units: Units | undefined;
  /** Answered from the response cache. */
  cacheHit: boolean;
  /** Where the call is being tried: holds a deployment's concurrency slot until it ends. */
  plan: AttemptPlan | undefined;
  /** Store the answer under this key (the model caches answers, and the request didn't say no-store). */
  cacheStore: { key: string; ttlS: number } | undefined;
  /** The agent's own trace (traceparent), for exported spans. */
  trace: { trace_id: string; parent_span_id: string } | undefined;
}

export interface GateSpec {
  /** Bypass header auth with a known key (admin playground). */
  keyOverride?: KeyRecord | undefined;
  /** What policy sees of the request (never logged). */
  args: (f: Flight) => Record<string, unknown>;
  /** Only providers that serve this endpoint; a model served only elsewhere is refused. */
  servedBy?: ((p: ProviderRecord) => boolean) | undefined;
  /** Resolve the model some other way than by name (a provider's own model id). */
  resolve?: (() => Promise<ModelResolution>) | undefined;
  /** The call's projected cost when it isn't priced by tokens. */
  project?: ((price: PriceRef) => number) | undefined;
}

/** What gate() established: who is calling, where to, for whom, and policy's decision. */
export interface Gated {
  /** What policy saw of the request: fallback models are checked with it too. */
  args: Record<string, unknown>;
  key: KeyRecord;
  target: PolicyTarget;
  onBehalfOf: string[];
  decision: PolicyDecision;
}

const KEEPALIVE_MS = 15_000;

export interface RunOptions {
  /** Bypass header auth with a known key (admin playground). */
  keyOverride?: KeyRecord;
  /** `embeddings` bodies carry `input` instead of `messages` and never stream. */
  kind?: 'chat' | 'embeddings';
}

export function newFlight(kind: FlightKind, dialect: WireDialect, body: Record<string, unknown>): Flight {
  return {
    id: ulid(),
    kind,
    dialect,
    stream: body.stream === true,
    t: { start: Date.now() },
    key: undefined,
    body,
    modelRequested: typeof body.model === 'string' ? body.model : '',
    estInput: 0,
    route: undefined,
    decision: undefined,
    approvalId: undefined,
    inspectOut: [],
    translateTo: undefined,
    viaChat: false,
    chain: [],
    parentFlightId: undefined,
    originKeyId: undefined,
    attempts: 0,
    deployment: undefined,
    provider: undefined,
    usage: undefined,
    usageSource: 'unknown',
    cost: null,
    costConfidence: 'unknown',
    status: undefined,
    httpStatus: 0,
    error: undefined,
    started: false,
    bytesWritten: 0,
    abort: new AbortController(),
    releaseSlot: undefined,
    clientGone: false,
    endpoint: undefined,
    tags: [],
    customer: undefined,
    units: undefined,
    cacheHit: false,
    plan: undefined,
    cacheStore: undefined,
    trace: undefined,
  };
}

/** Cheap admission-time estimate; the real tokenizer never runs on the hot path. */
export function estimateInputTokens(body: Record<string, unknown>): number {
  let chars = 0;
  const msgs = body.messages;
  if (Array.isArray(msgs)) {
    for (const m of msgs as Array<{ content?: unknown }>) {
      if (typeof m.content === 'string') chars += m.content.length;
      else if (m.content != null) chars += JSON.stringify(m.content).length;
    }
  }
  if (typeof body.system === 'string') chars += body.system.length;
  if (typeof body.instructions === 'string') chars += body.instructions.length;
  if (Array.isArray(body.tools)) chars += JSON.stringify(body.tools).length;
  if (typeof body.input === 'string') chars += body.input.length;
  else if (Array.isArray(body.input)) chars += JSON.stringify(body.input).length;
  return Math.max(1, Math.round(chars / 4));
}

/** Text a model produced, from one stream frame of either dialect (content, text, tool-call arguments). */
function collectText(v: unknown, out: string[], key?: string): void {
  if (typeof v === 'string') {
    if (key === 'content' || key === 'text' || key === 'arguments' || key === 'partial_json' || key === 'thinking' || key === 'delta') out.push(v);
    return;
  }
  if (Array.isArray(v)) for (const x of v) collectText(x, out, key);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) collectText(x, out, k);
}

function toolNames(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.tools)) return [];
  return (body.tools as Array<{ function?: { name?: string }; name?: string }>).map((t) => t.function?.name ?? t.name ?? '').filter(Boolean);
}

function sessionIdOf(req: FastifyRequest, body: Record<string, unknown>): string | undefined {
  const h = req.headers['x-ct-session'];
  if (typeof h === 'string' && h) return h;
  if (typeof body.user === 'string' && body.user) return body.user;
  const md = body.metadata as { user_id?: string } | undefined;
  return md?.user_id;
}

function isGatewayError(e: unknown): e is GatewayError {
  return !!e && typeof e === 'object' && 'status' in e && 'code' in e && !('httpStatus' in e);
}

export class FlightRunner {
  constructor(private readonly ctx: AppContext) {}

  /** Entry for /v1/chat/completions (openai-chat), /v1/responses (openai-responses) and /v1/messages (anthropic-messages). */
  async runChat(req: FastifyRequest, reply: FastifyReply, dialect: WireDialect, runOpts: RunOptions = {}): Promise<void> {
    const ctx = this.ctx;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const embeddings = runOpts.kind === 'embeddings';
    if (embeddings) body.stream = false;
    const kind = embeddings ? 'embeddings' : dialect === 'anthropic-messages' ? 'messages' : dialect === 'openai-responses' ? 'responses' : 'chat';
    const f = newFlight(kind, dialect, body);
    reply.header('x-ct-flight-id', f.id);

    // ServerResponse 'close' fires when the connection drops OR when the response
    // finishes; only the former is a disconnect. (IncomingMessage 'close' fires as
    // soon as the body is consumed, which is why it is not used here.)
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) {
        f.clientGone = true;
        f.abort.abort(new Error('client disconnected'));
      }
    });

    try {
      if (ctx.shuttingDown) throw E.shuttingDown();

      // ---- ingress ----
      if (typeof body !== 'object' || Array.isArray(body)) throw E.badRequest('Request body must be a JSON object.');
      if (!f.modelRequested) throw E.badRequest('Missing required field: model.');
      if (embeddings) {
        if (typeof body.input !== 'string' && !Array.isArray(body.input)) throw E.badRequest('Missing required field: input (string or array).');
      } else if (dialect === 'openai-responses') {
        if (body.input !== undefined && typeof body.input !== 'string' && !Array.isArray(body.input)) throw E.badRequest('Field input must be a string or an array of input items.');
      } else if (!Array.isArray(body.messages)) throw E.badRequest('Missing required field: messages (array).');
      f.estInput = estimateInputTokens(body);

      const g = await this.gate(f, req, reply, {
        keyOverride: runOpts.keyOverride,
        args: () => ({ model: f.modelRequested, max_tokens: body.max_tokens, stream: f.stream, tools: toolNames(body) }),
      });
      capMaxTokens(body, g.decision);

      // ---- inspect (what the agent sends) ----
      await this.inspectInput(f, g, ['messages', 'system', 'instructions', 'input', 'prompt']);

      // ---- cache (opt-in per model; consulted only after the gates, so it is never a way around them) ----
      if (await this.fromCache(f, req, reply, g)) return;

      // ---- dispatch + egress ----
      await this.dispatch(f, reply, g);

      // ---- account ----
      this.account(f);
    } catch (err) {
      await this.fail(f, reply, err);
    } finally {
      this.record(f);
    }
  }

  /**
   * Everything before a call leaves: auth → admission → resolve → policy (and a hold for approval) → a gate's limits.
   * Shared by chat calls and every other model API (images, audio, providers' own APIs); throws the refusal.
   */
  async gate(f: Flight, req: FastifyRequest, reply: FastifyReply, spec: GateSpec): Promise<Gated> {
    const ctx = this.ctx;
    // ---- auth ----
    const presented = extractApiKey(req);
    const key = spec.keyOverride ?? (presented ? ctx.registry.authenticate(presented) : undefined);
    if (!key) throw E.unauthorized();
    f.key = key;
    const problem = keyProblem(key);
    if (problem) throw problem === 'disabled' ? E.keyDisabled() : E.keyExpired();
    // Whom this call is for, when an agent is acting for another (refused below if the key needs it).
    const deleg = resolveDelegation(ctx, key, headerToken(req.headers));
    f.chain = deleg.chain ?? [];
    f.parentFlightId = deleg.parentFlightId;
    f.originKeyId = 'error' in deleg ? undefined : deleg.originKeyId;
    const onBehalfOf = 'error' in deleg ? [] : deleg.onBehalfOf;
    // Tags, the customer served, and the region asked for.
    const meta = requestMeta(req, f.body);
    f.tags = meta.tags;
    f.customer = meta.customer;
    f.trace = meta.trace;
    if (f.customer && ctx.registry.customers.get(f.customer)?.blocked) throw E.customerBlocked(f.customer);

    // ---- admission ----
    if (!ctx.registry.keyMayUseModel(key, f.modelRequested)) throw E.modelNotAllowed(f.modelRequested);
    const maxParallel = key.limits.maxParallel ?? 0;
    const release = await ctx.limiter.acquireSlot(`key:${key.id}`, maxParallel);
    if (!release) throw E.tooManyParallel(maxParallel);
    f.releaseSlot = release;
    const admit = await ctx.limiter.admit(`key:${key.id}`, f.estInput, key.limits);
    if (!admit.ok) {
      reply.header('retry-after', String(Math.ceil(admit.retryAfterMs / 1000)));
      throw E.rateLimited(admit.which ?? 'rpm', admit.retryAfterMs);
    }

    // ---- resolve ----
    let res = spec.resolve ? await spec.resolve() : ctx.registry.resolveModel(f.modelRequested);
    // A model a connected provider serves is added on first use: no Models step needed.
    if (!spec.resolve && res.candidates.length === 0 && (await ctx.autoModels.ensure(f.modelRequested))) res = ctx.registry.resolveModel(f.modelRequested);
    if (res.candidates.length === 0) throw E.modelNotFound(f.modelRequested);
    if (spec.servedBy) {
      const served = res.candidates.filter((d) => {
        const p = ctx.registry.providers.get(d.providerId);
        return !!p && spec.servedBy!(p);
      });
      if (served.length === 0) throw E.endpointNotSupported(f.modelRequested, f.endpoint ?? f.kind, ctx.registry.providers.get(res.candidates[0]!.providerId)?.name);
      res = { ...res, candidates: served };
    }
    // Only where the key's data may go, and to deployments reserved for the request's tags.
    res = { ...res, candidates: routeCandidates(ctx, key, f.modelRequested, meta, res.candidates) };
    if (res.alias?.strategy === 'least-cost') res = { ...res, candidates: cheapestFirst(ctx, res.alias, res.candidates) };
    const head = res.candidates[0]!;
    const headProv = ctx.registry.providers.get(head.providerId);
    const price = headProv
      ? ctx.pricing.resolve(headProv.kind, head.upstreamModel, head.pricingOverride, headProv.slug)
      : { source: 'none' as const, key: head.upstreamModel, entry: undefined };
    const maxOut = typeof f.body.max_tokens === 'number' ? f.body.max_tokens : Math.min(price.entry?.max_output ?? 4096, 4096);
    const projected = spec.project ? spec.project(price) : projectCost(f.estInput, maxOut, price.entry);
    // Spend made on someone's behalf also counts against the budgets of the agent that started the chain.
    const origin = f.originKeyId && f.originKeyId !== key.id ? ctx.registry.keysById.get(f.originKeyId) : undefined;
    const budgetScopes = [
      ...new Set(
        [key, ...(origin ? [origin] : [])].flatMap((k) => [`key:${k.id}`, k.team ? `team:${k.team}` : '', k.project ? `project:${k.project}` : '']).filter(Boolean),
      ),
      ...(f.customer ? [`customer:${f.customer}`] : []),
    ];
    const over = ctx.spend.reserve(budgetScopes, projected);
    if (over) throw E.budgetExceeded(over.scope);
    f.route = { alias: res.alias, candidates: res.candidates, price, projected, budgetScopes };
    f.deployment = head;
    f.provider = headProv;
    this.emitStarted(f);
    if ('error' in deleg) throw deleg.error; // recorded as a refused flight, with its chain
    if (deleg.invalid) flagIgnoredToken(ctx, f.id, deleg.invalid);

    // ---- policy ----
    // Policy is evaluated against the primary route; fallbacks stay within the same alias.
    const target: PolicyTarget = {
      kind: 'model',
      name: f.modelRequested,
      providerId: headProv?.id,
      providerKind: headProv?.kind,
      deploymentId: head.id,
      operation: 'read',
    };
    let decision = await ctx.policy.evaluate({
      flightId: f.id,
      key,
      target,
      args: spec.args(f),
      onBehalfOf,
      estInputTokens: f.estInput,
      projectedNanousd: projected,
    });

    // A retry may carry a ticket or grant from an earlier hold.
    const presentedApproval = req.headers['x-ct-approval'];
    if (decision.effect === 'hold' && typeof presentedApproval === 'string' && presentedApproval) {
      const scope = (decision as { scopeHash?: string }).scopeHash ?? '';
      const r = await ctx.approvals.redeem(presentedApproval, key.id, scope, sessionIdOf(req, f.body));
      if (r.ok) {
        decision = { ...decision, effect: 'allow', reason: `approved (grant …${r.grantId.slice(-6)})` };
      } else if (r.reason === 'pending') {
        f.decision = decision;
        this.emitDecision(f, 'hold', decision, 'ticket still pending');
        f.status = 'ticketed';
        throw E.approvalRequired('CONTROL_TOWER_APPROVAL_REQUIRED: still awaiting a human decision. Retry this exact call with the same x-ct-approval header after the suggested wait.', {
          ct: { v: 1, status: 'pending', ticket: presentedApproval, retry_after_ms: r.retryAfterMs ?? 15_000, request_id: r.approvalId },
        });
      } else if (r.reason === 'denied') {
        f.decision = decision;
        this.emitDecision(f, 'deny', decision, 'denied by approver');
        f.status = 'denied';
        throw E.policyDenied('Denied by an approver.', decision.ruleId);
      } else if (r.reason === 'scope_mismatch') {
        f.decision = decision;
        this.emitDecision(f, 'deny', decision, 'scope_mismatch');
        ctx.log.warn({ flight: f.id, key: key.id }, 'SECURITY: approval redeemed with different arguments than approved');
        f.status = 'denied';
        throw E.policyDenied('The approval was granted for different arguments than this request (scope mismatch). Request approval again.', decision.ruleId);
      }
      // expired / exhausted / revoked / unknown: fall through and hold again.
    }

    f.decision = decision;
    ctx.bus.emit({
      t: 'flight.decision',
      flight_id: f.id,
      ts: Date.now(),
      decision: decision.effect === 'hold' ? 'hold' : decision.effect,
      rule_id: decision.ruleId,
      zone_from: decision.zoneFrom,
      zone_to: decision.zoneTo,
      reason: decision.reason,
      arg_hash: decision.argHash,
    });
    if (decision.effect === 'deny') {
      f.status = 'denied';
      throw E.policyDenied(decision.reason, decision.ruleId);
    }
    if (decision.effect === 'hold') {
      const outcome = await ctx.approvals.hold(f, decision);
      if (outcome.kind !== 'approved') {
        f.status = outcome.kind === 'denied' ? 'denied' : 'ticketed';
        throw outcome.error;
      }
    }
    // An allow-with-limits gate: within its rate, and its cap on the reply's length.
    const overGate = await gateLimitRefusal(ctx, decision, key, f.estInput);
    if (overGate) {
      f.status = 'rejected';
      throw overGate;
    }
    return { key, target, onBehalfOf, decision, args: spec.args(f) };
  }

  /** A cached answer for this request, sent — true when it was (the call is then done: no provider, no cost). */
  private async fromCache(f: Flight, req: FastifyRequest, reply: FastifyReply, g: Gated): Promise<boolean> {
    const ctx = this.ctx;
    const head = f.route?.candidates[0];
    const cfg = f.route?.alias?.config.cache ?? (head ? capsOf(head).cache : undefined);
    if (!cfg?.ttl_s || !ctx.cache) return false;
    const cc = cacheControl(req.headers['x-ct-cache'], f.body);
    const key = cacheKey({ model: f.modelRequested, dialect: f.dialect, stream: f.stream, body: f.body, scope: cfg.shared ? '' : g.key.id, namespace: cc.namespace });
    if (!cc.noStore) f.cacheStore = { key, ttlS: cc.ttlS ?? cfg.ttl_s };
    if (cc.noCache) return false;
    const hit = await ctx.cache.get(key);
    if (!hit) {
      reply.header('x-ct-cache', 'miss');
      return false;
    }
    f.cacheHit = true;
    f.cacheStore = undefined;
    f.status = 'ok';
    f.httpStatus = hit.status;
    f.usage = hit.usage;
    f.usageSource = hit.usage ? 'provider' : 'unknown';
    f.cost = 0;
    f.costConfidence = 'exact';
    f.t.ttfb = f.t.ttft = Date.now();
    const body = Buffer.from(hit.body, 'base64');
    f.bytesWritten = body.byteLength;
    if (hit.stream) {
      reply.hijack();
      reply.raw.writeHead(hit.status, { 'content-type': hit.contentType, 'cache-control': 'no-cache, no-transform', 'x-ct-flight-id': f.id, 'x-ct-cache': 'hit' });
      reply.raw.end(body);
    } else {
      await reply.status(hit.status).header('content-type', hit.contentType).header('x-ct-cache', 'hit').send(body);
    }
    return true;
  }

  /** Inspect gates on this path look at what the agent sends: the named fields of the body. */
  async inspectInput(f: Flight, g: Gated, fields: string[]): Promise<void> {
    const ctx = this.ctx;
    const gates = ctx.policy.inspectors?.(g.key, g.target, g.onBehalfOf) ?? [];
    if (!gates.length) return;
    f.inspectOut = gates.filter((x) => x.compiled.direction !== 'input');
    const present = fields.filter((k) => f.body[k] !== undefined);
    if (!present.length) return;
    const picked = Object.fromEntries(present.map((k) => [k, f.body[k]]));
    const r = await inspect(ctx, f.key, gates, 'input', picked);
    emitInspectOutcomes(ctx.bus, f.id, r.outcomes, 'in the request');
    if (r.blocked) {
      f.status = 'denied';
      throw E.contentBlocked(blockedMessage(r.blocked, 'request'), r.blocked.ruleId, r.blocked.findings);
    }
    if (r.value !== picked) Object.assign(f.body, r.value as Record<string, unknown>);
  }

  private emitDecision(f: Flight, decision: 'allow' | 'deny' | 'hold' | 'mutate' | 'flagged', d: PolicyDecision, reason?: string): void {
    this.ctx.bus.emit({
      t: 'flight.decision',
      flight_id: f.id,
      ts: Date.now(),
      decision,
      rule_id: d.ruleId,
      zone_from: d.zoneFrom,
      zone_to: d.zoneTo,
      reason: reason ?? d.reason,
      arg_hash: d.argHash,
    });
  }

  private emitStarted(f: Flight): void {
    if (f.started || !f.key || !f.route) return;
    f.started = true;
    this.ctx.bus.emit({
      t: 'flight.started',
      flight_id: f.id,
      ts: f.t.start,
      key_id: f.key.id,
      key_name: f.key.name,
      agent_id: f.key.agentId,
      team: f.key.team,
      project: f.key.project,
      kind: f.kind,
      dialect: f.dialect,
      stream: f.stream,
      model_requested: f.modelRequested,
      alias_id: f.route.alias?.id,
      deployment_id: f.deployment?.id,
      provider_id: f.provider?.id,
      provider_kind: f.provider?.kind,
      ...(f.chain.length ? { on_behalf_of: f.chain } : {}),
      ...(f.parentFlightId ? { parent_flight_id: f.parentFlightId } : {}),
      ...(f.endpoint ? { endpoint: f.endpoint } : {}),
      ...(f.tags.length ? { tags: f.tags } : {}),
      ...(f.customer ? { customer: f.customer } : {}),
      ...(f.trace ? { trace: f.trace } : {}),
      est_input_tokens: f.estInput,
      projected_nanousd: f.route.projected,
    });
  }

  /** The attempt plan for a call: retries, busy deployments, context windows, fallback models (policy-checked). */
  newPlan(f: Flight, g: Gated, needTokens: number, servedBy?: (p: ProviderRecord) => boolean): AttemptPlan {
    const ctx = this.ctx;
    const plan = new AttemptPlan(ctx, f, g.key, {
      needTokens,
      servedBy,
      allowFallback: async (model) => {
        const target: PolicyTarget = { kind: 'model', name: model, operation: g.target.operation };
        const d = await ctx.policy.evaluate({ flightId: f.id, key: g.key, target, args: g.args, onBehalfOf: g.onBehalfOf, estInputTokens: f.estInput, projectedNanousd: f.route?.projected ?? 0 });
        return d.effect === 'allow';
      },
    });
    f.plan = plan;
    return plan;
  }

  private async dispatch(f: Flight, reply: FastifyReply, g: Gated): Promise<void> {
    const ctx = this.ctx;
    const maxOut = typeof f.body.max_tokens === 'number' ? f.body.max_tokens : typeof f.body.max_completion_tokens === 'number' ? f.body.max_completion_tokens : typeof f.body.max_output_tokens === 'number' ? f.body.max_output_tokens : 0;
    const plan = this.newPlan(f, g, f.kind === 'embeddings' ? f.estInput : f.estInput + maxOut);
    let lastErr: NormalizedError | undefined;
    let last: { dep: DeploymentRecord; err: NormalizedError } | undefined;
    // The Responses API goes as it came to providers that speak it, and through Chat Completions to the rest.
    let asChat: Record<string, unknown> | undefined;
    const responsesAsChat = () => {
      if (asChat) return asChat;
      try {
        return (asChat = responsesRequestToChat(f.body));
      } catch (err) {
        if (err instanceof ResponsesTranslationError) throw E.badRequest(err.message);
        throw err;
      }
    };

    for (let a = await plan.next(); a; a = await plan.next(last)) {
      const { dep, prov } = a;
      const adapter = ctx.adapters.get(prov.kind);
      if (!adapter) {
        last = { dep, err: { code: 'provider_misconfigured', message: `No adapter for ${prov.kind}`, httpStatus: 502, fallback: true, cooldown: false } };
        continue;
      }
      f.attempts++;
      f.deployment = dep;
      f.provider = prov;
      f.t.upstreamSent = Date.now();

      // Translate only when the adapter does not speak the client's dialect natively. A Responses
      // request for a provider without the Responses API is first put in Chat Completions form.
      f.viaChat = f.dialect === 'openai-responses' && !adapter.nativeDialects.has('openai-responses');
      const inDialect: WireDialect = f.viaChat ? 'openai-chat' : f.dialect;
      const inBody = f.viaChat ? responsesAsChat() : f.body;
      const native = adapter.nativeDialects.has(inDialect);
      const targetDialect: WireDialect = native ? inDialect : adapter.nativeDialects.has('anthropic-messages') ? 'anthropic-messages' : 'openai-chat';
      f.translateTo = native ? undefined : targetDialect;
      let outBody: Record<string, unknown> = { ...inBody, model: dep.upstreamModel };
      if (!native) outBody = targetDialect === 'anthropic-messages' ? oaRequestToAnthropic(outBody) : anRequestToOa(outBody);

      const result = await adapter.send(
        {
          flightId: f.id,
          provider: prov,
          deployment: dep,
          signal: f.abort.signal,
          onFirstByte: () => {
            if (f.t.ttfb == null) f.t.ttfb = Date.now();
          },
        },
        outBody,
        { inboundDialect: inDialect, stream: f.stream, upstreamModel: dep.upstreamModel },
      );

      if (result.kind === 'error') {
        lastErr = result.err;
        last = { dep, err: result.err };
        ctx.bus.emit({
          t: 'flight.upstream',
          flight_id: f.id,
          ts: Date.now(),
          attempt: f.attempts,
          deployment_id: dep.id,
          provider_id: prov.id,
          upstream_model: dep.upstreamModel,
          outcome: 'error',
          status: result.err.upstreamStatus,
          error_code: result.err.code,
        });
        if (result.err.cooldown) ctx.registry.markCooldown(dep.id);
        continue;
      }

      ctx.registry.clearCooldown(dep.id);
      // Priced as the deployment that answered: a fallback may be another model.
      f.route!.price = ctx.pricing.resolve(prov.kind, dep.upstreamModel, dep.pricingOverride, prov.slug);
      ctx.bus.emit({
        t: 'flight.upstream',
        flight_id: f.id,
        ts: Date.now(),
        attempt: f.attempts,
        deployment_id: dep.id,
        provider_id: prov.id,
        upstream_model: dep.upstreamModel,
        outcome: 'ok',
        status: result.status,
        ttfb_ms: f.t.ttfb == null ? undefined : f.t.ttfb - f.t.start,
      });

      if (result.kind === 'json') {
        f.usage = result.usage;
        f.usageSource = result.usage ? 'provider' : 'unknown';
        f.httpStatus = result.status;
        f.status = 'ok';
        if (f.t.ttfb == null) f.t.ttfb = Date.now();
        if (f.t.ttft == null) f.t.ttft = f.t.ttfb;
        let bodyOut: Uint8Array = result.body;
        let ctype = result.contentType;
        if (f.translateTo || f.viaChat) {
          try {
            let parsed = JSON.parse(Buffer.from(result.body).toString('utf8')) as Record<string, unknown>;
            if (f.translateTo) parsed = f.translateTo === 'anthropic-messages' ? anthropicResponseToOa(parsed, f.modelRequested) : oaResponseToAnthropic(parsed, f.modelRequested);
            if (f.viaChat) parsed = chatResponseToResponses(parsed, f.modelRequested, requestTools(f.body));
            bodyOut = Buffer.from(JSON.stringify(parsed));
            ctype = 'application/json';
          } catch {
            /* forward as-is */
          }
        }
        if (f.inspectOut.length && f.kind !== 'embeddings') {
          let parsed: unknown;
          try {
            parsed = JSON.parse(Buffer.from(bodyOut).toString('utf8'));
          } catch {
            parsed = undefined;
          }
          if (parsed !== undefined) {
            const r = await inspect(ctx, f.key, f.inspectOut, 'output', parsed);
            emitInspectOutcomes(ctx.bus, f.id, r.outcomes, 'in the response');
            if (r.blocked) {
              f.status = 'denied';
              throw E.contentBlocked(blockedMessage(r.blocked, 'response'), r.blocked.ruleId, r.blocked.findings);
            }
            if (r.value !== parsed) {
              bodyOut = Buffer.from(JSON.stringify(r.value));
              ctype = 'application/json';
            }
          }
        }
        reply.header('content-type', ctype).status(result.status);
        f.bytesWritten = bodyOut.byteLength;
        if (f.cacheStore && result.status < 300 && ctx.cache) {
          void ctx.cache.set(f.cacheStore.key, { status: result.status, contentType: ctype, body: Buffer.from(bodyOut).toString('base64'), stream: false, usage: f.usage, deploymentId: dep.id, storedAt: Date.now() }, f.cacheStore.ttlS);
        }
        await reply.send(Buffer.from(bodyOut));
        return;
      }

      await this.streamOut(f, reply, result.events, result.status, result.contentType);
      return;
    }
    throw lastErr ?? plan.refusal() ?? E.modelNotFound(f.modelRequested);
  }

  private async streamOut(
    f: Flight,
    reply: FastifyReply,
    events: AsyncIterable<import('../providers/adapter.js').UpstreamEvent>,
    status: number,
    contentType: string,
  ): Promise<void> {
    const res = reply.raw;
    const cacheState = reply.getHeader('x-ct-cache');
    reply.hijack();
    res.writeHead(status, {
      'content-type': contentType,
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-ct-flight-id': f.id,
      ...(typeof cacheState === 'string' ? { 'x-ct-cache': cacheState } : {}),
    });
    f.httpStatus = status;
    if (f.t.ttfb == null) f.t.ttfb = Date.now();

    let keepalive: NodeJS.Timeout | undefined;
    const armKeepalive = () => {
      if (keepalive) clearTimeout(keepalive);
      keepalive = setTimeout(() => {
        if (!res.writableEnded) res.write(': ping\n\n');
        armKeepalive();
      }, KEEPALIVE_MS);
      keepalive.unref?.();
    };
    armKeepalive();
    // OpenAI-compat: the usage-only chunk (choices: []) crashes older SDKs unless the client asked for it.
    const clientWantsUsage =
      f.dialect !== 'openai-chat' || (f.body.stream_options as { include_usage?: boolean } | undefined)?.include_usage === true;
    const provXform =
      f.translateTo === 'anthropic-messages'
        ? new AnthropicToOaStream(f.modelRequested, clientWantsUsage)
        : f.translateTo === 'openai-chat'
          ? new OaToAnthropicStream(f.modelRequested, f.estInput)
          : null;
    // A Responses request served through Chat Completions: chat chunks (native, or from the step above) become Responses events.
    const respXform = f.viaChat ? new ChatToResponsesStream(f.modelRequested, requestTools(f.body)) : null;
    const xform = respXform
      ? {
          feed: (parsed: Record<string, unknown>): { frames: string[]; hasContent: boolean } => {
            if (!provXform) return respXform.feed(parsed);
            const frames: string[] = [];
            let hasContent = false;
            for (const fr of provXform.feed(parsed).frames) {
              const chunk = parseSseData(fr);
              if (!chunk) continue;
              const r = respXform.feed(chunk);
              frames.push(...r.frames);
              hasContent ||= r.hasContent;
            }
            return { frames, hasContent };
          },
        }
      : provXform;

    // Streamed replies can only be inspected after delivery: collect the text for a flag-only scan.
    const seen: string[] = [];
    let seenChars = 0;
    const collect = (parsed: Record<string, unknown> | null | undefined): void => {
      if (!parsed || seenChars > MAX_SCAN_CHARS) return;
      collectText(parsed, seen);
      seenChars = seen.reduce((n, x) => n + x.length, 0);
    };
    const inspecting = f.inspectOut.length > 0;

    // A model that caches answers keeps the stream as the client got it, to send again whole.
    const kept: Buffer[] | undefined = f.cacheStore ? [] : undefined;
    let keptBytes = 0;
    const write = async (chunk: Uint8Array | string): Promise<void> => {
      if (res.writableEnded || res.destroyed) return;
      f.bytesWritten += typeof chunk === 'string' ? chunk.length : chunk.byteLength;
      if (kept && keptBytes < 8 * 1024 * 1024) {
        const b = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
        kept.push(b);
        keptBytes += b.byteLength;
      }
      if (!res.write(chunk)) {
        await Promise.race([once(res, 'drain'), once(res, 'close')]);
      }
      armKeepalive();
    };

    try {
      for await (const ev of events) {
        if (f.clientGone) break;
        switch (ev.t) {
          case 'frame': {
            if (xform) {
              const parsed = (ev.parsed as Record<string, unknown> | undefined) ?? parseSseData(ev.raw);
              if (!parsed) break;
              if (inspecting) collect(parsed);
              const r = xform.feed(parsed);
              if (r.hasContent && f.t.ttft == null) {
                f.t.ttft = Date.now();
                if (f.deployment) this.ctx.registry.recordTtft(f.deployment.id, f.t.ttft - f.t.start);
              }
              for (const fr of r.frames) await write(fr);
              break;
            }
            if (ev.usageOnly && !clientWantsUsage) break;
            if (inspecting) collect((ev.parsed as Record<string, unknown> | undefined) ?? parseSseData(ev.raw));
            if (ev.hasContent && f.t.ttft == null) {
              f.t.ttft = Date.now();
              if (f.deployment) this.ctx.registry.recordTtft(f.deployment.id, f.t.ttft - f.t.start);
            }
            await write(ev.raw);
            break;
          }
          case 'usage':
            f.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...(f.usage ?? {}), ...ev.usage } as Usage;
            f.usageSource = 'provider';
            break;
          case 'error':
            f.error = ev.err;
            f.status = 'error';
            await write(errorFrame(f.dialect, { status: ev.err.httpStatus, code: 'provider_stream_error', message: ev.err.message }));
            break;
          case 'done':
            break;
        }
      }
      if (xform instanceof OaToAnthropicStream && !f.clientGone && f.status !== 'error') {
        for (const fr of xform.finish()) await write(fr);
      }
      if (respXform && !f.clientGone && f.status !== 'error') for (const fr of respXform.finish()) await write(fr);
      if (f.status !== 'error') f.status = f.clientGone ? 'client_aborted' : 'ok';
    } catch (err) {
      if (f.clientGone) {
        f.status = 'client_aborted';
      } else {
        f.status = 'error';
        f.error = { code: 'provider_stream_error', message: (err as Error).message, httpStatus: 502, fallback: false, cooldown: false };
        try {
          await write(errorFrame(f.dialect, { status: 502, code: 'provider_stream_error', message: (err as Error).message }));
        } catch {
          /* socket gone */
        }
      }
    } finally {
      if (keepalive) clearTimeout(keepalive);
      if (!res.writableEnded) res.end();
    }
    if (f.status === 'client_aborted' && f.usageSource !== 'provider') f.usageSource = 'estimated_partial';
    if (kept && f.status === 'ok' && keptBytes < 8 * 1024 * 1024 && this.ctx.cache && f.cacheStore) {
      void this.ctx.cache.set(f.cacheStore.key, { status, contentType, body: Buffer.concat(kept).toString('base64'), stream: true, usage: f.usage, deploymentId: f.deployment?.id, storedAt: Date.now() }, f.cacheStore.ttlS);
    }
    if (inspecting && seen.length) {
      const r = await inspect(this.ctx, f.key, f.inspectOut, 'output', seen.join(''), { streamed: true });
      emitInspectOutcomes(this.ctx.bus, f.id, r.outcomes, 'in the response', true);
    }
  }

  private account(f: Flight): void {
    const ctx = this.ctx;
    if (f.cacheHit) return; // answered from the cache: nothing spent
    if (f.usage && f.route) {
      f.cost = computeCost(f.usage, f.route.price.entry);
      f.costConfidence = f.cost == null ? 'unknown' : f.usageSource === 'provider' ? 'exact' : 'estimated';
      if (f.key) ctx.limiter.reconcile(`key:${f.key.id}`, f.usage.input + f.usage.output - f.estInput, f.key.limits);
    } else if (f.route && f.status === 'client_aborted') {
      // No usage from upstream: charge the input-side estimate so a budget cannot be drained silently.
      f.usage = { input: f.estInput, output: 0, cacheRead: 0, cacheWrite: 0 };
      f.usageSource = 'estimated_partial';
      f.cost = computeCost(f.usage, f.route.price.entry);
      f.costConfidence = f.cost == null ? 'unknown' : 'estimated';
    }
  }

  async fail(f: Flight, reply: FastifyReply, err: unknown): Promise<void> {
    if (f.clientGone) {
      // The client went away mid-flight; nothing to send, nothing to log at error level.
      f.status = f.status ?? 'client_aborted';
      f.httpStatus = f.httpStatus || 499;
      f.error = f.error ?? { code: 'client_aborted', message: 'client disconnected', httpStatus: 499, fallback: false, cooldown: false };
      return;
    }
    const ge: GatewayError = isGatewayError(err)
      ? err
      : err && typeof err === 'object' && 'httpStatus' in err
        ? { status: (err as NormalizedError).httpStatus, code: (err as NormalizedError).code, message: (err as NormalizedError).message }
        : { status: 500, code: 'internal_error', message: (err as Error)?.message ?? 'Internal error' };

    if (ge.status === 500) this.ctx.log.error({ err, flight: f.id }, 'flight failed');

    f.error = f.error ?? ge;
    f.httpStatus = ge.status;
    if (!f.status) {
      if (!f.started) f.status = 'rejected';
      else if (ge.code === 'policy_denied') f.status = 'denied';
      else if (ge.code === 'approval_required') f.status = 'ticketed';
      else if (f.clientGone) f.status = 'client_aborted';
      else if (ge.status === 429 || ge.status === 401 || ge.status === 403 || ge.status === 404 || ge.status === 400) f.status = 'rejected';
      else f.status = 'error';
    }

    if (reply.sent || f.bytesWritten > 0) return;
    if (f.key && !f.started && f.route === undefined && ge.status !== 401) {
      // Authenticated but rejected before resolve: still show a pulse on the map.
      f.route = { alias: undefined, candidates: [], price: { source: 'none', key: '', entry: undefined }, projected: 0, budgetScopes: [] };
      this.emitStarted(f);
    }
    await reply.status(ge.status).send(errorBody(f.dialect, ge));
  }

  record(f: Flight): void {
    const ctx = this.ctx;
    f.t.end = Date.now();
    f.releaseSlot?.();
    f.plan?.done();
    if (f.route && f.route.budgetScopes.length) ctx.spend.settle(f.route.budgetScopes, f.route.projected, f.cost);
    if (!f.started) return;
    const err = f.error;
    ctx.bus.emit({
      t: 'flight.completed',
      flight_id: f.id,
      ts: f.t.end,
      status: f.status ?? 'error',
      http_status: f.httpStatus || 500,
      deployment_id: f.deployment?.id,
      usage: f.usage,
      usage_source: f.usageSource,
      cost_nanousd: f.cost,
      cost_confidence: f.costConfidence,
      ttfb_ms: f.t.ttfb == null ? undefined : f.t.ttfb - f.t.start,
      ttft_ms: f.t.ttft == null ? undefined : f.t.ttft - f.t.start,
      duration_ms: f.t.end - f.t.start,
      gateway_overhead_ms: (f.t.upstreamSent ?? f.t.end) - f.t.start,
      ...(f.units ? { units: f.units } : {}),
      ...(f.cacheHit ? { cache_hit: true } : {}),
      error: err
        ? {
            code: err.code,
            message: err.message,
            upstream_status: 'upstreamStatus' in err ? err.upstreamStatus : undefined,
          }
        : undefined,
    });
  }
}

/**
 * A least-cost alias's deployments, cheapest first within each priority tier: by the price of a typical call (input and output
 * per million tokens, weighted 3:1). Deployments without a known price go last, in their own order.
 */
function cheapestFirst(ctx: AppContext, alias: AliasRecord, candidates: DeploymentRecord[]): DeploymentRecord[] {
  const cost = (d: DeploymentRecord): number => {
    const prov = ctx.registry.providers.get(d.providerId);
    const e = prov ? ctx.pricing.resolve(prov.kind, d.upstreamModel, d.pricingOverride, prov.slug).entry : undefined;
    return e ? e.input * 3 + e.output : Number.POSITIVE_INFINITY;
  };
  const c = new Map(candidates.map((d) => [d.id, cost(d)]));
  // Within each priority tier: a later tier stays a fallback, however cheap.
  return byTier(alias, candidates, (a, b) => (c.get(a.id) ?? Infinity) - (c.get(b.id) ?? Infinity));
}
