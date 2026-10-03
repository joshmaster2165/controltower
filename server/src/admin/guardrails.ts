import type { FastifyInstance, FastifyReply } from 'fastify';
import { ulid } from 'ulid';
import type { AppContext } from '../context.js';
import { requireAdmin } from './auth.js';
import { guardrailProblem, tidyChecks, withGuardrails, type GuardrailChecks } from '../guardrails/library.js';
import { compileInspector, describeFindings, type InspectConfig } from '../guardrails/scan.js';
import { inspect } from '../guardrails/inspect.js';
import type { PolicyService } from '../policy/policy.js';

/**
 * Your own guardrails (guardrails/library.ts): list, make, change, remove, and try one on some text before a gate
 * uses it. They're kept with the policy: a change reloads it, here and (through the cluster's sync) everywhere.
 */
export async function guardrailRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const guard = requireAdmin(ctx);
  const policy = ctx.policy as PolicyService;
  const bad = (reply: FastifyReply, message: string) => reply.status(400).send({ error: { code: 'invalid', message } });
  /** The gates using a guardrail. */
  const usedBy = (id: string) => policy.rules.filter((r) => r.effect === 'inspect' && r.config.guardrails?.includes(id)).map((r) => ({ id: r.id, name: r.name }));
  const view = (g: { id: string; name: string; description: string | null; checks: string; created_by: string | null; created_at: number; updated_at: number }) => ({
    id: g.id,
    name: g.name,
    description: g.description,
    checks: JSON.parse(g.checks) as GuardrailChecks,
    created_by: g.created_by,
    created_at: g.created_at,
    updated_at: g.updated_at,
    used_by: usedBy(g.id),
  });

  app.get('/admin/api/guardrails', { preHandler: guard }, async () => {
    const rows = await ctx.db.read.selectFrom('guardrails').selectAll().orderBy('name').execute();
    return { guardrails: rows.map(view) };
  });

  app.post('/admin/api/guardrails', { preHandler: guard }, async (req, reply) => {
    const b = (req.body ?? {}) as { name?: string; description?: string | null; checks?: GuardrailChecks };
    const problem = guardrailProblem(b);
    if (problem) return bad(reply, problem);
    const name = b.name!.trim();
    if (await ctx.db.read.selectFrom('guardrails').select('id').where('name', '=', name).executeTakeFirst()) return reply.status(409).send({ error: { code: 'exists', message: `There's already a guardrail named "${name}".` } });
    const id = `gr_${ulid()}`;
    const now = Date.now();
    await ctx.db.write
      .insertInto('guardrails')
      .values({ id, name, description: b.description?.trim() || null, checks: JSON.stringify(tidyChecks(b.checks!)), created_by: req.admin?.email ?? null, created_at: now, updated_at: now })
      .execute();
    await policy.reload();
    const row = (await ctx.db.read.selectFrom('guardrails').selectAll().where('id', '=', id).executeTakeFirst())!;
    return reply.status(201).send({ guardrail: view(row) });
  });

  app.patch('/admin/api/guardrails/:id', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const cur = await ctx.db.read.selectFrom('guardrails').selectAll().where('id', '=', id).executeTakeFirst();
    if (!cur) return reply.status(404).send({ error: { code: 'not_found', message: 'guardrail not found' } });
    const b = (req.body ?? {}) as { name?: string; description?: string | null; checks?: GuardrailChecks };
    const next = { name: b.name ?? cur.name, description: b.description === undefined ? cur.description : b.description, checks: b.checks ?? (JSON.parse(cur.checks) as GuardrailChecks) };
    const problem = guardrailProblem(next);
    if (problem) return bad(reply, problem);
    const name = next.name.trim();
    const clash = await ctx.db.read.selectFrom('guardrails').select('id').where('name', '=', name).where('id', '!=', id).executeTakeFirst();
    if (clash) return reply.status(409).send({ error: { code: 'exists', message: `There's already a guardrail named "${name}".` } });
    await ctx.db.write
      .updateTable('guardrails')
      .set({ name, description: next.description?.trim() || null, checks: JSON.stringify(tidyChecks(next.checks)), updated_at: Date.now() })
      .where('id', '=', id)
      .execute();
    await policy.reload();
    return { guardrail: view((await ctx.db.read.selectFrom('guardrails').selectAll().where('id', '=', id).executeTakeFirst())!) };
  });

  app.delete('/admin/api/guardrails/:id', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const users = usedBy(id);
    if (users.length) return reply.status(409).send({ error: { code: 'in_use', message: `Gates still use this guardrail: ${users.map((u) => u.name).join(', ')}. Take it out of them first.` } });
    const r = await ctx.db.write.deleteFrom('guardrails').where('id', '=', id).executeTakeFirst();
    if (Number(r.numDeletedRows) === 0) return reply.status(404).send({ error: { code: 'not_found', message: 'guardrail not found' } });
    await policy.reload();
    return { ok: true };
  });

  // Try a guardrail on some text: a saved one, or checks not saved yet. What it finds, the text as a masking gate
  // would pass it on, and a policy's verdict.
  app.post('/admin/api/guardrails/test', { preHandler: guard }, async (req, reply) => {
    const b = (req.body ?? {}) as { id?: string; checks?: GuardrailChecks; name?: string; text?: string };
    const text = typeof b.text === 'string' ? b.text.slice(0, 20_000) : '';
    if (!text.trim()) return bad(reply, 'Give some text to try it on.');
    let cfg: InspectConfig;
    let name: string;
    if (b.id) {
      const g = policy.guardrails.get(b.id);
      if (!g) return reply.status(404).send({ error: { code: 'not_found', message: 'guardrail not found' } });
      cfg = withGuardrails({ guardrails: [b.id] }, policy.guardrails);
      name = g.name;
    } else {
      name = b.name?.trim() || 'draft';
      const problem = guardrailProblem({ name, checks: b.checks });
      if (problem) return bad(reply, problem);
      cfg = withGuardrails({ guardrails: ['draft'] }, new Map([['draft', { id: 'draft', name, description: null, checks: tidyChecks(b.checks!) }]]));
    }
    const config: InspectConfig = { ...cfg, action: 'mask', direction: 'both' };
    const gate = { rule: { id: 'try', name, config }, compiled: compileInspector(config) };
    const r = await inspect(ctx, undefined, [gate], 'input', { text });
    const findings = new Map<string, number>();
    for (const o of r.outcomes) for (const [k, n] of Object.entries(o.findings)) findings.set(k, (findings.get(k) ?? 0) + n);
    return {
      text,
      found: [...findings].map(([id, count]) => ({ id, label: describeFindings({ [id]: 1 }), count })),
      masked: (r.value as { text?: string }).text ?? text,
      // A policy can't be masked word by word: what it finds withholds the text.
      withheld: !!r.blocked,
      reasons: r.outcomes.map((o) => o.reason).filter((x): x is string => !!x),
    };
  });
}
