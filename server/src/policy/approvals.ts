import { ulid } from 'ulid';
import type { Kysely } from 'kysely';
import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../db/schema.js';
import type { Flight } from '../pipeline/flight.js';
import type { PolicyDecision } from './engine.js';
import type { PolicyDecisionFull } from './policy.js';
import { E, type GatewayError } from '../gateway/errors.js';
import type { FlightBus } from '../events/bus.js';
import type { Versioned } from '../util/versioned.js';
import { dedupeKey, opaqueToken, personScope } from './hash.js';
import { PERSON_APPS } from '../gateway/notices.js';
import type { RequesterNotify } from './requester-mail.js';
import { isToolKind } from '@controltower/shared';

/**
 * Human-in-the-loop hold.
 *
 *   ApprovalRequest (human-facing, 15 min)  ──approve──▶ Grant (single-use, 10 min)
 *          │                                          ▲
 *          └── hold budget expires ──▶ Ticket ──retry with x-ct-approval──┘
 *
 * The agent's request waits inside the handler for `holdBudgetMs`. A human
 * answering within that window makes the flight continue transparently.
 * Otherwise the agent receives a structured 403 with a resumable ticket.
 * Identical in-flight requests coalesce onto one approval card.
 *
 * Approve with a window ("this call and the next N, for T minutes") and the grant
 * also covers new calls from the same agent through the same gate (at the same
 * revision) to the same target — with any arguments, or only the ones on the card.
 * Those calls go straight through, no card; revoking the grant ends the window.
 */
export type HoldOutcome =
  | { kind: 'approved'; grantId: string; by: string | undefined }
  | { kind: 'denied'; error: GatewayError }
  | { kind: 'ticketed'; error: GatewayError };

export interface Approvals {
  /** `onHeld` runs once the approval card exists (and the call is waiting on it). */
  hold(flight: Flight, decision: PolicyDecision, onHeld?: () => void): Promise<HoldOutcome>;
  redeem(token: string, keyId: string, scopeHash: string, sessionId: string | undefined): Promise<RedeemResult>;
  decide(approvalId: string, by: string, action: 'approve' | 'deny', opts?: { note?: string; window?: ApprovalWindow }): Promise<{ ok: boolean; status: string }>;
  /** A person's access ended: their waiting requests are refused, and approvals they haven't used yet end. */
  withdrawFor(person: string, reason: string): Promise<number>;
  readonly heldCount: number;
  drain(): void;
}

/** Approve more than the call on the card: `uses` further calls within `ttl_ms`, with any arguments or only these. */
export interface ApprovalWindow {
  uses?: number;
  ttl_ms?: number;
  any_args?: boolean;
}

export const WINDOW_MAX_USES = 1000;
export const WINDOW_MAX_TTL_MS = 60 * 60 * 1000;

export type RedeemFailReason = 'pending' | 'denied' | 'expired' | 'exhausted' | 'scope_mismatch' | 'revoked' | 'unknown';

export type RedeemResult =
  | { ok: true; grantId: string; approvalId: string }
  | { ok: false; reason: RedeemFailReason; approvalId?: string | undefined; retryAfterMs?: number | undefined };

const APPROVAL_TTL_MS = 15 * 60 * 1000;
const GRANT_TTL_MS = 10 * 60 * 1000;
const TICKET_EXTRA_MS = 5 * 60 * 1000;
const SAFETY_POLL_MS = 2000;
const MAX_HELD_PER_KEY = 5;

type Waiter = (status: 'approved' | 'denied' | 'expired' | 'timeout' | 'drained') => void;

export class ApprovalService implements Approvals {
  private waiters = new Map<string, Set<Waiter>>();
  private heldByKey = new Map<string, number>();
  private _held = 0;
  private sweeper: NodeJS.Timeout | undefined;

  constructor(
    private readonly db: Kysely<Database>,
    private readonly bus: FlightBus,
    private readonly version: Versioned,
    private readonly getLog: () => FastifyBaseLogger,
    private readonly opts: { holdBudgetMs: number; maxHeld: number; publicUrl: string; policyRevision: () => number },
  ) {}

  get heldCount(): number {
    return this._held;
  }

  start(): void {
    this.sweeper = setInterval(() => void this.sweep(), 10_000);
    this.sweeper.unref?.();
  }

  stop(): void {
    if (this.sweeper) clearInterval(this.sweeper);
  }

  private consoleUrl(approvalId: string): string {
    return `${this.opts.publicUrl}/#/tower/${approvalId}`;
  }

  async hold(flight: Flight, decision: PolicyDecision, onHeld?: () => void): Promise<HoldOutcome> {
    const d = decision as PolicyDecisionFull;
    const key = flight.key!;
    const now = Date.now();
    const rule = d.rule;
    const budget = Math.max(0, Math.min(rule?.config.hold_ms ?? this.opts.holdBudgetMs, this.opts.holdBudgetMs));
    const argHash = d.argHash ?? '';
    const sh = d.scopeHash ?? '';
    // Whom the call is for is part of what is being approved: the same call made for someone else is another card.
    const chain = flight.chain ?? [];
    const dk = dedupeKey({ revision: this.opts.policyRevision(), keyId: key.id, targetName: flight.modelRequested, argHash, ...(chain.length ? { chain } : {}) });

    // A human already let this agent make more calls like this one: go straight through.
    if (d.ruleId) {
      const w = await this.useWindow(key.id, d.ruleId, rule?.revision ?? null, flight.modelRequested, sh, chain, flight.id, flight.principal);
      if (w) {
        flight.approvalId = w.approvalId;
        this.version.bump();
        this.bus.emit({ t: 'flight.resolved', flight_id: flight.id, ts: now, approval_id: w.approvalId, outcome: 'approved', by: w.by, grant_id: w.grantId });
        return { kind: 'approved', grantId: w.grantId, by: w.by };
      }
    }

    // A person whose call was approved after they stopped waiting: sending it again goes through on that approval, once
    // (their app can't present a ticket). The same call, or from a person's app (Claude, Codex), the same message: those
    // resend the whole conversation, which now also holds the first, unanswered try.
    const personApp = !!flight.client && PERSON_APPS.has(flight.client) && !isToolKind(flight.kind);
    const followUp = personApp && isFollowUp(flight.body);
    const typed = personApp ? (followUp ? taskText(flight.body) : lastUserText(flight.body)) : '';
    const ps = flight.principal && typed ? personScope({ requester: flight.principal, keyId: key.id, targetName: flight.modelRequested, ruleId: d.ruleId, ruleRevision: rule?.revision, text: typed }) : null;
    // The next steps of an approved task: the app working on what the person asked (calling tools, reading their
    // results), not something new they typed. They go through for the gate's task_minutes (30 by default; 0: every
    // step asks), for that person, on that message.
    const taskMs = Math.min(480, Math.max(0, Number(rule?.config.task_minutes ?? 30) || 0)) * 60_000;
    if (followUp && ps && taskMs > 0) {
      const task = await this.db
        .selectFrom('approvals')
        .select(['id', 'grant_id', 'resolved_by'])
        .where('person_scope', '=', ps)
        .where('status', '=', 'approved')
        .where('requester', '=', flight.principal!)
        .where('resolved_at', '>=', now - taskMs)
        .orderBy('resolved_at', 'desc')
        .executeTakeFirst();
      if (task) {
        flight.approvalId = task.id;
        this.version.bump();
        const by = task.resolved_by ?? undefined;
        this.bus.emit({ t: 'flight.resolved', flight_id: flight.id, ts: now, approval_id: task.id, outcome: 'approved', by, ...(task.grant_id ? { grant_id: task.grant_id } : {}) });
        return { kind: 'approved', grantId: task.grant_id ?? '', by };
      }
    }
    if (flight.principal) {
      const done = await this.db
        .selectFrom('approvals')
        .select(['id', 'grant_id', 'resolved_by', 'scope_hash'])
        .where((eb) => (ps ? eb.or([eb('dedupe_key', '=', dk), eb('person_scope', '=', ps)]) : eb('dedupe_key', '=', dk)))
        .where('status', '=', 'approved')
        .where('requester', '=', flight.principal)
        .where('grant_id', 'is not', null)
        .orderBy('resolved_at', 'desc')
        .executeTakeFirst();
      if (done?.grant_id && (await this.consumeGrant(done.grant_id, key.id, done.scope_hash, undefined)).ok) {
        flight.approvalId = done.id;
        this.version.bump();
        const by = done.resolved_by ?? undefined;
        this.bus.emit({ t: 'flight.resolved', flight_id: flight.id, ts: now, approval_id: done.id, outcome: 'approved', by, grant_id: done.grant_id });
        return { kind: 'approved', grantId: done.grant_id, by };
      }
    }

    // Admission control: over the cap we do not hold at all. The cap is an agent's (its key), or, for a person, theirs:
    // a company's laptops share one key, and one person waiting mustn't use up everyone's turn.
    const capKey = flight.principal ? `${key.id}\u0000${flight.principal}` : key.id;
    const perKey = this.heldByKey.get(capKey) ?? 0;
    const canHold = budget > 0 && this._held < this.opts.maxHeld && perKey < MAX_HELD_PER_KEY;
    const holdUntil = now + (canHold ? budget : 0);

    // Coalesce identical in-flight requests onto one card.
    let approval = await this.db.selectFrom('approvals').selectAll().where('dedupe_key', '=', dk).where('status', '=', 'pending').executeTakeFirst();
    if (approval) {
      const until = Math.max(approval.hold_until ?? 0, holdUntil);
      await this.db.updateTable('approvals').set((eb) => ({ waiters: eb('waiters', '+', 1), hold_until: until })).where('id', '=', approval.id).execute();
    } else {
      const id = `apr_${ulid()}`;
      await this.db
        .insertInto('approvals')
        .values({
          id,
          flight_id: flight.id,
          key_id: key.id,
          key_name: key.name,
          rule_id: d.ruleId ?? null,
          rule_revision: rule?.revision ?? null,
          summary: d.summary ?? `${key.name} → ${flight.modelRequested}`,
          target: JSON.stringify({ kind: isToolKind(flight.kind) ? 'tool' : 'model', name: flight.modelRequested, deployment_id: flight.deployment?.id, provider: flight.provider?.slug, zone_from: d.zoneFrom, zone_to: d.zoneTo, ...(chain.length ? { on_behalf_of: chain } : {}) }),
          args_preview: JSON.stringify(previewArgs(flight)),
          arg_hash: argHash || null,
          scope_hash: sh,
          dedupe_key: dk,
          status: 'pending',
          waiters: 1,
          requested_at: now,
          expires_at: now + APPROVAL_TTL_MS,
          resolved_at: null,
          resolved_by: null,
          note: null,
          grant_id: null,
          demo: key.demo ? 1 : 0,
          hold_until: holdUntil,
          requester: flight.principal ?? null,
          client: flight.client ?? null,
          person_scope: ps,
          device: flight.device ?? null,
        })
        .execute();
      if (flight.principal) this.notify?.held(id);
      approval = (await this.db.selectFrom('approvals').selectAll().where('id', '=', id).executeTakeFirst())!;
    }
    flight.approvalId = approval.id;
    this.version.bump();

    this.bus.emit({ t: 'flight.held', flight_id: flight.id, ts: now, approval_id: approval.id, budget_ms: canHold ? budget : 0, summary: approval.summary });
    onHeld?.();

    let status: 'approved' | 'denied' | 'expired' | 'timeout' | 'drained' = 'timeout';
    if (canHold) {
      this._held++;
      this.heldByKey.set(capKey, perKey + 1);
      try {
        status = await this.wait(approval.id, budget, flight);
      } finally {
        this._held--;
        const n = (this.heldByKey.get(capKey) ?? 1) - 1;
        if (n <= 0) this.heldByKey.delete(capKey);
        else this.heldByKey.set(capKey, n);
        await this.db.updateTable('approvals').set((eb) => ({ waiters: eb('waiters', '-', 1) })).where('id', '=', approval.id).execute();
      }
    }

    const fresh = await this.db.selectFrom('approvals').selectAll().where('id', '=', approval.id).executeTakeFirst();
    const by = fresh?.resolved_by ?? undefined;

    if (status === 'approved' && fresh?.grant_id) {
      const consumed = await this.consumeGrant(fresh.grant_id, key.id, sh, flight.id);
      if (consumed.ok) {
        this.bus.emit({ t: 'flight.resolved', flight_id: flight.id, ts: Date.now(), approval_id: approval.id, outcome: 'approved', by, grant_id: fresh.grant_id });
        return { kind: 'approved', grantId: fresh.grant_id, by };
      }
      // Grant exhausted by a coalesced sibling: fall through to ticket so the agent can retry.
      status = 'timeout';
    }
    if (status === 'denied') {
      this.bus.emit({ t: 'flight.resolved', flight_id: flight.id, ts: Date.now(), approval_id: approval.id, outcome: 'denied', by });
      return { kind: 'denied', error: E.policyDenied(`Denied by ${by ?? 'an approver'}${fresh?.note ? `: ${fresh.note}` : ''}.`, d.ruleId) };
    }
    // The card went while the call waited (deleted with its data, say): nothing to issue a ticket against.
    if (!fresh) status = 'expired';
    if (status === 'expired') {
      this.bus.emit({ t: 'flight.resolved', flight_id: flight.id, ts: Date.now(), approval_id: approval.id, outcome: 'expired', by });
      return { kind: 'ticketed', error: E.approvalRequired('CONTROL_TOWER_APPROVAL_EXPIRED: the approval request expired before a human answered. Retry the call to request approval again.', { ct: { v: 1, status: 'expired', request_id: approval.id } }) };
    }

    // Hold budget exhausted (or drained on shutdown): mint a ticket.
    const ticket = opaqueToken('ct_tkt');
    await this.db.insertInto('tickets').values({ id: ticket, approval_id: approval.id, key_id: key.id, expires_at: approval.expires_at + TICKET_EXTRA_MS, created_at: Date.now() }).execute();
    this.bus.emit({ t: 'flight.resolved', flight_id: flight.id, ts: Date.now(), approval_id: approval.id, outcome: 'ticketed' });
    const retryAfterMs = 15_000;
    const expiresIso = new Date(approval.expires_at).toISOString();
    const message =
      `CONTROL_TOWER_APPROVAL_REQUIRED\n` +
      `This action requires human approval and one was requested but not yet granted.\n` +
      `Do not attempt to work around this restriction or use a different tool.\n` +
      `Retry this exact call, unchanged, including the header:\n` +
      `  x-ct-approval: ${ticket}\n` +
      `Suggested wait before retry: ${retryAfterMs} ms. Ticket expires: ${expiresIso}.\n` +
      `Status: ${this.consoleUrl(approval.id)}`;
    return {
      kind: 'ticketed',
      error: E.approvalRequired(message, {
        ct: { v: 1, status: 'pending', ticket, retry_after_ms: retryAfterMs, request_id: approval.id, expires_at: expiresIso, console_url: this.consoleUrl(approval.id) },
      }),
    };
  }

  private wait(approvalId: string, budgetMs: number, flight: Flight): Promise<'approved' | 'denied' | 'expired' | 'timeout' | 'drained'> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (s: 'approved' | 'denied' | 'expired' | 'timeout' | 'drained') => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(poll);
        flight.abort.signal.removeEventListener('abort', onAbort);
        const set = this.waiters.get(approvalId);
        set?.delete(waiter);
        if (set && set.size === 0) this.waiters.delete(approvalId);
        resolve(s);
      };
      const waiter: Waiter = (s) => finish(s);
      const set = this.waiters.get(approvalId) ?? new Set<Waiter>();
      set.add(waiter);
      this.waiters.set(approvalId, set);
      const timer = setTimeout(() => finish('timeout'), budgetMs);
      // Safety poll: never rely solely on in-process wakeups.
      const poll = setInterval(() => {
        void this.db
          .selectFrom('approvals')
          .select('status')
          .where('id', '=', approvalId)
          .executeTakeFirst()
          .then((r) => {
            if (r && r.status !== 'pending') finish(r.status as 'approved' | 'denied' | 'expired');
          });
      }, SAFETY_POLL_MS);
      const onAbort = () => finish('timeout');
      flight.abort.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Told when a card is decided here: the other instances are told too, so a call held there continues at once. */
  onDecided: ((approvalId: string, status: 'approved' | 'denied') => void) | undefined;

  /** A card was decided on another instance: continue the calls held on it here. */
  decidedElsewhere(approvalId: string, status: 'approved' | 'denied'): void {
    this.wake(approvalId, status);
  }

  private wake(approvalId: string, status: 'approved' | 'denied' | 'expired' | 'drained'): void {
    const set = this.waiters.get(approvalId);
    if (!set) return;
    for (const w of [...set]) w(status);
  }

  async withdrawFor(person: string, reason: string): Promise<number> {
    const waiting = await this.db.selectFrom('approvals').select('id').where('requester', '=', person).where('status', '=', 'pending').execute();
    for (const a of waiting) await this.decide(a.id, 'Control Tower', 'deny', { note: reason });
    await this.db
      .updateTable('grants')
      .set({ revoked_at: Date.now() })
      .where('revoked_at', 'is', null)
      .where('approval_id', 'in', (eb) => eb.selectFrom('approvals').select('id').where('requester', '=', person))
      .execute();
    this.version.bump();
    return waiting.length;
  }

  private notify: RequesterNotify | undefined;
  /** Who to tell the person who asked (emails; see requester-mail.ts). */
  setNotifier(n: RequesterNotify): void {
    this.notify = n;
  }

  async decide(approvalId: string, by: string, action: 'approve' | 'deny', opts: { note?: string; window?: ApprovalWindow } = {}): Promise<{ ok: boolean; status: string }> {
    const now = Date.now();
    const status = action === 'approve' ? 'approved' : 'denied';
    const res = await this.db
      .updateTable('approvals')
      .set({ status, resolved_at: now, resolved_by: by, note: opts.note ?? null })
      .where('id', '=', approvalId)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) === 0) {
      const cur = await this.db.selectFrom('approvals').select(['status', 'resolved_by']).where('id', '=', approvalId).executeTakeFirst();
      return { ok: false, status: cur ? `already ${cur.status}${cur.resolved_by ? ` by ${cur.resolved_by}` : ''}` : 'not found' };
    }
    if (action === 'approve') {
      const a = (await this.db.selectFrom('approvals').selectAll().where('id', '=', approvalId).executeTakeFirst())!;
      const grantId = opaqueToken('ct_grn');
      const w = opts.window;
      // The calls on the card, plus — for a window — the next N like them.
      const held = Math.max(1, a.waiters);
      const uses = w ? held + Math.max(1, Math.min(WINDOW_MAX_USES, Math.floor(w.uses ?? 1))) : held;
      const ttl = Math.max(60_000, Math.min(WINDOW_MAX_TTL_MS, w?.ttl_ms ?? GRANT_TTL_MS));
      const target = (typeof a.target === 'string' ? JSON.parse(a.target) : a.target) as { name?: string; on_behalf_of?: string[] };
      await this.db
        .insertInto('grants')
        .values({
          id: grantId,
          approval_id: approvalId,
          key_id: a.key_id,
          scope_hash: a.scope_hash,
          uses_allowed: uses,
          uses_consumed: 0,
          not_before: now,
          expires_at: now + ttl,
          revoked_at: null,
          consumed_by_session: null,
          last_used_at: null,
          created_at: now,
          is_window: w && a.rule_id ? 1 : 0,
          rule_id: a.rule_id,
          rule_revision: a.rule_revision,
          target_name: target.name ?? null,
          any_args: w?.any_args ? 1 : 0,
          chain: target.on_behalf_of?.length ? JSON.stringify(target.on_behalf_of) : null,
        })
        .execute();
      await this.db.updateTable('approvals').set({ grant_id: grantId }).where('id', '=', approvalId).execute();
    }
    this.wake(approvalId, status);
    this.notify?.decided(approvalId, status, by, opts.note);
    this.onDecided?.(approvalId, status);
    this.version.bump();
    this.getLog().info({ approvalId, by, action }, 'approval decided');
    return { ok: true, status };
  }

  /** Take one use of an open approval window that covers this call, if there is one. */
  private async useWindow(keyId: string, ruleId: string, ruleRevision: number | null, targetName: string, scopeHash: string, chain: string[], flightId: string, principal: string | undefined): Promise<{ grantId: string; approvalId: string; by: string | undefined } | undefined> {
    const now = Date.now();
    const open = await this.db
      .selectFrom('grants')
      .innerJoin('approvals', 'approvals.id', 'grants.approval_id')
      .select(['grants.id as id', 'grants.approval_id as approval_id', 'grants.any_args as any_args', 'grants.scope_hash as scope_hash', 'grants.chain as chain', 'approvals.resolved_by as by', 'approvals.requester as requester'])
      .where('grants.is_window', '=', 1)
      .where('grants.key_id', '=', keyId)
      .where('grants.rule_id', '=', ruleId)
      .where('grants.target_name', '=', targetName)
      .where('grants.revoked_at', 'is', null)
      .where('grants.expires_at', '>', now)
      .where((eb) => eb('grants.uses_consumed', '<', eb.ref('grants.uses_allowed')))
      .orderBy('grants.created_at', 'desc')
      .execute();
    // A window opened for calls made on someone's behalf covers calls for that same chain only.
    const want = chain.length ? JSON.stringify(chain) : null;
    for (const g of open) {
      if (!g.any_args && g.scope_hash !== scopeHash) continue;
      if ((g.chain ?? null) !== want) continue;
      // A window opened for a person's request covers that person: others on the same key (a company's laptops share
      // one) ask for themselves.
      if (g.requester && g.requester !== principal) continue;
      const res = await this.db
        .updateTable('grants')
        .set((eb) => ({ uses_consumed: eb('uses_consumed', '+', 1), last_used_at: now, consumed_by_session: flightId }))
        .where('id', '=', g.id)
        .where('revoked_at', 'is', null)
        .where('expires_at', '>', now)
        .where((eb) => (ruleRevision === null ? eb('rule_revision', 'is', null) : eb('rule_revision', '=', ruleRevision)))
        .where((eb) => eb('uses_consumed', '<', eb.ref('uses_allowed')))
        .executeTakeFirst();
      if (Number(res.numUpdatedRows) > 0) return { grantId: g.id, approvalId: g.approval_id, by: g.by ?? undefined };
    }
    return undefined;
  }

  private async consumeGrant(grantId: string, keyId: string, scopeHash: string, sessionId: string | undefined): Promise<{ ok: true } | { ok: false; reason: RedeemFailReason }> {
    const now = Date.now();
    const res = await this.db
      .updateTable('grants')
      .set((eb) => ({ uses_consumed: eb('uses_consumed', '+', 1), last_used_at: now, consumed_by_session: sessionId ?? null }))
      .where('id', '=', grantId)
      .where('key_id', '=', keyId)
      .where('scope_hash', '=', scopeHash)
      .where('revoked_at', 'is', null)
      .where('not_before', '<=', now)
      .where('expires_at', '>', now)
      .where((eb) => eb('uses_consumed', '<', eb.ref('uses_allowed')))
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) > 0) return { ok: true };
    const g = await this.db.selectFrom('grants').selectAll().where('id', '=', grantId).executeTakeFirst();
    if (!g) return { ok: false, reason: 'unknown' };
    if (g.key_id !== keyId || g.scope_hash !== scopeHash) {
      this.getLog().warn({ grantId, keyId }, 'SECURITY: grant redeemed with mismatched scope (bait-and-switch?)');
      return { ok: false, reason: 'scope_mismatch' };
    }
    if (g.revoked_at) return { ok: false, reason: 'revoked' };
    if (g.expires_at <= now) return { ok: false, reason: 'expired' };
    // Same-session grace: a duplicate retry within 5 s re-uses the consumed grant.
    if (sessionId && g.consumed_by_session === sessionId && g.last_used_at && now - g.last_used_at < 5000) return { ok: true };
    return { ok: false, reason: 'exhausted' };
  }

  async redeem(token: string, keyId: string, scopeHash: string, sessionId: string | undefined): Promise<RedeemResult> {
    const now = Date.now();
    if (token.startsWith('ct_grn_')) {
      const g = await this.db.selectFrom('grants').select(['approval_id']).where('id', '=', token).executeTakeFirst();
      if (!g) return { ok: false, reason: 'unknown' };
      const c = await this.consumeGrant(token, keyId, scopeHash, sessionId);
      return c.ok ? { ok: true, grantId: token, approvalId: g.approval_id } : { ok: false, reason: c.reason, approvalId: g.approval_id };
    }
    if (token.startsWith('ct_tkt_')) {
      const t = await this.db.selectFrom('tickets').selectAll().where('id', '=', token).executeTakeFirst();
      if (!t || t.key_id !== keyId) return { ok: false, reason: 'unknown' };
      if (t.expires_at <= now) return { ok: false, reason: 'expired', approvalId: t.approval_id };
      const a = await this.db.selectFrom('approvals').selectAll().where('id', '=', t.approval_id).executeTakeFirst();
      if (!a) return { ok: false, reason: 'unknown' };
      if (a.status === 'pending') return { ok: false, reason: 'pending', approvalId: a.id, retryAfterMs: 15_000 };
      if (a.status === 'denied') return { ok: false, reason: 'denied', approvalId: a.id };
      if (a.status !== 'approved' || !a.grant_id) return { ok: false, reason: 'expired', approvalId: a.id };
      const c = await this.consumeGrant(a.grant_id, keyId, scopeHash, sessionId);
      return c.ok ? { ok: true, grantId: a.grant_id, approvalId: a.id } : { ok: false, reason: c.reason, approvalId: a.id };
    }
    return { ok: false, reason: 'unknown' };
  }

  async revokeGrant(grantId: string): Promise<boolean> {
    const res = await this.db.updateTable('grants').set({ revoked_at: Date.now() }).where('id', '=', grantId).where('revoked_at', 'is', null).executeTakeFirst();
    this.version.bump();
    return Number(res.numUpdatedRows) > 0;
  }

  drain(): void {
    for (const [id] of this.waiters) this.wake(id, 'drained');
  }

  private async sweep(): Promise<void> {
    const now = Date.now();
    const expired = await this.db.selectFrom('approvals').select('id').where('status', '=', 'pending').where('expires_at', '<=', now).execute();
    if (expired.length === 0) return;
    await this.db
      .updateTable('approvals')
      .set({ status: 'expired', resolved_at: now })
      .where('status', '=', 'pending')
      .where('expires_at', '<=', now)
      .execute();
    for (const e of expired) {
      this.wake(e.id, 'expired');
      this.notify?.decided(e.id, 'expired', undefined, null);
    }
    this.version.bump();
  }
}

/** Never the model's summary: the actual (bounded) wire arguments. */
function previewArgs(flight: Flight): Record<string, unknown> {
  if (flight.kind === 'mcp.tool') return (flight.body.arguments as Record<string, unknown>) ?? {};
  // HTTP: the request itself — method, path, query and (possibly truncated) body.
  if (flight.kind === 'http.request') {
    const a = (flight.body.arguments as Record<string, unknown>) ?? {};
    const body = a.body === undefined ? '' : typeof a.body === 'string' ? a.body : JSON.stringify(a.body);
    return body.length > 4000 ? { ...a, body: `${body.slice(0, 4000)}… (${Math.round(body.length / 1024)} KB, truncated)` } : a;
  }
  // A2A: the method and the message's text, and which task it continues.
  if (flight.kind === 'a2a.call') {
    const a = (flight.body.arguments as Record<string, unknown>) ?? {};
    const msg = (a.message ?? {}) as { parts?: Array<{ text?: unknown }>; taskId?: unknown; contextId?: unknown };
    const text = (msg.parts ?? []).map((p) => (typeof p?.text === 'string' ? p.text : '')).join(' ').trim();
    return { method: flight.body.method, ...(text ? { message: text.slice(0, 2000) } : {}), ...(msg.taskId ? { task_id: msg.taskId } : a.id ? { task_id: a.id } : {}), ...(msg.contextId ? { context_id: msg.contextId } : {}) };
  }
  const text = lastUserText(flight.body);
  const tools = Array.isArray(flight.body.tools) ? (flight.body.tools as Array<{ function?: { name?: string }; name?: string; type?: string }>).map((t) => t.function?.name ?? t.name ?? t.type).filter(Boolean) : [];
  const maxTokens = flight.body.max_tokens ?? flight.body.max_output_tokens;
  const instructions = typeof flight.body.instructions === 'string' ? flight.body.instructions.slice(0, 200) : undefined;
  return { model: flight.modelRequested, stream: flight.stream, max_tokens: maxTokens, ...(instructions ? { instructions } : {}), last_user_message: text.slice(0, 500), tools };
}

/**
 * What the person last typed: the last text in the last user message. Chat and Messages carry `messages`; the Responses
 * API carries `input` (a string or input items). Claude Code adds context of its own to that message
 * (`<system-reminder>…`): that isn't what they typed, unless it's all there is. And an unanswered try is merged into the
 * next user message (turns must alternate), so the last text is the newest.
 */
export function lastUserText(body: Record<string, unknown>): string {
  const input = body.input;
  if (typeof input === 'string') return input;
  const msgs = (Array.isArray(body.messages) ? body.messages : Array.isArray(input) ? input : []) as Array<{ role?: string; content?: unknown }>;
  const last = msgs.filter((m) => m.role === 'user').pop();
  if (typeof last?.content === 'string') return last.content;
  if (!Array.isArray(last?.content)) return last?.content != null ? JSON.stringify(last.content) : '';
  const texts = (last.content as Array<{ text?: unknown }>).map((p) => (typeof p?.text === 'string' ? p.text.trim() : '')).filter(Boolean);
  const own = texts.filter((t) => !t.startsWith('<system-reminder>'));
  return (own.length ? own : texts).pop() ?? '';
}

/** What the person typed in a message: its text, without the context their app adds (`<system-reminder>…`). */
function ownTexts(content: unknown): string[] {
  if (typeof content === 'string') return content.trim() && !content.trim().startsWith('<system-reminder>') ? [content.trim()] : [];
  if (!Array.isArray(content)) return [];
  return (content as Array<{ text?: unknown }>).map((p) => (typeof p?.text === 'string' ? p.text.trim() : '')).filter((t) => t && !t.startsWith('<system-reminder>'));
}

/**
 * A step the app takes on its own, in a task the person started: the newest message carries tools' results, nothing
 * they typed. Messages: a `tool` message (Chat), or a user message of `tool_result` blocks (Messages); the Responses
 * API: a tool's output item last.
 */
export function isFollowUp(body: Record<string, unknown>): boolean {
  const list = (Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : []) as Array<{ role?: string; type?: string; content?: unknown }>;
  const last = list[list.length - 1];
  if (!last) return false;
  if (last.role === 'tool') return true;
  if (typeof last.type === 'string' && /(_call_output|tool_result)$/.test(last.type)) return true;
  if (last.role === 'user' && Array.isArray(last.content)) {
    const blocks = last.content as Array<{ type?: string }>;
    return blocks.some((b) => b?.type === 'tool_result') && ownTexts(last.content).length === 0;
  }
  return false;
}

/** The task a step belongs to: what the person last typed, anywhere in the conversation. */
export function taskText(body: Record<string, unknown>): string {
  const list = (Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : []) as Array<{ role?: string; content?: unknown }>;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.role !== 'user') continue;
    const own = ownTexts(list[i]!.content);
    if (own.length) return own[own.length - 1]!;
  }
  return '';
}
