import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { PageHeader } from '../components/PageHeader';
import { api, ApiError } from '../api';
import { useStore } from '../store';
import { SsoSettings } from '../ee/Sso';

type Role = 'admin' | 'approver' | 'viewer';
interface User {
  id: string;
  email: string;
  role: Role;
  created_at: number;
  last_seen_at: number | null;
  must_change_password: boolean;
  sso: boolean;
  provisioned: boolean;
  disabled: boolean;
  display_name: string | null;
}

const ROLE_TEXT: Record<Role, string> = {
  admin: 'Changes anything: providers, keys, gates, people',
  approver: 'Sees everything; approves and denies held calls',
  viewer: 'Sees everything; changes nothing',
};

/** A one-time password, shown once, with a way to copy it. */
function OneTime({ email, password, onDone }: { email: string; password: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="notice-row" style={{ display: 'block' }}>
      <div>
        One-time password for <b>{email}</b> — shown only now. They sign in with it and choose their own:
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
        <code className="mono" style={{ userSelect: 'all' }}>
          {password}
        </code>
        <button
          className="btn sm"
          onClick={() =>
            void navigator.clipboard
              .writeText(password)
              .then(() => setCopied(true))
              .catch(() => undefined)
          }
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button className="btn sm ghost" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

/** The people who sign in to the console and what each may do. Admins only. */
export function UsersPage() {
  const me = useStore((s) => s.me);
  const [rows, setRows] = useState<User[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [shown, setShown] = useState<{ email: string; password: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => void api.get<{ users: User[] }>('/admin/api/users').then((d) => setRows(d.users)), []);
  useEffect(() => {
    load();
  }, [load]);
  const run = async (fn: () => Promise<void>) => {
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      load();
    }
  };
  const add = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await api.post<{ email: string; password: string }>('/admin/api/users', { email, role });
      setShown({ email: r.email, password: r.password });
      setEmail('');
    });
  };
  return (
    <div className="page">
      <PageHeader title="People" description="Who signs in to the console, and what each may do. New people get a one-time password to share with them; they choose their own when they first sign in." />
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}
      {shown && <OneTime email={shown.email} password={shown.password} onDone={() => setShown(null)} />}
      <form className="card" style={{ padding: 14, marginBottom: 14, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }} onSubmit={add}>
        <div className="field" style={{ flex: '1 1 240px', margin: 0 }}>
          <label>Email</label>
          <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="dana@example.com" />
        </div>
        <div className="field" style={{ flex: '0 1 200px', margin: 0 }}>
          <label>Role</label>
          <select className="input" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="viewer">Viewer</option>
            <option value="approver">Approver</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <button className="btn primary" type="submit">
          Add person
        </button>
        <span className="hint" style={{ flexBasis: '100%' }}>
          {ROLE_TEXT[role]}.
        </span>
      </form>
      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead>
            <tr>
              <th>Person</th>
              <th>Role</th>
              <th>Last signed in</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id}>
                <td>
                  <span className="strong">{u.email}</span>
                  {u.id === (me as { id?: string } | null)?.id || u.email === me?.email ? <span className="sub">you</span> : null}
                  {u.must_change_password && <span className="sub">has a one-time password</span>}
                  {u.display_name && <span className="sub">{u.display_name}</span>}
                  {u.sso && <span className="sub">signs in with single sign-on</span>}
                  {u.provisioned && <span className="sub">provisioned by your identity provider</span>}
                  {u.disabled && <span className="tag muted">deactivated</span>}
                </td>
                <td>
                  <select className="input" style={{ width: 150 }} value={u.role} onChange={(e) => void run(() => api.patch(`/admin/api/users/${u.id}`, { role: e.target.value }))}>
                    <option value="viewer">Viewer</option>
                    <option value="approver">Approver</option>
                    <option value="admin">Admin</option>
                  </select>
                  <span className="sub">{ROLE_TEXT[u.role]}</span>
                </td>
                <td className="muted">{u.last_seen_at ? new Date(u.last_seen_at).toLocaleString() : 'never'}</td>
                <td>
                  <div className="row-actions">
                    <button className="btn sm" onClick={() => void run(async () => setShown({ email: u.email, password: (await api.patch<{ password: string }>(`/admin/api/users/${u.id}`, { reset_password: true })).password }))}>
                      Reset password
                    </button>
                    {u.email !== me?.email && (
                      <button className="btn sm danger" onClick={() => void run(() => api.del(`/admin/api/users/${u.id}`))}>
                        Remove
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <SsoSettings />
    </div>
  );
}

/** Change your own password: from the sidebar, or — after signing in with a one-time password — before anything else. */
export function ChangePassword({ forced, onDone }: { forced?: boolean; onDone: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== again) return setErr('The new passwords are not the same.');
    setBusy(true);
    setErr(null);
    try {
      await api.post('/admin/api/me/password', { current, password: next });
      onDone();
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : String(e2));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="card" style={{ padding: 20, maxWidth: 420, margin: forced ? '12vh auto' : '0 0 14px' }} onSubmit={(e) => void submit(e)}>
      <h2 style={{ marginTop: 0 }}>{forced ? 'Choose your password' : 'Change your password'}</h2>
      {forced && <p className="hint">You signed in with a one-time password. Choose your own to continue.</p>}
      <div className="field">
        <label>{forced ? 'One-time password' : 'Current password'}</label>
        <input className="input" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
      </div>
      <div className="field">
        <label>New password (10 characters or more)</label>
        <input className="input" type="password" autoComplete="new-password" required minLength={10} value={next} onChange={(e) => setNext(e.target.value)} />
      </div>
      <div className="field">
        <label>New password, again</label>
        <input className="input" type="password" autoComplete="new-password" required minLength={10} value={again} onChange={(e) => setAgain(e.target.value)} />
      </div>
      {err && <div className="error" style={{ marginBottom: 10 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn primary" type="submit" disabled={busy}>
          Save password
        </button>
        {!forced && (
          <button className="btn ghost" type="button" onClick={onDone}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
