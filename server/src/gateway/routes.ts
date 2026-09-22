import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { FlightRunner, extractApiKey } from '../pipeline/flight.js';
import { E, errorBody } from './errors.js';
import { ANTHROPIC_PASSTHROUGH_HEADERS } from '../providers/anthropic.js';

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
