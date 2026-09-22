import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { useStore } from '../store';

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
      <h1>Providers</h1>
      <p className="sub">Connect the LLM providers your agents may reach. Credentials are encrypted at rest with the master key and never leave this server.</p>

      {adding && (
        <form className="card" style={{ marginBottom: 18, maxWidth: 560 }} onSubmit={submit}>
          <div style={{ fontWeight: 600, marginBottom: 10 }}>Connect {adding.name}</div>
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
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', marginBottom: 24 }}>
          {providers.map((p) => {
            const t = tests[p.id];
            return (
              <div className="card" key={p.id}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span className={`status ${p.health === 'ok' ? 'ok' : p.health === 'down' ? 'error' : ''}`} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600 }}>
                      {p.name} {p.demo && <span className="tag">demo</span>}
                    </div>
                    <div style={{ fontSize: 12.5, color: 'var(--text-dim)' }} className="mono">
                      {p.slug} · {p.kind}
                      {p.base_url ? ` · ${p.base_url}` : ''}
                    </div>
                  </div>
                  <button className="btn sm" onClick={() => void test(p.id)} disabled={t === 'running'}>
                    {t === 'running' ? 'Testing…' : 'Test connect'}
                  </button>
                  {!p.demo && (
                    <button className="btn sm danger" onClick={() => void remove(p)}>
                      Delete
                    </button>
                  )}
                </div>
                <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--text-dim)' }}>
                  {p.deployments} model deployment{p.deployments === 1 ? '' : 's'}
                  {p.health_detail ? ` · ${p.health_detail}` : ''}
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

      <h2 style={{ fontSize: 15, margin: '6px 0 10px' }}>Add a provider</h2>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))' }}>
        {catalog.map((c) => (
          <button key={c.id} className="card" disabled={!c.available} onClick={() => startAdd(c)} style={{ textAlign: 'left', cursor: c.available ? 'pointer' : 'default', opacity: c.available ? 1 : 0.5 }}>
            <div style={{ fontWeight: 600 }}>{c.name}</div>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 2 }}>{c.available ? c.kind : 'coming soon'}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
