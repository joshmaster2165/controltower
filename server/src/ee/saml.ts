import { SAML, ValidateInResponseTo, type CacheProvider, type Profile } from '@node-saml/node-saml';
import { groupsFrom, roleFor, type IdentityProvider, type SsoResult } from './oidc.js';

/**
 * SAML 2.0 single sign-on (SP-initiated, HTTP-Redirect out, HTTP-POST back). Signature checking — including
 * against signature wrapping — is node-saml's (xml-crypto 6, pinned). This file decides what is accepted:
 *
 *  - the assertion must be signed with the certificate the admin entered (a signed response alone isn't enough);
 *  - it must be addressed to this service provider (audience), within its time window, and — when set — from
 *    the IdP's entity ID (checked here: node-saml checks the issuer only on logout messages);
 *  - it must answer the request this browser's sign-in started: InResponseTo is checked against the one request
 *    id sealed for that sign-in, so a response captured elsewhere, or replayed, is refused.
 */

const EMAIL_ATTRIBUTES = [
  'email',
  'mail',
  'urn:oid:0.9.2342.19200300.100.1.3',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn',
];

/** A cache holding exactly one request id: the one this sign-in started. */
function oneRequest(expected?: { id: string; instant: string }): CacheProvider & { saved?: { id: string; instant: string } } {
  const c: CacheProvider & { saved?: { id: string; instant: string } } = {
    async saveAsync(key, value) {
      c.saved = { id: key, instant: value };
      return { value, createdAt: Date.now() };
    },
    async getAsync(key) {
      return expected && key === expected.id ? expected.instant : null;
    },
    async removeAsync(key) {
      return key;
    },
  };
  return c;
}

function client(p: IdentityProvider, acsUrl: string, spEntityId: string, cache: CacheProvider): SAML {
  if (!p.samlEntryPoint || !p.samlIdpCert) throw new Error('This SAML provider is missing its sign-in URL or certificate.');
  return new SAML({
    callbackUrl: acsUrl,
    entryPoint: p.samlEntryPoint,
    issuer: spEntityId,
    audience: spEntityId,
    idpCert: p.samlIdpCert,
    ...(p.samlIdpIssuer ? { idpIssuer: p.samlIdpIssuer } : {}),
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: 10 * 60_000,
    cacheProvider: cache,
    acceptedClockSkewMs: 60_000,
    maxAssertionAgeMs: 10 * 60_000,
    identifierFormat: null,
    disableRequestedAuthnContext: true,
    signatureAlgorithm: 'sha256',
  });
}

/** Where to send the browser, and the request id the response must answer. */
export async function samlStart(p: IdentityProvider, acsUrl: string, spEntityId: string, relayState: string): Promise<{ url: string; requestId: string; instant: string }> {
  const cache = oneRequest();
  const url = await client(p, acsUrl, spEntityId, cache).getAuthorizeUrlAsync(relayState, undefined, {});
  if (!cache.saved) throw new Error('no request id was issued');
  return { url, requestId: cache.saved.id, instant: cache.saved.instant };
}

/** Check the IdP's response and decide who this is. */
export async function samlFinish(p: IdentityProvider, acsUrl: string, spEntityId: string, body: Record<string, string>, request: { id: string; instant: string }): Promise<SsoResult> {
  const { profile } = await client(p, acsUrl, spEntityId, oneRequest(request)).validatePostResponseAsync(body);
  if (!profile) return { ok: false, reason: 'The identity provider sent no one to sign in.' };
  return resultFromProfile(p, profile);
}

export function resultFromProfile(p: Pick<IdentityProvider, 'emailAttribute' | 'groupsClaim' | 'roleMap' | 'defaultRole' | 'allowedDomains' | 'samlIdpIssuer'>, profile: Profile): SsoResult {
  // node-saml checks idpIssuer only on logout messages: the signed assertion's issuer is checked here.
  if (p.samlIdpIssuer && profile.issuer !== p.samlIdpIssuer) return { ok: false, reason: `The assertion came from ${profile.issuer || 'no issuer'}, not ${p.samlIdpIssuer}.` };
  const attrs = profile as Record<string, unknown>;
  const first = (v: unknown) => (Array.isArray(v) ? v[0] : v);
  const emailRaw = [p.emailAttribute, ...EMAIL_ATTRIBUTES].filter((k): k is string => !!k).map((k) => first(attrs[k])).find((v) => typeof v === 'string' && v.includes('@')) ?? (profile.nameID?.includes('@') ? profile.nameID : undefined);
  const email = String(emailRaw ?? '').trim().toLowerCase();
  if (!profile.nameID) return { ok: false, reason: 'The identity provider sent no NameID.' };
  if (!email.includes('@')) return { ok: false, reason: 'The identity provider sent no email address. Add an email attribute (or use the email address as the NameID).' };
  const domain = email.split('@')[1] ?? '';
  if (p.allowedDomains.length && !p.allowedDomains.some((d) => d.toLowerCase() === domain)) return { ok: false, reason: `${domain} is not one of the email domains allowed to sign in.`, email };
  const groups = groupsFrom(attrs, p.groupsClaim);
  const role = roleFor(p, groups);
  // The subject is the IdP's own NameID for the person (scoped to that IdP when it says so).
  return { ok: true, subject: profile.nameQualifier ? `${profile.nameQualifier}!${profile.nameID}` : profile.nameID, email, role, groups };
}

/** This service provider's metadata, for the IdP's app settings. */
export function samlMetadata(p: IdentityProvider, acsUrl: string, spEntityId: string): string {
  return client({ ...p, samlEntryPoint: p.samlEntryPoint ?? 'https://unset.invalid', samlIdpCert: p.samlIdpCert ?? 'unset' }, acsUrl, spEntityId, oneRequest()).generateServiceProviderMetadata(null);
}
