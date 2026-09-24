import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { requireAdmin } from './auth.js';

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
    const rows = await ctx.db.read
      .selectFrom('flights')
      .select(['id', 'ts', 'key_id', 'key_name', 'kind', 'deployment_id', 'mcp_server_id', 'tool', 'status', 'duration_ms', 'rule_id'])
      .where('ts', '>=', from)
      .where('ts', '<', to)
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
    return {
      from,
      to,
      oldest: oldest?.ts ?? null,
      truncated,
      // [id, ts, key_id, key_name, kind, target_id, tool, status, duration_ms, rule_id, approval_status]
      flights: rows.map((r) => [r.id, r.ts, r.key_id, r.key_name, r.kind, r.mcp_server_id ?? r.deployment_id, r.tool, r.status, r.duration_ms, r.rule_id, held.get(r.id) ?? null]),
    };
  });
}
