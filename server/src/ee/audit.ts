import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { ulid } from 'ulid';
import type { Db } from '../db/index.js';
import type { AuditEventsTable } from '../db/schema.js';
import { scrub } from '../providers/adapter.js';

/**
 * The audit log: who changed what in Control Tower, and who tried and was refused. Every change through the
 * admin API (by a person or the admin key), sign-ins, sign-outs, setup, password changes and single sign-on
 * are recorded, with the request's secrets removed.
 *
 * Each event stores the hash of the one before it, so an edited, inserted or deleted row breaks the chain
 * and `verify()` names where. Events are numbered in one sequence across every instance sharing a database.
 */

export type AuditOutcome = 'success' | 'denied' | 'failure';
export interface AuditActor {
  type: 'person' | 'admin_key' | 'anonymous' | 'system' | 'scim';
  id?: string | undefined;
  email?: string | undefined;
  role?: string | undefined;
}
export interface AuditInput {
  action: string;
  outcome: AuditOutcome;
  actor: AuditActor;
  status?: number | undefined;
  target?: { type?: string | undefined; id?: string | undefined } | undefined;
  detail?: Record<string, unknown> | undefined;
  ip?: string | undefined;
  userAgent?: string | undefined;
  requestId?: string | undefined;
}
export type AuditEvent = AuditEventsTable;

/** The chain starts from this. */
export const GENESIS = '0'.repeat(64);
/** Held while numbering an event on Postgres, so instances writing at once can't fork the chain. */
const PG_LOCK = 7_240_001;
const MAX_DETAIL = 8 * 1024;

/** Field names whose values are never recorded. */
const SECRET_FIELD = /(pass(word|wd)?|secret|token|api[_-]?key|credential|private|auth|cookie|webhook|signature|session|service[_-]?account|^current$|^key$)/i;
/** A PEM private key anywhere in a value (a service account key pasted as JSON, say). */
const PEM_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g;

/** A request body as it may be recorded: secret fields replaced, secrets inside strings scrubbed, bounded. */
export function redact(v: unknown, depth = 0): unknown {
  if (depth > 6) return '…';
  if (typeof v === 'string') return scrub(v.replace(PEM_KEY, '[private key]').replace(/(\w+:\/\/)[^\s/@]+@/g, '$1***@')).slice(0, 500);
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redact(x, depth + 1));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 100)) {
      out[k] = SECRET_FIELD.test(k) && x !== null && x !== undefined && x !== '' && typeof x !== 'boolean' ? '[redacted]' : redact(x, depth + 1);
    }
    return out;
  }
  return v;
}

const VERB: Record<string, string> = { POST: 'create', PUT: 'update', PATCH: 'update', DELETE: 'delete' };
/** Routes whose generic name would mislead. */
const NAMED: Record<string, string> = {
  'POST /admin/api/me/password': 'me.password.change',
  'POST /admin/api/demo': 'demo.start',
  'DELETE /admin/api/demo': 'demo.stop',
};
/**
 * A readable action for an admin route: `POST /admin/api/keys` → keys.create,
 * `POST /admin/api/approvals/:id/decide` → approvals.decide, `PUT /admin/api/airspace/layout` → airspace.layout.update.
 */
export function actionFor(method: string, route: string): string {
  const named = NAMED[`${method} ${route}`];
  if (named) return named;
  const parts = route.replace(/^\/admin\/api\//, '').replace(/^\//, '').split('/').filter((p) => p && !p.startsWith(':'));
  const last = parts[parts.length - 1] ?? '';
  const trailingVerb = /^(decide|revoke|test|bulk|import|simulate|check|rotate|refresh|start|stop|reset|verify|generate|delete|update|new|block|unblock|regenerate|info)$/.test(last);
  const name = parts.map((p) => p.replace(/-/g, '_')).join('.');
  if (trailingVerb && parts.length > 1) return name;
  return `${name || 'root'}.${VERB[method] ?? method.toLowerCase()}`;
}

function hashOf(e: Omit<AuditEvent, 'hash'>): string {
  const body = JSON.stringify([e.seq, e.id, e.ts, e.actor_type, e.actor_id, e.actor_email, e.actor_role, e.action, e.outcome, e.status, e.target_type, e.target_id, e.detail, e.ip, e.user_agent, e.request_id, e.prev_hash]);
  return createHash('sha256').update(body).digest('hex');
}

export interface AuditQuery {
  since?: number | undefined;
  until?: number | undefined;
  actor?: string | undefined;
  action?: string | undefined;
  outcome?: string | undefined;
  /** Events before this sequence number (paging backwards from the newest). */
  before?: number | undefined;
  limit?: number | undefined;
}

export class AuditLog {
  /** `enabled`: whether the audit log is on (it is an Enterprise feature). Nothing is recorded while it's off. */
  constructor(private readonly db: Db, private readonly log?: { warn(o: object, m: string): void }, private readonly enabled: () => boolean = () => true) {}

  /** Record an event. Never throws: an audit failure is logged, and the request it describes goes on. */
  async record(e: AuditInput): Promise<void> {
    if (!this.enabled()) return;
    try {
      await this.write(e);
    } catch (err) {
      this.log?.warn({ err: (err as Error).message, action: e.action }, 'audit event not recorded');
    }
  }

  private async write(e: AuditInput): Promise<void> {
    let detail: string | null = null;
    if (e.detail) {
      detail = JSON.stringify(redact(e.detail));
      if (detail.length > MAX_DETAIL) detail = JSON.stringify({ truncated: true, head: detail.slice(0, MAX_DETAIL) });
    }
    const base = {
      id: ulid(),
      ts: Date.now(),
      actor_type: e.actor.type,
      actor_id: e.actor.id ?? null,
      actor_email: e.actor.email ?? null,
      actor_role: e.actor.role ?? null,
      action: e.action,
      outcome: e.outcome,
      status: e.status ?? null,
      target_type: e.target?.type ?? null,
      target_id: e.target?.id ?? null,
      detail,
      ip: e.ip ?? null,
      user_agent: e.userAgent ? e.userAgent.slice(0, 300) : null,
      request_id: e.requestId ?? null,
    };
    await this.db.write.transaction().execute(async (trx) => {
      if (this.db.dialect === 'postgres') await sql`SELECT pg_advisory_xact_lock(${PG_LOCK})`.execute(trx);
      const last = await trx.selectFrom('audit_events').select(['seq', 'hash']).orderBy('seq', 'desc').limit(1).executeTakeFirst();
      const row = { ...base, seq: Number(last?.seq ?? 0) + 1, prev_hash: last?.hash ?? GENESIS };
      await trx.insertInto('audit_events').values({ ...row, hash: hashOf(row) }).execute();
    });
  }

  async query(q: AuditQuery): Promise<AuditEvent[]> {
    let s = this.db.read.selectFrom('audit_events').selectAll();
    if (q.since) s = s.where('ts', '>=', q.since);
    if (q.until) s = s.where('ts', '<', q.until);
    if (q.before) s = s.where('seq', '<', q.before);
    if (q.actor) s = s.where('actor_email', '=', q.actor.toLowerCase());
    if (q.action) s = s.where('action', 'like', `${q.action.replace(/[%_]/g, '')}%`);
    if (q.outcome) s = s.where('outcome', '=', q.outcome);
    return s.orderBy('seq', 'desc').limit(Math.min(Math.max(q.limit ?? 100, 1), 1000)).execute();
  }

  /** Every event from `since` on, oldest first, a page at a time (for exports). */
  async *stream(q: { since?: number | undefined; until?: number | undefined }): AsyncGenerator<AuditEvent> {
    let after = 0;
    for (;;) {
      let s = this.db.read.selectFrom('audit_events').selectAll().where('seq', '>', after);
      if (q.since) s = s.where('ts', '>=', q.since);
      if (q.until) s = s.where('ts', '<', q.until);
      const rows = await s.orderBy('seq').limit(1000).execute();
      for (const r of rows) yield r;
      if (rows.length < 1000) return;
      after = Number(rows[rows.length - 1]!.seq);
    }
  }

  /**
   * Walk the chain: every event's hash matches its contents, points at the one before it, and the numbers
   * have no gaps. The oldest event kept (older ones leave with retention) is taken as given.
   */
  async verify(): Promise<{ ok: boolean; events: number; first_seq: number | null; last_seq: number | null; broken_at?: number; reason?: string }> {
    let prev: { seq: number; hash: string } | undefined;
    let events = 0;
    let first: number | null = null;
    for await (const e of this.stream({})) {
      const seq = Number(e.seq);
      if (first === null) first = seq;
      events++;
      const { hash, ...rest } = e;
      if (hashOf({ ...rest, seq, ts: Number(e.ts), status: e.status === null ? null : Number(e.status) }) !== hash) return { ok: false, events, first_seq: first, last_seq: seq, broken_at: seq, reason: 'the event was changed after it was recorded' };
      if (prev) {
        if (seq !== prev.seq + 1) return { ok: false, events, first_seq: first, last_seq: seq, broken_at: prev.seq + 1, reason: `events ${prev.seq + 1}–${seq - 1} are missing` };
        if (e.prev_hash !== prev.hash) return { ok: false, events, first_seq: first, last_seq: seq, broken_at: seq, reason: 'the event does not follow the one before it' };
      }
      prev = { seq, hash };
    }
    return { ok: true, events, first_seq: first, last_seq: prev?.seq ?? null };
  }
}

/** An event as the API and exports give it. */
export function publicEvent(e: AuditEvent): Record<string, unknown> {
  let detail: unknown = null;
  try {
    detail = e.detail ? JSON.parse(e.detail) : null;
  } catch {
    detail = e.detail;
  }
  return {
    seq: Number(e.seq),
    id: e.id,
    time: new Date(Number(e.ts)).toISOString(),
    actor: { type: e.actor_type, id: e.actor_id, email: e.actor_email, role: e.actor_role },
    action: e.action,
    outcome: e.outcome,
    status: e.status === null ? null : Number(e.status),
    target: e.target_type || e.target_id ? { type: e.target_type, id: e.target_id } : null,
    detail,
    ip: e.ip,
    user_agent: e.user_agent,
    request_id: e.request_id,
    prev_hash: e.prev_hash,
    hash: e.hash,
  };
}
