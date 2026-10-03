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
// Reading it is slow (seconds), and nothing happens on screen meanwhile: the edit cuts that time out of the video.
const cuts: Array<[number, number]> = [];
const tree = async (proc = 'Claude'): Promise<El[]> => {
  const t0 = Date.now();
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
  cuts.push([t0, Date.now()]);
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
// First choice: one continuous recording by ffmpeg, which stops cleanly on "q" (its clock starts when it says it's
// capturing). If it can't capture the screen, screencapture's chunks.
let ff: ChildProcess | undefined;
let ffT0 = 0;
// NO_VIDEO=1: screenshots and what Claude shows, no recording (a check of the real app, not a demo).
const NO_VIDEO = process.env.NO_VIDEO === '1';
const startRecording = async () => {
  if (NO_VIDEO) return;
  log(`screens: ${(await run('ffmpeg -hide_banner -f avfoundation -list_devices true -i ""')).err.split('\n').filter((l) => /screen/i.test(l)).join(' | ')}`);
  let err = '';
  ff = spawn('ffmpeg', ['-y', '-f', 'avfoundation', '-capture_cursor', '1', '-framerate', '30', '-i', 'Capture screen 0:none', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '22', '-pix_fmt', 'yuv420p', RAW], { stdio: ['pipe', 'ignore', 'pipe'] });
  ff.stderr!.on('data', (d) => {
    err += d;
    if (!ffT0 && /Press \[q\]/.test(err)) ffT0 = Date.now();
  });
  await sleep(5000);
  if (ff.exitCode === null && ffT0 && /frame=\s*[1-9]/.test(err)) {
    log('recording: ffmpeg');
    return;
  }
  log(`recording: ffmpeg didn't capture (${err.split('\n').slice(-4).join(' | ').slice(0, 300)}); screencapture chunks instead`);
  ff.kill('SIGKILL');
  ff = undefined;
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
  if (ff) {
    const p = ff;
    p.stdin!.write('q');
    await new Promise<void>((r) => {
      const t = setTimeout(() => (p.kill('SIGINT'), r()), 30_000);
      p.on('exit', () => (clearTimeout(t), r()));
    });
    await sleep(1000);
  }
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
    CT_HOLD_BUDGET_MS: '600000',
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


// ---- Steps both videos use ----
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
const ask = async (text: string) => {
  // (Near its left end: Claude's notifications banner can cover the right half.)
  const box = await waitFor('Prompt');
  if (box) await clickAt(box.x + 40, box.y + box.h / 2);
  await sleep(500);
  await type('Claude', text, true);
};
const chooseSonnet = async () => {
  log(`Model menu: ${await press(/^Model:/, 'Claude', { done: async () => !!(await find(/sonnet/i, 'Claude', 'AXMenuItem')) })}`);
  // The menu answers the keyboard (a click on its item doesn't take): down to Sonnet, Return.
  for (let downs = 1; downs <= 2 && !(await find(/^Model:.*sonnet/i)); downs++) {
    if (!(await find(/sonnet/i, 'Claude', 'AXMenuItem'))) await press(/^Model:/, 'Claude', { done: async () => !!(await find(/sonnet/i, 'Claude', 'AXMenuItem')) });
    await keys('Claude', `${'key code 125\n  delay 0.4\n  '.repeat(downs)}key code 36`);
    await sleep(1500);
  }
  log(`Sonnet: ${(await find(/^Model:/))?.name ?? '?'}`);
};
const mariaSignsIn = async () => {
  await run(`open -a Safari ${q(`${CONSOLE}/#/tower`)}`);
  await sleep(5000);
  const box = await find(/^(Email|Username|Email or username)$/i, 'Safari', 'AXTextField');
  if (box) await clickAt(box.x + box.w / 2, box.y + box.h / 2);
  await type('Safari', MARIA.email);
  await keys('Safari', 'key code 48');
  await type('Safari', MARIA.password, true);
  await sleep(3000);
  await keys('Safari', 'key code 53'); // Safari's "Save Password?": not now
  await sleep(1500);
};
const waiting = async () => ((await api('GET', '/admin/api/approvals?status=pending')).approvals ?? []) as Array<{ id: string }>;
// The card a message just made (not one left waiting from earlier).
const heldCall = async (before = new Set<string>(), seconds = 30) => {
  for (let i = 0; i < seconds; i++) {
    const w = (await waiting()).filter((a) => !before.has(a.id));
    if (w.length) return w[w.length - 1];
    await sleep(1000);
  }
  return undefined;
};
// Maria presses Approve on each card in the Tower.
const approveAll = async () => {
  for (let i = 0; i < 5 && (await waiting()).length > 0; i++) {
    const before = (await waiting()).length;
    const btn = await find('Approve', 'Safari', 'AXButton');
    if (!btn) {
      await run(`open -a Safari ${q(`${CONSOLE}/#/tower`)}`);
      await sleep(3000);
      continue;
    }
    await clickAt(btn.x + btn.w / 2, btn.y + btn.h / 2);
    await sleep(2000);
    if ((await waiting()).length >= before) {
      await mouse(btn.x + btn.w / 2, btn.y + btn.h / 2);
      await sleep(2000);
    }
    log(`Approve (tower): ${before} -> ${(await waiting()).length} waiting`);
  }
};
// Claude Desktop's first launch: Continue, then the browser sign-in (the code, caught by the recorder).
const signInCode = () => new URL(seen.find((x) => x.url.startsWith('/device?code='))?.url ?? '/', GW).searchParams.get('code') ?? '';
const pressContinue = async () => {
  const win = await osa(`tell application "System Events" to tell process "Claude"
  set {px, py} to position of window 1
  set {sw, sh} to size of window 1
end tell
return (px as text) & "," & (py as text) & "," & (sw as text) & "," & (sh as text)`);
  const [px, py, sw, sh] = win.out.trim().split(',').map(Number) as [number, number, number, number];
  const cont = await find(/^Continue$/);
  log(`Continue: ${cont ? 'by name' : 'by place'}`);
  await osa(`tell application "Claude" to activate
delay 1
tell application "System Events" to click at {${Math.round(cont ? cont.x + cont.w / 2 : px + sw / 2)}, ${Math.round(cont ? cont.y + cont.h / 2 : py + sh * 0.608)}}`);
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
  return code;
};
// Approving Dana's computer through her own session, off camera.
const danaApproves = async (code: string) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/admin/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(DANA) });
  const cookie = r.headers.getSetCookie().map((x) => x.split(';')[0]).join('; ');
  const { csrf } = (await r.json()) as { csrf: string };
  const ok = await fetch(`http://127.0.0.1:${PORT}/admin/api/me/devices/approve`, { method: 'POST', headers: { cookie, 'x-ct-csrf': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ user_code: code }) });
  log(`device approved: ${ok.status}`);
};
// What the person in Claude sees, and what Control Tower answered.
const clientSees = async (name: string) => {
  await shot(name);
  const els = await tree();
  const text = els.filter((e) => e.role === 'AXStaticText' && e.y > 110 && e.y < 1000).map((e) => e.name).filter(Boolean);
  fs.writeFileSync(path.join(OUT, `client-${name}.txt`), text.join('\n'));
  log(`client ${name}: ${text.slice(-6).join(' | ').slice(0, 400)}`);
};

// ---- The whole story: install, sign-in, an answer, a block, a hold ----
async function fullVideo(zip: string) {
  await startRecording();
  await sleep(2500);

  scene("A company Mac. IT's device management has already sent Control Tower's settings.");
  const fw = await osa(`tell application "Finder"
  activate
  set w to make new Finder window to folder "Applications" of startup disk
  set bounds of w to {360, 120, 1560, 900}
  set current view of w to icon view
end tell`);
  log(`Finder window: ${fw.code} ${fw.err.trim().slice(0, 200)}`);
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

  scene('Dana clicks Continue. Control Tower’s sign-in opens in her browser.');
  await pressContinue();
  await sleep(5000);
  await shot('browser-sign-in');
  scene('She signs in with her work account…');
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
  log(`Code: ${await press('Code', 'Claude', { role: 'AXButton', done: async () => !!(await find(/^Select folder/)) })}`);
  await chooseFolder();
  await sleep(2000);
  await shot('folder');

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
  log(`calls: ${calls(n1)}`);
  await keys('Claude', 'key code 53');
  await sleep(1000);

  scene('A new session, on Sonnet: the company asks a manager to approve Sonnet calls.', 1.5);
  log(`New: ${await press('New', 'Claude', { role: 'AXButton', done: async () => true })}`);
  await sleep(3000);
  const els = await dump('new-session');
  if (els.some((e) => /^Select folder/.test(e.name) && e.w > 0)) await chooseFolder();
  await chooseSonnet();
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
  await mariaSignsIn();
  scene('…sees who is asking, from which app, for which model, and approves.');
  await shot('tower');
  await sleep(4000);
  // Claude Code asks twice on a new session (the reply, and a title for the session): she approves both.
  await approveAll();
  if (card) log(`card now: ${(await api('GET', `/admin/api/approvals/${card.id}`)).approval?.status}`);
  await sleep(2500);

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
}

// ---- Approvals, side by side: Dana in Claude Desktop, Maria in the Tower; then how a hold ends other ways ----
async function approvalsVideo(zip: string) {
  // Off camera: Claude installed and signed in, a folder open with one ordinary answer (so the session already has its
  // title, and the Sonnet call is the only one held), and Maria signed in to the Tower.
  log(`unzip: ${(await run(`ditto -x -k ${q(zip)} /Applications`)).code}`);
  await run('open /Applications/Claude.app');
  await sleep(14_000);
  const code = await pressContinue();
  if (code) await danaApproves(code);
  await sleep(4000);
  await run(`osascript -e 'tell application "Safari" to close every window'`);
  await osa('tell application "Claude" to activate');
  await sleep(12_000);
  log(`Code: ${await press('Code', 'Claude', { role: 'AXButton', done: async () => !!(await find(/^Select folder/)) })}`);
  await chooseFolder();
  // Already on Sonnet, with the gate off for a first answer: switching models restarts Claude Code, which makes a
  // call of its own, and the session's title is made from the first message. Then the gate, on.
  await api('PATCH', `/admin/api/rules/${holdRule}`, { enabled: false });
  await chooseSonnet();
  await ask('Summarize the Q3 pipeline in README.md');
  await sleep(20_000);
  await api('PATCH', `/admin/api/rules/${holdRule}`, { enabled: true });
  await mariaSignsIn();
  // Side by side, the Dock out of the way (windows placed through System Events: the apps' own scripting may not be allowed).
  await run('defaults write com.apple.dock autohide -bool true && killall Dock');
  await sleep(2000);
  const placed = await osa(`tell application "System Events"
  tell process "Claude"
    set position of window 1 to {0, 30}
    set size of window 1 to {980, 1050}
  end tell
  tell process "Safari"
    set position of window 1 to {980, 30}
    set size of window 1 to {940, 1050}
  end tell
end tell`);
  log(`side by side: ${placed.code} ${placed.err.trim().slice(0, 200)}`);
  await osa('tell application "Claude" to activate');
  await sleep(2000);
  await shot('ready');

  await startRecording();
  await sleep(2500);
  scene('Dana works in Claude Desktop. Maria approves requests in Control Tower’s Tower.');
  await sleep(5000);
  scene('Dana is on Sonnet. Company policy: every Sonnet call needs a manager’s OK. She asks for the board update…');
  const n = seen.length;
  await ask('Draft the board update on the Q3 pipeline');
  const card = await heldCall();
  log(`held: ${card?.id ?? 'none'}`);
  scene('Control Tower holds the call at the gate. Nothing has reached the model; Claude just waits.');
  await sleep(10_000);
  await shot('held');
  scene('In the Tower, Maria sees who is asking, from which app, for which model, and the request itself.');
  await sleep(9000);
  await shot('tower');
  scene('She approves…');
  await approveAll();
  scene('…and the held call carries on: the answer streams into Claude.');
  await sleep(10_000);
  await clientSees('approved');
  log(`calls: ${calls(n)}`);
  scene('The decision is on record: who approved it, and when.');
  await sleep(6000);
  await shot('decided');
  scene('');
  await sleep(1000);

  // ---- After the video (still recorded, not in the edit): how a hold ends other ways, as Dana sees it ----
  const decide = async (id: string, action: 'approve' | 'deny', note?: string) => log(`${action}: ${JSON.stringify(await api('POST', `/admin/api/approvals/${id}/decide`, { action, ...(note ? { note } : {}) }))}`.slice(0, 200));
  let m = 0;
  let c: { id: string } | undefined;
  // Denied, with a note.
  m = seen.length;
  let before = new Set((await waiting()).map((a) => a.id));
  await ask('Draft the board update for the investors');
  c = await heldCall(before);
  await sleep(5000);
  if (c) await decide(c.id, 'deny', 'Not before the audit closes');
  await sleep(10_000);
  await clientSees('denied');
  log(`calls: ${calls(m)}`);
  // Nobody answers in time: the hold expires.
  log(`hold 20s: ${JSON.stringify(await api('PATCH', `/admin/api/rules/${holdRule}`, { config: { hold_ms: 20_000 } })).slice(0, 160)}`);
  m = seen.length;
  before = new Set((await waiting()).map((a) => a.id));
  await ask('Draft the board update for the partners');
  c = await heldCall(before);
  await sleep(35_000);
  await clientSees('waiting-ticket');
  log(`calls: ${calls(m)}; card: ${c ? (await api('GET', `/admin/api/approvals/${c.id}`)).approval?.status : 'none'}`);
  // Approved after she stopped waiting: the same message again goes through.
  if (c) await decide(c.id, 'approve');
  m = seen.length;
  await ask('Draft the board update for the partners');
  await sleep(20_000);
  await clientSees('resent-after-approval');
  log(`calls: ${calls(m)}`);
  for (const x of ((await api('GET', '/admin/api/approvals?status=all&limit=4')).approvals ?? []) as Array<{ id: string; status: string; requester: string | null; client: string | null; args_preview: { last_user_message?: string } | null }>)
    log(`card ${x.id.slice(-6)}: ${x.status} ${x.requester} ${x.client} "${x.args_preview?.last_user_message ?? ''}"`);
  // Last (a secret in the conversation blocks every later call in it): blocked by an inspect gate.
  m = seen.length;
  await ask('Check this AWS key still works: AKIAIOSFODNN7EXAMPLE');
  await sleep(10_000);
  const details = await find(/^View details/);
  if (details) await mouse(details.x + details.w / 2, details.y + details.h / 2);
  await sleep(3000);
  await clientSees('blocked');
  log(`calls: ${calls(m)}`);
}

let holdRule = '';
const SCENARIO = process.env.SCENARIO ?? 'full';
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
    config: { hold_ms: 600_000 },
    priority: 10,
  });
  holdRule = hold.id;
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

  if (SCENARIO === 'approvals') await approvalsVideo(zip);
  else await fullVideo(zip);
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

// ---- The edit: each scene at its speed with its caption, less the time spent reading the screen, between a title and
// an end card. Each piece is cut and captioned on its own, then the pieces are joined. (Captions are drawn by a browser:
// Homebrew's ffmpeg has no text filter.)
fs.writeFileSync(path.join(OUT, 'timeline.json'), JSON.stringify({ ffT0, chunks: chunks.map((c) => ({ start: c.start, end: c.end })), cuts, scenes }, null, 2));
if ((ffT0 ? fs.existsSync(RAW) : chunks.length) && scenes.length > 1) {
  if (!ffT0) {
    fs.writeFileSync(path.join(TMP, 'chunks.txt'), chunks.map((c) => `file '${c.file}'`).join('\n'));
    log(`join ${chunks.length} chunks: ${(await run(`ffmpeg -y -f concat -safe 0 -i ${q(path.join(TMP, 'chunks.txt'))} -c copy ${q(RAW)}`, 600_000)).code}`);
  }
  const dur = await duration(RAW);
  log(`raw: ${dur}s`);
  // A wall-clock moment's place in the video (with chunks, a moment between two goes to the start of the next).
  const at = (t: number) => {
    if (ffT0) return Math.max(0, (t - ffT0) / 1000);
    let before = 0;
    for (const c of chunks) {
      if (t < c.end) return before + Math.max(0, t - c.start) / 1000;
      before += (c.end - c.start) / 1000;
    }
    return before;
  };
  // Each scene (the last one only marks the end) less the cuts, as pieces of the joined video.
  const pieces: Array<{ a: number; b: number; speed: number; caption: string; scene: number }> = [];
  for (let i = 0; i + 1 < scenes.length; i++) {
    const s = scenes[i]!;
    let spans: Array<[number, number]> = [[s.t, scenes[i + 1]!.t]];
    for (const [c0, c1] of cuts) spans = spans.flatMap(([x, y]): Array<[number, number]> => (c1 <= x || c0 >= y ? [[x, y]] : ([[x, c0], [c1, y]] as Array<[number, number]>).filter(([u, v]) => v - u > 0)));
    for (const [x, y] of spans) {
      const a = at(x);
      const b = Math.min(at(y), dur);
      if (b - a >= 0.5) pieces.push({ a, b, speed: s.speed, caption: s.caption, scene: i });
    }
  }
  fs.writeFileSync(path.join(OUT, 'pieces.json'), JSON.stringify(pieces, null, 2));
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
  const ENC = '-an -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -r 30 -video_track_timescale 30000';
  const parts: string[] = [];
  const card = async (n: string, title: string, sub: string) => {
    const f = path.join(TMP, `${n}.mp4`);
    const r = await run(`ffmpeg -y -loop 1 -framerate 30 -t 4 -i ${q(await png(n, cardHtml(title, sub), false))} -vf scale=1920:1080,setsar=1 ${ENC} ${q(f)}`, 300_000);
    if (r.code) log(`card ${n}: ${r.err.slice(-600)}`);
    parts.push(f);
  };
  if (SCENARIO === 'approvals') await card('card0', 'Held for approval', 'Recorded live: Claude Desktop on a company Mac, and Control Tower’s Tower');
  else await card('card0', 'Claude Desktop on a company Mac', 'Recorded live: installed, signed in, and governed by Control Tower');
  const caps = new Map<number, string>();
  for (const [k, pc] of pieces.entries()) {
    if (pc.caption && !caps.has(pc.scene)) caps.set(pc.scene, await png(`cap${pc.scene}`, caption(pc.caption), true));
    const f = path.join(TMP, `piece-${String(k).padStart(3, '0')}.mp4`);
    // (A still screen records few frames, so each piece is held to its exact length.)
    const base = `setpts=(PTS-STARTPTS)/${pc.speed},fps=30,tpad=stop_mode=clone:stop_duration=600,scale=1920:1080,setsar=1`;
    const len = `-t ${((pc.b - pc.a) / pc.speed).toFixed(3)}`;
    const r = pc.caption
      ? await run(`ffmpeg -y -ss ${pc.a.toFixed(3)} -to ${pc.b.toFixed(3)} -i ${q(RAW)} -i ${q(caps.get(pc.scene)!)} -filter_complex "[0:v]${base}[v];[v][1:v]overlay=0:0[o]" -map "[o]" ${len} ${ENC} ${q(f)}`, 600_000)
      : await run(`ffmpeg -y -ss ${pc.a.toFixed(3)} -to ${pc.b.toFixed(3)} -i ${q(RAW)} -vf "${base}" ${len} ${ENC} ${q(f)}`, 600_000);
    if (r.code) log(`piece ${k}: ${r.err.slice(-600)}`);
    else parts.push(f);
  }
  await card('card1', 'See every agent. Gate what matters.', 'Open-source AI gateway · github.com/joshmaster2165/controltower');
  await browser.close();
  fs.writeFileSync(path.join(TMP, 'parts.txt'), parts.map((f) => `file '${f}'`).join('\n'));
  const mp4 = path.join(OUT, SCENARIO === 'approvals' ? 'demo-approvals.mp4' : 'demo-desktop.mp4');
  const r = await run(`ffmpeg -y -f concat -safe 0 -i ${q(path.join(TMP, 'parts.txt'))} -c copy -movflags +faststart ${q(mp4)}`, 600_000);
  log(`edit: ${pieces.length} pieces, ${r.code} ${r.code ? r.err.slice(-1500) : ''}${fs.existsSync(mp4) ? ` ${(fs.statSync(mp4).size / 1e6).toFixed(1)} MB, ${(await duration(mp4)).toFixed(1)}s` : ''}`);
}
