import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type FlightRow } from '../api';
import { useStore } from '../store';
import { PageHeader } from '../components/PageHeader';
import { Icon } from '../components/Icon';
import { ago, ms, num, usd } from '../format';
import { agentColor, hex } from '../airspace/colors';

const OUTCOME: Record<string, { label: string; cls: string }> = {
  ok: { label: 'ok', cls: 'ok' },
  error: { label: 'error', cls: 'error' },
  denied: { label: 'blocked', cls: 'denied' },
  rejected: { label: 'rejected', cls: 'rejected' },
  ticketed: { label: 'awaiting approval', cls: 'ticketed' },
  client_aborted: { label: 'client left', cls: 'client_aborted' },
  shutdown: { label: 'shutdown', cls: 'error' },
};

const FILTERS: Array<{ id: string; label: string }> = [
  { id: '', label: 'All' },
  { id: 'error', label: 'Errors' },
  { id: 'denied', label: 'Blocked' },
  { id: 'ticketed', label: 'Awaiting approval' },
  { id: 'rejected', label: 'Rejected' },
];

/** `crm__delete_contact` → crm › delete_contact */
function Target({ name }: { name: string }) {
  const i = name.indexOf('__');
  if (i < 0) return <span className="mono">{name}</span>;
  return (
    <span className="mono">
      <span className="muted">{name.slice(0, i)} › </span>
      {name.slice(i + 2)}
    </span>
  );
}

export function FlightsPage() {
  const [rows, setRows] = useState<FlightRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [live, setLive] = useState(true);
  // Agents calling agents: calls made for one agent, or every call in one call's tree.
  // Opened from the map with #/flights/trace:<flight> or #/flights/for:<agent>.
  const routeParam = useStore((s) => s.routeParam);
  const [forAgent, setForAgent] = useState(() => (routeParam?.startsWith('for:') ? routeParam.slice(4) : ''));
  const [trace, setTrace] = useState(() => (routeParam?.startsWith('trace:') ? routeParam.slice(6) : ''));
  useEffect(() => {
    if (routeParam?.startsWith('for:')) {
      setTrace('');
      setForAgent(routeParam.slice(4));
    } else if (routeParam?.startsWith('trace:')) {
      setForAgent('');
      setTrace(routeParam.slice(6));
    } else if (!routeParam) {
      // Flights from the sidebar: every flight again.
      setForAgent('');
      setTrace('');
    }
  }, [routeParam]);
  const counters = useStore((s) => s.counters);
  // Only the latest request may fill the table: an older one (say, a live refresh from before a
  // filter changed) must not overwrite a newer answer.
  const seq = useRef(0);

  const load = async () => {
    const mine = ++seq.current;
    setBusy(true);
    try {
      const p = new URLSearchParams({ limit: '200' });
      if (status) p.set('status', status);
      if (forAgent) p.set('for', forAgent);
      if (trace) p.set('trace', trace);
      const r = await api.get<{ flights: FlightRow[] }>(`/admin/api/flights?${p.toString()}`);
      if (mine === seq.current) setRows(r.flights);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, forAgent, trace]);

  // Follow the traffic while live; debounce so a busy gateway does not thrash the table.
  useEffect(() => {
    if (!live) return;
    const t = setTimeout(() => void load(), 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [counters.flights, live, status, forAgent, trace]);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    const hit = s ? rows.filter((f) => `${f.key_name} ${f.team ?? ''} ${f.model_requested} ${f.error_code ?? ''} ${f.id} ${behalf(f.on_behalf_of)}`.toLowerCase().includes(s)) : rows;
    return trace ? treeOrder(hit) : hit.map((f) => ({ f, depth: 0 }));
  }, [rows, q, trace]);

  return (
    <div className="page">
      <PageHeader
        title="Flights"
        meta={`latest ${num(rows.length)}`}
        description="Every request through the gateway — LLM calls, MCP tool calls, HTTP API calls and calls to A2A agents — with its outcome, tokens, cost and latency."
        actions={
          <>
            <button className={`btn sm ${live ? 'active' : ''}`} onClick={() => setLive((v) => !v)} title={live ? 'Pause auto-refresh' : 'Follow new flights'}>
              <i className={`live-led ${live ? 'on' : ''}`} /> {live ? 'Live' : 'Paused'}
            </button>
            <button className="btn sm" onClick={() => void load()} disabled={busy} title="Refresh">
              <Icon name="refresh" size={14} /> Refresh
            </button>
          </>
        }
      />
      <div className="toolbar">
        <div className="seg">
          {FILTERS.map((f) => (
            <button key={f.id} className={status === f.id ? 'on' : ''} onClick={() => setStatus(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
        <label className="search">
          <Icon name="search" size={15} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by agent, model, tool, error or flight id" aria-label="Filter flights" />
        </label>
      </div>
      {(forAgent || trace) && (
        <div className="filter-banner">
          {trace ? (
            <>
              Showing one chain of agents calling agents: the call that started it, and every call it led to, in order.
            </>
          ) : (
            <>
              Showing calls made on behalf of <b>{forAgent}</b>, anywhere up the chain.
            </>
          )}
          <button
            className="btn sm ghost"
            onClick={() => {
              setForAgent('');
              setTrace('');
            }}
          >
            Show all flights
          </button>
        </div>
      )}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table className="table">
          <thead>
            <tr>
              <th>When</th>
              <th>Agent</th>
              <th>Target</th>
              <th>Outcome</th>
              <th className="num">Tokens in → out</th>
              <th className="num">Cost</th>
              <th className="num">Latency</th>
              <th className="num">Flight</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(({ f, depth }) => {
              const o = f.status ? (OUTCOME[f.status] ?? { label: f.status, cls: '' }) : { label: 'in flight', cls: 'pending' };
              return (
                <tr key={f.id}>
                  <td title={new Date(f.ts).toLocaleString()}>
                    <span className="mono">{new Date(f.ts).toLocaleTimeString([], { hour12: false })}</span>
                    <span className="sub">{ago(f.ts)}</span>
                  </td>
                  <td>
                    <div className="agent-cell" style={depth ? { paddingLeft: depth * 18 } : undefined}>
                      {depth > 0 && <span className="tree-elbow" aria-hidden="true">↳</span>}
                      <i className="agent-dot" style={{ background: hex(agentColor(f.agent_id ?? f.key_id)) }} />
                      <div>
                        <span className="strong">{f.key_name}</span>
                        {f.team && <span className="sub">{f.team}</span>}
                        {chainOf(f.on_behalf_of).length > 0 && (
                          <span className="sub behalf" title="Made on behalf of these agents (first one first), from a verified delegation token. Click one to see everything done for it.">
                            for{' '}
                            {chainOf(f.on_behalf_of).map((a, i) => (
                              <span key={i}>
                                {i > 0 && ' → '}
                                <button type="button" className="link-btn" onClick={() => setForAgent(a)}>
                                  {a}
                                </button>
                              </span>
                            ))}
                          </span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td>
                    <Target name={f.model_requested} />
                  </td>
                  <td>
                    <span className={`status ${o.cls}`}>{o.label}</span>
                    {f.error_code && <span className="sub">{f.error_code.replace(/_/g, ' ')}</span>}
                  </td>
                  <td className="num mono">
                    {f.in_tokens == null && f.out_tokens == null ? (
                      <span className="muted">—</span>
                    ) : (
                      <>
                        {num(f.in_tokens)} → {num(f.out_tokens)}
                        {f.usage_source && f.usage_source !== 'provider' && (
                          <span className="muted" title="Estimated: the provider did not report usage">
                            {' '}
                            ~
                          </span>
                        )}
                      </>
                    )}
                  </td>
                  <td className={`num mono ${f.cost_nanousd ? '' : 'muted'}`}>{usd(f.cost_nanousd)}</td>
                  <td className="num mono">
                    {f.duration_ms == null ? <span className="muted">—</span> : ms(f.duration_ms)}
                    {f.ttft_ms != null && <span className="sub">first token {ms(f.ttft_ms)}</span>}
                  </td>
                  <td className="num mono muted" title={f.id}>
                    {f.id.slice(-8)}
                    {(f.parent_flight_id || f.has_children) && !trace ? (
                      <button type="button" className="link-btn sub" onClick={() => setTrace(f.id)} title="Every call in this chain of agents calling agents">
                        trace
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
            {shown.length === 0 && (
              <tr>
                <td colSpan={8} className="table-empty">
                  <b>{rows.length ? 'Nothing matches this filter' : 'No flights yet'}</b>
                  {rows.length ? (
                    'Clear the filter to see every request.'
                  ) : (
                    <>
                      Send a request to <code>/v1/chat/completions</code> with an API key, or start with <code>CT_DEMO=1</code>.
                    </>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** A flight's on_behalf_of chain, origin first. */
function chainOf(v: string | null | undefined): string[] {
  if (!v) return [];
  try {
    const chain = JSON.parse(v) as unknown;
    return Array.isArray(chain) ? chain.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** "support-bot → triage", for search. */
const behalf = (v: string | null | undefined): string => chainOf(v).join(' → ');

/** A trace's calls in call order: each call, then the calls it led to, indented. */
function treeOrder(rows: FlightRow[]): Array<{ f: FlightRow; depth: number }> {
  const ids = new Set(rows.map((r) => r.id));
  const kids = new Map<string, FlightRow[]>();
  const roots: FlightRow[] = [];
  for (const r of [...rows].sort((a, b) => a.ts - b.ts)) {
    if (r.parent_flight_id && ids.has(r.parent_flight_id)) (kids.get(r.parent_flight_id) ?? kids.set(r.parent_flight_id, []).get(r.parent_flight_id)!).push(r);
    else roots.push(r);
  }
  const out: Array<{ f: FlightRow; depth: number }> = [];
  const walk = (r: FlightRow, depth: number) => {
    out.push({ f: r, depth });
    for (const k of kids.get(r.id) ?? []) walk(k, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return out;
}
