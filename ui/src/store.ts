import { create } from 'zustand';
import type { FlightEvent, LiveTick } from '@controltower/shared';
import { api, setCsrf, type AlertChannel, type AlertItem, type AlertRule, type Approval, type Me, type PolicyBundle, type Status, type Topology } from './api';

export type Route = 'airspace' | 'tower' | 'alerts' | 'report' | 'flights' | 'keys' | 'providers' | 'models' | 'mcp' | 'http' | 'a2a' | 'playground' | 'welcome' | 'ledger';

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
  /** Second hash segment, e.g. the approval id in #/tower/<id>. */
  routeParam: string | null;
  topology: Topology | null;
  policy: PolicyBundle | null;
  approvals: Approval[];
  alerts: AlertItem[];
  unreadAlerts: number;
  alertRules: AlertRule[];
  alertChannels: AlertChannel[];
  /** Alerts that fired while this tab was open, shown as toasts until dismissed. */
  toasts: Array<AlertItem & { repeats?: number }>;
  alertsLoaded: boolean;
  wsState: 'connecting' | 'live' | 'offline';
  feed: FeedItem[];
  counters: { flights: number; ok: number; errors: number; denied: number; cost_nanousd: number; tokens: number };
  boot(): Promise<void>;
  setMe(me: Me | null): void;
  setRoute(r: Route, param?: string | null): void;
  refreshTopology(): Promise<void>;
  /** Start the demo fleet, or stop it and remove everything it added. */
  setDemo(on: boolean): Promise<void>;
  refreshPolicy(): Promise<void>;
  refreshApprovals(): Promise<void>;
  refreshAlerts(): Promise<void>;
  dismissToast(id: string): void;
  setWs(s: State['wsState']): void;
  /** Full events of held, denied and failed flights: the feed. */
  onEvents(es: FlightEvent[]): void;
  /** A second of traffic, summed: the counters. */
  onTick(t: LiveTick): void;
}

const started = new Map<string, { key: string; model: string; ts: number }>();

export const useStore = create<State>((set, get) => ({
  booted: false,
  status: null,
  me: null,
  ...parseHash(),
  topology: null,
  policy: null,
  approvals: [],
  alerts: [],
  unreadAlerts: 0,
  alertRules: [],
  alertChannels: [],
  toasts: [],
  alertsLoaded: false,
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
    if (me?.email) await Promise.all([get().refreshTopology(), get().refreshPolicy(), get().refreshApprovals(), get().refreshAlerts()]);
  },

  setMe(me) {
    setCsrf(me?.csrf ?? null);
    set({ me });
    if (me?.email) void Promise.all([get().refreshTopology(), get().refreshPolicy(), get().refreshApprovals(), get().refreshAlerts()]);
  },

  setRoute(route, param = null) {
    location.hash = param ? `#/${route}/${encodeURIComponent(param)}` : `#/${route}`;
    set({ route, routeParam: param });
  },

  async setDemo(on) {
    if (on) await api.post('/admin/api/demo');
    else await api.del('/admin/api/demo');
    const status = await api.get<Status>('/admin/api/status');
    set({ status });
    await Promise.all([get().refreshTopology(), get().refreshPolicy(), get().refreshApprovals(), get().refreshAlerts()]);
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

  async refreshAlerts() {
    try {
      const [a, r, c] = await Promise.all([
        api.get<{ alerts: AlertItem[]; unread: number }>('/admin/api/alerts?limit=100'),
        api.get<{ rules: AlertRule[] }>('/admin/api/alert-rules'),
        api.get<{ channels: AlertChannel[] }>('/admin/api/alert-channels'),
      ]);
      const prev = get();
      const known = new Set(prev.alerts.map((x) => x.id));
      // Toast only what fired after this tab loaded, never the backlog.
      const fresh = prev.alertsLoaded ? a.alerts.filter((x) => !known.has(x.id) && !x.read) : [];
      // One toast per alert rule: a repeat replaces the previous toast and bumps its counter.
      let toasts = prev.toasts;
      for (const f of [...fresh].reverse()) {
        const same = toasts.find((t) => t.alert_rule_id === f.alert_rule_id);
        toasts = [{ ...f, repeats: (same?.repeats ?? 0) + (same ? 1 : 0) }, ...toasts.filter((t) => t !== same)];
      }
      set({ alerts: a.alerts, unreadAlerts: a.unread, alertRules: r.rules, alertChannels: c.channels, alertsLoaded: true, toasts: toasts.slice(0, 3) });
    } catch {
      /* not signed in */
    }
  },

  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },

  setWs(wsState) {
    set({ wsState });
  },

  onTick(t) {
    const c = { ...get().counters };
    c.flights += t.totals.flights;
    c.ok += t.totals.ok;
    c.errors += t.totals.errors;
    c.denied += t.totals.denied;
    c.cost_nanousd += t.totals.cost_nanousd;
    c.tokens += t.totals.tokens;
    set({ counters: c });
  },

  onEvents(es) {
    const s = get();
    const items: FeedItem[] = [];
    for (const e of es) {
      let item: FeedItem | null = null;
      if (e.t === 'flight.started') {
        started.set(e.flight_id, { key: e.key_name, model: e.model_requested, ts: e.ts });
      } else if (e.t === 'flight.completed') {
        const st = started.get(e.flight_id);
        started.delete(e.flight_id);
        const key = st?.key ?? 'agent';
        const model = st?.model ?? 'model';
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
      if (item) items.unshift(item);
    }
    if (items.length) set({ feed: [...items, ...s.feed].slice(0, 8) });
  },
}));

function parseHash(): { route: Route; routeParam: string | null } {
  const [r, p] = location.hash.replace(/^#\/?/, '').split('/');
  return { route: (r as Route) || 'airspace', routeParam: p ? decodeURIComponent(p) : null };
}

window.addEventListener('hashchange', () => useStore.setState(parseHash()));
