/**
 * Records an extended product video (1080p MP4, captions burned in, made for LinkedIn and the website) from a
 * real Control Tower: the built server with the demo fleet and an Enterprise test license, driven in Chromium —
 * the live map, tracing an agent, drawing a gate, approving the held call, Flights, the Ledger and the audit log.
 *
 *   CT_TEST_LICENSE_KEYS=1 pnpm build && npx tsx scripts/demo-video.mjs [out.mp4]
 *
 * Frames come from Chrome's screencast (every repaint, at 1920×1080), then ffmpeg encodes them at 30 fps.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { TEST_LICENSE_PUBLIC_KEY, testLicense } from '../e2e/support/license.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] ?? path.join(REPO, 'data/brand/controltower-demo.mp4'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-demo-video-'));
const FRAMES = path.join(TMP, 'frames');
const PORT = 4481;
const CT = `http://127.0.0.1:${PORT}`;
const ADMIN = 'demo-video-admin-key-0123456789abcdef';
// A 1440×810 page at 4/3 device pixels: 1920×1080 frames, with the console at a size people can read.
const W = 1440, H = 810, DSF = 4 / 3;
fs.mkdirSync(FRAMES);

async function startServer() {
  const p = spawn('node', ['server/dist/server.mjs', '--port', String(PORT)], {
    cwd: REPO,
    env: {
      ...process.env,
      CT_DATA_DIR: path.join(TMP, 'data'),
      CT_DEMO: '1',
      CT_ADMIN_KEY: ADMIN,
      CT_UI_DIR: path.join(REPO, 'ui/dist'),
      CT_LOG_LEVEL: 'warn',
      CT_LICENSE_SERVER: 'off',
      CT_LICENSE_PUBLIC_KEY: TEST_LICENSE_PUBLIC_KEY,
      CT_LICENSE_KEY: testLicense({ customer: 'Acme Corp', email: 'it@acme.example' }),
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${CT}/health/liveliness`)).ok) return p;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  p.kill();
  throw new Error('server did not start — run CT_TEST_LICENSE_KEYS=1 pnpm build first');
}

const srv = await startServer();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DSF });

// Presentation layer: a visible cursor with click ripples, caption cards, title cards, no toasts.
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
      #rec-caption { position: fixed; z-index: 99997; left: 104px; bottom: 64px; transform: translateY(12px); opacity: 0; pointer-events: none; display: flex; align-items: center; gap: 16px; transition: opacity .35s, transform .35s;
        background: rgba(10,18,34,.94); color: #fff; padding: 14px 26px 14px 14px; border-radius: 16px; box-shadow: 0 16px 40px rgba(10,18,34,.35); font: 500 17px/1.35 system-ui, -apple-system, 'Segoe UI', sans-serif; white-space: nowrap; }
      #rec-caption.on { opacity: 1; transform: none; }
      #rec-caption b { display: block; font-size: 20px; font-weight: 650; letter-spacing: -.01em; }
      #rec-caption span.sub { color: #b9c6da; }
      #rec-caption .n { flex: none; width: 40px; height: 40px; border-radius: 11px; background: #1f5eff; display: grid; place-items: center; font-weight: 700; font-size: 18px; }
      #rec-title { position: fixed; inset: 0; z-index: 100000; display: grid; place-items: center; text-align: center; color: #fff; opacity: 0; pointer-events: none; transition: opacity .6s;
        background: radial-gradient(900px 500px at 50% 30%, rgba(31,94,255,.45), transparent 70%), #0a1222; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; }
      #rec-title.on { opacity: 1; }
      #rec-title .t { font-size: 58px; font-weight: 600; letter-spacing: -.035em; line-height: 1.05; }
      #rec-title .t em { font-style: normal; color: #6f9bff; display: block; }
      #rec-title .s { margin-top: 18px; font-size: 21px; color: #a9b8d3; }
      #rec-title .k { margin-top: 30px; font: 600 14px ui-monospace, Menlo, monospace; letter-spacing: .2em; color: #8fb0ff; }
      #rec-title svg { width: 74px; height: 74px; margin: 0 auto 22px; display: block; }`;
    document.head.appendChild(css);
    const c = document.createElement('div');
    c.id = 'rec-cursor';
    c.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M4 2l15 11.5-6.6.9 3.9 7.4-3 1.5-3.8-7.4L4 20z" fill="#0f1b2d" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.body.appendChild(c);
    const cap = document.createElement('div');
    cap.id = 'rec-caption';
    document.body.appendChild(cap);
    const title = document.createElement('div');
    title.id = 'rec-title';
    document.body.appendChild(title);
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
const titleCard = (html) =>
  page.evaluate((h) => {
    const el = document.getElementById('rec-title');
    if (!h) return void el.classList.remove('on');
    el.innerHTML = `<div>${h}</div>`;
    el.classList.add('on');
  }, html);
const caption = (n, title, sub) =>
  page.evaluate(([n, t, s]) => {
    const el = document.getElementById('rec-caption');
    if (!n) return void el.classList.remove('on');
    el.innerHTML = `<div class="n">${n}</div><div><b>${t}</b><span class="sub">${s}</span></div>`;
    el.classList.add('on');
  }, [n, title, sub]);

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
  const bb = await loc.boundingBox();
  await clickAt(bb.x + bb.width / 2, bb.y + bb.height / 2, ms);
}
const wait = (ms) => page.waitForTimeout(ms);
/** Smooth scroll of the console's main pane. */
const scrollBy = (dy, ms = 1200) =>
  page.evaluate(([dy, ms]) => new Promise((done) => {
    const el = document.querySelector('main.main') ?? document.scrollingElement;
    const y0 = el.scrollTop, t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / ms), e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      el.scrollTop = y0 + dy * e;
      k < 1 ? requestAnimationFrame(step) : done();
    };
    requestAnimationFrame(step);
  }), [dy, ms]);

/** Screen position of a station on the Airspace canvas (dx/dy in map units from its top-left). */
async function stationAt(label, dx = 60, dy = 20) {
  for (let i = 0; i < 50; i++) {
    const pt = await page.evaluate(([l, dx, dy]) => {
      const s = window.__ctScene;
      if (!s) return null;
      const st = [...s.stations.values()].find((x) => x.label === l);
      if (!st) return null;
      const c = s.getCamera();
      const r = s.canvas.getBoundingClientRect();
      return [(st.x + dx) * c.k + c.x + r.left, (st.y + dy) * c.k + c.y + r.top];
    }, [label, dx, dy]);
    if (pt) return pt;
    await wait(200);
  }
  throw new Error('no station ' + label);
}
/** Go to a console page without a reload (the presentation layer stays). */
const go = async (route) => {
  await page.evaluate((r) => (location.hash = r), route);
  await wait(900);
};

// ---- recorder: Chrome's screencast, every repaint ----
const cdp = await page.context().newCDPSession(page);
const frames = [];
cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
  const f = path.join(FRAMES, `${String(frames.length).padStart(5, '0')}.jpg`);
  fs.writeFileSync(f, Buffer.from(data, 'base64'));
  frames.push({ file: f, t: metadata.timestamp });
  await cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined);
});

function encode() {
  // Each frame shown until the next one; the last held for a moment.
  const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.001, ((frames[i + 1]?.t ?? f.t + 2) - f.t)).toFixed(4)}`).join('\n') + `\nfile '${frames.at(-1).file}'\n`;
  fs.writeFileSync(path.join(TMP, 'frames.txt'), list);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(TMP, 'frames.txt'), '-vf', 'scale=1920:1080:flags=lanczos,fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-movflags', '+faststart', OUT], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('ffmpeg failed');
  const secs = Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', OUT], { encoding: 'utf8' }).stdout);
  console.log(`${path.relative(REPO, OUT)}: ${secs.toFixed(1)} s, ${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB, ${frames.length} frames`);
}

try {
  // Sign in, then let the demo fleet build up traffic before recording.
  await page.goto(CT + '/');
  const f = (l) => page.locator('.field', { has: page.locator('label', { hasText: l }) }).first().locator('input').first();
  await f(/^Email or username/).fill('admin');
  await f(/^Password/).fill(ADMIN);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await wait(800);
  await go('#/airspace');
  // A morning's work in the audit log: keys, a budget, a limit, a team, a new approver, and a refused sign-in.
  const h = { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' };
  const api = (method, p, body) => fetch(CT + p, { method, headers: h, ...(body ? { body: JSON.stringify(body) } : {}) }).then((r) => r.json().catch(() => ({})));
  const keys = (await api('GET', '/admin/api/keys')).keys ?? [];
  const triage = keys.find((k) => k.name === 'support-triage');
  await api('POST', '/admin/api/keys', { name: 'billing-agent', team: 'finance' });
  if (triage) await api('PUT', `/admin/api/budgets/key/${triage.id}`, { limit_usd: 50, period: 'monthly', hard: true });
  if (triage) await api('PATCH', `/admin/api/keys/${triage.id}`, { limits: { rpm: 120 } });
  await api('POST', '/admin/api/teams', { name: 'customer-support' });
  await api('POST', '/admin/api/users', { email: 'dana@acme.example', role: 'approver' });
  await fetch(CT + '/admin/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'mallory@example.com', password: 'guess-1234' }) });
  await wait(20000);
  await page.evaluate(() => window.__ctScene.fit());
  await wait(800);
  await page.mouse.move(cur[0], cur[1]);
  await titleCard(`${LOGO}<div class="t">Air traffic control<em>for your AI agents</em></div><div class="s">See every agent, model and tool call. Gate the risky ones. Know what each one costs.</div>`);
  await wait(700);

  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1 });
  await wait(3800);
  await titleCard('');
  await wait(700);

  // 1 — See
  await caption(1, 'See every agent on one live map', 'Agents, models, MCP tool servers and APIs — the calls between them, as they happen');
  await wait(5200);

  // 2 — Trace
  await caption(2, 'Trace any agent', 'Where it goes, what it calls, what it costs and what fails');
  const [ax, ay] = await stationAt('support-triage');
  await glide(ax, ay, 1000);
  await wait(1400);
  await clickAt(ax, ay, 200);
  await wait(3800);
  await page.keyboard.press('Escape');
  await wait(500);

  // 3 — Gate
  await caption(3, 'Draw a gate on the map', 'Drag from an agent to a tool: block it, inspect it, or require a human');
  await clickEl(page.getByRole('button', { name: 'Add gate' }), 800);
  await wait(500);
  const [sx, sy] = await stationAt('support-triage');
  const [tx, ty] = await stationAt('Salesforce', 50, 16);
  await glide(sx, sy, 600);
  await page.mouse.down();
  await glide(tx, ty, 1000);
  await page.mouse.up();
  await wait(800);
  if (process.env.DEBUG_SHOTS) await page.screenshot({ path: path.join(REPO, 'data/brand/dbg-1-after-drag.png') });
  const pop = page.locator('.popover').filter({ hasText: 'New gate' });
  // The dropdown that offers the tool (the gate's "To").
  let tool, opt;
  for (const sel of await pop.locator('select').all()) {
    const o = (await sel.locator('option').allTextContents()).find((x) => x.includes('search_contacts'));
    if (o) [tool, opt] = [sel, o];
  }
  if (!tool) throw new Error('no dropdown offers search_contacts');
  await clickEl(tool, 500);
  await tool.selectOption({ label: opt });
  await wait(600);
  await clickEl(pop.getByRole('button', { name: 'Require approval', exact: true }), 500);
  await wait(500);
  const addBtn = pop.getByRole('button', { name: 'Add gate', exact: true });
  await addBtn.scrollIntoViewIfNeeded();
  await wait(400);
  if (process.env.DEBUG_SHOTS) await page.screenshot({ path: path.join(REPO, 'data/brand/dbg-2-before-add.png') });
  await clickEl(addBtn, 600);
  await wait(300);
  if (process.env.DEBUG_SHOTS) await page.screenshot({ path: path.join(REPO, 'data/brand/dbg-3-after-add.png') });
  await page.getByRole('button', { name: 'Add gate', exact: true }).first().click(); // leave add-gate mode
  await caption(3, 'Draw a gate on the map', 'support-triage → search_contacts now waits for a person');
  await wait(1200);

  // 4 — Approve
  await clickEl(page.getByRole('button', { name: /^Approvals/ }), 900);
  const card = page.locator('.tower-drawer .approval').filter({ hasText: 'support-triage' }).first();
  await card.waitFor({ timeout: 25000 });
  await caption(4, 'Approve it from the Tower', 'The call holds at the gate with its real arguments — approve, and the agent carries on');
  await wait(2600);
  await clickEl(card.getByRole('button', { name: 'Approve', exact: true }), 800);
  await wait(3000);
  await page.keyboard.press('Escape');
  await caption(0);
  await wait(1500);

  // 5 — Flights
  await go('#/flights');
  await caption(5, 'Every call, recorded', 'Agent, model or tool, outcome, tokens, cost and latency — on your own servers');
  await glide(W * 0.55, H * 0.4, 900);
  await wait(2600);
  await scrollBy(320, 1600);
  await wait(2200);

  // 6 — Ledger
  await go('#/ledger');
  await caption(6, 'Know what every agent costs', 'Spend, tokens and latency by agent, team and model');
  await glide(W * 0.6, H * 0.35, 900);
  await wait(2800);
  await scrollBy(380, 1800);
  await wait(2400);

  // 7 — Audit (Enterprise)
  await go('#/audit');
  await caption(7, 'A tamper-evident audit log', 'Every change, hash-chained — Verify finds anything edited or removed');
  await wait(1800);
  await clickEl(page.getByRole('button', { name: 'Verify' }), 900);
  await wait(3600);
  await caption(0);
  await wait(500);

  // End card
  await titleCard(`${LOGO}<div class="t">Control Tower</div><div class="s">Open source · self-hosted · Enterprise when you need it</div><div class="k">AGENTCONTROLTOWER.APP</div>`);
  await wait(4500);

  await cdp.send('Page.stopScreencast');
  await wait(300);
  encode();
} catch (err) {
  // What the page and the server looked like when it went wrong.
  const dbg = path.join(REPO, 'data/brand/demo-video-failure.png');
  await page.screenshot({ path: dbg }).catch(() => undefined);
  const h = { authorization: `Bearer ${ADMIN}` };
  const pol = await (await fetch(`${CT}/admin/api/policy`, { headers: h })).json().catch(() => ({}));
  const rules = (pol.rules ?? []).map((r) => `${r.name ?? r.id}:${r.effect}:${JSON.stringify(r.match ?? {}).slice(0, 120)}`);
  const fl = await (await fetch(`${CT}/admin/api/flights?limit=40`, { headers: h })).json().catch(() => ({}));
  console.error('support-triage calls:', JSON.stringify((fl.flights ?? []).filter((x) => x.key_name === 'support-triage').slice(0, 8).map((x) => [x.tool ?? x.model ?? x.target, x.status])));
  const pending = await (await fetch(`${CT}/admin/api/approvals?status=pending`, { headers: h })).json().catch(() => ({}));
  console.error('failure screenshot:', dbg);
  console.error('rules:', JSON.stringify(rules).slice(0, 900));
  console.error('pending approvals:', JSON.stringify(pending).slice(0, 600));
  throw err;
} finally {
  await browser.close();
  srv.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
}
