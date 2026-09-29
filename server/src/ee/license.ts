import crypto from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';

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
export const LICENSE_STORE: string | null = null;

export const FEATURES = ['sso', 'scim', 'audit', 'jwt_auth', 'secret_managers', 'orgs', 'multi_region', 'siem_export'] as const;
export type Feature = (typeof FEATURES)[number];

/** Enterprise features keep working this long after a license's end date, while it renews. */
export const GRACE_MS = 14 * 24 * 3600_000;
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

/**
 * The keys this build trusts. Development builds (not NODE_ENV=production) also trust CT_LICENSE_PUBLIC_KEY, so
 * tests can sign licenses of their own; the published image never does.
 */
function publicKeys(): Record<string, string> {
  const extra = process.env.NODE_ENV !== 'production' && process.env.CT_LICENSE_PUBLIC_KEY ? { test: process.env.CT_LICENSE_PUBLIC_KEY } : {};
  return { ...PUBLIC_KEYS, ...extra };
}

export function stateOf(key: string | undefined, source: LicenseState['source'], now = Date.now()): LicenseState {
  if (!key) return { status: 'none' };
  const p = parseLicense(key);
  if (!p.ok) return { status: 'invalid', reason: p.reason, ...(source ? { source } : {}) };
  const l = p.license;
  const status: LicenseStatus = now > l.expires_at + GRACE_MS ? 'expired' : now > l.expires_at ? 'grace' : now > l.expires_at - WARN_MS ? 'expiring' : 'valid';
  return { status, license: l, ...(source ? { source } : {}) };
}

/** The license in force: CT_LICENSE_KEY, else the key an admin entered in the console. */
export class Licensing {
  private state: LicenseState = { status: 'none' };
  private listeners = new Set<() => void>();

  constructor(private readonly db: Kysely<Database>, private readonly envKey: string | undefined) {}

  async load(): Promise<LicenseState> {
    const stored = await this.db.selectFrom('settings').select('value').where('key', '=', 'license_key').executeTakeFirst();
    this.state = this.envKey ? stateOf(this.envKey, 'env') : stateOf(stored?.value, 'console');
    for (const l of this.listeners) l();
    return this.state;
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
    return this.load();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

function recompute(s: LicenseState): Partial<LicenseState> {
  if (!s.license) return {};
  const now = Date.now();
  const l = s.license;
  return { status: now > l.expires_at + GRACE_MS ? 'expired' : now > l.expires_at ? 'grace' : now > l.expires_at - WARN_MS ? 'expiring' : 'valid' };
}
