// Control Tower Enterprise — Elastic License 2.0 (see ee/LICENSE).
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import { auditOrigin, requireAdmin } from '../../admin/auth.js';
import { requireEnterprise } from './license.js';
import { FRAMEWORKS, digest, evidenceMarkdown, frameworkById, frameworkReport, runChecks } from '../compliance.js';

/**
 * Compliance (Enterprise): the frameworks, each requirement's status from this installation's data, and the evidence
 * pack. GET /admin/api/compliance?framework=&days= ; GET /admin/api/compliance/evidence?framework=&days=&format=md|json
 */
export async function complianceRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const guard = [requireAdmin(ctx), requireEnterprise(ctx, 'compliance')];
  const params = (q: { framework?: string; days?: string }) => ({
    framework: frameworkById(q.framework ?? 'eu-ai-act'),
    days: Math.min(365, Math.max(1, Math.round(Number(q.days ?? 90)) || 90)),
  });

  app.get('/admin/api/compliance', { preHandler: guard }, async (req, reply) => {
    const { framework, days } = params(req.query as { framework?: string; days?: string });
    if (!framework) return reply.status(400).send({ error: { code: 'invalid', message: `Choose a framework: ${FRAMEWORKS.map((f) => f.id).join(', ')}.` } });
    const { checks, evidence } = await runChecks(ctx, days);
    return { demo: evidence.demo, frameworks: FRAMEWORKS.map((f) => ({ id: f.id, name: f.name, version: f.version })), report: frameworkReport(framework, checks, days, ctx.config.version), checks: Object.values(checks) };
  });

  app.get('/admin/api/compliance/evidence', { preHandler: guard }, async (req, reply) => {
    const q = req.query as { framework?: string; days?: string; format?: string };
    const { framework, days } = params(q);
    if (!framework) return reply.status(400).send({ error: { code: 'invalid', message: `Choose a framework: ${FRAMEWORKS.map((f) => f.id).join(', ')}.` } });
    const { checks, evidence } = await runChecks(ctx, days);
    const report = frameworkReport(framework, checks, days, ctx.config.version);
    const by = req.admin?.email ?? 'the admin key';
    const json = q.format === 'json';
    const body = json ? `${JSON.stringify({ report, checks: Object.values(checks), evidence }, null, 2)}\n` : evidenceMarkdown(report, evidence, by);
    const sha256 = digest(body);
    // On record: who took which pack, and its digest (a copy handed to an auditor can be checked against it).
    await ctx.audit?.record({
      action: 'compliance.evidence_exported',
      outcome: 'success',
      actor: req.admin && req.admin.adminId !== 'admin-key' ? { type: 'person', id: req.admin.adminId, email: req.admin.email, role: req.admin.role } : { type: 'admin_key' },
      status: 200,
      detail: { framework: framework.id, days, format: json ? 'json' : 'md', sha256, summary: report.summary },
      ...auditOrigin(req),
    });
    const name = `controltower-${framework.id}-evidence-${report.generated_at.slice(0, 10)}.${json ? 'json' : 'md'}`;
    return reply
      .header('content-type', json ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8')
      .header('content-disposition', `attachment; filename="${name}"`)
      .header('x-ct-sha256', sha256)
      .send(body);
  });
}
