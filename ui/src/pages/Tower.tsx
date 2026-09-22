import { useEffect, useState } from 'react';
import { api, ApiError, type Approval } from '../api';
import { useStore } from '../store';

export function scopeStatement(a: Approval): string {
  const t = a.target;
  if (t.kind === 'tool') return `Approve this ONE call to ${t.name} with exactly these arguments`;
  return `Approve this ONE request from ${a.key_name} to ${t.name}${t.zone_to ? ` (${t.zone_to})` : ''}`;
}

export function Countdown({ until, label }: { until: number; label?: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.round((until - now) / 1000));
  const m = Math.floor(s / 60);
  return (
    <span className="cd">
      {label ? `${label} ` : ''}
      {m > 0 ? `${m}m ${s % 60}s` : `${s}s`}
    </span>
  );
}

export function ApprovalCard({ a, onDecided }: { a: Approval; onDecided?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const decide = async (action: 'approve' | 'deny') => {
    setBusy(true);
    setErr(null);
    try {
      await api.post(`/admin/api/approvals/${a.id}/decide`, { action });
      onDecided?.();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const pending = a.status === 'pending';
  const holdUntil = a.requested_at + 20_000;
  return (
    <div className={`approval ${pending ? '' : 'done'}`}>
      <div className="h">
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: pending ? 'var(--warn)' : a.status === 'approved' ? 'var(--ok)' : 'var(--danger)' }} />
        {a.key_name} → {a.target.name}
        {a.waiters > 1 && <span className="tag">{a.waiters} waiting</span>}
        {pending ? <Countdown until={Date.now() < holdUntil ? holdUntil : a.expires_at} label={Date.now() < holdUntil ? 'holding' : 'expires in'} /> : <span className="cd">{a.status}{a.resolved_by ? ` · ${a.resolved_by}` : ''}</span>}
      </div>
      <div className="s">{a.summary}</div>
      <div className="scope">{scopeStatement(a)}</div>
      {a.args_preview && (
        <div className="args">
          {Object.entries(a.args_preview)
            .filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0))
            .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
            .join('\n')}
        </div>
      )}
      {err && <div className="error" style={{ marginBottom: 6 }}>{err}</div>}
      {pending && (
        <div className="actions">
          <button className="btn sm primary" disabled={busy} onClick={() => void decide('approve')}>
            Approve
          </button>
          <button className="btn sm danger" disabled={busy} onClick={() => void decide('deny')}>
            Deny
          </button>
        </div>
      )}
    </div>
  );
}

export function TowerPage() {
  const pending = useStore((s) => s.approvals);
  const refresh = useStore((s) => s.refreshApprovals);
  const [history, setHistory] = useState<Approval[]>([]);
  const load = async () => {
    const r = await api.get<{ approvals: Approval[] }>('/admin/api/approvals?status=all&limit=100');
    setHistory(r.approvals.filter((a) => a.status !== 'pending'));
  };
  useEffect(() => {
    void load();
    void refresh();
  }, [pending.length, refresh]);

  return (
    <div className="page">
      <h1>Tower</h1>
      <p className="sub">Flights holding at a checkpoint gate wait here for a human. Approve and the flight continues transparently; ignore it and the agent receives a resumable ticket instead of a silent timeout.</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 420px) minmax(0, 1fr)', gap: 20 }}>
        <div>
          <h2 style={{ fontSize: 15, margin: '0 0 10px' }}>Pending ({pending.length})</h2>
          {pending.length === 0 && <div className="card hint">Nothing is waiting. Put a “require approval” gate on a boundary and the next crossing will appear here.</div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {pending.map((a) => (
              <ApprovalCard key={a.id} a={a} onDecided={() => void refresh()} />
            ))}
          </div>
        </div>
        <div>
          <h2 style={{ fontSize: 15, margin: '0 0 10px' }}>History</h2>
          <div className="card" style={{ padding: 0 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Agent → target</th>
                  <th>Outcome</th>
                  <th>By</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {history.map((a) => (
                  <tr key={a.id}>
                    <td className="mono">{new Date(a.requested_at).toLocaleTimeString([], { hour12: false })}</td>
                    <td>
                      {a.key_name} → {a.target.name}
                    </td>
                    <td>
                      <span className={`status ${a.status === 'approved' ? 'ok' : a.status === 'denied' ? 'denied' : 'ticketed'}`}>{a.status}</span>
                    </td>
                    <td>{a.resolved_by ?? '—'}</td>
                    <td style={{ color: 'var(--text-dim)' }}>{a.note ?? ''}</td>
                  </tr>
                ))}
                {history.length === 0 && (
                  <tr>
                    <td colSpan={5} style={{ color: 'var(--text-dim)', padding: 24, textAlign: 'center' }}>
                      No decisions yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
