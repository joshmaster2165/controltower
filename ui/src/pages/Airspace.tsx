import { useEffect, useRef, useState } from 'react';
import { formatUsd } from '@controltower/shared';
import { useStore } from '../store';
import { onFlightEvent } from '../ws';
import { AirspaceScene, type ClickInfo, type FocusSummary, type HoverInfo, type LinkState } from '../airspace/scene';
import { hex } from '../airspace/colors';
import { api, ApiError, type Rule, type Zone } from '../api';
import { ApprovalCard } from './Tower';

const SWATCHES = ['#1f5eff', '#0b3d91', '#0e9aa7', '#6366f1', '#1a9e6b', '#d9860b', '#d3374e', '#7c3aed'];

type Popover =
  | { kind: 'lasso'; stationIds: string[]; x: number; y: number }
  | { kind: 'zone'; zone: Zone; x: number; y: number }
  | { kind: 'gate'; rule: Rule; x: number; y: number };

const STATE_LABEL: Record<LinkState, string> = {
  active: 'active',
  idle: 'idle (24h)',
  unused: 'no traffic',
  holding: 'holding for approval',
  blocked: 'blocked',
};

const KIND_LABEL = { agent: 'agent', model: 'model', mcp: 'MCP server', unknown: 'unrouted' } as const;

export function AirspacePage() {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<AirspaceScene | null>(null);
  const topology = useStore((s) => s.topology);
  const policy = useStore((s) => s.policy);
  const approvals = useStore((s) => s.approvals);
  const counters = useStore((s) => s.counters);
  const feed = useStore((s) => s.feed);
  const wsState = useStore((s) => s.wsState);
  const refreshPolicy = useStore((s) => s.refreshPolicy);
  const refreshApprovals = useStore((s) => s.refreshApprovals);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [stats, setStats] = useState({ active: 0, stations: 0, held: 0 });
  const [drawMode, setDrawMode] = useState(false);
  const [popover, setPopover] = useState<Popover | null>(null);
  const [showTower, setShowTower] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [focus, setFocus] = useState<FocusSummary | null>(null);
  const focusRef = useRef<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [customLayout, setCustomLayout] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const cameraReady = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const applyFocus = (id: string | null) => {
    focusRef.current = id;
    setFocusId(id);
    sceneRef.current?.setFocus(id);
    setFocus(id ? (sceneRef.current?.focusSummary(id) ?? null) : null);
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    const scene = new AirspaceScene();
    let unsub = () => {};
    void scene
      .init(host)
      .catch((err: unknown) => {
        console.error('[airspace] init failed', err);
        setInitError(err instanceof Error ? err.message : String(err));
        throw err;
      })
      .then(() => {
        if (disposed) {
          scene.destroy();
          return;
        }
        sceneRef.current = scene;
        (window as unknown as { __ctScene?: AirspaceScene }).__ctScene = scene;
        scene.onHover(setHover);
        scene.onClick((c: ClickInfo) => {
          if (c.kind === 'lasso') {
            setDrawMode(false);
            scene.drawMode = false;
            if (c.stationIds.length) setPopover({ kind: 'lasso', stationIds: c.stationIds, x: c.x, y: c.y });
            else setPopover(null);
          } else if (c.kind === 'station') {
            setPopover(null);
            applyFocus(focusRef.current === c.station.id ? null : c.station.id);
          } else if (c.kind === 'zone') setPopover({ kind: 'zone', zone: c.zone, x: c.x, y: c.y });
          else if (c.kind === 'gate') setPopover({ kind: 'gate', rule: c.rule, x: c.x, y: c.y });
          else {
            setPopover(null);
            applyFocus(null);
          }
        });
        const st = useStore.getState();
        if (st.topology) scene.setTopology(st.topology);
        if (st.policy) scene.setPolicy(st.policy);
        unsub = onFlightEvent((e) => scene.handle(e));

        // Arrangement is shared (server); camera is per viewer (localStorage).
        scene.onLayoutChange((positions) => {
          setCustomLayout(Object.keys(positions).length > 0);
          setSaveState('saving');
          if (saveTimer.current) clearTimeout(saveTimer.current);
          saveTimer.current = setTimeout(() => {
            api
              .put('/admin/api/airspace/layout', { positions })
              .then(() => setSaveState('saved'))
              .catch(() => setSaveState('error'));
          }, 500);
        });
        scene.onCamera((c) => {
          setZoom(c.k);
          try {
            localStorage.setItem('ct.airspace.camera', JSON.stringify(c));
          } catch {
            /* storage unavailable */
          }
        });
        void api
          .get<{ positions: Record<string, [number, number]> }>('/admin/api/airspace/layout')
          .then((r) => {
            if (disposed) return;
            scene.setPositions(r.positions);
            setCustomLayout(scene.hasCustomLayout());
          })
          .catch(() => undefined)
          .finally(() => {
            if (disposed) return;
            let saved: { x: number; y: number; k: number } | null = null;
            try {
              saved = JSON.parse(localStorage.getItem('ct.airspace.camera') ?? 'null') as typeof saved;
            } catch {
              saved = null;
            }
            if (saved) scene.setCamera(saved);
            else scene.fit();
            setZoom(scene.getCamera().k);
            cameraReady.current = true;
          });
      })
      .catch(() => undefined);
    const iv = setInterval(() => {
      const sc = sceneRef.current;
      if (!sc) return;
      setStats(sc.stats());
      if (focusRef.current) setFocus(sc.focusSummary(focusRef.current));
    }, 1000);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') applyFocus(null);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      disposed = true;
      clearInterval(iv);
      window.removeEventListener('keydown', onKey);
      unsub();
      sceneRef.current?.destroy();
      sceneRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (topology && sceneRef.current) {
      sceneRef.current.setTopology(topology);
      if (focusRef.current) setFocus(sceneRef.current.focusSummary(focusRef.current));
    }
  }, [topology]);
  useEffect(() => {
    if (policy && sceneRef.current) sceneRef.current.setPolicy(policy);
  }, [policy]);
  useEffect(() => {
    sceneRef.current?.setRightInset(showTower || focusId ? 372 : 0);
  }, [showTower, focusId, topology, policy]);

  const fitView = () => {
    sceneRef.current?.fit();
    if (sceneRef.current) setZoom(sceneRef.current.getCamera().k);
  };
  const resetLayout = () => {
    if (!confirm('Reset the Airspace to the automatic layout? Everyone sees the shared arrangement.')) return;
    sceneRef.current?.resetLayout();
  };

  const toggleDraw = () => {
    const next = !drawMode;
    setDrawMode(next);
    if (sceneRef.current) sceneRef.current.drawMode = next;
    setPopover(null);
  };

  const stationKeyFor = (id: string) => {
    const s = sceneRef.current?.stationList().find((x) => x.id === id);
    return s?.kind === 'agent' ? `key:${id}` : s?.kind === 'mcp' ? `mcp:${id}` : `deployment:${id}`;
  };

  const pendingHere = approvals.filter((a) => a.status === 'pending');

  return (
    <div className="airspace" ref={hostRef} style={{ cursor: drawMode ? 'crosshair' : 'default' }}>
      <div className="hud">
        <div className="hud-strip">
          <div className="seg">
            <div className="label">Flights</div>
            <div className="value">{counters.flights.toLocaleString()}</div>
          </div>
          <div className="seg">
            <div className="label">Spend</div>
            <div className="value">{formatUsd(counters.cost_nanousd)}</div>
          </div>
          <div className="seg">
            <div className="label">Blocked · errors</div>
            <div className="value" style={{ color: counters.denied + counters.errors ? 'var(--danger)' : undefined }}>
              {counters.denied} · {counters.errors}
            </div>
          </div>
          <div className="seg">
            <div className="label">Active links</div>
            <div className="value">{stats.active}</div>
          </div>
          <div className="seg">
            <div className="label">Holding</div>
            <div className="value" style={{ color: pendingHere.length ? 'var(--warn)' : undefined }}>
              {pendingHere.length}
            </div>
          </div>
        </div>
        <button className={`btn ${drawMode ? 'active' : ''}`} onClick={toggleDraw} title="Drag a lasso around stations to create a zone">
          Draw zone
        </button>
        <button className={`btn ${showTower && !focusId ? 'active' : ''}`} onClick={() => { applyFocus(null); setShowTower((v) => !v); }}>
          Approvals {pendingHere.length > 0 && <span className="badge">{pendingHere.length}</span>}
        </button>
      </div>
      <div className="airspace-caption">
        <b>Airspace</b> · drag nodes to arrange · drag the canvas or scroll to pan · ⌘/Ctrl + scroll to zoom · click a node to trace it
      </div>
      {initError && (
        <div className="card" style={{ position: 'absolute', left: '50%', top: '45%', transform: 'translate(-50%,-50%)', maxWidth: 440, zIndex: 6 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>The Airspace could not start</div>
          <div className="hint" style={{ marginBottom: 10 }}>{initError}</div>
          <button className="btn sm" onClick={() => location.reload()}>Reload</button>
        </div>
      )}
      {drawMode && <div className="mode-banner">Drag a lasso around the stations that belong together</div>}

      {focus ? (
        <FocusPanel summary={focus} onClose={() => applyFocus(null)} onPick={(id) => applyFocus(id)} />
      ) : (
        showTower && (
          <div className="tower-drawer">
            {pendingHere.length === 0 ? (
              <div className="card hint">No flights holding. Click a gate to make it a checkpoint, or draw a zone first.</div>
            ) : (
              pendingHere.map((a) => <ApprovalCard key={a.id} a={a} onDecided={() => void refreshApprovals()} />)
            )}
            {feed.slice(0, 4).map((f) => (
              <div className="feed" key={f.id} style={{ position: 'static', width: 'auto' }}>
                <div className="row">
                  <i style={{ background: f.kind === 'held' ? 'var(--warn)' : f.kind === 'ok' || f.kind === 'info' ? 'var(--accent)' : 'var(--danger)' }} />
                  <span>{f.text}</span>
                  <span className="m">{f.meta}</span>
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {popover?.kind === 'lasso' && (
        <ZoneCreatePopover
          x={popover.x}
          y={popover.y}
          count={popover.stationIds.length}
          onCancel={() => setPopover(null)}
          onCreate={async (name, color) => {
            try {
              await api.post('/admin/api/zones', { name, color, stations: popover.stationIds.map(stationKeyFor) });
              await refreshPolicy();
              setPopover(null);
            } catch (e) {
              setError(e instanceof ApiError ? e.message : String(e));
            }
          }}
        />
      )}
      {popover?.kind === 'zone' && policy && (
        <ZonePopover x={popover.x} y={popover.y} zone={popover.zone} zones={policy.zones} rules={policy.rules} onClose={() => setPopover(null)} onChanged={() => void refreshPolicy()} />
      )}
      {popover?.kind === 'gate' && policy && (
        <GatePopover
          x={popover.x}
          y={popover.y}
          rule={policy.rules.find((r) => r.id === popover.rule.id) ?? popover.rule}
          zones={policy.zones}
          stats={policy.rule_stats[popover.rule.id]}
          onClose={() => setPopover(null)}
          onChanged={() => void refreshPolicy()}
        />
      )}
      {error && (
        <div className="popover" style={{ left: 16, bottom: 50, top: 'auto', width: 'auto' }}>
          <span className="error">{error}</span>{' '}
          <button className="btn sm ghost" onClick={() => setError(null)}>
            ok
          </button>
        </div>
      )}

      {hover && !popover && <Tooltip hover={hover} />}

      <div className="map-controls" style={{ right: showTower || focusId ? 388 : 16 }}>
        <button className="btn sm ghost" onClick={() => sceneRef.current?.zoomBy(1 / 1.2)} aria-label="Zoom out">
          −
        </button>
        <span className="zoom">{Math.round(zoom * 100)}%</span>
        <button className="btn sm ghost" onClick={() => sceneRef.current?.zoomBy(1.2)} aria-label="Zoom in">
          +
        </button>
        <span className="sep" />
        <button className="btn sm ghost" onClick={fitView}>
          Fit
        </button>
        {customLayout && (
          <button className="btn sm ghost" onClick={resetLayout}>
            Reset layout
          </button>
        )}
        {saveState !== 'idle' && <span className="save">{saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Layout saved' : 'Save failed'}</span>}
      </div>

      <div className="legend">
        <span>
          <em className="ln active" /> active (last min)
        </span>
        <span>
          <em className="ln idle" /> idle (24h)
        </span>
        <span>
          <em className="ln unused" /> no traffic
        </span>
        <span>
          <em className="ln holding" /> holding
        </span>
        <span>
          <em className="ln blocked" /> blocked
        </span>
        <span className="sep" />
        <span>
          <em className="gate deny" /> deny gate
        </span>
        <span>
          <em className="gate hold" /> approval gate
        </span>
        <span className={`pill ${wsState === 'live' ? 'live' : 'warn'}`}>
          <i className="led" /> {wsState}
        </span>
        {policy && !policy.enforcement && <span className="pill warn">enforcement off</span>}
      </div>
    </div>
  );
}

function Tooltip({ hover }: { hover: HoverInfo }) {
  const pos = { left: hover.x, top: hover.y };
  if (hover.station) {
    const s = hover.station;
    return (
      <div className="tooltip" style={pos}>
        <div className="t" style={{ color: hex(s.color) }}>
          {s.label}
        </div>
        <div className="r">
          <span>{KIND_LABEL[s.kind]}</span>
          <b>{STATE_LABEL[s.state]}</b>
        </div>
        <div className="r">
          <span>last minute</span>
          <b>{s.rpm} flights</b>
        </div>
        <div className="r">
          <span>24h requests</span>
          <b>{s.requests24h.toLocaleString()}</b>
        </div>
        <div className="r">
          <span>24h spend</span>
          <b>{formatUsd(s.cost24h)}</b>
        </div>
        {(s.denied24h > 0 || s.errors24h > 0) && (
          <div className="r">
            <span>blocked · errors</span>
            <b>
              {s.denied24h} · {s.errors24h}
            </b>
          </div>
        )}
        <div className="r">
          <span>click to trace connections</span>
        </div>
      </div>
    );
  }
  if (hover.tool) {
    const t = hover.tool;
    return (
      <div className="tooltip" style={pos}>
        <div className="t">
          {t.server} · {t.name}
        </div>
        <div className="r">
          <span>operation</span>
          <b>{t.op === 'admin' ? 'destructive' : t.op}</b>
        </div>
        <div className="r">
          <span>last minute</span>
          <b>{t.rpm} calls</b>
        </div>
        <div className="r">
          <span>24h calls</span>
          <b>{t.count24h.toLocaleString()}</b>
        </div>
        {t.gates.map((g) => (
          <div className="r" key={g.id}>
            <span>gate</span>
            <b>{g.effect.replace('_', ' ')}</b>
          </div>
        ))}
      </div>
    );
  }
  if (hover.lane) {
    const l = hover.lane;
    return (
      <div className="tooltip" style={pos}>
        <div className="t">
          {l.fromLabel} → {l.toLabel}
        </div>
        <div className="r">
          <span>state</span>
          <b>{STATE_LABEL[l.state]}</b>
        </div>
        <div className="r">
          <span>last minute</span>
          <b>{l.rpm} flights</b>
        </div>
        <div className="r">
          <span>24h requests · spend</span>
          <b>
            {l.requests.toLocaleString()} · {formatUsd(l.cost)}
          </b>
        </div>
        {l.gate && (
          <div className="r">
            <span>gate</span>
            <b>{l.gate.rule.effect.replace('_', ' ')}</b>
          </div>
        )}
      </div>
    );
  }
  if (hover.gate) {
    return (
      <div className="tooltip" style={pos}>
        <div className="t">{hover.gate.rule.name}</div>
        <div className="r">
          <span>effect</span>
          <b>{hover.gate.rule.effect.replace('_', ' ')}</b>
        </div>
        <div className="r">
          <span>triggered (last min)</span>
          <b>{hover.gate.hits}</b>
        </div>
        <div className="r">
          <span>click to edit</span>
        </div>
      </div>
    );
  }
  if (hover.hub) {
    return (
      <div className="tooltip" style={pos}>
        <div className="t">Control Tower</div>
        <div className="r">
          <span>active links</span>
          <b>{hover.hub.active}</b>
        </div>
        <div className="r">
          <span>flights / min</span>
          <b>{hover.hub.rpm}</b>
        </div>
        <div className="r">
          <span>holding</span>
          <b>{hover.hub.held}</b>
        </div>
      </div>
    );
  }
  if (hover.zone) {
    return (
      <div className="tooltip" style={pos}>
        <div className="t" style={{ color: hover.zone.color }}>
          {hover.zone.name}
        </div>
        <div className="r">
          <span>click to manage gates</span>
        </div>
      </div>
    );
  }
  return null;
}

function FocusPanel({ summary, onClose, onPick }: { summary: FocusSummary; onClose: () => void; onPick: (id: string) => void }) {
  const s = summary.station;
  const title = s.kind === 'agent' ? 'Reaches' : 'Used by';
  const maxReq = Math.max(1, ...summary.links.map((l) => l.requests));
  return (
    <div className="tower-drawer">
      <div className="card focus-panel">
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="hint" style={{ textTransform: 'uppercase', letterSpacing: 0.4, fontSize: 11, fontWeight: 600 }}>
              {KIND_LABEL[s.kind]} · {STATE_LABEL[s.state]}
            </div>
            <div style={{ fontWeight: 600, fontSize: 16, marginTop: 2 }}>{s.label}</div>
            <div className="hint">{s.sub}</div>
          </div>
          <button className="btn sm ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="focus-stats">
          <div>
            <div className="label">Last min</div>
            <div className="value">{s.rpm}</div>
          </div>
          <div>
            <div className="label">24h requests</div>
            <div className="value">{s.requests24h.toLocaleString()}</div>
          </div>
          <div>
            <div className="label">24h spend</div>
            <div className="value">{formatUsd(s.cost24h)}</div>
          </div>
        </div>
        <div className="focus-title">
          {title} · {summary.links.length}
        </div>
        {summary.links.length === 0 && <div className="hint">No connections in the last 24 hours.</div>}
        {summary.links.map((l) => (
          <div key={l.id} className="focus-link" onClick={() => onPick(l.id)} role="button" tabIndex={0}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <i className="swatch" style={{ background: hex(l.color) }} />
              <span className="name">{l.label}</span>
              <span className="kind">{KIND_LABEL[l.kind]}</span>
              {l.live && <span className="live-dot" title="active in the last minute" />}
              <span className="num">{l.requests.toLocaleString()}</span>
            </div>
            <div className="bar">
              <div style={{ width: `${(l.requests / maxReq) * 100}%` }} />
            </div>
            {(l.denied > 0 || l.errors > 0 || l.cost > 0) && (
              <div className="meta">
                {formatUsd(l.cost)}
                {l.denied > 0 && <span className="bad"> · {l.denied} blocked</span>}
                {l.errors > 0 && <span className="bad"> · {l.errors} errors</span>}
              </div>
            )}
            {l.tools.length > 0 && (
              <div className="tools">
                {l.tools.map((t) => (
                  <span key={t.name} className="tag">
                    {t.name} · {t.requests.toLocaleString()}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
        <div className="hint" style={{ marginTop: 10 }}>
          Click a connection to trace it · Esc to clear
        </div>
      </div>
    </div>
  );
}

function ZoneCreatePopover({ x, y, count, onCancel, onCreate }: { x: number; y: number; count: number; onCancel: () => void; onCreate: (name: string, color: string) => Promise<void> }) {
  const [name, setName] = useState('');
  const [color, setColor] = useState(SWATCHES[0]!);
  return (
    <form
      className="popover"
      style={{ left: Math.min(x, window.innerWidth - 340), top: Math.min(y, window.innerHeight - 260) }}
      onSubmit={(e) => {
        e.preventDefault();
        if (name) void onCreate(name, color);
      }}
    >
      <div className="t">New zone · {count} station{count === 1 ? '' : 's'}</div>
      <div className="field">
        <label>Name</label>
        <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Finance agents" />
      </div>
      <div className="field">
        <label>Colour</label>
        <div className="swatches">
          {SWATCHES.map((c) => (
            <i key={c} className={c === color ? 'sel' : ''} style={{ background: c }} onClick={() => setColor(c)} />
          ))}
        </div>
      </div>
      <div className="row">
        <button className="btn sm primary" disabled={!name} type="submit">
          Create zone
        </button>
        <button className="btn sm ghost" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function ZonePopover({ x, y, zone, zones, rules, onClose, onChanged }: { x: number; y: number; zone: Zone; zones: Zone[]; rules: Rule[]; onClose: () => void; onChanged: () => void }) {
  const [target, setTarget] = useState(zones.find((z) => z.id !== zone.id)?.id ?? '');
  const [effect, setEffect] = useState<Rule['effect']>('require_approval');
  const [name, setName] = useState(zone.name);
  const own = rules.filter((r) => r.from_zone === zone.id || r.to_zone === zone.id);
  const addGate = async () => {
    await api.post('/admin/api/rules', { from_zone: zone.id, to_zone: target || null, effect, config: effect === 'require_approval' ? { hold_ms: 20000 } : {} });
    onChanged();
    onClose();
  };
  const rename = async () => {
    if (name.trim() && name !== zone.name) await api.patch(`/admin/api/zones/${zone.id}`, { name: name.trim() });
    onChanged();
  };
  const remove = async () => {
    if (!confirm(`Delete zone "${zone.name}" and its gates?`)) return;
    await api.del(`/admin/api/zones/${zone.id}`);
    onChanged();
    onClose();
  };
  return (
    <div className="popover" style={{ left: Math.min(x, window.innerWidth - 340), top: Math.min(y + 8, window.innerHeight - 320) }}>
      <div className="t" style={{ color: zone.color }}>
        {zone.name}
      </div>
      <div className="field">
        <label>Rename</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn sm" onClick={() => void rename()}>
            Save
          </button>
        </div>
      </div>
      <div className="field">
        <label>Add a gate from this zone to…</label>
        <select className="input" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">anywhere</option>
          {zones
            .filter((z) => z.id !== zone.id)
            .map((z) => (
              <option key={z.id} value={z.id}>
                {z.name}
              </option>
            ))}
        </select>
        <select className="input" value={effect} onChange={(e) => setEffect(e.target.value as Rule['effect'])} style={{ marginTop: 6 }}>
          <option value="allow">allow (open gate)</option>
          <option value="deny">deny (barrier)</option>
          <option value="require_approval">require approval (checkpoint)</option>
        </select>
        <div className="row">
          <button className="btn sm primary" onClick={() => void addGate()}>
            Add gate
          </button>
        </div>
      </div>
      {own.length > 0 && (
        <div className="hint" style={{ marginBottom: 8 }}>
          {own.length} gate{own.length === 1 ? '' : 's'} touch this zone — click a gate marker on a lane to edit it.
        </div>
      )}
      <div className="row">
        <button className="btn sm danger" onClick={() => void remove()}>
          Delete zone
        </button>
        <button className="btn sm ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

function GatePopover({ x, y, rule, zones, stats, onClose, onChanged }: { x: number; y: number; rule: Rule; zones: Zone[]; stats: { approved: number; denied: number } | undefined; onClose: () => void; onChanged: () => void }) {
  const [effect, setEffect] = useState<Rule['effect']>(rule.effect);
  const [reason, setReason] = useState(rule.config.reason ?? '');
  const [hold, setHold] = useState(String(Math.round((rule.config.hold_ms ?? 20000) / 1000)));
  const zoneName = (id: string | null) => (id ? (zones.find((z) => z.id === id)?.name ?? '?') : 'anywhere');
  const total = (stats?.approved ?? 0) + (stats?.denied ?? 0);
  const rate = total ? (stats!.approved / total) * 100 : null;
  const save = async () => {
    await api.patch(`/admin/api/rules/${rule.id}`, { effect, config: { reason: reason || undefined, hold_ms: Math.max(0, Number(hold)) * 1000 } });
    onChanged();
    onClose();
  };
  const toggle = async () => {
    await api.patch(`/admin/api/rules/${rule.id}`, { enabled: !rule.enabled });
    onChanged();
  };
  const remove = async () => {
    if (!confirm(`Delete gate "${rule.name}"?`)) return;
    await api.del(`/admin/api/rules/${rule.id}`);
    onChanged();
    onClose();
  };
  return (
    <div className="popover" style={{ left: Math.min(x, window.innerWidth - 340), top: Math.min(y + 8, window.innerHeight - 360) }}>
      <div className="t">{rule.name}</div>
      <div className="hint" style={{ marginBottom: 8 }}>
        {zoneName(rule.from_zone)} → {zoneName(rule.to_zone)}
        {rule.demo ? ' · demo' : ''}
      </div>
      <div className="field">
        <label>Effect</label>
        <select className="input" value={effect} onChange={(e) => setEffect(e.target.value as Rule['effect'])}>
          <option value="allow">allow (open gate)</option>
          <option value="deny">deny (barrier)</option>
          <option value="require_approval">require approval (checkpoint)</option>
        </select>
      </div>
      {effect === 'require_approval' && (
        <div className="field">
          <label>Hold the request up to (seconds) before issuing a ticket</label>
          <input className="input" type="number" min={0} max={55} value={hold} onChange={(e) => setHold(e.target.value)} />
        </div>
      )}
      <div className="field">
        <label>Reason shown to the agent</label>
        <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why this gate exists" />
      </div>
      {rate != null && (
        <div className="hint" style={{ marginBottom: 8, color: rate >= 95 && total >= 20 ? 'var(--warn)' : undefined }}>
          {stats!.approved} approved / {stats!.denied} denied ({rate.toFixed(0)}%){rate >= 95 && total >= 20 ? ' — this gate is noise; consider auto-allow.' : ''}
        </div>
      )}
      <div className="row">
        <button className="btn sm primary" onClick={() => void save()}>
          Save
        </button>
        <button className="btn sm ghost" onClick={() => void toggle()}>
          {rule.enabled ? 'Disable' : 'Enable'}
        </button>
        <button className="btn sm danger" onClick={() => void remove()}>
          Delete
        </button>
        <button className="btn sm ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
