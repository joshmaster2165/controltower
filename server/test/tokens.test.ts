import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import { openSqlite } from '../src/db/index.js';
import { TokenAuth, globMatch, looksLikeJwt, ruleMatches } from '../src/ee/tokens.js';
import type { KeyRecord } from '../src/registry.js';

const ISS = 'https://idp.example.com';
const AUD = 'controltower';
const key = (id: string): KeyRecord => ({ id, name: id, hash: '', prefix: '', last4: '', agentId: id, team: undefined, project: undefined, tags: [], allowedModels: ['*'], allowedMcp: ['*'], limits: {}, enabled: true, expiresAt: undefined, demo: false, createdAt: 0, lastUsedAt: undefined, delegatedOnly: false, regions: [], tokensOnly: false });
const keys = new Map([['k_invoice', key('k_invoice')], ['k_ci', key('k_ci')], ['k_ops', key('k_ops')]]);

let signer: CryptoKey;
let jwk: JWK;
let other: CryptoKey;
let rotated: CryptoKey;
let rotatedJwk: JWK;
let server: http.Server;
let base = '';
let published: JWK[] = [];
let discoveryIssuer = '';

beforeAll(async () => {
  const pair = await generateKeyPair('ES256', { extractable: true });
  signer = pair.privateKey;
  jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
  other = (await generateKeyPair('ES256')).privateKey;
  const r = await generateKeyPair('RS256', { extractable: true });
  rotated = r.privateKey;
  rotatedJwk = { ...(await exportJWK(r.publicKey)), kid: 'k2', alg: 'RS256' };
  published = [jwk];
  server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/.well-known/openid-configuration') return res.end(JSON.stringify({ issuer: discoveryIssuer || base, jwks_uri: `${base}/keys` }));
    if (req.url === '/keys') return res.end(JSON.stringify({ keys: published }));
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const sign = (claims: Record<string, unknown>, opts: { key?: CryptoKey; kid?: string; alg?: string; iss?: string; aud?: string | string[]; exp?: string | number; iat?: number } = {}) => {
  const j = new SignJWT(claims).setProtectedHeader({ alg: opts.alg ?? 'ES256', kid: opts.kid ?? 'k1' }).setIssuer(opts.iss ?? ISS).setAudience(opts.aud ?? AUD).setExpirationTime(opts.exp ?? '10m');
  if (opts.iat !== undefined) j.setIssuedAt(opts.iat);
  else j.setIssuedAt();
  return j.sign(opts.key ?? signer);
};

async function setup(over: Record<string, unknown> = {}) {
  const db = openSqlite('', { memory: true });
  let allowed = true;
  const now = Date.now();
  await db.write
    .insertInto('token_issuers')
    .values({
      id: 'i1', name: 'Acme IdP', issuer: ISS, jwks_uri: null, jwks_json: JSON.stringify({ keys: [jwk] }), audiences: JSON.stringify([AUD, 'api://controltower']),
      rules: JSON.stringify([
        { claims: { sub: 'system:serviceaccount:prod:invoice-bot' }, key_id: 'k_invoice' },
        { claims: { repository: 'acme/*', ref: 'refs/heads/main' }, key_id: 'k_ci' },
        { claims: { groups: 'ops-agents', 'kubernetes.io.namespace': 'ops' }, key_id: 'k_ops' },
      ]),
      principal_claim: 'sub', max_lifetime_s: 3600, enabled: 1, last_status: null, last_error: null, accepted_count: 0, refused_count: 0, last_refusal: null, last_refusal_at: null, last_used_at: null, created_at: now, updated_at: now,
      ...over,
    })
    .execute();
  const t = new TokenAuth({ db: db.write, keys: () => keys, allowed: () => allowed, log: () => ({ warn: () => undefined }) });
  await t.reload();
  return { db, t, allow: (v: boolean) => (allowed = v) };
}

describe('JWT authentication for agents', () => {
  it('a signed token for Control Tower is the key its rule names, with who presented it', async () => {
    const { t } = await setup();
    const tok = await sign({ sub: 'system:serviceaccount:prod:invoice-bot' });
    expect(looksLikeJwt(tok)).toBe(true);
    expect(t.keyFor(tok)).toBeUndefined(); // not checked yet
    expect(await t.verify(tok)).toMatchObject({ keyId: 'k_invoice', principal: 'Acme IdP · system:serviceaccount:prod:invoice-bot' });
    expect(t.keyFor(tok)?.id).toBe('k_invoice');
    // Globs, several claims at once, list claims and nested claims.
    expect(await t.verify(await sign({ sub: 'repo:acme/app:ref:refs/heads/main', repository: 'acme/app', ref: 'refs/heads/main' }))).toMatchObject({ keyId: 'k_ci' });
    expect(await t.verify(await sign({ sub: 'x', repository: 'acme/app', ref: 'refs/heads/dev' }))).toMatchObject({ refused: expect.stringContaining('no rule matches') });
    expect(await t.verify(await sign({ sub: 'y', groups: ['staff', 'ops-agents'], kubernetes: { io: { namespace: 'ops' } } }))).toMatchObject({ keyId: 'k_ops' });
    // Another audience it accepts.
    expect(await t.verify(await sign({ sub: 'system:serviceaccount:prod:invoice-bot' }, { aud: ['api://controltower', 'other'] }))).toMatchObject({ keyId: 'k_invoice' });
    expect(t.stats('i1')).toMatchObject({ accepted: 4, refused: 1 });
  });

  it('refuses tokens that are forged, tampered, for someone else, expired, too long-lived, or unsigned', async () => {
    const { t } = await setup();
    const sub = { sub: 'system:serviceaccount:prod:invoice-bot' };
    const good = await sign(sub);
    const [h, p, s] = good.split('.');
    const tampered = `${h}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p!, 'base64url').toString()), sub: 'system:serviceaccount:prod:invoice-bot', admin: true })).toString('base64url')}.${s}`;
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${p}.`;
    const hs = await new SignJWT(sub).setProtectedHeader({ alg: 'HS256', kid: 'k1' }).setIssuer(ISS).setAudience(AUD).setExpirationTime('10m').sign(new TextEncoder().encode('a-shared-secret-of-sufficient-length'));
    const cases: Array<[string, string, RegExp]> = [
      ['signed by another key', await sign(sub, { key: other }), /signature does not match/],
      ['tampered after signing', tampered, /signature does not match/],
      ['alg none', none, /algorithm|not a readable|signature/],
      ['a shared-secret algorithm', hs, /algorithm that is not accepted/],
      ['for another service', await sign(sub, { aud: 'https://graph.microsoft.com' }), /not meant for Control Tower/],
      ['from an issuer not trusted', await sign(sub, { iss: 'https://evil.example.com' }), /no trusted issuer/],
      ['expired', await sign(sub, { exp: Math.floor(Date.now() / 1000) - 300, iat: Math.floor(Date.now() / 1000) - 900 }), /expired/],
      ['valid for a week', await sign(sub, { exp: '7d' }), /longer than the 3600 s allowed/],
    ];
    for (const [what, tok, why] of cases) {
      const r = await t.verify(tok);
      expect(r, what).toMatchObject({ refused: expect.stringMatching(why) });
      expect(t.keyFor(tok), what).toBeUndefined();
    }
    // A token without an expiry.
    const noExp = await new SignJWT(sub).setProtectedHeader({ alg: 'ES256', kid: 'k1' }).setIssuer(ISS).setAudience(AUD).sign(signer);
    expect(await t.verify(noExp)).toMatchObject({ refused: expect.stringMatching(/exp/) });
  });

  it('only while licensed; a changed rule applies at once', async () => {
    const { db, t, allow } = await setup();
    const tok = await sign({ sub: 'system:serviceaccount:prod:invoice-bot' });
    expect(await t.verify(tok)).toMatchObject({ keyId: 'k_invoice' });
    allow(false);
    expect(t.keyFor(tok)).toBeUndefined();
    expect(t.enforced()).toBe(false);
    allow(true);
    expect(t.keyFor(tok)?.id).toBe('k_invoice');
    await db.write.updateTable('token_issuers').set({ rules: JSON.stringify([{ claims: { sub: 'someone-else' }, key_id: 'k_invoice' }]) }).execute();
    await t.reload();
    expect(t.keyFor(tok)).toBeUndefined();
    expect(await t.verify(tok)).toMatchObject({ refused: expect.stringContaining('no rule matches') });
  });

  it('finds the keys through the issuer\'s OpenID configuration, and fetches them again when they rotate', async () => {
    discoveryIssuer = '';
    const { t } = await setup({ issuer: base, jwks_json: null });
    const tok = await sign({ sub: 'system:serviceaccount:prod:invoice-bot' }, { iss: base });
    expect(await t.verify(tok)).toMatchObject({ keyId: 'k_invoice' });
    expect(await t.test('i1')).toMatchObject({ ok: true, message: expect.stringContaining('1 signing key') });
    // The issuer rotates to a new key; a token signed with it arrives. (Refetching waits 30 s between tries.)
    published = [jwk, rotatedJwk];
    const next = await sign({ sub: 'system:serviceaccount:prod:invoice-bot', n: 2 }, { iss: base, key: rotated, alg: 'RS256', kid: 'k2' });
    const st = (t as unknown as { state: Map<string, { fetchedAt: number }> }).state.get('i1')!;
    st.fetchedAt = Date.now() - 31_000;
    expect(await t.verify(next)).toMatchObject({ keyId: 'k_invoice' });
    published = [jwk];
  });

  it('refuses an OpenID configuration that is for another issuer', async () => {
    discoveryIssuer = 'https://someone-else.example.com';
    const { t } = await setup({ issuer: base, jwks_json: null });
    const r = await t.verify(await sign({ sub: 'system:serviceaccount:prod:invoice-bot' }, { iss: base }));
    expect(r).toMatchObject({ refused: expect.stringContaining('could not be fetched') });
    expect(t.stats('i1')).toMatchObject({ keys_status: 'error', keys_error: expect.stringContaining('is for issuer') });
    discoveryIssuer = '';
  });

  it('matches claims by glob, and never matches a rule with no claims', () => {
    expect(globMatch('repo:acme/*:ref:refs/heads/main', 'repo:acme/app:ref:refs/heads/main')).toBe(true);
    expect(globMatch('acme/*', 'acme/app/../../evil')).toBe(true); // * is any characters: write patterns accordingly
    expect(globMatch('a.b', 'aXb')).toBe(false);
    expect(ruleMatches({ claims: {}, key_id: 'k' }, { sub: 'x' })).toBe(false);
    expect(ruleMatches({ claims: { sub: 'x' }, key_id: 'k' }, { sub: { toString: () => 'x' } })).toBe(false);
  });
});
