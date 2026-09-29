import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TEST_LICENSE_PUBLIC_KEY, testLicense } from './support/license';
import { testIdp, type TestIdp } from './support/oidc-idp';

/**
 * Control Tower Enterprise: without a license the Enterprise features are off and everything else works; a
 * signed license key turns them on, checked on the server; tampered keys are refused; an ended license keeps
 * working through its grace period, and passwords come back so nobody is locked out; seats cap single sign-on.
 */
test.describe.configure({ mode: 'serial' });

const PORT = 4474;
const BASE = `http://127.0.0.1:${PORT}`;
const AK = 'license-admin-key-0123456789';
const DAY = 86_400_000;
let server: ChildProcess;
let idp: TestIdp;

const ak = (method: string, p: string, body?: unknown) =>
  fetch(`${BASE}${p}`, { method, headers: { authorization: `Bearer ${AK}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }).then(async (r) => ({ status: r.status, body: (await r.json().catch(() => ({}))) as any }));

async function ssoSignIn(id: string): Promise<{ cookie?: string; error?: string }> {
  const start = await fetch(`${BASE}/admin/sso/${id}/start`, { redirect: 'manual' });
  const loc = start.headers.get('location') ?? '';
  if (!loc.startsWith('http')) return { error: new URL(loc, BASE).searchParams.get('sso_error') ?? 'refused at start' };
  const state = start.headers.getSetCookie().find((c) => c.startsWith('ct_sso='))?.split(';')[0] ?? '';
  const atIdp = await fetch(loc, { redirect: 'manual' });
  const back = await fetch(atIdp.headers.get('location')!, { redirect: 'manual', headers: { cookie: state } });
  const session = back.headers.getSetCookie().find((c) => c.startsWith('ct_session='))?.split(';')[0];
  const error = new URL(back.headers.get('location') ?? '/', BASE).searchParams.get('sso_error') ?? undefined;
  return { ...(session ? { cookie: session } : {}), ...(error ? { error } : {}) };
}

test.beforeAll(async () => {
  idp = await testIdp();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-license-'));
  server = spawn('node', ['server/dist/server.mjs', '--port', String(PORT)], {
    env: { ...process.env, CT_DATA_DIR: dir, CT_UI_DIR: path.resolve('ui/dist'), CT_LOG_LEVEL: 'warn', CT_ADMIN_KEY: AK, CT_MODEL_HEALTH_INTERVAL_S: '0', CT_LOGIN_RPM: '1000', CT_LICENSE_PUBLIC_KEY: TEST_LICENSE_PUBLIC_KEY, CT_LICENSE_KEY: '' },
    stdio: 'ignore',
  });
  await expect.poll(async () => (await fetch(`${BASE}/healthz`).catch(() => undefined))?.status, { timeout: 20_000 }).toBe(200);
});
test.afterAll(async () => {
  const done = new Promise((r) => server.once('exit', r));
  server.kill('SIGTERM');
  await done;
  await idp.close();
});

test('without a license, Enterprise features are off and say so; the rest works', async () => {
  expect((await ak('GET', '/admin/api/license')).body).toMatchObject({ status: 'none', editable: true });
  for (const [method, p] of [['GET', '/admin/api/audit'], ['GET', '/admin/api/identity-providers'], ['POST', '/admin/api/identity-providers'], ['PUT', '/admin/api/sso/settings']] as const) {
    const r = await ak(method, p, method === 'GET' ? undefined : {});
    expect([r.status, r.body.error?.code], `${method} ${p}`).toEqual([402, 'enterprise_required']);
  }
  expect(await (await fetch(`${BASE}/admin/api/sso`)).json()).toEqual({ providers: [], sso_only: false });
  expect((await ak('POST', '/admin/api/keys', { name: 'free-agent' })).status).toBe(201); // everything else works
});

test('a tampered or foreign key is refused; a signed one turns Enterprise on', async () => {
  const good = testLicense({ customer: 'Acme', seats: 1 });
  const [h, , sig] = good.split('.');
  const forged = `${h}.${Buffer.from(JSON.stringify({ v: 1, kid: 'test', id: 'x', customer: 'Acme', email: 'a@acme.com', plan: 'enterprise', seats: 9999, requests_per_year: 0, features: ['*'], issued_at: 0, expires_at: Date.now() + 999 * DAY })).toString('base64url')}.${sig}`;
  expect((await ak('PUT', '/admin/api/license', { key: forged })).body.error.message).toContain('signature');
  expect((await ak('PUT', '/admin/api/license', { key: 'sk-live-123' })).status).toBe(400);

  const r = await ak('PUT', '/admin/api/license', { key: good });
  expect(r.body).toMatchObject({ status: 'valid', source: 'console', license: { customer: 'Acme', seats: 1, plan: 'enterprise' } });
  expect(JSON.stringify(r.body)).not.toContain(good); // the key is never sent back
  expect((await ak('GET', '/admin/api/audit')).status).toBe(200);
  // What was done without a license was not recorded; what's done now is.
  expect(((await ak('GET', '/admin/api/audit')).body.events as any[]).some((e) => e.detail?.body?.name === 'free-agent')).toBe(false);
  await ak('POST', '/admin/api/keys', { name: 'licensed-agent' });
  await expect.poll(async () => ((await ak('GET', '/admin/api/audit')).body.events as any[]).some((e) => e.detail?.body?.name === 'licensed-agent')).toBe(true);
});

test('seats cap how many people sign in with single sign-on', async () => {
  const p = await ak('POST', '/admin/api/identity-providers', { name: 'Test IdP', issuer: idp.url, client_id: idp.clientId, client_secret: idp.clientSecret, default_role: 'viewer' });
  expect(p.status).toBe(201);
  idp.user = { sub: 'seat-1', email: 'first@example.com' };
  expect((await ssoSignIn(p.body.id)).cookie).toBeTruthy();
  idp.user = { sub: 'seat-1', email: 'first@example.com' };
  expect((await ssoSignIn(p.body.id)).cookie).toBeTruthy(); // the same person again: still one seat
  idp.user = { sub: 'seat-2', email: 'second@example.com' };
  expect((await ssoSignIn(p.body.id)).error).toContain('covers 1 person');
  expect((await ak('GET', '/admin/api/license')).body.seats_used).toBe(1);
});

test('an ended license: grace keeps Enterprise on; after it, features stop and passwords come back', async () => {
  const idpId = (await ak('GET', '/admin/api/identity-providers')).body.providers[0].id;
  // Passwords off while licensed…
  const u = await ak('POST', '/admin/api/users', { email: 'pw@example.com', role: 'viewer' });
  expect((await ak('PUT', '/admin/api/sso/settings', { sso_only: true })).status).toBe(200);
  const login = () => fetch(`${BASE}/admin/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'pw@example.com', password: u.body.password }) });
  expect((await login()).status).toBe(403);

  await ak('PUT', '/admin/api/license', { key: testLicense({ seats: 5, expires_at: Date.now() - 3 * DAY }) });
  expect((await ak('GET', '/admin/api/license')).body.status).toBe('grace');
  expect((await ak('GET', '/admin/api/audit')).status).toBe(200);

  await ak('PUT', '/admin/api/license', { key: testLicense({ seats: 5, expires_at: Date.now() - 20 * DAY }) });
  expect((await ak('GET', '/admin/api/license')).body.status).toBe('expired');
  expect((await ak('GET', '/admin/api/audit')).status).toBe(402);
  expect((await login()).status).toBe(200); // not locked out
  idp.user = { sub: 'seat-1', email: 'first@example.com' };
  expect((await ssoSignIn(idpId)).error).toContain('needs a Control Tower Enterprise license');

  await ak('PUT', '/admin/api/license', { key: testLicense({ seats: 5, expires_at: Date.now() + 10 * DAY }) });
  expect((await ak('GET', '/admin/api/license')).body.status).toBe('expiring');
  expect((await ak('DELETE', '/admin/api/license')).body.status).toBe('none');
});

test('the console shows the license, and Enterprise notices where features are off', async ({ page }) => {
  await page.goto(BASE);
  await page.getByLabel('Email or username').fill('admin');
  await page.getByLabel('Password').fill(AK);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.goto(`${BASE}/#/audit`);
  await expect(page.getByText('is part of Control Tower Enterprise')).toBeVisible();
  await page.goto(`${BASE}/#/license`);
  await page.getByLabel('Add a license key').fill(testLicense({ customer: 'Console Co', expires_at: Date.now() + 5 * DAY }));
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Console Co')).toBeVisible();
  await page.reload();
  await expect(page.locator('.role-banner')).toContainText('ends on');
});
