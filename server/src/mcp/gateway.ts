import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { inspect } from '../guardrails/inspect.js';
import { E } from '../gateway/errors.js';
import { ulid } from 'ulid';
import type { AppContext } from '../context.js';
import type { KeyRecord } from '../registry.js';
import { globMatch } from '../registry.js';
import { newFlight, type Flight } from '../pipeline/flight.js';
import { usableKey } from '../gateway/key.js';
import { McpUpstreamError, type McpTool } from './upstream.js';
import { namespaced, splitNamespaced, type McpServerRecord } from './registry.js';
import type { PolicyTarget } from '../policy/engine.js';
import { describeFindings } from '../guardrails/scan.js';
import { blockedMessage, emitInspectOutcomes } from '../guardrails/emit.js';
import { DELEGATION_HEADER, DELEGATION_META, headerToken, flagIgnoredToken, loopsBack, resolveDelegation, tokenFor } from '../policy/delegation.js';

/**
 * The MCP gateway. Agents point their MCP client at /mcp (all servers, tools
 * namespaced `slug__tool`) or /mcp/<slug> (one server, plain names). Every
 * request carries the agent's Control Tower API key.
 *
 *  - tools/list is filtered pre-emptively: a tool the key may not use, or
 *    that a static rule denies, is simply not there. Deny-by-invisibility.
 *  - tools/call becomes a Flight through the same policy + approval path as
 *    model calls. Denied/ticketed calls return a tool result with
 *    isError: true carrying a JSON envelope the model can read.
 */
const PROTOCOL_VERSION = '2025-06-18';
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 2000;

interface Session {
  id: string;
  keyId: string;
  slug: string | null;
  lastSeen: number;
}

interface RpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: RpcRequest['id'], result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
function rpcError(id: RpcRequest['id'], code: number, message: string, data?: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

export function classifyOperation(tool: McpTool): PolicyTarget['operation'] {
  const a = (tool.annotations ?? {}) as { readOnlyHint?: boolean; destructiveHint?: boolean };
  if (a.readOnlyHint === true) return 'read';
  if (a.destructiveHint === true) return 'admin';
  const n = tool.name.toLowerCase();
  if (/^(get|list|search|read|find|fetch|query|describe|show)/.test(n)) return 'read';
  if (/^(delete|remove|drop|destroy|purge|merge|deploy|pay|transfer|send)/.test(n)) return 'admin';
  if (/^(create|update|write|set|put|post|add|edit|insert|upsert|run|execute)/.test(n)) return 'write';
  return 'unknown';
}

export class McpGateway {
  private sessions = new Map<string, Session>();

  constructor(private readonly ctx: AppContext) {
    const sweep = setInterval(() => {
      const now = Date.now();
      for (const [id, s] of this.sessions) if (now - s.lastSeen > SESSION_TTL_MS) this.sessions.delete(id);
    }, 60_000);
    sweep.unref?.();
  }

  register(app: FastifyInstance): void {
    for (const path of ['/mcp', '/mcp/:slug']) {
      app.post(path, async (req, reply) => this.handlePost(req, reply));
      app.get(path, async (_req, reply) => reply.status(405).header('allow', 'POST, DELETE').send({ error: 'Control Tower does not open server-initiated streams; use POST.' }));
      app.delete(path, async (req, reply) => {
        const sid = req.headers['mcp-session-id'];
        if (typeof sid === 'string') this.sessions.delete(sid);
        return reply.status(204).send();
      });
    }
  }

  // ---- visibility ----

  private visibleTools(key: KeyRecord, only: McpServerRecord | null): Array<{ server: McpServerRecord; tool: McpTool; public: string }> {
    const out: Array<{ server: McpServerRecord; tool: McpTool; public: string }> = [];
    const servers = only ? [only] : [...this.ctx.mcp.servers.values()];
    for (const s of servers) {
      if (!s.enabled || s.health === 'down') continue;
      for (const t of s.tools) {
        const full = namespaced(s.slug, t.name);
        if (!key.allowedMcp.some((g) => globMatch(g, full))) continue;
        const target: PolicyTarget = { kind: 'tool', name: full, mcpServerId: s.id, operation: classifyOperation(t) };
        if (this.ctx.policy.staticDecision(key, target) === 'deny') continue;
        out.push({ server: s, tool: t, public: only ? t.name : full });
      }
    }
    return out;
  }

  // ---- transport ----

  private async handlePost(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    const slugParam = (req.params as { slug?: string }).slug;
    const only = slugParam ? (this.ctx.mcp.bySlug.get(slugParam) ?? null) : null;
    if (slugParam && !only) return reply.status(404).send(rpcError(null, -32004, `Unknown MCP server "${slugParam}"`));

    const key = usableKey(this.ctx, req);
    if (!key) return reply.status(401).send(rpcError(null, -32001, 'Missing or invalid Control Tower API key. Send it as Authorization: Bearer ct_sk_…'));

    const body = req.body as RpcRequest | RpcRequest[] | undefined;
    if (!body || typeof body !== 'object') return reply.status(400).send(rpcError(null, -32700, 'Parse error'));
    const batch = Array.isArray(body);
    const msgs = batch ? body : [body];

    // Session binding: a session belongs to the key that opened it.
    const sidHeader = req.headers['mcp-session-id'];
    let session = typeof sidHeader === 'string' ? this.sessions.get(sidHeader) : undefined;
    if (session && session.keyId !== key.id) return reply.status(401).send(rpcError(null, -32001, 'Session belongs to a different key'));

    const responses: unknown[] = [];
    for (const m of msgs) {
      if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') {
        responses.push(rpcError((m as RpcRequest | undefined)?.id, -32600, 'Invalid request'));
        continue;
      }
      const isNotification = m.id === undefined;
      if (m.method === 'initialize') {
        if (this.sessions.size >= MAX_SESSIONS) {
          const oldest = [...this.sessions.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
          if (oldest) this.sessions.delete(oldest.id);
        }
        session = { id: `mcp_${ulid()}`, keyId: key.id, slug: only?.slug ?? null, lastSeen: Date.now() };
        this.sessions.set(session.id, session);
        reply.header('mcp-session-id', session.id);
        const requested = (m.params?.protocolVersion as string | undefined) ?? PROTOCOL_VERSION;
        responses.push(
          rpcResult(m.id, {
            protocolVersion: ['2025-06-18', '2025-03-26', '2024-11-05'].includes(requested) ? requested : PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: true }, ...(only ? { resources: {}, prompts: {} } : {}) },
            serverInfo: { name: only ? `controltower/${only.slug}` : 'controltower', version: this.ctx.config.version },
            instructions: only
              ? `Tools from ${only.name}, gated by Control Tower. A tool result with isError and a ct_status field means the call was blocked or is awaiting human approval; follow its instructions.`
              : 'Tools are named <server>__<tool>. A tool result with isError and a ct_status field means the call was blocked or is awaiting human approval; follow its instructions and never try to work around a gate.',
          }),
        );
        continue;
      }
      if (session) session.lastSeen = Date.now();
      if (isNotification) continue; // notifications/initialized, notifications/cancelled…
      try {
        responses.push(rpcResult(m.id, await this.dispatch(m, key, only, req)));
      } catch (err) {
        if (err instanceof McpUpstreamError && err.rpc) responses.push(rpcError(m.id, err.rpc.code, err.rpc.message, err.rpc.data));
        else if (err instanceof RpcFailure) responses.push(rpcError(m.id, err.code, err.message));
        else responses.push(rpcError(m.id, -32603, (err as Error).message));
      }
    }
    if (responses.length === 0) return reply.status(202).send();
    return reply.send(batch ? responses : responses[0]);
  }

  private async dispatch(m: RpcRequest, key: KeyRecord, only: McpServerRecord | null, req: FastifyRequest): Promise<unknown> {
    switch (m.method) {
      case 'ping':
        return {};
      case 'tools/list':
        return {
          tools: this.visibleTools(key, only).map(({ tool, public: name }) => ({
            name,
            description: tool.description ?? '',
            inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
            ...(tool.annotations ? { annotations: tool.annotations } : {}),
          })),
        };
      case 'tools/call':
        return this.callTool(m, key, only, req);
      case 'resources/list':
      case 'resources/templates/list':
      case 'prompts/list': {
        const empty = { [m.method.startsWith('resources') ? (m.method.includes('templates') ? 'resourceTemplates' : 'resources') : 'prompts']: [] };
        if (!only) return empty;
        // A key that may read none of this server's resources or prompts doesn't see them listed.
        const what = m.method.startsWith('resources') ? 'resources/read' : 'prompts/get';
        if (!key.allowedMcp.some((g) => globMatch(g, namespaced(only.slug, what)))) return empty;
        return this.ctx.mcp.client(only).call(m.method, m.params ?? {});
      }
      case 'resources/read':
      case 'prompts/get': {
        if (!only) rpcFail(-32601, 'Use /mcp/<server> for resources and prompts');
        // Reading a resource or getting a prompt is a flight like a tool call: recorded, gated, inspected.
        const r = await this.callTool(m, key, only, req, m.method);
        if (r && typeof r === 'object' && '__ct_blocked' in r) throw new RpcFailure(-32003, String((r as unknown as { text: string }).text));
        return r;
      }
      default:
        throw new RpcFailure(-32601, `Method not found: ${m.method}`);
    }
  }

  // ---- tools/call as a Flight ----

  /**
   * A tools/call — or, with `method`, a resources/read or prompts/get on one server — as a flight.
   * Those two are reads named `<server>__resources/read` and `<server>__prompts/get`, their
   * parameters the arguments, so gates, allow-lists and inspect gates apply to them as to tools.
   */
  private async callTool(m: RpcRequest, key: KeyRecord, only: McpServerRecord | null, req: FastifyRequest, method?: 'resources/read' | 'prompts/get'): Promise<unknown> {
    const ctx = this.ctx;
    const params = m.params ?? {};
    const requested = method ?? String(params.name ?? '');
    const { _meta: _ignored, ...plain } = params as Record<string, unknown>;
    const args = method ? plain : ((params.arguments as Record<string, unknown> | undefined) ?? {});
    let server: McpServerRecord | undefined;
    let toolName: string;
    if (only) {
      server = only;
      toolName = requested;
    } else {
      const split = splitNamespaced(requested);
      if (!split) throw new RpcFailure(-32602, `Tool names are <server>__<tool>; got "${requested}"`);
      server = ctx.mcp.bySlug.get(split.slug);
      toolName = split.tool;
    }
    const full = server ? namespaced(server.slug, toolName) : requested;
    const tool = method ? { name: method, annotations: { readOnlyHint: true } } : server?.tools.find((t) => t.name === toolName);

    const f: Flight = newFlight('mcp.tool', 'openai-chat', { name: full, arguments: args, stream: false });
    f.modelRequested = full;
    f.key = key;
    f.estInput = Math.max(1, Math.round(JSON.stringify(args).length / 4));
    const started = (): void => {
      if (f.started) return;
      f.started = true;
      ctx.bus.emit({
        t: 'flight.started',
        flight_id: f.id,
        ts: f.t.start,
        key_id: key.id,
        key_name: key.name,
        agent_id: key.agentId,
        team: key.team,
        project: key.project,
        kind: 'mcp.tool',
        dialect: 'mcp',
        stream: false,
        model_requested: full,
        mcp_server_id: server?.id,
        tool: toolName,
        ...(f.chain.length ? { on_behalf_of: f.chain } : {}),
        ...(f.parentFlightId ? { parent_flight_id: f.parentFlightId } : {}),
        est_input_tokens: f.estInput,
        projected_nanousd: 0,
      });
    };
    const complete = (status: Flight['status'], http: number, error?: { code: string; message: string }, outBytes = 0): void => {
      f.t.end = Date.now();
      if (!f.started) return;
      ctx.bus.emit({
        t: 'flight.completed',
        flight_id: f.id,
        ts: f.t.end,
        status: status ?? 'error',
        http_status: http,
        usage: { input: f.estInput, output: Math.round(outBytes / 4), cacheRead: 0, cacheWrite: 0 },
        usage_source: 'estimated',
        cost_nanousd: 0,
        cost_confidence: 'exact',
        duration_ms: f.t.end - f.t.start,
        gateway_overhead_ms: (f.t.upstreamSent ?? f.t.end) - f.t.start,
        error,
      });
    };
    const blocked = (ctStatus: string, message: string, extra: Record<string, unknown>) => {
      const text = `${message}\n${JSON.stringify({ ct_status: ctStatus, flight_id: f.id, ...extra })}`;
      // A tool's refusal is a tool result the model reads; a resource or prompt has no such shape, so it is an error.
      return method ? { __ct_blocked: true, text } : { content: [{ type: 'text', text }], isError: true };
    };

    // Whom this call is for, when an agent is acting for another: the token arrives in _meta or as a header.
    const metaToken = (params._meta as Record<string, unknown> | undefined)?.[DELEGATION_META];
    const deleg = resolveDelegation(ctx, key, typeof metaToken === 'string' ? metaToken : headerToken(req.headers));
    f.chain = deleg.chain ?? [];
    f.parentFlightId = deleg.parentFlightId;
    f.originKeyId = 'error' in deleg ? undefined : deleg.originKeyId;
    const onBehalfOf = 'error' in deleg ? [] : deleg.onBehalfOf;

    try {
      if (ctx.shuttingDown) throw new RpcFailure(-32000, 'Control Tower is restarting');
      if ('error' in deleg) {
        started();
        complete('rejected', deleg.error.status, { code: deleg.error.code, message: deleg.error.message });
        return blocked('denied', deleg.error.message, { reason: deleg.error.code });
      }
      if (!server || !tool) {
        started();
        complete('rejected', 404, { code: 'tool_not_found', message: `Unknown tool ${requested}` });
        return blocked('not_found', `Unknown tool "${requested}".`, {});
      }
      if (!key.allowedMcp.some((g) => globMatch(g, full))) {
        started();
        complete('denied', 403, { code: 'tool_not_allowed', message: `Key may not use ${full}` });
        return blocked('denied', `This API key is not allowed to use ${full}.`, { reason: 'key_not_allowed' });
      }
      if (loopsBack(f.chain, server.agentId)) {
        started();
        const e = E.delegationLoop(server.agentId!);
        complete('rejected', 403, { code: e.code, message: e.message });
        return blocked('denied', e.message, { reason: e.code });
      }
      const admit = ctx.limiter.admit(`key:${key.id}`, 1, key.limits);
      if (!admit.ok) {
        started();
        complete('rejected', 429, { code: 'rate_limit_exceeded', message: 'rate limited' });
        return blocked('rate_limited', `Rate limit exceeded; retry in ${Math.ceil(admit.retryAfterMs / 1000)}s.`, { retry_after_ms: admit.retryAfterMs });
      }
      started();
      if (!('error' in deleg) && deleg.invalid) flagIgnoredToken(ctx, f.id, deleg.invalid);

      // ---- policy (with the real arguments) ----
      const target: PolicyTarget = { kind: 'tool', name: full, mcpServerId: server.id, operation: method ? 'read' : classifyOperation(tool as McpTool) };
      let decision = await ctx.policy.evaluate({ flightId: f.id, key, target, args, onBehalfOf, estInputTokens: f.estInput, projectedNanousd: 0 });
      const presentedApproval = req.headers['x-ct-approval'] ?? (params._meta as { ct_approval?: string } | undefined)?.ct_approval;
      if (decision.effect === 'hold' && typeof presentedApproval === 'string' && presentedApproval) {
        const scope = (decision as { scopeHash?: string }).scopeHash ?? '';
        const r = await ctx.approvals.redeem(presentedApproval, key.id, scope, undefined);
        if (r.ok) decision = { ...decision, effect: 'allow', reason: `approved (grant …${r.grantId.slice(-6)})` };
        else if (r.reason === 'pending') {
          ctx.bus.emit({ t: 'flight.decision', flight_id: f.id, ts: Date.now(), decision: 'hold', rule_id: decision.ruleId, reason: 'ticket still pending' });
          complete('ticketed', 403);
          return blocked('pending', 'Approval is still pending. Retry the same call with the same approval token after the suggested wait.', { ticket: presentedApproval, retry_after_ms: r.retryAfterMs ?? 15_000 });
        } else if (r.reason === 'denied' || r.reason === 'scope_mismatch') {
          ctx.bus.emit({ t: 'flight.decision', flight_id: f.id, ts: Date.now(), decision: 'deny', rule_id: decision.ruleId, reason: r.reason });
          complete('denied', 403, { code: 'policy_denied', message: r.reason });
          return blocked('denied', r.reason === 'scope_mismatch' ? 'The approval was for different arguments (scope mismatch). Request approval again with the original arguments.' : 'Denied by an approver.', { reason: r.reason });
        }
      }
      ctx.bus.emit({ t: 'flight.decision', flight_id: f.id, ts: Date.now(), decision: decision.effect === 'hold' ? 'hold' : decision.effect, rule_id: decision.ruleId, zone_from: decision.zoneFrom, zone_to: decision.zoneTo, reason: decision.reason, arg_hash: decision.argHash });
      if (decision.effect === 'deny') {
        complete('denied', 403, { code: 'policy_denied', message: decision.reason ?? 'blocked' });
        return blocked('denied', `${decision.reason ?? 'Blocked by Control Tower policy.'} Do not attempt to work around this restriction.`, { rule_id: decision.ruleId });
      }
      if (decision.effect === 'hold') {
        const outcome = await ctx.approvals.hold(f, decision);
        if (outcome.kind === 'denied') {
          complete('denied', 403, { code: 'policy_denied', message: outcome.error.message });
          return blocked('denied', outcome.error.message, { rule_id: decision.ruleId });
        }
        if (outcome.kind === 'ticketed') {
          complete('ticketed', 403, { code: 'approval_required', message: 'awaiting approval' });
          const ct = (outcome.error.extra?.ct as Record<string, unknown> | undefined) ?? {};
          return blocked(String(ct.status ?? 'pending'), outcome.error.message, { ...ct, how_to_resume: 'Retry this exact tool call with _meta.ct_approval set to the ticket (or the x-ct-approval HTTP header).' });
        }
      }

      // ---- inspect the arguments ----
      const gates = ctx.policy.inspectors?.(key, target, onBehalfOf) ?? [];
      let callArgs = args;
      if (gates.length) {
        const r = await inspect(ctx, key, gates, 'input', args);
        emitInspectOutcomes(ctx.bus, f.id, r.outcomes, 'in the tool arguments');
        if (r.blocked) {
          complete('denied', 400, { code: 'content_blocked', message: describeFindings(r.blocked.findings) });
          return blocked('content_blocked', blockedMessage(r.blocked, 'tool arguments'), { rule_id: r.blocked.ruleId, findings: r.blocked.findings });
        }
        callArgs = r.value as Record<string, unknown>;
      }

      // ---- dispatch ----
      f.t.upstreamSent = Date.now();
      const client = ctx.mcp.client(server);
      // A server that fronts an agent is told whom the call is for: that agent passes the token on with its own calls.
      const token = server.agentId ? tokenFor(ctx, f.chain, key, server.agentId, f.id, f.originKeyId) : undefined;
      let result = method
        ? ((await client.call(method, { ...callArgs, ...(token ? { _meta: { [DELEGATION_META]: token } } : {}) }, f.abort.signal, token ? { [DELEGATION_HEADER]: token } : undefined)) as Record<string, unknown>)
        : await client.callTool(toolName, callArgs, f.abort.signal, token ? { headers: { [DELEGATION_HEADER]: token }, meta: { [DELEGATION_META]: token } } : {});
      if (f.t.ttfb == null) f.t.ttfb = Date.now();
      ctx.bus.emit({ t: 'flight.upstream', flight_id: f.id, ts: Date.now(), attempt: 1, deployment_id: server.id, provider_id: server.id, upstream_model: toolName, outcome: 'ok', status: 200, ttfb_ms: f.t.ttfb - f.t.start });
      // ---- inspect the result: what the model is about to read ----
      if (gates.length) {
        const r = await inspect(ctx, key, gates, 'output', result);
        emitInspectOutcomes(ctx.bus, f.id, r.outcomes, 'in the tool result');
        if (r.blocked) {
          complete('denied', 400, { code: 'content_blocked', message: describeFindings(r.blocked.findings) });
          return blocked('content_blocked', blockedMessage(r.blocked, 'tool result'), { rule_id: r.blocked.ruleId, findings: r.blocked.findings });
        }
        result = r.value as typeof result;
      }
      const bytes = JSON.stringify(result).length;
      complete(result.isError ? 'error' : 'ok', 200, result.isError ? { code: 'tool_error', message: 'tool returned isError' } : undefined, bytes);
      return result;
    } catch (err) {
      if (err instanceof McpUpstreamError) {
        ctx.bus.emit({ t: 'flight.upstream', flight_id: f.id, ts: Date.now(), attempt: 1, deployment_id: server?.id ?? '', provider_id: server?.id ?? '', upstream_model: toolName, outcome: 'error', error_code: err.code });
        complete('error', 502, { code: `upstream_${err.code}`, message: err.message });
        if (err.rpc) throw err;
        return blocked('upstream_error', `The upstream MCP server failed: ${err.message}`, { code: err.code });
      }
      if (err instanceof RpcFailure) {
        complete('rejected', 400, { code: 'rpc', message: err.message });
        throw err;
      }
      complete('error', 500, { code: 'internal_error', message: (err as Error).message });
      throw err;
    }
  }
}

class RpcFailure extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function rpcFail(code: number, message: string): never {
  throw new RpcFailure(code, message);
}
