import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CT, admin } from './support/admin';
import { testIdp, type TestIdp } from './support/oidc-idp';

/**
 * Single sign-on over OpenID Connect, against a real (test) identity provider: people come in with the role
 * their groups give them, created on first sign-in or linked to an account an admin made; tampered, replayed,
 * mis-signed or out-of-domain sign-ins are refused and recorded; "only single sign-on" turns passwords off
 * but keeps the admin key as the way back in.
 */
test.describe.configure({ mode: 'serial' });

let idp: TestIdp;
let providerId = '';

/** Follow the sign-in the way a browser does: start → IdP → callback. Returns the session cookie, or the error shown. */
async function ssoSignIn(base: string, id: string, opts: { alterState?: boolean; keepCallback?: (url: string, cookie: string) => void } = {}): Promise<{ cookie?: string; error?: string; location: string }> {
  const start = await fetch(`${base}/admin/sso/${id}/start`, { redirect: 'manual' });
  let state = start.headers.getSetCookie().find((c) => c.startsWith('ct_sso='))?.split(';')[0] ?? '';
  if (opts.alterState) state = state.slice(0, -4) + (state.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  const atIdp = await fetch(start.headers.get('location')!, { redirect: 'manual' });
  const callbackUrl = atIdp.headers.get('location')!;
  opts.keepCallback?.(callbackUrl, state);
  const back = await fetch(callbackUrl, { redirect: 'manual', headers: { cookie: state } });
  const location = back.headers.get('location') ?? '';
  const session = back.headers.getSetCookie().find((c) => c.startsWith('ct_session='))?.split(';')[0];
  const error = new URL(location, base).searchParams.get('sso_error') ?? undefined;
  return { ...(session ? { cookie: session } : {}), ...(error ? { error } : {}), location };
}
const me = async (base: string, cookie: string) => (await (await fetch(`${base}/admin/api/me`, { headers: { cookie } })).json()) as any;
async function audited(filter: (e: any) => boolean): Promise<any[]> {
  for (let i = 0; i < 30; i++) {
    const found = ((await admin.get('/admin/api/audit?limit=200')).body.events as any[]).filter(filter);
    if (found.length) return found;
    await new Promise((r) => setTimeout(r, 150));
  }
  return [];
}

test.beforeAll(async () => {
  await admin.signIn();
  idp = await testIdp();
});
test.afterAll(async () => {
  for (const e of ['sso-new@example.com', 'sso-invited@example.com']) {
    const u = ((await admin.get('/admin/api/users')).body.users as any[]).find((x) => x.email === e);
    if (u) await admin.del(`/admin/api/users/${u.id}`);
  }
  if (providerId) await admin.del(`/admin/api/identity-providers/${providerId}`);
  await idp.close();
});

test('an admin adds an identity provider; the sign-in page offers it', async () => {
  const bad = await admin.post('/admin/api/identity-providers', { name: 'Evil', issuer: 'http://idp.evil.example', client_id: 'x' });
  expect(bad.status).toBe(400);
  expect(bad.body.error.message).toContain('https');

  const p = await admin.post('/admin/api/identity-providers', {
    name: 'Test IdP',
    issuer: idp.url,
    client_id: idp.clientId,
    client_secret: idp.clientSecret,
    allowed_domains: ['example.com'],
    groups_claim: 'groups',
    role_map: { admin: ['ct-admins'], approver: ['ct-approvers'] },
    default_role: 'viewer',
  });
  expect(p.status).toBe(201);
  providerId = p.body.id;
  expect(p.body.provider).toMatchObject({ client_secret_set: true, redirect_uri: `${CT}/admin/sso/${providerId}/callback` });
  expect(JSON.stringify(p.body)).not.toContain(idp.clientSecret);
  expect((await admin.post(`/admin/api/identity-providers/${providerId}/test`)).body).toMatchObject({ ok: true, authorization_endpoint: `${idp.url}/authorize` });
  expect(await (await fetch(`${CT}/admin/api/sso`)).json()).toEqual({ providers: [{ id: providerId, name: 'Test IdP' }], sso_only: false });
});

test('someone new signs in, is created with the role their groups give, and it is recorded', async () => {
  idp.user = { sub: 'idp-user-1', email: 'SSO-New@Example.com', groups: ['staff', 'ct-approvers'] };
  const r = await ssoSignIn(CT, providerId);
  expect(r.error).toBeUndefined();
  expect(r.location).toBe('/');
  expect(await me(CT, r.cookie!)).toMatchObject({ email: 'sso-new@example.com', role: 'approver', must_change_password: false });
  expect(idp.tokenRequests.at(-1)?.auth).toBe('basic');
  const [created] = await audited((e) => e.action === 'users.create' && e.detail?.email === 'sso-new@example.com');
  expect(created).toMatchObject({ actor: { type: 'system' }, detail: { reason: 'first single sign-on', role: 'approver' } });
  const [signIn] = await audited((e) => e.action === 'auth.sign_in' && e.actor.email === 'sso-new@example.com' && e.outcome === 'success');
  expect(signIn.detail).toMatchObject({ method: 'sso', provider: 'Test IdP', groups: ['staff', 'ct-approvers'] });
  // They have no password to sign in with.
  const pw = await fetch(`${CT}/admin/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'sso-new@example.com', password: '' }) });
  expect(pw.status).toBe(401);
});

test('moving someone between groups at the IdP changes their role at the next sign-in, and ends old sessions', async () => {
  idp.user = { sub: 'idp-user-1', email: 'sso-new@example.com', groups: ['ct-approvers'] };
  const first = await ssoSignIn(CT, providerId);
  idp.user = { sub: 'idp-user-1', email: 'sso-new@example.com', groups: ['ct-admins'] };
  const second = await ssoSignIn(CT, providerId);
  expect((await me(CT, second.cookie!)).role).toBe('admin');
  expect((await fetch(`${CT}/admin/api/me`, { headers: { cookie: first.cookie! } })).status).toBe(401);
  idp.user = { sub: 'idp-user-1', email: 'sso-new@example.com', groups: [] };
  expect((await me(CT, (await ssoSignIn(CT, providerId)).cookie!)).role).toBe('viewer'); // the default role
});

test('refused: another domain, no allowed group, a user who cancels', async () => {
  idp.user = { sub: 'outsider', email: 'eve@evil.example', groups: ['ct-admins'] };
  expect((await ssoSignIn(CT, providerId)).error).toContain('evil.example is not one of the email domains');
  expect((await audited((e) => e.action === 'auth.sign_in' && e.outcome === 'denied' && e.actor.email === 'eve@evil.example')).length).toBe(1);

  await admin.patch(`/admin/api/identity-providers/${providerId}`, { default_role: 'none' });
  idp.user = { sub: 'nobody', email: 'nogroups@example.com', groups: ['staff'] };
  expect((await ssoSignIn(CT, providerId)).error).toContain('none of the groups');
  await admin.patch(`/admin/api/identity-providers/${providerId}`, { default_role: 'viewer' });

  idp.user = null;
  expect((await ssoSignIn(CT, providerId)).error).toContain('cancelled');
});

test('refused: altered state, a replayed callback, a wrong nonce, audience or issuer, a token signed by another key', async () => {
  idp.user = { sub: 'idp-user-1', email: 'sso-new@example.com', groups: [] };
  expect((await ssoSignIn(CT, providerId, { alterState: true })).error).toContain('expired or was started elsewhere');

  let replay: { url: string; cookie: string } | undefined;
  const ok = await ssoSignIn(CT, providerId, { keepCallback: (url, cookie) => (replay = { url, cookie }) });
  expect(ok.cookie).toBeTruthy();
  const again = await fetch(replay!.url, { redirect: 'manual', headers: { cookie: replay!.cookie } });
  expect(again.headers.getSetCookie().some((c) => c.startsWith('ct_session='))).toBe(false);
  expect(again.headers.get('location')).toContain('sso_error');

  for (const tamper of [
    { claims: (c: Record<string, unknown>) => ({ ...c, nonce: 'not-the-nonce' }) },
    { claims: (c: Record<string, unknown>) => ({ ...c, aud: 'someone-else' }) },
    { claims: (c: Record<string, unknown>) => ({ ...c, iss: 'https://impostor.example' }) },
    { claims: (c: Record<string, unknown>) => ({ ...c, exp: Math.floor(Date.now() / 1000) - 3600 }) },
    { signWithOtherKey: true },
  ]) {
    idp.tamper = tamper;
    const r = await ssoSignIn(CT, providerId);
    expect(r.cookie, JSON.stringify(tamper)).toBeUndefined();
    expect(r.error).toContain('could not be verified');
  }
  idp.tamper = null;
});

test('with new people not created, only someone an admin added gets in, and is linked to their IdP identity', async () => {
  await admin.patch(`/admin/api/identity-providers/${providerId}`, { create_users: false, groups_claim: null });
  idp.user = { sub: 'idp-user-2', email: 'sso-invited@example.com', groups: [] };
  expect((await ssoSignIn(CT, providerId)).error).toContain('have not been added');
  await admin.post('/admin/api/users', { email: 'sso-invited@example.com', role: 'approver' });
  const r = await ssoSignIn(CT, providerId);
  expect(await me(CT, r.cookie!)).toMatchObject({ email: 'sso-invited@example.com', role: 'approver' }); // the role the admin gave
  // Someone else at the IdP claiming the same email can't take the account over.
  idp.user = { sub: 'idp-impostor', email: 'sso-invited@example.com', groups: [] };
  expect((await ssoSignIn(CT, providerId)).error).toContain('another identity');
  await admin.patch(`/admin/api/identity-providers/${providerId}`, { create_users: true, groups_claim: 'groups' });
});

test('"only single sign-on" needs the admin key, and someone who has used it', async () => {
  const r = await admin.put('/admin/api/sso/settings', { sso_only: true });
  expect(r.status).toBe(400);
  expect(r.body.error.message).toContain('CT_ADMIN_KEY'); // this server has no admin key
  expect((await admin.get('/admin/api/identity-providers')).body).toMatchObject({ sso_only: false, admin_key_set: false });
});

test('the sign-in page offers single sign-on and signs you in with it', async ({ page }) => {
  idp.user = { sub: 'idp-user-1', email: 'sso-new@example.com', groups: ['ct-admins'] };
  await page.goto(CT);
  await page.getByRole('button', { name: 'Sign in with Test IdP' }).click();
  await expect(page.locator('.side-user')).toContainText('sso-new@example.com');

  await page.context().clearCookies();
  idp.user = { sub: 'outsider', email: 'eve@evil.example', groups: [] };
  await page.goto(CT);
  await page.getByRole('button', { name: 'Sign in with Test IdP' }).click();
  await expect(page.getByText('evil.example is not one of the email domains')).toBeVisible();
});

// Passwords off: a server of its own, with an admin key.
test.describe('only single sign-on', () => {
  const PORT = 4473;
  const BASE = `http://127.0.0.1:${PORT}`;
  const AK = 'sso-only-admin-key-0123456789';
  let server: ChildProcess;
  let pid = '';
  const ak = (method: string, p: string, body?: unknown) =>
    fetch(`${BASE}${p}`, { method, headers: { authorization: `Bearer ${AK}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
  const login = (email: string, password: string) => fetch(`${BASE}/admin/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });

  test.beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-sso-'));
    server = spawn('node', ['server/dist/server.mjs', '--port', String(PORT)], { env: { ...process.env, CT_DATA_DIR: dir, CT_UI_DIR: path.resolve('ui/dist'), CT_LOG_LEVEL: 'warn', CT_ADMIN_KEY: AK, CT_MODEL_HEALTH_INTERVAL_S: '0', CT_LOGIN_RPM: '1000' }, stdio: 'ignore' });
    await expect.poll(async () => (await fetch(`${BASE}/healthz`).catch(() => undefined))?.status, { timeout: 20_000 }).toBe(200);
    pid = (await ak('POST', '/admin/api/identity-providers', { name: 'Test IdP', issuer: idp.url, client_id: idp.clientId, client_secret: idp.clientSecret, default_role: 'viewer' })).body.id;
  });
  test.afterAll(async () => {
    const done = new Promise((r) => server.once('exit', r));
    server.kill('SIGTERM');
    await done;
  });

  test('passwords are refused, single sign-on and the admin key still work, and turning it off brings passwords back', async () => {
    const u = await ak('POST', '/admin/api/users', { email: 'pw-person@example.com', role: 'viewer' });
    const before = await login('pw-person@example.com', u.body.password);
    expect(before.status).toBe(200);
    const beforeCookie = before.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

    expect((await ak('PUT', '/admin/api/sso/settings', { sso_only: true })).body).toEqual({ ok: true, sso_only: true });
    expect(await (await fetch(`${BASE}/admin/api/sso`)).json()).toMatchObject({ sso_only: true });
    const refused = await login('pw-person@example.com', u.body.password);
    expect([refused.status, ((await refused.json()) as any).error.code]).toEqual([403, 'sso_required']);
    expect((await fetch(`${BASE}/admin/api/me`, { headers: { cookie: beforeCookie } })).status).toBe(401); // their password session ended
    expect((await login('admin', AK)).status).toBe(200); // the admin key's own sign-in: the way back in

    idp.user = { sub: 'sso-only-1', email: 'sso-only@example.com', groups: [] };
    const r = await ssoSignIn(BASE, pid);
    expect((await me(BASE, r.cookie!)).email).toBe('sso-only@example.com');

    expect((await ak('DELETE', `/admin/api/identity-providers/${pid}`)).status).toBe(400); // the last provider can't go while passwords are off
    expect((await ak('PUT', '/admin/api/sso/settings', { sso_only: false })).body.sso_only).toBe(false);
    expect((await login('pw-person@example.com', u.body.password)).status).toBe(200);
  });
});
