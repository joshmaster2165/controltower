import { test, expect } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { CT, admin, flightById } from './support/admin';
import { webhookReceiver, type Upstream } from './support/upstreams';

/**
 * Models checked in the background — down, missing, and back — shown on the map, raising health alerts,
 * and tried last while failing; and answers cached for models that opt in, only ever after the gates.
 */
test.describe.configure({ mode: 'serial' });

/** An OpenAI-compatible upstream whose health can be switched: its model list, its models, its chat. */
const state = { listStatus: 200, listed: ['hc-model', 'hc-other', 'cache-model', 'embed-model'], chatStatus: 200, chats: 0 };
let server: http.Server;
let upUrl = '';
let hook: Upstream;
let providerId = '';
let key = '';
let keyId = '';
let key2 = '';
const deps: Record<string, string> = {};

async function chat(k: string, model: string, o: { headers?: Record<string, string>; content?: string; stream?: boolean } = {}) {
  const r = await fetch(`${CT}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${k}`, 'content-type': 'application/json', ...(o.headers ?? {}) },
    body: JSON.stringify({ model, max_tokens: 5, stream: o.stream ?? false, messages: [{ role: 'user', content: o.content ?? 'hello cache' }] }),
  });
  const text = await r.text();
  return { status: r.status, text, cache: r.headers.get('x-ct-cache'), flight: r.headers.get('x-ct-flight-id')! };
}
const topoDeployment = async (id: string) => ((await admin.get('/admin/api/topology')).body.deployments as any[]).find((d) => d.id === id);

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'GET') return state.listStatus === 200 ? send(200, { object: 'list', data: state.listed.map((id) => ({ id, object: 'model' })) }) : send(state.listStatus, { error: { message: 'upstream is down' } });
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (req.url?.endsWith('/embeddings')) return send(200, { object: 'list', data: [{ object: 'embedding', index: 0, embedding: [0.5, 0.25] }], model: body.model, usage: { prompt_tokens: 3, total_tokens: 3 } });
      state.chats++;
      if (state.chatStatus !== 200) return send(state.chatStatus, { error: { message: 'model overloaded' } });
      const answer = `answer #${state.chats} from ${body.model}`;
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: answer } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', model: body.model, choices: [], usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } })}\n\n`);
        return res.end('data: [DONE]\n\n');
      }
      send(200, { id: 'c', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  upUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  hook = await webhookReceiver();
  await admin.signIn();
  const p = await admin.post('/admin/api/providers', { catalog_id: 'custom', name: 'Health upstream', slug: 'hcup', base_url: `${upUrl}/v1`, credentials: { api_key: 'sk-hc' } });
  providerId = (p.body.provider ?? p.body).id;
  for (const [name, caps] of [['hc-model', {}], ['hc-other', {}], ['cache-model', { cache: { ttl_s: 60 } }], ['shared-cache', { cache: { ttl_s: 60, shared: true } }], ['embed-model', { mode: 'embedding', cache: { ttl_s: 60 } }]] as const) {
    const upstream = name === 'shared-cache' ? 'cache-model' : name;
    const r = await admin.post('/admin/api/deployments', { provider_id: providerId, upstream_model: upstream, public_name: name, caps, pricing_override: { input: 1, output: 2 } });
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    deps[name] = r.body.id;
  }
  const k = await admin.post('/admin/api/keys', { name: 'hc-agent', agent_id: 'hc-agent' });
  key = k.body.key;
  keyId = k.body.id;
  key2 = (await admin.post('/admin/api/keys', { name: 'hc-agent-2', agent_id: 'hc-agent-2' })).body.key;
});

test.afterAll(async () => {
  await admin.del(`/admin/api/providers/${providerId}`);
  await new Promise<void>((r) => server.close(() => r()));
  await hook?.close();
});

test('a model whose provider stops answering is marked down — on the map, with an alert — and recovers', async () => {
  const web = (await admin.post('/admin/api/alert-channels', { kind: 'webhook', url: `${hook.url}/health`, name: 'Health hook' })).body.id;
  const rule = await admin.post('/admin/api/alert-rules', { kind: 'health', triggers: ['outage', 'recovered'], threshold: 1, window_s: 300, cooldown_s: 0, channels: [web], name: 'Model health', params: { targets: [deps['hc-model']] } });
  expect(rule.status, JSON.stringify(rule.body)).toBe(201);

  expect((await admin.post('/admin/api/deployments/check')).status).toBe(200);
  expect(await topoDeployment(deps['hc-model']!)).toMatchObject({ health: 'ok' });

  state.listStatus = 503;
  await admin.post('/admin/api/deployments/check');
  const down = await topoDeployment(deps['hc-model']!);
  expect(down.health).toBe('down');
  expect(down.health_detail).toContain('not answering');
  await expect.poll(() => hook.calls.filter((c) => c.path === '/health').map((c) => JSON.parse(c.body).trigger)).toContain('outage');

  state.listStatus = 200;
  await admin.post('/admin/api/deployments/check');
  expect((await topoDeployment(deps['hc-model']!)).health).toBe('ok');
  await expect.poll(() => hook.calls.filter((c) => c.path === '/health').map((c) => JSON.parse(c.body).trigger)).toContain('recovered');
  await admin.del(`/admin/api/alert-rules/${rule.body.id}`);
});

test('a model the provider no longer lists is marked missing; a server with no model list is not marked down', async () => {
  state.listed = ['hc-model', 'cache-model', 'embed-model'];
  await admin.post('/admin/api/deployments/check');
  expect(await topoDeployment(deps['hc-other']!)).toMatchObject({ health: 'missing' });
  state.listed = ['hc-model', 'hc-other', 'cache-model', 'embed-model'];

  state.listStatus = 404; // no /models on this server
  await admin.post('/admin/api/deployments/check');
  expect((await topoDeployment(deps['hc-model']!)).health).toBe('ok');
  state.listStatus = 200;
});

test('"Check" makes a real call, and a model failing its check is tried last', async () => {
  state.chatStatus = 503;
  const r = await admin.post(`/admin/api/deployments/${deps['hc-other']}/check`);
  expect(r.body).toMatchObject({ health: 'down' });
  state.chatStatus = 200;
  // An alias listing the failing model first still answers from the healthy one first.
  const a = await admin.post('/admin/api/aliases', { name: 'hc-alias', strategy: 'priority', targets: [{ deployment_id: deps['hc-other'], priority: 0 }, { deployment_id: deps['hc-model'], priority: 1 }] });
  expect(a.status).toBeLessThan(300);
  const c = await chat(key, 'hc-alias', { content: 'which one?' });
  expect(c.text).toContain('from hc-model');
  expect((await admin.post(`/admin/api/deployments/${deps['hc-other']}/check`)).body).toMatchObject({ health: 'ok' });
});

test('answers are cached for models that opt in: the second identical call never reaches the provider, and costs nothing', async () => {
  const before = state.chats;
  const a = await chat(key, 'cache-model');
  expect([a.status, a.cache]).toEqual([200, 'miss']);
  const b = await chat(key, 'cache-model');
  expect([b.status, b.cache]).toEqual([200, 'hit']);
  expect(b.text).toBe(a.text);
  expect(state.chats).toBe(before + 1);
  const fb = await flightById(b.flight);
  expect(fb).toMatchObject({ cache_hit: 1, cost_nanousd: 0, status: 'ok' });
  expect((await flightById(a.flight)).cost_nanousd).toBeGreaterThan(0);

  // Another agent doesn't see this agent's answers — unless the model's cache is shared.
  expect((await chat(key2, 'cache-model')).cache).toBe('miss');
  await chat(key, 'shared-cache');
  expect((await chat(key2, 'shared-cache')).cache).toBe('hit');

  // Asked not to use it, or not to keep it.
  const n = state.chats;
  expect((await chat(key, 'cache-model', { headers: { 'x-ct-cache': 'no-cache' } })).cache).toBeNull();
  expect(state.chats).toBe(n + 1);
  await chat(key, 'cache-model', { content: 'keep nothing', headers: { 'x-ct-cache': 'no-store' } });
  expect((await chat(key, 'cache-model', { content: 'keep nothing' })).cache).toBe('miss');
});

test('streamed answers are cached whole and sent again as a stream', async () => {
  const a = await chat(key, 'cache-model', { stream: true, content: 'stream me' });
  expect(a.cache).toBe('miss');
  const b = await chat(key, 'cache-model', { stream: true, content: 'stream me' });
  expect(b.cache).toBe('hit');
  expect(b.text).toBe(a.text);
  expect(b.text).toContain('data: [DONE]');
});

test('embeddings are cached too', async () => {
  const call = () => fetch(`${CT}/v1/embeddings`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'embed-model', input: 'cache this vector' }) });
  expect((await call()).headers.get('x-ct-cache')).toBe('miss');
  expect((await call()).headers.get('x-ct-cache')).toBe('hit');
});

test('a gate still stops a call whose answer is cached', async () => {
  await chat(key, 'cache-model', { content: 'gated later' });
  const rule = await admin.post('/admin/api/rules', { name: 'hc: no cache-model', target_kind: 'model', match: { keys: [keyId], models: ['cache-model'] }, effect: 'deny' });
  try {
    const r = await chat(key, 'cache-model', { content: 'gated later' });
    expect(r.status).toBe(403);
    expect(r.cache).toBeNull();
  } finally {
    await admin.del(`/admin/api/rules/${rule.body.id ?? rule.body.rule?.id}`);
  }
  const cleared = await admin.del('/admin/api/cache');
  expect(cleared.body.cleared).toBeGreaterThan(0);
  expect((await chat(key, 'cache-model', { content: 'gated later' })).cache).toBe('miss');
});
