import { ulid } from 'ulid';
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';
import { SpendTracker, nextReset, periodStart, type BudgetScope } from './limiter.js';
import { NANO_PER_USD } from '@controltower/shared';

/**
 * Loads budget rows into the in-memory SpendTracker and persists settled
 * spend back every few seconds so a restart does not reset the meter.
 */
export class Budgets {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly db: Kysely<Database>,
    readonly tracker: SpendTracker,
  ) {}

  async reload(): Promise<void> {
    const rows = await this.db.selectFrom('budgets').selectAll().execute();
    const seen = new Set<string>();
    for (const r of rows) {
      const scope = `${r.scope_type}:${r.scope_id}`;
      seen.add(scope);
      const existing = this.tracker.get(scope);
      const b: BudgetScope = {
        limitNanousd: r.limit_nanousd,
        hard: r.hard === 1,
        spent: Math.max(existing?.spent ?? 0, r.spent_nanousd),
        reserved: existing?.reserved ?? 0,
        period: r.period as BudgetScope['period'],
        resetsAt: r.resets_at ?? undefined,
      };
      this.tracker.set(scope, b);
    }
    // Drop scopes deleted in the DB.
    for (const s of this.snapshot().map((x) => x.scope)) if (!seen.has(s)) this.tracker.delete(s);
  }

  /**
   * Create or change a budget. A new budget — or one whose period changes —
   * starts from what the scope has already spent in the current period, so a
   * monthly team budget set mid-month counts the month so far.
   */
  async upsert(scopeType: 'key' | 'team' | 'project', scopeId: string, limitUsd: number, period: BudgetScope['period'], hard: boolean): Promise<void> {
    const limit = Math.round(limitUsd * NANO_PER_USD);
    const existing = await this.db.selectFrom('budgets').select(['period', 'resets_at']).where('scope_type', '=', scopeType).where('scope_id', '=', scopeId).executeTakeFirst();
    const fresh = !existing || existing.period !== period;
    if (!fresh) {
      await this.db.updateTable('budgets').set({ limit_nanousd: limit, hard: hard ? 1 : 0 }).where('scope_type', '=', scopeType).where('scope_id', '=', scopeId).execute();
    } else {
      const spent = await this.spentSince(scopeType, scopeId, periodStart(period));
      const values = { limit_nanousd: limit, period, hard: hard ? 1 : 0, resets_at: nextReset(period) ?? null, spent_nanousd: spent };
      await this.db
        .insertInto('budgets')
        .values({ id: ulid(), scope_type: scopeType, scope_id: scopeId, ...values })
        .onConflict((oc) => oc.columns(['scope_type', 'scope_id']).doUpdateSet(values))
        .execute();
      this.tracker.delete(`${scopeType}:${scopeId}`); // the meter restarts from the recorded spend
    }
    await this.reload();
  }

  /** Recorded spend of a key, team or project since a time (retained flights only). */
  async spentSince(scopeType: 'key' | 'team' | 'project', scopeId: string, since: number): Promise<number> {
    const column = scopeType === 'key' ? 'key_id' : scopeType;
    const row = await this.db
      .selectFrom('flights')
      .select((eb) => eb.fn.sum<number>('cost_nanousd').as('spent'))
      .where(column, '=', scopeId)
      .where('ts', '>=', since)
      .executeTakeFirst();
    return Number(row?.spent ?? 0);
  }

  async remove(scopeType: string, scopeId: string): Promise<void> {
    await this.db.deleteFrom('budgets').where('scope_type', '=', scopeType).where('scope_id', '=', scopeId).execute();
    this.tracker.delete(`${scopeType}:${scopeId}`);
  }

  snapshot(): Array<{ scope: string; limit_nanousd: number; spent_nanousd: number; reserved_nanousd: number; hard: boolean; period: string; resets_at: number | undefined }> {
    const out: Array<{ scope: string; limit_nanousd: number; spent_nanousd: number; reserved_nanousd: number; hard: boolean; period: string; resets_at: number | undefined }> = [];
    for (const [scope, b] of (this.tracker as unknown as { scopes: Map<string, BudgetScope> }).scopes) {
      out.push({ scope, limit_nanousd: b.limitNanousd, spent_nanousd: Math.round(b.spent), reserved_nanousd: Math.round(b.reserved), hard: b.hard, period: b.period, resets_at: b.resetsAt });
    }
    return out;
  }

  startPersisting(intervalMs = 10_000): void {
    this.timer = setInterval(() => void this.persist(), intervalMs);
    this.timer.unref?.();
  }

  async persist(): Promise<void> {
    for (const s of this.snapshot()) {
      const [scopeType, ...rest] = s.scope.split(':');
      await this.db
        .updateTable('budgets')
        .set({ spent_nanousd: s.spent_nanousd, resets_at: s.resets_at ?? null })
        .where('scope_type', '=', scopeType!)
        .where('scope_id', '=', rest.join(':'))
        .execute();
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.persist();
  }
}
