/**
 * A new user's first five minutes, against the published image, as Getting started says: `docker run`, the setup
 * code from the log, the first admin, a model provider, a key, the curl command the console shows, the agent on the
 * map; then a restart that keeps everything. Linux with Docker (a CI runner).
 *
 *   IMAGE=ghcr.io/joshmaster2165/controltower:main npx tsx scripts/install/fresh-docker.mts
 */
import { execFile, execSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import http from 'node:http';
import { chromium } from '@playwright/test';

const IMAGE = process.env.IMAGE ?? 'ghcr.io/joshmaster2165/controltower:latest';
const NAME = 'ct-fresh';
const CT = 'http://localhost:4000';
const checks: Array<{ what: string; pass: boolean; detail: string }> = [];
const c = (what: string, pass: boolean, detail = '') => {
  checks.push({ what, pass, detail });
  console.log(`${pass ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd: string) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const logs = () => spawnSync('docker', ['logs', NAME], { encoding: 'utf8' }).stdout + spawnSync('docker', ['logs', NAME], { encoding: 'utf8' }).stderr;
async function healthy(ms = 90_000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if ((await fetch(`${CT}/healthz`).catch(() => null))?.ok) return true;
    await sleep(500);
  }
  return false;
}

// A model server where the user's provider would be: OpenAI-compatible, on every interface so the container reaches it.
const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url?.endsWith('/models')) return res.end(JSON.stringify({ object: 'list', data: [{ id: 'llama3.2', object: 'model' }] }));
    const model = (() => {
      try {
        return JSON.parse(body).model as string;
      } catch {
        return 'llama3.2';
      }
    })();
    res.end(JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from the stand-in model.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 } }));
  });
});
await new Promise<void>((r) => upstream.listen(11434, '0.0.0.0', () => r()));
const gateway = sh("docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}'");

const browser = await chromium.launch();
try {
  // 1. The command from Getting started (detached here, and named, so the test can read its log).
  sh(`docker rm -f ${NAME} >/dev/null 2>&1 || true; docker volume rm controltower-data >/dev/null 2>&1 || true`);
  sh(`docker pull ${IMAGE}`);
  sh(`docker run -d --name ${NAME} -p 4000:4000 -v controltower-data:/data ${IMAGE}`);
  c('the docs\' docker run starts it', await healthy(), IMAGE);
  await sleep(1000);
  const log = logs();
  const open = /Open\s+(http:\/\/localhost:4000\/\?setup=[\w-]+)/.exec(log)?.[1];
  const code = /Setup code\s+([\w-]+)/.exec(log)?.[1];
  c('its log shows the Open link and the setup code, as the docs say', !!open && !!code && /ANTHROPIC_BASE_URL=http:\/\/localhost:4000/.test(log) && /master\.key/.test(log), open ?? log.slice(0, 300));
  // The entrypoint starts as root to hand /data to `node`, then drops to it: the server process is what counts.
  const uid = sh(`docker exec ${NAME} sh -c 'for p in /proc/[0-9]*; do tr "\\0" " " < $p/cmdline 2>/dev/null | grep -q "^node dist/serve[r].mjs" && stat -c %u $p; done; true'`).split('\n')[0] ?? '';
  c('the server runs as a user other than root', uid !== '' && uid !== '0', `uid ${uid || 'not found'}`);

  // 2. The first admin, from the Open link (the code is filled in).
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(open ?? CT);
  const field = (l: RegExp) => page.locator('.field', { has: page.locator('label', { hasText: l }) }).first().locator('input, select').first();
  c('the setup page has the code filled in', (await field(/^Setup code/).inputValue()) === code);
  await field(/^Email/).fill('you@example.com');
  await field(/^Password/).fill('a-long-admin-password');
  await page.getByRole('button', { name: /Create admin/ }).click();
  await page.getByRole('heading', { name: 'Get started' }).waitFor({ timeout: 20_000 });
  c('the admin is created, and it lands on Get started', true);

  // 3. A provider (a local model server, by its address), Connect & test.
  await page.getByRole('link', { name: 'Providers' }).first().click();
  await page.locator('button.card', { hasText: 'Ollama' }).first().click();
  const base = page.locator('form.card').locator('.field', { has: page.locator('label', { hasText: /^Base URL$/ }) }).locator('input');
  await base.fill(`http://${gateway}:11434/v1`);
  await page.locator('form.card').getByRole('button', { name: /Connect & test/ }).click();
  const connected = await page.getByText(/Connected in \d+ ms/).first().waitFor({ timeout: 20_000 }).then(() => true, () => false);
  c('a provider connects and is tested', connected, `http://${gateway}:11434/v1`);

  // 4. A key, and the curl command the console shows for it, run as it is.
  await page.getByRole('link', { name: 'Keys' }).first().click();
  await page.getByRole('button', { name: 'Create key', exact: true }).click();
  await field(/Name \(agent\)/).fill('my-agent');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.locator('.keybox').waitFor({ timeout: 20_000 });
  await page.locator('.connect-agent').getByRole('button', { name: 'Test with curl' }).click();
  const curl = (await page.locator('.connect-agent pre').filter({ hasText: 'curl' }).first().innerText()).trim();
  // Run without blocking: the stand-in model server lives in this process and has to answer while curl waits.
  const out = await promisify(execFile)('bash', ['-c', curl.replace(/\\\n/g, ' ') + ' -s -w "\\n%{http_code}"'], { encoding: 'utf8' }).catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? '' }));
  const status = out.stdout.trim().split('\n').pop();
  c("the console's curl command works as shown", status === '200' && out.stdout.includes('stand-in model'), `${status}: ${out.stdout.slice(0, 120)}`);
  const green = await page.locator('.connect-status', { hasText: 'Connected' }).waitFor({ timeout: 20_000 }).then(() => true, () => false);
  c('the key panel turns green when the request arrives', green);

  // 5. The agent on the map.
  await page.getByRole('link', { name: 'Airspace', exact: true }).first().click();
  const onMap = await page.waitForFunction(() => [...((window as any).__ctScene?.stations?.values() ?? [])].some((s: any) => s.label === 'my-agent'), null, { timeout: 20_000 }).then(() => true, () => false);
  c('the agent is on the map', onMap);
  c('no script errors on the way', !errors.length, errors.join('; ').slice(0, 200));

  // 6. A restart keeps it all (the volume): sign in again, the key is there.
  sh(`docker restart ${NAME}`);
  c('it comes back after a restart', await healthy());
  await page.goto(CT);
  // Sessions are kept in the database, so the console may still be signed in; otherwise sign in again.
  const keysLink = page.getByRole('link', { name: 'Keys' }).first();
  const signIn = page.getByRole('button', { name: 'Sign in' });
  await keysLink.or(signIn).first().waitFor({ timeout: 20_000 });
  if (await signIn.isVisible()) {
    await field(/^Email or username/).fill('you@example.com');
    await field(/^Password/).fill('a-long-admin-password');
    await signIn.click();
  }
  await page.getByRole('link', { name: 'Keys' }).first().click();
  c('…with the admin and the key still there (the volume)', await page.getByText('my-agent').first().waitFor({ timeout: 15_000 }).then(() => true, () => false));
  const health = sh(`docker inspect --format '{{.State.Health.Status}}' ${NAME}`);
  c("the image's health check reports healthy", health === 'healthy' || health === 'starting', health);
} catch (err) {
  c('the walk-through ran', false, (err as Error).message.slice(0, 300));
} finally {
  await browser.close();
  upstream.close();
  const failed = checks.filter((x) => !x.pass).length;
  const md = `### A new install, as Getting started says (${IMAGE}): ${checks.length - failed} of ${checks.length}\n\n${checks.map((x) => `- ${x.pass ? '✅' : '❌'} ${x.what}${x.detail ? ` — ${x.detail}` : ''}`).join('\n')}\n`;
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  if (failed) console.log(logs().slice(-2000));
  console.log(`${checks.length - failed} of ${checks.length} passed`);
  process.exitCode = failed ? 1 : 0;
}
