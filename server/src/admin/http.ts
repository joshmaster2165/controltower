import type { FastifyInstance } from 'fastify';
import { ulid } from 'ulid';
import { sql } from 'kysely';
import type { AppContext } from '../context.js';
import { requireAdmin } from './auth.js';
import type { HttpApiRecord } from '../http/registry.js';
import { routeOperation, type HttpApiAuth } from '../http/route.js';
import { OUTSIDE } from '../http/gateway.js';

/** An agent id from a request body: trimmed, or null to clear. */
const agentIdOf = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 100) : null);

const SEVEN_DAYS = 7 * 86_400_000;

/** Routes an API has actually served lately — the rows under it on the map. */
export async function recentRoutes(ctx: AppContext, since = Date.now() - SEVEN_DAYS): Promise<Map<string, Array<{ name: string; op: string; requests: number }>>> {
  const rows = await ctx.db.read
    .selectFrom('flights')
    .select(['mcp_server_id', 'tool', sql<number>`count(*)`.as('n')])
    .where('kind', '=', 'http.request')
    .where('ts', '>=', since)
    .where('mcp_server_id', 'is not', null)
    .where('tool', 'is not', null)
    .where('tool', 'not like', `%${OUTSIDE}`)
    .groupBy(['mcp_server_id', 'tool'])
    .orderBy('n', 'desc')
    .execute();
  const out = new Map<string, Array<{ name: string; op: string; requests: number }>>();
  for (const r of rows) {
    const list = out.get(r.mcp_server_id!) ?? [];
    if (list.length < 25) list.push({ name: r.tool!, op: routeOperation(r.tool), requests: Number(r.n) });
    out.set(r.mcp_server_id!, list);
  }
  return out;
}

function validAuth(a: HttpApiAuth | undefined): HttpApiAuth {
  if (!a || a.type === 'none') return { type: 'none' };
  if (a.type === 'bearer' && a.token) return { type: 'bearer', token: a.token };
  if (a.type === 'header' && a.token && a.header && /^[A-Za-z0-9-]{1,64}$/.test(a.header)) return { type: 'header', header: a.header, token: a.token };
  return { type: 'none' };
}

export async function httpAdminRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const guard = requireAdmin(ctx);
  const pub = (a: HttpApiRecord, routes: Array<{ name: string; op: string; requests: number }> = []) => ({
    id: a.id,
    slug: a.slug,
    name: a.name,
    base_url: a.baseUrl,
    auth_type: a.auth.type,
    auth_header: a.auth.type === 'header' ? a.auth.header : undefined,
    timeout_ms: a.timeoutMs,
    enabled: a.enabled,
    health: a.health,
    health_detail: a.healthDetail,
    last_checked_at: a.lastCheckedAt,
    demo: a.demo,
    agent_id: a.agentId ?? null,
    routes,
  });

  app.get('/admin/api/http/apis', { preHandler: guard }, async () => {
    const routes = await recentRoutes(ctx);
    return { apis: [...ctx.http.apis.values()].map((a) => pub(a, routes.get(a.id))) };
  });

  app.post('/admin/api/http/apis', { preHandler: guard }, async (req, reply) => {
    const b = (req.body ?? {}) as { name?: string; slug?: string; base_url?: string; auth?: HttpApiAuth; timeout_ms?: number; agent_id?: string | null };
    const name = (b.name ?? '').trim();
    const slug = (b.slug || name).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
    const baseUrl = (b.base_url ?? '').trim();
    if (!name || !slug) return reply.status(400).send({ error: { code: 'invalid', message: 'name is required' } });
    if (!/^https?:\/\/[^\s/]+/.test(baseUrl)) return reply.status(400).send({ error: { code: 'invalid', message: 'base URL must start with http:// or https://' } });
    if (ctx.http.bySlug.has(slug) || ctx.mcp.bySlug.has(slug) || ctx.a2a.bySlug.has(slug)) return reply.status(409).send({ error: { code: 'conflict', message: `"${slug}" is already used by another API, tool server or agent` } });
    const id = `http_${ulid()}`;
    const now = Date.now();
    const auth = validAuth(b.auth);
    await ctx.db.write
      .insertInto('http_apis')
      .values({
        id,
        slug,
        name,
        base_url: baseUrl.replace(/\/+$/, ''),
        auth_enc: auth.type === 'none' ? null : ctx.secrets.encrypt(JSON.stringify(auth), `http_apis.auth_enc.${id}`),
        timeout_ms: Math.min(Math.max(b.timeout_ms ?? 30_000, 1000), 600_000),
        // An API that fronts an agent: calls to it are agent-to-agent.
        agent_id: agentIdOf(b.agent_id),
        enabled: 1,
        health: 'unknown',
        health_detail: null,
        last_checked_at: null,
        demo: 0,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await ctx.http.reload();
    const check = await ctx.http.check(ctx.http.apis.get(id)!);
    return reply.status(201).send({ api: pub(ctx.http.apis.get(id)!), check });
  });

  app.post('/admin/api/http/apis/:id/test', { preHandler: guard }, async (req, reply) => {
    const a = ctx.http.apis.get((req.params as { id: string }).id);
    if (!a) return reply.status(404).send({ error: { code: 'not_found', message: 'API not found' } });
    const r = await ctx.http.check(a);
    return { ok: r.ok, latency_ms: r.latencyMs, detail: r.detail };
  });

  app.patch('/admin/api/http/apis/:id', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!ctx.http.apis.has(id)) return reply.status(404).send({ error: { code: 'not_found', message: 'API not found' } });
    const b = (req.body ?? {}) as { name?: string; base_url?: string; enabled?: boolean; auth?: HttpApiAuth; timeout_ms?: number; agent_id?: string | null };
    const patch: Record<string, unknown> = { updated_at: Date.now() };
    if (typeof b.name === 'string' && b.name.trim()) patch.name = b.name.trim();
    if (typeof b.base_url === 'string' && /^https?:\/\/[^\s/]+/.test(b.base_url.trim())) patch.base_url = b.base_url.trim().replace(/\/+$/, '');
    if (typeof b.enabled === 'boolean') patch.enabled = b.enabled ? 1 : 0;
    if (typeof b.timeout_ms === 'number') patch.timeout_ms = Math.min(Math.max(b.timeout_ms, 1000), 600_000);
    if ('agent_id' in b) patch.agent_id = agentIdOf(b.agent_id);
    if (b.auth) {
      const auth = validAuth(b.auth);
      patch.auth_enc = auth.type === 'none' ? null : ctx.secrets.encrypt(JSON.stringify(auth), `http_apis.auth_enc.${id}`);
    }
    await ctx.db.write.updateTable('http_apis').set(patch).where('id', '=', id).execute();
    await ctx.http.reload();
    return { ok: true };
  });

  app.delete('/admin/api/http/apis/:id', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const res = await ctx.db.write.deleteFrom('http_apis').where('id', '=', id).executeTakeFirst();
    if (Number(res.numDeletedRows) === 0) return reply.status(404).send({ error: { code: 'not_found', message: 'API not found' } });
    await ctx.http.reload();
    return { ok: true };
  });
}
