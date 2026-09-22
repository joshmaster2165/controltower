import { create } from 'zustand';
import type { FlightEvent } from '@controltower/shared';
import { api, setCsrf, type Approval, type Me, type PolicyBundle, type Status, type Topology } from './api';

export type Route = 'airspace' | 'tower' | 'flights' | 'keys' | 'providers' | 'models' | 'mcp' | 'playground' | 'ledger';

interface FeedItem {
  id: string;
  ts: number;
  kind: 'ok' | 'error' | 'denied' | 'held' | 'info';
  text: string;
  meta: string;
}

interface State {
  booted: boolean;
  status: Status | null;
  me: Me | null;
  route: Route;
  topology: Topology | null;
  policy: PolicyBundle | null;
  approvals: Approval[];
  wsState: 'connecting' | 'live' | 'offline';
  feed: FeedItem[];
  counters: { flights: number; ok: number; errors: number; denied: number; cost_nanousd: number; tokens: number };
  boot(): Promise<void>;
  setMe(me: Me | null): void;
  setRoute(r: Route): void;
  refreshTopology(): Promise<void>;
  refreshPolicy(): Promise<void>;
  refreshApprovals(): Promise<void>;
  setWs(s: State['wsState']): void;
  onEvent(e: FlightEvent): void;
}

const started = new Map<string, { key: string; model: string; ts: number }>();

export const useStore = create<State>((set, get) => ({
  booted: false,
  status: null,
  me: null,
  route: (location.hash.replace('#/', '') as Route) || 'airspace',
  topology: null,
  policy: null,
  approvals: [],
  wsState: 'offline',
  feed: [],
  counters: { flights: 0, ok: 0, errors: 0, denied: 0, cost_nanousd: 0, tokens: 0 },

  async boot() {
    const status = await api.get<Status>('/admin/api/status');
    let me: Me | null = null;
    try {
      me = await api.get<Me>('/admin/api/me');
      setCsrf(me.csrf ?? null);
    } catch {
      me = null;
    }
    set({ status, me, booted: true });
    if (me?.email) await Promise.all([get().refreshTopology(), get().refreshPolicy(), get().refreshApprovals()]);
  },

  setMe(me) {
    setCsrf(me?.csrf ?? null);
    set({ me });
    if (me?.email) void Promise.all([get().refreshTopology(), get().refreshPolicy(), get().refreshApprovals()]);
  },

  setRoute(route) {
    location.hash = `#/${route}`;
    set({ route });
  },

  async refreshTopology() {
    try {
      const topology = await api.get<Topology>('/admin/api/topology');
      set({ topology });
    } catch {
      /* not signed in */
    }
  },

  async refreshPolicy() {
    try {
      const policy = await api.get<PolicyBundle>('/admin/api/policy');
      set({ policy });
    } catch {
      /* not signed in */
    }
  },

  async refreshApprovals() {
    try {
      const r = await api.get<{ approvals: Approval[] }>('/admin/api/approvals?status=pending&limit=50');
      set({ approvals: r.approvals });
    } catch {
      /* not signed in */
    }
  },

  setWs(wsState) {
    set({ wsState });
  },

  onEvent(e) {
    const s = get();
    let item: FeedItem | null = null;
    const c = { ...s.counters };
    if (e.t === 'flight.started') {
      started.set(e.flight_id, { key: e.key_name, model: e.model_requested, ts: e.ts });
      c.flights++;
    } else if (e.t === 'flight.completed') {
      const st = started.get(e.flight_id);
      started.delete(e.flight_id);
      const key = st?.key ?? 'agent';
      const model = st?.model ?? 'model';
      if (e.status === 'ok') c.ok++;
      else if (e.status === 'error') c.errors++;
      else if (e.status === 'denied' || e.status === 'rejected' || e.status === 'ticketed') c.denied++;
      if (e.cost_nanousd) c.cost_nanousd += e.cost_nanousd;
      if (e.usage) c.tokens += e.usage.input + e.usage.output;
      if (e.status !== 'ok') {
        item = {
          id: e.flight_id,
          ts: e.ts,
          kind: e.status === 'error' ? 'error' : e.status === 'denied' || e.status === 'rejected' || e.status === 'ticketed' ? 'denied' : 'info',
          text: `${key} → ${model}`,
          meta: e.error?.code ?? e.status,
        };
      }
    } else if (e.t === 'flight.held') {
      const st = started.get(e.flight_id);
      item = { id: e.flight_id + ':held', ts: e.ts, kind: 'held', text: `${st?.key ?? 'agent'} holding at gate`, meta: e.summary.slice(0, 40) };
    } else if (e.t === 'flight.decision' && e.decision === 'deny') {
      const st = started.get(e.flight_id);
      item = { id: e.flight_id + ':deny', ts: e.ts, kind: 'denied', text: `${st?.key ?? 'agent'} → ${st?.model ?? ''}`, meta: e.reason ?? 'denied by policy' };
    }
    if (item) {
      const feed = [item, ...s.feed].slice(0, 8);
      set({ counters: c, feed });
    } else {
      set({ counters: c });
    }
  },
}));

window.addEventListener('hashchange', () => {
  const r = (location.hash.replace('#/', '') as Route) || 'airspace';
  useStore.setState({ route: r });
});
