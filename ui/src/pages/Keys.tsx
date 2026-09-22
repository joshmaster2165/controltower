import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type KeyRow } from '../api';
import { useStore } from '../store';

export function KeysPage() {
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', team: '', project: '', allowed_models: '*', rpm: '', budget: '' });
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
        team: form.team || undefined,
        project: form.project || undefined,
        allowed_models: form.allowed_models.split(',').map((s) => s.trim()).filter(Boolean),
        limits: form.rpm ? { rpm: Number(form.rpm) } : {},
      };
      if (form.budget) body.budget = { limit_usd: Number(form.budget), period: 'monthly', hard: true };
      const r = await api.post<{ name: string; key: string }>('/admin/api/keys', body);
      setCreated(r);
      setShowNew(false);
      setForm({ name: '', team: '', project: '', allowed_models: '*', rpm: '', budget: '' });
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <h1>API keys</h1>
          <p className="sub">One key per agent. Keys carry team/project labels for the map and the ledger, model allow-lists, rate limits and budgets.</p>
        </div>
        <button className="btn primary" onClick={() => setShowNew(true)}>
          + Create key
        </button>
      </div>

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
          <div style={{ marginTop: 12, color: 'var(--text-dim)', fontSize: 13 }}>
            Point any OpenAI SDK at <code>{location.origin}/v1</code> with this key, or Claude Code / Anthropic SDK at <code>{location.origin}</code> with <code>x-api-key</code>.
          </div>
        </div>
      )}

      {showNew && (
        <form className="card" style={{ marginBottom: 16, maxWidth: 560 }} onSubmit={create}>
          <div className="field">
            <label>Name (agent)</label>
            <input className="input" autoFocus required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="invoice-bot" />
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
              <th>Name</th>
              <th>Key</th>
              <th>Team / project</th>
              <th>Models</th>
              <th>Limits</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id}>
                <td>
                  {k.name}
                  {k.demo && <span className="tag" style={{ marginLeft: 6 }}>demo</span>}
                </td>
                <td className="mono">
                  {k.prefix}…{k.last4}
                </td>
                <td>{[k.team, k.project].filter(Boolean).join(' / ') || <span style={{ color: 'var(--text-faint)' }}>—</span>}</td>
                <td className="mono">{k.allowed_models.join(', ')}</td>
                <td className="mono">{k.limits.rpm ? `${k.limits.rpm} rpm` : '—'}</td>
                <td>
                  <span className={`status ${k.enabled ? 'ok' : 'error'}`}>{k.enabled ? 'enabled' : 'disabled'}</span>
                </td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button className="btn sm ghost" onClick={() => void toggle(k)}>
                    {k.enabled ? 'Disable' : 'Enable'}
                  </button>{' '}
                  <button className="btn sm danger" onClick={() => void remove(k)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {keys.length === 0 && (
              <tr>
                <td colSpan={7} style={{ color: 'var(--text-dim)', padding: 24, textAlign: 'center' }}>
                  No keys yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
