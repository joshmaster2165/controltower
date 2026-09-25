import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { once } from 'node:events';
import { request } from 'undici';
import type { AppContext } from '../context.js';
import { globMatch } from '../registry.js';
import { usableKey } from '../gateway/key.js';
import { newFlight, type Flight } from '../pipeline/flight.js';
import type { PolicyTarget } from '../policy/engine.js';
import { runInspectors } from '../guardrails/scan.js';
import { blockedMessage, emitInspectOutcomes } from '../guardrails/emit.js';
import { namespaced } from '../mcp/registry.js';
import { DELEGATION_HEADER, DELEGATION_META, headerToken, flagIgnoredToken, resolveDelegation, tokenFor } from '../policy/delegation.js';
import { CARD_PATH, LEGACY_CARD_PATH, METHODS, publishedCard, skillsOf } from './card.js';
import { authHeaders, type A2aAgentRecord } from './registry.js';
import { readCapped } from '../util/body.js';

type Json = Record<string, unknown>;
type Status = NonNullable<Flight['status']>;
const MAX_BODY = 10 * 1024 * 1024;
/** A2A service parameters a caller may send the agent (A2A-Version, A2A-Extensions). */
const PASS_HEADERS = ['a2a-version', 'a2a-extensions'];

/**
 * What a gate's decision — and an approval — is bound to: the call without what changes on every
 * try of the same call. SDKs make a new messageId per send; the retry carries the approval ticket;
 * each call gets a new delegation token.
 */
export function stableArgs(params: Json): Json {
  const out: Json = { ...params };
  if (params.message && typeof params.message === 'object') {
    const m = { ...(params.message as Json) };
    delete m.messageId;
    out.message = m;
  }
  if (params.metadata && typeof params.metadata === 'object') {
    const md = { ...(params.metadata as Json) };
    delete md.ct_approval;
    delete md[DELEGATION_META];
    // Metadata that only carried those is the same call as none at all.
    if (Object.keys(md).length) out.metadata = md;
    else delete out.metadata;
  }
  return out;
}

/**
 * The A2A gateway. A remote agent registered under **A2A agents** is served
 * at `/a2a/<slug>`: its Agent Card (`/a2a/<slug>/.well-known/agent-card.json`)
 * as published by Control Tower — pointing at `/a2a/<slug>` and asking for a
 * Control Tower key — and its JSON-RPC methods, forwarded with the agent's
 * own credentials. Each call is a flight of kind `a2a.call` named
 * `<slug>__<Method>` (`research__SendMessage`), gated like a tool: the key's
 * allow-list, rate limits, gates, approvals and inspect gates (on the message,
 * and on the reply unless it is streamed). The agent is sent a delegation
 * token, in the request's `metadata` and the `x-ct-delegation` header, to pass
 * on with its own calls. Both A2A 1.0 and 0.3 method names are accepted.
 */
export class A2aGateway {
  constructor(private readonly ctx: AppContext) {}

  register(app: FastifyInstance): void {
    app.get('/a2a', (req, reply) => this.list(req, reply));
    for (const p of [CARD_PATH, LEGACY_CARD_PATH]) app.get(`/a2a/:slug${p}`, (req, reply) => this.card(req, reply));
    app.post('/a2a/:slug', { bodyLimit: MAX_BODY }, (req, reply) => this.rpc(req, reply));
  }

  private base(req: FastifyRequest): string {
    return (this.ctx.config.publicUrl ?? `${req.protocol}://${req.headers.host ?? 'localhost'}`).replace(/\/+$/, '');
  }

  private agentFor(slug: string): A2aAgentRecord | undefined {
    const a = this.ctx.a2a.bySlug.get(slug);
    return a && a.enabled ? a : undefined;
  }

  /** The agents this key may reach, with where to find their cards. */
  private async list(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    const key = usableKey(this.ctx, req);
    if (!key) return reply.status(401).send({ error: { code: 'invalid_api_key', message: 'Send your Control Tower key as Authorization: Bearer ct_sk_….' } });
    const base = this.base(req);
    const agents = [...this.ctx.a2a.agents.values()]
      .filter((a) => a.enabled && key.allowedMcp.some((g) => globMatch(g, namespaced(a.slug, 'SendMessage'))))
      .map((a) => ({ name: a.name, slug: a.slug, description: String(a.card?.description ?? ''), card: `${base}/a2a/${a.slug}${CARD_PATH}`, skills: skillsOf(a.card) }));
    return { agents };
  }

  private async card(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    const key = usableKey(this.ctx, req);
    if (!key) return reply.status(401).send({ error: { code: 'invalid_api_key', message: 'Send your Control Tower key as Authorization: Bearer ct_sk_….' } });
    const agent = this.agentFor((req.params as { slug: string }).slug);
    if (agent && !key.allowedMcp.some((g) => globMatch(g, namespaced(agent.slug, 'SendMessage')))) return reply.status(403).send({ error: { code: 'tool_not_allowed', message: 'This key may not call that agent.' } });
    if (!agent?.card || !agent.endpoint) return reply.status(404).send({ error: { code: 'agent_not_found', message: 'No A2A agent with that name is registered (or its card could not be read).' } });
    return publishedCard(agent.card, `${this.base(req)}/a2a/${agent.slug}`, agent.protocolVersion ?? '1.0');
  }

  private async rpc(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    const ctx = this.ctx;
    const slug = (req.params as { slug: string }).slug;
    const body = req.body as Json | undefined;
    const id = body && typeof body === 'object' && !Array.isArray(body) ? (body.id ?? null) : null;
    const rpcError = (http: number, code: number, message: string, info: Record<string, string> = {}) =>
      reply
        .status(http)
        .header('content-type', 'application/json')
        .send({ jsonrpc: '2.0', id, error: { code, message, data: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: info.reason ?? 'CONTROL_TOWER', domain: 'controltower', metadata: info }] } });

    if (!body || typeof body !== 'object' || Array.isArray(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') return rpcError(400, -32600, 'Request payload validation error: a single JSON-RPC 2.0 request is expected.');
    const key = usableKey(ctx, req);
    if (!key) return rpcError(401, 401, 'Missing or invalid Control Tower key: send it as Authorization: Bearer ct_sk_….', { reason: 'INVALID_API_KEY' });
    const agent = this.agentFor(slug);
    if (!agent?.endpoint) return rpcError(404, 404, `No A2A agent "${slug}" is registered in Control Tower (or its card could not be read).`, { reason: 'AGENT_NOT_FOUND' });
    const method = body.method;
    const info = METHODS[method];
    if (!info) return rpcError(200, -32601, `Method not found: ${method}`);
    const params = (body.params && typeof body.params === 'object' ? { ...(body.params as Json) } : {}) as Json;
    const full = namespaced(agent.slug, info.name);

    const f: Flight = newFlight('a2a.call', 'openai-chat', { name: full, method, arguments: params, stream: !!info.stream });
    f.modelRequested = full;
    f.key = key;
    f.estInput = Math.max(1, Math.round(JSON.stringify(params).length / 4));
    reply.header('x-ct-flight-id', f.id);
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) f.abort.abort();
    });

    // Whom this call is for, when an agent is acting for another: the token arrives in metadata or as a header.
    const meta = (params.metadata && typeof params.metadata === 'object' ? { ...(params.metadata as Json) } : {}) as Json;
    const deleg = resolveDelegation(ctx, key, typeof meta[DELEGATION_META] === 'string' ? (meta[DELEGATION_META] as string) : headerToken(req.headers));
    f.chain = deleg.chain ?? [];
    f.parentFlightId = deleg.parentFlightId;
    const onBehalfOf = 'error' in deleg ? [] : deleg.onBehalfOf;

    const started = (): void => {
      if (f.started) return;
      f.started = true;
      ctx.bus.emit({ t: 'flight.started', flight_id: f.id, ts: f.t.start, key_id: key.id, key_name: key.name, agent_id: key.agentId, team: key.team, project: key.project, kind: 'a2a.call', dialect: 'a2a', stream: !!info.stream, model_requested: full, mcp_server_id: agent.id, tool: info.name, ...(f.chain.length ? { on_behalf_of: f.chain } : {}), ...(f.parentFlightId ? { parent_flight_id: f.parentFlightId } : {}), est_input_tokens: f.estInput, projected_nanousd: 0 });
    };
    const complete = (status: Status, http: number, error?: { code: string; message: string }, outBytes = 0): void => {
      f.t.end = Date.now();
      if (!f.started) return;
      ctx.bus.emit({ t: 'flight.completed', flight_id: f.id, ts: f.t.end, status, http_status: http, usage: { input: f.estInput, output: Math.round(outBytes / 4), cacheRead: 0, cacheWrite: 0 }, usage_source: 'estimated', cost_nanousd: 0, cost_confidence: 'exact', duration_ms: f.t.end - f.t.start, gateway_overhead_ms: (f.t.upstreamSent ?? f.t.end) - f.t.start, error });
    };
    const refuse = (http: number, status: Status, code: string, message: string, extra: Record<string, string> = {}) => {
      complete(status, http, { code, message });
      return rpcError(http, http, message, { reason: code.toUpperCase(), flight_id: f.id, ...extra });
    };

    started();
    if (ctx.shuttingDown) return refuse(503, 'shutdown', 'shutting_down', 'Control Tower is restarting; retry shortly.');
    if ('error' in deleg) return refuse(deleg.error.status, 'rejected', deleg.error.code, deleg.error.message);
    if (deleg.invalid) flagIgnoredToken(ctx, f.id, deleg.invalid);
    if (!key.allowedMcp.some((g) => globMatch(g, full))) return refuse(403, 'denied', 'tool_not_allowed', `This key may not call ${agent.name} (${info.name}).`);
    const admit = ctx.limiter.admit(`key:${key.id}`, 1, key.limits);
    if (!admit.ok) return refuse(429, 'rejected', 'rate_limit_exceeded', 'Rate limit exceeded for this key.', { retry_after_ms: String(admit.retryAfterMs) });

    try {
      // ---- policy, with the real message as arguments ----
      const target: PolicyTarget = { kind: 'tool', name: full, mcpServerId: agent.id, operation: info.op };
      let decision = await ctx.policy.evaluate({ flightId: f.id, key, target, args: stableArgs(params), onBehalfOf, estInputTokens: f.estInput, projectedNanousd: 0 });
      const approval = typeof meta.ct_approval === 'string' ? meta.ct_approval : req.headers['x-ct-approval'];
      if (decision.effect === 'hold' && typeof approval === 'string' && approval) {
        const r = await ctx.approvals.redeem(approval, key.id, (decision as { scopeHash?: string }).scopeHash ?? '', undefined);
        if (r.ok) decision = { ...decision, effect: 'allow', reason: `approved (grant …${r.grantId.slice(-6)})` };
        else if (r.reason === 'pending') {
          ctx.bus.emit({ t: 'flight.decision', flight_id: f.id, ts: Date.now(), decision: 'hold', rule_id: decision.ruleId, reason: 'ticket still pending' });
          return refuse(403, 'ticketed', 'approval_pending', 'Approval is still pending. Retry the same call with the same approval token later.', { ticket: approval });
        } else if (r.reason === 'denied' || r.reason === 'scope_mismatch') {
          ctx.bus.emit({ t: 'flight.decision', flight_id: f.id, ts: Date.now(), decision: 'deny', rule_id: decision.ruleId, reason: r.reason });
          return refuse(403, 'denied', 'policy_denied', r.reason === 'scope_mismatch' ? 'The approval was for a different message (scope mismatch). Ask again with the original message.' : 'Denied by an approver.');
        }
      }
      ctx.bus.emit({ t: 'flight.decision', flight_id: f.id, ts: Date.now(), decision: decision.effect === 'hold' ? 'hold' : decision.effect, rule_id: decision.ruleId, zone_from: decision.zoneFrom, zone_to: decision.zoneTo, reason: decision.reason, arg_hash: decision.argHash });
      if (decision.effect === 'deny') return refuse(403, 'denied', 'policy_denied', `${decision.reason ?? 'Blocked by Control Tower policy.'} Do not attempt to work around this restriction.`, decision.ruleId ? { rule_id: decision.ruleId } : {});
      if (decision.effect === 'hold') {
        const outcome = await ctx.approvals.hold(f, decision);
        if (outcome.kind === 'denied') return refuse(403, 'denied', 'policy_denied', outcome.error.message);
        if (outcome.kind === 'ticketed') {
          const ct = (outcome.error.extra?.ct as Record<string, unknown> | undefined) ?? {};
          return refuse(403, 'ticketed', 'approval_required', `${outcome.error.message} Retry this exact call with metadata.ct_approval (or the x-ct-approval header) set to the ticket.`, ct.ticket ? { ticket: String(ct.ticket), request_id: String(ct.request_id ?? '') } : {});
        }
      }

      // ---- inspect the message ----
      const gates = ctx.policy.inspectors?.(key, target, onBehalfOf) ?? [];
      let outParams: Json = params;
      if (gates.length && info.message) {
        const r = runInspectors(gates, 'input', params.message);
        emitInspectOutcomes(ctx.bus, f.id, r.outcomes, 'in the message');
        if (r.blocked) return refuse(400, 'denied', 'content_blocked', blockedMessage(r.blocked, 'request'), { rule_id: r.blocked.ruleId });
        if (r.value !== params.message) outParams = { ...params, message: r.value };
      }

      // ---- forward, with the agent's credentials and a delegation token for it ----
      const token = agent.agentId ? tokenFor(ctx, f.chain, key, agent.agentId, f.id) : undefined;
      // The caller's own token and approval ticket stay here; the agent gets a token of its own, if it is linked to a key.
      const outMeta: Json = { ...meta };
      delete outMeta.ct_approval;
      delete outMeta[DELEGATION_META];
      if (token) outMeta[DELEGATION_META] = token;
      const outBody: Json = { ...outParams };
      if (Object.keys(outMeta).length) outBody.metadata = outMeta;
      else delete outBody.metadata;
      const upstreamBody = JSON.stringify({ jsonrpc: '2.0', id, method, params: outBody });
      const headers: Record<string, string> = { 'content-type': 'application/json', accept: info.stream ? 'text/event-stream' : 'application/json', ...authHeaders(agent.auth), ...(token ? { [DELEGATION_HEADER]: token } : {}) };
      for (const h of PASS_HEADERS) {
        const v = req.headers[h];
        if (typeof v === 'string') headers[h] = v;
      }
      f.t.upstreamSent = Date.now();
      const res = await request(agent.endpoint, {
        method: 'POST',
        headers,
        body: upstreamBody,
        // A stream may run as long as the task does; only its start is bounded.
        signal: info.stream ? f.abort.signal : AbortSignal.any([f.abort.signal, AbortSignal.timeout(agent.timeoutMs)]),
        headersTimeout: agent.timeoutMs,
        bodyTimeout: info.stream ? 0 : agent.timeoutMs,
      });
      f.t.ttfb = Date.now();
      ctx.bus.emit({ t: 'flight.upstream', flight_id: f.id, ts: Date.now(), attempt: 1, deployment_id: agent.id, provider_id: agent.id, upstream_model: info.name, outcome: res.statusCode < 500 ? 'ok' : 'error', status: res.statusCode, ttfb_ms: f.t.ttfb - f.t.start });
      const ctype = String(res.headers['content-type'] ?? '');

      // A stream is relayed as it comes (not inspected: it has already reached the caller).
      if (ctype.includes('text/event-stream')) {
        // A stream can't be inspected before the caller reads it. A method that doesn't stream mustn't slip past inspect gates that way.
        if (!info.stream && gates.length) {
          res.body.destroy();
          return refuse(502, 'error', 'unexpected_stream', `${agent.name} answered ${info.name} with a stream, which the inspect gates on this path can't read.`);
        }
        reply.hijack();
        reply.raw.writeHead(res.statusCode, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-ct-flight-id': f.id });
        let bytes = 0;
        // A task may stream for as long as it runs, but not go silent for longer than the agent's timeout.
        let idle: NodeJS.Timeout | undefined;
        let idled = false;
        const arm = () => {
          clearTimeout(idle);
          idle = setTimeout(() => {
            idled = true;
            f.abort.abort();
          }, agent.timeoutMs);
        };
        try {
          arm();
          for await (const chunk of res.body) {
            arm();
            bytes += (chunk as Buffer).length;
            if (!reply.raw.write(chunk)) await Promise.race([once(reply.raw, 'drain'), once(reply.raw, 'close')]);
            if (reply.raw.destroyed) {
              f.abort.abort();
              break;
            }
          }
          if (reply.raw.destroyed) complete('client_aborted', 499, { code: 'client_aborted', message: 'client disconnected' }, bytes);
          else complete(res.statusCode < 400 ? 'ok' : 'error', res.statusCode, undefined, bytes);
        } catch (err) {
          if (idled) complete('error', 504, { code: 'upstream_timeout', message: `${agent.name} sent nothing for ${Math.round(agent.timeoutMs / 1000)} s` }, bytes);
          else complete(f.abort.signal.aborted ? 'client_aborted' : 'error', 502, { code: 'stream_error', message: (err as Error).message }, bytes);
        } finally {
          clearTimeout(idle);
        }
        reply.raw.end();
        return reply;
      }

      const raw = await readCapped(res.body, MAX_BODY);
      if (!raw) return refuse(502, 'error', 'response_too_large', `${agent.name} replied with more than 10 MB; Control Tower does not relay replies that large.`);
      const text = raw.toString('utf8');
      let parsed: Json | undefined;
      try {
        parsed = JSON.parse(text) as Json;
      } catch {
        parsed = undefined;
      }
      if (!parsed) {
        complete('error', 502, { code: 'invalid_agent_response', message: `the agent answered HTTP ${res.statusCode} without JSON-RPC` }, text.length);
        return rpcError(502, -32006, `${agent.name} did not answer with JSON-RPC (HTTP ${res.statusCode}).`, { reason: 'INVALID_AGENT_RESPONSE', flight_id: f.id });
      }
      // ---- inspect what comes back: what the calling agent is about to read ----
      if (gates.length && parsed.result !== undefined) {
        const r = runInspectors(gates, 'output', parsed.result);
        emitInspectOutcomes(ctx.bus, f.id, r.outcomes, 'in the reply');
        if (r.blocked) return refuse(403, 'denied', 'content_blocked', blockedMessage(r.blocked, 'response'), { rule_id: r.blocked.ruleId });
        if (r.value !== parsed.result) parsed = { ...parsed, result: r.value };
      }
      // An extended card is published pointing at Control Tower too.
      if (info.card && parsed.result && typeof parsed.result === 'object') parsed = { ...parsed, result: publishedCard(parsed.result as Json, `${this.base(req)}/a2a/${agent.slug}`, agent.protocolVersion ?? '1.0') };
      const err = parsed.error as { code?: number; message?: string } | undefined;
      complete(err ? 'error' : res.statusCode < 400 ? 'ok' : 'error', res.statusCode, err ? { code: `a2a_${err.code ?? 'error'}`, message: String(err.message ?? '') } : undefined, text.length);
      return reply.status(res.statusCode).header('content-type', 'application/json').send(parsed);
    } catch (err) {
      const e = err as Error & { code?: string; name?: string };
      if (f.abort.signal.aborted && !(e.name === 'TimeoutError')) {
        complete('client_aborted', 499, { code: 'client_aborted', message: 'client disconnected' });
        return reply;
      }
      const timeout = e.name === 'TimeoutError' || e.code === 'UND_ERR_HEADERS_TIMEOUT' || e.code === 'UND_ERR_BODY_TIMEOUT' || e.code === 'UND_ERR_CONNECT_TIMEOUT';
      ctx.bus.emit({ t: 'flight.upstream', flight_id: f.id, ts: Date.now(), attempt: 1, deployment_id: agent.id, provider_id: agent.id, upstream_model: info.name, outcome: 'error', error_code: timeout ? 'timeout' : 'unreachable' });
      if (timeout) return refuse(504, 'error', 'upstream_timeout', `${agent.name} did not answer within ${Math.round(agent.timeoutMs / 1000)} s.`);
      // The detail (hosts, ports) is for the flight record, not for the calling agent.
      complete('error', 502, { code: 'upstream_unreachable', message: `Could not reach ${agent.name}: ${e.message}` });
      return rpcError(502, 502, `Could not reach ${agent.name}.`, { reason: 'UPSTREAM_UNREACHABLE', flight_id: f.id });
    }
  }
}
