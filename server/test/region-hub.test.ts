import { describe, expect, it } from 'vitest';
import { RegionHub } from '../src/ee/multi-region/hub.js';
import { mergeLedger, mergeTopology } from '../src/ee/multi-region/merge.js';

describe('the console across regions', () => {
  it("a question waits for the region's poll, and its answer comes back", async () => {
    const hub = new RegionHub(undefined);
    const asked = hub.request('eu-west', { method: 'GET', url: '/admin/api/flights' });
    const [q] = await hub.next('eu-west', 1000);
    expect(q).toMatchObject({ method: 'GET', url: '/admin/api/flights' });
    hub.answer([{ id: q!.id, status: 200, body: { flights: [{ id: 'f1' }] } }]);
    expect(await asked).toMatchObject({ status: 200, body: { flights: [{ id: 'f1' }] } });
    // A poll open before the question gets it at once.
    const polling = hub.next('eu-west', 5000);
    const again = hub.request('eu-west', { method: 'GET', url: '/admin/api/topology' });
    const [q2] = await polling;
    hub.answer([{ id: q2!.id, status: 200, body: {} }]);
    expect((await again).status).toBe(200);
    // Another region's question isn't handed to eu-west.
    void hub.request('us-east', { method: 'GET', url: '/x' }, 200).catch(() => undefined);
    expect(await hub.next('eu-west', 50)).toEqual([]);
  });

  it('a region that never answers times out; one that hung up is known to be gone', async () => {
    const hub = new RegionHub(undefined);
    await expect(hub.request('asia', { method: 'GET', url: '/x' }, 100)).rejects.toThrow(/didn't answer/);
    let hangUp!: () => void;
    const poll = hub.next('asia', 10_000, new Promise<void>((r) => (hangUp = r)));
    expect(hub.connected('asia')).toBe(true);
    hangUp();
    await poll;
    await new Promise((r) => setTimeout(r, 1600));
    expect(hub.connected('asia')).toBe(false);
  });

  it('adds up regions: spend by key and model, the map by connection', () => {
    const ledger = mergeLedger(
      { window: '24h', by_key: [{ key_id: 'k', requests: 2, errors: 0, denied: 0, cost_nanousd: 10, in_tokens: 1, out_tokens: 1 }], by_deployment: [{ deployment_id: 'd', requests: 2, cost_nanousd: 10, in_tokens: 1, out_tokens: 1, lat_sum_ms: 100, lat_count: 2 }], series: [{ bucket: '2026-09-30T10', requests: 2, cost_nanousd: 10, errors: 0 }] },
      [{ by_key: [{ key_id: 'k', requests: 3, errors: 1, denied: 0, cost_nanousd: 5, in_tokens: 1, out_tokens: 1 }], by_deployment: [{ deployment_id: 'd', requests: 3, cost_nanousd: 5, in_tokens: 1, out_tokens: 1, lat_sum_ms: 900, lat_count: 3 }], series: [{ bucket: '2026-09-30T10', requests: 3, cost_nanousd: 5, errors: 1 }] }],
    );
    expect(ledger.by_key).toEqual([expect.objectContaining({ key_id: 'k', requests: 5, errors: 1, cost_nanousd: 15 })]);
    expect(ledger.by_deployment[0].avg_ms).toBe(200);
    expect(ledger.series).toEqual([expect.objectContaining({ requests: 5, errors: 1 })]);
    const topo = mergeTopology(
      { keys: [{ id: 'k' }], mcp_servers: [{ id: 's', tools: [{ name: 'a' }] }], edges: [{ key_id: 'k', target_id: 'd', requests: 1, errors: 0, denied: 0, cost_nanousd: 1, last_ts: 5, keys: 1, recent: [[100, 1]] }], delegations: [], paths_since: 50 },
      [{ keys: [{ id: 'k' }, { id: 'key_playground' }], mcp_servers: [{ id: 's', tools: [{ name: 'b' }] }], edges: [{ key_id: 'k', target_id: 'd', requests: 2, errors: 1, denied: 0, cost_nanousd: 2, last_ts: 9, keys: 1, recent: [[100, 2], [105, 1]] }], delegations: [], paths_since: 20 }],
    );
    expect(topo.edges).toEqual([expect.objectContaining({ requests: 3, errors: 1, last_ts: 9, recent: [[100, 3], [105, 1]] })]);
    expect(topo.keys.map((k: { id: string }) => k.id)).toEqual(['k', 'key_playground']);
    expect(topo.mcp_servers[0].tools.map((t: { name: string }) => t.name)).toEqual(['a', 'b']);
    expect(topo.paths_since).toBe(20);
  });
});
