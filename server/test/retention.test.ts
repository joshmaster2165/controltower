import { describe, expect, it } from 'vitest';
import { openSqlite } from '../src/db/index.js';
import { applyRetention } from '../src/db/retention.js';

const DAY = 24 * 3600 * 1000;

describe('retention', () => {
  it('drops old per-request rows in chunks and keeps recent rows and daily rollups', async () => {
    const db = openSqlite('', { memory: true });
    const now = Date.UTC(2026, 8, 24, 12);
    const flight = db.raw.prepare("INSERT INTO flights (id, ts, key_id, key_name, kind, dialect, model_requested) VALUES (?, ?, 'k', 'agent', 'chat', 'openai-chat', 'm')");
    const event = db.raw.prepare("INSERT INTO flight_events (flight_id, seq, ts, type, payload) VALUES (?, 0, ?, 'flight.started', '{}')");
    db.raw.transaction(() => {
      for (let i = 0; i < 12_000; i++) flight.run(`old_${i}`, now - 40 * DAY); // more than two chunks
      for (let i = 0; i < 5; i++) flight.run(`new_${i}`, now - DAY);
      for (let i = 0; i < 10; i++) event.run(`e_old_${i}`, now - 10 * DAY);
      for (let i = 0; i < 3; i++) event.run(`e_new_${i}`, now - 2 * DAY);
    })();
    db.raw.prepare("INSERT INTO usage_hourly (bucket, requests) VALUES (?, 1)").run(new Date(now - 120 * DAY).toISOString().slice(0, 13));
    db.raw.prepare("INSERT INTO usage_hourly (bucket, requests) VALUES (?, 1)").run(new Date(now - DAY).toISOString().slice(0, 13));
    db.raw.prepare("INSERT INTO usage_daily (bucket, requests) VALUES (?, 1)").run(new Date(now - 400 * DAY).toISOString().slice(0, 10));

    const deleted = await applyRetention(db.write, { flightsDays: 30, eventsDays: 7 }, now);
    expect(deleted).toMatchObject({ flights: 12_000, flight_events: 10, usage_hourly: 1 });
    const count = (sql: string) => (db.raw.prepare(sql).get() as { n: number }).n;
    expect(count('SELECT COUNT(*) AS n FROM flights')).toBe(5);
    expect(count('SELECT COUNT(*) AS n FROM flight_events')).toBe(3);
    expect(count('SELECT COUNT(*) AS n FROM usage_hourly')).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM usage_daily')).toBe(1); // spend history is kept

    // 0 keeps flights forever.
    flight.run('ancient', now - 900 * DAY);
    expect((await applyRetention(db.write, { flightsDays: 0, eventsDays: 0 }, now)).flights).toBeUndefined();
    expect(count('SELECT COUNT(*) AS n FROM flights')).toBe(6);
  });
});
