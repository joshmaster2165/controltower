/**
 * A short video of the Airspace (about 50 s), for social posts: the live map of agents, tracing one, the matrix, trust
 * classes with an exfiltration risk and its one-click fix, and coverage by team. One continuous take of the showcase
 * (the demo fleet sending real traffic), recorded like the website's tour.
 *
 *   npx tsx scripts/airspace-video.mts            → data/brand/airspace-map.mp4 (+ .jpg poster)
 *
 * Gates the take adds are removed afterwards.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO, openStage, encodeFrames, ffmpeg, duration } from '../marketing/lib/stage.mjs';

const URL_ = (process.env.SHOWCASE_URL ?? 'https://showcase-production-b625.up.railway.app').replace(/\/+$/, '');
const KEY = process.env.SHOWCASE_KEY ?? fs.readFileSync(path.join(REPO, 'data/railway-test/showcase-admin-key.txt'), 'utf8').trim();
const OUT = path.join(REPO, 'data/brand/airspace-map.mp4');
const POSTER = path.join(REPO, 'data/brand/airspace-map.jpg');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-tour-'));
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const api = (method: string, p: string, body?: unknown) =>
  fetch(URL_ + p, { method, headers: { authorization: `Bearer ${KEY}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }).then((r) => r.json() as Promise<any>);

const s = await openStage({ ct: { url: URL_ }, site: null, tmp: TMP });
const { page } = s;
// For the take: no demo-data notice on Compliance (it's for people using the page as evidence).
await page.context().addInitScript(() => {
  addEventListener('DOMContentLoaded', () => {
    const css = document.createElement('style');
    css.textContent = '.compliance .notice-row { display: none !important; }';
    document.head.appendChild(css);
  });
});
const rulesBefore = new Set(((await api('GET', '/admin/api/policy')).rules ?? []).map((r: { id: string }) => r.id));

// ---- Sign in with the admin key, and let the map fill ----
await page.goto(URL_ + '/');
await page.evaluate(() => localStorage.setItem('ct.airspace.mode', 'map'));
const field = (l: RegExp) => page.locator('.field', { has: page.locator('label', { hasText: l }) }).first().locator('input').first();
await field(/^Email or username/).fill('admin');
await field(/^Password/).fill(KEY);
await page.getByRole('button', { name: 'Sign in' }).click();
await page.getByRole('link', { name: 'Airspace' }).first().waitFor({ timeout: 20000 }).catch(() => {});
await s.go('airspace');
await s.wait(12000);
// What's in use now: active agents and destinations (idle ones would only crowd the map).
await page.locator('#ct-agent-filter').selectOption('recent');
await s.wait(1500);
await s.fitMap();

// ---- Recording: the browser's screencast, every frame it paints ----
const framesDir = path.join(TMP, 'frames');
fs.mkdirSync(framesDir, { recursive: true });
const frames: Array<{ file: string; t: number }> = [];
const cdp = await page.context().newCDPSession(page);
cdp.on('Page.screencastFrame', async (f: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
  const file = path.join(framesDir, `${String(frames.length).padStart(6, '0')}.jpg`);
  fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
  frames.push({ file, t: Date.now() });
  await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
});
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
log('recording');

try {
  // 1. The map
  await s.caption(null, 'Every AI agent and coding assistant, on one live map', 'Agents, models, MCP tools and APIs: the traffic between them, live');
  await s.wait(4000);
  for (const a of ['support-triage', 'pr-reviewer', 'outbound-sdr']) {
    const [x, y] = await s.stationAt(a);
    await s.glide(x, y, 700);
    await s.wait(500);
  }

  // 2. Trace one
  await s.caption(null, 'Click an agent: see everything it reaches', 'Every model, tool and API it uses, how often, and what it costs');
  {
    const [x, y] = await s.stationAt('support-triage');
    await s.clickAt(x, y, 600);
    await s.wait(4000);
    await page.keyboard.press('Escape');
    await s.wait(500);
  }

  // 3. The matrix
  await s.caption(null, 'Every agent against every destination', 'The connections in use that no gate can stop, at a glance');
  await s.clickEl(page.getByRole('radio', { name: 'Matrix' }), 700);
  await s.wait(3500);

  // 4. Trust classes and exfiltration risk
  await s.clickEl(page.getByRole('radio', { name: 'Classes' }), 700);
  await page.locator('g.agent').first().waitFor({ timeout: 20000 });
  await s.caption(null, 'How deep each agent reaches, and where data could leave', 'Production and customer data inside; vendors and the public internet outside');
  await s.wait(3500);
  const risk = page.locator('.risk.high').first();
  if (await risk.count()) {
    await s.caption(null, 'Customer data in reach, and a way out with nothing on it', 'An exfiltration risk: the path lights up');
    await s.clickEl(risk.locator('.risk-head'), 800);
    await s.wait(3500);
    await s.caption(null, 'One click puts a gate on exactly that path', 'Personal data and secrets are masked before they leave');
    await s.clickEl(risk.locator('.fix'), 800);
    await page.locator('.rail-note').waitFor({ timeout: 10000 }).catch(() => {});
    await s.wait(1200);
    await s.caption(null, 'Checked: the gate stands on the way out', 'The risk drops from High to Checked, and the gate is on the map');
    await s.wait(3500);
  }

  // 5. Coverage
  await s.clickEl(page.getByRole('radio', { name: 'Coverage' }), 700);
  await page.locator('g.team').first().waitFor({ timeout: 20000 });
  await s.caption(null, 'How much of each team\'s AI traffic is governed', 'Gated, through the gateway with no gate, or around it');
  await s.wait(2500);
  await s.clickEl(page.locator('g.team', { hasText: 'engineering' }).first(), 800);
  await s.wait(3500);

  // Back to the map, and the end
  await s.clickEl(page.getByRole('radio', { name: 'Map' }), 700);
  await s.caption(null, 'Open source. Self-hosted. Your data stays with you.', 'Claude Code, Codex, Copilot and your own agents, through a gateway you run');
  await s.wait(3500);
  await s.caption(null);
  await s.endCard('Control Tower', 'See every agent. Gate every call. Open source.');
  await s.wait(3500);
} finally {
  await cdp.send('Page.stopScreencast').catch(() => {});
  // The browser sends a frame only when something changes: the last one is held until the take ends.
  if (frames.length) frames.push({ file: frames.at(-1)!.file, t: Date.now() });
  log(`${frames.length} frames`);
  // Leave the showcase as it was: the gates this take added go.
  for (const r of (await api('GET', '/admin/api/policy')).rules ?? []) if (!rulesBefore.has(r.id)) await api('DELETE', `/admin/api/rules/${r.id}`);
  await s.close();
}

// Variable-rate frames → 30 fps, then the web file: 1080p, H.264, quick to start.
const raw = path.join(TMP, 'raw.mp4');
encodeFrames(frames, raw);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
ffmpeg(['-i', raw, '-c:v', 'libx264', '-preset', 'slow', '-crf', '22', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', OUT]);
ffmpeg(['-ss', '6', '-i', OUT, '-frames:v', '1', '-q:v', '3', POSTER]);
log(`${OUT}: ${duration(OUT).toFixed(1)} s, ${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB`);
