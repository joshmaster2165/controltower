import { describe, expect, it } from 'vitest';
import { openSqlite } from '../src/db/index.js';
import { PolicyService } from '../src/policy/policy.js';
import type { KeyRecord, Registry } from '../src/registry.js';

function key(id: string): KeyRecord {
  return { id, name: id, hash: '', prefix: '', last4: '', agentId: id, team: undefined, project: undefined, tags: [], allowedModels: ['*'], allowedMcp: ['*'], limits: {}, enabled: true, expiresAt: undefined, demo: false, createdAt: 0, lastUsedAt: undefined };
}

describe('station-scoped gates', () => {
  it('matches a specific agent → deployment / server / tool without zones', async () => {
    const db = openSqlite('', { memory: true });
    const now = Date.now();
    const insert = db.raw.prepare(
      `INSERT INTO rules (id, name, from_zone, to_zone, target_kind, match, effect, config, priority, enabled, revision, demo, created_at, updated_at)
       VALUES (?, ?, NULL, NULL, 'any', ?, ?, '{}', ?, 1, 1, 0, ?, ?)`,
    );
    insert.run('r_deny_pair', 'intern → prod model', JSON.stringify({ keys: ['k_intern'], deployments: ['dep_prod'] }), 'deny', 5, now, now);
    insert.run('r_hold_tool', 'anyone deleting contacts', JSON.stringify({ mcp_servers: ['mcp_crm'], tools: ['crm__delete_contact'] }), 'require_approval', 6, now, now);
    const policy = new PolicyService(db.read, {} as Registry, () => true);
    await policy.reload();

    const model = (dep: string) => ({ kind: 'model' as const, name: 'smart', deploymentId: dep, operation: 'read' as const });
    const tool = (name: string) => ({ kind: 'tool' as const, name, mcpServerId: 'mcp_crm', operation: 'admin' as const });
    const ev = (k: string, target: ReturnType<typeof model> | ReturnType<typeof tool>, args?: Record<string, unknown>) =>
      policy.evaluate({ flightId: 'f', key: key(k), target, args, estInputTokens: 1, projectedNanousd: 0 });

    expect(ev('k_intern', model('dep_prod')).effect).toBe('deny');
    expect(ev('k_other', model('dep_prod')).effect).toBe('allow');
    expect(ev('k_intern', model('dep_cheap')).effect).toBe('allow');
    expect(ev('k_other', tool('crm__delete_contact'), { id: 'c1' }).effect).toBe('hold');
    expect(ev('k_other', tool('crm__search_contacts'), {}).effect).toBe('allow');
    // Static visibility: the intern's denied pair is decidable without arguments.
    expect(policy.staticDecision(key('k_intern'), model('dep_prod'))).toBe('deny');
    db.close();
  });
});
