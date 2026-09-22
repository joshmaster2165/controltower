import { useState, type FormEvent } from 'react';
import { api, ApiError, type Me } from '../api';
import { useStore } from '../store';

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
      await useStore.getState().boot();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center">
      <form className="card auth" onSubmit={submit}>
        <div className="brand" style={{ marginBottom: 14 }}>
          <img src="/logo.svg" alt="" /> Control <span className="accent">Tower</span>
        </div>
        <h1>Set up your tower</h1>
        <p>Create the admin account. Everything else — providers, models, keys, MCP servers, zones — happens in the browser after this.</p>
        <div className="field">
          <label>Email</label>
          <input className="input" type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div className="field">
          <label>Password (10+ characters)</label>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={10} required />
        </div>
        {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}
        <button className="btn primary" disabled={busy} type="submit">
          {busy ? 'Creating…' : 'Create admin & continue'}
        </button>
      </form>
    </div>
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
    <div className="center">
      <form className="card auth" onSubmit={submit}>
        <div className="brand" style={{ marginBottom: 14 }}>
          <img src="/logo.svg" alt="" /> Control <span className="accent">Tower</span>
        </div>
        <h1>Sign in</h1>
        <p>Admin access to the Airspace, keys and approvals.</p>
        <div className="field">
          <label>Email</label>
          <input className="input" type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div className="field">
          <label>Password</label>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}
        <button className="btn primary" disabled={busy} type="submit">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
