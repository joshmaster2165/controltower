import crypto from 'node:crypto';
import { ulid } from 'ulid';
import type { Kysely } from 'kysely';
import type { AppContext } from '../context.js';
import type { Database } from '../db/schema.js';
import type { PolicyService } from '../policy/policy.js';
import { catalogEntry } from '../providers/catalog.js';
import type { ImportPlan } from './litellm.js';

/**
 * Writes an import plan. Two modes:
 *  - console (source null): a one-off import; new rows, fresh ids.
 *  - config  (source 'config'): the file given with --config is the source of
 *    truth. Previous config rows are replaced in one transaction, with ids
 *    derived from each entry so flights, gates and the map keep pointing at
 *    the same stations across restarts. Rows made in the console are untouched.
 */
export interface ApplyResult {
  providers: number;
  deployments: number;
  aliases: number;
  mcp_servers: number;
  alert_rules: number;
  warnings: string[];
}

const stable = (kind: string, sig: string) => `cfg_${kind}_${crypto.createHash('sha256').update(sig).digest('hex').slice(0, 20)}`;

/** LiteLLM alert_types → Control Tower alert rules. */
const ALERT_TYPES: Record<string, { kind: string; triggers: string[]; threshold: number; window_s: number; cooldown_s: number; params: Record<string, unknown>; name: string }> = {
  llm_exceptions: { kind: 'errors', triggers: ['failed'], threshold: 1, window_s: 60, cooldown_s: 300, params: {}, name: 'LLM exceptions' },
  llm_too_slow: { kind: 'latency', triggers: ['slow'], threshold: 1, window_s: 300, cooldown_s: 600, params: { slow_ms: 300_000 }, name: 'LLM calls too slow' },
  budget_alerts: { kind: 'budget', triggers: ['budget_warning', 'budget_exceeded'], threshold: 1, window_s: 300, cooldown_s: 0, params: { warn_pct: 80 }, name: 'Budgets' },
  cooldown_deployment: { kind: 'health', triggers: ['outage', 'recovered'], threshold: 3, window_s: 60, cooldown_s: 600, params: {}, name: 'Deployment outages' },
  daily_reports: { kind: 'digest', triggers: ['daily'], threshold: 1, window_s: 86_400, cooldown_s: 0, params: { hour: 8 }, name: 'Daily report' },
};
const ALERT_ALIASES: Record<string, string> = { llm_requests_hanging: 'llm_too_slow', outage_alerts: 'cooldown_deployment', region_outage_alerts: 'cooldown_deployment', spend_reports: 'daily_reports' };
const DEFAULT_ALERTS = ['llm_exceptions', 'llm_too_slow', 'budget_alerts', 'cooldown_deployment'];

export async function applyImportPlan(ctx: AppContext, p: ImportPlan, opts: { source: 'config' | null }): Promise<ApplyResult> {
  const cfg = opts.source === 'config';
  const now = Date.now();
  const warnings = [...p.warnings];
  const provIds = new Map<string, string>();
  const depIds = new Map<string, string>();
  let alertRules = 0;

  await ctx.db.write.transaction().execute(async (trx) => {
    // Models a config provider added on first use (wildcards) are not in the file; keep them if their provider still is.
    let carried: Awaited<ReturnType<typeof keptAutoModels>> = [];
    if (cfg) {
      carried = await keptAutoModels(trx);
      // Replace what the previous boot declared. Deleting a provider cascades to its deployments and alias targets.
      await trx.deleteFrom('alert_rules').where('source', '=', 'config').execute();
      await trx.deleteFrom('alert_channels').where('source', '=', 'config').execute();
      await trx.deleteFrom('aliases').where('source', '=', 'config').execute();
      await trx.deleteFrom('mcp_servers').where('source', '=', 'config').execute();
      await trx.deleteFrom('providers').where('source', '=', 'config').execute();
    }
    for (const prov of p.providers) {
      const cat = catalogEntry(prov.catalogId)!;
      const id = cfg ? stable('prov', prov.sig) : ulid();
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
          source: opts.source,
          created_at: now,
          updated_at: now,
        })
        .execute();
    }
    for (const d of p.deployments) {
      const id = cfg ? stable('dep', d.sig) : ulid();
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
          source: opts.source,
          created_at: now,
          updated_at: now,
        })
        .execute();
    }
    if (carried.length) {
      const declared = new Set(provIds.values());
      const taken = new Set(p.deployments.map((d) => d.publicName ?? '').filter(Boolean));
      for (const d of carried) if (declared.has(d.provider_id) && !(d.public_name && taken.has(d.public_name))) await trx.insertInto('deployments').values(d).execute();
    }
    for (const a of p.aliases) {
      const id = cfg ? stable('alias', a.name) : ulid();
      await trx.insertInto('aliases').values({ id, name: a.name, strategy: a.strategy, fallback_on: JSON.stringify(['429', '5xx', 'timeout', 'provider_auth']), demo: 0, source: opts.source, created_at: now }).execute();
      const seen = new Set<string>();
      for (const t of a.targets) {
        const dep = depIds.get(t.deploymentRef);
        if (!dep || seen.has(dep)) continue;
        seen.add(dep);
        await trx.insertInto('alias_targets').values({ alias_id: id, deployment_id: dep, priority: t.priority, weight: t.weight }).execute();
      }
    }
    for (const m of p.mcpServers) {
      const mcpId = cfg ? stable('mcp', m.slug) : `mcp_${ulid()}`;
      await trx
        .insertInto('mcp_servers')
        .values({ id: mcpId, slug: m.slug, name: m.name, url: m.url, transport: 'streamable-http', auth_enc: m.auth ? ctx.secrets.encrypt(JSON.stringify(m.auth), `mcp_servers.auth_enc.${mcpId}`) : null, timeout_ms: 120_000, enabled: 1, health: 'unknown', health_detail: null, tools_cache: '[]', tools_hash: null, last_checked_at: null, demo: 0, source: opts.source, created_at: now, updated_at: now })
        .execute();
    }
    // general_settings.alerting: ["slack"] + SLACK_WEBHOOK_URL → a Slack channel and the matching alert rules.
    if (p.settings.slack) {
      const id = cfg ? 'ach_cfg_slack' : `ach_${ulid()}`;
      let host = 'slack';
      try {
        host = new URL(p.settings.slack.webhook).host;
      } catch {
        /* keep the default */
      }
      await trx
        .insertInto('alert_channels')
        .values({ id, name: 'Slack (from config)', kind: 'slack', config_enc: ctx.alerts.encryptConfig(id, { url: p.settings.slack.webhook, secret: undefined }), target_hint: host, enabled: 1, last_status: null, last_error: null, last_sent_at: null, source: opts.source, created_at: now, updated_at: now })
        .execute();
      const types = p.settings.slack.alertTypes.length ? p.settings.slack.alertTypes : DEFAULT_ALERTS;
      const done = new Set<string>();
      for (const raw of types) {
        const t = ALERT_ALIASES[raw] ?? raw;
        const def = ALERT_TYPES[t];
        if (!def) {
          warnings.push(`alert_types: "${raw}" has no equivalent and was skipped.`);
          continue;
        }
        if (done.has(t)) continue;
        done.add(t);
        await trx
          .insertInto('alert_rules')
          .values({ id: cfg ? `alr_cfg_${t}` : `alr_${ulid()}`, name: def.name, kind: def.kind, params: JSON.stringify(def.params), rule_id: null, triggers: JSON.stringify(def.triggers), threshold: def.threshold, window_s: def.window_s, cooldown_s: def.cooldown_s, channels: JSON.stringify([id]), enabled: 1, demo: 0, source: opts.source, last_fired_at: null, created_at: now, updated_at: now })
          .execute();
        alertRules++;
      }
    }
  });
  await ctx.registry.reload();
  await ctx.mcp.reload();
  await (ctx.policy as PolicyService).reload();
  await ctx.alerts.reload();
  return { providers: p.providers.length, deployments: p.deployments.length, aliases: p.aliases.length, mcp_servers: p.mcpServers.length, alert_rules: alertRules, warnings };
}

/**
 * For a config loaded at boot: providers whose required credentials are not in
 * the environment are left out (with their models), like LiteLLM starting and
 * failing only when those models are called.
 */
export function dropUnresolved(p: ImportPlan): ImportPlan {
  const bad = new Set(p.providers.filter((x) => x.creds.some((c) => c.required && !x.values[c.field])).map((x) => x.ref));
  if (!bad.size) return p;
  const warnings = [...p.warnings];
  for (const x of p.providers.filter((y) => bad.has(y.ref))) {
    const missing = x.creds.filter((c) => c.required && !x.values[c.field]).map((c) => c.env ?? c.label);
    warnings.push(`${x.name} skipped: ${missing.join(', ')} not set in the environment.`);
  }
  const deployments = p.deployments.filter((d) => !bad.has(d.providerRef));
  const kept = new Set(deployments.map((d) => d.ref));
  const aliases = p.aliases.map((a) => ({ ...a, targets: a.targets.filter((t) => kept.has(t.deploymentRef)) })).filter((a) => a.targets.length);
  return { ...p, providers: p.providers.filter((x) => !bad.has(x.ref)), deployments, aliases, warnings };
}

/** Deployments added on first use under a config provider (ids `dep_auto_…`, stable per provider and model). */
async function keptAutoModels(trx: Kysely<Database>) {
  return trx
    .selectFrom('deployments')
    .innerJoin('providers', 'providers.id', 'deployments.provider_id')
    .where('providers.source', '=', 'config')
    .where('deployments.id', 'like', 'dep_auto_%')
    .selectAll('deployments')
    .execute();
}
