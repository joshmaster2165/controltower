import crypto from 'node:crypto';
import type { Kysely } from 'kysely';
import { ulid } from 'ulid';
import type { Database } from '../db/schema.js';
import type { KeyRecord } from '../registry.js';
import { keyProblem } from '../gateway/key.js';
import { randomToken, sha256Hex } from '../crypto/secrets.js';

/**
 * Laptop sign-in (Enterprise). A helper on the laptop (ct-auth) starts a sign-in (RFC 8628, the device flow); the
 * person approves it in the console after signing in as usual (single sign-on or a password); the laptop gets a
 * refresh token for its keychain and short-lived access tokens for Claude Code, Claude Desktop or Codex.
 *
 * Access tokens are signed, not stored: `ct_dt_<payload>.<hmac>`, naming the session, the key the calls are made as
 * and the person. They're checked without a database read, and refused at once when their session is revoked or
 * their person deactivated (every instance reloads what's revoked within a minute, and at once through the cluster).
 */
export const DEVICE_TOKEN_PREFIX = 'ct_dt_';
export const CLIENTS = ['claude-code', 'claude-desktop', 'codex', 'other'] as const;
export type DeviceClient = (typeof CLIENTS)[number];
export const CLIENT_NAMES: Record<DeviceClient, string> = { 'claude-code': 'Claude Code', 'claude-desktop': 'Claude Desktop', codex: 'Codex', other: 'Another tool' };

export const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const CODE_TTL_MS = 10 * 60_000;
/** Seconds between polls (RFC 8628 §3.5): faster gets slow_down. */
export const POLL_INTERVAL_S = 5;
/** Lifetime of an access token: an hour unless CT_DEVICE_TOKEN_TTL_S says otherwise (5 minutes to a day). */
export const ACCESS_TTL_S = Math.min(86_400, Math.max(300, Number(process.env.CT_DEVICE_TOKEN_TTL_S) || 3600));
/** User codes: consonants only (no vowels, so no words), unambiguous, 8 characters as XXXX-XXXX. */
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
const DAY = 86_400_000;

export interface DeviceRule {
  id: string;
  client: string;
  teamId: string | null;
  keyId: string;
}

export interface DeviceSettings {
  /** A laptop signs in again after this many days, whatever happens. */
  sessionDays: number;
  /** …or after this many days unused. */
  idleDays: number;
}
export const DEFAULT_SETTINGS: DeviceSettings = { sessionDays: 90, idleDays: 30 };

export interface DeviceToken {
  sessionId: string;
  keyId: string;
  /** The person, by email: recorded on each call as who made it. */
  principal: string;
  client: string;
  /** The computer it was signed in on, as the person named it (tokens minted before 0.2.10 don't say). */
  deviceName?: string | undefined;
  exp: number;
}

export type TokenResponse =
  | { ok: true; access_token: string; token_type: 'Bearer'; expires_in: number; refresh_token?: string; key_name: string; person: string }
  | { ok: false; error: 'authorization_pending' | 'slow_down' | 'access_denied' | 'expired_token' | 'invalid_grant' | 'unavailable'; error_description: string };

export const isClient = (c: unknown): c is DeviceClient => typeof c === 'string' && (CLIENTS as readonly string[]).includes(c);

export function newUserCode(): string {
  const b = crypto.randomBytes(8);
  const c = [...b].map((x) => USER_CODE_ALPHABET[x % USER_CODE_ALPHABET.length]).join('');
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}
/** What people type, tidied: case, spaces and the dash don't matter. */
export function normaliseUserCode(s: string): string {
  const c = s.toUpperCase().replace(/[^A-Z]/g, '');
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : '';
}

export class DeviceAuth {
  private rules: DeviceRule[] = [];
  private revoked = new Set<string>();
  settings: DeviceSettings = { ...DEFAULT_SETTINGS };
  private timer: NodeJS.Timeout | undefined;
  private lastSweep = 0;

  constructor(
    private readonly deps: {
      db: Kysely<Database>;
      /** Signs access tokens (derived from the master key, so every instance sharing a database agrees). */
      key: Buffer;
      keys: () => Map<string, KeyRecord>;
      /** Whether the license includes laptop sign-in: tokens are refused while it doesn't. */
      allowed: () => boolean;
    },
  ) {}

  /** Rules, settings, and which sessions may no longer be used (revoked, or their person deactivated or removed). */
  async reload(): Promise<void> {
    const db = this.deps.db;
    const rules = await db.selectFrom('device_rules').selectAll().orderBy('position').execute();
    this.rules = rules.map((r) => ({ id: r.id, client: r.client, teamId: r.team_id, keyId: r.key_id }));
    const rows = await db.selectFrom('settings').select(['key', 'value']).where('key', 'in', ['devices_session_days', 'devices_idle_days']).execute();
    const num = (k: string, d: number) => {
      const v = Number(rows.find((r) => r.key === k)?.value);
      return Number.isFinite(v) && v >= 1 ? Math.round(v) : d;
    };
    this.settings = { sessionDays: num('devices_session_days', DEFAULT_SETTINGS.sessionDays), idleDays: num('devices_idle_days', DEFAULT_SETTINGS.idleDays) };
    // Only sessions whose access tokens may still be out there matter: those ended in the last token lifetime.
    const since = Date.now() - ACCESS_TTL_S * 1000 - 60_000;
    const ended = await db.selectFrom('device_sessions').select('id').where('revoked_at', '>=', since).execute();
    const gone = await db
      .selectFrom('device_sessions as s')
      .leftJoin('admins as a', 'a.id', 's.admin_id')
      .select('s.id')
      .where('s.revoked_at', 'is', null)
      .where('s.last_used_at', '>=', since)
      .where((eb) => eb.or([eb('a.id', 'is', null), eb('a.disabled', '!=', 0)]))
      .execute();
    this.revoked = new Set([...ended, ...gone].map((r) => r.id));
  }

  /** Reload every minute (people deactivated elsewhere, by SCIM say), and tidy up old sign-ins hourly. */
  start(): void {
    this.timer ??= setInterval(() => {
      void this.reload().catch(() => undefined);
      if (Date.now() - this.lastSweep > 3600_000) {
        this.lastSweep = Date.now();
        void this.sweep().catch(() => undefined);
      }
    }, 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  get ruleList(): DeviceRule[] {
    return this.rules;
  }

  // ---- access tokens ----

  private sign(payload: string): string {
    return crypto.createHmac('sha256', this.deps.key).update(`${DEVICE_TOKEN_PREFIX}${payload}`).digest('base64url');
  }

  mint(t: Omit<DeviceToken, 'exp'>, now = Date.now()): { token: string; exp: number } {
    const exp = now + ACCESS_TTL_S * 1000;
    const payload = Buffer.from(JSON.stringify({ s: t.sessionId, k: t.keyId, p: t.principal, c: t.client, ...(t.deviceName ? { d: t.deviceName.slice(0, 80) } : {}), e: exp })).toString('base64url');
    return { token: `${DEVICE_TOKEN_PREFIX}${payload}.${this.sign(payload)}`, exp };
  }

  /** What an access token stands for, if it's genuine, current, its session still good and the license allows it. */
  verify(token: string, now = Date.now()): DeviceToken | undefined {
    if (!token.startsWith(DEVICE_TOKEN_PREFIX) || token.length > 2048) return undefined;
    const [payload, sig] = token.slice(DEVICE_TOKEN_PREFIX.length).split('.');
    if (!payload || !sig) return undefined;
    const want = Buffer.from(this.sign(payload));
    const got = Buffer.from(sig);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return undefined;
    let p: { s?: unknown; k?: unknown; p?: unknown; c?: unknown; d?: unknown; e?: unknown };
    try {
      p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return undefined;
    }
    if (typeof p.s !== 'string' || typeof p.k !== 'string' || typeof p.p !== 'string' || typeof p.e !== 'number') return undefined;
    if (p.e <= now || this.revoked.has(p.s) || !this.deps.allowed()) return undefined;
    return { sessionId: p.s, keyId: p.k, principal: p.p, client: typeof p.c === 'string' ? p.c : 'other', ...(typeof p.d === 'string' && p.d ? { deviceName: p.d } : {}), exp: p.e };
  }

  /** The key an access token's calls are made as (it must still exist and be usable). */
  keyFor(token: string): KeyRecord | undefined {
    const t = this.verify(token);
    const key = t ? this.deps.keys().get(t.keyId) : undefined;
    return key && !keyProblem(key) ? key : undefined;
  }

  // ---- which key ----

  /** The key a person's calls from a client are made as: the first rule for that client and one of their teams (or everyone). */
  async keyForPerson(adminId: string, client: string): Promise<{ key: KeyRecord } | { problem: string }> {
    const teams = new Set((await this.deps.db.selectFrom('memberships').select('scope_id').where('admin_id', '=', adminId).where('scope_type', '=', 'team').execute()).map((r) => r.scope_id));
    const rule = this.rules.find((r) => (r.client === '*' || r.client === client) && (!r.teamId || teams.has(r.teamId)));
    const name = isClient(client) ? CLIENT_NAMES[client] : client;
    if (!rule) return { problem: `No laptop sign-in rule covers you for ${name}. Ask an admin to add one under Laptops.` };
    const key = this.deps.keys().get(rule.keyId);
    if (!key) return { problem: `The laptop sign-in rule for ${name} names a key that no longer exists. Ask an admin.` };
    const why = keyProblem(key);
    if (why) return { problem: `The key ${name} uses (${key.name}) is ${why}. Ask an admin.` };
    return { key };
  }

  // ---- the device flow ----

  async begin(r: { client: DeviceClient; deviceName: string; ip: string }, now = Date.now()) {
    const deviceCode = randomToken(32);
    let userCode = newUserCode();
    for (let i = 0; i < 5; i++) {
      const taken = await this.deps.db.selectFrom('device_codes').select('user_code').where('user_code', '=', userCode).executeTakeFirst();
      if (!taken) break;
      userCode = newUserCode();
    }
    await this.deps.db
      .insertInto('device_codes')
      .values({ code_hash: sha256Hex(deviceCode), user_code: userCode, client: r.client, device_name: r.deviceName.slice(0, 120) || 'a computer', ip: r.ip.slice(0, 64), created_at: now, expires_at: now + CODE_TTL_MS, last_poll_at: null, status: 'pending', admin_id: null })
      .execute();
    return { deviceCode, userCode, expiresIn: CODE_TTL_MS / 1000, interval: POLL_INTERVAL_S };
  }

  /** A sign-in waiting for approval, by the code the person sees. */
  async pending(userCode: string, now = Date.now()) {
    const code = normaliseUserCode(userCode);
    if (!code) return undefined;
    const row = await this.deps.db.selectFrom('device_codes').selectAll().where('user_code', '=', code).executeTakeFirst();
    if (!row || row.status !== 'pending' || row.expires_at < now) return undefined;
    return row;
  }

  /** The person approves (or refuses) a sign-in they started. */
  async decide(userCode: string, adminId: string, approve: boolean, now = Date.now()): Promise<boolean> {
    const code = normaliseUserCode(userCode);
    const r = await this.deps.db
      .updateTable('device_codes')
      .set({ status: approve ? 'approved' : 'denied', admin_id: adminId })
      .where('user_code', '=', code)
      .where('status', '=', 'pending')
      .where('expires_at', '>=', now)
      .executeTakeFirst();
    return Number(r.numUpdatedRows ?? 0) === 1;
  }

  /** The laptop polls with its device code (RFC 8628 §3.4–3.5); once approved, it gets its tokens, once. */
  async poll(deviceCode: string, ip: string, now = Date.now()): Promise<TokenResponse> {
    const db = this.deps.db;
    const row = await db.selectFrom('device_codes').selectAll().where('code_hash', '=', sha256Hex(deviceCode)).executeTakeFirst();
    if (!row) return { ok: false, error: 'invalid_grant', error_description: 'Unknown sign-in. Start again.' };
    if (row.expires_at < now && row.status !== 'used') return { ok: false, error: 'expired_token', error_description: 'The sign-in expired before it was approved. Start again.' };
    if (row.status === 'denied') return { ok: false, error: 'access_denied', error_description: 'The sign-in was refused in the console.' };
    if (row.status === 'used') return { ok: false, error: 'invalid_grant', error_description: 'This sign-in was already completed.' };
    if (row.status === 'pending') {
      const fast = row.last_poll_at !== null && now - row.last_poll_at < (POLL_INTERVAL_S - 1) * 1000;
      await db.updateTable('device_codes').set({ last_poll_at: now }).where('code_hash', '=', row.code_hash).execute();
      return fast ? { ok: false, error: 'slow_down', error_description: `Poll every ${POLL_INTERVAL_S} seconds.` } : { ok: false, error: 'authorization_pending', error_description: 'Waiting for the sign-in to be approved in the console.' };
    }
    // Approved: exactly one poll wins the tokens.
    const won = await db.updateTable('device_codes').set({ status: 'used' }).where('code_hash', '=', row.code_hash).where('status', '=', 'approved').executeTakeFirst();
    if (Number(won.numUpdatedRows ?? 0) !== 1) return { ok: false, error: 'invalid_grant', error_description: 'This sign-in was already completed.' };
    const person = await db.selectFrom('admins').select(['id', 'email', 'disabled']).where('id', '=', row.admin_id ?? '').executeTakeFirst();
    if (!person || (person.disabled ?? 0) !== 0) return { ok: false, error: 'access_denied', error_description: 'The person who approved this sign-in can no longer sign in.' };
    const k = await this.keyForPerson(person.id, row.client);
    if ('problem' in k) return { ok: false, error: 'access_denied', error_description: k.problem };
    const refresh = `ct_rt_${randomToken(32)}`;
    const id = ulid();
    await db
      .insertInto('device_sessions')
      .values({ id, admin_id: person.id, client: row.client, device_name: row.device_name, refresh_hash: sha256Hex(refresh), created_at: now, last_used_at: now, last_ip: ip.slice(0, 64), expires_at: now + this.settings.sessionDays * DAY, revoked_at: null, revoked_by: null, key_id: k.key.id })
      .execute();
    const a = this.mint({ sessionId: id, keyId: k.key.id, principal: person.email, client: row.client, deviceName: row.device_name }, now);
    return { ok: true, access_token: a.token, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, key_name: k.key.name, person: person.email };
  }

  /** A new access token for a signed-in laptop. Its session, its person and the rules are checked each time. */
  async refresh(refreshToken: string, ip: string, now = Date.now()): Promise<TokenResponse & { sessionId?: string }> {
    const db = this.deps.db;
    const s = await db.selectFrom('device_sessions').selectAll().where('refresh_hash', '=', sha256Hex(refreshToken)).executeTakeFirst();
    const again = (why: string): TokenResponse => ({ ok: false, error: 'invalid_grant', error_description: `${why} Sign in again.` });
    if (!s) return again('This laptop is not signed in.');
    if (s.revoked_at) return again('This sign-in was revoked.');
    if (s.expires_at < now) return again(`Sign-ins last ${this.settings.sessionDays} days.`);
    if (s.last_used_at + this.settings.idleDays * DAY < now) return again(`This sign-in was unused for over ${this.settings.idleDays} days.`);
    const person = await db.selectFrom('admins').select(['id', 'email', 'disabled']).where('id', '=', s.admin_id).executeTakeFirst();
    if (!person || (person.disabled ?? 0) !== 0) {
      await this.revoke(s.id, 'deactivated', now);
      return again('This account has been deactivated.');
    }
    const k = await this.keyForPerson(person.id, s.client);
    if ('problem' in k) return { ok: false, error: 'access_denied', error_description: k.problem };
    await db.updateTable('device_sessions').set({ last_used_at: now, last_ip: ip.slice(0, 64), key_id: k.key.id }).where('id', '=', s.id).execute();
    const a = this.mint({ sessionId: s.id, keyId: k.key.id, principal: person.email, client: s.client, deviceName: s.device_name }, now);
    return { ok: true, access_token: a.token, token_type: 'Bearer', expires_in: ACCESS_TTL_S, key_name: k.key.name, person: person.email, sessionId: s.id };
  }

  async revoke(sessionId: string, by: string, now = Date.now()): Promise<boolean> {
    const r = await this.deps.db.updateTable('device_sessions').set({ revoked_at: now, revoked_by: by.slice(0, 200) }).where('id', '=', sessionId).where('revoked_at', 'is', null).executeTakeFirst();
    this.revoked.add(sessionId);
    await this.reload();
    return Number(r.numUpdatedRows ?? 0) === 1;
  }

  /** Sign out from the laptop (ct-auth logout): the refresh token ends its own session. */
  async revokeByRefresh(refreshToken: string, now = Date.now()): Promise<string | undefined> {
    const s = await this.deps.db.selectFrom('device_sessions').select(['id']).where('refresh_hash', '=', sha256Hex(refreshToken)).where('revoked_at', 'is', null).executeTakeFirst();
    if (!s) return undefined;
    await this.revoke(s.id, 'signed out on the laptop', now);
    return s.id;
  }

  async revokePerson(adminId: string, by: string, now = Date.now()): Promise<number> {
    const r = await this.deps.db.updateTable('device_sessions').set({ revoked_at: now, revoked_by: by.slice(0, 200) }).where('admin_id', '=', adminId).where('revoked_at', 'is', null).executeTakeFirst();
    await this.reload();
    return Number(r.numUpdatedRows ?? 0);
  }

  /** Codes a day old, and sessions ended a month ago, are removed. */
  async sweep(now = Date.now()): Promise<void> {
    await this.deps.db.deleteFrom('device_codes').where('expires_at', '<', now - DAY).execute();
    await this.deps.db
      .deleteFrom('device_sessions')
      .where((eb) => eb.or([eb('revoked_at', '<', now - 30 * DAY), eb('expires_at', '<', now - 30 * DAY)]))
      .execute();
  }
}
