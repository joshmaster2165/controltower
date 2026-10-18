/**
 * A rolling upgrade on Postgres: the old version and this build serving the same database at the same time, the way
 * servers are replaced one at a time behind a load balancer.
 *
 *   1. The old version (OLD_DIR) runs and makes data (the demo fleet).
 *   2. This build starts beside it, on the same database: it upgrades the schema while the old one keeps serving.
 *   3. Steady calls go to both for a while: every one must be answered (the old version on the upgraded schema too).
 *   4. The old one stops; this build carries on alone.
 *
 *   OLD_DIR=/tmp/old FROM=0.2.12 UPGRADE_DATABASE_URL=postgres://… npx tsx scripts/upgrade/rolling-test.mts
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TEST_LICENSE_PUBLIC_KEY, testLicense } from '../../e2e/support/license.ts';

const REPO = path.resolve(import.meta.dirname, '../..');
const OLD = path.resolve(process.env.OLD_DIR ?? '');
const FROM = process.env.FROM ?? '?';
const PG = process.env.UPGRADE_DATABASE_URL;
if (!PG) throw new Error('a rolling upgrade needs Postgres: UPGRADE_DATABASE_URL');
const AK = 'rolling-test-admin-key-0123456789abcdef';
const MASTER = Buffer.alloc(32, 7).toString('base64'); // both servers must read the same secrets
const checks: Array<{ what: string; pass: boolean; detail: string }> = [];
const c = (what: string, pass: boolean, detail = '') => {
  checks.push({ what, pass, detail });
  console.log(`${pass ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const procs: ChildProcess[] = [];
async function start(dir: string, port: number, demo: boolean): Promise<{ url: string; proc: ChildProcess }> {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-rolling-'));
  const proc = spawn(process.execPath, [path.join(dir, 'server/dist/server.mjs'), '--port', String(port)], {
    cwd: dir,
    env: { ...process.env, CT_DATA_DIR: data, CT_DATABASE_URL: PG, CT_MASTER_KEY: MASTER, CT_ADMIN_KEY: AK, CT_DEMO: demo ? '1' : '0', CT_LOG_LEVEL: 'warn', CT_LICENSE_PUBLIC_KEY: TEST_LICENSE_PUBLIC_KEY, CT_LICENSE_KEY: testLicense(), CT_LICENSE_SERVER: 'off', CT_UPDATE_CHECK: 'off', CT_MODEL_HEALTH_INTERVAL_S: '0' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  procs.push(proc);
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    if ((await fetch(`${url}/healthz`).catch(() => null))?.ok) return { url, proc };
    if (proc.exitCode !== null) throw new Error(`${dir} exited (${proc.exitCode})`);
    if (i > 300) throw new Error(`${dir} did not start`);
    await sleep(200);
  }
}
const stop = async (p: ChildProcess) => {
  if (p.exitCode !== null) return;
  const done = new Promise((r) => p.once('exit', r));
  p.kill('SIGTERM');
  await done;
};
const version = async (url: string) => ((await (await fetch(`${url}/admin/api/status`, { headers: { authorization: `Bearer ${AK}` } })).json()) as { version: string }).version;

/** Calls to every server, ~10 a second, for `ms`: the demo's own agents' models, and admin reads. */
async function traffic(urls: string[], ms: number) {
  const keys = ((await (await fetch(`${urls[0]}/admin/api/keys`, { headers: { authorization: `Bearer ${AK}` } })).json()) as { keys: Array<{ id: string }> }).keys;
  const t0 = Date.now();
  let n = 0;
  const bad: string[] = [];
  while (Date.now() - t0 < ms) {
    const url = urls[n % urls.length]!;
    const r = n % 2
      ? await fetch(`${url}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${AK}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 5, messages: [{ role: 'user', content: `rolling ${n}` }] }) }).catch((e) => e as Error)
      : await fetch(`${url}/admin/api/flights?limit=20`, { headers: { authorization: `Bearer ${AK}` } }).catch((e) => e as Error);
    if (r instanceof Error) bad.push(`${url} ${r.message}`);
    else if (!r.ok) {
      // The demo's stand-in model fails ~1% of calls on purpose (429s and 500s, passed on as provider_*): those are
      // the model's, not the gateway's. Anything else (the gateway's own errors) counts.
      const text = await r.text();
      const code = (() => {
        try {
          return String((JSON.parse(text) as { error?: { code?: string } }).error?.code ?? '');
        } catch {
          return '';
        }
      })();
      if (!code.startsWith('provider_')) bad.push(`${url} ${r.status} ${text.slice(0, 120)}`);
    } else await r.arrayBuffer();
    n++;
    await sleep(100);
  }
  return { n, bad, keys: keys.length };
}

try {
  const old = await start(OLD, 4720, true);
  c(`the old version runs on Postgres (${await version(old.url)})`, true);
  await sleep(15_000); // the demo fleet's traffic and setup
  const before = await traffic([old.url], 3000);
  c('it serves', !before.bad.length, before.bad.length ? before.bad.slice(0, 3).join(' | ') : `${before.n} calls`);

  // This build starts beside it: it upgrades the schema under the running old version.
  const next = await start(REPO, 4721, false);
  c(`this build starts beside it on the same database (${await version(next.url)})`, true);
  const mixed = await traffic([old.url, next.url], 20_000);
  c('both serve every call while the old version runs on the upgraded database', !mixed.bad.length, mixed.bad.length ? mixed.bad.slice(0, 3).join(' | ') : `${mixed.n} calls, none failed`);

  await stop(old.proc);
  const after = await traffic([next.url], 3000);
  c('the old one stops, and this build carries on alone', !after.bad.length, after.bad.length ? after.bad.slice(0, 3).join(' | ') : `${after.n} calls`);
} catch (err) {
  c('the test ran', false, (err as Error).message);
} finally {
  for (const p of procs) await stop(p);
  const failed = checks.filter((x) => !x.pass).length;
  const md = `### Rolling upgrade ${FROM} → this build (Postgres): ${checks.length - failed} of ${checks.length}\n\n${checks.map((x) => `- ${x.pass ? '✅' : '❌'} ${x.what}${x.detail ? ` — ${x.detail}` : ''}`).join('\n')}\n`;
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  console.log(`${checks.length - failed} of ${checks.length} passed`);
  process.exitCode = failed ? 1 : 0;
}
