#!/usr/bin/env node
/**
 * Load-test fleet: drives a running Control Tower the way a mid-market
 * organization would — many agents in many teams, several copies of each —
 * and measures the gateway and the Airspace under that load.
 *
 * Start a server in demo mode (for the stand-in models, MCP servers and HTTP
 * API; nothing leaves the machine), then:
 *
 *   CT_ADMIN_KEY=… CT_DEMO=1 pnpm start
 *   pnpm load:fleet --admin-key "$CT_ADMIN_KEY" --agents 1500 --rps 300 --duration 90
 *
 * Keys it creates are named load-*; each run replaces the previous run's.
 * Options: --url (http://localhost:4000), --agents, --types (60), --teams (12),
 * --rps, --duration (s), --out (load-report/), --no-browser.
 */
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
    return acc;
  }, []),
);
const URL_ = (args.url ?? 'http://localhost:4000').replace(/\/+$/, '');
const ADMIN = args['admin-key'] ?? process.env.CT_ADMIN_KEY;
const AGENTS = Number(args.agents ?? 1500);
const TYPES = Number(args.types ?? 60);
const TEAMS = Number(args.teams ?? 12);
const RPS = Number(args.rps ?? 300);
const DURATION = Number(args.duration ?? 60);
const OUT = path.resolve(args.out ?? 'load-report');
const BROWSER = args['no-browser'] !== 'true';
if (!ADMIN) {
  console.error('Pass --admin-key (or set CT_ADMIN_KEY): the fleet creates keys and reads /metrics with it.');
  process.exit(1);
}

const admin = async (p, init = {}) => {
  const r = await fetch(`${URL_}${p}`, { ...init, headers: { authorization: `Bearer ${ADMIN}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) } });
  const text = await r.text();
  if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${p} → ${r.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
};
const pool = async (items, n, fn) => {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
};
const quantile = (xs, q) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(q * xs.length))] : 0);

// ------------------------------------------------------------ the organization
const TEAM_NAMES = ['support', 'sales', 'marketing', 'finance', 'engineering', 'platform', 'security', 'data', 'legal', 'people', 'operations', 'product', 'procurement', 'research'];
const ROLES = ['triage', 'researcher', 'copilot', 'reviewer', 'summarizer', 'planner', 'writer', 'reconciler', 'auditor', 'router'];

const topo = await admin('/admin/api/topology');
const models = [...new Set(topo.deployments.filter((d) => d.enabled !== false).map((d) => d.public_name ?? d.upstream_model))];
const mcpTools = topo.mcp_servers.filter((m) => m.protocol !== 'http').flatMap((m) => (m.tools ?? []).filter((t) => t.op === 'read' || /^(search|list|get)/.test(t.name)).map((t) => `${m.slug}__${t.name}`));
const httpApis = topo.mcp_servers.filter((m) => m.protocol === 'http').map((m) => m.slug);
if (!models.length) {
  console.error('No models on this server. Start it with CT_DEMO=1 (stand-in models and tools) or connect a provider.');
  process.exit(1);
}

let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const types = Array.from({ length: TYPES }, (_, i) => {
  const team = TEAM_NAMES[i % Math.min(TEAMS, TEAM_NAMES.length)];
  const role = ROLES[Math.floor(i / Math.min(TEAMS, TEAM_NAMES.length)) % ROLES.length];
  const id = `${team}-${role}${i >= TEAMS * ROLES.length ? `-${i}` : ''}`;
  const usesTool = mcpTools.length && rand() < 0.35;
  const usesHttp = httpApis.length && rand() < 0.15;
  return { id, team, models: [pick(models), pick(models)], tool: usesTool ? pick(mcpTools) : null, http: usesHttp ? pick(httpApis) : null, weight: 1 / Math.pow(i + 1, 0.8), keys: [] };
});
// Copies per type: a few big agents, a long tail of small ones (at least one each).
const totalWeight = types.reduce((s, t) => s + t.weight, 0);
let assigned = 0;
for (const t of types) {
  t.copies = Math.max(1, Math.round((AGENTS - TYPES) * (t.weight / totalWeight)) + 1);
  assigned += t.copies;
}
types[0].copies += AGENTS - assigned;

// ------------------------------------------------------------ keys
fs.mkdirSync(OUT, { recursive: true });
const t0 = performance.now();
const existing = (await admin('/admin/api/keys')).keys.filter((k) => k.name.startsWith('load-'));
if (existing.length) {
  process.stdout.write(`Removing ${existing.length} keys from a previous run… `);
  await pool(existing, 16, (k) => admin(`/admin/api/keys/${k.id}`, { method: 'DELETE' }));
  console.log('done');
}
process.stdout.write(`Creating ${AGENTS} agent keys (${TYPES} agent types, ${Math.min(TEAMS, TEAM_NAMES.length)} teams)… `);
const jobs = types.flatMap((t) => Array.from({ length: t.copies }, (_, n) => ({ t, n })));
await pool(jobs, 16, async ({ t, n }) => {
  const k = await admin('/admin/api/keys', { method: 'POST', body: JSON.stringify({ name: `load-${t.id}-${String(n + 1).padStart(3, '0')}`, agent_id: t.id, team: t.team, project: 'load-test' }) });
  t.keys.push(k.key);
});
const keySeconds = (performance.now() - t0) / 1000;
console.log(`done in ${keySeconds.toFixed(1)} s`);

// ------------------------------------------------------------ traffic
const metricsText = async () => (await fetch(`${URL_}/metrics`, { headers: { authorization: `Bearer ${ADMIN}` } })).text();
const histogram = (text, name) => {
  const buckets = [];
  for (const m of text.matchAll(new RegExp(`^${name}_bucket\\{[^}]*le="([^"]+)"[^}]*\\} (\\d+(?:\\.\\d+)?)`, 'gm'))) buckets.push([m[1] === '+Inf' ? Infinity : Number(m[1]), Number(m[2])]);
  const merged = new Map();
  for (const [le, c] of buckets) merged.set(le, (merged.get(le) ?? 0) + c);
  return [...merged.entries()].sort((a, b) => a[0] - b[0]);
};
const histQuantile = (before, after, q) => {
  const diff = after.map(([le, c], i) => [le, c - (before[i]?.[1] ?? 0)]);
  const total = diff.at(-1)?.[1] ?? 0;
  if (!total) return null;
  const found = diff.find(([, c]) => c >= q * total);
  return found ? found[0] : null;
};
const metricsBefore = await metricsText();

const totalCopies = types.reduce((s, t) => s + t.copies, 0);
const latencies = [];
const statuses = new Map();
let sent = 0;
let inFlight = 0;
let dropped = 0;
const MAX_IN_FLIGHT = 4000;
const call = async () => {
  // Busier agent types send more: pick a type by its share of copies, then one of its keys.
  let r = rand() * totalCopies;
  let t = types[0];
  for (const x of types) if ((r -= x.copies) <= 0) { t = x; break; }
  const key = pick(t.keys);
  const roll = rand();
  let url;
  let init;
  if (t.tool && roll < 0.3) {
    url = `${URL_}/mcp`;
    init = { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: sent, method: 'tools/call', params: { name: t.tool, arguments: { query: 'Acme', repo: 'acme/payments-api', state: 'open' } } }) };
  } else if (t.http && roll < 0.45) {
    url = `${URL_}/http/${t.http}/api/v1/components`;
    init = { headers: { 'x-ct-key': key } };
  } else {
    url = `${URL_}/v1/chat/completions`;
    init = { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: pick(t.models), max_tokens: 24, messages: [{ role: 'user', content: `Summarise ticket ${sent} in one line.` }] }) };
  }
  if (inFlight >= MAX_IN_FLIGHT) return void dropped++;
  inFlight++;
  sent++;
  const start = performance.now();
  try {
    const res = await fetch(url, init);
    await res.arrayBuffer();
    statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
    if (latencies.length < 200_000) latencies.push(performance.now() - start);
  } catch (err) {
    statuses.set('network', (statuses.get('network') ?? 0) + 1);
  } finally {
    inFlight--;
  }
};

console.log(`Sending ${RPS} requests/s for ${DURATION} s…`);
const runStart = performance.now();
let owed = 0;
let last = runStart;
const ticker = setInterval(() => {
  const now = performance.now();
  owed += ((now - last) / 1000) * RPS;
  last = now;
  while (owed >= 1) {
    owed--;
    void call();
  }
}, 10);
const progress = setInterval(() => process.stdout.write(`  ${Math.round((performance.now() - runStart) / 1000)} s · ${sent} sent · ${inFlight} in flight\r`), 2000);

// ------------------------------------------------------------ the map, in a real browser, mid-run
let map = null;
if (BROWSER) {
  await new Promise((r) => setTimeout(r, Math.min(20, DURATION / 3) * 1000));
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  let step = 'open the console';
  try {
  await page.addInitScript(() => {
    const w = window;
    w.__ws = { messages: 0, bytes: 0, byType: {} };
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(...a) {
        super(...a);
        this.addEventListener('message', (e) => {
          w.__ws.messages++;
          const n = typeof e.data === 'string' ? e.data.length : 0;
          w.__ws.bytes += n;
          const type = (typeof e.data === 'string' && /"type":"(\w+)"/.exec(e.data.slice(0, 40))?.[1]) || 'other';
          const b = (w.__ws.byType[type] ??= { messages: 0, bytes: 0 });
          b.messages++;
          b.bytes += n;
        });
      }
    };
  });
  await page.goto(URL_, { timeout: 60_000 });
  step = 'sign in';
  const field = (label) => page.locator('.field', { has: page.locator('label', { hasText: label }) }).first().locator('input').first();
  await field(/^Email or username/).fill('admin');
  await field(/^Password/).fill(ADMIN);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForTimeout(1000);
  const opened = performance.now();
  step = 'draw the Airspace';
  await page.getByRole('link', { name: 'Airspace', exact: true }).click({ timeout: 60_000 });
  await page.waitForFunction(() => window.__ctScene && window.__ctScene.stations.size > 0, null, { timeout: 60_000, polling: 250 });
  const firstPaint = performance.now() - opened;
  await page.waitForTimeout(1500);
  const sample = await page.evaluate(async () => {
    const w = window;
    const ws0 = { ...w.__ws, byType: JSON.parse(JSON.stringify(w.__ws.byType)) };
    // Count the map's actual redraws (it only redraws when something changed).
    let draws = 0;
    const scene = w.__ctScene;
    const draw = scene.draw.bind(scene);
    scene.draw = () => {
      draws++;
      draw();
    };
    let frames = 0;
    const t0 = performance.now();
    await new Promise((res) => {
      const f = () => {
        frames++;
        if (performance.now() - t0 < 5000) requestAnimationFrame(f);
        else res();
      };
      requestAnimationFrame(f);
    });
    const secs = (performance.now() - t0) / 1000;
    const topo = performance.getEntriesByType('resource').filter((e) => e.name.includes('/admin/api/topology')).at(-1);
    const s = w.__ctScene;
    const stations = [...s.stations.values()];
    const bottom = Math.max(...stations.map((x) => x.y + x.h));
    return {
      fps: frames / secs,
      redraws_per_s: draws / secs,
      ws_messages_per_s: (w.__ws.messages - ws0.messages) / secs,
      ws_kb_per_s: (w.__ws.bytes - ws0.bytes) / 1024 / secs,
      ws_by_type: Object.fromEntries(
        Object.entries(w.__ws.byType).map(([t, v]) => [t, { per_s: Number(((v.messages - (ws0.byType[t]?.messages ?? 0)) / secs).toFixed(1)), kb_per_s: Number(((v.bytes - (ws0.byType[t]?.bytes ?? 0)) / 1024 / secs).toFixed(1)) }]),
      ),
      topology_ms: topo ? topo.duration : null,
      topology_kb: topo ? (topo.encodedBodySize || topo.transferSize) / 1024 : null,
      stations: stations.length,
      agent_stations: stations.filter((x) => x.kind === 'agent').length,
      map_height_px: Math.round(bottom),
      js_heap_mb: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null,
    };
  });
  map = { first_paint_ms: Math.round(firstPaint), ...sample };
  await page.screenshot({ path: path.join(OUT, 'airspace.png') });
  } catch (err) {
    map = { error: `could not ${step}: ${err.message.split('\n')[0]}` };
    await page.screenshot({ path: path.join(OUT, 'airspace.png') }).catch(() => undefined);
  }
  await browser.close();
}

await new Promise((r) => setTimeout(r, Math.max(0, DURATION * 1000 - (performance.now() - runStart))));
clearInterval(ticker);
clearInterval(progress);
while (inFlight > 0) await new Promise((r) => setTimeout(r, 100));
const elapsed = (performance.now() - runStart) / 1000;
const metricsAfter = await metricsText();

// ------------------------------------------------------------ report
latencies.sort((a, b) => a - b);
const overheadBefore = histogram(metricsBefore, 'controltower_gateway_overhead_seconds');
const overheadAfter = histogram(metricsAfter, 'controltower_gateway_overhead_seconds');
const ok = [...statuses.entries()].filter(([s]) => typeof s === 'number' && s < 400).reduce((n, [, c]) => n + c, 0);
const report = {
  at: new Date().toISOString(),
  server: URL_,
  fleet: { agents: AGENTS, agent_types: TYPES, teams: Math.min(TEAMS, TEAM_NAMES.length), biggest_type: `${types[0].id} ×${types[0].copies}`, key_setup_s: Number(keySeconds.toFixed(1)) },
  traffic: {
    target_rps: RPS,
    achieved_rps: Number((sent / elapsed).toFixed(1)),
    requests: sent,
    ok_share: Number((ok / Math.max(1, sent)).toFixed(4)),
    statuses: Object.fromEntries(statuses),
    skipped_over_4000_in_flight: dropped,
    client_latency_ms: { p50: Math.round(quantile(latencies, 0.5)), p95: Math.round(quantile(latencies, 0.95)), p99: Math.round(quantile(latencies, 0.99)) },
    gateway_overhead_ms: { p50: histQuantile(overheadBefore, overheadAfter, 0.5) * 1000, p99: histQuantile(overheadBefore, overheadAfter, 0.99) * 1000 },
  },
  map,
};
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
const row = (k, v) => `| ${k} | ${v} |`;
const md = [
  `# Load test — ${AGENTS} agents, ${RPS} req/s target`,
  '',
  '| | |',
  '|---|---|',
  row('Agents / types / teams', `${AGENTS} / ${TYPES} / ${report.fleet.teams} (largest: ${report.fleet.biggest_type})`),
  row('Achieved rate', `${report.traffic.achieved_rps} req/s (${sent} requests, ${(report.traffic.ok_share * 100).toFixed(1)}% ok)`),
  row('Client latency p50 / p95 / p99', `${report.traffic.client_latency_ms.p50} / ${report.traffic.client_latency_ms.p95} / ${report.traffic.client_latency_ms.p99} ms`),
  row('Gateway overhead p50 / p99', `≤ ${report.traffic.gateway_overhead_ms.p50} / ≤ ${report.traffic.gateway_overhead_ms.p99} ms`),
  row('Statuses', Object.entries(report.traffic.statuses).map(([s, c]) => `${s}: ${c}`).join(', ')),
  ...(map?.error ? [row('Map', map.error)] : []),
  ...(map && !map.error
    ? [
        row('Map: first draw', `${map.first_paint_ms} ms`),
        row('Map: topology request', `${map.topology_ms?.toFixed(0)} ms, ${map.topology_kb?.toFixed(0)} KB`),
        row('Map: stations (agents)', `${map.stations} (${map.agent_stations})`),
        row('Map: height', `${map.map_height_px} px (viewport 900)`),
        row('Map: frame rate', `${map.fps.toFixed(0)} fps (map redrawn ${map.redraws_per_s.toFixed(1)}×/s)`),
        row('Map: live updates', `${map.ws_messages_per_s.toFixed(0)} messages/s, ${map.ws_kb_per_s.toFixed(0)} KB/s (${Object.entries(map.ws_by_type).map(([t, v]) => `${t}: ${v.per_s}/s, ${v.kb_per_s} KB/s`).join('; ')})`),
        row('Map: JS heap', map.js_heap_mb ? `${map.js_heap_mb.toFixed(0)} MB` : 'n/a'),
      ]
    : []),
  '',
].join('\n');
fs.writeFileSync(path.join(OUT, 'report.md'), md);
console.log(`\n\n${md}\nReport: ${path.relative(process.cwd(), OUT)}/report.md (and report.json${map ? ', airspace.png' : ''})`);
