import type { FastifyInstance } from 'fastify';
import { ulid } from 'ulid';
import { sql } from 'kysely';
import type { AppContext } from '../context.js';
import { requireAdmin, isSetupComplete } from './auth.js';
import { generateApiKey } from '../crypto/apikeys.js';
import { classifyOperation } from '../mcp/gateway.js';
import { recentRoutes } from './http.js';
import { DemoConflict, startDemo, stopDemo } from '../demo/control.js';
import { ADMIN_KEY_ID } from './admin-key.js';
import { PLAYGROUND_KEY_ID } from './playground.js';
import { GUARDRAIL_KEY_ID } from '../guardrails/model-check.js';
import { loadViews } from './views.js';
import { recentMethods } from './a2a.js';

const BUILT_IN_KEYS = new Set([ADMIN_KEY_ID, PLAYGROUND_KEY_ID, GUARDRAIL_KEY_ID]);
/** Width of the buckets the map's last minute is seeded from. */
const RECENT_BUCKET_MS = 5000;

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
      demo: ctx.demo !== undefined,
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
    const routes = await recentRoutes(ctx);
    const a2aMethods = await recentMethods(ctx);
    // Connectivity: who actually talked to what (model, tool server, tool) in the last 24h.
    const edgeRows = await sql<{ key_id: string; target: string | null; tool: string | null; requests: number; errors: number; denied: number; cost: number; last_ts: number }>`
      SELECT key_id, COALESCE(mcp_server_id, deployment_id) AS target, tool,
        COUNT(*) AS requests,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
        SUM(CASE WHEN status IN ('denied', 'rejected', 'ticketed') THEN 1 ELSE 0 END) AS denied,
        COALESCE(SUM(cost_nanousd), 0) AS cost,
        MAX(ts) AS last_ts
      FROM flights
      WHERE ts >= ${since} AND COALESCE(mcp_server_id, deployment_id) IS NOT NULL
      GROUP BY key_id, target, tool`.execute(ctx.db.read);
    // The last minute of calls per connection in 5-second buckets, so a map opened now shows what is active now.
    const recentRows = await sql<{ key_id: string; target: string; tool: string | null; b: number; n: number }>`
      SELECT key_id, COALESCE(mcp_server_id, deployment_id) AS target, tool, (ts / ${RECENT_BUCKET_MS}) * ${RECENT_BUCKET_MS} AS b, COUNT(*) AS n
      FROM flights
      WHERE ts >= ${Date.now() - 60_000} AND COALESCE(mcp_server_id, deployment_id) IS NOT NULL
      GROUP BY key_id, target, tool, b`.execute(ctx.db.read);
    const recentBy = new Map<string, Array<[number, number]>>();
    for (const row of recentRows.rows) {
      const k = `${row.key_id}|${row.target}|${row.tool ?? ''}`;
      const list = recentBy.get(k) ?? recentBy.set(k, []).get(k)!;
      list.push([Number(row.b), Number(row.n)]);
    }
    // One row per agent and team rather than per key: copies of an agent (same agent id and team)
    // are drawn as one station at every level, so their rows are summed here. `key_id` is one of
    // the copies (the map resolves it to the agent's station); `keys` counts them.
    const bucketOf = (keyId: string) => {
      const k = r.keysById.get(keyId);
      return k?.agentId ? `a:${k.agentId}|${k.team ?? ''}` : `k:${keyId}`;
    };
    const merged = new Map<string, { key_id: string; target_id: string; tool?: string; requests: number; errors: number; denied: number; cost_nanousd: number; last_ts: number; recent: Map<number, number>; keys: Set<string> }>();
    for (const e of edgeRows.rows) {
      // A deleted key's history stays in Flights and the Ledger; the map has no station to draw it from.
      if (!r.keysById.has(e.key_id)) continue;
      const k = `${bucketOf(e.key_id)}>${e.target}|${e.tool ?? ''}`;
      const recent = recentBy.get(`${e.key_id}|${e.target}|${e.tool ?? ''}`) ?? [];
      const m = merged.get(k);
      if (!m) {
        merged.set(k, { key_id: e.key_id, target_id: e.target!, ...(e.tool ? { tool: e.tool } : {}), requests: Number(e.requests), errors: Number(e.errors), denied: Number(e.denied), cost_nanousd: Number(e.cost), last_ts: Number(e.last_ts), recent: new Map(recent), keys: new Set([e.key_id]) });
        continue;
      }
      m.requests += Number(e.requests);
      m.errors += Number(e.errors);
      m.denied += Number(e.denied);
      m.cost_nanousd += Number(e.cost);
      m.last_ts = Math.max(m.last_ts, Number(e.last_ts));
      for (const [b, n] of recent) m.recent.set(b, (m.recent.get(b) ?? 0) + n);
      m.keys.add(e.key_id);
    }
    const edges = [...merged.values()].map(({ keys, recent, ...e }) => {
      const k = r.keysById.get(e.key_id);
      // When this agent first used this connection (the map flags recent ones as new).
      const first = ctx.paths.get(k?.agentId ?? e.key_id, e.target_id, e.tool)?.first;
      return { ...e, keys: keys.size, recent: [...recent].sort((a, b) => a[0] - b[0]), ...(first ? { first_ts: first } : {}) };
    });

    // Agents calling agents: who called whom (the last agent in each call's chain → the key making the call), last 24h.
    const delegationLinks = async () => {
      const rows = await sql<{ on_behalf_of: string; key_id: string; n: number; last_ts: number }>`
        SELECT on_behalf_of, key_id, COUNT(*) AS n, MAX(ts) AS last_ts
        FROM flights WHERE ts >= ${since} AND on_behalf_of IS NOT NULL
        GROUP BY on_behalf_of, key_id`.execute(ctx.db.read);
      const out = new Map<string, { from: string; origin: string; key_id: string; requests: number; last_ts: number }>();
      for (const row of rows.rows) {
        let chain: string[];
        try {
          chain = JSON.parse(row.on_behalf_of) as string[];
        } catch {
          continue;
        }
        if (!chain.length || !r.keysById.has(row.key_id)) continue;
        const from = chain[chain.length - 1]!;
        const k = `${from}>${bucketOf(row.key_id)}`;
        const cur = out.get(k);
        if (cur) {
          cur.requests += Number(row.n);
          cur.last_ts = Math.max(cur.last_ts, Number(row.last_ts));
        } else out.set(k, { from, origin: chain[0]!, key_id: row.key_id, requests: Number(row.n), last_ts: Number(row.last_ts) });
      }
      return [...out.values()];
    };

    // Built-in keys (console playground, admin key) only appear once they have carried traffic.
    const active = new Set(edgeRows.rows.map((e) => e.key_id));
    const shown = [...r.keysById.values()].filter((k) => !BUILT_IN_KEYS.has(k.id) || active.has(k.id));

    return {
      version: r.version,
      keys: shown.map((k) => ({
        id: k.id,
        name: k.name,
        agent_id: k.agentId,
        team: k.team,
        project: k.project,
        tags: k.tags,
        enabled: k.enabled,
        demo: k.demo,
        ...(k.delegatedOnly ? { delegated_only: true } : {}),
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
      mcp_servers: [
        ...[...ctx.mcp.servers.values()].map((s) => ({
        id: s.id,
        slug: s.slug,
        name: s.name,
        health: s.health,
        enabled: s.enabled,
        tools: s.tools.map((t) => ({ name: t.name, op: classifyOperation(t) })),
        demo: s.demo,
        protocol: 'mcp' as const,
        ...(s.agentId ? { agent_id: s.agentId } : {}),
        })),
        // HTTP APIs are tool servers too: one row per route they have served.
        ...[...ctx.http.apis.values()].map((a) => ({
          id: a.id,
          slug: a.slug,
          name: a.name,
          health: a.health,
          enabled: a.enabled,
          tools: (routes.get(a.id) ?? []).map((t) => ({ name: t.name, op: t.op })),
          demo: a.demo,
          ...(a.agentId ? { agent_id: a.agentId } : {}),
          protocol: 'http' as const,
        })),
        // Remote agents over A2A: one row per method they have been called with; they front an agent.
        ...[...ctx.a2a.agents.values()].map((a) => ({
          id: a.id,
          slug: a.slug,
          name: a.name,
          health: a.health,
          enabled: a.enabled,
          tools: (a2aMethods.get(a.id) ?? []).map((t) => ({ name: t.name, op: t.op })),
          demo: a.demo,
          protocol: 'a2a' as const,
          ...(a.agentId ? { agent_id: a.agentId } : {}),
        })),
      ],
      edges,
      observed: await ctx.observed.summary(since),
      views: await loadViews(ctx),
      delegations: await delegationLinks(),
      // Since when connections have been recorded: a connection is only "new" once there is history to compare with.
      paths_since: ctx.paths.since,
    };
  });

  // ---- Airspace arrangement: the map is shared documentation, so node positions live on the server ----
  app.get('/admin/api/airspace/layout', { preHandler: guard }, async () => {
    const row = await ctx.db.read.selectFrom('settings').select(['value', 'updated_at']).where('key', '=', 'airspace.layout').executeTakeFirst();
    let positions: Record<string, [number, number]> = {};
    try {
      positions = row ? (JSON.parse(row.value) as Record<string, [number, number]>) : {};
    } catch {
      positions = {};
    }
    return { positions, updated_at: row?.updated_at ?? null };
  });

  app.put('/admin/api/airspace/layout', { preHandler: guard }, async (req, reply) => {
    const b = (req.body ?? {}) as { positions?: unknown };
    const input = b.positions;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return reply.status(400).send({ error: { code: 'invalid', message: 'positions must be an object of id → [x, y]' } });
    const entries = Object.entries(input as Record<string, unknown>);
    if (entries.length > 5000) return reply.status(400).send({ error: { code: 'invalid', message: 'too many positions' } });
    const clean: Record<string, [number, number]> = {};
    for (const [id, v] of entries) {
      if (id.length > 128 || !Array.isArray(v) || v.length !== 2) continue;
      const [x, y] = v as unknown[];
      if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1e6 || Math.abs(y) > 1e6) continue;
      clean[id] = [Math.round(x), Math.round(y)];
    }
    const now = Date.now();
    const value = JSON.stringify(clean);
    await ctx.db.write
      .insertInto('settings')
      .values({ key: 'airspace.layout', value, updated_at: now })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value, updated_at: now }))
      .execute();
    return { ok: true, count: Object.keys(clean).length, updated_at: now };
  });

  app.get('/admin/api/events/recent', { preHandler: guard }, async (req) => {
    const q = req.query as { since?: string };
    const since = q.since ? Number(q.since) : Date.now() - 10_000;
    return { events: ctx.ring.since(since) };
  });

  // ---- keys ----
  app.get('/admin/api/keys', { preHandler: guard }, async () => {
    // Last use comes from what the key actually did: gateway flights and observe reports.
    const used = new Map<string, number>();
    const flightRows = await ctx.db.read.selectFrom('flights').select(['key_id', sql<number>`max(ts)`.as('ts')]).where('key_id', 'is not', null).groupBy('key_id').execute();
    for (const r of flightRows) if (r.key_id) used.set(r.key_id, Number(r.ts));
    const observedRows = await ctx.db.read.selectFrom('observed_hourly').select(['key_id', sql<number>`max(last_seen)`.as('ts')]).groupBy('key_id').execute();
    for (const r of observedRows) used.set(r.key_id, Math.max(used.get(r.key_id) ?? 0, Number(r.ts)));
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
          delegated_only: k.delegatedOnly,
          created_at: k.createdAt,
          last_used_at: used.get(k.id) ?? k.lastUsedAt ?? null,
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
      delegated_only?: boolean;
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
        delegated_only: b.delegated_only ? 1 : 0,
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
    if (typeof b.delegated_only === 'boolean') patch.delegated_only = b.delegated_only ? 1 : 0;
    const budget = b.budget as { limit_usd?: number; period?: 'daily' | 'weekly' | 'monthly' | 'total'; hard?: boolean } | null | undefined;
    if (budget !== undefined && budget !== null && !(typeof budget.limit_usd === 'number' && budget.limit_usd > 0 && ['daily', 'weekly', 'monthly', 'total'].includes(budget.period ?? ''))) {
      return reply.status(400).send({ error: { code: 'invalid', message: 'budget needs limit_usd > 0 and period daily | weekly | monthly | total' } });
    }
    if (Object.keys(patch).length === 0 && budget === undefined) return reply.status(400).send({ error: { code: 'invalid', message: 'nothing to update' } });
    if (!ctx.registry.keysById.has(id)) return reply.status(404).send({ error: { code: 'not_found', message: 'key not found' } });
    if (Object.keys(patch).length) await ctx.db.write.updateTable('api_keys').set(patch).where('id', '=', id).execute();
    if (budget === null) {
      await ctx.db.write.deleteFrom('budgets').where('scope_type', '=', 'key').where('scope_id', '=', id).execute();
      await ctx.budgets.reload();
    } else if (budget) {
      await ctx.budgets.upsert('key', id, budget.limit_usd!, budget.period!, budget.hard ?? true);
    }
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
    const q = req.query as { limit?: string; before?: string; status?: string; key_id?: string; kind?: string; for?: string; trace?: string };
    const limit = Math.min(200, Math.max(1, Number(q.limit ?? 50)));
    let qb = ctx.db.read
      .selectFrom('flights')
      .selectAll()
      // Whether this call led to others (agents it called, their calls): a trace starts here.
      .select(sql<number>`EXISTS (SELECT 1 FROM flights c WHERE c.parent_flight_id = flights.id)`.as('has_children'))
      .orderBy('ts', 'desc')
      .limit(limit);
    if (q.before) qb = qb.where('ts', '<', Number(q.before));
    if (q.status) qb = qb.where('status', '=', q.status);
    if (q.key_id) qb = qb.where('key_id', '=', q.key_id);
    if (q.kind) qb = qb.where('kind', '=', q.kind);
    // Calls made on behalf of an agent, anywhere up the chain.
    if (q.for) {
      const pattern = `%${JSON.stringify(q.for).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      qb = qb.where(sql<boolean>`on_behalf_of LIKE ${pattern} ESCAPE '\\'`);
    }
    // Every call in the same tree as this one: up to the call that started it, then everything it led to.
    if (q.trace) {
      const ids = await sql<{ id: string }>`
        WITH RECURSIVE up(id, parent, depth) AS (
          SELECT id, parent_flight_id, 0 FROM flights WHERE id = ${q.trace}
          UNION ALL SELECT f.id, f.parent_flight_id, up.depth + 1 FROM flights f JOIN up ON f.id = up.parent WHERE up.depth < 16
        ),
        root AS (SELECT id FROM up ORDER BY depth DESC LIMIT 1),
        down(id, depth) AS (
          SELECT id, 0 FROM root
          UNION ALL SELECT f.id, down.depth + 1 FROM flights f JOIN down ON f.parent_flight_id = down.id WHERE down.depth < 16
        )
        SELECT id FROM down LIMIT 500`.execute(ctx.db.read);
      qb = qb.where('id', 'in', ids.rows.length ? ids.rows.map((r) => r.id) : ['']);
    }
    const rows = await qb.execute();
    return { flights: rows, next_before: rows.length === limit ? rows[rows.length - 1]!.ts : null };
  });

  /**
   * The calls behind an arc between two agents on the map: the caller's calls to the servers that
   * front the callee (each with what it led to), and what the callee did on the caller's behalf.
   * `from` and `to` are the key ids behind each station (a group or team stands for several).
   */
  app.get('/admin/api/airspace/agent-link', { preHandler: guard }, async (req) => {
    const q = req.query as { from?: string; to?: string; since?: string };
    const ids = (v: string | undefined) => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 500);
    const fromKeys = ids(q.from);
    const toKeys = ids(q.to);
    const since = Number(q.since) || Date.now() - 7 * 24 * 3600_000;
    const ref = (keyId: string) => ctx.registry.keysById.get(keyId)?.agentId ?? keyId;
    const fromRefs = [...new Set(fromKeys.map(ref))];
    const toRefs = new Set(toKeys.map(ref));
    const fronting = [
      ...[...ctx.mcp.servers.values()].filter((x) => x.agentId && toRefs.has(x.agentId)).map((x) => x.id),
      ...[...ctx.http.apis.values()].filter((x) => x.agentId && toRefs.has(x.agentId)).map((x) => x.id),
      ...[...ctx.a2a.agents.values()].filter((x) => x.agentId && toRefs.has(x.agentId)).map((x) => x.id),
    ];
    if (!fromKeys.length || !toKeys.length) return { calls: [], on_behalf: { count: 0, cost_nanousd: 0, last_ts: null }, from_agents: fromRefs };
    const calls = fronting.length
      ? await ctx.db.read
          .selectFrom('flights as f')
          .select(['f.id', 'f.ts', 'f.key_name', 'f.kind', 'f.model_requested', 'f.status', 'f.duration_ms', 'f.error_code'])
          .select(sql<number>`(SELECT count(*) FROM flights c WHERE c.parent_flight_id = f.id)`.as('led_to'))
          .select(sql<number>`(SELECT coalesce(sum(c.cost_nanousd), 0) FROM flights c WHERE c.parent_flight_id = f.id)`.as('led_to_cost_nanousd'))
          .where('f.key_id', 'in', fromKeys)
          .where('f.mcp_server_id', 'in', fronting)
          .where('f.ts', '>=', since)
          .orderBy('f.ts', 'desc')
          .limit(50)
          .execute()
      : [];
    // The callee's own calls made for the caller: the chain ends with the caller.
    const last = sql<string>`json_extract(on_behalf_of, '$[#-1]')`;
    const behalf = await ctx.db.read
      .selectFrom('flights')
      .select([sql<number>`count(*)`.as('n'), sql<number>`coalesce(sum(cost_nanousd), 0)`.as('cost'), sql<number>`max(ts)`.as('last')])
      .where('key_id', 'in', toKeys)
      .where('ts', '>=', since)
      .where('on_behalf_of', 'is not', null)
      .where(last, 'in', fromRefs.length ? fromRefs : [''])
      .executeTakeFirst();
    return { calls, on_behalf: { count: Number(behalf?.n ?? 0), cost_nanousd: Number(behalf?.cost ?? 0), last_ts: behalf?.last ?? null }, from_agents: fromRefs };
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

  // ---- demo mode: start it from the console, or stop it and remove everything it added ----
  app.post('/admin/api/demo', { preHandler: guard }, async (_req, reply) => {
    try {
      await startDemo(ctx);
    } catch (err) {
      if (err instanceof DemoConflict) return reply.status(409).send({ error: { code: 'demo_conflict', message: err.message, names: err.names } });
      throw err;
    }
    return { ok: true, active: true };
  });
  app.delete('/admin/api/demo', { preHandler: guard }, async () => {
    await stopDemo(ctx);
    return { ok: true, active: false };
  });
}
