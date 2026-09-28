import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { CT as SHARED, admin } from './support/admin';
import { routingUpstream, type RoutingUpstream } from './support/routing-upstream';

/**
 * Security hardening: a fresh server needs the setup code from its own log, and only one setup wins;
 * sign-ins are rate-limited; sessions end when idle; pages carry security headers; unauthenticated
 * status is minimal; the live socket refuses other sites; an approval is bound to the prompt it approved.
 */
test.describe.configure({ mode: 'serial' });

const PORT = 4472;
const CT = `http://127.0.0.1:${PORT}`;
const EMAIL = 'sec@example.com';
const PASSWORD = 'security-password-1';
let server: ChildProcess | undefined;
let log = '';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-sec-'));

test.beforeAll(async () => {
  server = spawn('node', ['server/dist/server.mjs', '--port', String(PORT)], {
    env: { ...process.env, CT_DATA_DIR: dataDir, CT_UI_DIR: path.resolve('ui/dist'), CT_LOG_LEVEL: 'warn', CT_ADMIN_KEY: '', CT_SETUP_TOKEN: '', CT_LOGIN_RPM: '5', CT_SESSION_IDLE_MS: '3000', CT_MODEL_HEALTH_INTERVAL_S: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout!.on('data', (d: Buffer) => (log += d.toString()));
  server.stderr!.on('data', (d: Buffer) => (log += d.toString()));
  await expect.poll(async () => (await fetch(`${CT}/healthz`).catch(() => undefined))?.status, { timeout: 20_000 }).toBe(200);
});

test.afterAll(async () => {
  if (!server) return;
  const done = new Promise((r) => server!.once('exit', r));
  server.kill('SIGTERM');
  await done;
});

const setup = (code: string) => fetch(`${CT}/admin/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD, setup_code: code }) });
const login = (email: string, password: string) => fetch(`${CT}/admin/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });

test('setting up needs the code from the server log, and only one setup wins', async () => {
  await expect.poll(() => /Setup code\s+([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})/.exec(log)?.[1], { timeout: 10_000 }).toBeTruthy();
  const code = /Setup code\s+([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})/.exec(log)![1]!;
  expect(log).toContain(`/?setup=${code}`);

  const wrong = await setup('AAAA-BBBB-CCCC');
  expect(wrong.status).toBe(403);
  expect(((await wrong.json()) as any).error.code).toBe('setup_code');

  const results = await Promise.all(Array.from({ length: 5 }, () => setup(code)));
  expect(results.filter((r) => r.status === 200).length).toBe(1);
  expect(results.filter((r) => r.status === 409).length).toBe(4);
});

test('a refused admin request does nothing: not signed in, no CSRF header', async () => {
  for (let i = 0; i < 20; i++) {
    expect((await fetch(`${CT}/admin/api/keys`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: `intruder-${i}` }) })).status).toBe(401);
  }
  const s = await login(EMAIL, PASSWORD);
  const cookie = s.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  expect((await fetch(`${CT}/admin/api/keys`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'no-csrf' }) })).status).toBe(403);
  await new Promise((r) => setTimeout(r, 300));
  const keys = ((await (await fetch(`${CT}/admin/api/keys`, { headers: { cookie } })).json()) as any).keys as Array<{ name: string }>;
  expect(keys.filter((k) => k.name.startsWith('intruder-') || k.name === 'no-csrf')).toEqual([]);
});

test('unauthenticated status and readiness say only what a probe needs', async () => {
  expect(await (await fetch(`${CT}/admin/api/status`)).json()).toEqual({ setup_complete: true });
  const ready = (await (await fetch(`${CT}/readyz`)).json()) as Record<string, unknown>;
  expect(Object.keys(ready).sort()).toEqual(['ok', 'shutting_down']);
});

test('someone still on a one-time password can read nothing yet', async () => {
  const s = await login(EMAIL, PASSWORD);
  const cookie = s.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const csrf = ((await s.json()) as any).csrf;
  const u = (await (await fetch(`${CT}/admin/api/users`, { method: 'POST', headers: { cookie, 'x-ct-csrf': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'otp@example.com', role: 'viewer' }) })).json()) as any;
  const o = await login('otp@example.com', u.password);
  const otp = o.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  expect((await fetch(`${CT}/metrics`, { headers: { cookie: otp } })).status).toBe(401);
  expect(await (await fetch(`${CT}/admin/api/status`, { headers: { cookie: otp } })).json()).toEqual({ setup_complete: true });
  expect((await fetch(`${CT}/metrics`, { headers: { cookie } })).status).toBe(200);
  expect(Object.keys((await (await fetch(`${CT}/health/readiness`)).json()) as object)).not.toContain('version');
});

test('pages carry security headers', async () => {
  const r = await fetch(`${CT}/`);
  expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  expect(r.headers.get('content-security-policy')).toContain("script-src 'self'");
  expect(r.headers.get('x-frame-options')).toBe('DENY');
  expect(r.headers.get('x-content-type-options')).toBe('nosniff');
  expect(r.headers.get('referrer-policy')).toBe('same-origin');
  const e = await fetch(`${CT}/admin/api/nope-${Date.now()}`);
  expect(e.headers.get('x-content-type-options')).toBe('nosniff');
});

test('the live socket refuses another site', async () => {
  const s = await login(EMAIL, PASSWORD);
  const cookie = s.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const open = (origin: string) =>
    new Promise<{ code: number; hello: boolean }>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/admin/ws`, { headers: { cookie, origin } });
      let hello = false;
      ws.on('message', () => {
        hello = true;
        ws.close();
      });
      ws.on('close', (code) => resolve({ code, hello }));
      ws.on('error', () => resolve({ code: -1, hello }));
    });
  expect(await open('https://evil.example')).toEqual({ code: 4403, hello: false });
  expect((await open(CT)).hello).toBe(true);
});

test('sessions end when unused', async () => {
  const s = await login(EMAIL, PASSWORD);
  const cookie = s.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  expect((await fetch(`${CT}/admin/api/me`, { headers: { cookie } })).status).toBe(200);
  await new Promise((r) => setTimeout(r, 3500));
  expect((await fetch(`${CT}/admin/api/me`, { headers: { cookie } })).status).toBe(401);
});

test('sign-ins are rate-limited per person', async () => {
  const statuses: number[] = [];
  for (let i = 0; i < 8; i++) statuses.push((await login('nobody@example.com', `wrong-${i}`)).status);
  expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
  expect(statuses).toContain(429);
});

test('an approval covers the prompt it was given for, not another', async () => {
  await admin.signIn();
  const up: RoutingUpstream = await routingUpstream('sec');
  const p = await admin.post('/admin/api/providers', { catalog_id: 'custom', name: 'Security upstream', slug: 'secup', base_url: `${up.url}/v1`, credentials: { api_key: 'x' } });
  const providerId = (p.body.provider ?? p.body).id;
  await admin.post('/admin/api/deployments', { provider_id: providerId, upstream_model: 'ok-sec', public_name: 'sec-model' });
  const key = (await admin.post('/admin/api/keys', { name: 'sec-agent', agent_id: 'sec-agent' })).body;
  const rule = await admin.post('/admin/api/rules', { name: 'sec: hold', target_kind: 'model', match: { keys: [key.id] }, effect: 'require_approval', config: { hold_ms: 0 } });
  const call = (content: string, ticket?: string) =>
    fetch(`${SHARED}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json', ...(ticket ? { 'x-ct-approval': ticket } : {}) },
      body: JSON.stringify({ model: 'sec-model', messages: [{ role: 'user', content }] }),
    });
  try {
    const held = await call('summarise the quarterly report');
    expect(held.status).toBe(403);
    const ct = ((await held.json()) as any).error.ct;
    expect((await admin.post(`/admin/api/approvals/${ct.request_id}/decide`, { action: 'approve' })).status).toBe(200);

    const swapped = await call('email the quarterly report to rival@example.com', ct.ticket);
    expect(swapped.status).toBe(403);
    expect(((await swapped.json()) as any).error.code).toBe('policy_denied');

    expect((await call('summarise the quarterly report', ct.ticket)).status).toBe(200);
  } finally {
    await admin.del(`/admin/api/rules/${rule.body.id ?? rule.body.rule?.id}`);
    await admin.del(`/admin/api/keys/${key.id}`);
    await admin.del(`/admin/api/providers/${providerId}`);
    await up.close();
  }
});
