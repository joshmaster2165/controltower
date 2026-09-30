import type { FastifyInstance } from 'fastify';
import { ulid } from 'ulid';
import { regionOf } from '../pipeline/routing.js';
import type { AppContext } from '../context.js';
import { requireAdmin } from './auth.js';
import { PROVIDER_CATALOG, catalogEntry } from '../providers/catalog.js';
import type { ProviderRecord } from '../registry.js';

/** How an alias picks among its deployments. With anything but priority, targets share one tier unless given one. */
const STRATEGIES = ['priority', 'weighted', 'least-latency', 'least-cost'];

/** Providers, deployments, aliases and the pricing table. */
export async function providerRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const guard = requireAdmin(ctx);

  app.get('/admin/api/catalog', { preHandler: guard }, async () => ({
    providers: PROVIDER_CATALOG.map((c) => ({ ...c, available: c.available && ctx.adapters.get(c.kind) !== undefined })),
    adapters: ctx.adapters.kinds(),
  }));

  // ---- providers ----
  const publicProvider = (p: ProviderRecord) => ({
    id: p.id,
    kind: p.kind,
    name: p.name,
    slug: p.slug,
    base_url: p.baseUrl,
    extra: p.extra,
    health: p.health,
    health_detail: p.healthDetail,
    has_credentials: Object.keys(p.creds).length > 0,
    credential_keys: Object.keys(p.creds),
    stream_usage_supported: p.streamUsageSupported,
    demo: p.demo,
    deployments: [...ctx.registry.deployments.values()].filter((d) => d.providerId === p.id).length,
  });

  app.get('/admin/api/providers', { preHandler: guard }, async () => ({
    providers: [...ctx.registry.providers.values()].map(publicProvider),
  }));

  app.post('/admin/api/providers', { preHandler: guard }, async (req, reply) => {
    const b = (req.body ?? {}) as { catalog_id?: string; name?: string; slug?: string; base_url?: string; credentials?: Record<string, string>; extra?: Record<string, unknown> };
    const cat = b.catalog_id ? catalogEntry(b.catalog_id) : undefined;
    if (!cat) return reply.status(400).send({ error: { code: 'invalid', message: 'catalog_id is required' } });
    if (!ctx.adapters.get(cat.kind)) return reply.status(400).send({ error: { code: 'unavailable', message: `${cat.name} is not available in this build yet.` } });
    const name = (b.name ?? cat.name).trim();
    const slug = (b.slug ?? cat.id).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 24);
    if (!slug) return reply.status(400).send({ error: { code: 'invalid', message: 'slug is required' } });
    const taken = ctx.registry.providersBySlug.get(slug);
    if (taken?.demo && !ctx.registry.providersBySlug.has(`${slug}-demo`)) {
      // A demo stand-in holds the real vendor's slug; step it aside for the real thing.
      await ctx.db.write.updateTable('providers').set({ slug: `${slug}-demo`, updated_at: Date.now() }).where('id', '=', taken.id).execute();
      await ctx.registry.reload();
    } else if (taken) {
      return reply.status(409).send({ error: { code: 'conflict', message: `A provider with slug "${slug}" already exists.` } });
    }
    for (const f of cat.fields) {
      if (f.required && !b.credentials?.[f.key]) return reply.status(400).send({ error: { code: 'invalid', message: `${f.label} is required` } });
    }
    for (const f of cat.extraFields ?? []) {
      if (f.required && !b.extra?.[f.key]) return reply.status(400).send({ error: { code: 'invalid', message: `${f.label} is required` } });
    }
    const id = ulid();
    const now = Date.now();
    const creds = b.credentials ?? {};
    await ctx.db.write
      .insertInto('providers')
      .values({
        id,
        kind: cat.kind,
        name,
        slug,
        base_url: (b.base_url ?? cat.baseUrl ?? null) || null,
        creds_enc: Object.keys(creds).length ? ctx.secrets.encrypt(JSON.stringify(creds), `providers.creds_enc.${id}`) : null,
        extra: JSON.stringify({ ...(cat.extra ?? {}), ...(b.extra ?? {}), catalog_id: cat.id }),
        health: 'unknown',
        health_detail: null,
        stream_usage_supported: null,
        demo: 0,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await ctx.registry.reload();
    return reply.status(201).send({ provider: publicProvider(ctx.registry.providers.get(id)!) });
  });

  app.patch('/admin/api/providers/:id', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const p = ctx.registry.providers.get(id);
    if (!p) return reply.status(404).send({ error: { code: 'not_found', message: 'provider not found' } });
    const b = (req.body ?? {}) as { name?: string; base_url?: string | null; credentials?: Record<string, string>; extra?: Record<string, unknown> };
    const patch: Record<string, unknown> = { updated_at: Date.now() };
    if (typeof b.name === 'string') patch.name = b.name.trim();
    if (b.base_url !== undefined) patch.base_url = b.base_url || null;
    if (b.extra) patch.extra = JSON.stringify({ ...p.extra, ...b.extra });
    if (b.credentials) {
      // Merge: empty string keeps the existing secret. From what is stored (secret references as references), not the values in use.
      const row = await ctx.db.read.selectFrom('providers').select('creds_enc').where('id', '=', id).executeTakeFirst();
      const merged = row?.creds_enc ? (JSON.parse(ctx.secrets.decrypt(row.creds_enc, `providers.creds_enc.${id}`)) as Record<string, string>) : {};
      for (const [k, v] of Object.entries(b.credentials)) if (v !== '') merged[k] = v;
      patch.creds_enc = Object.keys(merged).length ? ctx.secrets.encrypt(JSON.stringify(merged), `providers.creds_enc.${id}`) : null;
    }
    await ctx.db.write.updateTable('providers').set(patch).where('id', '=', id).execute();
    await ctx.registry.reload();
    return { provider: publicProvider(ctx.registry.providers.get(id)!) };
  });

  app.delete('/admin/api/providers/:id', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const res = await ctx.db.write.deleteFrom('providers').where('id', '=', id).executeTakeFirst();
    if (Number(res.numDeletedRows) === 0) return reply.status(404).send({ error: { code: 'not_found', message: 'provider not found' } });
    await ctx.registry.reload();
    return { ok: true };
  });

  /** Test Connect: health check + model discovery, persisted on the provider row. */
  app.post('/admin/api/providers/:id/test', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const p = ctx.registry.providers.get(id);
    if (!p) return reply.status(404).send({ error: { code: 'not_found', message: 'provider not found' } });
    const adapter = ctx.adapters.get(p.kind);
    if (!adapter?.healthCheck) return { ok: true, latency_ms: 0, detail: 'no health check for this provider kind', models: [] };
    const h = await adapter.healthCheck(p);
    let models: Array<{ id: string; context?: number }> = [];
    if (h.ok && adapter.listModels) {
      try {
        models = await adapter.listModels(p);
      } catch {
        /* health ok but listing unsupported */
      }
    }
    await ctx.db.write
      .updateTable('providers')
      .set({ health: h.ok ? 'ok' : 'down', health_detail: h.detail ?? null, updated_at: Date.now() })
      .where('id', '=', id)
      .execute();
    await ctx.registry.reload();
    return { ok: h.ok, latency_ms: h.latencyMs, detail: h.detail, models };
  });

  app.get('/admin/api/providers/:id/models', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const p = ctx.registry.providers.get(id);
    if (!p) return reply.status(404).send({ error: { code: 'not_found', message: 'provider not found' } });
    const adapter = ctx.adapters.get(p.kind);
    if (!adapter?.listModels) return { models: [] };
    try {
      const models = await adapter.listModels(p);
      return { models: models.map((m) => ({ ...m, price: ctx.pricing.resolve(p.kind, m.id, undefined, p.slug).entry ?? null })) };
    } catch (err) {
      return reply.status(502).send({ error: { code: 'upstream', message: (err as Error).message } });
    }
  });

  // ---- deployments ----
  app.get('/admin/api/deployments', { preHandler: guard }, async () => ({
    deployments: [...ctx.registry.deployments.values()].map((d) => {
      const p = ctx.registry.providers.get(d.providerId);
      const price = p ? ctx.pricing.resolve(p.kind, d.upstreamModel, d.pricingOverride, p.slug) : undefined;
      return {
        id: d.id,
        provider_id: d.providerId,
        provider_slug: p?.slug,
        provider_kind: p?.kind,
        upstream_model: d.upstreamModel,
        public_name: d.publicName,
        caps: d.caps,
        /** Where it is served: its own region, or its provider's. */
        region: regionOf(ctx, d) ?? null,
        pricing_override: d.pricingOverride,
        price: price?.entry ?? null,
        price_source: price?.source ?? 'none',
        weight: d.weight,
        enabled: d.enabled,
        cooling_until: d.coolingUntil,
        ewma_ttft_ms: d.ewmaTtftMs,
        demo: d.demo,
        health: d.health ?? null,
        health_detail: d.healthDetail ?? null,
        health_checked_at: d.healthCheckedAt ?? null,
      };
    }),
  }));

  app.post('/admin/api/deployments', { preHandler: guard }, async (req, reply) => {
    const b = (req.body ?? {}) as { provider_id?: string; upstream_model?: string; public_name?: string | null; pricing_override?: Record<string, unknown> | null; caps?: Record<string, unknown>; weight?: number };
    const p = b.provider_id ? ctx.registry.providers.get(b.provider_id) : undefined;
    if (!p) return reply.status(400).send({ error: { code: 'invalid', message: 'provider_id is required' } });
    const upstream = (b.upstream_model ?? '').trim();
    if (!upstream) return reply.status(400).send({ error: { code: 'invalid', message: 'upstream_model is required' } });
    const badCaps = b.caps ? capsProblem(b.caps) : undefined;
    if (badCaps) return reply.status(400).send({ error: { code: 'invalid', message: badCaps } });
    let publicName = b.public_name === undefined ? upstream : b.public_name?.trim() || null;
    if (publicName && (ctx.registry.deploymentsByPublicName.has(publicName) || ctx.registry.aliasesByName.has(publicName))) {
      return reply.status(409).send({ error: { code: 'conflict', message: `"${publicName}" is already used by another model or alias.` } });
    }
    const id = ulid();
    const now = Date.now();
    await ctx.db.write
      .insertInto('deployments')
      .values({
        id,
        provider_id: p.id,
        upstream_model: upstream,
        public_name: publicName,
        caps: JSON.stringify(b.caps ?? {}),
        pricing_override: b.pricing_override ? JSON.stringify(b.pricing_override) : null,
        weight: b.weight ?? 100,
        enabled: 1,
        cooling_until: null,
        ewma_ttft_ms: null,
        demo: 0,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await ctx.registry.reload();
    return reply.status(201).send({ id });
  });

  app.patch('/admin/api/deployments/:id', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const d = ctx.registry.deployments.get(id);
    if (!d) return reply.status(404).send({ error: { code: 'not_found', message: 'deployment not found' } });
    const b = (req.body ?? {}) as { public_name?: string | null; enabled?: boolean; pricing_override?: Record<string, unknown> | null; caps?: Record<string, unknown>; weight?: number };
    const patch: Record<string, unknown> = { updated_at: Date.now() };
    if (b.public_name !== undefined) patch.public_name = b.public_name?.trim() || null;
    if (typeof b.enabled === 'boolean') patch.enabled = b.enabled ? 1 : 0;
    if (b.pricing_override !== undefined) patch.pricing_override = b.pricing_override ? JSON.stringify(b.pricing_override) : null;
    if (b.caps) {
      const bad = capsProblem(b.caps);
      if (bad) return reply.status(400).send({ error: { code: 'invalid', message: bad } });
      // A null clears a setting.
      patch.caps = JSON.stringify(Object.fromEntries(Object.entries({ ...d.caps, ...b.caps }).filter(([, v]) => v !== null)));
    }
    if (typeof b.weight === 'number') patch.weight = b.weight;
    await ctx.db.write.updateTable('deployments').set(patch).where('id', '=', id).execute();
    await ctx.registry.reload();
    return { ok: true };
  });

  // Forget every cached answer.
  app.delete('/admin/api/cache', { preHandler: guard }, async () => ({ cleared: (await ctx.cache?.clear()) ?? 0 }));

  // Check every model now, the way the background check does.
  app.post('/admin/api/deployments/check', { preHandler: guard }, async () => ({ checked: (await ctx.modelHealth?.checkAll()) ?? 0 }));

  // Check a model now, with a real one-token call.
  app.post('/admin/api/deployments/:id/check', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const r = await ctx.modelHealth?.checkOne(id);
    if (!r) return reply.status(404).send({ error: { code: 'not_found', message: 'deployment not found' } });
    return r;
  });

  app.delete('/admin/api/deployments/:id', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const res = await ctx.db.write.deleteFrom('deployments').where('id', '=', id).executeTakeFirst();
    if (Number(res.numDeletedRows) === 0) return reply.status(404).send({ error: { code: 'not_found', message: 'deployment not found' } });
    await ctx.registry.reload();
    return { ok: true };
  });

  // ---- aliases ----
  app.get('/admin/api/aliases', { preHandler: guard }, async () => ({
    aliases: [...ctx.registry.aliases.values()].map((a) => ({ id: a.id, name: a.name, strategy: a.strategy, fallback_on: a.fallbackOn, targets: a.targets, demo: a.demo, config: a.config })),
  }));

  app.post('/admin/api/aliases', { preHandler: guard }, async (req, reply) => {
    const b = (req.body ?? {}) as { name?: string; strategy?: string; targets?: Array<{ deployment_id: string; priority?: number; weight?: number }>; config?: unknown };
    const name = (b.name ?? '').trim();
    const cfg = routeConfig(b.config);
    if ('error' in cfg) return reply.status(400).send({ error: { code: 'invalid', message: cfg.error } });
    if (!name) return reply.status(400).send({ error: { code: 'invalid', message: 'name is required' } });
    if (ctx.registry.aliasesByName.has(name) || ctx.registry.deploymentsByPublicName.has(name)) {
      return reply.status(409).send({ error: { code: 'conflict', message: `"${name}" is already used by another model or alias.` } });
    }
    const strategy = b.strategy ?? 'priority';
    if (!STRATEGIES.includes(strategy)) return reply.status(400).send({ error: { code: 'invalid', message: `strategy must be one of ${STRATEGIES.join(', ')}` } });
    const id = ulid();
    await ctx.db.write.transaction().execute(async (trx) => {
      await trx.insertInto('aliases').values({ id, name, strategy, fallback_on: JSON.stringify(['429', '5xx', 'timeout', 'provider_auth']), demo: 0, created_at: Date.now(), config: cfg.json }).execute();
      for (const [i, t] of (b.targets ?? []).entries()) {
        if (!ctx.registry.deployments.has(t.deployment_id)) continue;
        await trx.insertInto('alias_targets').values({ alias_id: id, deployment_id: t.deployment_id, priority: t.priority ?? (strategy === 'priority' ? i : 0), weight: t.weight ?? 100 }).execute();
      }
    });
    await ctx.registry.reload();
    return reply.status(201).send({ id });
  });

  app.put('/admin/api/aliases/:id', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!ctx.registry.aliases.has(id)) return reply.status(404).send({ error: { code: 'not_found', message: 'alias not found' } });
    const b = (req.body ?? {}) as { name?: string; strategy?: string; targets?: Array<{ deployment_id: string; priority?: number; weight?: number }>; config?: unknown };
    const cfg = b.config === undefined ? undefined : routeConfig(b.config);
    if (cfg && 'error' in cfg) return reply.status(400).send({ error: { code: 'invalid', message: cfg.error } });
    const strategy = typeof b.strategy === 'string' && STRATEGIES.includes(b.strategy) ? b.strategy : ctx.registry.aliases.get(id)!.strategy;
    await ctx.db.write.transaction().execute(async (trx) => {
      const patch: Record<string, unknown> = {};
      if (typeof b.name === 'string' && b.name.trim()) patch.name = b.name.trim();
      if (typeof b.strategy === 'string' && STRATEGIES.includes(b.strategy)) patch.strategy = b.strategy;
      if (cfg) patch.config = cfg.json;
      if (Object.keys(patch).length) await trx.updateTable('aliases').set(patch).where('id', '=', id).execute();
      if (b.targets) {
        await trx.deleteFrom('alias_targets').where('alias_id', '=', id).execute();
        for (const [i, t] of b.targets.entries()) {
          if (!ctx.registry.deployments.has(t.deployment_id)) continue;
          await trx.insertInto('alias_targets').values({ alias_id: id, deployment_id: t.deployment_id, priority: t.priority ?? (strategy === 'priority' ? i : 0), weight: t.weight ?? 100 }).execute();
        }
      }
    });
    await ctx.registry.reload();
    return { ok: true };
  });

  app.delete('/admin/api/aliases/:id', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const res = await ctx.db.write.deleteFrom('aliases').where('id', '=', id).executeTakeFirst();
    if (Number(res.numDeletedRows) === 0) return reply.status(404).send({ error: { code: 'not_found', message: 'alias not found' } });
    await ctx.registry.reload();
    return { ok: true };
  });

  // ---- pricing ----
  app.get('/admin/api/pricing', { preHandler: guard }, async () => ({ entries: ctx.pricing.entries() }));
}

const models = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim());
const count = (v: unknown): boolean => v === undefined || (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 20);

/** An alias's routing config, checked: fallback model lists, retry counts, a cache TTL. */
function routeConfig(v: unknown): { json: string | null } | { error: string } {
  if (v === undefined || v === null) return { json: null };
  if (typeof v !== 'object' || Array.isArray(v)) return { error: 'config must be an object' };
  const c = v as import('../pipeline/routing.js').RouteConfig;
  for (const k of ['context_window', 'content_policy', 'default'] as const) {
    const l = c.fallbacks?.[k];
    if (l !== undefined && !models(l)) return { error: `config.fallbacks.${k} must be a list of model names` };
  }
  for (const k of ['rate_limited', 'timeout', 'server_error', 'unreachable', 'max_attempts'] as const) {
    if (!count(c.retry?.[k])) return { error: `config.retry.${k} must be a whole number from 0 to 20` };
  }
  if (c.cache?.ttl_s !== undefined && !(typeof c.cache.ttl_s === 'number' && c.cache.ttl_s >= 0 && c.cache.ttl_s <= 30 * 24 * 3600)) return { error: 'config.cache.ttl_s must be seconds (up to 30 days)' };
  if (c.cache?.shared !== undefined && typeof c.cache.shared !== 'boolean') return { error: 'config.cache.shared must be true or false' };
  return { json: JSON.stringify(c) };
}

/** What's wrong with a deployment's routing settings, if anything. */
function capsProblem(caps: Record<string, unknown>): string | undefined {
  for (const k of ['context', 'rpm', 'tpm', 'max_parallel', 'headers_timeout_ms']) {
    const v = caps[k];
    if (v !== undefined && v !== null && !(typeof v === 'number' && v >= 0)) return `caps.${k} must be a non-negative number`;
  }
  if (caps.region !== undefined && caps.region !== null && typeof caps.region !== 'string') return 'caps.region must be a string';
  if (caps.tags !== undefined && caps.tags !== null && !models(caps.tags)) return 'caps.tags must be a list of tags';
  const rc = routeConfig({ fallbacks: caps.fallbacks, retry: caps.retry, cache: caps.cache });
  return 'error' in rc ? rc.error : undefined;
}
