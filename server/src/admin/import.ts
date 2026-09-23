import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { requireAdmin } from './auth.js';
import { applyImportPlan } from '../importers/apply.js';
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
    if (!p.providers.length && !p.mcpServers.length) return reply.status(400).send({ error: { code: 'invalid', message: 'Nothing to import.' } });

    const result = await applyImportPlan(ctx, p, { source: null });
    ctx.log.info({ providers: result.providers, deployments: result.deployments, aliases: result.aliases, mcp: result.mcp_servers }, 'imported LiteLLM config');
    if (p.settings.masterKey) result.warnings.push('general_settings.master_key applies when this file is loaded with --config (or set CT_ADMIN_KEY / LITELLM_MASTER_KEY).');
    return result;
  });
}
