/**
 * Laptops on a real machine (a GitHub Actions Windows or macOS runner, as administrator): installs the rollout files
 * the way Intune or Jamf would, then runs the real Claude Code and Codex with nothing else configured, and checks
 * their calls reach Control Tower as the person who signed in. Not for a developer's own computer: it writes system
 * settings (the registry, /Library, Program Files).
 *
 *   CT_TEST_LICENSE_KEYS=1 pnpm build && npm i -g @anthropic-ai/claude-code @openai/codex
 *   npx tsx scripts/laptops/real-machine.mts            (Windows: as administrator; macOS: with passwordless sudo)
 *
 * Writes laptops-real-results.json (RESULTS_DIR) and a summary for the workflow run.
 *
 * With CT_REMOTE_URL (and CT_REMOTE_ADMIN_KEY), the tools are rolled out against that deployed Control Tower instead of
 * one started here: a person, a team and a key of their own are made there, and what they do shows in its console as
 * it happens (with how many seconds each sign-in and call took to appear). Answers come from that deployment's models.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { anthropicUpstream, mcpUpstream, openAiUpstream } from '../../e2e/support/upstreams.ts';
import { TEST_LICENSE_PUBLIC_KEY, testLicense } from '../../e2e/support/license.ts';

const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';
if (!WIN && !MAC) throw new Error('Windows or macOS only');
if (!process.env.CI && !process.env.CT_REAL_MACHINE) throw new Error('This changes system settings: run it on a CI runner (or set CT_REAL_MACHINE=1 on a throwaway machine).');
const REPO = path.resolve(import.meta.dirname, '../..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-real-'));
const PORT = 4000;
const REMOTE = process.env.CT_REMOTE_URL?.replace(/\/+$/, '') || undefined;
if (REMOTE && !process.env.CT_REMOTE_ADMIN_KEY) throw new Error('CT_REMOTE_URL needs CT_REMOTE_ADMIN_KEY');
const CT = REMOTE ?? `http://127.0.0.1:${PORT}`;
const AK = REMOTE ? process.env.CT_REMOTE_ADMIN_KEY! : 'real-machine-admin-key-0123456789abcdef';
const OS_NAME = WIN ? 'windows' : 'macos';
// Remote: a new person each run (their computer shows on Laptops under their name), on a team and key of their own.
const PERSON = REMOTE ? `laptop-${OS_NAME}-${Date.now().toString(36)}@acme.com` : 'dev@acme.example';
const MODELS = { claude: 'claude-sonnet-4-5', fast: 'claude-haiku-4-5', gpt: REMOTE ? 'gpt-4.1-mini' : 'gpt-5' };
const REPLY = 'Connected through Control Tower as the person signed in.';
const checks: Array<{ what: string; pass: boolean; detail: string }> = [];
const c = (what: string, pass: boolean, detail: string) => {
  checks.push({ what, pass, detail });
  console.log(`${pass ? '✓' : '✗'} ${what} — ${detail}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run a command line (through the shell, so .cmd files work on Windows), asynchronously. */
function run(line: string, env: Record<string, string | undefined> = {}, timeoutMs = 180_000): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    // Variables set to undefined are removed (not passed on as the text "undefined").
    const full: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...process.env, ...env })) if (v !== undefined) full[k] = v;
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete full[k];
    // No input: `codex exec` otherwise waits to read more of its prompt from stdin.
    const p = spawn(line, { shell: true, env: full, cwd: TMP, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout?.on('data', (d) => (out += d));
    p.stderr?.on('data', (d) => (err += d));
    // On Windows the shell's children (the tools, the helper) outlive killing the shell: end the whole tree.
    const t = setTimeout(() => (WIN && p.pid ? spawn('taskkill', ['/pid', String(p.pid), '/T', '/F']) : p.kill()), timeoutMs);
    p.on('exit', (code) => (clearTimeout(t), resolve({ code: code ?? -1, out, err })));
  });
}
const q = (s: string) => `"${s}"`;

// Local: stand-in model providers and a tool server, and Control Tower itself. Remote: what that deployment has.
const ant = REMOTE ? undefined : await anthropicUpstream({ reply: REPLY, models: [MODELS.claude, MODELS.fast] });
const oai = REMOTE ? undefined : await openAiUpstream({ reply: REPLY, models: [MODELS.gpt] });
const files = REMOTE ? undefined : await mcpUpstream('files-token');
const ct: ChildProcess | undefined = REMOTE
  ? undefined
  : spawn(process.execPath, ['server/dist/server.mjs', '--port', String(PORT)], {
      cwd: REPO,
      env: { ...process.env, CT_DATA_DIR: path.join(TMP, 'data'), CT_ADMIN_KEY: AK, CT_UI_DIR: path.join(REPO, 'ui/dist'), CT_LOG_LEVEL: 'warn', CT_LICENSE_PUBLIC_KEY: TEST_LICENSE_PUBLIC_KEY, CT_LICENSE_KEY: testLicense(), CT_LICENSE_SERVER: 'off', CT_MODEL_HEALTH_INTERVAL_S: '0' },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
for (let i = 0; ; i++) {
  if ((await fetch(`${CT}/healthz`).catch(() => null))?.ok) break;
  if (i > 150) throw new Error(REMOTE ? `${CT} doesn't answer` : 'Control Tower did not start (a test build is needed: CT_TEST_LICENSE_KEYS=1 pnpm build)');
  await sleep(200);
}
// A recorder in front of Control Tower: what each tool sends (method, path, its credential's kind, the answer). The
// rollout points the tools here, so it sees every request, and passes each on unchanged.
const RECORD_PORT = 4002;
const GW = `http://127.0.0.1:${RECORD_PORT}`;
const seen: Array<{ method: string; path: string; ua: string; cred: string; status: number }> = [];
const recorder = http.createServer((req, res) => {
  const a = String(req.headers.authorization ?? req.headers['x-api-key'] ?? '');
  const cred = /ct_dt_/.test(a) ? 'ct_dt' : a ? 'other' : 'none';
  const target = new URL(CT);
  const via = target.protocol === 'https:' ? https : http;
  // Remote: the deployment's own host name (its proxy routes by it); local: the recorder's, for the links it builds.
  const up = via.request({ host: target.hostname, port: target.port || (target.protocol === 'https:' ? 443 : 80), path: req.url, method: req.method, headers: { ...req.headers, host: REMOTE ? target.host : `127.0.0.1:${RECORD_PORT}` } }, (r) => {
    seen.push({ method: req.method ?? '', path: (req.url ?? '').split('?')[0]!, ua: String(req.headers['user-agent'] ?? ''), cred, status: r.statusCode ?? 0 });
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  // (A reply already under way when Control Tower stops, at the end: just close it.)
  up.on('error', () => (res.headersSent ? res.destroy() : (res.writeHead(502), res.end())));
  req.pipe(up);
});
await new Promise<void>((r) => recorder.listen(RECORD_PORT, '127.0.0.1', () => r()));
const api = (method: string, p: string, body?: unknown) =>
  fetch(CT + p, { method, headers: { authorization: `Bearer ${AK}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }).then(async (r) => (await r.json().catch(() => ({}))) as any);
/** A call that went through Control Tower with the person's device token, and was answered (from the recorder). */
const throughCT = (since: number, ua: RegExp, p: RegExp) => seen.slice(since).find((x) => ua.test(x.ua) && p.test(x.path) && x.cred === 'ct_dt' && x.status === 200);
/** Local, the stand-in model's reply; remote, any answer, seen going through Control Tower. */
const answered = (text: string, since: number, ua: RegExp, p: RegExp) => (REMOTE ? text.trim().length > 0 && !!throughCT(since, ua, p) : text.includes(REPLY));
/** How long until something shows in Control Tower's console (its admin API), polled every 250 ms. */
async function shows(what: () => Promise<boolean>, maxMs = 20_000): Promise<number | null> {
  const t = Date.now();
  while (Date.now() - t < maxMs) {
    if (await what().catch(() => false)) return Date.now() - t;
    await sleep(250);
  }
  return null;
}
const secs = (ms: number | null) => (ms === null ? 'not within 20 s' : `in ${(ms / 1000).toFixed(1)} s`);
const flightsOf = async (keyId: string) => ((await api('GET', `/admin/api/flights?key_id=${keyId}&limit=200`)).flights ?? []) as Array<{ principal: string | null; model_requested: string; client: string | null }>;

try {
  // ---- Control Tower: providers, a tool server, a key, a rule, and a person ----
  let key: { id: string };
  if (!REMOTE) {
    await api('POST', '/admin/api/providers', { catalog_id: 'anthropic', base_url: ant!.url, credentials: { api_key: 'sk-ant-real' } });
    const op = await api('POST', '/admin/api/providers', { catalog_id: 'custom', name: 'OpenAI', slug: 'openai', base_url: `${oai!.url}/v1`, credentials: { api_key: 'sk-real' } });
    await api('POST', '/admin/api/deployments', { provider_id: (op.provider ?? op).id, upstream_model: MODELS.gpt, public_name: MODELS.gpt });
    await api('POST', '/admin/api/mcp/servers', { name: 'Files', slug: 'files', url: `${files!.url}/mcp`, auth: { type: 'bearer', token: 'files-token' } });
    key = await api('POST', '/admin/api/keys', { name: 'laptops', agent_id: 'laptops' });
    await api('PUT', '/admin/api/devices/rules', { rules: [{ client: '*', team_id: null, key_id: key.id }] });
  } else {
    // A team for this machine's rollouts, its key (the deployment's models, any tool), and a laptop rule for the team:
    // made once, reused by later runs. The other machine may be editing the rules at the same moment: check, and retry.
    const teamName = `laptop-rollout-${OS_NAME}`;
    const findTeam = async () => ((await api('GET', '/admin/api/teams')).teams as Array<{ id: string; name: string }>).find((t) => t.name === teamName);
    const team = (await findTeam()) ?? ((await api('POST', '/admin/api/teams', { name: teamName })), await findTeam());
    if (!team) throw new Error(`couldn't make the team ${teamName}`);
    const keyName = `laptop-rollout-${OS_NAME}`;
    key = ((await api('GET', '/admin/api/keys')).keys as Array<{ id: string; name: string }>).find((k) => k.name === keyName) ?? (await api('POST', '/admin/api/keys', { name: keyName, team: teamName, owner: 'it@acme.com', allowed_models: [MODELS.claude, MODELS.fast, MODELS.gpt] }));
    for (let i = 0; i < 6; i++) {
      const rules = ((await api('GET', '/admin/api/devices')).rules ?? []) as Array<{ client: string; team_id: string | null; key_id: string }>;
      if (rules.some((r) => r.team_id === team.id && r.key_id === key.id)) break;
      await api('PUT', '/admin/api/devices/rules', { rules: [{ client: '*', team_id: team.id, key_id: key.id }, ...rules.map((r) => ({ client: r.client, team_id: r.team_id, key_id: r.key_id }))] });
      await sleep(1000 + Math.random() * 2000);
    }
    await api('POST', '/admin/api/users', { email: PERSON, role: 'member' }).then(async (m) => {
      (globalThis as any).__pw = m.password;
      await api('PUT', `/admin/api/teams/${team.id}/members`, { email: PERSON, role: 'member' });
    });
    console.log(`In ${CT}: Laptops and Flights will show ${PERSON} (team ${teamName}) as this runs.`);
  }
  const made = REMOTE ? { password: (globalThis as any).__pw as string } : await api('POST', '/admin/api/users', { email: PERSON, role: 'viewer' });
  const login = async (pw: string) => {
    const r = await fetch(`${CT}/admin/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: PERSON, password: pw }) });
    return { cookie: r.headers.getSetCookie().map((x) => x.split(';')[0]).join('; '), csrf: ((await r.json()) as { csrf: string }).csrf };
  };
  const mine = `${made.password}-${OS_NAME}-laptop`;
  let s = await login(made.password);
  await fetch(`${CT}/admin/api/me/password`, { method: 'POST', headers: { cookie: s.cookie, 'x-ct-csrf': s.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ current: made.password, password: mine }) });
  s = await login(mine);

  // ---- What IT deploys ----
  const roll = await api('GET', `/admin/api/devices/rollout?url=${encodeURIComponent(GW)}&clients=claude-code,claude-desktop,codex,copilot&mcp=1&lockdown=1${REMOTE ? `&copilot_model=${MODELS.claude}` : ''}`);
  const file = (n: string) => (roll.files as Array<{ name: string; content: string }>).find((f) => f.name === n)!.content;
  if (WIN) {
    // As Intune runs a platform script: Windows PowerShell 5.1, 64-bit, as an administrator.
    fs.writeFileSync(path.join(TMP, 'install.ps1'), file('install-controltower-windows.ps1'));
    const r = await run(`powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${q(path.join(TMP, 'install.ps1'))}`);
    c('the Windows install script runs as Intune would (Windows PowerShell, as administrator)', r.code === 0, (r.out + r.err).trim().slice(-300));
    const reg = await run('reg query HKLM\\SOFTWARE\\Policies\\ClaudeCode /v Settings');
    const regDesktop = await run('reg query HKLM\\SOFTWARE\\Policies\\Claude /v inferenceGatewayBaseUrl');
    c('Claude Code and Claude Desktop policy is in the registry (HKLM)', reg.code === 0 && reg.out.includes('apiKeyHelper') && regDesktop.out.includes(GW), `${reg.out.trim().split('\n').pop()?.slice(0, 160)} · ${regDesktop.out.trim().split('\n').pop()}`);
    const want = ['C:\\Program Files\\ControlTower\\ct-auth.ps1', 'C:\\Program Files\\ControlTower\\ct-auth.cmd', 'C:\\Program Files\\ClaudeCode\\managed-mcp.json', path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'OpenAI', 'Codex', 'requirements.toml'), path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'ControlTower', 'ct-auth.conf')];
    const missing = want.filter((f) => !fs.existsSync(f));
    const bom = want.filter((f) => fs.existsSync(f) && fs.readFileSync(f)[0] === 0xef);
    c('the helper, its configuration and the tools\' files are in place, without byte-order marks', !missing.length && !bom.length, missing.length ? `missing: ${missing.join(', ')}` : bom.length ? `BOM in: ${bom.join(', ')}` : want.map((f) => path.basename(f)).join(', '));
  } else {
    // As Jamf runs a policy script (as root), and installs the profile (each payload lands in /Library/Managed Preferences).
    fs.writeFileSync(path.join(TMP, 'install.sh'), file('install-ct-auth-macos.sh'));
    const r = await run(`sudo sh ${q(path.join(TMP, 'install.sh'))}`);
    c('the macOS install script runs as Jamf would (as root)', r.code === 0, (r.out + r.err).trim().slice(-300));
    const mc = path.join(TMP, 'controltower.mobileconfig');
    fs.writeFileSync(mc, file('controltower.mobileconfig'));
    const lint = await run(`plutil -lint ${q(mc)}`);
    const types: string[] = [];
    for (let i = 0; i < 3; i++) {
      const t = (await run(`plutil -extract PayloadContent.${i}.PayloadType raw -o - ${q(mc)}`)).out.trim();
      if (!t) break;
      const p = path.join(TMP, `${t}.plist`);
      await run(`plutil -extract PayloadContent.${i} xml1 -o ${q(p)} ${q(mc)}`);
      for (const k of ['PayloadType', 'PayloadVersion', 'PayloadIdentifier', 'PayloadUUID', 'PayloadDisplayName']) await run(`plutil -remove ${k} ${q(p)}`);
      await run(`sudo mkdir -p "/Library/Managed Preferences" && sudo cp ${q(p)} "/Library/Managed Preferences/${t}.plist" && sudo chmod 644 "/Library/Managed Preferences/${t}.plist"`);
      types.push(t);
    }
    await run('sudo killall cfprefsd || true');
    c('the profile is valid, and its payloads are where macOS puts managed preferences', lint.code === 0 && types.length === 3, `${lint.out.trim()} · ${types.join(', ')}`);
    c('the helper and Claude Code\'s managed-mcp.json are in place', fs.existsSync('/usr/local/bin/ct-auth') && fs.existsSync('/Library/Application Support/ClaudeCode/managed-mcp.json') && fs.existsSync('/Library/Application Support/ControlTower/ct-auth.conf'), 'ct-auth, managed-mcp.json, ct-auth.conf');
  }

  // ---- The person signs in once per tool (their browser would open; here the link is approved for them) ----
  const helper = WIN ? q('C:\\Program Files\\ControlTower\\ct-auth.cmd') : '/usr/local/bin/ct-auth';
  const opened = path.join(TMP, 'opened.txt');
  const opener = path.join(TMP, WIN ? 'open.cmd' : 'open.sh');
  // (cmd splits %1 at "=", so the whole argument: %*.)
  fs.writeFileSync(opener, WIN ? `@echo %*> "${opened}"\r\n` : `#!/bin/sh\nprintf '%s' "$1" > "${opened}"\n`, { mode: 0o755 });
  const signIn = async (client: string) => {
    fs.rmSync(opened, { force: true });
    const p = run(`${helper} login --client ${client}`, { CT_AUTH_OPEN: opener, CT_URL: '' }, 120_000);
    let url = '';
    for (let i = 0; i < 100 && !url; i++) {
      await sleep(300);
      url = fs.existsSync(opened) ? fs.readFileSync(opened, 'utf8').trim().replace(/^"|"$/g, '') : '';
    }
    const code = url ? new URL(url).searchParams.get('code') : null;
    const ok = code ? (await fetch(`${CT}/admin/api/me/devices/approve`, { method: 'POST', headers: { cookie: s.cookie, 'x-ct-csrf': s.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ user_code: code }) })).status : 0;
    const r = await p;
    c(`${client}: ct-auth signs in (the address from the installed configuration)`, r.code === 0 && ok === 200, `approve ${ok}; ${(r.err || r.out).trim().split('\n').pop()}`);
    // The computer shows on Laptops, under the person and the tool.
    const ms = await shows(async () => ((await api('GET', '/admin/api/devices')).sessions as Array<{ person: string; client: string; status: string }>).some((d) => d.person === PERSON && d.client === client && d.status === 'active'));
    c(`${client}: the computer shows on Laptops, under the person`, ms !== null && ms < 10_000, secs(ms));
  };
  await signIn('claude-code');
  await signIn('codex');
  await signIn('claude-desktop');
  await signIn('copilot');
  if (WIN) {
    const dir = path.join(process.env.LOCALAPPDATA ?? '', 'ControlTower');
    const stored = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    const plain = stored.filter((f) => fs.readFileSync(path.join(dir, f), 'utf8').includes('ct_rt_'));
    c('the refresh token is stored encrypted for the person (DPAPI)', stored.some((f) => f.endsWith('.refresh')) && !plain.length, `${stored.length} files in %LOCALAPPDATA%\\ControlTower; readable as plain text: ${plain.length}`);
  } else {
    const kc = await run('security find-generic-password -s "Control Tower (127.0.0.1:4002)" -a claude-code.refresh');
    c('the refresh token is in the keychain', kc.code === 0, kc.code === 0 ? 'found' : kc.err.trim().slice(0, 200));
  }

  // ---- The real tools, with nothing configured but what IT deployed ----
  // Signed in already: a helper that finds no sign-in fails at once instead of waiting for a browser.
  const clean = { ANTHROPIC_API_KEY: undefined, ANTHROPIC_BASE_URL: undefined, ANTHROPIC_AUTH_TOKEN: undefined, OPENAI_API_KEY: undefined, CT_URL: undefined, CT_AUTH_NONINTERACTIVE: '1' };
  const ccAt = seen.length;
  const cc = await run('claude -p "Which gateway?" --output-format stream-json --verbose', { ...clean, CLAUDE_CONFIG_DIR: path.join(TMP, 'claude'), ANTHROPIC_MODEL: MODELS.claude, ANTHROPIC_SMALL_FAST_MODEL: MODELS.fast });
  const events = cc.out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
  const result = events.find((e) => e.type === 'result');
  c('Claude Code answers through Control Tower, its credential from ct-auth', answered(String(result?.result ?? ''), ccAt, /claude-cli/, /^\/v1\/messages/) && result?.is_error !== true, String(result?.result ?? (cc.err || cc.out)).slice(0, 300));
  const ccShows = await shows(async () => (await flightsOf(key.id)).some((f) => f.principal === PERSON && f.client === 'claude-code'));
  c("Claude Code's call shows in Control Tower's flights, as the person, in Claude Code", ccShows !== null && ccShows < 10_000, secs(ccShows));
  c('Claude Code connects to Control Tower\'s MCP endpoint (managed-mcp.json, headersHelper)', (init?.mcp_servers ?? []).some((m: any) => m.name === 'controltower' && m.status === 'connected'), JSON.stringify(init?.mcp_servers ?? null));
  const ver = await run('claude --version');
  console.log('claude', ver.out.trim());

  const cxAt = seen.length;
  const cx = await run(`codex exec --skip-git-repo-check -m ${MODELS.gpt} "Which gateway?"`, clean);
  c('Codex answers through Control Tower (requirements.toml, auth.command)', REMOTE ? cx.code === 0 && !!throughCT(cxAt, /codex/i, /^\/v1\/(responses|chat)/) : (cx.out + cx.err).includes(REPLY), (cx.out + cx.err).trim().slice(-400));
  const cxShows = await shows(async () => (await flightsOf(key.id)).some((f) => f.principal === PERSON && f.client === 'codex'));
  c("Codex's call shows in Control Tower's flights, as the person, in Codex", cxShows !== null && cxShows < 10_000, secs(cxShows));
  const mcpList = await run('codex mcp list', clean);
  c('Codex has Control Tower\'s MCP server, enabled', /controltower\s+\S*127\.0\.0\.1:4002\/mcp[\s\S]*enabled/.test(mcpList.out), mcpList.out.trim().split('\n').slice(0, 3).join(' | ').slice(0, 300));
  c('Codex runs its MCP headers helper without errors, and reads no setting it ignores', !/headers helper exited/i.test(cx.err) && !/no longer supported/i.test(cx.out + cx.err), ((cx.out + cx.err).match(/.*(headers helper|no longer supported).*/i)?.[0] ?? 'no helper errors, no ignored settings').slice(0, 240));
  const cxv = await run('codex --version');
  console.log('codex', cxv.out.trim());

  // GitHub Copilot CLI, with only what the rollout set: machine-wide variables on Windows (read as a new sign-in to
  // Windows would), the file every shell reads on macOS (zsh reads it through /etc/zshenv). No GitHub account.
  const copilotEnv: Record<string, string | undefined> = { ...clean, GITHUB_TOKEN: undefined, GH_TOKEN: undefined, COPILOT_GITHUB_TOKEN: undefined, COPILOT_HOME: path.join(TMP, 'copilot-home') };
  if (WIN) {
    for (const k of ['COPILOT_PROVIDER_TYPE', 'COPILOT_PROVIDER_BASE_URL', 'COPILOT_PROVIDER_API_KEY_COMMAND', 'COPILOT_MODEL', 'COPILOT_OFFLINE']) {
      copilotEnv[k] = (await run(`powershell.exe -NoProfile -Command "[Environment]::GetEnvironmentVariable('${k}', 'Machine')"`)).out.trim();
    }
  }
  // The credential command as Copilot runs it (through the shell): a token, or why not.
  const keyCmd = WIN ? copilotEnv.COPILOT_PROVIDER_API_KEY_COMMAND ?? '' : '/usr/local/bin/ct-auth-copilot';
  const kc = await run(keyCmd, copilotEnv);
  c('Copilot CLI\'s credential command prints a token for the person', kc.code === 0 && /^ct_dt_/.test(kc.out.trim()), `${keyCmd}: exit ${kc.code}${kc.code ? `; ${(kc.err || kc.out).trim().slice(0, 200)}` : `; ${kc.out.trim().slice(0, 6)}… (${kc.out.trim().length} chars)`}`);
  const cplAt = seen.length;
  const cpl = await run(WIN ? 'copilot -p "Which gateway?" --allow-all-tools' : `zsh -c 'copilot -p "Which gateway?" --allow-all-tools'`, copilotEnv);
  c('GitHub Copilot CLI answers through Control Tower (the rollout\'s environment, ct-auth\'s token, no GitHub account)', REMOTE ? cpl.code === 0 && !!throughCT(cplAt, /./, /^\/v1\/(messages|chat|responses)/) : (cpl.out + cpl.err).includes(REPLY), (cpl.out + cpl.err).trim().slice(0, 400));
  const cplv = await run('copilot --version', copilotEnv);
  console.log('copilot', cplv.out.trim());

  // ---- Claude Desktop: installed from Anthropic's release server, opened with only the managed settings ----
  const before = seen.length;
  let app = '';
  if (MAC) {
    const rel = (await (await fetch('https://downloads.claude.ai/releases/darwin/universal/RELEASES.json')).json()) as { releases: Array<{ updateTo: { url: string; version: string } }> };
    const zipUrl = rel.releases[0]!.updateTo.url;
    const zip = path.join(TMP, 'Claude.zip');
    fs.writeFileSync(zip, Buffer.from(await (await fetch(zipUrl)).arrayBuffer()));
    const unz = await run(`ditto -x -k ${q(zip)} /Applications`);
    app = '/Applications/Claude.app';
    c('Claude Desktop installs (from downloads.claude.ai)', unz.code === 0 && fs.existsSync(app), `${rel.releases[0]!.updateTo.version}${unz.code ? `: ${unz.err.slice(0, 200)}` : ''}`);
    await run(`open ${q(app)}`);
  } else {
    // The same installer Windows' package manager (winget) uses: per user, silent.
    const gh = process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : undefined;
    const manifest = await (await fetch('https://api.github.com/repos/microsoft/winget-pkgs/contents/manifests/a/Anthropic/Claude', { headers: gh })).json() as Array<{ name: string }>;
    if (!Array.isArray(manifest)) throw new Error(`GitHub's API: ${JSON.stringify(manifest).slice(0, 200)}`);
    const ver = manifest.map((m) => m.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1)!;
    const yaml = await (await fetch(`https://raw.githubusercontent.com/microsoft/winget-pkgs/master/manifests/a/Anthropic/Claude/${ver}/Anthropic.Claude.installer.yaml`)).text();
    const exeUrl = /InstallerUrl:\s*(https:\/\/downloads\.claude\.ai\/\S+x64\S+\.exe)/.exec(yaml)?.[1];
    if (!exeUrl) throw new Error('no Claude Desktop installer for Windows x64 in the winget manifest');
    const exe = path.join(TMP, 'ClaudeSetup.exe');
    fs.writeFileSync(exe, Buffer.from(await (await fetch(exeUrl)).arrayBuffer()));
    const inst = await run(`${q(exe)} --silent`, {}, 300_000);
    const local = process.env.LOCALAPPDATA ?? '';
    const candidates = [path.join(local, 'AnthropicClaude', 'claude.exe'), path.join(local, 'AnthropicClaude', 'Claude.exe'), path.join(local, 'Programs', 'Claude', 'Claude.exe')];
    app = candidates.find((f) => fs.existsSync(f)) ?? '';
    c('Claude Desktop installs (from downloads.claude.ai, the winget installer)', !!app, `${ver}${app ? ` at ${app}` : `: not found (installer exit ${inst.code})`}`);
    if (app) spawn(app, [], { detached: true, stdio: 'ignore' }).unref();
  }
  // At launch, a gateway-mode Claude Desktop lists the gateway's models with its credential, and connects its MCP servers.
  let models: (typeof seen)[number] | undefined;
  let mcp: (typeof seen)[number] | undefined;
  for (let i = 0; i < 90 && !(models && mcp); i++) {
    await sleep(1000);
    const fresh = seen.slice(before).filter((x) => !/ct-auth/.test(x.ua));
    models ??= fresh.find((x) => x.path === '/v1/models');
    mcp ??= fresh.find((x) => x.path.startsWith('/mcp'));
  }
  // Through the OS's accessibility automation (Claude Desktop won't run with a debugging port): the welcome screen's
  // Continue, then one message.
  const shots = process.env.RESULTS_DIR ?? TMP;
  const os_ = WIN ? 'windows' : 'macos';
  const screenshot = async (name: string) => {
    const f = path.join(shots, `claude-desktop-${os_}-${name}.png`);
    if (MAC) await run(`screencapture -x ${q(f)}`);
    else await run(`powershell.exe -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $i=New-Object System.Drawing.Bitmap $b.Width,$b.Height; [System.Drawing.Graphics]::FromImage($i).CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $i.Save('${f}')"`);
  };
  const ui = async (script: string) => {
    const f = path.join(TMP, MAC ? 'ui.applescript' : 'ui.ps1');
    fs.writeFileSync(f, script);
    return run(MAC ? `osascript ${q(f)}` : `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${q(f)}`, {}, 120_000);
  };
  let drove = '';
  let chat: (typeof seen)[number] | undefined;
  await screenshot('1-welcome');
  const clicked = MAC
    ? await ui(`tell application "Claude" to activate
delay 2
-- Electron shows its web content to automation once asked to (AXManualAccessibility): then press Continue by name,
-- or, failing that, click where it sits.
tell application "System Events" to tell process "Claude"
  try
    set value of attribute "AXManualAccessibility" to true
  end try
end tell
delay 2
tell application "System Events" to tell process "Claude"
  repeat 15 times
    try
      set b to first UI element of (entire contents of window 1) whose role is "AXButton" and (title is "Continue" or description is "Continue" or name is "Continue")
      perform action "AXPress" of b
      return "true (by name)"
    end try
    delay 1
  end repeat
  set {px, py} to position of window 1
  set {sw, sh} to size of window 1
end tell
tell application "System Events" to click at {px + sw / 2, py + sh * 0.608}
return "true (by position)"`)
    : await ui(`Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$cond = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty, 'Continue')
$b = $null
for ($i = 0; $i -lt 30 -and -not $b; $i++) { $b = [Windows.Automation.AutomationElement]::RootElement.FindFirst([Windows.Automation.TreeScope]::Descendants, $cond); if (-not $b) { Start-Sleep 1 } }
if (-not $b) { 'false'; exit }
try { $b.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke() } catch { $b.SetFocus(); [System.Windows.Forms.SendKeys]::SendWait('{ENTER}') }
'true'`);
  drove = /true/.test(clicked.out) ? `clicked Continue ${clicked.out.trim().replace('true', '')}`.trim() : `Continue not clicked: ${(clicked.err || clicked.out).trim().slice(0, 200)}`;
  for (let i = 0; i < 60 && !models; i++) {
    await sleep(1000);
    models ??= seen.slice(before).filter((x) => !/ct-auth/.test(x.ua)).find((x) => x.path === '/v1/models');
  }
  await sleep(4000);
  await screenshot('2-after-continue');
  // The message box has the focus in a new chat: type, and send.
  const typed = MAC
    ? await ui(`tell application "Claude" to activate
delay 1
tell application "System Events"
  keystroke "Which gateway are you going through?"
  delay 0.5
  key code 36
end tell`)
    : await ui(`Add-Type -AssemblyName System.Windows.Forms
$ws = New-Object -ComObject WScript.Shell
$null = $ws.AppActivate('Claude')
Start-Sleep 1
[System.Windows.Forms.SendKeys]::SendWait('Which gateway are you going through?')
Start-Sleep -Milliseconds 500
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')`);
  if (typed.code) drove += `; typing failed: ${(typed.err || typed.out).trim().slice(0, 160)}`;
  for (let i = 0; i < 60 && !chat; i++) {
    await sleep(1000);
    chat = seen.slice(before).filter((x) => !/ct-auth/.test(x.ua)).find((x) => x.method === 'POST' && x.path.startsWith('/v1/messages'));
  }
  await sleep(5000);
  await screenshot('3-chat');
  drove += chat ? '; a model request went through' : '; no model request';
  // (A model request: the typed message itself waits for a project folder on the Code tab, and Cowork needs hardware
  // virtualization these machines don't have. The screenshots show where it got to.)
  c('Claude Desktop makes model requests through Control Tower with ct-auth\'s token', !!chat && chat.cred === 'ct_dt' && chat.status === 200, chat ? `${chat.method} ${chat.path}: ${chat.cred} → ${chat.status}; ${drove}` : `no chat request; ${drove}`);

  // ---- Windows: a held message, told in Claude's conversation (the Mac is covered by scripts/demo-desktop.mts) ----
  // The Code tab sends a message once a project folder is open: open one, put a hold gate on Sonnet for this key, send,
  // and read what Claude shows (its window's text, through UI Automation) while it waits and once approved.
  if (WIN) {
    const folder = path.join(TMP, 'acme-reports');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'README.md'), '# Q3 pipeline\n\n42 open deals, $3.1M.\n');
    // UI Automation over Claude's window: its elements' names, or press the first whose name matches.
    const uia = (body: string) =>
      ui(`Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,System.Windows.Forms
Add-Type @"
using System; using System.Runtime.InteropServices;
public class M { [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(int f, int x, int y, int d, int e);
public static void Click(int x, int y) { SetCursorPos(x, y); mouse_event(2,0,0,0,0); mouse_event(4,0,0,0,0); } }
"@
function Wins { Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { [Windows.Automation.AutomationElement]::FromHandle($_.MainWindowHandle) } }
function Claude { Get-Process claude -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1 | ForEach-Object { [Windows.Automation.AutomationElement]::FromHandle($_.MainWindowHandle) } }
function All($w) { $w.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition) }
function Press($w, $re) {
  foreach ($e in (All $w)) {
    $n = $e.Current.Name
    if ($n -and $n -match $re -and -not $e.Current.IsOffscreen) {
      try { $e.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke(); return "invoked: $n" } catch {}
      $r = $e.Current.BoundingRectangle
      if ($r.Width -gt 0) { [M]::Click([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2)); return "clicked: $n" }
    }
  }
  return 'not found'
}
${body}`);
    const claudeText = async () => (await uia(`$w = Claude; if ($w) { (All $w | ForEach-Object { $_.Current.Name } | Where-Object { $_ }) -join "\`n" }`)).out;
    const dump = async (name: string) => fs.writeFileSync(path.join(shots, `claude-desktop-windows-uia-${name}.txt`), await claudeText());
    const steps: string[] = [];
    // The Code tab, pressed even when it looks selected (a new window can open on Cowork's "New task").
    steps.push(`code tab ${(await uia(`Press (Claude) '^Code$'`)).out.trim()}`);
    await sleep(2500);
    await dump('a-before-folder');
    steps.push(`folder button ${(await uia(`Press (Claude) 'Project or folder'`)).out.trim()}`);
    await sleep(2500);
    await screenshot('4-folder-menu');
    await dump('b-folder-menu');
    steps.push(`menu ${(await uia(`Press (Claude) '(Open|Choose|Select|Add|Browse).*(folder|project)|^Folder'`)).out.trim()}`);
    await sleep(3000);
    await screenshot('5-folder-dialog');
    // The folder picker: its address bar (Alt+D) to go to the folder, then Select Folder (which picks the folder shown).
    const picked = await uia(`$out = ''
$pick = $null
foreach ($w in (Wins)) { foreach ($e in (All $w)) { if ($e.Current.Name -eq 'Select Folder' -and -not $e.Current.IsOffscreen) { $pick = $w; break } }; if ($pick) { break } }
if ($pick) { $pick.SetFocus(); $out += "picker: $($pick.Current.Name)" } else { $out += 'no picker window' }
Start-Sleep -Milliseconds 500
[System.Windows.Forms.SendKeys]::SendWait('%d')
Start-Sleep -Milliseconds 600
[System.Windows.Forms.SendKeys]::SendWait('${folder.replace(/'/g, "''")}')
Start-Sleep -Milliseconds 600
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Start-Sleep 2
if ($pick) { $out += "; " + (Press $pick '^Select Folder$') }
$out`);
    steps.push(`picker ${picked.out.trim()}`);
    await sleep(3000);
    // "Allow Claude to change files in …?": allow (or, in some versions, trust the workspace).
    const trust = await uia(`Press (Claude) '^(Allow|Trust workspace|Trust)$'`);
    steps.push(`allow ${trust.out.trim()}`);
    await sleep(2000);
    await screenshot('6-folder-open');
    await dump('c-after-folder');
    const rule = await api('POST', '/admin/api/rules', { name: REMOTE ? `Sonnet needs a manager (${PERSON})` : 'Sonnet needs a manager', target_kind: 'model', match: { models: [MODELS.claude], keys: [key.id] }, effect: 'require_approval', config: { hold_ms: 180_000 }, priority: 10 });
    const sentAt = seen.length;
    // The message box keeps the focus: clear what an earlier step typed, then the message.
    // (Maximized first: the runner's screen is narrower than Claude's window, which put its send button off screen.)
    const sent = await uia(`$w = Claude; if ($w) { try { $w.GetCurrentPattern([Windows.Automation.WindowPattern]::Pattern).SetWindowVisualState([Windows.Automation.WindowVisualState]::Maximized) } catch {}; Start-Sleep 1; $w.SetFocus() }
$r = Press (Claude) '^Write your prompt'
Start-Sleep -Milliseconds 600
[System.Windows.Forms.SendKeys]::SendWait('^a')
[System.Windows.Forms.SendKeys]::SendWait('{DEL}')
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait('Draft the board update')
Start-Sleep -Milliseconds 500
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
"box: $r; sent with Enter"`);
    steps.push(sent.out.trim());
    // Enter didn't start it: the send button (Start task), clicked where it is.
    for (let i = 0; i < 6 && !seen.slice(sentAt).some((x) => x.path.startsWith('/v1/messages')); i++) await sleep(1000);
    if (!seen.slice(sentAt).some((x) => x.path.startsWith('/v1/messages'))) {
      const clicked = await uia(`$w = Claude
foreach ($e in (All $w)) { if ($e.Current.Name -match '^(Start task|Send|Send message)$') { $r = $e.Current.BoundingRectangle; if ($r.Width -gt 0) { [M]::Click([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2)); "clicked $($e.Current.Name) at $([int]$r.X),$([int]$r.Y)"; break } } }`);
      steps.push(clicked.out.trim() || 'no send button');
      await sleep(3000);
      await screenshot('6b-after-send');
      await dump('c2-after-send');
    }
    let card: { id: string } | undefined;
    for (let i = 0; i < 60 && !card; i++) {
      await sleep(1000);
      card = ((await api('GET', '/admin/api/approvals?status=pending')).approvals ?? []).find((a: { requester: string | null }) => a.requester === PERSON);
    }
    await sleep(4000);
    await screenshot('7-waiting');
    await dump('d-waiting');
    const waiting = await claudeText();
    c('Claude Desktop on Windows: a held message says so in the conversation, while it waits', !!card && /waiting for approval/.test(waiting), card ? `card ${card.id.slice(-6)}; ${(waiting.match(/.*waiting for approval.*/)?.[0] ?? 'no "waiting" line in the window').slice(0, 200)}; ${steps.join('; ')}` : `nothing held (${seen.slice(sentAt).filter((x) => x.path.startsWith('/v1/messages')).length} model calls); ${steps.join('; ')}`);
    if (card) {
      await api('POST', `/admin/api/approvals/${card.id}/decide`, { action: 'approve' });
      await sleep(8000);
      await screenshot('8-approved');
      await dump('e-approved');
      const after = await claudeText();
      c('Claude Desktop on Windows: once approved, it says who approved, then the answer follows', /approved by/.test(after) && (REMOTE ? after.length > waiting.length : after.includes(REPLY)), (after.match(/.*approved by.*/)?.[0] ?? 'no "approved by" line').slice(0, 200));
    }
    await api('DELETE', `/admin/api/rules/${rule.id}`);
  }
  const shot = path.join(shots, `claude-desktop-${os_}.png`);
  if (MAC) await run(`screencapture -x ${q(shot)}`);
  else await run(`powershell.exe -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $i=New-Object System.Drawing.Bitmap $b.Width,$b.Height; [System.Drawing.Graphics]::FromImage($i).CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $i.Save('${shot}')"`);
  const others = seen.slice(before).filter((x) => !/ct-auth/.test(x.ua)).map((x) => `${x.method} ${x.path} ${x.cred} ${x.status}`);
  c('Claude Desktop lists Control Tower\'s models with ct-auth\'s token (managed settings, credential helper)', !!models && models.cred === 'ct_dt' && models.status === 200, models ? `${models.method} ${models.path}: ${models.cred} → ${models.status} (${models.ua.slice(0, 60)})` : `not seen; requests: ${others.slice(0, 8).join(', ') || 'none'}`);
  c('Claude Desktop connects to Control Tower\'s MCP endpoint (managedMcpServers, headersHelper)', !!mcp && mcp.cred === 'ct_dt' && mcp.status < 400, mcp ? `${mcp.method} ${mcp.path}: ${mcp.cred} → ${mcp.status}` : `not seen; requests: ${others.slice(0, 8).join(', ') || 'none'}`);
  if (MAC) await run('osascript -e \'quit app "Claude"\'');
  else await run('taskkill /IM claude.exe /F');

  // ---- In Control Tower: the calls, as the person ----
  await sleep(1500);
  const flights = await flightsOf(key.id);
  const theirs = flights.filter((f) => f.principal === PERSON);
  c('Control Tower records Copilot CLI\'s calls as the person, in Copilot', theirs.some((f) => f.client === 'copilot'), [...new Set(theirs.map((f) => f.client ?? 'unknown'))].join(', '));
  c('Control Tower records both tools\' calls as the person', theirs.some((f) => f.model_requested.startsWith('claude')) && theirs.some((f) => f.model_requested.startsWith('gpt')), `${theirs.length} calls as ${PERSON}: ${[...new Set(theirs.map((f) => f.model_requested))].join(', ')}`);
  const devices = (((await api('GET', '/admin/api/devices')).sessions ?? []) as Array<{ person: string; client: string; device_name: string; status: string }>).filter((d) => d.person === PERSON);
  c('Laptops lists the computer, once per tool', devices.filter((d) => d.status === 'active').length === 4, devices.map((d) => `${d.client} on ${d.device_name}`).join(', '));
} finally {
  const failed = checks.filter((x) => !x.pass).length;
  fs.writeFileSync(path.join(process.env.RESULTS_DIR ?? REPO, 'laptops-real-results.json'), JSON.stringify({ platform: process.platform, ran_at: new Date().toISOString(), checks }, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Laptops on ${WIN ? 'Windows' : 'macOS'}: ${checks.length - failed} of ${checks.length}\n\n${checks.map((x) => `- ${x.pass ? '✅' : '❌'} ${x.what} — ${x.detail.replace(/\n/g, ' ')}`).join('\n')}\n`);
  console.log(`${checks.length - failed} of ${checks.length} passed`);
  ct?.kill();
  recorder.close();
  await ant?.close();
  await oai?.close();
  await files?.close();
  process.exitCode = failed || !checks.length ? 1 : 0;
}
