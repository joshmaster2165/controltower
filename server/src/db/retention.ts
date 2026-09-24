import { sql, type Kysely } from 'kysely';
import type { Database } from './schema.js';

/**
 * Data retention. Per-request rows are deleted after a while; the hourly and
 * daily rollups they were counted into stay, so spend and usage history
 * survives. Deletes run in small chunks and yield between them, so live
 * traffic never waits on a long write lock.
 */
export interface RetentionPolicy {
  /** flights (one row per request); 0 keeps them forever */
  flightsDays: number;
  /** flight_events (the per-step trail of each flight); 0 keeps them forever */
  eventsDays: number;
}

const DAY = 24 * 3600 * 1000;
const CHUNK = 5000;
/** Hourly rollups, observed traffic, the alert inbox and approval decisions. */
const HISTORY_DAYS = 90;

type Table = 'flights' | 'flight_events' | 'observed_hourly' | 'paths' | 'alerts' | 'approvals' | 'tickets' | 'grants' | 'sessions' | 'usage_hourly';

async function deleteChunked(db: Kysely<Database>, table: Table, where: ReturnType<typeof sql>): Promise<number> {
  let total = 0;
  for (;;) {
    const r = await sql`DELETE FROM ${sql.table(table)} WHERE rowid IN (SELECT rowid FROM ${sql.table(table)} WHERE ${where} LIMIT ${CHUNK})`.execute(db);
    const n = Number(r.numAffectedRows ?? 0);
    total += n;
    if (n < CHUNK) return total;
    await new Promise((res) => setImmediate(res));
  }
}

/** One pass. Returns rows deleted per table (only tables with deletions). */
export async function applyRetention(db: Kysely<Database>, policy: RetentionPolicy, now = Date.now()): Promise<Record<string, number>> {
  const history = now - HISTORY_DAYS * DAY;
  const out: Record<string, number> = {};
  const run = async (table: Table, where: ReturnType<typeof sql>) => {
    const n = await deleteChunked(db, table, where);
    if (n) out[table] = n;
  };
  if (policy.flightsDays > 0) await run('flights', sql`ts < ${now - policy.flightsDays * DAY}`);
  if (policy.eventsDays > 0) await run('flight_events', sql`ts < ${now - policy.eventsDays * DAY}`);
  await run('usage_hourly', sql`bucket < ${new Date(history).toISOString().slice(0, 13)}`);
  await run('observed_hourly', sql`bucket < ${history}`);
  // A connection unused for 90 days counts as new again when it comes back.
  await run('paths', sql`last_seen < ${history}`);
  await run('alerts', sql`last_at < ${history}`);
  await run('approvals', sql`status != 'pending' AND requested_at < ${history}`);
  await run('tickets', sql`expires_at < ${now - 7 * DAY}`);
  await run('grants', sql`expires_at < ${now - 7 * DAY}`);
  await run('sessions', sql`expires_at < ${now}`);
  return out;
}

/** Runs a pass shortly after start and then every hour. */
export function startRetention(db: Kysely<Database>, policy: RetentionPolicy, log: (deleted: Record<string, number>) => void, onError: (err: unknown) => void): () => void {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    applyRetention(db, policy)
      .then((d) => Object.keys(d).length && log(d))
      .catch(onError)
      .finally(() => (running = false));
  };
  const first = setTimeout(tick, 60_000);
  const every = setInterval(tick, 3600_000);
  first.unref?.();
  every.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
