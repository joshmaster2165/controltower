import { describe, expect, it } from 'vitest';
import { openSqlite } from '../src/db/index.js';
import { FlightBus } from '../src/events/bus.js';
import { OpenFlights, closeInterrupted } from '../src/events/open-flights.js';

describe('calls a stop cuts off', () => {
  it('a graceful stop records the calls still open as stopped', () => {
    const bus = new FlightBus();
    const open = new OpenFlights();
    const seen: any[] = [];
    bus.subscribe(open.push);
    bus.subscribe((e) => seen.push(e));
    bus.emit({ t: 'flight.started', flight_id: 'a', ts: 1000 } as never);
    bus.emit({ t: 'flight.started', flight_id: 'b', ts: 1000 } as never);
    bus.emit({ t: 'flight.completed', flight_id: 'a', ts: 2000, status: 'ok' } as never);
    expect(open.closeAll(bus, 5000)).toBe(1);
    expect(seen.at(-1)).toMatchObject({ t: 'flight.completed', flight_id: 'b', status: 'shutdown', duration_ms: 4000, error: { code: 'shutdown' } });
    expect(open.size).toBe(0);
  });

  it('at start, closes out calls and held approvals a crash left open — but not approvals the agent holds a ticket for', async () => {
    const db = openSqlite('', { memory: true });
    const now = Date.UTC(2026, 8, 27, 12);
    const flight = db.raw.prepare("INSERT INTO flights (id, ts, key_id, key_name, kind, dialect, model_requested, status) VALUES (?, ?, 'k', 'agent', 'chat', 'openai-chat', 'm', ?)");
    flight.run('done', now - 5000, 'ok');
    flight.run('cut', now - 4000, null);
    const approval = db.raw.prepare("INSERT INTO approvals (id, flight_id, key_id, key_name, summary, target, scope_hash, dedupe_key, status, waiters, requested_at, expires_at) VALUES (?, ?, 'k', 'agent', 's', '{}', 'h', ?, 'pending', 1, ?, ?)");
    approval.run('apr_crashed', 'cut', 'd1', now - 3000, now + 600_000);
    approval.run('apr_ticketed', 'done', 'd2', now - 3000, now + 600_000);
    db.raw.prepare("INSERT INTO tickets (id, approval_id, key_id, expires_at, created_at) VALUES ('ct_tkt_x', 'apr_ticketed', 'k', ?, ?)").run(now + 900_000, now - 2000);

    expect(await closeInterrupted(db.write, now)).toEqual({ flights: 1, approvals: 1 });
    const row = (sql: string, id: string) => db.raw.prepare(sql).get(id) as Record<string, unknown>;
    expect(row('SELECT status, error_code FROM flights WHERE id = ?', 'cut')).toEqual({ status: 'shutdown', error_code: 'interrupted' });
    expect(row('SELECT status FROM flights WHERE id = ?', 'done')).toEqual({ status: 'ok' });
    expect(row('SELECT status FROM approvals WHERE id = ?', 'apr_crashed')).toEqual({ status: 'expired' });
    expect(row('SELECT status FROM approvals WHERE id = ?', 'apr_ticketed')).toEqual({ status: 'pending' });
  });
});
