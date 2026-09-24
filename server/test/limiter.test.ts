import { describe, expect, it } from 'vitest';
import { MemoryLimiter, SpendTracker, nextReset, periodStart } from '../src/limits/limiter.js';

describe('MemoryLimiter (GCRA)', () => {
  it('admits up to the burst then rejects with a retry-after', () => {
    const l = new MemoryLimiter();
    const now = 1_000_000;
    let ok = 0;
    let first: ReturnType<MemoryLimiter['admit']> | null = null;
    for (let i = 0; i < 70; i++) {
      const r = l.admit('k', 10, { rpm: 60 }, now);
      if (r.ok) ok++;
      else {
        first = r;
        break;
      }
    }
    expect(ok).toBe(60);
    expect(first?.which).toBe('rpm');
    expect(first?.retryAfterMs).toBeGreaterThan(0);
    l.close();
  });

  it('refills over time', () => {
    const l = new MemoryLimiter();
    const now = 5_000_000;
    for (let i = 0; i < 60; i++) l.admit('k', 1, { rpm: 60 }, now);
    expect(l.admit('k', 1, { rpm: 60 }, now).ok).toBe(false);
    expect(l.admit('k', 1, { rpm: 60 }, now + 1100).ok).toBe(true);
    l.close();
  });

  it('enforces tpm on estimated tokens and reconciles', () => {
    const l = new MemoryLimiter();
    const now = 9_000_000;
    expect(l.admit('k', 50_000, { tpm: 60_000 }, now).ok).toBe(true);
    expect(l.admit('k', 20_000, { tpm: 60_000 }, now).which).toBe('tpm');
    // Actual usage was much lower than estimated: give the tokens back.
    l.reconcile('k', -45_000, { tpm: 60_000 }, now);
    expect(l.admit('k', 20_000, { tpm: 60_000 }, now).ok).toBe(true);
    l.close();
  });

  it('caps parallel slots', () => {
    const l = new MemoryLimiter();
    const a = l.acquireSlot('k', 2);
    const b = l.acquireSlot('k', 2);
    expect(a && b).toBeTruthy();
    expect(l.acquireSlot('k', 2)).toBeNull();
    a?.();
    expect(l.acquireSlot('k', 2)).not.toBeNull();
    l.close();
  });
});

describe('SpendTracker', () => {
  it('reserves projected cost and settles to actual', () => {
    const s = new SpendTracker();
    s.set('key:a', { limitNanousd: 1_000, hard: true, spent: 0, reserved: 0, period: 'total', resetsAt: undefined });
    expect(s.reserve(['key:a'], 600)).toBeNull();
    expect(s.reserve(['key:a'], 600)?.scope).toBe('key:a');
    s.settle(['key:a'], 600, 100);
    expect(s.get('key:a')?.spent).toBe(100);
    expect(s.get('key:a')?.reserved).toBe(0);
    expect(s.reserve(['key:a'], 600)).toBeNull();
  });

  it('soft budgets flag instead of blocking', () => {
    const s = new SpendTracker();
    s.set('team:t', { limitNanousd: 10, hard: false, spent: 50, reserved: 0, period: 'total', resetsAt: undefined });
    expect(s.reserve(['team:t'], 5)).toBeNull();
    expect(s.softOver(['team:t'])).toBe('team:t');
  });
});

describe('budget periods', () => {
  it('start at the beginning of the UTC day, week (Monday) and month', () => {
    const at = Date.UTC(2026, 8, 24, 15, 30); // Thursday 24 Sep 2026
    expect(periodStart('daily', at)).toBe(Date.UTC(2026, 8, 24));
    expect(periodStart('weekly', at)).toBe(Date.UTC(2026, 8, 21));
    expect(periodStart('monthly', at)).toBe(Date.UTC(2026, 8, 1));
    expect(periodStart('total', at)).toBe(0);
    for (const p of ['daily', 'weekly', 'monthly'] as const) expect(nextReset(p, at)! > periodStart(p, at)).toBe(true);
  });
});
