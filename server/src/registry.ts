import type { ProviderKind } from '@controltower/shared';
import type { Kysely } from 'kysely';
import type { Database } from './db/schema.js';
import type { SecretBox } from './crypto/secrets.js';
import { hashApiKey } from './crypto/apikeys.js';

/**
 * Everything the hot path needs lives in memory and is reloaded on admin
 * mutations. Nothing on the allow path awaits the database.
 */

export interface KeyLimits {
  rpm?: number;
  tpm?: number;
  maxParallel?: number;
}

export interface KeyRecord {
  id: string;
  name: string;
  hash: string;
  prefix: string;
  last4: string;
  agentId: string | undefined;
  team: string | undefined;
  project: string | undefined;
  tags: string[];
  allowedModels: string[];
  allowedMcp: string[];
  limits: KeyLimits;
  enabled: boolean;
  expiresAt: number | undefined;
  demo: boolean;
  createdAt: number;
  lastUsedAt: number | undefined;
  /** Acts only on behalf of other agents: calls without a valid delegation token are refused. */
  delegatedOnly: boolean;
}

export interface ProviderRecord {
  id: string;
  kind: ProviderKind;
  name: string;
  slug: string;
  baseUrl: string | undefined;
  /** Decrypted; memory only. Never attach to a Flight or an event. */
  creds: Record<string, string>;
  extra: Record<string, unknown>;
  health: string;
  healthDetail: string | undefined;
  streamUsageSupported: boolean | undefined;
  demo: boolean;
}

export interface DeploymentRecord {
  id: string;
  providerId: string;
  upstreamModel: string;
  publicName: string | undefined;
  caps: Record<string, unknown>;
  pricingOverride: Record<string, unknown> | undefined;
  weight: number;
  enabled: boolean;
  coolingUntil: number | undefined;
  /** Consecutive cooldown-worthy failures; drives escalating cooldown. */
  cooldownStrikes: number;
  ewmaTtftMs: number | undefined;
  demo: boolean;
}

export interface AliasTarget {
  deploymentId: string;
  priority: number;
  weight: number;
}

export interface AliasRecord {
  id: string;
  name: string;
  strategy: 'priority' | 'weighted' | 'least-latency' | 'least-cost';
  fallbackOn: string[];
  targets: AliasTarget[];
  demo: boolean;
}

export interface ModelResolution {
  alias: AliasRecord | undefined;
  candidates: DeploymentRecord[];
}

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/** Simple glob: `*` matches any run of characters. Case-sensitive. */
export function globMatch(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return pattern === value;
  const re = new RegExp('^' + pattern.split('*').map(escapeRe).join('.*') + '$');
  return re.test(value);
}
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class Registry {
  keysByHash = new Map<string, KeyRecord>();
  keysById = new Map<string, KeyRecord>();
  agentTeams = new Map<string, Set<string>>();
  providers = new Map<string, ProviderRecord>();
  providersBySlug = new Map<string, ProviderRecord>();
  deployments = new Map<string, DeploymentRecord>();
  deploymentsByPublicName = new Map<string, DeploymentRecord>();
  aliases = new Map<string, AliasRecord>();
  aliasesByName = new Map<string, AliasRecord>();
  /** Bumped on every reload so caches keyed on topology can invalidate. */
  version = 0;
  private listeners = new Set<() => void>();

  constructor(
    private readonly db: Kysely<Database>,
    private readonly secrets: SecretBox,
  ) {}

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async reload(): Promise<void> {
    const [keys, providers, deployments, aliases, targets] = await Promise.all([
      this.db.selectFrom('api_keys').selectAll().execute(),
      this.db.selectFrom('providers').selectAll().execute(),
      this.db.selectFrom('deployments').selectAll().execute(),
      this.db.selectFrom('aliases').selectAll().execute(),
      this.db.selectFrom('alias_targets').selectAll().execute(),
    ]);

    const keysByHash = new Map<string, KeyRecord>();
    const keysById = new Map<string, KeyRecord>();
    for (const k of keys) {
      const rec: KeyRecord = {
        id: k.id,
        name: k.name,
        hash: k.key_hash,
        prefix: k.key_prefix,
        last4: k.last4,
        agentId: k.agent_id ?? undefined,
        team: k.team ?? undefined,
        project: k.project ?? undefined,
        tags: parseJson<string[]>(k.tags, []),
        allowedModels: parseJson<string[]>(k.allowed_models, ['*']),
        allowedMcp: parseJson<string[]>(k.allowed_mcp, ['*']),
        limits: parseJson<KeyLimits>(k.limits, {}),
        enabled: k.enabled === 1,
        expiresAt: k.expires_at ?? undefined,
        demo: k.demo === 1,
        createdAt: k.created_at,
        lastUsedAt: k.last_used_at ?? undefined,
        delegatedOnly: k.delegated_only === 1,
      };
      keysByHash.set(rec.hash, rec);
      keysById.set(rec.id, rec);
    }

    const provs = new Map<string, ProviderRecord>();
    const provsBySlug = new Map<string, ProviderRecord>();
    for (const p of providers) {
      let creds: Record<string, string> = {};
      if (p.creds_enc) {
        try {
          creds = JSON.parse(this.secrets.decrypt(p.creds_enc, `providers.creds_enc.${p.id}`)) as Record<
            string,
            string
          >;
        } catch (err) {
          console.error(`[registry] cannot decrypt credentials for provider ${p.slug}:`, (err as Error).message);
        }
      }
      const rec: ProviderRecord = {
        id: p.id,
        kind: p.kind as ProviderKind,
        name: p.name,
        slug: p.slug,
        baseUrl: p.base_url ?? undefined,
        creds,
        extra: parseJson<Record<string, unknown>>(p.extra, {}),
        health: p.health,
        healthDetail: p.health_detail ?? undefined,
        streamUsageSupported: p.stream_usage_supported == null ? undefined : p.stream_usage_supported === 1,
        demo: p.demo === 1,
      };
      provs.set(rec.id, rec);
      provsBySlug.set(rec.slug, rec);
    }

    const deps = new Map<string, DeploymentRecord>();
    const depsByPublic = new Map<string, DeploymentRecord>();
    for (const d of deployments) {
      const rec: DeploymentRecord = {
        id: d.id,
        providerId: d.provider_id,
        upstreamModel: d.upstream_model,
        publicName: d.public_name ?? undefined,
        caps: parseJson<Record<string, unknown>>(d.caps, {}),
        pricingOverride: d.pricing_override ? parseJson<Record<string, unknown>>(d.pricing_override, {}) : undefined,
        weight: d.weight,
        enabled: d.enabled === 1,
        coolingUntil: d.cooling_until ?? undefined,
        cooldownStrikes: this.deployments.get(d.id)?.cooldownStrikes ?? 0,
        ewmaTtftMs: this.deployments.get(d.id)?.ewmaTtftMs ?? d.ewma_ttft_ms ?? undefined,
        demo: d.demo === 1,
      };
      deps.set(rec.id, rec);
      if (rec.publicName) depsByPublic.set(rec.publicName, rec);
    }

    const targetsByAlias = new Map<string, AliasTarget[]>();
    for (const t of targets) {
      const arr = targetsByAlias.get(t.alias_id) ?? [];
      arr.push({ deploymentId: t.deployment_id, priority: t.priority, weight: t.weight });
      targetsByAlias.set(t.alias_id, arr);
    }
    const als = new Map<string, AliasRecord>();
    const alsByName = new Map<string, AliasRecord>();
    for (const a of aliases) {
      const rec: AliasRecord = {
        id: a.id,
        name: a.name,
        strategy: a.strategy as AliasRecord['strategy'],
        fallbackOn: parseJson<string[]>(a.fallback_on, []),
        targets: (targetsByAlias.get(a.id) ?? []).sort((x, y) => x.priority - y.priority),
        demo: a.demo === 1,
      };
      als.set(rec.id, rec);
      alsByName.set(rec.name, rec);
    }

    this.keysByHash = keysByHash;
    this.keysById = keysById;
    // An agent's teams (by agent id, or key id for a key without one), for "on behalf of team X" gates.
    const agentTeams = new Map<string, Set<string>>();
    for (const k of keysById.values()) {
      if (!k.team) continue;
      const a = k.agentId ?? k.id;
      (agentTeams.get(a) ?? agentTeams.set(a, new Set()).get(a)!).add(k.team);
    }
    this.agentTeams = agentTeams;
    this.providers = provs;
    this.providersBySlug = provsBySlug;
    this.deployments = deps;
    this.deploymentsByPublicName = depsByPublic;
    this.aliases = als;
    this.aliasesByName = alsByName;
    this.version++;
    for (const l of this.listeners) {
      try {
        l();
      } catch (err) {
        console.error('[registry] listener error', err);
      }
    }
  }

  /** Resolve a presented API key (plaintext) to its record, or undefined. */
  /**
   * Generated keys (ct_sk_…) plus keys brought over from another gateway (sk-…) and the
   * admin key: anything of a plausible length is looked up by its hash.
   */
  authenticate(plaintext: string): KeyRecord | undefined {
    if (plaintext.length < 16 || plaintext.length > 512) return undefined;
    return this.keysByHash.get(hashApiKey(plaintext));
  }

  keyMayUseModel(key: KeyRecord, model: string): boolean {
    return key.allowedModels.some((p) => globMatch(p, model));
  }

  /**
   * Model name → alias or deployment candidates, health-filtered.
   * Order: alias name → deployment public name → `provider_slug/upstream_model`.
   */
  resolveModel(model: string, now = Date.now()): ModelResolution {
    const alias = this.aliasesByName.get(model);
    if (alias) {
      const enabled = alias.targets
        .map((t) => this.deployments.get(t.deploymentId))
        .filter((d): d is DeploymentRecord => !!d && d.enabled);
      let candidates = enabled.filter((d) => !d.coolingUntil || d.coolingUntil < now);
      if (candidates.length === 0 && enabled.length > 0) {
        // Everything is cooling: cooldown is a preference, not a blackout. Try the one closest to recovery first.
        candidates = [...enabled].sort((a, b) => (a.coolingUntil ?? 0) - (b.coolingUntil ?? 0));
      }
      return { alias, candidates: this.orderCandidates(alias, candidates) };
    }
    const dep = this.deploymentsByPublicName.get(model);
    if (dep && dep.enabled) return { alias: undefined, candidates: [dep] };

    const slash = model.indexOf('/');
    if (slash > 0) {
      const prov = this.providersBySlug.get(model.slice(0, slash));
      const upstream = model.slice(slash + 1);
      if (prov) {
        for (const d of this.deployments.values()) {
          if (d.providerId === prov.id && d.upstreamModel === upstream && d.enabled) {
            return { alias: undefined, candidates: [d] };
          }
        }
      }
    }
    return { alias: undefined, candidates: [] };
  }

  private orderCandidates(alias: AliasRecord, candidates: DeploymentRecord[]): DeploymentRecord[] {
    switch (alias.strategy) {
      case 'weighted': {
        // Weighted random pick for the head among the best priority tier still available — fallbacks
        // (a later tier) are only tried after it — then the rest in priority order.
        const prio = new Map(alias.targets.map((t) => [t.deploymentId, t.priority]));
        const best = Math.min(...candidates.map((d) => prio.get(d.id) ?? 0));
        const tier = candidates.filter((d) => (prio.get(d.id) ?? 0) === best);
        const total = tier.reduce((s, d) => s + d.weight, 0);
        if (total <= 0 || tier.length < 2) return [...tier, ...candidates.filter((d) => !tier.includes(d))];
        let r = Math.random() * total;
        let head = tier[0]!;
        for (const d of tier) {
          r -= d.weight;
          if (r <= 0) {
            head = d;
            break;
          }
        }
        return [head, ...candidates.filter((d) => d !== head)];
      }
      case 'least-latency':
        return [...candidates].sort((a, b) => (a.ewmaTtftMs ?? 1e9) - (b.ewmaTtftMs ?? 1e9));
      case 'priority':
      case 'least-cost':
      default:
        return candidates;
    }
  }

  /** Models a given key is allowed to see in /v1/models. */
  visibleModels(key: KeyRecord): Array<{ id: string; kind: "alias" | "deployment"; provider?: string | undefined }> {
    const out: Array<{ id: string; kind: "alias" | "deployment"; provider?: string | undefined }> = [];
    for (const a of this.aliases.values()) {
      if (this.keyMayUseModel(key, a.name)) out.push({ id: a.name, kind: 'alias' });
    }
    for (const d of this.deployments.values()) {
      if (!d.enabled) continue;
      const prov = this.providers.get(d.providerId);
      if (d.publicName && this.keyMayUseModel(key, d.publicName)) {
        out.push({ id: d.publicName, kind: 'deployment', provider: prov?.slug });
      }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Escalating cooldown: 2 s, 4 s, 8 s … capped at 30 s; reset by the next success. */
  markCooldown(deploymentId: string, baseMs = 2_000, maxMs = 30_000): void {
    const d = this.deployments.get(deploymentId);
    if (!d) return;
    d.cooldownStrikes = Math.min(8, d.cooldownStrikes + 1);
    d.coolingUntil = Date.now() + Math.min(maxMs, baseMs * 2 ** (d.cooldownStrikes - 1));
  }

  clearCooldown(deploymentId: string): void {
    const d = this.deployments.get(deploymentId);
    if (!d) return;
    d.cooldownStrikes = 0;
    d.coolingUntil = undefined;
  }

  recordTtft(deploymentId: string, ttftMs: number): void {
    const d = this.deployments.get(deploymentId);
    if (!d) return;
    d.ewmaTtftMs = d.ewmaTtftMs == null ? ttftMs : d.ewmaTtftMs * 0.8 + ttftMs * 0.2;
  }
}
