import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';

export type TrustClass = 'A' | 'B' | 'C' | 'D' | 'E';
type RiskLevel = 'critical' | 'high' | 'medium' | 'low';
interface ClassSystem {
  id: string;
  kind: 'model' | 'mcp' | 'http' | 'a2a' | 'observed';
  name: string;
  url: string | null;
  class: TrustClass;
  default_class: TrustClass;
  reason: string;
  set: boolean;
  calls: number;
  bypass: boolean;
  gate: {
    target_kind: 'model' | 'tool';
    match: Record<string, string[]>;
  } | null;
}
interface ClassAgent {
  id: string;
  name: string;
  team: string | null;
  owner: string | null;
  calls: number;
  depth: TrustClass;
  risk: RiskLevel | null;
}
interface ClassLink {
  agent_id: string;
  system_id: string;
  calls: number;
  op: 'read' | 'write' | 'admin' | 'unknown' | 'model';
  mitigated: boolean;
  mitigation: string | null;
  outside: boolean;
  state: 'allow' | 'hold' | 'deny';
}
interface ClassRisk {
  agent_id: string;
  source_id: string;
  source_class: TrustClass;
  dest_id: string;
  dest_class: TrustClass;
  level: RiskLevel;
  reason: string;
  mitigation: string | null;
  outside: boolean;
  calls: number;
}
export interface ClassesData {
  hours: number;
  classes: Array<{ id: TrustClass; name: string; about: string }>;
  systems: ClassSystem[];
  agents: ClassAgent[];
  links: ClassLink[];
  risks: ClassRisk[];
}

const KIND: Record<ClassSystem['kind'], string> = {
  model: 'Models',
  mcp: 'Tool server',
  http: 'HTTP API',
  a2a: 'Remote agent',
  observed: 'Seen outside',
};
const LEVEL: Record<RiskLevel, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Checked',
};
const OP: Record<ClassLink['op'], string> = {
  read: 'reads',
  write: 'writes',
  admin: 'administers',
  unknown: 'calls',
  model: 'thinks with',
};
const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const PII_AND_SECRETS = ['email', 'phone', 'credit_card', 'us_ssn', 'iban', 'aws_access_key', 'aws_secret_key', 'github_token', 'stripe_key', 'private_key', 'connection_string'];

// The drawing: classes nest from the public internet (E, the whole board) in to production (A).
// Agents sit in C, bottom left; inner classes (B, A) are a band across the top of C; C's own systems
// are a column on its right; D and E each own a column outside C. Lines to outer classes stay low and
// leave C through its right wall; lines to inner classes rise into the band from below.
const W = 1200;
const BOX_W = 170;
const BOX_H = 34;
const ROW = 42;
const PAD = 18;
const LABEL = 26;
const COL = BOX_W + 2 * PAD - 6; // an outer class's own column
const MAX_PER = 24;

interface Box {
  id: string;
  x: number;
  y: number;
}
interface Layout {
  H: number;
  rects: Record<TrustClass, { x: number; y: number; w: number; h: number }>;
  agents: Map<string, Box>;
  systems: Map<string, Box>;
  more: Array<{ x: number; y: number; n: number }>;
}

function layout(agents: ClassAgent[], systems: ClassSystem[]): Layout {
  const by = (c: TrustClass) => systems.filter((s) => s.class === c).sort((a, b) => b.calls - a.calls);
  const [sa, sb, sc, sd, se] = (['A', 'B', 'C', 'D', 'E'] as const).map(by) as [ClassSystem[], ClassSystem[], ClassSystem[], ClassSystem[], ClassSystem[]];
  const cap = <T,>(l: T[]) => l.slice(0, MAX_PER);
  const more: Layout['more'] = [];
  const E = { x: 0, w: W };
  const D = { x: PAD, w: W - COL - PAD };
  const C = { x: 2 * PAD, w: D.w - COL - PAD };
  // The inner band: A on the left of B, B's systems in columns to its right.
  const bandX = C.x + PAD;
  const bandW = C.w - 2 * PAD;
  const aW = BOX_W + 2 * PAD;
  const bCols = Math.max(1, Math.floor((bandW - aW - 2 * PAD) / (BOX_W + 14)));
  const aRows = Math.max(1, cap(sa).length);
  const bRows = Math.max(1, Math.ceil(cap(sb).length / bCols));
  const bandH = LABEL + Math.max(aRows * ROW + LABEL + PAD, bRows * ROW) + PAD;
  const top = PAD + LABEL; // D's top edge
  const cTop = top + PAD + LABEL - 4;
  const bTop = cTop + LABEL + 2;
  const lowTop = bTop + bandH + PAD + 6;
  const shownAgents = agents.slice(0, 40);
  const lowRows = Math.max(shownAgents.length, cap(sc).length, 2);
  const cH = lowTop - cTop + lowRows * ROW + PAD;
  const dRows = cap(sd).length;
  const eRows = cap(se).length;
  const H = Math.max(cTop + cH + PAD + 34, top + LABEL + dRows * ROW + 3 * PAD, LABEL + eRows * ROW + 3 * PAD + PAD) + 8;
  const rects: Layout['rects'] = {
    E: { x: E.x, y: 0, w: E.w, h: H },
    D: { x: D.x, y: top, w: D.w, h: H - top - PAD },
    C: { x: C.x, y: cTop, w: C.w, h: cH },
    B: { x: bandX, y: bTop, w: bandW, h: bandH },
    A: { x: bandX + PAD, y: bTop + LABEL, w: aW, h: bandH - LABEL - PAD },
  };
  const sysBox = new Map<string, Box>();
  cap(sa).forEach((s, i) =>
    sysBox.set(s.id, {
      id: s.id,
      x: rects.A.x + PAD,
      y: rects.A.y + LABEL + i * ROW,
    }),
  );
  cap(sb).forEach((s, i) =>
    sysBox.set(s.id, {
      id: s.id,
      x: rects.A.x + aW + PAD + (i % bCols) * (BOX_W + 14),
      y: bTop + LABEL + Math.floor(i / bCols) * ROW,
    }),
  );
  cap(sc).forEach((s, i) =>
    sysBox.set(s.id, {
      id: s.id,
      x: C.x + C.w - PAD - BOX_W,
      y: lowTop + i * ROW,
    }),
  );
  cap(sd).forEach((s, i) =>
    sysBox.set(s.id, {
      id: s.id,
      x: C.x + C.w + PAD + 4,
      y: cTop + LABEL + i * ROW,
    }),
  );
  cap(se).forEach((s, i) =>
    sysBox.set(s.id, {
      id: s.id,
      x: D.x + D.w + PAD - 2,
      y: top + LABEL + PAD + i * ROW,
    }),
  );
  for (const [l, x, y] of [
    [sa, rects.A.x + PAD, rects.A.y + LABEL + MAX_PER * ROW],
    [sb, rects.A.x + aW + PAD, bTop + LABEL + bRows * ROW],
    [sc, C.x + C.w - PAD - BOX_W, lowTop + MAX_PER * ROW],
    [sd, C.x + C.w + PAD + 4, cTop + LABEL + MAX_PER * ROW],
    [se, D.x + D.w + PAD - 2, top + LABEL + PAD + MAX_PER * ROW],
  ] as const)
    if (l.length > MAX_PER) more.push({ x, y, n: l.length - MAX_PER });
  const agentBox = new Map<string, Box>();
  shownAgents.forEach((a, i) => agentBox.set(a.id, { id: a.id, x: C.x + PAD, y: lowTop + i * ROW }));
  if (agents.length > shownAgents.length)
    more.push({
      x: C.x + PAD,
      y: lowTop + shownAgents.length * ROW,
      n: agents.length - shownAgents.length,
    });
  return { H, rects, agents: agentBox, systems: sysBox, more };
}

/** A cubic from the agent's right edge to the system: low and level, bending only near the end. */
function linkPath(a: Box, s: Box, cls: TrustClass, L: Layout) {
  const x1 = a.x + BOX_W;
  const y1 = a.y + BOX_H / 2;
  if (cls === 'A' || cls === 'B') {
    // Rise into the band from below.
    const x2 = s.x + BOX_W / 2;
    const y2 = s.y + BOX_H;
    return {
      d: `M${x1} ${y1} C ${x2} ${y1}, ${x2} ${y1 - 30}, ${x2} ${y2}`,
      pts: [x1, y1, x2, y1, x2, y1 - 30, x2, y2] as const,
    };
  }
  const x2 = s.x;
  const y2 = s.y + BOX_H / 2;
  const bend = cls === 'C' ? x2 - 60 : L.rects.C.x + L.rects.C.w;
  return {
    d: `M${x1} ${y1} C ${bend} ${y1}, ${bend + 10} ${y2}, ${x2} ${y2}`,
    pts: [x1, y1, bend, y1, bend + 10, y2, x2, y2] as const,
  };
}
function bez(p: readonly number[], t: number): [number, number] {
  const u = 1 - t;
  const x = u * u * u * p[0]! + 3 * u * u * t * p[2]! + 3 * u * t * t * p[4]! + t * t * t * p[6]!;
  const y = u * u * u * p[1]! + 3 * u * u * t * p[3]! + 3 * u * t * t * p[5]! + t * t * t * p[7]!;
  return [x, y];
}
/** Where a line crosses the border that matters: C's right wall going out, B's floor going in. */
function crossing(p: readonly number[], cls: TrustClass, L: Layout): [number, number] | null {
  if (cls === 'C') return null;
  let best: [number, number] | null = null;
  let bestD = Infinity;
  for (let i = 0; i <= 60; i++) {
    const [x, y] = bez(p, i / 60);
    const d = cls === 'A' || cls === 'B' ? Math.abs(y - (L.rects.B.y + L.rects.B.h)) : Math.abs(x - (L.rects.C.x + L.rects.C.w));
    if (d < bestD) {
      bestD = d;
      best = [x, y];
    }
  }
  return best;
}

export function ClassesView({ right, isAdmin, onOpenAgent }: { right: number; isAdmin: boolean; onOpenAgent: (keyId: string) => void }) {
  const [hours, setHours] = useState(24);
  const [data, setData] = useState<ClassesData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agentSel, setAgentSel] = useState<string | null>(null);
  const [sysSel, setSysSel] = useState<string | null>(null);
  // The selected risk, by agent and destination (the list re-sorts as risks change level).
  const [riskSel, setRiskSel] = useState<string | null>(null);
  const riskKey = (r: { agent_id: string; dest_id: string }) => `${r.agent_id}>${r.dest_id}`;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = () =>
    api
      .get<ClassesData>(`/admin/api/airspace/classes?hours=${hours}`)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hours]);

  const agents = useMemo(() => (data ? [...data.agents].sort((a, b) => b.calls - a.calls) : []), [data]);
  const L = useMemo(() => (data ? layout(agents, data.systems) : null), [agents, data]);
  const sys = useMemo(() => new Map((data?.systems ?? []).map((s) => [s.id, s])), [data]);
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const risk = riskSel !== null ? (data?.risks.find((r) => riskKey(r) === riskSel) ?? null) : null;
  const riskyLinks = useMemo(() => {
    const m = new Map<string, ClassRisk['level']>();
    for (const r of data?.risks ?? []) {
      if (r.level === 'low') continue;
      const k = `${r.agent_id}>${r.dest_id}`;
      if (!m.has(k)) m.set(k, r.level);
    }
    return m;
  }, [data]);

  if (!data || !L) {
    return (
      <div className="matrix-wrap scope" style={{ right }}>
        <div className="scope-empty">{error ? `Couldn't load the classes: ${error}` : 'Loading…'}</div>
      </div>
    );
  }

  const focusAgent = risk?.agent_id ?? agentSel;
  const lit = (l: ClassLink) => {
    if (risk) return l.agent_id === risk.agent_id && (l.system_id === risk.dest_id || l.system_id === risk.source_id);
    if (agentSel) return l.agent_id === agentSel;
    if (sysSel) return l.system_id === sysSel;
    return true;
  };
  const any = !!(risk || agentSel || sysSel);
  const sel = sysSel ? (sys.get(sysSel) ?? null) : null;
  const counts = { critical: 0, high: 0, medium: 0, low: 0 } as Record<RiskLevel, number>;
  for (const r of data.risks) counts[r.level]++;

  const setClass = async (id: string, c: TrustClass | null) => {
    setBusy(true);
    try {
      if (c)
        await api.put(`/admin/api/airspace/classes/${encodeURIComponent(id)}`, {
          class: c,
        });
      else await api.del(`/admin/api/airspace/classes/${encodeURIComponent(id)}`);
      await load();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const guard = async (r: ClassRisk) => {
    const dest = sys.get(r.dest_id);
    const agent = agentById.get(r.agent_id);
    if (!dest?.gate || !agent) return;
    setBusy(true);
    try {
      await api.post('/admin/api/rules', {
        name: `Mask data leaving: ${agent.name} → ${dest.name}`,
        target_kind: dest.gate.target_kind,
        match: { keys: [r.agent_id], ...dest.gate.match },
        effect: 'inspect',
        config: {
          detectors: PII_AND_SECRETS,
          action: 'mask',
          direction: 'input',
          reason: `${agent.name} reaches ${data.classes.find((c) => c.id === r.source_class)?.name.toLowerCase()}; personal data and secrets are masked before they reach ${dest.name}`,
        },
        priority: 40,
      });
      setNote(`Added a gate: what ${agent.name} sends to ${dest.name} is checked, and personal data and secrets are masked.`);
      await load();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const nameOf = (id: string) => sys.get(id)?.name ?? agentById.get(id)?.name ?? id;
  const classInfo = (c: TrustClass) => data.classes.find((x) => x.id === c)!;

  return (
    <div className="matrix-wrap scope" role="region" aria-label="Trust classes" style={{ right }}>
      <div className="matrix-bar scope-bar">
        <b className="scope-title">Trust classes</b>
        <span className="scope-hint">How deep each agent reaches, and where data could leave</span>
        <div className="seg sm layer-seg" role="radiogroup" aria-label="Window">
          {[1, 24, 168].map((h) => (
            <button key={h} role="radio" aria-checked={hours === h} className={hours === h ? 'on' : ''} onClick={() => setHours(h)}>
              {h === 1 ? '1 h' : h === 24 ? '24 h' : '7 d'}
            </button>
          ))}
        </div>
        <span className="scope-key">
          <i className="k-ok" /> checked <i className="k-hold" /> approval <i className="k-stop" /> leaves unchecked <i className="k-out" /> around the gateway
        </span>
      </div>
      <div className="scope-body">
        <div
          className="scope-board"
          onClick={() => {
            setAgentSel(null);
            setSysSel(null);
            setRiskSel(null);
          }}
        >
          <svg viewBox={`0 0 ${W} ${L.H}`} width="100%" style={{ minWidth: 900, display: 'block' }} role="img" aria-label="Nested trust classes with agents and the systems they reach">
            {(['E', 'D', 'C', 'B', 'A'] as const).map((c) => {
              const r = L.rects[c];
              const info = classInfo(c);
              return (
                <g key={c} className={`cls cls-${c}`}>
                  <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={c === 'E' ? 0 : 18} />
                  <text x={r.x + 14} y={r.y + 18} className="cls-label">
                    CLASS {c} · {info.name.toUpperCase()}
                  </text>
                </g>
              );
            })}
            {L.rects.A && !data.systems.some((s) => s.class === 'A') && (
              <text x={L.rects.A.x + PAD} y={L.rects.A.y + LABEL + 20} className="cls-none">
                nothing in production
              </text>
            )}
            {!data.systems.some((s) => s.class === 'B') && (
              <text x={L.rects.A.x + L.rects.A.w + PAD} y={L.rects.B.y + LABEL + 20} className="cls-none">
                no restricted data reached
              </text>
            )}
            <g className="links">
              {data.links.map((l) => {
                const a = L.agents.get(l.agent_id);
                const s = L.systems.get(l.system_id);
                const target = sys.get(l.system_id);
                if (!a || !s || !target) return null;
                const p = linkPath(a, s, target.class, L);
                const risky = riskyLinks.get(`${l.agent_id}>${l.system_id}`);
                const tone = l.state === 'deny' ? 'deny' : l.outside ? 'out' : l.state === 'hold' ? 'hold' : risky ? 'stop' : l.mitigated ? 'ok' : 'plain';
                const on = lit(l);
                const w = 1 + Math.min(4, Math.log10(1 + l.calls) * 1.3);
                const x = crossing(p.pts, target.class, L);
                return (
                  <g key={`${l.agent_id}>${l.system_id}`} className={`ln ${tone} ${any && !on ? 'dim' : ''}`}>
                    <path d={p.d} strokeWidth={w} />
                    {x && (tone === 'ok' || tone === 'hold' || tone === 'deny') && <rect className="gate" x={x[0] - 5} y={x[1] - 5} width={10} height={10} transform={`rotate(45 ${x[0]} ${x[1]})`} />}
                    {x && tone === 'stop' && <circle className="breach" cx={x[0]} cy={x[1]} r={6} />}
                    <title>
                      {nameOf(l.agent_id)} {OP[l.op]} {nameOf(l.system_id)} · {l.calls.toLocaleString()} calls
                      {l.outside ? ' · seen outside the gateway' : ''}
                      {l.mitigation ? ` · ${l.mitigation}` : ''}
                    </title>
                  </g>
                );
              })}
            </g>
            {[...L.systems.values()].map((b) => {
              const s = sys.get(b.id)!;
              const atRisk = data.risks.some((r) => r.dest_id === s.id && r.level !== 'low' && (!focusAgent || r.agent_id === focusAgent));
              const dim = any && !(sysSel === s.id || data.links.some((l) => l.system_id === s.id && lit(l)));
              return (
                <g
                  key={b.id}
                  className={`sys ${s.kind === 'observed' ? 'outside' : ''} ${atRisk ? 'risk' : ''} ${sysSel === s.id ? 'sel' : ''} ${dim ? 'dim' : ''}`}
                  transform={`translate(${b.x} ${b.y})`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setRiskSel(null);
                    setAgentSel(null);
                    setSysSel(sysSel === s.id ? null : s.id);
                  }}
                >
                  <rect width={BOX_W} height={BOX_H} rx={7} />
                  <text x={10} y={14} className="n">
                    {s.name.length > 24 ? `${s.name.slice(0, 23)}…` : s.name}
                  </text>
                  <text x={10} y={27} className="d">
                    {KIND[s.kind]} · {compact(s.calls)}
                    {s.set ? ' · set' : ''}
                  </text>
                  <text x={BOX_W - 10} y={21} className="c" textAnchor="end">
                    {s.class}
                  </text>
                </g>
              );
            })}
            {[...L.agents.values()].map((b) => {
              const a = agentById.get(b.id)!;
              const dim = any && focusAgent !== a.id && !(sysSel && data.links.some((l) => l.agent_id === a.id && l.system_id === sysSel));
              return (
                <g
                  key={b.id}
                  className={`agent ${a.risk ? `r-${a.risk}` : ''} ${focusAgent === a.id ? 'sel' : ''} ${dim ? 'dim' : ''}`}
                  transform={`translate(${b.x} ${b.y})`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setRiskSel(null);
                    setSysSel(null);
                    setAgentSel(agentSel === a.id ? null : a.id);
                  }}
                >
                  <rect width={BOX_W} height={BOX_H} rx={17} />
                  <circle cx={16} cy={BOX_H / 2} r={5} className="dot" />
                  <text x={28} y={14} className="n">
                    {a.name.length > 21 ? `${a.name.slice(0, 20)}…` : a.name}
                  </text>
                  <text x={28} y={27} className="d">
                    reaches {a.depth} · {compact(a.calls)}
                    {a.team ? ` · ${a.team}` : ''}
                  </text>
                </g>
              );
            })}
            {L.more.map((m) => (
              <text key={`${m.x}:${m.y}`} x={m.x + 4} y={m.y + 16} className="cls-none">
                +{m.n} more
              </text>
            ))}
          </svg>
        </div>
        <aside className="scope-rail">
          {sel ? (
            <div className="rail-sec">
              <div className="rail-kicker">{KIND[sel.kind]}</div>
              <div className="rail-title">{sel.name}</div>
              {sel.url && <div className="rail-mono">{sel.url}</div>}
              <p className="rail-p">
                Class {sel.class}, {classInfo(sel.class).name.toLowerCase()}. {sel.reason}.
              </p>
              {isAdmin && (
                <>
                  <div className="rail-kicker" style={{ marginTop: 10 }}>
                    Set its class
                  </div>
                  <div className="cls-pick" role="radiogroup" aria-label="Trust class">
                    {data.classes.map((c) => (
                      <button
                        key={c.id}
                        role="radio"
                        aria-checked={sel.class === c.id}
                        className={sel.class === c.id ? 'on' : ''}
                        disabled={busy}
                        title={`${c.name}: ${c.about}`}
                        onClick={() => void setClass(sel.id, c.id)}
                      >
                        {c.id}
                      </button>
                    ))}
                  </div>
                  {sel.set && (
                    <button className="rail-link" disabled={busy} onClick={() => void setClass(sel.id, null)}>
                      Back to its default ({sel.default_class})
                    </button>
                  )}
                </>
              )}
              <div className="rail-kicker" style={{ marginTop: 12 }}>
                Agents that reach it
              </div>
              {data.links
                .filter((l) => l.system_id === sel.id)
                .sort((a, b) => b.calls - a.calls)
                .map((l) => (
                  <div key={l.agent_id} className="rail-row">
                    <span>{nameOf(l.agent_id)}</span>
                    <span className="dim">
                      {OP[l.op]} · {compact(l.calls)}
                      {l.outside ? ' · outside' : l.mitigation ? ' · checked' : ''}
                    </span>
                  </div>
                ))}
            </div>
          ) : (
            <div className="rail-sec">
              <div className="rail-kicker">Exfiltration risk</div>
              <div className="risk-counts">
                {(['critical', 'high', 'medium'] as const).map((k) => (
                  <div key={k} className={`rc ${k} ${counts[k] ? 'some' : ''}`}>
                    <b>{counts[k]}</b>
                    <span>{LEVEL[k]}</span>
                  </div>
                ))}
                <div className="rc low">
                  <b>{counts.low}</b>
                  <span>Checked</span>
                </div>
              </div>
              <p className="rail-p">
                A risk is an agent that reaches an inner class and can send to an outer one. It is checked when something stands on the way out: an inspection, an approval or a block.
              </p>
              {agentSel && (
                <div className="rail-filter">
                  {nameOf(agentSel)}{' '}
                  <button className="rail-link" onClick={() => onOpenAgent(agentSel)}>
                    Show on the map
                  </button>
                </div>
              )}
              {data.risks.length === 0 && <p className="rail-p ok">No agent reaches restricted data or production and sends outside the company.</p>}
              <div className="risk-list">
                {data.risks.map((r, i) =>
                  agentSel && r.agent_id !== agentSel ? null : (
                    <div key={`${r.agent_id}>${r.dest_id}`} className={`risk ${r.level} ${riskSel === riskKey(r) ? 'on' : ''}`}>
                      <button
                        className="risk-head"
                        aria-expanded={riskSel === riskKey(r)}
                        onClick={() => {
                          setSysSel(null);
                          setRiskSel(riskSel === riskKey(r) ? null : riskKey(r));
                        }}
                      >
                        <span className="lvl">{LEVEL[r.level]}</span>
                        <span className="route">
                          {nameOf(r.agent_id)}
                          <em>
                            {nameOf(r.source_id)} <small>{r.source_class}</small> → {nameOf(r.dest_id)} <small>{r.dest_class}</small>
                          </em>
                        </span>
                      </button>
                      {riskSel === riskKey(r) && (
                        <div className="why">
                          {r.reason}.{r.mitigation ? ` ${r.mitigation[0]!.toUpperCase()}${r.mitigation.slice(1)}.` : ''} {compact(r.calls)} calls in {data.hours === 168 ? '7 days' : `${data.hours} h`}
                          .{r.outside && <> It goes around the gateway: bring it inside (Outside, on the map) so a gate can stand on it.</>}
                          {isAdmin && r.level !== 'low' && !r.outside && sys.get(r.dest_id)?.gate && (
                            <button className="fix" disabled={busy} onClick={() => void guard(r)}>
                              Mask personal data and secrets on this path
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  ),
                )}
              </div>
            </div>
          )}
          {note && (
            <div className="rail-note" onClick={() => setNote(null)}>
              {note}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
