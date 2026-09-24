import { describe, expect, it } from 'vitest';
import type { PolicyBundle, Rule, Topology } from '../api';
import { AirspaceScene } from './scene';

const HOUR = 3600_000;

function topology(now: number): Topology {
  return {
    version: 1,
    keys: [
      { id: 'k-reviewer', name: 'pr-reviewer', agent_id: 'pr-reviewer', team: 'eng', tags: [], enabled: true, demo: false },
      { id: 'k-writer', name: 'release-writer', agent_id: 'release-writer', team: 'eng', tags: [], enabled: true, demo: false },
    ],
    providers: [{ id: 'p1', kind: 'openai', name: 'OpenAI', slug: 'openai', health: 'ok', demo: false }],
    deployments: [{ id: 'dep1', provider_id: 'p1', upstream_model: 'gpt-4.1-mini', enabled: true, demo: false }],
    aliases: [],
    mcp_servers: [
      {
        id: 'srv1',
        slug: 'repo',
        name: 'Repo',
        health: 'ok',
        enabled: true,
        demo: false,
        tools: [
          { name: 'merge_pr', op: 'admin' },
          { name: 'list_prs', op: 'read' },
        ],
      },
    ],
    edges: [
      // Used for weeks, destructive, no gate.
      { key_id: 'k-reviewer', target_id: 'srv1', tool: 'merge_pr', requests: 10, errors: 0, denied: 0, cost_nanousd: 0, last_ts: now - HOUR, first_ts: now - 20 * 24 * HOUR },
      // First used an hour ago, and far busier than usual right now.
      { key_id: 'k-writer', target_id: 'dep1', requests: 240, errors: 0, denied: 0, cost_nanousd: 0, last_ts: now, first_ts: now - HOUR, recent: [[now - 30_000, 100], [now - 10_000, 100]] },
    ],
    paths_since: now - 3 * 24 * HOUR,
  };
}

const kinds = (s: AirspaceScene) => s.attention().items.map((i) => `${i.kind}:${i.title}`);

describe('attention', () => {
  it('flags destructive tools in use with no gate, new connections and spikes', () => {
    const now = Date.now();
    const s = new AirspaceScene();
    s.setTopology(topology(now));
    const got = kinds(s);
    expect(got).toContain('ungated:Repo → merge_pr has no gate');
    expect(got).toContain('new:release-writer → gpt-4.1-mini: new connection');
    expect(got.some((k) => k.startsWith('spike:release-writer'))).toBe(true);
    // Read-only tools and old connections are not news.
    expect(got.some((k) => k.includes('list_prs'))).toBe(false);
    expect(got.some((k) => k.startsWith('new:pr-reviewer'))).toBe(false);
    // Busiest right now.
    expect(s.attention().busiest[0]).toMatchObject({ label: 'release-writer', rpm: 200 });
  });

  it('needs a day of history before anything is new, and an hour before anything is a spike', () => {
    const now = Date.now();
    const s = new AirspaceScene();
    s.setTopology({ ...topology(now), paths_since: now - 2 * HOUR });
    expect(kinds(s).some((k) => k.startsWith('new:'))).toBe(false);
    expect(kinds(s).some((k) => k.startsWith('spike:'))).toBe(true);
    const fresh = new AirspaceScene();
    fresh.setTopology({ ...topology(now), paths_since: now - 30 * 60_000 });
    expect(kinds(fresh).some((k) => k.startsWith('new:') || k.startsWith('spike:'))).toBe(false);
  });

  it('stops flagging a destructive tool once a gate can stop it', () => {
    const now = Date.now();
    const s = new AirspaceScene();
    s.setTopology(topology(now));
    const gate = { id: 'r1', name: 'Merges need approval', from_zone: null, to_zone: null, target_kind: 'tool', match: { tools: ['repo__merge_pr'] }, effect: 'require_approval', config: {}, priority: 5, enabled: true, revision: 1, demo: false } as Rule;
    s.setPolicy({ zones: [], rules: [gate], rule_stats: {}, enforcement: true } as unknown as PolicyBundle);
    expect(kinds(s).some((k) => k.startsWith('ungated:'))).toBe(false);
    // An allow rule is not a control.
    s.setPolicy({ zones: [], rules: [{ ...gate, effect: 'allow' }], rule_stats: {}, enforcement: true } as unknown as PolicyBundle);
    expect(kinds(s)).toContain('ungated:Repo → merge_pr has no gate');
  });
});
