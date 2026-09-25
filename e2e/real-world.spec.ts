import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { SpanKind } from '@opentelemetry/api';
import { ClientFactory, ClientFactoryOptions, DefaultAgentCardResolver, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import { Role } from '@a2a-js/sdk';
import { a2aSdkAgent, a2aUpstream, anthropicUpstream, mcpUpstream, openAiUpstream, subAgentUpstream, webhookReceiver, type Upstream } from './support/upstreams';
import { field } from './support/ui';
import { smtpCapture } from './support/smtp';

/**
 * Everything the demo shows, done for real: no demo mode, no demo code.
 * Agents are the official OpenAI, Anthropic and MCP SDKs and an OpenTelemetry
 * exporter; upstreams speak the real wire protocols (the MCP server is the
 * official SDK's); a human approves through the admin API; alerts go to a
 * webhook receiver that verifies the signature.
 */
test.describe.configure({ mode: 'serial' });

const CT = 'http://127.0.0.1:4400';
const EMAIL = 'e2e@example.com';
const PASSWORD = 'e2e-password-123';

// ---- a tiny admin client (session cookie + CSRF) ----
const admin = {
  cookie: '',
  csrf: '',
  async signIn() {
    await fetch(`${CT}/admin/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
    const r = await fetch(`${CT}/admin/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
    expect(r.status).toBe(200);
    this.cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    this.csrf = ((await r.json()) as { csrf: string }).csrf;
  },
  async call<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const r = await fetch(`${CT}${path}`, {
      method,
      headers: { cookie: this.cookie, 'x-ct-csrf': this.csrf, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* text body (metrics, csv, md) */
    }
    return { status: r.status, body: parsed as T };
  },
  get<T = any>(path: string) {
    return this.call<T>('GET', path);
  },
  post<T = any>(path: string, body: unknown = {}) {
    return this.call<T>('POST', path, body);
  },
};

async function key(name: string, extra: Record<string, unknown> = {}): Promise<{ id: string; key: string }> {
  const r = await admin.post('/admin/api/keys', { name, team: 'real-world', ...extra });
  expect(r.status).toBe(201);
  return r.body;
}

/** Flights are written in 50 ms batches; wait until the predicate holds. */
async function flightsFor(keyId: string, predicate: (f: any[]) => boolean = (f) => f.length > 0): Promise<any[]> {
  let last: any[] = [];
  await expect
    .poll(async () => {
      last = (await admin.get(`/admin/api/flights?key_id=${keyId}&limit=50`)).body.flights ?? [];
      return predicate(last);
    })
    .toBe(true);
  return last;
}

const upstreams: Upstream[] = [];
test.afterAll(async () => {
  await Promise.all(upstreams.map((u) => u.close()));
});
test.beforeAll(async () => {
  await admin.signIn();
});

// ---------------------------------------------------------------- models
let oai: Upstream;
let oaiAgent: { id: string; key: string };

test('OpenAI SDK → Control Tower → OpenAI-compatible provider: chat, streaming, embeddings, models added on first use', async () => {
  oai = await openAiUpstream();
  upstreams.push(oai);
  const prov = await admin.post('/admin/api/providers', { catalog_id: 'custom', name: 'Upstream OpenAI', slug: 'upstream-oai', base_url: `${oai.url}/v1`, credentials: { api_key: 'sk-upstream-secret' } });
  expect(prov.status).toBe(201);
  oaiAgent = await key('rw-openai-agent');

  const client = new OpenAI({ baseURL: `${CT}/v1`, apiKey: oaiAgent.key });
  const chat = await client.chat.completions.create({ model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'hi' }] });
  expect(chat.choices[0]!.message.content).toBe('Hello from the OpenAI-compatible upstream');
  expect(chat.usage?.total_tokens).toBe(20);

  let text = '';
  const stream = await client.chat.completions.create({ model: 'gpt-4.1-mini', stream: true, messages: [{ role: 'user', content: 'hi' }] });
  for await (const c of stream) text += c.choices[0]?.delta?.content ?? '';
  expect(text.trim()).toBe('Hello from the OpenAI-compatible upstream');

  const emb = await client.embeddings.create({ model: 'text-embedding-3-small', input: 'hello' });
  expect(emb.data[0]!.embedding).toHaveLength(3);

  // The upstream got the provider's credential, never the agent's key.
  const chatCalls = oai.calls.filter((c) => c.path.includes('/chat/completions') || c.path.includes('/embeddings'));
  expect(chatCalls.length).toBeGreaterThanOrEqual(3);
  for (const c of chatCalls) expect(c.headers.authorization).toBe('Bearer sk-upstream-secret');
  expect(JSON.stringify(oai.calls)).not.toContain(oaiAgent.key);

  // Recorded as flights with usage and a real price.
  const flights = await flightsFor(oaiAgent.id, (f) => f.filter((x) => x.status === 'ok').length >= 3);
  const chatFlight = flights.find((f) => f.model_requested === 'gpt-4.1-mini' && f.status === 'ok');
  expect(chatFlight.in_tokens).toBe(12);
  expect(chatFlight.cost_nanousd).toBeGreaterThan(0);
});

test('Anthropic SDK (and Claude Code’s path) → /v1/messages → Anthropic, plus an OpenAI SDK call translated to Anthropic', async () => {
  const ant = await anthropicUpstream();
  upstreams.push(ant);
  const prov = await admin.post('/admin/api/providers', { catalog_id: 'anthropic', base_url: ant.url, credentials: { api_key: 'sk-ant-upstream-secret' } });
  expect(prov.status).toBe(201);
  const agent = await key('rw-claude-agent');

  const client = new Anthropic({ baseURL: CT, apiKey: agent.key });
  const msg = await client.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] });
  expect(msg.content[0]).toMatchObject({ type: 'text', text: 'Hello from the Anthropic upstream' });

  let streamed = '';
  const s = client.messages.stream({ model: 'claude-sonnet-4-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] });
  s.on('text', (t) => (streamed += t));
  const final = await s.finalMessage();
  expect(streamed.trim()).toBe('Hello from the Anthropic upstream');
  expect(final.usage.output_tokens).toBe(9);

  // Claude Desktop's gateway mode lists models the Anthropic way (here with the x-api-key scheme the SDK uses).
  const listed: string[] = [];
  for await (const m of client.models.list()) listed.push(m.id);
  expect(listed).toContain('claude-sonnet-4-5');

  // OpenAI dialect in, Anthropic out: translated both ways.
  const viaOpenAi = await new OpenAI({ baseURL: `${CT}/v1`, apiKey: agent.key }).chat.completions.create({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }] });
  expect(viaOpenAi.choices[0]!.message.content).toBe('Hello from the Anthropic upstream');

  const msgCalls = ant.calls.filter((c) => c.path.endsWith('/v1/messages'));
  expect(msgCalls.length).toBe(3);
  for (const c of msgCalls) expect(c.headers['x-api-key']).toBe('sk-ant-upstream-secret');
  expect(JSON.stringify(ant.calls)).not.toContain(agent.key);
  const flights = await flightsFor(agent.id, (f) => f.filter((x) => x.status === 'ok').length >= 3);
  expect(flights.every((f) => f.cost_nanousd > 0)).toBe(true);
});

test('OpenAI Responses API (Agents SDK, Codex) → /v1/responses → OpenAI-compatible provider, JSON and streaming', async () => {
  const agent = await key('rw-responses-agent');
  const client = new OpenAI({ baseURL: `${CT}/v1`, apiKey: agent.key });

  const r = await client.responses.create({ model: 'gpt-4.1-mini', instructions: 'Be brief.', input: 'hi' });
  expect(r.output_text).toBe('Hello from the OpenAI-compatible upstream');
  expect(r.usage?.input_tokens).toBe(21);

  let text = '';
  let completed = false;
  const stream = await client.responses.create({ model: 'gpt-4.1-mini', input: [{ role: 'user', content: 'hi' }], stream: true });
  for await (const ev of stream) {
    if (ev.type === 'response.output_text.delta') text += ev.delta;
    if (ev.type === 'response.completed') completed = true;
  }
  expect(text.trim()).toBe('Hello from the OpenAI-compatible upstream');
  expect(completed).toBe(true);

  // Forwarded as a Responses call with the provider's credential; no chat-only fields added.
  const calls = oai.calls.filter((c) => c.path.endsWith('/v1/responses'));
  expect(calls).toHaveLength(2);
  for (const c of calls) {
    expect(c.headers.authorization).toBe('Bearer sk-upstream-secret');
    expect(JSON.parse(c.body)).not.toHaveProperty('stream_options');
  }

  // Recorded as responses flights, with the provider's usage (cached tokens split out) and a price.
  const flights = await flightsFor(agent.id, (f) => f.filter((x) => x.status === 'ok').length >= 2);
  const ok = flights.filter((f) => f.status === 'ok');
  expect(ok.every((f) => f.kind === 'responses')).toBe(true);
  expect(ok.every((f) => f.in_tokens === 16 && f.out_tokens === 9 && f.usage_source === 'provider')).toBe(true);
  expect(ok.every((f) => f.cost_nanousd > 0)).toBe(true);

  // A model on a provider without a Responses API (here Anthropic): translated through Chat Completions and back,
  // so Codex and the Agents SDK can use any model — JSON and streamed.
  const viaChat = await client.responses.create({ model: 'claude-sonnet-4-5', instructions: 'Be brief.', input: 'hi' });
  expect(viaChat.output_text).toBe('Hello from the Anthropic upstream');
  expect(viaChat.usage?.output_tokens).toBeGreaterThan(0);
  let streamed = '';
  let finished: { status: string; output: unknown[] } | undefined;
  for await (const ev of await client.responses.create({ model: 'claude-sonnet-4-5', input: 'hi', stream: true })) {
    if (ev.type === 'response.output_text.delta') streamed += ev.delta;
    if (ev.type === 'response.completed') finished = ev.response as unknown as { status: string; output: unknown[] };
  }
  expect(streamed.trim()).toBe('Hello from the Anthropic upstream');
  expect(finished?.status).toBe('completed');
  expect(finished?.output).toHaveLength(1);
});

test('Team budgets: count what the team already spent, cover keys added later, lift when removed', async () => {
  const first = await key('rw-budget-first', { team: 'budget-team' });
  const other = await key('rw-budget-other-team', { team: 'another-team' });
  const chat = (k: string) =>
    fetch(`${CT}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${k}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'hi' }] }) });
  expect((await chat(first.key)).status).toBe(200);
  await flightsFor(first.id, (f) => f.some((x) => x.status === 'ok' && x.cost_nanousd > 0));

  // A budget below what the team has already spent this month.
  const put = await admin.call('PUT', '/admin/api/budgets/team/budget-team', { limit_usd: 0.00001, period: 'monthly' });
  expect(put.status).toBe(200);
  expect(put.body.spent_usd).toBeGreaterThan(0.00001);

  const refused = await chat(first.key);
  expect(refused.status).toBe(429);
  expect((await refused.json()).error.code).toBe('budget_exceeded');
  const joinedLater = await key('rw-budget-joined-later', { team: 'budget-team' });
  expect((await chat(joinedLater.key)).status).toBe(429);
  expect((await chat(other.key)).status).toBe(200);

  const list = (await admin.get('/admin/api/budgets')).body;
  expect(list.budgets.find((b: { scope_type: string; scope_id: string }) => b.scope_type === 'team' && b.scope_id === 'budget-team')).toMatchObject({ keys: 2, period: 'monthly', hard: true });
  expect(list.teams).toEqual(expect.arrayContaining(['budget-team', 'another-team']));

  expect((await admin.call('DELETE', '/admin/api/budgets/team/budget-team')).status).toBe(200);
  expect((await chat(first.key)).status).toBe(200);
});

test('Fallback: an alias skips a rate-limited deployment and answers from the next one', async () => {
  const flaky = await openAiUpstream({ rateLimited: true });
  const steady = await openAiUpstream({ reply: 'Hello from the steady upstream' });
  upstreams.push(flaky, steady);
  const p1 = (await admin.post('/admin/api/providers', { catalog_id: 'custom', name: 'Flaky', slug: 'flaky', base_url: `${flaky.url}/v1` })).body.provider.id;
  const p2 = (await admin.post('/admin/api/providers', { catalog_id: 'custom', name: 'Steady', slug: 'steady', base_url: `${steady.url}/v1` })).body.provider.id;
  const d1 = (await admin.post('/admin/api/deployments', { provider_id: p1, upstream_model: 'gpt-4.1-mini', public_name: 'flaky-gpt' })).body.id;
  const d2 = (await admin.post('/admin/api/deployments', { provider_id: p2, upstream_model: 'gpt-4.1-mini', public_name: 'steady-gpt' })).body.id;
  expect((await admin.post('/admin/api/aliases', { name: 'house-model', targets: [{ deployment_id: d1 }, { deployment_id: d2 }] })).status).toBe(201);

  const r = await new OpenAI({ baseURL: `${CT}/v1`, apiKey: oaiAgent.key }).chat.completions.create({ model: 'house-model', messages: [{ role: 'user', content: 'hi' }] });
  expect(r.choices[0]!.message.content).toBe('Hello from the steady upstream');
  expect(flaky.calls.some((c) => c.path.endsWith('/chat/completions'))).toBe(true);
  expect(steady.calls.some((c) => c.path.endsWith('/chat/completions'))).toBe(true);
});

test('Routing: weighted aliases keep fallbacks for failures; least-cost goes to the cheaper model', async () => {
  const primaryA = await openAiUpstream({ reply: 'primary A' });
  const primaryB = await openAiUpstream({ reply: 'primary B' });
  const backup = await openAiUpstream({ reply: 'backup' });
  upstreams.push(primaryA, primaryB, backup);
  const prov = async (slug: string, u: Upstream) => (await admin.post('/admin/api/providers', { catalog_id: 'custom', name: slug, slug, base_url: `${u.url}/v1` })).body.provider.id as string;
  const dep = async (provider_id: string, public_name: string, upstream_model = 'gpt-4.1-mini') => (await admin.post('/admin/api/deployments', { provider_id, upstream_model, public_name })).body.id as string;
  const a = await dep(await prov('route-a', primaryA), 'route-a');
  const b = await dep(await prov('route-b', primaryB), 'route-b');
  const c = await dep(await prov('route-backup', backup), 'route-backup');
  // Two primaries share the load; the backup, a later priority, is only a fallback.
  expect((await admin.post('/admin/api/aliases', { name: 'shared-model', strategy: 'weighted', targets: [{ deployment_id: a, priority: 0, weight: 50 }, { deployment_id: b, priority: 0, weight: 50 }, { deployment_id: c, priority: 1, weight: 100 }] })).status).toBe(201);
  const client = new OpenAI({ baseURL: `${CT}/v1`, apiKey: oaiAgent.key, maxRetries: 0 });
  const answers = new Set<string>();
  for (let i = 0; i < 16; i++) answers.add((await client.chat.completions.create({ model: 'shared-model', messages: [{ role: 'user', content: 'hi' }] })).choices[0]!.message.content ?? '');
  expect(answers.has('backup')).toBe(false);
  expect([...answers].sort()).toEqual(['primary A', 'primary B']);

  // Least cost: the cheaper model answers, whatever the order it was added in.
  const pricey = await dep(await prov('route-pricey', primaryA), 'route-pricey', 'gpt-4.1');
  const cheap = await dep(await prov('route-cheap', primaryB), 'route-cheap', 'gpt-4.1-nano');
  expect((await admin.post('/admin/api/aliases', { name: 'thrifty-model', strategy: 'least-cost', targets: [{ deployment_id: pricey }, { deployment_id: cheap }] })).status).toBe(201);
  expect((await client.chat.completions.create({ model: 'thrifty-model', messages: [{ role: 'user', content: 'hi' }] })).choices[0]!.message.content).toBe('primary B');
});

test('Limits: a rate limit and a hard budget stop an agent', async () => {
  const limited = await key('rw-rate-limited', { limits: { rpm: 2 } });
  const client = new OpenAI({ baseURL: `${CT}/v1`, apiKey: limited.key, maxRetries: 0 });
  await client.chat.completions.create({ model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'a' }] });
  await client.chat.completions.create({ model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'b' }] });
  const third = await client.chat.completions.create({ model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'c' }] }).catch((e: unknown) => e as { status: number; code?: string });
  expect(third).toMatchObject({ status: 429, code: 'rate_limit_exceeded' });

  // A priced deployment: $1000 per million tokens, so each call costs $0.02.
  const prov = (await admin.get('/admin/api/topology')).body.providers.find((p: { slug: string }) => p.slug === 'upstream-oai').id;
  await admin.post('/admin/api/deployments', { provider_id: prov, upstream_model: 'gpt-4.1-mini', public_name: 'pricey-gpt', pricing_override: { input: 1000, output: 1000 } });
  const budgeted = await key('rw-budgeted', { budget: { limit_usd: 0.025, period: 'monthly', hard: true } });
  const b = new OpenAI({ baseURL: `${CT}/v1`, apiKey: budgeted.key, maxRetries: 0 });
  await b.chat.completions.create({ model: 'pricey-gpt', max_tokens: 5, messages: [{ role: 'user', content: 'a' }] });
  const over = await b.chat.completions.create({ model: 'pricey-gpt', max_tokens: 5, messages: [{ role: 'user', content: 'b' }] }).catch((e: unknown) => e as { status: number; code?: string });
  expect(over).toMatchObject({ status: 429, code: 'budget_exceeded' });
});

test('Zones: a gate drawn between two zones blocks only the agents inside them', async () => {
  const intern = await key('rw-sandbox-intern');
  const deps = (await admin.get('/admin/api/topology')).body.deployments as Array<{ id: string; public_name?: string }>;
  const pricey = deps.find((d) => d.public_name === 'pricey-gpt')!;
  const from = (await admin.post('/admin/api/zones', { name: 'Sandbox', stations: [`key:${intern.id}`] })).body.id;
  const to = (await admin.post('/admin/api/zones', { name: 'Expensive models', stations: [`deployment:${pricey.id}`] })).body.id;
  expect((await admin.post('/admin/api/rules', { name: 'Sandbox may not use expensive models', from_zone: from, to_zone: to, effect: 'deny', config: { reason: 'Use the cheap tier in the sandbox' }, priority: 5 })).status).toBe(201);

  const blocked = await new OpenAI({ baseURL: `${CT}/v1`, apiKey: intern.key, maxRetries: 0 })
    .chat.completions.create({ model: 'pricey-gpt', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] })
    .catch((e: unknown) => e as { status: number; code?: string; message?: string });
  expect(blocked).toMatchObject({ status: 403, code: 'policy_denied' });
  // Outside the zone, the same model still works; inside it, other models still work.
  const other = await new OpenAI({ baseURL: `${CT}/v1`, apiKey: intern.key }).chat.completions.create({ model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'hi' }] });
  expect(other.choices[0]!.message.content).toBeTruthy();
});

test('Agent groups: a gate or zone on an agent covers every copy of it, and nothing else', async ({ page }) => {
  // Two copies of one agent (same agent id, a key each) and a different agent.
  const copies = [await key('rw-worker-1', { agent_id: 'rw-worker' }), await key('rw-worker-2', { agent_id: 'rw-worker' })];
  const other = await key('rw-other-agent', { agent_id: 'rw-other' });
  const chat = (k: string) =>
    fetch(`${CT}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${k}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4.1-mini', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }) });

  const gate = await admin.post('/admin/api/rules', { name: 'Workers may not use mini', effect: 'deny', target_kind: 'model', match: { groups: ['rw-worker'], models: ['gpt-4.1-mini'] }, priority: 5 });
  expect(gate.status).toBe(201);
  expect((await chat(copies[0]!.key)).status).toBe(403);
  expect((await chat(copies[1]!.key)).status).toBe(403);
  expect((await chat(other.key)).status).toBe(200);
  // A copy added later is covered too.
  const third = await key('rw-worker-3', { agent_id: 'rw-worker' });
  expect((await chat(third.key)).status).toBe(403);

  // Zones hold a group as one member; policy as code refers to it as group:<agent id>.
  const zone = (await admin.post('/admin/api/zones', { name: 'Workers', stations: ['group:rw-worker'] })).body.id;
  const yamlText = (await admin.get<string>('/admin/api/policy/export')).body;
  expect(yamlText).toContain('group:rw-worker');
  expect(yamlText).toMatch(/groups:\s*\n\s*- rw-worker/);
  const bad = await admin.post('/admin/api/policy/import', { yaml: 'gates:\n  - name: Typo\n    match: { groups: [no-such-agent] }\n    effect: deny\n', mode: 'merge' });
  expect(bad.body.errors.join(' ')).toContain('no keys carry the agent id "no-such-agent"');

  expect((await admin.call('DELETE', `/admin/api/rules/${gate.body.id}`)).status).toBeLessThan(300);
  expect((await admin.call('DELETE', `/admin/api/zones/${zone}`)).status).toBeLessThan(300);
  expect((await chat(copies[0]!.key)).status).toBe(200);

  // The map draws the three copies as one station.
  await page.goto(`${CT}/`);
  await field(page, /^Email/).fill(EMAIL);
  await field(page, /^Password/).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const station = () =>
    page.evaluate(() => {
      const s = (window as unknown as { __ctScene?: { stations: Map<string, { id: string; label: string; copies?: number }> } }).__ctScene;
      const all = [...(s?.stations.values() ?? [])];
      return { group: all.find((x) => x.id === 'group:rw-worker')?.copies ?? 0, copiesDrawnAlone: all.filter((x) => /^rw-worker-/.test(x.label)).length };
    });
  await expect.poll(station).toEqual({ group: 3, copiesDrawnAlone: 0 });

  // Teams: a second team makes the Teams view available; each team is one station until opened.
  await key('rw-ops-agent', { team: 'rw-ops' });
  await key('rw-ops-helper', { team: 'rw-ops' });
  type Scene = { stations: Map<string, { id: string; x: number; y: number; w: number; headH: number }>; getCamera(): { x: number; y: number; k: number }; canvas: HTMLCanvasElement; focusId: string | null };
  const agentStations = () =>
    page.evaluate(() => {
      const s = (window as unknown as { __ctScene?: Scene }).__ctScene;
      return [...(s?.stations.values() ?? [])].map((x) => x.id).filter((id) => id.startsWith('team:') || id.startsWith('group:'));
    });
  await page.getByRole('radio', { name: 'Teams' }).click();
  await expect.poll(agentStations).toEqual(expect.arrayContaining(['team:real-world', 'team:rw-ops']));
  expect(await agentStations()).not.toContain('group:rw-worker');

  // Open the team from its arrow: its agents, the worker group among them, come back.
  const arrow = await page.evaluate(() => {
    const s = (window as unknown as { __ctScene: Scene }).__ctScene;
    const st = s.stations.get('team:real-world')!;
    const c = s.getCamera();
    const r = s.canvas.getBoundingClientRect();
    return [(st.x + st.w - 13) * c.k + c.x + r.left, (st.y + st.headH / 2) * c.k + c.y + r.top] as const;
  });
  await page.mouse.click(arrow[0], arrow[1]);
  await expect.poll(agentStations).toContain('group:rw-worker');
  expect(await agentStations()).not.toContain('team:real-world');

  // Search finds an agent folded into a closed team, opens the team and traces the agent.
  await page.getByRole('radio', { name: 'Teams' }).click(); // back to every team closed
  await expect.poll(agentStations).toContain('team:real-world');
  await page.keyboard.press('/');
  await page.keyboard.type('rw-work');
  await expect(page.getByRole('option').first()).toContainText('rw-worker');
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __ctScene: Scene }).__ctScene.focusId)).toBe('group:rw-worker');
  await expect(page.locator('.focus-panel, .focus')).toContainText('rw-worker');

  // A gate drawn on a team covers its keys only; policy files name it team:<name> and match.teams.
  const opsKey = await key('rw-ops-third', { team: 'rw-ops' });
  const teamGate = await admin.post('/admin/api/rules', { name: 'Ops may not use mini', effect: 'deny', target_kind: 'model', match: { teams: ['rw-ops'], models: ['gpt-4.1-mini'] }, priority: 5 });
  expect(teamGate.status).toBe(201);
  expect((await chat(opsKey.key)).status).toBe(403);
  expect((await chat(other.key)).status).toBe(200);
  const opsZone = (await admin.post('/admin/api/zones', { name: 'Ops', stations: ['team:rw-ops'] })).body.id;
  const policyYaml = (await admin.get<string>('/admin/api/policy/export')).body;
  expect(policyYaml).toContain('team:rw-ops');
  expect(policyYaml).toMatch(/teams:\s*\n\s*- rw-ops/);
  await admin.call('DELETE', `/admin/api/rules/${teamGate.body.id}`);
  await admin.call('DELETE', `/admin/api/zones/${opsZone}`);
  expect((await chat(opsKey.key)).status).toBe(200);

  // Views: one part of the organization on a map of its own, a link under Airspace.
  const opsView = await admin.post('/admin/api/airspace/views', { name: 'Ops', teams: ['rw-ops'] });
  expect(opsView.status).toBe(201);
  expect((await admin.post('/admin/api/airspace/views', { name: 'ops', teams: ['real-world'] })).status).toBe(400);
  expect((await admin.get('/admin/api/topology')).body.views.map((v: { name: string }) => v.name)).toContain('Ops');
  await page.reload();
  await page.getByRole('link', { name: 'Ops', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/airspace/${opsView.body.id}$`));
  const drawnAgents = () =>
    page.evaluate(() => {
      const s = (window as unknown as { __ctScene?: { stations: Map<string, { kind: string; label: string }> } }).__ctScene;
      return [...(s?.stations.values() ?? [])].filter((x) => x.kind === 'agent').map((x) => x.label).sort();
    });
  await expect.poll(drawnAgents).toEqual(['rw-ops-agent', 'rw-ops-helper', 'rw-ops-third']);
  await expect(page.locator('.view-seg')).toContainText('Ops');
  // Leaving the view brings the whole organization back.
  await page.getByRole('button', { name: 'Leave view' }).click();
  await expect.poll(async () => (await drawnAgents()).length).toBeGreaterThan(3);
  expect((await admin.call('DELETE', `/admin/api/airspace/views/${opsView.body.id}`)).status).toBe(200);

  // Attention: what needs a person on this map, and the busiest stations right now.
  await page.getByRole('button', { name: 'Attention' }).click();
  await expect(page.locator('.attention-panel')).toContainText('Needs attention');
  await page.locator('.attention-panel').getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('.attention-panel')).toHaveCount(0);

  // Matrix: every agent against every destination; a cell opens the gate editor for that path.
  await page.getByRole('radio', { name: 'Matrix' }).click();
  await page.getByRole('radio', { name: 'Agents' }).click();
  const workerRow = page.locator('table.matrix tr', { has: page.locator('.row-name', { hasText: /^rw-worker/ }) });
  await expect(workerRow).toHaveCount(1);
  await expect(page.locator('.matrix-summary')).toContainText('no gate can stop');
  await workerRow.locator('td.cell.used').first().click();
  await expect(page.locator('.popover.composer')).toContainText('rw-worker (every copy)');
  await page.locator('.popover.composer').getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('radio', { name: 'Map' }).click();
  await expect(page.locator('table.matrix')).toHaveCount(0);
});

test('Agents calling agents: an agent behind a tool, delegation tokens passed on, on-behalf-of gates', async () => {
  // research-agent: exposed as an MCP tool. Its tool asks a model through Control Tower with its own key,
  // passing on the delegation token it was called with. Its key acts only on behalf of other agents.
  const research = await key('rw-research-agent', { agent_id: 'rw-research', team: 'research', delegated_only: true });
  const tokens: Array<string | undefined> = [];
  const ask = (token: string | undefined, body = { model: 'gpt-4.1-mini', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }) =>
    fetch(`${CT}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${research.key}`, 'content-type': 'application/json', ...(token ? { 'x-ct-delegation': token } : {}) }, body: JSON.stringify(body) });
  const sub = await subAgentUpstream(async (_question, token) => {
    tokens.push(token);
    return String((await ask(token)).status);
  });
  upstreams.push(sub);
  const reg = await admin.post('/admin/api/mcp/servers', { name: 'Research agent', slug: 'research', url: `${sub.url}/mcp`, agent_id: 'rw-research' });
  expect(reg.status).toBe(201);
  expect(reg.body.server.agent_id).toBe('rw-research');

  // support-bot calls the research agent's tool: the research agent's own model call runs on its behalf.
  const bot = await key('rw-support-bot', { agent_id: 'rw-support-bot', team: 'support' });
  const client = await mcpClient(bot.key);
  expect(textOf(await client.callTool({ name: 'research__ask', arguments: { question: 'What is the refund policy?' } }))).toBe('200');
  expect(tokens[0]).toMatch(/^ctd1\./);
  const own = await flightsFor(research.id);
  expect(JSON.parse(own[0].on_behalf_of)).toEqual(['rw-support-bot']);

  // Delegated-only: without its token the research agent can't act; another agent can't use its token.
  const bare = await ask(undefined);
  expect(bare.status).toBe(403);
  expect(((await bare.json()) as { error: { code: string } }).error.code).toBe('delegation_required');
  // Refused, and still recorded.
  const bareId = bare.headers.get('x-ct-flight-id')!;
  await expect.poll(async () => (await admin.get(`/admin/api/flights/${bareId}`)).body.flight?.status).toBe('rejected');

  // Each call links to the call that led to it; a trace shows the whole chain, and calls can be listed by whom they were for.
  const botCall = (await flightsFor(bot.id)).find((f) => f.kind === 'mcp.tool')!;
  expect(own[0].parent_flight_id).toBe(botCall.id);
  const traced = (await admin.get(`/admin/api/flights?trace=${own[0].id}`)).body.flights as Array<{ id: string; has_children: number }>;
  expect(traced.map((f) => f.id).sort()).toEqual([botCall.id, own[0].id].sort());
  expect(traced.find((f) => f.id === botCall.id)!.has_children).toBe(1);
  const forBot = (await admin.get('/admin/api/flights?for=rw-support-bot')).body.flights as Array<{ key_id: string }>;
  expect(forBot.length).toBeGreaterThan(0);
  expect(forBot.every((f) => f.key_id === research.id)).toBe(true);
  // The arc on the map: support-bot's calls to the research agent, what each led to, and what was done for it.
  const arc = (await admin.get(`/admin/api/airspace/agent-link?from=${bot.id}&to=${research.id}`)).body;
  expect(arc.calls[0]).toMatchObject({ id: botCall.id, model_requested: 'research__ask', led_to: 1 });
  expect(arc.on_behalf.count).toBeGreaterThan(0);
  expect(arc.from_agents).toEqual(['rw-support-bot']);
  const stolen = await fetch(`${CT}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${oaiAgent.key}`, 'content-type': 'application/json', 'x-ct-delegation': tokens[0]! }, body: JSON.stringify({ model: 'gpt-4.1-mini', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }) });
  expect(stolen.status).toBe(200);
  expect((await flightsFor(oaiAgent.id))[0].on_behalf_of).toBeNull(); // not issued to it: counted as its own call

  // A gate on whom a call is for: nothing on behalf of team support may use gpt-4.1-mini, however many agents deep.
  const gate = await admin.post('/admin/api/rules', { name: 'Not for support, via any agent', effect: 'deny', target_kind: 'model', match: { on_behalf_of: ['team:support'], models: ['gpt-4.1-mini'] }, priority: 5 });
  expect(gate.status).toBe(201);
  expect(textOf(await client.callTool({ name: 'research__ask', arguments: { question: 'again' } }))).toBe('403');
  const yamlText = (await admin.get<string>('/admin/api/policy/export')).body;
  expect(yamlText).toMatch(/on_behalf_of:\s*\n\s*- team:support/);
  await admin.call('DELETE', `/admin/api/rules/${gate.body.id}`);
  expect(textOf(await client.callTool({ name: 'research__ask', arguments: { question: 'and again' } }))).toBe('200');
  await client.close();

  // The map knows: the research server fronts an agent, and support-bot delegated to it.
  const topo = (await admin.get('/admin/api/topology')).body;
  expect(topo.mcp_servers.find((s: { slug: string }) => s.slug === 'research').agent_id).toBe('rw-research');
  expect(topo.delegations).toEqual(expect.arrayContaining([expect.objectContaining({ from: 'rw-support-bot', key_id: research.id })]));
});

test('A2A: a remote agent behind Control Tower — its card, messages, streams, gates and delegation', async () => {
  // The research agent is a remote A2A 1.0 agent. Its own key acts only on behalf of other agents.
  const research = await key('rw-a2a-research', { agent_id: 'rw-a2a-research', delegated_only: true });
  const remote = await a2aUpstream({ version: '1.0', token: 'agent-secret' });
  upstreams.push(remote);
  const reg = await admin.post('/admin/api/a2a/agents', { name: 'Research agent', slug: 'researcher', url: remote.url, auth: { type: 'bearer', token: 'agent-secret' }, agent_id: 'rw-a2a-research' });
  expect(reg.status).toBe(201);
  expect(reg.body.check.ok).toBe(true);
  expect(reg.body.agent).toMatchObject({ protocol_version: '1.0', endpoint: `${remote.url}/rpc`, agent_id: 'rw-a2a-research', skills: [{ id: 'research', name: 'Research' }] });
  expect((await admin.post('/admin/api/a2a/agents', { name: 'Research', slug: 'researcher', url: remote.url })).status).toBe(409);

  const caller = await key('rw-a2a-caller', { agent_id: 'rw-a2a-caller', team: 'support' });
  const auth = { authorization: `Bearer ${caller.key}` };
  const rpc = (method: string, params: unknown, headers: Record<string, string> = auth, slug = 'researcher') =>
    fetch(`${CT}/a2a/${slug}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'a2a-version': '1.0' }, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }) });
  const message = (text: string) => ({ message: { messageId: crypto.randomUUID(), role: 'ROLE_USER', parts: [{ text }] } });

  // The card Control Tower publishes points at Control Tower and asks for a Control Tower key.
  expect((await fetch(`${CT}/a2a/researcher/.well-known/agent-card.json`)).status).toBe(401);
  const card = (await (await fetch(`${CT}/a2a/researcher/.well-known/agent-card.json`, { headers: auth })).json()) as any;
  expect(card.supportedInterfaces).toEqual([{ url: `${CT}/a2a/researcher`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }]);
  expect(card.securitySchemes).toEqual({ controltower: { httpAuthSecurityScheme: expect.objectContaining({ scheme: 'Bearer' }) } });
  expect(card.signatures).toBeUndefined();
  expect(card.skills[0].id).toBe('research');
  expect(JSON.stringify(card)).not.toContain(remote.url);
  expect((await fetch(`${CT}/a2a/researcher/.well-known/agent.json`, { headers: auth })).status).toBe(200);
  const listed = (await (await fetch(`${CT}/a2a`, { headers: auth })).json()) as any;
  expect(listed.agents.map((a: { slug: string }) => a.slug)).toContain('researcher');

  // SendMessage reaches the agent with the agent's credentials — never the caller's key — and a delegation token.
  const sent = await rpc('SendMessage', message('What is our refund policy?'));
  expect(sent.status).toBe(200);
  expect(sent.headers.get('x-ct-flight-id')).toBeTruthy();
  const task = ((await sent.json()) as any).result.task;
  expect(task.status.state).toBe('TASK_STATE_COMPLETED');
  expect(task.artifacts[0].parts[0].text).toBe('echo: What is our refund policy?');
  const call = remote.calls.find((c) => c.path === '/rpc')!;
  expect(call.headers.authorization).toBe('Bearer agent-secret');
  expect(JSON.stringify(call.headers)).not.toContain(caller.key);
  const token = String(call.headers['x-ct-delegation']);
  expect(token).toMatch(/^ctd1\./);
  const upstreamBody = JSON.parse(call.body);
  expect(upstreamBody).toMatchObject({ jsonrpc: '2.0', id: 7, method: 'SendMessage' });
  expect(upstreamBody.params.metadata['controltower/delegation']).toBe(token);
  expect(call.headers['a2a-version']).toBe('1.0');

  // The agent passes the token on with its own model call: that call is made on the caller's behalf.
  const own = await fetch(`${CT}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${research.key}`, 'content-type': 'application/json', 'x-ct-delegation': token }, body: JSON.stringify({ model: 'gpt-4.1-mini', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }) });
  expect(own.status).toBe(200);
  expect(JSON.parse((await flightsFor(research.id))[0].on_behalf_of)).toEqual(['rw-a2a-caller']);

  // Reads, streams and the extended card.
  const got = (await (await rpc('GetTask', { id: task.id })).json()) as any;
  expect(got.result.id).toBe(task.id);
  const stream = await rpc('SendStreamingMessage', message('stream it'));
  expect(stream.headers.get('content-type')).toContain('text/event-stream');
  const events = (await stream.text()).split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)).result);
  expect(events.map((e) => Object.keys(e)[0])).toEqual(['task', 'artifactUpdate', 'statusUpdate']);
  expect(events[1].artifactUpdate.artifact.parts[0].text).toBe('echo: stream it');
  const extended = (await (await rpc('GetExtendedAgentCard', {})).json()) as any;
  expect(extended.result.description).toBe('The extended card');
  expect(extended.result.supportedInterfaces[0].url).toBe(`${CT}/a2a/researcher`);

  // Every call is a flight, named for the agent and method.
  const flights = await flightsFor(caller.id, (f) => f.length >= 4);
  expect(flights.every((f) => f.kind === 'a2a.call' && f.mcp_server_id === reg.body.agent.id)).toBe(true);
  expect(flights.map((f) => f.tool).sort()).toEqual(['GetExtendedAgentCard', 'GetTask', 'SendMessage', 'SendStreamingMessage']);

  // Errors, as JSON-RPC.
  const unknown = (await (await rpc('DoSomethingElse', {})).json()) as any;
  expect(unknown.error.code).toBe(-32601);
  const missing = await rpc('SendMessage', message('hi'), auth, 'nobody');
  expect(missing.status).toBe(404);
  expect(((await missing.json()) as any).error.data[0].reason).toBe('AGENT_NOT_FOUND');
  expect((await rpc('SendMessage', message('hi'), {})).status).toBe(401);

  // A key allowed only other tools can't reach it, or see it listed.
  const narrow = await key('rw-a2a-narrow', { allowed_mcp: ['files__*'] });
  const refused = await rpc('SendMessage', message('hi'), { authorization: `Bearer ${narrow.key}` });
  expect(refused.status).toBe(403);
  expect(((await refused.json()) as any).error.data[0].reason).toBe('TOOL_NOT_ALLOWED');
  expect(((await (await fetch(`${CT}/a2a`, { headers: { authorization: `Bearer ${narrow.key}` } })).json()) as any).agents).toEqual([]);

  // Gates: sending messages to it is denied, reading tasks is not; nothing denied reaches the agent.
  const deny = await admin.post('/admin/api/rules', { name: 'No messages to the research agent', target_kind: 'tool', match: { tools: ['researcher__SendMessage'] }, effect: 'deny', priority: 5 });
  expect(deny.status).toBe(201);
  const before = remote.calls.length;
  const denied = await rpc('SendMessage', message('hi'));
  expect(denied.status).toBe(403);
  expect(((await denied.json()) as any).error).toMatchObject({ code: 403, data: [expect.objectContaining({ reason: 'POLICY_DENIED' })] });
  expect(remote.calls.length).toBe(before);
  expect((await rpc('GetTask', { id: task.id })).status).toBe(200);
  await admin.call('DELETE', `/admin/api/rules/${deny.body.id}`);

  // Inspect gates read the message before it leaves.
  const inspect = await admin.post('/admin/api/rules', { name: 'No secrets to agents', target_kind: 'tool', match: { tools: ['researcher__*'] }, effect: 'inspect', config: { detectors: ['secrets'], action: 'block', direction: 'input' }, priority: 6 });
  expect(inspect.status).toBe(201);
  const leaked = await rpc('SendMessage', message('use AKIAIOSFODNN7EXAMPLE'));
  expect(leaked.status).toBe(400);
  expect(((await leaked.json()) as any).error.data[0].reason).toBe('CONTENT_BLOCKED');
  await admin.call('DELETE', `/admin/api/rules/${inspect.body.id}`);

  // Approvals: a held message is ticketed; once a person approves, the same message sent again — as SDKs do, with a new
  // messageId, the ticket in metadata — goes through. A different message can't ride on that approval.
  const hold = await admin.post('/admin/api/rules', { name: 'Research needs a yes', target_kind: 'tool', match: { tools: ['researcher__SendMessage'] }, effect: 'require_approval', config: { hold_ms: 800 }, priority: 5 });
  expect(hold.status).toBe(201);
  const held = await rpc('SendMessage', message('Summarise the Q3 board pack'));
  expect(held.status).toBe(403);
  const heldErr = ((await held.json()) as any).error;
  expect(heldErr.data[0].reason).toBe('APPROVAL_REQUIRED');
  const ticket = heldErr.data[0].metadata.ticket as string;
  expect(ticket).toBeTruthy();
  const pendingId = ((await admin.get('/admin/api/approvals?status=pending')).body.approvals as Array<{ id: string; key_id: string }>).find((x) => x.key_id === caller.id)!.id;
  expect((await admin.post(`/admin/api/approvals/${pendingId}/decide`, { action: 'approve' })).status).toBe(200);
  const other = await rpc('SendMessage', { ...message('Something else entirely'), metadata: { ct_approval: ticket } });
  expect(other.status).toBe(403);
  const retried = await rpc('SendMessage', { ...message('Summarise the Q3 board pack'), metadata: { ct_approval: ticket } });
  expect(retried.status).toBe(200);
  expect(((await retried.json()) as any).result.task.artifacts[0].parts[0].text).toBe('echo: Summarise the Q3 board pack');
  expect(JSON.parse(remote.calls.at(-1)!.body).params.metadata.ct_approval).toBeUndefined();
  await admin.call('DELETE', `/admin/api/rules/${hold.body.id}`);

  // Names are one namespace across A2A agents, MCP servers and HTTP APIs.
  expect((await admin.post('/admin/api/mcp/servers', { name: 'Clash', slug: 'researcher', url: `${remote.url}/mcp` })).status).toBe(409);
  expect((await admin.post('/admin/api/http/apis', { name: 'Clash', slug: 'researcher', base_url: remote.url })).status).toBe(409);

  // A card that sends calls to another server is refused: the agent's credentials only go where its card comes from.
  const elsewhere = await admin.post('/admin/api/a2a/agents', { name: 'Elsewhere', slug: 'elsewhere', url: remote.url.replace('127.0.0.1', 'localhost'), auth: { type: 'bearer', token: 'agent-secret' } });
  expect(elsewhere.body.check.ok).toBe(false);
  expect(elsewhere.body.check.detail).toContain('different server');
  expect((await rpc('SendMessage', message('hi'), auth, 'elsewhere')).status).toBe(404);
  await admin.call('DELETE', `/admin/api/a2a/agents/${elsewhere.body.agent.id}`);

  // An A2A 0.3 agent works the same way, by its own method names.
  const legacy = await a2aUpstream({ version: '0.3', token: 'legacy-secret' });
  upstreams.push(legacy);
  const reg03 = await admin.post('/admin/api/a2a/agents', { name: 'Legacy agent', slug: 'legacy', url: `${legacy.url}/.well-known/agent-card.json`, auth: { type: 'bearer', token: 'legacy-secret' } });
  expect(reg03.body.agent.protocol_version).toBe('0.3.0');
  const card03 = (await (await fetch(`${CT}/a2a/legacy/.well-known/agent-card.json`, { headers: auth })).json()) as any;
  expect(card03).toMatchObject({ url: `${CT}/a2a/legacy`, preferredTransport: 'JSONRPC', security: [{ controltower: [] }] });
  const r03 = (await (await rpc('message/send', { message: { kind: 'message', messageId: 'm1', role: 'user', parts: [{ kind: 'text', text: 'old school' }] } }, auth, 'legacy')).json()) as any;
  expect(r03.result).toMatchObject({ kind: 'task', status: { state: 'completed' } });
  expect(r03.result.status.message.parts[0].text).toBe('echo: old school');
  expect((await flightsFor(caller.id, (f) => f.some((x) => x.model_requested === 'legacy__SendMessage'))).length).toBeGreaterThan(0);

  // The map: both agents are destinations, the research agent is an agent, and the caller delegated to it.
  const topo = (await admin.get('/admin/api/topology')).body;
  const station = topo.mcp_servers.find((s: { slug: string }) => s.slug === 'researcher');
  expect(station).toMatchObject({ protocol: 'a2a', agent_id: 'rw-a2a-research' });
  expect(station.tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(['SendMessage', 'GetTask']));
  expect(topo.delegations).toEqual(expect.arrayContaining([expect.objectContaining({ from: 'rw-a2a-caller', key_id: research.id })]));
  const page = (await admin.get('/admin/api/a2a/agents')).body.agents.find((a: { slug: string }) => a.slug === 'researcher');
  expect(page.methods.map((m: { name: string }) => m.name)).toEqual(expect.arrayContaining(['SendMessage', 'GetTask']));
});

test('A2A with the official SDK: an SDK agent behind Control Tower, driven by the SDK client', async () => {
  const agent = await a2aSdkAgent('sdk-secret');
  upstreams.push({ url: agent.url, calls: [], close: agent.close });
  const reg = await admin.post('/admin/api/a2a/agents', { name: 'SDK research agent', slug: 'sdk-research', url: agent.url, auth: { type: 'bearer', token: 'sdk-secret' }, agent_id: 'rw-sdk-research' });
  expect(reg.status).toBe(201);
  expect(reg.body.check.ok).toBe(true);
  expect(reg.body.agent.protocol_version).toBe('1.0');

  // The SDK client, pointed at the card Control Tower publishes, with the caller's Control Tower key.
  const caller = await key('rw-sdk-caller', { agent_id: 'rw-sdk-caller' });
  const withKey = (k: string): typeof fetch => (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${k}`);
    return fetch(input, { ...init, headers });
  };
  const clientFor = (k: string, legacy = false) =>
    new ClientFactory(
      ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
        transports: [new JsonRpcTransportFactory({ fetchImpl: withKey(k), ...(legacy ? { legacyCompat: { enabled: true } } : {}) })],
        cardResolver: new DefaultAgentCardResolver({ fetchImpl: withKey(k), ...(legacy ? { legacyCompat: { enabled: true } } : {}) }),
      }),
    );
  const client = await clientFor(caller.key).createFromUrl(`${CT}/a2a/sdk-research/.well-known/agent-card.json`, ''); // the full card URL: a base URL would resolve /.well-known at the host root
  const card = await client.getAgentCard();
  expect(card.name).toBe('SDK research agent');
  expect(card.supportedInterfaces[0]!.url).toBe(`${CT}/a2a/sdk-research`);

  const message = (text: string) => ({ tenant: '', message: { messageId: crypto.randomUUID(), contextId: '', taskId: '', role: Role.ROLE_USER, parts: [{ content: { $case: 'text' as const, value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' }], metadata: undefined, extensions: [], referenceTaskIds: [] }, configuration: undefined, metadata: undefined });
  const textOfParts = (parts: Array<{ content?: { $case: string; value?: unknown } }>) => parts.map((p) => (p.content?.$case === 'text' ? String(p.content.value) : '')).join('');

  // SendMessage: the SDK agent does the work; it received the text, and a delegation token in metadata and the header.
  const result = (await client.sendMessage(message('What is the refund policy?'))) as any;
  expect(result.status.state).toBe(3); // TASK_STATE_COMPLETED
  expect(textOfParts(result.artifacts[0].parts)).toBe('researched: What is the refund policy?');
  expect(agent.received[0]!.text).toBe('What is the refund policy?');
  expect(String(agent.received[0]!.metadata['controltower/delegation'])).toMatch(/^ctd1\./);
  expect(agent.received[0]!.headers['x-ct-delegation']).toBe(agent.received[0]!.metadata['controltower/delegation']);
  expect(agent.received[0]!.headers.authorization).toBe('Bearer sdk-secret');

  // GetTask, and a stream the SDK parses event by event.
  const task = await client.getTask({ tenant: '', id: result.id, historyLength: undefined });
  expect(task.id).toBe(result.id);
  const kinds: string[] = [];
  let streamed = '';
  for await (const ev of client.sendMessageStream(message('stream it'))) {
    kinds.push(ev.payload!.$case);
    if (ev.payload?.$case === 'artifactUpdate') streamed = textOfParts(ev.payload.value.artifact!.parts as never);
  }
  expect(kinds[0]).toBe('task');
  expect(kinds).toContain('artifactUpdate');
  expect(kinds.at(-1)).toBe('statusUpdate');
  expect(streamed).toBe('researched: stream it');

  const flights = await flightsFor(caller.id, (f) => f.length >= 3);
  expect(flights.map((f) => f.tool).sort()).toEqual(['GetTask', 'SendMessage', 'SendStreamingMessage']);

  // A gate: the SDK client surfaces the refusal as an error, and nothing reaches the agent.
  const deny = await admin.post('/admin/api/rules', { name: 'No work for the SDK agent', target_kind: 'tool', match: { tools: ['sdk-research__SendMessage'] }, effect: 'deny', priority: 5 });
  const before = agent.received.length;
  const err = (await client.sendMessage(message('blocked?')).catch((e: unknown) => e)) as Error;
  expect(err).toBeInstanceOf(Error);
  expect(err.message).toContain(`Blocked by gate "No work for the SDK agent"`);
  expect(agent.received.length).toBe(before);
  await admin.call('DELETE', `/admin/api/rules/${deny.body.id}`);

  // The SDK's v0.3 compatibility client reads the 0.3 card Control Tower publishes for a 0.3 agent, and talks 0.3 through it.
  const legacy = await clientFor(caller.key, true).createFromUrl(`${CT}/a2a/legacy/.well-known/agent-card.json`, '');
  const r03 = (await legacy.sendMessage(message('old school'))) as any;
  expect(textOfParts(r03.status.message.parts)).toBe('echo: old school');
});

// ---------------------------------------------------------------- gates on models
let alertHook: Upstream;
const ALERT_SECRET = 'whsec-real-world-test';
let webhookChannel = '';

test('Alerts: a gate firing reaches a signed webhook and a Slack-format endpoint', async () => {
  alertHook = await webhookReceiver();
  upstreams.push(alertHook);
  const web = (await admin.post('/admin/api/alert-channels', { kind: 'webhook', url: `${alertHook.url}/hook`, name: 'Test webhook', secret: ALERT_SECRET })).body.id;
  webhookChannel = web;
  const slack = (await admin.post('/admin/api/alert-channels', { kind: 'slack', url: `${alertHook.url}/slack`, name: 'Test Slack' })).body.id;
  const rule = await admin.post('/admin/api/alert-rules', { kind: 'gate', rule_id: null, triggers: ['blocked'], threshold: 1, window_s: 300, cooldown_s: 0, channels: [web, slack], name: 'Anything blocked' });
  expect(rule.status).toBe(201);
});

test('Inspect gate: a secret in a prompt is blocked before it reaches the provider, and the alert fires', async () => {
  const gate = await admin.post('/admin/api/rules', { name: 'No secrets to models', target_kind: 'model', effect: 'inspect', config: { detectors: ['secrets'], action: 'block', direction: 'input' }, priority: 50 });
  expect(gate.status).toBe(201);
  const before = oai.calls.length;
  const r = await new OpenAI({ baseURL: `${CT}/v1`, apiKey: oaiAgent.key, maxRetries: 0 })
    .chat.completions.create({ model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'deploy with AKIAIOSFODNN7EXAMPLE' }] })
    .catch((e: unknown) => e as { status: number; code?: string });
  expect(r).toMatchObject({ status: 400, code: 'content_blocked' });
  expect(oai.calls.length).toBe(before);

  // The alert arrived, signed.
  await expect.poll(() => alertHook.calls.filter((c) => c.path === '/hook').length).toBeGreaterThan(0);
  const hook = alertHook.calls.find((c) => c.path === '/hook')!;
  const sig = String(hook.headers['x-ct-signature']);
  const [, t] = /t=(\d+)/.exec(sig)!;
  const [, v1] = /v1=([0-9a-f]+)/.exec(sig)!;
  expect(crypto.createHmac('sha256', ALERT_SECRET).update(`${t}.${hook.body}`).digest('hex')).toBe(v1);
  expect(JSON.parse(hook.body)).toMatchObject({ type: 'controltower.alert', trigger: 'blocked' });
  await expect.poll(() => alertHook.calls.filter((c) => c.path === '/slack').length).toBeGreaterThan(0);
  const slackBody = JSON.parse(alertHook.calls.find((c) => c.path === '/slack')!.body);
  expect(slackBody.text).toBeTruthy();
  expect(Array.isArray(slackBody.blocks)).toBe(true);
});

test('Approval on the model path: held with a ticket, approved by a human, redeemed once', async () => {
  const gate = await admin.post('/admin/api/rules', { name: 'Pricey model needs approval', target_kind: 'model', match: { models: ['pricey-gpt'] }, effect: 'require_approval', config: { hold_ms: 0 }, priority: 10 });
  expect(gate.status).toBe(201);
  const call = (headers: Record<string, string> = {}) =>
    fetch(`${CT}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${oaiAgent.key}`, 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ model: 'pricey-gpt', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }),
    });
  const held = await call();
  expect(held.status).toBe(403);
  const err = ((await held.json()) as { error: { code: string; ct: { ticket: string; request_id: string } } }).error;
  expect(err.code).toBe('approval_required');

  const decided = await admin.post(`/admin/api/approvals/${err.ct.request_id}/decide`, { action: 'approve', note: 'looks fine' });
  expect(decided.status).toBe(200);
  const ok = await call({ 'x-ct-approval': err.ct.ticket });
  expect(ok.status).toBe(200);
  // At most once: the same ticket does not buy a second call.
  const again = await call({ 'x-ct-approval': err.ct.ticket });
  expect(again.status).toBe(403);
});

// ---------------------------------------------------------------- MCP, both ends official SDK
let mcp: Awaited<ReturnType<typeof mcpUpstream>>;
let serverId = '';

async function mcpClient(apiKey: string): Promise<Client> {
  const client = new Client({ name: 'real-world-agent', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${CT}/mcp`), { requestInit: { headers: { authorization: `Bearer ${apiKey}` } } }));
  return client;
}
const textOf = (r: any): string => (r.content ?? []).map((c: { text?: string }) => c.text ?? '').join('\n');

test('MCP: official client → Control Tower → official server, with credentials injected', async () => {
  mcp = await mcpUpstream('mcp-upstream-token');
  upstreams.push(mcp);
  const reg = await admin.post('/admin/api/mcp/servers', { name: 'Files', slug: 'files', url: `${mcp.url}/mcp`, auth: { type: 'bearer', token: 'mcp-upstream-token' } });
  expect(reg.status).toBe(201);
  expect(reg.body.server.health).toBe('ok');
  serverId = reg.body.server.id;

  const agent = await key('rw-mcp-agent');
  const client = await mcpClient(agent.key);
  const tools = (await client.listTools()).tools.map((t) => t.name);
  expect(tools).toEqual(expect.arrayContaining(['files__read_file', 'files__delete_file']));
  const read = await client.callTool({ name: 'files__read_file', arguments: { path: '/etc/motd' } });
  expect(textOf(read)).toContain('contents of /etc/motd');
  await client.close();

  expect(mcp.calls.every((c) => c.headers.authorization === 'Bearer mcp-upstream-token')).toBe(true);
  expect(JSON.stringify(mcp.calls)).not.toContain(agent.key);
});

test('MCP: tools a key may not use are not even listed', async () => {
  const narrow = await key('rw-read-only-agent', { allowed_mcp: ['files__read_*'] });
  const client = await mcpClient(narrow.key);
  expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['files__read_file']);
  await client.close();
});

test('MCP: a destructive tool waits for a human; approve and it runs, deny and it never reaches the server', async () => {
  const gate = await admin.post('/admin/api/rules', { name: 'Deleting files needs approval', target_kind: 'tool', match: { tools: ['files__delete_file'] }, effect: 'require_approval', config: { hold_ms: 15000 }, priority: 20 });
  expect(gate.status).toBe(201);
  const agent = await key('rw-mcp-deleter');
  const client = await mcpClient(agent.key);

  const pending = client.callTool({ name: 'files__delete_file', arguments: { path: '/tmp/report.csv' } });
  let approvalId = '';
  await expect
    .poll(async () => {
      const list = (await admin.get('/admin/api/approvals?status=pending')).body.approvals as Array<{ id: string; key_id: string; target: { name: string }; args_preview: Record<string, unknown> }>;
      const a = list.find((x) => x.key_id === agent.id && x.target.name === 'files__delete_file');
      approvalId = a?.id ?? '';
      return a?.args_preview;
    })
    .toEqual({ path: '/tmp/report.csv' });
  expect((await admin.post(`/admin/api/approvals/${approvalId}/decide`, { action: 'approve' })).status).toBe(200);
  expect(textOf(await pending)).toContain('deleted /tmp/report.csv');
  expect(mcp.deleted).toEqual(['/tmp/report.csv']);

  const denied = client.callTool({ name: 'files__delete_file', arguments: { path: '/tmp/keep.csv' } });
  await expect
    .poll(async () => ((await admin.get('/admin/api/approvals?status=pending')).body.approvals as Array<{ id: string; key_id: string }>).find((x) => x.key_id === agent.id)?.id ?? '')
    .not.toBe('');
  const second = ((await admin.get('/admin/api/approvals?status=pending')).body.approvals as Array<{ id: string; key_id: string }>).find((x) => x.key_id === agent.id)!;
  await admin.post(`/admin/api/approvals/${second.id}/decide`, { action: 'deny', note: 'keep it' });
  const r = await denied;
  expect(r.isError).toBe(true);
  expect(mcp.deleted).toEqual(['/tmp/report.csv']);
  await client.close();
});

test('A human approves in the console, following the link in the alert', async ({ page }) => {
  await admin.post('/admin/api/alert-rules', { kind: 'gate', rule_id: null, triggers: ['held'], threshold: 1, window_s: 300, cooldown_s: 0, channels: [webhookChannel], name: 'Something is waiting' });
  const agent = await key('rw-console-approved');
  const client = await mcpClient(agent.key);
  const pending = client.callTool({ name: 'files__delete_file', arguments: { path: '/tmp/from-the-alert.csv' } });

  // The alert carries a link straight to the approval card.
  let link = '';
  await expect
    .poll(() => {
      const held = alertHook.calls.filter((c) => c.path === '/hook').map((c) => JSON.parse(c.body)).find((b) => b.trigger === 'held' && b.approval?.url);
      link = held?.approval.url ?? '';
      return link;
    })
    .toMatch(/#\/tower\/apr_/);

  await page.goto(`${CT}/`);
  await field(page, /^Email/).fill(EMAIL);
  await field(page, /^Password/).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.goto(link.replace(/^https?:\/\/[^/#]+/, CT));
  await expect(page.getByText('files__delete_file').first()).toBeVisible();
  await page.getByRole('button', { name: 'Approve', exact: true }).first().click();

  expect(textOf(await pending)).toContain('deleted /tmp/from-the-alert.csv');
  expect(mcp.deleted).toContain('/tmp/from-the-alert.csv');
  await client.close();
});

test('Email approvals: a held call emails a Review & approve link to its approval card', async () => {
  const smtp = await smtpCapture({ user: 'mailer', pass: 'smtp-secret' });
  try {
    const ch = await admin.post('/admin/api/alert-channels', { kind: 'email', name: 'On-call', to: 'oncall@example.com, security@example.com', smtp: { host: '127.0.0.1', port: smtp.port, from: 'Control Tower <tower@example.com>', user: 'mailer', pass: 'smtp-secret' } });
    expect(ch.status).toBe(201);
    const listed = (await admin.get('/admin/api/alert-channels')).body.channels.find((c: { id: string }) => c.id === ch.body.id);
    expect(listed).toMatchObject({ kind: 'email', to: ['oncall@example.com', 'security@example.com'], smtp: { host: '127.0.0.1', user: 'mailer', has_password: true } });
    expect(JSON.stringify(listed)).not.toContain('smtp-secret');

    // Send test.
    const t = await admin.post(`/admin/api/alert-channels/${ch.body.id}/test`);
    expect(t.body.error ?? '').toBe('');
    expect(t.body.ok).toBe(true);
    await expect.poll(() => smtp.messages.length).toBe(1);
    expect(smtp.messages[0]!.subject).toContain('Test alert');

    // A gate that holds this agent's calls, and an alert that emails when it does.
    const agent = await key('rw-email-approval');
    const gate = (await admin.post('/admin/api/rules', { name: 'Emailed approvals', target_kind: 'model', match: { keys: [agent.id] }, effect: 'require_approval', config: { hold_ms: 20_000 }, priority: 1 })).body.id;
    await admin.post('/admin/api/alert-rules', { kind: 'gate', rule_id: gate, triggers: ['held'], threshold: 1, window_s: 300, cooldown_s: 0, channels: [ch.body.id], name: 'Approvals by email' });
    const call = fetch(`${CT}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${agent.key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'Refund order 8812' }] }) });

    await expect.poll(() => smtp.messages.length, { timeout: 15_000 }).toBe(2);
    const mail = smtp.messages[1]!;
    expect(mail.subject).toMatch(/^\[Approval needed\] /);
    expect(smtp.envelopes[1]).toEqual(['oncall@example.com', 'security@example.com']);
    const link = /https?:\/\/[^\s"<]+#\/tower\/(apr_[0-9A-Za-z]+)/.exec(mail.text ?? '');
    expect(link).not.toBeNull();
    expect(mail.html).toContain('Review &amp; approve');
    expect(mail.text).toContain('Approving happens in Control Tower, signed in.');
    expect(mail.text).not.toContain('Refund order 8812'); // names and scope only, never the request itself

    // The link opens the card; approving is the signed-in action, and the held call continues.
    expect((await admin.post(`/admin/api/approvals/${link![1]}/decide`, { action: 'approve' })).status).toBe(200);
    expect((await call).status).toBe(200);
  } finally {
    await smtp.close();
  }
});

test('MCP: an inspect gate masks personal data in a tool result before the agent reads it', async () => {
  const gate = await admin.post('/admin/api/rules', { name: 'Mask emails from files', target_kind: 'tool', match: { tools: ['files__read_file'] }, effect: 'inspect', config: { detectors: ['email'], action: 'mask', direction: 'output' }, priority: 30 });
  expect(gate.status).toBe(201);
  const agent = await key('rw-mcp-reader');
  const client = await mcpClient(agent.key);
  const out = textOf(await client.callTool({ name: 'files__read_file', arguments: { path: '/srv/owners.txt' } }));
  expect(out).not.toContain('dana.whitfield@example.com');
  expect(out).toContain('[EMAIL]');
  await client.close();
});

test('MCP: health checks do not leak upstream sessions', async () => {
  const deletesBefore = mcp.calls.filter((c) => c.method === 'DELETE').length;
  const initsBefore = mcp.calls.filter((c) => c.body.includes('"method":"initialize"')).length;
  for (let i = 0; i < 3; i++) expect((await admin.post(`/admin/api/mcp/servers/${serverId}/test`)).body.ok).toBe(true);
  const inits = mcp.calls.filter((c) => c.body.includes('"method":"initialize"')).length - initsBefore;
  // Every session a check replaces is closed (DELETE), so a stateful server is not left holding them.
  await expect.poll(() => mcp.calls.filter((c) => c.method === 'DELETE').length - deletesBefore).toBeGreaterThanOrEqual(inits);
});

// ---------------------------------------------------------------- traffic that bypasses the gateway
test('Observed traffic: an OpenTelemetry SDK and /v1/observe put outside systems on the map', async () => {
  const agent = await key('rw-instrumented-agent');
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ 'service.name': 'rw-instrumented-agent' }),
    spanProcessors: [new SimpleSpanProcessor(new OTLPTraceExporter({ url: `${CT}/v1/traces`, headers: { authorization: `Bearer ${agent.key}` } }))],
  });
  const tracer = provider.getTracer('real-world');
  const span = tracer.startSpan('POST /v1/refunds', { kind: SpanKind.CLIENT, attributes: { 'http.request.method': 'POST', 'url.full': 'https://api.stripe.com/v1/refunds' } });
  span.end();
  await provider.forceFlush();
  await provider.shutdown();

  const obs = await fetch(`${CT}/v1/observe`, {
    method: 'POST',
    headers: { authorization: `Bearer ${agent.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ events: [{ target: 'postgresql://app:hunter2@orders-db.internal:5432/orders', kind: 'database', operation: 'write' }] }),
  });
  expect(obs.status).toBe(200);

  await expect
    .poll(async () => ((await admin.get('/admin/api/topology')).body.observed?.targets ?? []).map((t: { target: string }) => t.target).join(' '))
    .toMatch(/api\.stripe\.com[\s\S]*|orders-db/);
  const targets: string[] = ((await admin.get('/admin/api/topology')).body.observed.targets as Array<{ target: string }>).map((t) => t.target);
  expect(targets.some((t) => t.includes('api.stripe.com'))).toBe(true);
  expect(targets.some((t) => t.includes('orders-db.internal'))).toBe(true);
  // Credentials in connection strings are never stored.
  expect(JSON.stringify(targets)).not.toContain('hunter2');
});

// ---------------------------------------------------------------- the views over real traffic
test('Map, simulate, inventory export, ledger and metrics all reflect the real traffic', async () => {
  const topo = (await admin.get('/admin/api/topology')).body;
  const names = topo.keys.map((k: { name: string }) => k.name);
  expect(names).toEqual(expect.arrayContaining(['rw-openai-agent', 'rw-claude-agent', 'rw-mcp-agent']));
  expect(topo.mcp_servers.find((m: { slug: string }) => m.slug === 'files').tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(['read_file', 'delete_file']));
  expect(topo.edges.some((e: { key_id: string }) => e.key_id === oaiAgent.id)).toBe(true);

  const sim = await admin.post('/admin/api/policy/simulate', { rule: { effect: 'deny', target_kind: 'model', match: { models: ['gpt-4.1-mini'] } }, hours: 1 });
  expect(sim.status).toBe(200);
  expect(sim.body.changed.to_deny).toBeGreaterThan(0);

  const md = (await admin.get('/admin/api/export/dataflow?format=md')).body as string;
  expect(md).toContain('rw-openai-agent');
  expect(md).toContain('Files');
  const csv = (await admin.get('/admin/api/export/dataflow?format=csv')).body as string;
  expect(csv.split('\n')[0]).toMatch(/agent/i);

  const ledger = (await admin.get('/admin/api/ledger/summary?window=24h')).body;
  expect(ledger.by_key.find((r: { key_id: string }) => r.key_id === oaiAgent.id).cost_nanousd).toBeGreaterThan(0);
  expect(ledger.budgets.some((b: { scope: string }) => b.scope.startsWith('key:'))).toBe(true);

  const metrics = (await admin.get('/metrics')).body as string;
  expect(metrics).toContain('controltower_requests_total{agent="rw-openai-agent"');
  expect(metrics).toContain('controltower_mcp_server_up{server="files"} 1');
});

test('Policy as code: export zones and gates as YAML, edit, preview, apply, replace', async () => {
  // Export: readable YAML that references agents, models and servers by name.
  const yamlText = (await admin.get<string>('/admin/api/policy/export')).body;
  expect(yamlText).toContain('zones:');
  expect(yamlText).toContain('name: Sandbox');
  expect(yamlText).toContain('agent:rw-sandbox-intern');
  expect(yamlText).toContain('model:pricey-gpt');
  const original = (await admin.get('/admin/api/policy/export?format=json')).body.doc;

  // Re-importing what was exported changes nothing.
  const same = (await admin.post('/admin/api/policy/import', { yaml: yamlText, mode: 'replace' })).body;
  expect(same.errors).toEqual([]);
  expect([...same.zones.create, ...same.zones.update, ...same.zones.remove, ...same.gates.create, ...same.gates.update, ...same.gates.remove]).toEqual([]);

  // Add a gate by name (JSON is valid YAML), preview it, apply it, and it is enforced.
  const edited = { ...original, gates: [...original.gates, { name: 'No mini for the OpenAI agent', match: { agents: ['rw-openai-agent'], models: ['gpt-4.1-mini'] }, target: 'model', effect: 'deny', priority: 1 }] };
  const preview = (await admin.post('/admin/api/policy/import', { yaml: JSON.stringify(edited), mode: 'merge' })).body;
  expect(preview).toMatchObject({ errors: [], applied: false, gates: { create: ['No mini for the OpenAI agent'] } });
  const chat = () =>
    fetch(`${CT}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${oaiAgent.key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'hi' }] }) });
  expect((await chat()).status).toBe(200);
  expect((await admin.post('/admin/api/policy/import', { yaml: JSON.stringify(edited), mode: 'merge', apply: true })).body.applied).toBe(true);
  expect((await chat()).status).toBe(403);

  // Unknown references are refused, and nothing changes.
  const bad = await admin.post('/admin/api/policy/import', { yaml: 'gates:\n  - name: Typo\n    match: { agents: [no-such-agent] }\n    effect: deny\n', mode: 'merge', apply: true });
  expect(bad.status).toBe(400);
  expect(bad.body.errors.join(' ')).toContain('no agent named "no-such-agent"');

  // Replace with the original file: the added gate is removed and the agent is let through again.
  const back = (await admin.post('/admin/api/policy/import', { yaml: yamlText, mode: 'replace', apply: true })).body;
  expect(back.gates.remove).toEqual(['No mini for the OpenAI agent']);
  expect((await chat()).status).toBe(200);
});

test('Config import: a real config file becomes working providers, models and aliases', async () => {
  const up = await openAiUpstream({ reply: 'Hello from the imported model' });
  upstreams.push(up);
  const yaml = `model_list:
  - model_name: imported-fast
    params:
      model: openai/gpt-4.1-mini
      api_base: ${up.url}/v1
      api_key: sk-imported-secret
`;
  const plan = await admin.post('/admin/api/import/config/plan', { yaml });
  expect(plan.status).toBe(200);
  const applied = await admin.post('/admin/api/import/config/apply', { yaml });
  expect(applied.status).toBe(200);
  const r = await new OpenAI({ baseURL: `${CT}/v1`, apiKey: oaiAgent.key }).chat.completions.create({ model: 'imported-fast', messages: [{ role: 'user', content: 'hi' }] });
  expect(r.choices[0]!.message.content).toBe('Hello from the imported model');
  expect(up.calls.find((c) => c.path.endsWith('/chat/completions'))?.headers.authorization).toBe('Bearer sk-imported-secret');
});
