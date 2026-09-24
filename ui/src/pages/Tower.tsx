import { useEffect, useState } from 'react';
import { api, ApiError, type Approval } from '../api';
import { useStore } from '../store';
import { PageHeader } from '../components/PageHeader';
import { ago } from '../format';
import { Icon } from '../components/Icon';

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
        <span className="t">{a.key_name} → {a.target.name}</span>
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

/** The approval an alert linked to (#/tower/<id>), shown first whatever its state. */
function LinkedApproval({ id, version }: { id: string; version: number }) {
  const [a, setA] = useState<Approval | null | 'missing'>(null);
  const setRoute = useStore((s) => s.setRoute);
  useEffect(() => {
    api
      .get<{ approval: Approval }>(`/admin/api/approvals/${encodeURIComponent(id)}`)
      .then((r) => setA(r.approval))
      .catch(() => setA('missing'));
  }, [id, version]);
  return (
    <div className="linked-approval">
      <div className="section-h">
        <h2 style={{ fontSize: 15, margin: 0 }}>Request from your alert</h2>
        <button className="btn sm ghost" onClick={() => setRoute('tower')}>
          Show all
        </button>
      </div>
      {a === null && <div className="card hint">Loading…</div>}
      {a === 'missing' && <div className="card hint">This approval no longer exists.</div>}
      {a && a !== 'missing' && (
        <>
          <ApprovalCard a={a} onDecided={() => void useStore.getState().refreshApprovals()} />
          {a.status !== 'pending' && (
            <div className="hint" style={{ marginTop: 6 }}>
              Already {a.status}
              {a.resolved_by ? ` by ${a.resolved_by}` : ''}
              {a.resolved_at ? ` at ${new Date(a.resolved_at).toLocaleTimeString()}` : ''}. Nothing left to do.
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function TowerPage() {
  const pending = useStore((s) => s.approvals);
  const refresh = useStore((s) => s.refreshApprovals);
  const linkedId = useStore((s) => s.routeParam);
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
      <PageHeader
        title="Tower"
        meta={pending.length ? `${pending.length} waiting` : 'nothing waiting'}
        description="Requests held at an approval gate wait here for a human. Approve and the request continues as if nothing happened; let it expire and the agent gets a ticket it can retry with — never a silent timeout."
      />
      {linkedId && <LinkedApproval id={linkedId} version={pending.length + history.length} />}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 400px) minmax(0, 1fr)', gap: 24 }}>
        <div>
          <div className="section-title" style={{ marginTop: 0 }}>
            <h2>Waiting for you</h2>
            <span className="count">{pending.length}</span>
          </div>
          {pending.length === 0 && (
            <div className="card empty-card">
              <Icon name="check" size={20} />
              <b>All clear</b>
              <span>Put a “require approval” gate on a path and the next request across it will wait here.</span>
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {pending
              .filter((a) => a.id !== linkedId)
              .map((a) => (
                <ApprovalCard key={a.id} a={a} onDecided={() => void refresh()} />
              ))}
          </div>
        </div>
        <div>
          <div className="section-title" style={{ marginTop: 0 }}>
            <h2>Recent decisions</h2>
          </div>
          <div className="card" style={{ padding: 0 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Request</th>
                  <th>Outcome</th>
                  <th>Decided by</th>
                </tr>
              </thead>
              <tbody>
                {history.map((a) => (
                  <tr key={a.id}>
                    <td title={new Date(a.requested_at).toLocaleString()}>
                      <span className="mono">{new Date(a.requested_at).toLocaleTimeString([], { hour12: false })}</span>
                      <span className="sub">{ago(a.requested_at)}</span>
                    </td>
                    <td>
                      <span className="strong">{a.key_name}</span>
                      <span className="sub mono ellipsis">{a.target.name}</span>
                    </td>
                    <td>
                      <span className={`status ${a.status === 'approved' ? 'ok' : a.status === 'denied' ? 'denied' : 'ticketed'}`}>{a.status}</span>
                    </td>
                    <td>
                      {a.resolved_by ?? <span className="muted">nobody</span>}
                      {a.note && <span className="sub ellipsis">{a.note}</span>}
                    </td>
                  </tr>
                ))}
                {history.length === 0 && (
                  <tr>
                    <td colSpan={4} className="table-empty">
                      <b>No decisions yet</b>
                      Approvals and denials show up here with who made them.
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
