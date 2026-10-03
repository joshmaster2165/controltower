/**
 * The recording stage: a real Control Tower with the demo fleet, a headless
 * Chromium on top of it with a presentation layer (visible cursor, click
 * ripples, caption card, end card), and a frame recorder that turns what the
 * page shows into an H.264 MP4 through ffmpeg.
 *
 * Shared by every scene in ../scenes.mjs. Needs `pnpm build` (server/dist and
 * ui/dist) and ffmpeg on PATH.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const W = 1600, H = 900, DPR = 1.2; // frames are 1920x1080

const ADMIN = 'social-stage-admin-key-0123456789abcdef';

async function waitFor(url, what) {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${what} did not start at ${url}`);
}

/** Control Tower with the demo fleet, on its own port and data directory. */
export async function startControlTower(tmp, port = 4490) {
  const url = `http://127.0.0.1:${port}`;
  const p = spawn('node', ['server/dist/server.mjs', '--port', String(port)], {
    cwd: REPO,
    env: { ...process.env, CT_DATA_DIR: path.join(tmp, 'ct-data'), CT_DEMO: '1', CT_ADMIN_KEY: ADMIN, CT_UI_DIR: path.join(REPO, 'ui/dist'), CT_LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  await waitFor(`${url}/health/liveliness`, 'Control Tower (run pnpm build first)');
  return { url, stop: () => p.kill() };
}

/** The website and docs (site/, after `pnpm docs:build`), served as they are on agentcontroltower.app. */
export async function startSite(port = 4491) {
  const root = path.join(REPO, 'site');
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.gif': 'image/gif', '.jpg': 'image/jpeg', '.json': 'application/json', '.woff2': 'font/woff2' };
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let f = path.join(root, p);
    if (!f.startsWith(root)) return res.writeHead(403).end();
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
    if (!fs.existsSync(f) && fs.existsSync(f + '.html')) f += '.html';
    if (!fs.existsSync(f)) return res.writeHead(404).end('not found');
    res.writeHead(200, { 'content-type': types[path.extname(f)] ?? 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${port}`, stop: () => srv.close() };
}

// Injected into every page: cursor, ripples, caption card, end card. Hides toasts.
const PRESENTATION = () => {
  try { localStorage.setItem('ct.sidebar.collapsed', '1'); } catch {}
  addEventListener('DOMContentLoaded', () => {
    const css = document.createElement('style');
    css.textContent = `
      .toasts, .onboarding-pill, .onboarding { display: none !important; }
      html { scroll-behavior: auto !important; }
      #rec-cursor { position: fixed; z-index: 2147483000; pointer-events: none; width: 24px; height: 24px; left: -40px; top: -40px; transition: transform .08s; filter: drop-shadow(0 2px 3px rgba(0,0,0,.25)); }
      #rec-cursor.down { transform: scale(.85); }
      .rec-ripple { position: fixed; z-index: 2147482999; pointer-events: none; width: 40px; height: 40px; margin: -20px 0 0 -20px; border-radius: 50%; border: 3px solid #1f5eff; animation: rec-rip .6s ease-out forwards; }
      @keyframes rec-rip { from { transform: scale(.3); opacity: .9 } to { transform: scale(1.7); opacity: 0 } }
      #rec-caption { position: fixed; z-index: 2147482998; pointer-events: none; left: 50%; bottom: 44px; display: none; align-items: center; gap: 14px; transform: translateX(-50%);
        background: rgba(10,18,34,.94); color: #fff; padding: 14px 24px 14px 16px; border-radius: 16px; box-shadow: 0 16px 40px rgba(10,18,34,.35), 0 0 0 1px rgba(255,255,255,.06) inset;
        font: 500 16px/1.35 Geist, Inter, system-ui, sans-serif; white-space: nowrap; animation: rec-in .45s cubic-bezier(.22,1,.36,1); }
      @keyframes rec-in { from { opacity: 0; transform: translate(-50%, 12px) } to { opacity: 1; transform: translate(-50%, 0) } }
      #rec-caption b { display: block; font-size: 19px; font-weight: 650; letter-spacing: -.01em; }
      #rec-caption span.sub { color: #b9c6da; }
      #rec-caption .n { flex: none; width: 38px; height: 38px; border-radius: 11px; background: linear-gradient(#3a72ff,#1f5eff); display: grid; place-items: center; font-weight: 700; font-size: 17px; }
      #rec-end { position: fixed; inset: 0; z-index: 2147483001; display: none; place-items: center; background: radial-gradient(1200px 700px at 50% 40%, #16306b 0%, #0a1222 70%); color: #fff; font-family: Geist, Inter, system-ui, sans-serif; animation: rec-fade .5s ease both; }
      @keyframes rec-fade { from { opacity: 0 } to { opacity: 1 } }
      #rec-end .box { text-align: center; }
      #rec-end img { width: 88px; height: 88px; filter: drop-shadow(0 10px 30px rgba(31,94,255,.5)); }
      #rec-end h1 { font-size: 64px; letter-spacing: -.03em; margin: 22px 0 8px; font-weight: 700; }
      #rec-end p { font-size: 24px; color: #b9c6da; margin: 0 0 34px; }
      #rec-end .row { display: inline-flex; gap: 14px; }
      #rec-end .rec-pill { font: 500 22px/1 'Geist Mono', ui-monospace, monospace; padding: 16px 22px; border-radius: 14px; background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.14); }
      #rec-end .rec-pill.rec-star { background: linear-gradient(#3a72ff,#1f5eff); border-color: #4b7dff; box-shadow: 0 10px 30px rgba(31,94,255,.45); }`;
    document.head.appendChild(css);
    const c = document.createElement('div');
    c.id = 'rec-cursor';
    c.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M4 2l15 11.5-6.6.9 3.9 7.4-3 1.5-3.8-7.4L4 20z" fill="#0f1b2d" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
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
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * A browser on the stage. `rec` records frames between start() and stop();
 * helpers move a visible cursor and show captions so clips read without sound.
 */
export async function openStage({ ct, site, tmp }) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
  await context.addInitScript(PRESENTATION);
  const page = await context.newPage();
  const framesDir = path.join(tmp, 'frames');
  let cur = [W / 2, H / 2];

  const s = {
    page, ct, site, browser,
    wait: (ms) => page.waitForTimeout(ms),

    async signIn() {
      await page.goto(ct.url + '/');
      const f = (l) => page.locator('.field', { has: page.locator('label', { hasText: l }) }).first().locator('input').first();
      await f(/^Email or username/).fill('admin');
      await f(/^Password/).fill(ADMIN);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.getByRole('link', { name: 'Airspace' }).first().waitFor({ timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(600);
    },

    /** Console route, e.g. 'airspace', 'ledger', 'flights'. */
    async go(route) {
      await page.goto(`${ct.url}/#/${route}`);
      await page.waitForTimeout(1200);
      await page.mouse.move(cur[0], cur[1]);
    },

    async caption(n, title, sub = '') {
      await page.evaluate(([n, t, s]) => {
        const el = document.getElementById('rec-caption');
        if (!el) return;
        if (!t) { el.style.display = 'none'; return; }
        el.innerHTML = (n ? `<div class="n">${n}</div>` : '') + `<div><b>${t}</b>${s ? `<span class="sub">${s}</span>` : ''}</div>`;
        el.style.display = 'none'; void el.offsetWidth; el.style.display = 'flex';
      }, [n, esc(title), esc(sub)]);
    },

    /** Full-screen closing card; with `contact` (an email or URL) that becomes the main button instead of the GitHub star. */
    async endCard(headline = 'Control Tower', sub = 'See every agent. Gate every call. Open source.', contact = null) {
      await page.evaluate(([h, s, logo, contact]) => {
        let el = document.getElementById('rec-end');
        if (!el) { el = document.createElement('div'); el.id = 'rec-end'; document.body.appendChild(el); }
        el.innerHTML = `<div class="box"><img src="${logo}"><h1>${h}</h1><p>${s}</p><div class="row">${contact ? `<span class="rec-pill rec-star">✉ ${contact}</span><span class="rec-pill">★ github.com/joshmaster2165/controltower</span>` : '<span class="rec-pill rec-star">★ Star on GitHub</span><span class="rec-pill">github.com/joshmaster2165/controltower</span>'}</div></div>`;
        el.style.display = 'grid';
      }, [esc(headline), esc(sub), 'data:image/svg+xml;base64,' + fs.readFileSync(path.join(REPO, 'ui/public/logo.svg')).toString('base64'), contact && esc(contact)]);
    },

    async glide(x, y, ms = 700) {
      const [x0, y0] = cur;
      const steps = Math.max(8, Math.round(ms / 25));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps, e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
        await page.mouse.move(x0 + (x - x0) * e, y0 + (y - y0) * e);
        await page.waitForTimeout(25);
      }
      cur = [x, y];
    },
    async clickAt(x, y, ms) { await s.glide(x, y, ms); await page.mouse.down(); await page.waitForTimeout(90); await page.mouse.up(); },
    /** Glide the visible cursor to the element, then click it (Playwright's click, so it lands even if the layout shifted). */
    async clickEl(loc, ms) {
      await loc.scrollIntoViewIfNeeded();
      const bb = await loc.boundingBox();
      await s.glide(bb.x + bb.width / 2, bb.y + bb.height / 2, ms);
      await loc.click();
    },
    async hoverEl(loc, ms) { await loc.scrollIntoViewIfNeeded(); const bb = await loc.boundingBox(); await s.glide(bb.x + bb.width / 2, bb.y + bb.height / 2, ms); },

    /** Smooth scroll of the page (or of the first scrollable main pane) by dy pixels over ms. */
    async scroll(dy, ms = 2000) {
      const steps = Math.max(10, Math.round(ms / 30));
      let done = 0;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps, e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
        const target = Math.round(dy * e);
        await page.mouse.wheel(0, target - done);
        done = target;
        await page.waitForTimeout(30);
      }
    },

    /** Screen position of an Airspace station (dx/dy in map units from its top-left). */
    async stationAt(label, dx = 60, dy = 20) {
      for (let i = 0; i < 60; i++) {
        const pt = await page.evaluate(([l, dx, dy]) => {
          const sc = window.__ctScene;
          if (!sc) return null;
          const st = [...sc.stations.values()].find((x) => x.label === l);
          if (!st) return null;
          const c = sc.getCamera(); const r = sc.canvas.getBoundingClientRect();
          return [(st.x + dx) * c.k + c.x + r.left, (st.y + dy) * c.k + c.y + r.top];
        }, [label, dx, dy]);
        if (pt) return pt;
        await page.waitForTimeout(200);
      }
      throw new Error('no station ' + label);
    },

    async fitMap() { await page.evaluate(() => window.__ctScene?.fit()); await page.waitForTimeout(500); },

    /** A still of the current page (for cards), at full 1920x1080. */
    async still(file) { await page.screenshot({ path: file, type: 'png' }); },

    rec: {
      frames: [],
      on: false,
      loop: null,
      start() {
        fs.rmSync(framesDir, { recursive: true, force: true });
        fs.mkdirSync(framesDir, { recursive: true });
        this.frames = [];
        this.on = true;
        this.loop = (async () => {
          while (this.on) {
            const t = Date.now();
            const f = path.join(framesDir, `${String(this.frames.length).padStart(5, '0')}.jpg`);
            try {
              fs.writeFileSync(f, await page.screenshot({ type: 'jpeg', quality: 92 }));
              this.frames.push({ file: f, t });
            } catch {
              /* page navigating */
            }
          }
        })();
      },
      async stop(out) {
        this.on = false;
        await this.loop;
        encodeFrames(this.frames, out);
      },
    },

    async close() { await browser.close(); },
  };
  return s;
}

/** Variable-rate frames → constant 30 fps H.264, each frame held for as long as it was on screen. */
export function encodeFrames(frames, out) {
  if (frames.length < 2) throw new Error('nothing recorded');
  const list = path.join(path.dirname(frames[0].file), 'frames.txt');
  const lines = [];
  for (let i = 0; i < frames.length; i++) {
    const d = i + 1 < frames.length ? (frames[i + 1].t - frames[i].t) / 1000 : 1.5;
    lines.push(`file '${frames[i].file}'`, `duration ${Math.max(0.02, d).toFixed(3)}`);
  }
  lines.push(`file '${frames.at(-1).file}'`);
  fs.writeFileSync(list, lines.join('\n'));
  ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-vf', 'fps=30,scale=1920:1080:flags=lanczos,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-movflags', '+faststart', out]);
}

export function ffmpeg(args) {
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
}

export function duration(file) {
  return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim());
}
