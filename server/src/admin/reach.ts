import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import type { PolicyTarget } from '../policy/engine.js';
import type { PolicyService } from '../policy/policy.js';
import { requireAdmin } from './auth.js';
import { scopeOf, seesKey } from './scope.js';
import { globMatch } from '../registry.js';
import { classifyOperation } from '../mcp/gateway.js';
import { routeOperation } from '../http/route.js';
import { defaultClass, isClass, type TrustClass } from '../airspace/classes.js';

/**
 * Reach: one agent's blast radius. Everything its key lets it reach (models, MCP tools, HTTP APIs, remote agents),
 * what it actually used in the window, what a gate would do on each, and the permissions it would keep if trimmed to
 * what it uses: least privilege, from its own traffic.
 *
 *   GET /admin/api/airspace/reach?key=<id>&days=30
 * Trimming is an edit of the key (PATCH /admin/api/keys/:id) with the `trim` lists.
 */
type Op = 'model' | 'read' | 'write' | 'admin' | 'unknown';
const OP_RANK: Record<Op, number> = { model: 0, unknown: 1, read: 1, write: 2, admin: 3 };

export interface ReachItem {
  id: string;
  ring: 'model' | 'tool' | 'outside';
  system_id: string;
  system: string;
  system_kind: 'provider' | 'alias' | 'mcp' | 'http' | 'a2a' | 'observed';
  /** What the agent asks for: a model or alias name, or a tool's full name (server__tool); "server__*" for an API. */
  name: string;
  label: string;
  op: Op;
  class: TrustClass;
  granted: boolean;
  used: boolean;
  calls: number;
  last_used: number | null;
  /** What the gateway's gates would do on it now (for an API: on a read). */
  access: 'allow' | 'hold' | 'deny' | 'outside';
  gate: string | null;
}

export async function reachRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const guard = requireAdmin(ctx);

  app.get('/admin/api/airspace/reach', { preHandler: guard }, async (req, reply) => {
    const q = req.query as { key?: string; days?: string };
    const days = Math.min(365, Math.max(1, Math.round(Number(q.days ?? 30)) || 30));
    const key = q.key ? ctx.registry.keysById.get(q.key) : undefined;
    const scope = scopeOf(req);
    if (!key || !(scope.all || seesKey(scope, key))) return reply.status(404).send({ error: { code: 'not_found', message: 'No such agent.' } });
    const since = Date.now() - days * 86_400_000;

    // What it did: its calls in the window, by what it asked for.
    const rows = await ctx.db.read
      .selectFrom('flights')
      .select((eb) => ['kind', 'model_requested', 'mcp_server_id', 'deployment_id', 'tool', eb.fn.countAll<number>().as('n'), eb.fn.max<number>('ts').as('last')])
      .where('key_id', '=', key.id)
      .where('ts', '>=', since)
      .groupBy(['kind', 'model_requested', 'mcp_server_id', 'deployment_id', 'tool'])
      .execute();
    const usedBy = new Map<string, { calls: number; last: number; ops: Set<Op> }>();
    const note = (k: string, n: number, last: number, op?: Op) => {
      const u = usedBy.get(k) ?? { calls: 0, last: 0, ops: new Set<Op>() };
      u.calls += Number(n);
      u.last = Math.max(u.last, Number(last));
      if (op) u.ops.add(op);
      usedBy.set(k, u);
    };
    for (const r of rows) {
      if (r.kind === 'mcp.tool') note(`tool:${r.model_requested}`, r.n, r.last);
      else if (r.kind === 'http.request' || r.kind === 'a2a.call') note(`api:${r.mcp_server_id}`, r.n, r.last, r.kind === 'http.request' ? (routeOperation(r.tool) as Op) : 'write');
      else note(`model:${r.model_requested}`, r.n, r.last);
    }

    const set = new Map((await ctx.db.read.selectFrom('trust_classes').selectAll().execute()).filter((r) => isClass(r.class)).map((r) => [r.system_id, r.class as TrustClass]));
    const classOf = (id: string, facts: Parameters<typeof defaultClass>[0]) => set.get(id) ?? defaultClass(facts).class;
    const decide = (target: PolicyTarget): { access: ReachItem['access']; gate: string | null } => {
      const policy = ctx.policy as PolicyService;
      const d = policy.evaluateWith(policy.rules, { flightId: '', key, target, args: undefined, estInputTokens: 0, projectedNanousd: 0 });
      return { access: d.effect === 'deny' ? 'deny' : d.effect === 'hold' ? 'hold' : 'allow', gate: d.rule?.name ?? null };
    };
    const items: ReachItem[] = [];
    const push = (it: Omit<ReachItem, 'used' | 'calls' | 'last_used'>, usedKey: string) => {
      const u = usedBy.get(usedKey);
      items.push({ ...it, used: !!u, calls: u?.calls ?? 0, last_used: u?.last ?? null, op: u?.ops.size ? [...u.ops].reduce((a, b) => (OP_RANK[b] > OP_RANK[a] ? b : a)) : it.op });
      usedBy.delete(usedKey);
    };

    // Models: aliases, and each deployment by the name agents ask for.
    for (const a of ctx.registry.aliases.values()) {
      push({ id: `alias:${a.name}`, ring: 'model', system_id: 'aliases', system: 'Aliases', system_kind: 'alias', name: a.name, label: a.name, op: 'model', class: 'D', granted: ctx.registry.keyMayUseModel(key, a.name), ...decide({ kind: 'model', name: a.name, operation: 'read' }) }, `model:${a.name}`);
    }
    for (const d of ctx.registry.deployments.values()) {
      if (!d.enabled) continue;
      const p = ctx.registry.providers.get(d.providerId);
      if (!p) continue;
      const name = d.publicName ?? `${p.slug}/${d.upstreamModel}`;
      const sys = `provider:${p.id}`;
      push(
        { id: `deployment:${d.id}`, ring: 'model', system_id: sys, system: p.name, system_kind: 'provider', name, label: name, op: 'model', class: classOf(sys, { id: sys, kind: 'model', name: p.name, url: p.baseUrl, subkind: p.kind }), granted: ctx.registry.keyMayUseModel(key, name), ...decide({ kind: 'model', name, deploymentId: d.id, providerId: p.id, providerKind: p.kind, operation: 'read' }) },
        `model:${name}`,
      );
    }
    // Tools: each MCP tool, by its full name; HTTP APIs and remote agents as a whole (their routes aren't listed).
    const mayTool = (full: string) => key.allowedMcp.some((g) => globMatch(g, full));
    for (const m of ctx.mcp.servers.values()) {
      const sys = `tool:${m.id}`;
      const cls = classOf(sys, { id: sys, kind: 'mcp', name: m.name, url: m.url });
      for (const t of m.tools) {
        const full = `${m.slug}__${t.name}`;
        const op = classifyOperation(t) as Op;
        push({ id: `tool:${full}`, ring: 'tool', system_id: sys, system: m.name, system_kind: 'mcp', name: full, label: t.name, op, class: cls, granted: mayTool(full), ...decide({ kind: 'tool', name: full, mcpServerId: m.id, operation: op as PolicyTarget['operation'] }) }, `tool:${full}`);
      }
    }
    for (const h of ctx.http.apis.values()) {
      const sys = `tool:${h.id}`;
      push(
        { id: `api:${h.id}`, ring: 'tool', system_id: sys, system: h.name, system_kind: 'http', name: `${h.slug}__*`, label: `${h.name} (any route)`, op: 'unknown', class: classOf(sys, { id: sys, kind: 'http', name: h.name, url: h.baseUrl }), granted: mayTool(`${h.slug}__GET /`), ...decide({ kind: 'tool', name: `${h.slug}__GET /`, mcpServerId: h.id, operation: 'read' }) },
        `api:${h.id}`,
      );
    }
    for (const a of ctx.a2a.agents.values()) {
      const sys = `tool:${a.id}`;
      push(
        { id: `api:${a.id}`, ring: 'tool', system_id: sys, system: a.name, system_kind: 'a2a', name: `${a.slug}__*`, label: `${a.name} (agent)`, op: 'write', class: classOf(sys, { id: sys, kind: 'a2a', name: a.name, url: a.endpoint ?? a.cardUrl }), granted: mayTool(`${a.slug}__message/send`), ...decide({ kind: 'tool', name: `${a.slug}__message/send`, mcpServerId: a.id, operation: 'write' }) },
        `api:${a.id}`,
      );
    }
    // Calls to names not listed above (a model asked for as provider/model, a tool since removed): used, so granted.
    for (const [k, u] of usedBy) {
      const [kind, ...rest] = k.split(':');
      const name = rest.join(':');
      if (kind === 'model') items.push({ id: k, ring: 'model', system_id: 'other', system: 'Other models', system_kind: 'provider', name, label: name, op: 'model', class: 'D', granted: true, used: true, calls: u.calls, last_used: u.last, access: 'allow', gate: null });
    }
    // Outside the gateway: what was seen this agent reach directly (no key grants it; no gate stands on it).
    if (scope.all) {
      const obs = await ctx.observed.summary(since);
      const targets = new Map(obs.targets.map((t) => [t.id, t]));
      for (const e of obs.edges) {
        if (e.key_id !== key.id) continue;
        const t = targets.get(e.target_id);
        const sys = `observed:${e.target_id}`;
        items.push({ id: sys, ring: 'outside', system_id: sys, system: t?.system ?? t?.target ?? e.target_id, system_kind: 'observed', name: t?.target ?? e.target_id, label: t?.system ?? t?.target ?? e.target_id, op: e.writes_24h ? 'write' : 'read', class: classOf(sys, { id: sys, kind: 'observed', name: t?.system ?? t?.target ?? '', url: t?.target, subkind: t?.kind }), granted: false, used: true, calls: e.count_24h, last_used: null, access: 'outside', gate: null });
      }
    }

    // Least privilege from its own traffic: the names it used. A whole server when it used every tool on it.
    const used = items.filter((i) => i.used && i.ring !== 'outside');
    const models = [...new Set(used.filter((i) => i.ring === 'model').map((i) => i.name))].sort();
    const tools: string[] = [];
    for (const m of ctx.mcp.servers.values()) {
      const all = m.tools.map((t) => `${m.slug}__${t.name}`);
      const mine = all.filter((f) => used.some((i) => i.name === f));
      if (mine.length && mine.length === all.length) tools.push(`${m.slug}__*`);
      else tools.push(...mine);
    }
    tools.push(...used.filter((i) => i.system_kind === 'http' || i.system_kind === 'a2a').map((i) => i.name));
    const granted = items.filter((i) => i.granted);
    const unused = granted.filter((i) => !i.used);
    return {
      agent: { id: key.id, name: key.name, team: key.team ?? null, owner: key.owner ?? null, allowed_models: key.allowedModels, allowed_mcp: key.allowedMcp },
      days,
      items,
      summary: {
        granted: granted.length,
        used: granted.filter((i) => i.used).length,
        unused: unused.length,
        // Unused permissions that could change or delete something, and aren't gated: the ones worth removing first.
        unused_risky: unused.filter((i) => (i.op === 'write' || i.op === 'admin') && i.access === 'allow').length,
        outside: items.filter((i) => i.ring === 'outside').length,
      },
      trim: used.length ? { allowed_models: models, allowed_mcp: [...new Set(tools)].sort(), removes: unused.length } : null,
    };
  });
}
