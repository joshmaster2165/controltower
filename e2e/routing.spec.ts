import { test, expect } from '@playwright/test';
import { CT, admin, flightById } from './support/admin';
import { routingUpstream, type RoutingUpstream } from './support/routing-upstream';

/**
 * Where a call goes, beyond its model name: tags and customers on every flight (spend by tag and by
 * customer, customers blocked and budgeted), regions a key's data must stay in, deployments reserved for
 * tags, and what happens when a call can't be answered where it first went — retries, busy deployments,
 * prompts too long for the model, content refusals, and fallback models (policy still applies).
 */
test.describe.configure({ mode: 'serial' });

let eu: RoutingUpstream;
let us: RoutingUpstream;
let euId = '';
let usId = '';
const providerIds: string[] = [];
const keys: Record<string, { key: string; id: string }> = {};

async function dep(provider: string, upstream: string, publicName: string | null, caps: Record<string, unknown> = {}): Promise<string> {
  const r = await admin.post('/admin/api/deployments', { provider_id: provider, upstream_model: upstream, public_name: publicName, caps, pricing_override: { input: 1, output: 2 } });
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  return r.body.id;
}
async function alias(name: string, targets: string[], config?: unknown): Promise<void> {
  const r = await admin.post('/admin/api/aliases', { name, strategy: 'priority', targets: targets.map((d, i) => ({ deployment_id: d, priority: i })), config });
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
}
async function key(name: string, extra: Record<string, unknown> = {}): Promise<void> {
  const r = await admin.post('/admin/api/keys', { name, agent_id: name, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  keys[name] = { key: r.body.key, id: r.body.id };
}
async function chat(k: string, model: string, o: { headers?: Record<string, string>; content?: string; body?: Record<string, unknown> } = {}) {
  const r = await fetch(`${CT}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${keys[k]!.key}`, 'content-type': 'application/json', ...(o.headers ?? {}) },
    body: JSON.stringify({ model, max_tokens: 5, messages: [{ role: 'user', content: o.content ?? 'hi' }], ...(o.body ?? {}) }),
  });
  const j = (await r.json().catch(() => ({}))) as any;
  return { status: r.status, text: j.choices?.[0]?.message?.content as string | undefined, code: j.error?.code as string | undefined, message: j.error?.message as string | undefined, flight: r.headers.get('x-ct-flight-id')! };
}

test.beforeAll(async () => {
  [eu, us] = await Promise.all([routingUpstream('eu'), routingUpstream('us')]);
  await admin.signIn();
  for (const [u, region] of [[eu, 'eu-west-1'], [us, 'us-east-1']] as const) {
    const r = await admin.post('/admin/api/providers', { catalog_id: 'custom', name: `Routing ${u.name}`, slug: `rt${u.name}`, base_url: `${u.url}/v1`, credentials: { api_key: 'sk-rt' }, extra: { region } });
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    const p = r.body.provider ?? r.body;
    providerIds.push(p.id);
    if (u === eu) euId = p.id;
    else usId = p.id;
  }
  await key('rt-agent');
});

test.afterAll(async () => {
  for (const id of providerIds) await admin.del(`/admin/api/providers/${id}`);
  await Promise.all([eu?.close(), us?.close()]);
});

test('tags and customers are recorded, spend is broken down by both, and a customer can be blocked or budgeted', async () => {
  await dep(euId, 'ok-a', 'rt-ok');
  const a = await chat('rt-agent', 'rt-ok', { headers: { 'x-ct-tags': 'search, beta', 'x-ct-customer': 'acme' } });
  expect(a.status).toBe(200);
  const fa = await flightById(a.flight);
  expect(JSON.parse(fa.tags)).toEqual(['search', 'beta']);
  expect(fa.customer).toBe('acme');

  // The request's own user field names the customer; metadata.tags are taken out before the provider sees them.
  const g = await chat('rt-agent', 'rt-ok', { body: { user: 'globex', metadata: { tags: ['nightly'], trace: 't-1' } } });
  expect(g.status).toBe(200);
  const fg = await flightById(g.flight);
  expect(fg.customer).toBe('globex');
  expect(JSON.parse(fg.tags)).toEqual(['nightly']);
  expect(eu.bodies.at(-1).metadata).toEqual({ trace: 't-1' });

  const tags = (await admin.get('/admin/api/ledger/tags?window=24h')).body.tags as any[];
  expect(tags.find((t) => t.tag === 'search')).toMatchObject({ requests: 1 });
  expect(tags.find((t) => t.tag === 'search').cost_usd).toBeGreaterThan(0);
  const customers = (await admin.get('/admin/api/customers?window=24h')).body.customers as any[];
  expect(customers.find((c) => c.id === 'acme')).toMatchObject({ requests: 1, blocked: false, agents: 1 });

  expect((await admin.put('/admin/api/customers/acme', { blocked: true, name: 'Acme Corp' })).status).toBe(200);
  const blocked = await chat('rt-agent', 'rt-ok', { headers: { 'x-ct-customer': 'acme' } });
  expect([blocked.status, blocked.code]).toEqual([403, 'customer_blocked']);
  expect((await chat('rt-agent', 'rt-ok', { headers: { 'x-ct-customer': 'globex' } })).status).toBe(200);
  await admin.put('/admin/api/customers/acme', { blocked: false });

  // A budget for one customer: its calls stop at the limit, others carry on.
  expect((await admin.put('/admin/api/budgets/customer/initech', { limit_usd: 0.00003, period: 'monthly', hard: true })).status).toBe(200);
  expect((await chat('rt-agent', 'rt-ok', { headers: { 'x-ct-customer': 'initech' } })).status).toBe(200);
  const over = await chat('rt-agent', 'rt-ok', { headers: { 'x-ct-customer': 'initech' } });
  expect([over.status, over.code]).toEqual([429, 'budget_exceeded']);
  expect((await chat('rt-agent', 'rt-ok', { headers: { 'x-ct-customer': 'globex' } })).status).toBe(200);
  const listed = (await admin.get('/admin/api/customers?window=24h')).body.customers as any[];
  expect(listed.find((c) => c.id === 'initech').budget).toMatchObject({ limit_usd: 0.00003, hard: true });
  await admin.del('/admin/api/budgets/customer/initech');
});

test("a key's data stays in its regions", async () => {
  const usDep = await dep(usId, 'ok-geo', null);
  const euDep = await dep(euId, 'ok-geo', null);
  await alias('rt-geo', [usDep, euDep]);
  await key('rt-eu-agent', { regions: ['eu-*'] });
  await key('rt-ap-agent', { regions: ['ap-*'] });

  expect((await chat('rt-agent', 'rt-geo')).text).toBe('us:ok-geo'); // anywhere: the first choice
  expect((await chat('rt-eu-agent', 'rt-geo')).text).toBe('eu:ok-geo'); // only EU
  expect((await chat('rt-agent', 'rt-geo', { headers: { 'x-ct-region': 'eu-west-1' } })).text).toBe('eu:ok-geo'); // asked for EU
  const wrong = await chat('rt-eu-agent', 'rt-geo', { headers: { 'x-ct-region': 'us-east-1' } });
  expect([wrong.status, wrong.code]).toEqual([403, 'region_not_allowed']);
  const none = await chat('rt-ap-agent', 'rt-geo');
  expect([none.status, none.code]).toEqual([403, 'region_not_available']);
  expect(none.message).toContain('eu-west-1');
  // The key's regions are in the admin API.
  const k = ((await admin.get('/admin/api/keys')).body.keys as any[]).find((x) => x.id === keys['rt-eu-agent']!.id);
  expect(k.regions).toEqual(['eu-*']);
});

test('deployments reserved for tags serve only requests carrying them', async () => {
  const batch = await dep(usId, 'ok-batch', null, { tags: ['batch'] });
  const open = await dep(euId, 'ok-open', null);
  await alias('rt-tagged', [batch, open]);
  expect((await chat('rt-agent', 'rt-tagged')).text).toBe('eu:ok-open');
  expect((await chat('rt-agent', 'rt-tagged', { headers: { 'x-ct-tags': 'batch' } })).text).toBe('us:ok-batch');

  const only = await dep(usId, 'ok-only', 'rt-only-batch', { tags: ['batch'] });
  const refused = await chat('rt-agent', 'rt-only-batch');
  expect([refused.status, refused.code]).toEqual([403, 'no_deployment_for_tags']);
  await admin.patch(`/admin/api/deployments/${only}`, { caps: { tags: ['batch', 'default'] } });
  expect((await chat('rt-agent', 'rt-only-batch')).text).toBe('us:ok-only');
});

test('a prompt too long for the model goes to its context-window fallback — before the call, or after the provider refuses it', async () => {
  await dep(usId, 'ok-big', 'rt-big');
  await dep(euId, 'ok-small', 'rt-small', { context: 20, fallbacks: { context_window: ['rt-big'] } });
  const long = 'x'.repeat(400); // ~100 tokens

  expect((await chat('rt-agent', 'rt-small')).text).toBe('eu:ok-small');
  const before = eu.calls.get('ok-small') ?? 0;
  expect((await chat('rt-agent', 'rt-small', { content: long })).text).toBe('us:ok-big');
  expect(eu.calls.get('ok-small') ?? 0).toBe(before); // never sent where it can't fit

  await dep(euId, 'ok-small2', 'rt-small2', { context: 20 });
  const tooLong = await chat('rt-agent', 'rt-small2', { content: long });
  expect([tooLong.status, tooLong.code]).toEqual([400, 'context_window_exceeded']);
  expect(eu.calls.get('ok-small2') ?? 0).toBe(0);

  // The window isn't known: the provider says so, and the fallback answers.
  await dep(euId, 'ctxerr-x', 'rt-ctxerr', { fallbacks: { context_window: ['rt-big'] } });
  const r = await chat('rt-agent', 'rt-ctxerr', { content: long });
  expect(r.text).toBe('us:ok-big');
  await flightById(r.flight);
  const ev = (await admin.get(`/admin/api/flights/${r.flight}`)).body.events as any[];
  expect(ev.filter((e) => e.t === 'flight.upstream').map((e) => e.error_code ?? e.outcome)).toEqual(['provider_context_window_exceeded', 'ok']);
});

test('a content refusal goes to the content-policy fallback; any other failure to the default fallback', async () => {
  await dep(euId, 'policy-x', 'rt-policy', { fallbacks: { content_policy: ['rt-big'] } });
  expect((await chat('rt-agent', 'rt-policy')).text).toBe('us:ok-big');
  await dep(euId, 'policy-y', 'rt-policy2');
  const refused = await chat('rt-agent', 'rt-policy2');
  expect([refused.status, refused.code]).toEqual([400, 'provider_content_policy']);

  await dep(euId, 'down-d', 'rt-down', { fallbacks: { default: ['rt-big'] } });
  const f = await chat('rt-agent', 'rt-down');
  expect(f.text).toBe('us:ok-big');
  // Priced as the model that answered.
  expect((await flightById(f.flight)).deployment_id).toBeTruthy();
});

test('fallback models are still subject to gates', async () => {
  await dep(euId, 'down-e', 'rt-down2', { fallbacks: { default: ['rt-big'] } });
  const rule = await admin.post('/admin/api/rules', { name: 'rt: no big model', target_kind: 'model', match: { keys: [keys['rt-agent']!.id], models: ['rt-big'] }, effect: 'deny' });
  expect(rule.status).toBeLessThan(300);
  try {
    const r = await chat('rt-agent', 'rt-down2');
    expect(r.status).toBe(502);
    expect(r.code).toBe('provider_error');
  } finally {
    await admin.del(`/admin/api/rules/${rule.body.id ?? rule.body.rule?.id}`);
  }
});

test('retry rules: a rate-limited deployment is tried again before moving on', async () => {
  const d = await dep(euId, 'fail429x2-r', null);
  await alias('rt-retry', [d], { retry: { rate_limited: 2 } });
  expect((await chat('rt-agent', 'rt-retry')).text).toBe('eu:fail429x2-r');
  expect(eu.calls.get('fail429x2-r')).toBe(3);

  await dep(euId, 'fail429x1-n', 'rt-noretry');
  expect((await chat('rt-agent', 'rt-noretry')).status).toBe(429);
  expect(eu.calls.get('fail429x1-n')).toBe(1);

  const bad = await admin.post('/admin/api/aliases', { name: 'rt-bad', targets: [], config: { retry: { rate_limited: 'lots' } } });
  expect(bad.status).toBe(400);
  const listed = ((await admin.get('/admin/api/aliases')).body.aliases as any[]).find((a) => a.name === 'rt-retry');
  expect(listed.config).toEqual({ retry: { rate_limited: 2 } });
});

test("a deployment's own rate and concurrency limits send calls to the next one", async () => {
  const a = await dep(euId, 'ok-lima', null, { rpm: 2 });
  const b = await dep(usId, 'ok-limb', null);
  await alias('rt-lim', [a, b]);
  const where = [];
  for (let i = 0; i < 3; i++) where.push((await chat('rt-agent', 'rt-lim')).text);
  expect(where).toEqual(['eu:ok-lima', 'eu:ok-lima', 'us:ok-limb']);

  await dep(euId, 'ok-solo', 'rt-solo', { rpm: 1 });
  expect((await chat('rt-agent', 'rt-solo')).status).toBe(200);
  const busy = await chat('rt-agent', 'rt-solo');
  expect([busy.status, busy.code]).toEqual([429, 'deployment_busy']);

  const pa = await dep(euId, 'slow-a', null, { max_parallel: 1 });
  const pb = await dep(usId, 'slow-b', null);
  await alias('rt-par', [pa, pb]);
  const both = await Promise.all([chat('rt-agent', 'rt-par'), chat('rt-agent', 'rt-par')]);
  expect(both.map((x) => x.text).sort()).toEqual(['eu:slow-a', 'us:slow-b']);
  // The slot is given back when the call ends.
  expect((await chat('rt-agent', 'rt-par')).text).toBe('eu:slow-a');
});
