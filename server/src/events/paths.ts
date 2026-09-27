import type Database from 'better-sqlite3';
import type pg from 'pg';
import type { FlightEvent } from '@controltower/shared';

const FLUSH_MS = 5000;
/** A connection in use has its last-seen time written at most this often. */
const TOUCH_MS = 60_000;
/** Before this much history exists, nothing counts as new: on a fresh install everything is. */
export const LEARNING_MS = 24 * 3600_000;

export interface PathInfo {
  first: number;
  last: number;
}

type PathRow = { agent: string; target: string; tool: string; first_seen: number; last_seen: number };
/** Where connections are kept: SQLite (synchronous) or Postgres, shared by every instance. */
export interface PathsBackend {
  save(rows: PathRow[]): void | Promise<void>;
}

/** Postgres: load the connections, and a backend that writes them (keeping the earliest first use and latest last use). */
export async function postgresPaths(pool: pg.Pool): Promise<{ rows: PathRow[]; backend: PathsBackend }> {
  const rows = (await pool.query<PathRow>('SELECT agent, target, tool, first_seen, last_seen FROM paths')).rows.map((r) => ({ ...r, first_seen: Number(r.first_seen), last_seen: Number(r.last_seen) }));
  return {
    rows,
    backend: {
      async save(list) {
        if (!list.length) return;
        const vals: unknown[] = [];
        const ph = list.map((r, i) => {
          vals.push(r.agent, r.target, r.tool, r.first_seen, r.last_seen);
          return `($${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5})`;
        });
        await pool.query(
          `INSERT INTO paths (agent, target, tool, first_seen, last_seen) VALUES ${ph.join(', ')}
           ON CONFLICT (agent, target, tool) DO UPDATE SET first_seen = LEAST(paths.first_seen, EXCLUDED.first_seen), last_seen = GREATEST(paths.last_seen, EXCLUDED.last_seen)`,
          vals,
        );
      },
    },
  };
}

/**
 * Every connection agents have used — agent (its agent id, else its key) →
 * model deployment or tool server → tool — with when it was first and last
 * used. Kept in memory (one row per connection, so thousands, not millions)
 * and written in batches off the hot path. The map flags a connection first
 * seen in the last day as new: an agent that suddenly reaches a tool it never
 * used is worth a look.
 */
export class PathsStore {
  private paths = new Map<string, PathInfo>();
  private dirty = new Set<string>();
  private written = new Map<string, number>();
  private timer: NodeJS.Timeout;
  private backend: PathsBackend;
  /** When the earliest recorded connection was first used: how long the tower has been watching. */
  since: number | null = null;

  /** SQLite's handle, or connections loaded from Postgres with the backend that writes them. */
  constructor(db: Database.Database | { rows: PathRow[]; backend: PathsBackend }) {
    let rows: PathRow[];
    if ('backend' in db) {
      rows = db.rows;
      this.backend = db.backend;
    } else {
      rows = db.prepare('SELECT agent, target, tool, first_seen, last_seen FROM paths').all() as PathRow[];
      const upsert = db.prepare(`
        INSERT INTO paths (agent, target, tool, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (agent, target, tool) DO UPDATE SET last_seen = MAX(paths.last_seen, excluded.last_seen)`);
      const txn = db.transaction((list: PathRow[]) => {
        for (const r of list) upsert.run(r.agent, r.target, r.tool, r.first_seen, r.last_seen);
      });
      this.backend = { save: (list) => txn(list) };
    }
    for (const r of rows) {
      this.paths.set(key(r.agent, r.target, r.tool), { first: r.first_seen, last: r.last_seen });
      this.written.set(key(r.agent, r.target, r.tool), r.last_seen);
      if (this.since === null || r.first_seen < this.since) this.since = r.first_seen;
    }
    this.timer = setInterval(() => this.flush(), FLUSH_MS);
    this.timer.unref();
  }

  /** Bus sink: note the connection a flight uses. */
  push = (e: FlightEvent): void => {
    if (e.t !== 'flight.started') return;
    const target = e.deployment_id ?? e.mcp_server_id;
    if (!target) return;
    const k = key(e.agent_id ?? e.key_id, target, e.tool ?? '');
    const p = this.paths.get(k);
    if (!p) {
      this.paths.set(k, { first: e.ts, last: e.ts });
      this.dirty.add(k);
      if (this.since === null) this.since = e.ts;
      for (const l of this.newListeners) l();
      return;
    }
    if (e.ts > p.last) p.last = e.ts;
    if (p.last - (this.written.get(k) ?? 0) > TOUCH_MS) this.dirty.add(k);
  };

  private newListeners = new Set<() => void>();
  /** Called when a connection is used for the first time: the map needs a line it doesn't have yet. */
  onNew(fn: () => void): () => void {
    this.newListeners.add(fn);
    return () => this.newListeners.delete(fn);
  }

  get(agent: string, target: string, tool: string | null | undefined): PathInfo | undefined {
    return this.paths.get(key(agent, target, tool ?? ''));
  }

  flush(): void | Promise<void> {
    if (!this.dirty.size) return;
    const keys = [...this.dirty];
    this.dirty.clear();
    const list: PathRow[] = [];
    for (const k of keys) {
      const p = this.paths.get(k);
      if (!p) continue;
      const [agent, target, tool] = k.split('\u0000') as [string, string, string];
      list.push({ agent, target, tool, first_seen: p.first, last_seen: p.last });
    }
    const done = () => {
      for (const r of list) this.written.set(key(r.agent, r.target, r.tool), r.last_seen);
    };
    try {
      const r = this.backend.save(list);
      if (r instanceof Promise)
        return r.then(done, (err: unknown) => {
          console.error('[paths]', err);
          for (const k of keys) this.dirty.add(k);
        });
      done();
    } catch (err) {
      console.error('[paths]', err);
    }
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
  }
}

const key = (agent: string, target: string, tool: string) => `${agent}\u0000${target}\u0000${tool}`;
