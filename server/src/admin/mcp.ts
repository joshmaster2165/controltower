import type { FastifyInstance } from 'fastify';
import { ulid } from 'ulid';
import type { AppContext } from '../context.js';
import { requireAdmin } from './auth.js';
import type { McpServerRecord } from '../mcp/registry.js';
import type { McpAuth } from '../mcp/upstream.js';

/** An agent id from a request body: trimmed, or null to clear. */
const agentIdOf = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 100) : null);

export async function mcpAdminRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const guard = requireAdmin(ctx);
  const pub = (s: McpServerRecord) => ({
    id: s.id,
    slug: s.slug,
    name: s.name,
    url: s.url,
    transport: s.transport,
    auth_type: s.auth.type,
    timeout_ms: s.timeoutMs,
    enabled: s.enabled,
    health: s.health,
    health_detail: s.healthDetail,
    tools: s.tools.map((t) => ({ name: t.name, description: t.description ?? '', annotations: t.annotations })),
    last_checked_at: s.lastCheckedAt,
    demo: s.demo,
    agent_id: s.agentId ?? null,
  });

  app.get('/admin/api/mcp/servers', { preHandler: guard }, async () => ({ servers: [...ctx.mcp.servers.values()].map(pub) }));

  app.post('/admin/api/mcp/servers', { preHandler: guard }, async (req, reply) => {
    const b = (req.body ?? {}) as { name?: string; slug?: string; url?: string; auth?: McpAuth; timeout_ms?: number; agent_id?: string | null };
    const name = (b.name ?? '').trim();
    const slug = (b.slug ?? name).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
    const url = (b.url ?? '').trim();
    if (!name || !slug) return reply.status(400).send({ error: { code: 'invalid', message: 'name and slug are required' } });
    if (!/^https?:\/\//.test(url)) return reply.status(400).send({ error: { code: 'invalid', message: 'url must be an http(s) MCP endpoint' } });
    if (ctx.mcp.bySlug.has(slug) || ctx.http.bySlug.has(slug) || ctx.a2a.bySlug.has(slug)) return reply.status(409).send({ error: { code: 'conflict', message: `slug "${slug}" is already used` } });
    const id = `mcp_${ulid()}`;
    const now = Date.now();
    const auth: McpAuth = b.auth && b.auth.type !== 'none' ? b.auth : { type: 'none' };
    await ctx.db.write
      .insertInto('mcp_servers')
      .values({
        id,
        slug,
        name,
        url,
        transport: 'streamable-http',
        auth_enc: auth.type === 'none' ? null : ctx.secrets.encrypt(JSON.stringify(auth), `mcp_servers.auth_enc.${id}`),
        timeout_ms: b.timeout_ms ?? 120_000,
        // A server that fronts an agent (a sub-agent exposed as tools): calls to it are agent-to-agent.
        agent_id: agentIdOf(b.agent_id),
        enabled: 1,
        health: 'unknown',
        health_detail: null,
        tools_cache: '[]',
        tools_hash: null,
        last_checked_at: null,
        demo: 0,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await ctx.mcp.reload();
    const rec = ctx.mcp.servers.get(id)!;
    const check = await ctx.mcp.check(rec);
    return reply.status(201).send({ server: pub(ctx.mcp.servers.get(id)!), check });
  });

  app.post('/admin/api/mcp/servers/:id/test', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const s = ctx.mcp.servers.get(id);
    if (!s) return reply.status(404).send({ error: { code: 'not_found', message: 'server not found' } });
    const r = await ctx.mcp.check(s);
    return { ok: r.ok, latency_ms: r.latencyMs, detail: r.detail, tools: r.tools.map((t) => ({ name: t.name, description: t.description ?? '' })) };
  });

  app.patch('/admin/api/mcp/servers/:id', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const s = ctx.mcp.servers.get(id);
    if (!s) return reply.status(404).send({ error: { code: 'not_found', message: 'server not found' } });
    const b = (req.body ?? {}) as { name?: string; url?: string; enabled?: boolean; auth?: McpAuth; timeout_ms?: number; agent_id?: string | null };
    const patch: Record<string, unknown> = { updated_at: Date.now() };
    if (typeof b.name === 'string' && b.name.trim()) patch.name = b.name.trim();
    if (typeof b.url === 'string' && /^https?:\/\//.test(b.url)) patch.url = b.url.trim();
    if (typeof b.enabled === 'boolean') patch.enabled = b.enabled ? 1 : 0;
    if (typeof b.timeout_ms === 'number') patch.timeout_ms = b.timeout_ms;
    if ('agent_id' in b) patch.agent_id = agentIdOf(b.agent_id);
    if (b.auth) patch.auth_enc = b.auth.type === 'none' ? null : ctx.secrets.encrypt(JSON.stringify(b.auth), `mcp_servers.auth_enc.${id}`);
    await ctx.db.write.updateTable('mcp_servers').set(patch).where('id', '=', id).execute();
    await ctx.mcp.reload();
    return { ok: true };
  });

  app.delete('/admin/api/mcp/servers/:id', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const res = await ctx.db.write.deleteFrom('mcp_servers').where('id', '=', id).executeTakeFirst();
    if (Number(res.numDeletedRows) === 0) return reply.status(404).send({ error: { code: 'not_found', message: 'server not found' } });
    await ctx.mcp.reload();
    return { ok: true };
  });
}
