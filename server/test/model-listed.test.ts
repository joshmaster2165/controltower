import { describe, expect, it } from 'vitest';
import { listed } from '../src/models/health.js';

describe("a provider's model list", () => {
  it('counts a dated version as the short name (Anthropic lists only dated ids)', () => {
    const anthropic = new Set(['claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001', 'claude-opus-4-1-20250805']);
    expect(listed(anthropic, 'claude-sonnet-4-5')).toBe(true);
    expect(listed(anthropic, 'claude-haiku-4-5')).toBe(true);
    expect(listed(anthropic, 'claude-sonnet-4-5-20250929')).toBe(true);
    expect(listed(anthropic, 'claude-sonnet-4')).toBe(false); // not a prefix of a dated id: 4-5-… isn't a date
    expect(listed(anthropic, 'claude-3-opus')).toBe(false);
  });
  it('OpenAI-style dates count too; other suffixes do not', () => {
    expect(listed(new Set(['gpt-4o-2024-08-06']), 'gpt-4o')).toBe(true);
    expect(listed(new Set(['gpt-4o-mini']), 'gpt-4o')).toBe(false);
  });
});
