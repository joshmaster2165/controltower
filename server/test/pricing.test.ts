import { describe, expect, it } from 'vitest';
import { PricingTable, computeCost, projectCost } from '../src/pricing/index.js';

describe('pricing', () => {
  const t = new PricingTable();

  it('resolves bundled prices and computes exact nanousd', () => {
    const p = t.resolve('anthropic', 'claude-sonnet-4-5');
    expect(p.source).toBe('bundled');
    // 1000 in @ $3/M = $0.003 = 3_000_000 nanousd; 100 out @ $15/M = $0.0015 = 1_500_000
    expect(computeCost({ input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 }, p.entry)).toBe(4_500_000);
  });

  it('falls back from dated snapshots and regional prefixes', () => {
    expect(t.resolve('openai', 'gpt-4o-2024-08-06').entry).toBeDefined();
    // No Bedrock price is bundled: unknown, keyed on the exact model.
    const none = t.resolve('bedrock', 'us.anthropic.claude-sonnet-4-5');
    expect(none.source).toBe('none');
    // Once a price exists for the un-prefixed id, the regional variant resolves to it.
    t.setAdminOverride('bedrock/anthropic.claude-sonnet-4-5', { mode: 'chat', input: 3, output: 15 });
    expect(t.resolve('bedrock', 'us.anthropic.claude-sonnet-4-5').key).toBe('bedrock/anthropic.claude-sonnet-4-5');
    t.setAdminOverride('bedrock/anthropic.claude-sonnet-4-5', null);
  });

  it('applies tiers above the input threshold', () => {
    const p = t.resolve('gemini', 'gemini-2.5-pro').entry!;
    const small = computeCost({ input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 }, p)!;
    const large = computeCost({ input: 300_000, output: 0, cacheRead: 0, cacheWrite: 0 }, p)!;
    expect(small).toBe(1000 * 1250);
    expect(large).toBe(300_000 * 2500);
  });

  it('returns null cost for unknown models and honours overrides', () => {
    expect(t.resolve('openai', 'no-such-model').entry).toBeUndefined();
    expect(computeCost({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, undefined)).toBeNull();
    const o = t.resolve('openai', 'no-such-model', { input: 1, output: 2 });
    expect(o.source).toBe('override');
    expect(projectCost(1_000_000, 0, o.entry)).toBe(1_000_000 * 1000);
  });

  it('admin overrides beat bundled', () => {
    t.setAdminOverride('openai/gpt-4o', { mode: 'chat', input: 0, output: 0 });
    expect(t.resolve('openai', 'gpt-4o').source).toBe('admin');
    t.setAdminOverride('openai/gpt-4o', null);
    expect(t.resolve('openai', 'gpt-4o').source).toBe('bundled');
  });

  it('prices demo (mock) models like the real vendor model, whatever the slug', () => {
    const real = t.resolve('anthropic', 'claude-sonnet-4-5').entry;
    expect(t.resolve('mock', 'claude-sonnet-4-5', undefined, 'anthropic-demo').entry).toEqual(real);
    expect(t.resolve('mock', 'gemini-2.5-flash', undefined, 'gemini').entry).toBeDefined();
    expect(t.resolve('mock', 'mock-smart').key).toBe('mock/mock-smart');
  });
});
