import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { useStore } from '../store';
import { PageHeader } from '../components/PageHeader';
import { CodeBlock } from '../components/CodeBlock';
import { Monogram } from '../components/Monogram';
import { Icon } from '../components/Icon';

interface McpServer {
  id: string;
  slug: string;
  name: string;
  url: string;
  auth_type: string;
  timeout_ms: number;
  enabled: boolean;
  health: string;
  health_detail?: string;
  tools: Array<{ name: string; description: string; annotations?: Record<string, unknown> }>;
  last_checked_at?: number;
  demo: boolean;
}

export function McpPage() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ name: '', slug: '', url: '', auth_type: 'none', token: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const refreshTopology = useStore((s) => s.refreshTopology);

  const load = async () => {
    const r = await api.get<{ servers: McpServer[] }>('/admin/api/mcp/servers');
    setServers(r.servers);
  };
  useEffect(() => {
    void load();
  }, []);

  // Deep link #/mcp/new:<name> (from "Bring it inside" on the map) opens the form, pre-named.
  const routeParam = useStore((s) => s.routeParam);
  useEffect(() => {
    if (!routeParam?.startsWith('new')) return;
    const name = routeParam.slice(4);
    setShowAdd(true);
    if (name) setForm((f) => ({ ...f, name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) }));
    useStore.getState().setRoute('mcp');
  }, [routeParam]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy('add');
    setError(null);
    try {
      await api.post('/admin/api/mcp/servers', {
        name: form.name,
        slug: form.slug || undefined,
        url: form.url,
        auth: form.auth_type === 'bearer' ? { type: 'bearer', token: form.token } : { type: 'none' },
      });
      setShowAdd(false);
      setForm({ name: '', slug: '', url: '', auth_type: 'none', token: '' });
      await load();
      await refreshTopology();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };
  const test = async (s: McpServer) => {
    setBusy(s.id);
    try {
      await api.post(`/admin/api/mcp/servers/${s.id}/test`);
      await load();
      await refreshTopology();
    } finally {
      setBusy(null);
    }
  };
  const toggle = async (s: McpServer) => {
    await api.patch(`/admin/api/mcp/servers/${s.id}`, { enabled: !s.enabled });
    await load();
    await refreshTopology();
  };
  const remove = async (s: McpServer) => {
    if (!confirm(`Remove MCP server "${s.name}"? Agents lose its tools immediately.`)) return;
    await api.del(`/admin/api/mcp/servers/${s.id}`);
    await load();
    await refreshTopology();
  };

  const origin = location.origin;

  return (
    <div className="page">
      <PageHeader
        title="MCP servers"
        meta={servers.length ? `${servers.length} registered` : undefined}
        description={
          <>
            Tool servers your agents may reach. Agents connect to <code>{origin}/mcp</code> (every server, tools named <code>server__tool</code>) or <code>{origin}/mcp/&lt;slug&gt;</code> with their own key. Tools a key may not use are simply not listed.
          </>
        }
        actions={
          <button className="btn primary" onClick={() => setShowAdd(true)}>
            <Icon name="plus" size={15} /> Add server
          </button>
        }
      />

      {showAdd && (
        <form className="card" style={{ marginBottom: 16, maxWidth: 620 }} onSubmit={add}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="field">
              <label>Name</label>
              <input className="input" autoFocus required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="GitHub" />
            </div>
            <div className="field">
              <label>Slug (tool prefix, ≤ 24 chars)</label>
              <input className="input mono" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} placeholder="github" />
            </div>
          </div>
          <div className="field">
            <label>Streamable HTTP endpoint</label>
            <input className="input mono" required value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://api.githubcopilot.com/mcp/" />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 12 }}>
            <div className="field">
              <label>Auth</label>
              <select className="input" value={form.auth_type} onChange={(e) => setForm({ ...form, auth_type: e.target.value })}>
                <option value="none">none</option>
                <option value="bearer">bearer token</option>
              </select>
            </div>
            {form.auth_type === 'bearer' && (
              <div className="field">
                <label>Token (encrypted at rest)</label>
                <input className="input mono" type="password" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} autoComplete="off" />
              </div>
            )}
          </div>
          <div className="hint" style={{ marginBottom: 12 }}>
            stdio servers are not launched by Control Tower (that would be remote code execution from an admin page). Put them behind an HTTP bridge such as <code>supergateway</code> or <code>mcp-proxy</code> and register the URL.
          </div>
          {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" type="submit" disabled={busy === 'add'}>
              {busy === 'add' ? 'Connecting…' : 'Add & test'}
            </button>
            <button className="btn ghost" type="button" onClick={() => setShowAdd(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))' }}>
        {servers.map((s) => (
          <div className={`card provider-card ${s.enabled ? '' : 'is-off'}`} key={s.id}>
            <div className="provider-head">
              <Monogram name={s.name} kind="mcp" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="provider-name">
                  {s.name}
                  {s.demo && <span className="tag muted">demo</span>}
                  {!s.enabled && <span className="tag muted">disabled</span>}
                </div>
                <div className="provider-meta mono">
                  {s.slug} · {s.tools.length} tool{s.tools.length === 1 ? '' : 's'}
                </div>
              </div>
              <span className={`status ${s.health === 'ok' ? 'ok' : s.health === 'down' ? 'error' : ''}`}>{s.health === 'ok' ? 'healthy' : s.health === 'down' ? 'down' : 'not checked'}</span>
            </div>
            <div className="provider-url mono">{s.url}</div>
            {s.tools.length > 0 && (
              <div className="tool-list">
                {s.tools.map((t) => {
                  const a = (t.annotations ?? {}) as { readOnlyHint?: boolean; destructiveHint?: boolean };
                  const op = a.destructiveHint ? 'destructive' : a.readOnlyHint ? 'read' : 'write';
                  return (
                    <div key={t.name} className="tool-row" title={t.description}>
                      <span className="mono">{t.name}</span>
                      <span className={`op ${op === 'destructive' ? 'admin' : op}`}>{op}</span>
                      {t.description && <span className="tool-desc">{t.description}</span>}
                    </div>
                  );
                })}
              </div>
            )}
            <div className="provider-foot">
              <span className="dim">{s.health_detail ?? 'not checked yet'}</span>
              <span className="spacer" />
              <button className="btn sm" onClick={() => void test(s)} disabled={busy === s.id}>
                <Icon name="refresh" size={13} /> {busy === s.id ? 'Testing…' : 'Test'}
              </button>
              <button className="btn sm ghost" onClick={() => void toggle(s)}>
                {s.enabled ? 'Disable' : 'Enable'}
              </button>
              {!s.demo && (
                <button className="btn sm ghost danger-text" onClick={() => void remove(s)}>
                  Remove
                </button>
              )}
            </div>
          </div>
        ))}
        {servers.length === 0 && (
          <div className="card empty-card">
            <Icon name="tool" size={20} />
            <b>No tool servers yet</b>
            <span>Register an MCP server and its tools appear on the Airspace, where you can gate each one.</span>
          </div>
        )}
      </div>

      <div className="section-title">
        <h2>Connect a client</h2>
      </div>
      <div className="grid cols-3">
        <CodeBlock
          title="Claude Desktop / Claude Code / Cursor — mcp.json"
          code={`{
  "mcpServers": {
    "controltower": {
      "url": "${origin}/mcp",
      "headers": { "Authorization": "Bearer ct_sk_..." }
    }
  }
}`}
        />
        <CodeBlock
          title="curl"
          code={`curl ${origin}/mcp \\
  -H "Authorization: Bearer ct_sk_..." \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`}
        />
        <CodeBlock
          title="What a gated call looks like to the model"
          code={`tools/call → { isError: true,
  content: [{ type: "text", text:
   "... {\\"ct_status\\":\\"pending\\",\\"ticket\\":\\"ct_tkt_…\\"}" }] }

Retry with _meta.ct_approval = ticket
once a human approves in the Tower.`}
        />
      </div>
    </div>
  );
}
