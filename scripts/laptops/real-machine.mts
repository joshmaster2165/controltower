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
 */
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
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
const CT = `http://127.0.0.1:${PORT}`;
const AK = 'real-machine-admin-key-0123456789abcdef';
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

const ant = await anthropicUpstream({ reply: REPLY, models: ['claude-sonnet-4-5', 'claude-haiku-4-5'] });
const oai = await openAiUpstream({ reply: REPLY, models: ['gpt-5'] });
const files = await mcpUpstream('files-token');
const ct: ChildProcess = spawn(process.execPath, ['server/dist/server.mjs', '--port', String(PORT)], {
  cwd: REPO,
  env: { ...process.env, CT_DATA_DIR: path.join(TMP, 'data'), CT_ADMIN_KEY: AK, CT_UI_DIR: path.join(REPO, 'ui/dist'), CT_LOG_LEVEL: 'warn', CT_LICENSE_PUBLIC_KEY: TEST_LICENSE_PUBLIC_KEY, CT_LICENSE_KEY: testLicense(), CT_LICENSE_SERVER: 'off', CT_MODEL_HEALTH_INTERVAL_S: '0' },
  stdio: ['ignore', 'inherit', 'inherit'],
});
for (let i = 0; ; i++) {
  if ((await fetch(`${CT}/healthz`).catch(() => null))?.ok) break;
  if (i > 150) throw new Error('Control Tower did not start (a test build is needed: CT_TEST_LICENSE_KEYS=1 pnpm build)');
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
  const up = http.request({ host: '127.0.0.1', port: PORT, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${RECORD_PORT}` } }, (r) => {
    seen.push({ method: req.method ?? '', path: (req.url ?? '').split('?')[0]!, ua: String(req.headers['user-agent'] ?? ''), cred, status: r.statusCode ?? 0 });
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on('error', () => (res.writeHead(502), res.end()));
  req.pipe(up);
});
await new Promise<void>((r) => recorder.listen(RECORD_PORT, '127.0.0.1', () => r()));
const api = (method: string, p: string, body?: unknown) =>
  fetch(CT + p, { method, headers: { authorization: `Bearer ${AK}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }).then(async (r) => (await r.json().catch(() => ({}))) as any);

try {
  // ---- Control Tower: providers, a tool server, a key, a rule, and a person ----
  await api('POST', '/admin/api/providers', { catalog_id: 'anthropic', base_url: ant.url, credentials: { api_key: 'sk-ant-real' } });
  const op = await api('POST', '/admin/api/providers', { catalog_id: 'custom', name: 'OpenAI', slug: 'openai', base_url: `${oai.url}/v1`, credentials: { api_key: 'sk-real' } });
  await api('POST', '/admin/api/deployments', { provider_id: (op.provider ?? op).id, upstream_model: 'gpt-5', public_name: 'gpt-5' });
  await api('POST', '/admin/api/mcp/servers', { name: 'Files', slug: 'files', url: `${files.url}/mcp`, auth: { type: 'bearer', token: 'files-token' } });
  const key = await api('POST', '/admin/api/keys', { name: 'laptops', agent_id: 'laptops' });
  await api('PUT', '/admin/api/devices/rules', { rules: [{ client: '*', team_id: null, key_id: key.id }] });
  const made = await api('POST', '/admin/api/users', { email: 'dev@acme.example', role: 'viewer' });
  const login = async (pw: string) => {
    const r = await fetch(`${CT}/admin/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'dev@acme.example', password: pw }) });
    return { cookie: r.headers.getSetCookie().map((x) => x.split(';')[0]).join('; '), csrf: ((await r.json()) as { csrf: string }).csrf };
  };
  let s = await login(made.password);
  await fetch(`${CT}/admin/api/me/password`, { method: 'POST', headers: { cookie: s.cookie, 'x-ct-csrf': s.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ current: made.password, password: 'dev-password-123' }) });
  s = await login('dev-password-123');

  // ---- What IT deploys ----
  const roll = await api('GET', `/admin/api/devices/rollout?url=${encodeURIComponent(GW)}&clients=claude-code,claude-desktop,codex&mcp=1&lockdown=1`);
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
  };
  await signIn('claude-code');
  await signIn('codex');
  await signIn('claude-desktop');
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
  const cc = await run('claude -p "Which gateway?" --output-format stream-json --verbose', { ...clean, CLAUDE_CONFIG_DIR: path.join(TMP, 'claude'), ANTHROPIC_MODEL: 'claude-sonnet-4-5', ANTHROPIC_SMALL_FAST_MODEL: 'claude-haiku-4-5' });
  const events = cc.out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
  const result = events.find((e) => e.type === 'result');
  c('Claude Code answers through Control Tower, its credential from ct-auth', String(result?.result ?? '').includes('Connected through Control Tower'), String(result?.result ?? (cc.err || cc.out)).slice(0, 300));
  c('Claude Code connects to Control Tower\'s MCP endpoint (managed-mcp.json, headersHelper)', (init?.mcp_servers ?? []).some((m: any) => m.name === 'controltower' && m.status === 'connected'), JSON.stringify(init?.mcp_servers ?? null));
  const ver = await run('claude --version');
  console.log('claude', ver.out.trim());

  const cx = await run('codex exec --skip-git-repo-check -m gpt-5 "Which gateway?"', clean);
  c('Codex answers through Control Tower (requirements.toml, auth.command)', (cx.out + cx.err).includes('Connected through Control Tower'), (cx.out + cx.err).trim().slice(-400));
  const mcpList = await run('codex mcp list', clean);
  c('Codex has Control Tower\'s MCP server, enabled', /controltower\s+\S*127\.0\.0\.1:4002\/mcp[\s\S]*enabled/.test(mcpList.out), mcpList.out.trim().split('\n').slice(0, 3).join(' | ').slice(0, 300));
  c('Codex runs its MCP headers helper without errors, and reads no setting it ignores', !/headers helper exited/i.test(cx.err) && !/no longer supported/i.test(cx.out + cx.err), ((cx.out + cx.err).match(/.*(headers helper|no longer supported).*/i)?.[0] ?? 'no helper errors, no ignored settings').slice(0, 240));
  const cxv = await run('codex --version');
  console.log('codex', cxv.out.trim());

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
  const flights = ((await api('GET', `/admin/api/flights?key_id=${key.id}&limit=100`)).flights ?? []) as Array<{ principal: string | null; model_requested: string }>;
  const mine = flights.filter((f) => f.principal === 'dev@acme.example');
  c('Control Tower records both tools\' calls as the person', mine.some((f) => f.model_requested.startsWith('claude')) && mine.some((f) => f.model_requested.startsWith('gpt')), `${mine.length} calls as dev@acme.example: ${[...new Set(mine.map((f) => f.model_requested))].join(', ')}`);
  const devices = ((await api('GET', '/admin/api/devices')).sessions ?? []) as Array<{ client: string; device_name: string; status: string }>;
  c('Laptops lists the computer, once per tool', devices.filter((d) => d.status === 'active').length === 3, devices.map((d) => `${d.client} on ${d.device_name}`).join(', '));
} finally {
  const failed = checks.filter((x) => !x.pass).length;
  fs.writeFileSync(path.join(process.env.RESULTS_DIR ?? REPO, 'laptops-real-results.json'), JSON.stringify({ platform: process.platform, ran_at: new Date().toISOString(), checks }, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Laptops on ${WIN ? 'Windows' : 'macOS'}: ${checks.length - failed} of ${checks.length}\n\n${checks.map((x) => `- ${x.pass ? '✅' : '❌'} ${x.what} — ${x.detail.replace(/\n/g, ' ')}`).join('\n')}\n`);
  console.log(`${checks.length - failed} of ${checks.length} passed`);
  ct.kill();
  recorder.close();
  await ant.close();
  await oai.close();
  await files.close();
  process.exitCode = failed || !checks.length ? 1 : 0;
}
