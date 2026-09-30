import fs from 'node:fs';
import { awsCredentials, awsJsonCall, azureToken, call, googleToken, type HttpAnswer } from './cloud-auth.js';

/**
 * The secret managers Control Tower reads credentials from (and writes rotated keys to): AWS Secrets Manager,
 * HashiCorp Vault (KV version 2), Google Secret Manager and Azure Key Vault. Each reads a secret's current value,
 * writes a new one, and checks its settings.
 */
export const MANAGER_KINDS = ['aws', 'vault', 'gcp', 'azure'] as const;
export type ManagerKind = (typeof MANAGER_KINDS)[number];

export interface ManagerConfig {
  // aws
  region?: string;
  access_key_id?: string;
  secret_access_key?: string;
  session_token?: string;
  endpoint?: string;
  sts_endpoint?: string;
  // vault
  address?: string;
  namespace?: string;
  mount?: string;
  auth?: 'token' | 'approle' | 'kubernetes';
  token?: string;
  role_id?: string;
  secret_id?: string;
  role?: string;
  jwt_path?: string;
  auth_mount?: string;
  // gcp
  project?: string;
  service_account_json?: string;
  api_url?: string;
  // azure
  vault_url?: string;
  tenant_id?: string;
  client_id?: string;
  client_secret?: string;
  authority?: string;
}

/** Config fields that are secrets: stored encrypted and never returned. */
export const MANAGER_SECRET_FIELDS = ['access_key_id', 'secret_access_key', 'session_token', 'token', 'secret_id', 'service_account_json', 'client_secret'] as const;

export interface Backend {
  /** A secret's current value: a string, or an object of fields (Vault, or JSON stored in the others). */
  read(path: string): Promise<string | Record<string, unknown>>;
  /** Store a new value; with `field`, only that field of a JSON secret changes. */
  write(path: string, value: string, field?: string): Promise<void>;
  /** Check the settings (credentials, reach), in a few words. */
  test(): Promise<string>;
}

/** What's wrong with a manager's settings, if anything. */
export function managerProblem(kind: ManagerKind, c: ManagerConfig): string | undefined {
  const url = (u: string | undefined, what: string) => (!u || !/^https?:\/\//.test(u) ? `${what} must be an http(s) URL` : undefined);
  switch (kind) {
    case 'aws':
      if (!c.region) return 'region is required';
      if (!!c.access_key_id !== !!c.secret_access_key) return 'give both access_key_id and secret_access_key, or neither (to use the role Control Tower runs with)';
      return c.endpoint ? url(c.endpoint, 'endpoint') : undefined;
    case 'vault':
      if (url(c.address, 'address')) return url(c.address, 'address');
      if ((c.auth ?? 'token') === 'token' && !c.token) return 'token is required (or choose AppRole or Kubernetes sign-in)';
      if (c.auth === 'approle' && (!c.role_id || !c.secret_id)) return 'AppRole needs role_id and secret_id';
      if (c.auth === 'kubernetes' && !c.role) return 'Kubernetes sign-in needs the Vault role';
      return undefined;
    case 'gcp':
      if (!c.project) return 'project is required';
      if (c.service_account_json) {
        try {
          const sa = JSON.parse(c.service_account_json) as { client_email?: string; private_key?: string };
          if (!sa.client_email || !sa.private_key) return 'service_account_json must be a service account key (client_email, private_key)';
        } catch {
          return 'service_account_json must be JSON';
        }
      }
      return c.api_url ? url(c.api_url, 'api_url') : undefined;
    case 'azure':
      if (url(c.vault_url, 'vault_url')) return 'vault_url must be the vault\'s URL, e.g. https://acme.vault.azure.net';
      if (c.client_secret && (!c.tenant_id || !c.client_id)) return 'a client secret needs tenant_id and client_id';
      return undefined;
  }
}

/** A short, safe description of where it is. */
export function managerHint(kind: ManagerKind, c: ManagerConfig): string {
  const host = (u?: string) => {
    try {
      return u ? new URL(u).host : '';
    } catch {
      return '';
    }
  };
  switch (kind) {
    case 'aws':
      return `${c.region}${c.access_key_id ? '' : ' · ambient role'}`;
    case 'vault':
      return `${host(c.address)} · ${c.mount ?? 'secret'} · ${c.auth ?? 'token'}`;
    case 'gcp':
      return `${c.project}${c.service_account_json ? '' : ' · ambient'}`;
    case 'azure':
      return `${host(c.vault_url)}${c.client_secret ? '' : ' · managed identity'}`;
  }
}

const fail = (what: string, r: HttpAnswer, detail?: string) => new Error(`${what}: HTTP ${r.status}${detail ? ` ${detail}` : ''}`);
const jsonOr = (s: string): string | Record<string, unknown> => {
  const t = s.trim();
  if (t.startsWith('{')) {
    try {
      return JSON.parse(t) as Record<string, unknown>;
    } catch {
      // a string that merely starts with {
    }
  }
  return s;
};
/** Merge `field = value` into a JSON secret's current value (or make it the whole value). */
const merged = (current: string | Record<string, unknown> | undefined, value: string, field?: string): string => {
  if (!field) return value;
  const base = current && typeof current === 'object' ? current : {};
  return JSON.stringify({ ...base, [field]: value });
};

export function backendFor(kind: ManagerKind, c: ManagerConfig, cacheKey: string): Backend {
  switch (kind) {
    case 'aws':
      return aws(c, cacheKey);
    case 'vault':
      return vault(c);
    case 'gcp':
      return gcp(c, cacheKey);
    case 'azure':
      return azure(c, cacheKey);
  }
}

// ---------------------------------------------------------------- AWS Secrets Manager

function aws(c: ManagerConfig, cacheKey: string): Backend {
  const region = c.region ?? 'us-east-1';
  const base = c.endpoint ?? `https://secretsmanager.${region}.amazonaws.com`;
  const sm = async (op: string, payload: unknown) => awsJsonCall(await awsCredentials(c, cacheKey), region, 'secretsmanager', base, `secretsmanager.${op}`, payload);
  const why = (r: HttpAnswer) => {
    try {
      const j = JSON.parse(r.text) as { __type?: string; message?: string; Message?: string };
      return `${(j.__type ?? '').split('#').pop()} ${j.message ?? j.Message ?? ''}`.trim();
    } catch {
      return r.text.slice(0, 200);
    }
  };
  const read = async (path: string) => {
    const r = await sm('GetSecretValue', { SecretId: path });
    if (r.status !== 200) throw fail(`AWS Secrets Manager ${path}`, r, why(r));
    const j = JSON.parse(r.text) as { SecretString?: string; SecretBinary?: string };
    if (j.SecretString === undefined) throw new Error(`AWS Secrets Manager ${path} is binary, not text`);
    return jsonOr(j.SecretString);
  };
  return {
    read,
    async write(path, value, field) {
      const current = field ? await read(path).catch(() => undefined) : undefined;
      const r = await sm('PutSecretValue', { SecretId: path, SecretString: merged(current, value, field) });
      if (r.status !== 200) throw fail(`AWS Secrets Manager ${path}`, r, why(r));
    },
    async test() {
      const r = await sm('ListSecrets', { MaxResults: 1 });
      if (r.status !== 200) throw fail('AWS Secrets Manager', r, why(r));
      return `signed in to Secrets Manager in ${region}`;
    },
  };
}

// ---------------------------------------------------------------- HashiCorp Vault (KV v2)

function vault(c: ManagerConfig): Backend {
  const addr = (c.address ?? '').replace(/\/+$/, '');
  const mount = (c.mount ?? 'secret').replace(/^\/+|\/+$/g, '');
  const ns = c.namespace ? { 'x-vault-namespace': c.namespace } : {};
  let login: { token: string; expiresAt: number } | undefined;
  const token = async (): Promise<string> => {
    const how = c.auth ?? 'token';
    if (how === 'token') return c.token!;
    if (login && login.expiresAt > Date.now() + 60_000) return login.token;
    const authMount = (c.auth_mount ?? how).replace(/^\/+|\/+$/g, '');
    const body = how === 'approle' ? { role_id: c.role_id, secret_id: c.secret_id } : { role: c.role, jwt: fs.readFileSync(c.jwt_path ?? '/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8').trim() };
    const r = await call(`${addr}/v1/auth/${authMount}/login`, { method: 'POST', headers: { 'content-type': 'application/json', ...ns }, body: JSON.stringify(body) });
    if (r.status !== 200) throw fail(`Vault ${how} sign-in`, r, vaultErrors(r.text));
    const a = (JSON.parse(r.text) as { auth: { client_token: string; lease_duration: number } }).auth;
    login = { token: a.client_token, expiresAt: Date.now() + a.lease_duration * 1000 };
    return login.token;
  };
  const h = async () => ({ 'x-vault-token': await token(), ...ns });
  const dataUrl = (path: string) => `${addr}/v1/${mount}/data/${path.replace(/^\/+/, '')}`;
  const read = async (path: string) => {
    const r = await call(dataUrl(path), { headers: await h() });
    if (r.status !== 200) throw fail(`Vault ${mount}/${path}`, r, vaultErrors(r.text));
    return (JSON.parse(r.text) as { data: { data: Record<string, unknown> } }).data.data;
  };
  return {
    read,
    async write(path, value, field) {
      const current = await read(path).catch(() => ({}) as Record<string, unknown>);
      const data = { ...(current as Record<string, unknown>), [field ?? 'value']: value };
      const r = await call(dataUrl(path), { method: 'POST', headers: { 'content-type': 'application/json', ...(await h()) }, body: JSON.stringify({ data }) });
      if (r.status !== 200 && r.status !== 204) throw fail(`Vault ${mount}/${path}`, r, vaultErrors(r.text));
    },
    async test() {
      const r = await call(`${addr}/v1/auth/token/lookup-self`, { headers: await h() });
      if (r.status !== 200) throw fail('Vault', r, vaultErrors(r.text));
      const d = (JSON.parse(r.text) as { data?: { display_name?: string; policies?: string[] } }).data;
      return `signed in to Vault as ${d?.display_name ?? 'a token'}${d?.policies?.length ? ` (policies: ${d.policies.join(', ')})` : ''}`;
    },
  };
}
const vaultErrors = (text: string) => {
  try {
    return ((JSON.parse(text) as { errors?: string[] }).errors ?? []).join('; ').slice(0, 200);
  } catch {
    return '';
  }
};

// ---------------------------------------------------------------- Google Secret Manager

function gcp(c: ManagerConfig, cacheKey: string): Backend {
  const api = (c.api_url ?? 'https://secretmanager.googleapis.com').replace(/\/+$/, '');
  const auth = async () => ({ authorization: `Bearer ${await googleToken(c, cacheKey)}` });
  /** `name` or `name/versions/7` (latest by default). */
  const parts = (path: string) => {
    const [name, , version] = path.replace(/^\/+/, '').split('/');
    return { name: name!, version: version ?? 'latest' };
  };
  const why = (r: HttpAnswer) => {
    try {
      return (JSON.parse(r.text) as { error?: { message?: string } }).error?.message?.slice(0, 200) ?? '';
    } catch {
      return '';
    }
  };
  const read = async (path: string) => {
    const { name, version } = parts(path);
    const r = await call(`${api}/v1/projects/${encodeURIComponent(c.project!)}/secrets/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}:access`, { headers: await auth() });
    if (r.status !== 200) throw fail(`Google Secret Manager ${name}`, r, why(r));
    return jsonOr(Buffer.from((JSON.parse(r.text) as { payload: { data: string } }).payload.data, 'base64').toString('utf8'));
  };
  return {
    read,
    async write(path, value, field) {
      const { name } = parts(path);
      const current = field ? await read(name).catch(() => undefined) : undefined;
      const data = Buffer.from(merged(current, value, field)).toString('base64');
      const r = await call(`${api}/v1/projects/${encodeURIComponent(c.project!)}/secrets/${encodeURIComponent(name)}:addVersion`, { method: 'POST', headers: { 'content-type': 'application/json', ...(await auth()) }, body: JSON.stringify({ payload: { data } }) });
      if (r.status !== 200) throw fail(`Google Secret Manager ${name}`, r, why(r));
    },
    async test() {
      const r = await call(`${api}/v1/projects/${encodeURIComponent(c.project!)}/secrets?pageSize=1`, { headers: await auth() });
      if (r.status !== 200) throw fail('Google Secret Manager', r, why(r));
      return `signed in to Secret Manager in project ${c.project}`;
    },
  };
}

// ---------------------------------------------------------------- Azure Key Vault

function azure(c: ManagerConfig, cacheKey: string): Backend {
  const base = (c.vault_url ?? '').replace(/\/+$/, '');
  const auth = async () => ({ authorization: `Bearer ${await azureToken(c, cacheKey)}` });
  const why = (r: HttpAnswer) => {
    try {
      return (JSON.parse(r.text) as { error?: { message?: string } }).error?.message?.slice(0, 200) ?? '';
    } catch {
      return '';
    }
  };
  /** `name` or `name/<version>`. */
  const read = async (path: string) => {
    const r = await call(`${base}/secrets/${path.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')}?api-version=7.4`, { headers: await auth() });
    if (r.status !== 200) throw fail(`Azure Key Vault ${path}`, r, why(r));
    return jsonOr((JSON.parse(r.text) as { value: string }).value);
  };
  return {
    read,
    async write(path, value, field) {
      const name = path.replace(/^\/+/, '').split('/')[0]!;
      const current = field ? await read(name).catch(() => undefined) : undefined;
      const r = await call(`${base}/secrets/${encodeURIComponent(name)}?api-version=7.4`, { method: 'PUT', headers: { 'content-type': 'application/json', ...(await auth()) }, body: JSON.stringify({ value: merged(current, value, field) }) });
      if (r.status !== 200) throw fail(`Azure Key Vault ${name}`, r, why(r));
    },
    async test() {
      const r = await call(`${base}/secrets?maxresults=1&api-version=7.4`, { headers: await auth() });
      if (r.status !== 200) throw fail('Azure Key Vault', r, why(r));
      return `signed in to ${new URL(base).host}`;
    },
  };
}
