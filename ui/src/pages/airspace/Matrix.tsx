import { useMemo, useState } from 'react';
import { formatUsd } from '@controltower/shared';
import type { MatrixCell, MatrixData, MatrixHead } from '../../airspace/scene';
import { hex } from '../../airspace/colors';
import { Icon } from '../../components/Icon';

type Metric = 'requests' | 'cost' | 'denied';
const METRICS: Array<{ id: Metric; label: string; hint: string }> = [
  { id: 'requests', label: 'Calls', hint: 'Calls in the last 24 hours' },
  { id: 'cost', label: 'Spend', hint: 'Spend in the last 24 hours' },
  { id: 'denied', label: 'Blocked', hint: 'Calls blocked in the last 24 hours' },
];

const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const KIND: Record<string, string> = { model: 'Model', mcp: 'Tool server', observed: 'Outside' };

/**
 * The Airspace as a grid: every agent (or team) against every destination.
 * Where the map shows shape, the matrix shows every connection at once — at
 * a thousand agents it is still one row each — and which of them no gate
 * covers. Click a cell to gate that path; click a row to see it on the map.
 */
export function MatrixView({
  data,
  onGate,
  onRow,
  onOpenTeam,
  right,
}: {
  right: number;
  data: MatrixData;
  onGate: (row: MatrixHead, col: MatrixHead, x: number, y: number) => void;
  onRow: (row: MatrixHead) => void;
  onOpenTeam: (team: string) => void;
}) {
  const [metric, setMetric] = useState<Metric>('requests');
  const [filter, setFilter] = useState('');
  const [onlyUngated, setOnlyUngated] = useState(false);
  const value = (c: MatrixCell | undefined) => (c ? (metric === 'requests' ? c.requests : metric === 'cost' ? c.cost : c.denied) : 0);
  const max = useMemo(() => {
    let m = 0;
    for (const c of data.cells.values()) m = Math.max(m, value(c));
    return m || 1;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, metric]);
  const q = filter.trim().toLowerCase();
  // A gate that can deny, hold or limit is a control; one that only inspects content is not the same thing.
  const controlled = (c: MatrixCell) => c.gates.some((g) => g.effect !== 'inspect');
  const ungated = (c: MatrixCell | undefined) => !!c && !c.outside && c.requests > 0 && !controlled(c);
  const rows = data.rows.filter((r) => (!q || r.label.toLowerCase().includes(q) || r.sub.toLowerCase().includes(q)) && (!onlyUngated || data.cols.some((c) => ungated(data.cells.get(`${r.id}>${c.id}`)))));
  let paths = 0;
  let open = 0;
  for (const c of data.cells.values()) {
    if (c.outside || !c.requests) continue;
    paths++;
    if (!controlled(c)) open++;
  }
  const fmt = (n: number) => (metric === 'cost' ? formatUsd(n) : compact(n));

  return (
    <div className="matrix-wrap" role="region" aria-label="Connection matrix" style={{ right }}>
      <div className="matrix-bar">
        <div className="seg sm layer-seg" role="radiogroup" aria-label="Measure">
          {METRICS.map((m) => (
            <button key={m.id} role="radio" aria-checked={metric === m.id} className={metric === m.id ? 'on' : ''} title={m.hint} onClick={() => setMetric(m.id)}>
              {m.label}
            </button>
          ))}
        </div>
        <input className="input sm" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter agents" aria-label="Filter agents" style={{ width: 170 }} />
        <label className="matrix-check" title="Only agents with a connection in use that no gate can deny, hold or limit">
          <input type="checkbox" checked={onlyUngated} onChange={(e) => setOnlyUngated(e.target.checked)} /> Ungated only
        </label>
        <span className="hint matrix-summary">
          {rows.length.toLocaleString()} {rows.length === 1 ? 'row' : 'rows'} · {data.cols.length} destinations · {paths.toLocaleString()} connections in 24 h, <b className={open ? 'open' : ''}>{open.toLocaleString()} no gate can stop</b>
        </span>
        <span className="matrix-key hint">
          <i className="k-live" /> live now <i className="k-gate" /> gated <i className="k-insp" /> inspected only <i className="k-open" /> no gate
        </span>
      </div>
      <div className="matrix-scroll">
        <table className="matrix">
          <thead>
            <tr>
              <th className="corner">
                <span>Agents</span> <span className="hint">→ destinations</span>
              </th>
              {data.cols.map((c) => (
                <th key={c.id} className={`col ${c.outside ? 'outside' : ''}`} title={`${c.label} · ${KIND[c.kind] ?? c.kind}${c.outside ? ' — outside the gateway, not enforced' : ''} · ${c.total.toLocaleString()} calls in 24 h`}>
                  <div className="col-name">
                    <i style={{ background: hex(c.color) }} />
                    <span>{c.label}</span>
                  </div>
                  <div className="col-sub">{c.outside ? (c.bypass ? 'direct call' : 'outside') : KIND[c.kind]}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <th className="row">
                  <div className="row-head">
                  <button className="row-name" onClick={() => onRow(r)} title={`Show ${r.label} on the map`}>
                    <i style={{ background: hex(r.color) }} />
                    <span className="n">{r.label}</span>
                    {r.rpm > 0 && <span className="rpm">{r.rpm.toLocaleString()}/min</span>}
                  </button>
                  {r.team && (
                    <button className="row-open" onClick={() => onOpenTeam(r.team!)} title={`Open team ${r.team} into its agents`} aria-label={`Open team ${r.team}`}>
                      <Icon name="plus" size={12} />
                    </button>
                  )}
                  </div>
                </th>
                {data.cols.map((c) => {
                  const cell = data.cells.get(`${r.id}>${c.id}`);
                  const v = value(cell);
                  const shade = v ? 0.08 + 0.72 * Math.sqrt(v / max) : 0;
                  const tone = metric === 'denied' ? '211,55,78' : c.outside ? '100,116,139' : '31,94,255';
                  const title = cell
                    ? [
                        `${r.label} → ${c.label}`,
                        `${cell.requests.toLocaleString()} calls in 24 h${cell.cost ? ` · ${formatUsd(cell.cost)}` : ''}${cell.denied ? ` · ${cell.denied} blocked` : ''}${cell.errors ? ` · ${cell.errors} failed` : ''}`,
                        cell.tools.length ? `Tools: ${cell.tools.slice(0, 6).map((t) => `${t.name} (${t.requests})`).join(', ')}` : '',
                        cell.outside
                          ? 'Outside the gateway: seen, not enforced'
                          : cell.gates.length
                            ? `Gates: ${cell.gates.map((g) => g.name).join('; ')}${controlled(cell) ? '' : ' — inspection only: nothing can deny, hold or limit this connection'}`
                            : 'No gate covers this connection — click to add one',
                      ]
                        .filter(Boolean)
                        .join('\n')
                    : `${r.label} → ${c.label}: no calls in 24 h${c.outside ? '' : ' — click to gate it before it happens'}`;
                  return (
                    <td
                      key={c.id}
                      className={`cell ${cell ? 'used' : ''} ${cell?.outside ? 'outside' : ''}`}
                      style={shade ? { background: `rgba(${tone},${shade.toFixed(3)})`, color: shade > 0.5 ? '#fff' : undefined } : undefined}
                      title={title}
                      onClick={(e) => {
                        if (c.outside) onRow(r);
                        else onGate(r, c, e.clientX, e.clientY);
                      }}
                    >
                      {v > 0 && <span className="v">{fmt(v)}</span>}
                      {cell?.live && <i className="m-live" aria-label="live" />}
                      {cell && !cell.outside && cell.requests > 0 && (controlled(cell) ? <i className="m-gate" aria-label="gated" /> : cell.gates.length ? <i className="m-insp" aria-label="inspected only" /> : <i className="m-open" aria-label="no gate" />)}
                    </td>
                  );
                })}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td className="hint" colSpan={data.cols.length + 1} style={{ padding: 16 }}>
                  {onlyUngated ? 'Every connection in use is covered by a gate.' : 'No agents match.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
