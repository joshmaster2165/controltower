/**
 * Claude Desktop through Control Tower, recorded on a macOS runner (GitHub Actions): a Mac managed by IT, Claude
 * Desktop installed from Anthropic's release server, the person's first sign-in, a prompt an inspect gate blocks and
 * one a gate holds for approval. The gates, holds and approvals are Control Tower's own; the model is a stand-in.
 *
 *   CT_TEST_LICENSE_KEYS=1 pnpm build && npx tsx scripts/demo-desktop.mts        (on the runner; it changes the Mac)
 *
 * STAGE=explore (the default for now) only finds its way around Claude Desktop's first run and takes screenshots.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { anthropicUpstream } from '../e2e/support/upstreams.ts';
import { TEST_LICENSE_PUBLIC_KEY, testLicense } from '../e2e/support/license.ts';

if (process.platform !== 'darwin' || (!process.env.CI && !process.env.CT_REAL_MACHINE)) throw new Error('macOS CI runners only: it installs system settings and Claude Desktop');
const REPO = path.resolve(import.meta.dirname, '..');
const OUT = process.env.RESULTS_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'demo-desktop-'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-demo-'));
fs.mkdirSync(OUT, { recursive: true });
const PORT = 4000;
const GW_PORT = 4002;
const GW = `http://127.0.0.1:${GW_PORT}`;
const AK = 'demo-desktop-admin-key-0123456789abcdef';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (s: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
const q = (s: string) => `"${s}"`;
function run(line: string, timeoutMs = 120_000): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(line, { shell: true, cwd: TMP, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const t = setTimeout(() => p.kill(), timeoutMs);
    p.on('exit', (code) => (clearTimeout(t), resolve({ code: code ?? -1, out, err })));
  });
}
let shotN = 0;
const shot = async (name: string) => {
  const f = path.join(OUT, `${String(++shotN).padStart(2, '0')}-${name}.png`);
  await run(`screencapture -x ${q(f)}`);
  log(`screenshot ${path.basename(f)}`);
};
const osa = (script: string) => {
  const f = path.join(TMP, `s${Date.now()}.applescript`);
  fs.writeFileSync(f, script);
  return run(`osascript ${q(f)}`);
};

// ---- Control Tower, a stand-in model, and a recorder in front (to see what the Mac sends, and catch the sign-in code) ----
const ant = await anthropicUpstream({ reply: 'Here is a summary of the Q3 pipeline: 42 open deals worth $3.1M, with the largest three closing in October.', models: ['claude-sonnet-4-5', 'claude-haiku-4-5'] });
const ct: ChildProcess = spawn(process.execPath, ['server/dist/server.mjs', '--port', String(PORT)], {
  cwd: REPO,
  env: { ...process.env, CT_DATA_DIR: path.join(TMP, 'data'), CT_ADMIN_KEY: AK, CT_UI_DIR: path.join(REPO, 'ui/dist'), CT_LOG_LEVEL: 'warn', CT_LICENSE_PUBLIC_KEY: TEST_LICENSE_PUBLIC_KEY, CT_LICENSE_KEY: testLicense({ customer: 'Acme Corp' }), CT_LICENSE_SERVER: 'off', CT_MODEL_HEALTH_INTERVAL_S: '0', CT_HOLD_BUDGET_MS: '120000' },
  stdio: ['ignore', 'inherit', 'inherit'],
});
for (let i = 0; ; i++) {
  if ((await fetch(`http://127.0.0.1:${PORT}/healthz`).catch(() => null))?.ok) break;
  if (i > 150) throw new Error('Control Tower did not start');
  await sleep(200);
}
const seen: Array<{ method: string; url: string; ua: string; status: number }> = [];
const recorder = http.createServer((req, res) => {
  const up = http.request({ host: '127.0.0.1', port: PORT, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${GW_PORT}` } }, (r) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', ua: String(req.headers['user-agent'] ?? ''), status: r.statusCode ?? 0 });
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on('error', () => (res.writeHead(502), res.end()));
  req.pipe(up);
});
await new Promise<void>((r) => recorder.listen(GW_PORT, '127.0.0.1', () => r()));
const api = (method: string, p: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { authorization: `Bearer ${AK}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }).then(async (r) => (await r.json().catch(() => ({}))) as any);

try {
  const prov = await api('POST', '/admin/api/providers', { catalog_id: 'anthropic', base_url: ant.url, credentials: { api_key: 'sk-ant-demo' } });
  // Claude Desktop lists the Claude models Control Tower serves, and won't start without one.
  for (const m of ['claude-sonnet-4-5', 'claude-haiku-4-5']) await api('POST', '/admin/api/deployments', { provider_id: (prov.provider ?? prov).id, upstream_model: m, public_name: m });
  const key = await api('POST', '/admin/api/keys', { name: 'claude-desktop', agent_id: 'claude-desktop', team: 'finance' });
  await api('PUT', '/admin/api/devices/rules', { rules: [{ client: '*', team_id: null, key_id: key.id }] });
  const made = await api('POST', '/admin/api/users', { email: 'dana@acme.com', role: 'viewer' });
  fs.writeFileSync(path.join(TMP, 'person.json'), JSON.stringify({ email: 'dana@acme.com', password: made.password }));

  // ---- IT's rollout: ct-auth, and Claude Desktop's managed settings (as an MDM delivers them) ----
  const roll = await api('GET', `/admin/api/devices/rollout?url=${encodeURIComponent(GW)}&clients=claude-desktop&mcp=0&lockdown=1`);
  const file = (n: string) => (roll.files as Array<{ name: string; content: string }>).find((f) => f.name === n)!.content;
  fs.writeFileSync(path.join(TMP, 'install.sh'), file('install-ct-auth-macos.sh'));
  log(`install: ${(await run(`sudo sh ${q(path.join(TMP, 'install.sh'))}`)).code}`);
  const mc = path.join(TMP, 'controltower.mobileconfig');
  fs.writeFileSync(mc, file('controltower.mobileconfig'));
  const p = path.join(TMP, 'com.anthropic.claudefordesktop.plist');
  await run(`plutil -extract PayloadContent.0 xml1 -o ${q(p)} ${q(mc)}`);
  for (const k of ['PayloadType', 'PayloadVersion', 'PayloadIdentifier', 'PayloadUUID', 'PayloadDisplayName']) await run(`plutil -remove ${k} ${q(p)}`);
  await run(`sudo mkdir -p "/Library/Managed Preferences" && sudo cp ${q(p)} "/Library/Managed Preferences/com.anthropic.claudefordesktop.plist" && sudo killall cfprefsd || true`);

  // ---- What the screen can do: its size, and recording video ----
  await run('brew install cliclick displayplacer', 300_000);
  const disp = (await run('displayplacer list')).out.match(/id:(\S+) res:/)?.[1];
  if (disp) log(`1920x1080: ${(await run(`displayplacer "id:${disp} res:1920x1080 hz:60 color_depth:7 scaling:off origin:(0,0) degree:0"`)).code}`);
  await sleep(3000);
  log(`displays: ${(await run('displayplacer list')).out.split('\n').filter((l) => /Resolution|res:|mode/i.test(l)).slice(0, 30).join(' | ').slice(0, 1500)}`);
  const vid = await run(`screencapture -v -V 3 ${q(path.join(OUT, 'probe.mov'))}`, 30_000);
  log(`screencapture -v: exit ${vid.code} ${vid.err.trim().slice(0, 160)}; file ${fs.existsSync(path.join(OUT, 'probe.mov')) ? fs.statSync(path.join(OUT, 'probe.mov')).size : 0} bytes`);

  // ---- Claude Desktop: install, open, Continue ----
  const rel = (await (await fetch('https://downloads.claude.ai/releases/darwin/universal/RELEASES.json')).json()) as { releases: Array<{ updateTo: { url: string; version: string } }> };
  const zip = path.join(TMP, 'Claude.zip');
  fs.writeFileSync(zip, Buffer.from(await (await fetch(rel.releases[0]!.updateTo.url)).arrayBuffer()));
  log(`unzip: ${(await run(`ditto -x -k ${q(zip)} /Applications`)).code} (${rel.releases[0]!.updateTo.version})`);
  await run('open /Applications/Claude.app');
  await sleep(12_000);
  await shot('welcome');
  const pos = await osa(`tell application "System Events" to tell process "Claude"
  set {px, py} to position of window 1
  set {sw, sh} to size of window 1
end tell
return (px as text) & "," & (py as text) & "," & (sw as text) & "," & (sh as text)`);
  log(`window: ${pos.out.trim()}`);
  const [px, py, sw, sh] = pos.out.trim().split(',').map(Number) as [number, number, number, number];
  // Click like a person: the app in front, its web content exposed to accessibility (Electron asks for it), then
  // System Events' click at the button's place; a real mouse click (cliclick) if that doesn't take.
  const clickAt = async (x: number, y: number) => {
    await osa(`tell application "Claude" to activate
tell application "System Events" to tell process "Claude"
  try
    set value of attribute "AXManualAccessibility" to true
  end try
end tell
delay 2
tell application "System Events" to click at {${Math.round(x)}, ${Math.round(y)}}`);
  };
  await clickAt(px + sw / 2, py + sh * 0.608);
  await sleep(4000);
  await shot('after-ax-click');
  if (!seen.length) {
    const c = await run(`cliclick c:${Math.round(px + sw / 2)},${Math.round(py + sh * 0.608)}`);
    log(`cliclick: ${c.code} ${c.err.trim().slice(0, 120)}`);
  }
  // Not signed in yet: the helper opens the browser at /device?code=…; the recorder sees the code.
  let code = '';
  for (let i = 0; i < 40 && !code; i++) {
    await sleep(1000);
    const d = seen.find((x) => x.url.startsWith('/device?code='));
    if (d) code = new URL(d.url, GW).searchParams.get('code') ?? '';
  }
  await shot('after-continue');
  log(`sign-in code from the browser: ${code || 'none'}; requests: ${seen.map((x) => `${x.method} ${x.url.split('?')[0]} ${x.status}`).slice(0, 12).join(', ')}`);
  if (code) {
    // (In the video Dana signs in and approves on that page; here, through her session.)
    const login = async (pw: string) => {
      const r = await fetch(`http://127.0.0.1:${PORT}/admin/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'dana@acme.com', password: pw }) });
      return { cookie: r.headers.getSetCookie().map((x) => x.split(';')[0]).join('; '), csrf: ((await r.json()) as { csrf: string }).csrf };
    };
    let s = await login(made.password);
    await fetch(`http://127.0.0.1:${PORT}/admin/api/me/password`, { method: 'POST', headers: { cookie: s.cookie, 'x-ct-csrf': s.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ current: made.password, password: 'dana-password-123' }) });
    s = await login('dana-password-123');
    const ok = await fetch(`http://127.0.0.1:${PORT}/admin/api/me/devices/approve`, { method: 'POST', headers: { cookie: s.cookie, 'x-ct-csrf': s.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ user_code: code }) });
    log(`approved: ${ok.status}`);
    await run('osascript -e \'quit app "Safari"\'');
    await sleep(15_000);
    await run('osascript -e \'tell application "Claude" to activate\'');
    await sleep(2000);
    await shot('signed-in');
  }
  // ---- Finding a chat: the Code tab wants a project folder ----
  fs.mkdirSync('/Users/runner/acme-reports', { recursive: true });
  fs.writeFileSync('/Users/runner/acme-reports/README.md', '# Q3 pipeline\n');
  const ax = await osa(`tell application "System Events" to tell process "Claude"
  try
    set value of attribute "AXManualAccessibility" to true
  end try
  delay 2
  set out to ""
  repeat with e in (entire contents of window 1)
    try
      set r to role of e
      if r is in {"AXButton", "AXTextArea", "AXTextField", "AXRadioButton", "AXTab", "AXPopUpButton", "AXMenuButton", "AXLink"} then
        set out to out & r & " | " & (description of e as text) & " | " & (title of e as text) & " | " & (value of e as text) & linefeed
      end if
    end try
  end repeat
  return out
end tell`);
  fs.writeFileSync(path.join(OUT, 'claude-desktop-elements.txt'), ax.out + ax.err);
  log(`elements: ${ax.out.split('\n').length} (saved)`);
  await shot('main');
  // What Claude Desktop shows to accessibility (so the video can click by name).
  const tree = await osa(`tell application "Claude" to activate
delay 1
tell application "System Events" to tell process "Claude"
  try
    set value of attribute "AXManualAccessibility" to true
  end try
end tell
delay 3
tell application "System Events" to tell process "Claude"
  set out to ""
  set els to entire contents of window 1
  repeat with e in els
    try
      set out to out & (role of e as text) & " | " & (description of e as text) & " | " & (name of e as text) & " | " & ((position of e) as text) & " | " & ((size of e) as text) & linefeed
    end try
  end repeat
  return (count of els) as text & linefeed & out
end tell`);
  fs.writeFileSync(path.join(OUT, 'ax-tree.txt'), tree.out + tree.err);
  log(`ax tree: ${tree.out.split('\n')[0]} elements; ${tree.err.trim().slice(0, 200)}`);
  // Press things by name (looping: a "whose" query over Electron's tree fails), and list what's on screen.
  const AX_ON = (proc: string) => `tell application "System Events" to tell process "${proc}"
  try
    set value of attribute "AXManualAccessibility" to true
  end try
end tell
delay 1.5
`;
  const press = (name: string, proc = 'Claude') => osa(`${AX_ON(proc)}tell application "System Events" to tell process "${proc}"
  repeat with w in windows
    repeat with e in (entire contents of w)
      try
        if (description of e as text) is "${name}" or (name of e as text) is "${name}" then
          perform action "AXPress" of e
          return "pressed"
        end if
      end try
    end repeat
  end repeat
  return "not found"
end tell`);
  const dump = async (file: string, proc = 'Claude') => {
    const t = await osa(`${AX_ON(proc)}tell application "System Events" to tell process "${proc}"
  set out to ""
  repeat with w in windows
    set out to out & "== window " & (name of w as text) & linefeed
    repeat with e in (entire contents of w)
      try
        set r to role of e as text
        if r is not "AXGroup" then
          set p to position of e
          set z to size of e
          set out to out & r & " | " & (description of e as text) & " | " & (name of e as text) & " | " & (item 1 of p as text) & "," & (item 2 of p as text) & " | " & (item 1 of z as text) & "x" & (item 2 of z as text) & linefeed
        end if
      end try
    end repeat
  end repeat
  return out
end tell`);
    fs.writeFileSync(path.join(OUT, file), t.out + t.err);
  };
  log(`Code: ${(await press('Code')).out.trim()}`);
  await sleep(2000);
  await shot('code-tab');
  await dump('ax-code-tab.txt');
  log(`Project or folder: ${(await press('Project or folder')).out.trim()}`);
  await sleep(3000);
  await shot('project-or-folder');
  await dump('ax-project-or-folder.txt');
} finally {
  fs.writeFileSync(path.join(OUT, 'requests.json'), JSON.stringify(seen, null, 2));
  ct.kill();
  recorder.close();
  await ant.close();
  await run('osascript -e \'quit app "Claude"\'');
}
