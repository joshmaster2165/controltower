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
  mode: 'chat' | 'embedding' | 'completion' | 'moderation' | 'image_generation' | 'image_edit' | 'audio_speech' | 'audio_transcription' | 'rerank';
  input: number;
  output: number;
  /** USD per image made. */
  per_image?: number;
  /** USD per pixel of an image made (older image models price by size). */
  per_pixel?: number;
  /** USD per million image tokens read / made (token-priced image models). */
  image_input?: number;
  image_output?: number;
  /** USD per character spoken (text to speech). */
  per_character?: number;
  /** USD per second of audio transcribed, or spoken. */
  per_second?: number;
  /** USD per million audio tokens heard / spoken. */
  audio_input?: number;
  audio_output?: number;
  /** USD per search (rerank). */
  per_query?: number;
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

const MOCK_PRICE_AS = ['anthropic', 'openai', 'gemini'];

export class PricingTable {
  private admin = new Map<string, PriceEntry>();
  private remote = new Map<string, PriceEntry>();
  // The generated table first; the hand-maintained entries in bundled.ts win on conflict.
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
    // The mock provider stands in for real models in demos; price them like the real thing.
    if (kind === 'mock') for (const real of MOCK_PRICE_AS) keys.push(...candidateKeys(real, upstreamModel));
    for (const key of keys) {
      const a = this.admin.get(key);
      if (a) return { source: 'admin', key, entry: a };
      const r = this.remote.get(key);
      if (r) return { source: 'remote', key, entry: r };
      const b = this.bundled.get(key);
      if (b) return { source: 'bundled', key, entry: b };
    }
    // Image models priced only by quality and size (standard/1024-x-1024/dall-e-3): any of their prices says the model is known.
    const variant = this.variantOf(`${ns}/${upstreamModel}`);
    if (variant) return { source: 'bundled', key: variant, entry: this.bundled.get(variant) };
    return { source: 'none', key: `${ns}/${upstreamModel}`, entry: undefined };
  }

  private variants: Map<string, string> | undefined;
  private variantOf(key: string): string | undefined {
    if (!this.variants) {
      this.variants = new Map();
      for (const k of [...this.bundled.keys()].sort()) {
        const parts = k.split('/');
        if (parts.length < 3) continue;
        const short = `${parts[0]}/${parts.at(-1)}`;
        if (!this.variants.has(short)) this.variants.set(short, k);
      }
    }
    return this.variants.get(key);
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

/** What a call that isn't billed only on tokens was billed on. */
export interface Units {
  images?: number;
  /** Pixels per image, for models priced by size. */
  pixels?: number;
  characters?: number;
  seconds?: number;
  queries?: number;
}

/** Tokens by modality, for models that price text, image and audio tokens differently. */
export interface ModalTokens {
  textIn?: number;
  imageIn?: number;
  audioIn?: number;
  cachedIn?: number;
  textOut?: number;
  imageOut?: number;
  audioOut?: number;
}

const nano = (usd: number) => Math.round(usd * 1e9);

/**
 * Integer nanousd for an image, audio, rerank or moderation call: from the tokens it reported when it
 * reported them (each modality at its own rate), else from what it made — images, characters, seconds, searches.
 * Null when the model has no price that applies.
 */
export function computeApiCost(entry: PriceEntry | undefined, units: Units, tokens?: ModalTokens): number | null {
  if (!entry) return null;
  if (tokens && Object.values(tokens).some((t) => (t ?? 0) > 0)) {
    const r = (perM: number | undefined) => usdPerMillionToNanoPerToken(perM ?? 0);
    return Math.round(
      (tokens.textIn ?? 0) * r(entry.input) +
        (tokens.imageIn ?? 0) * r(entry.image_input ?? entry.input) +
        (tokens.audioIn ?? 0) * r(entry.audio_input ?? entry.input) +
        (tokens.cachedIn ?? 0) * r(entry.cache_read ?? entry.input) +
        (tokens.textOut ?? 0) * r(entry.output) +
        (tokens.imageOut ?? 0) * r(entry.image_output ?? entry.output) +
        (tokens.audioOut ?? 0) * r(entry.audio_output ?? entry.output),
    );
  }
  let usd = 0;
  let priced = false;
  if (units.images) {
    if (entry.per_image != null) (usd += units.images * entry.per_image), (priced = true);
    else if (entry.per_pixel != null && units.pixels) (usd += units.images * units.pixels * entry.per_pixel), (priced = true);
  }
  if (units.characters && entry.per_character != null) (usd += units.characters * entry.per_character), (priced = true);
  if (units.seconds && entry.per_second != null) (usd += units.seconds * entry.per_second), (priced = true);
  if (units.queries && entry.per_query != null) (usd += units.queries * entry.per_query), (priced = true);
  if (priced) return nano(usd);
  // Moderation is free where it is priced at all.
  if (entry.mode === 'moderation' && entry.input === 0 && entry.output === 0) return 0;
  return null;
}

/** Image models are priced by quality and size: `hd/1024-x-1792/dall-e-3`, then `1024-x-1792/dall-e-3`, then the model. */
export function imagePriceKeys(model: string, size: string | undefined, quality: string | undefined): string[] {
  const sz = size && /^\d+x\d+$/.test(size) ? size.replace('x', '-x-') : undefined;
  const q = quality && quality !== 'auto' ? quality : model.startsWith('dall-e') ? 'standard' : 'medium';
  const out: string[] = [];
  if (sz) out.push(`${q}/${sz}/${model}`, `${sz}/${model}`);
  out.push(model);
  return out;
}
