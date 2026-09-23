import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { FlightRunner, extractApiKey } from '../pipeline/flight.js';
import { E, errorBody } from './errors.js';
import { ANTHROPIC_PASSTHROUGH_HEADERS } from '../providers/anthropic.js';
import { parseObserveBody, parseOtlpTraces } from '../observe/observe.js';

export async function gatewayRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const runner = new FlightRunner(ctx);

  app.post('/v1/chat/completions', async (req, reply) => {
    await runner.runChat(req, reply, 'openai-chat');
  });

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

  app.post('/v1/embeddings', async (req, reply) => {
    await runner.runChat(req, reply, 'openai-chat', { kind: 'embeddings' });
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
  const observer = (req: import('fastify').FastifyRequest) => {
    const presented = extractApiKey(req);
    const key = presented ? ctx.registry.authenticate(presented) : undefined;
    return key && key.enabled && !(key.expiresAt && key.expiresAt < Date.now()) ? key : undefined;
  };

  app.post('/v1/observe', { bodyLimit: 1024 * 1024 }, async (req, reply) => {
    const key = observer(req);
    if (!key) return reply.status(401).send(errorBody('openai-chat', E.unauthorized()));
    const parsed = parseObserveBody(req.body);
    if ('error' in parsed) return reply.status(400).send(errorBody('openai-chat', E.badRequest(parsed.error)));
    return reply.send(await ctx.observed.record(key.id, parsed.events));
  });

  // OpenTelemetry: point an OTLP/HTTP exporter here with protocol http/json.
  app.post('/v1/traces', { bodyLimit: 4 * 1024 * 1024 }, async (req, reply) => {
    const key = observer(req);
    if (!key) return reply.status(401).send({ code: 16, message: 'Missing or invalid Control Tower API key (Authorization: Bearer ct_sk_…).' });
    if (!String(req.headers['content-type'] ?? '').includes('json')) {
      return reply.status(415).send({ code: 3, message: 'Control Tower accepts OTLP/HTTP with JSON encoding. Set OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json.' });
    }
    await ctx.observed.record(key.id, parseOtlpTraces(req.body, selfHosts));
    // OTLP success response: an empty ExportTraceServiceResponse.
    return reply.send({});
  });

  app.get('/v1/models', async (req, reply) => {
    const presented = extractApiKey(req);
    const key = presented ? ctx.registry.authenticate(presented) : undefined;
    if (!key) return reply.status(401).send(errorBody('openai-chat', E.unauthorized()));
    const now = Math.floor(Date.now() / 1000);
    const data = ctx.registry.visibleModels(key).map((m) => ({
      id: m.id,
      object: 'model',
      created: now,
      owned_by: m.provider ?? 'controltower',
    }));
    return reply.send({ object: 'list', data });
  });

  app.get('/v1/models/:id', async (req, reply) => {
    const presented = extractApiKey(req);
    const key = presented ? ctx.registry.authenticate(presented) : undefined;
    if (!key) return reply.status(401).send(errorBody('openai-chat', E.unauthorized()));
    const id = (req.params as { id: string }).id;
    const m = ctx.registry.visibleModels(key).find((x) => x.id === id);
    if (!m) return reply.status(404).send(errorBody('openai-chat', E.modelNotFound(id)));
    return reply.send({ id: m.id, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: m.provider ?? 'controltower' });
  });
}
