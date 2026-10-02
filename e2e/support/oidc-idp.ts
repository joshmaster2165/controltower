import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A small OpenID Connect provider for tests: discovery, JWKS, the authorization endpoint (signs in whoever
 * `idp.user` is, at once), and a token endpoint that checks the client's secret and the PKCE verifier and
 * returns an RS256-signed ID token. `idp.tamper` changes what it signs, so tests can prove Control Tower
 * refuses a wrong nonce, audience, issuer or signing key.
 *
 * Also the device flow (RFC 8628) for public clients, as Okta and Entra ID offer it to command-line tools:
 * `/device/authorize`, then opening `verification_uri_complete` approves as `idp.user`; ID tokens come with a
 * refresh token, which rotates on each use and can be revoked.
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
  /** Device-flow grants (by grant type) and refresh tokens revoked. */
  deviceGrants: string[];
  revoked: string[];
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
    deviceGrants: [] as string[],
    revoked: [] as string[],
  };
  const devices = new Map<string, { userCode: string; clientId: string; user: IdpUser | null | undefined; denied?: boolean }>();
  const refreshes = new Map<string, { user: IdpUser; clientId: string }>();
  /** An ID token (and access token, and a fresh refresh token) for a public client's device or refresh grant. */
  const issue = (user: IdpUser, clientId: string) => {
    const now = Math.floor(Date.now() / 1000);
    const refresh = crypto.randomBytes(16).toString('hex');
    refreshes.set(refresh, { user, clientId });
    const idToken = sign({ iss: idp.url, aud: clientId, sub: user.sub, email: user.email, email_verified: true, groups: user.groups ?? [], name: user.name ?? user.email, iat: now, exp: now + 300, jti: crypto.randomBytes(8).toString('hex') });
    return { access_token: crypto.randomBytes(16).toString('hex'), token_type: 'Bearer', expires_in: 300, id_token: idToken, refresh_token: refresh, scope: 'openid email profile offline_access' };
  };
  const formOf = (req: http.IncomingMessage) =>
    new Promise<URLSearchParams>((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
    });

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
        scopes_supported: ['openid', 'email', 'profile', 'groups', 'offline_access'],
        device_authorization_endpoint: `${idp.url}/device/authorize`,
        revocation_endpoint: `${idp.url}/revoke`,
        grant_types_supported: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'],
      });
    }
    if (u.pathname === '/device/authorize' && req.method === 'POST') {
      void formOf(req).then((f) => {
        if (f.get('client_id') !== idp.clientId) return json(400, { error: 'invalid_client' });
        const deviceCode = crypto.randomBytes(16).toString('hex');
        const userCode = crypto.randomBytes(3).toString('hex').toUpperCase();
        devices.set(deviceCode, { userCode, clientId: idp.clientId, user: undefined });
        json(200, { device_code: deviceCode, user_code: userCode, verification_uri: `${idp.url}/activate`, verification_uri_complete: `${idp.url}/activate?user_code=${userCode}`, expires_in: 600, interval: 1 });
      });
      return;
    }
    // The person "signs in" at the IdP: opening the link approves the device as idp.user (null refuses it).
    if (u.pathname === '/activate') {
      const d = [...devices.values()].find((x) => x.userCode === u.searchParams.get('user_code'));
      if (!d) return json(404, { error: 'unknown code' });
      if (idp.user) d.user = idp.user;
      else d.denied = true;
      return json(200, { ok: true });
    }
    if (u.pathname === '/revoke' && req.method === 'POST') {
      void formOf(req).then((f) => {
        const t = f.get('token') ?? '';
        if (refreshes.delete(t)) idp.revoked.push(t);
        json(200, {});
      });
      return;
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
        // Public clients (no secret): the device flow and refreshing its tokens.
        const gt = form.get('grant_type');
        if (gt === 'urn:ietf:params:oauth:grant-type:device_code' || gt === 'refresh_token') {
          idp.deviceGrants.push(gt);
          if (form.get('client_id') !== idp.clientId) return json(400, { error: 'invalid_client' });
          if (gt === 'refresh_token') {
            const r = refreshes.get(form.get('refresh_token') ?? '');
            if (!r) return json(400, { error: 'invalid_grant', error_description: 'The refresh token has expired or been revoked.' });
            refreshes.delete(form.get('refresh_token')!); // rotates
            return json(200, issue(r.user, r.clientId));
          }
          const d = devices.get(form.get('device_code') ?? '');
          if (!d) return json(400, { error: 'expired_token' });
          if (d.denied) return json(400, { error: 'access_denied', error_description: 'The user declined.' });
          if (!d.user) return json(400, { error: 'authorization_pending' });
          devices.delete(form.get('device_code')!);
          return json(200, issue(d.user, d.clientId));
        }
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
