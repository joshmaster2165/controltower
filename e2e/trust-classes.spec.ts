import { test, expect } from '@playwright/test';
import { CT, admin } from './support/admin';
import { routingUpstream, type RoutingUpstream } from './support/routing-upstream';

/**
 * The Airspace's Classes and Coverage views: an agent that reads a billing API (restricted data, class B) and sends
 * to a model outside the company (class D) is an exfiltration risk until something checks what it sends; coverage
 * counts that agent's calls under its team.
 */
test.describe.configure({ mode: 'serial' });

const run = Date.now().toString(36);
let up: RoutingUpstream;
let providerId = '';
let deploymentId = '';
let apiId = '';
let keyId = '';
let key = '';
let ruleId = '';
const team = `billing-ops-${run}`;

test.beforeAll(async () => {
  up = await routingUpstream('cls');
  await admin.signIn();
  const p = await admin.post('/admin/api/providers', { catalog_id: 'custom', name: `Outside models ${run}`, slug: `clsup${run}`.slice(0, 20), base_url: `${up.url}/v1`, credentials: { api_key: 'sk-cls' } });
  providerId = (p.body.provider ?? p.body).id;
  const d = await admin.post('/admin/api/deployments', { provider_id: providerId, upstream_model: 'ok-classes', public_name: `cls-model-${run}`, pricing_override: { input: 1, output: 2 } });
  deploymentId = (d.body.deployment ?? d.body).id;
  const a = await admin.post('/admin/api/http/apis', { name: `Customer billing ${run}`, slug: `billing-${run}`, base_url: up.url });
  expect(a.status, JSON.stringify(a.body)).toBe(201);
  apiId = a.body.api.id;
  const k = await admin.post('/admin/api/keys', { name: `billing-agent-${run}`, team, allowed_models: ['*'] });
  keyId = k.body.id;
  key = k.body.key;
});

test.afterAll(async () => {
  if (ruleId) await admin.del(`/admin/api/rules/${ruleId}`);
  if (keyId) await admin.del(`/admin/api/keys/${keyId}`);
  if (apiId) await admin.del(`/admin/api/http/apis/${apiId}`);
  if (deploymentId) await admin.del(`/admin/api/deployments/${deploymentId}`);
  if (providerId) await admin.del(`/admin/api/providers/${providerId}`);
  await up?.close();
});

test('classes: depth, a risk path out, an admin setting a class, and a gate that checks it', async () => {
  // The agent reads the billing API and thinks with the model.
  expect((await fetch(`${CT}/http/billing-${run}/v1/invoices`, { headers: { authorization: `Bearer ${key}` } })).status).toBe(200);
  const chat = await fetch(`${CT}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: `cls-model-${run}`, messages: [{ role: 'user', content: 'Summarise the overdue invoices' }] }) });
  expect(chat.status).toBe(200);

  const classes = async () => (await admin.get('/admin/api/airspace/classes?hours=1')).body;
  const provider = `provider:${providerId}`;
  const billing = `tool:${apiId}`;
  // Both paths show up once the calls are recorded.
  await expect.poll(async () => ((await classes()).links as any[]).filter((l) => l.agent_id === keyId).length, { timeout: 10_000 }).toBe(2);

  let d = await classes();
  const sys = (id: string) => (d.systems as any[]).find((s) => s.id === id);
  expect(sys(billing).class).toBe('B');
  expect(sys(billing).reason).toMatch(/restricted/);
  // A model on this network is inside the company by default; this one stands in for a vendor's.
  expect(sys(provider).class).toBe('C');
  expect((await admin.put(`/admin/api/airspace/classes/${encodeURIComponent(provider)}`, { class: 'Z' })).status).toBe(400);
  expect((await admin.put(`/admin/api/airspace/classes/${encodeURIComponent(provider)}`, { class: 'D' })).status).toBe(200);
  d = await classes();
  expect(sys(provider)).toMatchObject({ class: 'D', default_class: 'C', set: true });
  expect(sys(provider).reason).toContain('e2e@example.com');
  const agent = (d.agents as any[]).find((a) => a.id === keyId);
  expect(agent.depth).toBe('B');

  // Restricted data within reach, and a way out: high, unless a gate elsewhere already checks model calls.
  const risk = () => (d.risks as any[]).find((r) => r.agent_id === keyId && r.dest_id === provider);
  expect(risk()).toMatchObject({ source_id: billing, source_class: 'B', dest_class: 'D', outside: false });
  expect(risk().level === 'high' || !!risk().mitigation).toBe(true);
  expect(sys(provider).gate).toEqual({ target_kind: 'model', match: { deployments: [deploymentId] } });

  // The gate the panel adds: what this agent sends there is inspected. The risk is then checked (low).
  const g = await admin.post('/admin/api/rules', { name: `Mask data leaving ${run}`, target_kind: 'model', match: { keys: [keyId], deployments: [deploymentId] }, effect: 'inspect', config: { detectors: ['email', 'credit_card'], action: 'mask', direction: 'input' }, priority: 40 });
  expect(g.status, JSON.stringify(g.body)).toBe(201);
  ruleId = g.body.id ?? g.body.rule?.id;
  d = await classes();
  expect(risk().level).toBe('low');
  expect(risk().mitigation).toContain(`Mask data leaving ${run}`);

  // Back to its default.
  expect((await admin.del(`/admin/api/airspace/classes/${encodeURIComponent(provider)}`)).status).toBe(200);
  d = await classes();
  expect(sys(provider)).toMatchObject({ class: 'C', set: false });
  expect(risk()).toBeUndefined();
});

test('coverage: the team, its agent, and how much of its traffic a gate stands on', async () => {
  const c = (await admin.get('/admin/api/airspace/coverage?hours=1')).body;
  const t = (c.teams as any[]).find((x) => x.team === team);
  expect(t.agents.map((a: any) => a.id)).toEqual([keyId]);
  expect(t.calls).toBeGreaterThanOrEqual(2);
  expect(t.governed).toBeLessThanOrEqual(t.calls);
  expect(t.outside).toBe(0);
  expect(c.totals.agents).toBeGreaterThanOrEqual(1);
});

test('the views in the console', async ({ page }) => {
  await page.context().addCookies(admin.cookie.split('; ').map((c) => ({ name: c.split('=')[0]!, value: c.split('=').slice(1).join('='), url: CT })));
  await page.goto(`${CT}/#/airspace`);
  await page.getByRole('radio', { name: 'Classes' }).click();
  await expect(page.getByRole('region', { name: 'Trust classes' })).toBeVisible();
  await expect(page.getByText('Exfiltration risk')).toBeVisible();
  await expect(page.locator('g.agent', { hasText: `billing-agent-${run}`.slice(0, 18) })).toBeVisible();
  // Pick a system: its class, and (for an admin) the class buttons.
  await page.locator('g.sys', { hasText: `Customer billing ${run}`.slice(0, 23) }).click();
  await expect(page.getByRole('radiogroup', { name: 'Trust class' }).getByRole('radio', { name: 'B' })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('radio', { name: 'Coverage' }).click();
  await expect(page.getByRole('region', { name: 'Coverage by team' })).toBeVisible();
  await expect(page.getByText('The whole company')).toBeVisible();
  await expect(page.locator('g.team', { hasText: team })).toBeVisible();
});
