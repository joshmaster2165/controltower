import { describe, expect, it } from 'vitest';
import { openSqlite } from '../src/db/index.js';
import { PolicyService, type RuleRecord } from '../src/policy/policy.js';
import { simulate } from '../src/policy/simulate.js';
import type { KeyRecord, Registry } from '../src/registry.js';
import type { McpRegistry } from '../src/mcp/registry.js';

function key(id: string): KeyRecord {
  return { id, name: id.replace('k_', ''), hash: '', prefix: '', last4: '', agentId: id, team: undefined, project: undefined, tags: [], allowedModels: ['*'], allowedMcp: ['*'], limits: {}, enabled: true, expiresAt: undefined, demo: false, createdAt: 0, lastUsedAt: undefined };
}

function rule(over: Partial<RuleRecord>): RuleRecord {
  return { id: 'draft', name: 'draft', fromZone: null, toZone: null, targetKind: 'any', match: {}, effect: 'deny', config: {}, priority: 5, enabled: true, revision: 1, demo: false, ...over };
}

async function setup() {
  const db = openSqlite('', { memory: true });
  const now = Date.now();
  const ins = db.raw.prepare(
    `INSERT INTO flights (id, ts, key_id, key_name, kind, dialect, model_requested, deployment_id, mcp_server_id, tool, status, cost_nanousd, stream) VALUES (?, ?, ?, ?, ?, 'openai-chat', ?, ?, ?, ?, ?, ?, 0)`,
  );
  let n = 0;
  const add = (keyId: string, dep: string, status = 'ok', cost = 1_000_000, ageMs = 60_000) => ins.run(`f${++n}`, now - ageMs, keyId, keyId, 'chat', 'smart', dep, null, null, status, cost);
  for (let i = 0; i < 5; i++) add('k_intern', 'dep_prod');
  for (let i = 0; i < 3; i++) add('k_intern', 'dep_cheap');
  for (let i = 0; i < 4; i++) add('k_bot', 'dep_prod');
  add('k_intern', 'dep_prod', 'rejected'); // never reached policy
  add('k_intern', 'dep_prod', 'ok', 1, 3 * 86_400_000); // outside the window
  add('k_gone', 'dep_prod'); // deleted key
  ins.run('t1', now - 1000, 'k_bot', 'k_bot', 'mcp.tool', 'crm__delete_contact', null, 'mcp_crm', 'delete_contact', 'ok', 0);

  // Existing gate: the bot already may not reach dep_prod.
  db.raw
    .prepare(`INSERT INTO rules (id, name, from_zone, to_zone, target_kind, match, effect, config, priority, enabled, revision, demo, created_at, updated_at) VALUES ('r_bot', 'bot off prod', NULL, NULL, 'any', ?, 'deny', '{}', 10, 1, 1, 0, 0, 0)`)
    .run(JSON.stringify({ keys: ['k_bot'], deployments: ['dep_prod'] }));
  const keys = new Map([['k_intern', key('k_intern')], ['k_bot', key('k_bot')]]);
  const registry = { keysById: keys, deployments: new Map([['dep_prod', { publicName: 'prod-model', upstreamModel: 'x' }]]) } as unknown as Registry;
  const policy = new PolicyService(db.read, () => true);
  await policy.reload();
  const mcp = { servers: new Map([['mcp_crm', { tools: [{ name: 'delete_contact', annotations: { destructiveHint: true } }] }]]) } as unknown as McpRegistry;
  return { db, policy, deps: { db: db.read, policy, registry, mcp } };
}

describe('simulate a draft gate', () => {
  it('counts only the flights whose outcome the draft changes', async () => {
    const { deps } = await setup();
    const r = await simulate(deps, rule({ match: { deployments: ['dep_prod'] } }));
    // 5 intern → prod become denied; the bot's 4 were already denied; rejected, old and deleted-key flights are ignored.
    expect(r.considered).toBe(13);
    expect(r.changed).toEqual({ to_deny: 5, to_hold: 0, to_allow: 0 });
    expect(r.cost_avoided_nanousd).toBe(5_000_000);
    expect(r.agents).toEqual([{ key_id: 'k_intern', name: 'intern', deny: 5, hold: 0, allow: 0 }]);
    expect(r.destinations).toEqual([{ id: 'dep_prod', name: 'prod-model', deny: 5, hold: 0, allow: 0 }]);
    expect(r.lanes).toEqual([{ key_id: 'k_intern', target_id: 'dep_prod', deny: 5, hold: 0, allow: 0 }]);
    expect(r.notes).toContain('1 flights from deleted keys were skipped.');
  });

  it('simulates holds on tools and loosening an existing gate', async () => {
    const { deps } = await setup();
    const hold = await simulate(deps, rule({ effect: 'require_approval', targetKind: 'tool', match: { operations: ['admin'] } }));
    expect(hold.changed).toEqual({ to_deny: 0, to_hold: 1, to_allow: 0 });
    expect(hold.samples[0]).toMatchObject({ agent: 'bot', destination: 'crm__delete_contact', before: 'allow', after: 'hold' });

    // Replacing the bot's deny gate with an allow gate frees its 4 flights.
    const loosen = await simulate(deps, rule({ id: 'r_bot', effect: 'allow', match: { keys: ['k_bot'], deployments: ['dep_prod'] }, priority: 10 }), { replaceRuleId: 'r_bot' });
    expect(loosen.changed).toEqual({ to_deny: 0, to_hold: 0, to_allow: 4 });
  });

  it('notes what it cannot replay', async () => {
    const { deps } = await setup();
    const r = await simulate(deps, rule({ match: { args: [{ path: 'id', op: 'eq', value: 'c_1' }] } }));
    expect(r.changed.to_deny).toBe(0);
    expect(r.notes[0]).toContain('Arguments are not stored');
  });
});

describe('impact of an existing gate', () => {
  it('compares the rules without the gate to the rules with it', async () => {
    const { deps } = await setup();
    const r = await simulate(deps, null, { impactOfRuleId: 'r_bot' });
    expect(r.changed).toEqual({ to_deny: 4, to_hold: 0, to_allow: 0 });
    expect(r.agents.map((a) => a.name)).toEqual(['bot']);
  });
});
