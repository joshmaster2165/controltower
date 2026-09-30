import type { Db } from '../db/index.js';
import type { Licensing } from './license.js';
import type { AuditLog } from './audit.js';

/**
 * Requests against the license's yearly allowance (Enterprise). Every call through the gateway counts —
 * model calls, tool calls, HTTP APIs, agents calling agents, allowed or not — from the daily rollups, which
 * are kept forever and shared by every instance. Going over never slows or stops anything: the console says so
 * at 80% and at 100%, the audit log records it, and the count goes to the license service with each renewal.
 *
 * The license year runs from the subscription's start (the license's period_start), or else from when this
 * install first saw the license, and restarts every year after.
 */
const DAY = 86_400_000;
const WARN_AT = 0.8;
const CHECK_MS = 15 * 60_000;

export interface Usage {
  allowance: number;
  used: number;
  /** used / allowance (0 when unlimited). */
  share: number;
  period_start: number;
  period_end: number;
  /** At the pace so far, by the end of the year (after a week of it). */
  projected: number | null;
  level: 'ok' | 'warn' | 'over';
  /** Requests per month of this license year, oldest first ("YYYY-MM"). */
  by_month: Array<{ month: string; requests: number }>;
}

const addYear = (ms: number, n = 1) => {
  const d = new Date(ms);
  d.setUTCFullYear(d.getUTCFullYear() + n);
  return d.getTime();
};
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The license year holding `now`, counted from `anchor`. */
export function licenseYear(anchor: number, now = Date.now()): { start: number; end: number } {
  let start = anchor;
  if (start > now) start = addYear(start, -Math.ceil((start - now) / (366 * DAY)));
  while (addYear(start) <= now) start = addYear(start);
  return { start, end: addYear(start) };
}

export class Metering {
  private cached: { at: number; for: string; value: Usage | undefined } | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly deps: {
      db: Db;
      license: Licensing;
      audit?: AuditLog | undefined;
      log: () => { warn(o: object, m: string): void };
    },
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.check(), CHECK_MS);
    this.timer.unref?.();
    const first = setTimeout(() => void this.check(), 30_000);
    first.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Usage this license year; undefined without a license in force or with an unlimited one. */
  async usage(fresh = false): Promise<Usage | undefined> {
    // A new or changed license is counted afresh, not from a minute-old answer about the one before.
    const s = this.deps.license.current;
    const which = `${s.status}:${s.license?.id ?? ''}:${s.license?.requests_per_year ?? ''}:${s.license?.period_start ?? ''}`;
    if (!fresh && this.cached && this.cached.for === which && Date.now() - this.cached.at < 60_000) return this.cached.value;
    const value = await this.compute();
    this.cached = { at: Date.now(), for: which, value };
    return value;
  }

  private async anchor(licenseId: string, periodStart: number | undefined): Promise<number> {
    if (periodStart) return periodStart;
    const k = `license_usage_anchor.${licenseId}`;
    const w = this.deps.db.write;
    const row = await w.selectFrom('settings').select('value').where('key', '=', k).executeTakeFirst();
    if (row) return Number(row.value);
    const now = Date.now();
    await w.insertInto('settings').values({ key: k, value: String(now), updated_at: now }).onConflict((oc) => oc.column('key').doNothing()).execute();
    return Number((await w.selectFrom('settings').select('value').where('key', '=', k).executeTakeFirstOrThrow()).value);
  }

  private async compute(): Promise<Usage | undefined> {
    const s = this.deps.license.current;
    const l = s.license;
    if (!l || !l.requests_per_year || !['valid', 'expiring', 'grace'].includes(s.status)) return undefined;
    const anchor = await this.anchor(l.id, l.period_start);
    // Read after the anchor: a license first seen just now must not look a year old.
    const now = Date.now();
    const { start, end } = licenseYear(Math.min(anchor, now), now);
    const rows = await this.deps.db.read
      .selectFrom('usage_daily')
      .select(['bucket'])
      .select((eb) => eb.fn.sum<number>('requests').as('requests'))
      .where('bucket', '>=', day(start))
      .groupBy('bucket')
      .execute();
    // Regions' requests too (multi-region): each region reports its days to the control plane.
    const regional = await this.deps.db.read
      .selectFrom('region_usage_daily')
      .select(['bucket'])
      .select((eb) => eb.fn.sum<number>('requests').as('requests'))
      .where('bucket', '>=', day(start))
      .groupBy('bucket')
      .execute()
      .catch(() => []);
    const months = new Map<string, number>();
    let used = 0;
    for (const r of [...rows, ...regional]) {
      const n = Number(r.requests ?? 0);
      used += n;
      const m = String(r.bucket).slice(0, 7);
      months.set(m, (months.get(m) ?? 0) + n);
    }
    const elapsed = now - start;
    const projected = elapsed >= 7 * DAY ? Math.round((used * (end - start)) / elapsed) : null;
    const share = used / l.requests_per_year;
    return {
      allowance: l.requests_per_year,
      used,
      share,
      period_start: start,
      period_end: end,
      projected,
      level: share >= 1 ? 'over' : share >= WARN_AT ? 'warn' : 'ok',
      by_month: [...months].sort((a, b) => a[0].localeCompare(b[0])).map(([month, requests]) => ({ month, requests })),
    };
  }

  /** Record crossing 80% and 100% of the allowance, once each per license year. */
  async check(): Promise<void> {
    try {
      const u = await this.usage(true);
      const l = this.deps.license.current.license;
      if (!u || !l || u.level === 'ok') return;
      const k = `license_usage_notified.${l.id}.${u.period_start}`;
      const w = this.deps.db.write;
      const prev = (await w.selectFrom('settings').select('value').where('key', '=', k).executeTakeFirst())?.value;
      if (prev === u.level || (prev === 'over' && u.level === 'warn')) return;
      const now = Date.now();
      await w.insertInto('settings').values({ key: k, value: u.level, updated_at: now }).onConflict((oc) => oc.column('key').doUpdateSet({ value: u.level, updated_at: now })).execute();
      const pct = Math.round(u.share * 100);
      this.deps.log().warn({ used: u.used, allowance: u.allowance, percent: pct }, `license: ${pct}% of this year's requests used (traffic is never limited)`);
      await this.deps.audit?.record({ action: 'license.usage', outcome: 'success', actor: { type: 'system', id: 'metering' }, detail: { used: u.used, allowance: u.allowance, percent: pct, level: u.level, period_start: new Date(u.period_start).toISOString(), period_end: new Date(u.period_end).toISOString() } });
    } catch (err) {
      this.deps.log().warn({ err: (err as Error).message }, 'license usage check failed');
    }
  }
}
