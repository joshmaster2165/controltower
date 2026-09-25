import type { FastifyInstance } from 'fastify';
import { DELEGATION_HEADER, agentRef, headerToken } from '../policy/delegation.js';
import type { AppContext } from '../context.js';
import { FlightRunner } from '../pipeline/flight.js';
import { extractApiKey, keyProblem, usableKey } from './key.js';
import { E, errorBody } from './errors.js';
import { ANTHROPIC_PASSTHROUGH_HEADERS } from '../providers/anthropic.js';
import { parseObserveBody, parseOtlpTraces } from '../observe/observe.js';

export async function gatewayRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const runner = new FlightRunner(ctx);

  // Served with and without /v1: SDKs pointed at the bare origin call /chat/completions.
  for (const prefix of ['/v1', '']) {
    app.post(`${prefix}/chat/completions`, async (req, reply) => {
      await runner.runChat(req, reply, 'openai-chat');
    });
    app.post(`${prefix}/embeddings`, async (req, reply) => {
      await runner.runChat(req, reply, 'openai-chat', { kind: 'embeddings' });
    });
    // OpenAI's Responses API (Agents SDK, Codex): forwarded to providers that speak it.
    app.post(`${prefix}/responses`, async (req, reply) => {
      await runner.runChat(req, reply, 'openai-responses');
    });
  }
  // Azure OpenAI style (LlamaIndex's AzureOpenAI, Cursor's Azure mode): the model is in the path.
  const azure = (kind: 'chat' | 'embeddings') => async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.model !== 'string' || !body.model) body.model = (req.params as { model: string }).model;
    req.body = body;
    await runner.runChat(req, reply, 'openai-chat', kind === 'embeddings' ? { kind: 'embeddings' } : {});
  };
  app.post('/openai/deployments/:model/chat/completions', azure('chat'));
  app.post('/openai/deployments/:model/embeddings', azure('embeddings'));

  // Anthropic-native dialect. The AnthropicAdapter (build step 4) makes this a
  // byte passthrough; until then it runs through the same pipeline and the
  // mock adapter answers in OpenAI shape.
  app.post('/v1/messages', async (req, reply) => {
    // Carry Anthropic beta/version headers through to an Anthropic upstream.
    const body = req.body as Record<string, unknown> | undefined;
    if (body && typeof body === 'object') {
      const ph: Record<string, string> = {};
      for (const h of ANTHROPIC_PASSTHROUGH_HEADERS) {
        const v = req.headers[h];
        if (typeof v === 'string' && v) ph[h] = v;
      }
      if (Object.keys(ph).length) body.ct = { ...((body.ct as Record<string, unknown>) ?? {}), passthrough_headers: ph };
    }
    await runner.runChat(req, reply, 'anthropic-messages');
  });


  // ---- observed traffic: calls that do not pass through Control Tower ----
  const selfHosts = new Set([`localhost:${ctx.config.port}`, `127.0.0.1:${ctx.config.port}`, `[::1]:${ctx.config.port}`]);
  if (ctx.config.publicUrl) {
    try {
      selfHosts.add(new URL(ctx.config.publicUrl).host.toLowerCase());
    } catch {
      /* ignore */
    }
  }
  // Agents calling agents: renew a delegation token before it expires, for a task that outlasts it.
  app.post('/v1/delegation/renew', { bodyLimit: 16 * 1024 }, async (req, reply) => {
    const key = usableKey(ctx, req);
    if (!key) return reply.status(401).send(errorBody('openai-chat', keyRefusal(req)));
    const body = (req.body ?? {}) as { token?: unknown };
    const token = typeof body.token === 'string' ? body.token : headerToken(req.headers);
    if (!token) return reply.status(400).send(errorBody('openai-chat', E.badRequest(`Send the token to renew as the ${DELEGATION_HEADER} header or {"token": "…"}.`)));
    const r = ctx.delegations.renew(token, agentRef(key));
    if (!r.ok) return reply.status(403).send(errorBody('openai-chat', { status: 403, code: 'delegation_invalid', message: `The token can't be renewed: ${r.reason}.` }));
    return { token: r.token, expires_at: r.expiresAt };
  });

  app.post('/v1/observe', { bodyLimit: 1024 * 1024 }, async (req, reply) => {
    const key = usableKey(ctx, req);
    if (!key) return reply.status(401).send(errorBody('openai-chat', keyRefusal(req)));
    const parsed = parseObserveBody(req.body);
    if ('error' in parsed) return reply.status(400).send(errorBody('openai-chat', E.badRequest(parsed.error)));
    return reply.send(await ctx.observed.record(key.id, parsed.events));
  });

  // OpenTelemetry: point an OTLP/HTTP exporter here with protocol http/json.
  app.post('/v1/traces', { bodyLimit: 4 * 1024 * 1024 }, async (req, reply) => {
    const key = usableKey(ctx, req);
    if (!key) return reply.status(401).send({ code: 16, message: 'Missing or invalid Control Tower API key (Authorization: Bearer ct_sk_…).' });
    if (!String(req.headers['content-type'] ?? '').includes('json')) {
      return reply.status(415).send({ code: 3, message: 'Control Tower accepts OTLP/HTTP with JSON encoding. Set OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json.' });
    }
    await ctx.observed.record(key.id, parseOtlpTraces(req.body, selfHosts));
    // OTLP success response: an empty ExportTraceServiceResponse.
    return reply.send({});
  });

  // Why a key was refused, with the same codes as every other route: expired and disabled are told apart.
  const keyRefusal = (req: import('fastify').FastifyRequest) => {
    const presented = extractApiKey(req);
    const k = presented ? ctx.registry.authenticate(presented) : undefined;
    const problem = k ? keyProblem(k) : undefined;
    return problem === 'expired' ? E.keyExpired() : problem === 'disabled' ? E.keyDisabled() : E.unauthorized();
  };
  const listModels = async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    const key = usableKey(ctx, req);
    if (!key) return reply.status(401).send(errorBody('openai-chat', keyRefusal(req)));
    const data = ctx.registry.visibleModels(key).map((m) => modelEntry(m.id, m.provider));
    // Both list shapes at once: OpenAI's ({object, data}) and Anthropic's ({data, has_more, first_id, last_id}),
    // so OpenAI and Anthropic clients (Claude Desktop's model picker among them) read the same answer.
    return reply.send({ object: 'list', data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null });
  };
  const getModel = async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    const key = usableKey(ctx, req);
    if (!key) return reply.status(401).send(errorBody('openai-chat', keyRefusal(req)));
    const id = (req.params as { id: string }).id;
    const m = ctx.registry.visibleModels(key).find((x) => x.id === id);
    if (!m) return reply.status(404).send(errorBody('openai-chat', E.modelNotFound(id)));
    return reply.send(modelEntry(m.id, m.provider));
  };
  function modelEntry(id: string, provider: string | undefined) {
    const now = Date.now();
    return { id, object: 'model', created: Math.floor(now / 1000), owned_by: provider ?? 'controltower', type: 'model', display_name: id, created_at: new Date(now).toISOString() };
  }
  for (const prefix of ['/v1', '']) {
    app.get(`${prefix}/models`, listModels);
    app.get(`${prefix}/models/:id`, getModel);
  }
}
