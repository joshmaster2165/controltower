import { useEffect, useRef, useState } from 'react';
import { formatUsd } from '@controltower/shared';
import { useStore } from '../store';
import { onFlightEvent } from '../ws';
import { AirspaceScene, type ClickInfo, type HoverInfo } from '../airspace/scene';
import { hex } from '../airspace/colors';
import { api, ApiError, type Rule, type Zone } from '../api';
import { ApprovalCard } from './Tower';

const SWATCHES = ['#64d2ff', '#8b7bff', '#3ddc97', '#ffb547', '#ff5c7a', '#ff7ad9', '#a5ff8b', '#ffa26b'];

type Popover =
  | { kind: 'lasso'; stationIds: string[]; x: number; y: number }
  | { kind: 'zone'; zone: Zone; x: number; y: number }
  | { kind: 'gate'; rule: Rule; x: number; y: number };

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
  const [stats, setStats] = useState({ particles: 0, stations: 0 });
  const [drawMode, setDrawMode] = useState(false);
  const [popover, setPopover] = useState<Popover | null>(null);
  const [showTower, setShowTower] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    const scene = new AirspaceScene();
    let unsub = () => {};
    void scene.init(host).then(() => {
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
        } else if (c.kind === 'zone') setPopover({ kind: 'zone', zone: c.zone, x: c.x, y: c.y });
        else if (c.kind === 'gate') setPopover({ kind: 'gate', rule: c.rule, x: c.x, y: c.y });
        else setPopover(null);
      });
      const st = useStore.getState();
      if (st.topology) scene.setTopology(st.topology);
      if (st.policy) scene.setPolicy(st.policy);
      unsub = onFlightEvent((e) => scene.handle(e));
    });
    const iv = setInterval(() => {
      if (sceneRef.current) setStats(sceneRef.current.stats());
    }, 1000);
    return () => {
      disposed = true;
      clearInterval(iv);
      unsub();
      sceneRef.current?.destroy();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (topology && sceneRef.current) sceneRef.current.setTopology(topology);
  }, [topology]);
  useEffect(() => {
    if (policy && sceneRef.current) sceneRef.current.setPolicy(policy);
  }, [policy]);
  useEffect(() => {
    sceneRef.current?.setRightInset(showTower ? 360 : 0);
  }, [showTower, topology, policy]);

  const toggleDraw = () => {
    const next = !drawMode;
    setDrawMode(next);
    if (sceneRef.current) sceneRef.current.drawMode = next;
    setPopover(null);
  };

  const stationKeyFor = (id: string) => {
    const s = sceneRef.current?.stationList().find((x) => x.id === id);
    return s?.kind === 'agent' ? `key:${id}` : `deployment:${id}`;
  };

  const pendingHere = approvals.filter((a) => a.status === 'pending');

  return (
    <div className="airspace" ref={hostRef} style={{ cursor: drawMode ? 'crosshair' : 'default' }}>
      <div className="hud">
        <div className="card stat">
          <div className="label">Flights (session)</div>
          <div className="value">{counters.flights.toLocaleString()}</div>
        </div>
        <div className="card stat">
          <div className="label">Spend (session)</div>
          <div className="value mono">{formatUsd(counters.cost_nanousd)}</div>
        </div>
        <div className="card stat">
          <div className="label">Blocked / errors</div>
          <div className="value" style={{ color: counters.denied + counters.errors ? 'var(--danger)' : undefined }}>
            {counters.denied} / {counters.errors}
          </div>
        </div>
        <div className="card stat">
          <div className="label">In the air</div>
          <div className="value">{stats.particles}</div>
        </div>
        <button className={`btn ${drawMode ? 'active' : ''}`} onClick={toggleDraw} title="Drag a lasso around stations to create a zone">
          ✎ Draw zone
        </button>
        <button className={`btn ${showTower ? 'active' : ''}`} onClick={() => setShowTower((v) => !v)}>
          Tower {pendingHere.length > 0 && <span className="badge">{pendingHere.length}</span>}
        </button>
      </div>
      {drawMode && <div className="mode-banner">Drag a lasso around the stations that belong together</div>}

      {showTower && (
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
        <ZonePopover
          x={popover.x}
          y={popover.y}
          zone={popover.zone}
          zones={policy.zones}
          rules={policy.rules}
          onClose={() => setPopover(null)}
          onChanged={() => void refreshPolicy()}
        />
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

      {hover?.station && !popover && (
        <div className="tooltip" style={{ left: hover.x, top: hover.y }}>
          <div className="t" style={{ color: hex(hover.station.color) }}>
            {hover.station.label}
          </div>
          <div className="r">
            <span>{hover.station.kind === 'agent' ? 'agent key' : 'model deployment'}</span>
            <b>{hover.station.sub}</b>
          </div>
          <div className="r">
            <span>requests (live)</span>
            <b>{hover.station.requests}</b>
          </div>
          {hover.station.kind !== 'agent' && (
            <div className="r">
              <span>spend (live)</span>
              <b>{formatUsd(hover.station.cost)}</b>
            </div>
          )}
        </div>
      )}
      {hover?.lane && !popover && (
        <div className="tooltip" style={{ left: hover.x, top: hover.y }}>
          <div className="t">
            {hover.lane.fromLabel} → {hover.lane.toLabel}
          </div>
          <div className="r">
            <span>requests (24h)</span>
            <b>{hover.lane.requests}</b>
          </div>
          <div className="r">
            <span>spend (24h)</span>
            <b>{formatUsd(hover.lane.cost)}</b>
          </div>
          <div className="r">
            <span>avg latency</span>
            <b>{hover.lane.avgMs == null ? '—' : `${Math.round(hover.lane.avgMs)} ms`}</b>
          </div>
          <div className="r">
            <span>errors / blocked</span>
            <b>
              {hover.lane.errors} / {hover.lane.denied}
            </b>
          </div>
          {hover.lane.gate && (
            <div className="r">
              <span>gate</span>
              <b>{hover.lane.gate.rule.effect.replace('_', ' ')}</b>
            </div>
          )}
        </div>
      )}
      {hover?.gate && !popover && (
        <div className="tooltip" style={{ left: hover.x, top: hover.y }}>
          <div className="t">{hover.gate.rule.name}</div>
          <div className="r">
            <span>effect</span>
            <b>{hover.gate.rule.effect.replace('_', ' ')}</b>
          </div>
          <div className="r">
            <span>click to edit</span>
          </div>
        </div>
      )}
      {hover?.zone && !popover && (
        <div className="tooltip" style={{ left: hover.x, top: hover.y }}>
          <div className="t" style={{ color: hover.zone.color }}>
            {hover.zone.name}
          </div>
          <div className="r">
            <span>click to manage gates</span>
          </div>
        </div>
      )}

      <div className="legend">
        <span>
          <i style={{ background: 'var(--accent)' }} /> request
        </span>
        <span>
          <i style={{ background: 'var(--ok)' }} /> response
        </span>
        <span>
          <i style={{ background: 'var(--warn)' }} /> holding at gate
        </span>
        <span>
          <i style={{ background: 'var(--danger)' }} /> blocked / error
        </span>
        <span className={`pill ${wsState === 'live' ? 'live' : 'warn'}`}>
          <i className="led" /> {wsState}
        </span>
        {policy && !policy.enforcement && <span className="pill warn">enforcement off</span>}
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
