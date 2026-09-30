import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { requireAdmin } from './auth.js';
import type { BudgetScope } from '../limits/limiter.js';
import { managesTeam, scopeOf, seesKey, type Scope } from './scope.js';
import { budgetVisible } from './routes.js';

const SCOPES = ['key', 'team', 'project', 'customer'] as const;
const PERIODS = ['daily', 'weekly', 'monthly', 'total'] as const;
type ScopeType = (typeof SCOPES)[number];

/**
 * Budgets for a key, a team or a project. Team and project budgets cover
 * every key with that label, now and later; each call is checked against
 * every budget that covers it.
 */
export async function budgetRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const guard = requireAdmin(ctx);
  const bad = (reply: import('fastify').FastifyReply, message: string) => reply.status(400).send({ error: { code: 'invalid', message } });

  /**
   * Who may set a budget: a key's, whoever manages its team; a team's, an admin or the admin of its
   * organisation (a team admin can't raise their own); projects' and customers', admins.
   */
  const maySet = (scope: Scope, type: string, id: string): boolean => {
    if (scope.manage === 'all') return true;
    if (type === 'key') return managesTeam(scope, ctx.registry.keysById.get(id)?.team);
    if (type === 'team') {
      const org = ctx.orgs?.teamsByName.get(id)?.orgId;
      return !!org && scope.orgAdmin !== 'all' && scope.orgAdmin.has(org);
    }
    return false;
  };

  app.get('/admin/api/budgets', { preHandler: guard }, async (req) => {
    const scope = scopeOf(req);
    const keys = [...ctx.registry.keysById.values()].filter((k) => scope.all || seesKey(scope, k));
    return {
      budgets: ctx.budgets.snapshot().filter((b) => scope.all || budgetVisible(ctx, scope, b.scope)).map((b) => {
        const [type, ...rest] = b.scope.split(':');
        const id = rest.join(':');
        const covers = type === 'key' ? 1 : type === 'customer' ? 0 : keys.filter((k) => (type === 'team' ? k.team : k.project) === id).length;
        return {
          scope_type: type,
          scope_id: id,
          name: type === 'key' ? (ctx.registry.keysById.get(id)?.name ?? id) : type === 'customer' ? (ctx.registry.customers.get(id)?.name ?? id) : id,
          keys: covers,
          limit_usd: b.limit_nanousd / 1e9,
          spent_usd: b.spent_nanousd / 1e9,
          reserved_usd: b.reserved_nanousd / 1e9,
          period: b.period,
          hard: b.hard,
          resets_at: b.resets_at ?? null,
        };
      }),
      teams: [...new Set(keys.map((k) => k.team).filter(Boolean))].sort(),
      projects: [...new Set(keys.map((k) => k.project).filter(Boolean))].sort(),
    };
  });

  app.put('/admin/api/budgets/:type/:id', { preHandler: guard }, async (req, reply) => {
    const { type, id } = req.params as { type: string; id: string };
    const b = (req.body ?? {}) as { limit_usd?: unknown; period?: unknown; hard?: unknown };
    if (!(SCOPES as readonly string[]).includes(type)) return bad(reply, 'scope must be key, team, project or customer');
    const scopeId = decodeURIComponent(id).trim();
    if (!scopeId) return bad(reply, 'a team, project or key id is required');
    if (type === 'key' && !ctx.registry.keysById.has(scopeId)) return reply.status(404).send({ error: { code: 'not_found', message: 'key not found' } });
    if (!maySet(scopeOf(req), type, scopeId)) return reply.status(403).send({ error: { code: 'forbidden', message: type === 'team' ? "A team's budget is set by an admin or its organisation's admin." : "That budget isn't one of your teams'." } });
    if (typeof b.limit_usd !== 'number' || !(b.limit_usd > 0)) return bad(reply, 'limit_usd must be a positive number');
    const period = (b.period ?? 'monthly') as BudgetScope['period'];
    if (!(PERIODS as readonly string[]).includes(period)) return bad(reply, 'period must be daily, weekly, monthly or total');
    await ctx.budgets.upsert(type as ScopeType, scopeId, b.limit_usd, period, b.hard !== false);
    const snap = ctx.budgets.snapshot().find((s) => s.scope === `${type}:${scopeId}`)!;
    return { scope: snap.scope, limit_usd: snap.limit_nanousd / 1e9, spent_usd: snap.spent_nanousd / 1e9, period: snap.period, hard: snap.hard, resets_at: snap.resets_at ?? null };
  });

  app.delete('/admin/api/budgets/:type/:id', { preHandler: guard }, async (req, reply) => {
    const { type, id } = req.params as { type: string; id: string };
    const scopeId = decodeURIComponent(id);
    if (!maySet(scopeOf(req), type, scopeId)) return reply.status(403).send({ error: { code: 'forbidden', message: "That budget isn't one of yours to change." } });
    if (!ctx.budgets.snapshot().some((s) => s.scope === `${type}:${scopeId}`)) return reply.status(404).send({ error: { code: 'not_found', message: 'no such budget' } });
    await ctx.budgets.remove(type, scopeId);
    return { ok: true };
  });
}
