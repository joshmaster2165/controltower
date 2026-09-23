import type { FastifyInstance } from 'fastify';
import { ulid } from 'ulid';
import type { AppContext } from '../context.js';
import { requireAdmin } from './auth.js';
import type { PolicyService } from '../policy/policy.js';
import type { ApprovalService } from '../policy/approvals.js';
import { validatePattern, type InspectConfig } from '../guardrails/scan.js';
import { detectorCatalog } from '../guardrails/detectors.js';
import { simulate } from '../policy/simulate.js';
import type { RuleRecord } from '../policy/policy.js';

const EFFECTS = ['allow', 'deny', 'require_approval', 'allow_with_limits', 'inspect'];

function inspectConfigError(c: InspectConfig): string | null {
  if (c.action && !['block', 'mask', 'flag'].includes(c.action)) return 'action must be block | mask | flag';
  if (c.direction && !['input', 'output', 'both'].includes(c.direction)) return 'direction must be input | output | both';
  const known = new Set(['secrets', 'pii', 'injection', ...detectorCatalog().map((d) => d.id)]);
  const unknown = (c.detectors ?? []).filter((d) => !known.has(d));
  if (unknown.length) return `unknown detector(s): ${unknown.join(', ')}`;
  for (const p of c.patterns ?? []) {
    const err = validatePattern(p.regex ?? '');
    if (err) return `pattern "${p.name}": ${err}`;
  }
  if (!(c.detectors?.length || c.keywords?.length || c.patterns?.length)) return 'an inspect gate needs at least one detector, keyword or pattern';
  return null;
}

/** Zones, rules (gates), approvals and grants. */
export async function policyRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const guard = requireAdmin(ctx);
  const policy = ctx.policy as PolicyService;
  const approvals = ctx.approvals as ApprovalService;

  app.get('/admin/api/policy', { preHandler: guard }, async () => {
    const snap = policy.snapshot();
    // Rubber-stamp detector: approve rate per rule over recent decisions.
    const stats = await ctx.db.read
      .selectFrom('approvals')
      .select(['rule_id', 'status'])
      .select((eb) => eb.fn.count<number>('id').as('n'))
      .where('status', 'in', ['approved', 'denied'])
      .groupBy(['rule_id', 'status'])
      .execute();
    const byRule: Record<string, { approved: number; denied: number }> = {};
    for (const s of stats) {
      if (!s.rule_id) continue;
      const r = (byRule[s.rule_id] ??= { approved: 0, denied: 0 });
      if (s.status === 'approved') r.approved += Number(s.n);
      else r.denied += Number(s.n);
    }
    return { ...snap, enforcement: ctx.config.mode === 'on', rule_stats: byRule };
  });

  app.get('/admin/api/guardrails/detectors', { preHandler: guard }, async () => ({ detectors: detectorCatalog() }));

  // ---- simulate a draft gate against recorded traffic ----
  app.post('/admin/api/policy/simulate', { preHandler: guard }, async (req, reply) => {
    const b = (req.body ?? {}) as {
      rule?: { name?: string; from_zone?: string | null; to_zone?: string | null; target_kind?: string; match?: Record<string, unknown>; effect?: string; config?: Record<string, unknown>; priority?: number };
      replace_rule_id?: string;
      /** Measure what an existing gate does instead of simulating a draft. */
      impact_of_rule_id?: string;
      hours?: number;
    };
    if (b.impact_of_rule_id) {
      const g = policy.rules.find((x) => x.id === b.impact_of_rule_id);
      if (!g) return reply.status(404).send({ error: { code: 'not_found', message: 'rule not found' } });
      if (g.effect === 'inspect') return reply.status(400).send({ error: { code: 'unsupported', message: 'Inspect gates cannot be simulated: request and response contents are not stored.' } });
      return simulate({ db: ctx.db.read, policy, registry: ctx.registry, mcp: ctx.mcp }, null, { impactOfRuleId: g.id, windowHours: b.hours });
    }
    const r = b.rule ?? {};
    const effect = r.effect;
    if (effect === 'inspect') return reply.status(400).send({ error: { code: 'unsupported', message: 'Inspect gates cannot be simulated: request and response contents are not stored.' } });
    if (!effect || !['allow', 'deny', 'require_approval'].includes(effect)) return reply.status(400).send({ error: { code: 'invalid', message: 'effect must be allow | deny | require_approval' } });
    if (r.from_zone && !policy.zones.has(r.from_zone)) return reply.status(400).send({ error: { code: 'invalid', message: 'from_zone not found' } });
    if (r.to_zone && !policy.zones.has(r.to_zone)) return reply.status(400).send({ error: { code: 'invalid', message: 'to_zone not found' } });
    const existing = b.replace_rule_id ? policy.rules.find((x) => x.id === b.replace_rule_id) : undefined;
    if (b.replace_rule_id && !existing) return reply.status(404).send({ error: { code: 'not_found', message: 'rule not found' } });
    const draft: RuleRecord = {
      id: existing?.id ?? 'draft',
      name: r.name ?? existing?.name ?? 'Draft gate',
      fromZone: r.from_zone !== undefined ? r.from_zone : (existing?.fromZone ?? null),
      toZone: r.to_zone !== undefined ? r.to_zone : (existing?.toZone ?? null),
      targetKind: ((r.target_kind ?? existing?.targetKind ?? 'any') as RuleRecord['targetKind']),
      match: (r.match as RuleRecord['match'] | undefined) ?? existing?.match ?? {},
      effect: effect as RuleRecord['effect'],
      config: { ...(existing?.config ?? {}), ...((r.config as RuleRecord['config'] | undefined) ?? {}) },
      priority: r.priority ?? existing?.priority ?? 100,
      enabled: true,
      revision: (existing?.revision ?? 0) + 1,
      demo: false,
    };
    return simulate({ db: ctx.db.read, policy, registry: ctx.registry, mcp: ctx.mcp }, draft, { replaceRuleId: existing?.id, windowHours: b.hours });
  });

  // ---- zones ----
  app.post('/admin/api/zones', { preHandler: guard }, async (req, reply) => {
    const b = (req.body ?? {}) as { name?: string; color?: string; stations?: string[]; match?: Record<string, unknown>; position?: Record<string, unknown> };
    const name = (b.name ?? '').trim();
    if (!name) return reply.status(400).send({ error: { code: 'invalid', message: 'name is required' } });
    const id = `zone_${ulid()}`;
    const now = Date.now();
    await ctx.db.write
      .insertInto('zones')
      .values({ id, name, color: b.color ?? '#64d2ff', selector: JSON.stringify({ stations: b.stations ?? [], match: b.match ?? {} }), position: b.position ? JSON.stringify(b.position) : null, demo: 0, created_at: now, updated_at: now })
      .execute();
    await policy.reload();
    return reply.status(201).send({ id });
  });

  app.patch('/admin/api/zones/:id', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const z = policy.zones.get(id);
    if (!z) return reply.status(404).send({ error: { code: 'not_found', message: 'zone not found' } });
    const b = (req.body ?? {}) as { name?: string; color?: string; stations?: string[]; match?: Record<string, unknown>; position?: Record<string, unknown> | null };
    const patch: Record<string, unknown> = { updated_at: Date.now() };
    if (typeof b.name === 'string' && b.name.trim()) patch.name = b.name.trim();
    if (typeof b.color === 'string') patch.color = b.color;
    if (b.stations || b.match) patch.selector = JSON.stringify({ stations: b.stations ?? [...z.stations], match: b.match ?? z.match });
    if (b.position !== undefined) patch.position = b.position ? JSON.stringify(b.position) : null;
    await ctx.db.write.updateTable('zones').set(patch).where('id', '=', id).execute();
    await policy.reload();
    return { ok: true };
  });

  app.delete('/admin/api/zones/:id', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const res = await ctx.db.write.deleteFrom('zones').where('id', '=', id).executeTakeFirst();
    if (Number(res.numDeletedRows) === 0) return reply.status(404).send({ error: { code: 'not_found', message: 'zone not found' } });
    await policy.reload();
    return { ok: true };
  });

  // ---- rules (gates) ----
  app.post('/admin/api/rules', { preHandler: guard }, async (req, reply) => {
    const b = (req.body ?? {}) as {
      name?: string;
      from_zone?: string | null;
      to_zone?: string | null;
      target_kind?: string;
      match?: Record<string, unknown>;
      effect?: string;
      config?: Record<string, unknown>;
      priority?: number;
    };
    const effect = b.effect;
    if (!effect || !EFFECTS.includes(effect)) {
      return reply.status(400).send({ error: { code: 'invalid', message: `effect must be ${EFFECTS.join(' | ')}` } });
    }
    const bad = effect === 'inspect' ? inspectConfigError(b.config ?? {}) : null;
    if (bad) return reply.status(400).send({ error: { code: 'invalid', message: bad } });
    if (b.from_zone && !policy.zones.has(b.from_zone)) return reply.status(400).send({ error: { code: 'invalid', message: 'from_zone not found' } });
    if (b.to_zone && !policy.zones.has(b.to_zone)) return reply.status(400).send({ error: { code: 'invalid', message: 'to_zone not found' } });
    const id = `rule_${ulid()}`;
    const now = Date.now();
    const fromName = b.from_zone ? policy.zones.get(b.from_zone)?.name : 'anywhere';
    const toName = b.to_zone ? policy.zones.get(b.to_zone)?.name : 'anywhere';
    await ctx.db.write
      .insertInto('rules')
      .values({
        id,
        name: (b.name ?? '').trim() || `${fromName} → ${toName}: ${effect.replace('_', ' ')}`,
        from_zone: b.from_zone ?? null,
        to_zone: b.to_zone ?? null,
        target_kind: b.target_kind ?? 'any',
        match: JSON.stringify(b.match ?? {}),
        effect,
        config: JSON.stringify(b.config ?? {}),
        priority: b.priority ?? 100,
        enabled: 1,
        revision: 1,
        demo: 0,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await policy.reload();
    return reply.status(201).send({ id });
  });

  app.patch('/admin/api/rules/:id', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const r = policy.rules.find((x) => x.id === id);
    if (!r) return reply.status(404).send({ error: { code: 'not_found', message: 'rule not found' } });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = { updated_at: Date.now(), revision: r.revision + 1 };
    if (typeof b.name === 'string' && b.name.trim()) patch.name = b.name.trim();
    if ('from_zone' in b) patch.from_zone = (b.from_zone as string | null) ?? null;
    if ('to_zone' in b) patch.to_zone = (b.to_zone as string | null) ?? null;
    if (typeof b.target_kind === 'string') patch.target_kind = b.target_kind;
    if (b.match && typeof b.match === 'object') patch.match = JSON.stringify(b.match);
    if (typeof b.effect === 'string') {
      if (!EFFECTS.includes(b.effect)) return reply.status(400).send({ error: { code: 'invalid', message: `effect must be ${EFFECTS.join(' | ')}` } });
      patch.effect = b.effect;
    }
    if (b.config && typeof b.config === 'object') {
      const merged = { ...r.config, ...(b.config as object) };
      const bad = (patch.effect ?? r.effect) === 'inspect' ? inspectConfigError(merged) : null;
      if (bad) return reply.status(400).send({ error: { code: 'invalid', message: bad } });
      patch.config = JSON.stringify(merged);
    }
    if (typeof b.priority === 'number') patch.priority = b.priority;
    if (typeof b.enabled === 'boolean') patch.enabled = b.enabled ? 1 : 0;
    await ctx.db.write.updateTable('rules').set(patch).where('id', '=', id).execute();
    await policy.reload();
    return { ok: true };
  });

  app.delete('/admin/api/rules/:id', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const res = await ctx.db.write.deleteFrom('rules').where('id', '=', id).executeTakeFirst();
    if (Number(res.numDeletedRows) === 0) return reply.status(404).send({ error: { code: 'not_found', message: 'rule not found' } });
    await ctx.db.write.deleteFrom('alert_rules').where('rule_id', '=', id).execute();
    await policy.reload();
    await ctx.alerts.reload();
    return { ok: true };
  });

  // ---- approvals ----
  app.get('/admin/api/approvals', { preHandler: guard }, async (req) => {
    const q = req.query as { status?: string; limit?: string };
    const limit = Math.min(200, Math.max(1, Number(q.limit ?? 50)));
    let qb = ctx.db.read.selectFrom('approvals').selectAll().orderBy('requested_at', 'desc').limit(limit);
    if (q.status && q.status !== 'all') qb = qb.where('status', '=', q.status);
    const rows = await qb.execute();
    return {
      approvals: rows.map((a) => ({
        ...a,
        target: JSON.parse(a.target) as unknown,
        args_preview: a.args_preview ? (JSON.parse(a.args_preview) as unknown) : null,
        demo: a.demo === 1,
      })),
      held: ctx.approvals.heldCount,
      server_time: Date.now(),
    };
  });

  app.post('/admin/api/approvals/:id/decide', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const b = (req.body ?? {}) as { action?: 'approve' | 'deny'; note?: string; window?: { uses?: number; ttl_ms?: number } };
    if (b.action !== 'approve' && b.action !== 'deny') return reply.status(400).send({ error: { code: 'invalid', message: 'action must be approve or deny' } });
    const r = await approvals.decide(id, req.admin?.email ?? 'admin', b.action, { ...(b.note ? { note: b.note } : {}), ...(b.window ? { window: b.window } : {}) });
    if (!r.ok) return reply.status(409).send({ error: { code: 'conflict', message: r.status } });
    return r;
  });

  app.get('/admin/api/grants', { preHandler: guard }, async () => {
    const rows = await ctx.db.read.selectFrom('grants').selectAll().where('expires_at', '>', Date.now() - 3600_000).orderBy('created_at', 'desc').limit(100).execute();
    return { grants: rows.map((g) => ({ ...g, id: `…${g.id.slice(-6)}`, raw_id: g.id })) };
  });

  app.post('/admin/api/grants/:id/revoke', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const ok = await approvals.revokeGrant(id);
    if (!ok) return reply.status(404).send({ error: { code: 'not_found', message: 'grant not found or already revoked' } });
    return { ok: true };
  });
}
