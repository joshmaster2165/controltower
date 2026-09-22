import { describe, expect, it } from 'vitest';
import { openSqlite } from '../src/db/index.js';
import { DbSink } from '../src/events/db-sink.js';
import type { FlightEvent } from '@controltower/shared';

function started(id: string, ts: number): FlightEvent {
  return {
    t: 'flight.started',
    flight_id: id,
    ts,
    key_id: 'k1',
    key_name: 'agent',
    kind: 'chat',
    dialect: 'openai-chat',
    stream: false,
    model_requested: 'smart',
    deployment_id: 'd1',
    provider_id: 'p1',
    provider_kind: 'mock',
    est_input_tokens: 10,
    projected_nanousd: 100,
  };
}

function completed(id: string, ts: number, status: 'ok' | 'error' | 'denied', cost: number | null): FlightEvent {
  return {
    t: 'flight.completed',
    flight_id: id,
    ts,
    status,
    http_status: status === 'ok' ? 200 : 502,
    deployment_id: 'd1',
    usage: status === 'ok' ? { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 } : undefined,
    usage_source: status === 'ok' ? 'provider' : 'unknown',
    cost_nanousd: cost,
    cost_confidence: cost == null ? 'unknown' : 'exact',
    duration_ms: 120,
    gateway_overhead_ms: 1,
  };
}

describe('DbSink', () => {
  it('persists flights, events and incremental rollups in one flush', () => {
    const db = openSqlite('', { memory: true });
    const sink = new DbSink(db.raw);
    const ts = Date.UTC(2026, 8, 22, 10, 0, 0);
    sink.push(started('f1', ts));
    sink.push(completed('f1', ts + 120, 'ok', 5000));
    sink.push(started('f2', ts + 10));
    sink.push(completed('f2', ts + 200, 'error', null));
    sink.push(started('f3', ts + 20));
    sink.push(completed('f3', ts + 50, 'denied', null));
    sink.flush();

    const flights = db.raw.prepare('SELECT id, status, cost_nanousd, in_tokens, out_tokens FROM flights ORDER BY id').all() as Array<Record<string, unknown>>;
    expect(flights).toHaveLength(3);
    expect(flights[0]).toMatchObject({ id: 'f1', status: 'ok', cost_nanousd: 5000, in_tokens: 10, out_tokens: 20 });
    expect(flights[1]).toMatchObject({ id: 'f2', status: 'error' });

    const events = db.raw.prepare('SELECT COUNT(*) AS n FROM flight_events').get() as { n: number };
    expect(events.n).toBe(6);

    const hourly = db.raw.prepare('SELECT * FROM usage_hourly').all() as Array<Record<string, unknown>>;
    expect(hourly).toHaveLength(1);
    expect(hourly[0]).toMatchObject({ bucket: '2026-09-22T10', requests: 3, errors: 1, denied: 1, cost_nanousd: 5000, in_tokens: 10, out_tokens: 20, lat_count: 1 });
    const hist = JSON.parse(hourly[0]!.lat_hist as string) as number[];
    expect(hist.reduce((a, b) => a + b, 0)).toBe(1);

    // A second flush merges into the same rollup row.
    sink.push(started('f4', ts + 30));
    sink.push(completed('f4', ts + 400, 'ok', 1000));
    sink.flush();
    const again = db.raw.prepare('SELECT requests, cost_nanousd FROM usage_hourly').get() as { requests: number; cost_nanousd: number };
    expect(again).toEqual({ requests: 4, cost_nanousd: 6000 });
    db.close();
  });
});
