import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type Me } from '../api';
import { useStore } from '../store';
import type { ReactNode } from 'react';
import { AuthSky } from '../components/AuthSky';

/** Brand story on the left, the form on the right. */
export function AuthLayout({ children }: { children: ReactNode }) {
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
  // The link printed at start carries the code: ?setup=XXXX-XXXX-XXXX.
  const [code, setCode] = useState(() => new URLSearchParams(location.search).get('setup') ?? '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ ok: boolean; email: string; csrf: string }>('/admin/api/setup', { email, password, setup_code: code });
      if (location.search) history.replaceState(null, '', location.pathname + location.hash);
      setMe({ setup_complete: true, email: r.email, csrf: r.csrf, role: 'admin' } satisfies Me);
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
          <label>Setup code</label>
          <input className="input mono" value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXX-XXXX-XXXX" required autoComplete="off" />
          <span className="hint">Printed in the server's log when it starts (with Docker: <code>docker logs &lt;container&gt;</code>), so only someone who runs this server can set it up.</span>
        </div>
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
  // A single sign-on that came back refused lands here as ?sso_error=…; shown once, then taken off the address.
  const [error, setError] = useState<string | null>(() => new URLSearchParams(location.search).get('sso_error'));
  const [busy, setBusy] = useState(false);
  const [sso, setSso] = useState<{ providers: Array<{ id: string; name: string }>; sso_only: boolean }>({ providers: [], sso_only: false });
  const [showPassword, setShowPassword] = useState(false);
  useEffect(() => {
    if (location.search.includes('sso_error')) history.replaceState(null, '', location.pathname + location.hash);
    void api.get<typeof sso>('/admin/api/sso').then(setSso).catch(() => undefined);
  }, []);
  const passwords = !sso.sso_only || showPassword;
  // Signing in to approve a laptop (/device?code=…): single sign-on comes back here, not to the console.
  const device = location.pathname === '/device';
  const next = device ? `?next=${encodeURIComponent(location.pathname + location.search)}` : '';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ ok: boolean; email: string; csrf: string; role?: Me['role']; must_change_password?: boolean }>('/admin/api/login', { email, password });
      setMe({ setup_complete: true, email: r.email, csrf: r.csrf, role: r.role ?? 'admin', must_change_password: !!r.must_change_password });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout>
      <form className="auth" onSubmit={submit}>
        <h1>{device ? 'Connect your computer' : 'Sign in'}</h1>
        <p>{device ? 'Sign in as yourself to approve the sign-in you started on your computer.' : 'Welcome back. Sign in to the Airspace, approvals and settings.'}</p>
        {sso.providers.length > 0 && (
          <div className="sso-options" style={{ display: 'grid', gap: 8, marginBottom: 14 }}>
            {sso.providers.map((p) => (
              <button key={p.id} type="button" className={`btn auth-submit ${sso.sso_only ? 'primary' : ''}`} onClick={() => location.assign(`/admin/sso/${encodeURIComponent(p.id)}/start${next}`)}>
                Sign in with {p.name}
              </button>
            ))}
            {passwords && <div className="hint" style={{ textAlign: 'center' }}>or with a password</div>}
          </div>
        )}
        {passwords && (
          <>
            <div className="field">
              <label htmlFor="login-email">Email or username</label>
              <input id="login-email" className="input" type="text" autoComplete="username" autoFocus={!sso.providers.length} value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div className="field">
              <label htmlFor="login-password">Password</label>
              <input id="login-password" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
          </>
        )}
        {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}
        {passwords ? (
          <button className={`btn auth-submit ${sso.sso_only ? '' : 'primary'}`} disabled={busy} type="submit">
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        ) : (
          <button type="button" className="link-btn hint" onClick={() => setShowPassword(true)}>
            Sign in with the admin key instead
          </button>
        )}
      </form>
    </AuthLayout>
  );
}
