import { test, expect } from '@playwright/test';
import { CT, admin } from './support/admin';

/**
 * The audit log: changes made through the admin API are recorded with who made them and what they touched,
 * refused attempts too, sign-ins, never a secret; admins alone read it, export it and verify its chain.
 */
test.describe.configure({ mode: 'serial' });

const SECRET = 'sk-proj-audit-secret-0123456789';
async function eventsFor(filter: (e: any) => boolean, timeoutMs = 5000): Promise<any[]> {
  const t = Date.now();
  for (;;) {
    const r = await admin.get('/admin/api/audit?limit=200');
    const found = (r.body.events as any[]).filter(filter);
    if (found.length || Date.now() - t > timeoutMs) return found;
    await new Promise((res) => setTimeout(res, 150));
  }
}

let keyId = '';
let providerId = '';
let viewerId = '';

test.beforeAll(async () => {
  await admin.signIn();
});
test.afterAll(async () => {
  if (keyId) await admin.del(`/admin/api/keys/${keyId}`);
  if (providerId) await admin.del(`/admin/api/providers/${providerId}`);
  if (viewerId) await admin.del(`/admin/api/users/${viewerId}`);
});

test('a change is recorded with who made it and what it created; secrets never are', async () => {
  const k = await admin.post('/admin/api/keys', { name: 'audited-agent', agent_id: 'audited-agent' });
  keyId = k.body.id;
  const [e] = await eventsFor((x) => x.action === 'keys.create' && x.target?.id === keyId);
  expect(e).toMatchObject({ outcome: 'success', status: 201, actor: { type: 'person', email: 'e2e@example.com', role: 'admin' }, target: { type: 'keys', id: keyId } });
  expect(e.detail).toMatchObject({ method: 'POST', route: '/admin/api/keys', body: { name: 'audited-agent' } });
  expect(JSON.stringify(e)).not.toContain(k.body.key); // the key the answer carried is not in the log

  const p = await admin.post('/admin/api/providers', { catalog_id: 'openai', name: 'Audited OpenAI', slug: 'auditoai', credentials: { api_key: SECRET } });
  providerId = (p.body.provider ?? p.body).id;
  const [pe] = await eventsFor((x) => x.action === 'providers.create' && x.target?.id === providerId);
  expect(pe.detail.body).toMatchObject({ name: 'Audited OpenAI', credentials: '[redacted]' });
});

test('refused attempts are recorded, and only admins read the log', async () => {
  const u = await admin.post('/admin/api/users', { email: 'audit-viewer@example.com', role: 'viewer' });
  viewerId = u.body.id;
  const login = await fetch(`${CT}/admin/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'audit-viewer@example.com', password: u.body.password }) });
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const csrf = ((await login.json()) as any).csrf;
  await fetch(`${CT}/admin/api/me/password`, { method: 'POST', headers: { cookie, 'x-ct-csrf': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ current: u.body.password, password: 'audit-viewer-pass-1' }) });

  const tried = await fetch(`${CT}/admin/api/keys`, { method: 'POST', headers: { cookie, 'x-ct-csrf': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'sneaky' }) });
  expect(tried.status).toBe(403);
  const [d] = await eventsFor((x) => x.action === 'keys.create' && x.actor.email === 'audit-viewer@example.com');
  expect(d).toMatchObject({ outcome: 'denied', status: 403, actor: { role: 'viewer' }, detail: { refused: 'forbidden' } });
  // Their password change is recorded, without the passwords.
  const [pw] = await eventsFor((x) => x.action === 'me.password.change' && x.actor.email === 'audit-viewer@example.com');
  expect(pw.detail.body).toEqual({ current: '[redacted]', password: '[redacted]' });
  // Signing in is recorded.
  expect((await eventsFor((x) => x.action === 'auth.sign_in' && x.actor.email === 'audit-viewer@example.com' && x.outcome === 'success')).length).toBeGreaterThan(0);

  for (const path of ['/admin/api/audit', '/admin/api/audit/verify', '/admin/api/audit/export']) {
    expect((await fetch(`${CT}${path}`, { headers: { cookie } })).status, path).toBe(403);
  }
  const anon = await fetch(`${CT}/admin/api/rules/nope`, { method: 'DELETE' });
  expect(anon.status).toBe(401);
  expect((await eventsFor((x) => x.action === 'rules.delete' && x.actor.type === 'anonymous')).length).toBeGreaterThan(0);
});

test('the log exports as CSV and JSON Lines, and its chain verifies', async () => {
  const v = await admin.get('/admin/api/audit/verify');
  expect(v.body).toMatchObject({ ok: true });
  expect(v.body.events).toBeGreaterThan(3);

  const csv = await fetch(`${CT}/admin/api/audit/export?format=csv`, { headers: { cookie: admin.cookie } });
  expect(csv.headers.get('content-disposition')).toMatch(/attachment; filename="controltower-audit-.*\.csv"/);
  const text = await csv.text();
  expect(text.split('\n')[0]).toBe('seq,time,actor_type,actor_email,actor_role,action,outcome,status,target_type,target_id,ip,request_id,detail,hash');
  expect(text).toContain('keys.create');
  expect(text).not.toContain(SECRET);

  const jsonl = await (await fetch(`${CT}/admin/api/audit/export`, { headers: { cookie: admin.cookie } })).text();
  const rows = jsonl.trim().split('\n').map((l) => JSON.parse(l));
  // Oldest first, each pointing at the one before.
  for (let i = 1; i < rows.length; i++) {
    expect(rows[i].seq).toBe(rows[i - 1].seq + 1);
    expect(rows[i].prev_hash).toBe(rows[i - 1].hash);
  }
});

test('the console shows the log and checks it', async ({ page }) => {
  await page.context().addCookies(admin.cookie.split('; ').map((c) => ({ name: c.split('=')[0]!, value: c.split('=').slice(1).join('='), url: CT })));
  await page.goto(`${CT}/#/audit`);
  await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
  await expect(page.locator('td.mono', { hasText: 'keys.create' }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('status')).toContainText('Intact');
  await page.getByPlaceholder('Person (email)').fill('audit-viewer@example.com');
  await expect(page.locator('td', { hasText: 'refused' }).first()).toBeVisible();
});
