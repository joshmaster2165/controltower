import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backendFor, managerProblem } from '../src/ee/secret-managers/backends.js';
import { SecretRefs, parseRef } from '../src/ee/secret-managers/index.js';
import { openSqlite } from '../src/db/index.js';
import { SecretBox } from '../src/crypto/secrets.js';

/** One stand-in for AWS Secrets Manager + STS + ECS credentials, Vault, Google (token + Secret Manager + metadata) and Azure (Entra + Key Vault + managed identity). */
const store = { aws: new Map<string, string>(), vault: new Map<string, Record<string, unknown>>(), gcp: new Map<string, string[]>(), azure: new Map<string, string>() };
const seen: Array<{ path: string; headers: http.IncomingHttpHeaders; body: string }> = [];
const sa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
let server: http.Server;
let base = '';
const VAULT_TOKEN = 'hvs.test-token';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url!, 'http://x');
      seen.push({ path: url.pathname, headers: req.headers, body });
      const json = (status: number, o: unknown) => (res.writeHead(status, { 'content-type': 'application/json' }), res.end(JSON.stringify(o)));
      const p = url.pathname;
      // ---- AWS
      if (p === '/aws/') {
        const auth = String(req.headers.authorization ?? '');
        if (!/^AWS4-HMAC-SHA256 Credential=\w+\/\d{8}\/eu-west-1\/secretsmanager\/aws4_request, SignedHeaders=[^,]*x-amz-target[^,]*, Signature=[0-9a-f]{64}$/.test(auth)) return json(403, { __type: 'UnrecognizedClientException', message: 'bad signature' });
        const b = JSON.parse(body || '{}') as { SecretId?: string; SecretString?: string };
        const target = req.headers['x-amz-target'];
        if (target === 'secretsmanager.GetSecretValue') return store.aws.has(b.SecretId!) ? json(200, { Name: b.SecretId, SecretString: store.aws.get(b.SecretId!) }) : json(400, { __type: 'com.amazonaws#ResourceNotFoundException', message: "Secrets Manager can't find the specified secret." });
        if (target === 'secretsmanager.PutSecretValue') return (store.aws.set(b.SecretId!, b.SecretString!), json(200, { Name: b.SecretId }));
        if (target === 'secretsmanager.ListSecrets') return json(200, { SecretList: [] });
        return json(400, {});
      }
      if (p === '/sts/') {
        const q = new URLSearchParams(body);
        if (q.get('Action') !== 'AssumeRoleWithWebIdentity' || q.get('WebIdentityToken') !== 'eks-projected-token') return json(403, {});
        return json(200, { AssumeRoleWithWebIdentityResponse: { AssumeRoleWithWebIdentityResult: { Credentials: { AccessKeyId: 'ASIAWEBIDENTITY', SecretAccessKey: 'wi-secret', SessionToken: 'wi-session', Expiration: Date.now() / 1000 + 3600 } } } });
      }
      if (p === '/ecs-creds') return req.headers.authorization === 'ecs-auth' ? json(200, { AccessKeyId: 'ASIAECSTASK', SecretAccessKey: 'ecs-secret', Token: 'ecs-session', Expiration: new Date(Date.now() + 3600_000).toISOString() }) : json(401, {});
      // ---- Vault
      if (p.startsWith('/v1/auth/approle/login')) {
        const b = JSON.parse(body) as { role_id: string; secret_id: string };
        return b.role_id === 'role-1' && b.secret_id === 'sid-1' ? json(200, { auth: { client_token: VAULT_TOKEN, lease_duration: 3600 } }) : json(400, { errors: ['invalid role or secret ID'] });
      }
      if (p.startsWith('/v1/auth/kubernetes/login')) {
        const b = JSON.parse(body) as { role: string; jwt: string };
        return b.role === 'controltower' && b.jwt === 'k8s-sa-jwt' ? json(200, { auth: { client_token: VAULT_TOKEN, lease_duration: 3600 } }) : json(403, { errors: ['permission denied'] });
      }
      if (req.headers['x-vault-token'] !== VAULT_TOKEN) return json(403, { errors: ['permission denied'] });
      if (p === '/v1/auth/token/lookup-self') return json(200, { data: { display_name: 'token-controltower', policies: ['ai-read'] } });
      const kv = /^\/v1\/(\w+)\/data\/(.+)$/.exec(p);
      if (kv) {
        const k = `${kv[1]}/${kv[2]}${req.headers['x-vault-namespace'] ? `@${req.headers['x-vault-namespace']}` : ''}`;
        if (req.method === 'POST') return (store.vault.set(k, (JSON.parse(body) as { data: Record<string, unknown> }).data), json(200, { data: { version: 2 } }));
        return store.vault.has(k) ? json(200, { data: { data: store.vault.get(k), metadata: { version: 1 } } }) : json(404, { errors: [] });
      }
      return json(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** Google and Azure answer on routes of their own server (their APIs have fixed paths). */
async function cloudServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const s = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url!, 'http://x');
      const p = url.pathname;
      const json = (status: number, o: unknown) => (res.writeHead(status, { 'content-type': 'application/json' }), res.end(JSON.stringify(o)));
      // Google OAuth: the JWT assertion must be signed by the service account's key.
      if (p === '/google/token') {
        const [h, c, sig] = new URLSearchParams(body).get('assertion')!.split('.');
        const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), sa.publicKey, Buffer.from(sig!, 'base64url'));
        return ok ? json(200, { access_token: 'ya29.google', expires_in: 3600 }) : json(400, { error: 'invalid_grant' });
      }
      if (p === '/computeMetadata/v1/instance/service-accounts/default/token') return req.headers['metadata-flavor'] === 'Google' ? json(200, { access_token: 'ya29.metadata', expires_in: 3600 }) : json(403, {});
      const g = /^\/v1\/projects\/acme-prod\/secrets\/([^/:]+)(?:\/versions\/([^/:]+):access|:addVersion)?$/.exec(p);
      if (g || p === '/v1/projects/acme-prod/secrets') {
        if (!['Bearer ya29.google', 'Bearer ya29.metadata'].includes(String(req.headers.authorization))) return json(401, { error: { message: 'unauthenticated' } });
        if (!g) return json(200, { secrets: [] });
        const versions = store.gcp.get(g[1]!) ?? [];
        if (p.endsWith(':addVersion')) return (store.gcp.set(g[1]!, [...versions, (JSON.parse(body) as { payload: { data: string } }).payload.data]), json(200, { name: `v${versions.length + 1}` }));
        const v = g[2] === 'latest' ? versions.at(-1) : versions[Number(g[2]) - 1];
        return v ? json(200, { payload: { data: v } }) : json(404, { error: { message: `Secret [${g[1]}] not found or has no versions.` } });
      }
      // Azure: Entra client credentials, managed identity, Key Vault.
      if (p === '/tenant-1/oauth2/v2.0/token') {
        const q = new URLSearchParams(body);
        return q.get('client_secret') === 'az-secret' && q.get('scope') === 'https://vault.azure.net/.default' ? json(200, { access_token: 'az-token', expires_in: 3600 }) : json(401, { error_description: 'AADSTS7000215: Invalid client secret provided.' });
      }
      if (p === '/msi') return req.headers['x-identity-header'] === 'id-header' ? json(200, { access_token: 'az-msi', expires_on: String(Math.floor(Date.now() / 1000) + 3600) }) : json(401, {});
      const k = /^\/secrets(?:\/([^/]+))?(?:\/([^/]+))?$/.exec(p);
      if (k) {
        if (!['Bearer az-token', 'Bearer az-msi'].includes(String(req.headers.authorization))) return json(401, { error: { message: 'Unauthorized' } });
        if (!k[1]) return json(200, { value: [] });
        if (req.method === 'PUT') return (store.azure.set(k[1], (JSON.parse(body) as { value: string }).value), json(200, {}));
        return store.azure.has(k[1]) ? json(200, { value: store.azure.get(k[1]) }) : json(404, { error: { message: `A secret with (name/id) ${k[1]} was not found in this key vault.` } });
      }
      return json(404, {});
    });
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => s.close(() => r())) };
}

const withEnv = async <T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> => {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};

describe('secret managers', () => {
  it('parses references', () => {
    expect(parseRef('secret://vault/ai/openai#api_key')).toEqual({ manager: 'vault', path: 'ai/openai', field: 'api_key' });
    expect(parseRef('secret://aws-prod/prod/anthropic')).toEqual({ manager: 'aws-prod', path: 'prod/anthropic', field: undefined });
    expect(parseRef('sk-proj-abc')).toBeUndefined();
    expect(parseRef('secret://Bad Name/x')).toBeUndefined();
  });

  it('AWS Secrets Manager: signed calls, read, write one field of a JSON secret, test', async () => {
    const b = backendFor('aws', { region: 'eu-west-1', access_key_id: 'AKIASTATIC', secret_access_key: 'static-secret', endpoint: `${base}/aws` }, 'aws-static');
    store.aws.set('prod/openai', JSON.stringify({ api_key: 'sk-one', org: 'acme' }));
    expect(await b.read('prod/openai')).toEqual({ api_key: 'sk-one', org: 'acme' });
    await b.write('prod/openai', 'sk-two', 'api_key');
    expect(JSON.parse(store.aws.get('prod/openai')!)).toEqual({ api_key: 'sk-two', org: 'acme' });
    expect(await b.test()).toContain('eu-west-1');
    await expect(b.read('missing')).rejects.toThrow(/ResourceNotFoundException/);
    expect(String(seen.findLast((s) => s.path === '/aws/')!.headers.authorization)).toContain('Credential=AKIASTATIC/');
  });

  it('AWS without keys uses the role it runs with: EKS web identity, then the ECS task role', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-sm-'));
    fs.writeFileSync(path.join(dir, 'token'), 'eks-projected-token');
    store.aws.set('ambient', 'from-a-role');
    await withEnv({ AWS_WEB_IDENTITY_TOKEN_FILE: path.join(dir, 'token'), AWS_ROLE_ARN: 'arn:aws:iam::1:role/ct' }, async () => {
      const b = backendFor('aws', { region: 'eu-west-1', endpoint: `${base}/aws`, sts_endpoint: `${base}/sts` }, 'aws-wi');
      expect(await b.read('ambient')).toBe('from-a-role');
      const h = seen.findLast((s) => s.path === '/aws/')!.headers;
      expect(String(h.authorization)).toContain('Credential=ASIAWEBIDENTITY/');
      expect(h['x-amz-security-token']).toBe('wi-session');
    });
    await withEnv({ AWS_CONTAINER_CREDENTIALS_FULL_URI: `${base}/ecs-creds`, AWS_CONTAINER_AUTHORIZATION_TOKEN: 'ecs-auth' }, async () => {
      const b = backendFor('aws', { region: 'eu-west-1', endpoint: `${base}/aws` }, 'aws-ecs');
      expect(await b.read('ambient')).toBe('from-a-role');
      expect(seen.findLast((s) => s.path === '/aws/')!.headers['x-amz-security-token']).toBe('ecs-session');
    });
  });

  it('Vault KV v2 with a token, AppRole or Kubernetes sign-in, and a namespace', async () => {
    store.vault.set('secret/ai/openai', { api_key: 'sk-vault', org: 'acme' });
    store.vault.set('kv/ai/anthropic@team-a', { value: 'sk-ant-ns' });
    const tok = backendFor('vault', { address: base, token: VAULT_TOKEN }, 'v1');
    expect(await tok.read('ai/openai')).toEqual({ api_key: 'sk-vault', org: 'acme' });
    expect(await tok.test()).toContain('token-controltower');
    const approle = backendFor('vault', { address: base, auth: 'approle', role_id: 'role-1', secret_id: 'sid-1', mount: 'kv', namespace: 'team-a' }, 'v2');
    expect(await approle.read('ai/anthropic')).toEqual({ value: 'sk-ant-ns' });
    await approle.write('ai/anthropic', 'sk-ant-new', 'value');
    expect(store.vault.get('kv/ai/anthropic@team-a')).toEqual({ value: 'sk-ant-new' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-sm-'));
    fs.writeFileSync(path.join(dir, 'jwt'), 'k8s-sa-jwt');
    const k8s = backendFor('vault', { address: base, auth: 'kubernetes', role: 'controltower', jwt_path: path.join(dir, 'jwt') }, 'v3');
    expect(await k8s.read('ai/openai')).toMatchObject({ api_key: 'sk-vault' });
    await expect(backendFor('vault', { address: base, auth: 'approle', role_id: 'role-1', secret_id: 'wrong' }, 'v4').read('ai/openai')).rejects.toThrow(/invalid role or secret ID/);
  });

  it('Google Secret Manager with a service account key or the metadata server; versions', async () => {
    const g = await cloudServer();
    try {
      const key = JSON.stringify({ client_email: 'ct@acme-prod.iam.gserviceaccount.com', private_key: sa.privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: `${g.url}/google/token` });
      const b = backendFor('gcp', { project: 'acme-prod', service_account_json: key, api_url: g.url }, 'g1');
      await b.write('openai', 'sk-g1');
      await b.write('openai', 'sk-g2');
      expect(await b.read('openai')).toBe('sk-g2');
      expect(await b.read('openai/versions/1')).toBe('sk-g1');
      expect(await b.test()).toContain('acme-prod');
      await withEnv({ GCE_METADATA_HOST: g.url.replace('http://', '') }, async () => {
        expect(await backendFor('gcp', { project: 'acme-prod', api_url: g.url }, 'g2').read('openai')).toBe('sk-g2');
      });
    } finally {
      await g.close();
    }
  });

  it('Azure Key Vault with a client secret or a managed identity', async () => {
    const a = await cloudServer();
    try {
      const b = backendFor('azure', { vault_url: a.url, tenant_id: 'tenant-1', client_id: 'c1', client_secret: 'az-secret', authority: a.url }, 'a1');
      await b.write('openai-key', 'sk-az');
      expect(await b.read('openai-key')).toBe('sk-az');
      expect(await b.test()).toContain('127.0.0.1');
      await expect(backendFor('azure', { vault_url: a.url, tenant_id: 'tenant-1', client_id: 'c1', client_secret: 'wrong', authority: a.url }, 'a2').read('openai-key')).rejects.toThrow(/Invalid client secret/);
      await withEnv({ IDENTITY_ENDPOINT: `${a.url}/msi`, IDENTITY_HEADER: 'id-header' }, async () => {
        expect(await backendFor('azure', { vault_url: a.url }, 'a3').read('openai-key')).toBe('sk-az');
      });
    } finally {
      await a.close();
    }
  });

  it('checks settings', () => {
    expect(managerProblem('aws', { region: 'x', access_key_id: 'only-half' })).toMatch(/both/);
    expect(managerProblem('vault', { address: 'vault:8200', token: 't' })).toMatch(/http/);
    expect(managerProblem('vault', { address: 'https://vault:8200', auth: 'approle' })).toMatch(/role_id/);
    expect(managerProblem('gcp', { project: 'p', service_account_json: '{"x":1}' })).toMatch(/service account key/);
    expect(managerProblem('azure', { vault_url: 'acme' })).toMatch(/vault_url/);
    expect(managerProblem('aws', { region: 'us-east-1' })).toBeUndefined();
  });

  it('references resolve into credentials, follow rotation in the manager, and keep the last value when a read fails', async () => {
    const db = openSqlite('', { memory: true });
    const secrets = new SecretBox({ key: crypto.randomBytes(32), id: 'test', source: 'env' });
    const refs = new SecretRefs();
    refs.configure({ db: db.write, secrets, log: () => ({ warn: () => undefined }) });
    const now = Date.now();
    await db.write.insertInto('secret_managers').values({ id: 'm1', name: 'vault', kind: 'vault', config_enc: secrets.encrypt(JSON.stringify({ address: base, token: VAULT_TOKEN }), 'secret_managers.config_enc.m1'), target_hint: '', refresh_s: 30, created_at: now, updated_at: now }).execute();
    await refs.reload();
    let reloads = 0;
    refs.onChange(async () => void reloads++);
    store.vault.set('secret/ai/openai', { api_key: 'sk-first', org: 'acme' });
    const creds = { api_key: 'secret://vault/ai/openai#api_key', organization: 'literal-org' };
    // Not read yet: left as the reference, read now; what uses it reloads when it arrives.
    expect(refs.apply(creds, 'provider OpenAI')).toEqual(creds);
    await refs.settle();
    expect(reloads).toBe(1);
    expect(refs.apply(creds, 'provider OpenAI')).toEqual({ api_key: 'sk-first', organization: 'literal-org' });
    // Rotated in Vault: the next read picks it up and reloads.
    store.vault.set('secret/ai/openai', { api_key: 'sk-second', org: 'acme' });
    await refs.refreshAll();
    expect(reloads).toBe(2);
    expect(refs.apply(creds, 'provider OpenAI').api_key).toBe('sk-second');
    const st = refs.states().find((s) => s.ref === creds.api_key)!;
    expect(st).toMatchObject({ manager: 'vault', used_by: ['provider OpenAI'], status: 'ok' });
    expect(st.changed_at).toBeTruthy();
    expect(JSON.stringify(refs.states())).not.toContain('sk-second');
    // Vault loses the secret: the error is reported, the last value stays in use.
    store.vault.delete('secret/ai/openai');
    await refs.refreshAll();
    expect(refs.apply(creds, 'provider OpenAI').api_key).toBe('sk-second');
    expect(refs.states().find((s) => s.ref === creds.api_key)).toMatchObject({ status: 'error', error: expect.stringContaining('HTTP 404') });
    // A secret with several fields needs one named.
    store.vault.set('secret/ai/multi', { a: '1', b: '2' });
    await expect(refs.resolve('secret://vault/ai/multi')).rejects.toThrow(/several fields/);
    await expect(refs.resolve('secret://nope/x')).rejects.toThrow(/no secret manager is named "nope"/);
  });
});
