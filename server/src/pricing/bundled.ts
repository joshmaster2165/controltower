import type { PriceEntry } from './index.js';

/**
 * Starter pricing table (USD per million tokens). Replaced/extended by
 * `scripts/import-litellm-prices.ts`, which normalises LiteLLM's MIT-licensed
 * `model_prices_and_context_window.json` into `prices.json` (see
 * `THIRD_PARTY.md`). Keep this small and obviously-correct; the import is the
 * source of breadth.
 */
export const BUNDLED_PRICES: Record<string, PriceEntry> = {
  // ---- OpenAI ----
  'openai/gpt-4o': { mode: 'chat', input: 2.5, output: 10, cache_read: 1.25, context: 128000, max_output: 16384 },
  'openai/gpt-4o-mini': { mode: 'chat', input: 0.15, output: 0.6, cache_read: 0.075, context: 128000, max_output: 16384 },
  'openai/gpt-4.1': { mode: 'chat', input: 2, output: 8, cache_read: 0.5, context: 1047576, max_output: 32768 },
  'openai/gpt-4.1-mini': { mode: 'chat', input: 0.4, output: 1.6, cache_read: 0.1, context: 1047576, max_output: 32768 },
  'openai/gpt-4.1-nano': { mode: 'chat', input: 0.1, output: 0.4, cache_read: 0.025, context: 1047576, max_output: 32768 },
  'openai/o3': { mode: 'chat', input: 2, output: 8, cache_read: 0.5, context: 200000, max_output: 100000 },
  'openai/o4-mini': { mode: 'chat', input: 1.1, output: 4.4, cache_read: 0.275, context: 200000, max_output: 100000 },
  'openai/text-embedding-3-small': { mode: 'embedding', input: 0.02, output: 0 },
  'openai/text-embedding-3-large': { mode: 'embedding', input: 0.13, output: 0 },

  // ---- Anthropic ----
  'anthropic/claude-sonnet-4-5': { mode: 'chat', input: 3, output: 15, cache_read: 0.3, cache_write: 3.75, context: 200000, max_output: 64000 },
  'anthropic/claude-sonnet-4-5-20250929': { mode: 'chat', input: 3, output: 15, cache_read: 0.3, cache_write: 3.75, context: 200000, max_output: 64000 },
  'anthropic/claude-opus-4-1': { mode: 'chat', input: 15, output: 75, cache_read: 1.5, cache_write: 18.75, context: 200000, max_output: 32000 },
  'anthropic/claude-haiku-4-5': { mode: 'chat', input: 1, output: 5, cache_read: 0.1, cache_write: 1.25, context: 200000, max_output: 64000 },
  'anthropic/claude-3-5-haiku-latest': { mode: 'chat', input: 0.8, output: 4, cache_read: 0.08, cache_write: 1, context: 200000, max_output: 8192 },

  // ---- Google ----
  'gemini/gemini-2.5-pro': {
    mode: 'chat',
    input: 1.25,
    output: 10,
    cache_read: 0.31,
    tiers: [{ above_input_tokens: 200000, input: 2.5, output: 15 }],
    context: 1048576,
    max_output: 65536,
  },
  'gemini/gemini-2.5-flash': { mode: 'chat', input: 0.3, output: 2.5, cache_read: 0.075, context: 1048576, max_output: 65536 },

  // ---- Demo / mock (priced like real tiers so the Ledger looks realistic) ----
  'mock/mock-smart': { mode: 'chat', input: 3, output: 15, cache_read: 0.3, context: 200000, max_output: 8192 },
  'mock/mock-fast': { mode: 'chat', input: 0.15, output: 0.6, context: 128000, max_output: 8192 },
  'mock/mock-cheap': { mode: 'chat', input: 0.05, output: 0.2, context: 32000, max_output: 4096 },
  'mock/mock-embed': { mode: 'embedding', input: 0.02, output: 0 },
};
