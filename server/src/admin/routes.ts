import type { FastifyInstance } from 'fastify';
import { ulid } from 'ulid';
import { sql } from 'kysely';
import type { AppContext } from '../context.js';
import { requireAdmin, isSetupComplete } from './auth.js';
import { generateApiKey } from '../crypto/apikeys.js';
import { LAT_BUCKETS } from '../events/db-sink.js';

/**
 * Admin API. Read endpoints feed the console; write endpoints mutate the DB
 * and trigger a registry reload so the hot path sees the change immediately.
 */
export async function adminRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const guard = requireAdmin(ctx);

  // ---- status (unauthenticated, no secrets) ----
  app.get('/admin/api/status', async () => {
    const provs = [...ctx.registry.providers.values()];
    return {
      version: ctx.config.version,
      setup_complete: await isSetupComplete(ctx),
      demo: ctx.config.demo,
      mode: ctx.config.mode,
      uptime_s: Math.round((Date.now() - ctx.startedAt) / 1000),
      shutting_down: ctx.shuttingDown,
      db: { pending_events: ctx.dbSink.pendingCount, wal_bytes: ctx.db.walBytes(), backpressure: ctx.dbSink.backpressure },
      providers: { total: provs.length, ok: provs.filter((p) => p.health === 'ok').length, down: provs.filter((p) => p.health === 'down').length },
      held: ctx.approvals.heldCount,
      topology_version: ctx.registry.version,
    };
  });

  // ---- topology: what the Airspace draws before any flight arrives ----
  app.get('/admin/api/topology', { preHandler: guard }, async () => {
    const r = ctx.registry;
    const since = Date.now() - 24 * 3600 * 1000;
    const sinceBucket = new Date(since).toISOString().slice(0, 13);
    const lanes = await ctx.db.read
      .selectFrom('usage_hourly')
      .select(['key_id', 'deployment_id', 'kind'])
      .select((eb) => [
        eb.fn.sum<number>('requests').as('requests'),
        eb.fn.sum<number>('errors').as('errors'),
        eb.fn.sum<number>('denied').as('denied'),
        eb.fn.sum<number>('held').as('held'),
        eb.fn.sum<number>('cost_nanousd').as('cost_nanousd'),
        eb.fn.sum<number>('in_tokens').as('in_tokens'),
        eb.fn.sum<number>('out_tokens').as('out_tokens'),
        eb.fn.sum<number>('lat_sum_ms').as('lat_sum_ms'),
        eb.fn.sum<number>('lat_count').as('lat_count'),
      ])
      .where('bucket', '>=', sinceBucket)
      .groupBy(['key_id', 'deployment_id', 'kind'])
      .execute();

    return {
      version: r.version,
      keys: [...r.keysById.values()].map((k) => ({
        id: k.id,
        name: k.name,
        agent_id: k.agentId,
        team: k.team,
        project: k.project,
        tags: k.tags,
        enabled: k.enabled,
        demo: k.demo,
      })),
      providers: [...r.providers.values()].map((p) => ({ id: p.id, kind: p.kind, name: p.name, slug: p.slug, health: p.health, demo: p.demo })),
      deployments: [...r.deployments.values()].map((d) => ({
        id: d.id,
        provider_id: d.providerId,
        upstream_model: d.upstreamModel,
        public_name: d.publicName,
        enabled: d.enabled,
        cooling_until: d.coolingUntil,
        ewma_ttft_ms: d.ewmaTtftMs,
        demo: d.demo,
      })),
      aliases: [...r.aliases.values()].map((a) => ({ id: a.id, name: a.name, strategy: a.strategy, targets: a.targets })),
      mcp_servers: [...ctx.mcp.servers.values()].map((s) => ({ id: s.id, slug: s.slug, name: s.name, health: s.health, enabled: s.enabled, tools: s.tools.map((t) => t.name), demo: s.demo })),
      lanes: lanes.map((l) => ({
        key_id: l.key_id,
        deployment_id: l.deployment_id,
        kind: l.kind,
        requests: Number(l.requests ?? 0),
        errors: Number(l.errors ?? 0),
        denied: Number(l.denied ?? 0),
        held: Number(l.held ?? 0),
        cost_nanousd: Number(l.cost_nanousd ?? 0),
        in_tokens: Number(l.in_tokens ?? 0),
        out_tokens: Number(l.out_tokens ?? 0),
        avg_ms: Number(l.lat_count ?? 0) > 0 ? Number(l.lat_sum_ms ?? 0) / Number(l.lat_count ?? 0) : null,
      })),
      lat_buckets: LAT_BUCKETS,
    };
  });

  app.get('/admin/api/events/recent', { preHandler: guard }, async (req) => {
    const q = req.query as { since?: string };
    const since = q.since ? Number(q.since) : Date.now() - 10_000;
    return { events: ctx.ring.since(since) };
  });

  // ---- keys ----
  app.get('/admin/api/keys', { preHandler: guard }, async () => {
    return {
      keys: [...ctx.registry.keysById.values()]
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((k) => ({
          id: k.id,
          name: k.name,
          prefix: k.prefix,
          last4: k.last4,
          agent_id: k.agentId,
          team: k.team,
          project: k.project,
          tags: k.tags,
          allowed_models: k.allowedModels,
          allowed_mcp: k.allowedMcp,
          limits: k.limits,
          enabled: k.enabled,
          expires_at: k.expiresAt,
          demo: k.demo,
          created_at: k.createdAt,
          last_used_at: k.lastUsedAt,
        })),
    };
  });

  app.post('/admin/api/keys', { preHandler: guard }, async (req, reply) => {
    const b = (req.body ?? {}) as {
      name?: string;
      agent_id?: string;
      team?: string;
      project?: string;
      tags?: string[];
      allowed_models?: string[];
      allowed_mcp?: string[];
      limits?: { rpm?: number; tpm?: number; maxParallel?: number };
      expires_at?: number | null;
      budget?: { limit_usd: number; period: 'daily' | 'weekly' | 'monthly' | 'total'; hard?: boolean } | null;
    };
    const name = (b.name ?? '').trim();
    if (!name) return reply.status(400).send({ error: { code: 'invalid', message: 'name is required' } });
    const gen = generateApiKey();
    const id = ulid();
    const now = Date.now();
    await ctx.db.write
      .insertInto('api_keys')
      .values({
        id,
        name,
        key_hash: gen.hash,
        key_prefix: gen.prefix,
        last4: gen.last4,
        agent_id: b.agent_id?.trim() || name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        team: b.team?.trim() || null,
        project: b.project?.trim() || null,
        tags: JSON.stringify(b.tags ?? []),
        allowed_models: JSON.stringify(b.allowed_models?.length ? b.allowed_models : ['*']),
        allowed_mcp: JSON.stringify(b.allowed_mcp?.length ? b.allowed_mcp : ['*']),
        limits: JSON.stringify(b.limits ?? {}),
        enabled: 1,
        expires_at: b.expires_at ?? null,
        created_by: req.admin?.email ?? null,
        demo: 0,
        created_at: now,
        last_used_at: null,
      })
      .execute();
    if (b.budget) {
      await ctx.budgets.upsert('key', id, b.budget.limit_usd, b.budget.period, b.budget.hard ?? true);
    }
    await ctx.registry.reload();
    return reply.status(201).send({ id, name, key: gen.plaintext, prefix: gen.prefix, last4: gen.last4 });
  });

  app.patch('/admin/api/keys/:id', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (typeof b.name === 'string') patch.name = b.name.trim();
    if (typeof b.enabled === 'boolean') patch.enabled = b.enabled ? 1 : 0;
    if (typeof b.team === 'string' || b.team === null) patch.team = b.team || null;
    if (typeof b.project === 'string' || b.project === null) patch.project = b.project || null;
    if (typeof b.agent_id === 'string') patch.agent_id = b.agent_id || null;
    if (Array.isArray(b.allowed_models)) patch.allowed_models = JSON.stringify(b.allowed_models);
    if (Array.isArray(b.allowed_mcp)) patch.allowed_mcp = JSON.stringify(b.allowed_mcp);
    if (Array.isArray(b.tags)) patch.tags = JSON.stringify(b.tags);
    if (b.limits && typeof b.limits === 'object') patch.limits = JSON.stringify(b.limits);
    if ('expires_at' in b) patch.expires_at = (b.expires_at as number | null) ?? null;
    if (Object.keys(patch).length === 0) return reply.status(400).send({ error: { code: 'invalid', message: 'nothing to update' } });
    const res = await ctx.db.write.updateTable('api_keys').set(patch).where('id', '=', id).executeTakeFirst();
    if (Number(res.numUpdatedRows) === 0) return reply.status(404).send({ error: { code: 'not_found', message: 'key not found' } });
    await ctx.registry.reload();
    return { ok: true };
  });

  app.delete('/admin/api/keys/:id', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const res = await ctx.db.write.deleteFrom('api_keys').where('id', '=', id).executeTakeFirst();
    if (Number(res.numDeletedRows) === 0) return reply.status(404).send({ error: { code: 'not_found', message: 'key not found' } });
    await ctx.db.write.deleteFrom('budgets').where('scope_type', '=', 'key').where('scope_id', '=', id).execute();
    await ctx.registry.reload();
    await ctx.budgets.reload();
    return { ok: true };
  });

  // ---- flights ----
  app.get('/admin/api/flights', { preHandler: guard }, async (req) => {
    const q = req.query as { limit?: string; before?: string; status?: string; key_id?: string; kind?: string };
    const limit = Math.min(200, Math.max(1, Number(q.limit ?? 50)));
    let qb = ctx.db.read.selectFrom('flights').selectAll().orderBy('ts', 'desc').limit(limit);
    if (q.before) qb = qb.where('ts', '<', Number(q.before));
    if (q.status) qb = qb.where('status', '=', q.status);
    if (q.key_id) qb = qb.where('key_id', '=', q.key_id);
    if (q.kind) qb = qb.where('kind', '=', q.kind);
    const rows = await qb.execute();
    return { flights: rows, next_before: rows.length === limit ? rows[rows.length - 1]!.ts : null };
  });

  app.get('/admin/api/flights/:id', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const flight = await ctx.db.read.selectFrom('flights').selectAll().where('id', '=', id).executeTakeFirst();
    if (!flight) return reply.status(404).send({ error: { code: 'not_found', message: 'flight not found' } });
    const events = await ctx.db.read.selectFrom('flight_events').selectAll().where('flight_id', '=', id).orderBy('seq').execute();
    return { flight, events: events.map((e) => JSON.parse(e.payload)) };
  });

  // ---- ledger summary ----
  app.get('/admin/api/ledger/summary', { preHandler: guard }, async (req) => {
    const q = req.query as { window?: '1h' | '24h' | '7d' | '30d' };
    const win = q.window ?? '24h';
    const ms = { '1h': 3600e3, '24h': 24 * 3600e3, '7d': 7 * 24 * 3600e3, '30d': 30 * 24 * 3600e3 }[win];
    const table = win === '1h' || win === '24h' ? 'usage_hourly' : 'usage_daily';
    const sinceBucket = new Date(Date.now() - ms).toISOString().slice(0, table === 'usage_hourly' ? 13 : 10);
    const byKey = await ctx.db.read
      .selectFrom(table)
      .select(['key_id'])
      .select((eb) => [
        eb.fn.sum<number>('requests').as('requests'),
        eb.fn.sum<number>('errors').as('errors'),
        eb.fn.sum<number>('denied').as('denied'),
        eb.fn.sum<number>('cost_nanousd').as('cost_nanousd'),
        eb.fn.sum<number>('in_tokens').as('in_tokens'),
        eb.fn.sum<number>('out_tokens').as('out_tokens'),
      ])
      .where('bucket', '>=', sinceBucket)
      .groupBy('key_id')
      .execute();
    const byDeployment = await ctx.db.read
      .selectFrom(table)
      .select(['deployment_id'])
      .select((eb) => [
        eb.fn.sum<number>('requests').as('requests'),
        eb.fn.sum<number>('cost_nanousd').as('cost_nanousd'),
        eb.fn.sum<number>('in_tokens').as('in_tokens'),
        eb.fn.sum<number>('out_tokens').as('out_tokens'),
        eb.fn.sum<number>('lat_sum_ms').as('lat_sum_ms'),
        eb.fn.sum<number>('lat_count').as('lat_count'),
      ])
      .where('bucket', '>=', sinceBucket)
      .groupBy('deployment_id')
      .execute();
    const series = await ctx.db.read
      .selectFrom(table)
      .select(['bucket'])
      .select((eb) => [eb.fn.sum<number>('requests').as('requests'), eb.fn.sum<number>('cost_nanousd').as('cost_nanousd'), eb.fn.sum<number>('errors').as('errors')])
      .where('bucket', '>=', sinceBucket)
      .groupBy('bucket')
      .orderBy('bucket')
      .execute();
    const num = (v: unknown) => Number(v ?? 0);
    return {
      window: win,
      by_key: byKey.map((r) => ({ key_id: r.key_id, requests: num(r.requests), errors: num(r.errors), denied: num(r.denied), cost_nanousd: num(r.cost_nanousd), in_tokens: num(r.in_tokens), out_tokens: num(r.out_tokens) })),
      by_deployment: byDeployment.map((r) => ({
        deployment_id: r.deployment_id,
        requests: num(r.requests),
        cost_nanousd: num(r.cost_nanousd),
        in_tokens: num(r.in_tokens),
        out_tokens: num(r.out_tokens),
        avg_ms: num(r.lat_count) > 0 ? num(r.lat_sum_ms) / num(r.lat_count) : null,
      })),
      series: series.map((r) => ({ bucket: r.bucket, requests: num(r.requests), cost_nanousd: num(r.cost_nanousd), errors: num(r.errors) })),
      budgets: ctx.budgets.snapshot(),
    };
  });

  // ---- demo data ----
  app.delete('/admin/api/demo', { preHandler: guard }, async () => {
    await ctx.db.write.deleteFrom('api_keys').where('demo', '=', 1).execute();
    await ctx.db.write.deleteFrom('aliases').where('demo', '=', 1).execute();
    await ctx.db.write.deleteFrom('deployments').where('demo', '=', 1).execute();
    await ctx.db.write.deleteFrom('providers').where('demo', '=', 1).execute();
    await ctx.db.write.deleteFrom('rules').where('demo', '=', 1).execute();
    await ctx.db.write.deleteFrom('zones').where('demo', '=', 1).execute();
    await ctx.db.write.deleteFrom('approvals').where('demo', '=', 1).execute();
    await ctx.db.write.deleteFrom('mcp_servers').where('demo', '=', 1).execute();
    await ctx.mcp.reload();
    await sql`DELETE FROM flights WHERE key_id LIKE 'key_demo_%'`.execute(ctx.db.write);
    await sql`DELETE FROM flight_events WHERE flight_id NOT IN (SELECT id FROM flights)`.execute(ctx.db.write);
    await sql`DELETE FROM usage_hourly WHERE key_id LIKE 'key_demo_%'`.execute(ctx.db.write);
    await sql`DELETE FROM usage_daily WHERE key_id LIKE 'key_demo_%'`.execute(ctx.db.write);
    ctx.demo?.stop();
    await ctx.registry.reload();
    return { ok: true };
  });
}
