import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { useStore } from '../store';
import { PageHeader } from '../components/PageHeader';
import { CodeBlock } from '../components/CodeBlock';
import { Monogram } from '../components/Monogram';
import { Icon } from '../components/Icon';
import { num } from '../format';

interface A2aAgent {
  id: string;
  slug: string;
  name: string;
  card_url: string;
  endpoint: string | null;
  protocol_version: string | null;
  description: string;
  skills: Array<{ id: string; name: string; description: string }>;
  streaming: boolean;
  auth_type: 'none' | 'bearer' | 'header';
  agent_id: string | null;
  timeout_ms: number;
  enabled: boolean;
  health: string;
  health_detail?: string;
  last_checked_at?: number;
  path: string;
  card_path: string;
  methods: Array<{ name: string; op: string; requests: number }>;
}

const EMPTY = { name: '', slug: '', url: '', auth_type: 'none', token: '', header: 'x-api-key', agent_id: '' };

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
}

export function A2aAgentsPage() {
  const [agents, setAgents] = useState<A2aAgent[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const refreshTopology = useStore((s) => s.refreshTopology);

  const load = async () => {
    const r = await api.get<{ agents: A2aAgent[] }>('/admin/api/a2a/agents');
    setAgents(r.agents);
  };
  useEffect(() => {
    void load();
  }, []);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy('add');
    setError(null);
    try {
      const r = await api.post<{ agent: A2aAgent; check: { ok: boolean; detail: string } }>('/admin/api/a2a/agents', {
        name: form.name,
        slug: form.slug || undefined,
        url: form.url,
        auth: form.auth_type === 'bearer' ? { type: 'bearer', token: form.token } : form.auth_type === 'header' ? { type: 'header', header: form.header, token: form.token } : { type: 'none' },
        ...(form.agent_id.trim() ? { agent_id: form.agent_id.trim() } : {}),
      });
      if (!r.check.ok) setError(`Added, but its Agent Card couldn't be used: ${r.check.detail}`);
      else setShowAdd(false);
      setForm(EMPTY);
      await load();
      await refreshTopology();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };
  const test = async (a: A2aAgent) => {
    setBusy(a.id);
    try {
      await api.post(`/admin/api/a2a/agents/${a.id}/test`);
      await load();
      await refreshTopology();
    } finally {
      setBusy(null);
    }
  };
  const toggle = async (a: A2aAgent) => {
    await api.patch(`/admin/api/a2a/agents/${a.id}`, { enabled: !a.enabled });
    await load();
    await refreshTopology();
  };
  const remove = async (a: A2aAgent) => {
    if (!confirm(`Remove "${a.name}"? Agents calling ${a.path} get 404 immediately.`)) return;
    await api.del(`/admin/api/a2a/agents/${a.id}`);
    await load();
    await refreshTopology();
  };

  const origin = location.origin;
  const example = agents[0]?.slug ?? 'research';

  return (
    <div className="page">
      <PageHeader
        title="A2A agents"
        meta={agents.length ? `${agents.length} registered` : undefined}
        description={
          <>
            Remote agents that speak the Agent2Agent (A2A) protocol. Register one by its Agent Card; Control Tower publishes a card of its own at <code>{origin}/a2a/&lt;slug&gt;/.well-known/agent-card.json</code> that points callers here. Agents reach it with their own key, every message and task call becomes a flight you can gate and hold for approval, and the called agent is sent a delegation token so its own calls count as made on the caller’s behalf.
          </>
        }
        actions={
          <button className="btn primary" onClick={() => setShowAdd(true)}>
            <Icon name="plus" size={15} /> Add agent
          </button>
        }
      />

      {showAdd && (
        <form className="card" style={{ marginBottom: 16, maxWidth: 640 }} onSubmit={add}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="field">
              <label>Name</label>
              <input className="input" autoFocus required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value, slug: form.slug && form.slug !== slugify(form.name) ? form.slug : slugify(e.target.value) })} placeholder="Research agent" />
            </div>
            <div className="field">
              <label>Slug (the /a2a/&lt;slug&gt; path)</label>
              <input className="input mono" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} placeholder="research" />
            </div>
          </div>
          <div className="field">
            <label>Agent Card URL, or the agent’s base URL</label>
            <input className="input mono" required value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://research.internal.example.com" />
            <div className="hint">A base URL is searched for <code>/.well-known/agent-card.json</code>. The agent must offer the JSON-RPC binding.</div>
          </div>
          <div className="field">
            <label>Agent ID (optional)</label>
            <input className="input" value={form.agent_id} onChange={(e) => setForm({ ...form, agent_id: e.target.value })} placeholder="research-agent" />
            <div className="hint">The agent ID on this agent’s own Control Tower key, if it has one. Its model and tool calls then join it on the map, and it is sent a delegation token so they count as made on the caller’s behalf. Leave empty for an agent outside Control Tower.</div>
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
            Calling agents never see these credentials: their Control Tower key is removed and these are added instead.
          </div>
          {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" type="submit" disabled={busy === 'add'}>
              {busy === 'add' ? 'Reading its card…' : 'Add & read card'}
            </button>
            <button className="btn ghost" type="button" onClick={() => setShowAdd(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))' }}>
        {agents.map((a) => (
          <div className={`card provider-card ${a.enabled ? '' : 'is-off'}`} key={a.id}>
            <div className="provider-head">
              <Monogram name={a.name} kind="mcp" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="provider-name">
                  {a.name}
                  {a.protocol_version && <span className="tag muted">A2A {a.protocol_version}</span>}
                  {a.streaming && <span className="tag muted">streaming</span>}
                  {!a.enabled && <span className="tag muted">disabled</span>}
                </div>
                <div className="provider-meta mono">
                  {a.path} · {a.agent_id ? `agent ${a.agent_id}` : 'not linked to a key'} · {a.auth_type === 'none' ? 'no credentials' : a.auth_type === 'bearer' ? 'bearer token' : 'API key header'}
                </div>
              </div>
              <span className={`status ${a.health === 'ok' ? 'ok' : a.health === 'down' ? 'error' : ''}`}>{a.health === 'ok' ? 'reachable' : a.health === 'down' ? 'down' : 'not checked'}</span>
            </div>
            {a.description && <div className="hint" style={{ marginBottom: 8 }}>{a.description}</div>}
            <div className="provider-url mono" title="The agent's JSON-RPC endpoint, from its card">
              {a.endpoint ?? a.card_url}
            </div>
            {a.skills.length > 0 && (
              <div className="tool-list">
                {a.skills.map((s) => (
                  <div key={s.id} className="tool-row" title={s.description}>
                    <span className="mono">{s.name}</span>
                    <span className="op read">skill</span>
                    <span className="tool-desc">{s.description}</span>
                  </div>
                ))}
              </div>
            )}
            {a.methods.length > 0 ? (
              <div className="tool-list">
                {a.methods.map((m) => (
                  <div key={m.name} className="tool-row" title={`${num(m.requests)} calls in the last 7 days`}>
                    <span className="mono">{m.name}</span>
                    <span className={`op ${m.op}`}>{m.op}</span>
                    <span className="tool-desc">{num(m.requests)} call{m.requests === 1 ? '' : 's'} · 7 d</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="hint">No calls yet. Methods appear here (and on the map) as agents use them.</div>
            )}
            <div className="provider-foot">
              <span className="dim">{a.health_detail ?? 'not checked yet'}</span>
              <span className="spacer" />
              <button className="btn sm" onClick={() => void test(a)} disabled={busy === a.id}>
                <Icon name="refresh" size={13} /> {busy === a.id ? 'Reading…' : 'Re-read card'}
              </button>
              <button className="btn sm ghost" onClick={() => void toggle(a)}>
                {a.enabled ? 'Disable' : 'Enable'}
              </button>
              <button className="btn sm ghost danger-text" onClick={() => void remove(a)}>
                Remove
              </button>
            </div>
          </div>
        ))}
        {agents.length === 0 && (
          <div className="card empty-card">
            <Icon name="agents" size={20} />
            <b>No A2A agents yet</b>
            <span>Register a remote agent by its Agent Card. It appears on the Airspace as a destination, with a row for each A2A method agents call.</span>
          </div>
        )}
      </div>

      <div className="section-title">
        <h2>Connect an agent</h2>
      </div>
      <div className="grid cols-3">
        <CodeBlock
          title="Agent Card"
          code={`# Give the calling agent this card URL and its own key:
${origin}/a2a/${example}/.well-known/agent-card.json

Authorization: Bearer ct_sk_...`}
        />
        <CodeBlock
          title="curl (JSON-RPC)"
          code={`curl ${origin}/a2a/${example} \\
  -H "Authorization: Bearer ct_sk_..." \\
  -H "Content-Type: application/json" \\
  -H "A2A-Version: 1.0" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"SendMessage",
       "params":{"message":{"messageId":"m1",
       "role":"ROLE_USER","parts":[{"text":"hello"}]}}}'`}
        />
        <CodeBlock
          title="What a gated call returns"
          code={`{ "jsonrpc": "2.0", "id": 1,
  "error": { "code": 403,
    "message": "…needs approval…",
    "data": [{ "reason": "APPROVAL_REQUIRED",
      "metadata": { "ticket": "ct_tkt_…" } }] } }

Retry with params.metadata.ct_approval
(or the x-ct-approval header) once approved.`}
        />
      </div>
    </div>
  );
}
