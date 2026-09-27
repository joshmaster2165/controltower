import type { FlightCompleted, FlightDecision, FlightHeld, FlightStarted } from '@controltower/shared';

/**
 * How calls are summed into the hourly and daily usage rollups and the hourly traffic summary — the same for
 * SQLite and Postgres; each writer only differs in how it stores them.
 */

/** Log-spaced latency buckets (ms), last is +inf. */
export const LAT_BUCKETS = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 30000, Infinity];

export function bucketIndex(ms: number): number {
  for (let i = 0; i < LAT_BUCKETS.length; i++) if (ms <= LAT_BUCKETS[i]!) return i;
  return LAT_BUCKETS.length - 1;
}

export interface RollupAcc {
  requests: number;
  errors: number;
  denied: number;
  held: number;
  in_tokens: number;
  out_tokens: number;
  cache_r: number;
  cache_w: number;
  cost_nanousd: number;
  lat_sum_ms: number;
  lat_count: number;
  lat_hist: number[];
}

export function emptyAcc(): RollupAcc {
  return {
    requests: 0,
    errors: 0,
    denied: 0,
    held: 0,
    in_tokens: 0,
    out_tokens: 0,
    cache_r: 0,
    cache_w: 0,
    cost_nanousd: 0,
    lat_sum_ms: 0,
    lat_count: 0,
    lat_hist: new Array<number>(LAT_BUCKETS.length).fill(0),
  };
}

export function hourBucket(ts: number): string {
  return new Date(ts).toISOString().slice(0, 13); // YYYY-MM-DDTHH
}
export function dayBucket(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD
}

/** One hour of traffic on one path: what the map, the data-flow export and the route lists count from. */
export interface TrafficAcc {
  requests: number;
  errors: number;
  denied: number;
  rejected: number;
  ticketed: number;
  held: number;
  cost_nanousd: number;
  tokens: number;
  last_ts: number;
}
/** Joins a traffic path's parts: a character no tool, model or agent name contains. */
export const TSEP = '\u0001';
export const TRAFFIC_DIMS = ['bucket', 'key_id', 'kind', 'deployment_id', 'mcp_server_id', 'tool', 'model_requested', 'on_behalf_of', 'rule_id'] as const;


const SEP = '|';

/** Follows each call from start to finish and sums it into the summaries; the writer drains them after each batch. */
export class Accumulator {
  readonly hourly = new Map<string, RollupAcc>();
  readonly daily = new Map<string, RollupAcc>();
  readonly traffic = new Map<string, TrafficAcc>();
  private startedById = new Map<string, FlightStarted>();
  private heldIds = new Set<string>();
  /** The gate that decided each call in flight. */
  private ruleOf = new Map<string, string>();

  started(e: FlightStarted): void {
    this.startedById.set(e.flight_id, e);
  }
  decision(e: FlightDecision): void {
    if (e.rule_id) this.ruleOf.set(e.flight_id, e.rule_id);
  }
  held(e: FlightHeld): void {
    this.heldIds.add(e.flight_id);
  }

  completed(e: FlightCompleted): void {
    const s = this.startedById.get(e.flight_id);
    const keyId = s?.key_id ?? '';
    // Tool calls have no deployment: attribute them to their MCP server.
    const depId = e.deployment_id ?? s?.deployment_id ?? s?.mcp_server_id ?? '';
    const aliasId = s?.alias_id ?? '';
    const kind = s?.kind ?? '';
    const wasHeld = this.heldIds.has(e.flight_id);
    const targets: Array<[Map<string, RollupAcc>, string]> = [
      [this.hourly, hourBucket(e.ts)],
      [this.daily, dayBucket(e.ts)],
    ];
    // Traffic by the hour per path. A call whose start this process didn't see (it began before a restart) has no path to count.
    if (s) {
      const chain = s.on_behalf_of?.length ? JSON.stringify(s.on_behalf_of) : '';
      const k = [Math.floor(s.ts / 3_600_000) * 3_600_000, keyId, kind, e.deployment_id ?? s.deployment_id ?? '', s.mcp_server_id ?? '', s.tool ?? '', s.model_requested, chain, this.ruleOf.get(e.flight_id) ?? ''].join(TSEP);
      const t = this.traffic.get(k) ?? this.traffic.set(k, { requests: 0, errors: 0, denied: 0, rejected: 0, ticketed: 0, held: 0, cost_nanousd: 0, tokens: 0, last_ts: 0 }).get(k)!;
      t.requests += 1;
      if (e.status === 'error') t.errors += 1;
      if (e.status === 'denied') t.denied += 1;
      if (e.status === 'rejected') t.rejected += 1;
      if (e.status === 'ticketed') t.ticketed += 1;
      if (wasHeld) t.held += 1;
      if (e.cost_nanousd != null) t.cost_nanousd += Math.round(e.cost_nanousd);
      if (e.usage) t.tokens += e.usage.input + e.usage.output;
      t.last_ts = Math.max(t.last_ts, s.ts);
    }
    for (const [map, bucket] of targets) {
      const k = [bucket, keyId, depId, aliasId, kind].join(SEP);
      let acc = map.get(k);
      if (!acc) {
        acc = emptyAcc();
        map.set(k, acc);
      }
      acc.requests += 1;
      if (e.status === 'error') acc.errors += 1;
      if (e.status === 'denied' || e.status === 'rejected' || e.status === 'ticketed') acc.denied += 1;
      if (wasHeld) acc.held += 1;
      if (e.usage) {
        acc.in_tokens += e.usage.input;
        acc.out_tokens += e.usage.output;
        acc.cache_r += e.usage.cacheRead ?? 0;
        acc.cache_w += e.usage.cacheWrite ?? 0;
      }
      if (e.cost_nanousd != null) acc.cost_nanousd += e.cost_nanousd;
      if (e.status === 'ok') {
        acc.lat_sum_ms += e.duration_ms;
        acc.lat_count += 1;
        acc.lat_hist[bucketIndex(e.duration_ms)]! += 1;
      }
    }
    this.startedById.delete(e.flight_id);
    this.heldIds.delete(e.flight_id);
    this.ruleOf.delete(e.flight_id);
  }
}
