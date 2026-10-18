import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';

type Op = 'model' | 'read' | 'write' | 'admin' | 'unknown';
interface ReachItem {
  id: string;
  ring: 'model' | 'tool' | 'outside';
  system_id: string;
  system: string;
  system_kind: string;
  name: string;
  label: string;
  op: Op;
  class: string;
  granted: boolean;
  used: boolean;
  calls: number;
  last_used: number | null;
  access: 'allow' | 'hold' | 'deny' | 'outside';
  gate: string | null;
}
interface ReachData {
  agent: { id: string; name: string; team: string | null; owner: string | null; allowed_models: string[]; allowed_mcp: string[] };
  days: number;
  items: ReachItem[];
  summary: { granted: number; used: number; unused: number; unused_risky: number; outside: number };
  trim: { allowed_models: string[]; allowed_mcp: string[]; removes: number } | null;
}
interface KeyRow {
  id: string;
  name: string;
  team: string | null;
  last_used_at?: number | null;
}

const OP_LABEL: Record<Op, string> = { model: 'model', read: 'reads', write: 'writes', admin: 'admin', unknown: 'calls' };
const ago = (t: number | null) => {
  if (!t) return '';
  const h = (Date.now() - t) / 3600_000;
  return h < 1 ? 'in the last hour' : h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} d ago`;
};
const W = 1000;
const H = 760;
const CX = W / 2;
const CY = H / 2;
const RINGS: Record<ReachItem['ring'], number> = { model: 150, tool: 270, outside: 350 };
const RING_NAME: Record<ReachItem['ring'], string> = { model: 'Thinks with', tool: 'Can do', outside: 'Reaches around the gateway' };

/**
 * One agent's blast radius: what its key lets it reach, in rings (models, then tools and APIs, then what it reaches
 * around the gateway), solid where it used it and a ghost where it only may. Trimming keeps what it used.
 */
export function ReachView({ right, isAdmin, initialKey }: { right: number; isAdmin: boolean; initialKey?: string | null }) {
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [keyId, setKeyId] = useState<string | null>(initialKey ?? null);
  const [days, setDays] = useState(30);
  const [data, setData] = useState<ReachData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [trimming, setTrimming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    void api
      .get<{ keys: Array<KeyRow & { status?: string; built_in?: boolean }> }>('/admin/api/keys')
      .then((r) => {
        const list = r.keys.filter((k) => !k.built_in && !['key_admin_master', 'key_playground', 'key_guardrail'].includes(k.id)).sort((a, b) => (b.last_used_at ?? 0) - (a.last_used_at ?? 0));
        setKeys(list);
        setKeyId((cur) => cur ?? list[0]?.id ?? null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  const load = () => {
    if (!keyId) return;
    void api
      .get<ReachData>(`/admin/api/airspace/reach?key=${encodeURIComponent(keyId)}&days=${days}`)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  };
  useEffect(() => {
    setData(null);
    setSel(null);
    setTrimming(false);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyId, days]);

  // Each ring's items evenly round it, grouped by system, so a tool server's tools sit together.
  const placed = useMemo(() => {
    if (!data) return [];
    const out: Array<ReachItem & { x: number; y: number; a: number }> = [];
    for (const ring of ['model', 'tool', 'outside'] as const) {
      const list = data.items.filter((i) => i.ring === ring && (i.granted || i.used)).sort((a, b) => a.system.localeCompare(b.system) || a.label.localeCompare(b.label));
      // Half a step off the top, where the ring's name is.
      list.forEach((it, i) => {
        const a = -Math.PI / 2 + ((i + 0.5) / Math.max(1, list.length)) * Math.PI * 2;
        out.push({ ...it, a, x: CX + RINGS[ring] * Math.cos(a), y: CY + RINGS[ring] * Math.sin(a) });
      });
    }
    return out;
  }, [data]);
  const maxCalls = Math.max(1, ...placed.map((p) => p.calls));
  const item = sel ? placed.find((p) => p.id === sel) ?? null : null;
  const unused = (data?.items ?? []).filter((i) => i.granted && !i.used);
  const bySystem = new Map<string, ReachItem[]>();
  for (const u of unused) bySystem.set(u.system, [...(bySystem.get(u.system) ?? []), u]);

  const applyTrim = async () => {
    if (!data?.trim) return;
    setBusy(true);
    try {
      await api.patch(`/admin/api/keys/${encodeURIComponent(data.agent.id)}`, { allowed_models: data.trim.allowed_models, allowed_mcp: data.trim.allowed_mcp });
      setNote(`${data.agent.name} now keeps only what it used in ${data.days} days: ${data.trim.removes} permission${data.trim.removes === 1 ? '' : 's'} removed.`);
      setTrimming(false);
      load();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="matrix-wrap scope reach" role="region" aria-label="Reach" style={{ right }}>
      <div className="matrix-bar scope-bar">
        <b className="scope-title">Reach</b>
        <span className="scope-hint">One agent: everything its key lets it reach, and what it actually used</span>
        <select className="input sm" value={keyId ?? ''} onChange={(e) => setKeyId(e.target.value)} aria-label="Agent" style={{ maxWidth: 240 }}>
          {keys.map((k) => (
            <option key={k.id} value={k.id}>
              {k.name}
              {k.team ? ` · ${k.team}` : ''}
            </option>
          ))}
        </select>
        <div className="seg sm layer-seg" role="radiogroup" aria-label="Window">
          {[7, 30, 90].map((d) => (
            <button key={d} role="radio" aria-checked={days === d} className={days === d ? 'on' : ''} onClick={() => setDays(d)}>
              {d} d
            </button>
          ))}
        </div>
        <span className="scope-key">
          used: <i className="k-used" /> reads <i className="k-write" /> writes <i className="k-admin" /> admin · <i className="k-ghost" /> allowed, never used <i className="k-hold-d" /> needs approval <i className="k-deny-d" /> blocked <i className="k-out" /> around the gateway
        </span>
      </div>
      <div className="scope-body">
        <div className="scope-board" onClick={() => setSel(null)}>
          {!data ? (
            <div className="scope-empty">{error ? `Couldn't load: ${error}` : keyId ? 'Loading…' : 'No agents yet'}</div>
          ) : (
            <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block', maxHeight: '100%' }} role="img" aria-label={`What ${data.agent.name} can reach, and what it used`}>
              {(['outside', 'tool', 'model'] as const).map((r) => (
                <g key={r}>
                  <circle cx={CX} cy={CY} r={RINGS[r]} className={`reach-ring r-${r}`} />
                  <text x={CX} y={CY - RINGS[r] + 14} textAnchor="middle" className="reach-ring-label">
                    {RING_NAME[r].toUpperCase()}
                  </text>
                </g>
              ))}
              {placed.map((p) => {
                const tone = p.access === 'deny' ? 'deny' : p.ring === 'outside' ? 'out' : p.access === 'hold' ? 'hold' : p.used ? `used op-${p.op}` : 'ghost';
                const dim = sel && sel !== p.id;
                return (
                  <line
                    key={`l-${p.id}`}
                    x1={CX}
                    y1={CY}
                    x2={p.x}
                    y2={p.y}
                    className={`reach-ln ${tone} ${dim ? 'dim' : ''}`}
                    strokeWidth={p.used ? 1 + 3.5 * Math.sqrt(p.calls / maxCalls) : 1}
                  />
                );
              })}
              <circle cx={CX} cy={CY} r={44} className="reach-agent" />
              <text x={CX} y={CY - 2} textAnchor="middle" className="reach-agent-name">
                {data.agent.name.length > 16 ? `${data.agent.name.slice(0, 15)}…` : data.agent.name}
              </text>
              <text x={CX} y={CY + 14} textAnchor="middle" className="reach-agent-sub">
                {data.summary.used} of {data.summary.granted} used
              </text>
              {placed.map((p) => {
                const right = Math.cos(p.a) >= 0;
                const tone = p.access === 'deny' ? 'deny' : p.ring === 'outside' ? 'out' : p.access === 'hold' ? 'hold' : p.used ? `used op-${p.op}` : 'ghost';
                const label = p.ring === 'tool' && p.system_kind === 'mcp' ? `${p.system} · ${p.label}` : p.label;
                return (
                  <g
                    key={p.id}
                    className={`reach-node ${tone} ${sel === p.id ? 'sel' : ''} ${sel && sel !== p.id ? 'dim' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSel(sel === p.id ? null : p.id);
                    }}
                  >
                    <circle cx={p.x} cy={p.y} r={p.used ? 7 : 6} />
                    {p.access === 'deny' && <path d={`M${p.x - 3.5} ${p.y - 3.5}l7 7m0-7l-7 7`} className="reach-x" />}
                    <text x={p.x + (right ? 11 : -11)} y={p.y + 4} textAnchor={right ? 'start' : 'end'} className="reach-label">
                      {label.length > 30 ? `${label.slice(0, 29)}…` : label}
                    </text>
                    <title>
                      {p.system} · {p.label}: {p.used ? `${p.calls.toLocaleString()} calls, last ${ago(p.last_used)}` : p.granted ? `allowed, not used in ${data.days} days` : 'reached around the gateway'}
                      {p.gate ? ` · gate “${p.gate}”` : ''}
                    </title>
                  </g>
                );
              })}
            </svg>
          )}
        </div>
        <aside className="scope-rail">
          {data && item ? (
            <div className="rail-sec">
              <div className="rail-kicker">{RING_NAME[item.ring]}</div>
              <div className="rail-title">{item.label}</div>
              <div className="rail-mono">{item.name}</div>
              <p className="rail-p">
                {item.system} (class {item.class}).{' '}
                {item.ring === 'outside'
                  ? `Reached around the gateway: no key grants it and no gate can stand on it. ${item.calls.toLocaleString()} calls seen in the last day.`
                  : item.used
                    ? `${item.calls.toLocaleString()} calls in ${data.days} days, the last ${ago(item.last_used)}.`
                    : `Allowed by the key, never used in ${data.days} days.`}{' '}
                {item.access === 'deny' ? `A gate blocks it: “${item.gate}”.` : item.access === 'hold' ? `A person approves each call: “${item.gate}”.` : item.ring !== 'outside' ? 'No gate stands on it.' : ''}
              </p>
            </div>
          ) : data ? (
            <div className="rail-sec">
              <div className="rail-kicker">Least privilege · last {data.days} days</div>
              <div className="big-pct">
                <b>{data.summary.granted ? Math.round((data.summary.used / data.summary.granted) * 100) : 0}%</b> of what it may reach, used
              </div>
              <p className="rail-p">
                {data.agent.name} may reach {data.summary.granted} model{data.summary.granted === 1 ? '' : 's'}, tool{data.summary.granted === 1 ? '' : 's'} and API{data.summary.granted === 1 ? '' : 's'}, and used {data.summary.used}.
                {data.summary.unused_risky ? ` ${data.summary.unused_risky} of the unused can change or delete something, with no gate on them.` : ''}
                {data.summary.outside ? ` It also reaches ${data.summary.outside} system${data.summary.outside === 1 ? '' : 's'} around the gateway.` : ''}
              </p>
              {data.trim && data.trim.removes > 0 && isAdmin && !trimming && (
                <button className="btn primary" onClick={() => setTrimming(true)}>
                  Trim to what it uses ({data.trim.removes} fewer)
                </button>
              )}
              {data.trim && trimming && (
                <div className="reach-trim">
                  <div className="rail-kicker">Its key would allow</div>
                  <div className="rail-p">
                    <b>Models:</b> <span className="mono">{data.trim.allowed_models.join(', ') || 'none'}</span>
                    <br />
                    <b>Tools and APIs:</b> <span className="mono">{data.trim.allowed_mcp.join(', ') || 'none'}</span>
                  </div>
                  <div className="hint">
                    Instead of: models <span className="mono">{data.agent.allowed_models.join(', ') || 'none'}</span>; tools <span className="mono">{data.agent.allowed_mcp.join(', ') || 'none'}</span>. Anything it hasn’t used in {data.days} days would be refused; you can widen it again on Keys.
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button className="btn primary" disabled={busy} onClick={() => void applyTrim()}>
                      Trim
                    </button>
                    <button className="btn" onClick={() => setTrimming(false)}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              {!data.trim && <p className="rail-p">No calls in {data.days} days: nothing to trim to. If it’s no longer used, retire the key.</p>}
              {unused.length > 0 && (
                <>
                  <div className="rail-kicker" style={{ marginTop: 12 }}>
                    Allowed, never used
                  </div>
                  {[...bySystem.entries()].map(([sys, list]) => (
                    <div key={sys} className="reach-sys">
                      <div className="reach-sys-h">{sys}</div>
                      {list.map((u) => (
                        <button key={u.id} className="rail-row as-btn" onClick={() => setSel(u.id)}>
                          <span>{u.label}</span>
                          <span className={`dim ${(u.op === 'write' || u.op === 'admin') && u.access === 'allow' ? 'risky' : ''}`}>
                            {OP_LABEL[u.op]}
                            {u.access === 'deny' ? ' · blocked' : u.access === 'hold' ? ' · approval' : ''}
                          </span>
                        </button>
                      ))}
                    </div>
                  ))}
                </>
              )}
            </div>
          ) : null}
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
