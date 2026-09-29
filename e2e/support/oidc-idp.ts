import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A small OpenID Connect provider for tests: discovery, JWKS, the authorization endpoint (signs in whoever
 * `idp.user` is, at once), and a token endpoint that checks the client's secret and the PKCE verifier and
 * returns an RS256-signed ID token. `idp.tamper` changes what it signs, so tests can prove Control Tower
 * refuses a wrong nonce, audience, issuer or signing key.
 */
export interface IdpUser {
  sub: string;
  email: string;
  email_verified?: boolean;
  groups?: string[];
  name?: string;
}
export interface TestIdp {
  url: string;
  clientId: string;
  clientSecret: string;
  /** Who signs in next; null makes the IdP refuse (access_denied). */
  user: IdpUser | null;
  /** Changes the ID token's claims before signing; `signWithOtherKey` signs it with a key the JWKS doesn't list. */
  tamper: { claims?: (c: Record<string, unknown>) => Record<string, unknown>; signWithOtherKey?: boolean } | null;
  /** Token requests seen (client authentication method used). */
  tokenRequests: Array<{ auth: 'basic' | 'post' | 'none' }>;
  close(): Promise<void>;
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export async function testIdp(opts: { clientId?: string; clientSecret?: string } = {}): Promise<TestIdp> {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'test-key-1';
  const codes = new Map<string, { user: IdpUser; nonce: string | undefined; challenge: string | undefined; redirect: string; clientId: string }>();
  const idp = {
    url: '',
    clientId: opts.clientId ?? 'control-tower',
    clientSecret: opts.clientSecret ?? 'idp-client-secret',
    user: null as IdpUser | null,
    tamper: null as TestIdp['tamper'],
    tokenRequests: [] as TestIdp['tokenRequests'],
  };

  const sign = (claims: Record<string, unknown>, key = privateKey) => {
    const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
    const body = b64u(JSON.stringify(claims));
    const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), key);
    return `${head}.${body}.${b64u(sig)}`;
  };

  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', idp.url);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (u.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: idp.url,
        authorization_endpoint: `${idp.url}/authorize`,
        token_endpoint: `${idp.url}/token`,
        jwks_uri: `${idp.url}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: ['openid', 'email', 'profile', 'groups'],
      });
    }
    if (u.pathname === '/jwks') return json(200, { keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] });
    if (u.pathname === '/authorize') {
      const redirect = u.searchParams.get('redirect_uri') ?? '';
      const back = new URL(redirect);
      back.searchParams.set('state', u.searchParams.get('state') ?? '');
      if (u.searchParams.get('client_id') !== idp.clientId || u.searchParams.get('response_type') !== 'code') return json(400, { error: 'invalid_request' });
      if (!idp.user) {
        back.searchParams.set('error', 'access_denied');
        back.searchParams.set('error_description', 'The user cancelled');
      } else {
        const code = crypto.randomBytes(16).toString('hex');
        codes.set(code, { user: idp.user, nonce: u.searchParams.get('nonce') ?? undefined, challenge: u.searchParams.get('code_challenge') ?? undefined, redirect, clientId: idp.clientId });
        back.searchParams.set('code', code);
      }
      res.writeHead(302, { location: back.href });
      return res.end();
    }
    if (u.pathname === '/token' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        let client: [string, string] | undefined;
        const basic = /^Basic (.+)$/i.exec(req.headers.authorization ?? '');
        if (basic) {
          const [id, secret] = Buffer.from(basic[1]!, 'base64').toString('utf8').split(':').map(decodeURIComponent) as [string, string];
          client = [id, secret];
          idp.tokenRequests.push({ auth: 'basic' });
        } else if (form.get('client_secret')) {
          client = [form.get('client_id') ?? '', form.get('client_secret') ?? ''];
          idp.tokenRequests.push({ auth: 'post' });
        } else idp.tokenRequests.push({ auth: 'none' });
        if (!client || client[0] !== idp.clientId || client[1] !== idp.clientSecret) return json(401, { error: 'invalid_client' });
        const code = form.get('code') ?? '';
        const grant = codes.get(code);
        codes.delete(code); // one use
        if (!grant || form.get('grant_type') !== 'authorization_code' || form.get('redirect_uri') !== grant.redirect) return json(400, { error: 'invalid_grant' });
        const verifier = form.get('code_verifier') ?? '';
        if (!grant.challenge || b64u(crypto.createHash('sha256').update(verifier).digest()) !== grant.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        const now = Math.floor(Date.now() / 1000);
        let claims: Record<string, unknown> = { iss: idp.url, aud: grant.clientId, sub: grant.user.sub, email: grant.user.email, email_verified: grant.user.email_verified ?? true, groups: grant.user.groups ?? [], name: grant.user.name ?? grant.user.email, iat: now, exp: now + 300, ...(grant.nonce ? { nonce: grant.nonce } : {}) };
        if (idp.tamper?.claims) claims = idp.tamper.claims(claims);
        const idToken = sign(claims, idp.tamper?.signWithOtherKey ? other.privateKey : privateKey);
        return json(200, { access_token: crypto.randomBytes(16).toString('hex'), token_type: 'Bearer', expires_in: 300, id_token: idToken });
      });
      return;
    }
    json(404, { error: 'not_found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  idp.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return Object.assign(idp, { close: () => new Promise<void>((r) => server.close(() => r())) });
}
