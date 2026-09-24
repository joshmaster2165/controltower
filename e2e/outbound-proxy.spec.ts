import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { openAiUpstream, webhookReceiver, type Upstream } from './support/upstreams';

/**
 * Outbound proxy: with HTTP_PROXY set, Control Tower's own calls — to model
 * providers and to alert channels — go through it; NO_PROXY bypasses it.
 * Runs its own server, like a deployment behind a corporate proxy.
 */
test.describe.configure({ mode: 'serial' });

const PORT = 4471;
const CT = `http://127.0.0.1:${PORT}`;
const ADMIN = 'outbound-proxy-admin-key-0123456789';

/** A minimal forward proxy for http:// targets that records every request it relays. */
async function forwardProxy(): Promise<{ url: string; seen: string[]; close(): Promise<void> }> {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const target = new URL(req.url!);
    const up = http.request({ host: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => res.writeHead(502).end());
    req.pipe(up);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => new Promise((r) => server.close(() => r())) };
}

let server: ChildProcess | undefined;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-proxy-'));
async function start(env: Record<string, string>): Promise<void> {
  server = spawn('node', ['server/dist/server.mjs', '--port', String(PORT)], {
    env: { ...process.env, CT_DATA_DIR: dataDir, CT_UI_DIR: path.resolve('ui/dist'), CT_LOG_LEVEL: 'warn', CT_ADMIN_KEY: ADMIN, HTTP_PROXY: '', HTTPS_PROXY: '', NO_PROXY: '', ...env },
    stdio: 'ignore',
  });
  await expect.poll(async () => (await fetch(`${CT}/healthz`).catch(() => undefined))?.status, { timeout: 20_000 }).toBe(200);
}
async function stop(): Promise<void> {
  if (!server) return;
  const done = new Promise((r) => server!.once('exit', r));
  server.kill('SIGTERM');
  await done;
  server = undefined;
}
const admin = (p: string, body?: unknown) =>
  fetch(`${CT}${p}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).then((r) => r.json());

let upstream: Upstream;
let hook: Upstream;
let proxy: Awaited<ReturnType<typeof forwardProxy>>;
let agentKey = '';
test.beforeAll(async () => {
  upstream = await openAiUpstream();
  hook = await webhookReceiver();
  proxy = await forwardProxy();
});
test.afterAll(async () => {
  await stop();
  await Promise.all([upstream.close(), hook.close(), proxy.close()]);
});

const chat = () =>
  fetch(`${CT}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${agentKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'hi' }] }) });

test('with HTTP_PROXY, provider calls and alert deliveries go through the proxy', async () => {
  await start({ HTTP_PROXY: proxy.url });
  await admin('/admin/api/providers', { catalog_id: 'custom', name: 'Upstream', slug: 'upstream', base_url: `${upstream.url}/v1`, credentials: { api_key: 'sk-upstream' } });
  agentKey = (await admin('/admin/api/keys', { name: 'proxied-agent' })).key;

  const r = await chat();
  expect(r.status).toBe(200);
  expect(proxy.seen.some((s) => s.startsWith(`POST ${upstream.url}/v1/chat/completions`))).toBe(true);
  expect(upstream.calls.at(-1)?.headers.authorization).toBe('Bearer sk-upstream');

  // Alert webhooks use fetch: proxied too.
  const channel = await admin('/admin/api/alert-channels', { kind: 'webhook', name: 'Hook', url: `${hook.url}/hook` });
  expect((await admin(`/admin/api/alert-channels/${channel.id}/test`, {})).ok).toBe(true);
  expect(proxy.seen.some((s) => s.startsWith(`POST ${hook.url}/hook`))).toBe(true);
});

test('NO_PROXY bypasses the proxy', async () => {
  await stop();
  const before = proxy.seen.length;
  await start({ HTTP_PROXY: proxy.url, NO_PROXY: '127.0.0.1' });
  expect((await chat()).status).toBe(200);
  expect(proxy.seen.length).toBe(before);
});
