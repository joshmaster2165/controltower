import type { FastifyInstance } from 'fastify';
import { ulid } from 'ulid';
import type { AppContext } from '../context.js';
import { requireAdmin } from './auth.js';
import { EXPORT_KINDS, SECRET_FIELDS, configProblem, targetHint, type ExportConfig, type ExportKind } from '../exports/destinations.js';

/**
 * Where flight records go: OpenTelemetry, Datadog, Splunk, S3, webhooks. Secrets (API keys, tokens, S3
 * secret keys, header values) are stored encrypted and never returned — only whether each is set.
 */
export async function exportDestinationRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const guard = requireAdmin(ctx);
  const bad = (reply: import('fastify').FastifyReply, message: string) => reply.status(400).send({ error: { code: 'invalid', message } });
  const exporter = ctx.exporter!;

  const publicConfig = (c: ExportConfig) => {
    const out: Record<string, unknown> = {};
    const secrets: string[] = [];
    for (const [k, v] of Object.entries(c)) {
      if ((SECRET_FIELDS as readonly string[]).includes(k)) {
        if (v && (typeof v !== 'object' || Object.keys(v).length)) secrets.push(k === 'headers' ? `headers: ${Object.keys(v as object).join(', ')}` : k);
      } else out[k] = v;
    }
    return { config: out, secrets_set: secrets };
  };

  app.get('/admin/api/exports', { preHandler: guard }, async () => {
    const rows = await ctx.db.read.selectFrom('export_destinations').selectAll().orderBy('created_at').execute();
    return {
      kinds: EXPORT_KINDS,
      destinations: rows.map((r) => {
        const live = exporter.stats(r.id);
        const cfg = exporter.configOf(r.id);
        return {
          id: r.id,
          name: r.name,
          kind: r.kind,
          enabled: r.enabled === 1,
          target_hint: r.target_hint,
          ...(cfg ? publicConfig(cfg.config) : { config: {}, secrets_set: [] }),
          queued: live?.queued ?? 0,
          sent: live?.sent ?? r.sent_count,
          dropped: live?.dropped ?? r.dropped_count,
          last_status: live?.last_status ?? r.last_status,
          last_error: live?.last_error ?? r.last_error,
          last_sent_at: live?.last_sent_at ?? r.last_sent_at,
          created_at: r.created_at,
        };
      }),
    };
  });

  app.post('/admin/api/exports', { preHandler: guard }, async (req, reply) => {
    const b = (req.body ?? {}) as { name?: string; kind?: string; config?: ExportConfig };
    const kind = b.kind as ExportKind;
    if (!(EXPORT_KINDS as readonly string[]).includes(kind)) return bad(reply, `kind must be one of ${EXPORT_KINDS.join(', ')}`);
    const config = (b.config ?? {}) as ExportConfig;
    const problem = configProblem(kind, config);
    if (problem) return bad(reply, problem);
    const id = ulid();
    const now = Date.now();
    await ctx.db.write
      .insertInto('export_destinations')
      .values({ id, name: (b.name ?? '').trim().slice(0, 120) || kind, kind, config_enc: exporter.encryptConfig(id, config), target_hint: targetHint(kind, config), enabled: 1, last_status: null, last_error: null, last_sent_at: null, sent_count: 0, dropped_count: 0, created_at: now, updated_at: now })
      .execute();
    await exporter.reload();
    ctx.log.info({ destination: id, kind, by: req.admin?.email }, 'export destination added');
    return reply.status(201).send({ id });
  });

  app.patch('/admin/api/exports/:id', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const cur = exporter.configOf(id);
    const row = await ctx.db.read.selectFrom('export_destinations').select(['kind']).where('id', '=', id).executeTakeFirst();
    if (!row || !cur) return reply.status(404).send({ error: { code: 'not_found', message: 'export destination not found' } });
    const b = (req.body ?? {}) as { name?: string; enabled?: boolean; config?: ExportConfig };
    const patch: Record<string, unknown> = { updated_at: Date.now() };
    if (typeof b.name === 'string' && b.name.trim()) patch.name = b.name.trim().slice(0, 120);
    if (typeof b.enabled === 'boolean') patch.enabled = b.enabled ? 1 : 0;
    if (b.config) {
      // Secrets left out keep their stored values.
      const merged = { ...cur.config, ...Object.fromEntries(Object.entries(b.config).filter(([k, v]) => !((SECRET_FIELDS as readonly string[]).includes(k) && (v === '' || v === undefined)))) } as ExportConfig;
      const problem = configProblem(row.kind as ExportKind, merged);
      if (problem) return bad(reply, problem);
      patch.config_enc = exporter.encryptConfig(id, merged);
      patch.target_hint = targetHint(row.kind as ExportKind, merged);
    }
    await ctx.db.write.updateTable('export_destinations').set(patch).where('id', '=', id).execute();
    await exporter.reload();
    return { ok: true };
  });

  app.delete('/admin/api/exports/:id', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const r = await ctx.db.write.deleteFrom('export_destinations').where('id', '=', id).executeTakeFirst();
    if (Number(r.numDeletedRows) === 0) return reply.status(404).send({ error: { code: 'not_found', message: 'export destination not found' } });
    await exporter.reload();
    return { ok: true };
  });

  // Send an example record: to a stored destination, or to settings not saved yet.
  app.post('/admin/api/exports/test', { preHandler: guard }, async (req, reply) => {
    const b = (req.body ?? {}) as { id?: string; kind?: string; config?: ExportConfig };
    let kind: ExportKind;
    let config: ExportConfig;
    if (b.id) {
      const cur = exporter.configOf(b.id);
      if (!cur) return reply.status(404).send({ error: { code: 'not_found', message: 'export destination not found' } });
      kind = cur.kind;
      config = { ...cur.config, ...(b.config ?? {}) };
    } else {
      kind = b.kind as ExportKind;
      if (!(EXPORT_KINDS as readonly string[]).includes(kind)) return bad(reply, `kind must be one of ${EXPORT_KINDS.join(', ')}`);
      config = b.config ?? {};
    }
    const problem = configProblem(kind, config);
    if (problem) return bad(reply, problem);
    try {
      await exporter.test(kind, config);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // Send what is waiting now.
  app.post('/admin/api/exports/:id/flush', { preHandler: guard }, async (req) => {
    const id = (req.params as { id: string }).id;
    await exporter.drain(id);
    return exporter.stats(id) ?? { queued: 0 };
  });
}
