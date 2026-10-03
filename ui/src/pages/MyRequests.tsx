import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { PageHeader } from '../components/PageHeader';
import { ago, CLIENT_NAMES } from '../format';

/**
 * What I asked for that a gate held, and how each ended: for everyone, members included. The Tower is the
 * approvers'; this is the person waiting's. Claude's "needs approval" message links here.
 */
interface MyRequest {
  id: string;
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';
  waiting: boolean;
  gate: string | null;
  target: string;
  kind: string;
  what: string | null;
  client: string | null;
  device: string | null;
  requested_at: number;
  resolved_at: number | null;
  resolved_by: string | null;
  note: string | null;
}

const STATUS: Record<MyRequest['status'], { label: string; cls: string }> = {
  pending: { label: 'Waiting for approval', cls: 'warn' },
  approved: { label: 'Approved', cls: 'ok' },
  denied: { label: 'Denied', cls: 'error' },
  expired: { label: 'Expired', cls: '' },
  cancelled: { label: 'Withdrawn', cls: '' },
};

export function MyRequestsPage() {
  const [rows, setRows] = useState<MyRequest[] | null>(null);
  const load = useCallback(async () => {
    const r = await api.get<{ requests: MyRequest[] }>('/admin/api/me/requests');
    setRows(r.requests);
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="page">
      <PageHeader title="My requests" description="What you asked for that needed someone's approval, and how each ended. Approved after your tool stopped waiting? Send the same message again: it goes through." />
      <div className="card" style={{ padding: 0 }}>
        <table className="table my-requests">
          <thead>
            <tr>
              <th>Asked</th>
              <th>What</th>
              <th>Gate</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).map((r) => (
              <tr key={r.id}>
                <td>
                  {ago(r.requested_at)}
                  {(r.client || r.device) && (
                    <span className="sub">
                      {[r.client ? CLIENT_NAMES[r.client] ?? r.client : '', r.device ? `on ${r.device}` : ''].filter(Boolean).join(' ')}
                    </span>
                  )}
                </td>
                <td>
                  <span className="what">{r.what || r.target}</span>
                  <span className="sub mono">{r.target}</span>
                </td>
                <td>{r.gate ?? <span className="muted">—</span>}</td>
                <td>
                  <span className={`status ${STATUS[r.status]?.cls ?? ''}`}>{STATUS[r.status]?.label ?? r.status}</span>
                  {r.status === 'pending' && <span className="sub">{r.waiting ? 'your tool is waiting' : 'send it again once approved'}</span>}
                  {r.resolved_by && r.status !== 'pending' && (
                    <span className="sub">
                      by {r.resolved_by}
                      {r.resolved_at ? `, ${ago(r.resolved_at)}` : ''}
                    </span>
                  )}
                  {r.note && <span className="sub">“{r.note}”</span>}
                </td>
              </tr>
            ))}
            {rows && rows.length === 0 && (
              <tr>
                <td colSpan={4} className="table-empty">
                  <b>Nothing yet</b>
                  When a gate holds something you ask for until someone approves it, it shows here.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
