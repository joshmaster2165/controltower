import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { ulid } from 'ulid';
import type { AppContext } from '../context.js';
import type { HttpApiAuth } from '../http/route.js';
import type { A2aAgentRecord } from '../a2a/registry.js';
import { CARD_PATH, skillsOf } from '../a2a/card.js';
import { requireAdmin } from './auth.js';

const SEVEN_DAYS = 7 * 24 * 3600_000;

/** The A2A methods each agent has been called with lately: its rows on the map. */
export async function recentMethods(ctx: AppContext, since = Date.now() - SEVEN_DAYS): Promise<Map<string, Array<{ name: string; op: string; requests: number }>>> {
  const rows = await ctx.db.read
    .selectFrom('flights')
    .select(['mcp_server_id', 'tool', sql<number>`count(*)`.as('n')])
    .where('kind', '=', 'a2a.call')
    .where('ts', '>=', since)
    .where('mcp_server_id', 'is not', null)
    .where('tool', 'is not', null)
    .groupBy(['mcp_server_id', 'tool'])
    .orderBy('n', 'desc')
    .execute();
  const out = new Map<string, Array<{ name: string; op: string; requests: number }>>();
  for (const r of rows) {
    const list = out.get(r.mcp_server_id!) ?? out.set(r.mcp_server_id!, []).get(r.mcp_server_id!)!;
    list.push({ name: r.tool!, op: /^(Get|List|Subscribe)/.test(r.tool!) ? 'read' : 'write', requests: Number(r.n) });
  }
  return out;
}

function validAuth(a: HttpApiAuth | undefined): HttpApiAuth {
  if (!a || a.type === 'none') return { type: 'none' };
  if (a.type === 'bearer' && a.token) return { type: 'bearer', token: a.token };
  if (a.type === 'header' && a.token && a.header && /^[A-Za-z0-9-]{1,64}$/.test(a.header)) return { type: 'header', header: a.header, token: a.token };
  return { type: 'none' };
}

/** Remote agents reached over A2A: register by Agent Card, served at /a2a/<slug>. */
export async function a2aAdminRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const guard = requireAdmin(ctx);
  const pub = (a: A2aAgentRecord) => ({
    id: a.id,
    slug: a.slug,
    name: a.name,
    card_url: a.cardUrl,
    endpoint: a.endpoint ?? null,
    protocol_version: a.protocolVersion ?? null,
    description: String(a.card?.description ?? ''),
    skills: skillsOf(a.card),
    streaming: !!(a.card?.capabilities as { streaming?: boolean } | undefined)?.streaming,
    auth_type: a.auth.type,
    agent_id: a.agentId,
    timeout_ms: a.timeoutMs,
    enabled: a.enabled,
    health: a.health,
    health_detail: a.healthDetail,
    last_checked_at: a.lastCheckedAt,
    /** Where agents find it through Control Tower. */
    path: `/a2a/${a.slug}`,
    card_path: `/a2a/${a.slug}${CARD_PATH}`,
  });

  app.get('/admin/api/a2a/agents', { preHandler: guard }, async () => {
    const used = await recentMethods(ctx);
    return { agents: [...ctx.a2a.agents.values()].map((a) => ({ ...pub(a), methods: used.get(a.id) ?? [] })) };
  });

  app.post('/admin/api/a2a/agents', { preHandler: guard }, async (req, reply) => {
    const b = (req.body ?? {}) as { name?: string; slug?: string; url?: string; auth?: HttpApiAuth; timeout_ms?: number; agent_id?: string };
    const name = (b.name ?? '').trim();
    const slug = (b.slug || name).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
    const url = (b.url ?? '').trim();
    if (!name || !slug) return reply.status(400).send({ error: { code: 'invalid', message: 'name is required' } });
    if (!/^https?:\/\/[^\s/]+/.test(url)) return reply.status(400).send({ error: { code: 'invalid', message: 'the Agent Card URL (or the agent’s base URL) must start with http:// or https://' } });
    if (ctx.a2a.bySlug.has(slug) || ctx.http.bySlug.has(slug) || ctx.mcp.bySlug.has(slug)) return reply.status(409).send({ error: { code: 'conflict', message: `"${slug}" is already used by another agent, API or tool server` } });
    const id = `a2a_${ulid()}`;
    const auth = validAuth(b.auth);
    const now = Date.now();
    await ctx.db.write
      .insertInto('a2a_agents')
      .values({
        id,
        slug,
        name,
        card_url: url,
        endpoint: null,
        protocol_version: null,
        auth_enc: auth.type === 'none' ? null : ctx.secrets.encrypt(JSON.stringify(auth), `a2a_agents.auth_enc.${id}`),
        agent_id: (b.agent_id ?? '').trim().slice(0, 100) || slug,
        card_cache: null,
        timeout_ms: Math.min(Math.max(b.timeout_ms ?? 120_000, 1000), 600_000),
        health_detail: null,
        last_checked_at: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await ctx.a2a.reload();
    const check = await ctx.a2a.discover(ctx.a2a.agents.get(id)!);
    return reply.status(201).send({ agent: pub(ctx.a2a.agents.get(id)!), check });
  });

  app.post('/admin/api/a2a/agents/:id/test', { preHandler: guard }, async (req, reply) => {
    const a = ctx.a2a.agents.get((req.params as { id: string }).id);
    if (!a) return reply.status(404).send({ error: { code: 'not_found', message: 'agent not found' } });
    const r = await ctx.a2a.discover(a);
    return { ok: r.ok, latency_ms: r.latencyMs, detail: r.detail, agent: pub(ctx.a2a.agents.get(a.id)!) };
  });

  app.patch('/admin/api/a2a/agents/:id', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const cur = ctx.a2a.agents.get(id);
    if (!cur) return reply.status(404).send({ error: { code: 'not_found', message: 'agent not found' } });
    const b = (req.body ?? {}) as { name?: string; url?: string; enabled?: boolean; auth?: HttpApiAuth; timeout_ms?: number; agent_id?: string };
    const patch: Record<string, unknown> = { updated_at: Date.now() };
    if (typeof b.name === 'string' && b.name.trim()) patch.name = b.name.trim();
    if (typeof b.url === 'string' && /^https?:\/\/[^\s/]+/.test(b.url.trim())) patch.card_url = b.url.trim();
    if (typeof b.enabled === 'boolean') patch.enabled = b.enabled ? 1 : 0;
    if (typeof b.timeout_ms === 'number') patch.timeout_ms = Math.min(Math.max(b.timeout_ms, 1000), 600_000);
    if (typeof b.agent_id === 'string' && b.agent_id.trim()) patch.agent_id = b.agent_id.trim().slice(0, 100);
    if (b.auth) {
      const auth = validAuth(b.auth);
      patch.auth_enc = auth.type === 'none' ? null : ctx.secrets.encrypt(JSON.stringify(auth), `a2a_agents.auth_enc.${id}`);
    }
    await ctx.db.write.updateTable('a2a_agents').set(patch).where('id', '=', id).execute();
    await ctx.a2a.reload();
    if (patch.card_url || patch.auth_enc !== undefined) await ctx.a2a.discover(ctx.a2a.agents.get(id)!);
    return { ok: true, agent: pub(ctx.a2a.agents.get(id)!) };
  });

  app.delete('/admin/api/a2a/agents/:id', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const res = await ctx.db.write.deleteFrom('a2a_agents').where('id', '=', id).executeTakeFirst();
    if (Number(res.numDeletedRows) === 0) return reply.status(404).send({ error: { code: 'not_found', message: 'agent not found' } });
    await ctx.a2a.reload();
    return { ok: true };
  });
}
