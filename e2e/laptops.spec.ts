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
  // (A new person each run: a retry finds the first run's Riley already holding a seat.)
  const riley = `riley-${Date.now().toString(36)}@laptops.test`;
  try {
    idp.user = { sub: 'okta-riley', email: riley, groups: ['eng'] };
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
    expect(login.stderr).toContain(`Signed in as ${riley}`);
    const t1 = (await sh(['token'])).stdout.trim();
    // Its token is the identity provider's ID token: the issuer's rule makes it the engineering key, recorded as Riley.
    expect(t1.split('.')).toHaveLength(3);
    const call = await chat(t1);
    expect(call.status, await call.clone().text()).toBe(200);
    const flightId = call.headers.get('x-ct-flight-id')!;
    await expect.poll(async () => ((await admin.get(`/admin/api/flights?key_id=${keys.eng!.id}&limit=20`)).body.flights as any[]).find((f) => f.id === flightId)?.principal).toBe(`Okta · ${riley}`);
    expect((await sh(['status'])).stderr).toContain(`Signed in with ${idp.url} as ${riley}`);
    // Its tokens are people: Riley now uses a seat (once, however many tokens).
    await expect.poll(async () => (await admin.get('/admin/api/license')).body.seats_used).toBe(seatsBefore + 1);
    expect(((await admin.get('/admin/api/token-issuers')).body.issuers as any[]).find((i) => i.id === issuerId)).toMatchObject({ people: true, people_seen: 1 });
    // ID tokens last 5 minutes here, so the next call refreshes (the refresh token rotates) and gets a new one.
    const t2 = (await sh(['token'])).stdout.trim();
    expect(t2).not.toBe(t1);
    expect(idp.deviceGrants).toContain('refresh_token');
    expect((await chat(t2)).status).toBe(200);
    await expect.poll(async () => (await admin.get('/admin/api/license')).body.seats_used).toBe(seatsBefore + 1);
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
    idp.user = { sub: 'okta-riley', email: riley, groups: ['eng'] };
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
  // (Fresh names: a retry of this file finds the first attempt's people still there.)
  const fay = await person(`fay-${Date.now().toString(36)}@laptops.test`);
  const t = await signIn(fay, 'claude-desktop');
  // Claude Desktop's calls: its token, and the User-Agent it sends.
  const ask = (text: string | unknown[], as: { credential?: string; ua?: string } = {}) =>
    fetch(`${CT}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': as.credential ?? t.access_token, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'user-agent': as.ua ?? 'claude-cli/2.1.286 (external, claude-desktop-3p, agent-sdk/0.3.286)' },
      body: JSON.stringify({ model: 'lap-model', max_tokens: 5, messages: typeof text === 'string' ? [{ role: 'user', content: text }] : text }),
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
    expect(card).toMatchObject({ requester: fay.email, client: 'claude-desktop' });
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
    // Claude sends the whole conversation again, now with the unanswered first try in it, and its own context added
    // to the message: what she typed is what matches. The card shows what she typed.
    const typed = (t: string) => ({ role: 'user', content: [{ type: 'text', text: '<system-reminder>Today is Friday.</system-reminder>' }, { type: 'text', text: t }] });
    expect((await ask([typed('draft the partner update')])).status).toBe(400);
    const [partner] = await pending();
    expect(partner.args_preview.last_user_message).toBe('draft the partner update');
    await admin.post(`/admin/api/approvals/${partner.id}/decide`, { action: 'approve' });
    // (Turns alternate, so Claude merges the unanswered try into the next message.)
    const merged = (...ts: string[]) => ({ role: 'user', content: ts.flatMap((t) => typed(t).content) });
    expect((await ask([merged('draft the partner update', 'draft the partner update')])).status).toBe(200);
    // Once: and a different message isn't covered.
    expect((await ask([merged('draft the partner update', 'draft the partner update', 'draft the partner update')])).status).toBe(400);
    for (const c of await pending()) await admin.post(`/admin/api/approvals/${c.id}/decide`, { action: 'deny' });
    // Someone else sending the same words doesn't ride on Fay's approval.
    expect((await ask('draft the hiring plan')).status).toBe(400);
    const [hiring] = await pending();
    await admin.post(`/admin/api/approvals/${hiring.id}/decide`, { action: 'approve' });
    const other = await signIn(eve, 'claude-desktop');
    expect((await ask('draft the hiring plan', { credential: other.access_token })).status).toBe(400);
    expect((await ask('draft the hiring plan')).status).toBe(200);
  } finally {
    for (const id of rules) await admin.del(`/admin/api/rules/${id}`);
  }
});

test("a person's approval is theirs: not their own to give, windows and the hold cap per person, and removed means withdrawn", async () => {
  // Everyone's laptops on the team's one key, as a company would set it up.
  await admin.put('/admin/api/devices/rules', { rules: [{ client: '*', team_id: teamId, key_id: keys.eng!.id }] });
  const run = Date.now().toString(36);
  const people = await Promise.all(['gil', 'hal', 'ivy', 'jon', 'kim', 'lee'].map((n) => person(`${n}-${run}@laptops.test`)));
  const [gil, hal, ivy, jon] = people as [Person, Person, Person, Person];
  const tokens = await Promise.all(people.map(async (p) => (await signIn(p, 'claude-desktop')).access_token));
  const ask = (i: number, text: string) =>
    fetch(`${CT}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': tokens[i]!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'user-agent': 'claude-cli/2.1.286 (external, claude-desktop-3p)' },
      body: JSON.stringify({ model: 'lap-model', max_tokens: 5, messages: [{ role: 'user', content: text }] }),
    }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
  const gate = (await admin.post('/admin/api/rules', { name: 'Team calls need a teammate', target_kind: 'model', match: { keys: [keys.eng!.id] }, effect: 'require_approval', config: { hold_ms: 15000 }, priority: 1 })).body.id as string;
  const pending = async () => ((await admin.get('/admin/api/approvals?status=pending')).body.approvals as any[]).filter((a) => a.key_id === keys.eng!.id);
  const cardOf = async (who: Person) => {
    await expect.poll(async () => (await pending()).some((a) => a.requester === who.email)).toBe(true);
    return (await pending()).find((a) => a.requester === who.email);
  };
  try {
    // Gil can't approve his own request; Hal, a teammate, can, for Gil and the next calls like it: Gil's only.
    const gils = ask(0, 'gil asks');
    const card = await cardOf(gil);
    const own = await gil.call('POST', `/admin/api/approvals/${card.id}/decide`, { action: 'approve' });
    expect(own.status).toBe(403);
    expect(own.body.error.code).toBe('own_request');
    expect((await hal.call('POST', `/admin/api/approvals/${card.id}/decide`, { action: 'approve', window: { uses: 5, ttl_ms: 600000, any_args: true } })).status).toBe(200);
    expect((await gils).status).toBe(200);
    expect((await ask(0, 'gil asks something else')).status).toBe(200);
    const ivys = ask(2, 'ivy asks');
    const ivyCard = await cardOf(ivy);
    expect(ivyCard).toBeTruthy();
    await admin.post(`/admin/api/approvals/${ivyCard.id}/decide`, { action: 'deny' });
    expect((await ivys).status).toBe(400);
    for (const g of ((await admin.get('/admin/api/approval-windows')).body.windows as any[]).filter((w) => w.key_id === keys.eng!.id)) await admin.post(`/admin/api/grants/${g.id}/revoke`, {});

    // Six people waiting at once on the one key: each waits (an agent's key holds five at a time; this is per person).
    const all = people.map((_, i) => ask(i, `crowd ${i}`));
    await expect.poll(async () => (await pending()).length).toBe(6);
    // Jon is removed while he waits: his request is withdrawn at once, in words.
    const jonCard = (await pending()).find((a) => a.requester === jon.email);
    await admin.del(`/admin/api/users/${jon.id}`);
    const removed = await all[3]!;
    expect(removed.status).toBe(400);
    expect(removed.body.error.message).toBe('Control Tower: your request was withdrawn: your access was removed.');
    expect((await admin.get(`/admin/api/approvals/${jonCard.id}`)).body.approval).toMatchObject({ status: 'denied', resolved_by: 'Control Tower' });
    for (const a of await pending()) await admin.post(`/admin/api/approvals/${a.id}/decide`, { action: 'approve' });
    expect((await Promise.all(all.filter((_, i) => i !== 3))).map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
  } finally {
    await admin.del(`/admin/api/rules/${gate}`);
  }
});

test('who an agent belongs to: its owner, and the person, app and computer behind each call; secrets never reach a card', async () => {
  // An agent's owner: the person who made it unless given; changed later; on the map and on its cards.
  const mine = await admin.post('/admin/api/keys', { name: `owned-${Date.now().toString(36)}` });
  const given = await admin.post('/admin/api/keys', { name: `team-owned-${Date.now().toString(36)}`, owner: 'payments-oncall@acme.test' });
  try {
    const listed = (await admin.get('/admin/api/keys')).body.keys as any[];
    expect(listed.find((k) => k.id === mine.body.id)).toMatchObject({ owner: 'e2e@example.com', created_by: 'e2e@example.com' });
    expect(listed.find((k) => k.id === given.body.id)).toMatchObject({ owner: 'payments-oncall@acme.test' });
    expect((await admin.patch(`/admin/api/keys/${mine.body.id}`, { owner: 'dana@acme.test' })).status).toBe(200);
    expect(((await admin.get('/admin/api/topology')).body.keys as any[]).find((k) => k.id === mine.body.id)?.owner).toBe('dana@acme.test');
    expect((await admin.patch(`/admin/api/keys/${mine.body.id}`, { owner: null })).status).toBe(200);
    expect(((await admin.get('/admin/api/keys')).body.keys as any[]).find((k) => k.id === mine.body.id)?.owner).toBeNull();
  } finally {
    await admin.del(`/admin/api/keys/${mine.body.id}`);
    await admin.del(`/admin/api/keys/${given.body.id}`);
  }

  // A laptop's calls: the person, the app and the computer, on the flight and on the card.
  await admin.put('/admin/api/devices/rules', { rules: [{ client: '*', team_id: null, key_id: keys.all!.id }] });
  await admin.patch(`/admin/api/keys/${keys.all!.id}`, { owner: 'it@acme.test' });
  const nia = await person(`nia-${Date.now().toString(36)}@laptops.test`);
  const s = await form('/device/code', { client: 'claude-desktop', device_name: "Nia's ThinkPad" });
  await nia.call('POST', '/admin/api/me/devices/approve', { user_code: s.body.user_code });
  const token = (await poll(s.body.device_code)).body.access_token as string;
  const ask = (content: string) =>
    fetch(`${CT}/v1/messages`, { method: 'POST', headers: { 'x-api-key': token, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'lap-model', max_tokens: 5, messages: [{ role: 'user', content }] }) }).then(async (r) => ({ status: r.status, flight: r.headers.get('x-ct-flight-id'), body: (await r.json()) as any }));
  const ok = await ask('hello');
  expect(ok.status).toBe(200);
  await expect.poll(async () => ((await admin.get(`/admin/api/flights?key_id=${keys.all!.id}&limit=20`)).body.flights as any[]).find((f) => f.id === ok.flight)).toMatchObject({ principal: nia.email, client: 'claude-desktop', device: "Nia's ThinkPad" });

  const rules: string[] = [];
  try {
    rules.push((await admin.post('/admin/api/rules', { name: 'Everything held', target_kind: 'model', match: { keys: [keys.all!.id] }, effect: 'require_approval', config: { hold_ms: 1500 }, priority: 2 })).body.id);
    rules.push((await admin.post('/admin/api/rules', { name: 'No credentials', target_kind: 'model', match: { keys: [keys.all!.id] }, effect: 'inspect', config: { detectors: ['secrets'], action: 'block', direction: 'input' }, priority: 1 })).body.id);
    rules.push((await admin.post('/admin/api/rules', { name: 'No emails', target_kind: 'model', match: { keys: [keys.all!.id] }, effect: 'inspect', config: { detectors: ['email'], action: 'mask', direction: 'input' }, priority: 1 })).body.id);
    const pending = async () => ((await admin.get('/admin/api/approvals?status=pending')).body.approvals as any[]).filter((a) => a.key_id === keys.all!.id);
    // A secret is blocked before any hold: no card shows it, and nobody is asked to approve it.
    const before = (await pending()).length;
    const leak = await ask('deploy with AKIAIOSFODNN7EXAMPLE');
    expect(leak.status).toBe(400);
    expect(leak.body.error.code).toBe('content_blocked');
    expect((await pending()).length).toBe(before);
    // What a gate masks is masked on the card; the card names the person, the app, the computer and the agent's owner.
    expect((await ask('email the board at board@acme.test')).status).toBe(400);
    const card = (await pending()).find((a) => a.requester === nia.email);
    expect(card).toMatchObject({ requester: nia.email, client: 'claude-desktop', device: "Nia's ThinkPad", owner: 'it@acme.test' });
    expect(card.args_preview.last_user_message).not.toContain('board@acme.test');
    for (const a of await pending()) await admin.post(`/admin/api/approvals/${a.id}/decide`, { action: 'deny' });
  } finally {
    for (const id of rules) await admin.del(`/admin/api/rules/${id}`);
    await admin.patch(`/admin/api/keys/${keys.all!.id}`, { owner: null });
  }
});

test("an approved request covers the next steps of its task, for that person; something new they type asks again", async () => {
  await admin.put('/admin/api/devices/rules', { rules: [{ client: '*', team_id: null, key_id: keys.all!.id }] });
  const run = Date.now().toString(36);
  const [ola, pat] = await Promise.all([person(`ola-${run}@laptops.test`), person(`pat-${run}@laptops.test`)]);
  const [olaT, patT] = (await Promise.all([signIn(ola!, 'claude-code'), signIn(pat!, 'claude-code')])).map((x) => x.access_token) as [string, string];
  const send = (token: string, messages: unknown[]) =>
    fetch(`${CT}/v1/messages`, { method: 'POST', headers: { 'x-api-key': token, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'user-agent': 'claude-cli/2.1.286 (external, cli)' }, body: JSON.stringify({ model: 'lap-model', max_tokens: 5, messages }) }).then((r) => r.status);
  const reminder = { type: 'text', text: '<system-reminder>context</system-reminder>' };
  const typed = (t: string) => ({ role: 'user', content: [reminder, { type: 'text', text: t }] });
  const toolUse = (id: string) => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: `${id}.md` } }] });
  const toolResult = (id: string) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'text' }, reminder] });
  const gate = (await admin.post('/admin/api/rules', { name: 'Each task needs a yes', target_kind: 'model', match: { keys: [keys.all!.id] }, effect: 'require_approval', config: { hold_ms: 8000 }, priority: 1 })).body.id as string;
  const pending = async () => ((await admin.get('/admin/api/approvals?status=pending')).body.approvals as any[]).filter((a) => a.key_id === keys.all!.id);
  try {
    const asked = [typed('Summarize the Q3 files')];
    const first = send(olaT, asked);
    await expect.poll(async () => (await pending()).length).toBe(1);
    const [card] = await pending();
    await admin.post(`/admin/api/approvals/${card.id}/decide`, { action: 'approve' });
    expect(await first).toBe(200);
    // Claude Code reads files, then answers: each step goes straight through.
    const step1 = [...asked, toolUse('a'), toolResult('a')];
    const step2 = [...step1, toolUse('b'), toolResult('b')];
    expect(await send(olaT, step1)).toBe(200);
    expect(await send(olaT, step2)).toBe(200);
    expect((await pending()).length).toBe(0);
    // Pat's steps on the same words aren't Ola's task.
    const patSteps = send(patT, step1);
    await expect.poll(async () => (await pending()).length).toBe(1);
    for (const a of await pending()) await admin.post(`/admin/api/approvals/${a.id}/decide`, { action: 'deny' });
    expect(await patSteps).toBe(400);
    // Something new Ola types is a new request: it asks again.
    const next = send(olaT, [...step2, { role: 'assistant', content: 'Done.' }, typed('Now email it to the board')]);
    await expect.poll(async () => (await pending()).length).toBe(1);
    for (const a of await pending()) await admin.post(`/admin/api/approvals/${a.id}/decide`, { action: 'deny' });
    expect(await next).toBe(400);
    // A gate can ask at every step instead.
    await admin.patch(`/admin/api/rules/${gate}`, { config: { hold_ms: 8000, task_minutes: 0 } });
    const each = send(olaT, [...step2, toolUse('c'), toolResult('c')]);
    await expect.poll(async () => (await pending()).length).toBe(1);
    for (const a of await pending()) await admin.post(`/admin/api/approvals/${a.id}/decide`, { action: 'deny' });
    expect(await each).toBe(400);
  } finally {
    await admin.del(`/admin/api/rules/${gate}`);
  }
});

test('people follow their own held requests: My requests, and an email when one waits and when it is decided', async () => {
  const { smtpCapture } = await import('./support/smtp');
  const smtp = await smtpCapture();
  const ch = await admin.post('/admin/api/alert-channels', { kind: 'email', name: 'Mail for people', to: 'nobody@acme.test', smtp: { host: '127.0.0.1', port: smtp.port, from: 'Control Tower <tower@acme.test>' } });
  await admin.put('/admin/api/devices/rules', { rules: [{ client: '*', team_id: null, key_id: keys.all!.id }] });
  const run = Date.now().toString(36);
  const [quin, vee] = await Promise.all([person(`quin-${run}@laptops.test`), person(`vee-${run}@laptops.test`)]);
  const s = await form('/device/code', { client: 'claude-desktop', device_name: "Quin's MacBook" });
  await quin!.call('POST', '/admin/api/me/devices/approve', { user_code: s.body.user_code });
  const token = (await poll(s.body.device_code)).body.access_token as string;
  const ask = (content: string) =>
    fetch(`${CT}/v1/messages`, { method: 'POST', headers: { 'x-api-key': token, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'user-agent': 'claude-cli/2.1.286 (external, claude-desktop-3p)' }, body: JSON.stringify({ model: 'lap-model', max_tokens: 5, messages: [{ role: 'user', content }] }) }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
  const gate = (await admin.post('/admin/api/rules', { name: 'Quin needs a yes', target_kind: 'model', match: { keys: [keys.all!.id] }, effect: 'require_approval', config: { hold_ms: 1000 }, priority: 1 })).body.id as string;
  const pending = async () => ((await admin.get('/admin/api/approvals?status=pending')).body.approvals as any[]).filter((a) => a.requester === quin!.email);
  const mailsTo = (who: string) => smtp.messages.filter((m) => (m.to as any)?.value?.some((v: any) => v.address === who));
  try {
    // Approved straight away: no email (they saw the answer arrive).
    const quick = ask('quick one');
    await expect.poll(async () => (await pending()).length).toBe(1);
    await admin.post(`/admin/api/approvals/${(await pending())[0].id}/decide`, { action: 'approve' });
    expect((await quick).status).toBe(200);

    // Left waiting: told where to follow it; an email once it has waited; then how it ended.
    const r = await ask('Draft the board update on Q3');
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/Status: http:\/\/[^ ]+\/#\/requests$/);
    await expect.poll(() => mailsTo(quin!.email).length, { timeout: 15_000 }).toBe(1);
    const waiting = mailsTo(quin!.email)[0]!;
    expect(waiting.subject).toBe('Your request is waiting for approval');
    expect(waiting.text).toContain('Gate: Quin needs a yes');
    expect(waiting.text).toContain("From: Claude Desktop on Quin's MacBook");
    expect(waiting.text).not.toContain('board update');
    const mine = (await quin!.call('GET', '/admin/api/me/requests')).body.requests as any[];
    expect(mine[0]).toMatchObject({ status: 'pending', gate: 'Quin needs a yes', what: 'Draft the board update on Q3', client: 'claude-desktop', device: "Quin's MacBook" });
    expect(mine.map((x) => x.status)).toEqual(['pending', 'approved']);
    // Vee sees none of Quin's.
    expect((await vee!.call('GET', '/admin/api/me/requests')).body.requests).toHaveLength(0);

    await admin.post(`/admin/api/approvals/${(await pending())[0].id}/decide`, { action: 'deny', note: 'Not before the audit' });
    await expect.poll(() => mailsTo(quin!.email).length).toBe(2);
    const decided = mailsTo(quin!.email)[1]!;
    expect(decided.subject).toBe('Your request was denied by e2e@example.com');
    expect(decided.text).toContain('Their note: Not before the audit');
    expect(((await quin!.call('GET', '/admin/api/me/requests')).body.requests as any[])[0]).toMatchObject({ status: 'denied', resolved_by: 'e2e@example.com', note: 'Not before the audit' });
    expect(smtp.messages.every((m) => !(m.to as any)?.value?.some((v: any) => v.address === 'nobody@acme.test'))).toBe(true);
  } finally {
    await admin.del(`/admin/api/rules/${gate}`);
    if (ch.body.id) await admin.del(`/admin/api/alert-channels/${ch.body.id}`);
    await smtp.close();
  }
});

test("a person waiting in Claude is told in the conversation: waiting, approved, then the answer; refusals are replies; our lines never reach the model", async () => {
  const { anthropicUpstream } = await import('./support/upstreams');
  const run = Date.now().toString(36);
  const ant = await anthropicUpstream({ models: ['lap-claude'], reply: 'Board update: 42 deals worth $3.1M.' });
  const prov = await admin.post('/admin/api/providers', { catalog_id: 'anthropic', name: `Anthropic ${run}`, slug: `ant-${run}`, base_url: ant.url, credentials: { api_key: 'sk-ant-test' } });
  const pid = (prov.body.provider ?? prov.body).id as string;
  await admin.post('/admin/api/deployments', { provider_id: pid, upstream_model: 'lap-claude', public_name: 'lap-claude' });
  await admin.patch(`/admin/api/keys/${keys.all!.id}`, { allowed_models: ['lap-model', 'lap-claude'] });
  await admin.put('/admin/api/devices/rules', { rules: [{ client: '*', team_id: null, key_id: keys.all!.id }] });
  const wes = await person(`wes-${run}@laptops.test`);
  const token = (await signIn(wes, 'claude-desktop')).access_token;
  const MARK = '⁣';
  const typed = (t: string) => ({ role: 'user', content: [{ type: 'text', text: t }] });
  const stream = (messages: unknown[], credential = token, ua = 'claude-cli/2.1.286 (external, claude-desktop-3p)') =>
    fetch(`${CT}/v1/messages`, { method: 'POST', headers: { 'x-api-key': credential, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'user-agent': ua }, body: JSON.stringify({ model: 'lap-claude', max_tokens: 50, stream: true, messages }) }).then(async (r) => ({ status: r.status, type: r.headers.get('content-type') ?? '', text: await r.text() }));
  const events = (text: string) =>
    text
      .split('\n\n')
      .filter((b) => b.includes('data:'))
      .map((b) => JSON.parse(b.split('\n').find((l) => l.startsWith('data:'))!.slice(5)) as { type: string; index?: number; delta?: { text?: string } });
  const said = (text: string) => events(text).filter((e) => e.type === 'content_block_delta').map((e) => `${e.index}:${e.delta?.text ?? ''}`);
  const pending = async () => ((await admin.get('/admin/api/approvals?status=pending')).body.approvals as any[]).filter((a) => a.requester === wes.email);
  const rules: string[] = [];
  try {
    rules.push((await admin.post('/admin/api/rules', { name: 'Claude needs a manager', target_kind: 'model', match: { keys: [keys.all!.id], models: ['lap-claude'] }, effect: 'require_approval', config: { hold_ms: 8000 }, priority: 2 })).body.id);

    // Held: the reply starts at once, saying so; approved: it says who, and the model's answer follows.
    const asked = stream([typed('Draft the board update')]);
    await expect.poll(async () => (await pending()).length).toBe(1);
    await admin.post(`/admin/api/approvals/${(await pending())[0].id}/decide`, { action: 'approve' });
    const ok = await asked;
    expect(ok.status).toBe(200);
    expect(ok.type).toContain('text/event-stream');
    const evs = events(ok.text);
    expect(evs.filter((e) => e.type === 'message_start')).toHaveLength(1);
    expect(evs.filter((e) => e.type === 'message_stop')).toHaveLength(1);
    const lines = said(ok.text);
    expect(lines[0]).toBe(`0:${MARK}⏳ Control Tower: waiting for approval (gate “Claude needs a manager”). An approver has been asked; this carries on by itself once they approve.\n\n`);
    expect(lines[1]).toBe(`0:${MARK}✓ Control Tower: approved by e2e@example.com.\n\n`);
    expect(lines.slice(2).every((l) => l.startsWith('1:'))).toBe(true);
    expect(lines.slice(2).join('').replace(/1:/g, '')).toContain('Board update: 42 deals');

    // The next turn carries our lines back: they're taken out before the model sees the conversation.
    const answer = lines.map((l) => l.slice(2)).join('');
    const before = ant.calls.length;
    const next = stream([typed('Draft the board update'), { role: 'assistant', content: [{ type: 'text', text: answer }] }, typed('Shorter please')]);
    await expect.poll(async () => (await pending()).length).toBe(1);
    await admin.post(`/admin/api/approvals/${(await pending())[0].id}/decide`, { action: 'approve' });
    expect((await next).status).toBe(200);
    const sent = JSON.parse(ant.calls[before]!.body) as { messages: Array<{ role: string; content: unknown }> };
    expect(JSON.stringify(sent.messages)).not.toContain(MARK);
    expect(JSON.stringify(sent.messages)).not.toContain('waiting for approval');
    expect(JSON.stringify(sent.messages)).toContain('Board update: 42 deals');

    // Denied while waiting: the reply ends with who and why.
    const denied = stream([typed('Draft the investor update')]);
    await expect.poll(async () => (await pending()).length).toBe(1);
    await admin.post(`/admin/api/approvals/${(await pending())[0].id}/decide`, { action: 'deny', note: 'Not before the audit' });
    const no = await denied;
    expect(no.status).toBe(200);
    expect(said(no.text).at(-1)).toContain('your request was denied by e2e@example.com: Not before the audit');
    expect(events(no.text).at(-1)?.type).toBe('message_stop');

    // Nobody answers in time: the reply says so; approved later, the same message again (with our reply to the first
    // try in the conversation, as Claude sends it back) goes through.
    await admin.patch(`/admin/api/rules/${rules[0]}`, { config: { hold_ms: 1000 } });
    const first = await stream([typed('Draft the partner newsletter')]);
    expect(said(first.text).join('')).toContain('once they approve, send the same message again');
    await admin.post(`/admin/api/approvals/${(await pending())[0].id}/decide`, { action: 'approve' });
    const firstReply = said(first.text).map((l) => l.slice(2)).join('');
    const again = await stream([typed('Draft the partner newsletter'), { role: 'assistant', content: [{ type: 'text', text: firstReply }] }, typed('Draft the partner newsletter')]);
    const text = said(again.text).map((l) => l.slice(2)).join('');
    expect(text).toContain('Board update: 42 deals');
    expect(text).not.toContain('waiting for approval');

    // Sent again before anyone decided: it joins the card already waiting, so the approver decides once.
    const memo = await stream([typed('Draft the investor memo')]);
    const memoReply = said(memo.text).map((l) => l.slice(2)).join('');
    await stream([typed('Draft the investor memo'), { role: 'assistant', content: [{ type: 'text', text: memoReply }] }, typed('Draft the investor memo')]);
    const memoCards = (await pending()).filter((a) => a.args_preview?.last_user_message === 'Draft the investor memo');
    expect(memoCards.length).toBe(1);
    await admin.post(`/admin/api/approvals/${memoCards[0].id}/decide`, { action: 'deny' });

    // Claude's background guess at what to type next isn't put in front of an approver: it's answered empty.
    const suggestion = await stream([typed('Draft the investor memo'), { role: 'assistant', content: [{ type: 'text', text: memoReply }] }, typed('[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]')]);
    expect(suggestion.status).toBe(200);
    expect(said(suggestion.text)).toEqual([]);
    expect(suggestion.text).toContain('message_stop');
    expect((await pending()).length).toBe(0);
    await admin.patch(`/admin/api/rules/${rules[0]}`, { config: { hold_ms: 8000 } });

    // Blocked before anything is held: a reply in words, not an error box.
    rules.push((await admin.post('/admin/api/rules', { name: 'No keys to Claude', target_kind: 'model', match: { keys: [keys.all!.id] }, effect: 'inspect', config: { detectors: ['secrets'], action: 'block', direction: 'input' }, priority: 1 })).body.id);
    const blocked = await stream([typed('Use AKIAIOSFODNN7EXAMPLE to deploy')]);
    expect(blocked.status).toBe(200);
    expect(said(blocked.text).join('')).toContain('Control Tower blocked this message: it contains AWS access key (gate “No keys to Claude”)');
    expect((await pending()).length).toBe(0);

    // An agent's key gets the error it always did.
    const agent = await stream([typed('Use AKIAIOSFODNN7EXAMPLE to deploy')], keys.all!.key, 'my-agent/1.0');
    expect(agent.status).toBe(400);
    expect(agent.type).toContain('application/json');
  } finally {
    for (const id of rules) await admin.del(`/admin/api/rules/${id}`);
    await admin.patch(`/admin/api/keys/${keys.all!.id}`, { allowed_models: ['lap-model'] });
    await admin.del(`/admin/api/providers/${pid}`);
    await ant.close();
  }
});
