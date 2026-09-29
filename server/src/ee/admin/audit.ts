import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import { publicEvent, type AuditEvent } from '../audit.js';
import { requireAdmin } from '../../admin/auth.js';
import { requireEnterprise } from './license.js';

const num = (v: unknown): number | undefined => (v === undefined || v === '' || Number.isNaN(Number(v)) ? undefined : Number(v));
const time = (v: unknown): number | undefined => {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isNaN(n)) return n;
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? undefined : t;
};

const CSV_COLUMNS = ['seq', 'time', 'actor_type', 'actor_email', 'actor_role', 'action', 'outcome', 'status', 'target_type', 'target_id', 'ip', 'request_id', 'detail', 'hash'] as const;
/** A CSV cell. A leading =, +, - or @ is defused so spreadsheets don't run it as a formula. */
function cell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function csvRow(e: AuditEvent): string {
  const p = publicEvent(e);
  const actor = p.actor as Record<string, unknown>;
  const target = (p.target ?? {}) as Record<string, unknown>;
  const values: Record<(typeof CSV_COLUMNS)[number], unknown> = {
    seq: p.seq, time: p.time, actor_type: actor.type, actor_email: actor.email, actor_role: actor.role, action: p.action, outcome: p.outcome, status: p.status,
    target_type: target.type, target_id: target.id, ip: p.ip, request_id: p.request_id, detail: p.detail === null ? '' : JSON.stringify(p.detail), hash: p.hash,
  };
  return CSV_COLUMNS.map((c) => cell(values[c])).join(',');
}

/** The audit log, for admins: browse it, export it, check nothing in it was changed. */
export async function auditRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const guard = [requireAdmin(ctx), requireEnterprise(ctx, 'audit')];
  const audit = ctx.audit;
  if (!audit) return;

  app.get('/admin/api/audit', { preHandler: guard }, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const rows = await audit.query({ since: time(q.since), until: time(q.until), actor: q.actor || undefined, action: q.action || undefined, outcome: q.outcome || undefined, before: num(q.before), limit: num(q.limit) });
    return { events: rows.map(publicEvent), next: rows.length ? Number(rows[rows.length - 1]!.seq) : null };
  });

  app.get('/admin/api/audit/export', { preHandler: guard }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const format = q.format === 'csv' ? 'csv' : 'jsonl';
    const range = { since: time(q.since), until: time(q.until) };
    const stamp = new Date().toISOString().slice(0, 10);
    async function* lines(): AsyncGenerator<string> {
      if (format === 'csv') yield `${CSV_COLUMNS.join(',')}\n`;
      for await (const e of audit!.stream(range)) yield format === 'csv' ? `${csvRow(e)}\n` : `${JSON.stringify(publicEvent(e))}\n`;
    }
    reply
      .header('content-type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson')
      .header('content-disposition', `attachment; filename="controltower-audit-${stamp}.${format === 'csv' ? 'csv' : 'jsonl'}"`)
      .header('cache-control', 'no-store');
    return reply.send(Readable.from(lines()));
  });

  app.get('/admin/api/audit/verify', { preHandler: guard }, async () => audit.verify());
}
