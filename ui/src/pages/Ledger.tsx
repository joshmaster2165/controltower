import { useEffect, useMemo, useState } from 'react';
import { formatUsd } from '@controltower/shared';
import { usd } from '../format';
import { api } from '../api';
import { useStore } from '../store';
import { PageHeader } from '../components/PageHeader';

/**
 * Ledger: what the gateway cost and how much it moved. Forms follow the job —
 * stat tiles for headline numbers, single-series time charts (one axis each),
 * sequential single-hue bars for magnitude by agent/model, meters for budgets.
 * Every chart has a table next to it; text wears text tokens, marks wear the hue.
 */
type Window = '1h' | '24h' | '7d' | '30d';

interface Summary {
  window: Window;
  by_key: Array<{ key_id: string; requests: number; errors: number; denied: number; cost_nanousd: number; in_tokens: number; out_tokens: number }>;
  by_deployment: Array<{ deployment_id: string; requests: number; cost_nanousd: number; in_tokens: number; out_tokens: number; avg_ms: number | null }>;
  series: Array<{ bucket: string; requests: number; cost_nanousd: number; errors: number }>;
  budgets: Array<{ scope: string; limit_nanousd: number; spent_nanousd: number; reserved_nanousd: number; hard: boolean; period: string }>;
}

const HUE = '#1f5eff';
const HUE_SOFT = '#dbe6ff';
const INK_MUTED = '#8a98ad';
const GRID = '#e3e8f0';

function compact(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString();
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const m = v / p;
  const step = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
  return step * p;
}

function Sparkline({ values }: { values: number[] }) {
  const w = 96;
  const h = 28;
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => [values.length === 1 ? w : (i / (values.length - 1)) * w, h - (v / max) * (h - 4) - 2] as const);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  return (
    <svg width={w} height={h} aria-hidden="true">
      <path d={d} fill="none" stroke="#b9c7dd" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {last && <circle cx={last[0]} cy={last[1]} r={3} fill={HUE} stroke="#fff" strokeWidth={2} />}
    </svg>
  );
}

function StatTile({ label, value, trend, hint }: { label: string; value: string; trend?: number[] | undefined; hint?: string | undefined }) {
  return (
    <div className="card stat" style={{ display: 'flex', alignItems: 'flex-end', gap: 12 }}>
      <div style={{ flex: 1 }}>
        <div className="label">{label}</div>
        <div className="value">{value}</div>
        {hint && <div className="hint">{hint}</div>}
      </div>
      {trend && trend.length > 1 && <Sparkline values={trend} />}
    </div>
  );
}

/** Single series over time: 2px line + 10% wash, hairline grid, crosshair tooltip. */
function TimeSeries({ title, points, format, area }: { title: string; points: Array<{ label: string; value: number }>; format: (v: number) => string; area?: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const w = 560;
  const h = 180;
  const pad = { l: 44, r: 12, t: 12, b: 24 };
  const iw = w - pad.l - pad.r;
  const ih = h - pad.t - pad.b;
  const max = niceMax(Math.max(0, ...points.map((p) => p.value)));
  const x = (i: number) => pad.l + (points.length < 2 ? iw : (i / (points.length - 1)) * iw);
  const y = (v: number) => pad.t + ih - (v / max) * ih;
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const areaPath = points.length ? `${line} L${x(points.length - 1).toFixed(1)},${(pad.t + ih).toFixed(1)} L${x(0).toFixed(1)},${(pad.t + ih).toFixed(1)} Z` : '';
  const ticks = [0, 0.5, 1].map((f) => f * max);
  const hp = hover != null ? points[hover] : undefined;
  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div style={{ fontWeight: 600 }}>{title}</div>
        <div className="hint">{hp ? `${hp.label} · ${format(hp.value)}` : points.length ? `latest ${format(points[points.length - 1]!.value)}` : 'no data'}</div>
      </div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        style={{ width: '100%', height: 'auto', display: 'block', marginTop: 6 }}
        role="img"
        aria-label={title}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - rect.left) / rect.width) * w;
          if (points.length < 2) return setHover(points.length ? 0 : null);
          const i = Math.round(((px - pad.l) / iw) * (points.length - 1));
          setHover(Math.max(0, Math.min(points.length - 1, i)));
        }}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth={1} />
            <text x={pad.l - 6} y={y(t) + 4} fontSize={10} textAnchor="end" fill={INK_MUTED} style={{ fontVariantNumeric: 'tabular-nums' }}>
              {format(t)}
            </text>
          </g>
        ))}
        {points.length > 1 && area && <path d={areaPath} fill={HUE} opacity={0.1} />}
        {points.length > 1 && <path d={line} fill="none" stroke={HUE} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
        {points.length === 1 && <circle cx={x(0)} cy={y(points[0]!.value)} r={4} fill={HUE} stroke="#fff" strokeWidth={2} />}
        {hp && (
          <g>
            <line x1={x(hover!)} x2={x(hover!)} y1={pad.t} y2={pad.t + ih} stroke="#c9d3e0" strokeWidth={1} />
            <circle cx={x(hover!)} cy={y(hp.value)} r={4} fill={HUE} stroke="#fff" strokeWidth={2} />
          </g>
        )}
        {points.length > 0 && (
          <>
            <text x={pad.l} y={h - 6} fontSize={10} fill={INK_MUTED}>
              {points[0]!.label}
            </text>
            <text x={w - pad.r} y={h - 6} fontSize={10} fill={INK_MUTED} textAnchor="end">
              {points[points.length - 1]!.label}
            </text>
          </>
        )}
      </svg>
    </div>
  );
}

/** Horizontal bars, one hue, sorted; ≤24px thick, rounded data-end, value at the tip. */
function HBars({ title, rows, format, unit }: { title: string; rows: Array<{ name: string; value: number; sub?: string }>; format: (v: number) => string; unit: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const sorted = [...rows].sort((a, b) => b.value - a.value);
  const top = sorted.slice(0, 8);
  const rest = sorted.slice(8);
  if (rest.length) top.push({ name: `Other (${rest.length})`, value: rest.reduce((s, r) => s + r.value, 0) });
  const max = Math.max(1, ...top.map((r) => r.value));
  const rowH = 30;
  const labelW = 150;
  const w = 560;
  const h = top.length * rowH + 8;
  const barMaxW = w - labelW - 90;
  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>{title}</div>
      {top.length === 0 ? (
        <div className="hint">No traffic in this window.</div>
      ) : (
        <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label={`${title} (${unit})`} onMouseLeave={() => setHover(null)}>
          {top.map((r, i) => {
            const bw = Math.max(2, (r.value / max) * barMaxW);
            const y = i * rowH + 4;
            const bh = 20;
            const rr = Math.min(4, bw / 2);
            const path = `M${labelW},${y} h${bw - rr} a${rr},${rr} 0 0 1 ${rr},${rr} v${bh - 2 * rr} a${rr},${rr} 0 0 1 -${rr},${rr} h-${bw - rr} z`;
            return (
              <g key={r.name} onMouseEnter={() => setHover(i)} style={{ cursor: 'default' }}>
                <rect x={0} y={y - 4} width={w} height={rowH} fill={hover === i ? '#f3f6fb' : 'transparent'} />
                <text x={labelW - 10} y={y + 14} fontSize={12} textAnchor="end" fill="#0f1b2d">
                  {r.name.length > 20 ? r.name.slice(0, 19) + '…' : r.name}
                </text>
                <path d={path} fill={HUE} opacity={hover == null || hover === i ? 1 : 0.55} />
                <text x={labelW + bw + 8} y={y + 14} fontSize={11.5} fill="#5b6b82" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {format(r.value)}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

function Meter({ label, spent, limit, hard }: { label: string; spent: number; limit: number; hard: boolean }) {
  const ratio = limit > 0 ? spent / limit : 0;
  const fill = ratio >= 1 ? '#d3374e' : ratio >= 0.8 ? '#d9860b' : HUE;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
        <span>
          {label} <span className="hint">{hard ? 'hard' : 'soft'}</span>
        </span>
        <span className="mono" style={{ color: 'var(--text-dim)' }}>
          {formatUsd(spent, { compact: true })} / {formatUsd(limit, { compact: true })}
        </span>
      </div>
      <div style={{ height: 8, borderRadius: 4, background: HUE_SOFT, marginTop: 4, overflow: 'hidden' }} role="meter" aria-valuenow={Math.round(ratio * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div style={{ width: `${Math.min(100, ratio * 100)}%`, height: '100%', background: fill, borderRadius: 4 }} />
      </div>
    </div>
  );
}

/** Dollars for bar labels: none, dust, cents, or whole amounts. */
function usdValue(v: number): string {
  if (!v) return '—';
  if (v < 0.001) return '<$0.001';
  if (v < 1) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(2)}`;
}

export function LedgerPage() {
  const [win, setWin] = useState<Window>('24h');
  const [data, setData] = useState<Summary | null>(null);
  const topology = useStore((s) => s.topology);
  const counters = useStore((s) => s.counters);

  useEffect(() => {
    let alive = true;
    void api.get<Summary>(`/admin/api/ledger/summary?window=${win}`).then((d) => alive && setData(d));
    const t = setInterval(() => void api.get<Summary>(`/admin/api/ledger/summary?window=${win}`).then((d) => alive && setData(d)), 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [win, counters.flights > 0]);

  const keyName = useMemo(() => new Map((topology?.keys ?? []).map((k) => [k.id, k.name])), [topology]);
  const depName = useMemo(() => new Map((topology?.deployments ?? []).map((d) => [d.id, d.public_name ?? d.upstream_model])), [topology]);
  const mcpName = useMemo(() => new Map((topology?.mcp_servers ?? []).map((m) => [m.id, m.name])), [topology]);

  const totals = useMemo(() => {
    const t = { spend: 0, requests: 0, inTok: 0, outTok: 0, errors: 0, denied: 0 };
    for (const r of data?.by_key ?? []) {
      t.spend += r.cost_nanousd;
      t.requests += r.requests;
      t.inTok += r.in_tokens;
      t.outTok += r.out_tokens;
      t.errors += r.errors;
      t.denied += r.denied;
    }
    return t;
  }, [data]);

  const series = data?.series ?? [];
  const labelOf = (b: string) => (b.length === 13 ? `${b.slice(11)}:00` : b.slice(5));
  const spendSeries = series.map((s) => ({ label: labelOf(s.bucket), value: s.cost_nanousd / 1e9 }));
  const reqSeries = series.map((s) => ({ label: labelOf(s.bucket), value: s.requests }));
  const trend = (sel: (s: Summary['series'][number]) => number) => series.slice(-12).map(sel);

  return (
    <div className="page">
      <PageHeader
        title="Ledger"
        description="Spend, tokens and latency per agent and per model — each flight priced once, at the rate pinned when it was routed. Estimated usage is marked in Flights."
        actions={
          <div className="seg" role="tablist" aria-label="Time window">
            {(['1h', '24h', '7d', '30d'] as Window[]).map((w) => (
              <button key={w} role="tab" aria-selected={win === w} className={win === w ? 'on' : ''} onClick={() => setWin(w)}>
                {w}
              </button>
            ))}
          </div>
        }
      />

      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <StatTile label={`Spend · ${win}`} value={formatUsd(totals.spend)} trend={trend((s) => s.cost_nanousd)} />
        <StatTile label="Requests" value={compact(totals.requests)} trend={trend((s) => s.requests)} />
        <StatTile label="Tokens in → out" value={`${compact(totals.inTok)} → ${compact(totals.outTok)}`} hint={totals.requests ? `${Math.round((totals.inTok + totals.outTok) / totals.requests).toLocaleString()} per request` : undefined} />
        <StatTile label="Blocked · errors" value={`${compact(totals.denied)} · ${compact(totals.errors)}`} hint={totals.requests ? `${(((totals.denied + totals.errors) / totals.requests) * 100).toFixed(1)}% of requests` : undefined} trend={trend((s) => s.errors)} />
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', marginBottom: 14 }}>
        <TimeSeries title="Spend over time" points={spendSeries} format={(v) => (v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(3)}`)} area />
        <TimeSeries title="Requests over time" points={reqSeries} format={(v) => compact(Math.round(v))} />
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', marginBottom: 14 }}>
        <HBars title="Spend by agent" unit="USD" rows={(data?.by_key ?? []).map((r) => ({ name: keyName.get(r.key_id) ?? r.key_id, value: r.cost_nanousd / 1e9 }))} format={usdValue} />
        <HBars
          title="Spend by model / tool server"
          unit="USD"
          rows={(data?.by_deployment ?? []).map((r) => ({ name: depName.get(r.deployment_id) ?? mcpName.get(r.deployment_id) ?? (r.deployment_id || 'unrouted'), value: r.cost_nanousd / 1e9 }))}
          format={usdValue}
        />
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', marginBottom: 14 }}>
        <div className="card" style={{ padding: 0 }}>
          <table className="table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Requests</th>
                <th>Tokens in / out</th>
                <th>Blocked</th>
                <th>Errors</th>
                <th>Spend</th>
              </tr>
            </thead>
            <tbody>
              {(data?.by_key ?? [])
                .slice()
                .sort((a, b) => b.cost_nanousd - a.cost_nanousd)
                .map((r) => (
                  <tr key={r.key_id}>
                    <td>{keyName.get(r.key_id) ?? r.key_id}</td>
                    <td className="mono">{r.requests.toLocaleString()}</td>
                    <td className="mono">
                      {compact(r.in_tokens)} / {compact(r.out_tokens)}
                    </td>
                    <td className="mono">{r.denied}</td>
                    <td className="mono">{r.errors}</td>
                    <td className="mono num">{usd(r.cost_nanousd)}</td>
                  </tr>
                ))}
              {(data?.by_key ?? []).length === 0 && (
                <tr>
                  <td colSpan={6} className="hint" style={{ padding: 20, textAlign: 'center' }}>
                    Nothing in this window yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="card">
          <div style={{ fontWeight: 600, marginBottom: 10 }}>Budgets</div>
          {(data?.budgets ?? []).length === 0 && <div className="hint">No budgets set. Add one when creating a key.</div>}
          {(data?.budgets ?? []).map((b) => {
            const [type, ...rest] = b.scope.split(':');
            const id = rest.join(':');
            const name = type === 'key' ? (keyName.get(id) ?? id) : `${type} ${id}`;
            return <Meter key={b.scope} label={`${name} · ${b.period}`} spent={b.spent_nanousd + b.reserved_nanousd} limit={b.limit_nanousd} hard={b.hard} />;
          })}
        </div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead>
            <tr>
              <th>Model / tool server</th>
              <th>Requests</th>
              <th>Tokens in / out</th>
              <th>Avg latency</th>
              <th>Spend</th>
            </tr>
          </thead>
          <tbody>
            {(data?.by_deployment ?? [])
              .slice()
              .sort((a, b) => b.cost_nanousd - a.cost_nanousd)
              .map((r) => (
                <tr key={r.deployment_id || 'none'}>
                  <td>{depName.get(r.deployment_id) ?? mcpName.get(r.deployment_id) ?? (r.deployment_id || 'unrouted')}</td>
                  <td className="mono">{r.requests.toLocaleString()}</td>
                  <td className="mono">
                    {compact(r.in_tokens)} / {compact(r.out_tokens)}
                  </td>
                  <td className="mono">{r.avg_ms == null ? '—' : `${Math.round(r.avg_ms)} ms`}</td>
                  <td className="mono num">{usd(r.cost_nanousd)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
