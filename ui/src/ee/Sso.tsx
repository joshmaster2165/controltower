import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { EnterpriseNotice } from './LicensePage';

type Role = 'admin' | 'approver' | 'viewer';
type Kind = 'oidc' | 'saml';
interface Provider {
  id: string;
  name: string;
  kind: Kind;
  issuer: string;
  client_id: string;
  client_secret_set: boolean;
  scopes: string;
  allowed_domains: string[];
  groups_claim: string | null;
  role_map: Partial<Record<Role, string[]>>;
  default_role: Role | 'none';
  create_users: boolean;
  enabled: boolean;
  token_auth: 'client_secret_basic' | 'client_secret_post' | 'none';
  redirect_uri: string;
  saml_entry_point: string | null;
  saml_idp_cert_set: boolean;
  saml_idp_issuer: string | null;
  email_attribute: string | null;
  acs_url: string;
  sp_entity_id: string;
  metadata_url: string;
  scim_token_set: boolean;
  scim_url: string;
  last_status: string | null;
  last_error: string | null;
}
interface Settings {
  providers: Provider[];
  sso_only: boolean;
  admin_key_set: boolean;
  redirect_uri_pattern: string;
}

const list = (s: string) =>
  s
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

interface Draft {
  kind: Kind;
  name: string;
  issuer: string;
  client_id: string;
  client_secret: string;
  saml_entry_point: string;
  saml_idp_cert: string;
  saml_idp_issuer: string;
  email_attribute: string;
  allowed_domains: string;
  groups_claim: string;
  admin: string;
  approver: string;
  viewer: string;
  default_role: Role | 'none';
  create_users: boolean;
  token_auth: Provider['token_auth'];
}
const EMPTY: Draft = { kind: 'oidc', name: '', issuer: '', client_id: '', client_secret: '', saml_entry_point: '', saml_idp_cert: '', saml_idp_issuer: '', email_attribute: '', allowed_domains: '', groups_claim: 'groups', admin: '', approver: '', viewer: '', default_role: 'viewer', create_users: true, token_auth: 'client_secret_basic' };
const draftOf = (p: Provider): Draft => ({
  kind: p.kind,
  name: p.name,
  issuer: p.kind === 'oidc' ? p.issuer : '',
  client_id: p.client_id,
  client_secret: '',
  saml_entry_point: p.saml_entry_point ?? '',
  saml_idp_cert: '',
  saml_idp_issuer: p.saml_idp_issuer ?? '',
  email_attribute: p.email_attribute ?? '',
  allowed_domains: p.allowed_domains.join(', '),
  groups_claim: p.groups_claim ?? '',
  admin: (p.role_map.admin ?? []).join(', '),
  approver: (p.role_map.approver ?? []).join(', '),
  viewer: (p.role_map.viewer ?? []).join(', '),
  default_role: p.default_role,
  create_users: p.create_users,
  token_auth: p.token_auth,
});

function Copyable({ label, value }: { label: string; value: string }) {
  return (
    <div className="hint">
      {label}: <code className="mono" style={{ userSelect: 'all' }}>{value}</code>
    </div>
  );
}

function ProviderForm({ initial, existing, onSave, onCancel }: { initial: Draft; existing?: Provider; onSave: (d: Draft) => Promise<void>; onCancel: () => void }) {
  const [d, setD] = useState(initial);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await onSave(d);
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : String(e2));
    } finally {
      setBusy(false);
    }
  };
  const id = (k: string) => `sso-${k}`;
  const field = (label: string, k: keyof Draft, placeholder = '', type = 'text', hint?: string) => (
    <div className="field" style={{ margin: 0 }}>
      <label htmlFor={id(k)}>{label}</label>
      <input id={id(k)} className="input" type={type} value={String(d[k])} placeholder={placeholder} onChange={(e) => set(k, e.target.value as never)} />
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
  const saml = d.kind === 'saml';
  return (
    <form className="card" style={{ padding: 14, display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }} onSubmit={(e) => void submit(e)}>
      {!existing && (
        <div className="seg" style={{ gridColumn: '1 / -1' }}>
          {(['oidc', 'saml'] as const).map((k) => (
            <button key={k} type="button" className={d.kind === k ? 'on' : ''} onClick={() => set('kind', k)}>
              {k === 'oidc' ? 'OpenID Connect' : 'SAML 2.0'}
            </button>
          ))}
        </div>
      )}
      <div className="hint" style={{ gridColumn: '1 / -1' }}>
        {saml ? (
          existing ? (
            <>
              In your identity provider, create a SAML app with these, or give it the metadata URL:
              <Copyable label="ACS (reply) URL" value={existing.acs_url} />
              <Copyable label="Entity ID (audience)" value={existing.sp_entity_id} />
              <Copyable label="Metadata" value={existing.metadata_url} />
            </>
          ) : (
            'Save first: the ACS URL, entity ID and metadata URL to give your identity provider are shown when you edit it.'
          )
        ) : (
          <>
            In your identity provider, create an OpenID Connect web app with this sign-in redirect URL: <code className="mono">{existing?.redirect_uri ?? 'shown after saving'}</code>
          </>
        )}
      </div>
      {field('Name on the sign-in page', 'name', saml ? 'Okta (SAML)' : 'Okta')}
      {saml ? (
        <>
          {field('SAML sign-in URL', 'saml_entry_point', 'https://acme.okta.com/app/…/sso/saml', 'url', 'The IdP’s single sign-on URL (HTTP-Redirect).')}
          {field('IdP entity ID (issuer)', 'saml_idp_issuer', 'http://www.okta.com/exk…', 'text', 'Assertions must come from it.')}
          <div className="field" style={{ margin: 0, gridColumn: '1 / -1' }}>
            <label htmlFor={id('saml_idp_cert')}>Signing certificate</label>
            <textarea id={id('saml_idp_cert')} className="input mono" rows={4} value={d.saml_idp_cert} placeholder={existing?.saml_idp_cert_set ? 'unchanged' : '-----BEGIN CERTIFICATE-----'} onChange={(e) => set('saml_idp_cert', e.target.value)} />
          </div>
          {field('Email attribute', 'email_attribute', 'email', 'text', 'Empty: the usual email attributes, then the NameID.')}
        </>
      ) : (
        <>
          {field('Issuer URL', 'issuer', 'https://acme.okta.com', 'url', 'Where /.well-known/openid-configuration is.')}
          {field('Client ID', 'client_id')}
          {field('Client secret', 'client_secret', existing ? 'unchanged' : '', 'password')}
        </>
      )}
      {field('Email domains allowed', 'allowed_domains', 'acme.com, acme.co.uk', 'text', 'Empty: any email the provider vouches for.')}
      {field(saml ? 'Groups attribute' : 'Groups claim', 'groups_claim', 'groups', 'text', 'Lists someone’s groups. Empty: roles are set here, not by the provider.')}
      {field('Admin groups', 'admin', 'ct-admins')}
      {field('Approver groups', 'approver', 'ct-approvers')}
      {field('Viewer groups', 'viewer', 'engineering')}
      <div className="field" style={{ margin: 0 }}>
        <label htmlFor={id('default_role')}>Anyone else</label>
        <select id={id('default_role')} className="input" value={d.default_role} onChange={(e) => set('default_role', e.target.value as Draft['default_role'])}>
          <option value="none">Refused</option>
          <option value="viewer">Viewer</option>
          <option value="approver">Approver</option>
          <option value="admin">Admin</option>
        </select>
      </div>
      {!saml && (
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor={id('token_auth')}>Client authentication</label>
          <select id={id('token_auth')} className="input" value={d.token_auth} onChange={(e) => set('token_auth', e.target.value as Draft['token_auth'])}>
            <option value="client_secret_basic">Client secret (basic)</option>
            <option value="client_secret_post">Client secret (post)</option>
            <option value="none">None (public client, PKCE only)</option>
          </select>
        </div>
      )}
      <label className="check" style={{ alignSelf: 'end' }}>
        <input type="checkbox" checked={d.create_users} onChange={(e) => set('create_users', e.target.checked)} /> Create people on first sign-in
      </label>
      {err && (
        <div className="error" style={{ gridColumn: '1 / -1' }}>
          {err}
        </div>
      )}
      <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8 }}>
        <button className="btn primary" type="submit" disabled={busy}>
          Save
        </button>
        <button className="btn ghost" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** SCIM provisioning for one provider: a token shown once, and the base URL to give the IdP. */
function Provisioning({ p, onChange }: { p: Provider; onChange: () => void }) {
  const [shown, setShown] = useState<{ token: string; scim_url: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      onChange();
    }
  };
  return (
    <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
      <div className="sub">
        Provisioning (SCIM): {p.scim_token_set ? 'on — the identity provider adds, changes and removes people here' : 'off'}
      </div>
      {shown && (
        <div className="notice-row" style={{ display: 'block' }}>
          <div>Give your identity provider these. The token is shown only now:</div>
          <Copyable label="SCIM base URL" value={shown.scim_url} />
          <Copyable label="Token (bearer)" value={shown.token} />
          <button className="btn sm ghost" onClick={() => setShown(null)}>
            Done
          </button>
        </div>
      )}
      {err && <div className="error">{err}</div>}
      <div className="row-actions">
        <button className="btn sm" onClick={() => void run(async () => setShown(await api.post<{ token: string; scim_url: string }>(`/admin/api/identity-providers/${p.id}/scim-token`, {})))}>
          {p.scim_token_set ? 'New SCIM token' : 'Turn on provisioning'}
        </button>
        {p.scim_token_set && (
          <button className="btn sm ghost" onClick={() => void run(async () => void (await api.del(`/admin/api/identity-providers/${p.id}/scim-token`)))}>
            Revoke token
          </button>
        )}
      </div>
    </div>
  );
}

/** Identity providers people sign in with, provisioning, and whether passwords still work. Admins only. */
export function SsoSettings() {
  const [s, setS] = useState<Settings | null>(null);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [unlicensed, setUnlicensed] = useState(false);
  const load = useCallback(
    () =>
      void api
        .get<Settings>('/admin/api/identity-providers')
        .then(setS)
        .catch((e) => e instanceof ApiError && e.code === 'enterprise_required' && setUnlicensed(true)),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);

  const body = (d: Draft, isNew: boolean) => ({
    ...(isNew ? { kind: d.kind } : {}),
    name: d.name,
    ...(d.kind === 'oidc'
      ? { issuer: d.issuer, client_id: d.client_id, ...(d.client_secret ? { client_secret: d.client_secret } : {}), token_auth: d.token_auth }
      : { saml_entry_point: d.saml_entry_point, ...(d.saml_idp_cert ? { saml_idp_cert: d.saml_idp_cert } : {}), saml_idp_issuer: d.saml_idp_issuer || null, email_attribute: d.email_attribute || null }),
    allowed_domains: list(d.allowed_domains),
    groups_claim: d.groups_claim || null,
    role_map: { admin: list(d.admin), approver: list(d.approver), viewer: list(d.viewer) },
    default_role: d.default_role,
    create_users: d.create_users,
  });
  const run = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      load();
    }
  };
  if (unlicensed)
    return (
      <section style={{ marginTop: 22 }}>
        <h2 style={{ fontSize: 16, margin: '0 0 8px' }}>Single sign-on and provisioning</h2>
        <EnterpriseNotice feature="Single sign-on" />
      </section>
    );
  if (!s) return null;
  return (
    <section style={{ marginTop: 22 }}>
      <h2 style={{ fontSize: 16, margin: '0 0 4px' }}>Single sign-on and provisioning</h2>
      <p className="hint" style={{ marginTop: 0 }}>
        People sign in through your identity provider — Okta, Microsoft Entra ID, Google Workspace, OneLogin, Auth0, Keycloak — over OpenID Connect or SAML, and their groups there decide their role here. With SCIM, the provider also adds, deactivates and removes people.
      </p>
      {err && <div className="error" style={{ marginBottom: 10 }}>{err}</div>}
      {s.providers.map((p) =>
        editing === p.id ? (
          <ProviderForm
            key={p.id}
            initial={draftOf(p)}
            existing={p}
            onCancel={() => setEditing(null)}
            onSave={async (d) => {
              await api.patch(`/admin/api/identity-providers/${p.id}`, body(d, false));
              setEditing(null);
              load();
            }}
          />
        ) : (
          <div key={p.id} className="card" style={{ padding: 12, marginBottom: 8, display: 'flex', gap: 12, alignItems: 'start', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 300px' }}>
              <span className="strong">{p.name}</span> <span className="tag muted">{p.kind === 'saml' ? 'SAML' : 'OIDC'}</span> <span className="sub mono">{p.kind === 'saml' ? p.saml_entry_point : p.issuer}</span>
              <div className="sub">
                {p.groups_claim ? `Roles from “${p.groups_claim}”` : 'Roles set here'} · anyone else: {p.default_role === 'none' ? 'refused' : p.default_role} · {p.create_users ? 'creates people on first sign-in' : 'only people added here'}
                {p.allowed_domains.length ? ` · ${p.allowed_domains.join(', ')}` : ''}
                {!p.enabled ? ' · turned off' : ''}
              </div>
              {(msg[p.id] || p.last_error) && <div className={p.last_status === 'error' ? 'error' : 'sub'}>{msg[p.id] ?? p.last_error}</div>}
              <Provisioning p={p} onChange={load} />
            </div>
            <div className="row-actions">
              <button
                className="btn sm"
                onClick={() =>
                  void run(async () => {
                    const r = await api.post<{ ok: boolean; message: string }>(`/admin/api/identity-providers/${p.id}/test`, {});
                    setMsg((m) => ({ ...m, [p.id]: r.message }));
                  })
                }
              >
                Test
              </button>
              <button className="btn sm" onClick={() => void run(() => api.patch(`/admin/api/identity-providers/${p.id}`, { enabled: !p.enabled }))}>
                {p.enabled ? 'Turn off' : 'Turn on'}
              </button>
              <button className="btn sm" onClick={() => setEditing(p.id)}>
                Edit
              </button>
              <button className="btn sm danger" onClick={() => void run(() => api.del(`/admin/api/identity-providers/${p.id}`))}>
                Remove
              </button>
            </div>
          </div>
        ),
      )}
      {editing === 'new' ? (
        <ProviderForm
          initial={EMPTY}
          onCancel={() => setEditing(null)}
          onSave={async (d) => {
            const r = await api.post<{ id: string }>('/admin/api/identity-providers', body(d, true));
            // SAML: straight into editing, where the ACS URL and entity ID for the IdP are shown.
            setEditing(d.kind === 'saml' ? r.id : null);
            load();
          }}
        />
      ) : (
        <button className="btn" onClick={() => setEditing('new')}>
          + Identity provider
        </button>
      )}
      {s.providers.length > 0 && (
        <label className="check" style={{ display: 'block', marginTop: 14 }}>
          <input type="checkbox" checked={s.sso_only} disabled={!s.admin_key_set && !s.sso_only} onChange={(e) => void run(() => api.put('/admin/api/sso/settings', { sso_only: e.target.checked }))} /> Only single sign-on: turn passwords off
          <span className="hint" style={{ display: 'block', marginLeft: 22 }}>
            {s.admin_key_set
              ? 'Everyone signs in through the identity provider; password sessions end. The admin key still signs in, as the way back if the provider is down. Sign in with single sign-on yourself first.'
              : 'Needs CT_ADMIN_KEY set on the server: with passwords off, the admin key is the way back in if the identity provider is down.'}
          </span>
        </label>
      )}
    </section>
  );
}
