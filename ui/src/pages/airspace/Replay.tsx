import { useCallback, useEffect, useRef, useState } from 'react';
import type { FlightEvent, FlightStatus } from '@controltower/shared';
import { api, ApiError } from '../../api';

/** [id, ts, key_id, key_name, kind, target_id, tool, status, duration_ms, rule_id, approval_status] */
type Row = [string, number, string, string, string, string | null, string | null, string | null, number | null, string | null, string | null];
interface ReplayData {
  from: number;
  to: number;
  oldest: number | null;
  truncated: boolean;
  flights: Row[];
}

const WINDOWS = [
  { id: '1h', label: 'Last hour', ms: 3600_000, speed: 60 },
  { id: '6h', label: 'Last 6 hours', ms: 6 * 3600_000, speed: 300 },
  { id: '24h', label: 'Last 24 hours', ms: 24 * 3600_000, speed: 1800 },
  { id: '7d', label: 'Last 7 days', ms: 7 * 24 * 3600_000, speed: 10_000 },
] as const;
const SPEEDS = [10, 60, 300, 1800, 10_000];
const TOOL_KINDS = new Set(['mcp.tool', 'http.request', 'a2a.call']);

const fmtTime = (ts: number, span: number) =>
  new Date(ts).toLocaleString([], span > 24 * 3600_000 ? { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/**
 * Flight Recorder: plays a past window back on the map. Each recorded flight
 * is handed to the map as if it were happening now, compressed by the chosen
 * speed; live traffic is paused meanwhile.
 */
export function ReplayBar({ emit, reset, onExit }: { emit: (e: FlightEvent) => void; reset: () => void; onExit: () => void }) {
  const [win, setWin] = useState<(typeof WINDOWS)[number]>(WINDOWS[0]);
  const [data, setData] = useState<ReplayData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(WINDOWS[0].speed);
  const [cursor, setCursor] = useState(0);
  const [shown, setShown] = useState(0);

  // Playback state outside React, driven by requestAnimationFrame.
  const st = useRef({ cursor: 0, next: 0, pending: [] as Array<{ at: number; row: Row }>, shown: 0 });
  const speedRef = useRef(speed);
  speedRef.current = speed;

  const load = useCallback(
    async (w: (typeof WINDOWS)[number]) => {
      setErr(null);
      setPlaying(false);
      try {
        const to = Date.now();
        const d = await api.get<ReplayData>(`/admin/api/replay?from=${to - w.ms}&to=${to}`);
        setData(d);
        setSpeed(w.speed);
        // Start just before the first recorded flight, not at the (often quiet) start of the window.
        const first = d.flights[0]?.[1];
        const begin = first ? Math.max(d.from, first - 2000 * w.speed) : d.from;
        st.current = { cursor: begin, next: 0, pending: [], shown: 0 };
        setCursor(begin);
        setShown(0);
        reset();
        setPlaying(d.flights.length > 0);
      } catch (e) {
        setErr(e instanceof ApiError ? e.message : String(e));
      }
    },
    [reset],
  );
  useEffect(() => {
    void load(win);
  }, [win, load]);

  const start = (r: Row) => {
    const [id, , keyId, keyName, kind, target, tool, status, , ruleId, approval] = r;
    const ts = Date.now();
    const tools = TOOL_KINDS.has(kind);
    emit({
      t: 'flight.started',
      flight_id: id,
      ts,
      key_id: keyId,
      key_name: keyName,
      kind: kind as Extract<FlightEvent, { t: 'flight.started' }>['kind'],
      dialect: 'openai-chat',
      stream: false,
      model_requested: '',
      ...(target ? (tools ? { mcp_server_id: target } : { deployment_id: target }) : {}),
      ...(tool ? { tool } : {}),
      est_input_tokens: 0,
      projected_nanousd: 0,
    });
    if (status === 'denied' || status === 'rejected') emit({ t: 'flight.decision', flight_id: id, ts, decision: 'deny', ...(ruleId ? { rule_id: ruleId } : {}) });
    if (approval) emit({ t: 'flight.held', flight_id: id, ts, approval_id: 'replay', budget_ms: 1, summary: '' });
  };
  const finish = (r: Row) => {
    const [id, , , , , , , status, duration, , approval] = r;
    const ts = Date.now();
    if (approval) emit({ t: 'flight.resolved', flight_id: id, ts, approval_id: 'replay', outcome: approval === 'approved' ? 'approved' : approval === 'denied' ? 'denied' : 'ticketed' });
    emit({ t: 'flight.completed', flight_id: id, ts, status: (status ?? 'ok') as FlightStatus, http_status: status === 'ok' ? 200 : 403, usage_source: 'unknown', cost_nanousd: null, cost_confidence: 'unknown', duration_ms: duration ?? 0, gateway_overhead_ms: 0 });
  };

  useEffect(() => {
    if (!playing || !data) return;
    let raf = 0;
    let last = performance.now();
    let lastUi = 0;
    const tick = (now: number) => {
      const s = st.current;
      const dt = Math.min(250, now - last);
      last = now;
      s.cursor = Math.min(data.to, s.cursor + dt * speedRef.current);
      const rows = data.flights;
      // Skip quiet stretches: jump to just before the next flight when it is more than ~2 s of playback away.
      const upcoming = rows[s.next]?.[1];
      if (!s.pending.length && upcoming !== undefined && upcoming - s.cursor > 2000 * speedRef.current) s.cursor = upcoming - 500 * speedRef.current;
      while (s.next < rows.length && rows[s.next]![1] <= s.cursor) {
        const r = rows[s.next++]!;
        start(r);
        s.shown++;
        // Held calls include the wait for a human; keep them on the map at least briefly.
        const at = r[1] + Math.max(r[8] ?? 0, 250 * speedRef.current * (r[10] ? 4 : 1));
        let i = s.pending.length;
        while (i > 0 && s.pending[i - 1]!.at > at) i--;
        s.pending.splice(i, 0, { at, row: r });
      }
      while (s.pending.length && s.pending[0]!.at <= s.cursor) finish(s.pending.shift()!.row);
      if (now - lastUi > 100) {
        lastUi = now;
        setCursor(s.cursor);
        setShown(s.shown);
      }
      if (s.cursor >= data.to && !s.pending.length) {
        setCursor(s.cursor);
        setShown(s.shown);
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, data]);

  const seek = (to: number) => {
    if (!data) return;
    reset();
    const rows = data.flights;
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid]![1] < to) lo = mid + 1;
      else hi = mid;
    }
    st.current = { cursor: to, next: lo, pending: [], shown: lo };
    setCursor(to);
    setShown(lo);
  };

  const span = data ? data.to - data.from : win.ms;
  const total = data?.flights.length ?? 0;
  const atEnd = !!data && cursor >= data.to;
  return (
    <div className="replay" role="region" aria-label="Flight Recorder">
      <span className="replay-badge">
        <i /> Replay
      </span>
      <select className="input sm" value={win.id} onChange={(e) => setWin(WINDOWS.find((w) => w.id === e.target.value)!)} aria-label="Window">
        {WINDOWS.map((w) => (
          <option key={w.id} value={w.id}>
            {w.label}
          </option>
        ))}
      </select>
      <button
        className="btn sm primary replay-play"
        disabled={!total}
        onClick={() => {
          if (atEnd) seek(data!.from);
          setPlaying((p) => !p);
        }}
        aria-label={playing ? 'Pause' : 'Play'}
      >
        {playing ? '❚❚' : '▶'}
      </button>
      <input
        className="replay-scrub"
        type="range"
        min={data?.from ?? 0}
        max={data?.to ?? 1}
        step={Math.max(1, Math.round(span / 2000))}
        value={cursor}
        disabled={!total}
        onChange={(e) => seek(Number(e.target.value))}
        aria-label="Time"
      />
      <span className="replay-time mono">{data ? fmtTime(cursor, span) : '—'}</span>
      <select className="input sm" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Speed">
        {SPEEDS.map((s) => (
          <option key={s} value={s}>
            {s.toLocaleString()}×
          </option>
        ))}
      </select>
      <span className="replay-count">
        {err ? <span className="danger-text">{err}</span> : total ? `${shown.toLocaleString()} of ${total.toLocaleString()} flights${data?.truncated ? ' (first 50,000)' : ''}` : 'No flights in this window'}
      </span>
      <button className="btn sm" onClick={onExit}>
        Back to live
      </button>
    </div>
  );
}
