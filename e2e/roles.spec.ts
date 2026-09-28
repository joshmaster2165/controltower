import { test, expect } from '@playwright/test';
import { CT, admin } from './support/admin';
import { routingUpstream, type RoutingUpstream } from './support/routing-upstream';

/**
 * Console roles: admins change anything; approvers see everything and decide approvals; viewers see
 * everything and change nothing. People an admin adds sign in with a one-time password and must choose
 * their own before anything else; a new role or password ends their sessions.
 */
test.describe.configure({ mode: 'serial' });

class Session {
  cookie = '';
  csrf = '';
  constructor(readonly email: string) {}
  async login(password: string) {
    const r = await fetch(`${CT}/admin/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: this.email, password }) });
    const j = (await r.json()) as any;
    if (r.status === 200) {
      this.cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
      this.csrf = j.csrf;
    }
    return { status: r.status, body: j };
  }
  async call(method: string, path: string, body?: unknown) {
    const r = await fetch(`${CT}${path}`, { method, headers: { cookie: this.cookie, 'x-ct-csrf': this.csrf, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const t = await r.text();
    let j: any = t;
    try {
      j = JSON.parse(t);
    } catch {
      /* text */
    }
    return { status: r.status, body: j };
  }
}

const viewer = new Session('viv@example.com');
const approver = new Session('april@example.com');
const ids: Record<string, string> = {};
let up: RoutingUpstream;
let providerId = '';

test.beforeAll(async () => {
  await admin.signIn();
  up = await routingUpstream('roles');
  const p = await admin.post('/admin/api/providers', { catalog_id: 'custom', name: 'Roles upstream', slug: 'roleup', base_url: `${up.url}/v1`, credentials: { api_key: 'x' } });
  providerId = (p.body.provider ?? p.body).id;
  await admin.post('/admin/api/deployments', { provider_id: providerId, upstream_model: 'ok-roles', public_name: 'roles-model' });
});

test.afterAll(async () => {
  for (const id of Object.values(ids)) await admin.del(`/admin/api/users/${id}`);
  await admin.del(`/admin/api/providers/${providerId}`);
  await up.close();
});

test('an admin adds people with a one-time password, which only lets them choose their own', async () => {
  const v = await admin.post('/admin/api/users', { email: viewer.email, role: 'viewer' });
  expect(v.status).toBe(201);
  ids.viewer = v.body.id;
  const a = await admin.post('/admin/api/users', { email: approver.email, role: 'approver' });
  ids.approver = a.body.id;
  expect((await admin.post('/admin/api/users', { email: viewer.email, role: 'viewer' })).status).toBe(409);

  const first = await viewer.login(v.body.password);
  expect(first.body).toMatchObject({ role: 'viewer', must_change_password: true });
  expect((await viewer.call('GET', '/admin/api/keys')).body.error.code).toBe('password_change_required');
  expect((await viewer.call('POST', '/admin/api/me/password', { current: 'wrong-password', password: 'viewer-password-1' })).status).toBe(403);
  expect((await viewer.call('POST', '/admin/api/me/password', { current: v.body.password, password: 'short' })).status).toBe(400);
  expect((await viewer.call('POST', '/admin/api/me/password', { current: v.body.password, password: 'viewer-password-1' })).status).toBe(200);
  expect((await viewer.login(v.body.password)).status).toBe(401); // the one-time password is spent
  expect((await viewer.login('viewer-password-1')).body).toMatchObject({ role: 'viewer', must_change_password: false });

  await approver.login(a.body.password);
  await approver.call('POST', '/admin/api/me/password', { current: a.body.password, password: 'approver-password-1' });
  expect((await approver.login('approver-password-1')).status).toBe(200);
});

test('a viewer sees everything and changes nothing', async () => {
  for (const path of ['/admin/api/keys', '/admin/api/topology', '/admin/api/flights', '/admin/api/policy', '/admin/api/exports', '/admin/api/guardrail-services']) {
    expect((await viewer.call('GET', path)).status, path).toBe(200);
  }
  const k = await viewer.call('POST', '/admin/api/keys', { name: 'sneaky' });
  expect([k.status, k.body.error.code]).toEqual([403, 'forbidden']);
  expect((await viewer.call('DELETE', `/admin/api/providers/${providerId}`)).status).toBe(403);
  expect((await viewer.call('PUT', '/admin/api/airspace/layout', { positions: {} })).status).toBe(403);
  expect((await viewer.call('GET', '/admin/api/users')).status).toBe(403);
});

test('an approver decides approvals, and nothing else', async () => {
  const key = (await admin.post('/admin/api/keys', { name: 'roles-agent', agent_id: 'roles-agent' })).body;
  const rule = await admin.post('/admin/api/rules', { name: 'roles: hold', target_kind: 'model', match: { keys: [key.id] }, effect: 'require_approval', config: { hold_ms: 0 } });
  try {
    const held = await fetch(`${CT}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'roles-model', messages: [{ role: 'user', content: 'hi' }] }) });
    expect(held.status).toBe(403);
    const card = ((await held.json()) as any).error.ct.request_id;
    expect((await viewer.call('POST', `/admin/api/approvals/${card}/decide`, { action: 'approve' })).status).toBe(403);
    const d = await approver.call('POST', `/admin/api/approvals/${card}/decide`, { action: 'approve', note: 'fine' });
    expect(d.status).toBe(200);
    const a = ((await admin.get('/admin/api/approvals?status=all&limit=50')).body.approvals as any[]).find((x) => x.id === card);
    expect(a.resolved_by ?? a.decided_by ?? a.by).toContain('april@example.com');
    expect((await approver.call('POST', '/admin/api/rules', { name: 'x', target_kind: 'model', effect: 'deny' })).status).toBe(403);
  } finally {
    await admin.del(`/admin/api/rules/${rule.body.id ?? rule.body.rule?.id}`);
    await admin.del(`/admin/api/keys/${key.id}`);
  }
});

test('a new role, or a reset password, ends the person\'s sessions; someone always stays an admin', async () => {
  expect((await admin.patch(`/admin/api/users/${ids.viewer}`, { role: 'approver' })).status).toBe(200);
  expect((await viewer.call('GET', '/admin/api/keys')).status).toBe(401);
  expect((await viewer.login('viewer-password-1')).body.role).toBe('approver');

  const reset = await admin.patch(`/admin/api/users/${ids.approver}`, { reset_password: true });
  expect(reset.body.password).toBeTruthy();
  expect((await approver.call('GET', '/admin/api/keys')).status).toBe(401);
  expect((await approver.login('approver-password-1')).status).toBe(401);
  expect((await approver.login(reset.body.password)).body.must_change_password).toBe(true);

  const people = (await admin.get('/admin/api/users')).body.users as any[];
  const me = people.find((u) => u.email === 'e2e@example.com');
  const onlyAdmin = people.filter((u) => u.role === 'admin').length === 1;
  if (onlyAdmin) expect((await admin.patch(`/admin/api/users/${me.id}`, { role: 'viewer' })).status).toBe(400);
  expect((await admin.del(`/admin/api/users/${me.id}`)).status).toBe(400);
});

test('the console shows a viewer what they can do', async ({ page }) => {
  await admin.patch(`/admin/api/users/${ids.viewer}`, { role: 'viewer' });
  const s = await page.request.post(`${CT}/admin/api/login`, { data: { email: viewer.email, password: 'viewer-password-1' } });
  expect(s.status()).toBe(200);
  await page.goto(`${CT}/#/keys`);
  await expect(page.getByText('You can see everything here. Changing anything needs an admin.')).toBeVisible();
  await expect(page.locator('.sidebar').getByText('People', { exact: true })).toHaveCount(0);
  await expect(page.locator('.side-user')).toContainText('viewer');
});
