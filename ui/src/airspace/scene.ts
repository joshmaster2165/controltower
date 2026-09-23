import type { FlightEvent } from '@controltower/shared';
import type { ObservedEdge, PolicyBundle, Rule, Topology, TopologyEdge, Zone } from '../api';
import { agentColor, hex, MCP_COLOR, PROVIDER_COLORS, STATUS_COLORS } from './colors';

/**
 * The Airspace — a live map of the agentic ecosystem (Canvas 2D).
 *
 * Agents (left) connect through Control Tower (centre) to model deployments
 * and MCP tool servers (right); tool servers list their tools. Nothing
 * travels: every connection shows its *state*, which stays legible at scale.
 *
 *   active   traffic in the last minute — agent/station colour, weight ∝ rate
 *   idle     used in the last 24h, quiet now — solid grey
 *   unused   never used — faint dashed
 *   holding  a flight is waiting for human approval — amber
 *   blocked  most recent traffic denied — red
 *
 * Click a node to focus it: everything it talks to is highlighted and the
 * rest of the map recedes.
 */

const WINDOW_MS = 60_000;
const STALE_MS = 60_000;
const TOOL_ROW = 20;
const FONT = 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const INK = '#0f1b2d';
const INK_DIM = '#5b6b82';
const INK_FAINT = '#8a98ad';
const LINE_IDLE = '#c9d3e1';
const LINE_UNUSED = '#dfe5ee';
const ACCENT_HEX = '#1f5eff';

export type StationKind = 'agent' | 'model' | 'mcp' | 'observed' | 'unknown';
export type ToolOp = 'read' | 'write' | 'admin' | 'unknown';

export interface ToolRow {
  name: string;
  full: string;
  op: ToolOp;
  recent: number[];
  lastAt: number;
  count24h: number;
  gates: Rule[];
  y: number;
  /** Where this row's gate icons were drawn (world), for clicking them. */
  gateHits: Array<{ rule: Rule; x: number; y: number }>;
}

export interface Station {
  id: string;
  kind: StationKind;
  label: string;
  sub: string;
  slug: string;
  color: number;
  x: number;
  y: number;
  w: number;
  h: number;
  headH: number;
  px: number;
  py: number;
  tools: ToolRow[];
  expanded: boolean;
  userToggled: boolean;
  recent: number[];
  denials: number[];
  lastAt: number;
  held: number;
  /** Observed systems only: reported by agents, not proxied, so never enforced. */
  obs?: { target: string; kind: string; bypass: boolean; lastSeen: number; count24h: number; errors24h: number } | undefined;
}

export type LinkState = 'active' | 'idle' | 'unused' | 'holding' | 'blocked';

export interface StationView {
  id: string;
  kind: StationKind;
  label: string;
  sub: string;
  color: number;
  rpm: number;
  held: number;
  state: LinkState;
  requests24h: number;
  cost24h: number;
  errors24h: number;
  denied24h: number;
  /** Calls reported by the agent (SDK / OpenTelemetry) that bypass Control Tower. */
  observed24h: number;
  obs?: Station['obs'];
}

export interface LaneView {
  fromLabel: string;
  toLabel: string;
  state: LinkState;
  rpm: number;
  requests: number;
  cost: number;
  errors: number;
  denied: number;
  gate: { rule: Rule } | null;
}

export interface HoverInfo {
  x: number;
  y: number;
  station?: StationView;
  lane?: LaneView;
  zone?: Zone;
  gate?: { rule: Rule; hits: number };
  hub?: { rpm: number; held: number; active: number };
  tool?: { server: string; name: string; op: ToolOp; rpm: number; count24h: number; gates: Rule[] };
  observedLine?: { agent: string; target: string; system: string | null; bypass: boolean; count24h: number; errors24h: number; writes24h: number; lastSeen: number };
}

export type ClickInfo =
  | { kind: 'station'; station: StationView; x: number; y: number }
  | { kind: 'zone'; zone: Zone; x: number; y: number }
  | { kind: 'gate'; rule: Rule; x: number; y: number }
  | { kind: 'lasso'; stationIds: string[]; x: number; y: number }
  /** A line was clicked: agent spoke (traffic from an agent) or destination spoke (traffic to it). */
  | { kind: 'lane'; stationId: string; stationKind: StationKind; x: number; y: number }
  /** A tool row was clicked. */
  | { kind: 'tool'; serverId: string; tool: string; x: number; y: number }
  /** Gate mode: dragged from an agent to a destination (optionally a single tool). */
  | { kind: 'connect'; agentId: string; destId: string; tool?: string | undefined; x: number; y: number }
  /** Right-click on a node. */
  | { kind: 'context'; stationId: string; stationKind: StationKind; x: number; y: number }
  | { kind: 'empty'; x: number; y: number };

export interface FocusSummary {
  station: StationView;
  links: Array<{ id: string; label: string; kind: StationKind; color: number; requests: number; cost: number; denied: number; errors: number; live: boolean; tools: Array<{ name: string; requests: number }>; observed?: boolean; bypass?: boolean }>;
}

export interface SceneStats {
  active: number;
  stations: number;
  held: number;
}

type Pt = [number, number];
interface Bez {
  p0: Pt;
  p1: Pt;
  p2: Pt;
  p3: Pt;
}
interface Spoke {
  station: Station;
  bez: Bez;
  gates: Array<{ rule: Rule; x: number; y: number }>;
}

const LOGO_PATHS = [
  { d: 'M13 18h38l-4.5 12H17.5z', fill: '#1f5eff' },
  { d: 'M26.5 30h11l3.5 25H23z', fill: '#0b3d91' },
  { d: 'M30.5 6.5a1.5 1.5 0 0 1 3 0v8a1.5 1.5 0 0 1-3 0z', fill: '#0b3d91' },
  { d: 'M19.25 54h25.5a2.25 2.25 0 0 1 0 4.5h-25.5a2.25 2.25 0 0 1 0-4.5z', fill: '#0b3d91' },
  { d: 'M21.5 22.5h21a1.5 1.5 0 0 1 0 3h-21a1.5 1.5 0 0 1 0-3z', fill: '#ffffff' },
];

/** Compact operation badges on tool rows (R read, W write, D destructive); the tooltip spells them out. */
const OP_STYLE: Record<ToolOp, { label: string; color: string }> = {
  read: { label: 'R', color: '#1a9e6b' },
  write: { label: 'W', color: '#1f5eff' },
  admin: { label: 'D', color: '#d3374e' },
  unknown: { label: '', color: '#8a98ad' },
};

function rgba(c: number, a: number): string {
  return `rgba(${(c >> 16) & 255},${(c >> 8) & 255},${c & 255},${a})`;
}
function hexToNum(h: string): number {
  return Number.parseInt(h.replace('#', ''), 16) || 0x1f5eff;
}
/** Observed systems are outside the gateway: nothing can be gated or zoned there. */
function gateable(kind: StationKind): boolean {
  return kind !== 'unknown' && kind !== 'observed';
}

function gateColor(rule: Rule): number {
  return rule.effect === 'deny' ? STATUS_COLORS.denied : rule.effect === 'require_approval' ? STATUS_COLORS.held : rule.effect === 'inspect' ? STATUS_COLORS.info : STATUS_COLORS.ok;
}

function bezAt(b: Bez, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u;
  const bb = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return [a * b.p0[0] + bb * b.p1[0] + c * b.p2[0] + d * b.p3[0], a * b.p0[1] + bb * b.p1[1] + c * b.p2[1] + d * b.p3[1]];
}
function globMatch(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return pattern === value;
  return new RegExp('^' + pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(value);
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
  if (max <= 0) return '';
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
function prune(arr: number[], cutoff: number): void {
  let i = 0;
  while (i < arr.length && arr[i]! < cutoff) i++;
  if (i) arr.splice(0, i);
}

export class AirspaceScene {
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private host!: HTMLElement;
  private ro: ResizeObserver | null = null;
  private raf = 0;
  private dpr = 1;
  private w = 0;
  private h = 0;
  private ready = false;
  private dirty = true;
  private lastDraw = 0;
  private lastHoverRefresh = 0;

  private stations = new Map<string, Station>();
  private spokes = new Map<string, Spoke>();
  private edges: TopologyEdge[] = [];
  private used24h = new Set<string>();
  private livePairs = new Map<string, number>(); // `${agent}>${dest}` → last ts
  private liveToolPairs = new Map<string, number>(); // `${agent}>${dest}|${tool}` → last ts
  private live = new Map<string, { agent: string; dest: string | undefined; held: boolean }>();
  private ruleHits = new Map<string, number[]>();
  private hubRecent: number[] = [];
  private zoneBoxes: Array<{ zone: Zone; x: number; y: number; w: number; h: number; chip: { x: number; y: number; w: number; h: number } }> = [];
  private topology: Topology | null = null;
  private policy: PolicyBundle | null = null;
  private alerted = new Set<string>();
  /** A simulated gate's effect per station (agents and destinations), drawn over the map until cleared. */
  private sim: Map<string, { deny: number; hold: number; allow: number }> | null = null;
  /** Gates that cover every path (no agent, destination or zone): drawn on the tower itself. */
  private hubGates: Array<{ rule: Rule; x: number; y: number }> = [];
  private obsEdges: ObservedEdge[] = [];
  /** Agent → observed system, drawn straight across (not through the tower). */
  private obsLines: Array<{ edge: ObservedEdge; agent: Station; target: Station; bez: Bez }> = [];
  private hub: Pt = [0, 0];
  private hubR = 36;
  private holdR = 70;
  private rightInset = 0;
  private pointer: Pt | null = null;
  private hovered: string | null = null;
  private lasso: Pt[] | null = null;
  private hoverCb: ((h: HoverInfo | null) => void) | null = null;
  private clickCb: ((c: ClickInfo) => void) | null = null;
  private unknownStation: Station | null = null;
  private logo: Array<{ path: Path2D; fill: string }> = [];
  private focusId: string | null = null;
  private relatedCache: { id: string; set: Set<string> } | null = null;
  /** Camera: screen = world * k + (x, y). */
  private cam = { x: 0, y: 0, k: 1 };
  /** User-placed card positions (world, top-left); '__hub' is the tower centre. */
  private positions = new Map<string, Pt>();
  private drag: { kind: 'station' | 'hub' | 'pan'; id: string; start: Pt; last: Pt; moved: boolean; offset: Pt } | null = null;
  private layoutCb: ((positions: Record<string, Pt>) => void) | null = null;
  private camCb: ((cam: { x: number; y: number; k: number }) => void) | null = null;
  drawMode = false;
  /** Gate mode: drag from an agent to a destination to put a gate on that path. */
  gateMode = false;
  private connect: { from: Station; start: Pt; end: Pt; down: Pt } | null = null;

  async init(host: HTMLElement): Promise<void> {
    this.host = host;
    this.canvas = document.createElement('canvas');
    this.canvas.style.display = 'block';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Airspace: map of agents, Control Tower, models and tool servers with connection states');
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not available in this browser');
    this.ctx = ctx;
    host.prepend(this.canvas);
    try {
      this.logo = LOGO_PATHS.map((p) => ({ path: new Path2D(p.d), fill: p.fill }));
    } catch {
      this.logo = [];
    }
    this.resize();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);

    const screenPos = (ev: MouseEvent): Pt => {
      const r = this.canvas.getBoundingClientRect();
      return [ev.clientX - r.left, ev.clientY - r.top];
    };
    this.canvas.addEventListener('pointermove', (ev) => {
      const sp = screenPos(ev);
      this.pointer = sp;
      if (this.lasso) {
        this.lasso.push(this.toWorld(sp));
        this.dirty = true;
        return;
      }
      if (this.connect) {
        this.connect.end = this.toWorld(sp);
        const t = this.stationAt(this.connect.end);
        this.setHovered(t && gateable(t.kind) && (t.kind === 'agent') !== (this.connect.from.kind === 'agent') ? `station:${t.id}` : null);
        this.dirty = true;
        return;
      }
      const d = this.drag;
      if (d) {
        if (!d.moved && Math.hypot(sp[0] - d.start[0], sp[1] - d.start[1]) > 4) {
          d.moved = true;
          this.canvas.style.cursor = d.kind === 'pan' ? 'grabbing' : 'move';
          this.hoverCb?.(null);
        }
        if (d.moved) {
          if (d.kind === 'pan') {
            this.cam.x += sp[0] - d.last[0];
            this.cam.y += sp[1] - d.last[1];
          } else {
            const wp = this.toWorld(sp);
            this.positions.set(d.kind === 'hub' ? '__hub' : d.id, [Math.round(wp[0] - d.offset[0]), Math.round(wp[1] - d.offset[1])]);
            this.layout();
          }
          d.last = sp;
          this.dirty = true;
        }
        return;
      }
      this.hoverTest();
    });
    this.canvas.addEventListener('pointerleave', () => {
      this.pointer = null;
      if (this.hovered) this.dirty = true;
      this.hovered = null;
      this.hoverCb?.(null);
    });
    this.canvas.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 && ev.button !== 1) return;
      const sp = screenPos(ev);
      const wp = this.toWorld(sp);
      this.canvas.setPointerCapture(ev.pointerId);
      if (this.drawMode && ev.button === 0) {
        this.lasso = [wp];
        return;
      }
      if (this.gateMode && ev.button === 0) {
        const s = this.stationAt(wp);
        if (s && gateable(s.kind)) {
          this.connect = { from: s, start: [s.px, s.py], end: wp, down: sp };
          this.hoverCb?.(null);
          return;
        }
      }
      let kind: 'station' | 'hub' | 'pan' = 'pan';
      let id = '';
      let offset: Pt = [0, 0];
      if (ev.button === 0) {
        const s = this.stationAt(wp);
        if (s) {
          kind = 'station';
          id = s.id;
          offset = [wp[0] - s.x, wp[1] - s.y];
        } else if ((this.hub[0] - wp[0]) ** 2 + (this.hub[1] - wp[1]) ** 2 < (this.hubR + 6) ** 2) {
          kind = 'hub';
          id = '__hub';
          offset = [wp[0] - this.hub[0], wp[1] - this.hub[1]];
        }
      }
      this.drag = { kind, id, start: sp, last: sp, moved: false, offset };
    });
    this.canvas.addEventListener('pointerup', (ev) => {
      const sp = screenPos(ev);
      const wp = this.toWorld(sp);
      if (this.lasso) {
        const poly = this.lasso;
        this.lasso = null;
        this.dirty = true;
        if (poly.length > 2) {
          let area = 0;
          for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) area += (poly[j]![0] + poly[i]![0]) * (poly[j]![1] - poly[i]![1]);
          const [x0, y0] = poly[0]!;
          const [x1, y1] = poly[poly.length - 1]!;
          const inside = (s: Station) => {
            const cx = s.x + s.w / 2;
            const cy = s.y + s.headH / 2;
            return Math.abs(area / 2) < 600 ? cx >= Math.min(x0, x1) && cx <= Math.max(x0, x1) && cy >= Math.min(y0, y1) && cy <= Math.max(y0, y1) : pointInPoly(cx, cy, poly);
          };
          const ids = [...this.stations.values()].filter((s) => gateable(s.kind) && inside(s)).map((s) => s.id);
          this.clickCb?.({ kind: 'lasso', stationIds: ids, x: sp[0], y: sp[1] });
        }
        return;
      }
      if (this.connect) {
        const c = this.connect;
        this.connect = null;
        this.setHovered(null);
        this.dirty = true;
        // A plain click in gate mode: gate what was clicked (a tool row, or the node itself).
        if ((sp[0] - c.down[0]) ** 2 + (sp[1] - c.down[1]) ** 2 < 16) {
          const hit = this.hitTest(wp, sp);
          if (hit.kind === 'station') this.clickCb?.({ kind: 'context', stationId: c.from.id, stationKind: c.from.kind, x: sp[0], y: sp[1] });
          else this.clickCb?.(hit);
          return;
        }
        const target = this.stationAt(wp);
        if (target && gateable(target.kind) && target.id !== c.from.id && (target.kind === 'agent') !== (c.from.kind === 'agent')) {
          const agent = c.from.kind === 'agent' ? c.from : target;
          const dest = c.from.kind === 'agent' ? target : c.from;
          // Dropping on a tool row scopes the gate to that tool.
          const row = dest === target && dest.expanded ? dest.tools.find((r) => wp[1] >= r.y && wp[1] < r.y + TOOL_ROW) : undefined;
          this.clickCb?.({ kind: 'connect', agentId: agent.id, destId: dest.id, tool: row?.name, x: sp[0], y: sp[1] });
        }
        return;
      }
      const d = this.drag;
      this.drag = null;
      this.canvas.style.cursor = 'default';
      if (d?.moved) {
        if (d.kind === 'pan') this.camCb?.({ ...this.cam });
        else this.emitLayout();
        this.hoverTest();
        return;
      }
      // A click, not a drag. Chevron on a tool server toggles its tool list.
      for (const s of this.stations.values()) {
        if (s.kind === 'mcp' && s.tools.length && wp[0] >= s.x + s.w - 26 && wp[0] <= s.x + s.w && wp[1] >= s.y && wp[1] <= s.y + s.headH) {
          s.userToggled = true;
          s.expanded = !s.expanded;
          this.layout();
          return;
        }
      }
      this.clickCb?.(this.hitTest(wp, sp));
    });
    this.canvas.addEventListener('contextmenu', (ev) => {
      const sp = screenPos(ev);
      const s = this.stationAt(this.toWorld(sp));
      if (!s || !gateable(s.kind)) return;
      ev.preventDefault();
      this.clickCb?.({ kind: 'context', stationId: s.id, stationKind: s.kind, x: sp[0], y: sp[1] });
    });
    this.canvas.addEventListener(
      'wheel',
      (ev) => {
        ev.preventDefault();
        const sp = screenPos(ev);
        if (ev.ctrlKey || ev.metaKey) this.zoomAt(sp, Math.exp(-ev.deltaY * 0.01));
        else {
          this.cam.x -= ev.deltaX;
          this.cam.y -= ev.deltaY;
          this.dirty = true;
        }
        this.camCb?.({ ...this.cam });
      },
      { passive: false },
    );

    this.ready = true;
    const frame = (now: number) => {
      // No per-flight motion: redraw only when something changed, plus a slow tick for ageing states.
      const pulsing = this.anyLive();
      if (this.dirty || now - this.lastDraw > (pulsing ? 33 : 1000)) {
        try {
          this.draw();
        } catch (err) {
          console.error('[airspace] draw error', err);
        }
        this.lastDraw = now;
        this.dirty = false;
      }
      if (this.pointer && now - this.lastHoverRefresh > 1000) this.hoverTest();
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
    const now = Date.now();
    let active = 0;
    for (const s of this.stations.values()) if (s.kind !== 'agent' && s.recent.length) active++;
    for (const [, ts] of this.livePairs) if (now - ts < WINDOW_MS) active++;
    let held = 0;
    for (const f of this.live.values()) if (f.held) held++;
    return { active: this.activePairs(now), stations: this.stations.size, held };
  }

  debug(): Record<string, number> {
    return { stations: this.stations.size, live: this.live.size, edges: this.edges.length, active: this.activePairs(Date.now()) };
  }

  stationList(): Array<{ id: string; kind: StationKind }> {
    return [...this.stations.values()].map((s) => ({ id: s.id, kind: s.kind }));
  }

  setRightInset(px: number): void {
    if (this.rightInset === px) return;
    this.rightInset = px;
    this.layout();
  }

  onLayoutChange(cb: (positions: Record<string, Pt>) => void): void {
    this.layoutCb = cb;
  }
  onCamera(cb: (cam: { x: number; y: number; k: number }) => void): void {
    this.camCb = cb;
  }
  /** Saved arrangement from the server (world coordinates). */
  setPositions(p: Record<string, [number, number]>): void {
    this.positions = new Map(Object.entries(p).filter(([, v]) => Array.isArray(v) && v.length === 2 && v.every((n) => Number.isFinite(n))) as Array<[string, Pt]>);
    this.layout();
  }
  hasCustomLayout(): boolean {
    return this.positions.size > 0;
  }
  resetLayout(): void {
    this.positions.clear();
    this.layout();
    this.emitLayout();
    this.fit();
  }
  getCamera(): { x: number; y: number; k: number } {
    return { ...this.cam };
  }
  setCamera(c: { x: number; y: number; k: number }): void {
    if (![c.x, c.y, c.k].every(Number.isFinite)) return;
    this.cam = { x: c.x, y: c.y, k: Math.min(2.5, Math.max(0.25, c.k)) };
    this.dirty = true;
  }
  zoomBy(f: number): void {
    this.zoomAt([(this.w - this.rightInset) / 2, this.h / 2], f);
    this.camCb?.({ ...this.cam });
  }
  /**
   * Render the whole map (every node, not just what is on screen) to a PNG at
   * 2×, with a title strip — for architecture docs and security reviews.
   */
  async exportPng(title: string, subtitle: string): Promise<Blob> {
    let x0 = this.hub[0] - this.holdR - 40;
    let y0 = this.hub[1] - this.holdR - 30;
    let x1 = this.hub[0] + this.holdR + 40;
    let y1 = this.hub[1] + this.holdR + 50;
    for (const s of this.stations.values()) {
      x0 = Math.min(x0, s.x - 16);
      y0 = Math.min(y0, s.y - 36);
      x1 = Math.max(x1, s.x + s.w + 16);
      y1 = Math.max(y1, s.y + s.h + 16);
    }
    const pad = 32;
    const head = 64;
    const scale = 2;
    const W = Math.ceil(x1 - x0 + pad * 2);
    const H = Math.ceil(y1 - y0 + pad * 2 + head);
    const off = document.createElement('canvas');
    off.width = W * scale;
    off.height = H * scale;
    const octx = off.getContext('2d')!;
    const saved = { ctx: this.ctx, w: this.w, h: this.h, dpr: this.dpr, cam: this.cam, hovered: this.hovered, connect: this.connect, lasso: this.lasso };
    try {
      this.ctx = octx;
      this.w = W;
      this.h = H;
      this.dpr = scale;
      this.cam = { k: 1, x: pad - x0, y: pad + head - y0 };
      this.hovered = null;
      this.connect = null;
      this.lasso = null;
      this.draw();
    } finally {
      Object.assign(this, saved);
      this.dirty = true;
    }
    octx.setTransform(scale, 0, 0, scale, 0, 0);
    octx.fillStyle = '#ffffff';
    octx.fillRect(0, 0, W, head);
    octx.fillStyle = '#e3e8f0';
    octx.fillRect(0, head - 1, W, 1);
    octx.fillStyle = INK;
    octx.font = `600 18px ${FONT}`;
    octx.textBaseline = 'alphabetic';
    octx.fillText(title, pad, 30);
    octx.fillStyle = INK_DIM;
    octx.font = `400 12px ${FONT}`;
    octx.fillText(subtitle, pad, 50);
    return new Promise((res, rej) => off.toBlob((b) => (b ? res(b) : rej(new Error('could not encode PNG'))), 'image/png'));
  }

  /** Frame every node in the visible area (left of any right-hand panel). */
  fit(): void {
    const items = [...this.stations.values()];
    if (!items.length) {
      this.cam = { x: 0, y: 0, k: 1 };
      this.dirty = true;
      return;
    }
    let x0 = this.hub[0] - this.holdR - 40;
    let y0 = this.hub[1] - this.holdR - 30;
    let x1 = this.hub[0] + this.holdR + 40;
    let y1 = this.hub[1] + this.holdR + 50;
    for (const s of items) {
      x0 = Math.min(x0, s.x - 16);
      y0 = Math.min(y0, s.y - 36);
      x1 = Math.max(x1, s.x + s.w + 16);
      y1 = Math.max(y1, s.y + s.h + 16);
    }
    const top = 110;
    const bottom = 60;
    const aw = Math.max(200, this.w - this.rightInset - 32);
    const ah = Math.max(200, this.h - top - bottom);
    const k = Math.min(1.25, Math.max(0.25, Math.min(aw / (x1 - x0), ah / (y1 - y0))));
    this.cam = { k, x: 16 + (aw - (x1 - x0) * k) / 2 - x0 * k, y: top + (ah - (y1 - y0) * k) / 2 - y0 * k };
    this.dirty = true;
    this.camCb?.({ ...this.cam });
  }
  private zoomAt(sp: Pt, f: number): void {
    const w = this.toWorld(sp);
    const k = Math.min(2.5, Math.max(0.25, this.cam.k * f));
    this.cam = { k, x: sp[0] - w[0] * k, y: sp[1] - w[1] * k };
    this.dirty = true;
  }
  private toWorld(p: Pt): Pt {
    return [(p[0] - this.cam.x) / this.cam.k, (p[1] - this.cam.y) / this.cam.k];
  }
  private stationAt(wp: Pt): Station | undefined {
    for (const s of this.stations.values()) if (wp[0] >= s.x && wp[0] <= s.x + s.w && wp[1] >= s.y && wp[1] <= s.y + s.h) return s;
    return undefined;
  }
  private emitLayout(): void {
    this.layoutCb?.(Object.fromEntries(this.positions));
  }

  setFocus(id: string | null): void {
    this.focusId = id && this.stations.has(id) ? id : null;
    this.relatedCache = null;
    this.dirty = true;
  }

  // ---------------------------------------------------------------- topology

  private blank(id: string, kind: StationKind, label: string, sub: string, color: number, slug = ''): Station {
    return { id, kind, label, sub, slug, color, x: 0, y: 0, w: 0, h: 0, headH: 46, px: 0, py: 0, tools: [], expanded: true, userToggled: false, recent: [], denials: [], lastAt: 0, held: 0 };
  }

  setTopology(t: Topology): void {
    this.topology = t;
    const keep = new Set<string>();
    const upsert = (id: string, kind: StationKind, label: string, sub: string, color: number, slug = ''): Station => {
      keep.add(id);
      let s = this.stations.get(id);
      if (s) {
        s.label = label;
        s.sub = sub;
        s.color = color;
        s.slug = slug;
      } else {
        s = this.blank(id, kind, label, sub, color, slug);
        this.stations.set(id, s);
      }
      return s;
    };
    for (const k of t.keys) upsert(k.id, 'agent', k.name, [k.team, k.project].filter(Boolean).join(' · ') || 'agent', agentColor(k.agent_id ?? k.id));
    const provById = new Map(t.providers.map((p) => [p.id, p]));
    for (const d of t.deployments) {
      const prov = provById.get(d.provider_id);
      upsert(d.id, 'model', d.public_name ?? d.upstream_model, prov?.name ?? prov?.kind ?? 'model', PROVIDER_COLORS[prov?.kind ?? ''] ?? 0x475569);
    }
    for (const m of t.mcp_servers ?? []) {
      const s = upsert(m.id, 'mcp', m.name, `MCP server · ${m.tools.length} tool${m.tools.length === 1 ? '' : 's'}`, MCP_COLOR, m.slug);
      const prev = new Map(s.tools.map((r) => [r.name, r]));
      s.tools = m.tools.map((tool) => {
        const old = prev.get(tool.name);
        return { name: tool.name, full: `${m.slug}__${tool.name}`, op: tool.op, recent: old?.recent ?? [], lastAt: old?.lastAt ?? 0, count24h: 0, gates: [], y: 0, gateHits: [] };
      });
    }
    const OBS_KIND: Record<string, string> = { http: 'service', database: 'database', queue: 'queue', model: 'model API', saas: 'SaaS', rpc: 'service', tool: 'tool', other: 'system' };
    for (const o of t.observed?.targets ?? []) {
      // postgresql://orders-db.internal/orders → "orders", "postgresql · orders-db.internal"
      const uri = /^([\w+.-]+):\/\/([^/]+)(?:\/(.+))?$/.exec(o.target);
      const label = o.system ?? (uri ? (uri[3] ?? uri[2]!) : o.target);
      const sub = o.bypass
        ? 'direct model call · bypasses gateway'
        : uri && !o.system
          ? `${uri[1]} · ${uri[2]} · observed`
          : `${o.system ? `${o.target} · ` : ''}${OBS_KIND[o.kind] ?? 'system'} · observed`;
      const st = upsert(o.id, 'observed', label, sub, o.bypass ? 0xd3374e : 0x64748b);
      st.obs = { target: o.target, kind: o.kind, bypass: o.bypass, lastSeen: o.last_seen, count24h: o.count_24h, errors24h: o.errors_24h };
    }
    this.obsEdges = t.observed?.edges ?? [];
    for (const id of [...this.stations.keys()]) if (!keep.has(id) && id !== '__unknown') this.stations.delete(id);

    this.edges = t.edges ?? [];
    this.used24h.clear();
    for (const e of this.edges) {
      this.used24h.add(e.key_id);
      this.used24h.add(e.target_id);
      if (e.tool) {
        const row = this.stations.get(e.target_id)?.tools.find((r) => r.name === e.tool);
        if (row) row.count24h += e.requests;
      }
    }
    this.relatedCache = null;
    this.layout();
  }

  setPolicy(p: PolicyBundle): void {
    this.policy = p;
    this.layout();
  }

  /** Highlight the paths a simulated gate would change; null clears it. */
  setSimulation(lanes: Array<{ key_id: string; target_id: string; deny: number; hold: number; allow: number }> | null): void {
    if (!lanes) {
      this.sim = null;
    } else {
      const m = new Map<string, { deny: number; hold: number; allow: number }>();
      for (const l of lanes) {
        for (const id of [l.key_id, l.target_id]) {
          const c = m.get(id) ?? { deny: 0, hold: 0, allow: 0 };
          c.deny += l.deny;
          c.hold += l.hold;
          c.allow += l.allow;
          m.set(id, c);
        }
      }
      this.sim = m;
    }
    this.dirty = true;
  }

  /** Gates that have an alert rule get a bell on their marker. */
  setAlertedGates(ids: Iterable<string>): void {
    this.alerted = new Set(ids);
    this.dirty = true;
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
    this.layout();
  }

  private layout(): void {
    if (!this.canvas) return;
    this.dirty = true;
    const W = Math.max(480, this.w - this.rightInset);
    const padTop = 118;
    const padBottom = 64;
    const avail = Math.max(200, this.h - padTop - padBottom);
    const cardW = Math.round(Math.max(208, Math.min(252, W * 0.18)));
    this.hub = [Math.round(W / 2), Math.round(padTop + avail / 2)];
    this.hubR = 36;
    this.holdR = 70;

    const zones = this.policy?.zones ?? [];
    const rank = (s: Station) => {
      const zs = this.zonesOf(s);
      return zs.length ? zones.findIndex((z) => z.id === zs[0]!.id) : 999;
    };
    const kindRank = (s: Station) => (s.kind === 'model' ? 0 : s.kind === 'mcp' ? 1 : s.kind === 'observed' ? 3 : 2);
    const place = (list: Station[], x: number, side: 'left' | 'right') => {
      list.sort((a, b) => rank(a) - rank(b) || kindRank(a) - kindRank(b) || a.label.localeCompare(b.label));
      const n = list.length;
      if (!n) return;
      for (const s of list) if (!s.userToggled) s.expanded = s.kind === 'mcp' && s.tools.length > 0;
      const groups: number[] = [];
      for (let i = 0; i < n; i++) if (i === 0 || rank(list[i]!) !== rank(list[i - 1]!)) groups.push(i);
      const headed = groups.filter((i) => rank(list[i]!) !== 999).length;
      let head = 46;
      let gap = 10;
      const zoneGap = 16;
      const header = 24;
      const heightOf = (s: Station) => head + (s.expanded && s.tools.length ? s.tools.length * TOOL_ROW + 8 : 0);
      const need = () => list.reduce((sum, s) => sum + heightOf(s), 0) + (n - 1) * gap + (groups.length - 1) * zoneGap + headed * header;
      // Too tall: collapse auto-expanded tool lists (largest first), then tighten cards.
      while (need() > avail) {
        const c = list.filter((s) => s.expanded && !s.userToggled).sort((a, b) => b.tools.length - a.tools.length)[0];
        if (!c) break;
        c.expanded = false;
      }
      while (need() > avail && head > 32) {
        head -= 2;
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
        s.headH = head;
        s.h = heightOf(s);
        s.px = side === 'left' ? x + cardW : x;
        s.py = s.y + head / 2;
        s.tools.forEach((r, j) => (r.y = s.y + head + 4 + j * TOOL_ROW));
        y += s.h;
      });
    };
    place([...this.stations.values()].filter((s) => s.kind === 'agent'), 28, 'left');
    place([...this.stations.values()].filter((s) => s.kind !== 'agent'), W - 28 - cardW, 'right');

    // User arrangement wins over the automatic columns; ports always face the tower.
    const hubPos = this.positions.get('__hub');
    if (hubPos) this.hub = [hubPos[0], hubPos[1]];
    for (const s of this.stations.values()) {
      const p = this.positions.get(s.id);
      if (p) {
        s.x = p[0];
        s.y = p[1];
      }
      s.px = s.x + s.w / 2 < this.hub[0] ? s.x + s.w : s.x;
      s.py = s.y + s.headH / 2;
      s.tools.forEach((r, j) => (r.y = s.y + s.headH + 4 + j * TOOL_ROW));
    }

    this.spokes.clear();
    const [hx, hy] = this.hub;
    this.obsLines = [];
    for (const e of this.obsEdges) {
      const a = this.stations.get(e.key_id);
      const o = this.stations.get(e.target_id);
      if (!a || !o) continue;
      const from: Pt = [a.px, a.py];
      const to: Pt = [o.px, o.py];
      const span = to[0] - from[0];
      // Bow away from the tower: this traffic does not pass through it.
      const bow = Math.max(40, Math.abs(span) * 0.12);
      this.obsLines.push({ edge: e, agent: a, target: o, bez: { p0: from, p1: [from[0] + span * 0.35, from[1] + bow], p2: [to[0] - span * 0.35, to[1] + bow], p3: to } });
    }
    for (const s of this.stations.values()) {
      if (s.kind === 'observed') continue;
      const dx = s.px - hx;
      const dy = s.py - hy;
      const len = Math.hypot(dx, dy) || 1;
      const rim: Pt = [hx + (dx / len) * (this.hubR + 4), hy + (dy / len) * (this.hubR + 4)];
      const span = s.px - rim[0];
      const bez: Bez =
        s.kind === 'agent'
          ? { p0: [s.px, s.py], p1: [s.px - span * 0.45, s.py], p2: [rim[0] + span * 0.3, rim[1] + (s.py - rim[1]) * 0.2], p3: rim }
          : { p0: rim, p1: [rim[0] + span * 0.3, rim[1] + (s.py - rim[1]) * 0.2], p2: [s.px - span * 0.45, s.py], p3: [s.px, s.py] };
      this.spokes.set(s.id, { station: s, bez, gates: [] });
    }

    // Gates: tool-scoped rules sit on the tool rows; the rest on the spoke of the station they guard.
    for (const s of this.stations.values()) for (const r of s.tools) r.gates = [];
    const global: Rule[] = [];
    for (const r of this.policy?.rules ?? []) {
      if (!r.enabled) continue;
      const m = r.match as { tools?: string[]; keys?: string[]; deployments?: string[]; mcp_servers?: string[] };
      const toolGlobs = m.tools;
      const toZone = r.to_zone ? zones.find((x) => x.id === r.to_zone) : undefined;
      if (toolGlobs?.length) {
        let servers = toZone ? this.zoneMembers(toZone).filter((s) => s.kind === 'mcp') : [...this.stations.values()].filter((s) => s.kind === 'mcp');
        if (m.mcp_servers?.length) servers = servers.filter((s) => m.mcp_servers!.includes(s.id));
        for (const s of servers) for (const row of s.tools) if (toolGlobs.some((g) => globMatch(g, row.full))) row.gates.push(r);
        continue;
      }
      const destIds = [...(m.deployments ?? []), ...(m.mcp_servers ?? [])];
      if (m.keys?.length) {
        // Scoped to specific agents: the gate sits on each agent's line.
        for (const k of m.keys) this.addGate(k, r, 0.66);
        continue;
      }
      if (destIds.length) {
        for (const d of destIds) this.addGate(d, r, 0.34);
        continue;
      }
      if (toZone) {
        for (const s of this.zoneMembers(toZone)) this.addGate(s.id, r, 0.34);
      } else if (r.from_zone) {
        const z = zones.find((x) => x.id === r.from_zone);
        if (z) for (const s of this.zoneMembers(z)) if (s.kind === 'agent') this.addGate(s.id, r, 0.66);
      } else {
        global.push(r);
      }
    }
    // Along the upper-right of the tower's ring (the top is where the holding count sits).
    this.hubGates = global.map((rule, i) => {
      const a = -Math.PI / 4 + i * 0.42;
      return { rule, x: this.hub[0] + Math.cos(a) * (this.hubR + 22), y: this.hub[1] + Math.sin(a) * (this.hubR + 22) };
    });

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
    sp.gates.push({ rule, x, y });
  }

  // ------------------------------------------------------------------ events

  handle(e: FlightEvent): void {
    if (!this.ready) return;
    const now = Date.now();
    if (now - e.ts > STALE_MS) return;
    this.dirty = true;
    switch (e.t) {
      case 'flight.started': {
        const agent = this.stations.get(e.key_id);
        if (!agent) return;
        const destId = e.deployment_id ?? e.mcp_server_id;
        const dest = (destId && this.stations.get(destId)) || (destId ? undefined : this.ensureUnknown());
        agent.recent.push(e.ts);
        agent.lastAt = e.ts;
        this.hubRecent.push(e.ts);
        if (dest) {
          dest.recent.push(e.ts);
          dest.lastAt = e.ts;
          this.livePairs.set(`${agent.id}>${dest.id}`, e.ts);
          if (e.tool) {
            const row = dest.tools.find((r) => r.name === e.tool);
            if (row) {
              row.recent.push(e.ts);
              row.lastAt = e.ts;
            }
            this.liveToolPairs.set(`${agent.id}>${dest.id}|${e.tool}`, e.ts);
          }
          if (this.focusId) this.relatedCache = null;
        }
        this.live.set(e.flight_id, { agent: agent.id, dest: dest?.id, held: false });
        break;
      }
      case 'flight.decision': {
        if (e.rule_id && (e.decision === 'deny' || e.decision === 'hold' || e.decision === 'mutate' || e.decision === 'flagged')) {
          const hits = this.ruleHits.get(e.rule_id) ?? [];
          hits.push(e.ts);
          this.ruleHits.set(e.rule_id, hits);
        }
        if (e.decision === 'deny') this.recordDenial(e.flight_id, e.ts);
        break;
      }
      case 'flight.held': {
        const f = this.live.get(e.flight_id);
        if (f && !f.held) {
          f.held = true;
          this.adjustHeld(f, 1);
        }
        break;
      }
      case 'flight.resolved': {
        const f = this.live.get(e.flight_id);
        if (f?.held) {
          f.held = false;
          this.adjustHeld(f, -1);
        }
        if (e.outcome === 'denied') this.recordDenial(e.flight_id, e.ts);
        break;
      }
      case 'flight.completed': {
        const f = this.live.get(e.flight_id);
        if (f?.held) this.adjustHeld(f, -1);
        this.live.delete(e.flight_id);
        break;
      }
      default:
        break;
    }
  }

  private recordDenial(flightId: string, ts: number): void {
    const f = this.live.get(flightId);
    if (!f) return;
    this.stations.get(f.agent)?.denials.push(ts);
    if (f.dest) this.stations.get(f.dest)?.denials.push(ts);
  }

  private adjustHeld(f: { agent: string; dest: string | undefined }, d: number): void {
    const a = this.stations.get(f.agent);
    if (a) a.held = Math.max(0, a.held + d);
    const b = f.dest ? this.stations.get(f.dest) : undefined;
    if (b) b.held = Math.max(0, b.held + d);
  }

  // ------------------------------------------------------------------- state

  private stateOf(s: Station, now: number): LinkState {
    if (s.obs) return now - s.obs.lastSeen < WINDOW_MS ? 'active' : s.obs.count24h > 0 ? 'idle' : 'unused';
    if (s.held > 0) return 'holding';
    const rate = s.recent.length;
    if (rate > 0) return s.denials.length >= Math.max(1, rate * 0.5) ? 'blocked' : 'active';
    return this.used24h.has(s.id) || s.lastAt > now - 24 * 3600e3 ? 'idle' : 'unused';
  }

  private anyLive(): boolean {
    for (const s of this.stations.values()) if (s.recent.length || s.held) return true;
    return false;
  }

  private activePairs(now: number): number {
    let n = 0;
    for (const ts of this.livePairs.values()) if (now - ts < WINDOW_MS) n++;
    return n;
  }

  private related(): Set<string> | null {
    if (!this.focusId) return null;
    if (this.relatedCache?.id === this.focusId) return this.relatedCache.set;
    const f = this.stations.get(this.focusId);
    if (!f) return null;
    const set = new Set<string>([f.id]);
    const add = (a: string, d: string) => {
      if (f.kind === 'agent' && a === f.id) set.add(d);
      else if (f.kind !== 'agent' && d === f.id) set.add(a);
    };
    for (const e of this.edges) add(e.key_id, e.target_id);
    for (const e of this.obsEdges) add(e.key_id, e.target_id);
    for (const k of this.livePairs.keys()) {
      const [a, d] = k.split('>') as [string, string];
      add(a, d);
    }
    this.relatedCache = { id: f.id, set };
    return set;
  }

  /** For the focus panel: what a node connects to, with 24h counts. */
  focusSummary(id: string): FocusSummary | null {
    const f = this.stations.get(id);
    if (!f) return null;
    const now = Date.now();
    const byId = new Map<string, FocusSummary['links'][number]>();
    const get = (otherId: string) => {
      let l = byId.get(otherId);
      if (!l) {
        const o = this.stations.get(otherId);
        if (!o) return undefined;
        l = { id: o.id, label: o.label, kind: o.kind, color: o.color, requests: 0, cost: 0, denied: 0, errors: 0, live: false, tools: [] };
        byId.set(otherId, l);
      }
      return l;
    };
    for (const e of this.edges) {
      const other = f.kind === 'agent' ? (e.key_id === f.id ? e.target_id : null) : e.target_id === f.id ? e.key_id : null;
      if (!other) continue;
      const l = get(other);
      if (!l) continue;
      l.requests += e.requests;
      l.cost += e.cost_nanousd;
      l.denied += e.denied;
      l.errors += e.errors;
      if (e.tool) {
        const t = l.tools.find((x) => x.name === e.tool);
        if (t) t.requests += e.requests;
        else l.tools.push({ name: e.tool, requests: e.requests });
      }
    }
    for (const e of this.obsEdges) {
      const other = f.kind === 'agent' ? (e.key_id === f.id ? e.target_id : null) : e.target_id === f.id ? e.key_id : null;
      if (!other) continue;
      const l = get(other);
      if (!l) continue;
      l.observed = true;
      l.bypass = !!this.stations.get(e.target_id)?.obs?.bypass;
      l.requests += e.count_24h;
      l.errors += e.errors_24h;
      if (now - e.last_seen < WINDOW_MS) l.live = true;
    }
    for (const [k, ts] of this.livePairs) {
      if (now - ts > WINDOW_MS) continue;
      const [a, d] = k.split('>') as [string, string];
      const other = f.kind === 'agent' ? (a === f.id ? d : null) : d === f.id ? a : null;
      if (other) {
        const l = get(other);
        if (l) l.live = true;
      }
    }
    const links = [...byId.values()].sort((a, b) => Number(b.live) - Number(a.live) || b.requests - a.requests);
    for (const l of links) l.tools.sort((a, b) => b.requests - a.requests);
    return { station: this.view(f, now), links };
  }

  private view(s: Station, now: number): StationView {
    let requests24h = 0;
    let cost24h = 0;
    let errors24h = 0;
    let denied24h = 0;
    for (const e of this.edges) {
      if ((s.kind === 'agent' && e.key_id === s.id) || (s.kind !== 'agent' && e.target_id === s.id)) {
        requests24h += e.requests;
        cost24h += e.cost_nanousd;
        errors24h += e.errors;
        denied24h += e.denied;
      }
    }
    let observed24h = 0;
    for (const e of this.obsEdges) if ((s.kind === 'agent' && e.key_id === s.id) || (s.kind === 'observed' && e.target_id === s.id)) observed24h += e.count_24h;
    return { id: s.id, kind: s.kind, label: s.label, sub: s.sub, color: s.color, rpm: s.recent.length, held: s.held, state: this.stateOf(s, now), requests24h, cost24h, errors24h, denied24h, observed24h, obs: s.obs };
  }

  // -------------------------------------------------------------------- draw

  /** Gridlines in world space: they pan and zoom with the map, hairline at any zoom. */
  private drawGrid(): void {
    const ctx = this.ctx;
    const k = this.cam.k;
    const x0 = -this.cam.x / k;
    const y0 = -this.cam.y / k;
    const x1 = x0 + this.w / k;
    const y1 = y0 + this.h / k;
    const draw = (step: number, color: string) => {
      ctx.beginPath();
      for (let x = Math.floor(x0 / step) * step; x <= x1; x += step) {
        ctx.moveTo(x, y0);
        ctx.lineTo(x, y1);
      }
      for (let y = Math.floor(y0 / step) * step; y <= y1; y += step) {
        ctx.moveTo(x0, y);
        ctx.lineTo(x1, y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1 / k;
      ctx.stroke();
    };
    if (24 * k >= 8) draw(24, '#edf1f6');
    draw(120, '#dde4ed');
  }

  private draw(): void {
    const ctx = this.ctx;
    const now = Date.now();
    const cutoff = now - WINDOW_MS;
    prune(this.hubRecent, cutoff);
    for (const s of this.stations.values()) {
      prune(s.recent, cutoff);
      prune(s.denials, cutoff);
      for (const r of s.tools) prune(r.recent, cutoff);
    }
    for (const [k, v] of this.ruleHits) {
      prune(v, cutoff);
      if (!v.length) this.ruleHits.delete(k);
    }

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#f6f8fb';
    ctx.fillRect(0, 0, this.w, this.h);
    const { k } = this.cam;
    ctx.setTransform(this.dpr * k, 0, 0, this.dpr * k, this.dpr * this.cam.x, this.dpr * this.cam.y);
    this.drawGrid();
    const [hx, hy] = this.hub;
    const rel = this.related();
    const dim = (id: string) => (rel && !rel.has(id) ? 0.22 : 1);

    // Static radar rings.
    const maxR = Math.min(260, Math.max(140, (this.w - this.rightInset) * 0.16));
    for (const r of [this.holdR + 36, maxR * 0.75, maxR]) {
      ctx.beginPath();
      ctx.arc(hx, hy, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(31,94,255,0.06)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Zones.
    for (const zb of this.zoneBoxes) {
      const c = hexToNum(zb.zone.color);
      ctx.globalAlpha = rel ? 0.5 : 1;
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
      ctx.globalAlpha = 1;
    }

    // Connections: state, not motion. Idle/unused first so active ones sit on top.
    const order: LinkState[] = ['unused', 'idle', 'active', 'blocked', 'holding'];
    const spokes = [...this.spokes.values()].map((sp) => ({ sp, st: this.stateOf(sp.station, now) }));
    spokes.sort((a, b) => order.indexOf(a.st) - order.indexOf(b.st));
    for (const { sp, st } of spokes) {
      const s = sp.station;
      const { p0, p1, p2, p3 } = sp.bez;
      ctx.beginPath();
      ctx.moveTo(p0[0], p0[1]);
      ctx.bezierCurveTo(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]);
      // Thin lines everywhere; live lines pulse their colour in place (slow breathing, per-line phase).
      const pulse = 0.5 + 0.5 * Math.sin(now / 650 + s.py * 0.031);
      let color = LINE_IDLE;
      let width = 1;
      let dash: number[] = [];
      switch (st) {
        case 'unused':
          color = LINE_UNUSED;
          dash = [3, 5];
          break;
        case 'idle':
          break;
        case 'active':
          color = rgba(s.color, 0.3 + 0.55 * pulse);
          width = 1.5;
          break;
        case 'blocked':
          color = rgba(STATUS_COLORS.denied, 0.3 + 0.55 * pulse);
          width = 1.5;
          break;
        case 'holding':
          color = rgba(STATUS_COLORS.held, 0.35 + 0.55 * pulse);
          width = 1.5;
          break;
      }
      if (this.hovered === `spoke:${s.id}`) {
        width += 1.5;
        dash = [];
        if (st === 'idle' || st === 'unused') color = '#8ea1bb';
      }
      let alpha = dim(s.id);
      if (this.sim) {
        const c = this.sim.get(s.id);
        if (c) {
          color = hex(c.deny >= c.hold && c.deny >= c.allow ? STATUS_COLORS.denied : c.hold >= c.allow ? STATUS_COLORS.held : STATUS_COLORS.ok);
          width = 2.5;
          dash = [7, 5];
        } else {
          alpha *= 0.25;
        }
      }
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(dash);
      ctx.lineCap = 'round';
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    // Observed traffic: dashed, straight from agent to system, never through the tower.
    for (const l of this.obsLines) {
      const { p0, p1, p2, p3 } = l.bez;
      const live = now - l.edge.last_seen < WINDOW_MS;
      const bypass = !!l.target.obs?.bypass;
      const pulse = 0.5 + 0.5 * Math.sin(now / 650 + l.agent.py * 0.031);
      const base = bypass ? STATUS_COLORS.denied : 0x64748b;
      const hot = this.hovered === `obs:${l.agent.id}>${l.target.id}`;
      ctx.beginPath();
      ctx.moveTo(p0[0], p0[1]);
      ctx.bezierCurveTo(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]);
      ctx.strokeStyle = rgba(base, live ? 0.35 + 0.5 * pulse : bypass ? 0.55 : 0.35);
      ctx.lineWidth = hot ? 2.5 : live ? 1.5 : 1.1;
      ctx.setLineDash([5, 5]);
      ctx.globalAlpha = Math.min(dim(l.agent.id), dim(l.target.id)) * (this.sim ? 0.25 : 1);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    // Simulation: a count on each affected line.
    if (this.sim) {
      for (const sp of this.spokes.values()) {
        const c = this.sim.get(sp.station.id);
        if (!c) continue;
        const parts = [c.deny ? `${c.deny} blocked` : '', c.hold ? `${c.hold} held` : '', c.allow ? `${c.allow} freed` : ''].filter(Boolean);
        const tone = c.deny >= c.hold && c.deny >= c.allow ? STATUS_COLORS.denied : c.hold >= c.allow ? STATUS_COLORS.held : STATUS_COLORS.ok;
        const [x, y] = bezAt(sp.bez, 0.5);
        const label = parts.join(' · ');
        ctx.font = `600 10.5px ${FONT}`;
        const tw = ctx.measureText(label).width + 14;
        roundRect(ctx, x - tw / 2, y - 9, tw, 18, 9);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.strokeStyle = hex(tone);
        ctx.lineWidth = 1.25;
        ctx.stroke();
        ctx.fillStyle = hex(tone);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, x, y + 0.5);
        ctx.textAlign = 'left';
      }
    }

    // Holding ring (static): amber when anything is waiting on a human.
    let held = 0;
    for (const f of this.live.values()) if (f.held) held++;
    ctx.beginPath();
    ctx.ellipse(hx, hy, this.holdR, this.holdR * 0.92, 0, 0, Math.PI * 2);
    ctx.setLineDash([3, 6]);
    ctx.strokeStyle = held ? rgba(STATUS_COLORS.held, 0.8) : 'rgba(138,152,173,0.3)';
    ctx.lineWidth = held ? 1.75 : 1;
    ctx.stroke();
    ctx.setLineDash([]);
    if (held) {
      const label = `${held} holding`;
      ctx.font = `600 11px ${FONT}`;
      const tw = ctx.measureText(label).width + 16;
      const bx = hx - tw / 2;
      const by = hy - this.holdR * 0.92 - 11;
      roundRect(ctx, bx, by, tw, 20, 10);
      ctx.fillStyle = '#fff8ec';
      ctx.fill();
      ctx.strokeStyle = rgba(STATUS_COLORS.held, 0.6);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#8a5200';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, hx, by + 10.5);
      ctx.textAlign = 'left';
    }

    // Gates on spokes.
    for (const sp of this.spokes.values()) {
      ctx.globalAlpha = dim(sp.station.id);
      for (const g of sp.gates) this.drawGate(g.x, g.y, g.rule, 10, this.hovered === `gate:${g.rule.id}:${sp.station.id}`);
      ctx.globalAlpha = 1;
    }

    this.drawHub(now, held);
    for (const g of this.hubGates) this.drawGate(g.x, g.y, g.rule, 10, this.hovered === `hubgate:${g.rule.id}`);

    for (const s of this.stations.values()) {
      ctx.globalAlpha = dim(s.id);
      this.drawCard(s, now, rel);
      ctx.globalAlpha = 1;
    }

    if (this.connect) {
      const { start, end } = this.connect;
      ctx.beginPath();
      ctx.moveTo(start[0], start[1]);
      const mx = (start[0] + end[0]) / 2;
      ctx.bezierCurveTo(mx, start[1], mx, end[1], end[0], end[1]);
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = 'rgba(31,94,255,0.9)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(end[0], end[1], 5, 0, Math.PI * 2);
      ctx.fillStyle = '#1f5eff';
      ctx.fill();
    }

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

  private drawGate(x: number, y: number, rule: Rule, r: number, hot: boolean): void {
    const ctx = this.ctx;
    const c = gateColor(rule);
    const hits = this.ruleHits.get(rule.id)?.length ?? 0;
    if (hits) {
      ctx.beginPath();
      ctx.arc(x, y, r + 5, 0, Math.PI * 2);
      ctx.fillStyle = rgba(c, 0.14);
      ctx.fill();
    }
    ctx.save();
    ctx.shadowColor = 'rgba(15,27,45,0.12)';
    ctx.shadowBlur = hot ? 10 : 6;
    ctx.shadowOffsetY = 1;
    ctx.beginPath();
    ctx.arc(x, y, hot ? r + 1 : r, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(x, y, hot ? r + 1 : r, 0, Math.PI * 2);
    ctx.strokeStyle = hex(c);
    ctx.lineWidth = 2;
    ctx.stroke();
    this.drawGateGlyph(x, y, rule, r / 10);
    if (this.alerted.has(rule.id)) this.drawBell(x + r * 0.78, y + r * 0.78, r >= 9 ? 5.5 : 3.5);
    if (hits && r >= 9) {
      const label = String(hits);
      ctx.font = `700 9.5px ${FONT}`;
      const tw = Math.max(15, ctx.measureText(label).width + 8);
      roundRect(ctx, x + r - 2, y - r - 8, tw, 14, 7);
      ctx.fillStyle = hex(c);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x + r - 2 + tw / 2, y - r - 0.5);
      ctx.textAlign = 'left';
    }
  }

  private drawBell(x: number, y: number, rad: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fillStyle = ACCENT_HEX;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    if (rad < 5) return;
    const k = rad / 5.5;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(x - 2.6 * k, y + 1.4 * k);
    ctx.quadraticCurveTo(x - 2.4 * k, y - 2.8 * k, x, y - 2.8 * k);
    ctx.quadraticCurveTo(x + 2.4 * k, y - 2.8 * k, x + 2.6 * k, y + 1.4 * k);
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(x - 3 * k, y + 1.2 * k, 6 * k, 0.9 * k);
    ctx.beginPath();
    ctx.arc(x, y + 2.7 * k, 0.9 * k, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawGateGlyph(x: number, y: number, rule: Rule, k: number): void {
    const ctx = this.ctx;
    const c = gateColor(rule);
    ctx.fillStyle = hex(c);
    ctx.strokeStyle = hex(c);
    if (rule.effect === 'inspect') {
      // Magnifier: content inspection.
      ctx.beginPath();
      ctx.arc(x - 1 * k, y - 1 * k, 3.4 * k, 0, Math.PI * 2);
      ctx.lineWidth = 1.8;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x + 1.5 * k, y + 1.5 * k);
      ctx.lineTo(x + 4.5 * k, y + 4.5 * k);
      ctx.lineCap = 'round';
      ctx.lineWidth = 2;
      ctx.stroke();
    } else if (rule.effect === 'deny') {
      roundRect(ctx, x - 5 * k, y - 1.5 * k, 10 * k, 3 * k, 1.5 * k);
      ctx.fill();
    } else if (rule.effect === 'require_approval') {
      ctx.beginPath();
      ctx.moveTo(x - 4 * k, y - 5 * k);
      ctx.lineTo(x + 4 * k, y - 5 * k);
      ctx.lineTo(x - 4 * k, y + 5 * k);
      ctx.lineTo(x + 4 * k, y + 5 * k);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(x - 4 * k, y);
      ctx.lineTo(x - 1 * k, y + 3 * k);
      ctx.lineTo(x + 4 * k, y - 3 * k);
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
    ctx.beginPath();
    ctx.arc(hx, hy, r + 10, 0, Math.PI * 2);
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
    ctx.strokeStyle = this.hovered === 'hub' ? '#9fb3d1' : '#cfd9e8';
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
    const rpm = this.hubRecent.length;
    const active = this.activePairs(now);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `700 10px ${FONT}`;
    ctx.fillStyle = '#334155';
    ctx.fillText('CONTROL TOWER', hx, hy + this.holdR + 22);
    ctx.font = `500 11px ${FONT}`;
    ctx.fillStyle = INK_FAINT;
    ctx.fillText(`${active} active link${active === 1 ? '' : 's'} · ${rpm}/min${held ? ` · ${held} holding` : ''}`, hx, hy + this.holdR + 37);
    ctx.textAlign = 'left';
  }

  private drawCard(s: Station, now: number, rel: Set<string> | null): void {
    const ctx = this.ctx;
    const hot = this.hovered === `station:${s.id}` || this.focusId === s.id;
    const st = this.stateOf(s, now);
    ctx.save();
    ctx.shadowColor = `rgba(15,27,45,${hot ? 0.14 : 0.07})`;
    ctx.shadowBlur = hot ? 16 : 10;
    ctx.shadowOffsetY = 2;
    roundRect(ctx, s.x, s.y, s.w, s.h, 10);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.restore();
    roundRect(ctx, s.x + 0.5, s.y + 0.5, s.w - 1, s.h - 1, 10);
    ctx.strokeStyle =
      this.focusId === s.id ? hex(s.color) : st === 'holding' ? rgba(STATUS_COLORS.held, 0.7) : st === 'blocked' ? rgba(STATUS_COLORS.denied, 0.6) : st === 'active' ? rgba(s.color, 0.45) : hot ? '#b9c7dd' : '#e1e7ef';
    ctx.lineWidth = this.focusId === s.id ? 2 : st === 'active' || st === 'holding' || st === 'blocked' ? 1.5 : 1;
    // Observed systems are outside the gateway: dashed outline, like their lines.
    if (s.kind === 'observed') ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Header.
    const head = s.headH;
    const ix = s.x + 10;
    const iy = s.y + (head - 26) / 2;
    roundRect(ctx, ix, iy, 26, 26, 7);
    ctx.fillStyle = rgba(s.color, 0.1);
    ctx.fill();
    this.drawGlyph(s, ix + 13, iy + 13);

    const tx = ix + 36;
    const chevronW = s.kind === 'mcp' && s.tools.length ? 22 : 0;
    const right = s.x + s.w - 12 - chevronW;
    const compact = head < 40;
    // Status line on the right: live rate, holding, idle.
    let status = '';
    let statusColor = INK_FAINT;
    if (s.held) {
      status = `${s.held} holding`;
      statusColor = '#b26b00';
    } else if (s.recent.length) {
      status = `${s.recent.length}/min`;
      statusColor = st === 'blocked' ? '#b4233a' : INK_DIM;
    } else if (st === 'idle') status = 'idle';
    ctx.font = `600 11px ${FONT}`;
    const statusW = status ? ctx.measureText(status).width + 10 : 0;
    ctx.textBaseline = 'alphabetic';
    ctx.font = `600 ${compact ? 11.5 : 12.5}px ${FONT}`;
    ctx.fillStyle = INK;
    const titleY = s.y + (compact ? head / 2 + 4 : head / 2 - 2);
    ctx.fillText(fitText(ctx, s.label, right - tx - statusW), tx, titleY);
    if (!compact) {
      ctx.font = `400 11px ${FONT}`;
      ctx.fillStyle = INK_DIM;
      ctx.fillText(fitText(ctx, s.sub, right - tx), tx, s.y + head / 2 + 13);
    }
    if (status) {
      ctx.font = `600 11px ${FONT}`;
      ctx.fillStyle = statusColor;
      ctx.textAlign = 'right';
      ctx.fillText(status, right, titleY);
      ctx.textAlign = 'left';
      if (st === 'active' || st === 'holding' || st === 'blocked') {
        ctx.beginPath();
        ctx.arc(right - ctx.measureText(status).width - 7, titleY - 4, 3, 0, Math.PI * 2);
        ctx.fillStyle = st === 'holding' ? hex(STATUS_COLORS.held) : st === 'blocked' ? hex(STATUS_COLORS.denied) : hex(STATUS_COLORS.ok);
        ctx.fill();
      }
    }
    if (chevronW) {
      const cx = s.x + s.w - 16;
      const cy = s.y + head / 2;
      ctx.beginPath();
      if (s.expanded) {
        ctx.moveTo(cx - 4, cy - 2);
        ctx.lineTo(cx, cy + 2);
        ctx.lineTo(cx + 4, cy - 2);
      } else {
        ctx.moveTo(cx - 2, cy - 4);
        ctx.lineTo(cx + 2, cy);
        ctx.lineTo(cx - 2, cy + 4);
      }
      ctx.strokeStyle = INK_FAINT;
      ctx.lineWidth = 1.6;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
    }

    // Port.
    ctx.beginPath();
    ctx.arc(s.px, s.py, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = st === 'active' ? hex(s.color) : st === 'holding' ? hex(STATUS_COLORS.held) : st === 'blocked' ? hex(STATUS_COLORS.denied) : '#b9c7dd';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Tool rows.
    if (!s.expanded || !s.tools.length) return;
    ctx.beginPath();
    ctx.moveTo(s.x + 10, s.y + head + 0.5);
    ctx.lineTo(s.x + s.w - 10, s.y + head + 0.5);
    ctx.strokeStyle = '#edf1f6';
    ctx.lineWidth = 1;
    ctx.stroke();
    const focusAgent = rel && this.focusId && this.stations.get(this.focusId)?.kind === 'agent' ? this.focusId : null;
    for (const row of s.tools) {
      const cy = row.y + TOOL_ROW / 2;
      const usedByFocus = focusAgent ? this.toolUsedBy(focusAgent, s.id, row.name) : true;
      ctx.globalAlpha = (rel ? (rel.has(s.id) ? 1 : 0.22) : 1) * (usedByFocus ? 1 : 0.35);
      if (this.hovered === `tool:${s.id}:${row.name}`) {
        roundRect(ctx, s.x + 6, row.y, s.w - 12, TOOL_ROW, 5);
        ctx.fillStyle = '#f3f6fb';
        ctx.fill();
      }
      const active = row.recent.length > 0;
      ctx.beginPath();
      ctx.arc(s.x + 18, cy, 3.5, 0, Math.PI * 2);
      if (active) {
        ctx.fillStyle = hex(MCP_COLOR);
        ctx.fill();
      } else {
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.strokeStyle = row.count24h ? '#9fb0c8' : '#dbe2ec';
        ctx.lineWidth = 1.25;
        ctx.stroke();
      }
      // Right side: count · gate · op tag
      let rx = s.x + s.w - 12;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'right';
      const count = active ? `${row.recent.length}/min` : row.count24h ? `${row.count24h.toLocaleString()}` : '';
      if (count) {
        ctx.font = `${active ? 600 : 500} 10.5px ${FONT}`;
        ctx.fillStyle = active ? INK_DIM : INK_FAINT;
        ctx.fillText(count, rx, cy + 0.5);
        rx -= ctx.measureText(count).width + 8;
      }
      row.gateHits = [];
      for (const g of row.gates) {
        this.drawGate(rx - 7, cy, g, 6.5, this.hovered === `toolgate:${g.id}:${s.id}:${row.name}`);
        row.gateHits.push({ rule: g, x: rx - 7, y: cy });
        rx -= 18;
      }
      const op = OP_STYLE[row.op];
      if (op.label) {
        ctx.font = `700 9px ${FONT}`;
        const tw = 15;
        roundRect(ctx, rx - tw, cy - 7, tw, 14, 4);
        ctx.fillStyle = op.color + '14';
        ctx.fill();
        ctx.fillStyle = op.color;
        ctx.textAlign = 'center';
        ctx.fillText(op.label, rx - tw / 2, cy + 0.5);
        rx -= tw + 6;
      }
      ctx.textAlign = 'left';
      ctx.font = `500 11px ${FONT}`;
      ctx.fillStyle = row.count24h || active ? INK : INK_FAINT;
      ctx.fillText(fitText(ctx, row.name, rx - (s.x + 28)), s.x + 28, cy + 0.5);
      ctx.textBaseline = 'alphabetic';
    }
    ctx.globalAlpha = 1;
  }

  private toolUsedBy(agentId: string, serverId: string, tool: string): boolean {
    if (this.liveToolPairs.has(`${agentId}>${serverId}|${tool}`)) return true;
    return this.edges.some((e) => e.key_id === agentId && e.target_id === serverId && e.tool === tool);
  }

  private drawGlyph(s: Station, cx: number, cy: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = hex(s.color);
    ctx.fillStyle = hex(s.color);
    ctx.lineWidth = 1.6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    switch (s.kind) {
      case 'observed':
        // An eye: seen, not controlled.
        ctx.beginPath();
        ctx.moveTo(cx - 7, cy);
        ctx.quadraticCurveTo(cx, cy - 7, cx + 7, cy);
        ctx.quadraticCurveTo(cx, cy + 7, cx - 7, cy);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx, cy, 2, 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'agent':
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
      case 'model':
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
      case 'mcp':
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
      default:
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.arc(cx, cy, 6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
    }
  }

  // ------------------------------------------------------------ interaction

  private laneView(sp: Spoke, now: number): LaneView {
    const v = this.view(sp.station, now);
    const g = sp.gates[0];
    return {
      fromLabel: sp.station.kind === 'agent' ? sp.station.label : 'Control Tower',
      toLabel: sp.station.kind === 'agent' ? 'Control Tower' : sp.station.label,
      state: v.state,
      rpm: v.rpm,
      requests: v.requests24h,
      cost: v.cost24h,
      errors: v.errors24h,
      denied: v.denied24h,
      gate: g ? { rule: g.rule } : null,
    };
  }

  private hitTest(wp: Pt, sp: Pt): ClickInfo {
    const now = Date.now();
    const [x, y] = wp;
    const [sx, sy] = sp;
    for (const s of this.stations.values()) {
      if (!s.expanded || x < s.x || x > s.x + s.w || y <= s.y + s.headH || y > s.y + s.h) continue;
      for (const r of s.tools) for (const g of r.gateHits) if ((g.x - x) ** 2 + (g.y - y) ** 2 < 9 * 9) return { kind: 'gate', rule: g.rule, x: sx, y: sy };
      const row = s.tools.find((r) => y >= r.y && y < r.y + TOOL_ROW);
      if (row) return { kind: 'tool', serverId: s.id, tool: row.name, x: sx, y: sy };
    }
    for (const s of this.stations.values()) {
      if (x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) return { kind: 'station', station: this.view(s, now), x: sx, y: sy };
    }
    for (const g of this.hubGates) if ((g.x - x) ** 2 + (g.y - y) ** 2 < 14 * 14) return { kind: 'gate', rule: g.rule, x: sx, y: sy };
    for (const sp of this.spokes.values()) {
      for (const g of sp.gates) if ((g.x - x) ** 2 + (g.y - y) ** 2 < 14 * 14) return { kind: 'gate', rule: g.rule, x: sx, y: sy };
    }
    for (const zb of this.zoneBoxes) {
      const c = zb.chip;
      if (x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h) return { kind: 'zone', zone: zb.zone, x: sx, y: sy };
    }
    let best: { sp: Spoke; d: number } | null = null;
    for (const spk of this.spokes.values()) {
      for (let t = 0.04; t < 0.97; t += 0.04) {
        const [px, py] = bezAt(spk.bez, t);
        const d = (px - x) ** 2 + (py - y) ** 2;
        if (d < 64 && (!best || d < best.d)) best = { sp: spk, d };
      }
    }
    if (best && best.sp.station.kind !== 'unknown') return { kind: 'lane', stationId: best.sp.station.id, stationKind: best.sp.station.kind, x: sx, y: sy };
    return { kind: 'empty', x: sx, y: sy };
  }

  private setHovered(id: string | null): void {
    if (this.hovered !== id) {
      this.hovered = id;
      this.dirty = true;
    }
  }

  private hoverTest(): void {
    this.lastHoverRefresh = performance.now();
    if (!this.pointer || this.lasso) {
      this.hoverCb?.(null);
      return;
    }
    const now = Date.now();
    const [sx, sy] = this.pointer;
    const [x, y] = this.toWorld(this.pointer);
    for (const s of this.stations.values()) {
      if (x < s.x || x > s.x + s.w || y < s.y || y > s.y + s.h) continue;
      if (s.expanded && y > s.y + s.headH) {
        for (const r of s.tools) {
          for (const g of r.gateHits) {
            if ((g.x - x) ** 2 + (g.y - y) ** 2 < 9 * 9) {
              this.setHovered(`toolgate:${g.rule.id}:${s.id}:${r.name}`);
              this.canvas.style.cursor = 'pointer';
              this.hoverCb?.({ x: sx, y: sy, gate: { rule: g.rule, hits: this.ruleHits.get(g.rule.id)?.length ?? 0 } });
              return;
            }
          }
        }
        const row = s.tools.find((r) => y >= r.y && y < r.y + TOOL_ROW);
        if (row) {
          this.setHovered(`tool:${s.id}:${row.name}`);
          this.canvas.style.cursor = this.gateMode ? 'crosshair' : 'pointer';
          this.hoverCb?.({ x: sx, y: sy, tool: { server: s.label, name: row.name, op: row.op, rpm: row.recent.length, count24h: row.count24h, gates: row.gates } });
          return;
        }
      }
      this.setHovered(`station:${s.id}`);
      this.canvas.style.cursor = this.drawMode || this.gateMode ? 'crosshair' : 'grab';
      this.hoverCb?.({ x: sx, y: sy, station: this.view(s, now) });
      return;
    }
    for (const l of this.obsLines) {
      // Sample every ~5px along the curve: these lines are long.
      const { p0, p3 } = l.bez;
      const step = Math.min(0.04, 5 / Math.max(1, Math.hypot(p3[0] - p0[0], p3[1] - p0[1]) * 1.3));
      let near = false;
      for (let t = step; t < 1 && !near; t += step) {
        const [px, py] = bezAt(l.bez, t);
        near = (px - x) ** 2 + (py - y) ** 2 < 49;
      }
      if (!near) continue;
      this.setHovered(`obs:${l.agent.id}>${l.target.id}`);
      this.canvas.style.cursor = 'default';
      const o = l.target.obs;
      this.hoverCb?.({ x: sx, y: sy, observedLine: { agent: l.agent.label, target: o?.target ?? l.target.label, system: l.target.label !== o?.target ? l.target.label : null, bypass: !!o?.bypass, count24h: l.edge.count_24h, errors24h: l.edge.errors_24h, writes24h: l.edge.writes_24h, lastSeen: l.edge.last_seen } });
      return;
    }
    for (const g of this.hubGates) {
      if ((g.x - x) ** 2 + (g.y - y) ** 2 < 14 * 14) {
        this.setHovered(`hubgate:${g.rule.id}`);
        this.canvas.style.cursor = 'pointer';
        this.hoverCb?.({ x: sx, y: sy, gate: { rule: g.rule, hits: this.ruleHits.get(g.rule.id)?.length ?? 0 } });
        return;
      }
    }
    for (const sp of this.spokes.values()) {
      for (const g of sp.gates) {
        if ((g.x - x) ** 2 + (g.y - y) ** 2 < 14 * 14) {
          this.setHovered(`gate:${g.rule.id}:${sp.station.id}`);
          this.canvas.style.cursor = 'pointer';
          this.hoverCb?.({ x: sx, y: sy, gate: { rule: g.rule, hits: this.ruleHits.get(g.rule.id)?.length ?? 0 } });
          return;
        }
      }
    }
    for (const zb of this.zoneBoxes) {
      const c = zb.chip;
      if (x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h) {
        this.setHovered(`zone:${zb.zone.id}`);
        this.canvas.style.cursor = 'pointer';
        this.hoverCb?.({ x: sx, y: sy, zone: zb.zone });
        return;
      }
    }
    const [hx, hy] = this.hub;
    if ((hx - x) ** 2 + (hy - y) ** 2 < (this.hubR + 6) ** 2) {
      this.setHovered('hub');
      this.canvas.style.cursor = 'grab';
      let held = 0;
      for (const f of this.live.values()) if (f.held) held++;
      this.hoverCb?.({ x: sx, y: sy, hub: { rpm: this.hubRecent.length, held, active: this.activePairs(now) } });
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
      this.setHovered(`spoke:${best.sp.station.id}`);
      this.canvas.style.cursor = 'pointer';
      this.hoverCb?.({ x: sx, y: sy, lane: this.laneView(best.sp, now) });
      return;
    }
    this.setHovered(null);
    this.hoverCb?.(null);
  }
}
