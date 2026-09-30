/**
 * Two Control Tower instances sharing Postgres and Redis, on this machine: everything that must hold when
 * several instances serve the same agents. Needs local Postgres (PG_URL) and Redis (REDIS_URL).
 * Writes cluster-results.json.
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import WebSocket from 'ws';
import { openAiUpstream } from '../../e2e/support/upstreams.ts';
import { TEST_LICENSE_PUBLIC_KEY, testLicense } from '../../e2e/support/license.ts';
import { signJwt, testSigner } from '../../e2e/support/jwt.ts';

const DIR = process.env.RESULTS_DIR ?? new URL('.', import.meta.url).pathname;
const REPO = new URL('../..', import.meta.url).pathname;
const PG = process.env.PG_URL!;
const REDIS = process.env.REDIS_URL!;
const AK = 'cluster-test-admin-key-0123456789abc';
const MASTER = Buffer.alloc(32, 7).toString('base64');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const logs: Record<string, string[]> = {};
const LICENSE = testLicense();

// A SIEM: the audit events it receives, by sequence number.
const siemGot: number[] = [];
const siem = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (d: Buffer) => chunks.push(d));
  req.on('end', () => {
    for (const e of (JSON.parse(Buffer.concat(chunks).toString('utf8')).events ?? []) as Array<{ seq: number }>) siemGot.push(e.seq);
    res.writeHead(200);
    res.end('{}');
  });
});
await new Promise<void>((r) => siem.listen(0, '127.0.0.1', () => r()));
const siemUrl = `http://127.0.0.1:${(siem.address() as AddressInfo).port}/siem`;
const newestSeq = async (x: ReturnType<typeof admin>) => Number(((await x('GET', '/admin/api/audit?limit=1')).body.events as Array<{ seq: number }>)[0]?.seq ?? 0);
const siemHas = async (upTo: number, waitMs: number) => {
  for (let t = 0; t < waitMs && !(siemGot.length && Math.max(...siemGot) >= upTo); t += 500) await sleep(500);
  return siemGot.length > 0 && Math.max(...siemGot) >= upTo;
};

function start(name: string, port: number, extra: Record<string, string> = {}): { p: ChildProcess; url: string; ready: Promise<boolean> } {
  const url = `http://127.0.0.1:${port}`;
  logs[name] = [];
  const p = spawn(process.execPath, ['server/dist/server.mjs'], {
    cwd: REPO,
    env: { ...process.env, CT_PORT: String(port), CT_DATA_DIR: `${process.env.SCRATCH ?? (process.env.TMPDIR ?? '/tmp')}/cluster-${name}`, CT_ADMIN_KEY: AK, CT_MASTER_KEY: MASTER, CT_DATABASE_URL: PG, CT_REDIS_URL: REDIS, CT_UI_DIR: 'ui/dist', CT_LOG_LEVEL: 'warn', CT_INSTANCE_ID: name, CT_INSTANCE_TIMEOUT_MS: '8000', CT_HOLD_BUDGET_MS: '30000', CT_LICENSE_PUBLIC_KEY: TEST_LICENSE_PUBLIC_KEY, CT_LICENSE_KEY: LICENSE, CT_LICENSE_SERVER: 'off', ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const s of [p.stdout!, p.stderr!]) s.on('data', (d) => logs[name]!.push(String(d)));
  const ready = (async () => {
    for (let i = 0; i < 100; i++) {
      if (p.exitCode !== null) return false;
      if ((await fetch(`${url}/healthz`).catch(() => null))?.ok) return true;
      await sleep(150);
    }
    return false;
  })();
  return { p, url, ready };
}
const admin = (base: string) => async (method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${AK}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const t = await r.text();
  try {
    return { status: r.status, body: JSON.parse(t) };
  } catch {
    return { status: r.status, body: t };
  }
};
const chat = (base: string, key: string, model = 'gpt-4.1-mini') =>
  fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }) }).then(async (r) => {
    const j = (await r.json().catch(() => ({}))) as any;
    return { status: r.status, code: j.error?.code as string | undefined, message: String(j.error?.message ?? '').slice(0, 160) };
  });

type Check = { what: string; pass: boolean; detail: string };
const checks: Check[] = [];
const c = (what: string, pass: boolean, detail: string) => {
  checks.push({ what, pass, detail });
  console.log(`${pass ? '✓' : '✗'} ${what} — ${detail}`);
};

const oai = await openAiUpstream({ models: ['gpt-4.1-mini'] });
const A = start('a', 4801);
const B = start('b', 4802);
const [okA, okB] = await Promise.all([A.ready, B.ready]);
c('two instances start together on one database', okA && okB, `a ${okA ? 'up' : 'down'}, b ${okB ? 'up' : 'down'}${okA && okB ? '' : ` — ${(logs.a!.join('') + logs.b!.join('')).slice(-400)}`}`);
const a = admin(A.url);
const b = admin(B.url);
try {
  // Configuration made through one instance is live on the other at once.
  await a('POST', '/admin/api/providers', { catalog_id: 'openai', base_url: `${oai.url}/v1`, credentials: { api_key: 'sk-x' } });
  const k = (await a('POST', '/admin/api/keys', { name: 'cluster-agent', agent_id: 'cluster-agent' })).body;
  const onB = await chat(B.url, k.key);
  c('a key and a provider added through one instance work through the other', onB.status === 200, `call through b: ${onB.status}`);
  await a('PATCH', `/admin/api/keys/${k.id}`, { enabled: false });
  await sleep(300);
  const disabled = await chat(B.url, k.key);
  c('a key disabled through one instance is refused by the other at once', disabled.status === 401, `call through b: ${disabled.status} ${disabled.code ?? ''}`);
  await a('PATCH', `/admin/api/keys/${k.id}`, { enabled: true });
  await sleep(300);
  const gate = (await a('POST', '/admin/api/rules', { name: 'cluster: deny', target_kind: 'model', match: { keys: [k.id] }, effect: 'deny' })).body;
  await sleep(300);
  const denied = await chat(B.url, k.key);
  c('a gate drawn through one instance is enforced by the other', denied.status === 403 && denied.code === 'policy_denied', `call through b: ${denied.status} ${denied.code ?? ''}`);
  await a('DELETE', `/admin/api/rules/${gate.id}`);
  await sleep(300);

  // Rate limits are shared: 10 a minute is 10 a minute across both.
  const rl = (await a('POST', '/admin/api/keys', { name: 'cluster-limited', limits: { rpm: 10 } })).body;
  await sleep(300);
  const codes: number[] = [];
  for (let i = 0; i < 16; i++) codes.push((await chat(i % 2 ? B.url : A.url, rl.key)).status);
  const ok = codes.filter((s) => s === 200).length;
  c('a rate limit is shared: 10 a minute across both instances, not 10 each', ok === 10 && codes.filter((s) => s === 429).length === 6, `${ok} answered, ${codes.filter((s) => s === 429).length} refused (429) of 16, alternating instances`);

  // Budgets are shared: spend through either counts against the one budget.
  const bk = (await a('POST', '/admin/api/keys', { name: 'cluster-budget' })).body;
  const price = (await chat(A.url, bk.key)).status;
  await sleep(4000);
  const spentOne = ((await a('GET', '/admin/api/budgets')).body.budgets ?? []).length;
  await a('PUT', `/admin/api/budgets/key/${bk.id}`, { limit_usd: 0.00005, period: 'monthly', hard: true });
  await sleep(500);
  let firstRefused = -1;
  const seen: string[] = [];
  for (let i = 0; i < 40 && firstRefused < 0; i++) {
    const r = await chat(i % 2 ? B.url : A.url, bk.key);
    seen.push(`${i % 2 ? 'b' : 'a'}${r.status}`);
    if (r.status === 429) firstRefused = i;
    if (i % 4 === 3) await sleep(3500); // let the instances exchange spend
  }
  await sleep(4000);
  const afterA = await chat(A.url, bk.key);
  const afterB = await chat(B.url, bk.key);
  const budget = ((await b('GET', '/admin/api/budgets')).body.budgets as any[]).find((x) => x.scope_type === 'key' && x.scope_id === bk.id);
  c('a budget is shared: spend through both counts, and both refuse once it is used up', firstRefused > 0 && afterA.status === 429 && afterB.status === 429, `first refusal after ${firstRefused} calls (${seen.join(' ')}); then a ${afterA.status}, b ${afterB.status}; spent $${budget?.spent_usd} of $${budget?.limit_usd} (first call ${price}, ${spentOne} budget rows before)`);

  // An approval decided through one instance releases the call held on the other at once.
  const hk = (await a('POST', '/admin/api/keys', { name: 'cluster-held' })).body;
  const hold = (await a('POST', '/admin/api/rules', { name: 'cluster: hold', target_kind: 'model', match: { keys: [hk.id] }, effect: 'require_approval', config: { hold_ms: 30000 } })).body;
  await sleep(300);
  const t0 = Date.now();
  const held = chat(B.url, hk.key).then((r) => ({ ...r, ms: Date.now() - t0 }));
  let card: any;
  for (let i = 0; i < 40 && !card; i++) {
    card = ((await a('GET', '/admin/api/approvals?status=pending')).body.approvals as any[]).find((x) => x.key_id === hk.id);
    if (!card) await sleep(100);
  }
  const decidedAt = Date.now() - t0;
  await a('POST', `/admin/api/approvals/${card?.id}/decide`, { action: 'approve' });
  const r = await held;
  c('an approval decided through one instance releases the call held on the other at once', r.status === 200 && r.ms - decidedAt < 1500, `held on b, approved through a after ${(decidedAt / 1000).toFixed(1)} s; b answered ${r.status} ${r.ms - decidedAt} ms later`);
  await a('DELETE', `/admin/api/rules/${hold.id}`);

  // A console on one instance sees the traffic every instance serves.
  const login = await fetch(`${B.url}/admin/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin', password: AK }) });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
  const ws = new WebSocket(`${B.url.replace('http', 'ws')}/admin/ws`, { headers: { cookie } });
  const ticks: any[] = [];
  ws.on('message', (d: Buffer) => {
    const m = JSON.parse(String(d));
    if (m.type === 'tick') ticks.push(m);
  });
  await new Promise((res) => ws.once('open', res));
  await sleep(1500);
  const before = ticks.reduce((n, t) => n + t.totals.flights, 0);
  for (let i = 0; i < 5; i++) await chat(A.url, k.key);
  await sleep(2500);
  const fromA = ticks.reduce((n, t) => n + t.totals.flights, 0) - before;
  ws.close();
  c('a console on one instance sees the calls the other serves, live', fromA >= 5, `console on b counted ${fromA} of 5 calls made through a`);
  const topo = (await b('GET', '/admin/api/topology')).body;
  c('the map on either instance draws all the traffic', topo.edges.some((e: any) => e.key_id === k.id && e.requests >= 6), `edges for the agent on b: ${topo.edges.filter((e: any) => e.key_id === k.id).map((e: any) => e.requests).join(', ')}`);

  // The audit log to a SIEM: changes through both instances arrive once each, in order, sent by one of them.
  const dest = (await a('POST', '/admin/api/exports', { name: 'SIEM', kind: 'webhook', config: { url: siemUrl }, send_flights: false, send_audit: true })).body;
  const made: string[] = [];
  for (let i = 0; i < 10; i++) made.push((await (i % 2 ? b : a)('POST', '/admin/api/keys', { name: `cluster-audit-${i}` })).body.id);
  for (const id of made) await (made.indexOf(id) % 2 ? a : b)('DELETE', `/admin/api/keys/${id}`);
  const upTo = await newestSeq(a);
  const arrived = await siemHas(upTo, 20_000);
  const dupes = siemGot.length - new Set(siemGot).size;
  const inOrder = siemGot.every((x, i) => i === 0 || x === siemGot[i - 1]! + 1);
  const holder = ((await a('GET', '/admin/api/exports')).body.destinations as any[]).find((d) => d.id === dest.id)?.audit;
  c('the audit log reaches the SIEM once, in order, from changes made through both instances', arrived && dupes === 0 && inOrder && siemGot.length >= 21, `${siemGot.length} events (seq ${siemGot[0]}–${siemGot.at(-1)}), newest recorded ${upTo}, ${dupes} twice, ${inOrder ? 'in order' : 'out of order'}; status: ${holder?.last_status}, ${holder?.behind} behind`);

  // Agent identity: an issuer trusted through one instance; the other accepts its tokens, and stops when it's turned off.
  const signer = testSigner('cluster-idp');
  const ISS = 'https://idp.cluster.test';
  const ti = (await a('POST', '/admin/api/token-issuers', { name: 'Cluster IdP', issuer: ISS, jwks: { keys: [signer.jwk] }, audiences: ['controltower'], rules: [{ claims: { sub: 'svc-cluster' }, key_id: k.id }] })).body;
  await sleep(300);
  const tok = signJwt(signer, { iss: ISS, aud: 'controltower', sub: 'svc-cluster' });
  const viaToken = await chat(B.url, tok);
  await a('PATCH', `/admin/api/token-issuers/${ti.id}`, { enabled: false });
  await sleep(300);
  const afterOff = await chat(B.url, tok);
  c('a token issuer trusted through one instance is honoured by the other, and turning it off applies to both', viaToken.status === 200 && afterOff.status === 401, `token through b: ${viaToken.status} ${viaToken.code ?? ''}; after turning it off through a: ${afterOff.status}`);

  // An instance that crashes: the other closes out what it left open.
  const ck = (await a('POST', '/admin/api/keys', { name: 'cluster-crash' })).body;
  const ch = (await a('POST', '/admin/api/rules', { name: 'cluster: hold for crash', target_kind: 'model', match: { keys: [ck.id] }, effect: 'require_approval', config: { hold_ms: 30000 } })).body;
  await sleep(300);
  void chat(A.url, ck.key).catch(() => undefined);
  await sleep(1500);
  A.p.kill('SIGKILL');
  const orphan = async () => ((await b('GET', `/admin/api/flights?key_id=${ck.id}&limit=5`)).body.flights as any[])[0];
  const leftBy = await orphan();
  let swept: any;
  for (let i = 0; i < 40; i++) {
    swept = await orphan();
    if (swept?.status) break;
    await sleep(1000);
  }
  const card2 = ((await b('GET', '/admin/api/approvals?status=all&limit=20')).body.approvals as any[]).find((x) => x.key_id === ck.id);
  c('when an instance crashes, the other closes out the calls it left open', !leftBy?.status && swept?.status === 'shutdown', `call held on a when it was killed: ${leftBy?.status ?? 'no outcome'} → ${swept?.status ?? 'no outcome'} (${swept?.error_code ?? ''}); its card: ${card2?.status}`);
  await b('DELETE', `/admin/api/rules/${ch.id}`);
  const stillB = await chat(B.url, k.key);
  const rb = (await b('GET', '/admin/api/rules')).body;
  const rules = (Array.isArray(rb) ? rb : (rb.rules ?? [])).map((r: any) => r.name);
  // Whichever instance was sending to the SIEM, the survivor sends now.
  await b('POST', '/admin/api/keys', { name: 'cluster-audit-after-crash' });
  const afterCrash = await newestSeq(b);
  const tookOver = await siemHas(afterCrash, 45_000);
  c('when an instance crashes, the other goes on sending the audit log', tookOver, `newest ${afterCrash}, SIEM has up to ${Math.max(...siemGot)}; ${siemGot.length - new Set(siemGot).size} sent twice (allowed: delivery is at least once)`);
  c('the surviving instance keeps serving', stillB.status === 200, `call through b: ${stillB.status} ${stillB.code ?? ''} ${stillB.message}; gates: ${rules.join(', ')}`);

  // An instance with a different master key refuses to start.
  const C = start('c', 4803, { CT_MASTER_KEY: Buffer.alloc(32, 9).toString('base64') });
  const okC = await C.ready;
  await sleep(500);
  c('an instance with a different master key refuses to start', !okC && /different master key/.test(logs.c!.join('')), okC ? 'it started' : (logs.c!.join('').match(/this database was set up with a different master key[^\n]*/)?.[0] ?? logs.c!.join('').slice(-200)));
  C.p.kill('SIGKILL');
} finally {
  A.p.kill('SIGTERM');
  B.p.kill('SIGTERM');
  await oai.close();
  siem.close();
  fs.writeFileSync(`${DIR}/cluster-results.json`, JSON.stringify({ ran_at: new Date().toISOString(), checks }, null, 2));
  await sleep(1000);
}
console.log(`\n${checks.filter((x) => x.pass).length} of ${checks.length} passed`);
process.exit(checks.every((x) => x.pass) ? 0 : 1);
