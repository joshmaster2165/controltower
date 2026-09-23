import { describe, expect, it } from 'vitest';
import { AutoModels } from '../src/models/auto.js';
import { PricingTable } from '../src/pricing/index.js';
import type { ProviderRecord, Registry } from '../src/registry.js';
import type { Adapters } from '../src/providers/index.js';
import type { Kysely } from 'kysely';
import type { Database } from '../src/db/schema.js';

function provider(id: string, kind: ProviderRecord['kind'], slug: string, demo = false): ProviderRecord {
  return { id, kind, name: slug, slug, baseUrl: undefined, creds: {}, extra: {}, health: 'ok', healthDetail: undefined, streamUsageSupported: true, demo };
}

function setup(providers: ProviderRecord[], listed: Record<string, string[]> = {}) {
  const registry = {
    providers: new Map(providers.map((p) => [p.id, p])),
    providersBySlug: new Map(providers.map((p) => [p.slug, p])),
    deploymentsByPublicName: new Map(),
    aliasesByName: new Map(),
  } as unknown as Registry;
  const adapters = { get: () => ({ listModels: async (p: ProviderRecord) => (listed[p.id] ?? []).map((id) => ({ id })) }) } as unknown as Adapters;
  return new AutoModels({ db: {} as Kysely<Database>, registry, pricing: new PricingTable(), adapters, enabled: true }, () => undefined);
}

describe('models on first use', () => {
  it('sends a priced model to its own vendor', async () => {
    const auto = setup([provider('p1', 'openai', 'openai'), provider('p2', 'anthropic', 'anthropic')]);
    expect((await auto.providerFor('claude-sonnet-4-5'))?.provider.id).toBe('p2');
    expect((await auto.providerFor('gpt-4.1-mini'))?.provider.id).toBe('p1');
    // Dated snapshots resolve through the family's price.
    expect((await auto.providerFor('claude-sonnet-4-5-20250929'))?.provider.id).toBe('p2');
  });

  it('does not let an OpenAI-compatible host claim OpenAI models', async () => {
    const auto = setup([provider('g', 'openai-compatible', 'groq')]);
    expect(await auto.providerFor('gpt-4.1')).toBeUndefined();
  });

  it('uses a provider’s own model list for local models', async () => {
    const auto = setup([provider('o', 'openai-compatible', 'ollama')], { o: ['llama3.1:8b'] });
    expect((await auto.providerFor('llama3.1:8b'))?.provider.id).toBe('o');
    expect(await auto.providerFor('made-up-model')).toBeUndefined();
  });

  it('pins the provider with provider/model', async () => {
    const auto = setup([provider('p1', 'openai', 'openai'), provider('az', 'azure-openai', 'azure')]);
    const r = await auto.providerFor('azure/gpt-4.1');
    expect(r).toMatchObject({ upstream: 'gpt-4.1', pinned: true });
    expect(r?.provider.id).toBe('az');
  });

  it('never adopts models onto demo stand-ins', async () => {
    const auto = setup([provider('d', 'mock', 'anthropic', true)]);
    expect(await auto.providerFor('claude-opus-4-1')).toBeUndefined();
  });
});
