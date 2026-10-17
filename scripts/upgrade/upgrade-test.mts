/**
 * A real upgrade, from a released version to this build, on real data — and back.
 *
 *   1. The old version (built from its tag, in OLD_DIR) runs with the demo fleet, and some setup of our own: keys, a
 *      gate, a person, a provider and a model, a tool server. What it holds is noted.
 *   2. This build starts on the same data: everything is still there, the audit chain still checks out, the upgrade is
 *      in the history, and (SQLite) a backup was taken first.
 *   3. Something is changed after the upgrade. Then (SQLite) the backup is restored with this build, and the old
 *      version starts on it again: everything as it was before the upgrade, without the later change.
 *
 *   OLD_DIR=/tmp/old FROM=0.2.12 [UPGRADE_DATABASE_URL=postgres://…] npx tsx scripts/upgrade/upgrade-test.mts
 * Both builds need CT_TEST_LICENSE_KEYS=1 (they then trust the test license, for the audit log).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TEST_LICENSE_PUBLIC_KEY, testLicense } from '../../e2e/support/license.ts';

const REPO = path.resolve(import.meta.dirname, '../..');
const OLD = path.resolve(process.env.OLD_DIR ?? '');
const FROM = process.env.FROM ?? '?';
const PG = process.env.UPGRADE_DATABASE_URL || undefined;
if (!fs.existsSync(path.join(OLD, 'server/dist/server.mjs'))) throw new Error(`OLD_DIR must hold a built Control Tower (server/dist/server.mjs): ${OLD}`);
const PORT = 4710;
const CT = `http://127.0.0.1:${PORT}`;
const AK = 'upgrade-test-admin-key-0123456789abcdef';
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-upgrade-'));
const checks: Array<{ what: string; pass: boolean; detail: string }> = [];
const c = (what: string, pass: boolean, detail = '') => {
  checks.push({ what, pass, detail });
  console.log(`${pass ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const env = (demo: boolean) => ({
  ...process.env,
  CT_DATA_DIR: DATA,
  CT_ADMIN_KEY: AK,
  CT_LOG_LEVEL: 'warn',
  CT_DEMO: demo ? '1' : '0',
  CT_LICENSE_PUBLIC_KEY: TEST_LICENSE_PUBLIC_KEY,
  CT_LICENSE_KEY: testLicense(),
  CT_LICENSE_SERVER: 'off',
  CT_UPDATE_CHECK: 'off',
  CT_MODEL_HEALTH_INTERVAL_S: '0',
  ...(PG ? { CT_DATABASE_URL: PG } : {}),
});

let server: ChildProcess | undefined;
async function start(dir: string, demo: boolean): Promise<void> {
  server = spawn(process.execPath, [path.join(dir, 'server/dist/server.mjs'), '--port', String(PORT)], { cwd: dir, env: env(demo), stdio: ['ignore', 'inherit', 'inherit'] });
  for (let i = 0; ; i++) {
    if ((await fetch(`${CT}/healthz`).catch(() => null))?.ok) return;
    if (server.exitCode !== null) throw new Error(`the server at ${dir} exited (${server.exitCode})`);
    if (i > 200) throw new Error(`the server at ${dir} did not start`);
    await sleep(200);
  }
}
async function stop(): Promise<void> {
  if (!server || server.exitCode !== null) return;
  const done = new Promise((r) => server!.once('exit', r));
  server.kill('SIGTERM');
  await done;
}
const api = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(CT + p, { method, headers: { authorization: `Bearer ${AK}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
/** The version this data says it came from: exact, or a range of releases (a-b) that had its database. */
const fromMatches = (v: string | null | undefined, want: string) => {
  if (!v) return false;
  if (v === want) return true;
  const [lo, hi] = v.split('-');
  const n = (x: string) => x.split('.').map(Number).reduce((a, b) => a * 1000 + b, 0);
  return !!hi && n(lo!) <= n(want) && n(want) <= n(hi);
};
const names = (list: Array<{ name?: string; email?: string }> | undefined) => (list ?? []).map((x) => x.name ?? x.email ?? '').sort();

/** What the data holds, as the admin API shows it: compared field by field across the upgrade. */
async function snapshot() {
  const [keys, policy, users, providers, deployments, mcp, flights, approvals] = await Promise.all([
    api('GET', '/admin/api/keys'),
    api('GET', '/admin/api/policy'),
    api('GET', '/admin/api/users'),
    api('GET', '/admin/api/providers'),
    api('GET', '/admin/api/deployments'),
    api('GET', '/admin/api/mcp/servers'),
    api('GET', '/admin/api/flights?limit=5000'),
    api('GET', '/admin/api/approvals?limit=500'),
  ]);
  return {
    keys: names(keys.body.keys),
    rules: names(policy.body.rules),
    zones: names(policy.body.zones),
    people: names(users.body.users),
    providers: names(providers.body.providers),
    deployments: ((deployments.body.deployments ?? []) as Array<{ public_name?: string; upstream_model?: string }>).map((d) => d.public_name ?? d.upstream_model ?? '').sort(),
    tool_servers: names(mcp.body.servers ?? mcp.body.mcp_servers),
    flights: ((flights.body.flights ?? []) as Array<{ id: string }>).map((f) => f.id).sort(),
    approvals: ((approvals.body.approvals ?? []) as Array<{ id: string; status: string }>).map((a) => `${a.id}:${a.status}`).sort(),
  };
}
type Snap = Awaited<ReturnType<typeof snapshot>>;
function same(a: Snap, b: Snap): string[] {
  return (Object.keys(a) as Array<keyof Snap>).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).map((k) => `${k}: ${a[k].length} → ${b[k].length}`);
}
const sizes = (s: Snap) => Object.entries(s).map(([k, v]) => `${v.length} ${k.replace('_', ' ')}`).join(', ');

try {
  // ---- 1. The old version, with traffic and setup of its own ----
  await start(OLD, true);
  const oldVersion = (await api('GET', '/admin/api/status')).body.version;
  c(`the old version runs (${oldVersion})`, oldVersion === FROM || FROM === '?', `${oldVersion}, ${PG ? 'Postgres' : 'SQLite'}`);
  await api('POST', '/admin/api/keys', { name: 'kept-agent', team: 'ops', owner: 'ops@acme.example', allowed_models: ['*'] });
  await api('POST', '/admin/api/rules', { name: 'Kept: deletes need a person', target_kind: 'tool', match: { operations: ['admin'] }, effect: 'require_approval', priority: 30 });
  await api('POST', '/admin/api/users', { email: 'kept.viewer@acme.example', role: 'viewer' });
  const p = await api('POST', '/admin/api/providers', { catalog_id: 'custom', name: 'Kept upstream', slug: 'keptup', base_url: 'http://127.0.0.1:9/v1', credentials: { api_key: 'sk-kept' } });
  await api('POST', '/admin/api/deployments', { provider_id: (p.body.provider ?? p.body).id, upstream_model: 'kept-model', public_name: 'kept-model' });
  await api('POST', '/admin/api/mcp/servers', { name: 'Kept tools', slug: 'kepttools', url: 'http://127.0.0.1:9/mcp' });
  await sleep(20_000); // the demo fleet's traffic, approvals, audit events
  await stop();
  // Read what it holds with the demo stopped (the old version again, without the fleet), so nothing moves.
  await start(OLD, false);
  const before = await snapshot();
  const auditBefore = (await api('GET', '/admin/api/audit/verify')).body;
  await stop();
  c('the old version holds data of every kind', before.flights.length > 10 && before.keys.includes('kept-agent') && before.rules.includes('Kept: deletes need a person') && before.approvals.length > 0, sizes(before));

  // ---- 2. This build, on the same data ----
  await start(REPO, false);
  const status = (await api('GET', '/admin/api/status')).body;
  const after = await snapshot();
  const diff = same(before, after);
  c(`this build (${status.version}) starts on it, and everything is still there`, !diff.length, diff.length ? diff.join('; ') : sizes(after));
  const va = await api('GET', '/admin/api/audit/verify');
  const auditAfter = va.body;
  c('the audit chain still checks out, unbroken', auditAfter.ok === true && auditAfter.events >= auditBefore.events, auditAfter.ok === undefined ? `${va.status}: ${JSON.stringify(va.body).slice(0, 200)}` : `${auditBefore.events} events before, ${auditAfter.events} after: ${auditAfter.ok ? 'intact' : auditAfter.reason}`);
  const up = (await api('GET', '/admin/api/updates')).body;
  const rec = up.history?.[0];
  c('the upgrade is in the history', fromMatches(rec?.from_version, oldVersion) && rec?.to_version === status.version, rec ? `${rec.from_version} → ${rec.to_version}, schema ${rec.from_schema} → ${rec.to_schema}` : 'no history');
  const backup = up.data?.backups?.[0];
  if (!PG) c('the database was backed up before it was upgraded', !!backup && fromMatches(backup.from_version, oldVersion) && rec?.backup === backup.name, backup ? `${backup.name} (${Math.round(backup.size / 1024)} KB)` : 'no backup');
  else c('Postgres: no backup by Control Tower (the provider snapshots it), and none claimed', !rec?.backup && !(up.data?.backups ?? []).length);
  await api('POST', '/admin/api/keys', { name: 'written-after-upgrade', allowed_models: ['*'] });
  await stop();

  // ---- 3. Back: restore the backup with this build, then the old version on it ----
  if (!PG && backup) {
    const r = spawnSync(process.execPath, [path.join(REPO, 'server/dist/server.mjs'), '--restore', backup.name], { cwd: REPO, env: env(false), encoding: 'utf8' });
    c('--restore puts the backup back', r.status === 0 && /Restored/.test(r.stdout), (r.stdout || r.stderr).trim().split('\n')[0]);
    await start(OLD, false);
    const back = await snapshot();
    const d2 = same(before, back);
    c('the old version starts on the restored data: as it was before the upgrade', !d2.length && !back.keys.includes('written-after-upgrade'), d2.length ? d2.join('; ') : sizes(back));
    await stop();
    // And forward again: this build upgrades it once more (and backs it up again).
    await start(REPO, false);
    const again = (await api('GET', '/admin/api/updates')).body;
    c('this build upgrades the restored data again, with a new backup', again.history?.[0]?.to_version === status.version && (again.data?.backups ?? []).filter((b: { before_version: string | null }) => b.before_version).length >= 2);
    await stop();
  }
} finally {
  await stop();
  const failed = checks.filter((x) => !x.pass).length;
  const summary = `### Upgrade ${FROM} → this build (${PG ? 'Postgres' : 'SQLite'}): ${checks.length - failed} of ${checks.length}\n\n${checks.map((x) => `- ${x.pass ? '✅' : '❌'} ${x.what}${x.detail ? ` — ${x.detail}` : ''}`).join('\n')}\n`;
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(`${checks.length - failed} of ${checks.length} passed`);
  if (!PG) fs.rmSync(DATA, { recursive: true, force: true });
  process.exitCode = failed || !checks.length ? 1 : 0;
}
