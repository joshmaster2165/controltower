import { useCallback, useEffect, useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { Icon } from '../components/Icon';
import { api, ApiError } from '../api';
import { ago } from '../format';
import { EnterpriseNotice } from './LicensePage';

interface AuditEvent {
  seq: number;
  id: string;
  time: string;
  actor: { type: 'person' | 'admin_key' | 'anonymous' | 'system'; id: string | null; email: string | null; role: string | null };
  action: string;
  outcome: 'success' | 'denied' | 'failure';
  status: number | null;
  target: { type: string | null; id: string | null } | null;
  detail: Record<string, unknown> | null;
  ip: string | null;
  user_agent: string | null;
  request_id: string | null;
}
interface Verify {
  ok: boolean;
  events: number;
  first_seq: number | null;
  last_seq: number | null;
  broken_at?: number;
  reason?: string;
}

const OUTCOME: Record<AuditEvent['outcome'], { label: string; cls: string }> = {
  success: { label: 'done', cls: 'ok' },
  denied: { label: 'refused', cls: 'denied' },
  failure: { label: 'failed', cls: 'error' },
};
const RANGES = [
  { id: '1', label: '24 hours', days: 1 },
  { id: '7', label: '7 days', days: 7 },
  { id: '30', label: '30 days', days: 30 },
  { id: 'all', label: 'All', days: 0 },
];

function who(a: AuditEvent['actor']): string {
  if (a.type === 'admin_key') return 'Admin key';
  if (a.type === 'system') return 'Control Tower';
  if (a.email) return a.email;
  return 'Not signed in';
}

/** Who changed what in Control Tower, and who tried. Admins only. */
export function AuditPage() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [range, setRange] = useState('7');
  const [outcome, setOutcome] = useState('');
  const [actor, setActor] = useState('');
  const [action, setAction] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const [verify, setVerify] = useState<Verify | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [unlicensed, setUnlicensed] = useState(false);

  const query = useCallback(
    (before?: number) => {
      const p = new URLSearchParams({ limit: '100' });
      const days = RANGES.find((r) => r.id === range)?.days ?? 0;
      if (days) p.set('since', String(Date.now() - days * 86_400_000));
      if (outcome) p.set('outcome', outcome);
      if (actor.trim()) p.set('actor', actor.trim());
      if (action.trim()) p.set('action', action.trim());
      if (before) p.set('before', String(before));
      return p;
    },
    [range, outcome, actor, action],
  );
  const load = useCallback(
    (before?: number) => {
      setErr(null);
      void api
        .get<{ events: AuditEvent[]; next: number | null }>(`/admin/api/audit?${query(before)}`)
        .then((d) => {
          setEvents((prev) => (before ? [...prev, ...d.events] : d.events));
          setNext(d.events.length === 100 ? d.next : null);
        })
        .catch((e) => (e instanceof ApiError && e.code === 'enterprise_required' ? setUnlicensed(true) : setErr(e instanceof ApiError ? e.message : String(e))));
    },
    [query],
  );
  useEffect(() => {
    const t = setTimeout(() => load(), 250);
    return () => clearTimeout(t);
  }, [load]);

  const exportUrl = (format: 'csv' | 'jsonl') => {
    const p = query();
    p.delete('limit');
    p.delete('outcome');
    p.delete('actor');
    p.delete('action');
    p.set('format', format);
    return `/admin/api/audit/export?${p}`;
  };

  if (unlicensed)
    return (
      <div className="page">
        <PageHeader title="Audit log" description="Every change made in Control Tower, and every attempt that was refused, chained so edits to the log show." />
        <EnterpriseNotice feature="The audit log" />
      </div>
    );
  return (
    <div className="page">
      <PageHeader
        title="Audit log"
        description="Every change made in Control Tower — by a person, the admin key or single sign-on — and every attempt that was refused. Passwords, keys and credentials are never recorded. Each event is chained to the one before it, so edits to the log show."
        actions={
          <>
            <button className="btn" onClick={() => void api.get<Verify>('/admin/api/audit/verify').then(setVerify).catch((e) => setErr(String(e)))}>
              <Icon name="check" size={15} /> Verify
            </button>
            <a className="btn" href={exportUrl('csv')} download>
              <Icon name="download" size={15} /> CSV
            </a>
            <a className="btn" href={exportUrl('jsonl')} download>
              <Icon name="download" size={15} /> JSON Lines
            </a>
          </>
        }
      />
      {verify && (
        <div className={verify.ok ? 'notice-row' : 'error'} style={{ marginBottom: 12 }} role="status">
          {verify.ok
            ? verify.events
              ? `Intact: all ${verify.events.toLocaleString()} events (${verify.first_seq}–${verify.last_seq}) are unchanged and in order.`
              : 'Nothing recorded yet.'
            : `Broken at event ${verify.broken_at}: ${verify.reason}. Someone changed the log outside Control Tower.`}
        </div>
      )}
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}
      <div className="toolbar">
        <div className="seg">
          {RANGES.map((r) => (
            <button key={r.id} className={range === r.id ? 'on' : ''} onClick={() => setRange(r.id)}>
              {r.label}
            </button>
          ))}
        </div>
        <div className="seg">
          {[
            ['', 'All'],
            ['denied', 'Refused'],
            ['failure', 'Failed'],
          ].map(([id, label]) => (
            <button key={id} className={outcome === id ? 'on' : ''} onClick={() => setOutcome(id!)}>
              {label}
            </button>
          ))}
        </div>
        <label className="search">
          <Icon name="search" size={15} />
          <input value={actor} onChange={(e) => setActor(e.target.value)} placeholder="Person (email)" aria-label="Filter by person" />
        </label>
        <label className="search">
          <Icon name="search" size={15} />
          <input value={action} onChange={(e) => setAction(e.target.value)} placeholder="Action, e.g. keys or auth.sign_in" aria-label="Filter by action" />
        </label>
      </div>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table className="table">
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>Action</th>
              <th>Outcome</th>
              <th>What</th>
              <th>From</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => {
              const o = OUTCOME[e.outcome] ?? { label: e.outcome, cls: '' };
              const t = new Date(e.time).getTime();
              return [
                <tr key={e.seq} onClick={() => setOpen(open === e.seq ? null : e.seq)} style={{ cursor: 'pointer' }}>
                  <td title={new Date(t).toLocaleString()}>
                    <span className="mono">{new Date(t).toLocaleString([], { hour12: false, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                    <span className="sub">{ago(t)}</span>
                  </td>
                  <td>
                    <span className="strong">{who(e.actor)}</span>
                    {e.actor.role && e.actor.type === 'person' && <span className="sub">{e.actor.role}</span>}
                  </td>
                  <td className="mono">{e.action}</td>
                  <td>
                    <span className={`status ${o.cls}`}>{o.label}</span>
                    {e.status && e.outcome !== 'success' && <span className="sub">{e.status}</span>}
                  </td>
                  <td className="mono">{e.target?.id ?? e.target?.type ?? ''}</td>
                  <td className="mono">{e.ip ?? ''}</td>
                </tr>,
                open === e.seq && (
                  <tr key={`${e.seq}-detail`}>
                    <td colSpan={6}>
                      <pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12 }}>
                        {JSON.stringify({ event: e.seq, request_id: e.request_id, user_agent: e.user_agent, ...(e.detail ?? {}) }, null, 2)}
                      </pre>
                    </td>
                  </tr>
                ),
              ];
            })}
            {!events.length && (
              <tr>
                <td colSpan={6} className="muted">
                  Nothing recorded in this window.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {next && (
        <div style={{ marginTop: 12 }}>
          <button className="btn" onClick={() => load(next)}>
            Older events
          </button>
        </div>
      )}
    </div>
  );
}
