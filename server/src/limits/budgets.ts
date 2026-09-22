import { ulid } from 'ulid';
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';
import { SpendTracker, nextReset, type BudgetScope } from './limiter.js';
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

  async upsert(scopeType: 'key' | 'team' | 'project', scopeId: string, limitUsd: number, period: BudgetScope['period'], hard: boolean): Promise<void> {
    const limit = Math.round(limitUsd * NANO_PER_USD);
    const resets = nextReset(period) ?? null;
    await this.db
      .insertInto('budgets')
      .values({ id: ulid(), scope_type: scopeType, scope_id: scopeId, limit_nanousd: limit, period, hard: hard ? 1 : 0, resets_at: resets, spent_nanousd: 0 })
      .onConflict((oc) => oc.columns(['scope_type', 'scope_id']).doUpdateSet({ limit_nanousd: limit, period, hard: hard ? 1 : 0, resets_at: resets }))
      .execute();
    await this.reload();
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
