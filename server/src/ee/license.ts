import crypto from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';
import { seatsUsed } from './seats.js';

/**
 * Control Tower Enterprise licenses. A license key is `ctl1.<payload>.<signature>`: a JSON payload signed with
 * the licensor's Ed25519 key, checked here against the public key built into every release — offline, so it
 * works air-gapped. A server that can reach the license service also refreshes the key daily (renewals, a
 * change of seats), but never needs to.
 *
 * Without a valid license the Enterprise features are off; nothing else changes. Gateway traffic is never
 * stopped by licensing: not at expiry, not over the request allowance.
 */

/** Public keys that sign licenses, by id. A new key can be added before the old one is retired. */
const PUBLIC_KEYS: Record<string, string> = {
  k1: 'aiCcvF3waHIjPVc5XwdkHnmVWYQNUE1lFMhrZq50Zb4',
};

/** Where plans, checkout and trial keys are (the license service). */
export const LICENSE_STORE: string | null = 'https://license.agentcontroltower.app';

export const FEATURES = ['sso', 'scim', 'audit', 'jwt_auth', 'secret_managers', 'orgs', 'multi_region', 'siem_export'] as const;
export type Feature = (typeof FEATURES)[number];

/** Enterprise features keep working this long after a license's end date, while it renews. Trials have none: nothing renews them. */
export const GRACE_MS = 14 * 24 * 3600_000;
export const graceOf = (l: Pick<LicensePayload, 'plan'>): number => (l.plan === 'trial' ? 0 : GRACE_MS);

/** A license's status at a moment: valid, then expiring (30 days before its end), grace (after it), expired. */
export function statusAt(l: LicensePayload, now: number): Exclude<LicenseStatus, 'none' | 'invalid'> {
  return now > l.expires_at + graceOf(l) ? 'expired' : now > l.expires_at ? 'grace' : now > l.expires_at - WARN_MS ? 'expiring' : 'valid';
}
/** The console starts saying a license is ending this long before. */
export const WARN_MS = 30 * 24 * 3600_000;

export interface LicensePayload {
  v: 1;
  /** Signing key id. */
  kid: string;
  /** License id (stable across renewals of one subscription). */
  id: string;
  customer: string;
  email: string;
  plan: 'enterprise' | 'trial';
  /** People who may sign in through single sign-on or be provisioned by SCIM. */
  seats: number;
  /** Requests a year included; over it the console warns, traffic is never stopped. 0 means unlimited. */
  requests_per_year: number;
  /** Features included; ["*"] for all. */
  features: string[];
  issued_at: number;
  expires_at: number;
  /** The subscription behind it, for renewals (opaque here). */
  sub?: string;
  /** When the subscription began: license years (for the request allowance) run from it. */
  period_start?: number;
}

export type LicenseStatus = 'none' | 'valid' | 'expiring' | 'grace' | 'expired' | 'invalid';
export interface LicenseState {
  status: LicenseStatus;
  license?: LicensePayload;
  reason?: string;
  /** Where the key came from. */
  source?: 'env' | 'console';
}

const b64u = (b: Buffer) => b.toString('base64url');

/** Verify a key's signature and shape. Returns the payload, or why it isn't a license. */
export function parseLicense(key: string, keys: Record<string, string> = publicKeys()): { ok: true; license: LicensePayload } | { ok: false; reason: string } {
  const parts = key.trim().split('.');
  if (parts.length !== 3 || parts[0] !== 'ctl1') return { ok: false, reason: 'This is not a Control Tower license key (they start with ctl1.).' };
  let payload: LicensePayload;
  try {
    payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as LicensePayload;
  } catch {
    return { ok: false, reason: 'The license key is damaged. Copy it again, whole.' };
  }
  const pub = keys[payload.kid];
  if (!pub) return { ok: false, reason: 'The license key was signed by a key this version does not know. Upgrade Control Tower.' };
  const publicKey = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pub }, format: 'jwk' });
  if (!crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2]!, 'base64url'))) {
    return { ok: false, reason: 'The license key is not valid: its signature does not match.' };
  }
  if (payload.v !== 1 || typeof payload.expires_at !== 'number' || !Array.isArray(payload.features)) return { ok: false, reason: 'The license key is not in a format this version understands.' };
  return { ok: true, license: payload };
}

/** Sign a license (the license service does this; tests too, with a key of their own). */
export function signLicense(payload: LicensePayload, privateKey: crypto.KeyObject): string {
  const head = `ctl1.${b64u(Buffer.from(JSON.stringify(payload)))}`;
  return `${head}.${b64u(crypto.sign(null, Buffer.from(head), privateKey))}`;
}

/** Set when the server is bundled (server/build.mjs): true only in test builds. Undefined when run from source. */
declare const __CT_TEST_LICENSE_KEYS__: boolean | undefined;
const TEST_KEYS = typeof __CT_TEST_LICENSE_KEYS__ === 'undefined' ? true : __CT_TEST_LICENSE_KEYS__;

/**
 * The keys this build trusts. Test builds, and the server run from source, also trust CT_LICENSE_PUBLIC_KEY, so
 * tests can sign licenses of their own. Release builds never do, whatever the environment says: the image and the
 * npm package are bundled without that code.
 */
function publicKeys(): Record<string, string> {
  if (!TEST_KEYS || !process.env.CT_LICENSE_PUBLIC_KEY) return PUBLIC_KEYS;
  return { ...PUBLIC_KEYS, test: process.env.CT_LICENSE_PUBLIC_KEY };
}

export function stateOf(key: string | undefined, source: LicenseState['source'], now = Date.now()): LicenseState {
  if (!key) return { status: 'none' };
  const p = parseLicense(key);
  if (!p.ok) return { status: 'invalid', reason: p.reason, ...(source ? { source } : {}) };
  return { status: statusAt(p.license, now), license: p.license, ...(source ? { source } : {}) };
}

/** The license in force: CT_LICENSE_KEY, else the key an admin entered in the console. */
export class Licensing {
  private state: LicenseState = { status: 'none' };
  private listeners = new Set<() => void>();

  constructor(private readonly db: Kysely<Database>, private readonly envKey: string | undefined) {}

  private raw: string | undefined;

  /** Load again (and, with several instances, on all of them: see Cluster.syncReloads). */
  async reload(): Promise<void> {
    await this.load();
  }

  async load(): Promise<LicenseState> {
    const rows = await this.db.selectFrom('settings').select(['key', 'value']).where('key', 'in', ['license_key', 'license_key_renewed']).execute();
    const get = (k: string) => rows.find((r) => r.key === k)?.value;
    let key = this.envKey ?? get('license_key');
    let state = stateOf(key, this.envKey ? 'env' : 'console');
    // A renewal fetched from the license service replaces the key it renews while it is the newer of the two.
    const renewed = get('license_key_renewed');
    if (renewed && state.license) {
      const r = stateOf(renewed, state.source);
      // The newest key the license service issued for this license wins: a renewal, or a key shortened because the
      // subscription ended early (refunded, say).
      if (r.license && r.license.id === state.license.id && r.license.issued_at >= state.license.issued_at) {
        key = renewed;
        state = r;
      }
    }
    this.raw = key;
    this.state = state;
    for (const l of this.listeners) l();
    return this.state;
  }

  /**
   * Ask the license service for a renewed key (a subscription renewed, or its seats changed). Only keys that
   * belong to a subscription are sent; air-gapped servers (no license server) never call out.
   */
  async refresh(server: string, log: { info(o: object, m: string): void; warn(o: object, m: string): void }): Promise<'renewed' | 'unchanged' | 'ended' | 'skipped' | 'failed'> {
    const l = this.state.license;
    if (!l?.sub || !this.raw) return 'skipped';
    try {
      // With the key goes this license year's request count (a number, nothing else), for renewals and capacity.
      const u = await this.usage?.().catch(() => undefined);
      const usage = u ? { requests: u.used, period_start: u.period_start, period_end: u.period_end } : undefined;
      // And whether the clock was found set back (the latest time seen, how far behind): nothing else about the server.
      const c = this.clock?.();
      const clock = c?.behind ? { behind_ms: c.behind_ms, latest_seen: c.high_water } : undefined;
      // And how many people use seats now (a number), so seats can't be reduced below it.
      const seats_used = await seatsUsed(this.db).catch(() => undefined);
      const r = await fetch(`${server.replace(/\/+$/, '')}/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: this.raw, ...(usage ? { usage } : {}), ...(clock ? { clock } : {}), ...(seats_used !== undefined ? { seats_used } : {}) }), signal: AbortSignal.timeout(15_000) });
      const j = (await r.json()) as { status?: string; key?: string };
      if (j.status === 'renewed' && j.key) {
        const next = parseLicense(j.key);
        if (!next.ok || next.license.id !== l.id) return 'failed';
        const now = Date.now();
        await this.db.insertInto('settings').values({ key: 'license_key_renewed', value: j.key, updated_at: now }).onConflict((oc) => oc.column('key').doUpdateSet({ value: j.key!, updated_at: now })).execute();
        await this.reload();
        log.info({ customer: next.license.customer, until: new Date(next.license.expires_at).toISOString().slice(0, 10), seats: next.license.seats }, 'license renewed');
        return 'renewed';
      }
      if (j.status === 'ended') {
        // A subscription that ended before the key did: its key ends then (it comes signed, for this license).
        const short = j.key ? parseLicense(j.key) : undefined;
        if (short?.ok && short.license.id === l.id && short.license.expires_at < l.expires_at) {
          const now = Date.now();
          await this.db.insertInto('settings').values({ key: 'license_key_renewed', value: j.key!, updated_at: now }).onConflict((oc) => oc.column('key').doUpdateSet({ value: j.key!, updated_at: now })).execute();
          await this.reload();
        }
        log.warn({ customer: l.customer, ends: new Date((short?.ok ? short.license : l).expires_at).toISOString().slice(0, 10) }, 'license: the subscription behind it has ended; Enterprise features stop after its end date and grace period');
        return 'ended';
      }
      return 'unchanged';
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'license: could not reach the license service (the current key keeps working)');
      return 'failed';
    }
  }

  /** Whether the clock has been set back, sent with renewals (set by the clock watch). */
  clock: (() => { behind: boolean; behind_ms: number; high_water: number | null }) | undefined;

  /** This license year's request count, sent with renewals (set by the metering service). */
  usage: (() => Promise<{ used: number; period_start: number; period_end: number } | undefined>) | undefined;

  /**
   * Refresh a minute after start and then daily, or hourly from a day before the key's end date until a renewal comes
   * (a renewal is charged at the end date, and its key is only issued once the payment has gone through).
   */
  startRefresh(server: string | undefined, log: Parameters<Licensing['refresh']>[1]): () => void {
    if (!server) return () => undefined;
    let last = 0;
    const tick = (): void => {
      const l = this.state.license;
      const now = Date.now();
      const nearEnd = !!l?.sub && l.expires_at - now < 24 * 3600_000 && now - l.expires_at < 15 * 24 * 3600_000;
      if (now - last < (nearEnd ? 3600_000 : 24 * 3600_000) - 60_000) return;
      last = now;
      void this.refresh(server, log);
    };
    const first = setTimeout(tick, 60_000);
    const hourly = setInterval(tick, 3600_000);
    first.unref?.();
    hourly.unref?.();
    return () => {
      clearTimeout(first);
      clearInterval(hourly);
    };
  }

  /** The state now: a license moves from valid to expiring, grace and expired with the clock, without a reload. */
  get current(): LicenseState {
    return this.state.license ? { ...this.state, ...recompute(this.state) } : this.state;
  }

  /** Whether an Enterprise feature is on now: a license in force (grace included) that includes it. */
  allows(feature: Feature): boolean {
    const s = this.current;
    if (!s.license || (s.status !== 'valid' && s.status !== 'expiring' && s.status !== 'grace')) return false;
    return s.license.features.includes('*') || s.license.features.includes(feature);
  }

  get seats(): number {
    return this.allows('sso') || this.allows('scim') ? (this.current.license?.seats ?? 0) : 0;
  }

  /** Save a key entered in the console. Refused when CT_LICENSE_KEY is set (the environment decides then). */
  async save(key: string | null): Promise<LicenseState> {
    if (this.envKey) throw new Error('CT_LICENSE_KEY is set: change the license there.');
    if (key) {
      const p = parseLicense(key);
      if (!p.ok) throw new Error(p.reason);
    }
    const now = Date.now();
    if (key) await this.db.insertInto('settings').values({ key: 'license_key', value: key.trim(), updated_at: now }).onConflict((oc) => oc.column('key').doUpdateSet({ value: key.trim(), updated_at: now })).execute();
    else await this.db.deleteFrom('settings').where('key', '=', 'license_key').execute();
    // A key added by hand replaces any renewal of the one before.
    await this.db.deleteFrom('settings').where('key', '=', 'license_key_renewed').execute();
    await this.reload();
    return this.state;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

function recompute(s: LicenseState): Partial<LicenseState> {
  return s.license ? { status: statusAt(s.license, Date.now()) } : {};
}
