import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { formatUsd } from '@controltower/shared';
import { useStore } from '../store';
import { onFlightEvent } from '../ws';
import { AirspaceScene, type ClickInfo, type FocusSummary, type HoverInfo, type LinkState } from '../airspace/scene';
import { hex } from '../airspace/colors';
import { api, ApiError, type AlertChannel, type AlertRule, type DetectorInfo, type InspectConfig, type Rule, type Topology, type Zone } from '../api';
import { AlertRuleForm, BellIcon, conditionText, defaultTriggers, notifyText } from './Alerts';
import { ApprovalCard } from './Tower';

const SWATCHES = ['#1f5eff', '#0b3d91', '#0e9aa7', '#6366f1', '#1a9e6b', '#d9860b', '#d3374e', '#7c3aed'];

/** Prefill for the gate composer: `from` is 'all' | 'zone:<id>' | 'key:<id>', `to` is '' | 'dep:<id>' | 'mcp:<id>'. */
interface GateDraft {
  from: string;
  to: string;
  tool?: string | undefined;
}

type Popover =
  | { kind: 'compose'; draft: GateDraft; x: number; y: number }
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

/** Place a side panel near the click, fully on screen; it scrolls if taller than the room left. */
function panelPos(x: number, y: number, h: number): CSSProperties {
  const room = window.innerHeight - 52;
  const top = Math.max(12, Math.min(y - 40, room - h));
  return { left: Math.max(12, Math.min(x, window.innerWidth - 740)), top, maxHeight: room - top - 12 };
}

function alertedGates(rules: AlertRule[]): string[] {
  return rules.filter((r) => r.enabled && r.rule_id).map((r) => r.rule_id!);
}

function destRef(id: string): string {
  const t = useStore.getState().topology;
  return t?.mcp_servers.some((m) => m.id === id) ? `mcp:${id}` : `dep:${id}`;
}

/** Plain-language description of what a gate covers. */
export function describeRule(r: Rule, t: Topology | null, zones: Zone[]): string {
  const m = r.match as { keys?: string[]; deployments?: string[]; mcp_servers?: string[]; tools?: string[] };
  const keyName = (id: string) => t?.keys.find((k) => k.id === id)?.name ?? id;
  const depName = (id: string) => {
    const d = t?.deployments.find((x) => x.id === id);
    return d?.public_name ?? d?.upstream_model ?? id;
  };
  const mcpName = (id: string) => t?.mcp_servers.find((x) => x.id === id)?.name ?? id;
  const zoneName = (id: string) => zones.find((z) => z.id === id)?.name ?? id;
  const from = m.keys?.length ? m.keys.map(keyName).join(', ') : r.from_zone ? `${zoneName(r.from_zone)} agents` : 'any agent';
  let to = 'anything';
  if (m.deployments?.length) to = m.deployments.map(depName).join(', ');
  else if (m.mcp_servers?.length) to = m.mcp_servers.map(mcpName).join(', ');
  else if (r.to_zone) to = zoneName(r.to_zone);
  if (m.tools?.length) to += ` → ${m.tools.map((x) => x.split('__').pop()).join(', ')}`;
  return `${from} → ${to}`;
}

export function AirspacePage() {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<AirspaceScene | null>(null);
  const topology = useStore((s) => s.topology);
  const policy = useStore((s) => s.policy);
  const alertRules = useStore((s) => s.alertRules);
  const alertChannels = useStore((s) => s.alertChannels);
  const approvals = useStore((s) => s.approvals);
  const counters = useStore((s) => s.counters);
  const feed = useStore((s) => s.feed);
  const wsState = useStore((s) => s.wsState);
  const refreshPolicy = useStore((s) => s.refreshPolicy);
  const refreshApprovals = useStore((s) => s.refreshApprovals);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [stats, setStats] = useState({ active: 0, stations: 0, held: 0 });
  const [drawMode, setDrawMode] = useState(false);
  const [gateMode, setGateMode] = useState(false);
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
          } else if (c.kind === 'lane') {
            setPopover({ kind: 'compose', draft: c.stationKind === 'agent' ? { from: `key:${c.stationId}`, to: '' } : { from: 'all', to: destRef(c.stationId) }, x: c.x, y: c.y });
          } else if (c.kind === 'tool') {
            setPopover({ kind: 'compose', draft: { from: 'all', to: `mcp:${c.serverId}`, tool: c.tool }, x: c.x, y: c.y });
          } else if (c.kind === 'connect') {
            setPopover({ kind: 'compose', draft: { from: `key:${c.agentId}`, to: destRef(c.destId), tool: c.tool }, x: c.x, y: c.y });
          } else if (c.kind === 'context') {
            setPopover({ kind: 'compose', draft: c.stationKind === 'agent' ? { from: `key:${c.stationId}`, to: '' } : { from: 'all', to: destRef(c.stationId) }, x: c.x, y: c.y });
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
        scene.setAlertedGates(alertedGates(st.alertRules));
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
    sceneRef.current?.setAlertedGates(alertedGates(alertRules));
  }, [alertRules]);
  const [exportOpen, setExportOpen] = useState(false);
  const downloadMap = async () => {
    setExportOpen(false);
    const scene = sceneRef.current;
    if (!scene) return;
    const now = new Date();
    const t = useStore.getState().topology;
    const sub = `${now.toLocaleString()} · ${t?.keys.length ?? 0} agents · ${t?.deployments.length ?? 0} models · ${t?.mcp_servers.length ?? 0} tool servers · ${policy?.rules.length ?? 0} gates`;
    const blob = await scene.exportPng('Control Tower · agent data-flow map', sub);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `controltower-map-${now.toISOString().slice(0, 10)}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  const showSimulation = useCallback((r: SimResult | null) => sceneRef.current?.setSimulation(r ? r.lanes : null), []);
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
    setGateMode(false);
    if (sceneRef.current) {
      sceneRef.current.drawMode = next;
      sceneRef.current.gateMode = false;
    }
    setPopover(null);
  };
  const toggleGate = () => {
    const next = !gateMode;
    setGateMode(next);
    setDrawMode(false);
    if (sceneRef.current) {
      sceneRef.current.gateMode = next;
      sceneRef.current.drawMode = false;
    }
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
        <button className={`btn ${gateMode ? 'active' : ''}`} onClick={toggleGate} title="Drag from an agent to a model, tool server or tool to put a gate on that path">
          Add gate
        </button>
        <button className={`btn ${drawMode ? 'active' : ''}`} onClick={toggleDraw} title="Drag a lasso around stations to create a zone">
          Draw zone
        </button>
        <div className="menu-wrap">
          <button className={`btn ${exportOpen ? 'active' : ''}`} onClick={() => setExportOpen((v) => !v)} aria-haspopup="menu" aria-expanded={exportOpen}>
            Export
          </button>
          {exportOpen && (
            <div className="menu" role="menu" onMouseLeave={() => setExportOpen(false)}>
              <button role="menuitem" onClick={() => void downloadMap()}>
                <b>Map image</b>
                <span>PNG of the whole map, for docs and reviews</span>
              </button>
              <a role="menuitem" href="#/report" onClick={() => setExportOpen(false)}>
                <b>Data-flow inventory</b>
                <span>Every path, its volume and the gates on it — printable</span>
              </a>
              <a role="menuitem" href="/admin/api/export/dataflow?format=md" download onClick={() => setExportOpen(false)}>
                <b>Inventory as Markdown</b>
                <span>For a wiki or a pull request</span>
              </a>
              <a role="menuitem" href="/admin/api/export/dataflow?format=csv" download onClick={() => setExportOpen(false)}>
                <b>Paths as CSV</b>
                <span>For a spreadsheet</span>
              </a>
            </div>
          )}
        </div>
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
      {gateMode && (
        <div className="mode-banner">
          Drag from an agent to a model, tool server or a single tool to gate that path · or click any line or tool row
        </div>
      )}

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

      {popover?.kind === 'compose' && topology && (
        <GateComposer
          x={popover.x}
          y={popover.y}
          draft={popover.draft}
          topology={topology}
          zones={policy?.zones ?? []}
          channels={alertChannels}
          onSimulate={showSimulation}
          onClose={() => setPopover(null)}
          onCreated={() => {
            setPopover(null);
            void refreshPolicy();
          }}
        />
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
          desc={describeRule(policy.rules.find((r) => r.id === popover.rule.id) ?? popover.rule, topology, policy.zones)}
          zones={policy.zones}
          stats={policy.rule_stats[popover.rule.id]}
          alerts={alertRules.filter((a) => a.rule_id === popover.rule.id)}
          channels={alertChannels}
          onSimulate={showSimulation}
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
        <span>
          <em className="gate inspect" /> inspect gate
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

function GatePopover({ x, y, rule, desc, stats, alerts, channels, onClose, onChanged, onSimulate }: { x: number; y: number; rule: Rule; desc: string; zones: Zone[]; stats: { approved: number; denied: number } | undefined; alerts: AlertRule[]; channels: AlertChannel[]; onClose: () => void; onChanged: () => void; onSimulate: (r: SimResult | null) => void }) {
  const [alertForm, setAlertForm] = useState<AlertRule | 'new' | null>(null);
  const [sim, setSim] = useState<SimResult | null>(null);
  const [simBusy, setSimBusy] = useState(false);
  const [simErr, setSimErr] = useState<string | null>(null);
  const [inspect, setInspect] = useState<InspectConfig>(rule.effect === 'inspect' ? { detectors: rule.config.detectors, keywords: rule.config.keywords, patterns: rule.config.patterns, action: rule.config.action ?? 'flag', direction: rule.config.direction ?? 'both' } : DEFAULT_INSPECT);
  const [effect, setEffect] = useState<Rule['effect']>(rule.effect);
  const [reason, setReason] = useState(rule.config.reason ?? '');
  const [hold, setHold] = useState(String(Math.round((rule.config.hold_ms ?? 20000) / 1000)));
  const total = (stats?.approved ?? 0) + (stats?.denied ?? 0);
  const rate = total ? (stats!.approved / total) * 100 : null;
  const save = async () => {
    await api.patch(`/admin/api/rules/${rule.id}`, { effect, config: { reason: reason || undefined, hold_ms: Math.max(0, Number(hold)) * 1000, ...(effect === 'inspect' ? inspect : {}) } });
    onChanged();
    onClose();
  };
  const toggle = async () => {
    await api.patch(`/admin/api/rules/${rule.id}`, { enabled: !rule.enabled });
    onChanged();
  };
  const changed = effect !== rule.effect;
  useEffect(() => () => onSimulate(null), [onSimulate]);
  useEffect(() => {
    setSim(null);
    onSimulate(null);
  }, [effect, onSimulate]);
  const runSimulation = async () => {
    setSimBusy(true);
    setSimErr(null);
    try {
      const body = changed ? { rule: { effect, config: { hold_ms: Math.max(0, Number(hold)) * 1000 } }, replace_rule_id: rule.id, hours: 24 } : { impact_of_rule_id: rule.id, hours: 24 };
      const r = await api.post<SimResult>('/admin/api/policy/simulate', body);
      setSim(r);
      onSimulate(r);
    } catch (e) {
      setSimErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSimBusy(false);
    }
  };
  const remove = async () => {
    if (!confirm(`Delete gate "${rule.name}"?`)) return;
    await api.del(`/admin/api/rules/${rule.id}`);
    onChanged();
    onClose();
  };
  return (
    <div className="popover composer" style={panelPos(x, y, 560)}>
      <div className="t">{rule.name}</div>
      <div className="hint" style={{ marginBottom: 8 }}>
        {desc}
        {rule.demo ? ' · demo' : ''}
      </div>
      <div className="field">
        <label>Effect</label>
        <select className="input" value={effect} onChange={(e) => setEffect(e.target.value as Rule['effect'])}>
          <option value="allow">allow (open gate)</option>
          <option value="deny">deny (barrier)</option>
          <option value="require_approval">require approval (checkpoint)</option>
          <option value="inspect">inspect content (guardrail)</option>
        </select>
      </div>
      {effect === 'require_approval' && (
        <div className="field">
          <label>Hold the request up to (seconds) before issuing a ticket</label>
          <input className="input" type="number" min={0} max={55} value={hold} onChange={(e) => setHold(e.target.value)} />
        </div>
      )}
      {effect === 'inspect' && <InspectFields value={inspect} onChange={setInspect} />}
      <div className="field">
        <label>Reason shown to the agent</label>
        <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why this gate exists" />
      </div>
      {effect !== 'inspect' && (
        <div className="gate-sim">
          <button className="btn sm" disabled={simBusy} onClick={() => void runSimulation()}>
            {simBusy ? 'Replaying…' : changed ? 'Simulate this change on last 24 h' : 'Impact in the last 24 h'}
          </button>
          {sim && <SimulationView r={sim} mode={changed ? 'draft' : 'impact'} />}
          {simErr && <div className="error">{simErr}</div>}
        </div>
      )}
      <GateAlerts rule={{ ...rule, effect }} alerts={alerts} channels={channels} form={alertForm} setForm={setAlertForm} />
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

function GateAlerts({ rule, alerts, channels, form, setForm }: { rule: Rule; alerts: AlertRule[]; channels: AlertChannel[]; form: AlertRule | 'new' | null; setForm: (f: AlertRule | 'new' | null) => void }) {
  const refresh = useStore((s) => s.refreshAlerts);
  const labels: Record<string, string> = { blocked: 'blocked', held: 'held', approved: 'approved', rejected: 'rejected', unanswered: 'not answered', allowed: 'allowed', scope_mismatch: 'approval misused' };
  const remove = async (a: AlertRule) => {
    await api.del(`/admin/api/alert-rules/${a.id}`);
    void refresh();
  };
  const toggle = async (a: AlertRule) => {
    await api.patch(`/admin/api/alert-rules/${a.id}`, { enabled: !a.enabled });
    void refresh();
  };
  return (
    <div className="gate-alerts">
      <div className="gh">
        <BellIcon size={13} /> Alerts
      </div>
      {form === null && alerts.length === 0 && <div className="hint" style={{ marginBottom: 6 }}>Nobody is told when this gate triggers.</div>}
      {form === null &&
        alerts.map((a) => (
          <div key={a.id} className={`ar ${a.enabled ? '' : 'off'}`}>
            <div className="txt">
              <b>{a.triggers.map((t) => labels[t] ?? t).join(', ')}</b> · {conditionText(a)}
              <br />
              {notifyText(a, channels)}
            </div>
            <button className="btn sm ghost" onClick={() => setForm(a)}>
              Edit
            </button>
            <button className="btn sm ghost" onClick={() => void toggle(a)}>
              {a.enabled ? 'Pause' : 'Resume'}
            </button>
            <button className="btn sm ghost danger-text" aria-label="Remove alert" onClick={() => void remove(a)}>
              ×
            </button>
          </div>
        ))}
      {form === null && (
        <button className="btn sm" onClick={() => setForm('new')}>
          Add alert
        </button>
      )}
      {form !== null && <AlertRuleForm compact gate={rule} gates={[]} channels={channels} existing={form === 'new' ? undefined : form} onDone={() => setForm(null)} onCancel={() => setForm(null)} />}
    </div>
  );
}

export interface SimResult {
  window_hours: number;
  considered: number;
  changed: { to_deny: number; to_hold: number; to_allow: number };
  cost_avoided_nanousd: number;
  agents: Array<{ key_id: string; name: string; deny: number; hold: number; allow: number }>;
  destinations: Array<{ id: string; name: string; deny: number; hold: number; allow: number }>;
  lanes: Array<{ key_id: string; target_id: string; deny: number; hold: number; allow: number }>;
  samples: Array<{ ts: number; agent: string; destination: string; before: string; after: string }>;
  notes: string[];
}

/** What a draft gate would have done — or what an existing gate did — to recorded traffic. */
function SimulationView({ r, mode = 'draft' }: { r: SimResult; mode?: 'draft' | 'impact' }) {
  const { to_deny, to_hold, to_allow } = r.changed;
  const none = to_deny + to_hold + to_allow === 0;
  const would = mode === 'draft';
  const list = (xs: Array<{ name: string; deny: number; hold: number; allow: number }>) =>
    xs
      .slice(0, 4)
      .map((x) => `${x.name} ${x.deny + x.hold + x.allow}`)
      .join(' · ');
  return (
    <div className="sim">
      <div className="sim-h">
        {would ? 'Replayed' : 'In'} the last {r.window_hours} h · {r.considered.toLocaleString('en-US')} requests{would ? '' : ' checked'}
      </div>
      {none ? (
        <div className="sim-none">{would ? 'No recorded request would have been treated differently.' : 'This gate did not change the outcome of any recorded request — a broader gate or no traffic covers this path.'}</div>
      ) : (
        <>
          <div className="sim-big">
            {to_deny > 0 && <span className="d">{to_deny.toLocaleString('en-US')} {would ? 'would be blocked' : 'blocked'}</span>}
            {to_hold > 0 && <span className="h">{to_hold.toLocaleString('en-US')} {would ? 'would wait for approval' : 'held for approval'}</span>}
            {to_allow > 0 && <span className="a">{to_allow.toLocaleString('en-US')} {would ? 'would be let through' : 'let through'}</span>}
          </div>
          {r.cost_avoided_nanousd > 0 && <div className="dim">{formatUsd(r.cost_avoided_nanousd)} of spend {would ? 'would not have happened' : 'was stopped'}.</div>}
          {r.agents.length > 0 && <div className="dim">Agents: {list(r.agents)}</div>}
          {r.destinations.length > 0 && <div className="dim">Targets: {list(r.destinations)}</div>}
          <div className="dim">Affected paths are highlighted on the map.</div>
        </>
      )}
      {r.notes.map((n, i) => (
        <div key={i} className="hint">
          {n}
        </div>
      ))}
    </div>
  );
}

let detectorCache: DetectorInfo[] | null = null;
function useDetectors(): DetectorInfo[] {
  const [d, setD] = useState<DetectorInfo[]>(detectorCache ?? []);
  useEffect(() => {
    if (detectorCache) return;
    void api.get<{ detectors: DetectorInfo[] }>('/admin/api/guardrails/detectors').then((r) => {
      detectorCache = r.detectors;
      setD(r.detectors);
    });
  }, []);
  return d;
}

export const DEFAULT_INSPECT: InspectConfig = { detectors: ['secrets'], action: 'block', direction: 'input' };

export function inspectSummary(c: InspectConfig): string {
  const ids = c.detectors ?? [];
  const what = [
    ids.includes('secrets') ? 'secrets' : '',
    ids.includes('injection') ? 'prompt injection' : '',
    ids.some((d) => d !== 'secrets' && d !== 'injection') || ids.includes('pii') ? 'personal data' : '',
    c.keywords?.length ? 'keywords' : '',
  ].filter(Boolean);
  const verb = c.action === 'mask' ? 'mask' : c.action === 'block' ? 'block' : 'flag';
  const where = c.direction === 'input' ? 'in what agents send' : c.direction === 'output' ? 'in what comes back' : 'both ways';
  return `${verb} ${what.join(', ') || 'nothing yet'} ${where}`;
}

function InspectFields({ value, onChange }: { value: InspectConfig; onChange: (v: InspectConfig) => void }) {
  const detectors = useDetectors();
  const ids = value.detectors ?? [];
  const pii = detectors.filter((d) => d.category === 'pii');
  const has = (id: string) => ids.includes(id);
  const toggle = (id: string) => onChange({ ...value, detectors: has(id) ? ids.filter((x) => x !== id) : [...ids, id] });
  const [kw, setKw] = useState((value.keywords ?? []).join(', '));
  return (
    <div className="inspect-fields">
      <div className="field">
        <label>Look for</label>
        <label className="check">
          <input type="checkbox" checked={has('secrets')} onChange={() => toggle('secrets')} /> Secrets & credentials
          <span className="dim">API keys, tokens, private keys, connection strings</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={has('injection')} onChange={() => toggle('injection')} /> Prompt injection
          <span className="dim">Instructions hidden in tool results and documents</span>
        </label>
        <div className="dim" style={{ margin: '4px 0 4px' }}>Personal data</div>
        <div className="chips">
          {pii.map((d) => (
            <button key={d.id} type="button" className={`chip warn ${has(d.id) ? 'on' : ''}`} onClick={() => toggle(d.id)}>
              {d.label}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <label>Keywords (optional, comma-separated)</label>
        <input
          className="input"
          value={kw}
          placeholder="Project Falcon, acquisition"
          onChange={(e) => {
            setKw(e.target.value);
            onChange({ ...value, keywords: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) });
          }}
        />
      </div>
      <div className="field">
        <label>When found</label>
        <div className="seg">
          {(['mask', 'block', 'flag'] as const).map((a) => (
            <button key={a} type="button" className={value.action === a ? 'on' : ''} onClick={() => onChange({ ...value, action: a })}>
              {a === 'mask' ? 'Mask it' : a === 'block' ? 'Block' : 'Flag only'}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <label>Check</label>
        <div className="seg">
          {(['input', 'output', 'both'] as const).map((d) => (
            <button key={d} type="button" className={value.direction === d ? 'on' : ''} onClick={() => onChange({ ...value, direction: d })}>
              {d === 'input' ? 'What agents send' : d === 'output' ? 'What comes back' : 'Both'}
            </button>
          ))}
        </div>
        {value.direction !== 'input' && <div className="hint">Tool results and complete model replies are checked before the agent sees them. Streamed model replies can only be checked after delivery, so there a match is flagged.</div>}
      </div>
    </div>
  );
}

const EFFECTS: Array<{ id: Rule['effect']; label: string; hint: string; cls: string }> = [
  { id: 'deny', label: 'Block', hint: 'Requests on this path are refused with a 403 the agent can read.', cls: 'deny' },
  { id: 'require_approval', label: 'Require approval', hint: 'Requests wait at the gate until someone approves in the Tower.', cls: 'hold' },
  { id: 'inspect', label: 'Inspect', hint: 'Scan what passes for secrets, personal data or prompt injection — mask it, block it, or flag it. Runs alongside the other gates.', cls: 'inspect' },
  { id: 'allow', label: 'Allow', hint: 'Explicitly allow this path (takes precedence over broader gates below it).', cls: 'allow' },
];

function GateComposer({ x, y, draft, topology, zones, channels, onClose, onCreated, onSimulate }: { x: number; y: number; draft: GateDraft; topology: Topology; zones: Zone[]; channels: AlertChannel[]; onClose: () => void; onCreated: () => void; onSimulate: (r: SimResult | null) => void }) {
  const [notify, setNotify] = useState(false);
  const [inspect, setInspect] = useState<InspectConfig>(DEFAULT_INSPECT);
  const [notifyChannels, setNotifyChannels] = useState<string[]>(channels.filter((c) => c.enabled).map((c) => c.id));
  const [from, setFrom] = useState(draft.from);
  const [to, setTo] = useState(draft.to);
  const [tool, setTool] = useState(draft.tool ?? '');
  const [effect, setEffect] = useState<Rule['effect']>('require_approval');
  const [reason, setReason] = useState('');
  const [hold, setHold] = useState('20');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const server = to.startsWith('mcp:') ? topology.mcp_servers.find((m) => m.id === to.slice(4)) : undefined;
  const agentLabel = from === 'all' ? 'Any agent' : from.startsWith('zone:') ? `${zones.find((z) => z.id === from.slice(5))?.name ?? '?'} agents` : (topology.keys.find((k) => k.id === from.slice(4))?.name ?? '?');
  const destLabel = !to
    ? 'anything'
    : to.startsWith('mcp:')
      ? `${server?.name ?? '?'}${tool ? ` → ${tool}` : ''}`
      : (() => {
          const d = topology.deployments.find((x) => x.id === to.slice(4));
          return d?.public_name ?? d?.upstream_model ?? '?';
        })();
  const verb = effect === 'deny' ? 'Block' : effect === 'require_approval' ? 'Require approval for' : effect === 'inspect' ? 'Inspect' : 'Allow';
  const sentence = effect === 'inspect' ? `Inspect ${agentLabel} → ${destLabel}: ${inspectSummary(inspect)}` : `${verb} ${agentLabel} → ${destLabel}`;

  const [sim, setSim] = useState<SimResult | null>(null);
  const [simBusy, setSimBusy] = useState(false);
  useEffect(() => () => onSimulate(null), [onSimulate]);
  // Any change to the draft makes a shown simulation stale.
  useEffect(() => {
    setSim(null);
    onSimulate(null);
  }, [from, to, tool, effect, onSimulate]);

  const buildBody = (): { body?: Record<string, unknown>; error?: string } => {
    if (from === 'all' && !to && effect !== 'inspect') return { error: 'Pick an agent or a destination — a gate on everything would stop all traffic.' };
    const match: Record<string, unknown> = {};
    const body: Record<string, unknown> = { name: sentence, effect, priority: 5, target_kind: 'any' };
    if (from.startsWith('key:')) match.keys = [from.slice(4)];
    if (from.startsWith('zone:')) body.from_zone = from.slice(5);
    if (to.startsWith('dep:')) {
      match.deployments = [to.slice(4)];
      body.target_kind = 'model';
    }
    if (to.startsWith('mcp:')) {
      match.mcp_servers = [to.slice(4)];
      body.target_kind = 'tool';
      if (tool && server) match.tools = [`${server.slug}__${tool}`];
    }
    body.match = match;
    const config: Record<string, unknown> = {};
    if (reason.trim()) config.reason = reason.trim();
    if (effect === 'require_approval') config.hold_ms = Math.max(0, Math.min(55, Number(hold) || 0)) * 1000;
    if (effect === 'inspect') {
      if (!(inspect.detectors?.length || inspect.keywords?.length)) return { error: 'Pick at least one thing to look for.' };
      Object.assign(config, inspect);
    }
    body.config = config;
    return { body };
  };

  const runSimulation = async () => {
    const { body, error } = buildBody();
    if (!body) {
      setErr(error ?? null);
      return;
    }
    setSimBusy(true);
    setErr(null);
    try {
      const r = await api.post<SimResult>('/admin/api/policy/simulate', { rule: body, hours: 24 });
      setSim(r);
      onSimulate(r);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSimBusy(false);
    }
  };

  const create = async () => {
    const { body, error } = buildBody();
    if (!body) {
      setErr(error ?? null);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const created = await api.post<{ id: string }>('/admin/api/rules', body);
      if (notify) {
        await api.post('/admin/api/alert-rules', { rule_id: created.id, triggers: defaultTriggers(effect), threshold: 1, cooldown_s: 300, channels: notifyChannels });
        void useStore.getState().refreshAlerts();
      }
      onCreated();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="popover composer" style={panelPos(x, y, 600)}>
      <div className="t">New gate</div>
      <div className="field">
        <label>From</label>
        <select className="input" value={from} onChange={(e) => setFrom(e.target.value)}>
          <option value="all">Any agent</option>
          {zones.length > 0 && (
            <optgroup label="Zones">
              {zones.map((z) => (
                <option key={z.id} value={`zone:${z.id}`}>
                  {z.name}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="Agents">
            {topology.keys.map((k) => (
              <option key={k.id} value={`key:${k.id}`}>
                {k.name}
              </option>
            ))}
          </optgroup>
        </select>
      </div>
      <div className="field">
        <label>To</label>
        <select
          className="input"
          value={to}
          onChange={(e) => {
            setTo(e.target.value);
            setTool('');
          }}
        >
          <option value="">Anything</option>
          <optgroup label="Models">
            {topology.deployments.map((d) => (
              <option key={d.id} value={`dep:${d.id}`}>
                {d.public_name ?? d.upstream_model}
              </option>
            ))}
          </optgroup>
          {topology.mcp_servers.length > 0 && (
            <optgroup label="MCP servers">
              {topology.mcp_servers.map((m) => (
                <option key={m.id} value={`mcp:${m.id}`}>
                  {m.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </div>
      {server && (
        <div className="field">
          <label>Tool</label>
          <select className="input" value={tool} onChange={(e) => setTool(e.target.value)}>
            <option value="">Any tool on {server.name}</option>
            {server.tools.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
                {t.op === 'admin' ? ' (destructive)' : t.op === 'write' ? ' (write)' : t.op === 'read' ? ' (read)' : ''}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="field">
        <label>Effect</label>
        <div className="effects">
          {EFFECTS.map((e) => (
            <button key={e.id} type="button" className={`effect ${e.cls} ${effect === e.id ? 'on' : ''}`} onClick={() => setEffect(e.id)}>
              {e.label}
            </button>
          ))}
        </div>
        <div className="hint" style={{ marginTop: 6 }}>{EFFECTS.find((e) => e.id === effect)!.hint}</div>
      </div>
      {effect === 'require_approval' && (
        <div className="field">
          <label>Hold the request up to (seconds) before issuing a ticket</label>
          <input className="input" type="number" min={0} max={55} value={hold} onChange={(e) => setHold(e.target.value)} />
        </div>
      )}
      {effect === 'inspect' && <InspectFields value={inspect} onChange={setInspect} />}
      <div className="field">
        <label>Reason shown to the agent (optional)</label>
        <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why this gate exists" />
      </div>
      <div className="field">
        <label className="check">
          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Alert me when this gate {effect === 'deny' ? 'blocks something' : effect === 'require_approval' ? 'holds a request' : effect === 'inspect' ? 'finds something' : 'lets something through'}
        </label>
        {notify &&
          channels.map((c) => (
            <label key={c.id} className="check" style={{ marginLeft: 22 }}>
              <input type="checkbox" checked={notifyChannels.includes(c.id)} onChange={() => setNotifyChannels(notifyChannels.includes(c.id) ? notifyChannels.filter((x) => x !== c.id) : [...notifyChannels, c.id])} /> {c.name}
            </label>
          ))}
        {notify && <div className="hint">Console inbox{channels.length ? ' plus the channels ticked above' : ''}; at most one alert per 5 min, the rest summarised. Fine-tune it by clicking the gate later.</div>}
      </div>
      <div className="summary">{sentence}</div>
      {sim && <SimulationView r={sim} />}
      {err && <div className="error" style={{ marginBottom: 8 }}>{err}</div>}
      <div className="row">
        <button className="btn sm primary" disabled={busy} onClick={() => void create()}>
          {busy ? 'Adding…' : 'Add gate'}
        </button>
        {effect !== 'inspect' && (
          <button className="btn sm" disabled={simBusy} onClick={() => void runSimulation()} title="Replay the last 24 hours of traffic through this gate">
            {simBusy ? 'Simulating…' : sim ? 'Simulate again' : 'Simulate on last 24 h'}
          </button>
        )}
        <button className="btn sm ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
