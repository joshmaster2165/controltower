/**
 * Records the README animation from a real Control Tower: starts the built
 * server with the demo fleet on its own port and data directory, drives the
 * console in headless Chromium (see → monitor → gate → approve), and writes
 * docs/media/controltower-demo.gif.
 *
 *   pnpm build && pnpm demo:gif
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { PNG } from 'pngjs';
import gifenc from 'gifenc';

const { GIFEncoder, quantize, applyPalette } = gifenc;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = path.join(REPO, 'docs/media/controltower-demo.gif');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-demo-gif-'));
const FRAMES = path.join(TMP, 'frames');
const PORT = 4480;
const CT = `http://127.0.0.1:${PORT}`;
const ADMIN = 'demo-gif-admin-key-0123456789abcdef';
const W = 1440, H = 860;
const FPS = 12;
const SCALE = 0.8; // 1152x688: sharp at README width, ~5 MB
fs.mkdirSync(FRAMES);

async function startServer() {
  const p = spawn('node', ['server/dist/server.mjs', '--port', String(PORT)], {
    cwd: REPO,
    env: { ...process.env, CT_DATA_DIR: path.join(TMP, 'data'), CT_DEMO: '1', CT_ADMIN_KEY: ADMIN, CT_UI_DIR: path.join(REPO, 'ui/dist'), CT_LOG_LEVEL: 'warn' },
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
  throw new Error('server did not start — run pnpm build first');
}

async function signIn(page) {
  await page.goto(CT + '/');
  const f = (l) => page.locator('.field', { has: page.locator('label', { hasText: l }) }).first().locator('input').first();
  await f(/^Email or username/).fill('admin');
  await f(/^Password/).fill(ADMIN);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForTimeout(800);
}

/** Screen position of a station on the Airspace canvas (dx/dy in map units from its top-left). */
async function stationAt(page, label, dx = 60, dy = 20) {
  for (let i = 0; i < 50; i++) {
    const pt = await page.evaluate(([l, dx, dy]) => {
      const s = window.__ctScene;
      if (!s) return null;
      const st = [...s.stations.values()].find((x) => x.label === l);
      if (!st) return null;
      const c = s.getCamera(); const r = s.canvas.getBoundingClientRect();
      return [(st.x + dx) * c.k + c.x + r.left, (st.y + dy) * c.k + c.y + r.top, st.w ?? null, st.h ?? null];
    }, [label, dx, dy]);
    if (pt) return pt;
    await page.waitForTimeout(200);
  }
  throw new Error('no station ' + label);
}

/** A captured frame as RGBA, box-downscaled by SCALE. */
function load(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  if (SCALE === 1) return { w: png.width, h: png.height, data: png.data };
  const w = Math.round(png.width * SCALE), h = Math.round(png.height * SCALE);
  const d = new Uint8ClampedArray(w * h * 4);
  const r = 1 / SCALE;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx0 = Math.floor(x * r), sy0 = Math.floor(y * r), sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * r)), sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * r));
    const a = [0, 0, 0];
    let n = 0;
    for (let yy = sy0; yy < sy1; yy++) for (let xx = sx0; xx < sx1; xx++) { const o = (yy * png.width + xx) * 4; a[0] += png.data[o]; a[1] += png.data[o + 1]; a[2] += png.data[o + 2]; n++; }
    const o = (y * w + x) * 4; d[o] = a[0] / n; d[o + 1] = a[1] / n; d[o + 2] = a[2] / n; d[o + 3] = 255;
  }
  return { w, h, data: d };
}

/** GIF at a fixed frame rate with one palette; unchanged pixels are transparent so the file stays small. */
async function encode(frames) {
  const t0 = frames[0].t, t1 = frames.at(-1).t;
  const picks = [];
  for (let t = t0, j = 0; t <= t1; t += 1000 / FPS) {
    while (j + 1 < frames.length && frames[j + 1].t <= t) j++;
    if (picks.at(-1)?.i === j) picks.at(-1).n++;
    else picks.push({ i: j, n: 1 });
  }
  // One palette for the whole clip (sampled across it), with index 255 reserved for "unchanged".
  const samples = [0, 0.25, 0.5, 0.7, 0.85, 1].map((p) => load(frames[picks[Math.min(picks.length - 1, Math.floor(p * (picks.length - 1)))].i].file));
  const { w, h } = samples[0];
  const pool = new Uint8Array(samples.length * w * h * 4);
  samples.forEach((s, k) => pool.set(s.data, k * w * h * 4));
  const palette = quantize(pool, 255, { format: 'rgb565' });
  while (palette.length < 255) palette.push([0, 0, 0]);
  palette.push([255, 0, 255]);
  const TRANSPARENT = 255;

  const gif = GIFEncoder();
  let prev = null;
  for (let k = 0; k < picks.length; k++) {
    const { data } = load(frames[picks[k].i].file);
    const idx = applyPalette(data, palette.slice(0, 255), 'rgb565');
    const outIdx = new Uint8Array(idx.length);
    if (prev) for (let p = 0; p < idx.length; p++) outIdx[p] = idx[p] === prev[p] ? TRANSPARENT : idx[p];
    else outIdx.set(idx);
    prev = idx;
    const delay = Math.round((picks[k].n * 1000) / FPS) + (k === picks.length - 1 ? 1500 : 0);
    gif.writeFrame(outIdx, w, h, k === 0 ? { palette, delay, dispose: 1 } : { delay, transparent: true, transparentIndex: TRANSPARENT, dispose: 1 });
  }
  gif.finish();
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, gif.bytes());
  console.log(path.relative(REPO, OUT_FILE), w + 'x' + h, picks.length, 'frames', (fs.statSync(OUT_FILE).size / 1e6).toFixed(2), 'MB');
}

const srv = await startServer();
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: W, height: H } });

// Presentation layer: a visible cursor with click ripples, a caption card, no toasts.
await page.addInitScript(() => {
  try { localStorage.setItem('ct.sidebar.collapsed', '1'); } catch {}
  addEventListener('DOMContentLoaded', () => {
    const css = document.createElement('style');
    css.textContent = `
      .toasts, .onboarding-pill { display: none !important; }
      #rec-cursor { position: fixed; z-index: 99999; pointer-events: none; width: 22px; height: 22px; left: -40px; top: -40px; transition: transform .08s; }
      #rec-cursor.down { transform: scale(.85); }
      .rec-ripple { position: fixed; z-index: 99998; pointer-events: none; width: 36px; height: 36px; margin: -18px 0 0 -18px; border-radius: 50%; border: 3px solid #1f5eff; animation: rec-rip .6s ease-out forwards; }
      @keyframes rec-rip { from { transform: scale(.3); opacity: .9 } to { transform: scale(1.6); opacity: 0 } }
      #rec-caption { position: fixed; z-index: 99997; left: 92px; bottom: 62px; display: none; align-items: center; gap: 14px;
        background: #0f1b2d; color: #fff; padding: 12px 20px 12px 14px; border-radius: 14px; box-shadow: 0 12px 32px rgba(15,27,45,.28); font: 500 15px/1.35 Inter, system-ui, sans-serif; white-space: nowrap; }
      #rec-caption b { display: block; font-size: 17px; font-weight: 650; }
      #rec-caption span.sub { color: #b9c6da; }
      #rec-caption .n { flex: none; width: 34px; height: 34px; border-radius: 10px; background: #1f5eff; display: grid; place-items: center; font-weight: 700; font-size: 16px; }`;
    document.head.appendChild(css);
    const c = document.createElement('div');
    c.id = 'rec-cursor';
    c.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M4 2l15 11.5-6.6.9 3.9 7.4-3 1.5-3.8-7.4L4 20z" fill="#0f1b2d" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.body.appendChild(c);
    const cap = document.createElement('div');
    cap.id = 'rec-caption';
    document.body.appendChild(cap);
    addEventListener('mousemove', (e) => { c.style.left = e.clientX - 3 + 'px'; c.style.top = e.clientY - 2 + 'px'; }, true);
    addEventListener('mousedown', (e) => {
      c.classList.add('down');
      const r = document.createElement('div'); r.className = 'rec-ripple'; r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px';
      document.body.appendChild(r); setTimeout(() => r.remove(), 700);
    }, true);
    addEventListener('mouseup', () => c.classList.remove('down'), true);
  });
});

const caption = (n, title, sub) =>
  page.evaluate(([n, t, s]) => {
    const el = document.getElementById('rec-caption');
    if (!n) { el.style.display = 'none'; return; }
    el.innerHTML = `<div class="n">${n}</div><div><b>${t}</b><span class="sub">${s}</span></div>`;
    el.style.display = 'flex';
  }, [n, title, sub]);

let cur = [W / 2, H / 2];
async function glide(x, y, ms = 700) {
  const [x0, y0] = cur;
  const steps = Math.max(8, Math.round(ms / 25));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    await page.mouse.move(x0 + (x - x0) * e, y0 + (y - y0) * e);
    await page.waitForTimeout(25);
  }
  cur = [x, y];
}
async function clickAt(x, y, ms) { await glide(x, y, ms); await page.mouse.down(); await page.waitForTimeout(90); await page.mouse.up(); }
async function clickEl(loc, ms) { const bb = await loc.boundingBox(); await clickAt(bb.x + bb.width / 2, bb.y + bb.height / 2, ms); }
const wait = (ms) => page.waitForTimeout(ms);

// ---- recorder ----
let recording = false;
const frames = [];
async function recorder() {
  while (recording) {
    const t = Date.now();
    const buf = await page.screenshot({ type: 'png' });
    const f = `${FRAMES}/${String(frames.length).padStart(4, '0')}.png`;
    fs.writeFileSync(f, buf);
    frames.push({ file: f, t });
  }
}

try {
  await signIn(page);
  await page.goto(CT + '/#/airspace');
  await wait(18000); // let the demo fleet build up traffic
  await page.evaluate(() => window.__ctScene.fit());
  await wait(800);
  await page.mouse.move(cur[0], cur[1]);

  recording = true;
  const rec = recorder();

  // 1 — See
  await caption(1, 'See every agentic flow', 'Agents, models, MCP tool servers and APIs on one live map');
  await wait(3600);

  // 2 — Monitor
  await caption(2, 'Monitor any agent', 'Hover or click to trace where it goes, what it costs and what fails');
  const [ax, ay] = await stationAt(page, 'support-triage');
  await glide(ax, ay, 900);
  await wait(1300);
  await clickAt(ax, ay, 200);
  await wait(2600);
  await page.keyboard.press('Escape');
  await wait(400);

  // 3 — Enforce
  await caption(3, 'Enforce it with a gate', 'Drag from an agent to a tool — block, require approval or inspect');
  await clickEl(page.getByRole('button', { name: 'Add gate' }), 800);
  await wait(500);
  const [sx, sy] = await stationAt(page, 'support-triage');
  const [tx, ty] = await stationAt(page, 'Salesforce', 50, 16);
  await glide(sx, sy, 600);
  await page.mouse.down();
  await glide(tx, ty, 900);
  await page.mouse.up();
  await wait(700);
  const pop = page.locator('.popover').filter({ hasText: 'New gate' });
  const tool = pop.locator('select').nth(2);
  const opt = (await tool.locator('option').allTextContents()).find((o) => o.includes('search_contacts'));
  await clickEl(tool, 500);
  await tool.selectOption({ label: opt });
  await wait(500);
  await clickEl(pop.getByRole('button', { name: 'Require approval', exact: true }), 500);
  await wait(400);
  const addBtn = pop.getByRole('button', { name: 'Add gate', exact: true });
  await addBtn.scrollIntoViewIfNeeded();
  await wait(400);
  await clickEl(addBtn, 600);
  await wait(300);
  await page.getByRole('button', { name: 'Add gate', exact: true }).first().click(); // leave add-gate mode
  await caption(3, 'Enforce it with a gate', 'support-triage → search_contacts now waits for a human');
  await clickEl(page.getByRole('button', { name: /^Approvals/ }), 900);
  const card = page.locator('.tower-drawer .approval').filter({ hasText: 'support-triage' }).first();
  await card.waitFor({ timeout: 20000 });
  await wait(1200);

  // 4 — Manage
  await caption(4, 'Approve in the Tower', 'The call waits at the gate — approve it and the agent carries on');
  const approve = card.getByRole('button', { name: 'Approve', exact: true });
  await wait(500);
  await clickEl(approve, 700);
  await wait(2600);
  await page.keyboard.press('Escape');
  await caption(0);
  await glide(W - 60, H / 2, 500);
  await wait(1800);

  recording = false;
  await rec;
  await encode(frames);
} finally {
  recording = false;
  await b.close();
  srv.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
}
