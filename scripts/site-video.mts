/**
 * The website's product video: one continuous take of a real, deployed Control Tower (the showcase on Railway, with
 * the demo fleet sending real traffic through it), recorded in headless Chromium and encoded to 1080p H.264.
 *
 *   SHOWCASE_URL=https://… SHOWCASE_KEY=… npx tsx scripts/site-video.mts
 *
 * Narrated (marketing/lib/narration.mjs: CT_TTS_KEY or CT_TTS_KEY_FILE for a Control Tower with a speech model).
 * Writes site/media/controltower-tour.mp4 and its poster. Frames come from the browser's own screencast (every
 * change, not a screenshot loop), so motion is smooth. Gates the take adds are removed afterwards.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO, openStage, encodeFrames, ffmpeg, duration } from '../marketing/lib/stage.mjs';
import { mixNarration, narrator } from '../marketing/lib/narration.mjs';

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

// ---- The voice-over, generated before the take so each scene can wait for its line ----
const n = narrator({ dir: path.join(REPO, 'data/brand/narration/tour') });
const lines = await n.prepare({
  map: 'This is Control Tower: every AI agent and coding assistant in your company, on one live map.',
  trace: 'Click an agent to see everything it touches, how often, and what it costs.',
  gate: 'Least privilege is drawn on the map. Drag from an agent to a tool: block it, inspect it, or require approval.',
  hold: 'Now its next call waits at the gate for a person, before it happens.',
  approve: "Approve it in the Tower, and it's on the record: who asked, and who said yes.",
  classes: 'Trust classes flag agents that could send customer data outside the company.',
  reach: 'Reach shows what an agent may touch, against what it actually uses. One click trims its key to just that.',
  flights: 'Every call is on the record, with what each gate decided and what it cost.',
  guardrails: 'Secrets and personal data stop at the gateway.',
  laptops: 'Roll it out to every laptop with Jamf or Intune: Claude Code, Codex and Copilot sign in as the person.',
  inventory: 'The AI inventory keeps itself current.',
  audit: 'Every change lands in a tamper-evident audit log, sent to your SIEM.',
  compliance: 'And each requirement of the EU AI Act, NIST AI RMF and ISO 42001 is checked against your own records, with an evidence pack for your assessor.',
  end: 'Control Tower. See every agent. Gate every call. Prove it.',
});
log(`narration: ${Object.values(lines).reduce((a, b) => a + b, 0) / 1000} s of speech`);

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
  const say = async (id: string, title: string | null, sub = '') => {
    if (title) await s.caption(null, title, sub);
    n.say(id);
  };

  // 1. The map
  await say('map', 'Every AI agent and coding assistant, on one live map', 'Claude Code, Codex, Copilot and your own agents, through a gateway you run');
  await s.wait(2500);
  for (const a of ['support-triage', 'pr-reviewer', 'outbound-sdr']) {
    const [x, y] = await s.stationAt(a);
    await s.glide(x, y, 800);
    await s.wait(500);
  }
  await n.done();

  // 2. Trace an agent
  await say('trace', 'See what each agent can reach', 'Click an agent: every model, tool and API it uses lights up');
  {
    const [x, y] = await s.stationAt('support-triage');
    await s.clickAt(x, y, 700);
    await n.done();
    await page.keyboard.press('Escape');
    await s.wait(400);
  }

  // 3. A gate, and 4. a person approves
  await say('gate', 'Least privilege, drawn on the map', 'Drag from an agent to a tool: block it, inspect it, or require approval');
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
  await n.done(150);
  await say('hold', 'Human oversight, before it happens', 'The next call waits at the gate for a person: not a log line after the fact');
  await s.clickEl(page.getByRole('button', { name: /^Approvals/ }), 900);
  const card = page.locator('.tower-drawer .approval').filter({ hasText: 'support-triage' }).first();
  await card.waitFor({ timeout: 40000 });
  await n.done(150);
  await say('approve', 'Approve it in the Tower', 'Who asked, from which agent, for what, and who said yes: all on record');
  await s.clickEl(card.getByRole('button', { name: 'Approve', exact: true }), 800).catch(() => {});
  await n.done();
  // Close the drawer (the views after this have panels where it sits).
  await s.clickEl(page.getByRole('button', { name: /^Approvals/ }), 500);
  await s.wait(400);

  // 5. Trust classes: where data could leave
  await s.clickEl(page.getByRole('radio', { name: 'Classes' }), 700);
  await page.locator('g.agent').first().waitFor({ timeout: 20000 });
  await say('classes', 'Where customer data could leave', 'Each agent against trust classes, from production out to the public internet');
  const risk = page.locator('.risk.high, .risk.critical').first();
  if (await risk.count()) {
    await s.wait(1800);
    await s.clickEl(risk.locator('.risk-head'), 800);
  }
  await n.done();

  // 6. Reach: least privilege, from its own traffic
  await s.clickEl(page.getByRole('radio', { name: 'Reach' }), 700);
  await s.caption(null, 'What it may reach, against what it uses', 'Unused permissions as ghosts, and one click trims the key to what it uses');
  {
    // The agent with the most unused permissions (finance-reconciler on the showcase: also the High risk above).
    const picker = page.getByRole('region', { name: 'Reach' }).getByLabel('Agent', { exact: true });
    await page.waitForFunction(() => [...document.querySelectorAll('.reach select option')].some((o) => o.textContent?.startsWith('finance-reconciler')), null, { timeout: 15000 }).catch(() => {});
    const value = await picker.evaluate((el) => [...(el as HTMLSelectElement).options].find((o) => o.textContent?.startsWith('finance-reconciler'))?.value ?? '');
    if (value) {
      await picker.selectOption(value);
      await page.locator('.reach-agent-name', { hasText: 'finance-reconcil' }).waitFor({ timeout: 15000 }).catch(() => {});
    }
  }
  await page.locator('.reach-node').first().waitFor({ timeout: 20000 }).catch(() => {});
  await say('reach', null);
  await s.wait(1600);
  await s.hoverEl(page.getByRole('button', { name: /Trim to what it uses/ }), 900).catch(() => {});
  await n.done();
  await s.clickEl(page.getByRole('radio', { name: 'Map' }), 600);

  // 7. Flights
  await s.caption(null);
  await s.go('flights');
  await say('flights', 'Every call on the record', 'Who made it, which agent, which model or tool, what each gate decided, and the cost');
  await s.wait(800);
  await s.glide(800, 420, 600);
  await s.scroll(450, 1800);
  await n.done();

  // 8. Guardrails
  await s.caption(null);
  await s.go('guardrails');
  await say('guardrails', 'Secrets and personal data stop at the gateway', 'Built-in detectors, your own guardrails, and services like Presidio and Lakera');
  await s.wait(800);
  await s.glide(800, 500, 600);
  await s.scroll(600, 1800);
  await n.done();

  // 9. Laptops
  await s.caption(null);
  await s.go('laptops');
  await say('laptops', 'Coding assistants on every laptop, signed in as the person', 'Claude Code, Claude Desktop, Codex and Copilot CLI, rolled out with Jamf or Intune');
  await s.wait(800);
  await s.glide(800, 500, 600);
  await s.scroll(900, 2400);
  await n.done();

  // 10. Inventory
  await s.caption(null);
  await s.go('report');
  await say('inventory', 'An AI inventory that keeps itself current', 'Every agent, its owner, what it reaches and the gates on the way: CSV, Markdown or PDF');
  await s.wait(600);
  await s.glide(800, 500, 600);
  await s.scroll(800, 1800);
  await n.done();

  // 11. Audit log
  await s.caption(null);
  await s.go('audit');
  await say('audit', 'A tamper-evident audit log', 'Every change and refusal, hash-chained, and sent to your SIEM');
  await s.wait(1200);
  await s.clickEl(page.getByRole('button', { name: 'Verify' }), 800).catch(() => {});
  await n.done();

  // 12. Compliance
  await s.caption(null);
  await s.go('compliance');
  await page.getByRole('cell', { name: 'Art. 12' }).waitFor({ timeout: 20000 });
  await say('compliance', 'Evidence for the EU AI Act, NIST AI RMF and ISO/IEC 42001', 'Each requirement checked against your own records, and an evidence pack for your assessor');
  await s.wait(1200);
  await s.clickEl(page.getByRole('cell', { name: 'Art. 14' }), 700);
  await s.wait(1200);
  await s.clickEl(page.getByRole('radio', { name: 'ISO/IEC 42001' }), 700);
  await page.getByRole('cell', { name: 'A.6.2.8' }).waitFor({ timeout: 20000 });
  await s.hoverEl(page.getByRole('link', { name: 'Evidence pack' }), 800);
  await n.done();

  // The end
  await s.caption(null);
  await s.endCard('Control Tower', 'See every agent. Gate every call. Prove it.', 'agentcontroltower.app');
  n.say('end');
  await n.done(1200);
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
const silent = path.join(TMP, 'silent.mp4');
ffmpeg(['-i', raw, '-c:v', 'libx264', '-preset', 'slow', '-crf', '22', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', silent]);
mixNarration(silent, n.cues, frames[0]!.t, OUT);
ffmpeg(['-ss', '6', '-i', OUT, '-frames:v', '1', '-q:v', '3', POSTER]);
log(`${OUT}: ${duration(OUT).toFixed(1)} s, ${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB`);
