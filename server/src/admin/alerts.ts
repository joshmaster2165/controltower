import type { FastifyInstance, FastifyReply } from 'fastify';
import { ulid } from 'ulid';
import type { AppContext } from '../context.js';
import { requireAdmin } from './auth.js';
import type { PolicyService } from '../policy/policy.js';
import { ALERT_KINDS, KIND_TRIGGERS, targetHint, type AlertKind, type AlertParams, type AlertTrigger, type ChannelConfig, type ChannelKind } from '../alerts/alerts.js';
import { isEmail, type SmtpConfig } from '../alerts/email.js';

const bad = (reply: FastifyReply, message: string) => reply.status(400).send({ error: { code: 'invalid', message } });
const notFound = (reply: FastifyReply, what: string) => reply.status(404).send({ error: { code: 'not_found', message: `${what} not found` } });

/** Recipients and SMTP settings for an email channel; `cur` keeps what an update leaves out (the password above all). */
function emailConfig(b: { to?: unknown; smtp?: unknown }, cur: ChannelConfig | undefined, hasDefault: boolean): { config: ChannelConfig; hint: string } | string {
  const raw = b.to === undefined ? (cur?.to ?? []) : Array.isArray(b.to) ? b.to : String(b.to).split(/[,;\s]+/);
  const to = [...new Set(raw.map((x) => String(x).trim()).filter(Boolean))];
  if (!to.length) return 'at least one recipient is required';
  if (to.length > 20) return 'at most 20 recipients';
  const badTo = to.find((x) => !isEmail(x));
  if (badTo) return `"${badTo}" is not an email address`;
  let smtp: SmtpConfig | undefined = cur?.smtp;
  if (b.smtp === null) smtp = undefined;
  else if (b.smtp && typeof b.smtp === 'object') {
    const s = b.smtp as Partial<Record<keyof SmtpConfig, unknown>>;
    const host = typeof s.host === 'string' ? s.host.trim() : '';
    const from = typeof s.from === 'string' ? s.from.trim() : '';
    if (!host) return 'SMTP host is required';
    if (!from || !isEmail(from.replace(/^.*<([^>]+)>\s*$/, '$1'))) return 'SMTP "from" must be an email address (optionally "Name <address>")';
    const secure = s.secure === true;
    const port = Number(s.port) || (secure ? 465 : 587);
    if (port < 1 || port > 65535) return 'SMTP port must be 1–65535';
    const user = typeof s.user === 'string' && s.user.trim() ? s.user.trim() : undefined;
    const pass = typeof s.pass === 'string' && s.pass ? s.pass : user && cur?.smtp?.user === user ? cur.smtp.pass : undefined;
    smtp = { host, port, secure, user, pass, from };
  }
  if (!smtp && !hasDefault) return 'an SMTP server is required (or set CT_SMTP_URL on the server)';
  return { config: { to, smtp }, hint: `${to[0]}${to.length > 1 ? ` +${to.length - 1}` : ''}` };
}

function httpUrl(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  try {
    const u = new URL(s.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : dflt;
}

/** Alert rules on gates, notification channels, and the fired-alert inbox. */
export async function alertRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const guard = requireAdmin(ctx);
  const alerts = ctx.alerts;
  const policy = ctx.policy as PolicyService;

  // ---- inbox ----
  app.get('/admin/api/alerts', { preHandler: guard }, async (req) => {
    const q = req.query as { limit?: string; rule_id?: string };
    const limit = Math.min(200, Math.max(1, Number(q.limit ?? 50)));
    let qb = ctx.db.read.selectFrom('alerts').selectAll().orderBy('last_at', 'desc').limit(limit);
    if (q.rule_id) qb = qb.where('rule_id', '=', q.rule_id);
    const [rows, unread] = await Promise.all([
      qb.execute(),
      ctx.db.read.selectFrom('alerts').select((eb) => eb.fn.count<number>('id').as('n')).where('read_at', 'is', null).executeTakeFirst(),
    ]);
    return {
      alerts: rows.map((a) => ({
        id: a.id,
        alert_rule_id: a.alert_rule_id,
        rule_id: a.rule_id,
        trigger: a.trigger,
        title: a.title,
        detail: JSON.parse(a.detail) as unknown,
        count: a.count,
        first_at: a.first_at,
        last_at: a.last_at,
        deliveries: JSON.parse(a.deliveries) as unknown,
        read: a.read_at != null,
        demo: a.demo === 1,
      })),
      unread: Number(unread?.n ?? 0),
    };
  });

  app.post('/admin/api/alerts/read', { preHandler: guard }, async (req) => {
    const b = (req.body ?? {}) as { ids?: string[] };
    let qb = ctx.db.write.updateTable('alerts').set({ read_at: Date.now() }).where('read_at', 'is', null);
    if (Array.isArray(b.ids) && b.ids.length) qb = qb.where('id', 'in', b.ids.slice(0, 500));
    await qb.execute();
    ctx.alertsVersion.bump();
    return { ok: true };
  });

  // ---- rules ----
  /** Validates an alert-rule body; returns the column values or an error message. */
  const ruleBody = (b: Record<string, unknown>, partial: boolean): { v: Record<string, unknown> } | { error: string } => {
    const out: Record<string, unknown> = {};
    const kind = (b.kind ?? (partial ? undefined : 'gate')) as AlertKind | undefined;
    if (kind !== undefined) {
      if (!ALERT_KINDS.includes(kind)) return { error: `kind must be ${ALERT_KINDS.join(' | ')}` };
      out.kind = kind;
    }
    if ('params' in b || !partial) {
      const p = (b.params ?? {}) as AlertParams;
      const params: AlertParams = {};
      if (Array.isArray(p.targets)) params.targets = p.targets.filter((x): x is string => typeof x === 'string').slice(0, 200);
      if (p.slow_ms !== undefined) params.slow_ms = clampInt(p.slow_ms, 100, 3_600_000, 30_000);
      if (p.warn_pct !== undefined) params.warn_pct = clampInt(p.warn_pct, 1, 99, 80);
      if (p.hour !== undefined) params.hour = clampInt(p.hour, 0, 23, 8);
      out.params = JSON.stringify(params);
    }
    if ('rule_id' in b || !partial) {
      const rid = (b.rule_id as string | null | undefined) ?? null;
      if (rid && !policy.rules.some((r) => r.id === rid)) return { error: 'gate (rule_id) not found' };
      out.rule_id = rid;
    }
    if ('triggers' in b || !partial) {
      const allowed = KIND_TRIGGERS[kind ?? 'gate'];
      const t = Array.isArray(b.triggers) ? (b.triggers as unknown[]).filter((x): x is AlertTrigger => (allowed as readonly unknown[]).includes(x)) : [];
      if (!t.length) return { error: `pick at least one trigger: ${allowed.join(' | ')}` };
      out.triggers = JSON.stringify([...new Set(t)]);
    }
    if ('threshold' in b || !partial) out.threshold = clampInt(b.threshold, 1, 10_000, 1);
    if ('window_s' in b || !partial) out.window_s = clampInt(b.window_s, 10, 7 * 86_400, 300);
    if ('cooldown_s' in b || !partial) out.cooldown_s = clampInt(b.cooldown_s, 0, 7 * 86_400, 300);
    if ('channels' in b || !partial) {
      const ch = Array.isArray(b.channels) ? (b.channels as unknown[]).filter((x): x is string => typeof x === 'string') : [];
      if (ch.some((id) => !alerts.channelConfig(id))) return { error: 'unknown channel' };
      out.channels = JSON.stringify([...new Set(ch)]);
    }
    if (typeof b.enabled === 'boolean') out.enabled = b.enabled ? 1 : 0;
    if (typeof b.name === 'string' && b.name.trim()) out.name = b.name.trim().slice(0, 200);
    return { v: out };
  };

  app.get('/admin/api/alert-rules', { preHandler: guard }, async () => {
    const rows = await ctx.db.read.selectFrom('alert_rules').selectAll().orderBy('created_at', 'asc').execute();
    const counts = await ctx.db.read
      .selectFrom('alerts')
      .select(['alert_rule_id'])
      .select((eb) => eb.fn.count<number>('id').as('n'))
      .where('last_at', '>', Date.now() - 86_400_000)
      .groupBy('alert_rule_id')
      .execute();
    const n24 = new Map(counts.map((c) => [c.alert_rule_id, Number(c.n)]));
    return {
      rules: rows.map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind,
        params: JSON.parse(r.params || '{}') as AlertParams,
        rule_id: r.rule_id,
        gate_name: r.rule_id ? (policy.rules.find((x) => x.id === r.rule_id)?.name ?? null) : null,
        triggers: JSON.parse(r.triggers) as string[],
        threshold: r.threshold,
        window_s: r.window_s,
        cooldown_s: r.cooldown_s,
        channels: JSON.parse(r.channels) as string[],
        enabled: r.enabled === 1,
        demo: r.demo === 1,
        last_fired_at: r.last_fired_at,
        fired_24h: n24.get(r.id) ?? 0,
      })),
    };
  });

  app.post('/admin/api/alert-rules', { preHandler: guard }, async (req, reply) => {
    const r = ruleBody((req.body ?? {}) as Record<string, unknown>, false);
    if ('error' in r) return bad(reply, r.error);
    const v = r.v;
    const id = `alr_${ulid()}`;
    const now = Date.now();
    if (v.kind !== 'gate') v.rule_id = null;
    const gate = v.rule_id ? policy.rules.find((r) => r.id === v.rule_id) : undefined;
    const kindName: Record<string, string> = { health: 'Provider outage', errors: 'Failed requests', latency: 'Slow requests', budget: 'Budget', digest: 'Daily summary' };
    await ctx.db.write
      .insertInto('alert_rules')
      .values({
        id,
        name: (v.name as string | undefined) ?? (v.kind !== 'gate' ? (kindName[v.kind as string] ?? 'Alert') : gate ? `Alert on “${gate.name}”` : 'Alert on any gate'),
        kind: v.kind as string,
        params: v.params as string,
        rule_id: v.rule_id as string | null,
        triggers: v.triggers as string,
        threshold: v.threshold as number,
        window_s: v.window_s as number,
        cooldown_s: v.cooldown_s as number,
        channels: v.channels as string,
        enabled: (v.enabled as number | undefined) ?? 1,
        demo: 0,
        last_fired_at: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await alerts.reload();
    return reply.status(201).send({ id });
  });

  app.patch('/admin/api/alert-rules/:id', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const r = ruleBody((req.body ?? {}) as Record<string, unknown>, true);
    if ('error' in r) return bad(reply, r.error);
    const res = await ctx.db.write.updateTable('alert_rules').set({ ...r.v, updated_at: Date.now() }).where('id', '=', id).executeTakeFirst();
    if (Number(res.numUpdatedRows) === 0) return notFound(reply, 'alert rule');
    await alerts.reload();
    return { ok: true };
  });

  app.delete('/admin/api/alert-rules/:id', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const res = await ctx.db.write.deleteFrom('alert_rules').where('id', '=', id).executeTakeFirst();
    if (Number(res.numDeletedRows) === 0) return notFound(reply, 'alert rule');
    await alerts.reload();
    return { ok: true };
  });

  // ---- channels ----
  app.get('/admin/api/alert-channels', { preHandler: guard }, async () => {
    const rows = await ctx.db.read.selectFrom('alert_channels').selectAll().orderBy('created_at', 'asc').execute();
    return {
      channels: rows.map((c) => ({
        id: c.id,
        name: c.name,
        kind: c.kind,
        target_hint: c.target_hint,
        has_secret: !!alerts.channelConfig(c.id)?.secret,
        ...(c.kind === 'email'
          ? (() => {
              const cfg = alerts.channelConfig(c.id);
              const s = cfg?.smtp;
              return { to: cfg?.to ?? [], smtp: s ? { host: s.host, port: s.port, secure: s.secure, user: s.user ?? null, from: s.from, has_password: !!s.pass } : null };
            })()
          : {}),
        enabled: c.enabled === 1,
        last_status: c.last_status,
        last_error: c.last_error,
        last_sent_at: c.last_sent_at,
      })),
      smtp_default: alerts.hasDefaultSmtp,
    };
  });

  app.post('/admin/api/alert-channels', { preHandler: guard }, async (req, reply) => {
    const b = (req.body ?? {}) as { name?: string; kind?: string; url?: string; secret?: string; to?: unknown; smtp?: unknown };
    const kind = b.kind as ChannelKind;
    if (kind === 'email') {
      const e = emailConfig(b, undefined, alerts.hasDefaultSmtp);
      if (typeof e === 'string') return bad(reply, e);
      const id = `ach_${ulid()}`;
      const now = Date.now();
      await ctx.db.write
        .insertInto('alert_channels')
        .values({ id, name: ((b.name ?? '').trim() || 'Email').slice(0, 120), kind, config_enc: alerts.encryptConfig(id, e.config), target_hint: e.hint, enabled: 1, last_status: null, last_error: null, last_sent_at: null, created_at: now, updated_at: now })
        .execute();
      await alerts.reload();
      return reply.status(201).send({ id });
    }
    if (kind !== 'slack' && kind !== 'webhook') return bad(reply, 'kind must be slack | webhook | email');
    const url = httpUrl(b.url);
    if (!url) return bad(reply, 'a valid http(s) URL is required');
    const name = (b.name ?? '').trim() || (kind === 'slack' ? 'Slack' : 'Webhook');
    const id = `ach_${ulid()}`;
    const now = Date.now();
    const secret = kind === 'webhook' && b.secret?.trim() ? b.secret.trim() : undefined;
    await ctx.db.write
      .insertInto('alert_channels')
      .values({ id, name: name.slice(0, 120), kind, config_enc: alerts.encryptConfig(id, { url, secret }), target_hint: targetHint(url), enabled: 1, last_status: null, last_error: null, last_sent_at: null, created_at: now, updated_at: now })
      .execute();
    await alerts.reload();
    return reply.status(201).send({ id });
  });

  app.patch('/admin/api/alert-channels/:id', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const cur = alerts.channelConfig(id);
    if (!cur) return notFound(reply, 'channel');
    const b = (req.body ?? {}) as { name?: string; url?: string; secret?: string | null; enabled?: boolean; to?: unknown; smtp?: unknown };
    const patch: Record<string, unknown> = { updated_at: Date.now() };
    if (typeof b.name === 'string' && b.name.trim()) patch.name = b.name.trim().slice(0, 120);
    if (typeof b.enabled === 'boolean') patch.enabled = b.enabled ? 1 : 0;
    if (cur.to && (b.to !== undefined || b.smtp !== undefined)) {
      const e = emailConfig(b, cur, alerts.hasDefaultSmtp);
      if (typeof e === 'string') return bad(reply, e);
      patch.config_enc = alerts.encryptConfig(id, e.config);
      patch.target_hint = e.hint;
    } else if (!cur.to && (b.url !== undefined || b.secret !== undefined)) {
      const url = b.url !== undefined ? httpUrl(b.url) : cur.url;
      if (!url) return bad(reply, 'a valid http(s) URL is required');
      const secret = b.secret === null ? undefined : (b.secret?.trim() || cur.secret);
      patch.config_enc = alerts.encryptConfig(id, { url, secret });
      patch.target_hint = targetHint(url);
    }
    await ctx.db.write.updateTable('alert_channels').set(patch).where('id', '=', id).execute();
    await alerts.reload();
    return { ok: true };
  });

  app.delete('/admin/api/alert-channels/:id', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const res = await ctx.db.write.deleteFrom('alert_channels').where('id', '=', id).executeTakeFirst();
    if (Number(res.numDeletedRows) === 0) return notFound(reply, 'channel');
    // Detach it from every rule that pointed at it.
    const rules = await ctx.db.write.selectFrom('alert_rules').select(['id', 'channels']).execute();
    for (const r of rules) {
      const ch = JSON.parse(r.channels) as string[];
      if (ch.includes(id)) await ctx.db.write.updateTable('alert_rules').set({ channels: JSON.stringify(ch.filter((c) => c !== id)) }).where('id', '=', r.id).execute();
    }
    await alerts.reload();
    return { ok: true };
  });

  app.post('/admin/api/alert-channels/:id/test', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const d = await alerts.test(id);
    if (!d) return notFound(reply, 'channel');
    return d;
  });
}
