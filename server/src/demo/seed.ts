import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';
import { generateApiKey } from '../crypto/apikeys.js';
import type { SecretBox } from '../crypto/secrets.js';

/**
 * Demo topology: one mock provider, three deployments, two aliases, six agent
 * keys. Ids are deterministic so historical flights keep pointing at the same
 * stations across restarts; key secrets are rotated every boot and only ever
 * live in memory (the fleet generator uses them over loopback).
 */
export interface DemoAgent {
  id: string;
  name: string;
  team: string;
  project: string;
  /** candidate models; one is picked per request */
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
  { id: 'support-bot', name: 'support-bot', team: 'support', project: 'helpdesk', models: ['smart'], rate: 0.9, streamRatio: 0.85, promptChars: [600, 2400], maxTokens: 220, tools: [{ name: 'crm__search_contacts', args: { query: 'acme' }, rate: 0.3 }] },
  { id: 'code-reviewer', name: 'code-reviewer', team: 'engineering', project: 'ci', models: ['smart'], rate: 0.5, streamRatio: 0.3, promptChars: [3000, 12000], maxTokens: 400 },
  { id: 'researcher', name: 'researcher', team: 'product', project: 'insights', models: ['fast'], rate: 0.6, streamRatio: 0.7, promptChars: [800, 4000], maxTokens: 300 },
  { id: 'ops-agent', name: 'ops-agent', team: 'platform', project: 'sre', models: ['fast'], rate: 0.4, streamRatio: 0.2, promptChars: [200, 1200], maxTokens: 120, tools: [{ name: 'repo__list_prs', args: {}, rate: 0.2 }] },
  { id: 'sdr-agent', name: 'sdr-agent', team: 'sales', project: 'outbound', models: ['cheap', 'smart'], rate: 0.4, streamRatio: 0.5, promptChars: [300, 1500], maxTokens: 160, tools: [{ name: 'crm__update_contact', args: { id: 'c_102', field: 'stage', value: 'proposal' }, rate: 0.2 }, { name: 'crm__delete_contact', args: { id: 'c_103' }, rate: 0.08 }] },
  { id: 'rogue-intern', name: 'rogue-intern', team: 'engineering', project: 'sandbox', models: ['fast', 'smart'], rate: 0.3, streamRatio: 0.5, promptChars: [200, 900], maxTokens: 200, tools: [{ name: 'repo__list_prs', args: {}, rate: 0.1 }, { name: 'repo__merge_pr', args: { number: 484 }, rate: 0.15 }] },
];

export const DEMO_PROVIDER_ID = 'prov_demo_mock';
export const DEMO_DEPLOYMENTS = [
  { id: 'dep_demo_smart', upstream: 'mock-smart', publicName: 'mock-smart' },
  { id: 'dep_demo_fast', upstream: 'mock-fast', publicName: 'mock-fast' },
  { id: 'dep_demo_cheap', upstream: 'mock-cheap', publicName: 'mock-cheap' },
];
export const DEMO_ALIASES = [
  { id: 'alias_demo_smart', name: 'smart', targets: [['dep_demo_smart', 0], ['dep_demo_fast', 1]] as Array<[string, number]> },
  { id: 'alias_demo_fast', name: 'fast', targets: [['dep_demo_fast', 0], ['dep_demo_cheap', 1]] as Array<[string, number]> },
  { id: 'alias_demo_cheap', name: 'cheap', targets: [['dep_demo_cheap', 0]] as Array<[string, number]> },
];

export function demoKeyId(agentId: string): string {
  return `key_demo_${agentId}`;
}

export async function seedDemo(db: Kysely<Database>, secrets: SecretBox): Promise<Map<string, string>> {
  const now = Date.now();
  const keys = new Map<string, string>();

  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('providers')
      .values({
        id: DEMO_PROVIDER_ID,
        kind: 'mock',
        name: 'Demo (mock provider)',
        slug: 'mock',
        base_url: null,
        creds_enc: secrets.encrypt(JSON.stringify({ api_key: 'mock' }), `providers.creds_enc.${DEMO_PROVIDER_ID}`),
        extra: JSON.stringify({ tokPerSec: 40, ttftMeanMs: 300, ttftSdMs: 120, err429Rate: 0.01, err500Rate: 0.005 }),
        health: 'ok',
        health_detail: null,
        stream_usage_supported: 1,
        demo: 1,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) => oc.column('id').doUpdateSet({ updated_at: now, health: 'ok' }))
      .execute();

    for (const d of DEMO_DEPLOYMENTS) {
      await trx
        .insertInto('deployments')
        .values({
          id: d.id,
          provider_id: DEMO_PROVIDER_ID,
          upstream_model: d.upstream,
          public_name: d.publicName,
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
          oc.column('id').doUpdateSet({ key_hash: gen.hash, key_prefix: gen.prefix, last4: gen.last4, enabled: 1 }),
        )
        .execute();
    }
  });

  return keys;
}

export const DEMO_ZONES = [
  { id: 'zone_demo_eng', name: 'Engineering', color: '#64d2ff', stations: ['key:key_demo_code-reviewer', 'key:key_demo_ops-agent'] },
  { id: 'zone_demo_sales', name: 'Sales', color: '#ffb547', stations: ['key:key_demo_sdr-agent'] },
  { id: 'zone_demo_sandbox', name: 'Sandbox', color: '#ff5c7a', stations: ['key:key_demo_rogue-intern'] },
  { id: 'zone_demo_prod', name: 'Production models', color: '#8b7bff', stations: ['deployment:dep_demo_smart'] },
];

export const DEMO_RULES = [
  {
    id: 'rule_demo_sandbox_deny',
    name: 'Sandbox may not use production models',
    from_zone: 'zone_demo_sandbox',
    to_zone: 'zone_demo_prod',
    effect: 'deny',
    config: { reason: 'Sandbox agents may not use production models' },
    priority: 10,
  },
  {
    id: 'rule_demo_sales_approval',
    name: 'Sales needs approval for production models',
    from_zone: 'zone_demo_sales',
    to_zone: 'zone_demo_prod',
    effect: 'require_approval',
    config: { reason: 'Sales agents need a human to approve production-model usage', hold_ms: 20000 },
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
