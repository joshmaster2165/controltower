import { test, expect } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { CT, admin } from './support/admin';

/**
 * Secret managers and key rotation (Enterprise). A provider's key lives in Vault as a reference; Control Tower
 * reads it, sends it upstream, follows a rotation in Vault, and never writes the value back over the reference.
 * An agent's key rotates with an overlap, its new secret delivered to Vault, and the old one can be stopped.
 */
test.describe.configure({ mode: 'serial' });

// A stand-in Vault (KV v2, token sign-in).
const vault = new Map<string, Record<string, unknown>>();
let vaultSrv: http.Server;
let vaultUrl = '';
// An OpenAI-compatible provider that records the key it was sent.
const upstreamAuth: string[] = [];
let upSrv: http.Server;
let upUrl = '';
let managerId = '';
let providerId = '';
let agent: { id: string; key: string };

const listen = async (s: http.Server) => (await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r())), `http://127.0.0.1:${(s.address() as AddressInfo).port}`);
const chat = (key: string) => fetch(`${CT}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'vault-model', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }) });

test.beforeAll(async () => {
  vaultSrv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const json = (s: number, o: unknown) => (res.writeHead(s, { 'content-type': 'application/json' }), res.end(JSON.stringify(o)));
      if (req.headers['x-vault-token'] !== 'hvs.e2e') return json(403, { errors: ['permission denied'] });
      if (req.url === '/v1/auth/token/lookup-self') return json(200, { data: { display_name: 'token-e2e', policies: ['ai'] } });
      const m = /^\/v1\/secret\/data\/(.+)$/.exec(req.url ?? '');
      if (!m) return json(404, { errors: [] });
      if (req.method === 'POST') return (vault.set(m[1]!, (JSON.parse(Buffer.concat(chunks).toString()) as { data: Record<string, unknown> }).data), json(200, {}));
      return vault.has(m[1]!) ? json(200, { data: { data: vault.get(m[1]!) } }) : json(404, { errors: [] });
    });
  });
  vaultUrl = await listen(vaultSrv);
  upSrv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      upstreamAuth.push(String(req.headers.authorization));
      if (req.headers.authorization !== `Bearer ${vault.get('ai/upstream')?.api_key}`) return (res.writeHead(401, { 'content-type': 'application/json' }), res.end('{"error":{"message":"bad key"}}'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'c1', object: 'chat.completion', created: 1, model: 'vault-up', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }));
    });
  });
  upUrl = await listen(upSrv);
  vault.set('ai/upstream', { api_key: 'sk-upstream-one', org: 'acme' });
  await admin.signIn();
});

test.afterAll(async () => {
  if (agent) await admin.del(`/admin/api/keys/${agent.id}`);
  if (providerId) await admin.del(`/admin/api/providers/${providerId}`);
  if (managerId) await admin.del(`/admin/api/secret-managers/${managerId}?force=true`);
  await new Promise<void>((r) => vaultSrv.close(() => r()));
  await new Promise<void>((r) => upSrv.close(() => r()));
});

test('an admin adds Vault; its token is never shown again, and it can be checked', async () => {
  expect((await admin.post('/admin/api/secret-managers', { name: 'Vault!', kind: 'vault', config: { address: vaultUrl, token: 'hvs.e2e' } })).status).toBe(400);
  expect((await admin.post('/admin/api/secret-managers', { name: 'vault', kind: 'vault', config: { address: vaultUrl } })).body.error.message).toContain('token is required');
  const r = await admin.post('/admin/api/secret-managers', { name: 'vault', kind: 'vault', config: { address: vaultUrl, token: 'hvs.e2e' }, refresh_s: 60 });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  managerId = r.body.id;
  const list = (await admin.get('/admin/api/secret-managers')).body;
  expect(JSON.stringify(list)).not.toContain('hvs.e2e');
  expect(list.managers[0]).toMatchObject({ name: 'vault', kind: 'vault', secrets_set: ['token'], refresh_s: 60 });
  expect((await admin.post(`/admin/api/secret-managers/${managerId}/test`, {})).body).toMatchObject({ ok: true, message: expect.stringContaining('token-e2e') });
  const read = (await admin.post(`/admin/api/secret-managers/${managerId}/test`, { ref: 'secret://vault/ai/upstream#api_key' })).body;
  expect(read).toMatchObject({ ok: true, message: expect.stringContaining('15 characters') });
  expect(JSON.stringify(read)).not.toContain('sk-upstream-one');
  expect((await admin.post(`/admin/api/secret-managers/${managerId}/test`, { ref: 'secret://vault/ai/upstream' })).body).toMatchObject({ ok: false, message: expect.stringContaining('several fields') });
});

test("a provider's key read from Vault is used upstream, follows rotation there, and stays a reference", async () => {
  const p = await admin.post('/admin/api/providers', { catalog_id: 'custom', name: 'Vault upstream', slug: 'vaultup', base_url: `${upUrl}/v1`, credentials: { api_key: 'secret://vault/ai/upstream#api_key' } });
  providerId = (p.body.provider ?? p.body).id;
  await admin.post('/admin/api/deployments', { provider_id: providerId, upstream_model: 'vault-up', public_name: 'vault-model' });
  agent = (await admin.post('/admin/api/keys', { name: 'vault-agent' })).body;
  await expect.poll(async () => (await chat(agent.key)).status).toBe(200);
  expect(upstreamAuth.at(-1)).toBe('Bearer sk-upstream-one');
  const refs = (await admin.get('/admin/api/secret-managers')).body.refs as any[];
  expect(refs.find((r) => r.ref === 'secret://vault/ai/upstream#api_key')).toMatchObject({ used_by: ['provider Vault upstream'], status: 'ok' });

  // Rotated in Vault: read again, and the new key goes upstream.
  vault.set('ai/upstream', { api_key: 'sk-upstream-two', org: 'acme' });
  await admin.post('/admin/api/secret-managers/refresh');
  expect((await chat(agent.key)).status).toBe(200);
  expect(upstreamAuth.at(-1)).toBe('Bearer sk-upstream-two');

  // Changing the provider keeps the reference, not the value read: a later rotation still reaches it.
  await admin.patch(`/admin/api/providers/${providerId}`, { name: 'Vault upstream', credentials: { organization: 'acme' } });
  vault.set('ai/upstream', { api_key: 'sk-upstream-three' });
  await admin.post('/admin/api/secret-managers/refresh');
  expect((await chat(agent.key)).status).toBe(200);
  expect(upstreamAuth.at(-1)).toBe('Bearer sk-upstream-three');

  // A manager still referenced isn't removed by accident.
  expect((await admin.del(`/admin/api/secret-managers/${managerId}`)).status).toBe(409);
});

test("an agent's key rotates: the new secret goes to Vault, the old one works for the overlap until stopped", async () => {
  expect((await admin.put(`/admin/api/keys/${agent.id}/rotation`, { every_days: 30 })).body.error.message).toContain('needs deliver_to');
  expect((await admin.put(`/admin/api/keys/${agent.id}/rotation`, { every_days: 30, deliver_to: 'secret://nope/x#y' })).body.error.message).toContain('no secret manager is named "nope"');
  expect((await admin.put(`/admin/api/keys/${agent.id}/rotation`, { every_days: 30, overlap_s: 3600, deliver_to: 'secret://vault/agents/vault-agent#api_key' })).status).toBe(200);
  const r = await admin.post(`/admin/api/keys/${agent.id}/rotate`, {});
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  expect(r.body.key).toBeUndefined(); // delivered, so not answered
  expect(r.body.delivered_to).toBe('secret://vault/agents/vault-agent#api_key');
  const fresh = vault.get('agents/vault-agent')!.api_key as string;
  expect(fresh).toMatch(/^ct_sk_/);
  expect((await chat(fresh)).status).toBe(200);
  expect((await chat(agent.key)).status).toBe(200); // the overlap
  const listed = ((await admin.get('/admin/api/keys')).body.keys as any[]).find((k) => k.id === agent.id);
  expect(listed.rotation).toMatchObject({ every_days: 30, deliver_to: 'secret://vault/agents/vault-agent#api_key', error: null });
  expect(listed.rotation.next_at).toBeGreaterThan(Date.now() + 29 * 86_400_000);
  expect(listed.old_secret_valid_until).toBeGreaterThan(Date.now());
  await admin.post(`/admin/api/keys/${agent.id}/rotate/end-overlap`);
  expect((await chat(agent.key)).status).toBe(401);
  expect((await chat(fresh)).status).toBe(200);
  // Rotating without delivery answers the new secret once.
  const shown = await admin.post(`/admin/api/keys/${agent.id}/rotate`, { overlap_s: 0, deliver_to: null });
  expect(shown.body.key).toMatch(/^ct_sk_/);
  expect((await chat(fresh)).status).toBe(401);
  agent = { id: agent.id, key: shown.body.key };
  const audit = (await admin.get('/admin/api/audit?action=keys&limit=50')).body.events as any[];
  expect(audit.some((e) => e.action === 'keys.rotate' && e.outcome === 'success')).toBe(true);
  expect(JSON.stringify(audit)).not.toContain(shown.body.key);
});
