import crypto from 'node:crypto';
import fs from 'node:fs';
import { SignatureV4 } from '@smithy/signature-v4';
import { Hash } from '@smithy/hash-node';
import type { HttpRequest } from '@smithy/types';
import { readBodyText, sendUpstream } from '../../providers/http.js';

/**
 * Credentials for the cloud secret managers, without the cloud SDKs: AWS (static keys, or the ambient chain —
 * environment, EKS web identity, ECS task role, EC2 instance role), Google (a service account, or the metadata
 * server), Azure (a client secret, or a managed identity). Tokens are cached until shortly before they expire.
 */

export interface HttpAnswer {
  status: number;
  text: string;
  headers: Record<string, string | string[] | undefined>;
}

/** One HTTP call, answered as text. Throws only when the request can't be made. */
export async function call(url: string, init: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; headers?: Record<string, string>; body?: string } = {}, timeoutMs = 15_000): Promise<HttpAnswer> {
  const r = await sendUpstream('secret-manager', { url, method: (init.method ?? 'GET') as 'GET', headers: init.headers ?? {}, ...(init.body !== undefined ? { body: init.body } : {}) }, AbortSignal.timeout(timeoutMs), { headersTimeoutMs: timeoutMs });
  if (!r.ok) throw new Error(`${new URL(url).host}: ${r.err.message}`);
  return { status: r.res.status, text: await readBodyText(r.res.body, 1024 * 1024), headers: r.res.headers as Record<string, string | string[] | undefined> };
}

const env = (k: string) => process.env[k] || undefined;
const soon = (expiresAt: number) => expiresAt < Date.now() + 5 * 60_000;

// ---------------------------------------------------------------- AWS

export interface AwsCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiresAt?: number;
}
const awsCache = new Map<string, AwsCreds>();

/**
 * Static keys when given; otherwise the ambient chain, in the AWS SDKs' order: environment variables, a web
 * identity token (EKS IRSA / pod identity), the ECS container credentials endpoint, then the EC2 instance role.
 */
export async function awsCredentials(c: { access_key_id?: string; secret_access_key?: string; session_token?: string; region?: string; sts_endpoint?: string }, cacheKey: string): Promise<AwsCreds> {
  if (c.access_key_id && c.secret_access_key) return { accessKeyId: c.access_key_id, secretAccessKey: c.secret_access_key, ...(c.session_token ? { sessionToken: c.session_token } : {}) };
  const cached = awsCache.get(cacheKey);
  if (cached && !(cached.expiresAt && soon(cached.expiresAt))) return cached;
  const got = await ambientAws(c);
  awsCache.set(cacheKey, got);
  return got;
}

async function ambientAws(c: { region?: string; sts_endpoint?: string }): Promise<AwsCreds> {
  const id = env('AWS_ACCESS_KEY_ID');
  const secret = env('AWS_SECRET_ACCESS_KEY');
  if (id && secret) return { accessKeyId: id, secretAccessKey: secret, ...(env('AWS_SESSION_TOKEN') ? { sessionToken: env('AWS_SESSION_TOKEN')! } : {}) };

  const tokenFile = env('AWS_WEB_IDENTITY_TOKEN_FILE');
  const role = env('AWS_ROLE_ARN');
  if (tokenFile && role) {
    const region = c.region ?? env('AWS_REGION') ?? env('AWS_DEFAULT_REGION') ?? 'us-east-1';
    const sts = (c.sts_endpoint ?? `https://sts.${region}.amazonaws.com`).replace(/\/+$/, '');
    const q = new URLSearchParams({ Action: 'AssumeRoleWithWebIdentity', Version: '2011-06-15', RoleArn: role, RoleSessionName: env('AWS_ROLE_SESSION_NAME') ?? 'controltower', WebIdentityToken: fs.readFileSync(tokenFile, 'utf8').trim() });
    const r = await call(`${sts}/`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: q.toString() });
    if (r.status !== 200) throw new Error(`AWS STS AssumeRoleWithWebIdentity: HTTP ${r.status} ${tag(r.text, 'Message')}`);
    const x = parseStsCredentials(r.text);
    if (!x) throw new Error('AWS STS answered without credentials');
    return x;
  }

  const full = env('AWS_CONTAINER_CREDENTIALS_FULL_URI') ?? (env('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI') ? `http://169.254.170.2${env('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI')}` : undefined);
  if (full) {
    const tokenPath = env('AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE');
    const auth = tokenPath ? fs.readFileSync(tokenPath, 'utf8').trim() : env('AWS_CONTAINER_AUTHORIZATION_TOKEN');
    const r = await call(full, { headers: auth ? { authorization: auth } : {} }, 5_000);
    if (r.status !== 200) throw new Error(`AWS container credentials: HTTP ${r.status}`);
    return fromJsonCreds(JSON.parse(r.text));
  }

  // EC2 instance metadata (IMDSv2).
  const imds = (env('AWS_EC2_METADATA_SERVICE_ENDPOINT') ?? 'http://169.254.169.254').replace(/\/+$/, '');
  const tok = await call(`${imds}/latest/api/token`, { method: 'PUT', headers: { 'x-aws-ec2-metadata-token-ttl-seconds': '21600' } }, 2_000).catch(() => undefined);
  if (!tok || tok.status !== 200) throw new Error('no AWS credentials: set access keys, or run with a role (environment, EKS web identity, ECS task role or EC2 instance role)');
  const h = { 'x-aws-ec2-metadata-token': tok.text.trim() };
  const name = (await call(`${imds}/latest/meta-data/iam/security-credentials/`, { headers: h }, 2_000)).text.trim().split('\n')[0];
  if (!name) throw new Error('the EC2 instance has no role');
  const r = await call(`${imds}/latest/meta-data/iam/security-credentials/${name}`, { headers: h }, 2_000);
  return fromJsonCreds(JSON.parse(r.text));
}

function fromJsonCreds(j: { AccessKeyId?: string; SecretAccessKey?: string; Token?: string; Expiration?: string }): AwsCreds {
  if (!j.AccessKeyId || !j.SecretAccessKey) throw new Error('AWS credentials endpoint answered without keys');
  return { accessKeyId: j.AccessKeyId, secretAccessKey: j.SecretAccessKey, ...(j.Token ? { sessionToken: j.Token } : {}), ...(j.Expiration ? { expiresAt: Date.parse(j.Expiration) } : {}) };
}

function parseStsCredentials(text: string): AwsCreds | undefined {
  try {
    const j = JSON.parse(text) as { AssumeRoleWithWebIdentityResponse?: { AssumeRoleWithWebIdentityResult?: { Credentials?: { AccessKeyId: string; SecretAccessKey: string; SessionToken: string; Expiration: number | string } } } };
    const cr = j.AssumeRoleWithWebIdentityResponse?.AssumeRoleWithWebIdentityResult?.Credentials;
    if (cr) return { accessKeyId: cr.AccessKeyId, secretAccessKey: cr.SecretAccessKey, sessionToken: cr.SessionToken, expiresAt: typeof cr.Expiration === 'number' ? cr.Expiration * 1000 : Date.parse(cr.Expiration) };
  } catch {
    // XML
  }
  const id = tag(text, 'AccessKeyId');
  const secret = tag(text, 'SecretAccessKey');
  if (!id || !secret) return undefined;
  const exp = tag(text, 'Expiration');
  return { accessKeyId: id, secretAccessKey: secret, sessionToken: tag(text, 'SessionToken'), ...(exp ? { expiresAt: Date.parse(exp) } : {}) };
}
const tag = (xml: string, name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1] ?? '';

/** A signed AWS JSON 1.1 call (Secrets Manager speaks it): `target` is e.g. secretsmanager.GetSecretValue. */
export async function awsJsonCall(creds: AwsCreds, region: string, service: string, base: string, target: string, payload: unknown): Promise<HttpAnswer> {
  const u = new URL(`${base.replace(/\/+$/, '')}/`);
  const body = JSON.stringify(payload);
  const signer = new SignatureV4({ credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey, ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}) }, region, service, sha256: Hash.bind(null, 'sha256') });
  const req: HttpRequest = {
    method: 'POST',
    protocol: u.protocol,
    hostname: u.hostname,
    ...(u.port ? { port: Number(u.port) } : {}),
    path: u.pathname,
    query: {},
    headers: { host: u.host, 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': target },
    body,
  };
  const signed = await signer.sign(req);
  return call(u.toString(), { method: 'POST', headers: signed.headers as Record<string, string>, body });
}

// ---------------------------------------------------------------- Google

const googleCache = new Map<string, { token: string; expiresAt: number }>();
const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** An access token for Google APIs: from a service account key, or the metadata server when none is given. */
export async function googleToken(c: { service_account_json?: string }, cacheKey: string): Promise<string> {
  const cached = googleCache.get(cacheKey);
  if (cached && !soon(cached.expiresAt)) return cached.token;
  let token: string;
  let expiresIn: number;
  if (c.service_account_json) {
    const sa = JSON.parse(c.service_account_json) as { client_email: string; private_key: string; token_uri?: string };
    const tokenUrl = sa.token_uri ?? 'https://oauth2.googleapis.com/token';
    const now = Math.floor(Date.now() / 1000);
    const head = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: tokenUrl, iat: now, exp: now + 3600 }))}`;
    const assertion = `${head}.${b64url(crypto.sign('RSA-SHA256', Buffer.from(head), sa.private_key))}`;
    const r = await call(tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString() });
    if (r.status !== 200) throw new Error(`Google token: HTTP ${r.status} ${r.text.slice(0, 200)}`);
    ({ access_token: token, expires_in: expiresIn = 3600 } = JSON.parse(r.text) as { access_token: string; expires_in?: number });
  } else {
    const host = env('GCE_METADATA_HOST') ?? 'metadata.google.internal';
    const r = await call(`http://${host}/computeMetadata/v1/instance/service-accounts/default/token`, { headers: { 'metadata-flavor': 'Google' } }, 3_000).catch((err: Error) => {
      throw new Error(`no Google credentials: give a service account key, or run on Google Cloud (${err.message})`);
    });
    if (r.status !== 200) throw new Error(`Google metadata server: HTTP ${r.status}`);
    ({ access_token: token, expires_in: expiresIn = 3600 } = JSON.parse(r.text) as { access_token: string; expires_in?: number });
  }
  googleCache.set(cacheKey, { token, expiresAt: Date.now() + expiresIn * 1000 });
  return token;
}

// ---------------------------------------------------------------- Azure

const azureCache = new Map<string, { token: string; expiresAt: number }>();

/**
 * An access token for Azure Key Vault: a client secret (tenant, client ID, secret), or a managed identity
 * (App Service / Container Apps / Arc through IDENTITY_ENDPOINT, otherwise the VM's instance metadata).
 */
export async function azureToken(c: { tenant_id?: string; client_id?: string; client_secret?: string; authority?: string }, cacheKey: string, resource = 'https://vault.azure.net'): Promise<string> {
  const cached = azureCache.get(cacheKey);
  if (cached && !soon(cached.expiresAt)) return cached.token;
  let token: string;
  let expiresAt: number;
  if (c.client_secret) {
    if (!c.tenant_id || !c.client_id) throw new Error('Azure: a client secret needs tenant_id and client_id');
    const authority = (c.authority ?? 'https://login.microsoftonline.com').replace(/\/+$/, '');
    const r = await call(`${authority}/${encodeURIComponent(c.tenant_id)}/oauth2/v2.0/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: c.client_id, client_secret: c.client_secret, scope: `${resource}/.default` }).toString() });
    if (r.status !== 200) throw new Error(`Azure token: HTTP ${r.status} ${(JSON.parse(r.text || '{}') as { error_description?: string }).error_description?.slice(0, 200) ?? ''}`);
    const j = JSON.parse(r.text) as { access_token: string; expires_in: number };
    token = j.access_token;
    expiresAt = Date.now() + j.expires_in * 1000;
  } else {
    const idEndpoint = env('IDENTITY_ENDPOINT');
    const idHeader = env('IDENTITY_HEADER');
    let r: HttpAnswer;
    const q = new URLSearchParams({ resource, ...(c.client_id ? { client_id: c.client_id } : {}) });
    if (idEndpoint && idHeader) r = await call(`${idEndpoint}?api-version=2019-08-01&${q}`, { headers: { 'x-identity-header': idHeader } }, 5_000);
    else
      r = await call(`http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&${q}`, { headers: { metadata: 'true' } }, 3_000).catch((err: Error) => {
        throw new Error(`no Azure credentials: give a client secret, or run with a managed identity (${err.message})`);
      });
    if (r.status !== 200) throw new Error(`Azure managed identity: HTTP ${r.status} ${r.text.slice(0, 200)}`);
    const j = JSON.parse(r.text) as { access_token: string; expires_on?: string | number; expires_in?: string | number };
    token = j.access_token;
    expiresAt = j.expires_on ? Number(j.expires_on) * 1000 : Date.now() + Number(j.expires_in ?? 3600) * 1000;
  }
  azureCache.set(cacheKey, { token, expiresAt });
  return token;
}

/** Forget cached credentials for a manager (its settings changed). */
export function forgetCredentials(cacheKey: string): void {
  awsCache.delete(cacheKey);
  googleCache.delete(cacheKey);
  azureCache.delete(cacheKey);
}
