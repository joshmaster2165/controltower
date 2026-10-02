/**
 * Records a product video (1080p MP4, captions burned in): an admin rolls Control Tower out to a fleet of Claude
 * Code and Claude Desktop users. Keys for each tool, rules by team, the MDM rollout files, a person connecting their
 * laptop, then the whole fleet on the map, every signed-in computer, and spend by person. A real server (the demo
 * fleet plus an Enterprise test license); the laptops are real device-flow sign-ins with real calls.
 *
 *   CT_TEST_LICENSE_KEYS=1 pnpm build && npx tsx scripts/demo-fleet.mjs [out.mp4]
 *
 * The recorder and presentation layer are those of scripts/demo-video.mjs.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { TEST_LICENSE_PUBLIC_KEY, testLicense } from '../e2e/support/license.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] ?? path.join(REPO, 'data/brand/controltower-fleet-rollout.mp4'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-fleet-video-'));
const FRAMES = path.join(TMP, 'frames');
const PORT = 4482;
const CT = `http://127.0.0.1:${PORT}`;
// What the laptops see: the address IT rolls out (the recording runs on this machine).
const SHOWN = 'https://ai.acme.com';
const ADMIN = 'fleet-video-admin-key-0123456789abcdef';
const W = 1440, H = 810, DSF = 4 / 3;
fs.mkdirSync(FRAMES);

const p = spawn('node', ['server/dist/server.mjs', '--port', String(PORT)], {
  cwd: REPO,
  env: { ...process.env, CT_DATA_DIR: path.join(TMP, 'data'), CT_DEMO: '1', CT_ADMIN_KEY: ADMIN, CT_UI_DIR: path.join(REPO, 'ui/dist'), CT_LOG_LEVEL: 'warn', CT_LICENSE_SERVER: 'off', CT_LICENSE_PUBLIC_KEY: TEST_LICENSE_PUBLIC_KEY, CT_LICENSE_KEY: testLicense({ customer: 'Acme Corp', email: 'it@acme.example', seats: 100 }), CT_LOGIN_RPM: '1000' },
  stdio: ['ignore', 'ignore', 'inherit'],
});
for (let i = 0; ; i++) {
  if ((await fetch(`${CT}/health/liveliness`).catch(() => null))?.ok) break;
  if (i > 100) throw new Error('server did not start — run CT_TEST_LICENSE_KEYS=1 pnpm build first');
  await new Promise((r) => setTimeout(r, 200));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H_ADMIN = { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' };
const api = (method, pth, body) => fetch(CT + pth, { method, headers: H_ADMIN, ...(body ? { body: JSON.stringify(body) } : {}) }).then((r) => r.json().catch(() => ({})));
// Laptops sign in from the office and from home (the address a load balancer would pass on).
const form = (pth, body, ip = '10.20.4.17') => fetch(CT + pth, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': ip }, body: new URLSearchParams(body) }).then((r) => r.json());
const ipFor = (i) => (i % 3 === 0 ? `73.${40 + i}.${(i * 37) % 250}.${(i * 11) % 250}` : `10.20.${4 + (i % 3)}.${20 + i}`);

/** A person with their own password and a session (to approve their laptop). */
async function person(email, teamId) {
  const made = await api('PUT', `/admin/api/teams/${teamId}/members`, { email, role: 'member' });
  const pw = `${email.split('@')[0]}-Password-1`;
  const login = async (password) => {
    const r = await fetch(`${CT}/admin/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    return { cookie: r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '), csrf: (await r.json()).csrf };
  };
  let s = await login(made.password);
  await fetch(`${CT}/admin/api/me/password`, { method: 'POST', headers: { cookie: s.cookie, 'x-ct-csrf': s.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ current: made.password, password: pw }) });
  s = await login(pw);
  return { email, pw, approve: (code) => fetch(`${CT}/admin/api/me/devices/approve`, { method: 'POST', headers: { cookie: s.cookie, 'x-ct-csrf': s.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ user_code: code }) }) };
}
/** A laptop's sign-in: the device flow ct-auth runs. */
async function signIn(who, client, device, ip) {
  const s = await form('/device/code', { client, device_name: device }, ip);
  const a = await who.approve(s.user_code);
  if (a.status !== 200) throw new Error(`${who.email} could not approve ${client}: ${a.status} ${await a.text()}`);
  for (let i = 0; i < 20; i++) {
    const t = await form('/device/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: s.device_code }, ip);
    if (t.access_token) return t.access_token;
    if (t.error !== 'authorization_pending' && t.error !== 'slow_down') throw new Error(`${who.email}: ${JSON.stringify(t)}`);
    await sleep(1000);
  }
  throw new Error(`${who.email}: no token`);
}
const step = (s) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
const PROMPTS = ['Refactor the billing module to use the new invoices API', 'Why does this test flake on CI?', 'Write a migration for the orders table', 'Summarise this RFC for the design review', 'Explain this stack trace', 'Draft release notes from these commits'];
const call = (token, model) =>
  fetch(`${CT}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, max_tokens: 200, messages: [{ role: 'user', content: PROMPTS[Math.floor(Math.random() * PROMPTS.length)] }] }) }).catch(() => undefined);

// ---- setup, before recording ----
const eng = (await api('POST', '/admin/api/teams', { name: 'engineering' })).id;
const design = (await api('POST', '/admin/api/teams', { name: 'design' })).id;
const dana = await person('dana@acme.example', eng);
const FIRST = ['priya', 'lee', 'sam', 'alex', 'morgan', 'jordan', 'kim', 'noor', 'ravi', 'tess', 'omar', 'yuki', 'ines', 'theo', 'zara', 'luis', 'mei', 'arjun', 'kofi', 'hana'];
const people = [];
for (const [i, n] of FIRST.entries()) people.push({ ...(await person(`${n}@acme.example`, i % 4 === 3 ? design : eng)), team: i % 4 === 3 ? 'design' : 'engineering', name: n });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: DSF, acceptDownloads: true });
const page = await ctx.newPage();
await page.addInitScript(() => {
  try {
    localStorage.setItem('ct.sidebar.collapsed', '1');
  } catch {}
  addEventListener('DOMContentLoaded', () => {
    const css = document.createElement('style');
    css.textContent = `
      .toasts, .onboarding-pill, .onboarding { display: none !important; }
      #rec-cursor { position: fixed; z-index: 99999; pointer-events: none; width: 24px; height: 24px; left: -40px; top: -40px; transition: transform .08s; }
      #rec-cursor.down { transform: scale(.85); }
      .rec-ripple { position: fixed; z-index: 99998; pointer-events: none; width: 40px; height: 40px; margin: -20px 0 0 -20px; border-radius: 50%; border: 3px solid #1f5eff; animation: rec-rip .6s ease-out forwards; }
      @keyframes rec-rip { from { transform: scale(.3); opacity: .9 } to { transform: scale(1.6); opacity: 0 } }
      #rec-caption { position: fixed; z-index: 99997; left: 104px; bottom: 56px; transform: translateY(12px); opacity: 0; pointer-events: none; display: flex; align-items: center; gap: 16px; transition: opacity .35s, transform .35s;
        background: rgba(10,18,34,.94); color: #fff; padding: 14px 26px 14px 14px; border-radius: 16px; box-shadow: 0 16px 40px rgba(10,18,34,.35); font: 500 17px/1.35 system-ui, -apple-system, 'Segoe UI', sans-serif; white-space: nowrap; }
      #rec-caption.on { opacity: 1; transform: none; }
      #rec-caption b { display: block; font-size: 20px; font-weight: 650; letter-spacing: -.01em; }
      #rec-caption span.sub { color: #b9c6da; }
      #rec-caption .n { flex: none; width: 40px; height: 40px; border-radius: 11px; background: #1f5eff; display: grid; place-items: center; font-weight: 700; font-size: 18px; }
      #rec-title { position: fixed; inset: 0; z-index: 100000; display: grid; place-items: center; text-align: center; color: #fff; opacity: 0; pointer-events: none; transition: opacity .6s;
        background: radial-gradient(900px 500px at 50% 30%, rgba(31,94,255,.45), transparent 70%), #0a1222; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; }
      #rec-title.on { opacity: 1; }
      #rec-title .t { font-size: 54px; font-weight: 600; letter-spacing: -.035em; line-height: 1.08; }
      #rec-title .t em { font-style: normal; color: #6f9bff; display: block; }
      #rec-title .s { margin-top: 18px; font-size: 21px; color: #a9b8d3; }
      #rec-title .k { margin-top: 30px; font: 600 14px ui-monospace, Menlo, monospace; letter-spacing: .2em; color: #8fb0ff; }
      #rec-title svg { width: 74px; height: 74px; margin: 0 auto 22px; display: block; }
      #rec-term { position: fixed; z-index: 99996; left: 50%; top: 46%; width: 860px; transform: translate(-50%, -50%) scale(.97); opacity: 0; pointer-events: none; transition: opacity .4s, transform .4s;
        border-radius: 14px; overflow: hidden; box-shadow: 0 30px 80px rgba(10,18,34,.5); background: #0f1b2d; font: 15px/1.6 'JetBrains Mono', ui-monospace, Menlo, monospace; color: #dbe4f0; }
      #rec-term.on { opacity: 1; transform: translate(-50%, -50%); box-shadow: 0 30px 80px rgba(10,18,34,.5), 0 0 0 100vmax rgba(10,18,34,.55); }
      #rec-term .bar { display: flex; align-items: center; gap: 8px; padding: 11px 14px; background: #1c2a3f; color: #9fb0c8; font: 13px system-ui, sans-serif; }
      #rec-term .bar i { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
      #rec-term .body { padding: 18px 22px 22px; min-height: 250px; white-space: pre-wrap; }
      #rec-term .p { color: #6ee7a8; } #rec-term .dim { color: #8a9bb4; } #rec-term .hl { color: #ffd479; } #rec-term .ok { color: #6ee7a8; }`;
    document.head.appendChild(css);
    const c = document.createElement('div');
    c.id = 'rec-cursor';
    c.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M4 2l15 11.5-6.6.9 3.9 7.4-3 1.5-3.8-7.4L4 20z" fill="#0f1b2d" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.body.appendChild(c);
    for (const id of ['rec-caption', 'rec-title']) {
      const el = document.createElement('div');
      el.id = id;
      document.body.appendChild(el);
    }
    const term = document.createElement('div');
    term.id = 'rec-term';
    term.innerHTML = '<div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i><span style="margin-left:10px">dana — Dana’s MacBook Pro — zsh</span></div><div class="body"></div>';
    document.body.appendChild(term);
    addEventListener('mousemove', (e) => { c.style.left = e.clientX - 3 + 'px'; c.style.top = e.clientY - 2 + 'px'; }, true);
    addEventListener('mousedown', (e) => {
      c.classList.add('down');
      const r = document.createElement('div');
      r.className = 'rec-ripple';
      r.style.left = e.clientX + 'px';
      r.style.top = e.clientY + 'px';
      document.body.appendChild(r);
      setTimeout(() => r.remove(), 700);
    }, true);
    addEventListener('mouseup', () => c.classList.remove('down'), true);
  });
});

const LOGO = '<svg viewBox="0 0 64 64" fill="none"><path d="M41 15a13 13 0 0 1 9 9" stroke="#6f9bff" stroke-width="3" stroke-linecap="round" opacity=".8"/><path d="M44 8a20 20 0 0 1 13 13" stroke="#6f9bff" stroke-width="3" stroke-linecap="round" opacity=".45"/><rect x="30.5" y="5" width="3" height="11" rx="1.5" fill="#fff"/><path d="M13 18h38l-4.5 12H17.5z" fill="#3d7bff"/><rect x="20" y="22.5" width="24" height="3" rx="1.5" fill="#fff" opacity=".9"/><path d="M26.5 30h11l3.5 25H23z" fill="#fff"/><rect x="17" y="54" width="30" height="4.5" rx="2.25" fill="#fff"/></svg>';
const titleCard = (html) => page.evaluate((h) => { const el = document.getElementById('rec-title'); if (!h) return void el.classList.remove('on'); el.innerHTML = `<div>${h}</div>`; el.classList.add('on'); }, html);
const caption = (n, title, sub) => page.evaluate(([n, t, s]) => { const el = document.getElementById('rec-caption'); if (!n) return void el.classList.remove('on'); el.innerHTML = `<div class="n">${n}</div><div><b>${t}</b><span class="sub">${s}</span></div>`; el.classList.add('on'); }, [n, title, sub]);
/** The terminal window: lines appear one by one (html per line; empty hides it). */
async function terminal(lines, perLine = 450) {
  await page.evaluate(() => { const t = document.getElementById('rec-term'); t.querySelector('.body').innerHTML = ''; t.classList.add('on'); });
  if (!lines) return page.evaluate(() => document.getElementById('rec-term').classList.remove('on'));
  for (const l of lines) {
    await page.evaluate((h) => { const b = document.querySelector('#rec-term .body'); b.innerHTML += `${h}\n`; }, l);
    await page.waitForTimeout(perLine);
  }
}
const termOff = () => page.evaluate(() => document.getElementById('rec-term').classList.remove('on'));

let cur = [W / 2, H / 2];
async function glide(x, y, ms = 700) {
  const [x0, y0] = cur;
  const steps = Math.max(8, Math.round(ms / 20));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    await page.mouse.move(x0 + (x - x0) * e, y0 + (y - y0) * e);
    await page.waitForTimeout(20);
  }
  cur = [x, y];
}
async function clickAt(x, y, ms) {
  await glide(x, y, ms);
  await page.mouse.down();
  await page.waitForTimeout(90);
  await page.mouse.up();
}
async function clickEl(loc, ms) {
  await loc.scrollIntoViewIfNeeded();
  const bb = await loc.boundingBox();
  await clickAt(bb.x + bb.width / 2, bb.y + bb.height / 2, ms);
}
/** Type into a field the way a person does. */
async function typeInto(loc, text) {
  await clickEl(loc, 500);
  await loc.fill('');
  await loc.pressSequentially(text, { delay: 45 });
}
const wait = (ms) => page.waitForTimeout(ms);
const scrollMain = (y, ms = 1200) =>
  page.evaluate(([y, ms]) => new Promise((done) => {
    const el = document.querySelector('main.main') ?? document.scrollingElement;
    const y0 = el.scrollTop, t0 = performance.now();
    const step = (t) => { const k = Math.min(1, (t - t0) / ms), e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2; el.scrollTop = y0 + (y - y0) * e; k < 1 ? requestAnimationFrame(step) : done(); };
    requestAnimationFrame(step);
  }), [y, ms]);
const scrollTo = async (loc, offset = 90, ms = 1200) => {
  const top = await loc.evaluate((e) => { const m = document.querySelector('main.main'); return e.getBoundingClientRect().top + (m?.scrollTop ?? 0) - (m?.getBoundingClientRect().top ?? 0); });
  await scrollMain(Math.max(0, top - offset), ms);
};
const go = async (route) => { await page.evaluate((r) => (location.hash = r), route); await wait(900); };
async function stationAt(label, dx = 60, dy = 20) {
  for (let i = 0; i < 60; i++) {
    const pt = await page.evaluate(([l, dx, dy]) => {
      const s = window.__ctScene;
      const st = s && [...s.stations.values()].find((x) => x.label === l);
      if (!st) return null;
      const c = s.getCamera(), r = s.canvas.getBoundingClientRect();
      return [(st.x + dx) * c.k + c.x + r.left, (st.y + dy) * c.k + c.y + r.top];
    }, [label, dx, dy]);
    if (pt) return pt;
    await wait(250);
  }
  throw new Error('no station ' + label);
}
async function signInUi(email, password) {
  const f = (l) => page.locator('.field', { has: page.locator('label', { hasText: l }) }).first().locator('input').first();
  await f(/^Email or username/).fill(email);
  await f(/^Password/).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

// ---- recorder ----
const cdp = await ctx.newCDPSession(page);
const frames = [];
cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
  const f = path.join(FRAMES, `${String(frames.length).padStart(5, '0')}.jpg`);
  fs.writeFileSync(f, Buffer.from(data, 'base64'));
  frames.push({ file: f, t: metadata.timestamp });
  await cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined);
});
function encode() {
  const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.001, (frames[i + 1]?.t ?? f.t + 2) - f.t).toFixed(4)}`).join('\n') + `\nfile '${frames.at(-1).file}'\n`;
  fs.writeFileSync(path.join(TMP, 'frames.txt'), list);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(TMP, 'frames.txt'), '-vf', 'scale=1920:1080:flags=lanczos,fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-movflags', '+faststart', OUT], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('ffmpeg failed');
  const secs = Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', OUT], { encoding: 'utf8' }).stdout);
  console.log(`${path.relative(REPO, OUT)}: ${secs.toFixed(1)} s, ${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB, ${frames.length} frames`);
}

let fleetRunning = false;
const tokens = [];
try {
  await page.goto(CT + '/');
  await signInUi('admin', ADMIN);
  await wait(1000);
  await go('#/keys');
  await wait(4000);
  await page.mouse.move(cur[0], cur[1]);
  await titleCard(`${LOGO}<div class="t">Every Claude Code and Claude Desktop<em>through your gateway</em></div><div class="s">Rolled out with Jamf, Intune or Kandji — every person signed in as themselves</div>`);
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1 });
  await wait(4200);
  await titleCard('');
  await wait(700);

  step('1 — A key for each tool.');
  // 1 — A key for each tool.
  await caption(1, 'A key for each tool', 'Its models, budget, limits and gates apply to every laptop that uses it');
  await clickEl(page.getByRole('button', { name: 'Create key', exact: true }), 900);
  const kform = page.locator('form.card');
  const kf = (l) => kform.locator('.field', { has: page.locator('label', { hasText: l }) }).first().locator('input').first();
  await typeInto(kf(/^Name \(agent\)/), 'claude-code');
  await typeInto(kf(/^Team/), 'engineering');
  await wait(400);
  await clickEl(kform.getByRole('button', { name: 'Create', exact: true }), 700);
  await wait(1200);
  // The key in the list (its secret is never handed out: laptops get their own short-lived tokens).
  const keyRow = page.locator('table tr', { hasText: 'claude-code' }).first();
  await keyRow.waitFor();
  await scrollTo(keyRow, 180, 1000);
  await glide(W * 0.62, H * 0.55, 600);
  await caption(1, 'A key for each tool', 'Nobody ever copies its secret: laptops get their own short-lived tokens');
  await wait(2600);
  const cdKey = await api('POST', '/admin/api/keys', { name: 'claude-desktop' });
  const ccKey = ((await api('GET', '/admin/api/keys')).keys ?? []).find((k) => k.name === 'claude-code');

  step('2 — Rules');
  // 2 — Rules: which key each tool's calls are made as.
  await go('#/laptops');
  await caption(2, 'Rules: who uses which key', 'Claude Code for engineering, Claude Desktop for everyone');
  const rulesSection = page.locator('.laptops-section').nth(0);
  for (const [tool, team, key] of [['Claude Code', 'Team engineering', 'claude-code'], ['Claude Desktop', 'Everyone', 'claude-desktop']]) {
    await clickEl(rulesSection.getByRole('button', { name: 'Add a rule' }), 700);
    const row = rulesSection.locator('tbody tr').last();
    await clickEl(row.getByLabel('Tool'), 400);
    await row.getByLabel('Tool').selectOption({ label: tool });
    await clickEl(row.getByLabel('People'), 400);
    await row.getByLabel('People').selectOption({ label: team });
    await clickEl(row.getByLabel('Key'), 400);
    await row.getByLabel('Key').selectOption({ label: key === 'claude-code' ? 'claude-code (engineering)' : key });
    await wait(400);
  }
  await clickEl(rulesSection.getByRole('button', { name: 'Save rules' }), 700);
  await wait(1800);

  step('3 — The rollout files.');
  // 3 — The rollout files.
  const roll = page.locator('.laptops-section').nth(1);
  await scrollTo(roll, 70);
  await caption(3, 'Download the rollout files', 'One profile and one script, with your address — no secrets in them');
  await typeInto(roll.getByLabel('The address laptops reach Control Tower at'), SHOWN);
  await clickEl(roll.getByLabel('Codex'), 600);
  await wait(900);
  await clickEl(roll.getByLabel('Lock down: no other provider or MCP server'), 500);
  await wait(300);
  await clickEl(roll.getByLabel('Lock down: no other provider or MCP server'), 500);
  await caption(3, 'Lock it down', 'Managed settings: Claude Code and Claude Desktop use Control Tower, and nothing else');
  await wait(1600);
  const showProfile = roll.getByRole('row', { name: /controltower\.mobileconfig/ }).getByRole('button', { name: 'Show' });
  await clickEl(showProfile, 700);
  await wait(800);
  await scrollTo(roll.locator('pre').first(), 150, 1600);
  await wait(2200);
  await scrollTo(roll.getByRole('row', { name: /controltower\.mobileconfig/ }), 220, 1000);
  await caption(3, 'Upload them to Jamf, Intune or Kandji', 'macOS profile + script · Windows script or .reg · Linux script');
  const dl = page.waitForEvent('download').catch(() => undefined);
  await clickEl(roll.getByRole('row', { name: /controltower\.mobileconfig/ }).getByRole('button', { name: 'Download' }), 700);
  await dl;
  await wait(2400);
  await caption(0);

  step('4 — On a laptop');
  // 4 — On a laptop: Claude Code asks Dana to sign in; she approves in her browser.
  const sCode = await form('/device/code', { client: 'claude-code', device_name: 'Dana’s MacBook Pro' });
  await caption(4, 'On each laptop: sign in once', 'The first time Claude Code starts, it asks the person to sign in');
  await terminal([
    '<span class="p">~/billing $</span> claude',
    '',
    '<span class="dim">Sign in to Control Tower for Claude Code:</span>',
    `  open  <span class="hl">${SHOWN}/device?code=${sCode.user_code}</span>`,
    `  and check the code  <span class="hl">${sCode.user_code}</span>`,
  ]);
  await wait(2600);
  await termOff();
  await wait(400);
  // Dana's browser: her company sign-in, then the approval.
  await ctx.clearCookies();
  await page.goto(`${CT}/device?code=${sCode.user_code}`);
  await wait(700);
  await page.mouse.move(cur[0], cur[1]);
  await caption(4, 'Her browser opens Control Tower', 'She signs in as usual — single sign-on, or a password');
  const f = (l) => page.locator('.field', { has: page.locator('label', { hasText: l }) }).first().locator('input').first();
  await typeInto(f(/^Email or username/), dana.email);
  await typeInto(f(/^Password/), dana.pw);
  await clickEl(page.getByRole('button', { name: 'Sign in', exact: true }), 600);
  await page.getByRole('button', { name: 'Approve' }).waitFor();
  await caption(4, 'She approves it', 'What asked, from where, and the key its calls are made as');
  await wait(2600);
  await clickEl(page.getByRole('button', { name: 'Approve' }), 800);
  await wait(1800);
  let danaToken;
  for (let i = 0; i < 20 && !danaToken; i++) {
    const t = await form('/device/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: sCode.device_code });
    if (t.access_token) danaToken = t.access_token;
    else await sleep(1000);
  }
  if (!danaToken) throw new Error('Dana got no token');
  await call(danaToken, 'claude-sonnet-4-5');
  await terminal([
    '<span class="ok">Signed in as dana@acme.example.</span> <span class="dim">Calls from Claude Code are made as the key claude-code.</span>',
    `<span class="dim">Claude Code is set up by your company to use ${SHOWN}.</span>`,
    '',
    '<span class="p">&gt;</span> Refactor the billing module to use the new invoices API',
    '<span class="dim">  (every request now goes through Control Tower, as Dana)</span>',
  ], 380);
  await wait(2200);
  await termOff();

  step('The rest of the fleet');
  // The rest of the fleet signs in, and gets to work.
  await ctx.clearCookies();
  await page.goto(CT + '/');
  await signInUi('admin', ADMIN);
  await wait(800);
  const DEVICES = ['MacBook Pro', 'MacBook Air', 'ThinkPad X1', 'Surface Laptop', 'Mac Studio'];
  await Promise.all(people.map(async (pp, i) => {
    const client = pp.team === 'engineering' && i % 3 !== 2 ? 'claude-code' : 'claude-desktop';
    const name = `${pp.name[0].toUpperCase()}${pp.name.slice(1)}’s ${DEVICES[i % DEVICES.length]}`;
    tokens.push({ token: await signIn(pp, client, name, ipFor(i)), client });
    if (client === 'claude-code' && i % 2 === 0) tokens.push({ token: await signIn(pp, 'claude-desktop', name, ipFor(i)), client: 'claude-desktop' });
  }));
  tokens.push({ token: danaToken, client: 'claude-code' });
  fleetRunning = true;
  void (async () => {
    while (fleetRunning) {
      const t = tokens[Math.floor(Math.random() * tokens.length)];
      void call(t.token, t.client === 'claude-code' ? (Math.random() < 0.7 ? 'claude-sonnet-4-5' : 'claude-haiku-4-5') : 'claude-sonnet-4-5');
      await sleep(180 + Math.random() * 300);
    }
  })();

  step('5 — The fleet on the map.');
  // 5 — The fleet on the map.
  await go('#/airspace');
  await wait(2500);
  await page.evaluate(() => window.__ctScene?.fit());
  await caption(5, 'The whole fleet, on the map', 'Every laptop’s Claude Code and Claude Desktop, beside your agents');
  await wait(2500);
  const [kx, ky] = await stationAt('claude-code');
  await glide(kx, ky, 1100);
  await wait(900);
  await clickAt(kx, ky, 200);
  await glide(W * 0.5, H * 0.12, 700);
  await caption(5, 'Gates apply to every laptop', 'Block a model, require approval for a tool, inspect what leaves — for the whole fleet');
  await wait(4200);
  await page.keyboard.press('Escape');

  step('6 — Every signed-in computer.');
  // 6 — Every signed-in computer.
  await go('#/laptops');
  const comps = page.locator('.laptops-section').nth(2);
  await scrollTo(comps, 16, 1400);
  await caption(6, 'Every signed-in computer', 'Who, which tool, which machine, which key, last used');
  await wait(3200);
  await caption(6, 'Someone leaves? Sign them out', 'Their token stops working at once — and removing them at your IdP does the same');
  await clickEl(comps.getByRole('button', { name: 'Sign out' }).nth(3), 1000);
  await wait(2600);

  step('7 — Spend by person.');
  // 7 — Spend by person.
  await caption(0);
  await go('#/ledger');
  const peopleCard = page.locator('.card', { hasText: 'Spend by person' });
  await peopleCard.waitFor();
  await scrollTo(peopleCard, 80, 1600);
  await caption(7, 'Spend by person', 'Even on a shared key: who used what, and what it cost');
  await wait(4200);
  await caption(0);
  await wait(400);

  await titleCard(`${LOGO}<div class="t">Control Tower</div><div class="s">Laptops · single sign-on · gates · spend by person — self-hosted</div><div class="k">AGENTCONTROLTOWER.APP</div>`);
  await wait(4500);
  await cdp.send('Page.stopScreencast');
  await wait(300);
  fleetRunning = false;
  encode();
} catch (err) {
  const dbg = path.join(REPO, 'data/brand/demo-fleet-failure.png');
  await page.screenshot({ path: dbg }).catch(() => undefined);
  console.error('failure screenshot:', dbg);
  throw err;
} finally {
  fleetRunning = false;
  await browser.close();
  p.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
}
