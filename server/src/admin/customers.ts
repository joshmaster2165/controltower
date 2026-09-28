import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import type { AppContext } from '../context.js';
import { requireAdmin } from './auth.js';
import { currentDialect } from '../db/sqlfn.js';

const WINDOWS: Record<string, number> = { '24h': 24 * 3600e3, '7d': 7 * 24 * 3600e3, '30d': 30 * 24 * 3600e3 };

/**
 * The end customers agents serve, and spend by tag. A call's customer is its `x-ct-customer` header (or the
 * request's `user` field); its tags come from `x-ct-tags`. Customers can be named, blocked and given budgets.
 */
export async function customerRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const guard = requireAdmin(ctx);
  const since = (q: unknown) => Date.now() - (WINDOWS[(q as { window?: string }).window ?? '30d'] ?? WINDOWS['30d']!);

  app.get('/admin/api/customers', { preHandler: guard }, async (req) => {
    const rows = await ctx.db.read
      .selectFrom('flights')
      .select((eb) => [
        'customer',
        eb.fn.countAll<number>().as('requests'),
        eb.fn.sum<number>('cost_nanousd').as('cost_nanousd'),
        eb.fn.max<number>('ts').as('last_ts'),
        eb.fn.count<number>('key_id').distinct().as('agents'),
      ])
      .where('customer', 'is not', null)
      .where('ts', '>=', since(req.query))
      .groupBy('customer')
      .orderBy('cost_nanousd', 'desc')
      .limit(1000)
      .execute();
    const budgets = new Map(
      ctx.budgets
        .snapshot()
        .filter((b) => b.scope.startsWith('customer:'))
        .map((b) => [b.scope.slice(9), { limit_usd: b.limit_nanousd / 1e9, spent_usd: b.spent_nanousd / 1e9, period: b.period, hard: b.hard, resets_at: b.resets_at ?? null }]),
    );
    const seen = new Set<string>();
    const out = rows.map((r) => {
      const id = r.customer!;
      seen.add(id);
      const c = ctx.registry.customers.get(id);
      return { id, name: c?.name ?? null, blocked: c?.blocked ?? false, requests: Number(r.requests), cost_usd: Number(r.cost_nanousd ?? 0) / 1e9, agents: Number(r.agents), last_ts: Number(r.last_ts), budget: budgets.get(id) ?? null };
    });
    // Customers named, blocked or budgeted, with no calls in the window.
    for (const id of new Set([...ctx.registry.customers.keys(), ...budgets.keys()])) {
      if (seen.has(id)) continue;
      const c = ctx.registry.customers.get(id);
      out.push({ id, name: c?.name ?? null, blocked: c?.blocked ?? false, requests: 0, cost_usd: 0, agents: 0, last_ts: 0, budget: budgets.get(id) ?? null });
    }
    return { customers: out };
  });

  app.put('/admin/api/customers/:id', { preHandler: guard }, async (req, reply) => {
    const id = decodeURIComponent((req.params as { id: string }).id).trim();
    const b = (req.body ?? {}) as { name?: unknown; blocked?: unknown; note?: unknown };
    if (!id || id.length > 128) return reply.status(400).send({ error: { code: 'invalid', message: 'a customer id (up to 128 characters) is required' } });
    const now = Date.now();
    const cur = await ctx.db.write.selectFrom('customers').selectAll().where('id', '=', id).executeTakeFirst();
    const row = {
      name: typeof b.name === 'string' ? b.name.trim() || null : (cur?.name ?? null),
      blocked: typeof b.blocked === 'boolean' ? (b.blocked ? 1 : 0) : (cur?.blocked ?? 0),
      note: typeof b.note === 'string' ? b.note.trim() || null : (cur?.note ?? null),
      updated_at: now,
    };
    await ctx.db.write
      .insertInto('customers')
      .values({ id, created_at: now, ...row })
      .onConflict((oc) => oc.column('id').doUpdateSet(row))
      .execute();
    await ctx.registry.reload();
    ctx.log.info({ customer: id, blocked: row.blocked === 1, by: req.admin?.email }, 'customer updated');
    return { id, name: row.name, blocked: row.blocked === 1, note: row.note };
  });

  app.delete('/admin/api/customers/:id', { preHandler: guard }, async (req) => {
    const id = decodeURIComponent((req.params as { id: string }).id);
    await ctx.db.write.deleteFrom('customers').where('id', '=', id).execute();
    await ctx.budgets.remove('customer', id);
    await ctx.registry.reload();
    return { ok: true };
  });

  // Spend by the tags requests carried.
  app.get('/admin/api/ledger/tags', { preHandler: guard }, async (req) => {
    const from = since(req.query);
    const q =
      currentDialect() === 'postgres'
        ? sql<{ tag: string; requests: number; cost_nanousd: number | null; errors: number }>`
            SELECT t.tag, count(*) AS requests, sum(f.cost_nanousd) AS cost_nanousd, sum(CASE WHEN f.status = 'error' THEN 1 ELSE 0 END) AS errors
            FROM flights f CROSS JOIN LATERAL jsonb_array_elements_text(f.tags::jsonb) AS t(tag)
            WHERE f.tags IS NOT NULL AND f.ts >= ${from} GROUP BY t.tag ORDER BY cost_nanousd DESC NULLS LAST LIMIT 500`
        : sql<{ tag: string; requests: number; cost_nanousd: number | null; errors: number }>`
            SELECT je.value AS tag, count(*) AS requests, sum(f.cost_nanousd) AS cost_nanousd, sum(CASE WHEN f.status = 'error' THEN 1 ELSE 0 END) AS errors
            FROM flights f, json_each(f.tags) je
            WHERE f.tags IS NOT NULL AND f.ts >= ${from} GROUP BY je.value ORDER BY cost_nanousd DESC LIMIT 500`;
    const r = await q.execute(ctx.db.read);
    return { tags: r.rows.map((x) => ({ tag: x.tag, requests: Number(x.requests), errors: Number(x.errors), cost_usd: Number(x.cost_nanousd ?? 0) / 1e9 })) };
  });
}
