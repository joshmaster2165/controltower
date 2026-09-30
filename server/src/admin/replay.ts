import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { requireAdmin } from './auth.js';
import { inList, scopeOf } from './scope.js';
import { askRegions, note } from '../ee/multi-region/federate.js';

const MAX = 50_000;

/**
 * Flight Recorder: past flights in a time window, compact, for replaying on
 * the map. Only names, targets, outcomes and timings — the same facts the map
 * shows live; nothing about request contents is stored to begin with.
 */
export async function replayRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const guard = requireAdmin(ctx);
  app.get('/admin/api/replay', { preHandler: guard }, async (req, reply) => {
    const q = req.query as { from?: string; to?: string };
    const to = Number(q.to) || Date.now();
    const from = Number(q.from) || to - 3600_000;
    if (!(from < to)) return reply.status(400).send({ error: { code: 'invalid', message: 'from must be before to' } });
    const scope = scopeOf(req);
    const rows = await ctx.db.read
      .selectFrom('flights')
      .select(['id', 'ts', 'key_id', 'key_name', 'kind', 'deployment_id', 'mcp_server_id', 'tool', 'status', 'duration_ms', 'rule_id'])
      .where('ts', '>=', from)
      .where('ts', '<', to)
      .$if(!scope.all, (qb) => qb.where('team', 'in', inList([...scope.teams])))
      .orderBy('ts', 'asc')
      .limit(MAX + 1)
      .execute();
    const truncated = rows.length > MAX;
    if (truncated) rows.length = MAX;
    const ids = rows.map((r) => r.id);
    const held = new Map<string, string>();
    for (let i = 0; i < ids.length; i += 900) {
      const chunk = ids.slice(i, i + 900);
      const a = await ctx.db.read.selectFrom('approvals').select(['flight_id', 'status']).where('flight_id', 'in', chunk).execute();
      for (const r of a) held.set(r.flight_id, r.status);
    }
    const oldest = await ctx.db.read.selectFrom('flights').select((eb) => eb.fn.min<number>('ts').as('ts')).executeTakeFirst();
    // With regions (Enterprise): their calls in the window too.
    const remote = await askRegions(ctx, req, 'GET', req.url);
    const flightsOut = rows.map((r) => [r.id, r.ts, r.key_id, r.key_name, r.kind, r.mcp_server_id ?? r.deployment_id, r.tool, r.status, r.duration_ms, r.rule_id, held.get(r.id) ?? null] as unknown[]);
    if (remote.length) {
      for (const a of remote) if (a.ok) flightsOut.push(...((a.body?.flights ?? []) as unknown[][]));
      flightsOut.sort((x, y) => Number(x[1]) - Number(y[1]));
      if (flightsOut.length > MAX) flightsOut.length = MAX;
    }
    return {
      from,
      to,
      oldest: oldest?.ts ?? null,
      truncated: truncated || remote.some((a) => a.ok && a.body?.truncated) || flightsOut.length >= MAX,
      ...(remote.length ? { regions: note(remote) } : {}),
      // [id, ts, key_id, key_name, kind, target_id, tool, status, duration_ms, rule_id, approval_status]
      flights: flightsOut,
    };
  });
}
