import { test, expect } from '@playwright/test';
import { CT, admin } from './support/admin';
import { routingUpstream, type RoutingUpstream } from './support/routing-upstream';

/**
 * Reach: an agent allowed two models and every tool, that used one model: the view shows what it may reach and what
 * it used, and trimming its key keeps just that.
 */
test.describe.configure({ mode: 'serial' });

const run = Date.now().toString(36);
let up: RoutingUpstream;
let providerId = '';
const deployments: string[] = [];
let keyId = '';
let key = '';

test.beforeAll(async () => {
  up = await routingUpstream('reach');
  await admin.signIn();
  const p = await admin.post('/admin/api/providers', { catalog_id: 'custom', name: `Reach upstream ${run}`, slug: `reach${run}`.slice(0, 20), base_url: `${up.url}/v1`, credentials: { api_key: 'sk-reach' } });
  providerId = (p.body.provider ?? p.body).id;
  for (const m of ['ok-used', 'ok-never']) deployments.push((await admin.post('/admin/api/deployments', { provider_id: providerId, upstream_model: m, public_name: `${m}-${run}` })).body.id);
  const k = await admin.post('/admin/api/keys', { name: `reach-agent-${run}`, team: 'reach', allowed_models: [`ok-used-${run}`, `ok-never-${run}`] });
  keyId = k.body.id;
  key = k.body.key;
});
test.afterAll(async () => {
  if (keyId) await admin.del(`/admin/api/keys/${keyId}`);
  for (const d of deployments) await admin.del(`/admin/api/deployments/${d}`);
  if (providerId) await admin.del(`/admin/api/providers/${providerId}`);
  await up?.close();
});

test('what it may reach, what it used, and the trimmed permissions', async () => {
  for (let i = 0; i < 2; i++) {
    const r = await fetch(`${CT}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: `ok-used-${run}`, messages: [{ role: 'user', content: 'hi' }] }) });
    expect(r.status).toBe(200);
  }
  const reach = async () => (await admin.get(`/admin/api/airspace/reach?key=${keyId}&days=30`)).body;
  await expect.poll(async () => (await reach()).summary.used, { timeout: 10_000 }).toBe(1);
  const d = await reach();
  const model = (n: string) => d.items.find((i: { name: string }) => i.name === `${n}-${run}`);
  expect(model('ok-used')).toMatchObject({ ring: 'model', granted: true, used: true, calls: 2 });
  expect(model('ok-never')).toMatchObject({ granted: true, used: false });
  // On create, an empty tool list means every tool: so it may reach every tool too.
  expect(d.agent.allowed_mcp).toEqual(['*']);
  expect(d.trim.allowed_models).toEqual([`ok-used-${run}`]);
  expect(d.trim.allowed_mcp).toEqual([]);
  expect(d.summary.unused).toBe(d.trim.removes);
  expect((await admin.get('/admin/api/airspace/reach?key=nope')).status).toBe(404);
});

test('the console: the rings, the unused list, and trimming the key', async ({ page }) => {
  await page.context().addCookies(admin.cookie.split('; ').map((c) => ({ name: c.split('=')[0]!, value: c.split('=').slice(1).join('='), url: CT })));
  await page.goto(`${CT}/#/airspace`);
  await page.getByRole('radio', { name: 'Reach' }).click();
  const view = page.getByRole('region', { name: 'Reach' });
  await view.getByLabel('Agent', { exact: true }).selectOption(keyId);
  await expect(view.locator('.reach-agent-name')).toContainText(`reach-agent-${run}`.slice(0, 15));
  await expect(view.locator('.rail-kicker', { hasText: 'Allowed, never used' })).toBeVisible();
  await expect(view.locator('.rail-row', { hasText: `ok-never-${run}` })).toBeVisible();
  await view.getByRole('button', { name: /Trim to what it uses/ }).click();
  await expect(view.locator('.reach-trim')).toContainText(`ok-used-${run}`);
  await view.getByRole('button', { name: 'Trim', exact: true }).click();
  await expect(view.locator('.rail-note')).toContainText('permission');
  const k = ((await admin.get('/admin/api/keys')).body.keys as Array<{ id: string; allowed_models: string[]; allowed_mcp: string[] }>).find((x) => x.id === keyId)!;
  expect(k.allowed_models).toEqual([`ok-used-${run}`]);
  expect(k.allowed_mcp).toEqual([]);
  // Still works for what it used; refused for what it didn't.
  const used = await fetch(`${CT}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: `ok-used-${run}`, messages: [{ role: 'user', content: 'hi' }] }) });
  const never = await fetch(`${CT}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: `ok-never-${run}`, messages: [{ role: 'user', content: 'hi' }] }) });
  expect([used.status, never.status]).toEqual([200, 403]);
});
