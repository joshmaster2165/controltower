import { test, expect } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { CT, admin } from './support/admin';
import { routingUpstream, type RoutingUpstream } from './support/routing-upstream';
import { signJwt, testSigner, type TestSigner } from './support/jwt';

/**
 * Agents authenticate with tokens from the company's identity provider instead of a key's secret (Enterprise):
 * a token signed by a trusted issuer, meant for Control Tower, whose claims match a rule, is used as that
 * rule's key — its models, limits and gates — and the call records who presented it. Anything else is refused.
 */
test.describe.configure({ mode: 'serial' });

let idp: http.Server;
let issuer = '';
let signer: TestSigner;
let up: RoutingUpstream;
let providerId = '';
let key: { id: string; key: string };
let issuerId = '';
const SUB = 'system:serviceaccount:prod:invoice-bot';

const token = async (claims: Record<string, unknown> = { sub: SUB }, aud = 'controltower') => signJwt(signer, { iss: issuer, aud, ...claims });
const chat = (credential: string) =>
  fetch(`${CT}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'tok-model', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }) });

test.beforeAll(async () => {
  signer = testSigner('cluster-1');
  // The identity provider's published keys (a Kubernetes cluster's, say).
  idp = http.createServer((_req, res) => (res.writeHead(200, { 'content-type': 'application/json' }), res.end(JSON.stringify({ keys: [signer.jwk] }))));
  await new Promise<void>((r) => idp.listen(0, '127.0.0.1', () => r()));
  issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
  up = await routingUpstream('tok');
  await admin.signIn();
  const p = await admin.post('/admin/api/providers', { catalog_id: 'custom', name: 'Token upstream', slug: 'tokup', base_url: `${up.url}/v1`, credentials: { api_key: 'sk-tok' } });
  providerId = (p.body.provider ?? p.body).id;
  await admin.post('/admin/api/deployments', { provider_id: providerId, upstream_model: 'ok-tok', public_name: 'tok-model' });
  key = (await admin.post('/admin/api/keys', { name: 'invoice-bot', agent_id: 'invoice-bot', allowed_models: ['tok-model'] })).body;
});

test.afterAll(async () => {
  if (issuerId) await admin.del(`/admin/api/token-issuers/${issuerId}`);
  await admin.del(`/admin/api/keys/${key.id}`);
  await admin.del(`/admin/api/providers/${providerId}`);
  await up.close();
  await new Promise<void>((r) => idp.close(() => r()));
});

test('an admin trusts an issuer; its rules must name a key and the tokens must be meant for Control Tower', async () => {
  expect((await admin.post('/admin/api/token-issuers', { name: 'Cluster', issuer, jwks_uri: `${issuer}/keys`, audiences: [], rules: [] })).body.error.message).toContain('audiences are required');
  expect((await admin.post('/admin/api/token-issuers', { name: 'Cluster', issuer, jwks_uri: `${issuer}/keys`, audiences: ['controltower'], rules: [{ claims: { sub: '*' }, key_id: key.id }] })).body.error.message).toContain('more specific');
  expect((await admin.post('/admin/api/token-issuers', { name: 'Cluster', issuer, audiences: ['controltower'], rules: [] })).body.error.message).toContain('needs its keys');
  expect((await admin.post('/admin/api/token-issuers', { name: 'Cluster', issuer, jwks: { keys: [{ ...signer.jwk, d: 'private-part' }] }, audiences: ['controltower'], rules: [] })).body.error.message).toContain('private key');
  const r = await admin.post('/admin/api/token-issuers', { name: 'Cluster', issuer, jwks_uri: `${issuer}/keys`, audiences: ['controltower'], rules: [{ claims: { sub: SUB }, key_id: key.id }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  issuerId = r.body.id;
  expect(r.body.issuer).toMatchObject({ name: 'Cluster', rules: [{ claims: { sub: SUB }, key_name: 'invoice-bot' }], max_lifetime_s: 86400 });
  expect((await admin.post(`/admin/api/token-issuers/${issuerId}/test`)).body).toMatchObject({ ok: true, message: expect.stringContaining('1 signing key') });
});

test('an agent calls with a token instead of the secret: it is the rule\'s key, and the call records who presented it', async () => {
  const r = await chat(await token());
  expect(r.status, await r.clone().text()).toBe(200);
  const flightId = r.headers.get('x-ct-flight-id')!;
  await expect
    .poll(async () => ((await admin.get(`/admin/api/flights?key_id=${key.id}&limit=5`)).body.flights as any[]).find((f) => f.id === flightId)?.principal)
    .toBe(`Cluster · ${SUB}`);
  // The key's own permissions apply: it may use only tok-model.
  const other = await fetch(`${CT}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'hi' }] }) });
  expect(other.status).toBe(403);
  // Models list and the MCP gateway take the token too.
  expect((await fetch(`${CT}/v1/models`, { headers: { authorization: `Bearer ${await token()}` } })).status).toBe(200);
  const mcp = await fetch(`${CT}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } }) });
  expect(mcp.status).toBe(200);
  // HTTP APIs take it as x-ct-key (Authorization there belongs to the API).
  const api = await admin.post('/admin/api/http/apis', { name: 'Token API', slug: 'tok-api', base_url: issuer });
  expect(api.status).toBe(201);
  try {
    const viaHeader = await fetch(`${CT}/http/tok-api/things`, { headers: { 'x-ct-key': await token() } });
    expect(viaHeader.status).toBe(200);
    expect((await fetch(`${CT}/http/tok-api/things`, { headers: { authorization: `Bearer ${await token()}` } })).status).toBe(401);
    await expect
      .poll(async () => ((await admin.get(`/admin/api/flights?key_id=${key.id}&kind=http.request&limit=5`)).body.flights as any[])[0]?.principal)
      .toBe(`Cluster · ${SUB}`);
  } finally {
    await admin.del(`/admin/api/http/apis/${api.body.id ?? api.body.api?.id}`);
  }
});

test('refused: another audience, another subject, a forged signature, expired, tampered', async () => {
  const good = await token();
  const [h, p, s] = good.split('.');
  const forged = signJwt(testSigner('cluster-1'), { iss: issuer, aud: 'controltower', sub: SUB });
  const now = Math.floor(Date.now() / 1000);
  const cases: Array<[string, string]> = [
    ['meant for another service', await token({ sub: SUB }, 'https://graph.microsoft.com')],
    ['a subject no rule names', await token({ sub: 'system:serviceaccount:prod:someone-else' })],
    ['signed by another key', forged],
    ['expired', signJwt(signer, { iss: issuer, aud: 'controltower', sub: SUB, iat: now - 900, exp: now - 300 })],
    ['tampered', `${h}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p!, 'base64url').toString()), sub: SUB, extra: 1 })).toString('base64url')}.${s}`],
  ];
  for (const [what, t] of cases) expect((await chat(t)).status, what).toBe(401);
  const list = ((await admin.get('/admin/api/token-issuers')).body.issuers as any[]).find((i) => i.id === issuerId);
  expect(list.refused).toBeGreaterThanOrEqual(4);
  expect(list.last_refusal).toBeTruthy();
  // "Try a token" says why, without storing it.
  expect((await admin.post('/admin/api/token-issuers/check', { token: cases[0]![1] })).body).toMatchObject({ ok: false, reason: expect.stringContaining('not meant for Control Tower') });
  expect((await admin.post('/admin/api/token-issuers/check', { token: good })).body).toMatchObject({ ok: true, key: { name: 'invoice-bot' }, principal: `Cluster · ${SUB}` });
  const audit = JSON.stringify((await admin.get('/admin/api/audit?action=token_issuers&limit=20')).body.events);
  expect(audit).not.toContain(good);
});

test('a key can refuse its secret and take only tokens; turning the issuer off stops its tokens', async () => {
  expect((await chat(key.key)).status).toBe(200);
  await admin.patch(`/admin/api/keys/${key.id}`, { tokens_only: true });
  expect((await chat(key.key)).status).toBe(401);
  expect((await chat(await token())).status).toBe(200);
  const listed = ((await admin.get('/admin/api/keys')).body.keys as any[]).find((k) => k.id === key.id);
  expect(listed).toMatchObject({ tokens_only: true, token_issuers: ['Cluster'] });
  await admin.patch(`/admin/api/token-issuers/${issuerId}`, { enabled: false });
  expect((await chat(await token())).status).toBe(401);
  // With no issuer in use, a tokens-only key takes its secret again: nobody is locked out.
  expect((await chat(key.key)).status).toBe(200);
  await admin.patch(`/admin/api/token-issuers/${issuerId}`, { enabled: true });
  await admin.patch(`/admin/api/keys/${key.id}`, { tokens_only: false });
});
