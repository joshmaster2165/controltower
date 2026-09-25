import { useEffect, useState } from 'react';
import { api, ApiError, type Approval, type ApprovalWindowRow } from '../api';
import { useStore } from '../store';
import { PageHeader } from '../components/PageHeader';
import { ago } from '../format';
import { Icon } from '../components/Icon';

export function scopeStatement(a: Approval): string {
  const t = a.target;
  const behalf = t.on_behalf_of?.length ? `, made for ${t.on_behalf_of[0]}` : '';
  if (t.kind === 'tool') return `Approve this ONE call to ${t.name} with exactly these arguments${behalf}`;
  return `Approve this ONE request from ${a.key_name} to ${t.name}${t.zone_to ? ` (${t.zone_to})` : ''}${behalf}`;
}

/** Who a chained call is really for: the agent that started it, then each agent it passed through, then the one asking. */
export function BehalfLine({ a }: { a: Approval }) {
  const chain = a.target.on_behalf_of;
  if (!chain?.length) return null;
  return (
    <div className="behalf-line">
      For <b>{chain[0]}</b>
      {chain.length > 1 && <> via {chain.slice(1).join(' → ')}</>} → <b>{a.key_name}</b>
    </div>
  );
}

/** How long an approval window stays open. */
const WINDOW_TIMES = [
  { ms: 10 * 60_000, label: '10 minutes' },
  { ms: 30 * 60_000, label: '30 minutes' },
  { ms: 60 * 60_000, label: '1 hour' },
];

export function windowStatement(a: Approval, uses: number, ms: number, anyArgs: boolean): string {
  const time = WINDOW_TIMES.find((t) => t.ms === ms)?.label ?? `${Math.round(ms / 60_000)} minutes`;
  if (a.target.kind !== 'tool') return `Approve this request, and let ${a.key_name} make ${uses} more request${uses === 1 ? '' : 's'} to ${a.target.name} through this gate in the next ${time}. No card for those.`;
  const calls = `${uses} more call${uses === 1 ? '' : 's'}`;
  return `Approve this call, and let ${a.key_name} make ${calls} to ${a.target.name} through this gate in the next ${time} — ${anyArgs ? 'with any arguments' : 'with exactly these arguments'}. No card for those.`;
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
  const [more, setMore] = useState(false);
  const [uses, setUses] = useState(5);
  const [ms, setMs] = useState(30 * 60_000);
  const [anyArgs, setAnyArgs] = useState(true);
  const usesOk = Number.isInteger(uses) && uses >= 1 && uses <= 1000;
  const tool = a.target.kind === 'tool';
  const decide = async (action: 'approve' | 'deny', window?: { uses: number; ttl_ms: number; any_args: boolean }) => {
    setBusy(true);
    setErr(null);
    try {
      await api.post(`/admin/api/approvals/${a.id}/decide`, { action, ...(window ? { window } : {}) });
      onDecided?.();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const pending = a.status === 'pending';
  const holdUntil = a.hold_until ?? a.requested_at + 20_000;
  return (
    <div className={`approval ${pending ? '' : 'done'}`}>
      <div className="h">
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: pending ? 'var(--warn)' : a.status === 'approved' ? 'var(--ok)' : 'var(--danger)' }} />
        <span className="t">{a.key_name} → {a.target.name}</span>
        {a.waiters > 1 && <span className="tag">{a.waiters} waiting</span>}
        {pending ? <Countdown until={Date.now() < holdUntil ? holdUntil : a.expires_at} label={Date.now() < holdUntil ? 'holding' : 'expires in'} /> : <span className="cd">{a.status}{a.resolved_by ? ` · ${a.resolved_by}` : ''}</span>}
      </div>
      <div className="s">{a.summary}</div>
      <BehalfLine a={a} />
      <div className="scope">{pending && more ? windowStatement(a, usesOk ? uses : 1, ms, anyArgs) : scopeStatement(a)}</div>
      {a.args_preview && (
        <div className="args">
          {Object.entries(a.args_preview)
            .filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0))
            .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
            .join('\n')}
        </div>
      )}
      {err && <div className="error" style={{ marginBottom: 6 }}>{err}</div>}
      {pending && more && (
        <div className="approve-more">
          <label>
            <span>Next</span>
            <input type="number" min={1} max={1000} value={Number.isNaN(uses) ? '' : uses} onChange={(e) => setUses(e.target.valueAsNumber)} aria-label="How many more calls" />
            <span>calls, for</span>
            <select value={ms} onChange={(e) => setMs(Number(e.target.value))} aria-label="For how long">
              {WINDOW_TIMES.map((t) => (
                <option key={t.ms} value={t.ms}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          {/* On a model gate the arguments are the request's settings, not its prompt: no choice to offer. */}
          {tool && (
            <div className="seg" role="radiogroup" aria-label="Which arguments">
              <button type="button" role="radio" aria-checked={anyArgs} className={anyArgs ? 'on' : ''} onClick={() => setAnyArgs(true)}>
                Any arguments
              </button>
              <button type="button" role="radio" aria-checked={!anyArgs} className={!anyArgs ? 'on' : ''} onClick={() => setAnyArgs(false)}>
                Only these
              </button>
            </div>
          )}
        </div>
      )}
      {pending && (
        <div className="actions">
          {more ? (
            <>
              <button className="btn sm primary" disabled={busy || !usesOk} onClick={() => void decide('approve', { uses, ttl_ms: ms, any_args: !tool || anyArgs })}>
                Approve this + next {usesOk ? uses : '…'}
              </button>
              <button className="btn sm ghost" disabled={busy} onClick={() => setMore(false)}>
                Just this one
              </button>
            </>
          ) : (
            <>
              <button className="btn sm primary" disabled={busy} onClick={() => void decide('approve')}>
                Approve
              </button>
              <button className="btn sm danger" disabled={busy} onClick={() => void decide('deny')}>
                Deny
              </button>
              {a.rule_id && (
                <button className="btn sm ghost" disabled={busy} onClick={() => setMore(true)} title="Approve this call and let the agent make more like it without asking">
                  Approve more…
                </button>
              )}
            </>
          )}
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

/** Agents a human let through a gate for their next N calls, with what is left and a way to end it. */
function OpenWindows({ version }: { version: number }) {
  const [rows, setRows] = useState<ApprovalWindowRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const load = () =>
    api
      .get<{ windows: ApprovalWindowRow[] }>('/admin/api/approval-windows')
      .then((r) => setRows(r.windows))
      .catch(() => undefined);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [version]);
  const revoke = async (id: string) => {
    setErr(null);
    try {
      await api.post(`/admin/api/grants/${encodeURIComponent(id)}/revoke`, {});
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  };
  if (rows.length === 0) return null;
  return (
    <div className="open-windows">
      <div className="section-title" style={{ marginTop: 0 }}>
        <h2>Approved ahead</h2>
        <span className="count">{rows.length}</span>
      </div>
      {err && <div className="error">{err}</div>}
      <div className="card" style={{ padding: 0 }}>
        {rows.map((w) => (
          <div className="window-row" key={w.id}>
            <div className="what">
              <span className="strong">{w.key_name}</span> → <span className="mono">{w.target_name}</span>
              <span className="sub">
                {w.uses_left} of {w.uses_allowed} calls left · <Countdown until={w.expires_at} label="ends in" /> · {w.any_args ? 'any arguments' : 'only the approved arguments'}
                {w.approved_by ? ` · approved by ${w.approved_by}` : ''}
              </span>
            </div>
            <button className="btn sm danger" onClick={() => void revoke(w.id)}>
              End now
            </button>
          </div>
        ))}
      </div>
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
          <OpenWindows version={pending.length + history.length} />
          <div className="section-title" style={{ marginTop: 0 }}>
            <h2>Recent decisions</h2>
          </div>
          <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
            <table className="table fixed" style={{ minWidth: 560 }}>
              <colgroup>
                <col style={{ width: 104 }} />
                <col />
                <col style={{ width: 112 }} />
                <col style={{ width: '32%' }} />
              </colgroup>
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
                      {a.target.on_behalf_of?.length ? <span className="sub">for {a.target.on_behalf_of[0]}</span> : null}
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
