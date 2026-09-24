import { ulid } from 'ulid';
import { parse, stringify } from 'yaml';
import type { AppContext } from '../context.js';
import { inspectConfigError } from '../guardrails/validate.js';
import type { PolicyService, RuleConfig, RuleMatch, RuleRecord, ZoneMatch, ZoneRecord } from './policy.js';

/**
 * Policy as code: zones and gates as a YAML document that reads like the map
 * and can live in Git. Everything is referenced by name, so a file exported
 * from one install applies to another with the same agents, models and tool
 * servers:
 *
 *   zones:
 *     - name: AI Labs sandbox
 *       members: [agent:labs-prototype]
 *   gates:
 *     - name: AI Labs may not merge code
 *       from: AI Labs sandbox
 *       target: tool
 *       match: { servers: [github], tools: [github__merge_pr] }
 *       effect: deny
 *
 * Member references: agent:<key name>, model:<public name or provider/model>,
 * provider:<slug>, mcp:<slug>, http:<slug>, tool:<namespaced tool>.
 * Demo zones and gates are never exported, changed or removed.
 */

const EFFECTS = ['allow', 'deny', 'require_approval', 'allow_with_limits', 'inspect'] as const;
const TARGETS = ['model', 'tool', 'any'] as const;
const OPERATIONS = ['read', 'write', 'admin', 'unknown'] as const;

export interface ZoneDoc {
  name: string;
  color?: string;
  members?: string[];
  match?: ZoneMatch;
}
export interface GateDoc {
  name: string;
  from?: string;
  to?: string;
  target?: RuleRecord['targetKind'];
  match?: { agents?: string[]; deployments?: string[]; servers?: string[]; models?: string[]; tools?: string[]; operations?: RuleMatch['operations']; args?: RuleMatch['args'] };
  effect: RuleRecord['effect'];
  config?: RuleConfig;
  priority?: number;
  enabled?: boolean;
}
export interface PolicyDoc {
  version: 1;
  zones: ZoneDoc[];
  gates: GateDoc[];
}

/** Name ↔ id lookups for everything a zone or gate can point at. */
function names(ctx: AppContext) {
  const r = ctx.registry;
  const depName = (id: string) => {
    const d = r.deployments.get(id);
    if (!d) return undefined;
    return d.publicName ?? `${r.providers.get(d.providerId)?.slug ?? 'unknown'}/${d.upstreamModel}`;
  };
  const agents = new Map<string, string[]>();
  for (const k of r.keysById.values()) agents.set(k.name, [...(agents.get(k.name) ?? []), k.id]);
  const deployments = new Map<string, string>();
  for (const d of r.deployments.values()) {
    if (d.publicName) deployments.set(d.publicName, d.id);
    deployments.set(`${r.providers.get(d.providerId)?.slug ?? 'unknown'}/${d.upstreamModel}`, d.id);
  }
  const providers = new Map([...r.providers.values()].map((p) => [p.slug, p.id]));

  return {
    /** Station id (as stored on a zone) → reference, or undefined if it points at nothing that exists. */
    ref(station: string): string | undefined {
      const i = station.indexOf(':');
      const kind = station.slice(0, i);
      const id = station.slice(i + 1);
      switch (kind) {
        case 'key': {
          const k = r.keysById.get(id);
          return k ? `agent:${k.name}` : undefined;
        }
        case 'deployment': {
          const n = depName(id);
          return n ? `model:${n}` : undefined;
        }
        case 'provider': {
          const p = r.providers.get(id);
          return p ? `provider:${p.slug}` : undefined;
        }
        case 'mcp': {
          const m = ctx.mcp.servers.get(id);
          if (m) return `mcp:${m.slug}`;
          const h = ctx.http.apis.get(id);
          return h ? `http:${h.slug}` : undefined;
        }
        case 'tool':
          return station;
        default:
          return undefined;
      }
    },
    /** Reference → station id, or an error message. */
    station(ref: string): { id: string } | { error: string } {
      const i = ref.indexOf(':');
      if (i < 1) return { error: `"${ref}" is not a member reference (use agent:, model:, provider:, mcp:, http: or tool:)` };
      const kind = ref.slice(0, i);
      const name = ref.slice(i + 1).trim();
      switch (kind) {
        case 'agent': {
          const ids = agents.get(name) ?? [];
          if (ids.length === 1) return { id: `key:${ids[0]}` };
          return { error: ids.length ? `${ids.length} agents are named "${name}"; rename one to reference it` : `no agent named "${name}"` };
        }
        case 'model': {
          const id = deployments.get(name);
          return id ? { id: `deployment:${id}` } : { error: `no model named "${name}"` };
        }
        case 'provider': {
          const id = providers.get(name);
          return id ? { id: `provider:${id}` } : { error: `no provider with slug "${name}"` };
        }
        case 'mcp':
        case 'http': {
          const id = kind === 'mcp' ? ctx.mcp.bySlug.get(name)?.id : ctx.http.bySlug.get(name)?.id;
          return id ? { id: `mcp:${id}` } : { error: `no ${kind === 'mcp' ? 'MCP server' : 'HTTP API'} with slug "${name}"` };
        }
        case 'tool':
          return name ? { id: `tool:${name}` } : { error: 'tool: needs a tool name' };
        default:
          return { error: `unknown member kind "${kind}:"` };
      }
    },
    agentName: (id: string) => r.keysById.get(id)?.name,
    agentId: (name: string) => {
      const ids = agents.get(name) ?? [];
      return ids.length === 1 ? ids[0] : undefined;
    },
    agentProblem: (name: string) => ((agents.get(name) ?? []).length > 1 ? `${agents.get(name)!.length} agents are named "${name}"` : `no agent named "${name}"`),
    deploymentName: depName,
    deploymentId: (name: string) => deployments.get(name),
    serverSlug: (id: string) => ctx.mcp.servers.get(id)?.slug ?? ctx.http.apis.get(id)?.slug,
    serverId: (slug: string) => ctx.mcp.bySlug.get(slug)?.id ?? ctx.http.bySlug.get(slug)?.id,
  };
}

const nonEmpty = <T>(xs: T[] | undefined): T[] | undefined => (xs && xs.length ? xs : undefined);
const clean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length) && !(v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length))) as T;

/** The live (non-demo) policy as a document; references that no longer exist are reported, not exported. */
export function exportPolicy(ctx: AppContext): { doc: PolicyDoc; warnings: string[] } {
  const policy = ctx.policy as PolicyService;
  const n = names(ctx);
  const warnings: string[] = [];
  const zoneName = (id: string | null) => (id ? policy.zones.get(id)?.name : undefined);
  const zones: ZoneDoc[] = [...policy.zones.values()]
    .filter((z) => !z.demo)
    .map((z) => {
      const members: string[] = [];
      for (const s of z.stations) {
        const ref = n.ref(s);
        if (ref) members.push(ref);
        else warnings.push(`Zone "${z.name}": skipped ${s}, which no longer exists.`);
      }
      return clean({ name: z.name, color: z.color, members: members.sort(), match: clean(z.match) });
    });
  const gates: GateDoc[] = policy.rules
    .filter((r) => !r.demo)
    .map((r) => {
      const m = r.match;
      const list = (ids: string[] | undefined, f: (id: string) => string | undefined, what: string) =>
        nonEmpty(
          (ids ?? []).flatMap((id) => {
            const v = f(id);
            if (!v) warnings.push(`Gate "${r.name}": skipped ${what} ${id}, which no longer exists.`);
            return v ? [v] : [];
          }),
        );
      const match = clean({
        agents: list(m.keys, n.agentName, 'agent'),
        deployments: list(m.deployments, n.deploymentName, 'model'),
        servers: list(m.mcp_servers, n.serverSlug, 'tool server'),
        models: nonEmpty(m.models),
        tools: nonEmpty(m.tools),
        operations: nonEmpty(m.operations),
        args: nonEmpty(m.args),
      });
      return clean({
        name: r.name,
        from: zoneName(r.fromZone),
        to: zoneName(r.toZone),
        target: r.targetKind === 'any' ? undefined : r.targetKind,
        match,
        effect: r.effect,
        config: clean(r.config),
        priority: r.priority === 100 ? undefined : r.priority,
        enabled: r.enabled ? undefined : false,
      }) as GateDoc;
    });
  return { doc: { version: 1, zones, gates }, warnings };
}

export function policyYaml(ctx: AppContext): string {
  const { doc, warnings } = exportPolicy(ctx);
  const head = [
    '# Control Tower policy: zones and the gates between them.',
    `# Exported ${new Date().toISOString()}. Apply with Airspace → Export → Import policy, or POST /admin/api/policy/import.`,
    '# Members: agent:<name>, model:<name>, provider:<slug>, mcp:<slug>, http:<slug>, tool:<server__tool>.',
    ...warnings.map((w) => `# Note: ${w}`),
  ];
  return `${head.join('\n')}\n${stringify(doc, { lineWidth: 0 })}`;
}

// ---------------------------------------------------------------- import

interface ZoneRow {
  name: string;
  color: string;
  stations: string[];
  match: ZoneMatch;
}
interface RuleRow {
  name: string;
  from: string | null;
  to: string | null;
  targetKind: RuleRecord['targetKind'];
  match: RuleMatch;
  effect: RuleRecord['effect'];
  config: RuleConfig;
  priority: number;
  enabled: boolean;
}
export interface ImportPlan {
  mode: 'merge' | 'replace';
  errors: string[];
  warnings: string[];
  zones: { create: string[]; update: string[]; unchanged: string[]; remove: string[] };
  gates: { create: string[]; update: string[]; unchanged: string[]; remove: string[] };
  /** Resolved rows, used by applyPolicyImport. */
  rows: { zones: ZoneRow[]; gates: RuleRow[] };
}

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const same = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== undefined && !(Array.isArray(x) && !x.length))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, canon(x)]),
    );
  }
  return v;
}

export function planPolicyImport(ctx: AppContext, text: string, mode: 'merge' | 'replace'): ImportPlan {
  const policy = ctx.policy as PolicyService;
  const n = names(ctx);
  const plan: ImportPlan = { mode, errors: [], warnings: [], zones: { create: [], update: [], unchanged: [], remove: [] }, gates: { create: [], update: [], unchanged: [], remove: [] }, rows: { zones: [], gates: [] } };
  const fail = (m: string) => plan.errors.push(m);

  let doc: unknown;
  try {
    doc = parse(text);
  } catch (err) {
    fail(`Not valid YAML: ${(err as Error).message}`);
    return plan;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    fail('The file must be a mapping with zones: and gates: lists.');
    return plan;
  }
  const d = doc as { version?: unknown; zones?: unknown; gates?: unknown };
  if (d.version !== undefined && d.version !== 1) fail(`version ${String(d.version)} is not supported (expected 1).`);
  if (d.zones !== undefined && !Array.isArray(d.zones)) fail('zones: must be a list.');
  if (d.gates !== undefined && !Array.isArray(d.gates)) fail('gates: must be a list.');
  const zoneDocs = (Array.isArray(d.zones) ? d.zones : []) as Array<Partial<ZoneDoc>>;
  const gateDocs = (Array.isArray(d.gates) ? d.gates : []) as Array<Partial<GateDoc>>;

  // ---- zones ----
  const existingZones = [...policy.zones.values()].filter((z) => !z.demo);
  const zoneByName = new Map<string, ZoneRecord>();
  for (const z of existingZones) if (!zoneByName.has(z.name)) zoneByName.set(z.name, z);
  const fileZones = new Set<string>();
  zoneDocs.forEach((z, i) => {
    const where = `zones[${i}]`;
    const name = typeof z?.name === 'string' ? z.name.trim() : '';
    if (!name) return fail(`${where}: name is required.`);
    if (fileZones.has(name)) return fail(`Zone "${name}" appears twice.`);
    fileZones.add(name);
    if (z.members !== undefined && !strings(z.members)) return fail(`Zone "${name}": members must be a list of references.`);
    const stations: string[] = [];
    for (const ref of z.members ?? []) {
      const s = n.station(ref);
      if ('error' in s) fail(`Zone "${name}": ${s.error}.`);
      else stations.push(s.id);
    }
    const match: ZoneMatch = {};
    if (z.match !== undefined) {
      if (!z.match || typeof z.match !== 'object') return fail(`Zone "${name}": match must be a mapping.`);
      for (const [k, v] of Object.entries(z.match)) {
        if (!['teams', 'projects', 'tags', 'provider_kinds'].includes(k)) fail(`Zone "${name}": unknown match field "${k}" (teams, projects, tags, provider_kinds).`);
        else if (!strings(v)) fail(`Zone "${name}": match.${k} must be a list of strings.`);
        else (match as Record<string, string[]>)[k] = v;
      }
    }
    const row: ZoneRow = { name, color: typeof z.color === 'string' ? z.color : (zoneByName.get(name)?.color ?? '#64d2ff'), stations: [...new Set(stations)].sort(), match };
    plan.rows.zones.push(row);
    const cur = zoneByName.get(name);
    if (!cur) plan.zones.create.push(name);
    else if (cur.color === row.color && same([...cur.stations].sort(), row.stations) && same(cur.match, row.match)) plan.zones.unchanged.push(name);
    else plan.zones.update.push(name);
  });
  if (mode === 'replace') plan.zones.remove = existingZones.filter((z) => !fileZones.has(z.name)).map((z) => z.name);
  const zoneAvailable = (name: string) => fileZones.has(name) || (mode === 'merge' && zoneByName.has(name));

  // ---- gates ----
  const existingRules = policy.rules.filter((r) => !r.demo);
  const ruleByName = new Map<string, RuleRecord>();
  for (const r of existingRules) if (!ruleByName.has(r.name)) ruleByName.set(r.name, r);
  const fileGates = new Set<string>();
  gateDocs.forEach((g, i) => {
    const where = `gates[${i}]`;
    const name = typeof g?.name === 'string' ? g.name.trim() : '';
    if (!name) return fail(`${where}: name is required.`);
    if (fileGates.has(name)) return fail(`Gate "${name}" appears twice.`);
    fileGates.add(name);
    const effect = g.effect;
    if (!effect || !(EFFECTS as readonly string[]).includes(effect)) return fail(`Gate "${name}": effect must be ${EFFECTS.join(' | ')}.`);
    const target = g.target ?? 'any';
    if (!(TARGETS as readonly string[]).includes(target)) return fail(`Gate "${name}": target must be model | tool | any.`);
    for (const side of ['from', 'to'] as const) {
      const z = g[side];
      if (z !== undefined && (typeof z !== 'string' || !zoneAvailable(z))) fail(`Gate "${name}": ${side} zone "${String(z)}" is not defined${mode === 'replace' ? ' in this file' : ''}.`);
    }
    const m = (g.match ?? {}) as NonNullable<GateDoc['match']>;
    if (typeof m !== 'object' || Array.isArray(m)) return fail(`Gate "${name}": match must be a mapping.`);
    for (const k of Object.keys(m)) if (!['agents', 'deployments', 'servers', 'models', 'tools', 'operations', 'args'].includes(k)) fail(`Gate "${name}": unknown match field "${k}".`);
    for (const k of ['agents', 'deployments', 'servers', 'models', 'tools', 'operations'] as const) if (m[k] !== undefined && !strings(m[k])) fail(`Gate "${name}": match.${k} must be a list of strings.`);
    const resolve = (xs: string[] | undefined, f: (x: string) => string | undefined, problem: (x: string) => string) =>
      (xs ?? []).flatMap((x) => {
        const id = f(x);
        if (!id) fail(`Gate "${name}": ${problem(x)}.`);
        return id ? [id] : [];
      });
    const badOps = (m.operations ?? []).filter((o) => !(OPERATIONS as readonly string[]).includes(o));
    if (badOps.length) fail(`Gate "${name}": unknown operation(s) ${badOps.join(', ')} (read, write, admin, unknown).`);
    if (m.args !== undefined && (!Array.isArray(m.args) || m.args.some((a) => !a || typeof a.path !== 'string' || typeof a.op !== 'string'))) fail(`Gate "${name}": match.args must be a list of {path, op, value}.`);
    const match: RuleMatch = clean({
      keys: resolve(m.agents, n.agentId, n.agentProblem),
      deployments: resolve(m.deployments, n.deploymentId, (x) => `no model named "${x}"`),
      mcp_servers: resolve(m.servers, n.serverId, (x) => `no tool server with slug "${x}"`),
      models: m.models,
      tools: m.tools,
      operations: m.operations,
      args: m.args,
    }) as RuleMatch;
    const config = (g.config ?? {}) as RuleConfig;
    if (typeof config !== 'object' || Array.isArray(config)) return fail(`Gate "${name}": config must be a mapping.`);
    if (effect === 'inspect') {
      const bad = inspectConfigError(config);
      if (bad) fail(`Gate "${name}": ${bad}.`);
    }
    if (g.priority !== undefined && typeof g.priority !== 'number') fail(`Gate "${name}": priority must be a number.`);
    const row: RuleRow = { name, from: g.from ?? null, to: g.to ?? null, targetKind: target, match, effect, config, priority: g.priority ?? 100, enabled: g.enabled !== false };
    plan.rows.gates.push(row);
    const cur = ruleByName.get(name);
    if (!cur) return void plan.gates.create.push(name);
    const curFrom = cur.fromZone ? (policy.zones.get(cur.fromZone)?.name ?? null) : null;
    const curTo = cur.toZone ? (policy.zones.get(cur.toZone)?.name ?? null) : null;
    const unchanged = curFrom === row.from && curTo === row.to && cur.targetKind === row.targetKind && same(cur.match, row.match) && cur.effect === row.effect && same(cur.config, row.config) && cur.priority === row.priority && cur.enabled === row.enabled;
    (unchanged ? plan.gates.unchanged : plan.gates.update).push(name);
  });
  if (mode === 'replace') plan.gates.remove = existingRules.filter((r) => !fileGates.has(r.name)).map((r) => r.name);
  if (!zoneDocs.length && !gateDocs.length) plan.warnings.push(mode === 'replace' ? 'The file has no zones or gates: applying it removes every zone and gate you created.' : 'The file has no zones or gates.');
  return plan;
}

/** Writes a plan without errors in one transaction and reloads the policy. */
export async function applyPolicyImport(ctx: AppContext, plan: ImportPlan): Promise<void> {
  if (plan.errors.length) throw new Error('The policy has errors; fix them before applying.');
  const policy = ctx.policy as PolicyService;
  const now = Date.now();
  const zoneIds = new Map<string, string>();
  for (const z of policy.zones.values()) if (!z.demo && !zoneIds.has(z.name)) zoneIds.set(z.name, z.id);
  const ruleByName = new Map<string, RuleRecord>();
  for (const r of policy.rules) if (!r.demo && !ruleByName.has(r.name)) ruleByName.set(r.name, r);
  const removedRules = plan.gates.remove.map((n) => ruleByName.get(n)!.id);

  await ctx.db.write.transaction().execute(async (trx) => {
    if (removedRules.length) {
      await trx.deleteFrom('alert_rules').where('rule_id', 'in', removedRules).execute();
      await trx.deleteFrom('rules').where('id', 'in', removedRules).execute();
    }
    for (const name of plan.zones.remove) await trx.deleteFrom('zones').where('id', '=', zoneIds.get(name)!).execute();
    for (const z of plan.rows.zones) {
      const selector = JSON.stringify({ stations: z.stations, match: z.match });
      const id = zoneIds.get(z.name);
      if (id) await trx.updateTable('zones').set({ color: z.color, selector, updated_at: now }).where('id', '=', id).execute();
      else {
        const nid = `zone_${ulid()}`;
        zoneIds.set(z.name, nid);
        await trx.insertInto('zones').values({ id: nid, name: z.name, color: z.color, selector, position: null, demo: 0, created_at: now, updated_at: now }).execute();
      }
    }
    for (const g of plan.rows.gates) {
      if (plan.gates.unchanged.includes(g.name)) continue;
      const values = {
        from_zone: g.from ? zoneIds.get(g.from)! : null,
        to_zone: g.to ? zoneIds.get(g.to)! : null,
        target_kind: g.targetKind,
        match: JSON.stringify(g.match),
        effect: g.effect,
        config: JSON.stringify(g.config),
        priority: g.priority,
        enabled: g.enabled ? 1 : 0,
        updated_at: now,
      };
      const cur = ruleByName.get(g.name);
      if (cur) await trx.updateTable('rules').set({ ...values, revision: cur.revision + 1 }).where('id', '=', cur.id).execute();
      else await trx.insertInto('rules').values({ id: `rule_${ulid()}`, name: g.name, ...values, revision: 1, demo: 0, created_at: now }).execute();
    }
  });
  await policy.reload();
  if (removedRules.length) await ctx.alerts.reload();
}
