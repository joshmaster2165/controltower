import type { FlightEvent } from '@controltower/shared';
import type { PolicyBundle, Rule, Topology, Zone } from '../api';
import { agentColor, hex, MCP_COLOR, PROVIDER_COLORS, STATUS_COLORS } from './colors';

/**
 * The Airspace — Canvas 2D (no WebGL dependency, works in every browser).
 *
 * Every flight is routed through the tower in the middle, because that is
 * what actually happens: agents (left) → Control Tower (policy, gates) →
 * models and tool servers (right). Flights hold in a circling pattern around
 * the tower while a human decides, shatter at the gate that blocks them, and
 * return as a response trace sized by output tokens.
 */

export interface Station {
  id: string;
  kind: 'agent' | 'model' | 'mcp' | 'unknown';
  label: string;
  sub: string;
  color: number;
  /** card top-left */
  x: number;
  y: number;
  w: number;
  h: number;
  /** port where the spoke attaches */
  px: number;
  py: number;
  r: number;
  heat: number;
  requests: number;
  denied: number;
  errors: number;
  cost: number;
  arrivals: number[];
}

export interface Lane {
  from: string;
  to: string;
  activity: number;
  requests: number;
  cost: number;
  errors: number;
  denied: number;
  avgMs: number | null;
  cx: number;
  cy: number;
  gate: { rule: Rule; x: number; y: number } | null;
}

export interface SceneStats {
  particles: number;
  stations: number;
}

export interface HoverInfo {
  x: number;
  y: number;
  station?: Station & { rpm: number };
  lane?: Lane & { fromLabel: string; toLabel: string };
  zone?: Zone;
  gate?: { rule: Rule; lane: Lane };
  hub?: { rpm: number; held: number; costPerMin: number };
}

export type ClickInfo =
  | { kind: 'station'; station: Station; x: number; y: number }
  | { kind: 'zone'; zone: Zone; x: number; y: number }
  | { kind: 'gate'; rule: Rule; lane: Lane; x: number; y: number }
  | { kind: 'lasso'; stationIds: string[]; x: number; y: number }
  | { kind: 'empty'; x: number; y: number };

type Pt = [number, number];
interface Bez {
  p0: Pt;
  p1: Pt;
  p2: Pt;
  p3: Pt;
}
interface Spoke {
  station: Station;
  bez: Bez; // agents: station → hub; destinations: hub → station
  activity: number;
  gates: Array<{ rule: Rule; t: number; x: number; y: number }>;
}

interface Particle {
  id: string;
  agent: Station;
  dest: Station;
  color: number;
  size: number;
  phase: 'in' | 'hub' | 'out' | 'await' | 'hold' | 'retA' | 'retB' | 'shatter';
  t: number;
  verdict: 'pending' | 'allow' | 'deny' | 'held';
  completed: { status: string; outTokens: number } | undefined;
  stopAt: number | undefined;
  from: Pt | undefined; // blend-in origin for the current phase
  angle: number;
  born: number;
  x: number;
  y: number;
  trail: Pt[];
  shards: Array<{ x: number; y: number; vx: number; vy: number }> | undefined;
  shardColor: number;
  life: number;
  /** Where on which curve the pulse currently is (undefined when off the lines). */
  seg: { bez: Bez; k: number } | undefined;
}

interface Pulse {
  x: number;
  y: number;
  color: number;
  t: number;
  max: number;
}

const IN_MS = 650;
const HUB_MS = 140;
const OUT_MS = 650;
const RET_MS = 520;
const STALE_MS = 8_000;
const MAX_AGE_MS = 90_000;
const RESPONSE = 0x1a9e6b;
const FONT = 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const INK = '#0f1b2d';
const INK_DIM = '#5b6b82';
const INK_FAINT = '#8a98ad';
const LINE = '#d3dce8';

const LOGO_PATHS = [
  { d: 'M13 18h38l-4.5 12H17.5z', fill: '#1f5eff' },
  { d: 'M26.5 30h11l3.5 25H23z', fill: '#0b3d91' },
  { d: 'M30.5 6.5a1.5 1.5 0 0 1 3 0v8a1.5 1.5 0 0 1-3 0z', fill: '#0b3d91' },
  { d: 'M19.25 54h25.5a2.25 2.25 0 0 1 0 4.5h-25.5a2.25 2.25 0 0 1 0-4.5z', fill: '#0b3d91' },
  { d: 'M21.5 22.5h21a1.5 1.5 0 0 1 0 3h-21a1.5 1.5 0 0 1 0-3z', fill: '#ffffff' },
];

function rgba(c: number, a: number): string {
  return `rgba(${(c >> 16) & 255},${(c >> 8) & 255},${c & 255},${a})`;
}
function hexToNum(h: string): number {
  return Number.parseInt(h.replace('#', ''), 16) || 0x1f5eff;
}
function bezAt(b: Bez, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u;
  const bb = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return [a * b.p0[0] + bb * b.p1[0] + c * b.p2[0] + d * b.p3[0], a * b.p0[1] + bb * b.p1[1] + c * b.p2[1] + d * b.p3[1]];
}
function lerp(a: Pt, b: Pt, k: number): Pt {
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
}
function ease(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}
function pointInPoly(x: number, y: number, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
function fitText(ctx: CanvasRenderingContext2D, s: string, max: number): string {
  if (ctx.measureText(s).width <= max) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(s.slice(0, mid) + '…').width <= max) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo) + '…';
}

export class AirspaceScene {
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private bg: HTMLCanvasElement | null = null;
  private host!: HTMLElement;
  private ro: ResizeObserver | null = null;
  private raf = 0;
  private last = 0;
  private dpr = 1;
  private w = 0;
  private h = 0;
  private ready = false;
  private reducedMotion = false;

  private stations = new Map<string, Station>();
  private spokes = new Map<string, Spoke>();
  private particles: Particle[] = [];
  private byFlight = new Map<string, Particle>();
  private pulses: Pulse[] = [];
  private laneStats = new Map<string, Lane>();
  private zoneBoxes: Array<{ zone: Zone; x: number; y: number; w: number; h: number; chip: { x: number; y: number; w: number; h: number } }> = [];
  private topology: Topology | null = null;
  private policy: PolicyBundle | null = null;
  private hub: Pt = [0, 0];
  private hubR = 36;
  private holdR = 70;
  private sweep = 0;
  private hubArrivals: Array<{ ts: number; cost: number }> = [];
  private rightInset = 0;
  private pointer: Pt | null = null;
  private hovered: string | null = null;
  private lastHover = 0;
  private lasso: Pt[] | null = null;
  /** Last time a frame actually rendered; while the tab is hidden we don't queue visuals. */
  private lastFrameAt = 0;
  private hoverCb: ((h: HoverInfo | null) => void) | null = null;
  private clickCb: ((c: ClickInfo) => void) | null = null;
  private unknownStation: Station | null = null;
  private logo: Array<{ path: Path2D; fill: string }> = [];
  drawMode = false;

  async init(host: HTMLElement): Promise<void> {
    this.host = host;
    this.canvas = document.createElement('canvas');
    this.canvas.style.display = 'block';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Airspace: live map of agent traffic through Control Tower');
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not available in this browser');
    this.ctx = ctx;
    host.prepend(this.canvas);
    this.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    try {
      this.logo = LOGO_PATHS.map((p) => ({ path: new Path2D(p.d), fill: p.fill }));
    } catch {
      this.logo = [];
    }

    this.resize();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);

    const pos = (ev: PointerEvent): Pt => {
      const r = this.canvas.getBoundingClientRect();
      return [ev.clientX - r.left, ev.clientY - r.top];
    };
    this.canvas.addEventListener('pointermove', (ev) => {
      const p = pos(ev);
      this.pointer = p;
      if (this.lasso) this.lasso.push(p);
      this.hoverTest(true);
    });
    this.canvas.addEventListener('pointerleave', () => {
      this.pointer = null;
      this.hovered = null;
      this.hoverCb?.(null);
    });
    this.canvas.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 || !this.drawMode) return;
      this.lasso = [pos(ev)];
      this.canvas.setPointerCapture(ev.pointerId);
    });
    this.canvas.addEventListener('pointerup', (ev) => {
      const [x, y] = pos(ev);
      if (this.lasso) {
        const poly = this.lasso;
        this.lasso = null;
        if (poly.length > 2) {
          let area = 0;
          for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) area += (poly[j]![0] + poly[i]![0]) * (poly[j]![1] - poly[i]![1]);
          let inside: (s: Station) => boolean;
          if (Math.abs(area / 2) < 600) {
            const [x0, y0] = poly[0]!;
            const [x1, y1] = poly[poly.length - 1]!;
            inside = (s) => {
              const cx = s.x + s.w / 2;
              const cy = s.y + s.h / 2;
              return cx >= Math.min(x0, x1) && cx <= Math.max(x0, x1) && cy >= Math.min(y0, y1) && cy <= Math.max(y0, y1);
            };
          } else {
            inside = (s) => pointInPoly(s.x + s.w / 2, s.y + s.h / 2, poly);
          }
          const ids = [...this.stations.values()].filter((s) => s.kind !== 'unknown' && inside(s)).map((s) => s.id);
          this.clickCb?.({ kind: 'lasso', stationIds: ids, x, y });
          return;
        }
      }
      this.clickCb?.(this.hitTest(x, y));
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        // Drop anything that queued up while we weren't drawing; start fresh.
        this.particles = [];
        this.byFlight.clear();
        this.pulses = [];
      }
    });

    this.ready = true;
    this.last = performance.now();
    this.lastFrameAt = this.last;
    const frame = (now: number) => {
      // Keep real time even when frames are sparse (throttled or busy tabs); cap only true stalls.
      const dt = Math.min(250, now - this.last);
      this.last = now;
      this.lastFrameAt = now;
      try {
        this.tick(dt, now);
        this.draw(now);
      } catch (err) {
        console.error('[airspace] frame error', err);
      }
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  onHover(cb: (h: HoverInfo | null) => void): void {
    this.hoverCb = cb;
  }
  onClick(cb: (c: ClickInfo) => void): void {
    this.clickCb = cb;
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    this.canvas?.remove();
    this.ready = false;
  }

  stats(): SceneStats {
    return { particles: this.particles.filter((p) => p.phase !== 'shatter').length, stations: this.stations.size };
  }

  debug(): Record<string, number> {
    const out: Record<string, number> = { tracked: this.byFlight.size };
    for (const p of this.particles) out[p.phase] = (out[p.phase] ?? 0) + 1;
    return out;
  }

  stationList(): Station[] {
    return [...this.stations.values()];
  }

  setRightInset(px: number): void {
    if (this.rightInset === px) return;
    this.rightInset = px;
    this.layout();
  }

  // ---------------------------------------------------------------- topology

  private blank(id: string, kind: Station['kind'], label: string, sub: string, color: number): Station {
    return { id, kind, label, sub, color, x: 0, y: 0, w: 0, h: 0, px: 0, py: 0, r: 16, heat: 0, requests: 0, denied: 0, errors: 0, cost: 0, arrivals: [] };
  }

  setTopology(t: Topology): void {
    this.topology = t;
    const keep = new Set<string>();
    const upsert = (id: string, kind: Station['kind'], label: string, sub: string, color: number) => {
      keep.add(id);
      const s = this.stations.get(id);
      if (s) {
        s.label = label;
        s.sub = sub;
        s.color = color;
      } else this.stations.set(id, this.blank(id, kind, label, sub, color));
    };
    for (const k of t.keys) upsert(k.id, 'agent', k.name, [k.team, k.project].filter(Boolean).join(' · ') || 'agent', agentColor(k.agent_id ?? k.id));
    const provById = new Map(t.providers.map((p) => [p.id, p]));
    for (const d of t.deployments) {
      const prov = provById.get(d.provider_id);
      upsert(d.id, 'model', d.public_name ?? d.upstream_model, prov?.name ?? prov?.kind ?? 'model', PROVIDER_COLORS[prov?.kind ?? ''] ?? 0x475569);
    }
    for (const m of t.mcp_servers ?? []) upsert(m.id, 'mcp', m.name, `Tool server · ${m.tools.length} tool${m.tools.length === 1 ? '' : 's'}`, MCP_COLOR);
    for (const id of [...this.stations.keys()]) if (!keep.has(id) && id !== '__unknown') this.stations.delete(id);

    this.laneStats.clear();
    for (const l of t.lanes) {
      if (!l.key_id || !l.deployment_id) continue;
      this.laneStats.set(`${l.key_id}>${l.deployment_id}`, {
        from: l.key_id,
        to: l.deployment_id,
        activity: 0,
        requests: l.requests,
        cost: l.cost_nanousd,
        errors: l.errors,
        denied: l.denied,
        avgMs: l.avg_ms,
        cx: 0,
        cy: 0,
        gate: null,
      });
    }
    this.layout();
  }

  setPolicy(p: PolicyBundle): void {
    this.policy = p;
    this.layout();
  }

  private stationKey(s: Station): string {
    return s.kind === 'agent' ? `key:${s.id}` : s.kind === 'mcp' ? `mcp:${s.id}` : `deployment:${s.id}`;
  }

  private zoneMembers(z: Zone): Station[] {
    const t = this.topology;
    const out: Station[] = [];
    for (const s of this.stations.values()) {
      if (s.kind === 'unknown') continue;
      if (z.stations.includes(this.stationKey(s))) {
        out.push(s);
        continue;
      }
      if (s.kind === 'model') {
        const dep = t?.deployments.find((d) => d.id === s.id);
        if (dep && z.stations.includes(`provider:${dep.provider_id}`)) out.push(s);
        continue;
      }
      if (s.kind === 'agent') {
        const k = t?.keys.find((x) => x.id === s.id);
        const m = z.match as { teams?: string[]; projects?: string[]; tags?: string[] };
        if (k && ((m.teams?.length && k.team && m.teams.includes(k.team)) || (m.projects?.length && k.project && m.projects.includes(k.project)) || (m.tags?.length && k.tags.some((tg) => m.tags!.includes(tg))))) out.push(s);
      }
    }
    return out;
  }

  private zonesOf(s: Station): Zone[] {
    if (!this.policy) return [];
    return this.policy.zones.filter((z) => this.zoneMembers(z).some((x) => x.id === s.id));
  }

  private ensureUnknown(): Station {
    if (!this.unknownStation) {
      this.unknownStation = this.blank('__unknown', 'unknown', 'Unrouted', 'no matching model', 0x8a98ad);
      this.stations.set('__unknown', this.unknownStation);
      this.layout();
    }
    return this.unknownStation;
  }

  // ------------------------------------------------------------------ layout

  private resize(): void {
    const r = this.host.getBoundingClientRect();
    this.w = Math.max(320, Math.floor(r.width));
    this.h = Math.max(320, Math.floor(r.height));
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.floor(this.w * this.dpr);
    this.canvas.height = Math.floor(this.h * this.dpr);
    this.bg = null;
    this.layout();
  }

  private layout(): void {
    if (!this.ready && !this.canvas) return;
    const W = Math.max(480, this.w - this.rightInset);
    const padTop = 118;
    const padBottom = 64;
    const avail = Math.max(200, this.h - padTop - padBottom);
    const cardW = Math.round(Math.max(172, Math.min(236, W * 0.17)));
    this.hub = [Math.round(W / 2), Math.round(padTop + avail / 2)];
    this.hubR = 36;
    this.holdR = 72;

    const zones = this.policy?.zones ?? [];
    const rank = (s: Station) => {
      const zs = this.zonesOf(s);
      return zs.length ? zones.findIndex((z) => z.id === zs[0]!.id) : 999;
    };
    const place = (list: Station[], x: number, side: 'left' | 'right') => {
      list.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
      const n = list.length;
      if (!n) return;
      const groups: number[] = [];
      for (let i = 0; i < n; i++) if (i === 0 || rank(list[i]!) !== rank(list[i - 1]!)) groups.push(i);
      const headed = groups.filter((i) => rank(list[i]!) !== 999).length;
      let cardH = 46;
      let gap = 10;
      const zoneGap = 16;
      const header = 24;
      const need = () => n * cardH + (n - 1) * gap + (groups.length - 1) * zoneGap + headed * header;
      while (need() > avail && cardH > 32) {
        cardH -= 2;
        gap = Math.max(4, gap - 1);
      }
      let y = padTop + Math.max(0, (avail - need()) / 2);
      list.forEach((s, i) => {
        if (groups.includes(i)) {
          if (i > 0) y += zoneGap;
          if (rank(s) !== 999) y += header;
        } else y += gap;
        s.x = x;
        s.y = Math.round(y);
        s.w = cardW;
        s.h = cardH;
        s.px = side === 'left' ? x + cardW : x;
        s.py = s.y + cardH / 2;
        y += cardH;
      });
    };
    const agents = [...this.stations.values()].filter((s) => s.kind === 'agent');
    const dests = [...this.stations.values()].filter((s) => s.kind !== 'agent');
    place(agents, 28, 'left');
    place(dests, W - 28 - cardW, 'right');

    // Spokes: cubic curves that leave the card horizontally and meet the tower's rim.
    this.spokes.clear();
    const [hx, hy] = this.hub;
    for (const s of this.stations.values()) {
      const dx = s.px - hx;
      const dy = s.py - hy;
      const len = Math.hypot(dx, dy) || 1;
      const rim: Pt = [hx + (dx / len) * (this.hubR + 4), hy + (dy / len) * (this.hubR + 4)];
      const span = s.px - rim[0];
      const bez: Bez =
        s.kind === 'agent'
          ? { p0: [s.px, s.py], p1: [s.px - span * 0.45, s.py], p2: [rim[0] + span * 0.3, rim[1] + (s.py - rim[1]) * 0.2], p3: rim }
          : { p0: rim, p1: [rim[0] + span * 0.3, rim[1] + (s.py - rim[1]) * 0.2], p2: [s.px - span * 0.45, s.py], p3: [s.px, s.py] };
      this.spokes.set(s.id, { station: s, bez, activity: this.spokes.get(s.id)?.activity ?? 0, gates: [] });
    }

    // Gates: a rule sits on the spoke of the station it guards.
    for (const r of this.policy?.rules ?? []) {
      if (!r.enabled) continue;
      if (r.to_zone) {
        const z = zones.find((x) => x.id === r.to_zone);
        if (!z) continue;
        for (const s of this.zoneMembers(z)) this.addGate(s.id, r, 0.34);
      } else if (r.from_zone) {
        const z = zones.find((x) => x.id === r.from_zone);
        if (!z) continue;
        for (const s of this.zoneMembers(z)) if (s.kind === 'agent') this.addGate(s.id, r, 0.66);
      }
    }

    // Zone frames around each column's members.
    this.zoneBoxes = [];
    for (const z of zones) {
      const members = this.zoneMembers(z);
      for (const col of [members.filter((m) => m.kind === 'agent'), members.filter((m) => m.kind !== 'agent')]) {
        if (!col.length) continue;
        const x = Math.min(...col.map((s) => s.x)) - 10;
        const y = Math.min(...col.map((s) => s.y)) - 30;
        const x2 = Math.max(...col.map((s) => s.x + s.w)) + 10;
        const y2 = Math.max(...col.map((s) => s.y + s.h)) + 10;
        this.ctx.font = `600 10.5px ${FONT}`;
        const cw = this.ctx.measureText(z.name.toUpperCase()).width + 26;
        this.zoneBoxes.push({ zone: z, x, y, w: x2 - x, h: y2 - y, chip: { x: x + 8, y: y + 6, w: cw, h: 18 } });
      }
    }
  }

  private addGate(stationId: string, rule: Rule, baseT: number): void {
    const sp = this.spokes.get(stationId);
    if (!sp) return;
    const t = sp.station.kind === 'agent' ? baseT - sp.gates.length * 0.1 : baseT + sp.gates.length * 0.1;
    const [x, y] = bezAt(sp.bez, t);
    sp.gates.push({ rule, t, x, y });
  }

  // ------------------------------------------------------------------ events

  handle(e: FlightEvent): void {
    if (!this.ready) return;
    const stale = Date.now() - e.ts > STALE_MS;
    switch (e.t) {
      case 'flight.started': {
        if (stale) return;
        // Not rendering (hidden tab, paused pane): don't pile up visuals to replay all at once.
        if (document.visibilityState !== 'visible' || performance.now() - this.lastFrameAt > 1000) return;
        const agent = this.stations.get(e.key_id);
        if (!agent) return;
        const dest = (e.deployment_id && this.stations.get(e.deployment_id)) || (e.mcp_server_id && this.stations.get(e.mcp_server_id)) || this.ensureUnknown();
        const size = Math.min(1.6, Math.log10(1 + e.est_input_tokens) * 0.4);
        const [x, y] = [agent.px, agent.py];
        const p: Particle = {
          id: e.flight_id,
          agent,
          dest,
          color: agent.color,
          size,
          phase: 'in',
          t: 0,
          verdict: 'pending',
          completed: undefined,
          stopAt: undefined,
          from: undefined,
          angle: Math.random() * Math.PI * 2,
          born: performance.now(),
          x,
          y,
          trail: [],
          shards: undefined,
          shardColor: 0,
          life: 0,
          seg: undefined,
        };
        this.particles.push(p);
        this.byFlight.set(e.flight_id, p);
        agent.heat = Math.min(1, agent.heat + 0.5);
        const sp = this.spokes.get(agent.id);
        if (sp) sp.activity = Math.min(1, sp.activity + 0.25);
        break;
      }
      case 'flight.decision': {
        const p = this.byFlight.get(e.flight_id);
        if (!p) break;
        if (e.decision === 'deny') {
          p.verdict = 'deny';
          if (p.phase === 'out' || p.phase === 'await' || p.phase === 'hold') this.shatter(p, STATUS_COLORS.denied);
        } else if (e.decision === 'hold') {
          p.verdict = 'held';
        } else if (p.verdict === 'pending') p.verdict = 'allow';
        break;
      }
      case 'flight.held': {
        const p = this.byFlight.get(e.flight_id);
        if (!p) break;
        p.verdict = 'held';
        if (p.phase === 'out' || p.phase === 'await') this.enterHold(p);
        break;
      }
      case 'flight.resolved': {
        const p = this.byFlight.get(e.flight_id);
        if (!p) break;
        if (e.outcome === 'approved') {
          p.verdict = 'allow';
          this.pulse(this.hub[0], this.hub[1], STATUS_COLORS.ok, this.hubR + 30);
          if (p.phase === 'hold') this.go(p, 'out');
        } else {
          p.verdict = 'deny';
          this.shatter(p, e.outcome === 'denied' ? STATUS_COLORS.denied : STATUS_COLORS.held);
        }
        break;
      }
      case 'flight.upstream': {
        if (e.outcome === 'fallback') {
          const p = this.byFlight.get(e.flight_id);
          if (p) this.pulse(p.x, p.y, STATUS_COLORS.held, 14);
        }
        break;
      }
      case 'flight.completed': {
        const p = this.byFlight.get(e.flight_id);
        const dest = p?.dest;
        if (dest) {
          dest.requests++;
          if (e.cost_nanousd) dest.cost += e.cost_nanousd;
          if (e.status === 'ok') {
            dest.arrivals.push(Date.now());
            p!.agent.arrivals.push(Date.now());
          }
          if (e.status === 'error') dest.errors++;
          if (e.status === 'denied' || e.status === 'rejected' || e.status === 'ticketed') p!.agent.denied++;
        }
        this.hubArrivals.push({ ts: Date.now(), cost: e.cost_nanousd ?? 0 });
        if (!p) break;
        this.byFlight.delete(e.flight_id);
        p.completed = { status: e.status, outTokens: e.usage?.output ?? 0 };
        if (e.status === 'ok') {
          if (p.phase === 'await' || p.phase === 'hold') this.startReturn(p);
        } else if (e.status === 'error') {
          if (p.phase === 'await' || p.phase === 'out' || p.phase === 'hold') this.shatter(p, STATUS_COLORS.error);
        } else if (e.status === 'denied' || e.status === 'rejected' || e.status === 'ticketed') {
          if (p.phase !== 'in' && p.phase !== 'hub') this.shatter(p, e.status === 'ticketed' ? STATUS_COLORS.held : STATUS_COLORS.denied);
          else p.verdict = 'deny';
        } else {
          this.shatter(p, 0x8a98ad);
        }
        break;
      }
    }
  }

  private go(p: Particle, phase: Particle['phase']): void {
    p.from = [p.x, p.y];
    p.phase = phase;
    p.t = 0;
  }

  private enterHold(p: Particle): void {
    p.from = [p.x, p.y];
    p.angle = Math.atan2(p.y - this.hub[1], p.x - this.hub[0]);
    p.phase = 'hold';
    p.t = 0;
  }

  private startReturn(p: Particle): void {
    const out = p.completed?.outTokens ?? 0;
    p.color = RESPONSE;
    p.size = Math.min(1.8, Math.log10(1 + out) * 0.5);
    p.dest.heat = Math.min(1, p.dest.heat + 0.6);
    this.pulse(p.dest.px, p.dest.py, p.dest.color, 16);
    const sp = this.spokes.get(p.dest.id);
    if (sp) sp.activity = Math.min(1, sp.activity + 0.25);
    this.go(p, 'retA');
  }

  private shatter(p: Particle, color: number): void {
    if (p.phase === 'shatter') return;
    p.phase = 'shatter';
    p.life = 800;
    p.shardColor = color;
    p.shards = Array.from({ length: 10 }, () => {
      const a = Math.random() * Math.PI * 2;
      const v = 30 + Math.random() * 90;
      return { x: p.x, y: p.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v };
    });
    this.pulse(p.x, p.y, color, 22);
    this.byFlight.delete(p.id);
  }

  private pulse(x: number, y: number, color: number, max: number): void {
    this.pulses.push({ x, y, color, t: 0, max });
  }

  // ------------------------------------------------------------------- frame

  private tick(dt: number, now: number): void {
    if (!this.reducedMotion) this.sweep = (this.sweep + dt * 0.0009) % (Math.PI * 2);
    for (const s of this.stations.values()) s.heat *= Math.exp(-dt / 1400);
    for (const sp of this.spokes.values()) sp.activity *= Math.exp(-dt / 2500);
    for (const pl of this.pulses) pl.t += dt / 700;
    this.pulses = this.pulses.filter((pl) => pl.t < 1);

    const [hx, hy] = this.hub;
    for (const p of this.particles) {
      const agentSp = this.spokes.get(p.agent.id);
      const destSp = this.spokes.get(p.dest.id);
      if (!agentSp || !destSp) {
        p.phase = 'shatter';
        p.life = 0;
        continue;
      }
      let pos: Pt = [p.x, p.y];
      p.seg = undefined;
      switch (p.phase) {
        case 'in':
          p.t += dt / IN_MS;
          p.seg = { bez: agentSp.bez, k: ease(Math.min(1, p.t)) };
          pos = bezAt(agentSp.bez, p.seg.k);
          if (p.t >= 1) {
            p.phase = 'hub';
            p.t = 0;
            this.pulse(pos[0], pos[1], p.color, 12);
          }
          break;
        case 'hub': {
          p.t += dt / HUB_MS;
          const a = Math.atan2(pos[1] - hy, pos[0] - hx) + dt * 0.004;
          pos = [hx + Math.cos(a) * (this.hubR + 4), hy + Math.sin(a) * (this.hubR + 4)];
          const waited = now - p.born - IN_MS;
          if (p.t >= 1 && (p.verdict !== 'pending' || waited > 1800 || p.completed)) {
            if (p.verdict === 'deny') {
              const gate = destSp.gates.find((g) => g.rule.effect === 'deny');
              if (gate) {
                this.go(p, 'out');
                p.stopAt = gate.t;
              } else this.shatter(p, STATUS_COLORS.denied);
            } else if (p.verdict === 'held') this.enterHold(p);
            else this.go(p, 'out');
          }
          break;
        }
        case 'out': {
          p.t += dt / OUT_MS;
          const k = ease(Math.min(1, p.t));
          p.seg = { bez: destSp.bez, k };
          const target = bezAt(destSp.bez, k);
          pos = p.from && p.t < 0.3 ? lerp(p.from, target, p.t / 0.3) : target;
          if (p.stopAt != null && k >= p.stopAt) {
            p.x = pos[0];
            p.y = pos[1];
            this.shatter(p, STATUS_COLORS.denied);
            break;
          }
          if (p.t >= 1) {
            if (p.completed?.status === 'ok') this.startReturn(p);
            else if (p.completed && p.completed.status !== 'ok') this.shatter(p, p.completed.status === 'ticketed' ? STATUS_COLORS.held : STATUS_COLORS.denied);
            else {
              p.phase = 'await';
              p.t = 0;
              p.from = undefined;
            }
          }
          break;
        }
        case 'await': {
          p.angle += dt * 0.006;
          pos = [p.dest.px - 10 + Math.cos(p.angle) * 6, p.dest.py + Math.sin(p.angle) * 6];
          break;
        }
        case 'hold': {
          p.t += dt;
          p.angle += dt * 0.0012;
          const ring: Pt = [hx + Math.cos(p.angle) * this.holdR, hy + Math.sin(p.angle) * this.holdR * 0.92];
          pos = p.from && p.t < 450 ? lerp(p.from, ring, ease(p.t / 450)) : ring;
          break;
        }
        case 'retA': {
          p.t += dt / RET_MS;
          p.seg = { bez: destSp.bez, k: 1 - ease(Math.min(1, p.t)) };
          const target = bezAt(destSp.bez, p.seg.k);
          pos = p.from && p.t < 0.25 ? lerp(p.from, target, p.t / 0.25) : target;
          if (p.t >= 1) {
            p.phase = 'retB';
            p.t = 0;
            p.from = undefined;
          }
          break;
        }
        case 'retB':
          p.t += dt / RET_MS;
          p.seg = { bez: agentSp.bez, k: 1 - ease(Math.min(1, p.t)) };
          pos = bezAt(agentSp.bez, p.seg.k);
          if (p.t >= 1) {
            p.agent.heat = Math.min(1, p.agent.heat + 0.35);
            this.pulse(p.agent.px, p.agent.py, RESPONSE, 12);
            p.life = -1;
          }
          break;
        case 'shatter':
          p.life -= dt;
          for (const s of p.shards ?? []) {
            s.x += (s.vx * dt) / 1000;
            s.y += (s.vy * dt) / 1000;
            s.vx *= 0.97;
            s.vy *= 0.97;
          }
          break;
      }
      if (p.phase !== 'shatter') {
        p.trail.push([p.x, p.y]);
        if (p.trail.length > 12) p.trail.shift();
        p.x = pos[0];
        p.y = pos[1];
      }
      if (p.phase !== 'hold' && p.phase !== 'shatter' && now - p.born > MAX_AGE_MS) p.life = -1;
    }
    this.particles = this.particles.filter((p) => !(p.life < 0 || (p.phase === 'shatter' && p.life <= 0)));
    for (const [id, p] of this.byFlight) if (!this.particles.includes(p)) this.byFlight.delete(id);

    const cutoff = Date.now() - 60_000;
    while (this.hubArrivals.length && this.hubArrivals[0]!.ts < cutoff) this.hubArrivals.shift();
    for (const s of this.stations.values()) while (s.arrivals.length && s.arrivals[0]! < cutoff) s.arrivals.shift();

    if (this.pointer && now - this.lastHover > 250) this.hoverTest(false);
  }

  private drawBackground(): void {
    if (this.bg && this.bg.width === this.canvas.width && this.bg.height === this.canvas.height) {
      this.ctx.drawImage(this.bg, 0, 0, this.w, this.h);
      return;
    }
    const c = document.createElement('canvas');
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    const g = c.getContext('2d')!;
    g.scale(this.dpr, this.dpr);
    const grad = g.createLinearGradient(0, 0, 0, this.h);
    grad.addColorStop(0, '#f8fafc');
    grad.addColorStop(1, '#f1f4f9');
    g.fillStyle = grad;
    g.fillRect(0, 0, this.w, this.h);
    g.fillStyle = '#dde4ee';
    for (let x = 12; x < this.w; x += 24) for (let y = 12; y < this.h; y += 24) g.fillRect(x, y, 1.2, 1.2);
    this.bg = c;
    this.ctx.drawImage(c, 0, 0, this.w, this.h);
  }

  private draw(now: number): void {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawBackground();
    const [hx, hy] = this.hub;

    // Radar: rings + slow sweep around the tower.
    const maxR = Math.min(260, Math.max(140, (this.w - this.rightInset) * 0.16));
    ctx.save();
    for (const r of [this.holdR + 36, maxR * 0.75, maxR]) {
      ctx.beginPath();
      ctx.arc(hx, hy, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(31,94,255,0.07)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (!this.reducedMotion && 'createConicGradient' in ctx) {
      const cg = ctx.createConicGradient(this.sweep, hx, hy);
      cg.addColorStop(0, 'rgba(31,94,255,0.10)');
      cg.addColorStop(0.1, 'rgba(31,94,255,0)');
      cg.addColorStop(1, 'rgba(31,94,255,0)');
      ctx.fillStyle = cg;
      ctx.beginPath();
      ctx.arc(hx, hy, maxR, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Zones.
    for (const zb of this.zoneBoxes) {
      const c = hexToNum(zb.zone.color);
      roundRect(ctx, zb.x, zb.y, zb.w, zb.h, 14);
      ctx.fillStyle = rgba(c, 0.05);
      ctx.fill();
      ctx.strokeStyle = rgba(c, 0.32);
      ctx.lineWidth = 1;
      ctx.stroke();
      roundRect(ctx, zb.chip.x, zb.chip.y, zb.chip.w, zb.chip.h, 9);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = rgba(c, 0.35);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(zb.chip.x + 10, zb.chip.y + 9, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = hex(c);
      ctx.fill();
      ctx.font = `600 10.5px ${FONT}`;
      ctx.fillStyle = '#334155';
      ctx.textBaseline = 'middle';
      ctx.fillText(zb.zone.name.toUpperCase(), zb.chip.x + 18, zb.chip.y + 9.5);
    }

    // Spokes.
    for (const sp of this.spokes.values()) {
      const { p0, p1, p2, p3 } = sp.bez;
      const blocked = sp.gates.some((g) => g.rule.effect === 'deny' && !g.rule.from_zone);
      ctx.beginPath();
      ctx.moveTo(p0[0], p0[1]);
      ctx.bezierCurveTo(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]);
      ctx.strokeStyle = blocked ? rgba(STATUS_COLORS.denied, 0.35) : LINE;
      ctx.lineWidth = 1.25;
      ctx.setLineDash(sp.station.kind === 'unknown' ? [4, 4] : []);
      ctx.stroke();
      ctx.setLineDash([]);
      if (sp.activity > 0.02) {
        // A gentle breathing tint on the line itself: same width, soft alpha, slow pulse.
        const breath = 0.65 + 0.35 * Math.sin(now / 420 + sp.station.py * 0.05);
        ctx.strokeStyle = rgba(sp.station.color, Math.min(0.3, sp.activity * 0.3) * breath);
        ctx.lineWidth = 1.75;
        ctx.stroke();
      }
    }

    // Holding pattern.
    const held = this.particles.filter((p) => p.phase === 'hold').length;
    ctx.beginPath();
    ctx.ellipse(hx, hy, this.holdR, this.holdR * 0.92, 0, 0, Math.PI * 2);
    ctx.setLineDash([3, 6]);
    ctx.lineDashOffset = -now / 60;
    ctx.strokeStyle = held ? rgba(STATUS_COLORS.held, 0.75) : 'rgba(138,152,173,0.35)';
    ctx.lineWidth = held ? 1.5 : 1;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;

    // Gates.
    for (const sp of this.spokes.values()) {
      for (const g of sp.gates) this.drawGate(g.x, g.y, g.rule, this.hovered === `gate:${g.rule.id}:${sp.station.id}`);
    }

    // Flights: a soft band of light travelling along the line — no dots.
    for (const p of this.particles) {
      if (p.phase === 'shatter') continue; // blocked flights are shown as a flash ring (see pulses)
      if (p.phase === 'hold') {
        // Holding: a short glowing arc on the holding ring that breathes.
        const breathe = 0.55 + 0.45 * Math.sin(now / 260 + p.angle * 3);
        for (const [w, a] of [
          [7, 0.1],
          [2.5, 0.55],
        ] as const) {
          ctx.beginPath();
          ctx.ellipse(hx, hy, this.holdR, this.holdR * 0.92, 0, p.angle - 0.22, p.angle + 0.22);
          ctx.strokeStyle = rgba(STATUS_COLORS.held, a * breathe);
          ctx.lineWidth = w;
          ctx.lineCap = 'round';
          ctx.stroke();
        }
        continue;
      }
      if (!p.seg) continue;
      const { bez, k } = p.seg;
      const half = 0.1;
      const steps = 14;
      const strength = 0.45 + Math.min(0.25, p.size * 0.15);
      ctx.lineCap = 'round';
      for (const [w, a] of [
        [7, 0.08],
        [2.5, strength],
      ] as const) {
        let prev = bezAt(bez, Math.max(0, Math.min(1, k - half)));
        for (let i = 1; i <= steps; i++) {
          const t = k - half + (2 * half * i) / steps;
          if (t < 0 || t > 1) continue;
          const pt = bezAt(bez, t);
          const d = Math.abs(t - k) / half;
          const alpha = a * (1 - d) * (1 - d);
          if (alpha > 0.005) {
            ctx.beginPath();
            ctx.moveTo(prev[0], prev[1]);
            ctx.lineTo(pt[0], pt[1]);
            ctx.strokeStyle = rgba(p.color, alpha);
            ctx.lineWidth = w;
            ctx.stroke();
          }
          prev = pt;
        }
      }
    }

    this.drawHub(now, held);

    // Station cards.
    for (const s of this.stations.values()) this.drawCard(s);

    // Pulses.
    for (const pl of this.pulses) {
      ctx.beginPath();
      ctx.arc(pl.x, pl.y, 4 + pl.t * pl.max, 0, Math.PI * 2);
      ctx.strokeStyle = rgba(pl.color, (1 - pl.t) * 0.6);
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Lasso.
    if (this.lasso && this.lasso.length > 1) {
      ctx.beginPath();
      ctx.moveTo(this.lasso[0]![0], this.lasso[0]![1]);
      for (const [x, y] of this.lasso) ctx.lineTo(x, y);
      ctx.closePath();
      ctx.fillStyle = 'rgba(31,94,255,0.07)';
      ctx.fill();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = 'rgba(31,94,255,0.9)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (this.stations.size === 0) {
      ctx.font = `500 13px ${FONT}`;
      ctx.fillStyle = INK_DIM;
      ctx.textAlign = 'center';
      ctx.fillText('No agents yet — create an API key or start with CT_DEMO=1', hx, hy + this.hubR + 60);
      ctx.textAlign = 'left';
    }
  }

  private drawGate(x: number, y: number, rule: Rule, hot: boolean): void {
    const ctx = this.ctx;
    const c = rule.effect === 'deny' ? STATUS_COLORS.denied : rule.effect === 'require_approval' ? STATUS_COLORS.held : STATUS_COLORS.ok;
    ctx.save();
    ctx.shadowColor = 'rgba(15,27,45,0.12)';
    ctx.shadowBlur = hot ? 10 : 6;
    ctx.shadowOffsetY = 1;
    ctx.beginPath();
    ctx.arc(x, y, hot ? 11 : 10, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(x, y, hot ? 11 : 10, 0, Math.PI * 2);
    ctx.strokeStyle = hex(c);
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = hex(c);
    ctx.strokeStyle = hex(c);
    if (rule.effect === 'deny') {
      roundRect(ctx, x - 5, y - 1.5, 10, 3, 1.5);
      ctx.fill();
    } else if (rule.effect === 'require_approval') {
      // hourglass
      ctx.beginPath();
      ctx.moveTo(x - 4, y - 5);
      ctx.lineTo(x + 4, y - 5);
      ctx.lineTo(x - 4, y + 5);
      ctx.lineTo(x + 4, y + 5);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(x - 4, y);
      ctx.lineTo(x - 1, y + 3);
      ctx.lineTo(x + 4, y - 3);
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
  }

  private drawHub(now: number, held: number): void {
    const ctx = this.ctx;
    const [hx, hy] = this.hub;
    const r = this.hubR;
    const beat = 1 + Math.sin(now / 900) * 0.04;
    ctx.beginPath();
    ctx.arc(hx, hy, (r + 10) * beat, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(31,94,255,0.06)';
    ctx.fill();
    ctx.save();
    ctx.shadowColor = 'rgba(15,27,45,0.16)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 4;
    ctx.beginPath();
    ctx.arc(hx, hy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(hx, hy, r, 0, Math.PI * 2);
    ctx.strokeStyle = '#cfd9e8';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    if (this.logo.length) {
      ctx.save();
      const s = (r * 1.25) / 64;
      ctx.translate(hx - 32 * s, hy - 32 * s);
      ctx.scale(s, s);
      for (const l of this.logo) {
        ctx.fillStyle = l.fill;
        ctx.fill(l.path);
      }
      ctx.restore();
    }
    const rpm = this.hubArrivals.length;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `700 10px ${FONT}`;
    ctx.fillStyle = '#334155';
    ctx.fillText('CONTROL TOWER', hx, hy + this.holdR + 22);
    ctx.font = `500 11px ${FONT}`;
    ctx.fillStyle = INK_FAINT;
    ctx.fillText(`${rpm} flight${rpm === 1 ? '' : 's'}/min${held ? ` · ${held} holding` : ''}`, hx, hy + this.holdR + 37);
    ctx.textAlign = 'left';
  }

  private drawCard(s: Station): void {
    const ctx = this.ctx;
    const hot = this.hovered === `station:${s.id}`;
    ctx.save();
    ctx.shadowColor = `rgba(15,27,45,${hot ? 0.14 : 0.07})`;
    ctx.shadowBlur = hot ? 16 : 10;
    ctx.shadowOffsetY = 2;
    roundRect(ctx, s.x, s.y, s.w, s.h, 10);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.restore();
    roundRect(ctx, s.x + 0.5, s.y + 0.5, s.w - 1, s.h - 1, 10);
    ctx.strokeStyle = s.heat > 0.05 ? rgba(s.color, 0.25 + s.heat * 0.5) : hot ? '#b9c7dd' : '#e1e7ef';
    ctx.lineWidth = s.heat > 0.05 ? 1.5 : 1;
    ctx.stroke();

    // Icon tile.
    const ix = s.x + 10;
    const iy = s.y + (s.h - 26) / 2;
    roundRect(ctx, ix, iy, 26, 26, 7);
    ctx.fillStyle = rgba(s.color, 0.1);
    ctx.fill();
    this.drawGlyph(s, ix + 13, iy + 13);

    // Text.
    const tx = ix + 36;
    const right = s.x + s.w - 12;
    const rpm = s.arrivals.length;
    ctx.font = `600 11px ${FONT}`;
    const rpmText = rpm ? `${rpm}/min` : '';
    const rpmW = rpmText ? ctx.measureText(rpmText).width + 8 : 0;
    ctx.textBaseline = 'alphabetic';
    const compact = s.h < 40;
    ctx.font = `600 ${compact ? 11.5 : 12.5}px ${FONT}`;
    ctx.fillStyle = INK;
    ctx.fillText(fitText(ctx, s.label, right - tx - rpmW), tx, s.y + (compact ? s.h / 2 + 4 : s.h / 2 - 2));
    if (!compact) {
      ctx.font = `400 11px ${FONT}`;
      ctx.fillStyle = INK_DIM;
      ctx.fillText(fitText(ctx, s.sub, right - tx), tx, s.y + s.h / 2 + 13);
    }
    if (rpmText) {
      ctx.font = `600 11px ${FONT}`;
      ctx.fillStyle = INK_FAINT;
      ctx.textAlign = 'right';
      ctx.fillText(rpmText, right, s.y + (compact ? s.h / 2 + 4 : s.h / 2 - 2));
      ctx.textAlign = 'left';
    }

    // Port.
    ctx.beginPath();
    ctx.arc(s.px, s.py, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = s.heat > 0.05 ? hex(s.color) : '#b9c7dd';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  private drawGlyph(s: Station, cx: number, cy: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = hex(s.color);
    ctx.fillStyle = hex(s.color);
    ctx.lineWidth = 1.6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    switch (s.kind) {
      case 'agent': {
        roundRect(ctx, cx - 6, cy - 4, 12, 9, 3);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx, cy - 4);
        ctx.lineTo(cx, cy - 7);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx, cy - 7.5, 1.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(cx - 2.5, cy + 0.5, 1.2, 0, Math.PI * 2);
        ctx.arc(cx + 2.5, cy + 0.5, 1.2, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'model': {
        roundRect(ctx, cx - 5, cy - 5, 10, 10, 2);
        ctx.stroke();
        for (const d of [-2.5, 2.5]) {
          ctx.beginPath();
          ctx.moveTo(cx + d, cy - 5);
          ctx.lineTo(cx + d, cy - 8);
          ctx.moveTo(cx + d, cy + 5);
          ctx.lineTo(cx + d, cy + 8);
          ctx.moveTo(cx - 5, cy + d);
          ctx.lineTo(cx - 8, cy + d);
          ctx.moveTo(cx + 5, cy + d);
          ctx.lineTo(cx + 8, cy + d);
          ctx.stroke();
        }
        break;
      }
      case 'mcp': {
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = Math.PI / 6 + (i * Math.PI) / 3;
          const x = cx + Math.cos(a) * 7;
          const y = cy + Math.sin(a) * 7;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx, cy, 2, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      default: {
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.arc(cx, cy, 6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  // ------------------------------------------------------------ interaction

  private laneFor(sp: Spoke): Lane & { fromLabel: string; toLabel: string } {
    const s = sp.station;
    let requests = 0;
    let cost = 0;
    let errors = 0;
    let denied = 0;
    let latSum = 0;
    let latN = 0;
    for (const l of this.laneStats.values()) {
      if ((s.kind === 'agent' && l.from === s.id) || (s.kind !== 'agent' && l.to === s.id)) {
        requests += l.requests;
        cost += l.cost;
        errors += l.errors;
        denied += l.denied;
        if (l.avgMs != null) {
          latSum += l.avgMs * l.requests;
          latN += l.requests;
        }
      }
    }
    const g = sp.gates[0];
    return {
      from: s.kind === 'agent' ? s.id : 'tower',
      to: s.kind === 'agent' ? 'tower' : s.id,
      activity: sp.activity,
      requests,
      cost,
      errors,
      denied,
      avgMs: latN ? latSum / latN : null,
      cx: 0,
      cy: 0,
      gate: g ? { rule: g.rule, x: g.x, y: g.y } : null,
      fromLabel: s.kind === 'agent' ? s.label : 'Control Tower',
      toLabel: s.kind === 'agent' ? 'Control Tower' : s.label,
    };
  }

  private hitTest(x: number, y: number): ClickInfo {
    for (const s of this.stations.values()) {
      if (x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) return { kind: 'station', station: s, x, y };
    }
    for (const sp of this.spokes.values()) {
      for (const g of sp.gates) if ((g.x - x) ** 2 + (g.y - y) ** 2 < 14 * 14) return { kind: 'gate', rule: g.rule, lane: this.laneFor(sp), x, y };
    }
    for (const zb of this.zoneBoxes) {
      const c = zb.chip;
      if (x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h) return { kind: 'zone', zone: zb.zone, x, y };
    }
    return { kind: 'empty', x, y };
  }

  private hoverTest(fromMove: boolean): void {
    this.lastHover = performance.now();
    if (!this.pointer || this.lasso) {
      if (fromMove) this.hoverCb?.(null);
      return;
    }
    const [x, y] = this.pointer;
    for (const s of this.stations.values()) {
      if (x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) {
        this.hovered = `station:${s.id}`;
        this.canvas.style.cursor = this.drawMode ? 'crosshair' : 'default';
        this.hoverCb?.({ x, y, station: { ...s, rpm: s.arrivals.length } });
        return;
      }
    }
    for (const sp of this.spokes.values()) {
      for (const g of sp.gates) {
        if ((g.x - x) ** 2 + (g.y - y) ** 2 < 14 * 14) {
          this.hovered = `gate:${g.rule.id}:${sp.station.id}`;
          this.canvas.style.cursor = 'pointer';
          this.hoverCb?.({ x, y, gate: { rule: g.rule, lane: this.laneFor(sp) } });
          return;
        }
      }
    }
    for (const zb of this.zoneBoxes) {
      const c = zb.chip;
      if (x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h) {
        this.hovered = `zone:${zb.zone.id}`;
        this.canvas.style.cursor = 'pointer';
        this.hoverCb?.({ x, y, zone: zb.zone });
        return;
      }
    }
    const [hx, hy] = this.hub;
    if ((hx - x) ** 2 + (hy - y) ** 2 < (this.hubR + 6) ** 2) {
      this.hovered = 'hub';
      this.canvas.style.cursor = 'default';
      const costPerMin = this.hubArrivals.reduce((s, a) => s + a.cost, 0);
      this.hoverCb?.({ x, y, hub: { rpm: this.hubArrivals.length, held: this.particles.filter((p) => p.phase === 'hold').length, costPerMin } });
      return;
    }
    let best: { sp: Spoke; d: number } | null = null;
    for (const sp of this.spokes.values()) {
      for (let t = 0.04; t < 0.97; t += 0.04) {
        const [px, py] = bezAt(sp.bez, t);
        const d = (px - x) ** 2 + (py - y) ** 2;
        if (d < 49 && (!best || d < best.d)) best = { sp, d };
      }
    }
    this.canvas.style.cursor = this.drawMode ? 'crosshair' : 'default';
    if (best) {
      this.hovered = `spoke:${best.sp.station.id}`;
      this.hoverCb?.({ x, y, lane: this.laneFor(best.sp) });
      return;
    }
    this.hovered = null;
    this.hoverCb?.(null);
  }
}
