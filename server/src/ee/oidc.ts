import * as oidc from 'openid-client';
import type { Kysely } from 'kysely';
import type { Database, IdentityProvidersTable } from '../db/schema.js';
import type { SecretBox } from '../crypto/secrets.js';

/**
 * Single sign-on over OpenID Connect (Okta, Microsoft Entra ID, Google Workspace, Auth0, Keycloak, …).
 * The protocol work — discovery, PKCE, state and nonce, ID-token signature and claim checks — is
 * openid-client's. This file decides who may come in, and with which role.
 */

export type SsoRole = 'admin' | 'approver' | 'viewer';
const RANK: Record<SsoRole, number> = { admin: 3, approver: 2, viewer: 1 };
export type TokenAuth = 'client_secret_basic' | 'client_secret_post' | 'none';

export interface IdentityProvider {
  id: string;
  name: string;
  issuer: string;
  clientId: string;
  clientSecret: string | undefined;
  scopes: string;
  allowedDomains: string[];
  groupsClaim: string | undefined;
  roleMap: Partial<Record<SsoRole, string[]>>;
  defaultRole: SsoRole | 'none';
  createUsers: boolean;
  enabled: boolean;
  tokenAuth: TokenAuth;
  updatedAt: number;
}

/** A sign-in that got as far as the IdP and back: who they are, and the role they get (or why they don't). */
export type SsoResult =
  | { ok: true; subject: string; email: string; role: SsoRole; groups: string[] }
  | { ok: false; reason: string; email?: string | undefined };

const aad = (id: string) => `identity_providers.client_secret_enc.${id}`;

/** Plain http is for an IdP on this machine (development, tests); anywhere else it must be https. */
export function issuerProblem(issuer: string): string | undefined {
  let u: URL;
  try {
    u = new URL(issuer);
  } catch {
    return 'The issuer must be a URL, such as https://login.example.com or https://accounts.google.com.';
  }
  if (u.protocol === 'https:') return undefined;
  if (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return undefined;
  return 'The issuer must use https.';
}

export function roleFor(p: Pick<IdentityProvider, 'roleMap' | 'defaultRole'>, groups: string[]): SsoRole | undefined {
  let best: SsoRole | undefined;
  for (const role of Object.keys(RANK) as SsoRole[]) {
    const wanted = p.roleMap[role] ?? [];
    if (wanted.some((g) => groups.includes(g)) && (!best || RANK[role] > RANK[best])) best = role;
  }
  return best ?? (p.defaultRole === 'none' ? undefined : p.defaultRole);
}

/** The groups a claim lists: an array of strings, or one string (comma- or space-separated). */
export function groupsFrom(claims: Record<string, unknown>, claim: string | undefined): string[] {
  if (!claim) return [];
  // The claim's own name first (Auth0's are URLs: dots and all), then as a path into nested claims.
  const v = claim in claims ? claims[claim] : claim.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), claims);
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string') return v.split(/[\s,]+/).filter(Boolean);
  return [];
}

export class SsoService {
  private configs = new Map<string, { at: number; config: Promise<oidc.Configuration> }>();

  constructor(private readonly db: Kysely<Database>, private readonly secrets: SecretBox) {}

  private fromRow(r: IdentityProvidersTable): IdentityProvider {
    const roleMap = JSON.parse(r.role_map || '{}') as Partial<Record<SsoRole, string[]>>;
    return {
      id: r.id,
      name: r.name,
      issuer: r.issuer,
      clientId: r.client_id,
      clientSecret: r.client_secret_enc ? this.secrets.decrypt(r.client_secret_enc, aad(r.id)) : undefined,
      scopes: r.scopes,
      allowedDomains: JSON.parse(r.allowed_domains || '[]') as string[],
      groupsClaim: r.groups_claim || undefined,
      roleMap,
      defaultRole: (['admin', 'approver', 'viewer'].includes(r.default_role) ? r.default_role : 'none') as SsoRole | 'none',
      createUsers: r.create_users === 1,
      enabled: r.enabled === 1,
      tokenAuth: (['client_secret_basic', 'client_secret_post', 'none'].includes(r.token_auth) ? r.token_auth : 'client_secret_basic') as TokenAuth,
      updatedAt: r.updated_at,
    };
  }

  async list(): Promise<IdentityProvider[]> {
    return (await this.db.selectFrom('identity_providers').selectAll().orderBy('created_at').execute()).map((r) => this.fromRow(r));
  }

  async get(id: string): Promise<IdentityProvider | undefined> {
    const r = await this.db.selectFrom('identity_providers').selectAll().where('id', '=', id).executeTakeFirst();
    return r ? this.fromRow(r) : undefined;
  }

  encryptSecret(id: string, secret: string): string {
    return this.secrets.encrypt(secret, aad(id));
  }

  /** The IdP's configuration from its discovery document, cached until the provider's settings change. */
  config(p: IdentityProvider): Promise<oidc.Configuration> {
    const hit = this.configs.get(p.id);
    if (hit && hit.at === p.updatedAt) return hit.config;
    const auth = p.tokenAuth === 'none' || !p.clientSecret ? oidc.None() : p.tokenAuth === 'client_secret_post' ? oidc.ClientSecretPost(p.clientSecret) : oidc.ClientSecretBasic(p.clientSecret);
    const insecure = new URL(p.issuer).protocol === 'http:';
    // ID tokens are checked against the IdP's published keys too. The spec lets a client trust TLS to the token
    // endpoint instead; a gateway that decides who may change its security settings does both.
    const execute = [oidc.enableNonRepudiationChecks, ...(insecure ? [oidc.allowInsecureRequests] : [])];
    const config = oidc.discovery(new URL(p.issuer), p.clientId, undefined, auth, { timeout: 10, execute });
    this.configs.set(p.id, { at: p.updatedAt, config });
    config.catch(() => this.configs.delete(p.id));
    return config;
  }

  /** Where to send the browser, and what the callback must see again (kept in an encrypted cookie). */
  async start(p: IdentityProvider, redirectUri: string): Promise<{ url: string; verifier: string; state: string; nonce: string }> {
    const config = await this.config(p);
    const verifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: p.scopes || 'openid email profile',
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    return { url: url.href, verifier, state, nonce };
  }

  /** The IdP sent the browser back: exchange the code, check everything, and decide who this is. */
  async finish(p: IdentityProvider, callbackUrl: URL, checks: { verifier: string; state: string; nonce: string }): Promise<SsoResult> {
    const config = await this.config(p);
    const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, { pkceCodeVerifier: checks.verifier, expectedState: checks.state, expectedNonce: checks.nonce, idTokenExpected: true });
    const claims = (tokens.claims() ?? {}) as Record<string, unknown>;
    const subject = typeof claims.sub === 'string' ? claims.sub : '';
    const email = String(claims.email ?? claims.preferred_username ?? claims.upn ?? '').trim().toLowerCase();
    if (!subject) return { ok: false, reason: 'The identity provider sent no subject.' };
    if (!email.includes('@')) return { ok: false, reason: 'The identity provider sent no email address. Add the email scope or claim for this app.' };
    if (claims.email_verified === false) return { ok: false, reason: 'The identity provider says this email address is not verified.', email };
    const domain = email.split('@')[1] ?? '';
    if (p.allowedDomains.length && !p.allowedDomains.some((d) => d.toLowerCase() === domain)) return { ok: false, reason: `${domain} is not one of the email domains allowed to sign in.`, email };
    const groups = groupsFrom(claims, p.groupsClaim);
    const role = roleFor(p, groups);
    if (!role) return { ok: false, reason: 'You are in none of the groups allowed to sign in. Ask an admin to add you.', email };
    return { ok: true, subject, email, role, groups };
  }
}
