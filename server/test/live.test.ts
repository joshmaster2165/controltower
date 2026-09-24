import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlightEvent, LiveTick, WsServerMessage } from '@controltower/shared';
import { FlightBus } from '../src/events/bus.js';
import { LiveFrames } from '../src/admin/live.js';

const started = (id: string, key: string, target: string, tool?: string): FlightEvent => ({
  t: 'flight.started',
  flight_id: id,
  ts: Date.now(),
  key_id: key,
  key_name: key,
  kind: tool ? 'mcp.tool' : 'chat',
  dialect: tool ? 'mcp' : 'openai-chat',
  stream: false,
  model_requested: 'm',
  ...(tool ? { mcp_server_id: target, tool } : { deployment_id: target }),
  est_input_tokens: 1,
  projected_nanousd: 0,
});
const completed = (id: string, status: 'ok' | 'error' | 'denied', cost = 0): FlightEvent => ({
  t: 'flight.completed',
  flight_id: id,
  ts: Date.now(),
  status,
  http_status: status === 'ok' ? 200 : status === 'error' ? 502 : 403,
  usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0 },
  usage_source: 'provider',
  cost_nanousd: cost,
  cost_confidence: 'exact',
  duration_ms: 1,
  gateway_overhead_ms: 0,
});

describe('live frames', () => {
  afterEach(() => vi.useRealTimers());

  function setup() {
    vi.useFakeTimers();
    const bus = new FlightBus();
    const live = new LiveFrames(bus);
    const got: WsServerMessage[] = [];
    live.subscribe((m) => got.push(m));
    return { bus, live, got };
  }

  it('sums calls that went fine into one tick a second, per path', () => {
    const { bus, got } = setup();
    for (let i = 0; i < 50; i++) {
      bus.emit(started(`f${i}`, i % 2 ? 'k1' : 'k2', 'dep1'));
      bus.emit(completed(`f${i}`, 'ok', 10));
    }
    bus.emit(started('t1', 'k1', 'srv', 'search'));
    bus.emit(completed('t1', 'ok'));
    vi.advanceTimersByTime(1000);

    expect(got).toHaveLength(1); // no per-call messages
    const tick = got[0] as LiveTick;
    expect(tick.type).toBe('tick');
    expect(tick.totals).toEqual({ flights: 51, ok: 51, errors: 0, denied: 0, cost_nanousd: 500, tokens: 255 });
    expect(tick.paths).toEqual(expect.arrayContaining([['k1', 'dep1', null, 25, 0, 0, 250], ['k2', 'dep1', null, 25, 0, 0, 250], ['k1', 'srv', 'search', 1, 0, 0, 0]]));

    // A quiet second sends nothing.
    vi.advanceTimersByTime(1000);
    expect(got).toHaveLength(1);
  });

  it('sends held, denied and failed flights in full within 100 ms, start first', () => {
    const { bus, got } = setup();
    bus.emit(started('ok1', 'k1', 'dep1'));
    bus.emit(started('held1', 'k1', 'srv', 'delete'));
    bus.emit({ t: 'flight.decision', flight_id: 'held1', ts: Date.now(), decision: 'hold', rule_id: 'gate1' });
    bus.emit({ t: 'flight.held', flight_id: 'held1', ts: Date.now(), approval_id: 'a1', budget_ms: 1000, summary: 'delete' });
    bus.emit(started('bad1', 'k2', 'dep1'));
    bus.emit(completed('bad1', 'error'));
    vi.advanceTimersByTime(100);

    const detail = got.filter((m) => m.type === 'events').flatMap((m) => (m.type === 'events' ? m.events : []));
    expect(detail.map((e) => `${e.t}:${e.flight_id}`)).toEqual(['flight.started:held1', 'flight.held:held1', 'flight.started:bad1', 'flight.completed:bad1']);
    expect(detail.some((e) => e.flight_id === 'ok1')).toBe(false);

    // Its approval and completion follow; the gate hit and the counts are in the tick.
    bus.emit({ t: 'flight.resolved', flight_id: 'held1', ts: Date.now(), approval_id: 'a1', outcome: 'approved' });
    bus.emit(completed('held1', 'ok'));
    vi.advanceTimersByTime(1000);
    const later = got.flatMap((m) => (m.type === 'events' ? m.events : [])).filter((e) => e.flight_id === 'held1').map((e) => e.t);
    expect(later).toEqual(['flight.started', 'flight.held', 'flight.resolved', 'flight.completed']);
    const tick = got.find((m) => m.type === 'tick') as LiveTick;
    expect(tick.totals).toMatchObject({ flights: 3, ok: 1, errors: 1 });
    expect(tick.rules).toEqual({ gate1: 1 });
  });

  it('gives a console that connects now the last seconds of frames', () => {
    const { bus, live } = setup();
    bus.emit(started('f1', 'k1', 'dep1'));
    vi.advanceTimersByTime(1000);
    expect(live.backlog().map((m) => m.type)).toEqual(['tick']);
    vi.advanceTimersByTime(20_000);
    expect(live.backlog()).toEqual([]);
  });
});
