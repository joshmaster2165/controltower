import { createHash } from 'node:crypto';
import { createLocalJWKSet, decodeJwt, jwtVerify, errors as joseErrors, type JSONWebKeySet, type JWTPayload } from 'jose';
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';
import type { KeyRecord } from '../registry.js';
import { readBodyText, sendUpstream } from '../providers/http.js';

/**
 * Agents authenticate with tokens from your identity provider instead of a key's secret (Enterprise).
 *
 * A token issuer is an identity provider Control Tower trusts: Okta, Microsoft Entra ID, Auth0, Keycloak, Google,
 * GitHub Actions, Kubernetes service accounts, SPIFFE, or any issuer of signed JWTs with published keys. Its rules
 * map a token's claims to the key whose permissions apply (models, tools, limits, budgets, gates), and the
 * first rule that matches wins. The call is recorded against that key, with who presented the token.
 *
 * A token must be signed by one of the issuer's keys (asymmetric algorithms only), name the issuer exactly,
 * be meant for Control Tower (its `aud`), and be current. Verified tokens are remembered until they expire,
 * so a call costs one signature check per token, not per request.
 */

/** Asymmetric algorithms only: never `none`, never a shared secret. */
export const ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'];
const CLOCK_SKEW_S = 60;
const JWKS_TTL_MS = 10 * 60_000;
/** An unknown `kid` refetches the keys, at most this often (keys rotated at the issuer). */
const JWKS_REFETCH_MS = 30_000;
const CACHE_MAX = 20_000;
/** A refused token is refused again without checking, for this long. */
const REFUSED_TTL_MS = 30_000;

export interface TokenRule {
  /** Claim name (dots reach into objects: `kubernetes.io.namespace`) → pattern (`*` matches anything). */
  claims: Record<string, string>;
  key_id: string;
}
export interface TokenIssuer {
  id: string;
  name: string;
  issuer: string;
  jwksUri: string | undefined;
  jwks: JSONWebKeySet | undefined;
  audiences: string[];
  rules: TokenRule[];
  principalClaim: string;
  maxLifetimeS: number | undefined;
  enabled: boolean;
}
interface IssuerState {
  keys: ReturnType<typeof createLocalJWKSet> | undefined;
  fetchedAt: number;
  fetching: Promise<void> | undefined;
  status: 'ok' | 'error' | undefined;
  error: string | undefined;
  accepted: number;
  refused: number;
  lastRefusal: string | undefined;
  lastRefusalAt: number | undefined;
  lastUsedAt: number | undefined;
  dirty: boolean;
}
export interface Verified {
  keyId: string;
  issuerId: string;
  principal: string;
  exp: number;
}

/** Does this look like a JWT (three base64url parts, a JSON header)? Keys' secrets never do. */
export function looksLikeJwt(s: string): boolean {
  return s.length > 30 && s.length <= 16_384 && s.startsWith('eyJ') && /^[\w-]+\.[\w-]+\.[\w-]*$/.test(s);
}

/** A claim, by name; dots reach into nested objects when there is no claim with the dotted name itself. */
export function claimAt(payload: Record<string, unknown>, name: string): unknown {
  if (name in payload) return payload[name];
  let v: unknown = payload;
  for (const part of name.split('.')) {
    if (!v || typeof v !== 'object') return undefined;
    v = (v as Record<string, unknown>)[part];
  }
  return v;
}

/** `*` matches any run of characters; everything else literally. */
export function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 's');
  return re.test(value);
}

/** Whether a token's claims satisfy a rule: every claim named matches (a list claim, when any element does). */
export function ruleMatches(rule: TokenRule, payload: Record<string, unknown>): boolean {
  const entries = Object.entries(rule.claims);
  if (!entries.length) return false;
  return entries.every(([name, pattern]) => {
    const v = claimAt(payload, name);
    const values = Array.isArray(v) ? v : [v];
    return values.some((x) => (typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean') && globMatch(pattern, String(x)));
  });
}

export class TokenAuth {
  private issuers: TokenIssuer[] = [];
  private byIss = new Map<string, TokenIssuer>();
  private state = new Map<string, IssuerState>();
  private verified = new Map<string, Verified>();
  private refused = new Map<string, { until: number; why: string }>();
  private saver: NodeJS.Timeout | undefined;

  constructor(
    private readonly deps: {
      db: Kysely<Database>;
      keys: () => Map<string, KeyRecord>;
      /** Whether the license includes it: tokens are refused while it doesn't. */
      allowed: () => boolean;
      log: () => { warn(o: object, m: string): void };
    },
  ) {}

  get configured(): boolean {
    return this.issuers.some((i) => i.enabled);
  }

  /** Whether tokens can be used now (licensed, and an issuer set up): only then do tokens-only keys refuse their secret. */
  enforced(): boolean {
    return this.configured && this.deps.allowed();
  }

  async reload(): Promise<void> {
    const rows = await this.deps.db.selectFrom('token_issuers').selectAll().execute();
    const next: TokenIssuer[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      issuer: r.issuer,
      jwksUri: r.jwks_uri ?? undefined,
      jwks: r.jwks_json ? (JSON.parse(r.jwks_json) as JSONWebKeySet) : undefined,
      audiences: JSON.parse(r.audiences) as string[],
      rules: JSON.parse(r.rules) as TokenRule[],
      principalClaim: r.principal_claim,
      maxLifetimeS: r.max_lifetime_s ?? undefined,
      enabled: r.enabled === 1,
    }));
    const old = this.state;
    this.state = new Map();
    for (const i of next) {
      const prev = old.get(i.id);
      const r = rows.find((x) => x.id === i.id)!;
      this.state.set(i.id, {
        // Keys given directly are used as they are; fetched ones are fetched again after a change.
        keys: i.jwks ? createLocalJWKSet(i.jwks) : undefined,
        fetchedAt: i.jwks ? Date.now() : 0,
        fetching: undefined,
        status: i.jwks ? 'ok' : (prev?.status ?? (r.last_status as 'ok' | 'error' | null) ?? undefined),
        error: i.jwks ? undefined : (prev?.error ?? r.last_error ?? undefined),
        accepted: prev?.accepted ?? r.accepted_count,
        refused: prev?.refused ?? r.refused_count,
        lastRefusal: prev?.lastRefusal ?? r.last_refusal ?? undefined,
        lastRefusalAt: prev?.lastRefusalAt ?? r.last_refusal_at ?? undefined,
        lastUsedAt: prev?.lastUsedAt ?? r.last_used_at ?? undefined,
        dirty: false,
      });
    }
    this.issuers = next;
    this.byIss = new Map(next.filter((i) => i.enabled).map((i) => [i.issuer, i]));
    // A rule or issuer changed: every token is checked again against the new settings.
    this.verified.clear();
    this.refused.clear();
  }

  start(): void {
    this.saver = setInterval(() => void this.save(), 15_000);
    this.saver.unref?.();
  }

  async stop(): Promise<void> {
    if (this.saver) clearInterval(this.saver);
    await this.save();
  }

  /** The key a verified token stands for, from memory (synchronous: the gateway's hot path). */
  lookup(token: string): Verified | undefined {
    if (!this.deps.allowed()) return undefined;
    const v = this.verified.get(digest(token));
    if (!v) return undefined;
    if (v.exp * 1000 + CLOCK_SKEW_S * 1000 < Date.now()) {
      this.verified.delete(digest(token));
      return undefined;
    }
    return v;
  }

  /** The key a token stands for, when it's valid now. */
  keyFor(token: string): KeyRecord | undefined {
    const v = this.lookup(token);
    return v ? this.deps.keys().get(v.keyId) : undefined;
  }

  /**
   * Check a token (signature, issuer, audience, time, rules) and remember the result. Resolves to what it
   * stands for, or to the reason it was refused.
   */
  async verify(token: string): Promise<Verified | { refused: string }> {
    if (!this.deps.allowed()) return { refused: 'JWT authentication needs a Control Tower Enterprise license' };
    const d = digest(token);
    const known = this.lookup(token);
    if (known) return known;
    const before = this.refused.get(d);
    if (before && before.until > Date.now()) return { refused: before.why };
    let iss: string | undefined;
    try {
      iss = decodeJwt(token).iss;
    } catch {
      return this.refuse(d, undefined, 'not a readable JWT');
    }
    const issuer = iss ? this.byIss.get(iss) : undefined;
    if (!issuer) return this.refuse(d, undefined, `no trusted issuer is "${iss ?? '(none)'}"`);
    const st = this.state.get(issuer.id)!;
    let payload: JWTPayload;
    try {
      payload = await this.check(issuer, st, token);
    } catch (err) {
      return this.refuse(d, issuer, reason(err));
    }
    if (issuer.maxLifetimeS && typeof payload.iat === 'number' && typeof payload.exp === 'number' && payload.exp - payload.iat > issuer.maxLifetimeS) {
      return this.refuse(d, issuer, `the token is valid for ${payload.exp - payload.iat} s, longer than the ${issuer.maxLifetimeS} s allowed`);
    }
    const rule = issuer.rules.find((r) => ruleMatches(r, payload as Record<string, unknown>));
    if (!rule) return this.refuse(d, issuer, `no rule matches the token (sub "${String(payload.sub ?? '')}")`);
    if (!this.deps.keys().has(rule.key_id)) return this.refuse(d, issuer, 'the rule that matches names a key that no longer exists');
    const who = claimAt(payload as Record<string, unknown>, issuer.principalClaim) ?? payload.sub;
    const v: Verified = { keyId: rule.key_id, issuerId: issuer.id, principal: `${issuer.name} · ${String(who ?? '?').slice(0, 200)}`, exp: payload.exp! };
    if (this.verified.size >= CACHE_MAX) this.verified.delete(this.verified.keys().next().value!);
    this.verified.set(d, v);
    st.accepted++;
    st.lastUsedAt = Date.now();
    st.dirty = true;
    return v;
  }

  /** Signature, issuer, audience and time; fetching the issuer's keys when needed (and again for a new `kid`). */
  private async check(issuer: TokenIssuer, st: IssuerState, token: string): Promise<JWTPayload> {
    if (!st.keys || Date.now() - st.fetchedAt > JWKS_TTL_MS) await this.fetchKeys(issuer, st).catch(() => undefined);
    if (!st.keys) throw new Error(`the issuer's signing keys could not be fetched${st.error ? `: ${st.error}` : ''}`);
    const opts = { issuer: issuer.issuer, audience: issuer.audiences, algorithms: ALGORITHMS, clockTolerance: CLOCK_SKEW_S, requiredClaims: ['exp'] };
    try {
      return (await jwtVerify(token, st.keys, opts)).payload;
    } catch (err) {
      // Keys rotated at the issuer: fetch them again (not too often), and try once more.
      if (err instanceof joseErrors.JWKSNoMatchingKey && !issuer.jwks && Date.now() - st.fetchedAt > JWKS_REFETCH_MS) {
        await this.fetchKeys(issuer, st).catch(() => undefined);
        return (await jwtVerify(token, st.keys!, opts)).payload;
      }
      throw err;
    }
  }

  /** Fetch an issuer's signing keys: from its JWKS URL, or found through its OpenID configuration. */
  async fetchKeys(issuer: TokenIssuer, st = this.state.get(issuer.id)!): Promise<void> {
    if (issuer.jwks) return;
    st.fetching ??= (async () => {
      try {
        const uri = issuer.jwksUri ?? (await discoverJwksUri(issuer.issuer));
        const jwks = (await getJson(uri)) as JSONWebKeySet;
        if (!Array.isArray(jwks?.keys) || !jwks.keys.length) throw new Error(`${uri} has no keys`);
        st.keys = createLocalJWKSet(jwks);
        st.fetchedAt = Date.now();
        st.status = 'ok';
        st.error = undefined;
      } catch (err) {
        st.fetchedAt = Date.now();
        st.status = 'error';
        st.error = (err as Error).message.slice(0, 300);
        this.deps.log().warn({ issuer: issuer.name, err: st.error }, 'token issuer keys could not be fetched');
        throw err;
      } finally {
        st.dirty = true;
        st.fetching = undefined;
      }
    })();
    return st.fetching;
  }

  /** Check an issuer's settings: its keys can be fetched, and how many there are. */
  async test(id: string): Promise<{ ok: boolean; message: string }> {
    const issuer = this.issuers.find((i) => i.id === id);
    if (!issuer) return { ok: false, message: 'not found' };
    if (issuer.jwks) return { ok: true, message: `${issuer.jwks.keys.length} signing key(s), given directly` };
    try {
      const uri = issuer.jwksUri ?? (await discoverJwksUri(issuer.issuer));
      const jwks = (await getJson(uri)) as JSONWebKeySet;
      const st = this.state.get(issuer.id)!;
      st.keys = createLocalJWKSet(jwks);
      st.fetchedAt = Date.now();
      st.status = 'ok';
      st.error = undefined;
      st.dirty = true;
      return { ok: true, message: `${jwks.keys?.length ?? 0} signing key(s) from ${uri}` };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  /** The issuers with a rule naming this key (for the Keys page). */
  issuersFor(keyId: string): string[] {
    return this.issuers.filter((i) => i.enabled && i.rules.some((r) => r.key_id === keyId)).map((i) => i.name);
  }

  /** Delivery state, for the console. */
  stats(id: string) {
    const s = this.state.get(id);
    return s
      ? { keys_status: s.status ?? null, keys_error: s.error ?? null, accepted: s.accepted, refused: s.refused, last_refusal: s.lastRefusal ?? null, last_refusal_at: s.lastRefusalAt ?? null, last_used_at: s.lastUsedAt ?? null }
      : undefined;
  }

  private refuse(d: string, issuer: TokenIssuer | undefined, why: string): { refused: string } {
    if (this.refused.size >= CACHE_MAX) this.refused.clear();
    this.refused.set(d, { until: Date.now() + REFUSED_TTL_MS, why });
    if (issuer) {
      const st = this.state.get(issuer.id)!;
      st.refused++;
      st.lastRefusal = why.slice(0, 300);
      st.lastRefusalAt = Date.now();
      st.dirty = true;
    }
    return { refused: why };
  }

  private async save(): Promise<void> {
    for (const [id, s] of this.state) {
      if (!s.dirty) continue;
      s.dirty = false;
      await this.deps.db
        .updateTable('token_issuers')
        .set({ last_status: s.status ?? null, last_error: s.error ?? null, accepted_count: s.accepted, refused_count: s.refused, last_refusal: s.lastRefusal ?? null, last_refusal_at: s.lastRefusalAt ?? null, last_used_at: s.lastUsedAt ?? null })
        .where('id', '=', id)
        .execute()
        .catch(() => undefined);
    }
  }
}

const digest = (t: string) => createHash('sha256').update(t).digest('base64url');

/** A refusal in a few words (never the token). */
function reason(err: unknown): string {
  if (err instanceof joseErrors.JWTExpired) return 'the token has expired';
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    if (err.claim === 'aud') return 'the token is not meant for Control Tower (its aud is not one of the audiences accepted)';
    if (err.claim === 'nbf') return 'the token is not valid yet';
    if (err.claim === 'exp') return 'the token has no expiry';
    return `the token's ${err.claim} claim is not accepted`;
  }
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) return 'the signature does not match';
  if (err instanceof joseErrors.JOSEAlgNotAllowed) return 'the token is signed with an algorithm that is not accepted (asymmetric keys only)';
  if (err instanceof joseErrors.JWKSNoMatchingKey) return 'the token is signed by a key the issuer does not publish';
  return (err as Error)?.message?.slice(0, 200) || 'refused';
}

async function getJson(url: string): Promise<unknown> {
  if (!/^https?:\/\//.test(url)) throw new Error(`${url} is not an http(s) URL`);
  const r = await sendUpstream('token-issuer', { url, method: 'GET', headers: { accept: 'application/json' } }, AbortSignal.timeout(10_000), { headersTimeoutMs: 10_000 });
  if (!r.ok) throw new Error(`${url}: ${r.err.message}`);
  const text = await readBodyText(r.res.body, 512 * 1024);
  if (r.res.status !== 200) throw new Error(`${url}: HTTP ${r.res.status}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${url} did not answer with JSON`);
  }
}

async function discoverJwksUri(issuer: string): Promise<string> {
  const conf = (await getJson(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`)) as { jwks_uri?: string; issuer?: string };
  // The configuration must be the issuer's own (OpenID Connect Discovery, section 4.3).
  if (conf.issuer !== issuer) throw new Error(`the OpenID configuration at ${issuer} is for issuer "${conf.issuer ?? '(none)'}"`);
  if (!conf.jwks_uri) throw new Error(`${issuer}/.well-known/openid-configuration has no jwks_uri`);
  return conf.jwks_uri;
}
