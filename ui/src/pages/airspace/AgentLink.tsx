import { useEffect, useState } from 'react';
import { api } from '../../api';
import { useStore } from '../../store';
import { ago, ms, usd } from '../../format';
import { panelPos } from './shared';

interface LinkCall {
  id: string;
  ts: number;
  key_name: string;
  kind: string;
  model_requested: string;
  status: string | null;
  duration_ms: number | null;
  error_code: string | null;
  led_to: number;
  led_to_cost_nanousd: number;
}

interface LinkData {
  calls: LinkCall[];
  on_behalf: { count: number; cost_nanousd: number; last_ts: number | null };
  /** The caller's agent IDs (one, unless the station is a team). */
  from_agents: string[];
}

export interface AgentLinkEnd {
  id: string;
  label: string;
  keyIds: string[];
}

const HOP: Record<string, string> = { 'mcp.tool': 'MCP', 'http.request': 'HTTP', 'a2a.call': 'A2A' };

/**
 * The calls behind an arc between two agents: each call the first made to the second, what it led
 * to, and what the second did on the first's behalf — with a trace into Flights for any of them.
 */
export function AgentLinkPanel({ from, to, x, y, onClose }: { from: AgentLinkEnd; to: AgentLinkEnd; x: number; y: number; onClose: () => void }) {
  const [data, setData] = useState<LinkData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const setRoute = useStore((s) => s.setRoute);

  useEffect(() => {
    let stop = false;
    const qs = new URLSearchParams({ from: from.keyIds.join(','), to: to.keyIds.join(',') });
    api
      .get<LinkData>(`/admin/api/airspace/agent-link?${qs.toString()}`)
      .then((d) => !stop && setData(d))
      .catch((e: unknown) => !stop && setError(String((e as Error).message ?? e)));
    return () => {
      stop = true;
    };
  }, [from.keyIds, to.keyIds]);

  return (
    <div className="popover agent-link-panel" style={{ ...panelPos(x + 12, y, 420), width: 440 }} role="dialog" aria-label={`${from.label} calling ${to.label}`}>
      <div className="agent-link-head">
        <div>
          <div className="hint" style={{ textTransform: 'uppercase', letterSpacing: 0.4, fontSize: 11, fontWeight: 600 }}>
            Agent calling agent · last 7 days
          </div>
          <div style={{ fontWeight: 600, fontSize: 15 }}>
            {from.label} <span className="muted">→</span> {to.label}
          </div>
        </div>
        <button className="btn sm ghost" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {!data && !error && <div className="hint">Loading…</div>}
      {data && (
        <>
          {data.calls.length > 0 ? (
            <div className="agent-link-calls">
              {data.calls.map((c) => (
                <div className="agent-link-call" key={c.id}>
                  <span className="mono muted" title={new Date(c.ts).toLocaleString()}>
                    {ago(c.ts)}
                  </span>
                  <span className="agent-link-target">
                    <span className="tag muted">{HOP[c.kind] ?? c.kind}</span> <span className="mono">{c.model_requested.replace(/^[^_]+__/, '')}</span>
                    <span className="sub">
                      {c.status === 'ok' ? 'ok' : (c.error_code ?? c.status ?? 'in flight').replace(/_/g, ' ')}
                      {c.duration_ms != null ? ` · ${ms(c.duration_ms)}` : ''}
                      {c.led_to ? ` · led to ${c.led_to} call${c.led_to === 1 ? '' : 's'}${c.led_to_cost_nanousd ? ` (${usd(c.led_to_cost_nanousd)})` : ''}` : ''}
                    </span>
                  </span>
                  <button className="link-btn" onClick={() => setRoute('flights', `trace:${c.id}`)} title="Every call in this chain, in Flights">
                    trace
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="hint">No calls from {from.label} to a server that fronts {to.label} in the last 7 days.</div>
          )}
          {data.on_behalf.count > 0 && (
            <div className="agent-link-behalf">
              <span>
                {to.label} made <b>{data.on_behalf.count.toLocaleString()}</b> call{data.on_behalf.count === 1 ? '' : 's'} for {from.label}
                {data.on_behalf.cost_nanousd ? <> costing <b>{usd(data.on_behalf.cost_nanousd)}</b></> : null}
                {data.on_behalf.last_ts ? `, last ${ago(data.on_behalf.last_ts)}` : ''}.
              </span>
              {data.from_agents.length === 1 && (
                <button className="link-btn" onClick={() => setRoute('flights', `for:${data.from_agents[0]}`)}>
                  see them
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
