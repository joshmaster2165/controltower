import crypto from 'node:crypto';
import type { KeyRecord } from '../registry.js';
import type { AppContext } from '../context.js';
import { E, type GatewayError } from '../gateway/errors.js';

/**
 * Delegation: which agents a call is made on behalf of.
 *
 * When agent A's call reaches agent B through Control Tower — a tool server
 * or HTTP API that fronts B — the request to B carries a delegation token:
 * "this is B, called by A". B passes it back on its own calls
 * (`x-ct-delegation`), so they are recorded, and can be gated, as made on
 * behalf of A; when B in turn calls C, C's token says "called by B, on behalf
 * of A". Tokens are signed with a key derived from the master key and never
 * stored, expire quickly, and are bound to the agent they were issued to: a
 * token passed to another agent is refused. A key marked delegated-only
 * cannot drop its token to escape a rule — its calls without one are refused.
 *
 *   ctd1.<payload, base64url JSON>.<HMAC-SHA256, base64url>
 *   payload: { c: chain (origin first), t: agent the token was issued to, e: expiry (ms), f: flight id }
 */
export const DELEGATION_HEADER = 'x-ct-delegation';
/** Where an MCP server finds the token in a tools/call: params._meta[DELEGATION_META]. */
export const DELEGATION_META = 'controltower/delegation';
const PREFIX = 'ctd1';
const TTL_MS = 15 * 60_000;
/** A chain deeper than this is refused: agents calling agents calling agents in a loop. */
export const MAX_CHAIN = 8;

export type DelegationCheck = { ok: true; chain: string[] } | { ok: false; reason: string };

export class Delegations {
  constructor(private readonly secret: Buffer) {}

  private sign(payload: string): string {
    return crypto.createHmac('sha256', this.secret).update(`${PREFIX}.${payload}`).digest('base64url');
  }

  /** A token for `to`, called on behalf of `chain` (origin first). */
  issue(chain: string[], to: string, flightId: string, now = Date.now()): string {
    const payload = Buffer.from(JSON.stringify({ c: chain, t: to, e: now + TTL_MS, f: flightId })).toString('base64url');
    return `${PREFIX}.${payload}.${this.sign(payload)}`;
  }

  /** Check a presented token against the agent presenting it. */
  verify(token: string, presenter: string, now = Date.now()): DelegationCheck {
    const parts = token.trim().split('.');
    if (parts.length !== 3 || parts[0] !== PREFIX) return { ok: false, reason: 'not a Control Tower delegation token' };
    const [, payload, sig] = parts as [string, string, string];
    const want = Buffer.from(this.sign(payload));
    const got = Buffer.from(sig);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return { ok: false, reason: 'the delegation token signature does not match' };
    let p: { c?: unknown; t?: unknown; e?: unknown };
    try {
      p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as typeof p;
    } catch {
      return { ok: false, reason: 'the delegation token is malformed' };
    }
    if (typeof p.e !== 'number' || p.e < now) return { ok: false, reason: 'the delegation token has expired' };
    if (p.t !== presenter) return { ok: false, reason: `the delegation token was issued to another agent ("${String(p.t)}")` };
    if (!Array.isArray(p.c) || !p.c.every((x) => typeof x === 'string')) return { ok: false, reason: 'the delegation token is malformed' };
    return { ok: true, chain: p.c as string[] };
  }
}

/** The name a key's agent goes by in delegation chains: its agent id, else the key id. */
export const agentRef = (key: KeyRecord): string => key.agentId ?? key.id;

export type Resolved = { chain: string[]; onBehalfOf: string[]; invalid?: string } | { error: GatewayError };

/**
 * Whom a call is made on behalf of, from the token it presented. A delegated-only key without a
 * valid token is refused; an ordinary key with an invalid one acts on its own account.
 */
export function resolveDelegation(ctx: Pick<AppContext, 'delegations' | 'registry'>, key: KeyRecord, token: string | undefined): Resolved {
  if (!token) return key.delegatedOnly ? { error: E.delegationRequired('this call carried no delegation token') } : { chain: [], onBehalfOf: [] };
  const r = ctx.delegations.verify(token, agentRef(key));
  if (!r.ok) return key.delegatedOnly ? { error: E.delegationRequired(r.reason) } : { chain: [], onBehalfOf: [], invalid: r.reason };
  if (r.chain.length >= MAX_CHAIN) return { error: E.delegationTooDeep() };
  const onBehalfOf = r.chain.flatMap((a) => [`agent:${a}`, ...[...(ctx.registry.agentTeams.get(a) ?? [])].map((t) => `team:${t}`)]);
  return { chain: r.chain, onBehalfOf };
}

/** The token for an agent this call reaches (a tool server or HTTP API that fronts it). */
export function tokenFor(ctx: Pick<AppContext, 'delegations'>, chain: string[], key: KeyRecord, to: string, flightId: string): string {
  return ctx.delegations.issue([...chain, agentRef(key)], to, flightId);
}

export const headerToken = (headers: Record<string, string | string[] | undefined>): string | undefined => {
  const v = headers[DELEGATION_HEADER];
  return Array.isArray(v) ? v[0] : v || undefined;
};
