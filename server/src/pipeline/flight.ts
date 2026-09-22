import { once } from 'node:events';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ulid } from 'ulid';
import type { FlightKind, FlightStatus, Usage, UsageSource, CostConfidence } from '@controltower/shared';
import type { AppContext } from '../context.js';
import type { AliasRecord, DeploymentRecord, KeyRecord, ProviderRecord } from '../registry.js';
import type { NormalizedError, WireDialect } from '../providers/adapter.js';
import type { PriceRef } from '../pricing/index.js';
import { computeCost, projectCost } from '../pricing/index.js';
import { E, errorBody, errorFrame, type GatewayError } from '../gateway/errors.js';
import type { PolicyDecision } from '../policy/engine.js';
import { AnthropicToOaStream, anthropicResponseToOa, oaRequestToAnthropic } from '../translate/openai-anthropic.js';
import { OaToAnthropicStream, anRequestToOa, oaResponseToAnthropic } from '../translate/anthropic-openai.js';

/** Extract the JSON payload of a raw SSE frame; null for comments, [DONE] and non-JSON. */
function parseSseData(raw: Uint8Array): Record<string, unknown> | null {
  const text = Buffer.from(raw).toString('utf8');
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
  /** Set when the upstream adapter speaks a different dialect than the client: its native dialect. */
  translateTo: WireDialect | undefined;
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
}

const MAX_ATTEMPTS = 3;
const KEEPALIVE_MS = 15_000;

export interface RunOptions {
  /** Bypass header auth with a known key (admin playground). */
  keyOverride?: KeyRecord;
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
    translateTo: undefined,
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
  if (Array.isArray(body.tools)) chars += JSON.stringify(body.tools).length;
  if (typeof body.input === 'string') chars += body.input.length;
  else if (Array.isArray(body.input)) chars += JSON.stringify(body.input).length;
  return Math.max(1, Math.round(chars / 4));
}

export function extractApiKey(req: FastifyRequest): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  const xk = req.headers['x-api-key'];
  if (typeof xk === 'string' && xk) return xk.trim();
  return undefined;
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

  /** Entry for /v1/chat/completions (openai-chat) and /v1/messages (anthropic-messages). */
  async runChat(req: FastifyRequest, reply: FastifyReply, dialect: WireDialect, runOpts: RunOptions = {}): Promise<void> {
    const ctx = this.ctx;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const f = newFlight(dialect === 'anthropic-messages' ? 'messages' : 'chat', dialect, body);
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
      if (!Array.isArray(body.messages)) throw E.badRequest('Missing required field: messages (array).');
      f.estInput = estimateInputTokens(body);

      // ---- auth ----
      const presented = extractApiKey(req);
      const key = runOpts.keyOverride ?? (presented ? ctx.registry.authenticate(presented) : undefined);
      if (!key) throw E.unauthorized();
      f.key = key;
      if (!key.enabled) throw E.keyDisabled();
      if (key.expiresAt && key.expiresAt < Date.now()) throw E.keyExpired();

      // ---- admission ----
      if (!ctx.registry.keyMayUseModel(key, f.modelRequested)) throw E.modelNotAllowed(f.modelRequested);
      const maxParallel = key.limits.maxParallel ?? 0;
      const release = ctx.limiter.acquireSlot(`key:${key.id}`, maxParallel);
      if (!release) throw E.tooManyParallel(maxParallel);
      f.releaseSlot = release;
      const admit = ctx.limiter.admit(`key:${key.id}`, f.estInput, key.limits);
      if (!admit.ok) {
        reply.header('retry-after', String(Math.ceil(admit.retryAfterMs / 1000)));
        throw E.rateLimited(admit.which ?? 'rpm', admit.retryAfterMs);
      }

      // ---- resolve ----
      const res = ctx.registry.resolveModel(f.modelRequested);
      if (res.candidates.length === 0) throw E.modelNotFound(f.modelRequested);
      const head = res.candidates[0]!;
      const headProv = ctx.registry.providers.get(head.providerId);
      const price = headProv
        ? ctx.pricing.resolve(headProv.kind, head.upstreamModel, head.pricingOverride, headProv.slug)
        : { source: 'none' as const, key: head.upstreamModel, entry: undefined };
      const maxOut = typeof body.max_tokens === 'number' ? body.max_tokens : Math.min(price.entry?.max_output ?? 4096, 4096);
      const projected = projectCost(f.estInput, maxOut, price.entry);
      const budgetScopes = [`key:${key.id}`, key.team ? `team:${key.team}` : '', key.project ? `project:${key.project}` : ''].filter(Boolean);
      const over = ctx.spend.reserve(budgetScopes, projected);
      if (over) throw E.budgetExceeded(over.scope);
      f.route = { alias: res.alias, candidates: res.candidates, price, projected, budgetScopes };
      f.deployment = head;
      f.provider = headProv;
      this.emitStarted(f);

      // ---- policy ----
      // Policy is evaluated against the primary route; fallbacks stay within the same alias.
      let decision = await ctx.policy.evaluate({
        flightId: f.id,
        key,
        target: {
          kind: 'model',
          name: f.modelRequested,
          providerId: headProv?.id,
          providerKind: headProv?.kind,
          deploymentId: head.id,
          operation: 'read',
        },
        args: { model: f.modelRequested, max_tokens: body.max_tokens, stream: f.stream, tools: toolNames(body) },
        estInputTokens: f.estInput,
        projectedNanousd: projected,
      });

      // A retry may carry a ticket or grant from an earlier hold.
      const presentedApproval = req.headers['x-ct-approval'];
      if (decision.effect === 'hold' && typeof presentedApproval === 'string' && presentedApproval) {
        const scope = (decision as { scopeHash?: string }).scopeHash ?? '';
        const r = await ctx.approvals.redeem(presentedApproval, key.id, scope, sessionIdOf(req, body));
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

      // ---- dispatch + egress ----
      await this.dispatch(f, reply);

      // ---- account ----
      this.account(f);
    } catch (err) {
      await this.fail(f, reply, err);
    } finally {
      this.record(f);
    }
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
      dialect: f.dialect === 'anthropic-messages' ? 'anthropic-messages' : 'openai-chat',
      stream: f.stream,
      model_requested: f.modelRequested,
      alias_id: f.route.alias?.id,
      deployment_id: f.deployment?.id,
      provider_id: f.provider?.id,
      provider_kind: f.provider?.kind,
      est_input_tokens: f.estInput,
      projected_nanousd: f.route.projected,
    });
  }

  private async dispatch(f: Flight, reply: FastifyReply): Promise<void> {
    const ctx = this.ctx;
    const candidates = f.route!.candidates.slice(0, MAX_ATTEMPTS);
    let lastErr: NormalizedError | undefined;

    for (const dep of candidates) {
      const prov = ctx.registry.providers.get(dep.providerId);
      const adapter = prov ? ctx.adapters.get(prov.kind) : undefined;
      if (!prov || !adapter) continue;
      f.attempts++;
      f.deployment = dep;
      f.provider = prov;
      f.t.upstreamSent = Date.now();

      // Translate only when the adapter does not speak the client's dialect natively.
      const native = adapter.nativeDialects.has(f.dialect);
      const targetDialect: WireDialect = native ? f.dialect : adapter.nativeDialects.has('anthropic-messages') ? 'anthropic-messages' : 'openai-chat';
      f.translateTo = native ? undefined : targetDialect;
      let outBody: Record<string, unknown> = { ...f.body, model: dep.upstreamModel };
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
        { inboundDialect: f.dialect, stream: f.stream, upstreamModel: dep.upstreamModel },
      );

      if (result.kind === 'error') {
        lastErr = result.err;
        const more = f.attempts < candidates.length && result.err.fallback && f.bytesWritten === 0;
        ctx.bus.emit({
          t: 'flight.upstream',
          flight_id: f.id,
          ts: Date.now(),
          attempt: f.attempts,
          deployment_id: dep.id,
          provider_id: prov.id,
          upstream_model: dep.upstreamModel,
          outcome: more ? 'fallback' : 'error',
          status: result.err.upstreamStatus,
          error_code: result.err.code,
        });
        if (result.err.cooldown) ctx.registry.markCooldown(dep.id);
        if (more) continue;
        throw result.err;
      }

      ctx.registry.clearCooldown(dep.id);
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
        if (f.translateTo) {
          try {
            const parsed = JSON.parse(Buffer.from(result.body).toString('utf8')) as Record<string, unknown>;
            const translated = f.translateTo === 'anthropic-messages' ? anthropicResponseToOa(parsed, f.modelRequested) : oaResponseToAnthropic(parsed, f.modelRequested);
            bodyOut = Buffer.from(JSON.stringify(translated));
            ctype = 'application/json';
          } catch {
            /* forward as-is */
          }
        }
        reply.header('content-type', ctype).status(result.status);
        f.bytesWritten = bodyOut.byteLength;
        await reply.send(Buffer.from(bodyOut));
        return;
      }

      await this.streamOut(f, reply, result.events, result.status, result.contentType);
      return;
    }
    throw lastErr ?? E.modelNotFound(f.modelRequested);
  }

  private async streamOut(
    f: Flight,
    reply: FastifyReply,
    events: AsyncIterable<import('../providers/adapter.js').UpstreamEvent>,
    status: number,
    contentType: string,
  ): Promise<void> {
    const res = reply.raw;
    reply.hijack();
    res.writeHead(status, {
      'content-type': contentType,
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-ct-flight-id': f.id,
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
    const xform =
      f.translateTo === 'anthropic-messages'
        ? new AnthropicToOaStream(f.modelRequested, clientWantsUsage)
        : f.translateTo === 'openai-chat'
          ? new OaToAnthropicStream(f.modelRequested, f.estInput)
          : null;

    const write = async (chunk: Uint8Array | string): Promise<void> => {
      if (res.writableEnded || res.destroyed) return;
      f.bytesWritten += typeof chunk === 'string' ? chunk.length : chunk.byteLength;
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
              const r = xform.feed(parsed);
              if (r.hasContent && f.t.ttft == null) {
                f.t.ttft = Date.now();
                if (f.deployment) this.ctx.registry.recordTtft(f.deployment.id, f.t.ttft - f.t.start);
              }
              for (const fr of r.frames) await write(fr);
              break;
            }
            if (ev.usageOnly && !clientWantsUsage) break;
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
  }

  private account(f: Flight): void {
    const ctx = this.ctx;
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

  private async fail(f: Flight, reply: FastifyReply, err: unknown): Promise<void> {
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

  private record(f: Flight): void {
    const ctx = this.ctx;
    f.t.end = Date.now();
    f.releaseSlot?.();
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
