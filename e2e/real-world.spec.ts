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
import { anthropicUpstream, mcpUpstream, openAiUpstream, webhookReceiver, type Upstream } from './support/upstreams';
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

  // Models on providers without a Responses API get a clear answer instead of a translation.
  const claude = await client.responses.create({ model: 'claude-sonnet-4-5', input: 'hi' }).then(() => undefined, (e: unknown) => e as { status: number; message: string });
  expect(claude?.status).toBe(400);
  expect(claude?.message).toContain('/v1/chat/completions');

  // Recorded as responses flights, with the provider's usage (cached tokens split out) and a price.
  const flights = await flightsFor(agent.id, (f) => f.filter((x) => x.status === 'ok').length >= 2);
  const ok = flights.filter((f) => f.status === 'ok');
  expect(ok.every((f) => f.kind === 'responses')).toBe(true);
  expect(ok.every((f) => f.in_tokens === 16 && f.out_tokens === 9 && f.usage_source === 'provider')).toBe(true);
  expect(ok.every((f) => f.cost_nanousd > 0)).toBe(true);
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

test('LiteLLM import: a real config becomes working providers, models and aliases', async () => {
  const up = await openAiUpstream({ reply: 'Hello from the imported model' });
  upstreams.push(up);
  const yaml = `model_list:
  - model_name: imported-fast
    litellm_params:
      model: openai/gpt-4.1-mini
      api_base: ${up.url}/v1
      api_key: sk-imported-secret
`;
  const plan = await admin.post('/admin/api/import/litellm/plan', { yaml });
  expect(plan.status).toBe(200);
  const applied = await admin.post('/admin/api/import/litellm/apply', { yaml });
  expect(applied.status).toBe(200);
  const r = await new OpenAI({ baseURL: `${CT}/v1`, apiKey: oaiAgent.key }).chat.completions.create({ model: 'imported-fast', messages: [{ role: 'user', content: 'hi' }] });
  expect(r.choices[0]!.message.content).toBe('Hello from the imported model');
  expect(up.calls.find((c) => c.path.endsWith('/chat/completions'))?.headers.authorization).toBe('Bearer sk-imported-secret');
});
