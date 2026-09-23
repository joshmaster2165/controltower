import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { useStore } from '../store';
import { PageHeader } from '../components/PageHeader';
import { CodeBlock } from '../components/CodeBlock';
import { Monogram } from '../components/Monogram';
import { Icon } from '../components/Icon';
import { num } from '../format';

interface HttpApi {
  id: string;
  slug: string;
  name: string;
  base_url: string;
  auth_type: 'none' | 'bearer' | 'header';
  auth_header?: string;
  timeout_ms: number;
  enabled: boolean;
  health: string;
  health_detail?: string;
  last_checked_at?: number;
  demo: boolean;
  routes: Array<{ name: string; op: string; requests: number }>;
}

const EMPTY = { name: '', slug: '', base_url: '', auth_type: 'none', token: '', header: 'x-api-key' };

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
}

export function HttpApisPage() {
  const [apis, setApis] = useState<HttpApi[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const refreshTopology = useStore((s) => s.refreshTopology);

  const load = async () => {
    const r = await api.get<{ apis: HttpApi[] }>('/admin/api/http/apis');
    setApis(r.apis);
  };
  useEffect(() => {
    void load();
  }, []);

  // Deep link #/http/new:<name>|<base url> (from "Bring it inside" on the map) opens the form pre-filled.
  const routeParam = useStore((s) => s.routeParam);
  useEffect(() => {
    if (!routeParam?.startsWith('new')) return;
    const [name = '', base = ''] = routeParam.slice(4).split('|').map((x) => decodeURIComponent(x));
    setShowAdd(true);
    setForm((f) => ({ ...f, name, slug: slugify(name), base_url: base }));
    useStore.getState().setRoute('http');
  }, [routeParam]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy('add');
    setError(null);
    try {
      await api.post('/admin/api/http/apis', {
        name: form.name,
        slug: form.slug || undefined,
        base_url: form.base_url,
        auth: form.auth_type === 'bearer' ? { type: 'bearer', token: form.token } : form.auth_type === 'header' ? { type: 'header', header: form.header, token: form.token } : { type: 'none' },
      });
      setShowAdd(false);
      setForm(EMPTY);
      await load();
      await refreshTopology();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };
  const test = async (a: HttpApi) => {
    setBusy(a.id);
    try {
      await api.post(`/admin/api/http/apis/${a.id}/test`);
      await load();
      await refreshTopology();
    } finally {
      setBusy(null);
    }
  };
  const toggle = async (a: HttpApi) => {
    await api.patch(`/admin/api/http/apis/${a.id}`, { enabled: !a.enabled });
    await load();
    await refreshTopology();
  };
  const remove = async (a: HttpApi) => {
    if (!confirm(`Remove "${a.name}"? Agents calling /http/${a.slug}/… get 404 immediately.`)) return;
    await api.del(`/admin/api/http/apis/${a.id}`);
    await load();
    await refreshTopology();
  };

  const origin = location.origin;
  const example = apis[0]?.slug ?? 'status-api';

  return (
    <div className="page">
      <PageHeader
        title="HTTP APIs"
        meta={apis.length ? `${apis.length} registered` : undefined}
        description={
          <>
            Plain REST APIs your agents call through Control Tower. Agents call <code>{origin}/http/&lt;slug&gt;/&lt;path&gt;</code> with their own key; Control Tower adds the API's credentials (agents never hold them) and every call becomes a flight you can gate, hold for approval and inspect. Reads, writes and deletes are told apart by method.
          </>
        }
        actions={
          <button className="btn primary" onClick={() => setShowAdd(true)}>
            <Icon name="plus" size={15} /> Add API
          </button>
        }
      />

      {showAdd && (
        <form className="card" style={{ marginBottom: 16, maxWidth: 640 }} onSubmit={add}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="field">
              <label>Name</label>
              <input className="input" autoFocus required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value, slug: form.slug && form.slug !== slugify(form.name) ? form.slug : slugify(e.target.value) })} placeholder="Status page" />
            </div>
            <div className="field">
              <label>Slug (the /http/&lt;slug&gt; path)</label>
              <input className="input mono" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} placeholder="status-page" />
            </div>
          </div>
          <div className="field">
            <label>Base URL</label>
            <input className="input mono" required value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} placeholder="https://api.statuspage.io/v1" />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: form.auth_type === 'header' ? '170px 150px 1fr' : '170px 1fr', gap: 12 }}>
            <div className="field">
              <label>Credentials</label>
              <select className="input" value={form.auth_type} onChange={(e) => setForm({ ...form, auth_type: e.target.value })}>
                <option value="none">none</option>
                <option value="bearer">bearer token</option>
                <option value="header">API key header</option>
              </select>
            </div>
            {form.auth_type === 'header' && (
              <div className="field">
                <label>Header name</label>
                <input className="input mono" value={form.header} onChange={(e) => setForm({ ...form, header: e.target.value })} />
              </div>
            )}
            {form.auth_type !== 'none' && (
              <div className="field">
                <label>{form.auth_type === 'bearer' ? 'Token' : 'Value'} (encrypted at rest)</label>
                <input className="input mono" type="password" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} autoComplete="off" />
              </div>
            )}
          </div>
          <div className="hint" style={{ marginBottom: 12 }}>
            Agents can reach only paths under this base URL — <code>..</code> and encoded dots are refused. Their Control Tower key is removed before the request leaves; these credentials are added instead.
          </div>
          {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" type="submit" disabled={busy === 'add'}>
              {busy === 'add' ? 'Checking…' : 'Add & test'}
            </button>
            <button className="btn ghost" type="button" onClick={() => setShowAdd(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))' }}>
        {apis.map((a) => (
          <div className={`card provider-card ${a.enabled ? '' : 'is-off'}`} key={a.id}>
            <div className="provider-head">
              <Monogram name={a.name} kind="mcp" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="provider-name">
                  {a.name}
                  {a.demo && <span className="tag muted">demo</span>}
                  {!a.enabled && <span className="tag muted">disabled</span>}
                </div>
                <div className="provider-meta mono">
                  /http/{a.slug} · {a.auth_type === 'none' ? 'no credentials' : a.auth_type === 'bearer' ? 'bearer token' : `${a.auth_header} header`}
                </div>
              </div>
              <span className={`status ${a.health === 'ok' ? 'ok' : a.health === 'down' ? 'error' : ''}`}>{a.health === 'ok' ? 'reachable' : a.health === 'down' ? 'down' : 'not checked'}</span>
            </div>
            <div className="provider-url mono">{a.base_url}</div>
            {a.routes.length > 0 ? (
              <div className="tool-list">
                {a.routes.map((r) => (
                  <div key={r.name} className="tool-row" title={`${num(r.requests)} calls in the last 7 days`}>
                    <span className="mono">{r.name}</span>
                    <span className={`op ${r.op === 'admin' ? 'admin' : r.op}`}>{r.op === 'admin' ? 'destructive' : r.op}</span>
                    <span className="tool-desc">{num(r.requests)} calls · 7 d</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="hint">No calls yet. Routes appear here (and on the map) as agents use them.</div>
            )}
            <div className="provider-foot">
              <span className="dim">{a.health_detail ?? 'not checked yet'}</span>
              <span className="spacer" />
              <button className="btn sm" onClick={() => void test(a)} disabled={busy === a.id}>
                <Icon name="refresh" size={13} /> {busy === a.id ? 'Testing…' : 'Test'}
              </button>
              <button className="btn sm ghost" onClick={() => void toggle(a)}>
                {a.enabled ? 'Disable' : 'Enable'}
              </button>
              {!a.demo && (
                <button className="btn sm ghost danger-text" onClick={() => void remove(a)}>
                  Remove
                </button>
              )}
            </div>
          </div>
        ))}
        {apis.length === 0 && (
          <div className="card empty-card">
            <Icon name="globe" size={20} />
            <b>No HTTP APIs yet</b>
            <span>Register an API your agents call directly today. Its routes appear on the Airspace, where you can gate reads, writes and deletes separately.</span>
          </div>
        )}
      </div>

      <div className="section-title">
        <h2>Connect an agent</h2>
      </div>
      <div className="grid cols-3">
        <CodeBlock
          title="curl"
          code={`curl ${origin}/http/${example}/api/v1/components \\
  -H "x-ct-key: ct_sk_..."`}
        />
        <CodeBlock
          title="Python (requests)"
          code={`import requests

api = requests.Session()
api.headers["x-ct-key"] = "ct_sk_..."   # the agent's own key
base = "${origin}/http/${example}"

api.get(f"{base}/api/v1/components")`}
        />
        <CodeBlock
          title="What a gated call returns"
          code={`HTTP 403  x-ct-status: approval_required
{ "error": { "code": "approval_required",
  "ticket": "ct_tkt_…", "how_to_resume": … } }

Retry the same request with
  x-ct-approval: <ticket>
once a human approves in the Tower.`}
        />
      </div>
    </div>
  );
}
