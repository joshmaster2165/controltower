import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';

interface CoverageAgent {
  id: string;
  name: string;
  calls: number;
  governed: number;
  outside: number;
}
interface CoverageTeam {
  team: string;
  agents: CoverageAgent[];
  calls: number;
  governed: number;
  outside: number;
  people: { members: number; signed_in: number } | null;
}
export interface CoverageData {
  hours: number;
  teams: CoverageTeam[];
  totals: {
    calls: number;
    governed: number;
    outside: number;
    teams: number;
    agents: number;
  };
}

const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
/** The three shares of a team's traffic: gated, through the gateway with no gate, and around it. */
const shares = (t: { calls: number; governed: number; outside: number }) => {
  const all = t.calls + t.outside;
  return all
    ? {
        gated: t.governed / all,
        open: (t.calls - t.governed) / all,
        outside: t.outside / all,
        all,
      }
    : { gated: 0, open: 0, outside: 0, all: 0 };
};

const W = 1100;
const polar = (cx: number, cy: number, r: number, turn: number): [number, number] => [cx + r * Math.sin(turn * 2 * Math.PI), cy - r * Math.cos(turn * 2 * Math.PI)];
function arc(cx: number, cy: number, r: number, from: number, to: number) {
  if (to - from <= 0.0005) return '';
  if (to - from >= 0.9995) return `M${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.01} ${cy - r}`;
  const [x1, y1] = polar(cx, cy, r, from);
  const [x2, y2] = polar(cx, cy, r, to);
  return `M${x1} ${y1} A ${r} ${r} 0 ${to - from > 0.5 ? 1 : 0} 1 ${x2} ${y2}`;
}
/** A steady scatter of points inside a circle (the golden angle), so a team's stars don't jump between refreshes. */
const spiral = (i: number, n: number, r: number): [number, number] => {
  if (n === 1) return [0, 0];
  const rr = r * Math.sqrt((i + 0.6) / (n + 0.6));
  const a = i * 2.399963;
  return [rr * Math.cos(a), rr * Math.sin(a)];
};
/** Background stars, from a fixed seed. */
const SKY = (() => {
  let seed = 11;
  const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  return Array.from({ length: 140 }, () => [rnd(), rnd(), rnd()] as const);
})();

export function CoverageView({ right, onOpenAgent }: { right: number; onOpenAgent: (keyId: string) => void }) {
  const [hours, setHours] = useState(24);
  const [data, setData] = useState<CoverageData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      api
        .get<CoverageData>(`/admin/api/airspace/coverage?hours=${hours}`)
        .then((d) => {
          setData(d);
          setError(null);
        })
        .catch((e: Error) => setError(e.message));
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [hours]);

  // Teams in a grid of cells; each circle's area follows its traffic.
  const placed = useMemo(() => {
    if (!data) return null;
    const teams = data.teams;
    const cols = teams.length <= 2 ? Math.max(1, teams.length) : teams.length <= 6 ? 3 : 4;
    const cellW = W / cols;
    const cellH = 270;
    const maxAll = Math.max(1, ...teams.map((t) => t.calls + t.outside));
    const H = Math.max(1, Math.ceil(teams.length / cols)) * cellH + 20;
    return {
      H,
      teams: teams.map((t, i) => {
        const r = 44 + 52 * Math.sqrt((t.calls + t.outside) / maxAll);
        const row = Math.floor(i / cols);
        const inRow = Math.min(cols, teams.length - row * cols);
        const offset = (W - inRow * cellW) / 2;
        return {
          t,
          r,
          cx: offset + (i % cols) * cellW + cellW / 2,
          cy: row * cellH + 22 + cellH / 2 - 26,
        };
      }),
    };
  }, [data]);

  if (!data || !placed) {
    return (
      <div className="matrix-wrap scope" style={{ right }}>
        <div className="scope-empty">{error ? `Couldn't load coverage: ${error}` : 'Loading…'}</div>
      </div>
    );
  }
  const total = shares(data.totals);
  const team = sel ? (data.teams.find((t) => t.team === sel) ?? null) : null;
  const span = data.hours === 168 ? '7 days' : `${data.hours} h`;

  return (
    <div className="matrix-wrap scope" role="region" aria-label="Coverage by team" style={{ right }}>
      <div className="matrix-bar scope-bar">
        <b className="scope-title">Coverage</b>
        <span className="scope-hint">Each team's AI traffic: how much a gate stands on, and how much goes around the gateway</span>
        <div className="seg sm layer-seg" role="radiogroup" aria-label="Window">
          {[1, 24, 168].map((h) => (
            <button key={h} role="radio" aria-checked={hours === h} className={hours === h ? 'on' : ''} onClick={() => setHours(h)}>
              {h === 1 ? '1 h' : h === 24 ? '24 h' : '7 d'}
            </button>
          ))}
        </div>
        <span className="scope-key">
          <i className="k-gated" /> gated <i className="k-nogate" /> through the gateway, no gate <i className="k-out" /> around the gateway <i className="k-people" /> people signed in
        </span>
      </div>
      <div className="scope-body">
        <div className="scope-board" onClick={() => setSel(null)}>
          <svg
            viewBox={`0 0 ${W} ${placed.H}`}
            width="100%"
            style={{ minWidth: 760, display: 'block' }}
            role="img"
            aria-label="Teams as constellations, each with a ring showing how much of its traffic is gated"
          >
            {SKY.map(([x, y, b], i) => (
              <circle key={i} cx={x * W} cy={y * placed.H} r={0.3 + b * 1.1} className="sky" opacity={0.25 + b * 0.4} />
            ))}
            {placed.teams.map(({ t, r, cx, cy }) => {
              const s = shares(t);
              const ring = r + 10;
              const stars = t.agents.slice(0, 40);
              const maxA = Math.max(1, ...stars.map((a) => a.calls + a.outside));
              const pts = stars.map((a, i) => spiral(i, stars.length, r - 12));
              const dim = sel && sel !== t.team;
              return (
                <g
                  key={t.team}
                  className={`team ${sel === t.team ? 'sel' : ''} ${dim ? 'dim' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSel(sel === t.team ? null : t.team);
                  }}
                >
                  <circle cx={cx} cy={cy} r={r} className="halo" />
                  <circle cx={cx} cy={cy} r={ring} className="track" />
                  <path d={arc(cx, cy, ring, 0, s.gated)} className="seg-gated" />
                  <path d={arc(cx, cy, ring, s.gated, s.gated + s.open)} className="seg-open" />
                  <path d={arc(cx, cy, ring, s.gated + s.open, 1)} className="seg-out" />
                  {t.people && t.people.members > 0 && <path d={arc(cx, cy, ring + 9, 0, t.people.signed_in / t.people.members)} className="seg-people" />}
                  {pts.slice(1).map(([x, y], i) => (i % 3 !== 2 ? <line key={i} x1={cx + pts[i]![0]} y1={cy + pts[i]![1]} x2={cx + x} y2={cy + y} className="const" /> : null))}
                  {stars.map((a, i) => {
                    const [x, y] = pts[i]!;
                    const k = (a.calls + a.outside) / maxA;
                    const tone = a.outside > a.calls ? 'out' : a.calls && a.governed / a.calls >= 0.5 ? 'gated' : 'open';
                    const rad = 1.8 + 3.4 * Math.sqrt(k);
                    return (
                      <g key={a.id}>
                        <circle cx={cx + x} cy={cy + y} r={rad} className={`star ${tone}`}>
                          <title>
                            {a.name}: {a.calls.toLocaleString()} calls through the gateway ({pct(a.governed, a.calls)}% gated)
                            {a.outside ? `, ${a.outside.toLocaleString()} around it` : ''}
                          </title>
                        </circle>
                        {/* A few agents: name them. */}
                        {stars.length <= 5 && (
                          <text x={cx + x} y={cy + y + rad + 12} textAnchor="middle" className="star-name">
                            {a.name.length > 22 ? `${a.name.slice(0, 21)}…` : a.name}
                          </text>
                        )}
                      </g>
                    );
                  })}
                  <text x={cx} y={cy + ring + 30} textAnchor="middle" className="t-name">
                    {t.team}
                  </text>
                  <text x={cx} y={cy + ring + 46} textAnchor="middle" className={`t-sub ${s.all && s.gated < 0.5 ? 'warn' : ''}`}>
                    {s.all ? `${pct(t.governed, s.all)}% gated` : 'no traffic'}
                    {t.outside ? ` · ${pct(t.outside, s.all)}% around` : ''} · {t.agents.length} agent
                    {t.agents.length === 1 ? '' : 's'}
                    {t.people ? ` · ${t.people.signed_in}/${t.people.members} signed in` : ''}
                  </text>
                </g>
              );
            })}
            {data.teams.length === 0 && (
              <text x={W / 2} y={placed.H / 2} textAnchor="middle" className="t-sub">
                No agents yet
              </text>
            )}
          </svg>
        </div>
        <aside className="scope-rail">
          {team ? (
            <div className="rail-sec">
              <div className="rail-kicker">Team</div>
              <div className="rail-title">{team.team}</div>
              <Bar t={team} />
              <p className="rail-p">
                {compact(team.calls + team.outside)} calls in {span}: {compact(team.governed)} gated, {compact(team.calls - team.governed)} through the gateway with no gate
                {team.outside ? `, ${compact(team.outside)} around it` : ''}.{team.people ? ` ${team.people.signed_in} of ${team.people.members} people signed in from their computers.` : ''}
              </p>
              <div className="rail-kicker" style={{ marginTop: 10 }}>
                Agents
              </div>
              {team.agents.map((a) => (
                <button key={a.id} className="rail-row as-btn" onClick={() => onOpenAgent(a.id)} title="Show it on the map">
                  <span>{a.name}</span>
                  <span className="mini">
                    <Bar t={a} small />
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="rail-sec">
              <div className="rail-kicker">The whole company</div>
              <div className="big-pct">
                <b>{pct(data.totals.governed, total.all)}%</b> gated
              </div>
              <Bar t={data.totals} />
              <p className="rail-p">
                {compact(total.all)} calls in {span} across {data.totals.teams} team{data.totals.teams === 1 ? '' : 's'} and {data.totals.agents} agent{data.totals.agents === 1 ? '' : 's'}. Gated
                means a gate stands on the path: an approval, a block, limits or an inspection. Around the gateway is traffic seen outside it, where no gate can.
              </p>
              <div className="rail-kicker" style={{ marginTop: 10 }}>
                Least covered
              </div>
              {[...data.teams]
                .filter((t) => t.calls + t.outside > 0)
                .sort((a, b) => a.governed / (a.calls + a.outside) - b.governed / (b.calls + b.outside))
                .slice(0, 6)
                .map((t) => (
                  <button key={t.team} className="rail-row as-btn" onClick={() => setSel(t.team)}>
                    <span>{t.team}</span>
                    <span className="dim">{pct(t.governed, t.calls + t.outside)}% gated</span>
                  </button>
                ))}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function Bar({ t, small }: { t: { calls: number; governed: number; outside: number }; small?: boolean }) {
  const s = shares(t);
  return (
    <div
      className={`cov-bar ${small ? 'small' : ''}`}
      aria-label={`${Math.round(s.gated * 100)}% gated, ${Math.round(s.open * 100)}% through the gateway with no gate, ${Math.round(s.outside * 100)}% around it`}
    >
      <i className="gated" style={{ width: `${s.gated * 100}%` }} />
      <i className="open" style={{ width: `${s.open * 100}%` }} />
      <i className="out" style={{ width: `${s.outside * 100}%` }} />
    </div>
  );
}
