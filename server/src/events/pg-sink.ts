import type pg from 'pg';
import type { FlightEvent } from '@controltower/shared';
import { Accumulator, TRAFFIC_DIMS, TSEP, type RollupAcc } from './rollups.js';

/**
 * The batched event writer for Postgres (DbSink is SQLite's). Events are appended with no I/O on emit and
 * written every FLUSH_MS in one transaction as a handful of set-based statements — the events; new calls,
 * with everything the batch knows about them; updates to calls started earlier; the summaries — so the
 * round trips per batch stay constant however busy it is. Rows are written in key order, so instances
 * writing the same summaries at once don't deadlock; a batch that fails is retried, not dropped.
 */

const FLUSH_MS = 50;
const PENDING_MAX = 2000;
const BACKLOG_CAP = 100_000;
const CHUNK = 1000;

const INSERT_COLS = ['id', 'ts', 'key_id', 'key_name', 'agent_id', 'team', 'project', 'kind', 'dialect', 'model_requested', 'alias_id', 'deployment_id', 'provider_id', 'provider_kind', 'mcp_server_id', 'tool', 'stream', 'on_behalf_of', 'parent_flight_id', 'instance_id', 'endpoint', 'tags', 'customer', 'principal', 'client', 'device'] as const;
/** Columns later events fill in, with their Postgres types (VALUES lists need them spelled out). */
const LATER: Record<string, 'text' | 'bigint'> = {
  decision: 'text', rule_id: 'text', approval_id: 'text', deployment_id: 'text', provider_id: 'text', status: 'text', http_status: 'bigint',
  in_tokens: 'bigint', out_tokens: 'bigint', cache_r: 'bigint', cache_w: 'bigint', reasoning_tokens: 'bigint', usage_source: 'text', cost_nanousd: 'bigint',
  cost_confidence: 'text', ttfb_ms: 'bigint', ttft_ms: 'bigint', duration_ms: 'bigint', overhead_ms: 'bigint', error_code: 'text', error_message: 'text', completed_at: 'bigint', units: 'text', cache_hit: 'bigint',
};
type Row = Record<string, string | number | null>;
const int = (v: number | null | undefined) => (v == null ? null : Math.round(v));

export class PgSink {
  private pending: FlightEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private seq = new Map<string, number>();
  private acc = new Accumulator();
  /** Events already numbered and counted: a batch that is retried is written as it was, not counted twice. */
  private seqOf = new WeakMap<FlightEvent, number>();
  public backpressure = false;
  public flushedEvents = 0;

  constructor(
    private readonly pool: pg.Pool,
    private readonly instanceId: string | null = null,
    private readonly onError: (err: unknown) => void = (e) => console.error('[pg-sink]', e),
  ) {}

  push = (e: FlightEvent): void => {
    this.pending.push(e);
    if (this.pending.length >= BACKLOG_CAP) this.backpressure = true;
    if (this.pending.length >= PENDING_MAX) void this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), FLUSH_MS);
      this.timer.unref?.();
    }
  };

  get pendingCount(): number {
    return this.pending.length;
  }

  /** Write what is pending; one batch at a time. Resolves when everything pending now is written (or failed). */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.flushing) return this.flushing.then(() => (this.pending.length ? this.flush() : undefined));
    if (!this.pending.length) return Promise.resolve();
    const batch = this.pending;
    this.pending = [];
    this.flushing = this.write(batch)
      .then(() => {
        this.flushedEvents += batch.length;
        this.backpressure = this.pending.length >= BACKLOG_CAP;
      })
      .catch((err) => {
        this.onError(err);
        // Keep the events (up to the cap) and try again shortly: Postgres may be restarting.
        if (this.pending.length + batch.length <= BACKLOG_CAP) this.pending = [...batch, ...this.pending];
        if (!this.timer) {
          this.timer = setTimeout(() => void this.flush(), 1000);
          this.timer.unref?.();
        }
      })
      .finally(() => {
        this.flushing = null;
      });
    return this.flushing;
  }

  private async write(batch: FlightEvent[]): Promise<void> {
    const events: unknown[][] = [];
    const fresh = new Map<string, Row>();
    const later = new Map<string, Row>();
    // Summaries are computed from a copy of the accumulator's state, so a failed write can be retried as it was.
    for (const e of batch) {
      const first = !this.seqOf.has(e);
      if (first) {
        const n = (this.seq.get(e.flight_id) ?? 0) + 1;
        this.seq.set(e.flight_id, n);
        this.seqOf.set(e, n);
      }
      events.push([e.flight_id, this.seqOf.get(e)!, e.ts, e.t, JSON.stringify(e)]);
      const count = first ? this.acc : undefined;
      const row = (): Row => fresh.get(e.flight_id) ?? later.get(e.flight_id) ?? later.set(e.flight_id, {}).get(e.flight_id)!;
      switch (e.t) {
        case 'flight.started':
          count?.started(e);
          fresh.set(e.flight_id, {
            id: e.flight_id, ts: e.ts, key_id: e.key_id, key_name: e.key_name, agent_id: e.agent_id ?? null, team: e.team ?? null, project: e.project ?? null,
            kind: e.kind, dialect: e.dialect, model_requested: e.model_requested, alias_id: e.alias_id ?? null, deployment_id: e.deployment_id ?? null,
            provider_id: e.provider_id ?? null, provider_kind: e.provider_kind ?? null, mcp_server_id: e.mcp_server_id ?? null, tool: e.tool ?? null,
            stream: e.stream ? 1 : 0, on_behalf_of: e.on_behalf_of?.length ? JSON.stringify(e.on_behalf_of) : null, parent_flight_id: e.parent_flight_id ?? null,
            instance_id: this.instanceId, endpoint: e.endpoint ?? null, tags: e.tags?.length ? JSON.stringify(e.tags) : null, customer: e.customer ?? null,
            principal: e.principal ?? null,
            client: e.client ?? null,
            device: e.device ?? null,
          });
          later.delete(e.flight_id);
          break;
        case 'flight.decision': {
          const r = row();
          r.decision = e.decision;
          if (e.rule_id) r.rule_id = e.rule_id;
          count?.decision(e);
          break;
        }
        case 'flight.held':
          row().approval_id = e.approval_id;
          count?.held(e);
          break;
        case 'flight.upstream':
          if (e.outcome === 'ok') Object.assign(row(), { deployment_id: e.deployment_id, provider_id: e.provider_id });
          break;
        case 'flight.completed':
          Object.assign(row(), {
            status: e.status, http_status: e.http_status, ...(e.deployment_id ? { deployment_id: e.deployment_id } : {}),
            in_tokens: int(e.usage?.input), out_tokens: int(e.usage?.output), cache_r: int(e.usage?.cacheRead), cache_w: int(e.usage?.cacheWrite),
            reasoning_tokens: int(e.usage?.reasoning), usage_source: e.usage_source, cost_nanousd: int(e.cost_nanousd), cost_confidence: e.cost_confidence,
            ttfb_ms: int(e.ttfb_ms), ttft_ms: int(e.ttft_ms), duration_ms: int(e.duration_ms), overhead_ms: int(e.gateway_overhead_ms),
            error_code: e.error?.code ?? null, error_message: e.error?.message?.slice(0, 500) ?? null, completed_at: e.ts,
            units: e.units ? JSON.stringify(e.units) : null, cache_hit: e.cache_hit ? 1 : null,
          });
          count?.completed(e);
          if (first) this.seq.delete(e.flight_id);
          break;
      }
    }
    const hourly = [...this.acc.hourly];
    const daily = [...this.acc.daily];
    const traffic = [...this.acc.traffic];
    this.acc.hourly.clear();
    this.acc.daily.clear();
    this.acc.traffic.clear();

    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      for (const part of chunks(events.sort((a, b) => cmp(a[0], b[0]) || (a[1] as number) - (b[1] as number)), CHUNK)) {
        await c.query(`INSERT INTO flight_events (flight_id, seq, ts, type, payload) VALUES ${placeholders(part.length, 5)} ON CONFLICT DO NOTHING`, part.flat());
      }
      const freshRows = [...fresh.values()].sort((a, b) => cmp(a.id, b.id));
      const cols = [...INSERT_COLS, ...Object.keys(LATER).filter((k) => !(INSERT_COLS as readonly string[]).includes(k))];
      for (const part of chunks(freshRows, Math.floor(CHUNK / 2))) {
        await c.query(
          `INSERT INTO flights (${cols.join(', ')}) VALUES ${placeholders(part.length, cols.length)}
           ON CONFLICT (id) DO UPDATE SET ${Object.keys(LATER).map((k) => `${k} = COALESCE(EXCLUDED.${k}, flights.${k})`).join(', ')}`,
          part.flatMap((r) => cols.map((k) => r[k] ?? null)),
        );
      }
      const laterRows = [...later].sort((a, b) => cmp(a[0], b[0]));
      const lcols = Object.keys(LATER);
      for (const part of chunks(laterRows, Math.floor(CHUNK / 2))) {
        await c.query(
          `UPDATE flights AS f SET ${lcols.map((k) => `${k} = COALESCE(v.${k}::${LATER[k]}, f.${k})`).join(', ')}
           FROM (VALUES ${placeholders(part.length, lcols.length + 1)}) AS v(id, ${lcols.join(', ')}) WHERE f.id = v.id`,
          part.flatMap(([id, r]) => [id, ...lcols.map((k) => r[k] ?? null)]),
        );
      }
      for (const [table, map] of [['usage_hourly', hourly], ['usage_daily', daily]] as const) await this.rollups(c, table, map);
      await this.traffic(c, traffic);
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      // Put the summaries back so a retry counts them.
      for (const [k, a] of hourly) mergeInto(this.acc.hourly, k, a);
      for (const [k, a] of daily) mergeInto(this.acc.daily, k, a);
      for (const [k, a] of traffic) {
        const t = this.acc.traffic.get(k);
        if (!t) this.acc.traffic.set(k, a);
        else for (const f of Object.keys(a) as Array<keyof typeof a>) t[f] = f === 'last_ts' ? Math.max(t[f], a[f]) : t[f] + a[f];
      }
      throw err;
    } finally {
      c.release();
    }
  }

  private async rollups(c: pg.PoolClient, table: 'usage_hourly' | 'usage_daily', map: Array<[string, RollupAcc]>): Promise<void> {
    if (!map.length) return;
    const rows = map.sort((a, b) => cmp(a[0], b[0])).map(([k, a]) => [...k.split('|'), a.requests, a.errors, a.denied, a.held, a.in_tokens, a.out_tokens, a.cache_r, a.cache_w, Math.round(a.cost_nanousd), Math.round(a.lat_sum_ms), a.lat_count, JSON.stringify(a.lat_hist)]);
    const sum = ['requests', 'errors', 'denied', 'held', 'in_tokens', 'out_tokens', 'cache_r', 'cache_w', 'cost_nanousd', 'lat_sum_ms', 'lat_count'];
    for (const part of chunks(rows, CHUNK / 2)) {
      await c.query(
        `INSERT INTO ${table} (bucket, key_id, deployment_id, alias_id, kind, ${sum.join(', ')}, lat_hist) VALUES ${placeholders(part.length, 17)}
         ON CONFLICT (bucket, key_id, deployment_id, alias_id, kind) DO UPDATE SET ${sum.map((k) => `${k} = ${table}.${k} + EXCLUDED.${k}`).join(', ')},
           lat_hist = (SELECT json_agg(a + b)::text FROM unnest(ARRAY(SELECT json_array_elements_text(${table}.lat_hist::json)::bigint), ARRAY(SELECT json_array_elements_text(EXCLUDED.lat_hist::json)::bigint)) AS t(a, b))`,
        part.flat(),
      );
    }
  }

  private async traffic(c: pg.PoolClient, map: Array<[string, { requests: number; errors: number; denied: number; rejected: number; ticketed: number; held: number; cost_nanousd: number; tokens: number; last_ts: number }]>): Promise<void> {
    if (!map.length) return;
    const measures = ['requests', 'errors', 'denied', 'rejected', 'ticketed', 'held', 'cost_nanousd', 'tokens'] as const;
    const rows = map.sort((a, b) => cmp(a[0], b[0])).map(([k, a]) => {
      const d = k.split(TSEP);
      return [Number(d[0]), ...d.slice(1), ...measures.map((m) => Math.round(a[m])), a.last_ts];
    });
    const n = TRAFFIC_DIMS.length + measures.length + 1;
    for (const part of chunks(rows, Math.floor(CHUNK / 2))) {
      await c.query(
        `INSERT INTO traffic_hourly (${TRAFFIC_DIMS.join(', ')}, ${measures.join(', ')}, last_ts) VALUES ${placeholders(part.length, n)}
         ON CONFLICT (${TRAFFIC_DIMS.join(', ')}) DO UPDATE SET ${measures.map((m) => `${m} = traffic_hourly.${m} + EXCLUDED.${m}`).join(', ')}, last_ts = GREATEST(traffic_hourly.last_ts, EXCLUDED.last_ts)`,
        part.flat(),
      );
    }
  }
}

function placeholders(rows: number, cols: number): string {
  const out: string[] = [];
  let i = 1;
  for (let r = 0; r < rows; r++) out.push(`(${Array.from({ length: cols }, () => `$${i++}`).join(', ')})`);
  return out.join(', ');
}
function* chunks<T>(xs: T[], n: number): Generator<T[]> {
  for (let i = 0; i < xs.length; i += n) yield xs.slice(i, i + n);
}
const cmp = (a: unknown, b: unknown) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
function mergeInto(map: Map<string, RollupAcc>, k: string, a: RollupAcc): void {
  const t = map.get(k);
  if (!t) return void map.set(k, a);
  for (const f of ['requests', 'errors', 'denied', 'held', 'in_tokens', 'out_tokens', 'cache_r', 'cache_w', 'cost_nanousd', 'lat_sum_ms', 'lat_count'] as const) t[f] += a[f];
  t.lat_hist = t.lat_hist.map((v, i) => v + (a.lat_hist[i] ?? 0));
}
