import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { requireAdmin } from './auth.js';
import { scopeOf, seesKey } from './scope.js';
import { buildInventory } from './export.js';
import { BUILT_IN_KEYS } from './key-lifecycle.js';
import { CLASS_INFO, CLASSES, defaultClass, depth, exfilRisks, isClass, worstRisk, type Link, type Op, type SystemFacts, type TrustClass } from '../airspace/classes.js';

/**
 * The Airspace's Classes and Coverage views.
 *
 *   GET    /admin/api/airspace/classes?hours=   systems by trust class, agents and their links, exfiltration risks
 *   PUT    /admin/api/airspace/classes/:id      { class } an admin sets a system's class
 *   DELETE /admin/api/airspace/classes/:id      back to its default
 *   GET    /admin/api/airspace/coverage?hours=  per team: governed, gateway-only and outside traffic; people signed in
 */
const OP_RANK: Record<Op, number> = { model: 0, unknown: 1, read: 1, write: 2, admin: 3 };

export async function classRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const guard = requireAdmin(ctx);
  const hoursOf = (q: { hours?: string }) => Math.min(720, Math.max(1, Math.round(Number(q.hours ?? 24)) || 24));

  /** Every system an agent can reach, with its facts for classification. */
  async function systems(since: number): Promise<Map<string, SystemFacts & { calls: number; bypass?: boolean }>> {
    const out = new Map<string, SystemFacts & { calls: number; bypass?: boolean }>();
    const providersWithModels = new Set([...ctx.registry.deployments.values()].map((d) => d.providerId));
    for (const p of ctx.registry.providers.values()) if (providersWithModels.has(p.id)) out.set(`provider:${p.id}`, { id: `provider:${p.id}`, kind: 'model', name: p.name, url: p.baseUrl, subkind: p.kind, calls: 0 });
    for (const m of ctx.mcp.servers.values()) out.set(`tool:${m.id}`, { id: `tool:${m.id}`, kind: 'mcp', name: m.name, url: m.url, calls: 0 });
    for (const h of ctx.http.apis.values()) out.set(`tool:${h.id}`, { id: `tool:${h.id}`, kind: 'http', name: h.name, url: h.baseUrl, calls: 0 });
    for (const a of ctx.a2a.agents.values()) out.set(`tool:${a.id}`, { id: `tool:${a.id}`, kind: 'a2a', name: a.name, url: a.endpoint ?? a.cardUrl, calls: 0 });
    const observed = await ctx.observed.summary(since);
    for (const t of observed.targets) out.set(`observed:${t.id}`, { id: `observed:${t.id}`, kind: 'observed', name: t.system ?? t.target, url: t.target, subkind: t.kind, calls: t.count_24h, bypass: t.bypass });
    return out;
  }

  /** What a gate on the way to a system names: its models (a provider's deployments) or the tool server; none for what's outside. */
  function gateTarget(id: string): { target_kind: 'model' | 'tool'; match: { deployments: string[] } | { mcp_servers: string[] } } | null {
    const [kind, rest] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
    if (kind === 'provider') return { target_kind: 'model', match: { deployments: [...ctx.registry.deployments.values()].filter((d) => d.providerId === rest).map((d) => d.id) } };
    if (kind === 'tool') return { target_kind: 'tool', match: { mcp_servers: [rest] } };
    return null;
  }

  async function classesSet(): Promise<Map<string, { class: TrustClass; set_by: string | null; updated_at: number }>> {
    const rows = await ctx.db.read.selectFrom('trust_classes').selectAll().execute();
    return new Map(rows.filter((r) => isClass(r.class)).map((r) => [r.system_id, { class: r.class as TrustClass, set_by: r.set_by, updated_at: r.updated_at }]));
  }

  app.get('/admin/api/airspace/classes', { preHandler: guard }, async (req) => {
    const hours = hoursOf(req.query as { hours?: string });
    const since = Date.now() - hours * 3600_000;
    const scope = scopeOf(req);
    const [sys, set, inv] = await Promise.all([systems(since), classesSet(), buildInventory(ctx, hours)]);
    const classOf = (id: string): TrustClass => set.get(id)?.class ?? (sys.has(id) ? defaultClass(sys.get(id)!).class : 'D');

    // Links: each agent's paths through the gateway, folded per system; then what was seen outside it.
    const keys = [...ctx.registry.keysById.values()].filter((k) => !BUILT_IN_KEYS.has(k.id) && (scope.all || seesKey(scope, k)));
    const keyIds = new Set(keys.map((k) => k.id));
    const links = new Map<string, Link & { gates: Set<string> }>();
    for (const p of inv.paths) {
      if (!keyIds.has(p.agent_id)) continue;
      const systemId = p.kind === 'model' ? `provider:${ctx.registry.deployments.get(p.target_id)?.providerId ?? ''}` : `tool:${p.target_id}`;
      if (!sys.has(systemId)) continue;
      const k = `${p.agent_id}>${systemId}`;
      const op: Op = p.kind === 'model' ? 'model' : ((p.operation as Op) ?? 'unknown');
      // On the way out, only what checks the agent's own messages counts (a gate on results coming back doesn't).
      const checked = p.access !== 'allow' || p.inspects_sent.length > 0;
      const said = p.access === 'deny' ? `blocked: ${p.access_gate}` : p.access === 'hold' ? `held for approval: ${p.access_gate}` : p.inspects_sent.length ? `inspected by ${p.inspects_sent.join(', ')}` : null;
      const l = links.get(k);
      if (!l) {
        links.set(k, { agent_id: p.agent_id, system_id: systemId, calls: p.requests, op, mitigated: checked, mitigation: said, outside: false, state: p.access, gates: new Set(said ? [said] : []) });
      } else {
        l.calls += p.requests;
        if (OP_RANK[op] > OP_RANK[l.op]) l.op = op;
        l.mitigated = l.mitigated && checked;
        if (said) l.gates.add(said);
        if (p.access === 'allow') l.state = 'allow';
      }
      sys.get(systemId)!.calls += p.requests;
    }
    if (scope.all) {
      const observed = await ctx.observed.summary(since);
      for (const e of observed.edges) {
        if (!keyIds.has(e.key_id)) continue;
        const systemId = `observed:${e.target_id}`;
        links.set(`${e.key_id}>${systemId}`, { agent_id: e.key_id, system_id: systemId, calls: e.count_24h, op: e.writes_24h ? 'write' : 'read', mitigated: false, mitigation: null, outside: true, state: 'allow', gates: new Set() });
      }
    }
    const allLinks = [...links.values()].map(({ gates, ...l }) => ({ ...l, mitigation: gates.size ? [...gates].join('; ') : null }));
    const risks = exfilRisks(allLinks, classOf);
    const used = new Set(allLinks.map((l) => l.system_id));

    return {
      hours,
      classes: CLASSES.map((c) => ({ id: c, ...CLASS_INFO[c] })),
      systems: [...sys.values()]
        .filter((s) => used.has(s.id) || s.kind !== 'observed')
        .map((s) => {
          const d = defaultClass(s);
          const own = set.get(s.id);
          return { id: s.id, kind: s.kind, name: s.name, url: s.url ?? null, class: own?.class ?? d.class, default_class: d.class, reason: own ? `Set by ${own.set_by ?? 'an admin'}` : d.reason, set: !!own, calls: s.calls, bypass: !!s.bypass, gate: gateTarget(s.id) };
        }),
      agents: keys.map((k) => {
        const mine = allLinks.filter((l) => l.agent_id === k.id);
        const reach = mine.filter((l) => l.op !== 'model' && l.state !== 'deny').map((l) => classOf(l.system_id));
        return {
          id: k.id,
          name: k.name,
          team: k.team ?? null,
          owner: k.owner ?? null,
          demo: k.demo,
          calls: mine.reduce((n, l) => n + l.calls, 0),
          /** The innermost class it reaches (C when it reaches nothing deeper). */
          depth: reach.length ? reach.reduce((a, b) => (depth(b) < depth(a) ? b : a), 'C' as TrustClass) : 'C',
          risk: worstRisk(risks.filter((r) => r.agent_id === k.id)),
        };
      }),
      links: allLinks,
      risks,
    };
  });

  app.put('/admin/api/airspace/classes/:id', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const b = (req.body ?? {}) as { class?: string };
    if (!isClass(b.class)) return reply.status(400).send({ error: { code: 'invalid', message: `class is one of ${CLASSES.join(', ')}.` } });
    if (!/^(provider|tool|observed):.{1,300}$/.test(id)) return reply.status(400).send({ error: { code: 'invalid', message: 'Not a system id.' } });
    const now = Date.now();
    const by = req.admin?.email ?? 'the admin key';
    await ctx.db.write.insertInto('trust_classes').values({ system_id: id, class: b.class, set_by: by, updated_at: now }).onConflict((oc) => oc.column('system_id').doUpdateSet({ class: b.class!, set_by: by, updated_at: now })).execute();
    return { ok: true, id, class: b.class };
  });

  app.delete('/admin/api/airspace/classes/:id', { preHandler: guard }, async (req) => {
    const id = (req.params as { id: string }).id;
    await ctx.db.write.deleteFrom('trust_classes').where('system_id', '=', id).execute();
    return { ok: true, id };
  });

  app.get('/admin/api/airspace/coverage', { preHandler: guard }, async (req) => {
    const hours = hoursOf(req.query as { hours?: string });
    const since = Date.now() - hours * 3600_000;
    const scope = scopeOf(req);
    const inv = await buildInventory(ctx, hours);
    const keys = [...ctx.registry.keysById.values()].filter((k) => !BUILT_IN_KEYS.has(k.id) && (scope.all || seesKey(scope, k)));
    // Per agent: calls through the gateway, those a gate or inspection covered, and calls seen outside it.
    const per = new Map<string, { calls: number; governed: number; outside: number }>(keys.map((k) => [k.id, { calls: 0, governed: 0, outside: 0 }]));
    for (const p of inv.paths) {
      const a = per.get(p.agent_id);
      if (!a) continue;
      a.calls += p.requests;
      if (p.access !== 'allow' || p.inspected_by.length) a.governed += p.requests;
    }
    if (scope.all) for (const e of (await ctx.observed.summary(since)).edges) { const a = per.get(e.key_id); if (a) a.outside += e.count_24h; }
    // People: a team's members, and those signed in from a computer (laptops).
    const signedIn = new Set(
      ctx.devices
        ? (await ctx.db.read.selectFrom('device_sessions').select('admin_id').where('revoked_at', 'is', null).where('expires_at', '>', Date.now()).execute()).map((r) => r.admin_id)
        : [],
    );
    const teams = new Map<string, { team: string; agents: Array<{ id: string; name: string; calls: number; governed: number; outside: number }> }>();
    for (const k of keys) {
      const name = k.team ?? '(no team)';
      const t = teams.get(name) ?? { team: name, agents: [] };
      t.agents.push({ id: k.id, name: k.name, ...per.get(k.id)! });
      teams.set(name, t);
    }
    const out = [...teams.values()].map((t) => {
      const sum = (f: 'calls' | 'governed' | 'outside') => t.agents.reduce((n, a) => n + a[f], 0);
      const team = ctx.orgs?.teamsByName.get(t.team);
      const members = team ? ctx.orgs!.membersOf('team', team.id).map((m) => m.adminId) : [];
      return {
        team: t.team,
        agents: t.agents.sort((a, b) => b.calls + b.outside - (a.calls + a.outside)),
        calls: sum('calls'),
        governed: sum('governed'),
        outside: sum('outside'),
        people: team ? { members: members.length, signed_in: members.filter((m) => signedIn.has(m)).length } : null,
      };
    });
    const total = (f: 'calls' | 'governed' | 'outside') => out.reduce((n, t) => n + t[f], 0);
    return { hours, teams: out.sort((a, b) => b.calls + b.outside - (a.calls + a.outside)), totals: { calls: total('calls'), governed: total('governed'), outside: total('outside'), teams: out.length, agents: keys.length } };
  });
}
