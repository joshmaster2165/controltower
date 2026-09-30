import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TEST_LICENSE_PUBLIC_KEY, testLicense } from './support/license';
import { testIdp, type TestIdp } from './support/oidc-idp';
import { createRequire } from 'node:module';

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
let dataDir = '';
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
  dataDir = dir;
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
  for (const [method, p] of [['GET', '/admin/api/audit'], ['GET', '/admin/api/identity-providers'], ['POST', '/admin/api/identity-providers'], ['PUT', '/admin/api/sso/settings'], ['GET', '/admin/api/token-issuers'], ['POST', '/admin/api/token-issuers'], ['GET', '/admin/api/secret-managers'], ['POST', '/admin/api/keys/x/rotate'], ['PUT', '/admin/api/keys/x/rotation']] as const) {
    const r = await ak(method, p, method === 'GET' ? undefined : {});
    expect([r.status, r.body.error?.code], `${method} ${p}`).toEqual([402, 'enterprise_required']);
  }
  expect(await (await fetch(`${BASE}/admin/api/sso`)).json()).toEqual({ providers: [], sso_only: false });
  // Flights still export; the audit log to a SIEM needs Enterprise.
  const siem = await ak('POST', '/admin/api/exports', { kind: 'webhook', config: { url: 'http://127.0.0.1:9/siem' }, send_audit: true });
  expect([siem.status, siem.body.error?.code, siem.body.error?.feature]).toEqual([402, 'enterprise_required', 'siem_export']);
  expect((await ak('GET', '/admin/api/exports')).body.audit_available).toBe(false);
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
  // SCIM can't provision past the seats either.
  const t = (await ak('POST', `/admin/api/identity-providers/${p.body.id}/scim-token`)).body.token;
  const r = await fetch(`${BASE}/scim/v2/Users`, { method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/scim+json' }, body: JSON.stringify({ userName: 'third@example.com' }) });
  expect(r.status).toBe(403);
  expect(((await r.json()) as any).detail).toContain('covers 1 person');
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

test('a trial ends on its own: at its end, on a running server, Enterprise stops; traffic and passwords carry on', async () => {
  test.setTimeout(60_000);
  const pw = await ak('POST', '/admin/api/users', { email: 'trial-pw@example.com', role: 'viewer' });
  const login = () => fetch(`${BASE}/admin/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'trial-pw@example.com', password: pw.body.password }) }).then((r) => r.status);
  const agent = (await ak('POST', '/admin/api/keys', { name: 'trial-agent' })).body;
  const traffic = () => fetch(`${BASE}/v1/models`, { headers: { authorization: `Bearer ${agent.key}` } }).then((r) => r.status);
  const ENTERPRISE = ['/admin/api/audit', '/admin/api/token-issuers', '/admin/api/teams', '/admin/api/regions', '/admin/api/secret-managers'];

  // A trial that ends in 8 seconds.
  const endsAt = Date.now() + 8_000;
  await ak('PUT', '/admin/api/license', { key: testLicense({ plan: 'trial', id: 'lic_trial_e2e', seats: 50, expires_at: endsAt }) });
  expect((await ak('GET', '/admin/api/license')).body.status).toBe('expiring');
  const idpId = (await ak('GET', '/admin/api/identity-providers')).body.providers[0].id;
  for (const p of ENTERPRISE) expect((await ak('GET', p)).status, `${p} during the trial`).toBe(200);
  const scimToken = (await ak('POST', `/admin/api/identity-providers/${idpId}/scim-token`)).body.token;
  const scim = () => fetch(`${BASE}/scim/v2/Users`, { headers: { authorization: `Bearer ${scimToken}` } }).then((r) => r.status);
  expect(await scim()).toBe(200);
  expect((await ak('PUT', '/admin/api/sso/settings', { sso_only: true })).status).toBe(200);
  expect(await login()).toBe(403); // single sign-on only
  idp.user = { sub: 'trial-1', email: 'trial-1@example.com' };
  expect((await ssoSignIn(idpId)).cookie).toBeTruthy();
  expect(await traffic()).toBe(200);
  await ak('POST', '/admin/api/keys', { name: 'made-during-trial' });

  // It ends. Nothing restarts or reloads the server.
  await new Promise((r) => setTimeout(r, Math.max(0, endsAt - Date.now()) + 1_000));
  expect((await ak('GET', '/admin/api/license')).body.status).toBe('expired'); // no grace period for a trial
  for (const p of ENTERPRISE) expect((await ak('GET', p)).status, `${p} after the trial`).toBe(402);
  expect(await scim()).toBe(403);
  idp.user = { sub: 'trial-2', email: 'trial-2@example.com' };
  expect((await ssoSignIn(idpId)).error).toContain('needs a Control Tower Enterprise license');
  expect(await login()).toBe(200); // passwords work again: nobody is locked out
  expect(await traffic()).toBe(200); // agents are never cut off
  await ak('POST', '/admin/api/keys', { name: 'made-after-trial' });

  // Licensed again, the audit log has what happened during the trial and nothing from after it.
  await ak('PUT', '/admin/api/license', { key: testLicense() });
  const audit = JSON.stringify((await ak('GET', '/admin/api/audit?limit=500')).body);
  expect(audit).toContain('made-during-trial');
  expect(audit).not.toContain('made-after-trial');
  await ak('PUT', '/admin/api/sso/settings', { sso_only: false });
  expect((await ak('DELETE', '/admin/api/license')).body.status).toBe('none');
});

test('a clock set back is noticed and reported, never acted on; an admin can say it is right', async ({ page }) => {
  await ak('PUT', '/admin/api/license', { key: testLicense() });
  expect((await ak('GET', '/admin/api/license')).body.clock).toMatchObject({ behind: false });
  // As if this server had once run 40 days from now: its clock now reads 40 days behind the latest time seen.
  const Database = createRequire(path.resolve('server/package.json'))('better-sqlite3');
  const db = new Database(path.join(dataDir, 'controltower.db'));
  db.prepare("UPDATE settings SET value = ? WHERE key = 'clock_high_water'").run(String(Date.now() + 40 * DAY));
  db.close();
  const lic = (await ak('GET', '/admin/api/license')).body;
  expect(lic.clock).toMatchObject({ behind: true });
  expect(lic.status).toBe('valid'); // never acted on
  const audit = JSON.stringify((await ak('GET', '/admin/api/audit?limit=50')).body);
  expect(audit).toContain('license.clock_behind');

  // The console says so, and an admin says the clock is right.
  await page.goto(BASE);
  await page.getByLabel('Email or username').fill('admin');
  await page.getByLabel('Password').fill(AK);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'behind the latest time' })).toContainText('40 days behind');
  await page.getByRole('button', { name: 'say so' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'behind the latest time' })).toHaveCount(0);
  expect((await ak('GET', '/admin/api/license')).body.clock).toMatchObject({ behind: false });
  expect(JSON.stringify((await ak('GET', '/admin/api/audit?limit=50')).body)).toContain('license.clock_accepted');
  await ak('DELETE', '/admin/api/license');
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

test("requests are counted against the year's allowance: the console warns, and traffic is never stopped", async ({ page }) => {
  // An earlier test turned on "only single sign-on": passwords back on, to sign in here.
  await ak('PUT', '/admin/api/sso/settings', { sso_only: false });
  await page.goto(BASE);
  await page.getByLabel('Email or username').fill('admin');
  await page.getByLabel('Password').fill(AK);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('.side-user')).toBeVisible();
  expect((await ak('PUT', '/admin/api/license', { key: testLicense({ customer: 'Metered Co', requests_per_year: 10, period_start: Date.now() - 30 * DAY }) })).status).toBe(200);
  const agent = (await ak('POST', '/admin/api/keys', { name: 'metered-agent' })).body;
  const call = () => fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${agent.key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'no-such-model', messages: [{ role: 'user', content: 'hi' }] }) });
  // Past the allowance, calls are answered as they would be anyway (here: no such model), never refused for it.
  const statuses: number[] = [];
  for (let i = 0; i < 12; i++) statuses.push((await call()).status);
  expect(statuses.every((s) => s === statuses[0] && s !== 429 && s !== 402)).toBe(true);
  await new Promise((r) => setTimeout(r, 300));
  const u = (await ak('GET', '/admin/api/license')).body.usage;
  expect(u).toMatchObject({ allowance: 10, level: 'over' });
  expect(u.used).toBeGreaterThanOrEqual(12);
  expect(u.period_end - u.period_start).toBeGreaterThan(364 * DAY);
  await page.goto(`${BASE}/#/license`);
  await page.reload();
  await expect(page.locator('.role-banner')).toContainText('requests used this license year');
  await expect(page.getByLabel('Requests this license year')).toContainText('Requests this license year');
});
