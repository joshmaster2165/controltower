/**
 * Claude Desktop through Control Tower, recorded live on a macOS runner (GitHub Actions): a Mac managed by IT gets
 * Claude Desktop, which opens already pointed at Control Tower; Dana signs in with her work account in the browser,
 * asks a question (allowed), pastes an AWS key (blocked by an inspect gate), and asks Sonnet for a board update (held
 * until her manager approves it in the Tower). The gates, holds and approvals are Control Tower's own; the model behind
 * it is a stand-in. Everything on screen is real: the app, the clicks, the browser, the console.
 *
 *   CT_TEST_LICENSE_KEYS=1 pnpm build && npx tsx scripts/demo-desktop.mts        (on the runner; it changes the Mac)
 *
 * Writes demo-desktop.mp4 (captioned) and the raw recording, plus a screenshot per step, to RESULTS_DIR.
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
// The manager's console, on another name for the same address: its own cookies, so Dana's browser session stays hers.
const CONSOLE = `http://localhost:${GW_PORT}`;
const AK = 'demo-desktop-admin-key-0123456789abcdef';
const DANA = { email: 'dana@acme.com', password: 'dana-demo-password-1' };
const MARIA = { email: 'maria@acme.com', password: 'maria-demo-password-1' };
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
};
const osa = (script: string) => {
  const f = path.join(TMP, `s${Date.now()}${Math.random().toString(36).slice(2, 6)}.applescript`);
  fs.writeFileSync(f, script);
  return run(`osascript ${q(f)}`);
};

// ---- Driving the Mac like a person: what's on screen by name and place, clicks, typing ----
type El = { role: string; name: string; x: number; y: number; w: number; h: number };
// Electron (Claude) builds its accessibility tree for whoever asks, with the app in front; Safari always has one.
const tree = async (proc = 'Claude'): Promise<El[]> => {
  const t = await osa(`tell application "${proc}" to activate
delay 1
tell application "System Events" to tell process "${proc}"
  try
    set value of attribute "AXManualAccessibility" to true
  end try
end tell
delay ${proc === 'Claude' ? 3 : 1}
tell application "System Events" to tell process "${proc}"
  set out to ""
  set els to entire contents of window 1
  repeat with e in els
    try
      set p to position of e
      set z to size of e
      set d to ""
      try
        set d to (description of e as text)
      end try
      set n to ""
      try
        set n to (name of e as text)
      end try
      set tt to ""
      try
        set tt to (title of e as text)
      end try
      set out to out & (role of e as text) & tab & d & tab & n & tab & tt & tab & (item 1 of p as text) & tab & (item 2 of p as text) & tab & (item 1 of z as text) & tab & (item 2 of z as text) & linefeed
    end try
  end repeat
  return out
end tell`);
  const ok = (s?: string) => (s && s !== 'missing value' ? s : '');
  return t.out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [role, d, n, tt, x, y, w, h] = l.split('\t');
      return { role: role!, name: ok(d) || ok(n) || ok(tt), x: Number(x), y: Number(y), w: Number(w), h: Number(h) };
    });
};
const dump = async (name: string, proc = 'Claude') => {
  const els = await tree(proc);
  fs.writeFileSync(path.join(OUT, `ax-${name}.txt`), els.map((e) => `${e.role} | ${e.name} | ${e.x},${e.y} ${e.w}x${e.h}`).join('\n'));
  return els;
};
const matches = (e: El, name: string | RegExp, role?: string) => (typeof name === 'string' ? e.name === name : name.test(e.name)) && e.w > 0 && (!role || e.role === role);
const find = async (name: string | RegExp, proc = 'Claude', role?: string) => (await tree(proc)).find((e) => matches(e, name, role));
const clickAt = (x: number, y: number) => osa(`tell application "System Events" to click at {${Math.round(x)}, ${Math.round(y)}}`);
const mouse = (x: number, y: number) => run(`cliclick m:${Math.round(x)},${Math.round(y)} c:.`);
// Press a named control by whatever takes: System Events' click, then a real mouse click. Returns how.
const press = async (name: string | RegExp, proc = 'Claude', o: { role?: string; done?: () => Promise<boolean> } = {}) => {
  const e = await find(name, proc, o.role);
  if (!e) return 'not found';
  const cx = e.x + e.w / 2;
  const cy = e.y + e.h / 2;
  const done = o.done ?? (async () => !(await find(name, proc, o.role)));
  await clickAt(cx, cy);
  await sleep(1500);
  if (await done()) return 'click';
  await mouse(cx, cy);
  await sleep(1500);
  return (await done()) ? 'mouse' : 'no effect';
};
const waitFor = async (name: string | RegExp, proc = 'Claude', tries = 4) => {
  for (let i = 0; i < tries; i++) {
    const e = await find(name, proc);
    if (e) return e;
    await sleep(1000);
  }
  return undefined;
};
// Typing at a person's pace, into whichever app is in front.
const type = (proc: string, text: string, enter = false) =>
  osa(`tell application "${proc}" to activate
delay 0.4
tell application "System Events"
  repeat with c in characters of ${JSON.stringify(text)}
    keystroke c
    delay 0.035
  end repeat
  ${enter ? 'delay 0.6\n  key code 36' : ''}
end tell`);
const keys = (proc: string, script: string) =>
  osa(`tell application "${proc}" to activate
delay 0.4
tell application "System Events"
${script}
end tell`);

// ---- The recording, and the scenes the captions follow ----
// screencapture only writes a video it was told the length of, so it records back-to-back 45-second chunks; each
// chunk's place in time is its end less its length, and the scenes (in wall-clock time) are mapped onto the joined video.
type Scene = { t: number; caption: string; speed: number };
const scenes: Scene[] = [];
const chunks: Array<{ file: string; start: number; end: number }> = [];
let recording = false;
let recLoop: Promise<void> | undefined;
const RAW = path.join(OUT, 'raw.mov');
const duration = async (f: string) => Number((await run(`ffprobe -v error -show_entries format=duration -of csv=p=0 ${q(f)}`)).out.trim()) || 0;
const startRecording = () => {
  recording = true;
  recLoop = (async () => {
    for (let n = 0; recording; n++) {
      const file = path.join(TMP, `chunk-${String(n).padStart(3, '0')}.mov`);
      await run(`screencapture -v -x -V 45 ${q(file)}`, 120_000);
      const end = Date.now();
      if (fs.existsSync(file)) chunks.push({ file, start: end - (await duration(file)) * 1000, end });
    }
  })();
};
const stopRecording = async () => {
  recording = false;
  await recLoop;
};
const scene = (caption: string, speed = 1) => {
  scenes.push({ t: Date.now(), caption, speed });
  log(`scene: ${caption}${speed !== 1 ? ` (x${speed})` : ''}`);
};

// ---- Control Tower, a stand-in model, and a recorder in front (to see what the Mac sends, and catch the sign-in code) ----
const lastUser = (b: { messages?: Array<{ role: string; content: unknown }> }) => {
  const m = [...(b.messages ?? [])].reverse().find((x) => x.role === 'user');
  const c = m?.content;
  return typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join(' ') : '';
};
const ant = await anthropicUpstream({
  models: ['claude-sonnet-4-5', 'claude-haiku-4-5'],
  reply: (b) =>
    /board update/i.test(lastUser(b))
      ? 'Board update, Q3 pipeline: 42 open deals worth $3.1M (up 18% on Q2). The three largest, Northwind, Globex and Initech, close in October and would put Q4 ahead of plan. Risk: two renewals slipped to November.'
      : 'From README.md: the Q3 pipeline has 42 open deals worth $3.1M, and the three largest close in October.',
});
const ct: ChildProcess = spawn(process.execPath, ['server/dist/server.mjs', '--port', String(PORT)], {
  cwd: REPO,
  env: {
    ...process.env,
    CT_DATA_DIR: path.join(TMP, 'data'),
    CT_ADMIN_KEY: AK,
    CT_UI_DIR: path.join(REPO, 'ui/dist'),
    CT_LOG_LEVEL: 'warn',
    CT_LICENSE_PUBLIC_KEY: TEST_LICENSE_PUBLIC_KEY,
    CT_LICENSE_KEY: testLicense({ customer: 'Acme Corp' }),
    CT_LICENSE_SERVER: 'off',
    CT_MODEL_HEALTH_INTERVAL_S: '0',
    CT_HOLD_BUDGET_MS: '180000',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});
for (let i = 0; ; i++) {
  if ((await fetch(`http://127.0.0.1:${PORT}/healthz`).catch(() => null))?.ok) break;
  if (i > 150) throw new Error('Control Tower did not start');
  await sleep(200);
}
const seen: Array<{ method: string; url: string; ua: string; status: number }> = [];
const recorder = http.createServer((req, res) => {
  const up = http.request({ host: '127.0.0.1', port: PORT, path: req.url, method: req.method, headers: req.headers }, (r) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', ua: String(req.headers['user-agent'] ?? ''), status: r.statusCode ?? 0 });
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on('error', () => (res.writeHead(502), res.end()));
  req.pipe(up);
});
await new Promise<void>((r) => recorder.listen(GW_PORT, '127.0.0.1', () => r()));
const api = (method: string, p: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${PORT}${p}`, {
    method,
    headers: { authorization: `Bearer ${AK}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => (await r.json().catch(() => ({}))) as any);
const person = async (email: string, role: string, password: string) => {
  const made = await api('POST', '/admin/api/users', { email, role });
  const r = await fetch(`http://127.0.0.1:${PORT}/admin/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: made.password }) });
  const cookie = r.headers
    .getSetCookie()
    .map((x) => x.split(';')[0])
    .join('; ');
  const { csrf } = (await r.json()) as { csrf: string };
  const c = await fetch(`http://127.0.0.1:${PORT}/admin/api/me/password`, {
    method: 'POST',
    headers: { cookie, 'x-ct-csrf': csrf, 'content-type': 'application/json' },
    body: JSON.stringify({ current: made.password, password }),
  });
  log(`${email}: ${role}, password set ${c.status}`);
};
const calls = (from: number) =>
  seen
    .slice(from)
    .filter((x) => x.url.startsWith('/v1/messages'))
    .map((x) => `${x.url.split('?')[0]} ${x.status}`)
    .join(', ');

try {
  // ---- Before the video: Control Tower as the company set it up ----
  const prov = await api('POST', '/admin/api/providers', { catalog_id: 'anthropic', base_url: ant.url, credentials: { api_key: 'sk-ant-demo' } });
  for (const m of ['claude-sonnet-4-5', 'claude-haiku-4-5']) await api('POST', '/admin/api/deployments', { provider_id: (prov.provider ?? prov).id, upstream_model: m, public_name: m });
  const key = await api('POST', '/admin/api/keys', { name: 'claude-desktop', agent_id: 'claude-desktop', team: 'finance' });
  await api('PUT', '/admin/api/devices/rules', { rules: [{ client: '*', team_id: null, key_id: key.id }] });
  await person(DANA.email, 'member', DANA.password);
  await person(MARIA.email, 'approver', MARIA.password);
  const block = await api('POST', '/admin/api/rules', {
    name: 'No credentials to models',
    target_kind: 'model',
    effect: 'inspect',
    config: { detectors: ['secrets'], action: 'block', direction: 'input', reason: 'Credentials must never be sent to a model' },
    priority: 50,
  });
  const hold = await api('POST', '/admin/api/rules', {
    name: 'Sonnet needs a manager',
    target_kind: 'model',
    match: { models: ['claude-sonnet-4-5'] },
    effect: 'require_approval',
    config: { hold_ms: 150_000 },
    priority: 10,
  });
  log(`gates: ${block.id ?? JSON.stringify(block)} ${hold.id ?? JSON.stringify(hold)}`);

  // IT's rollout: ct-auth, and Claude Desktop's managed settings (as an MDM delivers them).
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

  // The screen, the tools for the video, Claude Desktop's download, and a project folder.
  log(`brew: ${(await run('brew install cliclick displayplacer ffmpeg', 900_000)).code}`);
  const disp = (await run('displayplacer list')).out.match(/id:(\S+) res:/)?.[1];
  if (disp) log(`1920x1080: ${(await run(`displayplacer "id:${disp} res:1920x1080 hz:60 color_depth:7 scaling:off origin:(0,0) degree:0"`)).code}`);
  const rel = (await (await fetch('https://downloads.claude.ai/releases/darwin/universal/RELEASES.json')).json()) as { releases: Array<{ updateTo: { url: string; version: string } }> };
  const zip = path.join(TMP, 'Claude.zip');
  fs.writeFileSync(zip, Buffer.from(await (await fetch(rel.releases[0]!.updateTo.url)).arrayBuffer()));
  log(`Claude Desktop ${rel.releases[0]!.updateTo.version}`);
  fs.mkdirSync('/Users/runner/acme-reports', { recursive: true });
  fs.writeFileSync('/Users/runner/acme-reports/README.md', '# Q3 pipeline\n\n42 open deals, $3.1M. Largest three close in October.\n');
  await run(`osascript -e 'tell application "Finder" to close every window'`);
  await sleep(3000);

  // ---- The video ----
  startRecording();
  await sleep(2500);

  scene("A company Mac. IT's device management has already sent Control Tower's settings.");
  await run('open /Applications');
  await sleep(5000);
  scene('Claude Desktop is installed', 3);
  log(`unzip: ${(await run(`ditto -x -k ${q(zip)} /Applications`)).code}`);
  await sleep(3000);
  await run(`osascript -e 'tell application "Finder" to close every window'`);
  await run('open /Applications/Claude.app');
  await sleep(14_000);
  scene('First launch: Claude is already set up to go through the company gateway. No Claude.ai account.');
  await shot('welcome');
  await sleep(6000);

  const win = await osa(`tell application "System Events" to tell process "Claude"
  set {px, py} to position of window 1
  set {sw, sh} to size of window 1
end tell
return (px as text) & "," & (py as text) & "," & (sw as text) & "," & (sh as text)`);
  const [px, py, sw, sh] = win.out.trim().split(',').map(Number) as [number, number, number, number];
  scene('Dana clicks Continue. Control Tower’s sign-in opens in her browser.');
  const cont = await find(/^Continue$/);
  log(`Continue: ${cont ? 'by name' : 'by place'}`);
  await osa(`tell application "Claude" to activate
delay 1
tell application "System Events" to click at {${Math.round(cont ? cont.x + cont.w / 2 : px + sw / 2)}, ${Math.round(cont ? cont.y + cont.h / 2 : py + sh * 0.608)}}`);
  const signInCode = () => new URL(seen.find((x) => x.url.startsWith('/device?code='))?.url ?? '/', GW).searchParams.get('code') ?? '';
  let code = '';
  for (let i = 0; i < 40 && !code; i++) {
    await sleep(1000);
    code = signInCode();
  }
  if (!code) {
    await mouse(px + sw / 2, py + sh * 0.608);
    for (let i = 0; i < 30 && !code; i++) {
      await sleep(1000);
      code = signInCode();
    }
  }
  log(`sign-in code: ${code || 'none'}`);
  await sleep(5000);
  await shot('browser-sign-in');
  scene('She signs in with her work account…');
  await dump('safari-login', 'Safari');
  const emailBox = await find(/^(Email|Username|Email or username)$/i, 'Safari', 'AXTextField');
  if (emailBox) await clickAt(emailBox.x + emailBox.w / 2, emailBox.y + emailBox.h / 2);
  await type('Safari', DANA.email);
  await keys('Safari', 'key code 48');
  await type('Safari', DANA.password, true);
  await sleep(3000);
  await keys('Safari', 'key code 53'); // Safari's "Save Password?": not now
  await sleep(1500);
  await shot('device-request');
  scene('…checks it’s her computer asking, and approves.');
  await dump('safari-device', 'Safari');
  await sleep(3000);
  log(`Approve (device): ${await press('Approve', 'Safari', { role: 'AXButton' })}`);
  await sleep(3000);
  await shot('device-approved');
  await sleep(2000);

  scene('Back in Claude: signed in. Every call now goes through Control Tower.', 2);
  await osa('tell application "Claude" to activate');
  await sleep(12_000);
  await shot('signed-in');

  scene('She opens a project folder in the Code tab', 1.5);
  const sheets = async () => (await osa('tell application "System Events" to tell process "Claude" to return count of sheets of window 1')).out.trim() !== '0';
  const chooseFolder = async () => {
    log(`Select folder: ${await press(/^Select folder/, 'Claude', { done: sheets })}`);
    await sleep(1500);
    await keys('Claude', 'keystroke "g" using {command down, shift down}\n  delay 1.5');
    await type('Claude', '/Users/runner/acme-reports');
    await keys('Claude', 'delay 0.8\n  key code 36\n  delay 1.5\n  key code 36');
    await sleep(3000);
    if (await find('Trust workspace')) log(`Trust workspace: ${await press('Trust workspace')}`);
  };
  log(`Code: ${await press('Code', 'Claude', { role: 'AXButton', done: async () => !!(await find(/^Select folder/)) })}`);
  await chooseFolder();
  await sleep(2000);
  await shot('folder');

  const ask = async (text: string) => {
    const box = await waitFor('Prompt');
    if (box) await clickAt(box.x + box.w / 2, box.y + box.h / 2);
    await sleep(500);
    await type('Claude', text, true);
  };
  scene('An everyday question: allowed, answered, and recorded.');
  const n0 = seen.length;
  await ask('Summarize the Q3 pipeline in README.md');
  await sleep(14_000);
  await shot('answered');
  log(`calls: ${calls(n0)}`);

  scene('Now she pastes an AWS key into a prompt…');
  const n1 = seen.length;
  await ask('Check this AWS key still works: AKIAIOSFODNN7EXAMPLE wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
  await sleep(6000);
  scene('Control Tower’s gate blocks it before it reaches any model.');
  await sleep(3000);
  const details = await find(/^View details/);
  if (details) await mouse(details.x + details.w / 2, details.y + details.h / 2);
  log(`View details: ${details ? 'clicked' : 'not found'}`);
  await sleep(6000);
  await shot('blocked');
  await dump('blocked');
  log(`calls: ${calls(n1)}`);
  await keys('Claude', 'key code 53');
  await sleep(1000);

  scene('A new session, on Sonnet: the company asks a manager to approve Sonnet calls.', 1.5);
  log(`New: ${await press('New', 'Claude', { role: 'AXButton', done: async () => true })}`);
  await sleep(3000);
  const els = await dump('new-session');
  if (els.some((e) => /^Select folder/.test(e.name) && e.w > 0)) await chooseFolder();
  log(`Model menu: ${await press(/^Model:/, 'Claude', { done: async () => !!(await find(/sonnet/i, 'Claude', 'AXMenuItem')) })}`);
  // The menu answers the keyboard (a click on its item doesn't take): down to Sonnet, Return.
  for (let downs = 1; downs <= 2 && !(await find(/^Model:.*sonnet/i)); downs++) {
    if (!(await find(/sonnet/i, 'Claude', 'AXMenuItem'))) await press(/^Model:/, 'Claude', { done: async () => !!(await find(/sonnet/i, 'Claude', 'AXMenuItem')) });
    await keys('Claude', `${'key code 125\n  delay 0.4\n  '.repeat(downs)}key code 36`);
    await sleep(1500);
  }
  log(`Sonnet: ${(await find(/^Model:/))?.name ?? '?'}`);
  await shot('sonnet');
  const n2 = seen.length;
  await ask('Draft the board update on the Q3 pipeline');
  let card: { id: string } | undefined;
  for (let i = 0; i < 30 && !card; i++) {
    await sleep(1000);
    card = ((await api('GET', '/admin/api/approvals?status=pending')).approvals ?? [])[0];
  }
  log(`held: ${card?.id ?? 'none'}`);
  scene('Control Tower holds the call at the gate while it asks.');
  await sleep(6000);
  await shot('held');

  scene('Maria, her manager, opens the Tower…');
  await run(`open -a Safari ${q(`${CONSOLE}/#/tower`)}`);
  await sleep(5000);
  await dump('maria-login', 'Safari');
  const mBox = await find(/^(Email|Username|Email or username)$/i, 'Safari', 'AXTextField');
  if (mBox) await clickAt(mBox.x + mBox.w / 2, mBox.y + mBox.h / 2);
  await type('Safari', MARIA.email);
  await keys('Safari', 'key code 48');
  await type('Safari', MARIA.password, true);
  await sleep(3000);
  await keys('Safari', 'key code 53');
  await sleep(1500);
  if (!(await find('Approve', 'Safari', 'AXButton'))) {
    await run(`open -a Safari ${q(`${CONSOLE}/#/tower`)}`);
    await sleep(4000);
  }
  scene('…sees who is asking, from which app, for which model, and approves.');
  await shot('tower');
  await dump('tower', 'Safari');
  await sleep(5000);
  log(`Approve (tower): ${await press('Approve', 'Safari', { role: 'AXButton' })}`);
  if (card) log(`card now: ${(await api('GET', `/admin/api/approvals/${card.id}`)).approval?.status}`);
  await sleep(3000);

  scene('The call goes through, and the answer arrives in Claude.');
  await osa('tell application "Claude" to activate');
  await sleep(12_000);
  await shot('approved-answer');
  log(`calls: ${calls(n2)}`);

  scene('Every call is in Flights: who, which app, which model, and what each gate decided.');
  await run(`open -a Safari ${q(`${CONSOLE}/#/flights`)}`);
  await sleep(9000);
  await shot('flights');
  scene('');
  await sleep(1500);
} finally {
  await stopRecording();
  fs.writeFileSync(path.join(OUT, 'requests.json'), JSON.stringify(seen, null, 2));
  fs.writeFileSync(path.join(OUT, 'scenes.json'), JSON.stringify(scenes, null, 2));
  fs.writeFileSync(path.join(OUT, 'flights.json'), JSON.stringify(await api('GET', '/admin/api/flights?limit=50').catch(() => ({})), null, 2));
  // (Claude keeps its connections open: don't wait on them.)
  await run('osascript -e \'quit app "Claude"\'', 20_000);
  ct.kill();
  recorder.closeAllConnections();
  recorder.close();
  await Promise.race([ant.close(), sleep(5000)]);
}

// ---- The edit: each scene at its speed with its caption, between a title and an end card ----
// (Captions are drawn by a browser and laid over the video: Homebrew's ffmpeg has no text filter.)
if (chunks.length && scenes.length) {
  fs.writeFileSync(path.join(TMP, 'chunks.txt'), chunks.map((c) => `file '${c.file}'`).join('\n'));
  log(`join ${chunks.length} chunks: ${(await run(`ffmpeg -y -f concat -safe 0 -i ${q(path.join(TMP, 'chunks.txt'))} -c copy ${q(RAW)}`, 600_000)).code}`);
  const dur = await duration(RAW);
  log(`raw: ${dur}s`);
  // A wall-clock moment's place in the joined video (a moment between chunks goes to the start of the next).
  const at = (t: number) => {
    let before = 0;
    for (const c of chunks) {
      if (t < c.end) return before + Math.max(0, t - c.start) / 1000;
      before += (c.end - c.start) / 1000;
    }
    return before;
  };
  for (const s of scenes) s.t = at(s.t);
  fs.writeFileSync(path.join(OUT, 'scenes.json'), JSON.stringify(scenes, null, 2));
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const FONT = "font-family: -apple-system, 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif;";
  const png = async (name: string, html: string, transparent: boolean) => {
    const f = path.join(TMP, `${name}.png`);
    await page.setContent(`<html><body style="margin:0;width:1920px;height:1080px;${FONT}${transparent ? 'background:transparent' : 'background:#0d1117'}">${html}</body></html>`);
    await page.screenshot({ path: f, omitBackground: transparent });
    return f;
  };
  const caption = (s: string) =>
    `<div style="position:absolute;left:0;right:0;bottom:56px;display:flex;justify-content:center"><div style="max-width:1500px;background:rgba(13,17,23,.86);color:#fff;font-size:38px;font-weight:600;line-height:1.3;padding:18px 34px;border-radius:16px;text-align:center;letter-spacing:-.01em">${esc(s)}</div></div>`;
  const cardHtml = (title: string, sub: string) =>
    `<div style="height:1080px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:26px;color:#fff;text-align:center"><div style="font-size:30px;letter-spacing:.18em;text-transform:uppercase;color:#f0a35e;font-weight:600">Control Tower</div><div style="font-size:76px;font-weight:700;letter-spacing:-.02em;max-width:1500px">${esc(title)}</div><div style="font-size:36px;color:#9aa4b2;max-width:1400px;line-height:1.35">${esc(sub)}</div></div>`;
  const segs = scenes.map((s, i) => ({ ...s, i, end: i + 1 < scenes.length ? scenes[i + 1]!.t : dur })).filter((s) => s.end - s.t >= 0.3 && s.t < dur);
  const inputs: string[] = [`-i ${q(RAW)}`];
  const add = (f: string, still = false) => (inputs.push(still ? `-loop 1 -framerate 30 -t 4 -i ${q(f)}` : `-i ${q(f)}`), inputs.length - 1);
  const parts: string[] = [];
  const labels: string[] = [];
  const cardIn = (n: string, title: string, sub: string) => png(n, cardHtml(title, sub), false).then((f) => add(f, true));
  const c0 = await cardIn('card0', 'Claude Desktop on a company Mac', 'Recorded live: installed, signed in, and governed by Control Tower');
  parts.push(`[${c0}:v]fps=30,scale=1920:1080,setsar=1,format=yuv420p[c0]`);
  labels.push('[c0]');
  parts.push(`[0:v]split=${segs.length}${segs.map((s) => `[r${s.i}]`).join('')}`);
  for (const s of segs) {
    const base = `[r${s.i}]trim=start=${s.t.toFixed(2)}:end=${Math.min(s.end, dur).toFixed(2)},setpts=(PTS-STARTPTS)/${s.speed},fps=30,scale=1920:1080,setsar=1`;
    if (s.caption) {
      const k = add(await png(`cap${s.i}`, caption(s.caption), true));
      parts.push(`${base}[b${s.i}]`, `[b${s.i}][${k}:v]overlay=0:0:eof_action=repeat,format=yuv420p[s${s.i}]`);
    } else parts.push(`${base},format=yuv420p[s${s.i}]`);
    labels.push(`[s${s.i}]`);
  }
  const c1 = await cardIn('card1', 'See every agent. Gate what matters.', 'Open-source AI gateway · github.com/joshmaster2165/controltower');
  parts.push(`[${c1}:v]fps=30,scale=1920:1080,setsar=1,format=yuv420p[c1]`);
  labels.push('[c1]');
  await browser.close();
  parts.push(`${labels.join('')}concat=n=${labels.length}:v=1:a=0[out]`);
  fs.writeFileSync(path.join(TMP, 'filter.txt'), parts.join(';\n'));
  fs.copyFileSync(path.join(TMP, 'filter.txt'), path.join(OUT, 'filter.txt'));
  const mp4 = path.join(OUT, 'demo-desktop.mp4');
  const r = await run(
    `ffmpeg -y ${inputs.join(' ')} -/filter_complex ${q(path.join(TMP, 'filter.txt'))} -map '[out]' -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -movflags +faststart ${q(mp4)}`,
    1_200_000,
  );
  log(`edit: ${r.code} ${r.code ? r.err.slice(-1500) : ''}${fs.existsSync(mp4) ? ` ${(fs.statSync(mp4).size / 1e6).toFixed(1)} MB` : ''}`);
}
