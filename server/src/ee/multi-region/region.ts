import { sql, type Kysely } from 'kysely';
import type { Db } from '../../db/index.js';
import { REPLICATED, SETTINGS_KEYS, verify } from './tables.js';

/**
 * A region of a multi-region deployment (Enterprise). It takes its configuration from the control plane and
 * serves its own calls: flights, spend and held calls stay here.
 *
 * Every few seconds it asks the control plane whether the configuration changed (sending how it is). A new
 * snapshot is checked — signed with this region's token, encrypted for this region's master key — and applied
 * in one transaction to this region's own database, where every part of Control Tower reads it as usual. So a
 * region keeps serving on the configuration it last received when the control plane can't be reached, even
 * after a restart; changes made meanwhile arrive when it can be reached again.
 */
type Row = Record<string, unknown>;
export interface Snapshot {
  etag: string;
  tables: Record<string, Row[]>;
  settings: Record<string, string>;
  master_key_id: string;
}
export interface RegionStatus {
  region: string;
  control_plane: string;
  applied_etag: string | null;
  applied_at: number | null;
  last_contact: number | null;
  error: string | null;
}

const APPLIED = 'region.applied_etag';
const APPLIED_AT = 'region.applied_at';
const PG_LOCK = 7_240_033;

export class RegionSync {
  private applied: string | undefined;
  private appliedAt: number | undefined;
  private lastContact: number | undefined;
  private error: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    private readonly deps: {
      db: Db;
      region: { name: string; controlPlaneUrl: string; token: string; pollMs: number };
      masterKeyId: string;
      version: string;
      instanceId: string;
      /** Reload everything that reads configuration, after a snapshot was applied (here or by another instance). */
      reload: () => Promise<void>;
      log: () => { info?(o: object, m: string): void; warn(o: object, m: string): void };
    },
  ) {}

  async init(): Promise<void> {
    const rows = await this.deps.db.read.selectFrom('settings').select(['key', 'value']).where('key', 'in', [APPLIED, APPLIED_AT]).execute();
    this.applied = rows.find((r) => r.key === APPLIED)?.value;
    const at = rows.find((r) => r.key === APPLIED_AT)?.value;
    this.appliedAt = at ? Number(at) : undefined;
  }

  status(): RegionStatus {
    return { region: this.deps.region.name, control_plane: this.deps.region.controlPlaneUrl, applied_etag: this.applied ?? null, applied_at: this.appliedAt ?? null, last_contact: this.lastContact ?? null, error: this.error ?? null };
  }

  /** Poll until stopped; the first poll is awaited by the caller (at start, to serve the newest configuration). */
  start(): void {
    const next = () => {
      if (this.stopped) return;
      this.timer = setTimeout(() => void this.poll().finally(next), this.deps.region.pollMs);
      this.timer.unref?.();
    };
    next();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Ask the control plane once. Never throws: a failure is kept (and reported at the next poll). */
  async poll(): Promise<'applied' | 'unchanged' | 'failed'> {
    const r = this.deps.region;
    try {
      const res = await fetch(`${r.controlPlaneUrl}/cp/v1/config`, {
        headers: {
          authorization: `Bearer ${r.token}`,
          'x-ct-region': r.name,
          'x-ct-instance': this.deps.instanceId,
          'x-ct-version': this.deps.version,
          ...(this.applied ? { 'x-ct-applied-etag': this.applied, 'if-none-match': this.applied } : {}),
          ...(this.error ? { 'x-ct-region-error': this.error.slice(0, 200) } : {}),
        },
        signal: AbortSignal.timeout(20_000),
      });
      this.lastContact = Date.now();
      if (res.status === 304) {
        this.error = undefined;
        // Another instance of this region may have applied it: make sure this one reads it too.
        await this.catchUp();
        return 'unchanged';
      }
      const body = await res.text();
      if (res.status !== 200) throw new Error(`the control plane answered ${res.status}: ${(safeJson(body)?.error?.message as string | undefined) ?? body.slice(0, 200)}`);
      if (!verify(r.token, body, res.headers.get('x-ct-signature'))) throw new Error('the configuration is not signed with this region’s token: refused');
      const snap = JSON.parse(body) as Snapshot;
      if (snap.master_key_id !== this.deps.masterKeyId) throw new Error(`the configuration is for master key ${snap.master_key_id}, and this region has ${this.deps.masterKeyId}: set CT_MASTER_KEY to the key the control plane gave for this region`);
      if (snap.etag === this.applied) return 'unchanged';
      await this.apply(snap);
      this.error = undefined;
      await this.deps.reload();
      this.deps.log().info?.({ etag: snap.etag }, 'region: configuration from the control plane applied');
      return 'applied';
    } catch (err) {
      const message = (err as Error).message;
      if (message !== this.error) this.deps.log().warn({ err: message }, 'region: no new configuration from the control plane (serving on the last one)');
      this.error = message;
      return 'failed';
    }
  }

  /** When another instance of this region applied a newer snapshot, reload from the database. */
  private async catchUp(): Promise<void> {
    const row = await this.deps.db.read.selectFrom('settings').select('value').where('key', '=', APPLIED).executeTakeFirst();
    if (row && row.value !== this.applied) {
      this.applied = row.value;
      await this.deps.reload();
    }
  }

  /** Write a snapshot into this region's database, in one transaction: rows added, changed and removed. */
  async apply(snap: Snapshot): Promise<void> {
    const db = this.deps.db;
    await db.write.transaction().execute(async (trx0) => {
      if (db.dialect === 'postgres') await sql`SELECT pg_advisory_xact_lock(${PG_LOCK})`.execute(trx0);
      const trx = trx0 as unknown as Kysely<Record<string, Row>>;
      const cur = await trx.selectFrom('settings').select('value').where('key', '=', APPLIED).executeTakeFirst();
      if (cur?.value === snap.etag) return;
      // Children before parents when removing, parents before children when adding.
      for (const t of [...REPLICATED].reverse()) {
        const wanted = new Set((snap.tables[t.name] ?? []).map((row) => keyOf(t.key, row)));
        const have = await trx.selectFrom(t.name).select([...t.key]).execute();
        const gone = have.filter((row) => !wanted.has(keyOf(t.key, row)) && !t.keepLocal?.(row));
        for (const row of gone) {
          let q = trx.deleteFrom(t.name);
          for (const k of t.key) q = q.where(k, '=', row[k] as string);
          await q.execute();
        }
      }
      for (const t of REPLICATED) {
        for (const row of snap.tables[t.name] ?? []) {
          const values = Object.fromEntries(Object.entries(row).filter(([k]) => !t.local.includes(k)));
          const update = Object.fromEntries(Object.entries(values).filter(([k]) => !t.key.includes(k)));
          await trx
            .insertInto(t.name)
            .values(values)
            .onConflict((oc) => (Object.keys(update).length ? oc.columns([...t.key]).doUpdateSet(update) : oc.columns([...t.key]).doNothing()))
            .execute();
        }
      }
      const now = Date.now();
      for (const k of SETTINGS_KEYS) {
        const v = snap.settings[k];
        if (v === undefined) await trx.deleteFrom('settings').where('key', '=', k).execute();
        else await trx.insertInto('settings').values({ key: k, value: v, updated_at: now }).onConflict((oc) => oc.column('key').doUpdateSet({ value: v, updated_at: now })).execute();
      }
      for (const [k, v] of [[APPLIED, snap.etag], [APPLIED_AT, String(now)]] as const)
        await trx.insertInto('settings').values({ key: k, value: v, updated_at: now }).onConflict((oc) => oc.column('key').doUpdateSet({ value: v, updated_at: now })).execute();
    });
    this.applied = snap.etag;
    this.appliedAt = Date.now();
  }
}

const keyOf = (key: readonly string[], row: Row) => key.map((k) => String(row[k] ?? '')).join('\u0000');
function safeJson(s: string): { error?: { message?: unknown } } | undefined {
  try {
    return JSON.parse(s) as { error?: { message?: unknown } };
  } catch {
    return undefined;
  }
}
