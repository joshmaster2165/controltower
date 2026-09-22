import type Database from 'better-sqlite3';
import type { FlightEvent, FlightCompleted, FlightStarted } from '@controltower/shared';

/**
 * Batched single-writer persistence. Events are appended to a pending array
 * on emit (no I/O) and flushed every FLUSH_MS or when PENDING_MAX is reached,
 * in one transaction: events, flights upsert, incremental rollups.
 *
 * Rollups are written incrementally so raw flights can be deleted by
 * retention without losing spend history.
 */

const FLUSH_MS = 50;
const PENDING_MAX = 500;
const BACKLOG_CAP = 100_000;
const SEP = '|';

/** Log-spaced latency buckets (ms), last is +inf. */
export const LAT_BUCKETS = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 30000, Infinity];

function bucketIndex(ms: number): number {
  for (let i = 0; i < LAT_BUCKETS.length; i++) if (ms <= LAT_BUCKETS[i]!) return i;
  return LAT_BUCKETS.length - 1;
}

interface RollupAcc {
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

function emptyAcc(): RollupAcc {
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

type RollupTable = 'usage_hourly' | 'usage_daily';

export class DbSink {
  private pending: FlightEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private seq = new Map<string, number>();
  private started = new Map<string, FlightStarted>();
  private held = new Set<string>();
  private hourly = new Map<string, RollupAcc>();
  private daily = new Map<string, RollupAcc>();
  private stmts: {
    insertEvent: Database.Statement;
    insertFlight: Database.Statement;
    decision: Database.Statement;
    held: Database.Statement;
    upstream: Database.Statement;
    complete: Database.Statement;
    rollupGet: Record<RollupTable, Database.Statement>;
    rollupUpsert: Record<RollupTable, Database.Statement>;
  };
  private txn: Database.Transaction<(events: FlightEvent[]) => void>;
  public backpressure = false;
  public flushedEvents = 0;

  constructor(
    db: Database.Database,
    private readonly onError: (err: unknown) => void = (e) => console.error('[db-sink]', e),
  ) {
    this.stmts = {
      insertEvent: db.prepare(
        'INSERT OR IGNORE INTO flight_events (flight_id, seq, ts, type, payload) VALUES (?, ?, ?, ?, ?)',
      ),
      insertFlight: db.prepare(`
        INSERT INTO flights (id, ts, key_id, key_name, agent_id, team, project, kind, dialect, model_requested,
          alias_id, deployment_id, provider_id, provider_kind, mcp_server_id, tool, stream)
        VALUES (@id, @ts, @key_id, @key_name, @agent_id, @team, @project, @kind, @dialect, @model_requested,
          @alias_id, @deployment_id, @provider_id, @provider_kind, @mcp_server_id, @tool, @stream)
        ON CONFLICT(id) DO UPDATE SET
          deployment_id = COALESCE(excluded.deployment_id, flights.deployment_id),
          provider_id = COALESCE(excluded.provider_id, flights.provider_id)`),
      decision: db.prepare('UPDATE flights SET decision = ?, rule_id = COALESCE(?, rule_id) WHERE id = ?'),
      held: db.prepare('UPDATE flights SET approval_id = ? WHERE id = ?'),
      upstream: db.prepare('UPDATE flights SET deployment_id = ?, provider_id = ? WHERE id = ?'),
      complete: db.prepare(`
        UPDATE flights SET status = @status, http_status = @http_status,
          deployment_id = COALESCE(@deployment_id, deployment_id),
          in_tokens = @in_tokens, out_tokens = @out_tokens, cache_r = @cache_r, cache_w = @cache_w,
          reasoning_tokens = @reasoning_tokens, usage_source = @usage_source, cost_nanousd = @cost_nanousd,
          cost_confidence = @cost_confidence, ttfb_ms = @ttfb_ms, ttft_ms = @ttft_ms, duration_ms = @duration_ms,
          overhead_ms = @overhead_ms, error_code = @error_code, error_message = @error_message, completed_at = @ts
        WHERE id = @id`),
      rollupGet: {
        usage_hourly: db.prepare(
          'SELECT lat_hist FROM usage_hourly WHERE bucket=? AND key_id=? AND deployment_id=? AND alias_id=? AND kind=?',
        ),
        usage_daily: db.prepare(
          'SELECT lat_hist FROM usage_daily WHERE bucket=? AND key_id=? AND deployment_id=? AND alias_id=? AND kind=?',
        ),
      },
      rollupUpsert: {
        usage_hourly: db.prepare(rollupUpsertSql('usage_hourly')),
        usage_daily: db.prepare(rollupUpsertSql('usage_daily')),
      },
    };
    this.txn = db.transaction((events: FlightEvent[]) => this.apply(events));
  }

  /** Called synchronously from the bus. No I/O. */
  push = (e: FlightEvent): void => {
    this.pending.push(e);
    if (this.pending.length >= BACKLOG_CAP) {
      this.backpressure = true;
      this.flush();
      return;
    }
    if (this.pending.length >= PENDING_MAX) {
      this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), FLUSH_MS);
      this.timer.unref?.();
    }
  };

  get pendingCount(): number {
    return this.pending.length;
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    try {
      this.txn(batch);
      this.flushedEvents += batch.length;
      this.backpressure = false;
    } catch (err) {
      this.onError(err);
    }
  }

  private apply(events: FlightEvent[]): void {
    for (const e of events) {
      const seq = (this.seq.get(e.flight_id) ?? 0) + 1;
      this.seq.set(e.flight_id, seq);
      this.stmts.insertEvent.run(e.flight_id, seq, e.ts, e.t, JSON.stringify(e));

      switch (e.t) {
        case 'flight.started':
          this.started.set(e.flight_id, e);
          this.stmts.insertFlight.run({
            id: e.flight_id,
            ts: e.ts,
            key_id: e.key_id,
            key_name: e.key_name,
            agent_id: e.agent_id ?? null,
            team: e.team ?? null,
            project: e.project ?? null,
            kind: e.kind,
            dialect: e.dialect,
            model_requested: e.model_requested,
            alias_id: e.alias_id ?? null,
            deployment_id: e.deployment_id ?? null,
            provider_id: e.provider_id ?? null,
            provider_kind: e.provider_kind ?? null,
            mcp_server_id: e.mcp_server_id ?? null,
            tool: e.tool ?? null,
            stream: e.stream ? 1 : 0,
          });
          break;
        case 'flight.decision':
          this.stmts.decision.run(e.decision, e.rule_id ?? null, e.flight_id);
          break;
        case 'flight.held':
          this.held.add(e.flight_id);
          this.stmts.held.run(e.approval_id, e.flight_id);
          break;
        case 'flight.resolved':
          break;
        case 'flight.upstream':
          if (e.outcome === 'ok') this.stmts.upstream.run(e.deployment_id, e.provider_id, e.flight_id);
          break;
        case 'flight.completed':
          this.stmts.complete.run({
            id: e.flight_id,
            ts: e.ts,
            status: e.status,
            http_status: e.http_status,
            deployment_id: e.deployment_id ?? null,
            in_tokens: e.usage?.input ?? null,
            out_tokens: e.usage?.output ?? null,
            cache_r: e.usage?.cacheRead ?? null,
            cache_w: e.usage?.cacheWrite ?? null,
            reasoning_tokens: e.usage?.reasoning ?? null,
            usage_source: e.usage_source,
            cost_nanousd: e.cost_nanousd,
            cost_confidence: e.cost_confidence,
            ttfb_ms: e.ttfb_ms == null ? null : Math.round(e.ttfb_ms),
            ttft_ms: e.ttft_ms == null ? null : Math.round(e.ttft_ms),
            duration_ms: Math.round(e.duration_ms),
            overhead_ms: Math.round(e.gateway_overhead_ms),
            error_code: e.error?.code ?? null,
            error_message: e.error?.message?.slice(0, 500) ?? null,
          });
          this.accumulate(e);
          this.seq.delete(e.flight_id);
          this.started.delete(e.flight_id);
          this.held.delete(e.flight_id);
          break;
      }
    }
    this.flushRollups('usage_hourly', this.hourly);
    this.flushRollups('usage_daily', this.daily);
  }

  private accumulate(e: FlightCompleted): void {
    const s = this.started.get(e.flight_id);
    const keyId = s?.key_id ?? '';
    const depId = e.deployment_id ?? s?.deployment_id ?? '';
    const aliasId = s?.alias_id ?? '';
    const kind = s?.kind ?? '';
    const wasHeld = this.held.has(e.flight_id);
    const targets: Array<[Map<string, RollupAcc>, string]> = [
      [this.hourly, hourBucket(e.ts)],
      [this.daily, dayBucket(e.ts)],
    ];
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
  }

  private flushRollups(table: RollupTable, map: Map<string, RollupAcc>): void {
    if (map.size === 0) return;
    for (const [k, acc] of map) {
      const [bucket, keyId, depId, aliasId, kind] = k.split(SEP) as [string, string, string, string, string];
      const existing = this.stmts.rollupGet[table].get(bucket, keyId, depId, aliasId, kind) as
        | { lat_hist: string }
        | undefined;
      let hist = acc.lat_hist;
      if (existing) {
        try {
          const prev = JSON.parse(existing.lat_hist) as number[];
          hist = hist.map((v, i) => v + (prev[i] ?? 0));
        } catch {
          /* keep new */
        }
      }
      this.stmts.rollupUpsert[table].run({
        bucket,
        key_id: keyId,
        deployment_id: depId,
        alias_id: aliasId,
        kind,
        requests: acc.requests,
        errors: acc.errors,
        denied: acc.denied,
        held: acc.held,
        in_tokens: acc.in_tokens,
        out_tokens: acc.out_tokens,
        cache_r: acc.cache_r,
        cache_w: acc.cache_w,
        cost_nanousd: Math.round(acc.cost_nanousd),
        lat_sum_ms: Math.round(acc.lat_sum_ms),
        lat_count: acc.lat_count,
        lat_hist: JSON.stringify(hist),
      });
    }
    map.clear();
  }
}

function rollupUpsertSql(table: string): string {
  return `
    INSERT INTO ${table} (bucket, key_id, deployment_id, alias_id, kind, requests, errors, denied, held,
      in_tokens, out_tokens, cache_r, cache_w, cost_nanousd, lat_sum_ms, lat_count, lat_hist)
    VALUES (@bucket, @key_id, @deployment_id, @alias_id, @kind, @requests, @errors, @denied, @held,
      @in_tokens, @out_tokens, @cache_r, @cache_w, @cost_nanousd, @lat_sum_ms, @lat_count, @lat_hist)
    ON CONFLICT(bucket, key_id, deployment_id, alias_id, kind) DO UPDATE SET
      requests = requests + excluded.requests,
      errors = errors + excluded.errors,
      denied = denied + excluded.denied,
      held = held + excluded.held,
      in_tokens = in_tokens + excluded.in_tokens,
      out_tokens = out_tokens + excluded.out_tokens,
      cache_r = cache_r + excluded.cache_r,
      cache_w = cache_w + excluded.cache_w,
      cost_nanousd = cost_nanousd + excluded.cost_nanousd,
      lat_sum_ms = lat_sum_ms + excluded.lat_sum_ms,
      lat_count = lat_count + excluded.lat_count,
      lat_hist = excluded.lat_hist`;
}
