import type { FastifyInstance } from 'fastify';
import { ulid } from 'ulid';
import type { AppContext } from '../context.js';
import { requireAdmin } from './auth.js';
import { catalogEntry } from '../providers/catalog.js';
import { ImportError, planLiteLLMImport, publicPlan, type ImportPlan } from '../importers/litellm.js';

const MAX_YAML = 1_000_000;

/** Import a LiteLLM proxy config.yaml: preview, then apply. */
export async function importRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const guard = requireAdmin(ctx);

  const plan = (yaml: unknown): ImportPlan => {
    if (typeof yaml !== 'string' || !yaml.trim()) throw new ImportError('Paste the contents of your LiteLLM config.yaml.');
    if (yaml.length > MAX_YAML) throw new ImportError('That file is larger than 1 MB.');
    return planLiteLLMImport(yaml, process.env, {
      providerSlugs: new Set(ctx.registry.providersBySlug.keys()),
      modelNames: new Set([...ctx.registry.deploymentsByPublicName.keys(), ...ctx.registry.aliasesByName.keys()]),
      mcpSlugs: new Set(ctx.mcp.bySlug.keys()),
    });
  };

  app.post('/admin/api/import/litellm/plan', { preHandler: guard, bodyLimit: MAX_YAML + 4096 }, async (req, reply) => {
    try {
      return publicPlan(plan((req.body as { yaml?: unknown } | undefined)?.yaml));
    } catch (e) {
      if (e instanceof ImportError) return reply.status(400).send({ error: { code: 'invalid', message: e.message } });
      throw e;
    }
  });

  app.post('/admin/api/import/litellm/apply', { preHandler: guard, bodyLimit: MAX_YAML + 64 * 1024 }, async (req, reply) => {
    const b = (req.body ?? {}) as { yaml?: unknown; secrets?: Record<string, string> };
    let p: ImportPlan;
    try {
      p = plan(b.yaml);
    } catch (e) {
      if (e instanceof ImportError) return reply.status(400).send({ error: { code: 'invalid', message: e.message } });
      throw e;
    }
    // Secrets typed into the preview, keyed `<provider ref>.<field>`.
    for (const prov of p.providers) {
      for (const c of prov.creds) {
        const v = b.secrets?.[`${prov.ref}.${c.field}`]?.trim();
        if (v) prov.values[c.field] = v;
      }
    }
    const missing = p.providers.flatMap((x) => x.creds.filter((c) => c.required && !x.values[c.field]).map((c) => `${x.name}: ${c.label}`));
    if (missing.length) return reply.status(400).send({ error: { code: 'missing_secrets', message: `Still missing: ${missing.join('; ')}` } });
    if (!p.deployments.length && !p.mcpServers.length) return reply.status(400).send({ error: { code: 'invalid', message: 'Nothing to import.' } });

    const now = Date.now();
    const provIds = new Map<string, string>();
    const depIds = new Map<string, string>();
    await ctx.db.write.transaction().execute(async (trx) => {
      for (const prov of p.providers) {
        const cat = catalogEntry(prov.catalogId)!;
        const id = ulid();
        provIds.set(prov.ref, id);
        await trx
          .insertInto('providers')
          .values({
            id,
            kind: cat.kind,
            name: prov.name,
            slug: prov.slug,
            base_url: (prov.baseUrl ?? cat.baseUrl ?? null) || null,
            creds_enc: Object.keys(prov.values).length ? ctx.secrets.encrypt(JSON.stringify(prov.values), `providers.creds_enc.${id}`) : null,
            extra: JSON.stringify({ ...(cat.extra ?? {}), ...prov.extra, catalog_id: cat.id, imported_from: 'litellm' }),
            health: 'unknown',
            health_detail: null,
            stream_usage_supported: null,
            demo: 0,
            created_at: now,
            updated_at: now,
          })
          .execute();
      }
      for (const d of p.deployments) {
        const id = ulid();
        depIds.set(d.ref, id);
        await trx
          .insertInto('deployments')
          .values({
            id,
            provider_id: provIds.get(d.providerRef)!,
            upstream_model: d.upstreamModel,
            public_name: d.publicName,
            caps: JSON.stringify(d.pricing?.mode === 'embedding' ? { mode: 'embedding' } : {}),
            pricing_override: d.pricing ? JSON.stringify(d.pricing) : null,
            weight: d.weight,
            enabled: 1,
            cooling_until: null,
            ewma_ttft_ms: null,
            demo: 0,
            created_at: now,
            updated_at: now,
          })
          .execute();
      }
      for (const a of p.aliases) {
        const id = ulid();
        await trx.insertInto('aliases').values({ id, name: a.name, strategy: a.strategy, fallback_on: JSON.stringify(['429', '5xx', 'timeout', 'provider_auth']), demo: 0, created_at: now }).execute();
        const seen = new Set<string>();
        for (const t of a.targets) {
          const dep = depIds.get(t.deploymentRef);
          if (!dep || seen.has(dep)) continue;
          seen.add(dep);
          await trx.insertInto('alias_targets').values({ alias_id: id, deployment_id: dep, priority: t.priority, weight: t.weight }).execute();
        }
      }
      for (const m of p.mcpServers) {
        await trx
          .insertInto('mcp_servers')
          .values({ id: `mcp_${ulid()}`, slug: m.slug, name: m.name, url: m.url, transport: 'streamable-http', auth_enc: null, timeout_ms: 120_000, enabled: 1, health: 'unknown', health_detail: null, tools_cache: '[]', tools_hash: null, last_checked_at: null, demo: 0, created_at: now, updated_at: now })
          .execute();
      }
    });
    await ctx.registry.reload();
    await ctx.mcp.reload();
    ctx.log.info({ providers: p.providers.length, deployments: p.deployments.length, aliases: p.aliases.length, mcp: p.mcpServers.length }, 'imported LiteLLM config');
    return { providers: p.providers.length, deployments: p.deployments.length, aliases: p.aliases.length, mcp_servers: p.mcpServers.length, warnings: p.warnings };
  });
}
