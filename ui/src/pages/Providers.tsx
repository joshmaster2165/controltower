import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { useStore } from '../store';
import { PageHeader } from '../components/PageHeader';
import { Monogram } from '../components/Monogram';
import { Icon } from '../components/Icon';

const GROUPS: Array<{ title: string; hint: string; ids: string[] }> = [
  { title: 'Model providers', hint: 'Hosted APIs, including cloud platforms', ids: ['openai', 'azure-openai', 'anthropic', 'gemini', 'vertex', 'bedrock'] },
  { title: 'OpenAI-compatible APIs', hint: 'Same wire format, different host', ids: ['groq', 'together', 'fireworks', 'mistral', 'deepseek', 'xai', 'openrouter', 'perplexity'] },
  { title: 'Self-hosted', hint: 'Models running on your own machines', ids: ['ollama', 'vllm', 'lmstudio', 'custom'] },
];

interface CatalogEntry {
  id: string;
  name: string;
  kind: string;
  baseUrl?: string;
  baseUrlEditable: boolean;
  fields: Array<{ key: string; label: string; secret: boolean; placeholder?: string; required: boolean }>;
  extra?: Record<string, unknown>;
  extraFields?: Array<{ key: string; label: string; placeholder?: string; required: boolean }>;
  docs?: string;
  available: boolean;
  suggestedModels?: string[];
}

interface Provider {
  id: string;
  kind: string;
  name: string;
  slug: string;
  base_url?: string;
  extra: Record<string, unknown>;
  health: string;
  health_detail?: string;
  has_credentials: boolean;
  credential_keys: string[];
  demo: boolean;
  deployments: number;
}

interface TestResult {
  ok: boolean;
  latency_ms: number;
  detail?: string;
  models: Array<{ id: string; context?: number }>;
}

export function ProvidersPage() {
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [adding, setAdding] = useState<CatalogEntry | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tests, setTests] = useState<Record<string, TestResult | 'running'>>({});
  const [adds, setAdds] = useState<Record<string, string>>({});
  const refreshTopology = useStore((s) => s.refreshTopology);

  const load = async () => {
    const [c, p] = await Promise.all([api.get<{ providers: CatalogEntry[] }>('/admin/api/catalog'), api.get<{ providers: Provider[] }>('/admin/api/providers')]);
    setCatalog(c.providers);
    setProviders(p.providers);
  };
  useEffect(() => {
    void load();
  }, []);

  const startAdd = (c: CatalogEntry) => {
    setAdding(c);
    setError(null);
    setForm({ name: c.name, slug: c.id, base_url: c.baseUrl ?? '', api_version: (c.extra?.api_version as string) ?? '' });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!adding) return;
    setBusy(true);
    setError(null);
    try {
      const credentials: Record<string, string> = {};
      for (const f of adding.fields) if (form[f.key]) credentials[f.key] = form[f.key]!;
      const extra: Record<string, unknown> = {};
      if (adding.kind === 'azure-openai' && form.api_version) extra.api_version = form.api_version;
      for (const f of adding.extraFields ?? []) if (form[`x_${f.key}`]) extra[f.key] = form[`x_${f.key}`];
      const r = await api.post<{ provider: Provider }>('/admin/api/providers', {
        catalog_id: adding.id,
        name: form.name,
        slug: form.slug,
        base_url: adding.baseUrlEditable ? form.base_url : undefined,
        credentials,
        extra,
      });
      setAdding(null);
      await load();
      await refreshTopology();
      void test(r.provider.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const test = async (id: string) => {
    setTests((t) => ({ ...t, [id]: 'running' }));
    try {
      const r = await api.post<TestResult>(`/admin/api/providers/${id}/test`);
      setTests((t) => ({ ...t, [id]: r }));
      await load();
    } catch (err) {
      setTests((t) => ({ ...t, [id]: { ok: false, latency_ms: 0, detail: err instanceof ApiError ? err.message : String(err), models: [] } }));
    }
  };

  const addModel = async (providerId: string, model: string) => {
    setAdds((a) => ({ ...a, [`${providerId}:${model}`]: 'adding' }));
    try {
      await api.post('/admin/api/deployments', { provider_id: providerId, upstream_model: model, public_name: model });
      setAdds((a) => ({ ...a, [`${providerId}:${model}`]: 'added' }));
      await load();
      await refreshTopology();
    } catch (err) {
      setAdds((a) => ({ ...a, [`${providerId}:${model}`]: err instanceof ApiError ? err.message : 'failed' }));
    }
  };

  const remove = async (p: Provider) => {
    if (!confirm(`Delete provider "${p.name}" and its ${p.deployments} model deployment(s)?`)) return;
    await api.del(`/admin/api/providers/${p.id}`);
    await load();
    await refreshTopology();
  };

  return (
    <div className="page">
      <PageHeader
        title="Providers"
        meta={providers.length ? `${providers.length} connected` : undefined}
        description="Connect the model providers your agents may reach. Credentials are encrypted at rest with the master key and never leave this server."
      />

      {adding && (
        <form className="card" style={{ marginBottom: 18, maxWidth: 560 }} onSubmit={submit}>
          <div className="form-title">
            <Monogram name={adding.name} kind={adding.kind} size={28} />
            <span>Connect {adding.name}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="field">
              <label>Display name</label>
              <input className="input" value={form.name ?? ''} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </div>
            <div className="field">
              <label>Slug (used in model ids like slug/model)</label>
              <input className="input mono" value={form.slug ?? ''} onChange={(e) => setForm({ ...form, slug: e.target.value })} required />
            </div>
          </div>
          {adding.baseUrlEditable && (
            <div className="field">
              <label>Base URL</label>
              <input className="input mono" value={form.base_url ?? ''} onChange={(e) => setForm({ ...form, base_url: e.target.value })} />
            </div>
          )}
          {adding.kind === 'azure-openai' && (
            <div className="field">
              <label>API version</label>
              <input className="input mono" value={form.api_version ?? ''} onChange={(e) => setForm({ ...form, api_version: e.target.value })} />
            </div>
          )}
          {(adding.extraFields ?? []).map((f) => (
            <div className="field" key={`x_${f.key}`}>
              <label>{f.label}</label>
              <input className="input mono" placeholder={f.placeholder} value={form[`x_${f.key}`] ?? ''} onChange={(e) => setForm({ ...form, [`x_${f.key}`]: e.target.value })} required={f.required} />
            </div>
          ))}
          {adding.fields.map((f) => (
            <div className="field" key={f.key}>
              <label>{f.label}</label>
              <input className="input mono" type={f.secret ? 'password' : 'text'} placeholder={f.placeholder} value={form[f.key] ?? ''} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} required={f.required} autoComplete="off" />
            </div>
          ))}
          {adding.docs && (
            <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginBottom: 12 }}>
              Get a key: <a href={adding.docs} target="_blank" rel="noreferrer">{adding.docs}</a>
            </div>
          )}
          {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" disabled={busy} type="submit">
              {busy ? 'Connecting…' : 'Connect & test'}
            </button>
            <button className="btn ghost" type="button" onClick={() => setAdding(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {providers.length > 0 && (
        <div className="section-title" style={{ marginTop: 0 }}>
          <h2>Connected</h2>
        </div>
      )}
      {providers.length > 0 && (
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', marginBottom: 8 }}>
          {providers.map((p) => {
            const t = tests[p.id];
            return (
              <div className="card provider-card" key={p.id}>
                <div className="provider-head">
                  <Monogram name={p.name} kind={p.kind} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="provider-name">
                      {p.name}
                      {p.demo && <span className="tag muted">demo</span>}
                    </div>
                    <div className="provider-meta mono">
                      {p.slug} · {p.kind}
                    </div>
                  </div>
                  <span className={`status ${p.health === 'ok' ? 'ok' : p.health === 'down' ? 'error' : ''}`}>{p.health === 'ok' ? 'healthy' : p.health === 'down' ? 'down' : 'not tested'}</span>
                </div>
                {p.base_url && <div className="provider-url mono">{p.base_url}</div>}
                <div className="provider-foot">
                  <span className="dim">
                    {p.deployments} model deployment{p.deployments === 1 ? '' : 's'}
                    {p.health_detail ? ` · ${p.health_detail}` : ''}
                  </span>
                  <span className="spacer" />
                  <button className="btn sm" onClick={() => void test(p.id)} disabled={t === 'running'}>
                    <Icon name="refresh" size={13} /> {t === 'running' ? 'Testing…' : 'Test connection'}
                  </button>
                  {!p.demo && (
                    <button className="btn sm ghost danger-text" onClick={() => void remove(p)}>
                      Delete
                    </button>
                  )}
                </div>
                {t && t !== 'running' && (
                  <div style={{ marginTop: 10 }}>
                    <div className={t.ok ? '' : 'error'} style={{ fontSize: 13 }}>
                      {t.ok ? `Connected in ${t.latency_ms} ms` : `Failed: ${t.detail}`}
                    </div>
                    {t.ok && t.models.length > 0 && (
                      <div style={{ marginTop: 8, maxHeight: 220, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
                        {t.models.slice(0, 200).map((m) => {
                          const st = adds[`${p.id}:${m.id}`];
                          return (
                            <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', borderBottom: '1px solid var(--border)', fontSize: 12.5 }}>
                              <span className="mono" style={{ flex: 1 }}>{m.id}</span>
                              {st === 'added' ? (
                                <span style={{ color: 'var(--ok)' }}>added</span>
                              ) : st === 'adding' ? (
                                <span style={{ color: 'var(--text-dim)' }}>…</span>
                              ) : st ? (
                                <span className="error">{st}</span>
                              ) : (
                                <button className="btn sm ghost" onClick={() => void addModel(p.id, m.id)}>
                                  + Add model
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="section-title">
        <h2>Add a provider</h2>
      </div>
      {GROUPS.map((g) => {
        const items = catalog.filter((c) => g.ids.includes(c.id));
        if (!items.length) return null;
        return (
          <div key={g.title} className="catalog-group">
            <div className="catalog-label">
              {g.title} <span>{g.hint}</span>
            </div>
            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 10 }}>
              {items.map((c) => (
                <button key={c.id} className="card catalog-tile" disabled={!c.available} onClick={() => startAdd(c)}>
                  <Monogram name={c.name} kind={c.kind} size={30} />
                  <span>
                    <span className="catalog-name">{c.name}</span>
                    <span className="catalog-kind">{c.available ? (c.kind === 'openai-compatible' ? 'OpenAI-compatible' : c.kind) : 'coming soon'}</span>
                  </span>
                  <Icon name="plus" size={15} className="catalog-plus" />
                </button>
              ))}
            </div>
          </div>
        );
      })}
      {catalog.filter((c) => !GROUPS.some((g) => g.ids.includes(c.id))).length > 0 && (
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 10 }}>
          {catalog
            .filter((c) => !GROUPS.some((g) => g.ids.includes(c.id)))
            .map((c) => (
              <button key={c.id} className="card catalog-tile" disabled={!c.available} onClick={() => startAdd(c)}>
                <Monogram name={c.name} kind={c.kind} size={30} />
                <span>
                  <span className="catalog-name">{c.name}</span>
                  <span className="catalog-kind">{c.kind}</span>
                </span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
