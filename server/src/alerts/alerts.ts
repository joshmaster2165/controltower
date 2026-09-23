import crypto from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { ulid } from 'ulid';
import type { FlightEvent } from '@controltower/shared';
import { formatUsd } from '@controltower/shared';
import type { Database } from '../db/schema.js';
import type { SecretBox } from '../crypto/secrets.js';
import type { Versioned } from '../util/versioned.js';

/**
 * Alerting. An alert rule watches one kind of thing and fires when it has seen
 * `threshold` matching events inside `window_s`. After firing it stays quiet
 * for `cooldown_s`; what happens meanwhile is rolled into one digest when the
 * cooldown ends, so a looping agent produces one message, not 500.
 *
 *   gate     — a gate blocked / held / masked … a request (one gate or every gate)
 *   health   — a model deployment or MCP server keeps failing upstream (and recovers)
 *   errors   — requests are failing for agents, after fallbacks
 *   latency  — requests are taking longer than a threshold
 *   budget   — a key / team / project budget crossed a percentage or ran out
 *   digest   — a daily summary of traffic, spend, enforcement and failures
 *
 * Windows and cooldowns are kept per subject (per deployment for `health`), so
 * one bad deployment cannot mute alerts about another.
 *
 * Every fired alert lands in the console inbox; channels (Slack, signed
 * webhooks) are optional extra destinations. Alerts carry names and counts
 * only — never request arguments, bodies or credentials.
 *
 * `push` runs on the flight bus and is synchronous and cheap; storage, queries
 * and delivery happen off the hot path.
 */

export const ALERT_KINDS = ['gate', 'health', 'errors', 'latency', 'budget', 'digest'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export const ALERT_TRIGGERS = [
  'blocked',
  'held',
  'approved',
  'rejected',
  'unanswered',
  'allowed',
  'scope_mismatch',
  'masked',
  'flagged',
  'outage',
  'recovered',
  'failed',
  'slow',
  'budget_warning',
  'budget_exceeded',
  'daily',
] as const;
export type AlertTrigger = (typeof ALERT_TRIGGERS)[number];

/** Which triggers make sense for each kind. */
export const KIND_TRIGGERS: Record<AlertKind, AlertTrigger[]> = {
  gate: ['blocked', 'held', 'approved', 'rejected', 'unanswered', 'allowed', 'scope_mismatch', 'masked', 'flagged'],
  health: ['outage', 'recovered'],
  errors: ['failed'],
  latency: ['slow'],
  budget: ['budget_warning', 'budget_exceeded'],
  digest: ['daily'],
};

const PAST: Record<AlertTrigger, string> = {
  blocked: 'blocked',
  held: 'held for approval',
  approved: 'approved',
  rejected: 'rejected by an approver',
  unanswered: 'not answered in time',
  allowed: 'allowed',
  scope_mismatch: 'replayed an approval with different arguments',
  masked: 'had sensitive content masked',
  flagged: 'flagged for sensitive content',
  outage: 'failed upstream',
  recovered: 'recovered',
  failed: 'failed',
  slow: 'were slow',
  budget_warning: 'budget warning',
  budget_exceeded: 'budget exhausted',
  daily: 'daily summary',
};

export interface AlertParams {
  /** health/errors/latency/budget: limit to these ids (deployments, MCP servers, keys, `team:x`…). Empty = all. */
  targets?: string[] | undefined;
  /** latency: what counts as slow. */
  slow_ms?: number | undefined;
  /** budget: warn at this percentage of the limit. */
  warn_pct?: number | undefined;
  /** digest: hour of day (UTC) to send it. */
  hour?: number | undefined;
}

export type ChannelKind = 'slack' | 'webhook';

export interface AlertRuleRecord {
  id: string;
  name: string;
  kind: AlertKind;
  ruleId: string | null;
  triggers: AlertTrigger[];
  threshold: number;
  windowS: number;
  cooldownS: number;
  channels: string[];
  params: AlertParams;
  enabled: boolean;
  demo: boolean;
  lastFiredAt: number | null;
}

export interface ChannelConfig {
  url: string;
  secret?: string | undefined;
}

interface ChannelRecord {
  id: string;
  name: string;
  kind: ChannelKind;
  config: ChannelConfig;
  enabled: boolean;
}

type SubjectKind = 'gate' | 'deployment' | 'mcp' | 'key' | 'budget' | 'fleet';

interface Hit {
  ts: number;
  flightId: string;
  subject: { kind: SubjectKind; id: string };
  trigger: AlertTrigger;
  agent: string;
  dest: string;
  reason: string | undefined;
  /** Set for `held`: the approval a human can act on. */
  approvalId?: string | undefined;
  isTool?: boolean | undefined;
}

interface RuleState {
  hits: Hit[];
  cooldownUntil: number;
  suppressed: Hit[];
  timer: NodeJS.Timeout | undefined;
}

export interface Delivery {
  channel_id: string;
  name: string;
  kind: ChannelKind;
  ok: boolean;
  status?: number | undefined;
  error?: string | undefined;
  attempts: number;
  at: number;
}

export interface AlertPayload {
  type: 'controltower.alert';
  id: string;
  kind: AlertKind;
  title: string;
  trigger: AlertTrigger | 'mixed';
  count: number;
  digest: boolean;
  window_s: number;
  first_at: string;
  last_at: string;
  alert_rule: { id: string; name: string };
  /** What the alert is about: a gate, a deployment, an MCP server, a budget scope, or the whole fleet. */
  subject: { kind: SubjectKind; id: string; name: string } | null;
  gate: { id: string; name: string; effect: string } | null;
  agents: Array<{ name: string; count: number }>;
  destinations: Array<{ name: string; count: number }>;
  reason: string | null;
  /** Extra facts, one per line (budget figures, digest contents). */
  lines: string[];
  flights: string[];
  /** For a single held request: the approval to review. Approving always happens signed in, in the console. */
  approval: { id: string; scope: string; url: string | null } | null;
  console_url: string | null;
  test?: boolean;
}

export interface GateInfo {
  name: string;
  effect: string;
}

export interface BudgetInfo {
  limitNanousd: number;
  spentNanousd: number;
  resetsAt: number | undefined;
  period: string;
}

interface Logger {
  warn(obj: unknown, msg?: string): void;
}

export interface AlertServiceOptions {
  publicUrl?: string | undefined;
  gate: (ruleId: string) => GateInfo | undefined;
  /** Display names for deployments, MCP servers and keys. */
  names?: ((kind: 'deployment' | 'mcp' | 'key', id: string) => string | undefined) | undefined;
  /** Current state of a budget scope such as `key:<id>` or `team:<name>`. */
  budget?: ((scope: string) => BudgetInfo | undefined) | undefined;
  log: () => Logger;
  fetch?: typeof fetch;
  now?: () => number;
  /** Delays between delivery attempts; attempts = length + 1. */
  retryDelaysMs?: number[];
  timeoutMs?: number;
}

const MAX_TRACKED = 20_000;
const RETENTION_MS = 30 * 86_400_000;
const DEFAULT_SLOW_MS = 30_000;
const DEFAULT_WARN_PCT = 80;

export function fmtDuration(s: number): string {
  if (s % 3600 === 0 && s >= 3600) return `${s / 3600} h`;
  if (s % 60 === 0 && s >= 60) return `${s / 60} min`;
  return `${s} s`;
}

function tally(xs: string[]): Array<{ name: string; count: number }> {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 8);
}

/** host + last 4 of the path: enough to recognise a channel, useless to an attacker. */
export function targetHint(url: string): string {
  try {
    const u = new URL(url);
    const tail = (u.pathname + u.search).replace(/\/+$/, '');
    return tail.length > 6 ? `${u.host}/…${tail.slice(-4)}` : `${u.host}${tail}`;
  } catch {
    return '';
  }
}

export function signBody(secret: string, ts: number, body: string): string {
  return crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
}

/** Upstream failures that indicate the provider is unwell: timeouts, network errors and 5xx — not 4xx or 429. */
export function isOutageFailure(status: number | undefined, code: string | undefined): boolean {
  if (status === undefined) return code !== undefined;
  return status >= 500 || status === 408;
}

interface FlightInfo {
  agent: string;
  keyId: string;
  team: string | undefined;
  project: string | undefined;
  dest: string;
  targetId: string | undefined;
  isTool: boolean;
  gateId?: string | undefined;
}

export class AlertService {
  rules: AlertRuleRecord[] = [];
  private channels = new Map<string, ChannelRecord>();
  /** Window/cooldown state per `${alertRuleId}|${subject}`. */
  private state = new Map<string, RuleState>();
  /** health: subjects currently in an alerted outage, per rule. */
  private down = new Set<string>();
  /** budget: `${rule}|${scope}|${trigger}|${period end}` already alerted this period. */
  private budgetSent = new Set<string>();
  private flights = new Map<string, FlightInfo>();
  private janitor: NodeJS.Timeout | undefined;
  private scheduler: NodeJS.Timeout | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  /** Pending deliveries, so tests (and shutdown) can wait for them. */
  private inflight = new Set<Promise<unknown>>();

  constructor(
    private db: Kysely<Database>,
    private secrets: SecretBox,
    private version: Versioned,
    private opts: AlertServiceOptions,
  ) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  async reload(): Promise<void> {
    const [rules, channels] = await Promise.all([this.db.selectFrom('alert_rules').selectAll().execute(), this.db.selectFrom('alert_channels').selectAll().execute()]);
    this.rules = rules.map((r) => ({
      id: r.id,
      name: r.name,
      kind: (ALERT_KINDS as readonly string[]).includes(r.kind) ? (r.kind as AlertKind) : 'gate',
      ruleId: r.rule_id,
      triggers: (JSON.parse(r.triggers) as string[]).filter((t): t is AlertTrigger => (ALERT_TRIGGERS as readonly string[]).includes(t)),
      threshold: Math.max(1, r.threshold),
      windowS: Math.max(1, r.window_s),
      cooldownS: Math.max(0, r.cooldown_s),
      channels: JSON.parse(r.channels) as string[],
      params: JSON.parse(r.params || '{}') as AlertParams,
      enabled: r.enabled === 1,
      demo: r.demo === 1,
      lastFiredAt: r.last_fired_at,
    }));
    const next = new Map<string, ChannelRecord>();
    for (const c of channels) {
      try {
        const config = JSON.parse(this.secrets.decrypt(c.config_enc, `alert_channels.config_enc.${c.id}`)) as ChannelConfig;
        next.set(c.id, { id: c.id, name: c.name, kind: c.kind as ChannelKind, config, enabled: c.enabled === 1 });
      } catch (err) {
        this.opts.log().warn({ err, channel: c.id }, 'alert channel config could not be decrypted');
      }
    }
    this.channels = next;
    // Keep windows/cooldowns for rules that survived the reload.
    const live = new Set(this.rules.filter((r) => r.enabled).map((r) => r.id));
    for (const [key, st] of this.state) {
      if (!live.has(key.split('|')[0]!)) {
        if (st.timer) clearTimeout(st.timer);
        this.state.delete(key);
      }
    }
    this.version.bump();
  }

  start(): void {
    this.janitor = setInterval(() => {
      void this.db.deleteFrom('alerts').where('last_at', '<', this.now() - RETENTION_MS).execute().catch(() => undefined);
    }, 3600_000);
    this.janitor.unref?.();
    this.scheduler = setInterval(() => void this.runScheduled(), 60_000);
    this.scheduler.unref?.();
  }

  stop(): void {
    if (this.janitor) clearInterval(this.janitor);
    if (this.scheduler) clearInterval(this.scheduler);
    for (const st of this.state.values()) if (st.timer) clearTimeout(st.timer);
  }

  /** Resolves when every delivery started so far has finished. */
  async settle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  private name(kind: 'deployment' | 'mcp' | 'key', id: string): string {
    return this.opts.names?.(kind, id) ?? id;
  }

  // ------------------------------------------------------------ the hot path

  push = (e: FlightEvent): void => {
    if (!this.rules.length) return;
    switch (e.t) {
      case 'flight.started': {
        if (this.flights.size >= MAX_TRACKED) this.flights.delete(this.flights.keys().next().value!);
        this.flights.set(e.flight_id, { agent: e.key_name, keyId: e.key_id, team: e.team, project: e.project, dest: e.tool ?? e.model_requested, targetId: e.mcp_server_id ?? e.deployment_id, isTool: e.kind === 'mcp.tool' });
        return;
      }
      case 'flight.decision': {
        if (!e.rule_id) return;
        const f = this.flights.get(e.flight_id);
        if (f && (e.decision === 'deny' || e.decision === 'hold' || e.decision === 'allow')) f.gateId = e.rule_id;
        // `held` is raised on flight.held, which carries the approval to link to.
        const trigger: AlertTrigger | null =
          e.decision === 'deny' ? (e.reason === 'scope_mismatch' ? 'scope_mismatch' : 'blocked') : e.decision === 'allow' ? 'allowed' : e.decision === 'mutate' ? 'masked' : e.decision === 'flagged' ? 'flagged' : null;
        if (trigger) this.gateHit(e.flight_id, e.rule_id, trigger, e.ts, e.reason);
        return;
      }
      case 'flight.held': {
        const f = this.flights.get(e.flight_id);
        if (f?.gateId) this.gateHit(e.flight_id, f.gateId, 'held', e.ts, e.summary, e.approval_id);
        return;
      }
      case 'flight.resolved': {
        const f = this.flights.get(e.flight_id);
        if (!f?.gateId) return;
        const trigger: AlertTrigger = e.outcome === 'approved' ? 'approved' : e.outcome === 'denied' ? 'rejected' : 'unanswered';
        this.gateHit(e.flight_id, f.gateId, trigger, e.ts, e.by ? `by ${e.by}` : undefined);
        return;
      }
      case 'flight.upstream':
        this.onUpstream(e);
        return;
      case 'flight.completed':
        this.onCompleted(e);
        this.flights.delete(e.flight_id);
        return;
      default:
        return;
    }
  };

  private hitFor(flightId: string, subject: Hit['subject'], trigger: AlertTrigger, ts: number, reason: string | undefined): Hit {
    const f = this.flights.get(flightId);
    return { ts, flightId, subject, trigger, agent: f?.agent ?? 'unknown agent', dest: f?.dest ?? 'unknown', reason, isTool: f?.isTool };
  }

  private gateHit(flightId: string, gateId: string, trigger: AlertTrigger, ts: number, reason: string | undefined, approvalId?: string): void {
    const h = { ...this.hitFor(flightId, { kind: 'gate', id: gateId }, trigger, ts, reason), approvalId };
    for (const r of this.rules) {
      if (r.kind !== 'gate' || !r.enabled || (r.ruleId && r.ruleId !== gateId) || !r.triggers.includes(trigger)) continue;
      this.count(r, '', h);
    }
  }

  private inScope(r: AlertRuleRecord, ...ids: Array<string | undefined>): boolean {
    const t = r.params.targets;
    return !t?.length || ids.some((id) => id !== undefined && t.includes(id));
  }

  private onUpstream(e: Extract<FlightEvent, { t: 'flight.upstream' }>): void {
    const isMcp = e.deployment_id === e.provider_id; // MCP flights use the server id for both
    const subject: Hit['subject'] = { kind: isMcp ? 'mcp' : 'deployment', id: e.deployment_id };
    if (e.outcome === 'ok') {
      for (const r of this.rules) {
        const key = `${r.id}|${e.deployment_id}`;
        if (r.kind !== 'health' || !r.enabled || !this.down.has(key)) continue;
        this.down.delete(key);
        if (r.triggers.includes('recovered')) this.fire(r, [this.hitFor(e.flight_id, subject, 'recovered', e.ts, undefined)], false);
      }
      return;
    }
    if (!isOutageFailure(e.status, e.error_code)) return;
    const reason = e.status ? `HTTP ${e.status}${e.error_code ? ` ${e.error_code}` : ''}` : (e.error_code ?? 'network error');
    const h = this.hitFor(e.flight_id, subject, 'outage', e.ts, reason);
    for (const r of this.rules) {
      if (r.kind !== 'health' || !r.enabled || !r.triggers.includes('outage') || !this.inScope(r, e.deployment_id)) continue;
      if (this.count(r, e.deployment_id, h)) this.down.add(`${r.id}|${e.deployment_id}`);
    }
  }

  private onCompleted(e: Extract<FlightEvent, { t: 'flight.completed' }>): void {
    const f = this.flights.get(e.flight_id);
    for (const r of this.rules) {
      if (!r.enabled) continue;
      if (r.kind === 'errors' && e.status === 'error' && r.triggers.includes('failed') && this.inScope(r, f?.keyId, f?.targetId)) {
        this.count(r, '', this.hitFor(e.flight_id, { kind: 'fleet', id: '' }, 'failed', e.ts, e.error?.code));
      } else if (r.kind === 'latency' && r.triggers.includes('slow') && this.inScope(r, f?.keyId, f?.targetId)) {
        const slow = r.params.slow_ms ?? DEFAULT_SLOW_MS;
        if (e.duration_ms > slow) this.count(r, '', this.hitFor(e.flight_id, { kind: 'fleet', id: '' }, 'slow', e.ts, `${(e.duration_ms / 1000).toFixed(1)} s`));
      } else if (r.kind === 'budget' && f && e.cost_nanousd) {
        this.checkBudgets(r, f, e.flight_id, e.ts);
      }
    }
  }

  private checkBudgets(r: AlertRuleRecord, f: FlightInfo, flightId: string, ts: number): void {
    if (!this.opts.budget) return;
    const scopes = [`key:${f.keyId}`, f.team ? `team:${f.team}` : '', f.project ? `project:${f.project}` : ''].filter(Boolean);
    for (const scope of scopes) {
      if (!this.inScope(r, scope, scope.startsWith('key:') ? scope.slice(4) : undefined)) continue;
      const b = this.opts.budget(scope);
      if (!b || b.limitNanousd <= 0) continue;
      const pct = (b.spentNanousd / b.limitNanousd) * 100;
      const trigger: AlertTrigger | null = pct >= 100 ? 'budget_exceeded' : pct >= (r.params.warn_pct ?? DEFAULT_WARN_PCT) ? 'budget_warning' : null;
      if (!trigger || !r.triggers.includes(trigger)) continue;
      // Once per budget period per threshold (a new period re-arms it).
      const dedupe = `${r.id}|${scope}|${trigger}|${b.resetsAt ?? 'never'}`;
      if (this.budgetSent.has(dedupe)) continue;
      this.budgetSent.add(dedupe);
      const h = this.hitFor(flightId, { kind: 'budget', id: scope }, trigger, ts, undefined);
      const resets = b.resetsAt ? `, resets ${new Date(b.resetsAt).toISOString().slice(0, 10)}` : '';
      this.fire(r, [h], false, [`${pct.toFixed(0)}% used: ${formatUsd(b.spentNanousd)} of ${formatUsd(b.limitNanousd)} (${b.period}${resets})`]);
    }
  }

  /**
   * Record a hit against a rule's window for one subject. Returns true when
   * this hit made the rule fire.
   */
  private count(r: AlertRuleRecord, subject: string, h: Hit): boolean {
    const key = `${r.id}|${subject}`;
    const now = this.now();
    let st = this.state.get(key);
    if (!st) {
      st = { hits: [], cooldownUntil: 0, suppressed: [], timer: undefined };
      this.state.set(key, st);
    }
    if (now < st.cooldownUntil) {
      st.suppressed.push(h);
      if (st.suppressed.length > 1000) st.suppressed.shift();
      if (!st.timer) {
        const s = st;
        s.timer = setTimeout(() => this.endCooldown(r.id, s), st.cooldownUntil - now);
        s.timer.unref?.();
      }
      return false;
    }
    st.hits.push(h);
    const cutoff = now - r.windowS * 1000;
    while (st.hits.length && st.hits[0]!.ts < cutoff) st.hits.shift();
    if (st.hits.length < r.threshold) return false;
    const batch = st.hits;
    st.hits = [];
    st.cooldownUntil = now + r.cooldownS * 1000;
    this.fire(r, batch, false);
    return true;
  }

  private endCooldown(ruleId: string, st: RuleState): void {
    st.timer = undefined;
    const pending = st.suppressed;
    st.suppressed = [];
    const r = this.rules.find((x) => x.id === ruleId && x.enabled);
    if (!r) return;
    if (pending.length >= r.threshold) {
      st.cooldownUntil = this.now() + r.cooldownS * 1000;
      this.fire(r, pending, true);
    } else {
      // Not enough for a digest: let them count toward the next window.
      st.cooldownUntil = 0;
      st.hits.push(...pending);
    }
  }

  // ------------------------------------------------------------ scheduled: daily digest

  /** Called every minute; sends any digest that is due. Exposed for tests. */
  async runScheduled(): Promise<void> {
    const now = new Date(this.now());
    const today = now.toISOString().slice(0, 10);
    for (const r of this.rules) {
      if (r.kind !== 'digest' || !r.enabled || !r.triggers.includes('daily')) continue;
      if (now.getUTCHours() !== (r.params.hour ?? 8)) continue;
      if (r.lastFiredAt && new Date(r.lastFiredAt).toISOString().slice(0, 10) === today) continue;
      r.lastFiredAt = this.now();
      await this.sendDigest(r).catch((err) => this.opts.log().warn({ err, alert_rule: r.id }, 'daily digest failed'));
    }
  }

  async sendDigest(r: AlertRuleRecord): Promise<void> {
    const since = this.now() - 86_400_000;
    const totals = await this.db
      .selectFrom('flights')
      .select((eb) => [
        eb.fn.countAll<number>().as('requests'),
        eb.fn.sum<number>('cost_nanousd').as('cost'),
        eb.fn.sum<number>(sql<number>`coalesce(in_tokens,0) + coalesce(out_tokens,0)`).as('tokens'),
        eb.fn.sum<number>(sql<number>`case when status = 'error' then 1 else 0 end`).as('errors'),
        eb.fn.sum<number>(sql<number>`case when status = 'denied' then 1 else 0 end`).as('blocked'),
        eb.fn.sum<number>(sql<number>`case when approval_id is not null then 1 else 0 end`).as('held'),
        eb.fn.sum<number>(sql<number>`case when decision in ('mutate', 'flagged') then 1 else 0 end`).as('inspected'),
      ])
      .where('ts', '>', since)
      .executeTakeFirst();
    const requests = Number(totals?.requests ?? 0);
    if (!requests) return;
    const [topAgents, failing, slowest, alerts] = await Promise.all([
      this.db.selectFrom('flights').select(['key_name']).select((eb) => eb.fn.sum<number>('cost_nanousd').as('cost')).where('ts', '>', since).groupBy('key_name').orderBy('cost', 'desc').limit(3).execute(),
      this.db
        .selectFrom('flights')
        .select(['deployment_id', 'mcp_server_id'])
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('ts', '>', since)
        .where('status', '=', 'error')
        .groupBy(['deployment_id', 'mcp_server_id'])
        .orderBy('n', 'desc')
        .limit(3)
        .execute(),
      this.db
        .selectFrom('flights')
        .select(['deployment_id'])
        .select((eb) => eb.fn.avg<number>('duration_ms').as('avg'))
        .where('ts', '>', since)
        .where('status', '=', 'ok')
        .where('deployment_id', 'is not', null)
        .groupBy('deployment_id')
        .orderBy('avg', 'desc')
        .limit(3)
        .execute(),
      this.db.selectFrom('alerts').select((eb) => eb.fn.countAll<number>().as('n')).where('last_at', '>', since).where('trigger', '!=', 'daily').executeTakeFirst(),
    ]);
    const n = (x: unknown) => Number(x ?? 0).toLocaleString('en-US');
    const lines = [
      `Requests: ${n(requests)} · tokens: ${n(totals?.tokens)} · spend: ${formatUsd(Number(totals?.cost ?? 0))}`,
      `Enforcement: ${n(totals?.blocked)} blocked · ${n(totals?.held)} held for approval · ${n(totals?.inspected)} masked or flagged`,
      `Errors: ${n(totals?.errors)} · alerts fired: ${n(alerts?.n)}`,
    ];
    const spenders = topAgents.filter((a) => Number(a.cost ?? 0) > 0);
    if (spenders.length) lines.push(`Top spend: ${spenders.map((a) => `${a.key_name} ${formatUsd(Number(a.cost ?? 0))}`).join(', ')}`);
    if (failing.length) lines.push(`Most failures: ${failing.map((f) => `${f.mcp_server_id ? this.name('mcp', f.mcp_server_id) : f.deployment_id ? this.name('deployment', f.deployment_id) : 'unrouted'} (${n(f.n)})`).join(', ')}`);
    if (slowest.length) lines.push(`Slowest: ${slowest.map((s) => `${this.name('deployment', s.deployment_id!)} ${(Number(s.avg) / 1000).toFixed(1)} s avg`).join(', ')}`);
    const title = `Daily summary: ${n(requests)} requests · ${formatUsd(Number(totals?.cost ?? 0))} · ${n(totals?.blocked)} blocked · ${n(totals?.errors)} errors`;
    this.fire(r, [{ ts: this.now(), flightId: '', subject: { kind: 'fleet', id: '' }, trigger: 'daily', agent: '', dest: '', reason: undefined }], false, lines, title);
  }

  // ------------------------------------------------------------ firing

  private subjectName(s: Hit['subject']): string {
    switch (s.kind) {
      case 'gate':
        return this.opts.gate(s.id)?.name ?? 'a deleted gate';
      case 'deployment':
        return this.name('deployment', s.id);
      case 'mcp':
        return this.name('mcp', s.id);
      case 'key':
        return this.name('key', s.id);
      case 'budget': {
        const [type, id] = [s.id.slice(0, s.id.indexOf(':')), s.id.slice(s.id.indexOf(':') + 1)];
        return type === 'key' ? `key ${this.name('key', id)}` : `${type} ${id}`;
      }
      case 'fleet':
        return 'All agents';
    }
  }

  private build(r: AlertRuleRecord, hits: Hit[], digest: boolean, id: string, lines: string[], titleOverride?: string): AlertPayload {
    const last = hits[hits.length - 1]!;
    const subjectName = this.subjectName(last.subject);
    const triggers = new Set(hits.map((h) => h.trigger));
    const trigger = triggers.size === 1 ? last.trigger : 'mixed';
    const n = hits.length;
    let title: string;
    if (titleOverride) title = titleOverride;
    else if (r.kind === 'gate') {
      const verb = trigger === 'mixed' ? 'triggered the gate' : PAST[trigger];
      let what: string;
      if (n === 1) what = trigger === 'scope_mismatch' ? `${last.agent} ${verb} (${last.dest})` : `${last.agent} → ${last.dest} ${verb}`;
      else if (digest) what = `${n} more requests ${verb} since the last alert`;
      else what = `${n} requests ${verb} in the last ${fmtDuration(r.windowS)}`;
      title = `${subjectName}: ${what}`;
    } else if (trigger === 'outage') {
      title = digest ? `${subjectName}: ${n} more upstream failures since the last alert` : `${subjectName} may be down: ${n} upstream failure${n === 1 ? '' : 's'} in ${fmtDuration(r.windowS)}`;
    } else if (trigger === 'recovered') {
      title = `${subjectName} recovered: requests are succeeding again`;
    } else if (trigger === 'failed') {
      title = n === 1 ? `${last.agent} → ${last.dest} failed (${last.reason ?? 'error'})` : digest ? `${n} more requests failed since the last alert` : `${n} requests failed in the last ${fmtDuration(r.windowS)}`;
    } else if (trigger === 'slow') {
      const slow = fmtDuration(Math.round((r.params.slow_ms ?? DEFAULT_SLOW_MS) / 1000));
      title = n === 1 ? `${last.agent} → ${last.dest} took ${last.reason}` : digest ? `${n} more requests took over ${slow} since the last alert` : `${n} requests took over ${slow} in the last ${fmtDuration(r.windowS)}`;
    } else if (trigger === 'budget_exceeded') {
      title = `Budget exhausted for ${subjectName}`;
    } else if (trigger === 'budget_warning') {
      title = `Budget for ${subjectName} is nearly used`;
    } else {
      title = `${r.name}: ${n} events`;
    }
    const gate = last.subject.kind === 'gate' ? this.opts.gate(last.subject.id) : undefined;
    const base = this.opts.publicUrl ? this.opts.publicUrl.replace(/\/+$/, '') : null;
    // One held request: link to its approval card. Several: to the Tower queue.
    const single = trigger === 'held' && n === 1 && last.approvalId ? last.approvalId : null;
    const route = single ? `tower/${single}` : trigger === 'held' ? 'tower' : r.kind === 'budget' ? 'keys' : r.kind === 'health' ? 'models' : 'alerts';
    const agentHits = hits.filter((h) => h.agent);
    return {
      type: 'controltower.alert',
      id,
      kind: r.kind,
      title,
      trigger,
      count: n,
      digest,
      window_s: r.windowS,
      first_at: new Date(hits[0]!.ts).toISOString(),
      last_at: new Date(last.ts).toISOString(),
      alert_rule: { id: r.id, name: r.name },
      subject: last.subject.kind === 'fleet' ? null : { kind: last.subject.kind, id: last.subject.id, name: subjectName },
      gate: gate ? { id: last.subject.id, name: gate.name, effect: gate.effect } : null,
      agents: tally(agentHits.map((h) => h.agent)),
      destinations: tally(agentHits.map((h) => h.dest)),
      reason: [...hits].reverse().find((h) => h.reason)?.reason ?? null,
      lines,
      flights: hits.filter((h) => h.flightId).slice(-5).map((h) => h.flightId),
      approval: single ? { id: single, scope: `Approve ONE ${last.isTool ? 'call to' : 'request to'} ${last.dest} from ${last.agent}`, url: base ? `${base}/#/tower/${single}` : null } : null,
      console_url: base ? `${base}/#/${route}` : null,
    };
  }

  private fire(r: AlertRuleRecord, hits: Hit[], digest: boolean, lines: string[] = [], titleOverride?: string): void {
    const id = `alert_${ulid()}`;
    const p = this.build(r, hits, digest, id, lines, titleOverride);
    const now = this.now();
    const channels = r.channels.map((c) => this.channels.get(c)).filter((c): c is ChannelRecord => !!c && c.enabled);
    const job = (async () => {
      await this.db
        .insertInto('alerts')
        .values({
          id,
          alert_rule_id: r.id,
          rule_id: p.gate?.id ?? null,
          trigger: p.trigger,
          title: p.title,
          detail: JSON.stringify({ kind: r.kind, subject: p.subject, gate: p.gate, agents: p.agents, destinations: p.destinations, reason: p.reason, lines: p.lines, flights: p.flights, approval: p.approval, digest, window_s: r.windowS }),
          count: p.count,
          first_at: hits[0]!.ts,
          last_at: hits[hits.length - 1]!.ts,
          deliveries: JSON.stringify(channels.map((c) => ({ channel_id: c.id, name: c.name, kind: c.kind, ok: false, attempts: 0, at: now, pending: true }))),
          read_at: null,
          demo: r.demo ? 1 : 0,
        })
        .execute();
      await this.db.updateTable('alert_rules').set({ last_fired_at: now }).where('id', '=', r.id).execute();
      r.lastFiredAt = now;
      this.version.bump();
      if (!channels.length) return;
      const deliveries = await Promise.all(channels.map((c) => this.deliver(c, p)));
      await this.db.updateTable('alerts').set({ deliveries: JSON.stringify(deliveries) }).where('id', '=', id).execute();
      this.version.bump();
    })().catch((err) => this.opts.log().warn({ err, alert_rule: r.id }, 'alert could not be recorded'));
    this.track(job);
  }

  private track(p: Promise<unknown>): void {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }

  // ------------------------------------------------------------ delivery

  async deliver(c: ChannelRecord, p: AlertPayload): Promise<Delivery> {
    const delays = this.opts.retryDelaysMs ?? [1000, 4000];
    const body = JSON.stringify(c.kind === 'slack' ? slackMessage(p) : p);
    let last: { ok: boolean; status?: number | undefined; error?: string | undefined } = { ok: false };
    let attempts = 0;
    for (let i = 0; i <= delays.length; i++) {
      attempts++;
      last = await this.post(c, body);
      // Retry only what might succeed later: network errors, 408, 429 and 5xx.
      if (last.ok || (last.status && last.status < 500 && last.status !== 408 && last.status !== 429)) break;
      if (i < delays.length) await new Promise((res) => setTimeout(res, delays[i]));
    }
    const at = this.now();
    await this.db
      .updateTable('alert_channels')
      .set({ last_status: last.ok ? 'ok' : 'error', last_error: last.ok ? null : (last.error ?? `HTTP ${last.status}`), last_sent_at: at })
      .where('id', '=', c.id)
      .execute()
      .catch(() => undefined);
    if (!last.ok) this.opts.log().warn({ channel: c.id, status: last.status, error: last.error }, 'alert delivery failed');
    return { channel_id: c.id, name: c.name, kind: c.kind, ok: last.ok, status: last.status, error: last.error, attempts, at };
  }

  private async post(c: ChannelRecord, body: string): Promise<{ ok: boolean; status?: number | undefined; error?: string | undefined }> {
    const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'ControlTower-Alerts/1' };
    if (c.kind === 'webhook') {
      headers['x-ct-event'] = 'alert';
      if (c.config.secret) {
        const ts = Math.floor(this.now() / 1000);
        headers['x-ct-signature'] = `t=${ts},v1=${signBody(c.config.secret, ts, body)}`;
      }
    }
    try {
      const res = await this.fetchImpl(c.config.url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5000) });
      // Drain so the socket returns to the pool; never store the response.
      await res.arrayBuffer().catch(() => undefined);
      return res.ok ? { ok: true, status: res.status } : { ok: false, status: res.status };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? (err.name === 'TimeoutError' ? 'timed out' : err.message) : String(err) };
    }
  }

  /** Send a sample alert to one channel, bypassing rules (the "Test" button). */
  async test(channelId: string): Promise<Delivery | null> {
    const c = this.channels.get(channelId);
    if (!c) return null;
    const now = this.now();
    const p: AlertPayload = {
      type: 'controltower.alert',
      id: `alert_test_${ulid()}`,
      kind: 'gate',
      title: 'Test alert from Control Tower — this channel is connected',
      trigger: 'blocked',
      count: 1,
      digest: false,
      window_s: 300,
      first_at: new Date(now).toISOString(),
      last_at: new Date(now).toISOString(),
      alert_rule: { id: 'test', name: 'Channel test' },
      subject: null,
      gate: null,
      agents: [{ name: 'example-agent', count: 1 }],
      destinations: [{ name: 'example-tool', count: 1 }],
      reason: 'Sent from the Alerts page',
      lines: [],
      flights: [],
      approval: null,
      console_url: this.opts.publicUrl ? `${this.opts.publicUrl.replace(/\/+$/, '')}/#/alerts` : null,
      test: true,
    };
    return this.deliver(c, p);
  }

  encryptConfig(id: string, config: ChannelConfig): string {
    return this.secrets.encrypt(JSON.stringify(config), `alert_channels.config_enc.${id}`);
  }

  channelConfig(id: string): ChannelConfig | undefined {
    return this.channels.get(id)?.config;
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Slack incoming-webhook message (also accepted by Mattermost and Rocket.Chat). */
export function slackMessage(p: AlertPayload): Record<string, unknown> {
  const list = (xs: Array<{ name: string; count: number }>) => xs.map((x) => (x.count > 1 ? `${esc(x.name)} (${x.count})` : esc(x.name))).join(', ');
  const lines: string[] = [];
  if (p.agents?.length) lines.push(`*Agents:* ${list(p.agents)}`);
  if (p.destinations?.length) lines.push(`*Target:* ${list(p.destinations)}`);
  if (p.reason) lines.push(`*Reason:* ${esc(p.reason)}`);
  for (const l of p.lines ?? []) lines.push(esc(l));
  if (p.approval) lines.push(`*Decision needed:* ${esc(p.approval.scope)}. Approving happens in Control Tower, signed in.`);
  const blocks: Array<Record<string, unknown>> = [
    { type: 'section', text: { type: 'mrkdwn', text: `*${esc(p.title)}*${lines.length ? `\n${lines.join('\n')}` : ''}` } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Control Tower · ${esc(p.alert_rule.name)}${p.gate ? ` · gate: ${esc(p.gate.name)}` : ''}` }] },
  ];
  if (p.console_url) {
    const button: Record<string, unknown> = { type: 'button', text: { type: 'plain_text', text: p.approval ? 'Review & approve' : p.trigger === 'held' ? 'Review in the Tower' : 'Open Control Tower' }, url: p.approval?.url ?? p.console_url };
    if (p.approval) button.style = 'primary';
    blocks.push({ type: 'actions', elements: [button] });
  }
  return { text: p.title, blocks };
}
