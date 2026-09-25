import type { Kysely } from 'kysely';
import { METHODS } from '../a2a/card.js';
import type { Database } from '../db/schema.js';
import type { Registry } from '../registry.js';
import type { McpRegistry } from '../mcp/registry.js';
import type { PolicyTarget } from './engine.js';
import type { PolicyService, RuleRecord } from './policy.js';
import { classifyOperation } from '../mcp/gateway.js';
import { routeOperation } from '../http/route.js';

/**
 * "What would this gate have done?" Replays recorded flights through the
 * current rules and through the rules with a draft gate added (or an existing
 * gate changed), and reports only the flights whose outcome changes — so every
 * number is attributable to the draft alone.
 *
 * Honest limits, reported with the result: arguments and bodies are not
 * stored, so argument conditions cannot be replayed and inspect gates cannot
 * be simulated; held requests are counted as held, not guessed approved.
 */

export type Effect = 'allow' | 'deny' | 'hold';

export interface SimulationResult {
  window_hours: number;
  considered: number;
  truncated: boolean;
  changed: { to_deny: number; to_hold: number; to_allow: number };
  /** Spend on flights that would have been blocked (they would not have reached the provider). */
  cost_avoided_nanousd: number;
  agents: Array<{ key_id: string; name: string; deny: number; hold: number; allow: number }>;
  destinations: Array<{ id: string; name: string; deny: number; hold: number; allow: number }>;
  /** Agent → destination pairs, for highlighting paths on the map. */
  lanes: Array<{ key_id: string; target_id: string; deny: number; hold: number; allow: number }>;
  samples: Array<{ ts: number; agent: string; destination: string; before: Effect; after: Effect }>;
  notes: string[];
}

const MAX_FLIGHTS = 200_000;
const YIELD_EVERY = 5_000;

export async function simulate(
  deps: { db: Kysely<Database>; policy: PolicyService; registry: Registry; mcp: McpRegistry },
  draft: RuleRecord | null,
  /**
   * replaceRuleId: the draft is an edited version of this gate.
   * impactOfRuleId: no draft — measure what this existing gate does, by
   * comparing the rules without it (before) to the rules as they are (after).
   */
  opts: { replaceRuleId?: string | undefined; impactOfRuleId?: string | undefined; windowHours?: number | undefined } = {},
): Promise<SimulationResult> {
  const hours = Math.min(24 * 30, Math.max(1, opts.windowHours ?? 24));
  const since = Date.now() - hours * 3600_000;
  let baseline = deps.policy.rules;
  let candidate: RuleRecord[];
  if (opts.impactOfRuleId) {
    candidate = baseline;
    baseline = baseline.filter((r) => r.id !== opts.impactOfRuleId);
  } else {
    if (!draft) throw new Error('simulate needs a draft or impactOfRuleId');
    candidate = [...baseline.filter((r) => r.id !== (opts.replaceRuleId ?? draft.id)), { ...draft, enabled: true }].sort((a, b) => a.priority - b.priority);
  }

  const rows = await deps.db
    .selectFrom('flights')
    .select(['ts', 'key_id', 'key_name', 'kind', 'model_requested', 'deployment_id', 'provider_id', 'provider_kind', 'mcp_server_id', 'tool', 'status', 'cost_nanousd'])
    .where('ts', '>', since)
    .where('status', '!=', 'rejected') // never reached policy (auth, limits, unknown model)
    .orderBy('ts', 'desc')
    .limit(MAX_FLIGHTS + 1)
    .execute();

  const result: SimulationResult = {
    window_hours: hours,
    considered: 0,
    truncated: rows.length > MAX_FLIGHTS,
    changed: { to_deny: 0, to_hold: 0, to_allow: 0 },
    cost_avoided_nanousd: 0,
    agents: [],
    destinations: [],
    lanes: [],
    samples: [],
    notes: [],
  };
  const agents = new Map<string, SimulationResult['agents'][number]>();
  const dests = new Map<string, SimulationResult['destinations'][number]>();
  const lanes = new Map<string, SimulationResult['lanes'][number]>();
  let unknownKeys = 0;

  let i = 0;
  for (const f of rows.slice(0, MAX_FLIGHTS)) {
    // Replaying runs on the gateway's event loop: yield regularly so live traffic is never stalled.
    if (++i % YIELD_EVERY === 0) await new Promise((r) => setImmediate(r));
    const key = deps.registry.keysById.get(f.key_id);
    if (!key) {
      unknownKeys++;
      continue;
    }
    let target: PolicyTarget;
    let targetId: string;
    let destName: string;
    if (f.kind === 'http.request') {
      target = { kind: 'tool', name: f.model_requested, mcpServerId: f.mcp_server_id ?? undefined, operation: routeOperation(f.tool) };
      targetId = f.mcp_server_id ?? f.model_requested;
      destName = f.model_requested;
    } else if (f.kind === 'a2a.call') {
      const method = String(f.tool ?? '');
      target = { kind: 'tool', name: f.model_requested, mcpServerId: f.mcp_server_id ?? undefined, operation: METHODS[method]?.op ?? 'write' };
      targetId = f.mcp_server_id ?? f.model_requested;
      destName = f.model_requested;
    } else if (f.kind === 'mcp.tool') {
      const server = f.mcp_server_id ? deps.mcp.servers.get(f.mcp_server_id) : undefined;
      const tool = server?.tools.find((t) => t.name === f.tool);
      target = { kind: 'tool', name: f.model_requested, mcpServerId: f.mcp_server_id ?? undefined, operation: tool ? classifyOperation(tool) : 'unknown' };
      targetId = f.mcp_server_id ?? f.model_requested;
      destName = f.model_requested;
    } else {
      const dep = f.deployment_id ? deps.registry.deployments.get(f.deployment_id) : undefined;
      target = { kind: 'model', name: f.model_requested, deploymentId: f.deployment_id ?? undefined, providerId: f.provider_id ?? undefined, providerKind: f.provider_kind ?? undefined, operation: 'read' };
      targetId = f.deployment_id ?? f.model_requested;
      destName = dep ? (dep.publicName ?? dep.upstreamModel) : f.model_requested;
    }
    result.considered++;
    const input = { flightId: '', key, target, args: undefined, estInputTokens: 0, projectedNanousd: 0 };
    const before = deps.policy.evaluateWith(baseline, input).effect;
    const after = deps.policy.evaluateWith(candidate, input).effect;
    if (before === after) continue;

    const bucket = after === 'deny' ? 'deny' : after === 'hold' ? 'hold' : 'allow';
    result.changed[after === 'deny' ? 'to_deny' : after === 'hold' ? 'to_hold' : 'to_allow']++;
    if (after === 'deny') result.cost_avoided_nanousd += f.cost_nanousd ?? 0;
    const a = agents.get(key.id) ?? { key_id: key.id, name: key.name, deny: 0, hold: 0, allow: 0 };
    a[bucket]++;
    agents.set(key.id, a);
    const d = dests.get(targetId) ?? { id: targetId, name: destName, deny: 0, hold: 0, allow: 0 };
    d[bucket]++;
    dests.set(targetId, d);
    const lk = `${key.id}|${targetId}`;
    const l = lanes.get(lk) ?? { key_id: key.id, target_id: targetId, deny: 0, hold: 0, allow: 0 };
    l[bucket]++;
    lanes.set(lk, l);
    if (result.samples.length < 8) result.samples.push({ ts: f.ts, agent: key.name, destination: destName, before, after });
  }

  const total = (x: { deny: number; hold: number; allow: number }) => x.deny + x.hold + x.allow;
  result.agents = [...agents.values()].sort((x, y) => total(y) - total(x)).slice(0, 12);
  result.destinations = [...dests.values()].sort((x, y) => total(y) - total(x)).slice(0, 12);
  result.lanes = [...lanes.values()];
  if ((draft ?? deps.policy.rules.find((r) => r.id === opts.impactOfRuleId))?.match.args?.length) result.notes.push('This gate has argument conditions. Arguments are not stored, so matches that depend on them are not counted.');
  if (unknownKeys) result.notes.push(`${unknownKeys} flights from deleted keys were skipped.`);
  if (result.truncated) result.notes.push(`Only the most recent ${MAX_FLIGHTS.toLocaleString('en-US')} flights were replayed.`);
  if (!deps.policy.enforcementOn()) result.notes.push('Enforcement is currently off (CT_MODE=off): this shows what the gates would do once it is on.');
  return result;
}
