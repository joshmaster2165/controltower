import { sql } from 'kysely';
import type { Db } from '../db/index.js';
import type { AuditEvent } from './audit.js';
import { publicEvent } from './audit.js';
import { attrs, nanos, post, postSigned, putS3, resource, type ExportConfig, type ExportKind } from '../exports/destinations.js';

/**
 * The audit log, sent to a SIEM: Splunk, Datadog, an OpenTelemetry collector, an S3 bucket or any webhook.
 *
 * Shipping reads from the audit log itself, not from a queue in memory. Each destination keeps the number of
 * the last event it received, so a restart, a deploy or a SIEM that's down for a day loses nothing: sending
 * picks up where it stopped, in order, with each event's chain hash so the SIEM can check nothing is missing.
 * Delivery is at least once: an event can arrive twice (a crash between sending and saving the position), never
 * out of order and never skipped, except for events retention removed before they could be sent, which are
 * counted and reported.
 *
 * With several instances on one database, one sends for each destination: it holds a lease that it renews
 * while sending, and another instance takes over when it lapses.
 */
const BATCH = 500;
const TICK_MS = 2_000;
const LEASE_MS = 30_000;
/** Most batches one destination sends per tick, so a long backlog doesn't hold up the others. */
const BATCHES_PER_TICK = 20;
const BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000];

export interface AuditDestination {
  id: string;
  name: string;
  kind: ExportKind;
  config: ExportConfig;
}
export interface AuditExportState {
  last_seq: number;
  /** Events recorded that this destination hasn't received yet. */
  behind: number;
  sent: number;
  skipped: number;
  last_status: string | null;
  last_error: string | null;
  last_sent_at: number | null;
}

export class AuditShipper {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private failures = new Map<string, { count: number; retryAt: number }>();
  private busy = new Set<string>();

  constructor(
    private readonly deps: {
      db: Db;
      /** Destinations set to receive the audit log (the exporter's, kept in step across instances). */
      destinations: () => AuditDestination[];
      /** Whether the license includes it; nothing is sent while it doesn't. */
      allowed: () => boolean;
      instanceId: string;
      version: string;
      log: () => { warn(o: object, m: string): void };
    },
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  /** Stop, and let another instance take over at once. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.deps.db.write.updateTable('audit_exports').set({ lease_owner: null, lease_until: 0 }).where('lease_owner', '=', this.deps.instanceId).execute().catch(() => undefined);
  }

  /**
   * Start sending the audit log to a destination: from the next event (`from: 'now'`), or from the oldest event
   * still kept (`'start'`). Called when a destination is set to receive it; leaves an existing position alone.
   */
  async begin(id: string, from: 'now' | 'start'): Promise<void> {
    const w = this.deps.db.write;
    const edge = await w.selectFrom('audit_events').select((eb) => [eb.fn.min('seq').as('first'), eb.fn.max('seq').as('last')]).executeTakeFirst();
    const lastSeq = from === 'start' ? Math.max(0, Number(edge?.first ?? 1) - 1) : Number(edge?.last ?? 0);
    const exists = await w.selectFrom('audit_exports').select('destination_id').where('destination_id', '=', id).executeTakeFirst();
    if (exists) return;
    await w.insertInto('audit_exports').values({ destination_id: id, last_seq: lastSeq, sent_count: 0, skipped_count: 0, last_status: null, last_error: null, last_sent_at: null, lease_owner: null, lease_until: 0 }).execute();
  }

  /** Forget a destination's position (it was deleted). */
  async forget(id: string): Promise<void> {
    await this.deps.db.write.deleteFrom('audit_exports').where('destination_id', '=', id).execute();
    this.failures.delete(id);
  }

  /** Where each destination has got to, for the console. */
  async states(): Promise<Map<string, AuditExportState>> {
    const r = this.deps.db.read;
    const rows = await r.selectFrom('audit_exports').selectAll().execute();
    const last = Number((await r.selectFrom('audit_events').select((eb) => eb.fn.max('seq').as('last')).executeTakeFirst())?.last ?? 0);
    return new Map(
      rows.map((s) => [
        s.destination_id,
        { last_seq: Number(s.last_seq), behind: Math.max(0, last - Number(s.last_seq)), sent: Number(s.sent_count), skipped: Number(s.skipped_count), last_status: s.last_status, last_error: s.last_error, last_sent_at: s.last_sent_at === null ? null : Number(s.last_sent_at) },
      ]),
    );
  }

  /** Send everything waiting for one destination now (for tests and "Send now"), even if it was backing off. */
  async drain(id: string): Promise<void> {
    const d = this.deps.destinations().find((x) => x.id === id);
    if (!d || !this.deps.allowed()) return;
    this.failures.delete(id);
    // A background send already under way finishes first; then this one sends whatever is left.
    for (let i = 0; this.busy.has(id) && i < 1500; i++) await new Promise((r) => setTimeout(r, 20));
    await this.ship(d, Number.MAX_SAFE_INTEGER);
  }

  /** Send one example event, to check a destination's settings. */
  async test(kind: ExportKind, config: ExportConfig): Promise<void> {
    const now = Date.now();
    await deliverAudit(kind, config, [{ seq: 0, id: `test_${now.toString(36)}`, time: new Date(now).toISOString(), actor: { type: 'system', id: null, email: null, role: null }, action: 'audit.test', outcome: 'success', status: null, target: null, detail: { message: 'A test event from Control Tower' }, ip: null, user_agent: null, request_id: null, prev_hash: null, hash: null }], { version: this.deps.version });
  }

  async tick(): Promise<void> {
    if (this.running || !this.deps.allowed()) return;
    this.running = true;
    try {
      for (const d of this.deps.destinations()) {
        const f = this.failures.get(d.id);
        if (f && f.retryAt > Date.now()) continue;
        await this.ship(d, BATCHES_PER_TICK).catch((err: unknown) => this.deps.log().warn({ destination: d.name, err: (err as Error).message }, 'audit log export failed'));
      }
    } finally {
      this.running = false;
    }
  }

  /** Send up to `batches` batches to one destination, if this instance holds its lease. */
  private async ship(d: AuditDestination, batches: number): Promise<'done' | 'more' | 'failed' | 'not-mine'> {
    if (this.busy.has(d.id)) return 'not-mine';
    this.busy.add(d.id);
    try {
      for (let i = 0; i < batches; i++) {
        if (!(await this.lease(d.id))) return 'not-mine';
        const state = await this.deps.db.write.selectFrom('audit_exports').select(['last_seq']).where('destination_id', '=', d.id).executeTakeFirst();
        if (!state) return 'done';
        const from = Number(state.last_seq);
        const events = await this.deps.db.write.selectFrom('audit_events').selectAll().where('seq', '>', from).orderBy('seq').limit(BATCH).execute();
        if (!events.length) return 'done';
        // Events that retention removed before they were sent: counted, and the SIEM sees the gap in `seq`.
        const skipped = Number(events[0]!.seq) - from - 1;
        try {
          await deliverAudit(d.kind, d.config, events.map(publicEvent), { version: this.deps.version });
        } catch (err) {
          const count = (this.failures.get(d.id)?.count ?? 0) + 1;
          this.failures.set(d.id, { count, retryAt: Date.now() + BACKOFF_MS[Math.min(count - 1, BACKOFF_MS.length - 1)]! });
          await this.deps.db.write.updateTable('audit_exports').set({ last_status: 'error', last_error: (err as Error).message.slice(0, 500) }).where('destination_id', '=', d.id).execute();
          return 'failed';
        }
        this.failures.delete(d.id);
        const last = Number(events[events.length - 1]!.seq);
        await this.deps.db.write
          .updateTable('audit_exports')
          .set({ last_seq: last, sent_count: sql`sent_count + ${events.length}`, skipped_count: sql`skipped_count + ${Math.max(0, skipped)}`, last_status: 'ok', last_error: null, last_sent_at: Date.now() })
          .where('destination_id', '=', d.id)
          .where('last_seq', '=', from)
          .execute();
        if (events.length < BATCH) return 'done';
      }
      return 'more';
    } finally {
      this.busy.delete(d.id);
    }
  }

  /** Take or renew the lease on a destination; false while another instance holds it. */
  private async lease(id: string): Promise<boolean> {
    const now = Date.now();
    const r = await this.deps.db.write
      .updateTable('audit_exports')
      .set({ lease_owner: this.deps.instanceId, lease_until: now + LEASE_MS })
      .where('destination_id', '=', id)
      .where((eb) => eb.or([eb('lease_owner', 'is', null), eb('lease_owner', '=', this.deps.instanceId), eb('lease_until', '<', now)]))
      .executeTakeFirst();
    return Number(r.numUpdatedRows) > 0;
  }
}

type PublicAuditEvent = ReturnType<typeof publicEvent>;
interface AuditShape {
  seq: number;
  time: string;
  actor: { type: string; id: string | null; email: string | null; role: string | null };
  action: string;
  outcome: string;
  status: number | null;
  target: { type: string | null; id: string | null } | null;
  ip: string | null;
  user_agent: string | null;
  request_id: string | null;
  hash: string | null;
}
const shape = (e: PublicAuditEvent) => e as unknown as AuditShape;

/** Who did it, in a few words: an email, "admin key", "SCIM", "someone not signed in". */
function who(e: AuditShape): string {
  if (e.actor.email) return e.actor.email;
  return e.actor.type === 'admin_key' ? 'admin key' : e.actor.type === 'anonymous' ? 'someone not signed in' : e.actor.type === 'scim' ? 'SCIM' : e.actor.type;
}
export const auditSummary = (e: AuditShape) => `${who(e)} ${e.action}: ${e.outcome}${e.status ? ` (${e.status})` : ''}`;

/** Send a batch of audit events in each destination's own format. Throws with a readable reason on refusal. */
export async function deliverAudit(kind: ExportKind, c: ExportConfig, events: PublicAuditEvent[], meta: { version: string }): Promise<void> {
  if (!events.length) return;
  switch (kind) {
    case 'otlp':
      // Audit events are log records, whatever the destination sends calls as.
      return post(`${c.endpoint!.replace(/\/+$/, '')}/v1/logs`, { 'content-type': 'application/json', ...(c.headers ?? {}) }, JSON.stringify(otlpAuditLogs(events, meta)));
    case 'datadog': {
      const site = (c.site ?? 'datadoghq.com').replace(/^https?:\/\//, '');
      // Datadog's reserved attributes: `status` is the log level, `usr`, `network.client.ip`, `http`, `evt` are standard.
      const body = events.map((raw) => {
        const e = shape(raw);
        const { status: _status, ip: _ip, user_agent: _ua, ...rest } = raw as Record<string, unknown>;
        return {
          ddsource: 'controltower',
          service: c.service ?? 'controltower',
          ...(c.ddtags ? { ddtags: c.ddtags } : {}),
          message: auditSummary(e),
          status: e.outcome === 'success' ? 'info' : e.outcome === 'denied' ? 'warn' : 'error',
          evt: { name: e.action, outcome: e.outcome, category: 'audit' },
          usr: { ...(e.actor.id ? { id: e.actor.id } : {}), ...(e.actor.email ? { email: e.actor.email } : {}), ...(e.actor.role ? { role: e.actor.role } : {}), type: e.actor.type },
          ...(e.ip ? { network: { client: { ip: e.ip } } } : {}),
          http: { ...(e.status ? { status_code: e.status } : {}), ...(e.user_agent ? { useragent: e.user_agent } : {}), ...(e.request_id ? { request_id: e.request_id } : {}) },
          audit: { ...rest, http_status: e.status },
        };
      });
      return post(`https://http-intake.logs.${site}/api/v2/logs`, { 'content-type': 'application/json', 'dd-api-key': c.api_key! }, JSON.stringify(body), c.endpoint);
    }
    case 'splunk': {
      const body = events
        .map((e) => JSON.stringify({ time: Date.parse(shape(e).time) / 1000, source: 'controltower', sourcetype: 'controltower:audit', ...((c.audit_index ?? c.index) ? { index: c.audit_index ?? c.index } : {}), event: e }))
        .join('\n');
      return post(`${c.url!.replace(/\/+$/, '')}/services/collector/event`, { 'content-type': 'application/json', authorization: `Splunk ${c.token}` }, body);
    }
    case 's3':
      return putS3(c, events.map((e) => JSON.stringify(e)), 'audit/');
    case 'webhook':
      return postSigned(c, JSON.stringify({ type: 'controltower.audit', count: events.length, events }));
  }
}

/** Audit events as OpenTelemetry log records: OpenTelemetry's user, client and HTTP attributes where they fit. */
export function otlpAuditLogs(events: PublicAuditEvent[], meta: { version: string }) {
  return {
    resourceLogs: [
      {
        resource: resource(meta),
        scopeLogs: [
          {
            scope: { name: 'controltower.audit', version: meta.version },
            logRecords: events.map((raw) => {
              const e = shape(raw);
              const t = Date.parse(e.time);
              return {
                timeUnixNano: nanos(t),
                observedTimeUnixNano: nanos(Date.now()),
                severityNumber: e.outcome === 'success' ? 9 : e.outcome === 'denied' ? 13 : 17,
                severityText: e.outcome === 'success' ? 'INFO' : e.outcome === 'denied' ? 'WARN' : 'ERROR',
                body: { stringValue: JSON.stringify(raw) },
                attributes: attrs({
                  'event.name': 'controltower.audit',
                  'controltower.audit.seq': e.seq,
                  'controltower.audit.action': e.action,
                  'controltower.audit.outcome': e.outcome,
                  'controltower.audit.actor_type': e.actor.type,
                  'controltower.audit.target_type': e.target?.type ?? undefined,
                  'controltower.audit.target_id': e.target?.id ?? undefined,
                  'controltower.audit.hash': e.hash ?? undefined,
                  'controltower.request_id': e.request_id ?? undefined,
                  'user.id': e.actor.id ?? undefined,
                  'user.email': e.actor.email ?? undefined,
                  'user.roles': e.actor.role ? [e.actor.role] : undefined,
                  'client.address': e.ip ?? undefined,
                  'user_agent.original': e.user_agent ?? undefined,
                  'http.response.status_code': e.status ?? undefined,
                }),
              };
            }),
          },
        ],
      },
    ],
  };
}

export type { AuditEvent };
