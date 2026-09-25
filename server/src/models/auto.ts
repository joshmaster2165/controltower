import crypto from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';
import type { ProviderRecord, Registry } from '../registry.js';
import type { PricingTable } from '../pricing/index.js';
import type { Adapters } from '../providers/index.js';

/**
 * Models that just work. When a request names a model no deployment serves,
 * look for a connected provider that offers it — the price table knows that
 * model for the provider, or the provider's own model list includes it — and
 * add the deployment on first use. A name nobody serves still fails with
 * model_not_found, and nothing is created for it.
 *
 * `provider/model` (e.g. `groq/llama-3.3-70b`) pins the provider.
 */
const KIND_RANK: Record<string, number> = { openai: 0, anthropic: 0, gemini: 0, 'azure-openai': 1, vertex: 2, bedrock: 2, 'openai-compatible': 3, mock: 9 };
const LIST_TTL_MS = 5 * 60_000;

export class AutoModels {
  private lists = new Map<string, { at: number; ids: Set<string> }>();
  private pending = new Map<string, Promise<boolean>>();

  constructor(
    private readonly deps: { db: Kysely<Database>; registry: Registry; pricing: PricingTable; adapters: Adapters; enabled: boolean },
    private readonly log: (msg: string) => void,
  ) {}

  /** Tries to make `model` routable. True when a deployment now serves it. */
  ensure(model: string): Promise<boolean> {
    if (!this.deps.enabled || !model || model.length > 200) return Promise.resolve(false);
    let p = this.pending.get(model);
    if (!p) {
      p = this.add(model)
        .catch((err: unknown) => {
          this.log(`could not add model "${model}": ${(err as Error).message}`);
          return false;
        })
        .finally(() => this.pending.delete(model));
      this.pending.set(model, p);
    }
    return p;
  }

  /** Which connected provider serves this model name, if any. */
  async providerFor(model: string): Promise<{ provider: ProviderRecord; upstream: string; pinned: boolean } | undefined> {
    const r = this.deps.registry;
    // Demo stand-ins never adopt new models: they only serve what demo mode seeded.
    let providers = [...r.providers.values()].filter((p) => !p.demo);
    let upstream = model;
    let pinned = false;
    const slash = model.indexOf('/');
    if (slash > 0 && r.providersBySlug.has(model.slice(0, slash))) {
      const p = r.providersBySlug.get(model.slice(0, slash))!;
      providers = p.demo ? [] : [p];
      upstream = model.slice(slash + 1);
      pinned = true;
    }
    if (!upstream) return undefined;
    const priced = providers
      .filter((p) => {
        const ref = this.deps.pricing.resolve(p.kind, upstream, undefined, p.slug);
        if (ref.source === 'none') return false;
        // OpenAI-compatible hosts (Groq, Together, …) share OpenAI's price namespace; only their own entries count.
        return p.kind !== 'openai-compatible' || ref.key.startsWith(`${p.slug}/`);
      })
      .sort((a, b) => (KIND_RANK[a.kind] ?? 5) - (KIND_RANK[b.kind] ?? 5));
    if (priced[0]) return { provider: priced[0], upstream, pinned };
    for (const p of providers) if ((await this.listed(p)).has(upstream)) return { provider: p, upstream, pinned };
    return undefined;
  }

  private async add(model: string): Promise<boolean> {
    const found = await this.providerFor(model);
    if (!found) return false;
    const { provider, upstream, pinned } = found;
    const r = this.deps.registry;
    const publicName = pinned || r.deploymentsByPublicName.has(model) || r.aliasesByName.has(model) ? null : model;
    const id = `dep_auto_${crypto.createHash('sha256').update(`${provider.id}|${upstream}`).digest('hex').slice(0, 20)}`;
    const now = Date.now();
    await this.deps.db
      .insertInto('deployments')
      .values({ id, provider_id: provider.id, upstream_model: upstream, public_name: publicName, caps: '{}', pricing_override: null, weight: 100, enabled: 1, cooling_until: null, ewma_ttft_ms: null, demo: 0, created_at: now, updated_at: now })
      // Already added under its pinned name (openai/…): the bare name now becomes its public name.
      .onConflict((oc) => (publicName ? oc.column('id').doUpdateSet({ public_name: publicName, updated_at: now }).where('deployments.public_name', 'is', null) : oc.doNothing()))
      .execute();
    await r.reload();
    this.log(`model "${model}" added on first use → ${provider.name} (${upstream})`);
    return true;
  }

  private async listed(p: ProviderRecord): Promise<Set<string>> {
    const hit = this.lists.get(p.id);
    if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.ids;
    let ids = new Set<string>();
    const adapter = this.deps.adapters.get(p.kind);
    if (adapter?.listModels) {
      try {
        ids = new Set((await adapter.listModels(p)).map((m) => m.id));
      } catch {
        // an unreachable provider simply offers nothing
      }
    }
    this.lists.set(p.id, { at: Date.now(), ids });
    return ids;
  }
}
