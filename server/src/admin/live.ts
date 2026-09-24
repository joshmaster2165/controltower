import type { FlightEvent, FlightStarted, LiveTick, WsServerMessage } from '@controltower/shared';
import type { FlightBus } from '../events/bus.js';

const TICK_MS = 1000;
const DETAIL_MS = 100;
/** How much a console that connects now is sent, so the map opens on what is happening. */
const BACKLOG_MS = 15_000;
/** Flights in the air whose start is kept in case they turn out to need a person. */
const MAX_PENDING = 20_000;

type Totals = LiveTick['totals'];
const zero = (): Totals => ({ flights: 0, ok: 0, errors: 0, denied: 0, cost_nanousd: 0, tokens: 0 });

/**
 * Live frames for the console. One message per flight event does not scale:
 * a gateway doing 300 calls a second emits some 1,200 events a second, which
 * no browser tab keeps up with. So the console gets, computed once and sent
 * to every open console:
 *
 *  - a tick every second: totals, calls per path (key → target → tool) and
 *    gate hits, which is everything the map and counters draw for calls that
 *    went fine;
 *  - the full events of flights a person should see — held, denied, failed —
 *    within 100 ms, with the start of the flight sent first so the map knows
 *    where it is.
 */
export class LiveFrames {
  private listeners = new Set<(m: WsServerMessage) => void>();
  private totals = zero();
  private paths = new Map<string, LiveTick['paths'][number]>();
  private rules = new Map<string, number>();
  private pending = new Map<string, Extract<FlightEvent, { t: 'flight.started' }>>();
  private promoted = new Set<string>();
  private detail: FlightEvent[] = [];
  private history: Array<{ at: number; m: WsServerMessage }> = [];
  private timers: NodeJS.Timeout[] = [];
  private unsub: () => void;

  constructor(bus: FlightBus) {
    this.unsub = bus.subscribe((e) => this.onEvent(e));
    const tick = setInterval(() => this.flushTick(), TICK_MS);
    const detail = setInterval(() => this.flushDetail(), DETAIL_MS);
    tick.unref();
    detail.unref();
    this.timers.push(tick, detail);
  }

  subscribe(fn: (m: WsServerMessage) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The last few seconds of frames, for a console that connects now. */
  backlog(): WsServerMessage[] {
    this.prune(Date.now());
    return this.history.map((h) => h.m);
  }

  stop(): void {
    this.unsub();
    for (const t of this.timers) clearInterval(t);
  }

  private onEvent(e: FlightEvent): void {
    switch (e.t) {
      case 'flight.started': {
        this.totals.flights++;
        const target = e.deployment_id ?? e.mcp_server_id ?? null;
        const k = `${e.key_id}|${target ?? ''}|${e.tool ?? ''}`;
        const row = this.paths.get(k);
        if (row) row[3]++;
        else this.paths.set(k, [e.key_id, target, e.tool ?? null, 1]);
        this.pending.set(e.flight_id, e as FlightStarted & { t: 'flight.started' });
        if (this.pending.size > MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
        break;
      }
      case 'flight.decision':
        if (e.rule_id && e.decision !== 'allow') this.rules.set(e.rule_id, (this.rules.get(e.rule_id) ?? 0) + 1);
        if (e.decision === 'deny') this.promote(e.flight_id);
        this.forward(e);
        break;
      case 'flight.held':
        this.promote(e.flight_id);
        this.forward(e);
        break;
      case 'flight.resolved':
        this.forward(e);
        break;
      case 'flight.completed': {
        const t = this.totals;
        if (e.status === 'ok') t.ok++;
        else if (e.status === 'error') t.errors++;
        else if (e.status === 'denied' || e.status === 'rejected' || e.status === 'ticketed') t.denied++;
        if (e.cost_nanousd) t.cost_nanousd += e.cost_nanousd;
        if (e.usage) t.tokens += e.usage.input + e.usage.output;
        // A failed call goes to the console's feed.
        if (e.status !== 'ok' && e.status !== 'client_aborted') this.promote(e.flight_id);
        this.forward(e);
        this.pending.delete(e.flight_id);
        this.promoted.delete(e.flight_id);
        break;
      }
      default:
        break;
    }
  }

  /** From now on this flight's events go out in full, starting with its start. */
  private promote(id: string): void {
    if (this.promoted.has(id)) return;
    this.promoted.add(id);
    const started = this.pending.get(id);
    if (started) this.detail.push(started);
  }

  private forward(e: FlightEvent): void {
    if (this.promoted.has(e.flight_id)) this.detail.push(e);
  }

  private flushDetail(): void {
    if (!this.detail.length) return;
    const events = this.detail;
    this.detail = [];
    this.emit({ type: 'events', events });
  }

  private flushTick(): void {
    const t = this.totals;
    if (!this.paths.size && !this.rules.size && !t.flights && !t.ok && !t.errors && !t.denied) return;
    const m: LiveTick = { type: 'tick', ts: Date.now(), ms: TICK_MS, totals: t, paths: [...this.paths.values()], rules: Object.fromEntries(this.rules) };
    this.totals = zero();
    this.paths = new Map();
    this.rules = new Map();
    this.emit(m);
  }

  private emit(m: WsServerMessage): void {
    const now = Date.now();
    this.history.push({ at: now, m });
    this.prune(now);
    for (const fn of this.listeners) {
      try {
        fn(m);
      } catch (err) {
        console.error('[live] listener error', err);
      }
    }
  }

  private prune(now: number): void {
    let i = 0;
    while (i < this.history.length && now - this.history[i]!.at > BACKLOG_MS) i++;
    if (i) this.history.splice(0, i);
  }
}
