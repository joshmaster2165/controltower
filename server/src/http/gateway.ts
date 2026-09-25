import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { E } from '../gateway/errors.js';
import { readCapped } from '../util/body.js';
import { request } from 'undici';
import type { AppContext } from '../context.js';
import { globMatch } from '../registry.js';
import { newFlight, type Flight } from '../pipeline/flight.js';
import type { PolicyTarget } from '../policy/engine.js';
import { runInspectors } from '../guardrails/scan.js';
import { blockedMessage, emitInspectOutcomes } from '../guardrails/emit.js';
import { namespaced } from '../mcp/registry.js';
import { ctKey, downstreamHeaders, httpOperation, isTextual, routeLabel, upstreamHeaders, upstreamUrl } from './route.js';
import { DELEGATION_HEADER, headerToken, flagIgnoredToken, loopsBack, resolveDelegation, tokenFor } from '../policy/delegation.js';

/**
 * The HTTP gateway: plain REST APIs, gated like tools. An agent calls
 * `/http/<slug>/<path>` with its Control Tower key (x-ct-key, or a ct_sk_
 * bearer token); Control Tower applies the key's allow-list, rate limits,
 * gates, approvals and inspect gates, then forwards to the registered base
 * URL with the API's stored credentials. The agent never holds them.
 *
 * Each call is a flight of kind `http.request`, named `<slug>__<METHOD /route>`
 * with identifiers folded (`GET /v1/users/:id`), so the map shows one row per
 * route and gates can match routes with the same globs used for MCP tools.
 * Bodies are buffered (up to 10 MB each way) so both directions can be inspected.
 */
const MAX_BODY = 10 * 1024 * 1024;
export const OUTSIDE = '(outside the API)';

type Status = NonNullable<Flight['status']>;

export class HttpGateway {
  constructor(private readonly ctx: AppContext) {}

  register(app: FastifyInstance): void {
    // Bodies pass through as bytes, whatever their type.
    app.removeAllContentTypeParsers();
    app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: MAX_BODY }, (_req, body, done) => done(null, body));
    const handler = (req: FastifyRequest, reply: FastifyReply) => this.handle(req, reply);
    app.all('/http/:slug', handler);
    app.all('/http/:slug/*', handler);
  }

  private async handle(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    const ctx = this.ctx;
    const slug = (req.params as { slug: string }).slug;
    const method = req.method.toUpperCase();
    const rawUrl = req.raw.url ?? '';
    const qi = rawUrl.indexOf('?');
    const rawPath = qi < 0 ? rawUrl : rawUrl.slice(0, qi);
    const search = qi < 0 ? '' : rawUrl.slice(qi);
    const prefix = `/http/${slug}`;
    const rest = rawPath.startsWith(prefix) ? rawPath.slice(prefix.length) || '/' : '/';

    const presented = ctKey(req.headers);
    if (!presented) return reply.status(401).send({ error: { code: 'missing_api_key', message: 'Send your Control Tower key as the x-ct-key header (or Authorization: Bearer ct_sk_…).' } });
    const key = ctx.registry.authenticate(presented.key);
    if (!key || !key.enabled) return reply.status(401).send({ error: { code: 'invalid_api_key', message: 'Unknown or disabled Control Tower key.' } });
    if (key.expiresAt && key.expiresAt < Date.now()) return reply.status(401).send({ error: { code: 'key_expired', message: 'This Control Tower key has expired.' } });

    const api = ctx.http.bySlug.get(slug);
    const url = api ? upstreamUrl(api.baseUrl, rest, search) : null;
    // A refused path gets one fixed label: it must not become a route row on the map.
    const route = api && !url ? `${method} ${OUTSIDE}` : routeLabel(method, rest);
    const full = namespaced(slug, route);
    const raw = Buffer.isBuffer(req.body) ? req.body : undefined;
    const contentType = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : undefined;
    const body = parseBody(raw, contentType);
    const query = Object.fromEntries(new URLSearchParams(search));
    const args: Record<string, unknown> = { method, path: rest, ...(Object.keys(query).length ? { query } : {}), ...(body !== undefined ? { body } : {}) };

    const f: Flight = newFlight('http.request', 'openai-chat', { name: full, arguments: args, stream: false });
    f.modelRequested = full;
    f.key = key;
    f.estInput = Math.max(1, Math.round((raw?.length ?? 0) / 4));
    reply.header('x-ct-flight-id', f.id);
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) f.abort.abort();
    });

    // Whom this call is for, when an agent is acting for another.
    const deleg = resolveDelegation(ctx, key, headerToken(req.headers));
    f.chain = deleg.chain ?? [];
    f.parentFlightId = deleg.parentFlightId;
    const onBehalfOf = 'error' in deleg ? [] : deleg.onBehalfOf;
    const started = (): void => {
      if (f.started) return;
      f.started = true;
      ctx.bus.emit({ t: 'flight.started', flight_id: f.id, ts: f.t.start, key_id: key.id, key_name: key.name, agent_id: key.agentId, team: key.team, project: key.project, kind: 'http.request', dialect: 'http', stream: false, model_requested: full, mcp_server_id: api?.id, tool: route, ...(f.chain.length ? { on_behalf_of: f.chain } : {}), ...(f.parentFlightId ? { parent_flight_id: f.parentFlightId } : {}), est_input_tokens: f.estInput, projected_nanousd: 0 });
    };
    const complete = (status: Status, http: number, error?: { code: string; message: string }, outBytes = 0): void => {
      f.t.end = Date.now();
      if (!f.started) return;
      ctx.bus.emit({ t: 'flight.completed', flight_id: f.id, ts: f.t.end, status, http_status: http, usage: { input: f.estInput, output: Math.round(outBytes / 4), cacheRead: 0, cacheWrite: 0 }, usage_source: 'estimated', cost_nanousd: 0, cost_confidence: 'exact', duration_ms: f.t.end - f.t.start, gateway_overhead_ms: (f.t.upstreamSent ?? f.t.end) - f.t.start, error });
    };
    /** Refusals carry a readable message plus a small JSON envelope the agent (or its model) can act on. */
    const refuse = (http: number, status: Status, code: string, message: string, extra: Record<string, unknown> = {}) => {
      complete(status, http, { code, message });
      return reply.status(http).header('x-ct-status', code).send({ error: { code, message, ct_status: code, flight_id: f.id, ...extra } });
    };

    started();
    if (ctx.shuttingDown) return refuse(503, 'shutdown', 'shutting_down', 'Control Tower is restarting; retry shortly.');
    if ('error' in deleg) return refuse(deleg.error.status, 'rejected', deleg.error.code, deleg.error.message);
    if (deleg.invalid) flagIgnoredToken(ctx, f.id, deleg.invalid);
    if (!api || !api.enabled) return refuse(404, 'rejected', 'api_not_found', `No HTTP API "${slug}" is registered in Control Tower.`);
    if (!url) return refuse(400, 'denied', 'path_not_allowed', 'That path leaves the registered API (dot segments and encoded dots are refused).');
    if (!key.allowedMcp.some((g) => globMatch(g, full))) return refuse(403, 'denied', 'tool_not_allowed', `This key may not call ${slug} (${route}).`);
    if (loopsBack(f.chain, api.agentId)) return refuse(403, 'rejected', 'delegation_loop', E.delegationLoop(api.agentId!).message);
    const admit = ctx.limiter.admit(`key:${key.id}`, 1, key.limits);
    if (!admit.ok) {
      reply.header('retry-after', String(Math.ceil(admit.retryAfterMs / 1000)));
      return refuse(429, 'rejected', 'rate_limit_exceeded', 'Rate limit exceeded for this key.', { retry_after_ms: admit.retryAfterMs });
    }

    try {
      // ---- policy, with the real request as arguments ----
      const target: PolicyTarget = { kind: 'tool', name: full, mcpServerId: api.id, operation: httpOperation(method) };
      let decision = await ctx.policy.evaluate({ flightId: f.id, key, target, args, onBehalfOf, estInputTokens: f.estInput, projectedNanousd: 0 });
      const approval = req.headers['x-ct-approval'];
      if (decision.effect === 'hold' && typeof approval === 'string' && approval) {
        const r = await ctx.approvals.redeem(approval, key.id, (decision as { scopeHash?: string }).scopeHash ?? '', undefined);
        if (r.ok) decision = { ...decision, effect: 'allow', reason: `approved (grant …${r.grantId.slice(-6)})` };
        else if (r.reason === 'pending') {
          ctx.bus.emit({ t: 'flight.decision', flight_id: f.id, ts: Date.now(), decision: 'hold', rule_id: decision.ruleId, reason: 'ticket still pending' });
          reply.header('retry-after', String(Math.ceil((r.retryAfterMs ?? 15_000) / 1000)));
          return refuse(403, 'ticketed', 'approval_pending', 'Approval is still pending. Retry the same request with the same x-ct-approval header later.', { ticket: approval });
        } else if (r.reason === 'denied' || r.reason === 'scope_mismatch') {
          ctx.bus.emit({ t: 'flight.decision', flight_id: f.id, ts: Date.now(), decision: 'deny', rule_id: decision.ruleId, reason: r.reason });
          return refuse(403, 'denied', 'policy_denied', r.reason === 'scope_mismatch' ? 'The approval was for a different request (scope mismatch). Ask again with the original request.' : 'Denied by an approver.', { reason: r.reason });
        }
      }
      ctx.bus.emit({ t: 'flight.decision', flight_id: f.id, ts: Date.now(), decision: decision.effect === 'hold' ? 'hold' : decision.effect, rule_id: decision.ruleId, zone_from: decision.zoneFrom, zone_to: decision.zoneTo, reason: decision.reason, arg_hash: decision.argHash });
      if (decision.effect === 'deny') return refuse(403, 'denied', 'policy_denied', `${decision.reason ?? 'Blocked by Control Tower policy.'} Do not attempt to work around this restriction.`, { rule_id: decision.ruleId });
      if (decision.effect === 'hold') {
        const outcome = await ctx.approvals.hold(f, decision);
        if (outcome.kind === 'denied') return refuse(403, 'denied', 'policy_denied', outcome.error.message, { rule_id: decision.ruleId });
        if (outcome.kind === 'ticketed') {
          const ct = (outcome.error.extra?.ct as Record<string, unknown> | undefined) ?? {};
          if (typeof ct.ticket === 'string') reply.header('x-ct-approval-ticket', ct.ticket);
          return refuse(403, 'ticketed', 'approval_required', outcome.error.message, { ...ct, how_to_resume: 'Retry this exact request with the header x-ct-approval: <ticket> once a human approves.' });
        }
      }

      // ---- inspect what is being sent ----
      const gates = ctx.policy.inspectors?.(key, target, onBehalfOf) ?? [];
      let outBody: Buffer | undefined = raw && method !== 'GET' && method !== 'HEAD' ? raw : undefined;
      if (gates.length && body !== undefined) {
        const r = runInspectors(gates, 'input', body);
        emitInspectOutcomes(ctx.bus, f.id, r.outcomes, 'in the request');
        if (r.blocked) return refuse(400, 'denied', 'content_blocked', blockedMessage(r.blocked, 'request'), { rule_id: r.blocked.ruleId, findings: r.blocked.findings });
        if (r.value !== body) outBody = Buffer.from(typeof r.value === 'string' ? r.value : JSON.stringify(r.value));
      }

      // ---- forward ----
      f.t.upstreamSent = Date.now();
      const res = await request(url, {
        method: method as 'GET',
        // An API that fronts an agent is told whom the call is for: that agent passes the token on with its own calls.
        headers: { ...upstreamHeaders(req.headers, presented.source, api.auth), ...(api.agentId ? { [DELEGATION_HEADER]: tokenFor(ctx, f.chain, key, api.agentId, f.id) } : {}) },
        body: outBody ?? null,
        signal: AbortSignal.any([f.abort.signal, AbortSignal.timeout(api.timeoutMs)]),
        headersTimeout: api.timeoutMs,
        bodyTimeout: api.timeoutMs,
      });
      f.t.ttfb = Date.now();
      let data = await readCapped(res.body, MAX_BODY);
      if (!data) {
        ctx.bus.emit({ t: 'flight.upstream', flight_id: f.id, ts: Date.now(), attempt: 1, deployment_id: api.id, provider_id: api.id, upstream_model: route, outcome: 'error', status: res.statusCode, error_code: 'response_too_large' });
        return refuse(502, 'error', 'response_too_large', 'The API replied with more than 10 MB; Control Tower does not relay replies that large.');
      }
      ctx.bus.emit({ t: 'flight.upstream', flight_id: f.id, ts: Date.now(), attempt: 1, deployment_id: api.id, provider_id: api.id, upstream_model: route, outcome: res.statusCode < 500 ? 'ok' : 'error', status: res.statusCode, ttfb_ms: f.t.ttfb - f.t.start });

      // ---- inspect what comes back: what the agent is about to read ----
      const resType = headerValue(res.headers['content-type']);
      if (gates.length && !res.headers['content-encoding'] && isTextual(resType)) {
        const parsed = parseBody(data, resType);
        const r = runInspectors(gates, 'output', parsed);
        emitInspectOutcomes(ctx.bus, f.id, r.outcomes, 'in the response');
        if (r.blocked) return refuse(403, 'denied', 'content_blocked', blockedMessage(r.blocked, 'response'), { rule_id: r.blocked.ruleId, findings: r.blocked.findings });
        if (r.value !== parsed) data = Buffer.from(typeof r.value === 'string' ? r.value : JSON.stringify(r.value));
      }

      const status = res.statusCode;
      complete(status < 400 ? 'ok' : 'error', status, status < 400 ? undefined : { code: `upstream_${status}`, message: `the API answered ${status}` }, data.length);
      return reply.status(status).headers(downstreamHeaders(res.headers)).send(data);
    } catch (err) {
      const e = err as Error & { code?: string; name?: string };
      if (f.abort.signal.aborted) {
        complete('client_aborted', 499, { code: 'client_aborted', message: 'client disconnected' });
        return reply;
      }
      const timeout = e.name === 'TimeoutError' || e.code === 'UND_ERR_HEADERS_TIMEOUT' || e.code === 'UND_ERR_BODY_TIMEOUT' || e.code === 'UND_ERR_CONNECT_TIMEOUT';
      ctx.bus.emit({ t: 'flight.upstream', flight_id: f.id, ts: Date.now(), attempt: 1, deployment_id: api.id, provider_id: api.id, upstream_model: route, outcome: 'error', error_code: timeout ? 'timeout' : 'unreachable' });
      return timeout
        ? refuse(504, 'error', 'upstream_timeout', `${api.name} did not answer within ${Math.round(api.timeoutMs / 1000)} s.`)
        : refuse(502, 'error', 'upstream_unreachable', `Could not reach ${api.name}: ${e.message}`);
    }
  }
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** JSON bodies become objects (so gates can match fields); other text stays text; binary is left alone. */
function parseBody(raw: Buffer | undefined, contentType: string | undefined): unknown {
  if (!raw?.length || !isTextual(contentType)) return undefined;
  const text = raw.toString('utf8');
  if (contentType?.toLowerCase().includes('json')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}


