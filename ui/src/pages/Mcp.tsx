import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { useStore } from '../store';

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
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <h1>MCP servers</h1>
          <p className="sub">
            Register the tool servers your agents may reach. Agents connect to <code>{origin}/mcp</code> (all servers, tools named <code>server__tool</code>) or <code>{origin}/mcp/&lt;slug&gt;</code> with their Control Tower key. Tools a key may not use are simply not listed.
          </p>
        </div>
        <button className="btn primary" onClick={() => setShowAdd(true)}>
          + Add server
        </button>
      </div>

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
          <div className="card" key={s.id}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className={`status ${s.health === 'ok' ? 'ok' : s.health === 'down' ? 'error' : ''}`} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>
                  {s.name} {s.demo && <span className="tag">demo</span>} {!s.enabled && <span className="tag">disabled</span>}
                </div>
                <div className="mono" style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                  {s.slug} · {s.url}
                </div>
              </div>
              <button className="btn sm" onClick={() => void test(s)} disabled={busy === s.id}>
                {busy === s.id ? 'Testing…' : 'Test'}
              </button>
              <button className="btn sm ghost" onClick={() => void toggle(s)}>
                {s.enabled ? 'Disable' : 'Enable'}
              </button>
              {!s.demo && (
                <button className="btn sm danger" onClick={() => void remove(s)}>
                  Remove
                </button>
              )}
            </div>
            <div className="hint" style={{ marginTop: 6 }}>{s.health_detail ?? 'not checked yet'}</div>
            {s.tools.length > 0 && (
              <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {s.tools.map((t) => {
                  const a = (t.annotations ?? {}) as { readOnlyHint?: boolean; destructiveHint?: boolean };
                  return (
                    <span key={t.name} className="tag" title={t.description} style={{ background: a.destructiveHint ? 'rgba(255,92,122,0.15)' : a.readOnlyHint ? 'rgba(61,220,151,0.12)' : undefined, color: a.destructiveHint ? '#ffb3c1' : a.readOnlyHint ? '#9ef0c9' : undefined }}>
                      {s.slug}__{t.name}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
        ))}
        {servers.length === 0 && <div className="card hint">No MCP servers yet.</div>}
      </div>

      <h2 style={{ fontSize: 15, margin: '20px 0 10px' }}>Connect a client</h2>
      <div className="grid cols-3">
        <div className="card">
          <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginBottom: 6 }}>Claude Desktop / Claude Code / Cursor (mcp.json)</div>
          <pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12 }}>{`{
  "mcpServers": {
    "controltower": {
      "url": "${origin}/mcp",
      "headers": { "Authorization": "Bearer ct_sk_..." }
    }
  }
}`}</pre>
        </div>
        <div className="card">
          <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginBottom: 6 }}>curl</div>
          <pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12 }}>{`curl ${origin}/mcp \\
  -H "Authorization: Bearer ct_sk_..." \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`}</pre>
        </div>
        <div className="card">
          <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginBottom: 6 }}>How gating shows up to the model</div>
          <pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12 }}>{`tools/call → { isError: true,
  content: [{ type: "text", text:
   "... {\\"ct_status\\":\\"pending\\",\\"ticket\\":\\"ct_tkt_…\\"}" }] }

Retry with _meta.ct_approval = ticket
once a human approves in the Tower.`}</pre>
        </div>
      </div>
    </div>
  );
}
