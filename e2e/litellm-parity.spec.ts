import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { anthropicUpstream, mcpUpstream, openAiUpstream, webhookReceiver, type Upstream } from './support/upstreams';

/**
 * LiteLLM's documented setup steps, done against Control Tower exactly as the
 * LiteLLM docs write them: start with `--config config.yaml` and
 * LITELLM_MASTER_KEY, probe /health/*, mint keys with POST /key/generate,
 * point SDKs at the bare origin, manage keys and models through /key/* and
 * /model/*, sign in at /ui with the master key. Its own server, on its own port.
 */
test.describe.configure({ mode: 'serial' });

const PORT = 4460;
const CT = `http://127.0.0.1:${PORT}`;
const MASTER = 'sk-litellm-parity-master-key-1234567890';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-litellm-'));
const configPath = path.join(dataDir, 'config.yaml');

let server: ChildProcess | undefined;
let log = '';
const upstreams: Upstream[] = [];
let oai: Upstream, flaky: Upstream, broken: Upstream, ant: Upstream, slack: Upstream;
let mcp: Awaited<ReturnType<typeof mcpUpstream>>;

function configYaml(extra = ''): string {
  return `model_list:
  - model_name: gpt-4o
    litellm_params:
      model: openai/gpt-4.1-mini
      api_base: ${oai.url}/v1
      api_key: os.environ/OPENAI_API_KEY
  - model_name: claude-sonnet
    litellm_params:
      model: anthropic/claude-sonnet-4-5
      api_base: ${ant.url}
      api_key: os.environ/ANTHROPIC_API_KEY
  - model_name: text-embedding
    litellm_params:
      model: openai/text-embedding-3-small
      api_base: ${oai.url}/v1
      api_key: os.environ/OPENAI_API_KEY
    model_info:
      mode: embedding
  - model_name: "openai/*"
    litellm_params:
      model: "openai/*"
      api_base: ${oai.url}/v1
      api_key: os.environ/OPENAI_API_KEY
  - model_name: flaky
    litellm_params:
      model: openai/gpt-4.1-mini
      api_base: ${flaky.url}/v1
      api_key: sk-flaky-upstream
  - model_name: broken
    litellm_params:
      model: openai/gpt-4.1-mini
      api_base: ${broken.url}/v1
      api_key: sk-broken-upstream
${extra}
litellm_settings:
  fallbacks: [{"flaky": ["gpt-4o"]}]

mcp_servers:
  files:
    url: "${mcp.url}/mcp"
    transport: http
    auth_type: bearer_token
    auth_value: os.environ/FILES_MCP_TOKEN

general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
  alerting: ["slack"]
  alert_types: ["llm_exceptions"]
`;
}

/** `litellm --config config.yaml --port …`, but Control Tower. */
async function startServer(args: string[] = ['--config', configPath, '--port', String(PORT)]): Promise<void> {
  log = '';
  server = spawn('node', ['server/dist/server.mjs', ...args], {
    env: {
      ...process.env,
      LITELLM_MASTER_KEY: MASTER,
      OPENAI_API_KEY: 'sk-upstream-openai',
      ANTHROPIC_API_KEY: 'sk-ant-upstream',
      FILES_MCP_TOKEN: 'files-mcp-token',
      SLACK_WEBHOOK_URL: `${slack.url}/slack`,
      CT_DATA_DIR: dataDir,
      CT_UI_DIR: path.resolve('ui/dist'),
      CT_LOG_LEVEL: 'warn',
      CT_DEMO: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout!.on('data', (d: Buffer) => (log += d.toString()));
  server.stderr!.on('data', (d: Buffer) => (log += d.toString()));
  await expect.poll(async () => (await fetch(`${CT}/health/liveliness`).catch(() => undefined))?.status, { timeout: 20_000 }).toBe(200);
}
async function stopServer(): Promise<void> {
  if (!server) return;
  const done = new Promise((r) => server!.once('exit', r));
  server.kill('SIGTERM');
  await done;
  server = undefined;
}

const master = (p: string, init: RequestInit = {}) =>
  fetch(`${CT}${p}`, { ...init, headers: { authorization: `Bearer ${MASTER}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });

test.beforeAll(async () => {
  oai = await openAiUpstream({ models: ['gpt-4.1-mini', 'gpt-4.1', 'text-embedding-3-small'] });
  flaky = await openAiUpstream({ rateLimited: true });
  broken = await openAiUpstream({ failing: true });
  ant = await anthropicUpstream();
  slack = await webhookReceiver();
  mcp = await mcpUpstream('files-mcp-token');
  upstreams.push(oai, flaky, broken, ant, slack, mcp);
  fs.writeFileSync(configPath, configYaml());
  await startServer();
});
test.afterAll(async () => {
  await stopServer();
  await Promise.all(upstreams.map((u) => u.close()));
});

let virtualKey = '';
let keyToken = '';

test('health probes answer like LiteLLM’s: liveliness, readiness, and /health with the master key', async () => {
  const live = await fetch(`${CT}/health/liveliness`);
  expect(await live.json()).toBe("I'm alive!");
  expect((await fetch(`${CT}/health/liveness`)).status).toBe(200);
  expect(await (await fetch(`${CT}/health/readiness`)).json()).toMatchObject({ status: 'healthy' });
  expect((await fetch(`${CT}/health`)).status).toBe(401);
  const h = await (await master('/health')).json();
  expect(h.healthy_endpoints.map((e: { model: string }) => e.model)).toEqual(expect.arrayContaining(['gpt-4o', 'claude-sonnet']));
});

test('POST /key/generate with the master key (virtual_keys doc)', async () => {
  const r = await master('/key/generate', {
    method: 'POST',
    body: JSON.stringify({ models: ['gpt-4o', 'claude-sonnet', 'text-embedding', 'flaky', 'broken', 'gpt-4.1'], metadata: { user: 'ishaan@berri.ai' }, key_alias: 'parity-agent', max_budget: 10, budget_duration: '30d', rpm_limit: 100 }),
  });
  expect(r.status).toBe(200);
  const b = await r.json();
  expect(b.key).toMatch(/^ct_sk_/);
  expect(b).toMatchObject({ key_alias: 'parity-agent', max_budget: 10, budget_duration: '30d', rpm_limit: 100, expires: null, metadata: { user: 'ishaan@berri.ai' } });
  virtualKey = b.key;
  keyToken = b.token;
  // Unsupported budget periods fail loudly rather than being silently rounded.
  const bad = await master('/key/generate', { method: 'POST', body: JSON.stringify({ max_budget: 1, budget_duration: '3h' }) });
  expect(bad.status).toBe(400);
});

test('curl /chat/completions without /v1 and /v1/chat/completions (quick start)', async () => {
  for (const p of ['/chat/completions', '/v1/chat/completions']) {
    const r = await fetch(`${CT}${p}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${virtualKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'what llm are you' }] }),
    });
    expect(r.status).toBe(200);
    expect((await r.json()).choices[0].message.content).toBe('Hello from the OpenAI-compatible upstream');
  }
});

test('OpenAI SDK with base_url = the bare origin (user_keys doc): chat, streaming, embeddings, models', async () => {
  const client = new OpenAI({ baseURL: CT, apiKey: virtualKey });
  const chat = await client.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
  expect(chat.choices[0]!.message.content).toBe('Hello from the OpenAI-compatible upstream');
  let text = '';
  for await (const c of await client.chat.completions.create({ model: 'gpt-4o', stream: true, messages: [{ role: 'user', content: 'hi' }] })) text += c.choices[0]?.delta?.content ?? '';
  expect(text.trim()).toBe('Hello from the OpenAI-compatible upstream');
  const emb = await client.embeddings.create({ model: 'text-embedding', input: 'hi' });
  expect(emb.data[0]!.embedding).toHaveLength(3);
  const models = (await client.models.list()).data.map((m) => m.id);
  expect(models).toEqual(expect.arrayContaining(['gpt-4o', 'claude-sonnet']));
  // The upstream saw the provider key from the environment, never the virtual key.
  expect(oai.calls.filter((c) => c.path.endsWith('/chat/completions')).every((c) => c.headers.authorization === 'Bearer sk-upstream-openai')).toBe(true);
});

test('Anthropic SDK and Claude Code: /v1/messages and /v1/messages/count_tokens with ANTHROPIC_AUTH_TOKEN', async () => {
  const msg = await new Anthropic({ baseURL: CT, apiKey: virtualKey }).messages.create({ model: 'claude-sonnet', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] });
  expect(msg.content[0]).toMatchObject({ type: 'text', text: 'Hello from the Anthropic upstream' });
  // Claude Code sends Authorization: Bearer (ANTHROPIC_AUTH_TOKEN) and counts tokens first.
  const count = await fetch(`${CT}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${virtualKey}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet', messages: [{ role: 'user', content: 'hi' }] }),
  });
  expect(await count.json()).toEqual({ input_tokens: 42 });
});

test('LiteLLM and Azure headers: x-litellm-api-key, api-key and /openai/deployments/<model>', async () => {
  const viaLitellmHeader = await fetch(`${CT}/chat/completions`, {
    method: 'POST',
    headers: { 'x-litellm-api-key': `Bearer ${virtualKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
  });
  expect(viaLitellmHeader.status).toBe(200);
  const azure = await fetch(`${CT}/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21`, {
    method: 'POST',
    headers: { 'api-key': virtualKey, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });
  expect(azure.status).toBe(200);
});

test('Routing from the config: fallbacks, provider wildcards, and a key limited to its models', async () => {
  const client = new OpenAI({ baseURL: CT, apiKey: virtualKey, maxRetries: 0 });
  const fb = await client.chat.completions.create({ model: 'flaky', messages: [{ role: 'user', content: 'hi' }] });
  expect(fb.choices[0]!.message.content).toBe('Hello from the OpenAI-compatible upstream');
  // openai/* : a model the provider lists, never named in the config.
  const wild = await client.chat.completions.create({ model: 'gpt-4.1', messages: [{ role: 'user', content: 'hi' }] });
  expect(wild.choices[0]!.message.content).toBeTruthy();

  const narrow = await (await master('/key/generate', { method: 'POST', body: JSON.stringify({ models: ['gpt-4o'] }) })).json();
  const denied = await new OpenAI({ baseURL: CT, apiKey: narrow.key, maxRetries: 0 }).chat.completions.create({ model: 'claude-sonnet', messages: [{ role: 'user', content: 'hi' }] }).catch((e: unknown) => e as { status: number });
  expect([401, 403]).toContain(denied.status);
});

test('Slack alerting from the config: an upstream exception reaches Slack', async () => {
  const err = await new OpenAI({ baseURL: CT, apiKey: virtualKey, maxRetries: 0 }).chat.completions.create({ model: 'broken', messages: [{ role: 'user', content: 'hi' }] }).catch((e: unknown) => e as { status: number });
  expect(err.status).toBeGreaterThanOrEqual(500);
  await expect.poll(() => slack.calls.filter((c) => c.path === '/slack').length, { timeout: 15_000 }).toBeGreaterThan(0);
  const body = JSON.parse(slack.calls.find((c) => c.path === '/slack')!.body);
  expect(body.text).toBeTruthy();
});

test('Key management: /key/info, /key/update, /key/list, /key/block, /key/unblock, /key/regenerate, /key/delete', async () => {
  const info = await (await master(`/key/info?key=${encodeURIComponent(virtualKey)}`)).json();
  expect(info.info).toMatchObject({ key_alias: 'parity-agent', max_budget: 10 });
  expect(info.info.spend).toBeGreaterThan(0);
  // A key may look itself up.
  const self = await fetch(`${CT}/key/info`, { headers: { authorization: `Bearer ${virtualKey}` } });
  expect((await self.json()).info.key_alias).toBe('parity-agent');

  const upd = await (await master('/key/update', { method: 'POST', body: JSON.stringify({ key: virtualKey, max_budget: 25, tpm_limit: 5000 }) })).json();
  expect(upd).toMatchObject({ max_budget: 25, tpm_limit: 5000 });
  const list = await (await master('/key/list?size=100')).json();
  expect(list.keys).toContain(keyToken);

  const call = (k: string) =>
    fetch(`${CT}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${k}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }) });
  await master('/key/block', { method: 'POST', body: JSON.stringify({ key: virtualKey }) });
  expect((await call(virtualKey)).status).toBe(401);
  await master('/key/unblock', { method: 'POST', body: JSON.stringify({ key: virtualKey }) });
  expect((await call(virtualKey)).status).toBe(200);

  const regen = await (await master(`/key/${encodeURIComponent(virtualKey)}/regenerate`, { method: 'POST', body: '{}' })).json();
  expect(regen.key).not.toBe(virtualKey);
  expect((await call(virtualKey)).status).toBe(401);
  expect((await call(regen.key)).status).toBe(200);
  virtualKey = regen.key;

  // An existing LiteLLM key can be brought over unchanged.
  const kept = await master('/key/generate', { method: 'POST', body: JSON.stringify({ key: 'sk-existing-litellm-key-abcdef123456', key_alias: 'migrated' }) });
  expect(kept.status).toBe(200);
  expect((await call('sk-existing-litellm-key-abcdef123456')).status).toBe(200);
  const del = await (await master('/key/delete', { method: 'POST', body: JSON.stringify({ keys: ['sk-existing-litellm-key-abcdef123456'] }) })).json();
  expect(del.deleted_keys).toHaveLength(1);
  expect((await call('sk-existing-litellm-key-abcdef123456')).status).toBe(401);
});

test('Model management: /model/info, /model/new, /model/delete (config models stay put)', async () => {
  const info = await (await master('/model/info')).json();
  const names = info.data.map((m: { model_name: string }) => m.model_name);
  expect(names).toEqual(expect.arrayContaining(['gpt-4o', 'claude-sonnet', 'flaky']));
  expect((await (await master('/v1/model/info')).json()).data.length).toBe(info.data.length);

  const created = await (await master('/model/new', { method: 'POST', body: JSON.stringify({ model_name: 'added-by-api', litellm_params: { model: 'openai/gpt-4.1', api_base: `${oai.url}/v1`, api_key: 'os.environ/OPENAI_API_KEY' } }) })).json();
  expect(created.model_id).toBeTruthy();
  const r = await new OpenAI({ baseURL: CT, apiKey: MASTER }).chat.completions.create({ model: 'added-by-api', messages: [{ role: 'user', content: 'hi' }] });
  expect(r.choices[0]!.message.content).toBeTruthy();
  expect((await master('/model/delete', { method: 'POST', body: JSON.stringify({ id: created.model_id }) })).status).toBe(200);

  const fromConfig = info.data.find((m: { model_name: string }) => m.model_name === 'gpt-4o').model_info;
  expect(fromConfig.db_model).toBe(false);
  expect((await master('/model/delete', { method: 'POST', body: JSON.stringify({ id: fromConfig.id }) })).status).toBe(400);
});

test('The master key calls models directly', async () => {
  const r = await new OpenAI({ baseURL: CT, apiKey: MASTER }).chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
  expect(r.choices[0]!.message.content).toBeTruthy();
});

test('MCP servers from the config, reached with x-litellm-api-key', async () => {
  const client = new Client({ name: 'litellm-style-client', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${CT}/mcp`), { requestInit: { headers: { 'x-litellm-api-key': `Bearer ${virtualKey}` } } }));
  await expect.poll(async () => (await client.listTools()).tools.map((t) => t.name), { timeout: 15_000 }).toContain('files__read_file');
  const out = await client.callTool({ name: 'files__read_file', arguments: { path: '/etc/motd' } });
  expect(JSON.stringify(out)).toContain('contents of /etc/motd');
  expect(mcp.calls.every((c) => c.headers.authorization === 'Bearer files-mcp-token')).toBe(true);
  await client.close();
});

test('/ui: sign in as admin with the master key (UI doc)', async ({ page }) => {
  await page.goto(`${CT}/ui`);
  await expect(page).toHaveURL(`${CT}/`);
  const field = (label: RegExp) => page.locator('.field', { has: page.locator('label', { hasText: label }) }).first().locator('input').first();
  await field(/^(Email|Username)/).fill('admin');
  await field(/^Password/).fill(MASTER);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('link', { name: 'Airspace', exact: true })).toBeVisible();
});

test('Restart with an edited config: nothing duplicated, edits applied, keys kept', async () => {
  const before = (await (await master('/model/info')).json()).data.length;
  await stopServer();
  // Drop "broken", add "gpt-4o-extra".
  fs.writeFileSync(
    configPath,
    configYaml(`  - model_name: gpt-4o-extra
    litellm_params:
      model: openai/gpt-4.1-mini
      api_base: ${oai.url}/v1
      api_key: os.environ/OPENAI_API_KEY`).replace(/  - model_name: broken[\s\S]*?api_key: sk-broken-upstream\n/, ''),
  );
  await startServer();
  const after = (await (await master('/model/info')).json()).data.map((m: { model_name: string }) => m.model_name);
  expect(after).toContain('gpt-4o-extra');
  expect(after).not.toContain('broken');
  expect(after.length).toBe(before); // one removed, one added: no duplicates
  expect(after).toContain('gpt-4.1'); // added on first use through openai/*, still there
  const added = await new OpenAI({ baseURL: CT, apiKey: MASTER }).chat.completions.create({ model: 'gpt-4o-extra', messages: [{ role: 'user', content: 'hi' }] });
  expect(added.choices[0]!.message.content).toBeTruthy();
  // Virtual keys live in the database, not the file: the key minted before the restart still works.
  const kept = await new OpenAI({ baseURL: CT, apiKey: virtualKey }).chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
  expect(kept.choices[0]!.message.content).toBeTruthy();
});

test('`--model provider/model` quick start and a bad config file', async () => {
  await stopServer();
  await startServer(['--model', 'openai/gpt-4.1-mini', '--port', String(PORT)]);
  const models = await (await master('/v1/models')).json();
  expect(models.data.map((m: { id: string }) => m.id)).toContain('openai/gpt-4.1-mini');
  await stopServer();

  // A config that cannot be parsed stops startup with a clear message, like LiteLLM.
  const bad = path.join(dataDir, 'bad.yaml');
  fs.writeFileSync(bad, 'model_list: [unclosed');
  const p = spawn('node', ['server/dist/server.mjs', '--config', bad, '--port', String(PORT + 1)], { env: { ...process.env, CT_DATA_DIR: dataDir, CT_UI_DIR: path.resolve('ui/dist') } });
  let out = '';
  p.stdout!.on('data', (d: Buffer) => (out += d.toString()));
  p.stderr!.on('data', (d: Buffer) => (out += d.toString()));
  const code = await new Promise<number | null>((r) => p.once('exit', r));
  expect(code).toBe(1);
  expect(out).toContain('not valid YAML');
});
