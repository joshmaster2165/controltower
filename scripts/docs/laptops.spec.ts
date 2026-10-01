import { test, expect, type Page } from '@playwright/test';
import { REPO as REPO_ROOT, nav, shot, startServer } from './helpers';
import { TEST_LICENSE_PUBLIC_KEY, testLicense } from '../../e2e/support/license';
import { openAiUpstream } from '../../e2e/support/upstreams';

/**
 * Screenshots for docs/laptops.md: the Laptops page (rules, rollout files, signed-in computers), approving a
 * computer's sign-in at /device, and spend by person in the Ledger. A real server with a test-signed license; the
 * sign-ins are the real device flow, approved by real people's sessions.
 */
const AK = 'docs-admin-key-0123456789abcdef';

test('laptops: rules, rollout, approving a sign-in, spend by person', async ({ page }) => {
  const up = await openAiUpstream({ models: ['claude-sonnet-4-5', 'gpt-4.1'], reply: 'Done.' });
  const ct = await startServer(4000, { CT_PUBLIC_URL: 'http://localhost:4000', CT_ADMIN_KEY: AK, CT_LICENSE_PUBLIC_KEY: TEST_LICENSE_PUBLIC_KEY, CT_LICENSE_KEY: testLicense({ customer: 'Acme Corp', seats: 25 }), CT_MODEL_HEALTH_INTERVAL_S: '0' });
  const api = (method: string, p: string, body?: unknown) =>
    fetch(`${ct.url}${p}`, { method, headers: { authorization: `Bearer ${AK}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }).then(async (r) => (await r.json().catch(() => ({}))) as any);
  const form = (p: string, body: Record<string, string>) => fetch(`${ct.url}${p}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) }).then((r) => r.json() as Promise<any>);
  /** A person with a password of their own, and a session to approve with. */
  const person = async (email: string, role: string, team?: string) => {
    const made = team ? await api('PUT', `/admin/api/teams/${team}/members`, { email, role: 'member' }) : await api('POST', '/admin/api/users', { email, role });
    const pw = `${email.split('@')[0]}-password-123`;
    let login = await fetch(`${ct.url}/admin/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: made.password }) });
    let cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    let csrf = ((await login.json()) as any).csrf;
    await fetch(`${ct.url}/admin/api/me/password`, { method: 'POST', headers: { cookie, 'x-ct-csrf': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ current: made.password, password: pw }) });
    login = await fetch(`${ct.url}/admin/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: pw }) });
    cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    csrf = ((await login.json()) as any).csrf;
    return { email, pw, approve: (code: string) => fetch(`${ct.url}/admin/api/me/devices/approve`, { method: 'POST', headers: { cookie, 'x-ct-csrf': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ user_code: code }) }) };
  };
  /** A computer signs in (the device flow, as ct-auth does it), then makes a few calls. */
  const laptop = async (who: { approve: (c: string) => Promise<Response> }, client: string, device: string, calls: number, model: string) => {
    const s = await form('/device/code', { client, device_name: device });
    await who.approve(s.user_code);
    let t: any;
    for (;;) {
      t = await form('/device/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: s.device_code });
      if (t.access_token) break;
      await new Promise((r) => setTimeout(r, 4200));
    }
    for (let i = 0; i < calls; i++) await fetch(`${ct.url}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${t.access_token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Refactor this function' }] }) });
  };
  const signIn = async (p: Page, email: string, password: string) => {
    await p.getByLabel('Email or username').fill(email);
    await p.getByLabel('Password').fill(password);
    await p.getByRole('button', { name: 'Sign in', exact: true }).click();
  };
  try {
    const prov = await api('POST', '/admin/api/providers', { catalog_id: 'custom', name: 'Anthropic', slug: 'anthropic', base_url: `${up.url}/v1`, credentials: { api_key: 'sk-docs' } });
    for (const m of ['claude-sonnet-4-5', 'gpt-4.1']) await api('POST', '/admin/api/deployments', { provider_id: (prov.provider ?? prov).id, upstream_model: m, public_name: m });
    const eng = (await api('POST', '/admin/api/teams', { name: 'engineering' })).id;
    await api('POST', '/admin/api/teams', { name: 'data' });
    const k = {
      cc: await api('POST', '/admin/api/keys', { name: 'claude-code-engineering', agent_id: 'claude-code', team: 'engineering', allowed_models: ['claude-sonnet-4-5'] }),
      cd: await api('POST', '/admin/api/keys', { name: 'claude-desktop', agent_id: 'claude-desktop', allowed_models: ['claude-sonnet-4-5'] }),
      cx: await api('POST', '/admin/api/keys', { name: 'codex', agent_id: 'codex', allowed_models: ['gpt-4.1'] }),
      all: await api('POST', '/admin/api/keys', { name: 'laptops-default', allowed_models: ['claude-sonnet-4-5', 'gpt-4.1'] }),
    };
    await api('PUT', '/admin/api/devices/rules', {
      rules: [
        { client: 'claude-code', team_id: eng, key_id: k.cc.id },
        { client: 'claude-desktop', team_id: null, key_id: k.cd.id },
        { client: 'codex', team_id: null, key_id: k.cx.id },
        { client: '*', team_id: null, key_id: k.all.id },
      ],
    });
    const it = await person('it@acme.com', 'admin');
    const dana = await person('dana@acme.com', 'member', eng);
    const lee = await person('lee@acme.com', 'member', eng);
    const priya = await person('priya@acme.com', 'member', eng);
    await laptop(dana, 'claude-code', 'Dana’s MacBook Pro', 7, 'claude-sonnet-4-5');
    await laptop(dana, 'claude-desktop', 'Dana’s MacBook Pro', 3, 'claude-sonnet-4-5');
    await laptop(lee, 'claude-code', 'LEE-THINKPAD', 4, 'claude-sonnet-4-5');
    await laptop(priya, 'codex', 'priya-dev (Ubuntu)', 5, 'gpt-4.1');

    // The Laptops page, as an admin.
    await page.goto(ct.url);
    await signIn(page, it.email, it.pw);
    await expect(page.locator('.side-user')).toBeVisible();
    await nav(page, 'Laptops');
    await expect(page.getByText('4 signed in')).toBeVisible();
    await shot(page, 'laptops-rules', { clip: page.locator('.laptops-section').nth(0), pad: 8 });
    await page.getByLabel('The address laptops reach Control Tower at').fill('https://ai.acme.com');
    await expect(page.getByRole('cell', { name: 'controltower.mobileconfig' })).toBeVisible();
    await page.waitForTimeout(600);
    await page.getByRole('button', { name: 'Show' }).nth(1).click();
    await expect(page.locator('.laptops-section').nth(1).locator('pre').first()).toBeVisible();
    await shot(page, 'laptops-rollout', { clip: page.locator('.laptops-section').nth(1), pad: 8 });
    await page.getByRole('button', { name: 'Hide' }).click();
    await page.locator('.laptops-section').nth(2).scrollIntoViewIfNeeded();
    await shot(page, 'laptops-computers', { clip: page.locator('.laptops-section').nth(2), pad: 8 });

    // Spend by person in the Ledger.
    await nav(page, 'Ledger');
    const people = page.locator('.card', { hasText: 'Spend by person' });
    await expect(people.getByText('dana@acme.com')).toBeVisible();
    await people.scrollIntoViewIfNeeded();
    await shot(page, 'ledger-people', { clip: people, pad: 8 });

    // A new sign-in from Sam's laptop: Sam opens the link ct-auth showed, signs in, and approves.
    const sam = await person('sam@acme.com', 'member', eng);
    const ctx = await page.context().browser()!.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
    const p2 = await ctx.newPage();
    const s = await form('/device/code', { client: 'claude-code', device_name: 'Sam’s MacBook Air' });
    await p2.goto(s.verification_uri_complete);
    await expect(p2.getByRole('heading', { name: 'Connect your computer' })).toBeVisible();
    await shot(p2, 'device-sign-in');
    await signIn(p2, sam.email, sam.pw);
    await expect(p2.getByRole('button', { name: 'Approve' })).toBeVisible();
    await shot(p2, 'device-approve', { el: p2.getByRole('button', { name: 'Approve' }) });
    await p2.getByRole('button', { name: 'Approve' }).click();
    await expect(p2.getByText('Approved')).toBeVisible();
    await shot(p2, 'device-approved');
    await ctx.close();
  } finally {
    await ct.stop();
    await up.close();
  }
});

/**
 * The real clients with the generated settings: Claude Code (managed settings and managed-mcp.json, through
 * --settings and --mcp-config) and Codex (the requirements' provider and the managed MCP server, in CODEX_HOME), each
 * getting its token from ct-auth after a real sign-in. Needs `claude` on PATH; Codex with CODEX_BIN.
 */
test('laptop clients: Claude Code and Codex sign in through ct-auth with the rollout files', async () => {
  const { spawn } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { anthropicUpstream, mcpUpstream } = await import('../../e2e/support/upstreams');
  const REPLY = 'Connected through Control Tower as the person signed in.';
  const ant = await anthropicUpstream({ reply: REPLY, models: ['claude-sonnet-4-5', 'claude-haiku-4-5'] });
  const oai = await openAiUpstream({ reply: REPLY, models: ['gpt-5'] });
  const files = await mcpUpstream('files-token');
  const ct = await startServer(4701, { CT_ADMIN_KEY: AK, CT_LICENSE_PUBLIC_KEY: TEST_LICENSE_PUBLIC_KEY, CT_LICENSE_KEY: testLicense(), CT_MODEL_HEALTH_INTERVAL_S: '0' });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-laptop-clients-'));
  const api = (method: string, p: string, body?: unknown) =>
    fetch(`${ct.url}${p}`, { method, headers: { authorization: `Bearer ${AK}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }).then(async (r) => (await r.json().catch(() => ({}))) as any);
  const run = (bin: string, args: string[], env: Record<string, string | undefined>, timeoutMs = 120_000) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const p = spawn(bin, args, { cwd: tmp, env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      p.stdout.on('data', (d) => (stdout += d));
      p.stderr.on('data', (d) => (stderr += d));
      const t = setTimeout(() => p.kill('SIGTERM'), timeoutMs);
      p.on('exit', (code) => (clearTimeout(t), resolve({ code, stdout, stderr })));
    });
  try {
    await api('POST', '/admin/api/providers', { catalog_id: 'anthropic', base_url: ant.url, credentials: { api_key: 'sk-ant-docs' } });
    await api('POST', '/admin/api/providers', { catalog_id: 'custom', name: 'OpenAI', slug: 'openai', base_url: `${oai.url}/v1`, credentials: { api_key: 'sk-docs' } });
    await api('POST', '/admin/api/mcp/servers', { name: 'Files', slug: 'files', url: `${files.url}/mcp`, auth: { type: 'bearer', token: 'files-token' } });
    const key = await api('POST', '/admin/api/keys', { name: 'laptops', agent_id: 'laptops' });
    await api('PUT', '/admin/api/devices/rules', { rules: [{ client: '*', team_id: null, key_id: key.id }] });
    const made = await api('POST', '/admin/api/users', { email: 'dev@acme.com', role: 'viewer' });
    const loginAs = async (pw: string) => {
      const l = await fetch(`${ct.url}/admin/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'dev@acme.com', password: pw }) });
      return { cookie: l.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '), csrf: ((await l.json()) as any).csrf as string };
    };
    let s = await loginAs(made.password);
    await fetch(`${ct.url}/admin/api/me/password`, { method: 'POST', headers: { cookie: s.cookie, 'x-ct-csrf': s.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ current: made.password, password: 'dev-password-123' }) });
    s = await loginAs('dev-password-123');

    // The rollout files, with the helper where this test keeps it instead of /usr/local/bin.
    const r = await api('GET', `/admin/api/devices/rollout?url=${encodeURIComponent(ct.url)}&clients=claude-code,codex`);
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    const helper = path.join(REPO_ROOT, 'server/src/ee/laptops/ct-auth.sh');
    // As installed: the helper finds its address and store by itself (clients run helpers with a bare environment:
    // Codex passes only HOME, PATH, USER and TMPDIR). Here a file store, so the test leaves the keychain alone.
    const conf = `CT_URL='${ct.url}' CT_AUTH_STORE=file CT_AUTH_DIR='${path.join(tmp, 'store')}'`;
    fs.writeFileSync(path.join(bin, 'ct-auth'), `#!/bin/sh\n${conf} exec sh "${helper}" "$@"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'ct-auth-mcp-codex'), `#!/bin/sh\n${conf} exec sh "${helper}" header --client codex 2>>"${tmp}/codex-helper-err"\n`, { mode: 0o755 });
    const file = (name: string) => ((r.files as Array<{ name: string; content: string }>).find((f) => f.name === name)!.content).split('/usr/local/bin/').join(`${bin}/`);
    const opened = path.join(tmp, 'opened');
    fs.writeFileSync(path.join(bin, 'open'), `#!/bin/sh\nprintf '%s' "$1" > "${opened}"\n`, { mode: 0o755 });
    const env: Record<string, string | undefined> = { ...process.env, ANTHROPIC_API_KEY: undefined, ANTHROPIC_BASE_URL: undefined, ANTHROPIC_AUTH_TOKEN: undefined, CT_AUTH_STORE: 'file', CT_AUTH_DIR: path.join(tmp, 'store'), CT_AUTH_OPEN: path.join(bin, 'open'), CT_AUTH_CONF: path.join(tmp, 'none') };

    // Sign in once per tool, as IT's rollout would have a person do on first use.
    const signIn = async (client: string) => {
      fs.rmSync(opened, { force: true });
      const p = run(path.join(bin, 'ct-auth'), ['login', '--url', ct.url, '--client', client], env, 60_000);
      await expect.poll(() => (fs.existsSync(opened) ? fs.readFileSync(opened, 'utf8') : ''), { timeout: 10_000 }).toContain('/device?code=');
      const code = new URL(fs.readFileSync(opened, 'utf8')).searchParams.get('code')!;
      await fetch(`${ct.url}/admin/api/me/devices/approve`, { method: 'POST', headers: { cookie: s.cookie, 'x-ct-csrf': s.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ user_code: code }) });
      const done = await p;
      expect(done.code, done.stderr).toBe(0);
    };
    // The helper reads the address from its config file in a real rollout; here, CT_URL.
    env.CT_URL = ct.url;

    // ---- Claude Code ----
    await signIn('claude-code');
    const settings = path.join(tmp, 'managed-settings.json');
    fs.writeFileSync(settings, file('claude-code/managed-settings.json'));
    const mcpConfig = path.join(tmp, 'managed-mcp.json');
    fs.writeFileSync(mcpConfig, file('claude-code/managed-mcp.json'));
    const ccEnv = { ...env, CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(tmp, 'claude-')), ANTHROPIC_MODEL: 'claude-sonnet-4-5', ANTHROPIC_SMALL_FAST_MODEL: 'claude-haiku-4-5' };
    const cc = await run(process.env.CLAUDE_BIN ?? 'claude', ['-p', 'Which gateway?', '--settings', settings, '--mcp-config', mcpConfig, '--strict-mcp-config', '--output-format', 'stream-json', '--verbose'], ccEnv);
    const events = cc.stdout.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
    const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
    console.log('claude code mcp:', JSON.stringify(init?.mcp_servers), 'result:', events.find((e) => e.type === 'result')?.result, cc.stderr.slice(0, 400));
    expect(events.find((e) => e.type === 'result')?.result).toContain('Connected through Control Tower');
    expect(init?.mcp_servers).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'controltower', status: 'connected' })]));
    const flights = async () => ((await api('GET', `/admin/api/flights?key_id=${key.id}&limit=50`)).flights as any[]) ?? [];
    await expect.poll(async () => (await flights()).some((f) => f.principal === 'dev@acme.com')).toBe(true);

    // ---- Codex ----
    if (process.env.CODEX_BIN) {
      await signIn('codex');
      const home = fs.mkdtempSync(path.join(tmp, 'codex-'));
      // requirements.toml's provider block and managed_config.toml's MCP server, as a config.toml (same keys).
      const req = file('codex/requirements.toml').replace(/^\[mcp_servers\.controltower\.identity\][\s\S]*$/m, '');
      fs.writeFileSync(path.join(home, 'config.toml'), `model = "gpt-5"\n${req}\n${file('codex/managed_config.toml')}`);
      const cx = await run(process.env.CODEX_BIN!, ['exec', '--skip-git-repo-check', 'Which gateway?'], { ...env, CODEX_HOME: home });
      console.log('codex:', cx.stdout.slice(0, 300), cx.stderr.slice(-600));
      expect(cx.stdout + cx.stderr).toContain('Connected through Control Tower');
      const list = await run(process.env.CODEX_BIN!, ['mcp', 'list'], { ...env, CODEX_HOME: home });
      console.log('codex mcp list:', list.stdout);
      // Codex ran the MCP headers helper, and it gave a token.
      expect(fs.existsSync(path.join(tmp, 'codex-helper-err')) ? fs.readFileSync(path.join(tmp, 'codex-helper-err'), 'utf8') : '').toBe('');
      expect(cx.stderr).not.toContain('headers helper exited');
      await expect.poll(async () => (await flights()).filter((f) => f.principal === 'dev@acme.com' && String(f.model_requested).startsWith('gpt')).length).toBeGreaterThan(0);
    }
  } finally {
    await ct.stop();
    await ant.close();
    await oai.close();
    await files.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
