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
export async function closeInterrupted(db: Kysely<Database>, now = Date.now()): Promise<{ flights: number; approvals: number }> {
  const f = await db
    .updateTable('flights')
    .set({ status: 'shutdown', error_code: 'interrupted', error_message: 'Control Tower stopped before this call finished (found unfinished at start)', completed_at: now })
    .where('status', 'is', null)
    .where('ts', '<', now)
    .executeTakeFirst();
  const a = await db
    .updateTable('approvals')
    .set({ status: 'expired', resolved_at: now, note: 'Control Tower restarted while this call was held; the agent was disconnected and got no ticket' })
    .where('status', '=', 'pending')
    .where('requested_at', '<', now)
    .where((eb) => eb.not(eb.exists(eb.selectFrom('tickets').select('tickets.id').whereRef('tickets.approval_id', '=', 'approvals.id'))))
    .executeTakeFirst();
  await db.updateTable('approvals').set({ waiters: 0 }).where('status', '=', 'pending').execute();
  return { flights: Number(f.numUpdatedRows), approvals: Number(a.numUpdatedRows) };
}
