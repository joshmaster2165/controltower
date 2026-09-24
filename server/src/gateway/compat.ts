import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { request } from 'undici';
import type { AppContext } from '../context.js';
import { estimateInputTokens } from '../pipeline/flight.js';
import { usableKey } from './key.js';
import { hasAdminKey } from '../admin/auth.js';
import { E, errorBody } from './errors.js';

/**
 * Routes clients and tooling written for LiteLLM (and Anthropic / Azure SDKs)
 * expect, beyond the core /v1 gateway:
 *  - /v1/messages/count_tokens — Claude Code calls it to size its context.
 *  - /health/liveliness, /health/readiness, /health — LiteLLM's probes.
 *  - /ui — LiteLLM's console path; the console lives at /.
 */
export async function compatRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // ---- Anthropic token counting ----
  app.post('/v1/messages/count_tokens', async (req, reply) => {
    const key = usableKey(ctx, req);
    if (!key) return reply.status(401).send(errorBody('anthropic-messages', E.unauthorized()));
    const body = (req.body ?? {}) as Record<string, unknown>;
    const model = typeof body.model === 'string' ? body.model : '';
    if (model && !ctx.registry.keyMayUseModel(key, model)) return reply.status(403).send(errorBody('anthropic-messages', E.modelNotAllowed(model)));
    // Exact counts from Anthropic when the model is served there; a local estimate otherwise.
    const head = ctx.registry.resolveModel(model).candidates[0];
    const prov = head ? ctx.registry.providers.get(head.providerId) : undefined;
    if (head && prov?.kind === 'anthropic' && prov.creds.api_key) {
      try {
        const res = await request(`${(prov.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '')}/v1/messages/count_tokens`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': prov.creds.api_key, 'anthropic-version': String(req.headers['anthropic-version'] ?? '2023-06-01') },
          body: JSON.stringify({ ...body, model: head.upstreamModel, ct: undefined }),
          signal: AbortSignal.timeout(15_000),
        });
        const text = await res.body.text();
        if (res.statusCode === 200) return reply.type('application/json').send(text);
      } catch {
        // fall through to the estimate
      }
    }
    return reply.send({ input_tokens: estimateInputTokens(body) });
  });

  // ---- health, LiteLLM style ----
  const alive = (_req: FastifyRequest, reply: FastifyReply) =>
    ctx.shuttingDown ? reply.status(503).send({ status: 'shutting_down' }) : reply.type('application/json').send(JSON.stringify("I'm alive!"));
  app.get('/health/liveliness', alive);
  app.get('/health/liveness', alive);
  app.get('/health/readiness', async (_req, reply) => {
    const ready = !ctx.shuttingDown && !ctx.dbSink.backpressure;
    return reply.status(ready ? 200 : 503).send({ status: ready ? 'healthy' : 'unhealthy', db: 'connected', version: ctx.config.version });
  });
  // Checks every provider that serves a model and reports each model as healthy or not.
  app.get('/health', async (req, reply) => {
    if (!hasAdminKey(ctx, req) && !usableKey(ctx, req)) return reply.status(401).send(errorBody('openai-chat', E.unauthorized()));
    const results = new Map<string, { ok: boolean; error?: string | undefined }>();
    await Promise.all(
      [...ctx.registry.providers.values()].map(async (p) => {
        const adapter = ctx.adapters.get(p.kind);
        try {
          if (adapter?.healthCheck) {
            const h = await Promise.race([adapter.healthCheck(p), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timed out after 10 s')), 10_000))]);
            results.set(p.id, { ok: h.ok, error: h.ok ? undefined : h.detail });
          } else results.set(p.id, { ok: p.health !== 'down', error: p.health === 'down' ? p.healthDetail : undefined });
        } catch (err) {
          results.set(p.id, { ok: false, error: (err as Error).message });
        }
      }),
    );
    const healthy: unknown[] = [];
    const unhealthy: unknown[] = [];
    for (const d of ctx.registry.deployments.values()) {
      if (!d.enabled) continue;
      const p = ctx.registry.providers.get(d.providerId);
      const r = results.get(d.providerId);
      const row = { model: d.publicName ?? `${p?.slug}/${d.upstreamModel}`, upstream_model: d.upstreamModel, provider: p?.slug, api_base: p?.baseUrl ?? null };
      if (r?.ok) healthy.push(row);
      else unhealthy.push({ ...row, error: r?.error ?? 'unknown' });
    }
    return reply.send({ healthy_endpoints: healthy, unhealthy_endpoints: unhealthy, healthy_count: healthy.length, unhealthy_count: unhealthy.length });
  });

  // ---- LiteLLM's console path ----
  const toConsole = (_req: FastifyRequest, reply: FastifyReply) => reply.redirect('/', 302);
  app.get('/ui', toConsole);
  app.get('/ui/*', toConsole);
}
