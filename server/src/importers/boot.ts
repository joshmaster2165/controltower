import fs from 'node:fs';
import { parse, stringify } from 'yaml';
import type { AppContext } from '../context.js';
import { ImportError, planLiteLLMImport } from './litellm.js';
import { applyImportPlan, dropUnresolved } from './apply.js';

/**
 * `--config config.yaml` (and `--model provider/model`), the way LiteLLM starts:
 * the file declares models, fallbacks, aliases, MCP servers, the master key and
 * Slack alerting. It is applied on every boot, replacing what the previous boot
 * declared; anything added in the console stays. A file that cannot be read or
 * parsed stops startup, like LiteLLM.
 */
export class BootConfigError extends Error {}

export async function loadBootConfig(ctx: AppContext): Promise<void> {
  const { configFile, quickModel } = ctx.config;
  if (!configFile && !quickModel) return;

  let doc: Record<string, unknown> = {};
  if (configFile) {
    let text: string;
    try {
      text = fs.readFileSync(configFile, 'utf8');
    } catch (err) {
      throw new BootConfigError(`Cannot read the config file ${configFile}: ${(err as Error).message}`);
    }
    try {
      const parsed = parse(text) as unknown;
      if (parsed !== null && parsed !== undefined) {
        if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected a mapping at the top level');
        doc = parsed as Record<string, unknown>;
      }
    } catch (err) {
      throw new BootConfigError(`${configFile} is not valid YAML: ${(err as Error).message}`);
    }
  }
  if (quickModel) {
    const list = Array.isArray(doc.model_list) ? doc.model_list : [];
    doc.model_list = [...list, { model_name: quickModel, litellm_params: { model: quickModel } }];
  }

  // Names already taken by rows made in the console (config rows are about to be replaced).
  const r = ctx.db.read;
  const notConfig = <T extends { source?: string | null | undefined }>(rows: T[]): T[] => rows.filter((x) => x.source !== 'config');
  const existing = {
    providerSlugs: new Set(notConfig(await r.selectFrom('providers').select(['slug', 'source']).execute()).map((x) => x.slug)),
    modelNames: new Set([
      ...notConfig(await r.selectFrom('deployments').select(['public_name', 'source']).execute()).flatMap((x) => (x.public_name ? [x.public_name] : [])),
      ...notConfig(await r.selectFrom('aliases').select(['name', 'source']).execute()).map((x) => x.name),
    ]),
    mcpSlugs: new Set(notConfig(await r.selectFrom('mcp_servers').select(['slug', 'source']).execute()).map((x) => x.slug)),
  };

  let plan;
  try {
    plan = dropUnresolved(planLiteLLMImport(stringify(doc), process.env, existing));
  } catch (err) {
    if (err instanceof ImportError) throw new BootConfigError(`${configFile ?? '--model'}: ${err.message}`);
    throw err;
  }
  if (!ctx.config.adminKey && plan.settings.masterKey) ctx.config.adminKey = plan.settings.masterKey;
  const result = await applyImportPlan(ctx, plan, { source: 'config' });
  ctx.log.info(
    { file: configFile, providers: result.providers, models: result.deployments, aliases: result.aliases, mcp_servers: result.mcp_servers, alert_rules: result.alert_rules },
    'config loaded',
  );
  for (const w of result.warnings) ctx.log.warn(`config: ${w}`);
  for (const s of plan.skipped) ctx.log.warn(`config: ${s.name} skipped — ${s.reason}`);
}
