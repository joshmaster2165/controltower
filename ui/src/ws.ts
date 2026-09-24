import type { FlightEvent, WsServerMessage } from '@controltower/shared';
import { useStore } from './store';

type Listener = (e: FlightEvent) => void;
const listeners = new Set<Listener>();

/** Subscribe to live flight events (used by the Airspace scene). */
export function onFlightEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let socket: WebSocket | null = null;
let backoff = 500;
let stopped = false;

// Reconnects replay the last seconds of events; never process one twice.
const seen = new Set<string>();
const seenOrder: string[] = [];
function isDuplicate(e: FlightEvent): boolean {
  const k = `${e.flight_id}|${e.t}|${e.ts}`;
  if (seen.has(k)) return true;
  seen.add(k);
  seenOrder.push(k);
  if (seenOrder.length > 5000) seen.delete(seenOrder.shift()!);
  return false;
}

export function connectWs(): void {
  stopped = false;
  open();
}

export function disconnectWs(): void {
  stopped = true;
  socket?.close();
  socket = null;
}

function open(): void {
  if (stopped) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/admin/ws`);
  socket = ws;
  useStore.getState().setWs('connecting');

  ws.onopen = () => {
    backoff = 500;
    useStore.getState().setWs('live');
  };
  ws.onmessage = (ev) => {
    let msg: WsServerMessage;
    try {
      msg = JSON.parse(String(ev.data)) as WsServerMessage;
    } catch {
      return;
    }
    const store = useStore.getState();
    switch (msg.type) {
      case 'event':
        dispatch([msg.event]);
        break;
      case 'events':
        dispatch(msg.events);
        break;
      case 'topology':
        void store.refreshTopology();
        void store.refreshPolicy();
        break;
      case 'approvals':
        void store.refreshApprovals();
        break;
      case 'alerts':
        scheduleAlerts();
        break;
      case 'hello':
        break;
    }
  };
  ws.onclose = (ev) => {
    socket = null;
    useStore.getState().setWs('offline');
    if (stopped || ev.code === 4401) return;
    setTimeout(open, backoff);
    backoff = Math.min(10_000, backoff * 2);
  };
  ws.onerror = () => {
    /* onclose follows */
  };
}

// An alert firing bumps the version twice (recorded, then delivered): coalesce.
let alertsTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleAlerts(): void {
  if (alertsTimer) return;
  alertsTimer = setTimeout(() => {
    alertsTimer = null;
    void useStore.getState().refreshAlerts();
  }, 250);
}

function dispatch(events: FlightEvent[]): void {
  const fresh = events.filter((e) => !isDuplicate(e));
  if (!fresh.length) return;
  useStore.getState().onEvents(fresh);
  for (const e of fresh) {
    for (const l of listeners) {
      try {
        l(e);
      } catch (err) {
        console.error('[ws] listener error', err);
      }
    }
  }
}
