import { useCallback, useEffect, useRef, useState } from 'react';
import { formatUsd } from '@controltower/shared';
import { useStore } from '../store';
import { onFlightEvent, onLiveTick } from '../ws';
import { AirspaceScene, type AgentLevel, type ClickInfo, type FocusSummary, type HoverInfo } from '../airspace/scene';
import { agentGroups, agentRef } from '../airspace/groups';
import { api, ApiError, type AirspaceView, type Rule, type Topology, type Zone } from '../api';
import { Icon } from '../components/Icon';
import { ApprovalCard } from './Tower';
import { type GateDraft, alertedGates, destRef, describeRule } from './airspace/shared';
import { BringInside, GettingStarted, Tooltip, FocusPanel, ZoneCreatePopover, ZonePopover } from './airspace/panels';
import { GatePopover, type SimResult, GateComposer } from './airspace/gates';
import { PolicyImport } from './airspace/PolicyImport';
import type { FlightEvent } from '@controltower/shared';
import { ReplayBar } from './airspace/Replay';
import { MapSearch } from './airspace/MapSearch';
import { ViewEditor } from './airspace/ViewEditor';
import { AttentionPanel, type Attention } from './airspace/Attention';

const LEVEL_KEY = 'ct.airspace.level';

type Popover =
  | { kind: 'compose'; draft: GateDraft; x: number; y: number }
  | { kind: 'lasso'; stationIds: string[]; x: number; y: number }
  | { kind: 'zone'; zone: Zone; x: number; y: number }
  | { kind: 'gate'; rule: Rule; x: number; y: number }
  | { kind: 'bringin'; stationId: string; rect: [number, number, number, number] };

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
  // The approvals drawer starts closed (the toolbar shows the count); the choice is remembered.
  const demoOn = useStore((st) => st.status?.demo ?? false);
  const [showTower, setShowTowerState] = useState(() => {
    try {
      return localStorage.getItem('ct.airspace.tower') === '1';
    } catch {
      return false;
    }
  });
  const setShowTower = (v: boolean | ((x: boolean) => boolean)) =>
    setShowTowerState((prev) => {
      const next = typeof v === 'function' ? v(prev) : v;
      try {
        localStorage.setItem('ct.airspace.tower', next ? '1' : '0');
      } catch {
        /* private mode */
      }
      return next;
    });
  const [error, setError] = useState<string | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [focus, setFocus] = useState<FocusSummary | null>(null);
  const focusRef = useRef<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [customLayout, setCustomLayout] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const cameraReady = useRef(false);
  // A view (#/airspace/<id>) shows one part of the organization: its teams' agents, what they reach, its own traffic.
  const routeParam = useStore((s) => s.routeParam);
  const setRoute = useStore((s) => s.setRoute);
  const view = (routeParam && topology?.views?.find((v) => v.id === routeParam)) || null;
  const viewRef = useRef<AirspaceView | null>(null);
  viewRef.current = view;
  const [viewCounters, setViewCounters] = useState({ flights: 0, errors: 0, denied: 0, cost_nanousd: 0 });
  const [editing, setEditing] = useState<AirspaceView | 'new' | null>(null);
  // What needs a person, recomputed every second; the panel lights those stations and dims the rest.
  const [attention, setAttention] = useState<Attention>({ items: [], busiest: [] });
  const [attentionOpen, setAttentionOpenState] = useState(false);
  const attentionOpenRef = useRef(false);
  const setAttentionOpen = (v: boolean) => {
    attentionOpenRef.current = v;
    setAttentionOpenState(v);
    const sc = sceneRef.current;
    if (!sc) return;
    if (v) {
      const a = sc.attention();
      setAttention(a);
      sc.setHighlight(a.items.flatMap((i) => (i.also ? [i.stationId, i.also] : [i.stationId])));
    } else sc.setHighlight(null);
  };
  useEffect(() => {
    if (routeParam === 'new') setEditing('new');
  }, [routeParam]);
  // Teams or agents; 'auto' (the default) draws teams once a fleet has more agents than fit.
  const [level, setLevelInfo] = useState<{ level: AgentLevel; pref: AgentLevel | 'auto'; teams: number }>({ level: 'agents', pref: 'auto', teams: 0 });
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
        scene.setScope(viewRef.current?.teams ?? null);
        try {
          const v = localStorage.getItem(LEVEL_KEY);
          if (v === 'teams' || v === 'agents') scene.setLevel(v);
        } catch {
          /* private mode */
        }
        scene.onLevelChange(() => {
          setLevelInfo(scene.getLevel());
          // The traced station may have been folded into a team, or opened out of one.
          if (focusRef.current && !scene.focusSummary(focusRef.current)) applyFocus(null);
        });
        (window as unknown as { __ctScene?: AirspaceScene }).__ctScene = scene;
        scene.onHover(setHover);
        scene.onClick((c: ClickInfo) => {
          if (c.kind === 'lasso') {
            setDrawMode(false);
            scene.drawMode = false;
            if (c.stationIds.length) setPopover({ kind: 'lasso', stationIds: c.stationIds, x: c.x, y: c.y });
            else setPopover(null);
          } else if (c.kind === 'station' && c.station.kind === 'observed') {
            // Outside the gateway: show how to bring it in, and trace who calls it.
            setPopover({ kind: 'bringin', stationId: c.station.id, rect: c.rect });
            applyFocus(c.station.id);
          } else if (c.kind === 'station') {
            setPopover(null);
            applyFocus(focusRef.current === c.station.id ? null : c.station.id);
          } else if (c.kind === 'lane') {
            setPopover({ kind: 'compose', draft: c.stationKind === 'agent' ? { from: agentRef(c.stationId), to: '' } : { from: 'all', to: destRef(c.stationId) }, x: c.x, y: c.y });
          } else if (c.kind === 'tool') {
            setPopover({ kind: 'compose', draft: { from: 'all', to: `mcp:${c.serverId}`, tool: c.tool }, x: c.x, y: c.y });
          } else if (c.kind === 'connect') {
            setPopover({ kind: 'compose', draft: { from: agentRef(c.agentId), to: destRef(c.destId), tool: c.tool }, x: c.x, y: c.y });
          } else if (c.kind === 'context') {
            setPopover({ kind: 'compose', draft: c.stationKind === 'agent' ? { from: agentRef(c.stationId), to: '' } : { from: 'all', to: destRef(c.stationId) }, x: c.x, y: c.y });
          } else if (c.kind === 'zone') setPopover({ kind: 'zone', zone: c.zone, x: c.x, y: c.y });
          else if (c.kind === 'gate') setPopover({ kind: 'gate', rule: c.rule, x: c.x, y: c.y });
          else {
            setPopover(null);
            applyFocus(null);
          }
        });
        const st = useStore.getState();
        if (st.topology) scene.setTopology(st.topology);
        setLevelInfo(scene.getLevel());
        if (st.policy) scene.setPolicy(st.policy);
        scene.setAlertedGates(alertedGates(st.alertRules));
        try {
          const v = localStorage.getItem('ct.airspace.layer');
          if (v === 'active' || v === 'gateway' || v === 'outside') scene.setLayer(v);
        } catch {
          /* private mode */
        }
        // While replaying, the map shows the recording; live events wait.
        const unsubEvents = onFlightEvent((e) => {
          if (!replayingRef.current) scene.handle(e, false);
        });
        const unsubTicks = onLiveTick((t) => {
          if (replayingRef.current) return;
          const mine = scene.ingestTick(t);
          if (viewRef.current && (mine.flights || mine.errors || mine.denied || mine.cost_nanousd))
            setViewCounters((c) => ({ flights: c.flights + mine.flights, errors: c.errors + mine.errors, denied: c.denied + mine.denied, cost_nanousd: c.cost_nanousd + mine.cost_nanousd }));
        });
        unsub = () => {
          unsubEvents();
          unsubTicks();
        };

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
      const a = sc.attention();
      setAttention(a);
      if (attentionOpenRef.current) sc.setHighlight(a.items.flatMap((i) => (i.also ? [i.stationId, i.also] : [i.stationId])));
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
      setLevelInfo(sceneRef.current.getLevel());
      if (focusRef.current) setFocus(sceneRef.current.focusSummary(focusRef.current));
    }
  }, [topology]);
  useEffect(() => {
    if (policy && sceneRef.current) sceneRef.current.setPolicy(policy);
  }, [policy]);
  const viewTeams = view?.teams.join('\u0000') ?? null;
  useEffect(() => {
    // Counters in a view start when the view is opened.
    setViewCounters({ flights: 0, errors: 0, denied: 0, cost_nanousd: 0 });
    const scene = sceneRef.current;
    if (!scene) return;
    scene.setScope(viewRef.current?.teams ?? null);
    setLevelInfo(scene.getLevel());
    if (focusRef.current && !scene.focusSummary(focusRef.current)) applyFocus(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewTeams]);
  useEffect(() => {
    sceneRef.current?.setAlertedGates(alertedGates(alertRules));
  }, [alertRules]);
  const [exportOpen, setExportOpen] = useState(false);
  const [policyImport, setPolicyImport] = useState(false);
  const [replay, setReplay] = useState(false);
  const replayingRef = useRef(false);
  const replayReset = useCallback(() => sceneRef.current?.resetActivity(), []);
  const replayEmit = useCallback((e: FlightEvent) => sceneRef.current?.handle(e), []);
  const startReplay = () => {
    replayingRef.current = true;
    setReplay(true);
  };
  const exitReplay = useCallback(() => {
    replayingRef.current = false;
    setReplay(false);
    const scene = sceneRef.current;
    if (!scene) return;
    scene.resetActivity();
    // Back to live: reseed the last minute of real traffic.
    void useStore.getState().refreshTopology().then(() => {
      const t = useStore.getState().topology;
      if (t) scene.setTopology(t);
    });
  }, []);
  const [layer, setLayerState] = useState<'all' | 'active' | 'gateway' | 'outside'>(() => {
    try {
      const v = localStorage.getItem('ct.airspace.layer');
      return v === 'active' || v === 'gateway' || v === 'outside' ? v : 'all';
    } catch {
      return 'all';
    }
  });
  const setLayer = (v: typeof layer) => {
    setLayerState(v);
    sceneRef.current?.setLayer(v);
    try {
      localStorage.setItem('ct.airspace.layer', v);
    } catch {
      /* private mode */
    }
  };
  const [legendOpen, setLegendOpen] = useState(() => {
    try {
      return localStorage.getItem('ct.airspace.legend') !== '0';
    } catch {
      return true;
    }
  });
  const toggleLegend = () =>
    setLegendOpen((v) => {
      try {
        localStorage.setItem('ct.airspace.legend', v ? '0' : '1');
      } catch {
        /* private mode */
      }
      return !v;
    });
  const downloadMap = async () => {
    setExportOpen(false);
    const scene = sceneRef.current;
    if (!scene) return;
    const now = new Date();
    const t = useStore.getState().topology;
    const sub = `${now.toLocaleString()} · ${agentCount(t)} · ${t?.deployments.length ?? 0} models · ${t?.mcp_servers.length ?? 0} tool servers · ${policy?.rules.length ?? 0} gates`;
    const blob = await scene.exportPng('Control Tower · agent data-flow map', sub);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `controltower-map-${now.toISOString().slice(0, 10)}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  const showSimulation = useCallback((r: SimResult | null) => sceneRef.current?.setSimulation(r ? r.lanes : null), []);
  useEffect(() => {
    sceneRef.current?.setRightInset(showTower || focusId || attentionOpen ? 372 : 0);
  }, [showTower, focusId, attentionOpen, topology, policy]);

  const chooseLevel = (v: AgentLevel) => {
    sceneRef.current?.setLevel(v);
    try {
      localStorage.setItem(LEVEL_KEY, v);
    } catch {
      /* private mode */
    }
  };
  const getScene = useCallback(() => sceneRef.current, []);
  const revealed = useCallback((id: string) => {
    setPopover(null);
    focusRef.current = id;
    setFocusId(id);
    setFocus(sceneRef.current?.focusSummary(id) ?? null);
  }, []);

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
    return s?.kind === 'agent' ? agentRef(id) : s?.kind === 'mcp' ? `mcp:${id}` : `deployment:${id}`;
  };

  const pendingHere = approvals.filter((a) => a.status === 'pending' && (!view || (sceneRef.current?.inScope(a.key_id) ?? true)));
  const shownCounters = view ? viewCounters : counters;

  return (
    <div className="airspace" ref={hostRef} style={{ cursor: drawMode ? 'crosshair' : 'default' }}>
      <div className={`hud ${view ? 'in-view' : ''}`}>
        <div className="hud-strip">
          {view && (
            <div className="seg view-seg" title={`Teams: ${view.teams.join(', ')}`}>
              <div className="label">
                View · {view.teams.length} team{view.teams.length === 1 ? '' : 's'}
              </div>
              <div className="value">
                <i style={{ background: view.color }} />
                <span className="view-name">{view.name}</span>
                <button className="icon-btn sm" onClick={() => setEditing(view)} title="Edit this view" aria-label="Edit view">
                  <Icon name="more" size={14} />
                </button>
                <button className="icon-btn sm" onClick={() => setRoute('airspace')} title="Back to the whole organization" aria-label="Leave view">
                  <Icon name="x" size={13} />
                </button>
              </div>
            </div>
          )}
          <div className="seg">
            <div className="label">Flights</div>
            <div className="value">{shownCounters.flights.toLocaleString()}</div>
          </div>
          <div className="seg">
            <div className="label">Spend</div>
            <div className="value">{formatUsd(shownCounters.cost_nanousd)}</div>
          </div>
          <div className="seg">
            <div className="label">Blocked · errors</div>
            <div className="value" style={{ color: shownCounters.denied + shownCounters.errors ? 'var(--danger)' : undefined }}>
              {shownCounters.denied} · {shownCounters.errors}
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
        <div className="toolgroup" role="toolbar" aria-label="Map tools">
          <button className={gateMode ? 'on' : ''} onClick={toggleGate} title="Drag from an agent to a model, tool server or tool to put a gate on that path" aria-pressed={gateMode}>
            <Icon name="shield" size={15} /> Add gate
          </button>
          <button className={drawMode ? 'on' : ''} onClick={toggleDraw} title="Drag a lasso around stations to create a zone" aria-pressed={drawMode}>
            <Icon name="map" size={15} /> Draw zone
          </button>
        </div>
        <div className="menu-wrap">
          <button className={`btn ${exportOpen ? 'active' : ''}`} onClick={() => setExportOpen((v) => !v)} aria-haspopup="menu" aria-expanded={exportOpen} title="Export" aria-label="Export">
            <Icon name="download" size={15} /> <span className="lbl">Export</span>
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
              <a role="menuitem" href="/admin/api/policy/export" download onClick={() => setExportOpen(false)}>
                <b>Policy as YAML</b>
                <span>Zones and gates as code, for Git and review</span>
              </a>
              <button role="menuitem" onClick={() => { setExportOpen(false); setPolicyImport(true); }}>
                <b>Import policy…</b>
                <span>Apply a policy YAML, with a preview first</span>
              </button>
            </div>
          )}
        </div>
        <button className={`btn ${replay ? 'active' : ''}`} onClick={() => (replay ? exitReplay() : startReplay())} title="Flight Recorder: play past traffic back on the map" aria-label="Replay">
          <Icon name="play" size={15} /> <span className="lbl">Replay</span>
        </button>
        <button
          className={`btn ${attentionOpen && !focusId ? 'active' : ''}`}
          onClick={() => {
            applyFocus(null);
            setShowTower(false);
            setAttentionOpen(!attentionOpen);
          }}
          title="What needs attention on this map: holds, blocks, direct provider calls, ungated destructive tools, new connections, spikes"
          aria-label="Attention"
        >
          <Icon name="activity" size={15} /> <span className="lbl">Attention</span>{' '}
          {attention.items.some((i) => i.severity >= 2) && (
            <span className={`badge ${attention.items.some((i) => i.severity === 3) ? 'alert' : 'warn'}`}>{attention.items.filter((i) => i.severity >= 2).length}</span>
          )}
        </button>
        <button className={`btn ${showTower && !focusId ? 'active' : ''}`} onClick={() => { applyFocus(null); setAttentionOpen(false); setShowTower((v) => !v); }} title="Approvals" aria-label="Approvals">
          <Icon name="tower" size={15} /> <span className="lbl">Approvals</span> {pendingHere.length > 0 && <span className="badge">{pendingHere.length}</span>}
        </button>
      </div>
      {initError && (
        <div className="card" style={{ position: 'absolute', left: '50%', top: '45%', transform: 'translate(-50%,-50%)', maxWidth: 440, zIndex: 6 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>The Airspace could not start</div>
          <div className="hint" style={{ marginBottom: 10 }}>{initError}</div>
          <button className="btn sm" onClick={() => location.reload()}>Reload</button>
        </div>
      )}
      {drawMode && !popover && <div className="mode-banner">Drag a lasso around the stations that belong together</div>}
      {gateMode && !popover && (
        <div className="mode-banner">
          Drag from an agent to a model, tool server or a single tool to gate that path · or click any line or tool row
        </div>
      )}

      {focus ? (
        <FocusPanel summary={focus} onClose={() => applyFocus(null)} onPick={(id) => applyFocus(id)} />
      ) : attentionOpen ? (
        <AttentionPanel
          data={attention}
          onClose={() => setAttentionOpen(false)}
          onPick={(item) => {
            const id = sceneRef.current?.reveal(item.ref, 372);
            if (id) revealed(id);
          }}
          onPickStation={(id) => {
            const got = sceneRef.current?.reveal(`station:${id}`, 372);
            if (got) revealed(got);
          }}
        />
      ) : (
        showTower && (
          <div className="tower-drawer">
            {pendingHere.length === 0 ? (
              <div className="drawer-empty">
                <Icon name="check" size={14} /> Nothing waiting for approval
              </div>
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
      {popover?.kind === 'bringin' && topology && (
        <BringInside
          rect={popover.rect}
          stationId={popover.stationId}
          topology={topology}
          onClose={() => {
            setPopover(null);
            applyFocus(null);
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

      <div className="map-controls" style={{ right: showTower || focusId || attentionOpen ? 388 : 16 }}>
        <MapSearch scene={getScene} onReveal={revealed} panelWidth={372} />
        <span className="sep" />
        {level.teams >= 2 && (
          <>
            <div className="seg sm layer-seg" role="radiogroup" aria-label="Draw agents by">
              {(
                [
                  ['teams', 'Teams', 'One station per team — open a team to see its agents'],
                  ['agents', 'Agents', 'One station per agent (copies of an agent drawn once)'],
                ] as const
              ).map(([id, label, hint]) => (
                <button key={id} role="radio" aria-checked={level.level === id} className={level.level === id ? 'on' : ''} title={hint} onClick={() => chooseLevel(id)}>
                  {label}
                </button>
              ))}
            </div>
            <span className="sep" />
          </>
        )}
        <div className="seg sm layer-seg" role="radiogroup" aria-label="Show connections">
          {(
            [
              ['all', 'All', 'Every connection'],
              ['active', 'Active', 'Only connections with traffic in the last minute'],
              ['gateway', 'Gateway', 'Only traffic through Control Tower'],
              ['outside', 'Outside', 'Only traffic that bypasses Control Tower'],
            ] as const
          ).map(([id, label, hint]) => (
            <button key={id} role="radio" aria-checked={layer === id} className={layer === id ? 'on' : ''} title={hint} onClick={() => setLayer(id)}>
              {label}
            </button>
          ))}
        </div>
        <span className="sep" />
        <button className="btn sm ghost" onClick={() => sceneRef.current?.zoomBy(1 / 1.2)} aria-label="Zoom out">
          −
        </button>
        <span className="zoom">{Math.round(zoom * 100)}%</span>
        <button className="btn sm ghost" onClick={() => sceneRef.current?.zoomBy(1.2)} aria-label="Zoom in">
          +
        </button>
        <span className="sep" />
        <button className="btn sm ghost" onClick={fitView} title="Fit every node on screen">
          Fit
        </button>
        <span
          className="map-help"
          tabIndex={0}
          title="Drag nodes to arrange (saved for everyone) · drag the canvas or scroll to pan · ⌘/Ctrl + scroll to zoom · click a node to trace what it connects to · right-click a node to gate it · click a team's arrow to open it · press / to find anything"
          aria-label="Map controls help"
        >
          ?
        </span>
        {customLayout && (
          <button className="btn sm ghost" onClick={resetLayout}>
            Reset layout
          </button>
        )}
        {saveState !== 'idle' && <span className="save">{saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Layout saved' : 'Save failed'}</span>}
      </div>

      {topology && <GettingStarted topology={topology} rules={policy?.rules.length ?? 0} onGate={() => !gateMode && toggleGate()} demo={demoOn} />}
      <div className={`legend ${legendOpen ? '' : 'closed'}`}>
        <button className="legend-toggle" onClick={toggleLegend} aria-expanded={legendOpen} title={legendOpen ? 'Hide legend' : 'Show legend'}>
          Legend
        </button>
        <span title="Traffic in the last minute">
          <em className="ln active" /> active
        </span>
        <span title="Line thickness is volume: calls in the last minute on a live line, calls in the last day on an idle one, relative to the busiest line on the map">
          <em className="flow" /> busier
        </span>
        <span title="Traffic in the last 24 hours, none in the last minute">
          <em className="ln idle" /> idle
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
        <span title="Gate that blocks">
          <em className="gate deny" /> deny
        </span>
        <span title="Gate that holds calls for a human">
          <em className="gate hold" /> approval
        </span>
        <span title="Gate that scans content">
          <em className="gate inspect" /> inspect
        </span>
        <span title="Reported by SDK or OpenTelemetry; not through the gateway, so gates can't stop it">
          <i className="obs-line" /> observed only
        </span>
        <span className={`pill ${wsState === 'live' ? 'live' : 'warn'}`}>
          <i className="led" /> {wsState}
        </span>
        {policy && !policy.enforcement && <span className="pill warn">enforcement off</span>}
      </div>
      {replay && <ReplayBar emit={replayEmit} reset={replayReset} onExit={exitReplay} />}
      {policyImport && <PolicyImport onClose={() => setPolicyImport(false)} onApplied={() => void refreshPolicy()} />}
      {editing && topology && (
        <ViewEditor
          view={editing === 'new' ? null : editing}
          topology={topology}
          onClose={() => {
            setEditing(null);
            if (routeParam === 'new') setRoute('airspace');
          }}
          onSaved={(v) => {
            setEditing(null);
            void useStore.getState().refreshTopology();
            setRoute('airspace', v?.id ?? null);
          }}
        />
      )}
    </div>
  );
}

/** "60 agents (1,500 keys)" when keys share agent ids, else "12 agents". */
function agentCount(t: Topology | null): string {
  const keys = t?.keys.length ?? 0;
  const groups = t ? agentGroups(t.keys) : new Map();
  const agents = keys - [...groups.values()].reduce((n, ks: unknown[]) => n + ks.length - 1, 0);
  return `${agents.toLocaleString()} agent${agents === 1 ? '' : 's'}${agents < keys ? ` (${keys.toLocaleString()} keys)` : ''}`;
}
