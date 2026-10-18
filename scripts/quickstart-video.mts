/**
 * The docs' quick-start video (Getting started): a fresh install, from the first page to an agent on the map, narrated.
 * A real Control Tower started here with nothing in it, and a local stand-in where Ollama would be.
 *
 *   pnpm build && CT_TTS_KEY_FILE=… npx tsx scripts/quickstart-video.mts
 * Writes site/media/quickstart.mp4 and its poster.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO, openStage, encodeFrames, ffmpeg, duration } from '../marketing/lib/stage.mjs';
import { mixNarration, narrator } from '../marketing/lib/narration.mjs';
import { openAiUpstream } from '../e2e/support/upstreams.ts';

const OUT = path.join(REPO, 'site/media/quickstart.mp4');
const POSTER = path.join(REPO, 'site/media/quickstart.jpg');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-quickstart-'));
const PORT = 4497;
const URL_ = `http://localhost:${PORT}`;
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

// A local model server where Ollama would be, and a Control Tower with nothing in it.
const ollama = await openAiUpstream({ port: 11434, models: ['llama3.2', 'qwen2.5:7b'], reply: 'Hello from your own machine, through Control Tower.' });
const ct = spawn('node', ['server/dist/server.mjs', '--port', String(PORT)], {
  cwd: REPO,
  env: { ...process.env, CT_DATA_DIR: path.join(TMP, 'data'), CT_UI_DIR: path.join(REPO, 'ui/dist'), CT_LOG_LEVEL: 'warn', CT_DEMO: '0', CT_SETUP_TOKEN: 'K7QF-2M9X', CT_UPDATE_CHECK: 'off' },
  stdio: ['ignore', 'ignore', 'inherit'],
});
for (let i = 0; !(await fetch(`${URL_}/healthz`).catch(() => null))?.ok; i++) {
  if (i > 150) throw new Error('Control Tower did not start (pnpm build first)');
  await new Promise((r) => setTimeout(r, 200));
}

const n = narrator({ dir: path.join(REPO, 'data/brand/narration/quickstart') });
await n.prepare({
  install: 'Getting started takes about five minutes. Run Control Tower with one Docker command, keeping its data on a volume, then open it on port four thousand.',
  admin: 'On first start it prints a one-time setup code in its log. Enter it, create the first admin, and you land on Get started.',
  provider: 'Next, connect a model provider. Pick it from the catalog and add its key, or its address. Here, a local Ollama. Control Tower tests the connection right away.',
  key: "Then give each agent its own key, with a team and a budget. The key is shown once, together with exactly what to set in Claude Code, Codex, or your own code.",
  first: 'Point the agent at Control Tower and send its first request. The panel turns green the moment it arrives.',
  map: 'And there it is on the map: your agent, the model it used, and the call between them. From here, put a gate on a path, roll it out to laptops, or connect your tools. The docs walk through each step.',
  end: 'Control Tower. Read the docs at agent control tower dot app.',
});

const s = await openStage({ ct: { url: URL_ }, site: null, tmp: TMP });
const { page } = s;
const field = (l: RegExp) => page.locator('.field', { has: page.locator('label', { hasText: l }) }).first().locator('input, select, textarea').first();
/** Type into a field the way a person does: visibly, a key at a time. */
const type = async (l: RegExp, text: string) => {
  const f = field(l);
  await s.clickEl(f, 500);
  await f.pressSequentially(text, { delay: 35 });
};
/** A terminal card over the page, showing a command (what you'd run before the console exists). */
const terminal = (cmd: string | null) =>
  page.evaluate((c) => {
    let el = document.getElementById('rec-term');
    if (!c) return el?.remove();
    if (!el) {
      el = document.createElement('div');
      el.id = 'rec-term';
      el.style.cssText = 'position:fixed;left:50%;top:38%;transform:translate(-50%,-50%);z-index:99998;width:880px;background:#0b1220;color:#d6e2ff;border-radius:14px;box-shadow:0 30px 80px rgba(8,15,30,.45);font:15px/1.6 "JetBrains Mono",ui-monospace,Menlo,monospace;overflow:hidden';
      document.body.appendChild(el);
    }
    el.innerHTML = `<div style="padding:10px 14px;background:#141d31;display:flex;gap:7px"><i style="width:11px;height:11px;border-radius:50%;background:#ff5f57"></i><i style="width:11px;height:11px;border-radius:50%;background:#febc2e"></i><i style="width:11px;height:11px;border-radius:50%;background:#28c840"></i></div><div style="padding:18px 22px"><span style="color:#7dd3a8">$</span> ${c}<br><span style="color:#8494b7">  Control Tower 0.2 is running · open http://localhost:4000 · setup code K7QF-2M9X</span></div>`;
  }, cmd);

await page.goto(URL_ + '/');
await page.getByRole('heading', { name: /Set up your tower/ }).waitFor({ timeout: 20000 });

const framesDir = path.join(TMP, 'frames');
fs.mkdirSync(framesDir, { recursive: true });
const frames: Array<{ file: string; t: number }> = [];
const cdp = await page.context().newCDPSession(page);
cdp.on('Page.screencastFrame', async (f: { data: string; sessionId: number }) => {
  const file = path.join(framesDir, `${String(frames.length).padStart(6, '0')}.jpg`);
  fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
  frames.push({ file, t: Date.now() });
  await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
});
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
log('recording');

try {
  // 1. Install
  await terminal('docker run -p 4000:4000 -v controltower-data:/data ghcr.io/joshmaster2165/controltower');
  await s.caption(1, 'Start it', 'One container; its data on a volume');
  n.say('install');
  await n.done();
  await terminal(null);

  // 2. The first admin
  await s.caption(2, 'Create the first admin', 'With the setup code from its log');
  n.say('admin');
  await type(/^Setup code/, 'K7QF-2M9X');
  await type(/^Email/, 'you@example.com');
  await type(/^Password/, 'a-long-admin-password');
  await s.clickEl(page.getByRole('button', { name: /Create admin/ }), 600);
  await page.getByRole('heading', { name: 'Get started' }).waitFor({ timeout: 20000 });
  await n.done();

  // 3. A provider
  await s.caption(3, 'Connect a model provider', 'From the catalog: a cloud provider with its key, or a local model server');
  n.say('provider');
  await s.clickEl(page.getByRole('link', { name: 'Providers' }).first(), 700);
  await s.wait(900);
  await s.clickEl(page.locator('button.card', { hasText: 'Ollama' }).first(), 800);
  const base = page.locator('form.card').locator('.field', { has: page.locator('label', { hasText: /^Base URL$/ }) }).locator('input');
  await s.clickEl(base, 500);
  await base.fill('');
  await base.pressSequentially('http://localhost:11434/v1', { delay: 30 });
  await s.clickEl(page.locator('form.card').getByRole('button', { name: /Connect & test/ }), 600);
  await page.getByText(/Connected in \d+ ms/).first().waitFor({ timeout: 20000 });
  await n.done();

  // 4. A key for the agent
  await s.caption(4, 'Give each agent its own key', 'Its team and budget; shown once, with what to set in each tool');
  n.say('key');
  await s.clickEl(page.getByRole('link', { name: 'Keys' }).first(), 700);
  await s.wait(700);
  await s.clickEl(page.getByRole('button', { name: 'Create key', exact: true }), 600);
  await type(/Name \(agent\)/, 'support-bot');
  await type(/^Team/, 'support');
  await type(/Monthly budget/, '50');
  await s.clickEl(page.getByRole('button', { name: 'Create', exact: true }), 600);
  await page.locator('.keybox').waitFor({ timeout: 20000 });
  await s.wait(800);
  await s.hoverEl(page.locator('.connect-agent').first(), 900);
  await n.done();

  // 5. Its first request
  await s.caption(5, 'Send its first request', 'The panel turns green when it arrives');
  n.say('first');
  const secret = (await page.locator('.keybox').innerText()).trim();
  await s.wait(1800);
  await fetch(`${URL_}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'llama3.2', messages: [{ role: 'user', content: 'Where are you running?' }] }) });
  await page.locator('.connect-status', { hasText: 'Connected' }).waitFor({ timeout: 20000 });
  await s.hoverEl(page.locator('.connect-status'), 700);
  await n.done();

  // 6. On the map
  await s.caption(6, 'Your agent, on the map', 'Next: a gate on a path, laptops, your tools');
  n.say('map');
  await s.clickEl(page.getByRole('link', { name: 'Airspace' }).first(), 700);
  await s.wait(2500);
  await page.evaluate(() => (window as unknown as { __ctScene?: { fit(): void } }).__ctScene?.fit());
  await n.done();

  await s.caption(null);
  await s.endCard('Control Tower', 'The docs walk through every step.', 'agentcontroltower.app/docs');
  n.say('end');
  await n.done(1000);
} finally {
  await cdp.send('Page.stopScreencast').catch(() => {});
  if (frames.length) frames.push({ file: frames.at(-1)!.file, t: Date.now() });
  log(`${frames.length} frames`);
  await s.close();
  ct.kill();
  await ollama.close();
}

const raw = path.join(TMP, 'raw.mp4');
encodeFrames(frames, raw);
const silent = path.join(TMP, 'silent.mp4');
ffmpeg(['-i', raw, '-c:v', 'libx264', '-preset', 'slow', '-crf', '23', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', silent]);
mixNarration(silent, n.cues, frames[0]!.t, OUT);
ffmpeg(['-ss', '20', '-i', OUT, '-frames:v', '1', '-q:v', '3', POSTER]);
log(`${OUT}: ${duration(OUT).toFixed(1)} s, ${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB`);
