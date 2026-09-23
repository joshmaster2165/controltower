import crypto from 'node:crypto';
import type { Kysely } from 'kysely';
import { ulid } from 'ulid';
import type { FlightEvent } from '@controltower/shared';
import type { Database } from '../db/schema.js';
import type { SecretBox } from '../crypto/secrets.js';
import type { Versioned } from '../util/versioned.js';

/**
 * Alerting on gates. An alert rule watches one gate (or every gate) for a set
 * of triggers — blocked, held, approved, … — and fires when it has seen
 * `threshold` of them inside `window_s`. After firing it stays quiet for
 * `cooldown_s`; anything that happens meanwhile is rolled into one digest at
 * the end of the cooldown, so a looping agent produces one message, not 500.
 *
 * Every fired alert lands in the console inbox; channels (Slack, signed
 * webhooks) are optional extra destinations. Like flight events, alerts carry
 * names and counts only — never request arguments, bodies or credentials.
 *
 * `push` runs on the flight bus and is synchronous and cheap; storage and
 * delivery happen off the hot path.
 */

export const ALERT_TRIGGERS = ['blocked', 'held', 'approved', 'rejected', 'unanswered', 'allowed', 'scope_mismatch'] as const;
export type AlertTrigger = (typeof ALERT_TRIGGERS)[number];

const PAST: Record<AlertTrigger, string> = {
  blocked: 'blocked',
  held: 'held for approval',
  approved: 'approved',
  rejected: 'rejected by an approver',
  unanswered: 'not answered in time',
  allowed: 'allowed',
  scope_mismatch: 'replayed an approval with different arguments',
};

export type ChannelKind = 'slack' | 'webhook';

export interface AlertRuleRecord {
  id: string;
  name: string;
  ruleId: string | null;
  triggers: AlertTrigger[];
  threshold: number;
  windowS: number;
  cooldownS: number;
  channels: string[];
  enabled: boolean;
  demo: boolean;
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

interface Hit {
  ts: number;
  flightId: string;
  gateId: string;
  trigger: AlertTrigger;
  agent: string;
  dest: string;
  reason: string | undefined;
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
  title: string;
  trigger: AlertTrigger | 'mixed';
  count: number;
  digest: boolean;
  window_s: number;
  first_at: string;
  last_at: string;
  alert_rule: { id: string; name: string };
  gate: { id: string; name: string; effect: string } | null;
  agents: Array<{ name: string; count: number }>;
  destinations: Array<{ name: string; count: number }>;
  reason: string | null;
  flights: string[];
  console_url: string | null;
  test?: boolean;
}

export interface GateInfo {
  name: string;
  effect: string;
}

interface Logger {
  warn(obj: unknown, msg?: string): void;
}

export interface AlertServiceOptions {
  publicUrl?: string | undefined;
  gate: (ruleId: string) => GateInfo | undefined;
  log: () => Logger;
  fetch?: typeof fetch;
  now?: () => number;
  /** Delays between delivery attempts; attempts = length + 1. */
  retryDelaysMs?: number[];
  timeoutMs?: number;
}

const MAX_TRACKED = 20_000;
const RETENTION_MS = 30 * 86_400_000;

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

export class AlertService {
  rules: AlertRuleRecord[] = [];
  private channels = new Map<string, ChannelRecord>();
  private state = new Map<string, RuleState>();
  /** flight id → who/where, learned from flight.started; the gate from flight.decision. */
  private flights = new Map<string, { agent: string; dest: string; gateId?: string | undefined }>();
  private janitor: NodeJS.Timeout | undefined;
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
      ruleId: r.rule_id,
      triggers: (JSON.parse(r.triggers) as string[]).filter((t): t is AlertTrigger => (ALERT_TRIGGERS as readonly string[]).includes(t)),
      threshold: Math.max(1, r.threshold),
      windowS: Math.max(1, r.window_s),
      cooldownS: Math.max(0, r.cooldown_s),
      channels: JSON.parse(r.channels) as string[],
      enabled: r.enabled === 1,
      demo: r.demo === 1,
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
    for (const [id, st] of this.state) {
      if (!this.rules.some((r) => r.id === id && r.enabled)) {
        if (st.timer) clearTimeout(st.timer);
        this.state.delete(id);
      }
    }
    this.version.bump();
  }

  start(): void {
    this.janitor = setInterval(() => {
      void this.db.deleteFrom('alerts').where('last_at', '<', this.now() - RETENTION_MS).execute().catch(() => undefined);
    }, 3600_000);
    this.janitor.unref?.();
  }

  stop(): void {
    if (this.janitor) clearInterval(this.janitor);
    for (const st of this.state.values()) if (st.timer) clearTimeout(st.timer);
  }

  /** Resolves when every delivery started so far has finished. */
  async settle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  // ------------------------------------------------------------ the hot path

  push = (e: FlightEvent): void => {
    if (!this.rules.length) return;
    switch (e.t) {
      case 'flight.started': {
        if (this.flights.size >= MAX_TRACKED) this.flights.delete(this.flights.keys().next().value!);
        this.flights.set(e.flight_id, { agent: e.key_name, dest: e.tool ?? e.model_requested });
        return;
      }
      case 'flight.decision': {
        if (!e.rule_id) return;
        const f = this.flights.get(e.flight_id);
        if (f) f.gateId = e.rule_id;
        const trigger: AlertTrigger | null = e.decision === 'deny' ? (e.reason === 'scope_mismatch' ? 'scope_mismatch' : 'blocked') : e.decision === 'hold' ? 'held' : e.decision === 'allow' ? 'allowed' : null;
        if (trigger) this.hit(e.flight_id, e.rule_id, trigger, e.ts, e.reason);
        return;
      }
      case 'flight.resolved': {
        const f = this.flights.get(e.flight_id);
        if (!f?.gateId) return;
        const trigger: AlertTrigger = e.outcome === 'approved' ? 'approved' : e.outcome === 'denied' ? 'rejected' : 'unanswered';
        this.hit(e.flight_id, f.gateId, trigger, e.ts, e.by ? `by ${e.by}` : undefined);
        return;
      }
      case 'flight.completed':
        this.flights.delete(e.flight_id);
        return;
      default:
        return;
    }
  };

  private hit(flightId: string, gateId: string, trigger: AlertTrigger, ts: number, reason: string | undefined): void {
    const f = this.flights.get(flightId);
    const h: Hit = { ts, flightId, gateId, trigger, agent: f?.agent ?? 'unknown agent', dest: f?.dest ?? 'unknown', reason };
    const now = this.now();
    for (const r of this.rules) {
      if (!r.enabled || (r.ruleId && r.ruleId !== gateId) || !r.triggers.includes(trigger)) continue;
      let st = this.state.get(r.id);
      if (!st) {
        st = { hits: [], cooldownUntil: 0, suppressed: [], timer: undefined };
        this.state.set(r.id, st);
      }
      if (now < st.cooldownUntil) {
        st.suppressed.push(h);
        if (st.suppressed.length > 1000) st.suppressed.shift();
        if (!st.timer) {
          const rule = r;
          const s = st;
          s.timer = setTimeout(() => this.endCooldown(rule, s), st.cooldownUntil - now);
          s.timer.unref?.();
        }
        continue;
      }
      st.hits.push(h);
      const cutoff = now - r.windowS * 1000;
      while (st.hits.length && st.hits[0]!.ts < cutoff) st.hits.shift();
      if (st.hits.length >= r.threshold) {
        const batch = st.hits;
        st.hits = [];
        st.cooldownUntil = now + r.cooldownS * 1000;
        this.fire(r, batch, false);
      }
    }
  }

  private endCooldown(r: AlertRuleRecord, st: RuleState): void {
    st.timer = undefined;
    const pending = st.suppressed;
    st.suppressed = [];
    if (!this.rules.some((x) => x.id === r.id && x.enabled)) return;
    if (pending.length >= r.threshold) {
      st.cooldownUntil = this.now() + r.cooldownS * 1000;
      this.fire(r, pending, true);
    } else {
      // Not enough for a digest: let them count toward the next window.
      st.cooldownUntil = 0;
      st.hits.push(...pending);
    }
  }

  // ------------------------------------------------------------ firing

  private build(r: AlertRuleRecord, hits: Hit[], digest: boolean, id: string): AlertPayload {
    const last = hits[hits.length - 1]!;
    const gate = this.opts.gate(last.gateId);
    const gateName = gate?.name ?? 'a deleted gate';
    const triggers = new Set(hits.map((h) => h.trigger));
    const trigger = triggers.size === 1 ? last.trigger : 'mixed';
    const verb = trigger === 'mixed' ? 'triggered the gate' : PAST[trigger];
    const n = hits.length;
    let what: string;
    if (n === 1) what = trigger === 'scope_mismatch' ? `${last.agent} ${verb} (${last.dest})` : `${last.agent} → ${last.dest} ${verb}`;
    else if (digest) what = `${n} more requests ${verb} since the last alert`;
    else what = `${n} requests ${verb} in the last ${fmtDuration(r.windowS)}`;
    const route = trigger === 'held' ? 'tower' : 'alerts';
    return {
      type: 'controltower.alert',
      id,
      title: `${gateName}: ${what}`,
      trigger,
      count: n,
      digest,
      window_s: r.windowS,
      first_at: new Date(hits[0]!.ts).toISOString(),
      last_at: new Date(last.ts).toISOString(),
      alert_rule: { id: r.id, name: r.name },
      gate: gate ? { id: last.gateId, name: gate.name, effect: gate.effect } : null,
      agents: tally(hits.map((h) => h.agent)),
      destinations: tally(hits.map((h) => h.dest)),
      reason: [...hits].reverse().find((h) => h.reason)?.reason ?? null,
      flights: hits.slice(-5).map((h) => h.flightId),
      console_url: this.opts.publicUrl ? `${this.opts.publicUrl.replace(/\/+$/, '')}/#/${route}` : null,
    };
  }

  private fire(r: AlertRuleRecord, hits: Hit[], digest: boolean): void {
    const id = `alert_${ulid()}`;
    const p = this.build(r, hits, digest, id);
    const now = this.now();
    const channels = r.channels.map((c) => this.channels.get(c)).filter((c): c is ChannelRecord => !!c && c.enabled);
    const job = (async () => {
      await this.db
        .insertInto('alerts')
        .values({
          id,
          alert_rule_id: r.id,
          rule_id: p.gate?.id ?? hits[hits.length - 1]!.gateId,
          trigger: p.trigger,
          title: p.title,
          detail: JSON.stringify({ gate: p.gate, agents: p.agents, destinations: p.destinations, reason: p.reason, flights: p.flights, digest, window_s: r.windowS }),
          count: p.count,
          first_at: hits[0]!.ts,
          last_at: hits[hits.length - 1]!.ts,
          deliveries: JSON.stringify(channels.map((c) => ({ channel_id: c.id, name: c.name, kind: c.kind, ok: false, attempts: 0, at: now, pending: true }))),
          read_at: null,
          demo: r.demo ? 1 : 0,
        })
        .execute();
      await this.db.updateTable('alert_rules').set({ last_fired_at: now }).where('id', '=', r.id).execute();
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
      title: 'Test alert from Control Tower — this channel is connected',
      trigger: 'blocked',
      count: 1,
      digest: false,
      window_s: 300,
      first_at: new Date(now).toISOString(),
      last_at: new Date(now).toISOString(),
      alert_rule: { id: 'test', name: 'Channel test' },
      gate: null,
      agents: [{ name: 'example-agent', count: 1 }],
      destinations: [{ name: 'example-tool', count: 1 }],
      reason: 'Sent from the Alerts page',
      flights: [],
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
  const lines = [`*Agents:* ${list(p.agents)}`, `*Target:* ${list(p.destinations)}`];
  if (p.reason) lines.push(`*Reason:* ${esc(p.reason)}`);
  const blocks: Array<Record<string, unknown>> = [
    { type: 'section', text: { type: 'mrkdwn', text: `*${esc(p.title)}*\n${lines.join('\n')}` } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Control Tower · ${esc(p.alert_rule.name)}${p.gate ? ` · gate: ${esc(p.gate.name)}` : ''}` }] },
  ];
  if (p.console_url) {
    blocks.push({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: p.trigger === 'held' ? 'Review in the Tower' : 'Open Control Tower' }, url: p.console_url }] });
  }
  return { text: p.title, blocks };
}
