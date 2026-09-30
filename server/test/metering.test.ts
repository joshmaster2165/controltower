import { describe, expect, it } from 'vitest';
import { openSqlite } from '../src/db/index.js';
import { AuditLog } from '../src/ee/audit.js';
import { Metering, licenseYear } from '../src/ee/metering.js';
import type { Licensing } from '../src/ee/license.js';

const DAY = 86_400_000;
const at = (s: string) => Date.parse(`${s}T00:00:00Z`);

describe('request metering', () => {
  it('license years run from the subscription start, anniversary to anniversary', () => {
    expect(licenseYear(at('2025-03-01'), at('2026-09-29'))).toEqual({ start: at('2026-03-01'), end: at('2027-03-01') });
    expect(licenseYear(at('2026-09-29'), at('2026-09-29'))).toEqual({ start: at('2026-09-29'), end: at('2027-09-29') });
    expect(licenseYear(at('2026-10-15'), at('2026-09-29')).start).toBe(at('2025-10-15'));
  });

  it('counts every request this license year, projects the year, and records 80% and 100% once each', async () => {
    const db = openSqlite('', { memory: true });
    const now = Date.now();
    const start = now - 100 * DAY;
    const license = { current: { status: 'valid', license: { id: 'lic_1', requests_per_year: 1000, period_start: start } } } as unknown as Licensing;
    const log = new AuditLog(db);
    const m = new Metering({ db, license, audit: log, log: () => ({ warn: () => undefined }) });
    const add = async (dayMs: number, requests: number, kind = 'chat') =>
      db.write.insertInto('usage_daily').values({ bucket: new Date(dayMs).toISOString().slice(0, 10), key_id: 'k', deployment_id: '', alias_id: '', kind, requests } as never).execute();
    await add(start - 5 * DAY, 999); // last license year: not counted
    await add(start + 1 * DAY, 300);
    await add(start + 40 * DAY, 200, 'mcp.tool');
    let u = (await m.usage(true))!;
    expect(u).toMatchObject({ allowance: 1000, used: 500, level: 'ok', period_start: start });
    expect(u.projected).toBeGreaterThan(1500); // 500 in 100 days → about 1,825 in a year
    expect(u.by_month.reduce((a, b) => a + b.requests, 0)).toBe(500);
    await m.check();
    expect((await db.read.selectFrom('audit_events').selectAll().execute()).length).toBe(0);

    await add(start + 60 * DAY, 350);
    u = (await m.usage(true))!;
    expect(u.level).toBe('warn');
    await m.check();
    await m.check();
    await add(start + 70 * DAY, 200);
    await m.check();
    const events = await db.read.selectFrom('audit_events').selectAll().orderBy('seq').execute();
    expect(events.map((e) => [e.action, JSON.parse(e.detail!).level])).toEqual([
      ['license.usage', 'warn'],
      ['license.usage', 'over'],
    ]);
  });

  it('nothing to count without a license in force, or with an unlimited one', async () => {
    const db = openSqlite('', { memory: true });
    const none = new Metering({ db, license: { current: { status: 'none' } } as unknown as Licensing, log: () => ({ warn: () => undefined }) });
    expect(await none.usage(true)).toBeUndefined();
    const unlimited = new Metering({ db, license: { current: { status: 'valid', license: { id: 'l', requests_per_year: 0 } } } as unknown as Licensing, log: () => ({ warn: () => undefined }) });
    expect(await unlimited.usage(true)).toBeUndefined();
    // No period_start: the year runs from when this install first saw the license, and stays put.
    const firstSeen = new Metering({ db, license: { current: { status: 'valid', license: { id: 'l2', requests_per_year: 10 } } } as unknown as Licensing, log: () => ({ warn: () => undefined }) });
    const a = (await firstSeen.usage(true))!.period_start;
    expect(Math.abs(a - Date.now())).toBeLessThan(5000);
    expect((await firstSeen.usage(true))!.period_start).toBe(a);
  });
});
