import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openSqlite } from '../src/db/index.js';
import { SecretBox, keyId } from '../src/crypto/secrets.js';
import { ControlPlane } from '../src/ee/multi-region/control-plane.js';
import { RegionSync, type Snapshot } from '../src/ee/multi-region/region.js';
import { sign, verify } from '../src/ee/multi-region/tables.js';
import type { AppContext } from '../src/context.js';

const box = (key = crypto.randomBytes(32)) => new SecretBox({ key, id: keyId(key), source: 'env' });
const now = Date.now();

async function controlPlane() {
  const db = openSqlite('', { memory: true });
  const secrets = box();
  const w = db.write as unknown as import('kysely').Kysely<Record<string, Record<string, unknown>>>;
  await w.insertInto('zones').values({ id: 'z1', name: 'Finance', created_at: now, updated_at: now }).execute();
  await w.insertInto('rules').values({ id: 'r1', name: 'Deny finance → web', effect: 'deny', from_zone: 'z1', created_at: now, updated_at: now }).execute();
  await w.insertInto('providers').values({ id: 'p1', kind: 'openai', name: 'OpenAI', slug: 'openai', creds_enc: secrets.encrypt('{"api_key":"sk-cp-secret"}', 'providers.creds_enc.p1'), health: 'ok', created_at: now, updated_at: now }).execute();
  await w.insertInto('deployments').values({ id: 'd1', provider_id: 'p1', upstream_model: 'gpt-4.1', public_name: 'smart', created_at: now, updated_at: now }).execute();
  await w.insertInto('api_keys').values({ id: 'k1', name: 'invoice-bot', key_hash: 'h1', key_prefix: 'ct_sk_ab', last4: 'abcd', tags: '[]', allowed_models: '["*"]', allowed_mcp: '["*"]', limits: '{}', enabled: 1, demo: 0, created_at: now }).execute();
  await w.insertInto('api_keys').values({ id: 'key_playground', name: 'playground', key_hash: 'cp-playground', key_prefix: 'ct_sk_pl', last4: 'pppp', tags: '[]', allowed_models: '["*"]', allowed_mcp: '["*"]', limits: '{}', enabled: 1, demo: 0, created_at: now }).execute();
  await w.insertInto('budgets').values({ id: 'b1', scope_type: 'key', scope_id: 'k1', limit_nanousd: 5e9, period: 'monthly', hard: 1 }).execute();
  await w.insertInto('settings').values({ key: 'license_key', value: 'ctl1.license', updated_at: now }).execute();
  const cp = new ControlPlane({ db, secrets, license: { allows: () => true } } as unknown as AppContext);
  return { db, w, secrets, cp };
}

describe('multi-region: configuration from the control plane', () => {
  it('a region gets the configuration, with credentials re-encrypted for its own key; the built-in keys stay its own', async () => {
    const { cp } = await controlPlane();
    const regionKey = crypto.randomBytes(32);
    const snap = cp.forRegion(await cp.snapshot(), regionKey);
    expect(snap.master_key_id).toBe(keyId(regionKey));
    expect(snap.tables.api_keys!.map((k) => k.id)).toEqual(['k1']);
    expect(snap.tables.providers![0]).not.toHaveProperty('health');
    expect(JSON.stringify(snap)).not.toContain('sk-cp-secret');

    const region = openSqlite('', { memory: true });
    const rw = region.write as unknown as import('kysely').Kysely<Record<string, Record<string, unknown>>>;
    await rw.insertInto('api_keys').values({ id: 'key_playground', name: 'playground', key_hash: 'region-playground', key_prefix: 'ct_sk_pl', last4: 'rrrr', tags: '[]', allowed_models: '["*"]', allowed_mcp: '["*"]', limits: '{}', enabled: 1, demo: 0, created_at: now }).execute();
    const sync = new RegionSync({ db: region, region: { name: 'eu-west', controlPlaneUrl: 'http://cp', token: 't', pollMs: 1000 }, masterKeyId: keyId(regionKey), version: 'test', instanceId: 'i', reload: async () => undefined, log: () => ({ warn: () => undefined }) });
    await sync.apply(snap as Snapshot);
    const p = await rw.selectFrom('providers').selectAll().executeTakeFirstOrThrow();
    expect(box(regionKey).decrypt(String(p.creds_enc), 'providers.creds_enc.p1')).toBe('{"api_key":"sk-cp-secret"}');
    expect(p.health).toBe('unknown'); // its own, not the control plane's
    expect((await rw.selectFrom('rules').selectAll().executeTakeFirstOrThrow()).from_zone).toBe('z1');
    expect((await rw.selectFrom('api_keys').select(['id', 'key_hash']).orderBy('id').execute()).map((k) => `${k.id}:${k.key_hash}`)).toEqual(['k1:h1', 'key_playground:region-playground']);
    expect((await rw.selectFrom('settings').select('value').where('key', '=', 'license_key').executeTakeFirstOrThrow()).value).toBe('ctl1.license');
    expect(sync.status().applied_etag).toBe(snap.etag);
  });

  it("changes arrive — added, changed, removed — and the region's own counts survive", async () => {
    const { w, cp } = await controlPlane();
    const regionKey = crypto.randomBytes(32);
    const region = openSqlite('', { memory: true });
    const rw = region.write as unknown as import('kysely').Kysely<Record<string, Record<string, unknown>>>;
    const sync = new RegionSync({ db: region, region: { name: 'eu-west', controlPlaneUrl: 'http://cp', token: 't', pollMs: 1000 }, masterKeyId: keyId(regionKey), version: 'test', instanceId: 'i', reload: async () => undefined, log: () => ({ warn: () => undefined }) });
    const first = cp.forRegion(await cp.snapshot(), regionKey);
    await sync.apply(first as Snapshot);
    await rw.updateTable('budgets').set({ spent_nanousd: 123 }).execute();

    // A health check on the control plane (updated_at) is not a change; a real one is.
    await w.updateTable('providers').set({ updated_at: now + 5, health: 'down' }).execute();
    cp.invalidate();
    expect((await cp.snapshot()).etag).toBe(first.etag);
    await w.updateTable('api_keys').set({ enabled: 0 }).where('id', '=', 'k1').execute();
    await w.updateTable('budgets').set({ limit_nanousd: 9e9 }).execute();
    await w.deleteFrom('rules').execute();
    await w.deleteFrom('zones').execute();
    await w.insertInto('zones').values({ id: 'z2', name: 'Web', created_at: now, updated_at: now }).execute();
    await w.deleteFrom('providers').execute(); // its deployment goes with it
    cp.invalidate();
    const second = cp.forRegion(await cp.snapshot(), regionKey);
    expect(second.etag).not.toBe(first.etag);
    await sync.apply(second as Snapshot);
    expect((await rw.selectFrom('api_keys').select('enabled').where('id', '=', 'k1').executeTakeFirstOrThrow()).enabled).toBe(0);
    expect(await rw.selectFrom('budgets').select(['limit_nanousd', 'spent_nanousd']).executeTakeFirstOrThrow()).toEqual({ limit_nanousd: 9e9, spent_nanousd: 123 });
    expect((await rw.selectFrom('zones').select('id').execute()).map((z) => z.id)).toEqual(['z2']);
    expect(await rw.selectFrom('providers').selectAll().execute()).toHaveLength(0);
    expect(await rw.selectFrom('deployments').selectAll().execute()).toHaveLength(0);
  });

  it('only the control plane can sign a snapshot', () => {
    const body = JSON.stringify({ etag: 'x' });
    const sig = sign('ctr_token', body);
    expect(verify('ctr_token', body, sig)).toBe(true);
    expect(verify('ctr_token', body.replace('x', 'y'), sig)).toBe(false);
    expect(verify('ctr_other', body, sig)).toBe(false);
    expect(verify('ctr_token', body, null)).toBe(false);
  });
});
