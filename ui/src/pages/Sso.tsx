import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';

type Role = 'admin' | 'approver' | 'viewer';
interface Provider {
  id: string;
  name: string;
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
  name: string;
  issuer: string;
  client_id: string;
  client_secret: string;
  allowed_domains: string;
  groups_claim: string;
  admin: string;
  approver: string;
  viewer: string;
  default_role: Role | 'none';
  create_users: boolean;
  token_auth: Provider['token_auth'];
}
const EMPTY: Draft = { name: '', issuer: '', client_id: '', client_secret: '', allowed_domains: '', groups_claim: 'groups', admin: '', approver: '', viewer: '', default_role: 'viewer', create_users: true, token_auth: 'client_secret_basic' };
const draftOf = (p: Provider): Draft => ({
  name: p.name,
  issuer: p.issuer,
  client_id: p.client_id,
  client_secret: '',
  allowed_domains: p.allowed_domains.join(', '),
  groups_claim: p.groups_claim ?? '',
  admin: (p.role_map.admin ?? []).join(', '),
  approver: (p.role_map.approver ?? []).join(', '),
  viewer: (p.role_map.viewer ?? []).join(', '),
  default_role: p.default_role,
  create_users: p.create_users,
  token_auth: p.token_auth,
});

function ProviderForm({ initial, redirect, onSave, onCancel }: { initial: Draft; redirect: string; onSave: (d: Draft) => Promise<void>; onCancel: () => void }) {
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
  const field = (label: string, k: keyof Draft, placeholder = '', type = 'text', hint?: string) => (
    <div className="field" style={{ margin: 0 }}>
      <label>{label}</label>
      <input className="input" type={type} value={String(d[k])} placeholder={placeholder} onChange={(e) => set(k, e.target.value as never)} />
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
  return (
    <form className="card" style={{ padding: 14, display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }} onSubmit={(e) => void submit(e)}>
      <div className="hint" style={{ gridColumn: '1 / -1' }}>
        In your identity provider, create an OpenID Connect web app with this sign-in redirect URL: <code className="mono">{redirect}</code>
      </div>
      {field('Name on the sign-in page', 'name', 'Okta')}
      {field('Issuer URL', 'issuer', 'https://acme.okta.com', 'url', 'Where /.well-known/openid-configuration is.')}
      {field('Client ID', 'client_id')}
      {field('Client secret', 'client_secret', initial.client_id ? 'unchanged' : '', 'password')}
      {field('Email domains allowed', 'allowed_domains', 'acme.com, acme.co.uk', 'text', 'Empty: any email the provider vouches for.')}
      {field('Groups claim', 'groups_claim', 'groups', 'text', 'The ID-token claim listing someone’s groups. Empty: roles are set here, not by the provider.')}
      {field('Admin groups', 'admin', 'ct-admins')}
      {field('Approver groups', 'approver', 'ct-approvers')}
      {field('Viewer groups', 'viewer', 'engineering')}
      <div className="field" style={{ margin: 0 }}>
        <label>Anyone else</label>
        <select className="input" value={d.default_role} onChange={(e) => set('default_role', e.target.value as Draft['default_role'])}>
          <option value="none">Refused</option>
          <option value="viewer">Viewer</option>
          <option value="approver">Approver</option>
          <option value="admin">Admin</option>
        </select>
      </div>
      <div className="field" style={{ margin: 0 }}>
        <label>Client authentication</label>
        <select className="input" value={d.token_auth} onChange={(e) => set('token_auth', e.target.value as Draft['token_auth'])}>
          <option value="client_secret_basic">Client secret (basic)</option>
          <option value="client_secret_post">Client secret (post)</option>
          <option value="none">None (public client, PKCE only)</option>
        </select>
      </div>
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

/** Identity providers people sign in with, and whether passwords still work. Admins only. */
export function SsoSettings() {
  const [s, setS] = useState<Settings | null>(null);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => void api.get<Settings>('/admin/api/identity-providers').then(setS), []);
  useEffect(() => {
    load();
  }, [load]);

  const body = (d: Draft) => ({
    name: d.name,
    issuer: d.issuer,
    client_id: d.client_id,
    ...(d.client_secret ? { client_secret: d.client_secret } : {}),
    allowed_domains: list(d.allowed_domains),
    groups_claim: d.groups_claim || null,
    role_map: { admin: list(d.admin), approver: list(d.approver), viewer: list(d.viewer) },
    default_role: d.default_role,
    create_users: d.create_users,
    token_auth: d.token_auth,
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
  if (!s) return null;
  return (
    <section style={{ marginTop: 22 }}>
      <h2 style={{ fontSize: 16, margin: '0 0 4px' }}>Single sign-on</h2>
      <p className="hint" style={{ marginTop: 0 }}>
        People sign in through your identity provider (Okta, Microsoft Entra ID, Google Workspace, Auth0, Keycloak — anything that speaks OpenID Connect), and their groups there decide their role here.
      </p>
      {err && <div className="error" style={{ marginBottom: 10 }}>{err}</div>}
      {s.providers.map((p) =>
        editing === p.id ? (
          <ProviderForm key={p.id} initial={draftOf(p)} redirect={p.redirect_uri} onCancel={() => setEditing(null)} onSave={async (d) => { await api.patch(`/admin/api/identity-providers/${p.id}`, body(d)); setEditing(null); load(); }} />
        ) : (
          <div key={p.id} className="card" style={{ padding: 12, marginBottom: 8, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 260px' }}>
              <span className="strong">{p.name}</span> <span className="sub mono">{p.issuer}</span>
              <div className="sub">
                {p.groups_claim ? `Roles from “${p.groups_claim}”` : 'Roles set here'} · anyone else: {p.default_role === 'none' ? 'refused' : p.default_role} · {p.create_users ? 'creates people on first sign-in' : 'only people added here'}
                {p.allowed_domains.length ? ` · ${p.allowed_domains.join(', ')}` : ''}
              </div>
              {(msg[p.id] || p.last_error) && <div className={p.last_status === 'error' ? 'error' : 'sub'}>{msg[p.id] ?? p.last_error}</div>}
            </div>
            <div className="row-actions">
              <button className="btn sm" onClick={() => void run(async () => { const r = await api.post<{ ok: boolean; message: string }>(`/admin/api/identity-providers/${p.id}/test`, {}); setMsg((m) => ({ ...m, [p.id]: r.message })); })}>
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
        <ProviderForm initial={EMPTY} redirect={s.redirect_uri_pattern.replace('<id>', '…')} onCancel={() => setEditing(null)} onSave={async (d) => { await api.post('/admin/api/identity-providers', body(d)); setEditing(null); load(); }} />
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
