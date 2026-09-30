import { describe, expect, it } from 'vitest';
import { openSqlite } from '../src/db/index.js';
import { CLOCK_TOLERANCE_MS, ClockWatch } from '../src/ee/clock.js';

const DAY = 86_400_000;

describe('the clock watch', () => {
  it('notices a clock set back more than two days, reports it once, and never before', async () => {
    const db = openSqlite('', { memory: true });
    let now = Date.UTC(2026, 9, 1);
    const reports: number[] = [];
    const clock = new ClockWatch({ db: db.write, now: () => now, onBehind: (s) => void reports.push(s.behind_ms) });

    expect((await clock.check()).behind).toBe(false);
    now += 30 * DAY;
    expect((await clock.check()).high_water).toBe(now);

    // A clock a little behind (a correction, another instance's skew) is fine.
    now -= DAY;
    expect((await clock.check()).behind).toBe(false);

    // Set back by weeks: reported, once.
    now -= 20 * DAY;
    const s = await clock.check();
    expect(s).toMatchObject({ behind: true, behind_ms: 21 * DAY });
    await clock.check();
    expect(reports).toEqual([21 * DAY]);

    // Another server on the same database sees the same mark.
    const other = new ClockWatch({ db: db.write, now: () => now });
    expect((await other.check()).behind).toBe(true);
  });

  it('an admin who knows the clock is right starts the mark again', async () => {
    const db = openSqlite('', { memory: true });
    let now = Date.UTC(2031, 0, 1); // set ahead by mistake…
    const reports: number[] = [];
    const clock = new ClockWatch({ db: db.write, now: () => now, onBehind: (s) => void reports.push(s.behind_ms) });
    await clock.check();
    now = Date.UTC(2026, 9, 1); // …then corrected
    expect((await clock.check()).behind).toBe(true);
    expect(await clock.accept()).toMatchObject({ behind: false, high_water: now });
    now += DAY;
    expect((await clock.check()).behind).toBe(false);
    // Set back again, later: reported again.
    now -= CLOCK_TOLERANCE_MS + 5 * DAY;
    expect((await clock.check()).behind).toBe(true);
    expect(reports).toHaveLength(2);
  });
});
