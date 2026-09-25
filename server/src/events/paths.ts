import type Database from 'better-sqlite3';
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
  private upsert: Database.Statement;
  private txn: Database.Transaction<(keys: string[]) => void>;
  /** When the earliest recorded connection was first used: how long the tower has been watching. */
  since: number | null = null;

  constructor(db: Database.Database) {
    for (const r of db.prepare('SELECT agent, target, tool, first_seen, last_seen FROM paths').all() as Array<{ agent: string; target: string; tool: string; first_seen: number; last_seen: number }>) {
      this.paths.set(key(r.agent, r.target, r.tool), { first: r.first_seen, last: r.last_seen });
      this.written.set(key(r.agent, r.target, r.tool), r.last_seen);
      if (this.since === null || r.first_seen < this.since) this.since = r.first_seen;
    }
    this.upsert = db.prepare(`
      INSERT INTO paths (agent, target, tool, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (agent, target, tool) DO UPDATE SET last_seen = MAX(paths.last_seen, excluded.last_seen)`);
    this.txn = db.transaction((keys: string[]) => {
      for (const k of keys) {
        const p = this.paths.get(k);
        if (!p) continue;
        const [agent, target, tool] = k.split('\u0000') as [string, string, string];
        this.upsert.run(agent, target, tool, p.first, p.last);
        this.written.set(k, p.last);
      }
    });
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

  flush(): void {
    if (!this.dirty.size) return;
    const keys = [...this.dirty];
    this.dirty.clear();
    try {
      this.txn(keys);
    } catch (err) {
      console.error('[paths]', err);
    }
  }

  stop(): void {
    clearInterval(this.timer);
    this.flush();
  }
}

const key = (agent: string, target: string, tool: string) => `${agent}\u0000${target}\u0000${tool}`;
