import { ulid } from 'ulid';
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';
import { SpendTracker, nextReset, periodStart, type BudgetScope } from './limiter.js';
import { NANO_PER_USD } from '@controltower/shared';

/**
 * Loads budget rows into the in-memory SpendTracker and writes settled spend back every few seconds, so a
 * restart does not reset the meter. What is written is what this instance spent since it last wrote (added
 * to the stored total), and what comes back is the total — so several instances sharing a database meter
 * one budget together. A period that rolls over is reset once, by whichever instance gets there first.
 */
/** A region's spend on one budget since it last told the control plane. */
export interface BudgetDelta {
  scope: string;
  delta: number;
  prev_resets_at: number | null;
  resets_at: number | null;
}

export class Budgets {
  private timer: NodeJS.Timeout | undefined;
  /** Per scope: the stored total and period this instance last saw. Spend above it is not written yet. */
  private synced = new Map<string, { spent: number; resetsAt: number | undefined }>();

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
      // Spend this instance hasn't written yet stays on top of the stored total.
      const unwritten = existing ? Math.max(0, existing.spent - (this.synced.get(scope)?.spent ?? existing.spent)) : 0;
      const b: BudgetScope = {
        limitNanousd: r.limit_nanousd,
        hard: r.hard === 1,
        spent: r.spent_nanousd + unwritten,
        reserved: existing?.reserved ?? 0,
        period: r.period as BudgetScope['period'],
        resetsAt: r.resets_at ?? undefined,
      };
      this.tracker.set(scope, b);
      this.synced.set(scope, { spent: r.spent_nanousd, resetsAt: r.resets_at ?? undefined });
    }
    // Drop scopes deleted in the DB.
    for (const s of this.snapshot().map((x) => x.scope)) if (!seen.has(s)) this.tracker.delete(s);
  }

  /**
   * Create or change a budget. A new budget — or one whose period changes —
   * starts from what the scope has already spent in the current period, so a
   * monthly team budget set mid-month counts the month so far.
   */
  async upsert(scopeType: 'key' | 'team' | 'project' | 'customer', scopeId: string, limitUsd: number, period: BudgetScope['period'], hard: boolean): Promise<void> {
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
      this.synced.delete(`${scopeType}:${scopeId}`);
    }
    await this.reload();
  }

  /** Recorded spend of a key, team or project since a time (retained flights only). */
  async spentSince(scopeType: 'key' | 'team' | 'project' | 'customer', scopeId: string, since: number): Promise<number> {
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
    this.synced.delete(`${scopeType}:${scopeId}`);
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

  /**
   * A region (multi-region, Enterprise): the control plane keeps every budget's total across regions, so this
   * install sends it what it spent (remoteItems) and takes the total back (settleRemote). Its own database keeps a
   * copy of the total, to start from after a restart.
   */
  regional = false;

  /** Spend since the last word with the control plane, per budget (and whether the period rolled over here). */
  remoteItems(): { items: BudgetDelta[]; base: Map<string, { prevSpent: number; delta: number }> } {
    const items: BudgetDelta[] = [];
    const base = new Map<string, { prevSpent: number; delta: number }>();
    for (const s of this.snapshot()) {
      const b = this.tracker.get(s.scope);
      if (!b) continue;
      const prev = this.synced.get(s.scope) ?? { spent: b.spent, resetsAt: b.resetsAt };
      const rolled = b.resetsAt !== prev.resetsAt;
      const prevSpent = rolled ? 0 : prev.spent;
      const delta = Math.round(b.spent - prevSpent);
      items.push({ scope: s.scope, delta, prev_resets_at: prev.resetsAt ?? null, resets_at: b.resetsAt ?? null });
      base.set(s.scope, { prevSpent, delta });
    }
    return { items, base };
  }

  /** The totals the control plane answered: this install meters from them (plus what it spent meanwhile). */
  async settleRemote(totals: Array<{ scope: string; spent: number; resets_at: number | null }>, base: Map<string, { prevSpent: number; delta: number }>): Promise<void> {
    for (const t of totals) {
      const b = this.tracker.get(t.scope);
      const sent = base.get(t.scope);
      if (!b || !sent) continue;
      const extra = b.spent - sent.prevSpent - sent.delta;
      if (t.resets_at != null && (b.resetsAt == null || t.resets_at > b.resetsAt)) b.resetsAt = t.resets_at;
      b.spent = t.spent + extra;
      this.synced.set(t.scope, { spent: t.spent, resetsAt: b.resetsAt });
      const [scopeType, ...rest] = t.scope.split(':');
      await this.db.updateTable('budgets').set({ spent_nanousd: Math.round(t.spent), resets_at: b.resetsAt ?? null }).where('scope_type', '=', scopeType!).where('scope_id', '=', rest.join(':')).execute().catch(() => undefined);
    }
  }

  /** On the control plane: a region's spend added to each budget's total, as one of its own instances would. */
  async applyRemote(items: BudgetDelta[]): Promise<Array<{ scope: string; spent: number; resets_at: number | null }>> {
    const out: Array<{ scope: string; spent: number; resets_at: number | null }> = [];
    for (const it of items) {
      const [scopeType, ...rest] = String(it.scope).split(':');
      const scopeId = rest.join(':');
      const where = <Q extends { where: (...a: any[]) => Q }>(q: Q): Q => q.where('scope_type', '=', scopeType!).where('scope_id', '=', scopeId);
      if (it.resets_at !== it.prev_resets_at && it.resets_at != null) {
        await where(this.db.updateTable('budgets').set({ spent_nanousd: 0, resets_at: it.resets_at }))
          .where((eb) => (it.prev_resets_at == null ? eb('resets_at', 'is', null) : eb('resets_at', '=', it.prev_resets_at)))
          .execute();
      }
      const delta = Math.round(Number(it.delta) || 0);
      if (delta > 0) {
        await where(this.db.updateTable('budgets').set((eb) => ({ spent_nanousd: eb('spent_nanousd', '+', delta) }))).execute();
        // Counted here at once too (not at this install's next write), as spend already stored.
        const b = this.tracker.get(it.scope);
        const seen = this.synced.get(it.scope);
        if (b && seen && seen.resetsAt === b.resetsAt) {
          b.spent += delta;
          seen.spent += delta;
        }
      }
      const row = await where(this.db.selectFrom('budgets').select(['spent_nanousd', 'resets_at'])).executeTakeFirst();
      if (row) out.push({ scope: it.scope, spent: Number(row.spent_nanousd), resets_at: row.resets_at == null ? null : Number(row.resets_at) });
    }
    return out;
  }

  async persist(): Promise<void> {
    // A region's totals come from the control plane (see remoteItems / settleRemote).
    if (this.regional) return;
    for (const s of this.snapshot()) {
      const [scopeType, ...rest] = s.scope.split(':');
      const scopeId = rest.join(':');
      const b = this.tracker.get(s.scope);
      if (!b) continue;
      const where = <Q extends { where: (...a: any[]) => Q }>(q: Q): Q => q.where('scope_type', '=', scopeType!).where('scope_id', '=', scopeId);
      let prev = this.synced.get(s.scope) ?? { spent: b.spent, resetsAt: b.resetsAt };
      // This instance saw the period roll over: reset the stored total, unless another instance already has.
      if (b.resetsAt !== prev.resetsAt) {
        await where(this.db.updateTable('budgets').set({ spent_nanousd: 0, resets_at: b.resetsAt ?? null }))
          .where((eb) => (prev.resetsAt == null ? eb('resets_at', 'is', null) : eb('resets_at', '=', prev.resetsAt)))
          .execute();
        prev = { spent: 0, resetsAt: b.resetsAt };
      }
      const delta = Math.round(b.spent - prev.spent);
      if (delta) await where(this.db.updateTable('budgets').set((eb) => ({ spent_nanousd: eb('spent_nanousd', '+', delta) }))).execute();
      const row = await where(this.db.selectFrom('budgets').select(['spent_nanousd', 'resets_at'])).executeTakeFirst();
      if (!row) continue;
      // Spend settled while this ran stays unwritten, on top of the new total.
      const extra = b.spent - prev.spent - delta;
      if ((row.resets_at ?? undefined) !== b.resetsAt && row.resets_at != null && (b.resetsAt == null || row.resets_at > b.resetsAt)) b.resetsAt = row.resets_at;
      b.spent = row.spent_nanousd + extra;
      this.synced.set(s.scope, { spent: row.spent_nanousd, resetsAt: b.resetsAt });
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.persist();
  }
}
