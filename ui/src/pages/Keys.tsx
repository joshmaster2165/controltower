import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type KeyRow } from '../api';
import { useStore } from '../store';
import { PageHeader } from '../components/PageHeader';
import { Icon } from '../components/Icon';
import { ConnectAgent } from '../components/ConnectAgent';
import { ago, globList } from '../format';
import { agentColor, hex } from '../airspace/colors';

const DAY = 86_400_000;
type KeyFilter = 'all' | 'today' | 'idle' | 'never' | 'expired';
const FILTERS: Array<{ id: KeyFilter; label: string; hint: string }> = [
  { id: 'all', label: 'All', hint: 'Every key' },
  { id: 'today', label: 'Used today', hint: 'Made a call in the last 24 hours' },
  { id: 'idle', label: 'Idle 7+ days', hint: 'Nothing in the last 7 days (never-used keys count from when they were made)' },
  { id: 'never', label: 'Never used', hint: 'Made no call at all' },
  { id: 'expired', label: 'Expired', hint: 'Past their expiry: they no longer work and are not on the map' },
];
const EXPIRY_CHOICES = [
  { ms: 0, label: 'Never' },
  { ms: 3600_000, label: 'In 1 hour' },
  { ms: DAY, label: 'In 1 day' },
  { ms: 7 * DAY, label: 'In 7 days' },
  { ms: 30 * DAY, label: 'In 30 days' },
];

const isExpired = (k: KeyRow, now: number) => !!k.expires_at && k.expires_at <= now;
function matches(k: KeyRow, f: KeyFilter, now: number): boolean {
  if (f === 'all') return true;
  // Control Tower's own keys are never tidied up.
  if (k.built_in) return false;
  const expired = isExpired(k, now);
  if (f === 'expired') return expired;
  if (expired) return false;
  if (f === 'today') return !!k.last_used_at && k.last_used_at > now - DAY;
  if (f === 'never') return !k.last_used_at;
  return (k.last_used_at ?? k.created_at) < now - 7 * DAY;
}
function untilText(ts: number, now: number): string {
  const s = Math.round((ts - now) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

export function KeysPage() {
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [filter, setFilter] = useState<KeyFilter>('all');
  const [retireDays, setRetireDays] = useState(0);
  const [pendingBulk, setPendingBulk] = useState<'disable' | 'delete' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expiresIn, setExpiresIn] = useState(0);
  const [showNew, setShowNew] = useState(false);
  const [created, setCreated] = useState<{ id: string; name: string; key: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', agent_id: '', team: '', project: '', allowed_models: '*', rpm: '', budget: '', delegated_only: false });
  const refreshTopology = useStore((s) => s.refreshTopology);

  const load = async () => {
    const r = await api.get<{ keys: KeyRow[] }>('/admin/api/keys');
    setKeys(r.keys);
  };
  useEffect(() => {
    void load();
    void api
      .get<{ idle_days: number }>('/admin/api/keys/retire-policy')
      .then((r) => setRetireDays(r.idle_days))
      .catch(() => undefined);
  }, []);
  const now = Date.now();
  const shown = keys.filter((k) => matches(k, filter, now));
  const countOf = (f: KeyFilter) => keys.filter((k) => matches(k, f, now)).length;
  const tidy = filter === 'idle' || filter === 'never' || filter === 'expired';

  const chooseRetire = async (days: number) => {
    setError(null);
    try {
      const r = await api.put<{ idle_days: number; retired: Array<{ name: string }> }>('/admin/api/keys/retire-policy', { idle_days: days });
      setRetireDays(r.idle_days);
      setNotice(
        days === 0
          ? 'Idle keys are no longer retired automatically.'
          : `Keys unused for ${days} days now expire on their own.${r.retired.length ? ` Retired ${r.retired.length} already idle: ${r.retired.map((k) => k.name).join(', ')}.` : ' None are idle that long yet.'}`,
      );
      await load();
      await refreshTopology();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  const runBulk = async (action: 'disable' | 'delete') => {
    setError(null);
    try {
      const r = await api.post<{ done: number }>('/admin/api/keys/bulk', { action, ids: shown.map((k) => k.id) });
      setNotice(`${action === 'delete' ? 'Deleted' : 'Disabled'} ${r.done} key${r.done === 1 ? '' : 's'}.`);
      setPendingBulk(null);
      await load();
      await refreshTopology();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const body: Record<string, unknown> = {
        name: form.name,
        agent_id: form.agent_id.trim() || undefined,
        ...(form.delegated_only ? { delegated_only: true } : {}),
        team: form.team || undefined,
        project: form.project || undefined,
        allowed_models: form.allowed_models.split(',').map((s) => s.trim()).filter(Boolean),
        limits: form.rpm ? { rpm: Number(form.rpm) } : {},
        ...(expiresIn ? { expires_at: Date.now() + expiresIn } : {}),
      };
      if (form.budget) body.budget = { limit_usd: Number(form.budget), period: 'monthly', hard: true };
      const r = await api.post<{ id: string; name: string; key: string }>('/admin/api/keys', body);
      setCreated(r);
      setShowNew(false);
      setForm({ name: '', agent_id: '', team: '', project: '', allowed_models: '*', rpm: '', budget: '', delegated_only: false });
      setExpiresIn(0);
      await load();
      await refreshTopology();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  const toggle = async (k: KeyRow) => {
    await api.patch(`/admin/api/keys/${k.id}`, { enabled: !k.enabled });
    await load();
    await refreshTopology();
  };

  const remove = async (k: KeyRow) => {
    if (!confirm(`Delete key "${k.name}"? Agents using it will get 401 immediately.`)) return;
    await api.del(`/admin/api/keys/${k.id}`);
    await load();
    await refreshTopology();
  };

  return (
    <div className="page">
      <PageHeader
        title="API keys"
        meta={`${keys.length} agent${keys.length === 1 ? '' : 's'}`}
        description="One key per agent. A key names the agent on the map and in the ledger, and carries its team and project, allowed models, rate limit and budget."
        actions={
          <button className="btn primary" onClick={() => setShowNew(true)}>
            <Icon name="plus" size={15} /> Create key
          </button>
        }
      />

      {created && (
        <div className="card" style={{ marginBottom: 16, borderColor: 'rgba(61,220,151,0.4)' }}>
          <div style={{ fontWeight: 600 }}>Key created: {created.name}</div>
          <div style={{ color: 'var(--text-dim)', fontSize: 13 }}>Copy it now — it is shown only once.</div>
          <div className="keybox">{created.key}</div>
          <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
            <button className="btn sm" onClick={() => void navigator.clipboard.writeText(created.key)}>
              Copy
            </button>
            <button className="btn sm ghost" onClick={() => setCreated(null)}>
              Dismiss
            </button>
          </div>
          <div className="section-title" style={{ margin: '18px 0 8px' }}>
            <h2>Connect {created.name}</h2>
          </div>
          {/* Keyed by the key: a new key starts from "waiting", not from the last key's status. */}
          <ConnectAgent key={created.id} keyId={created.id} secret={created.key} />
        </div>
      )}

      {showNew && (
        <form className="card" style={{ marginBottom: 16, maxWidth: 560 }} onSubmit={create}>
          <div className="field">
            <label>Name (agent)</label>
            <input className="input" autoFocus required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="invoice-bot" />
          </div>
          <div className="field">
            <label>Agent ID (optional)</label>
            <input className="input" value={form.agent_id} onChange={(e) => setForm({ ...form, agent_id: e.target.value })} placeholder="invoice-bot" />
            <div className="hint">Keys with the same agent ID are copies of one agent (replicas, workers, one key per tenant): the map draws them as one station, and a gate on it covers every copy. Defaults to the name.</div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="field">
              <label>Team</label>
              <input className="input" value={form.team} onChange={(e) => setForm({ ...form, team: e.target.value })} placeholder="finance" />
            </div>
            <div className="field">
              <label>Project</label>
              <input className="input" value={form.project} onChange={(e) => setForm({ ...form, project: e.target.value })} placeholder="ap-automation" />
            </div>
          </div>
          <div className="field">
            <label>Allowed models (comma-separated globs)</label>
            <input className="input" value={form.allowed_models} onChange={(e) => setForm({ ...form, allowed_models: e.target.value })} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="field">
              <label>Requests per minute (optional)</label>
              <input className="input" type="number" min={1} value={form.rpm} onChange={(e) => setForm({ ...form, rpm: e.target.value })} />
            </div>
            <div className="field">
              <label>Monthly budget USD (optional)</label>
              <input className="input" type="number" min={0} step="0.01" value={form.budget} onChange={(e) => setForm({ ...form, budget: e.target.value })} />
            </div>
          </div>
          <div className="field">
            <label>Expires</label>
            <select className="input" value={expiresIn} onChange={(e) => setExpiresIn(Number(e.target.value))}>
              {EXPIRY_CHOICES.map((c) => (
                <option key={c.ms} value={c.ms}>
                  {c.label}
                </option>
              ))}
            </select>
            <div className="hint">For a short-lived agent (a sub-agent, one run of a job): the key stops working when it expires and leaves the map. Its calls stay in Flights and the Ledger.</div>
          </div>
          <label className="check-row">
            <input type="checkbox" checked={form.delegated_only} onChange={(e) => setForm({ ...form, delegated_only: e.target.checked })} />
            <span>
              <b>Acts only on behalf of other agents</b>
              <span className="hint">
                For a sub-agent that other agents call. Its calls must carry the delegation token it was called with, so gates on whom a call is for always apply; calls without one are refused.
              </span>
            </span>
          </label>
          {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" type="submit">
              Create
            </button>
            <button className="btn ghost" type="button" onClick={() => setShowNew(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="keys-tools">
        <div className="seg" role="tablist" aria-label="Which keys">
          {FILTERS.map((f) => (
            <button key={f.id} role="tab" aria-selected={filter === f.id} className={filter === f.id ? 'on' : ''} title={f.hint} onClick={() => (setFilter(f.id), setPendingBulk(null))}>
              {f.label} <span className="n">{countOf(f.id)}</span>
            </button>
          ))}
        </div>
        <label className="retire">
          <span>Retire keys unused for</span>
          <select value={retireDays} onChange={(e) => void chooseRetire(Number(e.target.value))} aria-label="Retire keys unused for">
            <option value={0}>never</option>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
          </select>
        </label>
      </div>
      {notice && (
        <div className="notice-row">
          <span>{notice}</span>
          <button className="btn sm ghost" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}
      {error && !showNew && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}
      {tidy && shown.length > 0 && (
        <div className="bulk-bar">
          {pendingBulk ? (
            <>
              <span>
                {pendingBulk === 'delete'
                  ? `Delete ${shown.length} key${shown.length === 1 ? '' : 's'}? Anything still using them gets 401 at once. Their calls stay in Flights and the Ledger.`
                  : `Disable ${shown.length} key${shown.length === 1 ? '' : 's'}? You can enable any of them again.`}
              </span>
              <button className={`btn sm ${pendingBulk === 'delete' ? 'danger' : 'primary'}`} onClick={() => void runBulk(pendingBulk)}>
                {pendingBulk === 'delete' ? 'Delete' : 'Disable'} {shown.length}
              </button>
              <button className="btn sm ghost" onClick={() => setPendingBulk(null)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <span>
                {shown.length} {FILTERS.find((f) => f.id === filter)!.label.toLowerCase()} key{shown.length === 1 ? '' : 's'}
              </span>
              {filter !== 'expired' && (
                <button className="btn sm" onClick={() => setPendingBulk('disable')}>
                  Disable all {shown.length}
                </button>
              )}
              <button className="btn sm danger" onClick={() => setPendingBulk('delete')}>
                Delete all {shown.length}
              </button>
            </>
          )}
        </div>
      )}

      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Key</th>
              <th>Models</th>
              <th>Rate limit</th>
              <th>Last used</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((k) => (
              <tr key={k.id}>
                <td>
                  <div className="agent-cell">
                    <i className="agent-dot" style={{ background: hex(agentColor(k.agent_id ?? k.id)) }} />
                    <div>
                      <span className="strong">{k.name}</span>
                      {k.demo && <span className="tag muted" style={{ marginLeft: 6 }}>demo</span>}
                      <span className="sub">{[k.team, k.project].filter(Boolean).join(' · ') || 'no team'}</span>
                    </div>
                  </div>
                </td>
                <td className="mono muted">
                  {k.prefix}…{k.last4}
                </td>
                <td>{globList(k.allowed_models)}</td>
                <td className={k.limits.rpm ? '' : 'muted'}>{k.limits.rpm ? `${k.limits.rpm}/min` : 'none'}</td>
                <td className="muted">{ago(k.last_used_at)}</td>
                <td>
                  {isExpired(k, now) ? (
                    <span className="status ticketed">expired</span>
                  ) : (
                    <span className={`status ${k.enabled ? 'ok' : 'error'}`}>{k.enabled ? 'active' : 'disabled'}</span>
                  )}
                  {k.expires_at && !isExpired(k, now) && <span className="sub">expires in {untilText(k.expires_at, now)}</span>}
                </td>
                <td>
                  <div className="row-actions">
                    <button className="btn sm" onClick={() => void toggle(k)}>
                      {k.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button className="btn sm danger" onClick={() => void remove(k)}>
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {keys.length > 0 && shown.length === 0 && (
              <tr>
                <td colSpan={7} className="table-empty">
                  <b>None here</b>
                  {FILTERS.find((f) => f.id === filter)!.hint}: no keys match.
                </td>
              </tr>
            )}
            {keys.length === 0 && (
              <tr>
                <td colSpan={7} className="table-empty">
                  <b>No keys yet</b>
                  Create one key per agent so it shows up on the map with its own name, limits and budget.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
