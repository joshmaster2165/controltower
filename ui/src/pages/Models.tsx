import { useEffect, useState, type FormEvent } from 'react';
import { ImportConfig } from './ImportConfig';
import { PageHeader } from '../components/PageHeader';
import { Icon } from '../components/Icon';

const STRATEGY: Record<string, string> = { priority: 'in order', weighted: 'weighted', 'least-latency': 'fastest first', 'least-cost': 'cheapest first' };
import { api, ApiError } from '../api';
import { useStore } from '../store';

interface Deployment {
  id: string;
  provider_id: string;
  provider_slug?: string;
  provider_kind?: string;
  upstream_model: string;
  public_name?: string;
  price: { input: number; output: number; cache_read?: number } | null;
  price_source: string;
  enabled: boolean;
  cooling_until?: number;
  ewma_ttft_ms?: number;
  demo: boolean;
}

interface Alias {
  id: string;
  name: string;
  strategy: string;
  targets: Array<{ deploymentId: string; priority: number; weight: number }>;
  demo: boolean;
}

interface Provider {
  id: string;
  name: string;
  slug: string;
  kind: string;
}

export function ModelsPage() {
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [aliases, setAliases] = useState<Alias[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ provider_id: '', upstream_model: '', public_name: '', input: '', output: '' });
  const [showAlias, setShowAlias] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [aliasForm, setAliasForm] = useState<{ name: string; strategy: string; targets: string[] }>({ name: '', strategy: 'priority', targets: [] });
  const refreshTopology = useStore((s) => s.refreshTopology);

  const load = async () => {
    const [d, a, p] = await Promise.all([
      api.get<{ deployments: Deployment[] }>('/admin/api/deployments'),
      api.get<{ aliases: Alias[] }>('/admin/api/aliases'),
      api.get<{ providers: Provider[] }>('/admin/api/providers'),
    ]);
    setDeployments(d.deployments);
    setAliases(a.aliases);
    setProviders(p.providers);
    if (!addForm.provider_id && p.providers[0]) setAddForm((f) => ({ ...f, provider_id: p.providers[0]!.id }));
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addDeployment = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const pricing_override = addForm.input && addForm.output ? { mode: 'chat', input: Number(addForm.input), output: Number(addForm.output) } : null;
      await api.post('/admin/api/deployments', {
        provider_id: addForm.provider_id,
        upstream_model: addForm.upstream_model,
        public_name: addForm.public_name || addForm.upstream_model,
        pricing_override,
      });
      setShowAdd(false);
      setAddForm((f) => ({ ...f, upstream_model: '', public_name: '', input: '', output: '' }));
      await load();
      await refreshTopology();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  const toggle = async (d: Deployment) => {
    await api.patch(`/admin/api/deployments/${d.id}`, { enabled: !d.enabled });
    await load();
    await refreshTopology();
  };
  const removeDeployment = async (d: Deployment) => {
    if (!confirm(`Delete model "${d.public_name ?? d.upstream_model}"?`)) return;
    await api.del(`/admin/api/deployments/${d.id}`);
    await load();
    await refreshTopology();
  };

  const saveAlias = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.post('/admin/api/aliases', { name: aliasForm.name, strategy: aliasForm.strategy, targets: aliasForm.targets.map((id, i) => ({ deployment_id: id, priority: aliasForm.strategy === 'priority' ? i : 0 })) });
      setShowAlias(false);
      setAliasForm({ name: '', strategy: 'priority', targets: [] });
      await load();
      await refreshTopology();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };
  const removeAlias = async (a: Alias) => {
    if (!confirm(`Delete alias "${a.name}"? Agents using it will get model_not_found.`)) return;
    await api.del(`/admin/api/aliases/${a.id}`);
    await load();
    await refreshTopology();
  };

  const depLabel = (id: string) => {
    const d = deployments.find((x) => x.id === id);
    return d ? `${d.public_name ?? d.upstream_model} (${d.provider_slug})` : id;
  };

  return (
    <div className="page">
      <PageHeader
        title="Models"
        description={
          <>
            Agents ask for a name like <code>smart</code>; you decide what it means. A <b>deployment</b> is one model on one provider; an <b>alias</b> routes a name across deployments with fallbacks.
          </>
        }
        actions={
          <>
            <button className="btn" onClick={() => setShowImport(true)}>
              <Icon name="upload" size={15} /> Import config
            </button>
            <button className="btn" onClick={() => setShowAlias(true)}>
              <Icon name="plus" size={15} /> Alias
            </button>
            <button className="btn primary" onClick={() => setShowAdd(true)}>
              <Icon name="plus" size={15} /> Model
            </button>
          </>
        }
      />

      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

      {showImport && (
        <ImportConfig
          onClose={() => setShowImport(false)}
          onImported={() => {
            void load();
            void refreshTopology();
          }}
        />
      )}

      {showAdd && (
        <form className="card" style={{ marginBottom: 16, maxWidth: 620 }} onSubmit={addDeployment}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="field">
              <label>Provider</label>
              <select className="input" value={addForm.provider_id} onChange={(e) => setAddForm({ ...addForm, provider_id: e.target.value })} required>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.slug})
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Upstream model id</label>
              <input className="input mono" value={addForm.upstream_model} onChange={(e) => setAddForm({ ...addForm, upstream_model: e.target.value })} placeholder="gpt-4.1-mini" required />
            </div>
          </div>
          <div className="field">
            <label>Public name (what agents request; defaults to the upstream id)</label>
            <input className="input mono" value={addForm.public_name} onChange={(e) => setAddForm({ ...addForm, public_name: e.target.value })} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="field">
              <label>Price override — input $/M tokens (optional)</label>
              <input className="input" type="number" step="0.0001" value={addForm.input} onChange={(e) => setAddForm({ ...addForm, input: e.target.value })} />
            </div>
            <div className="field">
              <label>Output $/M tokens</label>
              <input className="input" type="number" step="0.0001" value={addForm.output} onChange={(e) => setAddForm({ ...addForm, output: e.target.value })} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" type="submit">
              Add model
            </button>
            <button className="btn ghost" type="button" onClick={() => setShowAdd(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {showAlias && (
        <form className="card" style={{ marginBottom: 16, maxWidth: 620 }} onSubmit={saveAlias}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="field">
              <label>Alias name</label>
              <input className="input mono" value={aliasForm.name} onChange={(e) => setAliasForm({ ...aliasForm, name: e.target.value })} placeholder="smart" required />
            </div>
            <div className="field">
              <label>Strategy</label>
              <select className="input" value={aliasForm.strategy} onChange={(e) => setAliasForm({ ...aliasForm, strategy: e.target.value })}>
                <option value="priority">priority (first healthy wins)</option>
                <option value="weighted">weighted (spread evenly)</option>
                <option value="least-latency">least latency (fastest first)</option>
                <option value="least-cost">least cost (cheapest first)</option>
              </select>
            </div>
          </div>
          <div className="field">
            <label>Targets in fallback order (click to add)</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {deployments
                .filter((d) => d.enabled)
                .map((d) => {
                  const idx = aliasForm.targets.indexOf(d.id);
                  return (
                    <button
                      type="button"
                      key={d.id}
                      className={`btn sm ${idx >= 0 ? 'primary' : 'ghost'}`}
                      onClick={() =>
                        setAliasForm({ ...aliasForm, targets: idx >= 0 ? aliasForm.targets.filter((x) => x !== d.id) : [...aliasForm.targets, d.id] })
                      }
                    >
                      {idx >= 0 ? `${idx + 1}. ` : ''}
                      {d.public_name ?? d.upstream_model}
                    </button>
                  );
                })}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" type="submit" disabled={aliasForm.targets.length === 0}>
              Create alias
            </button>
            <button className="btn ghost" type="button" onClick={() => setShowAlias(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="section-title">
        <h2>Aliases</h2>
        <span className="count">{aliases.length}</span>
      </div>
      <div className="card" style={{ padding: 0, marginBottom: 8 }}>
        <table className="table">
          <thead>
            <tr>
              <th>Name agents use</th>
              <th>Routing</th>
              <th>Tries, in order</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {aliases.map((a) => (
              <tr key={a.id}>
                <td>
                  <span className="mono strong">{a.name}</span>
                  {a.demo && <span className="tag muted" style={{ marginLeft: 6 }}>demo</span>}
                </td>
                <td className="muted">{STRATEGY[a.strategy] ?? a.strategy}</td>
                <td>
                  <div className="route-chain">
                    {a.targets.map((t, i) => (
                      <span key={t.deploymentId} className="route-step">
                        {i > 0 && <span className="route-arrow">→</span>}
                        <span className="route-chip">{depLabel(t.deploymentId)}</span>
                      </span>
                    ))}
                  </div>
                </td>
                <td>
                  <div className="row-actions">
                    <button className="btn sm danger" onClick={() => void removeAlias(a)}>
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {aliases.length === 0 && (
              <tr>
                <td colSpan={4} className="table-empty">
                  <b>No aliases yet</b>
                  An alias lets agents ask for <code>fast</code> or <code>smart</code> while you choose — and change — the models behind it.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="section-title">
        <h2>Deployments</h2>
        <span className="count">{deployments.length}</span>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Provider</th>
              <th className="num">Price in / out ($/M)</th>
              <th className="num">Time to first token</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {deployments.map((d) => (
              <tr key={d.id}>
                <td>
                  <span className="mono strong">{d.public_name ?? d.upstream_model}</span>
                  {d.demo && <span className="tag muted" style={{ marginLeft: 6 }}>demo</span>}
                  <span className="sub mono">{d.public_name && d.public_name !== d.upstream_model ? d.upstream_model : d.public_name ? '' : 'only reachable through an alias'}</span>
                </td>
                <td>{d.provider_slug}</td>
                <td className="num mono">
                  {d.price ? `${d.price.input} / ${d.price.output}` : <span style={{ color: 'var(--warn)' }}>unpriced</span>}
                  {d.price && <span className="sub">{d.price_source}</span>}
                </td>
                <td className={`num mono ${d.ewma_ttft_ms ? '' : 'muted'}`}>{d.ewma_ttft_ms ? `${Math.round(d.ewma_ttft_ms)} ms` : '—'}</td>
                <td>
                  <span className={`status ${d.enabled ? (d.cooling_until && d.cooling_until > Date.now() ? 'ticketed' : 'ok') : 'error'}`}>
                    {d.enabled ? (d.cooling_until && d.cooling_until > Date.now() ? 'cooling' : 'enabled') : 'disabled'}
                  </span>
                </td>
                <td>
                  <div className="row-actions">
                    <button className="btn sm" onClick={() => void toggle(d)}>
                      {d.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button className="btn sm danger" onClick={() => void removeDeployment(d)}>
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {deployments.length === 0 && (
              <tr>
                <td colSpan={6} className="table-empty">
                  <b>No models yet</b>
                  Connect a provider, then add models from its discovered list — or import a config file.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

    </div>
  );
}
