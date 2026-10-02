import { test, expect } from '@playwright/test';
import { execFile, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CT, admin } from './support/admin';
import { routingUpstream, type RoutingUpstream } from './support/routing-upstream';

/**
 * Laptop sign-in (Enterprise): ct-auth on a laptop starts a sign-in, the person approves it in the console, and
 * Claude Code, Claude Desktop or Codex call the gateway with short-lived tokens as that person. Rules pick the key;
 * revoking a sign-in, or removing the person, stops its tokens at once. The rollout files carry no secrets.
 */
test.describe.configure({ mode: 'serial' });

let up: RoutingUpstream;
let providerId = '';
let teamId = '';
const keys: Record<string, { id: string; key: string }> = {};
type Person = { id: string; email: string; call: (method: string, p: string, body?: unknown) => Promise<{ status: number; body: any }> };
let dana: Person;
let eve: Person;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-laptops-'));

async function person(email: string): Promise<Person> {
  const r = await admin.put(`/admin/api/teams/${teamId}/members`, { email, role: 'member' });
  const password = r.body.password as string;
  const login = async (pw: string) => {
    const l = await fetch(`${CT}/admin/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: pw }) });
    expect(l.status).toBe(200);
    return { cookie: l.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '), csrf: ((await l.json()) as { csrf: string }).csrf };
  };
  let s = await login(password);
  await fetch(`${CT}/admin/api/me/password`, { method: 'POST', headers: { cookie: s.cookie, 'x-ct-csrf': s.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ current: password, password: `${password}-mine` }) });
  s = await login(`${password}-mine`);
  const call = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(`${CT}${p}`, { method, headers: { cookie: s.cookie, 'x-ct-csrf': s.csrf, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const t = await res.text();
    let j: any = t;
    try {
      j = JSON.parse(t);
    } catch {
      /* text */
    }
    return { status: res.status, body: j };
  };
  const id = ((await admin.get('/admin/api/users')).body.users as any[]).find((u) => u.email === email).id;
  return { id, email, call };
}

const form = (p: string, body: Record<string, string>) => fetch(`${CT}${p}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
const start = (client: string, device = "Dana's MacBook") => form('/device/code', { client, device_name: device });
const poll = (code: string) => form('/device/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: code });
const refresh = (token: string) => form('/device/token', { grant_type: 'refresh_token', refresh_token: token });
const chat = (credential: string, header = 'authorization') =>
  fetch(`${CT}/v1/chat/completions`, { method: 'POST', headers: { [header]: header === 'authorization' ? `Bearer ${credential}` : credential, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'lap-model', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sign in end to end: start, approve as the person, poll for the tokens. */
async function signIn(who: Person, client: string) {
  const s = await start(client);
  expect((await who.call('POST', '/admin/api/me/devices/approve', { user_code: s.body.user_code })).status).toBe(200);
  const t = await poll(s.body.device_code);
  expect(t.status, JSON.stringify(t.body)).toBe(200);
  return t.body as { access_token: string; refresh_token: string; expires_in: number; key_name: string; person: string };
}

test.beforeAll(async () => {
  up = await routingUpstream('lap');
  await admin.signIn();
  const p = await admin.post('/admin/api/providers', { catalog_id: 'custom', name: 'Laptop upstream', slug: 'lapup', base_url: `${up.url}/v1`, credentials: { api_key: 'sk-lap' } });
  providerId = (p.body.provider ?? p.body).id;
  await admin.post('/admin/api/deployments', { provider_id: providerId, upstream_model: 'ok-lap', public_name: 'lap-model' });
  teamId = (await admin.post('/admin/api/teams', { name: 'laptop-eng' })).body.id;
  keys.eng = (await admin.post('/admin/api/keys', { name: 'claude-code-eng', team: 'laptop-eng', allowed_models: ['lap-model'] })).body;
  keys.all = (await admin.post('/admin/api/keys', { name: 'laptops-everyone', allowed_models: ['lap-model'] })).body;
  dana = await person('dana@laptops.test');
  eve = await person('eve@laptops.test');
  // Eve isn't in the team: only the catch-all rule covers her.
  await admin.del(`/admin/api/teams/${teamId}/members/${eve.id}`);
});

test.afterAll(async () => {
  await admin.put('/admin/api/devices/rules', { rules: [] });
  for (const u of ((await admin.get('/admin/api/users')).body.users as any[]).filter((x) => x.email.endsWith('@laptops.test'))) await admin.del(`/admin/api/users/${u.id}`);
  for (const k of Object.values(keys)) await admin.del(`/admin/api/keys/${k.id}`);
  await admin.del(`/admin/api/teams/${teamId}`);
  await admin.del(`/admin/api/providers/${providerId}`);
  await up.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('an admin sets the rules: which key each client\'s calls are made as, by team', async () => {
  expect((await admin.put('/admin/api/devices/rules', { rules: [{ client: 'cursor', key_id: keys.eng!.id }] })).status).toBe(400);
  expect((await admin.put('/admin/api/devices/rules', { rules: [{ client: 'claude-code', key_id: 'nope' }] })).status).toBe(400);
  const r = await admin.put('/admin/api/devices/rules', { rules: [{ client: 'claude-code', team_id: teamId, key_id: keys.eng!.id }, { client: '*', team_id: null, key_id: keys.all!.id }] });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const got = (await admin.get('/admin/api/devices')).body;
  expect(got.rules).toMatchObject([{ client: 'claude-code', team: 'laptop-eng', key: 'claude-code-eng' }, { client: '*', team: null, key: 'laptops-everyone' }]);
  expect(got.settings).toMatchObject({ session_days: 90, idle_days: 30, token_ttl_s: 3600 });
  // Members can't see everyone's laptops, or change the rules.
  expect((await dana.call('GET', '/admin/api/devices')).status).toBe(403);
  expect((await dana.call('PUT', '/admin/api/devices/rules', { rules: [] })).status).toBe(403);
});

test('a laptop signs in: the person sees what asked and as which key, approves, and the laptop gets its tokens once', async () => {
  expect((await start('cursor')).status).toBe(400);
  const s = await start('claude-code');
  expect(s.status).toBe(200);
  expect(s.body).toMatchObject({ user_code: expect.stringMatching(/^[B-DF-HJ-NP-TV-XZ]{4}-[B-DF-HJ-NP-TV-XZ]{4}$/), verification_uri: `${CT}/device`, interval: 5, expires_in: 600 });
  expect(s.body.verification_uri_complete).toBe(`${CT}/device?code=${s.body.user_code}`);
  // Not approved yet; polling faster than every 5 seconds is told to slow down.
  expect((await poll(s.body.device_code)).body.error).toBe('authorization_pending');
  expect((await poll(s.body.device_code)).body.error).toBe('slow_down');
  // The person looks the code up (in any case, without the dash) and sees the device, the client and the key.
  const pending = await dana.call('GET', `/admin/api/me/devices/pending?code=${s.body.user_code.replace('-', '').toLowerCase()}`);
  expect(pending.body).toMatchObject({ client: 'claude-code', client_name: 'Claude Code', device_name: "Dana's MacBook", key: { name: 'claude-code-eng' } });
  expect((await dana.call('GET', '/admin/api/me/devices/pending?code=BBBB-BBBB')).status).toBe(404);
  expect((await dana.call('POST', '/admin/api/me/devices/approve', { user_code: s.body.user_code })).status).toBe(200);
  expect((await dana.call('POST', '/admin/api/me/devices/approve', { user_code: s.body.user_code })).status).toBe(404);
  await sleep(4100);
  const t = await poll(s.body.device_code);
  expect(t.status, JSON.stringify(t.body)).toBe(200);
  expect(t.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, key_name: 'claude-code-eng', person: 'dana@laptops.test', access_token: expect.stringMatching(/^ct_dt_/), refresh_token: expect.stringMatching(/^ct_rt_/) });
  // Once only.
  expect((await poll(s.body.device_code)).body.error).toBe('invalid_grant');

  // Its calls are the rule's key, recorded as Dana's, whichever header the client sends the token in.
  const r = await chat(t.body.access_token);
  expect(r.status, await r.clone().text()).toBe(200);
  expect((await chat(t.body.access_token, 'x-api-key')).status).toBe(200);
  const flightId = r.headers.get('x-ct-flight-id')!;
  await expect.poll(async () => ((await admin.get(`/admin/api/flights?key_id=${keys.eng!.id}&limit=10`)).body.flights as any[]).find((f) => f.id === flightId)?.principal).toBe('dana@laptops.test');
  expect((await fetch(`${CT}/v1/models`, { headers: { authorization: `Bearer ${t.body.access_token}` } })).status).toBe(200);
  const mcp = await fetch(`${CT}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${t.body.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } }) });
  expect(mcp.status).toBe(200);
  // A token changed in any way is refused.
  const [payload, sig] = t.body.access_token.slice('ct_dt_'.length).split('.');
  const forged = `ct_dt_${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, 'base64url').toString()), k: keys.all!.id })).toString('base64url')}.${sig}`;
  expect((await chat(forged)).status).toBe(401);

  // Refreshing gives a new access token; the Ledger splits the key's spend by person.
  const again = await refresh(t.body.refresh_token);
  expect(again.status).toBe(200);
  expect(again.body.refresh_token).toBeUndefined();
  expect((await chat(again.body.access_token)).status).toBe(200);
  // (By this run's key: a retry of the file runs it all again, and the person's earlier calls stay in the Ledger.)
  await expect.poll(async () => ((await admin.get('/admin/api/ledger/people?window=24h')).body.people as any[]).find((p) => p.who === 'dana@laptops.test')?.keys.find((k: any) => k.key_id === keys.eng!.id)).toMatchObject({ key_name: 'claude-code-eng', requests: 3 });

  // Dana sees her sign-in; Eve doesn't, and can't end it.
  const mine = (await dana.call('GET', '/admin/api/me/devices')).body.sessions as any[];
  expect(mine).toHaveLength(1);
  expect(mine[0]).toMatchObject({ client: 'claude-code', device_name: "Dana's MacBook", status: 'active', key: { name: 'claude-code-eng' } });
  expect((await eve.call('GET', '/admin/api/me/devices')).body.sessions).toHaveLength(0);
  expect((await eve.call('DELETE', `/admin/api/me/devices/${mine[0].id}`)).status).toBe(404);

  // Revoked: its access token stops at once, and it can't refresh.
  expect((await dana.call('DELETE', `/admin/api/me/devices/${mine[0].id}`)).status).toBe(200);
  expect((await chat(again.body.access_token)).status).toBe(401);
  expect((await refresh(t.body.refresh_token)).body).toMatchObject({ error: 'invalid_grant', error_description: expect.stringContaining('revoked') });
});

test('the rules decide at every refresh; someone no rule covers can\'t approve; a refused sign-in gets nothing', async () => {
  // Eve is in no team: the catch-all rule.
  const e = await signIn(eve, 'codex');
  expect(e).toMatchObject({ key_name: 'laptops-everyone', person: 'eve@laptops.test' });
  // Dana's Claude Code moves to the catch-all key when her team's rule goes; Codex was always the catch-all.
  const d = await signIn(dana, 'claude-code');
  expect(d.key_name).toBe('claude-code-eng');
  await admin.put('/admin/api/devices/rules', { rules: [{ client: '*', team_id: null, key_id: keys.all!.id }] });
  expect((await refresh(d.refresh_token)).body.key_name).toBe('laptops-everyone');
  // No rule at all: the approval page says why, approving is refused, and refresh is refused (not ended).
  await admin.put('/admin/api/devices/rules', { rules: [] });
  const s = await start('claude-desktop');
  expect((await dana.call('GET', `/admin/api/me/devices/pending?code=${s.body.user_code}`)).body.problem).toContain('No laptop sign-in rule covers you for Claude Desktop');
  expect((await dana.call('POST', '/admin/api/me/devices/approve', { user_code: s.body.user_code })).status).toBe(409);
  expect((await refresh(d.refresh_token)).body.error).toBe('access_denied');
  await admin.put('/admin/api/devices/rules', { rules: [{ client: '*', team_id: null, key_id: keys.all!.id }] });
  expect((await refresh(d.refresh_token)).status).toBe(200);
  // Refused by the person: the laptop is told so.
  expect((await dana.call('POST', '/admin/api/me/devices/approve', { user_code: s.body.user_code, approve: false })).status).toBe(200);
  expect((await poll(s.body.device_code)).body.error).toBe('access_denied');
  // An admin sees every laptop and can end any sign-in.
  const all = (await admin.get('/admin/api/devices')).body.sessions as any[];
  const eves = all.find((x) => x.person === 'eve@laptops.test' && x.status === 'active');
  expect(eves).toMatchObject({ client: 'codex', client_name: 'Codex' });
  expect((await admin.del(`/admin/api/devices/${eves.id}`)).status).toBe(200);
  expect((await chat(e.access_token)).status).toBe(401);
});

test('removing a person ends their laptops\' sign-ins at once', async () => {
  const d = await signIn(dana, 'claude-code');
  expect((await chat(d.access_token)).status).toBe(200);
  expect((await admin.del(`/admin/api/users/${dana.id}`)).status).toBe(200);
  expect((await chat(d.access_token)).status).toBe(401);
  expect((await refresh(d.refresh_token)).body.error).toBe('invalid_grant');
});

test('ct-auth signs a laptop in end to end, caches its token, prints MCP headers, and signs out', async () => {
  await admin.put('/admin/api/devices/rules', { rules: [{ client: '*', team_id: null, key_id: keys.all!.id }] });
  const sam = await person('sam@laptops.test');
  const opened = path.join(tmp, 'opened.txt');
  const opener = path.join(tmp, 'open.sh');
  fs.writeFileSync(opener, `#!/bin/sh\nprintf '%s' "$1" > "${opened}"\n`, { mode: 0o755 });
  const env = { ...process.env, CT_AUTH_STORE: 'file', CT_AUTH_DIR: path.join(tmp, 'store'), CT_AUTH_OPEN: opener, CT_URL: CT, CT_AUTH_WAIT: '30' };
  const helper = path.resolve('server/src/ee/laptops/ct-auth.sh');
  // `token` with nobody signed in starts a sign-in, opens the browser at the approval page, and waits.
  const child = spawn('sh', [helper, 'token', '--client', 'claude-code'], { env });
  let out = '';
  let err = '';
  child.stdout.on('data', (b) => (out += b));
  child.stderr.on('data', (b) => (err += b));
  await expect.poll(() => (fs.existsSync(opened) ? fs.readFileSync(opened, 'utf8') : ''), { timeout: 10_000 }).toContain(`${CT}/device?code=`);
  const code = new URL(fs.readFileSync(opened, 'utf8')).searchParams.get('code')!;
  expect(err).toContain(code);
  expect((await sam.call('POST', '/admin/api/me/devices/approve', { user_code: code })).status).toBe(200);
  const exit = await new Promise<number>((r) => child.on('exit', (c) => r(c ?? -1)));
  expect(exit, err).toBe(0);
  const token = out.trim();
  expect(token).toMatch(/^ct_dt_/);
  expect((await chat(token)).status).toBe(200);
  // Again: the cached token, without asking Control Tower.
  const sh = (args: string[], extra: Record<string, string> = {}) =>
    new Promise<{ status: number; stdout: string; stderr: string }>((resolve) =>
      execFile('sh', [helper, ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 20_000 }, (e, stdout, stderr) => resolve({ status: e ? (typeof e.code === 'number' ? e.code : -1) : 0, stdout, stderr })),
    );
  const run = (...args: string[]) => sh([...args, '--client', 'claude-code']);
  const cached = await run('token');
  expect(cached.stdout.trim(), cached.stderr).toBe(token);
  expect(JSON.parse((await run('header')).stdout)).toEqual({ Authorization: `Bearer ${token}` });
  expect((await run('status')).stderr).toContain('as sam@laptops.test. Calls from Claude Code are made as the key laptops-everyone');
  // The refresh token is readable by its owner only.
  const stored = fs.readdirSync(path.join(tmp, 'store'));
  expect(stored.some((f) => f.endsWith('.refresh'))).toBe(true);
  for (const f of stored) expect(fs.statSync(path.join(tmp, 'store', f)).mode & 0o077).toBe(0);
  // Signing out ends the sign-in in Control Tower too.
  expect((await run('logout')).status).toBe(0);
  expect((await chat(token)).status).toBe(401);
  const after = await sh(['token', '--client', 'claude-code'], { CT_AUTH_NONINTERACTIVE: '1' });
  expect(after.status).toBe(1);
  // Without a person there (Claude Desktop's background refresh, say) it says how to sign in instead of waiting.
  const bg = await sh(['token', '--client', 'claude-desktop'], { CLAUDE_HELPER_CONTEXT: 'background' });
  expect(bg.status).toBe(1);
  expect(bg.stderr).toContain('ct-auth login --client claude-desktop');
});

test('the rollout files: every client set up for this address, with no secret in any of them', async () => {
  const r = await admin.get(`/admin/api/devices/rollout?url=${encodeURIComponent('https://ai.example.com')}&clients=claude-code,claude-desktop,codex`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const files = Object.fromEntries((r.body.files as any[]).map((f) => [f.name, f.content as string]));
  expect(Object.keys(files)).toEqual(expect.arrayContaining(['install-ct-auth-macos.sh', 'controltower.mobileconfig', 'install-controltower-windows.ps1', 'controltower-windows.reg', 'install-controltower-linux.sh', 'claude-code/managed-settings.json', 'claude-code/managed-mcp.json', 'codex/requirements.toml', 'ct-auth']));
  expect(JSON.parse(files['claude-code/managed-settings.json']!)).toEqual({
    env: { ANTHROPIC_BASE_URL: 'https://ai.example.com' },
    apiKeyHelper: '/usr/local/bin/ct-auth token --client claude-code',
    allowedProviders: ['customEndpoint'],
    allowManagedMcpServersOnly: true,
    allowedMcpServers: [{ serverUrl: 'https://ai.example.com/mcp*' }],
  });
  expect(files['codex/requirements.toml']).toContain('base_url = "https://ai.example.com/v1"');
  expect(files['install-controltower-windows.ps1']).toContain('\\"C:\\\\Program Files\\\\ControlTower\\\\ct-auth.cmd\\" token --client claude-code');
  for (const [name, content] of Object.entries(files)) expect(content, name).not.toMatch(/ct_sk_|ct_dt_[A-Za-z0-9]|ct_rt_[A-Za-z0-9]|BEGIN PRIVATE/);
  // Claude Desktop needs a Claude model listed: the keys here serve only lap-model, so the page says so.
  expect(r.body.warnings.join(' ')).toContain('Gateway returned no usable models');
  // The address must be a plain origin.
  expect((await admin.get(`/admin/api/devices/rollout?url=${encodeURIComponent('https://x.example.com/?q=1')}`)).status).toBe(400);
  expect((await admin.get('/admin/api/devices/rollout?clients=cursor')).status).toBe(400);
  // The helper can be fetched by hand, to try it before rolling it out.
  const sh = await fetch(`${CT}/device/ct-auth.sh`);
  expect(sh.status).toBe(200);
  expect(await sh.text()).toContain('ct-auth: signs this computer in, and prints short-lived tokens');
});

test('the install scripts write what they say (run into a scratch root), and the Windows ones parse', async () => {
  const r = await admin.get(`/admin/api/devices/rollout?url=${encodeURIComponent('https://ai.example.com')}`);
  const files = Object.fromEntries((r.body.files as any[]).map((f) => [f.name, f.content as string]));
  for (const name of ['install-ct-auth-macos.sh', 'install-controltower-linux.sh']) {
    const root = fs.mkdtempSync(path.join(tmp, 'root-'));
    const script = files[name]!.replace(/(["'\s])\/(usr\/local\/bin|Library|etc)\//g, `$1${root}/$2/`);
    const run = spawnSync('sh', ['-c', script], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    const installed = path.join(root, 'usr/local/bin/ct-auth');
    expect(fs.statSync(installed).mode & 0o111).not.toBe(0);
    expect(spawnSync('sh', [installed, 'version'], { encoding: 'utf8' }).stdout.trim()).toBe('ct-auth 2');
    expect(spawnSync('sh', [path.join(root, 'usr/local/bin/ct-auth-mcp-codex')], { encoding: 'utf8', env: { ...process.env, CT_URL: '' } }).stderr).toContain('ct-auth');
    const conf = name.includes('macos') ? 'Library/Application Support/ControlTower/ct-auth.conf' : 'etc/controltower/ct-auth.conf';
    expect(fs.readFileSync(path.join(root, conf), 'utf8').trim()).toBe('url=https://ai.example.com');
    if (name.includes('linux')) {
      expect(JSON.parse(fs.readFileSync(path.join(root, 'etc/claude-code/managed-settings.json'), 'utf8')).env.ANTHROPIC_BASE_URL).toBe('https://ai.example.com');
      expect(JSON.parse(fs.readFileSync(path.join(root, 'etc/claude-desktop/managed-settings.json'), 'utf8'))).toMatchObject({ inferenceProvider: 'gateway', inferenceCredentialHelper: `${root}/usr/local/bin/ct-auth-claude-desktop`, isLocalDevMcpEnabled: false });
      expect(fs.readFileSync(path.join(root, 'usr/local/bin/ct-auth-claude-desktop'), 'utf8')).toContain('token --client claude-desktop');
      expect(fs.readFileSync(path.join(root, 'etc/codex/requirements.toml'), 'utf8')).toContain('model_provider = "controltower"');
    } else {
      expect(JSON.parse(fs.readFileSync(path.join(root, 'Library/Application Support/ClaudeCode/managed-mcp.json'), 'utf8')).mcpServers.controltower.url).toBe('https://ai.example.com/mcp');
    }
  }
  // PowerShell (CI's Linux runners have it): the Windows installer parses, and the Windows helper signs in.
  if (spawnSync('pwsh', ['-v']).status !== 0) return;
  const ps1 = path.join(tmp, 'install.ps1');
  fs.writeFileSync(ps1, files['install-controltower-windows.ps1']!);
  const parse = spawnSync('pwsh', ['-NoProfile', '-Command', `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${ps1}', [ref]$null, [ref]$e); if ($e.Count) { $e | ForEach-Object { $_.Message }; exit 1 }`], { encoding: 'utf8' });
  expect(parse.status, parse.stdout + parse.stderr).toBe(0);
  await admin.put('/admin/api/devices/rules', { rules: [{ client: '*', team_id: null, key_id: keys.all!.id }] });
  const kim = await person('kim@laptops.test');
  const opened = path.join(tmp, 'opened-ps');
  const opener = path.join(tmp, 'open-ps.sh');
  fs.writeFileSync(opener, `#!/bin/sh\nprintf '%s' "$1" > "${opened}"\n`, { mode: 0o755 });
  const env = { ...process.env, CT_AUTH_DIR: path.join(tmp, 'ps-store'), CT_AUTH_OPEN: opener, CT_URL: CT, CT_AUTH_WAIT: '30' };
  const helper = path.resolve('server/src/ee/laptops/ct-auth.ps1');
  const child = spawn('pwsh', ['-NoProfile', '-File', helper, 'token', '--client', 'codex'], { env });
  let out = '';
  let err = '';
  child.stdout.on('data', (b) => (out += b));
  child.stderr.on('data', (b) => (err += b));
  await expect.poll(() => (fs.existsSync(opened) ? fs.readFileSync(opened, 'utf8') : ''), { timeout: 20_000 }).toContain('/device?code=');
  expect((await kim.call('POST', '/admin/api/me/devices/approve', { user_code: new URL(fs.readFileSync(opened, 'utf8')).searchParams.get('code') })).status).toBe(200);
  expect(await new Promise<number>((res) => child.on('exit', (c) => res(c ?? -1))), err).toBe(0);
  const token = out.trim();
  expect((await chat(token)).status).toBe(200);
  const header = spawnSync('pwsh', ['-NoProfile', '-File', helper, 'header', '--client', 'codex'], { env, encoding: 'utf8' });
  expect(JSON.parse(header.stdout)).toEqual({ Authorization: `Bearer ${token}` });
  expect(spawnSync('pwsh', ['-NoProfile', '-File', helper, 'logout', '--client', 'codex'], { env, encoding: 'utf8' }).status).toBe(0);
  expect((await chat(token)).status).toBe(401);
});

test('signing in with the identity provider: no Control Tower account, the issuer\'s rules pick the key', async () => {
  const { testIdp } = await import('./support/oidc-idp');
  const idp = await testIdp({ clientId: 'ct-laptops' });
  let issuerId = '';
  try {
    idp.user = { sub: 'okta-riley', email: 'riley@laptops.test', groups: ['eng'] };
    const made = await admin.post('/admin/api/token-issuers', { name: 'Okta', issuer: idp.url, jwks_uri: `${idp.url}/jwks`, audiences: ['ct-laptops'], rules: [{ claims: { groups: 'eng' }, key_id: keys.eng!.id }], principal_claim: 'email', people: true });
    const seatsBefore = (await admin.get('/admin/api/license')).body.seats_used as number;
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    issuerId = made.body.id;
    // The rollout files carry the identity provider; its client ID must be an accepted audience.
    expect((await admin.get(`/admin/api/devices/rollout?idp_issuer_id=${issuerId}&idp_client_id=someone-else`)).body.error.message).toContain('accepted audiences');
    const r = await admin.get(`/admin/api/devices/rollout?url=${encodeURIComponent('https://ai.example.com')}&idp_issuer_id=${issuerId}&idp_client_id=ct-laptops`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.idp).toMatchObject({ name: 'Okta', principal_claim: 'email', rules: 1 });
    expect((r.body.files as any[]).find((f) => f.name === 'install-controltower-linux.sh').content).toContain(`url=https://ai.example.com\nidp_issuer=${idp.url}\nidp_client_id=ct-laptops\n`);

    // A laptop with that configuration: ct-auth signs in at the identity provider (opening the link approves it).
    const conf = path.join(tmp, 'idp.conf');
    fs.writeFileSync(conf, `url=${CT}\nidp_issuer=${idp.url}\nidp_client_id=ct-laptops\n`);
    const opener = path.join(tmp, 'idp-open.sh');
    fs.writeFileSync(opener, '#!/bin/sh\ncurl -s "$1" >/dev/null\n', { mode: 0o755 });
    const env = { ...process.env, CT_AUTH_STORE: 'file', CT_AUTH_DIR: path.join(tmp, 'idp-store'), CT_AUTH_OPEN: opener, CT_AUTH_CONF: conf, CT_URL: '', CT_AUTH_WAIT: '20' };
    const helper = path.resolve('server/src/ee/laptops/ct-auth.sh');
    const sh = (args: string[]) =>
      new Promise<{ status: number; stdout: string; stderr: string }>((resolve) =>
        execFile('sh', [helper, ...args, '--client', 'claude-code'], { env, encoding: 'utf8', timeout: 30_000 }, (e, stdout, stderr) => resolve({ status: e ? (typeof e.code === 'number' ? e.code : -1) : 0, stdout, stderr })),
      );
    const login = await sh(['login']);
    expect(login.status, login.stderr).toBe(0);
    expect(login.stderr).toContain('Sign in with your work account');
    expect(login.stderr).toContain('Signed in as riley@laptops.test');
    const t1 = (await sh(['token'])).stdout.trim();
    // Its token is the identity provider's ID token: the issuer's rule makes it the engineering key, recorded as Riley.
    expect(t1.split('.')).toHaveLength(3);
    const call = await chat(t1);
    expect(call.status, await call.clone().text()).toBe(200);
    const flightId = call.headers.get('x-ct-flight-id')!;
    await expect.poll(async () => ((await admin.get(`/admin/api/flights?key_id=${keys.eng!.id}&limit=20`)).body.flights as any[]).find((f) => f.id === flightId)?.principal).toBe('Okta · riley@laptops.test');
    expect((await sh(['status'])).stderr).toContain(`Signed in with ${idp.url} as riley@laptops.test`);
    // Its tokens are people: Riley now uses a seat (once, however many tokens).
    expect((await admin.get('/admin/api/license')).body.seats_used).toBe(seatsBefore + 1);
    expect(((await admin.get('/admin/api/token-issuers')).body.issuers as any[]).find((i) => i.id === issuerId)).toMatchObject({ people: true, people_seen: 1 });
    // ID tokens last 5 minutes here, so the next call refreshes (the refresh token rotates) and gets a new one.
    const t2 = (await sh(['token'])).stdout.trim();
    expect(t2).not.toBe(t1);
    expect(idp.deviceGrants).toContain('refresh_token');
    expect((await chat(t2)).status).toBe(200);
    expect((await admin.get('/admin/api/license')).body.seats_used).toBe(seatsBefore + 1);
    // MCP clients get the same token.
    expect(JSON.parse((await sh(['header'])).stdout).Authorization).toMatch(/^Bearer ey/);
    // Signing out revokes the refresh token at the identity provider.
    expect((await sh(['logout'])).status).toBe(0);
    expect(idp.revoked).toHaveLength(1);
    // Someone outside the group the rule names gets a token, but Control Tower refuses it.
    idp.user = { sub: 'okta-sam', email: 'sam@laptops.test', groups: ['sales'] };
    expect((await sh(['login'])).status).toBe(0);
    expect((await chat((await sh(['token'])).stdout.trim())).status).toBe(401);
    await sh(['logout']);

    // The same with the Windows helper, where PowerShell is available.
    if (spawnSync('pwsh', ['-v']).status !== 0) return;
    idp.user = { sub: 'okta-riley', email: 'riley@laptops.test', groups: ['eng'] };
    const ps = path.resolve('server/src/ee/laptops/ct-auth.ps1');
    const psEnv = { ...env, CT_AUTH_DIR: path.join(tmp, 'idp-ps-store') };
    // Asynchronously: the identity provider runs in this process, and a blocking call would stop it answering.
    const pwsh = (args: string[]) =>
      new Promise<{ status: number; stdout: string; stderr: string }>((resolve) =>
        execFile('pwsh', ['-NoProfile', '-File', ps, ...args, '--client', 'codex'], { env: psEnv, encoding: 'utf8', timeout: 40_000 }, (e, stdout, stderr) => resolve({ status: e ? (typeof e.code === 'number' ? e.code : -1) : 0, stdout, stderr })),
      );
    const psLogin = await pwsh(['login']);
    expect(psLogin.status, psLogin.stderr).toBe(0);
    const psTok = (await pwsh(['token'])).stdout.trim();
    expect((await chat(psTok)).status).toBe(200);
  } finally {
    if (issuerId) await admin.del(`/admin/api/token-issuers/${issuerId}`);
    await idp.close();
  }
});

test("a person's app is told in words what a gate decided; their held call is theirs on the card, and goes through once approved", async () => {
  await admin.put('/admin/api/devices/rules', { rules: [{ client: '*', team_id: null, key_id: keys.all!.id }] });
  const fay = await person('fay@laptops.test');
  const t = await signIn(fay, 'claude-desktop');
  // Claude Desktop's calls: its token, and the User-Agent it sends.
  const ask = (text: string, as: { credential?: string; ua?: string } = {}) =>
    fetch(`${CT}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': as.credential ?? t.access_token, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'user-agent': as.ua ?? 'claude-cli/2.1.286 (external, claude-desktop-3p, agent-sdk/0.3.286)' },
      body: JSON.stringify({ model: 'lap-model', max_tokens: 5, messages: [{ role: 'user', content: text }] }),
    }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
  const agent = { credential: keys.all!.key, ua: 'my-agent/1.0' };
  const rules: string[] = [];
  const rule = async (body: Record<string, unknown>) => {
    const r = await admin.post('/admin/api/rules', { target_kind: 'model', match: { keys: [keys.all!.id] }, ...body });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    rules.push(r.body.id);
    return r.body.id as string;
  };
  try {
    expect((await ask('hello')).status).toBe(200);

    // Blocked by an inspect gate: a 400 the app shows, saying what, which gate, why, and what to do.
    const insp = await rule({ name: 'No credentials to models', effect: 'inspect', config: { detectors: ['secrets'], action: 'block', direction: 'input', reason: 'Credentials must never be sent to a model' }, priority: 1 });
    const blocked = await ask('is this key live? AKIAIOSFODNN7EXAMPLE');
    expect(blocked.status).toBe(400);
    expect(blocked.body.error).toMatchObject({ type: 'invalid_request_error', code: 'content_blocked' });
    expect(blocked.body.error.message).toBe('Control Tower blocked this message: it contains AWS access key (gate “No credentials to models”). Credentials must never be sent to a model. Remove it and send your message again.');
    // An agent's refusal is unchanged.
    const agentBlocked = await ask('is this key live? AKIAIOSFODNN7EXAMPLE', agent);
    expect(agentBlocked.status).toBe(400);
    expect(agentBlocked.body.error.message).toMatch(/^CONTROL_TOWER_CONTENT_BLOCKED: /);
    await admin.del(`/admin/api/rules/${insp}`);

    // Denied by a gate: 400 in words for the person (a 403 reads to Claude as a failed sign-in); 403 for the agent.
    const deny = await rule({ name: 'Not this model today', effect: 'deny', config: { reason: 'Ask your manager first' }, priority: 1 });
    const denied = await ask('hello');
    expect(denied.status).toBe(400);
    expect(denied.body.error).toMatchObject({ code: 'policy_denied', message: 'Control Tower blocked this request (gate “Not this model today”): Ask your manager first.' });
    expect((await ask('hello', agent)).status).toBe(403);
    // The app is known from its User-Agent too: Claude Code in a terminal, with a plain key.
    expect((await ask('hello', { credential: keys.all!.key, ua: 'claude-cli/2.1.286 (external, cli)' })).status).toBe(400);
    await admin.del(`/admin/api/rules/${deny}`);

    // Held, and the approver says no: the card names the person and the app; the person reads who said no, and why.
    const hold = await rule({ name: 'A manager approves', effect: 'require_approval', config: { hold_ms: 8000 }, priority: 1 });
    const pending = async () => ((await admin.get('/admin/api/approvals?status=pending')).body.approvals as any[]).filter((a) => a.key_id === keys.all!.id);
    const waiting = ask('draft the board update');
    await expect.poll(async () => (await pending()).length).toBe(1);
    const [card] = await pending();
    expect(card).toMatchObject({ requester: 'fay@laptops.test', client: 'claude-desktop' });
    await admin.post(`/admin/api/approvals/${card.id}/decide`, { action: 'deny', note: 'Not before the audit closes' });
    const no = await waiting;
    expect(no.status).toBe(400);
    expect(no.body.error.code).toBe('policy_denied');
    expect(no.body.error.message).toMatch(/^Control Tower: your request was denied by .+: Not before the audit closes \(gate “A manager approves”\)\.$/);

    // Nobody answers within the hold: told it's waiting; approved later, the same message again goes through, once.
    await admin.patch(`/admin/api/rules/${hold}`, { config: { hold_ms: 1500 } });
    const ticketed = await ask('draft the investor update');
    expect(ticketed.status).toBe(400);
    expect(ticketed.body.error.code).toBe('approval_required');
    expect(ticketed.body.error.message).toMatch(/^Control Tower: this request needs approval \(gate “A manager approves”\)\. An approver has been asked; once they approve, send the same message again\./);
    const [later] = await pending();
    await admin.post(`/admin/api/approvals/${later.id}/decide`, { action: 'approve' });
    expect((await ask('draft the investor update')).status).toBe(200);
    expect((await ask('draft the investor update')).status).toBe(400);
    // Someone else sending the same words doesn't ride on Fay's approval.
    const other = await signIn(eve, 'claude-desktop');
    const [again] = await pending();
    await admin.post(`/admin/api/approvals/${again.id}/decide`, { action: 'approve' });
    expect((await ask('draft the investor update', { credential: other.access_token })).status).toBe(400);
  } finally {
    for (const id of rules) await admin.del(`/admin/api/rules/${id}`);
  }
});
