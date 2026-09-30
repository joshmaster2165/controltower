import { test, expect } from '@playwright/test';
import WebSocket from 'ws';
import { CT, admin } from './support/admin';
import { routingUpstream, type RoutingUpstream } from './support/routing-upstream';

/**
 * Organisations and teams (Enterprise). A member sees only their teams' agents — keys, calls, approvals, spend,
 * the map and its live traffic; a team admin manages their team's keys, budgets and people and nothing else; an
 * organisation's admin does so for all its teams; a team's held calls are decided by its own people.
 */
test.describe.configure({ mode: 'serial' });

let up: RoutingUpstream;
let providerId = '';
const keys: Record<string, { id: string; key: string }> = {};
const ids: { org?: string; pay?: string; tax?: string; web?: string } = {};
const created: string[] = [];

/** Someone signed in: their cookie and CSRF token, and a way to call the admin API as them. */
async function as(email: string, password: string) {
  const login = async (pw: string) => {
    const r = await fetch(`${CT}/admin/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: pw }) });
    expect(r.status, await r.clone().text()).toBe(200);
    return { cookie: r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '), csrf: ((await r.json()) as { csrf: string }).csrf };
  };
  let s = await login(password);
  const own = `${password}-own-choice`;
  // A one-time password: choose their own first, then sign in again.
  await fetch(`${CT}/admin/api/me/password`, { method: 'POST', headers: { cookie: s.cookie, 'x-ct-csrf': s.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ current: password, password: own }) });
  s = await login(own);
  const call = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(`${CT}${p}`, { method, headers: { cookie: s.cookie, 'x-ct-csrf': s.csrf, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
  };
  return { ...s, call };
}
const chat = (key: string, model = 'team-model') => fetch(`${CT}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }) });

let payAdmin: Awaited<ReturnType<typeof as>>;
let taxMember: Awaited<ReturnType<typeof as>>;
let cfo: Awaited<ReturnType<typeof as>>;

test.beforeAll(async () => {
  up = await routingUpstream('team');
  await admin.signIn();
  const p = await admin.post('/admin/api/providers', { catalog_id: 'custom', name: 'Team upstream', slug: 'teamup', base_url: `${up.url}/v1`, credentials: { api_key: 'sk-team' } });
  providerId = (p.body.provider ?? p.body).id;
  await admin.post('/admin/api/deployments', { provider_id: providerId, upstream_model: 'ok-team', public_name: 'team-model' });
});

test.afterAll(async () => {
  for (const k of Object.values(keys)) await admin.del(`/admin/api/keys/${k.id}`);
  for (const id of created) await admin.del(`/admin/api/keys/${id}`);
  for (const t of [ids.pay, ids.tax, ids.web]) if (t) await admin.del(`/admin/api/teams/${t}`);
  const treasury = ((await admin.get('/admin/api/teams')).body.teams as any[]).find((t) => t.name === 'treasury');
  if (treasury) await admin.del(`/admin/api/teams/${treasury.id}`);
  if (ids.org) await admin.del(`/admin/api/orgs/${ids.org}`);
  for (const u of ((await admin.get('/admin/api/users')).body.users as any[]).filter((x) => x.email.endsWith('@teams.test'))) await admin.del(`/admin/api/users/${u.id}`);
  await admin.del(`/admin/api/providers/${providerId}`);
  await up.close();
});

test('an admin sets up an organisation, its teams, and their people', async () => {
  ids.org = (await admin.post('/admin/api/orgs', { name: 'Finance' })).body.id;
  ids.pay = (await admin.post('/admin/api/teams', { name: 'payments', org_id: ids.org })).body.id;
  ids.tax = (await admin.post('/admin/api/teams', { name: 'tax', org_id: ids.org })).body.id;
  ids.web = (await admin.post('/admin/api/teams', { name: 'web' })).body.id;
  for (const [name, team] of [['pay-bot', 'payments'], ['tax-bot', 'tax'], ['web-bot', 'web']]) keys[name!] = (await admin.post('/admin/api/keys', { name, team })).body;
  const addTo = async (path: string, email: string, role: string) => {
    const r = await admin.put(path, { email, role });
    expect(r.body.created).toBe(true);
    return r.body.password as string;
  };
  payAdmin = await as('pay-admin@teams.test', await addTo(`/admin/api/teams/${ids.pay}/members`, 'pay-admin@teams.test', 'admin'));
  taxMember = await as('tax-member@teams.test', await addTo(`/admin/api/teams/${ids.tax}/members`, 'tax-member@teams.test', 'member'));
  cfo = await as('cfo@teams.test', await addTo(`/admin/api/orgs/${ids.org}/members`, 'cfo@teams.test', 'admin'));
  expect((await payAdmin.call('GET', '/admin/api/me')).body).toMatchObject({ role: 'member', scope: { all: false, teams: ['payments'], manage: ['payments'] } });
  // Traffic from every team.
  for (const k of Object.values(keys)) expect((await chat(k.key)).status).toBe(200);
});

test("a member sees only their teams' keys, calls, spend and map — and nothing of the rest of Control Tower", async () => {
  const names = (r: { body: { keys: Array<{ name: string }> } }) => r.body.keys.map((k) => k.name).sort();
  expect(names(await payAdmin.call('GET', '/admin/api/keys'))).toEqual(['pay-bot']);
  expect(names(await cfo.call('GET', '/admin/api/keys'))).toEqual(['pay-bot', 'tax-bot']);
  await expect.poll(async () => ((await payAdmin.call('GET', '/admin/api/flights?limit=50')).body.flights as any[]).map((f) => f.key_name).filter((n: string) => n.endsWith('-bot'))).toEqual(['pay-bot']);
  const webFlight = ((await admin.get(`/admin/api/flights?key_id=${keys['web-bot']!.id}`)).body.flights as any[])[0];
  expect((await payAdmin.call('GET', `/admin/api/flights/${webFlight.id}`)).status).toBe(404);
  const topo = (await payAdmin.call('GET', '/admin/api/topology')).body;
  expect(topo.keys.map((k: any) => k.name)).toEqual(['pay-bot']);
  expect(topo.edges.every((e: any) => e.key_id === keys['pay-bot']!.id)).toBe(true);
  const ledger = (await payAdmin.call('GET', '/admin/api/ledger/summary')).body;
  expect(ledger.by_key.map((r: any) => r.key_id)).toEqual([keys['pay-bot']!.id]);
  for (const p of ['/admin/api/users', '/admin/api/audit', '/admin/api/alerts', '/admin/api/exports', '/admin/api/customers']) expect((await payAdmin.call('GET', p)).status, p).toBe(403);
  expect((await payAdmin.call('POST', '/admin/api/providers', { catalog_id: 'openai' })).status).toBe(403);
  expect((await payAdmin.call('POST', '/admin/api/rules', { name: 'x', effect: 'deny', target_kind: 'model', match: {} })).status).toBe(403);
});

test("the live map sends a member only their agents' traffic", async () => {
  const ws = new WebSocket(`${CT.replace('http', 'ws')}/admin/ws`, { headers: { cookie: payAdmin.cookie, origin: CT } });
  const seen = new Set<string>();
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw)) as { type: string; paths?: Array<[string]> };
    if (m.type === 'tick') for (const p of m.paths ?? []) seen.add(p[0]);
  });
  await new Promise((r) => ws.once('open', r));
  for (let i = 0; i < 3; i++) for (const k of Object.values(keys)) await chat(k.key);
  await expect.poll(() => seen.has(keys['pay-bot']!.id), { timeout: 5000 }).toBe(true);
  ws.close();
  expect([...seen]).toEqual([keys['pay-bot']!.id]);
});

test("a team admin manages their team's keys and budgets, and no one else's", async () => {
  expect((await payAdmin.call('POST', '/admin/api/keys', { name: 'pay-bot-2', team: 'tax' })).status).toBe(403);
  expect((await payAdmin.call('POST', '/admin/api/keys', { name: 'pay-bot-2' })).status).toBe(403);
  const made = await payAdmin.call('POST', '/admin/api/keys', { name: 'pay-bot-2', team: 'payments' });
  expect(made.status).toBe(201);
  created.push(made.body.id);
  expect((await payAdmin.call('PATCH', `/admin/api/keys/${keys['tax-bot']!.id}`, { enabled: false })).status).toBe(403);
  expect((await payAdmin.call('PATCH', `/admin/api/keys/${made.body.id}`, { team: 'web' })).status).toBe(403);
  expect((await payAdmin.call('PATCH', `/admin/api/keys/${made.body.id}`, { limits: { rpm: 30 } })).status).toBe(200);
  expect((await payAdmin.call('DELETE', `/admin/api/keys/${keys['web-bot']!.id}`)).status).toBe(403);
  expect((await payAdmin.call('POST', '/admin/api/keys/bulk', { action: 'disable', ids: [keys['tax-bot']!.id] })).body.done).toBe(0);
  expect((await payAdmin.call('PUT', `/admin/api/budgets/key/${keys['pay-bot']!.id}`, { limit_usd: 5, period: 'monthly' })).status).toBe(200);
  // A team's own budget is its organisation's call.
  expect((await payAdmin.call('PUT', '/admin/api/budgets/team/payments', { limit_usd: 500, period: 'monthly' })).status).toBe(403);
  expect((await cfo.call('PUT', '/admin/api/budgets/team/payments', { limit_usd: 500, period: 'monthly' })).status).toBe(200);
  expect((await cfo.call('PUT', '/admin/api/budgets/team/web', { limit_usd: 500, period: 'monthly' })).status).toBe(403);
  // Their people: a team admin adds to their team only; an organisation admin adds teams to it.
  expect((await payAdmin.call('PUT', `/admin/api/teams/${ids.tax}/members`, { email: 'x@teams.test' })).status).toBe(403);
  expect((await cfo.call('POST', '/admin/api/teams', { name: 'treasury', org_id: ids.org })).status).toBe(201);
  expect((await cfo.call('POST', '/admin/api/teams', { name: 'rogue' })).status).toBe(403);
  expect((await taxMember.call('POST', '/admin/api/keys', { name: 'tax-2', team: 'tax' })).status).toBe(403);
});

test("a team's held calls are decided by its own people", async () => {
  const gate = await admin.post('/admin/api/rules', { name: 'Payments need approval', target_kind: 'model', match: { keys: [keys['pay-bot']!.id] }, effect: 'require_approval', config: { hold_ms: 15000 } });
  try {
    const held = chat(keys['pay-bot']!.key);
    let pending: any;
    await expect.poll(async () => (pending = ((await payAdmin.call('GET', '/admin/api/approvals?status=pending')).body.approvals as any[])[0]), { timeout: 8000 }).toBeTruthy();
    expect((await taxMember.call('GET', '/admin/api/approvals?status=pending')).body.approvals).toHaveLength(0);
    expect((await taxMember.call('GET', `/admin/api/approvals/${pending.id}`)).status).toBe(404);
    expect((await taxMember.call('POST', `/admin/api/approvals/${pending.id}/decide`, { action: 'approve' })).status).toBe(403);
    expect((await payAdmin.call('POST', `/admin/api/approvals/${pending.id}/decide`, { action: 'approve' })).status).toBe(200);
    expect((await held).status).toBe(200);
  } finally {
    await admin.del(`/admin/api/rules/${gate.body.id}`);
  }
});

test('the console shows a member their teams only', async ({ page }) => {
  // The payments admin's session, in a browser.
  await page.context().addCookies(payAdmin.cookie.split('; ').map((c) => ({ name: c.split('=')[0]!, value: c.slice(c.indexOf('=') + 1), url: CT })));
  await page.goto(`${CT}/#/keys`);
  await expect(page.locator('.side-user')).toContainText('pay-admin@teams.test');
  const nav = await page.locator('nav a, .side a').allTextContents();
  for (const hidden of ['Providers', 'People', 'Audit log', 'Exports']) expect(nav.join(' ')).not.toContain(hidden);
  await expect(page.getByText('You see your teams: payments')).toBeVisible();
  await expect(page.getByText('pay-bot', { exact: true })).toBeVisible();
  await expect(page.getByText('tax-bot', { exact: true })).toHaveCount(0);
  await page.goto(`${CT}/#/providers`);
  await expect(page.getByText('Not part of your teams')).toBeVisible();
  await page.goto(`${CT}/#/teams`);
  await expect(page.locator('.members').getByText('pay-admin@teams.test')).toBeVisible();
});
