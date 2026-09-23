import { useEffect, useMemo, useState } from 'react';
import { formatUsd } from '@controltower/shared';
import { api } from '../api';
import { PageHeader } from '../components/PageHeader';
import { Icon } from '../components/Icon';

interface PathRow {
  agent: string;
  agent_id: string;
  team: string | null;
  kind: 'model' | 'tool';
  target: string;
  target_id: string;
  provider: string;
  tool: string | null;
  operation: string | null;
  requests: number;
  errors: number;
  blocked: number;
  held: number;
  spend_nanousd: number;
  tokens: number;
  last_seen: number;
  access: 'allow' | 'deny' | 'hold';
  access_gate: string | null;
  inspected_by: string[];
  key_permits: boolean;
}

interface Inventory {
  generated_at: number;
  window_hours: number;
  enforcement: boolean;
  totals: { agents: number; models: number; mcp_servers: number; paths: number; requests: number; spend_nanousd: number; gates: number };
  agents: Array<{ id: string; name: string; team: string | null; project: string | null; zones: string[]; models_allowed: string[]; tools_allowed: string[]; requests: number; spend_nanousd: number }>;
  models: Array<{ id: string; name: string; upstream: string; provider: string; provider_kind: string; zones: string[]; requests: number }>;
  mcp_servers: Array<{ id: string; name: string; url: string; health: string; zones: string[]; tools: Array<{ name: string; operation: string }> }>;
  paths: PathRow[];
  gates: Array<{ id: string; name: string; effect: string; covers: string; enabled: boolean; hits: number }>;
  zones: Array<{ id: string; name: string; members: number }>;
  observed: Array<{ agent: string; team: string | null; target: string; system: string | null; kind: string; bypass: boolean; calls: number; errors: number; writes: number; last_seen: number }>;
}

const ACCESS = { allow: 'allowed', deny: 'blocked', hold: 'needs approval' } as const;
const n = (x: number) => x.toLocaleString('en-US');
/** Spend, without five-decimal noise for fractions of a cent. */
const usd = (nano: number) => (!nano ? '—' : nano < 1_000_000 ? '<$0.001' : formatUsd(nano, { compact: true }));

/** The data-flow inventory: printable, downloadable documentation of the agent estate. */
export function ReportPage() {
  const [hours, setHours] = useState(24);
  const [inv, setInv] = useState<Inventory | null>(null);
  const [q, setQ] = useState('');
  useEffect(() => {
    setInv(null);
    void api.get<Inventory>(`/admin/api/export/dataflow?hours=${hours}`).then(setInv);
  }, [hours]);
  const paths = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (inv?.paths ?? []).filter((p) => !s || `${p.agent} ${p.team ?? ''} ${p.target} ${p.tool ?? ''} ${p.provider} ${p.access_gate ?? ''}`.toLowerCase().includes(s));
  }, [inv, q]);

  return (
    <div className="page report">
      <PageHeader
        title="Data-flow inventory"
        description="Every agent, model and tool server, and every path between them — with what Control Tower does on each path today. For architecture docs and security reviews."
        actions={
        <div className="row no-print">
          <select className="input" value={hours} onChange={(e) => setHours(Number(e.target.value))} aria-label="Window">
            <option value={24}>Last 24 hours</option>
            <option value={168}>Last 7 days</option>
            <option value={720}>Last 30 days</option>
          </select>
          <a className="btn" href={`/admin/api/export/dataflow?hours=${hours}&format=md`} download>
            <Icon name="download" size={15} /> Markdown
          </a>
          <a className="btn" href={`/admin/api/export/dataflow?hours=${hours}&format=csv`} download>
            <Icon name="download" size={15} /> CSV
          </a>
          <button className="btn primary" onClick={() => window.print()}>
            <Icon name="download" size={15} /> Print / PDF
          </button>
        </div>
        }
      />
      {!inv && <div className="card hint">Building the inventory…</div>}
      {inv && (
        <>
          <div className="dim print-only">
            Generated {new Date(inv.generated_at).toLocaleString()} · last {inv.window_hours} h · enforcement {inv.enforcement ? 'on' : 'off'}
          </div>
          <div className="grid cols-4" style={{ marginBottom: 18 }}>
            <div className="card stat">
              <div className="label">Agents</div>
              <div className="value">{n(inv.totals.agents)}</div>
            </div>
            <div className="card stat">
              <div className="label">Models · tool servers</div>
              <div className="value">
                {n(inv.totals.models)} · {n(inv.totals.mcp_servers)}
              </div>
            </div>
            <div className="card stat">
              <div className="label">Active paths</div>
              <div className="value">{n(inv.totals.paths)}</div>
            </div>
            <div className="card stat">
              <div className="label">Requests · spend</div>
              <div className="value">
                {n(inv.totals.requests)} · {formatUsd(inv.totals.spend_nanousd, { compact: true })}
              </div>
            </div>
          </div>

          <div className="section-h">
            <h2>Paths</h2>
            <input className="input no-print" style={{ maxWidth: 260 }} placeholder="Filter by agent, target, gate…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="card" style={{ padding: 0, marginBottom: 20 }}>
            <table className="table report-table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Target</th>
                  <th className="num">Requests</th>
                  <th className="num">Errors</th>
                  <th className="num">Blocked</th>
                  <th className="num">Held</th>
                  <th className="num">Spend</th>
                  <th>Access today</th>
                  <th>Inspected by</th>
                </tr>
              </thead>
              <tbody>
                {paths.map((p) => (
                  <tr key={`${p.agent_id}|${p.target_id}|${p.tool ?? ''}`}>
                    <td>
                      <b>{p.agent}</b>
                      {p.team && <div className="dim">{p.team}</div>}
                    </td>
                    <td>
                      {p.kind === 'tool' ? (
                        <>
                          {p.target} → <span className="mono">{p.tool}</span> <span className={`op ${p.operation}`}>{p.operation}</span>
                        </>
                      ) : (
                        p.target
                      )}
                      <div className="dim">{p.provider}</div>
                    </td>
                    <td className="num">{n(p.requests)}</td>
                    <td className="num">{p.errors ? n(p.errors) : '—'}</td>
                    <td className="num">{p.blocked ? n(p.blocked) : '—'}</td>
                    <td className="num">{p.held ? n(p.held) : '—'}</td>
                    <td className="num">{usd(p.spend_nanousd)}</td>
                    <td>
                      <span className={`status ${p.access === 'allow' ? 'ok' : p.access === 'deny' ? 'denied' : 'ticketed'}`}>{ACCESS[p.access]}</span>
                      {p.access_gate && <div className="dim">{p.access_gate}</div>}
                      {!p.key_permits && <div className="error" style={{ fontSize: 12 }}>key does not allow this</div>}
                    </td>
                    <td className="dim">{p.inspected_by.join(', ') || '—'}</td>
                  </tr>
                ))}
                {paths.length === 0 && (
                  <tr>
                    <td colSpan={9} className="dim" style={{ textAlign: 'center', padding: 24 }}>
                      No traffic in this window.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {inv.observed.length > 0 && (
            <>
              <h2>Seen, not enforced</h2>
              <p className="hint" style={{ marginTop: -4 }}>
                Calls agents reported through the SDK endpoint or OpenTelemetry that do not pass through Control Tower. No gate, budget or inspection applies to them.
              </p>
              <div className="card" style={{ padding: 0, marginBottom: 20 }}>
                <table className="table report-table">
                  <thead>
                    <tr>
                      <th>Agent</th>
                      <th>System</th>
                      <th>Kind</th>
                      <th className="num">Calls</th>
                      <th className="num">Writes</th>
                      <th className="num">Errors</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {inv.observed.map((o) => (
                      <tr key={`${o.agent}|${o.target}`}>
                        <td>
                          <b>{o.agent}</b>
                          {o.team && <div className="dim">{o.team}</div>}
                        </td>
                        <td>
                          {o.system ?? o.target}
                          {o.system && <div className="dim mono">{o.target}</div>}
                        </td>
                        <td className="dim">{o.kind}</td>
                        <td className="num">{n(o.calls)}</td>
                        <td className="num">{o.writes ? n(o.writes) : '—'}</td>
                        <td className="num">{o.errors ? n(o.errors) : '—'}</td>
                        <td>{o.bypass ? <span className="obs-tag bypass">bypasses gateway</span> : <span className="obs-tag">not enforced</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <div className="report-cols">
            <section>
              <h2>Agents</h2>
              <div className="card" style={{ padding: 0 }}>
                <table className="table report-table">
                  <thead>
                    <tr>
                      <th>Agent</th>
                      <th>Zones</th>
                      <th className="num">Requests</th>
                      <th className="num">Spend</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inv.agents.map((a) => (
                      <tr key={a.id}>
                        <td>
                          <b>{a.name}</b>
                          <div className="dim">{[a.team, a.project].filter(Boolean).join(' · ') || '—'}</div>
                        </td>
                        <td className="dim">{a.zones.join(', ') || '—'}</td>
                        <td className="num">{n(a.requests)}</td>
                        <td className="num">{usd(a.spend_nanousd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <section>
              <h2>Gates</h2>
              <div className="card" style={{ padding: 0 }}>
                <table className="table report-table">
                  <thead>
                    <tr>
                      <th>Gate</th>
                      <th>Covers</th>
                      <th className="num">Decisions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inv.gates.map((g) => (
                      <tr key={g.id} className={g.enabled ? '' : 'off'}>
                        <td>
                          <b>{g.name}</b>
                          <div className="dim">
                            {g.effect.replace('_', ' ')}
                            {g.enabled ? '' : ' · disabled'}
                          </div>
                        </td>
                        <td className="dim">{g.covers}</td>
                        <td className="num">{n(g.hits)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>

          <h2 style={{ marginTop: 20 }}>Models and tool servers</h2>
          <div className="card" style={{ padding: 0 }}>
            <table className="table report-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Provider / URL</th>
                  <th>Zones</th>
                  <th>Tools</th>
                </tr>
              </thead>
              <tbody>
                {inv.models.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <b>{m.name}</b>
                      <div className="dim mono">{m.upstream}</div>
                    </td>
                    <td className="dim">
                      {m.provider} ({m.provider_kind})
                    </td>
                    <td className="dim">{m.zones.join(', ') || '—'}</td>
                    <td className="dim">—</td>
                  </tr>
                ))}
                {inv.mcp_servers.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <b>{s.name}</b>
                      <div className="dim">MCP · {s.health}</div>
                    </td>
                    <td className="dim mono">{s.url}</td>
                    <td className="dim">{s.zones.join(', ') || '—'}</td>
                    <td className="dim">{s.tools.map((t) => `${t.name} (${t.operation})`).join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint" style={{ marginTop: 14 }}>
            Only traffic that passes through Control Tower is listed and enforced. “Access today” ignores gates that depend on tool arguments; those are decided per call.
          </p>
        </>
      )}
    </div>
  );
}
