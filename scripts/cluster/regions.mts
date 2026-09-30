/**
 * Multi-region, phase 1, on this machine: a control plane and two regions — eu-west (one instance, SQLite) and
 * us-east (two instances sharing Postgres and Redis). Configuration made on the control plane is served in every
 * region; calls stay in their region; a region keeps serving on its last configuration when the control plane is
 * down, even across a restart, and catches up when it's back. Needs PG_URL (an empty database) and REDIS_URL.
 * Writes regions-results.json.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { openAiUpstream } from '../../e2e/support/upstreams.ts';
import { TEST_LICENSE_PUBLIC_KEY, testLicense } from '../../e2e/support/license.ts';

const DIR = process.env.RESULTS_DIR ?? new URL('.', import.meta.url).pathname;
const REPO = new URL('../..', import.meta.url).pathname;
const PG = process.env.PG_URL!;
const REDIS = process.env.REDIS_URL!;
const AK = 'regions-test-admin-key-0123456789ab';
const RAK = 'regions-test-region-admin-key-01234';
const CP_MASTER = Buffer.alloc(32, 3).toString('base64');
const LICENSE = testLicense();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const logs: Record<string, string[]> = {};
const scratch = fs.mkdtempSync(path.join(process.env.SCRATCH ?? os.tmpdir(), 'ct-regions-'));

function start(name: string, port: number, env: Record<string, string>): { p: ChildProcess; url: string; ready: Promise<boolean> } {
  const url = `http://127.0.0.1:${port}`;
  logs[name] = logs[name] ?? [];
  const p = spawn(process.execPath, ['server/dist/server.mjs'], {
    cwd: REPO,
    env: { ...process.env, CT_PORT: String(port), CT_UI_DIR: 'ui/dist', CT_LOG_LEVEL: 'warn', CT_INSTANCE_ID: name, CT_LICENSE_PUBLIC_KEY: TEST_LICENSE_PUBLIC_KEY, CT_LICENSE_SERVER: 'off', CT_MODEL_HEALTH_INTERVAL_S: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const s of [p.stdout!, p.stderr!]) s.on('data', (d) => logs[name]!.push(String(d)));
  const ready = (async () => {
    for (let i = 0; i < 150; i++) {
      if (p.exitCode !== null) return false;
      if ((await fetch(`${url}/healthz`).catch(() => null))?.ok) return true;
      await sleep(150);
    }
    return false;
  })();
  return { p, url, ready };
}
const stop = async (x: { p: ChildProcess }) => {
  if (x.p.exitCode !== null) return;
  const done = new Promise((r) => x.p.once('exit', r));
  x.p.kill('SIGTERM');
  await done;
};
const api = (base: string, key: string) => async (method: string, p: string, body?: unknown) => {
  const r = await fetch(base + p, { method, headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const chat = async (base: string, key: string) => (await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4.1-mini', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }) })).status;
/** Wait until `f` gives what we want (up to `ms`). */
async function until<T>(f: () => Promise<T>, ok: (v: T) => boolean, ms = 12_000): Promise<T> {
  let v = await f();
  for (let t = 0; t < ms && !ok(v); t += 300) (await sleep(300), (v = await f()));
  return v;
}

type Check = { what: string; pass: boolean; detail: string };
const checks: Check[] = [];
const c = (what: string, pass: boolean, detail: string) => {
  checks.push({ what, pass, detail });
  console.log(`${pass ? '✓' : '✗'} ${what} — ${detail}`);
};

const oai = await openAiUpstream({ models: ['gpt-4.1-mini'] });
const cpEnv = { CT_DATA_DIR: path.join(scratch, 'cp'), CT_ADMIN_KEY: AK, CT_MASTER_KEY: CP_MASTER, CT_LICENSE_KEY: LICENSE, CT_PUBLIC_URL: 'http://127.0.0.1:4901' };
let CP = start('cp', 4901, cpEnv);
const procs: Array<{ p: ChildProcess }> = [CP];
try {
  c('the control plane starts', await CP.ready, logs.cp!.join('').slice(-300));
  const cp = api(CP.url, AK);
  // Configuration on the control plane: a provider (its credential is a secret), a model, an agent's key.
  const prov = (await cp('POST', '/admin/api/providers', { catalog_id: 'openai', base_url: `${oai.url}/v1`, credentials: { api_key: 'sk-control-plane-secret' } })).body;
  // Regions don't add models on first use (their configuration is the control plane's): models are added here.
  await cp('POST', '/admin/api/deployments', { provider_id: (prov.provider ?? prov).id, upstream_model: 'gpt-4.1-mini' });
  const key = (await cp('POST', '/admin/api/keys', { name: 'regional-agent', team: 'eu' })).body;
  const eu = (await cp('POST', '/admin/api/regions', { name: 'eu-west' })).body;
  const us = (await cp('POST', '/admin/api/regions', { name: 'us-east' })).body;
  c('regions are added on the control plane, each with its own token and master key', !!eu.env?.CT_REGION_TOKEN && eu.env.CT_MASTER_KEY !== us.env.CT_MASTER_KEY && eu.env.CT_MASTER_KEY !== CP_MASTER, `${eu.env?.CT_ROLE} ${eu.env?.CT_REGION}, ${us.env?.CT_REGION}`);
  const regionEnv = (e: Record<string, string>) => ({ ...e, CT_ADMIN_KEY: RAK, CT_CONFIG_POLL_S: '1' });

  const EU = start('eu-west', 4911, { ...regionEnv(eu.env), CT_DATA_DIR: path.join(scratch, 'eu') });
  const US1 = start('us-east-1', 4921, { ...regionEnv(us.env), CT_DATA_DIR: path.join(scratch, 'us1'), CT_DATABASE_URL: PG, CT_REDIS_URL: REDIS });
  procs.push(EU, US1);
  const [okEu, okUs1] = await Promise.all([EU.ready, US1.ready]);
  const US2 = start('us-east-2', 4922, { ...regionEnv(us.env), CT_DATA_DIR: path.join(scratch, 'us2'), CT_DATABASE_URL: PG, CT_REDIS_URL: REDIS });
  procs.push(US2);
  const okUs2 = await US2.ready;
  c('three region instances start (eu-west on SQLite; us-east ×2 on Postgres and Redis)', okEu && okUs1 && okUs2, `${okEu} ${okUs1} ${okUs2} ${(logs['eu-west']!.join('') + logs['us-east-1']!.join('')).slice(-300)}`);

  // The key made on the control plane works in every region, with the credential the control plane holds.
  const codes = [await chat(EU.url, key.key), await chat(US1.url, key.key), await chat(US2.url, key.key)];
  c("an agent's key made on the control plane works in every region", codes.every((s) => s === 200), codes.join(' '));
  c('regions call the provider with the credential set on the control plane (re-encrypted for them)', oai.calls.length >= 3 && oai.calls.slice(-3).every((x) => x.headers.authorization === 'Bearer sk-control-plane-secret'), `${oai.calls.length} upstream calls`);

  const listed = await until(async () => (await cp('GET', '/admin/api/regions')).body.regions as any[], (r) => r.every((x) => x.status === 'in_sync'));
  c('the control plane lists both regions in sync, with who reported', listed.length === 2 && listed.every((x) => x.status === 'in_sync' && x.version), listed.map((x) => `${x.name}:${x.status}:${x.instance}`).join(', '));

  // Calls stay in their region.
  const cpFlights = (await cp('GET', `/admin/api/flights?key_id=${key.id}`)).body.flights as any[];
  const euFlights = (await api(EU.url, RAK)('GET', `/admin/api/flights?key_id=${key.id}`)).body.flights as any[];
  c('calls stay in their region: the control plane holds none', cpFlights.length === 0 && euFlights.length >= 1, `control plane ${cpFlights.length}, eu-west ${euFlights.length}`);

  // A change on the control plane reaches every region within seconds.
  await cp('PATCH', `/admin/api/keys/${key.id}`, { enabled: false });
  const off = await until(async () => [await chat(EU.url, key.key), await chat(US1.url, key.key), await chat(US2.url, key.key)], (v) => v.every((s) => s === 401));
  c('a key disabled on the control plane is refused in every region within seconds', off.every((s) => s === 401), off.join(' '));
  await cp('PATCH', `/admin/api/keys/${key.id}`, { enabled: true });
  const gate = (await cp('POST', '/admin/api/rules', { name: 'No mini in any region', target_kind: 'model', match: { keys: [key.id] }, effect: 'deny' })).body;
  const denied = await until(async () => [await chat(EU.url, key.key), await chat(US2.url, key.key)], (v) => v.every((s) => s === 403));
  c('a gate drawn on the control plane is enforced in every region', denied.every((s) => s === 403), denied.join(' '));
  await cp('DELETE', `/admin/api/rules/${gate.id}`);
  await until(async () => [await chat(EU.url, key.key), await chat(US1.url, key.key), await chat(US2.url, key.key)], (v) => v.every((x) => x === 200));

  // A held call in a region is decided in that region.
  const before = (await cp('GET', '/admin/api/regions')).body.config_etag;
  const hold = (await cp('POST', '/admin/api/rules', { name: 'Hold in the region', target_kind: 'model', match: { keys: [key.id] }, effect: 'require_approval', config: { hold_ms: 15000 } })).body;
  // Until the control plane says eu-west has the configuration with the new gate.
  await until(async () => (await cp('GET', '/admin/api/regions')).body, (b: any) => b.config_etag !== before && b.regions.find((r: any) => r.name === 'eu-west')?.status === 'in_sync');
  let heldCall: Promise<number> | undefined;
  const pending = await until(async () => {
    heldCall ??= chat(EU.url, key.key);
    return ((await api(EU.url, RAK)('GET', '/admin/api/approvals?status=pending')).body.approvals as any[] | undefined)?.[0];
  }, (a) => !!a);
  const decided = pending ? await api(EU.url, RAK)('POST', `/admin/api/approvals/${pending.id}/decide`, { action: 'approve' }) : { status: 0 };
  const released = heldCall ? await heldCall : 0;
  c("a call held in a region is decided in that region's console", decided.status === 200 && released === 200, `decide ${decided.status}, call ${released}`);
  await cp('DELETE', `/admin/api/rules/${hold.id}`);
  await until(async () => [await chat(EU.url, key.key), await chat(US1.url, key.key), await chat(US2.url, key.key)], (v) => v.every((x) => x === 200));

  // A region's configuration is changed on the control plane only.
  const w = await api(EU.url, RAK)('POST', '/admin/api/keys', { name: 'sneaky' });
  c("a region refuses changes to its configuration (they're the control plane's)", w.status === 409 && w.body.error?.code === 'managed_by_control_plane', `${w.status} ${w.body.error?.message ?? ''}`);
  const forged = await fetch(`${CP.url}/cp/v1/config`, { headers: { authorization: 'Bearer ctr_not-a-region' } });
  c('the control plane refuses an unknown region token', forged.status === 401, `${forged.status}`);

  // The control plane goes down: regions keep serving, even across a restart.
  await stop(CP);
  const during = [await chat(EU.url, key.key), await chat(US1.url, key.key)];
  await stop(EU);
  const EU2 = start('eu-west', 4911, { ...regionEnv(eu.env), CT_DATA_DIR: path.join(scratch, 'eu') });
  procs.push(EU2);
  const eu2Up = await EU2.ready;
  const afterRestart = await chat(EU2.url, key.key);
  const st = (await api(EU2.url, RAK)('GET', '/admin/api/status')).body.region;
  c('with the control plane down, regions keep serving — even a region restarted meanwhile', during.every((s) => s === 200) && eu2Up && afterRestart === 200, `during ${during.join(' ')}; restarted eu-west ${eu2Up ? 'up' : 'down'}, call ${afterRestart}; its status: ${st?.error ? `error "${String(st.error).slice(0, 60)}"` : 'no error'}`);

  // Back up: a change made meanwhile (here: right after) arrives.
  CP = start('cp', 4901, cpEnv);
  procs.push(CP);
  await CP.ready;
  await api(CP.url, AK)('PATCH', `/admin/api/keys/${key.id}`, { enabled: false });
  const caught = await until(async () => [await chat(EU2.url, key.key), await chat(US1.url, key.key)], (v) => v.every((s) => s === 401), 15_000);
  const stAfter = (await api(EU2.url, RAK)('GET', '/admin/api/status')).body.region;
  c('the control plane back: regions catch up, and report no error', caught.every((s) => s === 401) && !stAfter?.error, `${caught.join(' ')}; eu-west error: ${stAfter?.error ?? 'none'}`);
} finally {
  for (const p of procs.reverse()) await stop(p).catch(() => undefined);
  await oai.close();
  fs.writeFileSync(`${DIR}/regions-results.json`, JSON.stringify({ ran_at: new Date().toISOString(), checks }, null, 2));
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log(`\n${checks.filter((x) => x.pass).length} of ${checks.length} passed`);
process.exit(checks.every((x) => x.pass) ? 0 : 1);
