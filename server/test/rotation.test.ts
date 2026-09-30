import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openSqlite } from '../src/db/index.js';
import { SecretBox } from '../src/crypto/secrets.js';
import { generateApiKey, hashApiKey } from '../src/crypto/apikeys.js';
import { Registry } from '../src/registry.js';
import { secretRefs } from '../src/ee/secret-managers/index.js';
import { KeyRotator, endOverlap, rotateKey } from '../src/ee/rotation.js';
import { ENCRYPTED_COLUMNS, rotateMasterKey } from '../src/db/rotate-master-key.js';
import type { AppContext } from '../src/context.js';

const box = (key = crypto.randomBytes(32)) => new SecretBox({ key, id: crypto.createHash('sha256').update(key).digest('base64url').slice(0, 8), source: 'env' });

// A stand-in Vault (KV v2) the new secrets are delivered to.
const vault = new Map<string, Record<string, unknown>>();
let vaultDown = false;
let server: http.Server;
let base = '';
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const json = (s: number, o: unknown) => (res.writeHead(s, { 'content-type': 'application/json' }), res.end(JSON.stringify(o)));
      if (vaultDown) return json(503, { errors: ['Vault is sealed'] });
      const m = /^\/v1\/secret\/data\/(.+)$/.exec(req.url ?? '');
      if (!m || req.headers['x-vault-token'] !== 'root') return json(403, { errors: ['permission denied'] });
      if (req.method === 'POST') return (vault.set(m[1]!, (JSON.parse(Buffer.concat(chunks).toString()) as { data: Record<string, unknown> }).data), json(200, {}));
      return vault.has(m[1]!) ? json(200, { data: { data: vault.get(m[1]!) } }) : json(404, { errors: [] });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function setup() {
  const db = openSqlite('', { memory: true });
  const secrets = box();
  const now = Date.now();
  await db.write.insertInto('secret_managers').values({ id: 'm1', name: 'vault', kind: 'vault', config_enc: secrets.encrypt(JSON.stringify({ address: base, token: 'root' }), 'secret_managers.config_enc.m1'), target_hint: '', refresh_s: 300, created_at: now, updated_at: now }).execute();
  secretRefs.configure({ db: db.write, secrets, log: () => ({ warn: () => undefined }) });
  await secretRefs.reload();
  const registry = new Registry(db.read, secrets);
  const addKey = async (name: string, extra: Record<string, unknown> = {}) => {
    const g = generateApiKey();
    const id = `k_${name}`;
    await db.write.insertInto('api_keys').values({ id, name, key_hash: g.hash, key_prefix: g.prefix, last4: g.last4, agent_id: name, team: null, project: null, tags: '[]', allowed_models: '["*"]', allowed_mcp: '["*"]', limits: '{}', enabled: 1, expires_at: null, created_by: null, demo: 0, created_at: now, last_used_at: null, ...extra }).execute();
    await registry.reload();
    return { id, secret: g.plaintext };
  };
  const ctx = { db, registry, audit: undefined } as unknown as AppContext;
  return { db, registry, ctx, addKey };
}

describe('key rotation', () => {
  it('a new secret now; the old one keeps working for the overlap, or can be stopped at once', async () => {
    const { registry, ctx, addKey } = await setup();
    const k = await addKey('invoice-bot');
    const r = await rotateKey(ctx, k.id, { overlapS: 3600, actor: { type: 'admin_key' }, instance: 'i1' });
    expect(r.key).toMatch(/^ct_sk_/);
    expect(r.old_valid_until).toBeGreaterThan(Date.now());
    expect(registry.authenticate(r.key)?.id).toBe(k.id);
    expect(registry.authenticate(k.secret)?.id).toBe(k.id); // the overlap
    await endOverlap(ctx, k.id);
    expect(registry.authenticate(k.secret)).toBeUndefined();
    expect(registry.authenticate(r.key)?.id).toBe(k.id);
    // No overlap: the old secret stops at once.
    const r2 = await rotateKey(ctx, k.id, { overlapS: 0, actor: { type: 'admin_key' }, instance: 'i1' });
    expect(registry.authenticate(r.key)).toBeUndefined();
    expect(registry.authenticate(r2.key)?.id).toBe(k.id);
  });

  it('on a schedule, the new secret is written to the secret manager before it is saved; a failed write changes nothing', async () => {
    const { db, registry, ctx, addKey } = await setup();
    const old = Date.now() - 40 * 86_400_000;
    const k = await addKey('scheduled', { rotate_every_days: 30, rotate_overlap_s: 600, deliver_to: 'secret://vault/agents/scheduled#api_key', created_at: old });
    const notDue = await addKey('not-due', { rotate_every_days: 30, deliver_to: 'secret://vault/agents/not-due#api_key' });
    const rotator = new KeyRotator(() => ctx, { instance: 'i1', allowed: () => true, log: () => ({ warn: () => undefined }) });
    expect(await rotator.tick()).toEqual([k.id]);
    const delivered = vault.get('agents/scheduled')!.api_key as string;
    expect(hashApiKey(delivered)).toBe(registry.keysById.get(k.id)!.hash);
    expect(registry.authenticate(delivered)?.id).toBe(k.id);
    expect(registry.authenticate(k.secret)?.id).toBe(k.id); // 10 minutes of overlap
    expect(registry.keysById.get(notDue.id)!.rotation.lastRotatedAt).toBeUndefined();
    // Not due again until 30 days later.
    expect(await rotator.tick()).toEqual([]);
    expect(await rotator.tick(Date.now() + 31 * 86_400_000)).toEqual([k.id, notDue.id]); // both due by then

    // Vault down: the key keeps its secret, and says why.
    const before = registry.keysById.get(k.id)!.hash;
    vaultDown = true;
    expect(await rotator.tick(Date.now() + 62 * 86_400_000)).toEqual([]);
    vaultDown = false;
    expect(registry.keysById.get(k.id)!.hash).toBe(before);
    const row = await db.read.selectFrom('api_keys').select(['rotation_error', 'rotation_claim']).where('id', '=', k.id).executeTakeFirstOrThrow();
    expect(row.rotation_error).toContain('Vault is sealed');
    expect(row.rotation_claim).toBeNull();
    // Without the license nothing rotates.
    expect(await new KeyRotator(() => ctx, { instance: 'i1', allowed: () => false, log: () => ({ warn: () => undefined }) }).tick(Date.now() + 99 * 86_400_000)).toEqual([]);
  });

  it('two instances due at once: one rotates, the other is refused', async () => {
    const { ctx, addKey } = await setup();
    const k = await addKey('contended');
    const results = await Promise.allSettled([rotateKey(ctx, k.id, { overlapS: 60, actor: { type: 'system' }, instance: 'a' }), rotateKey(ctx, k.id, { overlapS: 60, actor: { type: 'system' }, instance: 'b' })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(String((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason)).toMatch(/being rotated|changed while/);
  });
});

describe('master key rotation', () => {
  it('re-encrypts every stored secret under the new key, and records it', async () => {
    const db = openSqlite('', { memory: true });
    const from = box();
    const to = box();
    const now = Date.now();
    await db.write.insertInto('settings').values({ key: 'master_key_id', value: from.keyId, updated_at: now }).execute();
    await db.write.insertInto('providers').values({ id: 'p1', kind: 'openai', name: 'OpenAI', slug: 'openai', base_url: null, creds_enc: from.encrypt('{"api_key":"sk-1"}', 'providers.creds_enc.p1'), extra: '{}', health: 'unknown', health_detail: null, created_at: now, updated_at: now } as never).execute();
    await db.write.insertInto('secret_managers').values({ id: 'm1', name: 'vault', kind: 'vault', config_enc: from.encrypt('{"token":"t"}', 'secret_managers.config_enc.m1'), target_hint: '', refresh_s: 300, created_at: now, updated_at: now }).execute();
    await expect(rotateMasterKey(db, box(), to)).rejects.toThrow(/not the current key/);
    const counts = await rotateMasterKey(db, from, to);
    expect(counts['providers.creds_enc']).toBe(1);
    const p = await db.read.selectFrom('providers').select('creds_enc').executeTakeFirstOrThrow();
    expect(to.decrypt(p.creds_enc!, 'providers.creds_enc.p1')).toBe('{"api_key":"sk-1"}');
    expect(() => from.decrypt(p.creds_enc!, 'providers.creds_enc.p1')).toThrow();
    expect((await db.read.selectFrom('settings').select('value').where('key', '=', 'master_key_id').executeTakeFirstOrThrow()).value).toBe(to.keyId);
  });

  it('covers every encrypted column in the schema', () => {
    const db = openSqlite('', { memory: true });
    const tables = (db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
    const found = tables.flatMap((t) => (db.raw.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).filter((c) => c.name.endsWith('_enc')).map((c) => `${t}.${c.name}`));
    expect(found.sort()).toEqual(ENCRYPTED_COLUMNS.map(([t, c]) => `${t}.${c}`).sort());
  });
});
