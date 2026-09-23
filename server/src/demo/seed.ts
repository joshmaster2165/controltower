import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';
import { generateApiKey } from '../crypto/apikeys.js';
import type { SecretBox } from '../crypto/secrets.js';

/**
 * Demo topology: three providers standing in for Anthropic, OpenAI and Google
 * (served by the mock adapter, priced like the real models), four model
 * deployments, two aliases and six agents named the way teams name them.
 * Ids are deterministic so historical flights keep pointing at the same
 * stations across restarts; key secrets are rotated every boot and only ever
 * live in memory (the fleet generator uses them over loopback).
 */
export interface DemoAgent {
  id: string;
  name: string;
  team: string;
  project: string;
  /** candidate models (deployment names or aliases); one is picked per request */
  models: string[];
  /** requests per second */
  rate: number;
  streamRatio: number;
  promptChars: [number, number];
  maxTokens: number;
  /** MCP tool calls this agent makes, with per-second rates */
  tools?: Array<{ name: string; args: Record<string, unknown>; rate: number }>;
}

export const DEMO_AGENTS: DemoAgent[] = [
  { id: 'support-triage', name: 'support-triage', team: 'customer-support', project: 'zendesk-triage', models: ['claude-haiku-4-5', 'default'], rate: 0.9, streamRatio: 0.85, promptChars: [600, 2400], maxTokens: 220, tools: [{ name: 'salesforce__search_contacts', args: { query: 'Acme Ledger' }, rate: 0.3 }] },
  { id: 'pr-reviewer', name: 'pr-reviewer', team: 'engineering', project: 'code-review', models: ['claude-sonnet-4-5'], rate: 0.5, streamRatio: 0.3, promptChars: [3000, 12000], maxTokens: 400 },
  { id: 'market-research', name: 'market-research', team: 'product', project: 'insights', models: ['gemini-2.5-flash', 'default'], rate: 0.6, streamRatio: 0.7, promptChars: [800, 4000], maxTokens: 300 },
  { id: 'incident-copilot', name: 'incident-copilot', team: 'platform', project: 'sre', models: ['fast'], rate: 0.4, streamRatio: 0.2, promptChars: [200, 1200], maxTokens: 120, tools: [{ name: 'github__list_prs', args: { repo: 'acme/payments-api', state: 'open' }, rate: 0.2 }] },
  { id: 'outbound-sdr', name: 'outbound-sdr', team: 'sales', project: 'pipeline', models: ['gpt-4.1-mini', 'default'], rate: 0.4, streamRatio: 0.5, promptChars: [300, 1500], maxTokens: 160, tools: [{ name: 'salesforce__update_contact', args: { id: 'c_102', field: 'stage', value: 'proposal' }, rate: 0.2 }, { name: 'salesforce__delete_contact', args: { id: 'c_103' }, rate: 0.08 }] },
  { id: 'labs-prototype', name: 'labs-prototype', team: 'ai-labs', project: 'prototypes', models: ['fast', 'claude-sonnet-4-5'], rate: 0.3, streamRatio: 0.5, promptChars: [200, 900], maxTokens: 200, tools: [{ name: 'github__list_prs', args: { repo: 'acme/payments-api', state: 'open' }, rate: 0.1 }, { name: 'github__merge_pr', args: { repo: 'acme/payments-api', number: 484 }, rate: 0.15 }] },
];

/** The agent whose prompts sometimes contain pasted credentials (caught by the secrets gate). */
export const DEMO_LEAKY_AGENT = 'labs-prototype';

export const DEMO_PROVIDERS = [
  { id: 'prov_demo_anthropic', name: 'Anthropic', slug: 'anthropic', extra: { tokPerSec: 55, ttftMeanMs: 420, ttftSdMs: 140, err429Rate: 0.01, err500Rate: 0.004, models: ['claude-sonnet-4-5', 'claude-haiku-4-5'] } },
  { id: 'prov_demo_openai', name: 'OpenAI', slug: 'openai', extra: { tokPerSec: 70, ttftMeanMs: 340, ttftSdMs: 110, err429Rate: 0.008, err500Rate: 0.004, models: ['gpt-4.1', 'gpt-4.1-mini', 'text-embedding-3-small'] } },
  { id: 'prov_demo_google', name: 'Google Gemini', slug: 'gemini', extra: { tokPerSec: 95, ttftMeanMs: 260, ttftSdMs: 90, err429Rate: 0.015, err500Rate: 0.005, models: ['gemini-2.5-pro', 'gemini-2.5-flash'] } },
];
export const DEMO_DEPLOYMENTS = [
  { id: 'dep_demo_claude_sonnet', provider: 'prov_demo_anthropic', upstream: 'claude-sonnet-4-5' },
  { id: 'dep_demo_claude_haiku', provider: 'prov_demo_anthropic', upstream: 'claude-haiku-4-5' },
  { id: 'dep_demo_gpt41_mini', provider: 'prov_demo_openai', upstream: 'gpt-4.1-mini' },
  { id: 'dep_demo_gemini_flash', provider: 'prov_demo_google', upstream: 'gemini-2.5-flash' },
];
export const DEMO_ALIASES = [
  // "default" is the house model with a cross-vendor fallback; "fast" is the cheap tier.
  { id: 'alias_demo_default', name: 'default', targets: [['dep_demo_claude_sonnet', 0], ['dep_demo_gpt41_mini', 1]] as Array<[string, number]> },
  { id: 'alias_demo_fast_tier', name: 'fast', targets: [['dep_demo_gemini_flash', 0], ['dep_demo_claude_haiku', 1]] as Array<[string, number]> },
];

/**
 * Rows from the first demo dataset (one "mock" provider, mock-smart/fast/cheap,
 * support-bot … rogue-intern, crm/repo tool servers). Removed on boot so an
 * existing demo database moves to the current names instead of showing both.
 */
const LEGACY_DEMO = {
  providers: ['prov_demo_mock'],
  deployments: ['dep_demo_smart', 'dep_demo_fast', 'dep_demo_cheap'],
  aliases: ['alias_demo_smart', 'alias_demo_fast', 'alias_demo_cheap'],
  keys: ['support-bot', 'code-reviewer', 'researcher', 'ops-agent', 'sdr-agent', 'rogue-intern'].map((a) => `key_demo_${a}`),
  mcp: ['mcp_demo_crm', 'mcp_demo_repo'],
  zones: ['zone_demo_eng', 'zone_demo_sales', 'zone_demo_sandbox', 'zone_demo_prod', 'zone_demo_crm', 'zone_demo_repo'],
  rules: ['rule_demo_sandbox_deny', 'rule_demo_sales_approval', 'rule_demo_sandbox_repo', 'rule_demo_crm_delete', 'rule_demo_inspect_crm', 'rule_demo_inspect_repo'],
  alerts: ['alr_demo_sandbox_merge', 'alr_demo_crm_delete'],
};

async function retireLegacyDemo(trx: Kysely<Database>): Promise<void> {
  const L = LEGACY_DEMO;
  await trx.deleteFrom('alert_rules').where('id', 'in', L.alerts).where('demo', '=', 1).execute();
  await trx.deleteFrom('rules').where('id', 'in', L.rules).where('demo', '=', 1).execute();
  await trx.deleteFrom('zones').where('id', 'in', L.zones).where('demo', '=', 1).execute();
  await trx.deleteFrom('mcp_servers').where('id', 'in', L.mcp).where('demo', '=', 1).execute();
  await trx.deleteFrom('api_keys').where('id', 'in', L.keys).where('demo', '=', 1).execute();
  await trx.deleteFrom('observed_hourly').where('key_id', 'in', L.keys).execute();
  await trx.deleteFrom('aliases').where('id', 'in', L.aliases).where('demo', '=', 1).execute();
  await trx.deleteFrom('deployments').where('id', 'in', L.deployments).where('demo', '=', 1).execute();
  await trx.deleteFrom('providers').where('id', 'in', L.providers).where('demo', '=', 1).execute();
}

export function demoKeyId(agentId: string): string {
  return `key_demo_${agentId}`;
}

export async function seedDemo(db: Kysely<Database>, secrets: SecretBox): Promise<Map<string, string>> {
  const now = Date.now();
  const keys = new Map<string, string>();

  await db.transaction().execute(async (trx) => {
    await retireLegacyDemo(trx);

    for (const p of DEMO_PROVIDERS) {
      // Keep the real vendor slug unless a real provider already uses it.
      const clash = await trx.selectFrom('providers').select('id').where('slug', '=', p.slug).where('id', '!=', p.id).executeTakeFirst();
      const slug = clash ? `${p.slug}-demo` : p.slug;
      await trx
        .insertInto('providers')
        .values({
          id: p.id,
          kind: 'mock',
          name: p.name,
          slug,
          base_url: null,
          creds_enc: secrets.encrypt(JSON.stringify({ api_key: 'demo' }), `providers.creds_enc.${p.id}`),
          extra: JSON.stringify(p.extra),
          health: 'ok',
          health_detail: null,
          stream_usage_supported: 1,
          demo: 1,
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) => oc.column('id').doUpdateSet({ name: p.name, extra: JSON.stringify(p.extra), updated_at: now, health: 'ok' }))
        .execute();
    }

    for (const d of DEMO_DEPLOYMENTS) {
      await trx
        .insertInto('deployments')
        .values({
          id: d.id,
          provider_id: d.provider,
          upstream_model: d.upstream,
          public_name: d.upstream,
          caps: JSON.stringify({ tools: true, vision: false }),
          pricing_override: null,
          weight: 100,
          enabled: 1,
          cooling_until: null,
          ewma_ttft_ms: null,
          demo: 1,
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) => oc.column('id').doUpdateSet({ updated_at: now, enabled: 1 }))
        .execute();
    }

    for (const a of DEMO_ALIASES) {
      await trx
        .insertInto('aliases')
        .values({ id: a.id, name: a.name, strategy: 'priority', fallback_on: JSON.stringify(['429', '5xx', 'timeout', 'provider_auth']), demo: 1, created_at: now })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
      await trx.deleteFrom('alias_targets').where('alias_id', '=', a.id).execute();
      for (const [dep, prio] of a.targets) {
        await trx.insertInto('alias_targets').values({ alias_id: a.id, deployment_id: dep, priority: prio, weight: 100 }).execute();
      }
    }

    for (const agent of DEMO_AGENTS) {
      const gen = generateApiKey();
      keys.set(agent.id, gen.plaintext);
      const id = demoKeyId(agent.id);
      await trx
        .insertInto('api_keys')
        .values({
          id,
          name: agent.name,
          key_hash: gen.hash,
          key_prefix: gen.prefix,
          last4: gen.last4,
          agent_id: agent.id,
          team: agent.team,
          project: agent.project,
          tags: JSON.stringify(['demo']),
          allowed_models: JSON.stringify(['*']),
          allowed_mcp: JSON.stringify(['*']),
          limits: JSON.stringify({}),
          enabled: 1,
          expires_at: null,
          created_by: 'demo',
          demo: 1,
          created_at: now,
          last_used_at: null,
        })
        .onConflict((oc) =>
          oc.column('id').doUpdateSet({ key_hash: gen.hash, key_prefix: gen.prefix, last4: gen.last4, enabled: 1, team: agent.team, project: agent.project }),
        )
        .execute();
    }
  });

  return keys;
}

export const DEMO_ZONES = [
  { id: 'zone_demo_engineering', name: 'Engineering', color: '#64d2ff', stations: ['key:key_demo_pr-reviewer', 'key:key_demo_incident-copilot'] },
  { id: 'zone_demo_sales_team', name: 'Sales', color: '#ffb547', stations: ['key:key_demo_outbound-sdr'] },
  { id: 'zone_demo_ai_labs', name: 'AI Labs sandbox', color: '#ff5c7a', stations: ['key:key_demo_labs-prototype'] },
  { id: 'zone_demo_frontier', name: 'Frontier models', color: '#8b7bff', stations: ['deployment:dep_demo_claude_sonnet'] },
];

export const DEMO_RULES = [
  {
    id: 'rule_demo_labs_frontier_deny',
    name: 'AI Labs may not use frontier models',
    from_zone: 'zone_demo_ai_labs',
    to_zone: 'zone_demo_frontier',
    effect: 'deny',
    config: { reason: 'Sandbox prototypes run on the fast tier; frontier models need a production key' },
    priority: 10,
  },
  {
    id: 'rule_demo_sales_frontier_approval',
    name: 'Sales needs approval for frontier models',
    from_zone: 'zone_demo_sales_team',
    to_zone: 'zone_demo_frontier',
    effect: 'require_approval',
    config: { reason: 'Sales agents need a human to approve frontier-model usage', hold_ms: 20000 },
    priority: 20,
  },
];

/** Demo zones and gates; idempotent, only inserts what is missing so user edits survive restarts. */
export async function seedDemoPolicy(db: Kysely<Database>): Promise<void> {
  const now = Date.now();
  for (const z of DEMO_ZONES) {
    await db
      .insertInto('zones')
      .values({ id: z.id, name: z.name, color: z.color, selector: JSON.stringify({ stations: z.stations }), position: null, demo: 1, created_at: now, updated_at: now })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
  }
  for (const r of DEMO_RULES) {
    await db
      .insertInto('rules')
      .values({ id: r.id, name: r.name, from_zone: r.from_zone, to_zone: r.to_zone, target_kind: 'any', match: '{}', effect: r.effect, config: JSON.stringify(r.config), priority: r.priority, enabled: 1, revision: 1, demo: 1, created_at: now, updated_at: now })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
  }
}
