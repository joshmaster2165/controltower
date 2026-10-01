import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { AuthLayout } from '../pages/Auth';
import { ago } from '../format';
import { useStore } from '../store';

interface Pending {
  user_code: string;
  client: string;
  client_name: string;
  device_name: string;
  ip: string;
  started_at: number;
  expires_at: number;
  key?: { id: string; name: string; team: string | null };
  problem?: string;
}
export interface DeviceSession {
  id: string;
  person?: string;
  client: string;
  client_name: string;
  device_name: string;
  created_at: number;
  last_used_at: number;
  last_ip: string | null;
  ends_at: number;
  status: 'active' | 'revoked' | 'expired';
  revoked_by: string | null;
  key: { id: string; name: string | null } | null;
}

const tidy = (s: string) => s.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8);
const pretty = (s: string) => (s.length > 4 ? `${s.slice(0, 4)}-${s.slice(4)}` : s);

/**
 * Where a laptop's sign-in is approved (Enterprise): ct-auth opens /device?code=XXXX-XXXX after the person signs
 * in as usual. It shows what asked, from where and as which key, and the person's own computers.
 */
export function DevicePage() {
  const me = useStore((s) => s.me);
  const [code, setCode] = useState(() => tidy(new URLSearchParams(location.search).get('code') ?? ''));
  const [pending, setPending] = useState<Pending | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<null | { approved: boolean; client_name: string; device_name: string }>(null);
  const [busy, setBusy] = useState(false);
  const [mine, setMine] = useState<DeviceSession[]>([]);
  const [unlicensed, setUnlicensed] = useState(false);

  const loadMine = useCallback(() => {
    void api
      .get<{ sessions: DeviceSession[] }>('/admin/api/me/devices')
      .then((d) => setMine(d.sessions))
      .catch((e) => e instanceof ApiError && e.code === 'enterprise_required' && setUnlicensed(true));
  }, []);
  useEffect(loadMine, [loadMine]);

  const look = useCallback(async (c: string) => {
    setErr(null);
    setPending(null);
    setDone(null);
    if (c.length !== 8) return;
    try {
      setPending(await api.get<Pending>(`/admin/api/me/devices/pending?code=${pretty(c)}`));
    } catch (e) {
      if (e instanceof ApiError && e.code === 'enterprise_required') setUnlicensed(true);
      else setErr(e instanceof ApiError ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    if (code.length === 8) void look(code);
    // Only the code from the address is looked up by itself; one typed in is looked up on submit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const decide = async (approve: boolean) => {
    if (!pending) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<{ approved: boolean }>('/admin/api/me/devices/approve', { user_code: pending.user_code, approve });
      setDone({ approved: r.approved, client_name: pending.client_name, device_name: pending.device_name });
      setPending(null);
      loadMine();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    await api.del(`/admin/api/me/devices/${id}`).catch(() => undefined);
    loadMine();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void look(code);
  };

  const active = mine.filter((s) => s.status === 'active');
  return (
    <AuthLayout>
      <div className="auth device-page" style={{ width: 460 }}>
        <h1>Connect your computer</h1>
        {unlicensed ? (
          <p>Laptop sign-in is part of Control Tower Enterprise, and this Control Tower has no license for it. Ask an admin.</p>
        ) : done ? (
          <div className="device-result" role="status">
            {done.approved ? (
              <>
                <div className="device-big ok">Approved</div>
                <p>
                  {done.client_name} on <b>{done.device_name}</b> is signed in as you. Go back to it: it carries on by itself within a few seconds.
                </p>
              </>
            ) : (
              <>
                <div className="device-big">Refused</div>
                <p>Nothing was signed in. If you didn’t start this, tell your IT team.</p>
              </>
            )}
          </div>
        ) : pending ? (
          <div className="device-request">
            <p>
              <b>{pending.client_name}</b> on <b>{pending.device_name}</b> asks to use Control Tower as <b>{me?.email}</b>.
            </p>
            <dl className="device-facts">
              <dt>Code</dt>
              <dd className="mono">{pending.user_code}</dd>
              <dt>Started</dt>
              <dd>
                {ago(pending.started_at)} from {pending.ip}
              </dd>
              <dt>Calls made as</dt>
              <dd>{pending.key ? <span className="mono">{pending.key.name}</span> : '—'}</dd>
            </dl>
            {pending.problem ? (
              <div className="error">{pending.problem}</div>
            ) : (
              <>
                <div className="hint device-warn">Check the code matches the one on your screen. Approve only a sign-in you just started yourself — never one someone sent you.</div>
                <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                  <button className="btn primary auth-submit" disabled={busy} onClick={() => void decide(true)}>
                    Approve
                  </button>
                  <button className="btn auth-submit" disabled={busy} onClick={() => void decide(false)}>
                    Refuse
                  </button>
                </div>
              </>
            )}
          </div>
        ) : (
          <form onSubmit={submit}>
            <p>Enter the code shown where you started signing in (Claude Code, Claude Desktop, Codex or ct-auth).</p>
            <div className="field">
              <label htmlFor="device-code">Code</label>
              <input id="device-code" className="input mono device-code" autoFocus autoComplete="off" placeholder="XXXX-XXXX" value={pretty(code)} onChange={(e) => setCode(tidy(e.target.value))} />
            </div>
            <button className="btn primary auth-submit" type="submit" disabled={code.length !== 8}>
              Continue
            </button>
          </form>
        )}
        {err && (
          <div className="error" style={{ marginTop: 12 }}>
            {err}
          </div>
        )}
        {active.length > 0 && (
          <div className="device-mine">
            <h2>Your computers</h2>
            <ul>
              {active.map((s) => (
                <li key={s.id}>
                  <div>
                    <b>{s.client_name}</b> on {s.device_name}
                    <div className="hint">
                      used {ago(s.last_used_at)}
                      {s.key?.name ? ` · as ${s.key.name}` : ''}
                    </div>
                  </div>
                  <button className="btn sm" onClick={() => void revoke(s.id)}>
                    Sign out
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="hint" style={{ marginTop: 18 }}>
          Signed in as {me?.email}.{' '}
          <a href="/" onClick={() => history.replaceState(null, '', '/')}>
            Open Control Tower
          </a>
        </p>
      </div>
    </AuthLayout>
  );
}
