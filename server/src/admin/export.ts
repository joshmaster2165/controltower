import type { FastifyInstance } from 'fastify';
import { formatUsd } from '@controltower/shared';
import { METHODS } from '../a2a/card.js';
import type { AppContext } from '../context.js';
import { requireAdmin } from './auth.js';
import type { PolicyService, RuleRecord } from '../policy/policy.js';
import type { PolicyTarget } from '../policy/engine.js';
import { classifyOperation } from '../mcp/gateway.js';
import { routeOperation } from '../http/route.js';
import { globMatch } from '../registry.js';

/**
 * The data-flow inventory: every agent, every model and tool server, every
 * path between them seen in the window, and — for each path — what Control
 * Tower does about it today (access decision, content inspection, key
 * permissions). JSON for the console, Markdown for docs, CSV for spreadsheets.
 */

export interface PathRow {
  agent: string;
  agent_id: string;
  team: string | null;
  kind: 'model' | 'tool';
  target: string;
  target_id: string;
  provider: string;
  tool: string | null;
  operation: string | null;
  requests: number;
  errors: number;
  blocked: number;
  held: number;
  spend_nanousd: number;
  tokens: number;
  last_seen: number;
  /** What the gates do on this path right now (argument conditions aside). */
  access: 'allow' | 'deny' | 'hold';
  access_gate: string | null;
  inspected_by: string[];
  key_permits: boolean;
}

export interface DataflowInventory {
  generated_at: number;
  window_hours: number;
  enforcement: boolean;
  totals: { agents: number; models: number; mcp_servers: number; paths: number; requests: number; spend_nanousd: number; gates: number };
  agents: Array<{ id: string; name: string; team: string | null; project: string | null; zones: string[]; models_allowed: string[]; tools_allowed: string[]; requests: number; spend_nanousd: number; last_used: number | null }>;
  models: Array<{ id: string; name: string; upstream: string; provider: string; provider_kind: string; zones: string[]; requests: number }>;
  mcp_servers: Array<{ id: string; name: string; url: string; health: string; zones: string[]; tools: Array<{ name: string; operation: string }> }>;
  paths: PathRow[];
  gates: Array<{ id: string; name: string; effect: string; covers: string; enabled: boolean; hits: number }>;
  zones: Array<{ id: string; name: string; members: number }>;
  /** Paths agents reported (SDK / OpenTelemetry) that do not pass through Control Tower. */
  observed: Array<{ agent: string; team: string | null; target: string; system: string | null; kind: string; bypass: boolean; calls: number; errors: number; writes: number; last_seen: number }>;
}

function describeScope(r: RuleRecord, ctx: AppContext, policy: PolicyService): string {
  const key = (id: string) => ctx.registry.keysById.get(id)?.name ?? id;
  const dep = (id: string) => {
    const d = ctx.registry.deployments.get(id);
    return d ? (d.publicName ?? d.upstreamModel) : id;
  };
  const mcp = (id: string) => ctx.mcp.servers.get(id)?.name ?? ctx.http.apis.get(id)?.name ?? ctx.a2a.agents.get(id)?.name ?? id;
  const zone = (id: string) => policy.zones.get(id)?.name ?? id;
  const who = [...(r.match.keys ?? []).map(key), ...(r.match.groups ?? []).map((g) => `${g} (every copy)`), ...(r.match.teams ?? []).map((t) => `team ${t}`)];
  const from = who.length ? who.join(', ') : r.fromZone ? `${zone(r.fromZone)} agents` : 'any agent';
  const dests = [...(r.match.deployments ?? []).map(dep), ...(r.match.mcp_servers ?? []).map(mcp)];
  let to = dests.length ? dests.join(', ') : r.toZone ? zone(r.toZone) : 'anything';
  if (r.match.tools?.length) to += ` (${r.match.tools.join(', ')})`;
  if (r.match.operations?.length) to += ` [${r.match.operations.join('/')}]`;
  const behalf = r.match.on_behalf_of?.length ? `, on behalf of ${r.match.on_behalf_of.map((p) => (p.startsWith('team:') ? `team ${p.slice(5)}` : p.replace(/^agent:/, ''))).join(' or ')}` : '';
  return `${from} → ${to}${behalf}`;
}

export async function buildInventory(ctx: AppContext, hours: number): Promise<DataflowInventory> {
  const policy = ctx.policy as PolicyService;
  const since = Date.now() - hours * 3600_000;
  const rows = await ctx.db.read
    .selectFrom('flights')
    .select(['key_id', 'kind', 'deployment_id', 'mcp_server_id', 'tool', 'model_requested'])
    .select((eb) => [
      eb.fn.countAll<number>().as('requests'),
      eb.fn.sum<number>(eb.case().when('status', '=', 'error').then(1).else(0).end()).as('errors'),
      eb.fn.sum<number>(eb.case().when('status', '=', 'denied').then(1).else(0).end()).as('blocked'),
      eb.fn.sum<number>(eb.case().when('approval_id', 'is not', null).then(1).else(0).end()).as('held'),
      eb.fn.sum<number>(eb.fn.coalesce('cost_nanousd', eb.lit(0))).as('spend'),
      eb.fn.sum<number>(eb(eb.fn.coalesce('in_tokens', eb.lit(0)), '+', eb.fn.coalesce('out_tokens', eb.lit(0)))).as('tokens'),
      eb.fn.max<number>('ts').as('last_seen'),
    ])
    .where('ts', '>', since)
    .where('status', '!=', 'rejected')
    .groupBy(['key_id', 'kind', 'deployment_id', 'mcp_server_id', 'tool', 'model_requested'])
    .execute();

  const paths: PathRow[] = [];
  const agentUse = new Map<string, { requests: number; spend: number }>();
  const modelUse = new Map<string, number>();
  for (const r of rows) {
    const key = ctx.registry.keysById.get(r.key_id);
    if (!key) continue;
    const isHttp = r.kind === 'http.request';
    const isA2a = r.kind === 'a2a.call';
    const isTool = r.kind === 'mcp.tool' || isHttp || isA2a;
    let target: PolicyTarget;
    let row: Pick<PathRow, 'kind' | 'target' | 'target_id' | 'provider' | 'tool' | 'operation'>;
    if (isTool) {
      const server = r.mcp_server_id ? ctx.mcp.servers.get(r.mcp_server_id) : undefined;
      const api = isHttp && r.mcp_server_id ? ctx.http.apis.get(r.mcp_server_id) : undefined;
      const agent = isA2a && r.mcp_server_id ? ctx.a2a.agents.get(r.mcp_server_id) : undefined;
      const tool = server?.tools.find((t) => t.name === r.tool);
      const op = isHttp ? routeOperation(r.tool) : isA2a ? (METHODS[r.tool ?? '']?.op ?? 'write') : tool ? classifyOperation(tool) : 'unknown';
      target = { kind: 'tool', name: r.model_requested, mcpServerId: r.mcp_server_id ?? undefined, operation: op };
      row = { kind: 'tool', target: agent?.name ?? api?.name ?? server?.name ?? r.model_requested, target_id: r.mcp_server_id ?? '', provider: isHttp ? 'HTTP' : isA2a ? 'A2A' : 'MCP', tool: r.tool, operation: op };
    } else {
      const dep = r.deployment_id ? ctx.registry.deployments.get(r.deployment_id) : undefined;
      const prov = dep ? ctx.registry.providers.get(dep.providerId) : undefined;
      target = { kind: 'model', name: r.model_requested, deploymentId: r.deployment_id ?? undefined, providerId: prov?.id, providerKind: prov?.kind, operation: 'read' };
      row = { kind: 'model', target: dep ? (dep.publicName ?? dep.upstreamModel) : r.model_requested, target_id: r.deployment_id ?? '', provider: prov?.name ?? '—', tool: null, operation: null };
      if (r.deployment_id) modelUse.set(r.deployment_id, (modelUse.get(r.deployment_id) ?? 0) + Number(r.requests));
    }
    const decision = policy.evaluateWith(policy.rules, { flightId: '', key, target, args: undefined, estInputTokens: 0, projectedNanousd: 0 });
    const inspect = policy.inspectors(key, target).map((g) => g.rule.name);
    const permits = isTool ? key.allowedMcp.some((g) => globMatch(g, r.model_requested)) : ctx.registry.keyMayUseModel(key, r.model_requested);
    paths.push({
      agent: key.name,
      agent_id: key.id,
      team: key.team ?? null,
      ...row,
      requests: Number(r.requests),
      errors: Number(r.errors ?? 0),
      blocked: Number(r.blocked ?? 0),
      held: Number(r.held ?? 0),
      spend_nanousd: Number(r.spend ?? 0),
      tokens: Number(r.tokens ?? 0),
      last_seen: Number(r.last_seen),
      access: decision.effect,
      access_gate: decision.rule?.name ?? null,
      inspected_by: inspect,
      key_permits: permits,
    });
    const u = agentUse.get(key.id) ?? { requests: 0, spend: 0 };
    u.requests += Number(r.requests);
    u.spend += Number(r.spend ?? 0);
    agentUse.set(key.id, u);
  }
  paths.sort((a, b) => a.agent.localeCompare(b.agent) || b.requests - a.requests);

  const zoneNames = (zs: Array<{ name: string }>) => zs.map((z) => z.name);
  const agents = [...ctx.registry.keysById.values()]
    .filter((k) => k.name !== 'playground' || agentUse.has(k.id))
    .map((k) => ({
      id: k.id,
      name: k.name,
      team: k.team ?? null,
      project: k.project ?? null,
      zones: zoneNames(policy.sourceZones(k)),
      models_allowed: k.allowedModels,
      tools_allowed: k.allowedMcp,
      requests: agentUse.get(k.id)?.requests ?? 0,
      spend_nanousd: agentUse.get(k.id)?.spend ?? 0,
      last_used: k.lastUsedAt ?? null,
    }))
    .sort((a, b) => b.requests - a.requests);
  const models = [...ctx.registry.deployments.values()].map((d) => {
    const prov = ctx.registry.providers.get(d.providerId);
    return {
      id: d.id,
      name: d.publicName ?? d.upstreamModel,
      upstream: d.upstreamModel,
      provider: prov?.name ?? '—',
      provider_kind: prov?.kind ?? '—',
      zones: zoneNames(policy.targetZones({ kind: 'model', name: d.publicName ?? d.upstreamModel, deploymentId: d.id, providerId: d.providerId, providerKind: prov?.kind, operation: 'read' })),
      requests: modelUse.get(d.id) ?? 0,
    };
  });
  const mcpServers = [...ctx.mcp.servers.values()].map((m) => ({
    id: m.id,
    name: m.name,
    url: m.url,
    health: m.health,
    zones: zoneNames(policy.targetZones({ kind: 'tool', name: `${m.slug}__*`, mcpServerId: m.id, operation: 'unknown' })),
    tools: m.tools.map((t) => ({ name: t.name, operation: classifyOperation(t) })),
  }));
  const hits = await ctx.db.read.selectFrom('flights').select(['rule_id']).select((eb) => eb.fn.countAll<number>().as('n')).where('ts', '>', since).where('rule_id', 'is not', null).groupBy('rule_id').execute();
  const hitBy = new Map(hits.map((h) => [h.rule_id!, Number(h.n)]));
  const gates = policy.rules.map((r) => ({ id: r.id, name: r.name, effect: r.effect, covers: describeScope(r, ctx, policy), enabled: r.enabled, hits: hitBy.get(r.id) ?? 0 }));
  const zones = [...policy.zones.values()].map((z) => ({ id: z.id, name: z.name, members: z.stations.size }));
  const obs = await ctx.observed.summary(since);
  const obsTargets = new Map(obs.targets.map((t) => [t.id, t]));
  const observed = obs.edges
    .map((e) => {
      const t = obsTargets.get(e.target_id);
      const k = ctx.registry.keysById.get(e.key_id);
      return { agent: k?.name ?? e.key_id, team: k?.team ?? null, target: t?.target ?? e.target_id, system: t?.system ?? null, kind: t?.kind ?? 'other', bypass: !!t?.bypass, calls: e.count_24h, errors: e.errors_24h, writes: e.writes_24h, last_seen: e.last_seen };
    })
    .sort((a, b) => Number(b.bypass) - Number(a.bypass) || a.agent.localeCompare(b.agent) || b.calls - a.calls);

  return {
    generated_at: Date.now(),
    window_hours: hours,
    enforcement: policy.enforcementOn(),
    totals: {
      agents: agents.length,
      models: models.length,
      mcp_servers: mcpServers.length,
      paths: paths.length,
      requests: paths.reduce((n, p) => n + p.requests, 0),
      spend_nanousd: paths.reduce((n, p) => n + p.spend_nanousd, 0),
      gates: gates.length,
    },
    agents,
    models,
    mcp_servers: mcpServers,
    paths,
    gates,
    zones,
    observed,
  };
}

/** Spend, without five-decimal noise for fractions of a cent. */
const usd = (nano: number) => (!nano ? '—' : nano < 1_000_000 ? '<$0.001' : formatUsd(nano));

const ACCESS: Record<PathRow['access'], string> = { allow: 'allowed', deny: 'blocked', hold: 'needs approval' };

function csvCell(v: unknown): string {
  const s = v == null ? '' : Array.isArray(v) ? v.join('; ') : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function inventoryCsv(inv: DataflowInventory): string {
  const cols: Array<keyof PathRow> = ['agent', 'team', 'kind', 'target', 'provider', 'tool', 'operation', 'requests', 'errors', 'blocked', 'held', 'spend_nanousd', 'tokens', 'access', 'access_gate', 'inspected_by', 'key_permits', 'last_seen'];
  const lines = [cols.map((c) => (c === 'spend_nanousd' ? 'spend_usd' : c === 'last_seen' ? 'last_seen_utc' : c)).join(',')];
  for (const p of inv.paths) {
    lines.push(
      cols
        .map((c) => (c === 'spend_nanousd' ? (p.spend_nanousd / 1e9).toFixed(6) : c === 'last_seen' ? new Date(p.last_seen).toISOString() : csvCell(p[c])))
        .join(','),
    );
  }
  return lines.join('\n') + '\n';
}

function mdCell(v: unknown): string {
  return String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function inventoryMarkdown(inv: DataflowInventory): string {
  const n = (x: number) => x.toLocaleString('en-US');
  const at = new Date(inv.generated_at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const out: string[] = [];
  out.push(`# Agent data-flow inventory`, '', `Generated by Control Tower on ${at}, covering the last ${inv.window_hours} hours. Enforcement is **${inv.enforcement ? 'on' : 'off'}**.`, '');
  out.push(`${n(inv.totals.agents)} agents · ${n(inv.totals.models)} model deployments · ${n(inv.totals.mcp_servers)} MCP servers · ${n(inv.totals.paths)} active paths · ${n(inv.totals.requests)} requests · ${formatUsd(inv.totals.spend_nanousd)} spend · ${n(inv.totals.gates)} gates`, '');
  out.push('## Paths', '', 'Every agent → model or tool path seen in the window, and what Control Tower does on it today (argument-dependent gates aside).', '');
  out.push('| Agent | Target | Via | Requests | Errors | Blocked | Held | Spend | Access | Inspected by | Key allows |', '|---|---|---|---:|---:|---:|---:|---:|---|---|---|');
  for (const p of inv.paths) {
    const target = p.kind === 'tool' ? `${p.target} → ${p.tool} (${p.operation})` : p.target;
    out.push(`| ${mdCell(p.agent)} | ${mdCell(target)} | ${mdCell(p.provider)} | ${n(p.requests)} | ${n(p.errors)} | ${n(p.blocked)} | ${n(p.held)} | ${usd(p.spend_nanousd)} | ${ACCESS[p.access]}${p.access_gate ? ` (${mdCell(p.access_gate)})` : ''} | ${mdCell(p.inspected_by.join(', ') || '—')} | ${p.key_permits ? 'yes' : '**no**'} |`);
  }
  out.push('', '## Agents', '', '| Agent | Team | Project | Zones | Models allowed | Tools allowed | Requests | Spend |', '|---|---|---|---|---|---|---:|---:|');
  for (const a of inv.agents) out.push(`| ${mdCell(a.name)} | ${mdCell(a.team ?? '—')} | ${mdCell(a.project ?? '—')} | ${mdCell(a.zones.join(', ') || '—')} | ${mdCell(a.models_allowed.join(', '))} | ${mdCell(a.tools_allowed.join(', '))} | ${n(a.requests)} | ${usd(a.spend_nanousd)} |`);
  out.push('', '## Models', '', '| Name | Upstream model | Provider | Zones | Requests |', '|---|---|---|---|---:|');
  for (const m of inv.models) out.push(`| ${mdCell(m.name)} | ${mdCell(m.upstream)} | ${mdCell(`${m.provider} (${m.provider_kind})`)} | ${mdCell(m.zones.join(', ') || '—')} | ${n(m.requests)} |`);
  if (inv.mcp_servers.length) {
    out.push('', '## MCP tool servers', '', '| Server | URL | Health | Zones | Tools |', '|---|---|---|---|---|');
    for (const s of inv.mcp_servers) out.push(`| ${mdCell(s.name)} | ${mdCell(s.url)} | ${mdCell(s.health)} | ${mdCell(s.zones.join(', ') || '—')} | ${mdCell(s.tools.map((t) => `${t.name} (${t.operation})`).join(', '))} |`);
  }
  out.push('', '## Gates', '', '| Gate | Effect | Covers | Enabled | Decisions in window |', '|---|---|---|---|---:|');
  for (const g of inv.gates) out.push(`| ${mdCell(g.name)} | ${mdCell(g.effect.replace('_', ' '))} | ${mdCell(g.covers)} | ${g.enabled ? 'yes' : 'no'} | ${n(g.hits)} |`);
  if (inv.zones.length) {
    out.push('', '## Zones', '');
    for (const z of inv.zones) out.push(`- **${z.name}** — ${z.members} explicit member${z.members === 1 ? '' : 's'}`);
  }
  if (inv.observed.length) {
    out.push('', '## Seen, not enforced', '', 'Calls agents reported (SDK / OpenTelemetry) that do not pass through Control Tower. They are documented here but no gate, budget or inspection applies to them.', '');
    out.push('| Agent | System | Kind | Calls | Writes | Errors | Note |', '|---|---|---|---:|---:|---:|---|');
    for (const o of inv.observed) out.push(`| ${mdCell(o.agent)} | ${mdCell(o.system ? `${o.system} (${o.target})` : o.target)} | ${mdCell(o.kind)} | ${n(o.calls)} | ${n(o.writes)} | ${n(o.errors)} | ${o.bypass ? '**calls a model provider directly — bypasses the gateway**' : ''} |`);
  }
  out.push('', '---', '', 'Only traffic that passes through Control Tower is listed and enforced. Access decisions shown ignore gates that depend on tool arguments; those are evaluated per call.', '');
  return out.join('\n');
}

export async function exportRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const guard = requireAdmin(ctx);
  app.get('/admin/api/export/dataflow', { preHandler: guard }, async (req, reply) => {
    const q = req.query as { hours?: string; format?: string };
    const hours = Math.min(24 * 30, Math.max(1, Number(q.hours ?? 24) || 24));
    const inv = await buildInventory(ctx, hours);
    const stamp = new Date(inv.generated_at).toISOString().slice(0, 10);
    if (q.format === 'csv') {
      return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="controltower-paths-${stamp}.csv"`).send(inventoryCsv(inv));
    }
    if (q.format === 'md') {
      return reply.header('content-type', 'text/markdown; charset=utf-8').header('content-disposition', `attachment; filename="controltower-dataflow-${stamp}.md"`).send(inventoryMarkdown(inv));
    }
    return inv;
  });
}
