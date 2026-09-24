import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ulid } from 'ulid';
import { sql } from 'kysely';
import { stringify } from 'yaml';
import type { AppContext } from '../context.js';
import type { KeyRecord } from '../registry.js';
import { requireAdmin, hasAdminKey, loadSession } from './auth.js';
import { generateApiKey, hashApiKey } from '../crypto/apikeys.js';
import { usableKey } from '../gateway/key.js';
import { planLiteLLMImport } from '../importers/litellm.js';
import { applyImportPlan } from '../importers/apply.js';
import { ADMIN_KEY_ID } from './admin-key.js';

/**
 * LiteLLM's key and model management API, on Control Tower's data model, so
 * scripts and tooling written for LiteLLM keep working: /key/generate, /key/info,
 * /key/update, /key/delete, /key/list, /key/block, /key/unblock,
 * /key/regenerate, and /model/info, /model/new, /model/delete. Authenticated
 * with the admin key (LiteLLM's master key) as a bearer token, or an admin session.
 * Written from LiteLLM's documented request and response shapes; no LiteLLM code.
 */
type Period = 'daily' | 'weekly' | 'monthly' | 'total';
const PROTECTED = new Set([ADMIN_KEY_ID]);
const DAY = 86_400_000;

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** "30s" | "30m" | "30h" | "30d" | "1mo" → milliseconds. */
function durationMs(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const m = /^(\d+)\s*(s|m|h|d|mo)$/.exec(String(v).trim());
  if (!m) throw new ApiError(400, `Duration "${String(v)}" is not understood — use e.g. 30s, 30m, 24h, 30d or 1mo.`);
  const n = Number(m[1]);
  return n * { s: 1000, m: 60_000, h: 3_600_000, d: DAY, mo: 30 * DAY }[m[2] as 's' | 'm' | 'h' | 'd' | 'mo'];
}

/** LiteLLM budget_duration → Control Tower's budget periods. */
function periodOf(v: unknown): Period {
  const ms = durationMs(v);
  if (ms === undefined) return 'total';
  if (ms === DAY) return 'daily';
  if (ms === 7 * DAY) return 'weekly';
  if (ms === 30 * DAY || ms === 31 * DAY) return 'monthly';
  throw new ApiError(400, `budget_duration "${String(v)}" is not supported — Control Tower budgets reset daily (1d), weekly (7d) or monthly (30d / 1mo), or never (leave it out).`);
}
const durationOf: Record<Period, string | null> = { daily: '1d', weekly: '7d', monthly: '30d', total: null };

const LITELLM_PREFIX: Record<string, string> = { openai: 'openai', 'azure-openai': 'azure', anthropic: 'anthropic', gemini: 'gemini', vertex: 'vertex_ai', bedrock: 'bedrock', 'openai-compatible': 'openai', mock: 'demo' };

export async function litellmApiRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const guard = requireAdmin(ctx);
  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof ApiError) return reply.status(err.status).send({ error: { message: err.message, type: err.status === 404 ? 'not_found_error' : 'invalid_request_error', code: String(err.status) } });
    throw err;
  };

  /** A key by its secret, its hash (LiteLLM's "token"), or its Control Tower id. */
  const findKey = (ref: unknown): KeyRecord | undefined => {
    if (typeof ref !== 'string' || !ref) return undefined;
    return ctx.registry.keysById.get(ref) ?? ctx.registry.authenticate(ref) ?? ctx.registry.keysByHash.get(ref) ?? ctx.registry.keysByHash.get(hashApiKey(ref));
  };
  const spentUsd = async (keyId: string): Promise<number> => {
    const row = await ctx.db.read.selectFrom('usage_daily').select(sql<number>`coalesce(sum(cost_nanousd), 0)`.as('c')).where('key_id', '=', keyId).executeTakeFirst();
    return Number(row?.c ?? 0) / 1e9;
  };
  const budgetOf = (keyId: string) => ctx.budgets.snapshot().find((b) => b.scope === `key:${keyId}`);
  const view = async (k: KeyRecord) => {
    const b = budgetOf(k.id);
    return {
      token: k.id,
      key_name: `${k.prefix}…${k.last4}`,
      key_alias: k.name,
      models: k.allowedModels.includes('*') ? [] : k.allowedModels,
      max_budget: b ? b.limit_nanousd / 1e9 : null,
      budget_duration: b ? durationOf[b.period as Period] : null,
      spend: await spentUsd(k.id),
      tpm_limit: k.limits.tpm ?? null,
      rpm_limit: k.limits.rpm ?? null,
      max_parallel_requests: k.limits.maxParallel ?? null,
      expires: k.expiresAt ? new Date(k.expiresAt).toISOString() : null,
      blocked: !k.enabled,
      team_id: k.team ?? null,
      user_id: k.agentId ?? null,
      created_at: new Date(k.createdAt).toISOString(),
      last_active: k.lastUsedAt ? new Date(k.lastUsedAt).toISOString() : null,
    };
  };

  /** LiteLLM key fields → the columns they map to. */
  const fields = (b: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    if (Array.isArray(b.models)) {
      const ms = b.models.map(String).filter((m) => m && m !== 'all-proxy-models');
      out.allowed_models = JSON.stringify(ms.length ? ms : ['*']);
    }
    const perms = b.object_permission as { mcp_servers?: unknown; mcp_tool_permissions?: unknown } | undefined;
    if (perms && (Array.isArray(perms.mcp_servers) || (perms.mcp_tool_permissions && typeof perms.mcp_tool_permissions === 'object'))) {
      const tools = (perms.mcp_tool_permissions ?? {}) as Record<string, unknown>;
      const globs = new Set<string>();
      for (const s of Array.isArray(perms.mcp_servers) ? perms.mcp_servers.map(String) : []) if (!Array.isArray(tools[s])) globs.add(`${s}__*`);
      for (const [s, list] of Object.entries(tools)) if (Array.isArray(list)) for (const t of list) globs.add(`${s}__${String(t)}`);
      out.allowed_mcp = JSON.stringify(globs.size ? [...globs] : ['*']);
    }
    const limits: Record<string, number> = {};
    for (const [from, to] of [['rpm_limit', 'rpm'], ['tpm_limit', 'tpm'], ['max_parallel_requests', 'maxParallel']] as const) {
      if (typeof b[from] === 'number') limits[to] = b[from] as number;
    }
    if (Object.keys(limits).length) out.limits = limits;
    if (typeof b.key_alias === 'string' && b.key_alias.trim()) out.name = b.key_alias.trim();
    if (typeof b.team_id === 'string') out.team = b.team_id || null;
    if (typeof b.blocked === 'boolean') out.enabled = b.blocked ? 0 : 1;
    if (b.duration !== undefined) {
      const ms = durationMs(b.duration);
      out.expires_at = ms === undefined ? null : Date.now() + ms;
    }
    return out;
  };
  const applyBudget = async (keyId: string, b: Record<string, unknown>) => {
    if (b.max_budget === null) await ctx.budgets.remove('key', keyId);
    else if (typeof b.max_budget === 'number') await ctx.budgets.upsert('key', keyId, b.max_budget, periodOf(b.budget_duration), true);
    else if (b.budget_duration !== undefined) {
      const cur = budgetOf(keyId);
      if (cur) await ctx.budgets.upsert('key', keyId, cur.limit_nanousd / 1e9, periodOf(b.budget_duration), cur.hard);
    }
  };

  // ---- keys ----
  app.post('/key/generate', { preHandler: guard }, async (req, reply) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      periodOf(b.budget_duration); // validate before writing anything
      const f = fields(b);
      let plaintext: string;
      let prefix: string;
      let last4: string;
      if (typeof b.key === 'string' && b.key) {
        // Bring an existing key over (e.g. from LiteLLM) so agents keep working unchanged.
        if (b.key.length < 16) throw new ApiError(400, 'A custom key must be at least 16 characters.');
        if (ctx.registry.authenticate(b.key)) throw new ApiError(409, 'That key already exists.');
        plaintext = b.key;
        prefix = b.key.slice(0, 6);
        last4 = b.key.slice(-4);
      } else {
        const gen = generateApiKey();
        ({ plaintext, prefix, last4 } = gen);
      }
      const id = ulid();
      const now = Date.now();
      const name = (f.name as string | undefined) ?? (typeof b.user_id === 'string' && b.user_id ? b.user_id : `key-${last4}`);
      await ctx.db.write
        .insertInto('api_keys')
        .values({
          id,
          name,
          key_hash: hashApiKey(plaintext),
          key_prefix: prefix,
          last4,
          agent_id: (typeof b.user_id === 'string' && b.user_id) || name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
          team: (f.team as string | null | undefined) ?? null,
          project: null,
          tags: JSON.stringify(Array.isArray(b.tags) ? b.tags.map(String) : []),
          allowed_models: (f.allowed_models as string | undefined) ?? JSON.stringify(['*']),
          allowed_mcp: (f.allowed_mcp as string | undefined) ?? JSON.stringify(['*']),
          limits: JSON.stringify(f.limits ?? {}),
          enabled: (f.enabled as number | undefined) ?? 1,
          expires_at: (f.expires_at as number | null | undefined) ?? null,
          created_by: req.admin?.email ?? null,
          demo: 0,
          created_at: now,
          last_used_at: null,
        })
        .execute();
      await applyBudget(id, b);
      await ctx.registry.reload();
      const k = ctx.registry.keysById.get(id)!;
      return reply.send({ key: plaintext, ...(await view(k)), metadata: b.metadata ?? {} });
    } catch (err) {
      return fail(reply, err);
    }
  });

  // A key may look itself up; the admin may look up any key.
  app.get('/key/info', async (req, reply) => {
    const q = req.query as { key?: string };
    const admin = hasAdminKey(ctx, req) || !!(await loadSession(ctx, req));
    const caller = usableKey(ctx, req);
    if (!admin && !caller) return reply.status(401).send({ error: { message: 'Authentication required', type: 'auth_error', code: '401' } });
    const k = q.key ? findKey(q.key) : caller;
    if (!k || (!admin && k.id !== caller?.id)) return reply.status(404).send({ error: { message: 'Key not found', type: 'not_found_error', code: '404' } });
    return reply.send({ key: k.id, info: await view(k) });
  });

  app.post('/key/update', { preHandler: guard }, async (req, reply) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const k = findKey(b.key);
      if (!k) throw new ApiError(404, 'Key not found');
      if (PROTECTED.has(k.id)) throw new ApiError(400, 'The admin key is configured with CT_ADMIN_KEY / LITELLM_MASTER_KEY.');
      periodOf(b.budget_duration);
      const f = fields(b);
      const { limits, ...cols } = f;
      const patch: Record<string, unknown> = { ...cols };
      if (limits) patch.limits = JSON.stringify({ ...k.limits, ...(limits as Record<string, number>) });
      if (Object.keys(patch).length) await ctx.db.write.updateTable('api_keys').set(patch).where('id', '=', k.id).execute();
      await applyBudget(k.id, b);
      await ctx.registry.reload();
      return reply.send({ key: k.id, ...(await view(ctx.registry.keysById.get(k.id)!)) });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post('/key/delete', { preHandler: guard }, async (req, reply) => {
    const b = (req.body ?? {}) as { keys?: unknown[]; key_aliases?: unknown[] };
    const targets = new Map<string, KeyRecord>();
    for (const r of b.keys ?? []) {
      const k = findKey(r);
      if (k) targets.set(k.id, k);
    }
    for (const alias of b.key_aliases ?? []) for (const k of ctx.registry.keysById.values()) if (k.name === String(alias)) targets.set(k.id, k);
    const deleted: string[] = [];
    for (const k of targets.values()) {
      if (PROTECTED.has(k.id)) continue;
      await ctx.db.write.deleteFrom('api_keys').where('id', '=', k.id).execute();
      await ctx.budgets.remove('key', k.id);
      deleted.push(k.id);
    }
    await ctx.registry.reload();
    if (!deleted.length) return reply.status(404).send({ error: { message: 'No matching keys', type: 'not_found_error', code: '404' } });
    return reply.send({ deleted_keys: deleted });
  });

  app.get('/key/list', { preHandler: guard }, async (req, reply) => {
    const q = req.query as { page?: string; size?: string; return_full_object?: string; key_alias?: string; team_id?: string };
    const size = Math.min(100, Math.max(1, Number(q.size ?? 10) || 10));
    const page = Math.max(1, Number(q.page ?? 1) || 1);
    let all = [...ctx.registry.keysById.values()].filter((k) => !k.demo).sort((a, b) => b.createdAt - a.createdAt);
    if (q.key_alias) all = all.filter((k) => k.name === q.key_alias);
    if (q.team_id) all = all.filter((k) => k.team === q.team_id);
    const slice = all.slice((page - 1) * size, page * size);
    const full = q.return_full_object === 'true';
    return reply.send({
      keys: full ? await Promise.all(slice.map(view)) : slice.map((k) => k.id),
      total_count: all.length,
      current_page: page,
      total_pages: Math.max(1, Math.ceil(all.length / size)),
    });
  });

  const setBlocked = (blocked: boolean) => async (req: FastifyRequest, reply: FastifyReply) => {
    const k = findKey((req.body as { key?: unknown } | undefined)?.key);
    if (!k || PROTECTED.has(k.id)) return reply.status(404).send({ error: { message: 'Key not found', type: 'not_found_error', code: '404' } });
    await ctx.db.write.updateTable('api_keys').set({ enabled: blocked ? 0 : 1 }).where('id', '=', k.id).execute();
    await ctx.registry.reload();
    return reply.send({ key: k.id, blocked });
  };
  app.post('/key/block', { preHandler: guard }, setBlocked(true));
  app.post('/key/unblock', { preHandler: guard }, setBlocked(false));

  // A new secret for the same key: its history, budget and gates stay.
  const regenerate = async (req: FastifyRequest, reply: FastifyReply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (b.new_master_key) return reply.status(400).send({ error: { message: 'To rotate the admin key, change CT_ADMIN_KEY / LITELLM_MASTER_KEY and restart.', type: 'invalid_request_error', code: '400' } });
    const k = findKey((req.params as { key?: string }).key ?? b.key);
    if (!k || PROTECTED.has(k.id)) return reply.status(404).send({ error: { message: 'Key not found', type: 'not_found_error', code: '404' } });
    const gen = generateApiKey();
    await ctx.db.write.updateTable('api_keys').set({ key_hash: gen.hash, key_prefix: gen.prefix, last4: gen.last4 }).where('id', '=', k.id).execute();
    try {
      await applyBudget(k.id, b);
    } catch (err) {
      return fail(reply, err);
    }
    await ctx.registry.reload();
    return reply.send({ key: gen.plaintext, ...(await view(ctx.registry.keysById.get(k.id)!)) });
  };
  app.post('/key/regenerate', { preHandler: guard }, regenerate);
  app.post('/key/:key/regenerate', { preHandler: guard }, regenerate);

  // ---- models ----
  const modelInfo = async (req: FastifyRequest, reply: FastifyReply) => {
    const only = (req.query as { litellm_model_id?: string }).litellm_model_id;
    const r = ctx.registry;
    const entry = (name: string, depId: string) => {
      const d = r.deployments.get(depId)!;
      const p = r.providers.get(d.providerId);
      return {
        model_name: name,
        litellm_params: { model: `${LITELLM_PREFIX[p?.kind ?? ''] ?? p?.kind ?? 'openai'}/${d.upstreamModel}`, api_base: p?.baseUrl ?? null },
        model_info: { id: d.id, db_model: !d.id.startsWith('cfg_'), provider: p?.slug ?? null, mode: d.caps?.mode === 'embedding' ? 'embedding' : 'chat', enabled: d.enabled },
      };
    };
    const data: unknown[] = [];
    const inAlias = new Set<string>();
    for (const a of r.aliasesByName.values()) for (const t of a.targets) {
      if (!r.deployments.has(t.deploymentId)) continue;
      inAlias.add(t.deploymentId);
      data.push(entry(a.name, t.deploymentId));
    }
    for (const d of r.deployments.values()) {
      if (d.publicName) data.push(entry(d.publicName, d.id));
      else if (!inAlias.has(d.id)) data.push(entry(`${r.providers.get(d.providerId)?.slug}/${d.upstreamModel}`, d.id));
    }
    return reply.send({ data: only ? data.filter((x) => (x as { model_info: { id: string } }).model_info.id === only) : data });
  };
  app.get('/model/info', { preHandler: guard }, modelInfo);
  app.get('/v1/model/info', { preHandler: guard }, modelInfo);

  // One model_list entry, the LiteLLM way. Credentials resolve like the config file (os.environ/NAME).
  app.post('/model/new', { preHandler: guard }, async (req, reply) => {
    const b = (req.body ?? {}) as { model_name?: string; litellm_params?: Record<string, unknown>; model_info?: Record<string, unknown> };
    if (!b.model_name || !b.litellm_params?.model) return reply.status(400).send({ error: { message: 'model_name and litellm_params.model are required', type: 'invalid_request_error', code: '400' } });
    let plan;
    try {
      plan = planLiteLLMImport(stringify({ model_list: [b] }), process.env, {
        providerSlugs: new Set(ctx.registry.providersBySlug.keys()),
        modelNames: new Set([...ctx.registry.deploymentsByPublicName.keys(), ...ctx.registry.aliasesByName.keys()]),
        mcpSlugs: new Set(),
      });
    } catch (err) {
      return reply.status(400).send({ error: { message: (err as Error).message, type: 'invalid_request_error', code: '400' } });
    }
    if (plan.skipped.length) return reply.status(400).send({ error: { message: `${plan.skipped[0]!.name}: ${plan.skipped[0]!.reason}`, type: 'invalid_request_error', code: '400' } });
    const missing = plan.providers.flatMap((x) => x.creds.filter((c) => c.required && !x.values[c.field]).map((c) => c.env ?? c.label));
    if (missing.length) return reply.status(400).send({ error: { message: `Missing credentials: ${missing.join(', ')}`, type: 'invalid_request_error', code: '400' } });

    // Reuse a provider that already has exactly this endpoint and credentials.
    const want = plan.providers[0];
    const same = want && [...ctx.registry.providers.values()].find((p) => !p.demo && (p.extra.catalog_id === want.catalogId) && (p.baseUrl ?? null) === (want.baseUrl ?? null) && JSON.stringify(p.creds) === JSON.stringify(want.values));
    const d = plan.deployments[0];
    let id: string;
    if (same && d) {
      id = ulid();
      const now = Date.now();
      await ctx.db.write
        .insertInto('deployments')
        .values({ id, provider_id: same.id, upstream_model: d.upstreamModel, public_name: d.publicName, caps: JSON.stringify(d.pricing?.mode === 'embedding' ? { mode: 'embedding' } : {}), pricing_override: d.pricing ? JSON.stringify(d.pricing) : null, weight: d.weight, enabled: 1, cooling_until: null, ewma_ttft_ms: null, demo: 0, created_at: now, updated_at: now })
        .execute();
      await ctx.registry.reload();
    } else {
      await applyImportPlan(ctx, plan, { source: null });
      id = [...ctx.registry.deployments.values()].find((x) => x.publicName === b.model_name)?.id ?? '';
    }
    return reply.send({ model_id: id, model_name: b.model_name, litellm_params: { model: b.litellm_params.model }, model_info: { ...(b.model_info ?? {}), id } });
  });

  app.post('/model/delete', { preHandler: guard }, async (req, reply) => {
    const id = String((req.body as { id?: unknown } | undefined)?.id ?? '');
    const d = ctx.registry.deployments.get(id);
    if (!d) return reply.status(404).send({ error: { message: `Model ${id} not found`, type: 'not_found_error', code: '404' } });
    const row = await ctx.db.read.selectFrom('deployments').select('source').where('id', '=', id).executeTakeFirst();
    if (row?.source === 'config') return reply.status(400).send({ error: { message: 'This model is declared in the --config file; remove it there and restart.', type: 'invalid_request_error', code: '400' } });
    await ctx.db.write.deleteFrom('deployments').where('id', '=', id).execute();
    await ctx.registry.reload();
    return reply.send({ message: `Model: ${id} deleted successfully` });
  });
}

