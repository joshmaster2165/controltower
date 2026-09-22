import type { ProviderKind, Usage } from '@controltower/shared';
import { usdPerMillionToNanoPerToken } from '@controltower/shared';
import { BUNDLED_PRICES } from './bundled.js';
import { GENERATED_PRICES } from './prices.generated.js';

/**
 * Prices are USD per million tokens. Cost is computed in integer nanousd
 * exactly once per flight, with the price pinned at resolve time.
 */
export interface PriceTier {
  above_input_tokens: number;
  input: number;
  output: number;
}

export interface PriceEntry {
  mode: 'chat' | 'embedding' | 'completion';
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
  tiers?: PriceTier[];
  context?: number;
  max_output?: number;
  caps?: Record<string, boolean>;
}

export interface PriceRef {
  source: 'bundled' | 'override' | 'admin' | 'remote' | 'none';
  key: string;
  entry: PriceEntry | undefined;
}

/** Provider kinds that share the OpenAI catalogue namespace. */
const KIND_TO_NAMESPACE: Record<ProviderKind, string> = {
  openai: 'openai',
  'azure-openai': 'openai',
  'openai-compatible': 'openai',
  anthropic: 'anthropic',
  gemini: 'gemini',
  vertex: 'gemini',
  bedrock: 'bedrock',
  mock: 'mock',
};

export class PricingTable {
  private admin = new Map<string, PriceEntry>();
  private remote = new Map<string, PriceEntry>();
  // Vendored LiteLLM table first; the hand-maintained entries in bundled.ts win on conflict.
  private bundled = new Map<string, PriceEntry>([...Object.entries(GENERATED_PRICES), ...Object.entries(BUNDLED_PRICES)]);

  setAdminOverride(key: string, entry: PriceEntry | null): void {
    if (entry) this.admin.set(key, entry);
    else this.admin.delete(key);
  }

  setRemote(entries: Record<string, PriceEntry>): void {
    this.remote = new Map(Object.entries(entries));
  }

  /**
   * Resolution: deployment override → admin global override → remote snapshot
   * → bundled. Lookups try `namespace/model`, then a few normalisations.
   */
  resolve(kind: ProviderKind, upstreamModel: string, override?: Record<string, unknown>, providerSlug?: string): PriceRef {
    if (override && typeof override.input === 'number' && typeof override.output === 'number') {
      return { source: 'override', key: `${kind}/${upstreamModel}`, entry: override as unknown as PriceEntry };
    }
    const ns = KIND_TO_NAMESPACE[kind];
    // OpenAI-compatible providers (groq, together, …) have their own price namespaces keyed by slug.
    const keys = providerSlug && providerSlug !== ns ? [...candidateKeys(providerSlug, upstreamModel), ...candidateKeys(ns, upstreamModel)] : candidateKeys(ns, upstreamModel);
    for (const key of keys) {
      const a = this.admin.get(key);
      if (a) return { source: 'admin', key, entry: a };
      const r = this.remote.get(key);
      if (r) return { source: 'remote', key, entry: r };
      const b = this.bundled.get(key);
      if (b) return { source: 'bundled', key, entry: b };
    }
    return { source: 'none', key: `${ns}/${upstreamModel}`, entry: undefined };
  }

  entries(): Array<{ key: string; entry: PriceEntry; source: PriceRef['source'] }> {
    const out = new Map<string, { key: string; entry: PriceEntry; source: PriceRef['source'] }>();
    for (const [k, e] of this.bundled) out.set(k, { key: k, entry: e, source: 'bundled' });
    for (const [k, e] of this.remote) out.set(k, { key: k, entry: e, source: 'remote' });
    for (const [k, e] of this.admin) out.set(k, { key: k, entry: e, source: 'admin' });
    return [...out.values()].sort((a, b) => a.key.localeCompare(b.key));
  }
}

function candidateKeys(ns: string, model: string): string[] {
  const keys = [`${ns}/${model}`];
  // Azure deployments are often named after the model with dots stripped.
  const dotted = model.replace(/-(\d)(\d)-/, '-$1.$2-');
  if (dotted !== model) keys.push(`${ns}/${dotted}`);
  // Dated snapshots fall back to the family name: gpt-4o-2024-08-06 → gpt-4o.
  const undated = model.replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-\d{8}$/, '');
  if (undated !== model) keys.push(`${ns}/${undated}`);
  // Bedrock/Vertex regional prefixes.
  const stripped = model.replace(/^(us|eu|apac|global)\./, '');
  if (stripped !== model) keys.push(`${ns}/${stripped}`);
  return keys;
}

/** Integer nanousd. */
export function computeCost(usage: Usage, entry: PriceEntry | undefined): number | null {
  if (!entry) return null;
  const tier = entry.tiers?.find((t) => usage.input > t.above_input_tokens);
  const inRate = usdPerMillionToNanoPerToken(tier?.input ?? entry.input);
  const outRate = usdPerMillionToNanoPerToken(tier?.output ?? entry.output);
  const crRate = usdPerMillionToNanoPerToken(entry.cache_read ?? 0);
  const cwRate = usdPerMillionToNanoPerToken(entry.cache_write ?? 0);
  return (
    usage.input * inRate +
    (usage.output + (usage.reasoning ?? 0)) * outRate +
    (usage.cacheRead ?? 0) * crRate +
    (usage.cacheWrite ?? 0) * cwRate
  );
}

/** Projected cost for admission/budget reservation. */
export function projectCost(estInput: number, maxOutput: number, entry: PriceEntry | undefined): number {
  if (!entry) return 0;
  return computeCost({ input: estInput, output: maxOutput, cacheRead: 0, cacheWrite: 0 }, entry) ?? 0;
}
