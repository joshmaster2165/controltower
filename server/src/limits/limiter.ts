/**
 * GCRA (generic cell rate algorithm) rate limiter. A token bucket expressed as
 * a single "theoretical arrival time" per scope, which makes a Redis port a
 * 15-line Lua script with identical semantics.
 */

export interface Admit {
  ok: boolean;
  retryAfterMs: number;
  which?: 'rpm' | 'tpm';
  remaining: { rpm: number; tpm: number };
}

export interface Limits {
  rpm?: number;
  tpm?: number;
}

export interface Limiter {
  admit(scope: string, estTokens: number, limits: Limits, now?: number): Admit;
  /** Charge (actual − estimated) tokens after completion; may be negative. */
  reconcile(scope: string, deltaTokens: number, limits: Limits, now?: number): void;
  acquireSlot(scope: string, max: number): (() => void) | null;
}

interface Gcra {
  tat: number; // theoretical arrival time (ms)
  touched: number;
}

const IDLE_EVICT_MS = 10 * 60 * 1000;

function gcraAdmit(state: Gcra | undefined, cost: number, perMinute: number, now: number): { ok: boolean; tat: number; retryAfterMs: number; remaining: number } {
  const emission = 60_000 / perMinute; // ms per unit
  const burst = 60_000; // one minute of burst capacity
  const tat = Math.max(state?.tat ?? now, now);
  const newTat = tat + cost * emission;
  const allowAt = newTat - burst;
  if (allowAt <= now) {
    const remaining = Math.max(0, Math.floor((now + burst - newTat) / emission));
    return { ok: true, tat: newTat, retryAfterMs: 0, remaining };
  }
  return { ok: false, tat, retryAfterMs: Math.ceil(allowAt - now), remaining: 0 };
}

export class MemoryLimiter implements Limiter {
  private rpm = new Map<string, Gcra>();
  private tpm = new Map<string, Gcra>();
  private slots = new Map<string, number>();
  private sweep: NodeJS.Timeout;

  constructor() {
    this.sweep = setInterval(() => this.evict(), 60_000);
    this.sweep.unref?.();
  }

  admit(scope: string, estTokens: number, limits: Limits, now = Date.now()): Admit {
    let rpmRemaining = Infinity;
    let tpmRemaining = Infinity;
    let rpmNext: Gcra | undefined;
    let tpmNext: Gcra | undefined;

    if (limits.rpm && limits.rpm > 0) {
      const r = gcraAdmit(this.rpm.get(scope), 1, limits.rpm, now);
      if (!r.ok) return { ok: false, retryAfterMs: r.retryAfterMs, which: 'rpm', remaining: { rpm: 0, tpm: tpmRemaining } };
      rpmNext = { tat: r.tat, touched: now };
      rpmRemaining = r.remaining;
    }
    if (limits.tpm && limits.tpm > 0) {
      const t = gcraAdmit(this.tpm.get(scope), Math.max(1, estTokens), limits.tpm, now);
      if (!t.ok) return { ok: false, retryAfterMs: t.retryAfterMs, which: 'tpm', remaining: { rpm: rpmRemaining, tpm: 0 } };
      tpmNext = { tat: t.tat, touched: now };
      tpmRemaining = t.remaining;
    }
    if (rpmNext) this.rpm.set(scope, rpmNext);
    if (tpmNext) this.tpm.set(scope, tpmNext);
    return { ok: true, retryAfterMs: 0, remaining: { rpm: rpmRemaining, tpm: tpmRemaining } };
  }

  reconcile(scope: string, deltaTokens: number, limits: Limits, now = Date.now()): void {
    if (!limits.tpm || limits.tpm <= 0 || deltaTokens === 0) return;
    const st = this.tpm.get(scope);
    if (!st) return;
    const emission = 60_000 / limits.tpm;
    st.tat = Math.max(now, st.tat + deltaTokens * emission);
    st.touched = now;
  }

  acquireSlot(scope: string, max: number): (() => void) | null {
    const cur = this.slots.get(scope) ?? 0;
    if (max > 0 && cur >= max) return null;
    this.slots.set(scope, cur + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.slots.get(scope) ?? 1) - 1;
      if (n <= 0) this.slots.delete(scope);
      else this.slots.set(scope, n);
    };
  }

  private evict(now = Date.now()): void {
    for (const m of [this.rpm, this.tpm]) {
      for (const [k, v] of m) if (now - v.touched > IDLE_EVICT_MS) m.delete(k);
    }
  }

  close(): void {
    clearInterval(this.sweep);
  }
}

/**
 * Budget reservation: spent (settled) + reserved (in-flight projections).
 * Multi-instance deployments replace this with a Redis-backed counter; the
 * interface is the same.
 */
export interface BudgetScope {
  limitNanousd: number;
  hard: boolean;
  spent: number;
  reserved: number;
  period: 'daily' | 'weekly' | 'monthly' | 'total';
  resetsAt: number | undefined;
}

export class SpendTracker {
  private scopes = new Map<string, BudgetScope>();

  set(scope: string, b: BudgetScope): void {
    this.scopes.set(scope, b);
  }
  get(scope: string): BudgetScope | undefined {
    return this.scopes.get(scope);
  }
  delete(scope: string): void {
    this.scopes.delete(scope);
  }
  clear(): void {
    this.scopes.clear();
  }

  /** Returns null when within budget, else the offending scope. */
  reserve(scopes: string[], projected: number, now = Date.now()): { scope: string; b: BudgetScope } | null {
    for (const s of scopes) {
      const b = this.scopes.get(s);
      if (!b) continue;
      this.maybeReset(b, now);
      if (b.hard && b.spent + b.reserved + projected > b.limitNanousd) return { scope: s, b };
    }
    for (const s of scopes) {
      const b = this.scopes.get(s);
      if (b) b.reserved += projected;
    }
    return null;
  }

  settle(scopes: string[], projected: number, actual: number | null): void {
    for (const s of scopes) {
      const b = this.scopes.get(s);
      if (!b) continue;
      b.reserved = Math.max(0, b.reserved - projected);
      b.spent += actual ?? 0;
    }
  }

  softOver(scopes: string[]): string | null {
    for (const s of scopes) {
      const b = this.scopes.get(s);
      if (b && !b.hard && b.spent > b.limitNanousd) return s;
    }
    return null;
  }

  private maybeReset(b: BudgetScope, now: number): void {
    if (b.period === 'total' || !b.resetsAt) return;
    if (now >= b.resetsAt) {
      b.spent = 0;
      b.resetsAt = nextReset(b.period, now);
    }
  }
}

export function nextReset(period: BudgetScope['period'], from = Date.now()): number | undefined {
  const d = new Date(from);
  switch (period) {
    case 'daily':
      d.setUTCHours(24, 0, 0, 0);
      return d.getTime();
    case 'weekly': {
      const day = d.getUTCDay();
      d.setUTCDate(d.getUTCDate() + ((8 - day) % 7 || 7));
      d.setUTCHours(0, 0, 0, 0);
      return d.getTime();
    }
    case 'monthly':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    case 'total':
      return undefined;
  }
}
