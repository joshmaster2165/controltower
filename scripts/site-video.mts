/**
 * The website's product video: one continuous take of a real, deployed Control Tower (the showcase on Railway, with
 * the demo fleet sending real traffic through it), recorded in headless Chromium and encoded to 1080p H.264.
 *
 *   SHOWCASE_URL=https://… SHOWCASE_KEY=… npx tsx scripts/site-video.mts
 *
 * Writes site/media/controltower-tour.mp4 and its poster. Frames come from the browser's own screencast (every
 * change, not a screenshot loop), so motion is smooth. Gates the take adds are removed afterwards.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO, openStage, encodeFrames, ffmpeg, duration } from '../marketing/lib/stage.mjs';

const URL_ = (process.env.SHOWCASE_URL ?? 'https://showcase-production-b625.up.railway.app').replace(/\/+$/, '');
const KEY = process.env.SHOWCASE_KEY ?? fs.readFileSync(path.join(REPO, 'data/railway-test/showcase-admin-key.txt'), 'utf8').trim();
const OUT = path.join(REPO, 'site/media/controltower-tour.mp4');
const POSTER = path.join(REPO, 'site/media/controltower-tour.jpg');
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
const field = (l: RegExp) => page.locator('.field', { has: page.locator('label', { hasText: l }) }).first().locator('input').first();
await field(/^Email or username/).fill('admin');
await field(/^Password/).fill(KEY);
await page.getByRole('button', { name: 'Sign in' }).click();
await page.getByRole('link', { name: 'Airspace' }).first().waitFor({ timeout: 20000 }).catch(() => {});
await s.go('airspace');
await s.wait(12000);
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
  await s.caption(null, 'Every AI agent and coding assistant, on one live map', 'Claude Code, Codex, Copilot and your own agents, through a gateway you run');
  await s.wait(4500);
  for (const a of ['support-triage', 'pr-reviewer', 'outbound-sdr']) {
    const [x, y] = await s.stationAt(a);
    await s.glide(x, y, 800);
    await s.wait(700);
  }

  // 2. Trace an agent
  await s.caption(1, 'See what each agent can reach', 'Click an agent: every model, tool and API it uses lights up');
  {
    const [x, y] = await s.stationAt('support-triage');
    await s.clickAt(x, y, 700);
    await s.wait(4500);
    await page.keyboard.press('Escape');
    await s.wait(600);
  }

  // 3. A gate, and 4. a person approves
  await s.caption(2, 'Least privilege, drawn on the map', 'Drag from an agent to a tool: block it, inspect it, or require approval');
  await s.clickEl(page.getByRole('button', { name: 'Add gate' }), 700);
  await s.wait(400);
  {
    const [sx, sy] = await s.stationAt('support-triage');
    const [tx, ty] = await s.stationAt('Salesforce', 50, 16);
    await s.glide(sx, sy, 600);
    await page.mouse.down();
    await s.glide(tx, ty, 1000);
    await page.mouse.up();
  }
  await s.wait(700);
  const pop = page.locator('.popover').filter({ hasText: 'New gate' });
  const tool = pop.locator('select').filter({ has: page.locator('option', { hasText: 'search_contacts' }) }).first();
  const opt = (await tool.locator('option').allTextContents()).find((x) => x.includes('search_contacts'));
  await s.hoverEl(tool, 500);
  if (opt) await tool.selectOption({ label: opt });
  await s.wait(500);
  await s.clickEl(pop.getByRole('button', { name: 'Require approval', exact: true }), 500);
  await s.wait(700);
  await s.clickEl(pop.getByRole('button', { name: 'Add gate', exact: true }), 600);
  await s.wait(300);
  await page.getByRole('button', { name: 'Add gate', exact: true }).first().click().catch(() => {});
  await s.caption(3, 'Human oversight, before it happens', 'The next call waits at the gate for a person: not a log line after the fact');
  await s.clickEl(page.getByRole('button', { name: /^Approvals/ }), 900);
  const card = page.locator('.tower-drawer .approval').filter({ hasText: 'support-triage' }).first();
  await card.waitFor({ timeout: 40000 });
  await s.wait(2200);
  await s.caption(3, 'Approve it in the Tower', 'Who asked, from which agent, for what, and who said yes: all on record');
  await s.clickEl(card.getByRole('button', { name: 'Approve', exact: true }), 800).catch(() => {});
  await s.wait(2600);
  await page.keyboard.press('Escape');

  // 5. Flights
  await s.caption(null);
  await s.go('flights');
  await s.caption(4, 'Every call on the record', 'Who made it, which agent, which model or tool, what each gate decided, and the cost');
  await s.wait(3500);
  await s.glide(800, 420, 700);
  await s.scroll(450, 2600);
  await s.wait(1500);

  // 6. Guardrails
  await s.caption(null);
  await s.go('guardrails');
  await s.caption(5, 'Secrets and personal data stop at the gateway', 'Built-in detectors, your own guardrails, and services like Presidio and Lakera');
  await s.wait(3200);
  await s.glide(800, 500, 700);
  await s.scroll(600, 3000);
  await s.wait(1500);

  // 7. Laptops
  await s.caption(null);
  await s.go('laptops');
  await s.caption(6, 'Coding assistants on every laptop, signed in as the person', 'Claude Code, Claude Desktop, Codex and Copilot CLI, rolled out with Jamf or Intune');
  await s.wait(3000);
  await s.glide(800, 500, 700);
  await s.scroll(900, 3500);
  await s.wait(1800);

  // 8. Inventory
  await s.caption(null);
  await s.go('report');
  await s.caption(7, 'An AI inventory that keeps itself current', 'Every agent, its owner, what it reaches and the gates on the way: CSV, Markdown or PDF');
  await s.wait(3000);
  await s.glide(800, 500, 700);
  await s.scroll(800, 3500);
  await s.wait(1500);

  // 9. Audit log
  await s.caption(null);
  await s.go('audit');
  await s.caption(8, 'A tamper-evident audit log', 'Every change and refusal, hash-chained, and sent to your SIEM');
  await s.wait(2500);
  await s.clickEl(page.getByRole('button', { name: 'Verify' }), 800).catch(() => {});
  await s.wait(3200);

  // 10. Compliance
  await s.caption(null);
  await s.go('compliance');
  await page.getByRole('cell', { name: 'Art. 12' }).waitFor({ timeout: 20000 });
  await s.caption(9, 'Evidence for the EU AI Act, NIST AI RMF and ISO/IEC 42001', 'Each requirement checked against your own records, with what to do next');
  await s.wait(3500);
  await s.clickEl(page.getByRole('cell', { name: 'Art. 14' }), 800);
  await s.wait(3500);
  await s.clickEl(page.getByRole('radio', { name: 'ISO/IEC 42001' }), 800);
  await page.getByRole('cell', { name: 'A.6.2.8' }).waitFor({ timeout: 20000 });
  await s.wait(2500);
  await s.caption(9, 'Hand your assessor the evidence pack', 'The register and the records behind it, its checksum in the audit log');
  await s.hoverEl(page.getByRole('link', { name: 'Evidence pack' }), 900);
  await s.wait(3200);

  // The end
  await s.caption(null);
  await s.endCard('Control Tower', 'See every agent. Gate every call. Prove it.', 'agentcontroltower.app');
  await s.wait(4000);
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
