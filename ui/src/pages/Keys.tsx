import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type KeyRow } from '../api';
import { useStore } from '../store';
import { PageHeader } from '../components/PageHeader';
import { Icon } from '../components/Icon';
import { ConnectAgent } from '../components/ConnectAgent';
import { ago, globList } from '../format';
import { agentColor, hex } from '../airspace/colors';

export function KeysPage() {
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [created, setCreated] = useState<{ id: string; name: string; key: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', agent_id: '', team: '', project: '', allowed_models: '*', rpm: '', budget: '' });
  const refreshTopology = useStore((s) => s.refreshTopology);

  const load = async () => {
    const r = await api.get<{ keys: KeyRow[] }>('/admin/api/keys');
    setKeys(r.keys);
  };
  useEffect(() => {
    void load();
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const body: Record<string, unknown> = {
        name: form.name,
        agent_id: form.agent_id.trim() || undefined,
        team: form.team || undefined,
        project: form.project || undefined,
        allowed_models: form.allowed_models.split(',').map((s) => s.trim()).filter(Boolean),
        limits: form.rpm ? { rpm: Number(form.rpm) } : {},
      };
      if (form.budget) body.budget = { limit_usd: Number(form.budget), period: 'monthly', hard: true };
      const r = await api.post<{ id: string; name: string; key: string }>('/admin/api/keys', body);
      setCreated(r);
      setShowNew(false);
      setForm({ name: '', agent_id: '', team: '', project: '', allowed_models: '*', rpm: '', budget: '' });
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
            {keys.map((k) => (
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
                  <span className={`status ${k.enabled ? 'ok' : 'error'}`}>{k.enabled ? 'active' : 'disabled'}</span>
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
