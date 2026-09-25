import { useState, type FormEvent } from 'react';
import { api, ApiError, type Me } from '../api';
import { useStore } from '../store';
import type { ReactNode } from 'react';
import { AuthSky } from '../components/AuthSky';

/** Brand story on the left, the form on the right. */
function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth-shell">
      <aside className="auth-brand">
        <AuthSky />
        <div className="auth-logo">
          <img src="/logo.svg" alt="" /> Control <span>Tower</span>
        </div>
        <div className="auth-pitch">
          <h2>Air traffic control for AI agents.</h2>
          <p>One gateway for every model and tool call your agents make — mapped, governed and accounted for.</p>
          <ul>
            <li>
              <b>See it.</b> A live map of agents, models, tool servers and the paths between them.
            </li>
            <li>
              <b>Stop it.</b> Gates block, hold for approval or inspect traffic on any path.
            </li>
            <li>
              <b>Prove it.</b> Spend, alerts and a printable inventory of every data flow.
            </li>
          </ul>
        </div>
        <div className="auth-foot">Open source · self-hosted · your data stays on this server</div>
      </aside>
      <main className="auth-main">{children}</main>
    </div>
  );
}

export function SetupPage() {
  const setMe = useStore((s) => s.setMe);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ ok: boolean; email: string; csrf: string }>('/admin/api/setup', { email, password });
      setMe({ setup_complete: true, email: r.email, csrf: r.csrf } satisfies Me);
      // A brand-new install starts on the setup guide, not an empty map.
      useStore.getState().setRoute('welcome');
      await useStore.getState().boot();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout>
      <form className="auth" onSubmit={submit}>
        <h1>Set up your tower</h1>
        <p>Create the admin account. Everything else — providers, models, keys, tool servers, gates — happens here in the browser.</p>
        <div className="field">
          <label>Email</label>
          <input className="input" type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div className="field">
          <label>Password (10+ characters)</label>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={10} required />
        </div>
        {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}
        <button className="btn primary auth-submit" disabled={busy} type="submit">
          {busy ? 'Creating…' : 'Create admin & continue'}
        </button>
      </form>
    </AuthLayout>
  );
}

export function LoginPage() {
  const setMe = useStore((s) => s.setMe);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ ok: boolean; email: string; csrf: string }>('/admin/api/login', { email, password });
      setMe({ setup_complete: true, email: r.email, csrf: r.csrf });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout>
      <form className="auth" onSubmit={submit}>
        <h1>Sign in</h1>
        <p>Welcome back. Sign in to the Airspace, approvals and settings.</p>
        <div className="field">
          <label>Email or username</label>
          <input className="input" type="text" autoComplete="username" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div className="field">
          <label>Password</label>
          <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}
        <button className="btn primary auth-submit" disabled={busy} type="submit">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </AuthLayout>
  );
}
