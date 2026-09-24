import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';
import type { KeyRecord } from '../registry.js';
import { globMatch } from '../registry.js';
import type { PolicyDecision, PolicyEngine, PolicyInput, PolicyTarget } from './engine.js';
import { salientHash, scopeHash } from './hash.js';
import { compileInspector, type CompiledInspector, type InspectConfig } from '../guardrails/scan.js';

/**
 * Zones group stations; rules are gates on the boundary between a source zone
 * (where the agent lives) and a target zone (what it is reaching for). The
 * first matching rule by priority wins; no match means allow. Everything is
 * in memory and reloaded on change.
 */
export interface ZoneMatch {
  teams?: string[];
  projects?: string[];
  tags?: string[];
  provider_kinds?: string[];
}

export interface ZoneRecord {
  id: string;
  name: string;
  color: string;
  stations: Set<string>;
  match: ZoneMatch;
  position: Record<string, unknown> | undefined;
  demo: boolean;
}

export interface ArgConstraint {
  path: string;
  op: 'eq' | 'neq' | 'glob' | 'in' | 'gt' | 'lt' | 'exists';
  value?: unknown;
}

export interface RuleMatch {
  /** Specific agents (API key ids). Empty = any agent (subject to from_zone). */
  keys?: string[];
  /** Specific model deployments. */
  deployments?: string[];
  /** Specific MCP tool servers. */
  mcp_servers?: string[];
  models?: string[];
  tools?: string[];
  operations?: Array<'read' | 'write' | 'admin' | 'unknown'>;
  args?: ArgConstraint[];
}

export interface RuleConfig extends InspectConfig {
  reason?: string;
  hold_ms?: number;
  binding?: 'exact' | 'salient' | 'window';
  bind_fields?: string[];
  window?: { uses?: number; ttl_ms?: number };
  fail_mode?: 'open' | 'closed';
  approvers?: string[];
}

export interface RuleRecord {
  id: string;
  name: string;
  fromZone: string | null;
  toZone: string | null;
  targetKind: 'model' | 'tool' | 'any';
  match: RuleMatch;
  effect: 'allow' | 'deny' | 'require_approval' | 'allow_with_limits' | 'inspect';
  config: RuleConfig;
  priority: number;
  enabled: boolean;
  revision: number;
  demo: boolean;
}

export interface PolicyDecisionFull extends PolicyDecision {
  scopeHash?: string | undefined;
  rule?: RuleRecord | undefined;
}

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function getPath(o: unknown, path: string): unknown {
  let cur: unknown = o;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function argOk(c: ArgConstraint, args: Record<string, unknown>): boolean {
  const v = getPath(args, c.path);
  switch (c.op) {
    case 'exists':
      return v !== undefined;
    case 'eq':
      return v === c.value || String(v) === String(c.value);
    case 'neq':
      return !(v === c.value || String(v) === String(c.value));
    case 'glob':
      return typeof v === 'string' && typeof c.value === 'string' && globMatch(c.value, v);
    case 'in':
      return Array.isArray(c.value) && c.value.some((x) => x === v || String(x) === String(v));
    case 'gt':
      return typeof v === 'number' && typeof c.value === 'number' && v > c.value;
    case 'lt':
      return typeof v === 'number' && typeof c.value === 'number' && v < c.value;
  }
}

export class PolicyService implements PolicyEngine {
  zones = new Map<string, ZoneRecord>();
  rules: RuleRecord[] = [];
  version = 0;
  /** Compiled detectors per inspect gate, rebuilt on reload. */
  private compiled = new Map<string, CompiledInspector>();
  private listeners = new Set<() => void>();

  constructor(
    private readonly db: Kysely<Database>,
    private readonly enforcement: () => boolean,
  ) {}

  enforcementOn(): boolean {
    return this.enforcement();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async reload(): Promise<void> {
    const [zones, rules] = await Promise.all([this.db.selectFrom('zones').selectAll().execute(), this.db.selectFrom('rules').selectAll().execute()]);
    const zmap = new Map<string, ZoneRecord>();
    for (const z of zones) {
      const sel = parseJson<{ stations?: string[]; match?: ZoneMatch }>(z.selector, {});
      zmap.set(z.id, {
        id: z.id,
        name: z.name,
        color: z.color,
        stations: new Set(sel.stations ?? []),
        match: sel.match ?? {},
        position: z.position ? parseJson<Record<string, unknown>>(z.position, {}) : undefined,
        demo: z.demo === 1,
      });
    }
    this.zones = zmap;
    this.rules = rules
      .map<RuleRecord>((r) => ({
        id: r.id,
        name: r.name,
        fromZone: r.from_zone,
        toZone: r.to_zone,
        targetKind: (r.target_kind as RuleRecord['targetKind']) ?? 'any',
        match: parseJson<RuleMatch>(r.match, {}),
        effect: r.effect as RuleRecord['effect'],
        config: parseJson<RuleConfig>(r.config, {}),
        priority: r.priority,
        enabled: r.enabled === 1,
        revision: r.revision,
        demo: r.demo === 1,
      }))
      .sort((a, b) => a.priority - b.priority);
    this.compiled = new Map(this.rules.filter((r) => r.effect === 'inspect').map((r) => [r.id, compileInspector(r.config)]));
    this.version++;
    for (const l of this.listeners) {
      try {
        l();
      } catch (err) {
        console.error('[policy] listener error', err);
      }
    }
  }

  /** Zones containing a station, by explicit membership or attribute match. */
  zonesForStation(stationKey: string, attrs: { team?: string | undefined; project?: string | undefined; tags?: string[] | undefined; providerKind?: string | undefined } = {}): ZoneRecord[] {
    const out: ZoneRecord[] = [];
    for (const z of this.zones.values()) {
      if (z.stations.has(stationKey)) {
        out.push(z);
        continue;
      }
      const m = z.match;
      if (m.teams?.length && attrs.team && m.teams.includes(attrs.team)) out.push(z);
      else if (m.projects?.length && attrs.project && m.projects.includes(attrs.project)) out.push(z);
      else if (m.tags?.length && attrs.tags?.some((t) => m.tags!.includes(t))) out.push(z);
      else if (m.provider_kinds?.length && attrs.providerKind && m.provider_kinds.includes(attrs.providerKind)) out.push(z);
    }
    return out;
  }

  sourceZones(key: KeyRecord): ZoneRecord[] {
    return this.zonesForStation(`key:${key.id}`, { team: key.team, project: key.project, tags: key.tags });
  }

  targetZones(target: PolicyTarget): ZoneRecord[] {
    const seen = new Map<string, ZoneRecord>();
    const keys: string[] = [];
    if (target.kind === 'model') {
      if (target.deploymentId) keys.push(`deployment:${target.deploymentId}`);
      if (target.providerId) keys.push(`provider:${target.providerId}`);
    } else {
      keys.push(`tool:${target.name}`);
      if (target.mcpServerId) keys.push(`mcp:${target.mcpServerId}`);
    }
    for (const k of keys) for (const z of this.zonesForStation(k, { providerKind: target.providerKind })) seen.set(z.id, z);
    return [...seen.values()];
  }

  private matchRule(r: RuleRecord, key: KeyRecord, target: PolicyTarget, src: Set<string>, dst: Set<string>, args: Record<string, unknown> | undefined): 'match' | 'no' | 'needs_args' {
    if (!r.enabled) return 'no';
    if (r.targetKind !== 'any' && r.targetKind !== target.kind) return 'no';
    if (r.fromZone && !src.has(r.fromZone)) return 'no';
    if (r.toZone && !dst.has(r.toZone)) return 'no';
    // Station-level scope: gates drawn directly on the Airspace between a specific agent and destination.
    if (r.match.keys?.length && !r.match.keys.includes(key.id)) return 'no';
    const dests = [...(r.match.deployments ?? []), ...(r.match.mcp_servers ?? [])];
    if (dests.length) {
      const id = target.kind === 'model' ? target.deploymentId : target.mcpServerId;
      if (!id || !dests.includes(id)) return 'no';
    }
    if (target.kind === 'model' && r.match.models?.length && !r.match.models.some((g) => globMatch(g, target.name))) return 'no';
    if (target.kind === 'tool' && r.match.tools?.length && !r.match.tools.some((g) => globMatch(g, target.name))) return 'no';
    if (r.match.operations?.length && !r.match.operations.includes(target.operation)) return 'no';
    if (r.match.args?.length) {
      if (!args) return 'needs_args';
      if (!r.match.args.every((c) => argOk(c, args))) return 'no';
    }
    return 'match';
  }

  evaluate(input: PolicyInput): PolicyDecisionFull {
    if (!this.enforcement()) return { effect: 'allow', reason: 'enforcement off' };
    return this.evaluateWith(this.rules, input);
  }

  /**
   * First-match evaluation over an explicit rule list (sorted by priority).
   * Used live with `this.rules`, and by the simulator with a draft rule set.
   * With `args` undefined, rules that need arguments do not match.
   */
  evaluateWith(rules: RuleRecord[], input: PolicyInput): PolicyDecisionFull {
    const src = new Set(this.sourceZones(input.key).map((z) => z.id));
    const dstZones = this.targetZones(input.target);
    const dst = new Set(dstZones.map((z) => z.id));
    for (const r of rules) {
      if (r.effect === 'inspect') continue;
      const m = this.matchRule(r, input.key, input.target, src, dst, input.args);
      if (m !== 'match') continue;
      const zoneFrom = r.fromZone ? this.zones.get(r.fromZone)?.name : undefined;
      const zoneTo = r.toZone ? this.zones.get(r.toZone)?.name : undefined;
      const base = { ruleId: r.id, zoneFrom, zoneTo, rule: r };
      switch (r.effect) {
        case 'deny':
          return { effect: 'deny', reason: r.config.reason ?? `Blocked by gate "${r.name}"`, ...base };
        case 'require_approval': {
          const argHash = salientHash(input.args, r.config.bind_fields);
          const sh = scopeHash({ keyId: input.key.id, targetKind: input.target.kind, targetName: input.target.name, argHash, ruleId: r.id, ruleRevision: r.revision });
          const summary = r.config.reason ?? `${input.key.name} wants to reach ${input.target.name}${zoneTo ? ` in ${zoneTo}` : ''}`;
          return { effect: 'hold', reason: r.name, summary, argHash, scopeHash: sh, ...base };
        }
        case 'allow':
        case 'allow_with_limits':
        default:
          return { effect: 'allow', ...base };
      }
    }
    return { effect: 'allow' };
  }

  /**
   * Inspect gates on this path, in priority order. Unlike access gates they do
   * not compete: every matching inspect gate runs, after the access decision.
   */
  inspectors(key: KeyRecord, target: PolicyTarget): Array<{ rule: RuleRecord; compiled: CompiledInspector }> {
    if (!this.enforcement() || !this.compiled.size) return [];
    const src = new Set(this.sourceZones(key).map((z) => z.id));
    const dst = new Set(this.targetZones(target).map((z) => z.id));
    const out: Array<{ rule: RuleRecord; compiled: CompiledInspector }> = [];
    for (const r of this.rules) {
      if (r.effect !== 'inspect') continue;
      // Inspect gates have no argument constraints; `needs_args` cannot occur.
      if (this.matchRule(r, key, target, src, dst, {}) !== 'match') continue;
      const compiled = this.compiled.get(r.id);
      if (compiled) out.push({ rule: r, compiled });
    }
    return out;
  }

  staticDecision(key: KeyRecord, target: PolicyTarget): 'deny' | 'maybe' {
    if (!this.enforcement()) return 'maybe';
    const src = new Set(this.sourceZones(key).map((z) => z.id));
    const dst = new Set(this.targetZones(target).map((z) => z.id));
    for (const r of this.rules) {
      if (r.effect === 'inspect') continue;
      const m = this.matchRule(r, key, target, src, dst, undefined);
      if (m === 'needs_args') return 'maybe';
      if (m === 'match') return r.effect === 'deny' ? 'deny' : 'maybe';
    }
    return 'maybe';
  }

  /** Serialisable view for the console. */
  snapshot(): { version: number; zones: Array<Record<string, unknown>>; rules: Array<Record<string, unknown>> } {
    return {
      version: this.version,
      zones: [...this.zones.values()].map((z) => ({ id: z.id, name: z.name, color: z.color, stations: [...z.stations], match: z.match, position: z.position, demo: z.demo })),
      rules: this.rules.map((r) => ({
        id: r.id,
        name: r.name,
        from_zone: r.fromZone,
        to_zone: r.toZone,
        target_kind: r.targetKind,
        match: r.match,
        effect: r.effect,
        config: r.config,
        priority: r.priority,
        enabled: r.enabled,
        revision: r.revision,
        demo: r.demo,
      })),
    };
  }
}
