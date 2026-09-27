import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';
import type { FlightBus } from './bus.js';
import type { FlightEvent } from '@controltower/shared';

/**
 * Calls in flight right now. A stop that cuts some off — a stream longer than the shutdown grace —
 * records them as stopped instead of leaving them "running" for ever.
 */
export class OpenFlights {
  private open = new Map<string, number>();

  push = (e: FlightEvent): void => {
    if (e.t === 'flight.started') this.open.set(e.flight_id, e.ts);
    else if (e.t === 'flight.completed') this.open.delete(e.flight_id);
  };

  get size(): number {
    return this.open.size;
  }

  /** Record every call still open as stopped by the shutdown. Returns how many. */
  closeAll(bus: FlightBus, now = Date.now()): number {
    const ids = [...this.open];
    for (const [id, started] of ids) {
      bus.emit({
        t: 'flight.completed',
        flight_id: id,
        ts: now,
        status: 'shutdown',
        http_status: 503,
        usage_source: 'unknown',
        cost_nanousd: null,
        cost_confidence: 'unknown',
        duration_ms: Math.max(0, now - started),
        gateway_overhead_ms: 0,
        error: { code: 'shutdown', message: 'Control Tower stopped before this call finished' },
      });
    }
    return ids.length;
  }
}

/**
 * At start, close out what a crash left open: calls with no outcome are marked stopped, and a held
 * call's approval that no agent can come back to — the agent was disconnected and never got a ticket —
 * is expired. (A graceful stop hands held calls tickets; those approvals stay open.)
 */
export async function closeInterrupted(db: Kysely<Database>, now = Date.now(), live: string[] = []): Promise<{ flights: number; approvals: number }> {
  // Only calls served by instances that are no longer running: several may share this database.
  const gone = (eb: any) => (live.length ? eb.or([eb('instance_id', 'is', null), eb('instance_id', 'not in', live)]) : eb.lit(true));
  const orphans = db.selectFrom('flights').select('id').where('status', 'is', null).where('ts', '<', now).where(gone);
  const a = await db
    .updateTable('approvals')
    .set({ status: 'expired', resolved_at: now, waiters: 0, note: 'Control Tower restarted while this call was held; the agent was disconnected and got no ticket' })
    .where('status', '=', 'pending')
    .where('requested_at', '<', now)
    .where('flight_id', 'in', orphans)
    .where((eb) => eb.not(eb.exists(eb.selectFrom('tickets').select('tickets.id').whereRef('tickets.approval_id', '=', 'approvals.id'))))
    .executeTakeFirst();
  const f = await db
    .updateTable('flights')
    .set({ status: 'shutdown', error_code: 'interrupted', error_message: 'Control Tower stopped before this call finished (found unfinished at start)', completed_at: now })
    .where('status', 'is', null)
    .where('ts', '<', now)
    .where(gone)
    .executeTakeFirst();
  return { flights: Number(f.numUpdatedRows), approvals: Number(a.numUpdatedRows) };
}

/** How long an instance may go without saying it is alive before the others treat it as stopped. */
export const INSTANCE_TIMEOUT_MS = Number(process.env.CT_INSTANCE_TIMEOUT_MS ?? 90_000);

/**
 * This instance says it is alive every 15 s, and every minute closes out what stopped instances left open.
 * With one instance that is what the last run left; with several, what a crashed peer left.
 */
export function startInstance(db: Kysely<Database>, o: { id: string; host: string; version: string }, onSwept: (r: { flights: number; approvals: number }) => void, onError: (err: unknown) => void): { stop(): Promise<void>; sweep(): Promise<{ flights: number; approvals: number }> } {
  const beat = async () => {
    const now = Date.now();
    await db
      .insertInto('instances')
      .values({ id: o.id, host: o.host, version: o.version, started_at: now, last_seen: now })
      .onConflict((oc) => oc.column('id').doUpdateSet({ last_seen: now }))
      .execute();
  };
  const sweep = async () => {
    const now = Date.now();
    const live = (await db.selectFrom('instances').select('id').where('last_seen', '>', now - INSTANCE_TIMEOUT_MS).execute()).map((r) => r.id);
    const r = await closeInterrupted(db, now - 5_000, live.includes(o.id) ? live : [...live, o.id]);
    await db.deleteFrom('instances').where('last_seen', '<', now - 24 * 3600_000).execute();
    if (r.flights || r.approvals) onSwept(r);
    return r;
  };
  const hb = setInterval(() => void beat().catch(onError), Math.min(15_000, INSTANCE_TIMEOUT_MS / 4));
  const sw = setInterval(() => void sweep().catch(onError), Math.min(60_000, INSTANCE_TIMEOUT_MS / 2));
  hb.unref?.();
  sw.unref?.();
  return {
    sweep: async () => {
      await beat();
      return sweep();
    },
    async stop() {
      clearInterval(hb);
      clearInterval(sw);
      await db.deleteFrom('instances').where('id', '=', o.id).execute().catch(() => undefined);
    },
  };
}
