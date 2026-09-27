/** An existing SQLite install copied into Postgres keeps working: sign-in, keys, gates, history, provider credentials. */
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { openAiUpstream } from '../../e2e/support/upstreams.ts';
const REPO = new URL('../..', import.meta.url).pathname;
const S = process.env.SCRATCH ?? (await import('node:os')).tmpdir();
const PG = process.env.PG_URL!;
const AK = 'copy-test-admin-key-0123456789abcdef';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const data = fs.mkdtempSync(`${S}/copy-src-`);
const up = async (env: Record<string, string>, port: number) => {
  const p = spawn(process.execPath, ['server/dist/server.mjs'], { cwd: REPO, env: { ...process.env, CT_PORT: String(port), CT_DATA_DIR: data, CT_ADMIN_KEY: AK, CT_LOG_LEVEL: 'warn', ...env }, stdio: 'ignore' });
  for (let i = 0; i < 80; i++) {
    if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => null))?.ok) break;
    await sleep(150);
  }
  return p;
};
const api = (port: number) => async (method: string, path: string, body?: unknown) => (await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { authorization: `Bearer ${AK}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })).json() as Promise<any>;
const chat = (port: number, key: string) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4.1-mini', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }) }).then((r) => r.status);

const oai = await openAiUpstream({ models: ['gpt-4.1-mini'] });
// 1. A SQLite install with a provider, keys, a gate and some traffic.
let p = await up({}, 4821);
const a = api(4821);
await a('POST', '/admin/api/providers', { catalog_id: 'openai', base_url: `${oai.url}/v1`, credentials: { api_key: 'sk-secret-provider-key' } });
const k = await a('POST', '/admin/api/keys', { name: 'copied-agent', team: 'ops' });
const blocked = await a('POST', '/admin/api/keys', { name: 'blocked-agent' });
await a('POST', '/admin/api/rules', { name: 'No model for blocked-agent', target_kind: 'model', match: { keys: [blocked.id] }, effect: 'deny' });
for (let i = 0; i < 5; i++) await chat(4821, k.key);
await sleep(300);
const before = (await a('GET', `/admin/api/flights?key_id=${k.id}&limit=50`)).flights.length;
p.kill('SIGTERM');
await new Promise((r) => p.on('exit', r));
const master = fs.readFileSync(`${data}/master.key`, 'utf8').trim();

// 2. Copy it into Postgres.
const copy = spawnSync(process.execPath, ['server/dist/server.mjs', '--copy-to-postgres', PG], { cwd: REPO, env: { ...process.env, CT_DATA_DIR: data, CT_LOG_LEVEL: 'warn' }, encoding: 'utf8' });
console.log(copy.stdout.trim().split('\n').slice(-3).join('\n'), copy.stderr.trim().slice(-300));
// A second copy into the same database is refused.
const again = spawnSync(process.execPath, ['server/dist/server.mjs', '--copy-to-postgres', PG], { cwd: REPO, env: { ...process.env, CT_DATA_DIR: data }, encoding: 'utf8' });
console.log('copy again:', again.status !== 0 && /already has data/.test(again.stderr + again.stdout) ? 'refused (already has data)' : `NOT refused: ${again.stdout} ${again.stderr}`.slice(0, 200));

// 3. Control Tower on Postgres, with the install's master key and a fresh data directory.
const fresh = fs.mkdtempSync(`${S}/copy-dst-`);
p = spawn(process.execPath, ['server/dist/server.mjs'], { cwd: REPO, env: { ...process.env, CT_PORT: '4822', CT_DATA_DIR: fresh, CT_DATABASE_URL: PG, CT_MASTER_KEY: master, CT_LOG_LEVEL: 'warn' }, stdio: 'ignore' });
for (let i = 0; i < 80; i++) {
  if ((await fetch('http://127.0.0.1:4822/healthz').catch(() => null))?.ok) break;
  await sleep(150);
}
const login = await fetch('http://127.0.0.1:4822/admin/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin', password: AK }) });
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
const b = async (path: string) => (await fetch(`http://127.0.0.1:4822${path}`, { headers: { cookie } })).json() as Promise<any>;
const checks: Array<[string, boolean, string]> = [];
checks.push(['the console sign-in carried over', login.status === 200, `login ${login.status}`]);
const call = await chat(4822, k.key);
checks.push(['keys, and the encrypted provider credentials, work', call === 200, `call with the copied key: ${call}`]);
const deny = await chat(4822, blocked.key);
checks.push(['gates carried over', deny === 403, `blocked-agent: ${deny}`]);
await sleep(500);
const after = (await b(`/admin/api/flights?key_id=${k.id}&limit=50`)).flights?.length;
checks.push(['the history carried over', after === before + 1, `${before} calls before the copy, ${after} after one more`]);
for (const [what, ok, detail] of checks) console.log(`${ok ? '✓' : '✗'} ${what} — ${detail}`);
p.kill('SIGTERM');
await oai.close();
fs.rmSync(data, { recursive: true, force: true });
fs.rmSync(fresh, { recursive: true, force: true });
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
