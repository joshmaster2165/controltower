import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FlightEvent } from '@controltower/shared';
import { openSqlite } from '../src/db/index.js';
import { SecretBox } from '../src/crypto/secrets.js';
import { Versioned } from '../src/util/versioned.js';
import { AlertService, signBody, slackMessage, targetHint } from '../src/alerts/alerts.js';

const box = new SecretBox({ key: crypto.randomBytes(32), id: 'test', source: 'env' });
const quiet = { warn: () => undefined };

interface Setup {
  svc: AlertService;
  db: ReturnType<typeof openSqlite>;
  clock: { t: number };
  sent: Array<{ url: string; headers: Record<string, string>; body: string }>;
}

async function setup(opts: { respond?: (n: number) => number } = {}): Promise<Setup> {
  const db = openSqlite('', { memory: true });
  const clock = { t: 1_000_000 };
  const sent: Setup['sent'] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
    const status = opts.respond?.(sent.length) ?? 200;
    return new Response('ok', { status });
  }) as unknown as typeof fetch;
  const svc = new AlertService(db.write, box, new Versioned(), {
    publicUrl: 'https://tower.example.com',
    gate: (id) => ({ rule_demo: { name: 'Sandbox may not merge code', effect: 'deny' }, rule_hold: { name: 'Deleting contacts needs approval', effect: 'require_approval' } })[id],
    log: () => quiet,
    fetch: fakeFetch,
    now: () => clock.t,
    retryDelaysMs: [0, 0],
    names: (kind, id) => ({ dep_a: 'model-a', dep_b: 'model-b', k_team: 'team-bot' })[id],
    budget: (scope) => budgets.get(scope),
  });
  return { svc, db, clock, sent };
}

function addRule(db: Setup['db'], id: string, over: Partial<{ kind: string; params: Record<string, unknown>; rule_id: string | null; triggers: string[]; threshold: number; window_s: number; cooldown_s: number; channels: string[] }> = {}): void {
  db.raw
    .prepare(`INSERT INTO alert_rules (id, name, kind, params, rule_id, triggers, threshold, window_s, cooldown_s, channels, enabled, demo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, 0)`)
    .run(id, id, over.kind ?? 'gate', JSON.stringify(over.params ?? {}), over.rule_id === undefined ? 'rule_demo' : over.rule_id, JSON.stringify(over.triggers ?? ['blocked']), over.threshold ?? 1, over.window_s ?? 300, over.cooldown_s ?? 0, JSON.stringify(over.channels ?? []));
}

function addChannel(s: Setup, id: string, kind: 'slack' | 'webhook', url: string, secret?: string): void {
  s.db.raw
    .prepare(`INSERT INTO alert_channels (id, name, kind, config_enc, target_hint, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, '', 1, 0, 0)`)
    .run(id, id, kind, s.svc.encryptConfig(id, { url, secret }));
}

const budgets = new Map<string, { limitNanousd: number; spentNanousd: number; resetsAt: number | undefined; period: string }>();

let seq = 0;
/** One flight through a gate: started → decision (→ resolved) → completed. */
function flight(s: Setup, agent: string, dest: string, decision: 'deny' | 'hold' | 'allow', gate = 'rule_demo', resolved?: 'approved' | 'denied' | 'ticketed'): string {
  const id = `f${++seq}`;
  const ts = s.clock.t;
  const ev: FlightEvent[] = [
    { t: 'flight.started', flight_id: id, ts, key_id: agent, key_name: agent, kind: 'mcp.tool', dialect: 'mcp', stream: false, model_requested: dest, tool: dest, est_input_tokens: 1, projected_nanousd: 0 },
    { t: 'flight.decision', flight_id: id, ts, decision, rule_id: gate, reason: decision === 'deny' ? 'Sandbox agents may not merge pull requests' : undefined },
  ];
  if (decision === 'hold') ev.push({ t: 'flight.held', flight_id: id, ts, approval_id: `appr_${id}`, budget_ms: 20000, summary: `${agent} wants ${dest}` });
  if (resolved) ev.push({ t: 'flight.resolved', flight_id: id, ts, approval_id: 'a', outcome: resolved, by: 'dana@example.com' });
  ev.push({ t: 'flight.completed', flight_id: id, ts, status: decision === 'allow' || resolved === 'approved' ? 'ok' : 'denied', http_status: 200, usage_source: 'unknown', cost_nanousd: null, cost_confidence: 'unknown', duration_ms: 1, gateway_overhead_ms: 0 });
  for (const e of ev) s.svc.push(e);
  return id;
}

function fired(s: Setup) {
  return s.db.raw.prepare(`SELECT alert_rule_id, trigger, title, count, detail, deliveries FROM alerts ORDER BY last_at, rowid`).all() as Array<{ alert_rule_id: string; trigger: string; title: string; count: number; detail: string; deliveries: string }>;
}

describe('gate alerts', () => {
  it('fires on every trigger of its gate and ignores other gates and triggers', async () => {
    const s = await setup();
    addRule(s.db, 'every');
    await s.svc.reload();
    flight(s, 'rogue-intern', 'repo__merge_pr', 'deny');
    flight(s, 'rogue-intern', 'repo__merge_pr', 'allow'); // wrong trigger
    flight(s, 'rogue-intern', 'crm__delete_contact', 'deny', 'rule_hold'); // wrong gate
    await s.svc.settle();
    const a = fired(s);
    expect(a).toHaveLength(1);
    expect(a[0]!.title).toBe('Sandbox may not merge code: rogue-intern → repo__merge_pr blocked');
    expect(JSON.parse(a[0]!.detail).reason).toBe('Sandbox agents may not merge pull requests');
  });

  it('waits for N hits inside the window, then stays quiet for the cooldown and sends one digest', async () => {
    const s = await setup();
    addRule(s.db, 'burst', { threshold: 3, window_s: 60, cooldown_s: 1 });
    await s.svc.reload();

    flight(s, 'a', 'repo__merge_pr', 'deny');
    s.clock.t += 61_000; // first hit falls out of the window
    flight(s, 'a', 'repo__merge_pr', 'deny');
    flight(s, 'b', 'repo__merge_pr', 'deny');
    await s.svc.settle();
    expect(fired(s)).toHaveLength(0);

    flight(s, 'a', 'repo__merge_pr', 'deny');
    await s.svc.settle();
    expect(fired(s)).toHaveLength(1);
    expect(fired(s)[0]!.title).toBe('Sandbox may not merge code: 3 requests blocked in the last 1 min');
    expect(JSON.parse(fired(s)[0]!.detail).agents).toEqual([{ name: 'a', count: 2 }, { name: 'b', count: 1 }]);

    // Five more during the cooldown: no alert now, one digest when it ends.
    for (let i = 0; i < 5; i++) flight(s, 'a', 'repo__merge_pr', 'deny');
    await s.svc.settle();
    expect(fired(s)).toHaveLength(1);
    s.clock.t += 1000;
    await new Promise((r) => setTimeout(r, 1100));
    await s.svc.settle();
    const all = fired(s);
    expect(all).toHaveLength(2);
    expect(all[1]!.count).toBe(5);
    expect(all[1]!.title).toBe('Sandbox may not merge code: 5 more requests blocked since the last alert');
    s.svc.stop();
  });

  it('follows a held request to its outcome', async () => {
    const s = await setup();
    addRule(s.db, 'outcomes', { rule_id: 'rule_hold', triggers: ['approved', 'rejected', 'unanswered'] });
    await s.svc.reload();
    flight(s, 'sdr-agent', 'crm__delete_contact', 'hold', 'rule_hold', 'approved');
    flight(s, 'sdr-agent', 'crm__delete_contact', 'hold', 'rule_hold', 'denied');
    flight(s, 'sdr-agent', 'crm__delete_contact', 'hold', 'rule_hold', 'ticketed');
    await s.svc.settle();
    expect(fired(s).map((a) => a.trigger)).toEqual(['approved', 'rejected', 'unanswered']);
    expect(fired(s)[1]!.title).toBe('Deleting contacts needs approval: sdr-agent → crm__delete_contact rejected by an approver');
  });

  it('an any-gate rule watches every gate', async () => {
    const s = await setup();
    addRule(s.db, 'any', { rule_id: null, triggers: ['blocked', 'held'] });
    await s.svc.reload();
    flight(s, 'x', 'repo__merge_pr', 'deny', 'rule_demo');
    flight(s, 'y', 'crm__delete_contact', 'hold', 'rule_hold');
    await s.svc.settle();
    expect(fired(s).map((a) => a.title)).toEqual([
      'Sandbox may not merge code: x → repo__merge_pr blocked',
      'Deleting contacts needs approval: y → crm__delete_contact held for approval',
    ]);
  });

  it('delivers a signed webhook and a Slack message, recording the result', async () => {
    const s = await setup();
    addChannel(s, 'hook', 'webhook', 'https://hooks.example.com/ct', 'whsec_test');
    addChannel(s, 'slack', 'slack', 'https://hooks.slack.com/services/T0/B0/xyz');
    addRule(s.db, 'notify', { channels: ['hook', 'slack'] });
    await s.svc.reload();
    flight(s, 'rogue-intern', 'repo__merge_pr', 'deny');
    await s.svc.settle();

    expect(s.sent).toHaveLength(2);
    const hook = s.sent.find((x) => x.url.startsWith('https://hooks.example.com'))!;
    const [t, v1] = hook.headers['x-ct-signature']!.split(',').map((p) => p.split('=')[1]!);
    expect(v1).toBe(signBody('whsec_test', Number(t), hook.body));
    const payload = JSON.parse(hook.body);
    expect(payload).toMatchObject({ type: 'controltower.alert', trigger: 'blocked', count: 1, gate: { id: 'rule_demo', effect: 'deny' }, console_url: 'https://tower.example.com/#/alerts' });
    // Structural redaction: no arguments or bodies travel in an alert.
    expect(hook.body).not.toMatch(/arguments|prompt|messages/);

    const slack = JSON.parse(s.sent.find((x) => x.url.includes('slack'))!.body);
    expect(slack.text).toContain('rogue-intern → repo__merge_pr blocked');
    expect(slack.blocks[2].elements[0].url).toBe('https://tower.example.com/#/alerts');

    const deliveries = JSON.parse(fired(s)[0]!.deliveries) as Array<{ ok: boolean; attempts: number }>;
    expect(deliveries.every((d) => d.ok && d.attempts === 1)).toBe(true);
  });

  it('retries 5xx, gives up on 4xx', async () => {
    const s = await setup({ respond: (n) => (n === 1 ? 503 : n === 2 ? 200 : 404) });
    addChannel(s, 'hook', 'webhook', 'https://hooks.example.com/ct');
    addRule(s.db, 'r', { channels: ['hook'] });
    await s.svc.reload();
    flight(s, 'a', 'repo__merge_pr', 'deny');
    await s.svc.settle();
    expect(JSON.parse(fired(s)[0]!.deliveries)[0]).toMatchObject({ ok: true, attempts: 2 });
    flight(s, 'a', 'repo__merge_pr', 'deny');
    await s.svc.settle();
    expect(JSON.parse(fired(s)[1]!.deliveries)[0]).toMatchObject({ ok: false, status: 404, attempts: 1 });
    const ch = s.db.raw.prepare(`SELECT last_status, last_error FROM alert_channels`).get();
    expect(ch).toEqual({ last_status: 'error', last_error: 'HTTP 404' });
  });

  it('really POSTs over HTTP', async () => {
    const got: string[] = [];
    const server = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        got.push(b);
        res.end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
    const db = openSqlite('', { memory: true });
    const svc = new AlertService(db.write, box, new Versioned(), { gate: () => undefined, log: () => quiet });
    db.raw.prepare(`INSERT INTO alert_channels (id, name, kind, config_enc, target_hint, enabled, created_at, updated_at) VALUES ('c', 'c', 'webhook', ?, '', 1, 0, 0)`).run(svc.encryptConfig('c', { url }));
    await svc.reload();
    const d = await svc.test('c');
    server.close();
    expect(d).toMatchObject({ ok: true, status: 200 });
    expect(JSON.parse(got[0]!)).toMatchObject({ type: 'controltower.alert', test: true });
  });

  it('shows channels by host and a short tail only', () => {
    expect(targetHint('https://hooks.slack.com/services/T000/B000/abcdefgh')).toBe('hooks.slack.com/…efgh');
    expect(slackMessage({ title: '<b>&', agents: [], destinations: [], reason: null, alert_rule: { name: 'r' }, gate: null, console_url: null } as never).blocks).toHaveLength(2);
  });
});

function upstream(s: Setup, dep: string, outcome: 'ok' | 'error' | 'fallback', status?: number, code?: string): void {
  s.svc.push({ t: 'flight.upstream', flight_id: `u${++seq}`, ts: s.clock.t, attempt: 1, deployment_id: dep, provider_id: 'prov', upstream_model: dep, outcome, status, error_code: code });
}

function completed(s: Setup, over: { status?: 'ok' | 'error'; duration_ms?: number; cost?: number; key?: string; team?: string; dep?: string; code?: string } = {}): void {
  const id = `c${++seq}`;
  s.svc.push({ t: 'flight.started', flight_id: id, ts: s.clock.t, key_id: over.key ?? 'k_team', key_name: 'team-bot', team: over.team, kind: 'chat', dialect: 'openai-chat', stream: false, model_requested: 'fast', deployment_id: over.dep ?? 'dep_a', est_input_tokens: 1, projected_nanousd: 0 });
  s.svc.push({ t: 'flight.completed', flight_id: id, ts: s.clock.t, status: over.status ?? 'ok', http_status: 200, usage_source: 'provider', cost_nanousd: over.cost ?? 0, cost_confidence: 'exact', duration_ms: over.duration_ms ?? 100, gateway_overhead_ms: 1, error: over.code ? { code: over.code, message: 'x' } : undefined });
}

describe('approval links', () => {
  it('links a single held request to its approval card, and Slack gets a Review & approve button', async () => {
    const s = await setup();
    addChannel(s, 'slack', 'slack', 'https://hooks.slack.com/services/T0/B0/xyz');
    addRule(s.db, 'held', { rule_id: 'rule_hold', triggers: ['held'], channels: ['slack'] });
    await s.svc.reload();
    const id = flight(s, 'sdr-agent', 'crm__delete_contact', 'hold', 'rule_hold');
    await s.svc.settle();
    const detail = JSON.parse(fired(s)[0]!.detail);
    expect(detail.approval).toEqual({ id: `appr_${id}`, scope: 'Approve ONE call to crm__delete_contact from sdr-agent', url: `https://tower.example.com/#/tower/appr_${id}` });
    const slack = JSON.parse(s.sent[0]!.body);
    expect(slack.blocks[0].text.text).toContain('*Decision needed:* Approve ONE call to crm__delete_contact from sdr-agent');
    expect(slack.blocks[2].elements[0]).toMatchObject({ text: { text: 'Review & approve' }, url: `https://tower.example.com/#/tower/appr_${id}`, style: 'primary' });
  });
});

describe('operational alerts', () => {
  it('detects an outage per deployment from 5xx/timeouts only, then its recovery', async () => {
    const s = await setup();
    addRule(s.db, 'health', { kind: 'health', rule_id: null, triggers: ['outage', 'recovered'], threshold: 3, window_s: 60, cooldown_s: 600 });
    await s.svc.reload();
    upstream(s, 'dep_a', 'error', 429); // rate limits are not outages
    upstream(s, 'dep_a', 'error', 400);
    upstream(s, 'dep_a', 'fallback', 503);
    upstream(s, 'dep_b', 'error', 500); // a different deployment has its own window
    upstream(s, 'dep_a', 'error', undefined, 'provider_timeout');
    await s.svc.settle();
    expect(fired(s)).toHaveLength(0);
    upstream(s, 'dep_a', 'error', 502);
    upstream(s, 'dep_b', 'ok');
    await s.svc.settle();
    expect(fired(s).map((a) => a.title)).toEqual(['model-a may be down: 3 upstream failures in 1 min']);
    upstream(s, 'dep_a', 'ok');
    upstream(s, 'dep_a', 'ok');
    await s.svc.settle();
    expect(fired(s).map((a) => a.title)).toEqual(['model-a may be down: 3 upstream failures in 1 min', 'model-a recovered: requests are succeeding again']);
  });

  it('counts failed and slow requests', async () => {
    const s = await setup();
    addRule(s.db, 'errors', { kind: 'errors', rule_id: null, triggers: ['failed'], threshold: 2 });
    addRule(s.db, 'slow', { kind: 'latency', rule_id: null, triggers: ['slow'], threshold: 1, params: { slow_ms: 5000 } });
    await s.svc.reload();
    completed(s, { status: 'error', code: 'provider_error' });
    completed(s, { duration_ms: 4000 });
    completed(s, { status: 'error', code: 'provider_timeout' });
    completed(s, { duration_ms: 12_500 });
    await s.svc.settle();
    expect(fired(s).map((a) => a.title)).toEqual(['2 requests failed in the last 5 min', 'team-bot → fast took 12.5 s']);
  });

  it('warns once per budget period at the threshold and again when it runs out', async () => {
    const s = await setup();
    addRule(s.db, 'budget', { kind: 'budget', rule_id: null, triggers: ['budget_warning', 'budget_exceeded'], params: { warn_pct: 80 } });
    await s.svc.reload();
    const b = { limitNanousd: 10e9, spentNanousd: 5e9, resetsAt: Date.UTC(2026, 9, 1), period: 'monthly' };
    budgets.set('team:growth', b);
    completed(s, { team: 'growth', cost: 1 });
    b.spentNanousd = 8.5e9;
    completed(s, { team: 'growth', cost: 1 });
    completed(s, { team: 'growth', cost: 1 }); // same period: no repeat
    b.spentNanousd = 10.2e9;
    completed(s, { team: 'growth', cost: 1 });
    b.resetsAt = Date.UTC(2026, 10, 1);
    b.spentNanousd = 8.1e9;
    completed(s, { team: 'growth', cost: 1 }); // new period re-arms the warning
    await s.svc.settle();
    const a = fired(s);
    expect(a.map((x) => x.title)).toEqual(['Budget for team growth is nearly used', 'Budget exhausted for team growth', 'Budget for team growth is nearly used']);
    expect(JSON.parse(a[0]!.detail).lines[0]).toBe('85% used: $8.50 of $10.00 (monthly, resets 2026-10-01)');
    budgets.clear();
  });

  it('sends a daily summary once, at its hour, from the flight log', async () => {
    const s = await setup();
    s.clock.t = Date.UTC(2026, 8, 22, 8, 5);
    addRule(s.db, 'digest', { kind: 'digest', rule_id: null, triggers: ['daily'], params: { hour: 8 } });
    const ins = s.db.raw.prepare(`INSERT INTO flights (id, ts, key_id, key_name, kind, dialect, model_requested, deployment_id, status, cost_nanousd, in_tokens, out_tokens, duration_ms, stream) VALUES (?, ?, 'k', ?, 'chat', 'openai-chat', 'fast', 'dep_a', ?, ?, 10, 20, ?, 0)`);
    ins.run('f1', s.clock.t - 1000, 'researcher', 'ok', 2e9, 1200);
    ins.run('f2', s.clock.t - 2000, 'researcher', 'denied', 0, 5);
    ins.run('f3', s.clock.t - 3000, 'ops-agent', 'error', 0, 30);
    ins.run('old', s.clock.t - 2 * 86_400_000, 'ops-agent', 'ok', 9e9, 10);
    await s.svc.reload();
    await s.svc.runScheduled();
    await s.svc.runScheduled();
    await s.svc.settle();
    const a = fired(s);
    expect(a).toHaveLength(1);
    expect(a[0]!.title).toBe('Daily summary: 3 requests · $2.00 · 1 blocked · 1 errors');
    expect(JSON.parse(a[0]!.detail).lines).toEqual([
      'Requests: 3 · tokens: 90 · spend: $2.00',
      'Enforcement: 1 blocked · 0 held for approval · 0 masked or flagged',
      'Errors: 1 · alerts fired: 0',
      'Top spend: researcher $2.00',
      'Most failures: model-a (1)',
      'Slowest: model-a 1.2 s avg',
    ]);
  });
});
