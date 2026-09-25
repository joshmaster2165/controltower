import type { FlightEvent, LiveTick } from '@controltower/shared';
import type { ObservedEdge, PolicyBundle, Rule, Topology, TopologyEdge, TopologyKey, Zone } from '../api';
import { agentColor, hex, MCP_COLOR, PROVIDER_COLORS, providerLook, STATUS_COLORS } from './colors';
import { agentGroups, agentRef, groupStation, isTeam, keyStations, teamStation } from './groups';

/**
 * The Airspace — a live map of the agentic ecosystem (Canvas 2D).
 *
 * Agents (left) connect through Control Tower (centre) to model deployments
 * and MCP tool servers (right); tool servers list their tools. Nothing
 * travels: every connection shows its *state*, which stays legible at scale.
 *
 *   active   traffic in the last minute — agent/station colour, thickness ∝ calls/min
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
  /** Failed calls in the last minute. */
  errors: number[];
  lastAt: number;
  held: number;
  /** Tool servers only: 'http' for a plain HTTP API (rows are routes), else MCP. */
  protocol?: 'mcp' | 'http' | undefined;
  /** Observed systems only: reported by agents, not proxied, so never enforced. */
  obs?: { target: string; kind: string; bypass: boolean; lastSeen: number; count24h: number; errors24h: number } | undefined;
  /** An agent group: how many keys (copies of the agent) it stands for. */
  copies?: number | undefined;
  /** When the rest of an agent's copies are folded into a team: how many copies the agent has in all. */
  copiesOf?: number | undefined;
  /** A team station (organization level): the team it stands for, and how many agents and keys. */
  team?: { name: string; agents: number; keys: number } | undefined;
  /** Agent stations inside an opened team: that team (they sit together under its header). */
  teamOf?: string | undefined;
  /** A tool server or HTTP API that fronts an agent: that agent's id. */
  agentOf?: string | undefined;
}

export interface MatrixCell {
  requests: number;
  cost: number;
  denied: number;
  errors: number;
  live: boolean;
  tools: Array<{ name: string; requests: number }>;
  gates: Rule[];
  /** Reported by the agent, outside the gateway: nothing can gate it. */
  outside: boolean;
}
export interface MatrixHead {
  id: string;
  label: string;
  sub: string;
  kind: StationKind;
  color: number;
  /** Calls in the last day across the row or column. */
  total: number;
  rpm: number;
  team: string | undefined;
  outside: boolean;
  bypass: boolean;
  /** A destination that fronts an agent: that agent. */
  agent: string | undefined;
}
export interface MatrixData {
  rows: MatrixHead[];
  cols: MatrixHead[];
  /** `${row id}>${col id}` → the connection. */
  cells: Map<string, MatrixCell>;
}

/** Something on the map that needs a person; `ref` goes to reveal(). */
export interface AttentionItem {
  kind: 'holding' | 'blocked' | 'bypass' | 'errors' | 'ungated' | 'new' | 'spike';
  severity: 1 | 2 | 3;
  stationId: string;
  /** A second station the item is about (the destination of a new connection). */
  also?: string;
  ref: string;
  title: string;
  detail: string;
}

/** How agents are drawn: one station per team (opening into its agents), or one per agent. */
export type AgentLevel = 'teams' | 'agents';

export interface SearchHit {
  /** Pass to reveal(). */
  ref: string;
  label: string;
  sub: string;
  kind: 'team' | 'agent' | 'key' | 'model' | 'mcp' | 'tool' | 'observed';
}

/** A day of recorded history before any connection counts as new. */
const LEARNING_MS = 24 * 3600_000;
/** Above this many agents, 'auto' draws teams. */
const AUTO_TEAMS_ABOVE = 24;
/** Height of the header over an opened team's agents. */
const TEAM_HEAD = 24;

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
  protocol?: Station['protocol'];
  /** Agent stations standing for more than one key: a whole team, or an agent's copies. */
  grouping?: 'team' | 'group' | undefined;
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
  /** `rect` is the card on screen (left, top, right, bottom), for anchoring panels beside it. */
  | { kind: 'station'; station: StationView; x: number; y: number; rect: [number, number, number, number] }
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
  links: Array<{ id: string; label: string; kind: StationKind; color: number; requests: number; cost: number; denied: number; errors: number; live: boolean; tools: Array<{ name: string; requests: number }>; observed?: boolean; bypass?: boolean; relation?: 'calls' | 'called by' }>;
}

/** One agent calling another: through a tool server that fronts it, or on someone's behalf (delegation). */
interface AgentLink {
  from: string;
  to: string;
  /** Calls between the two: the caller's calls to the callee's server, or (without one) the callee's calls on its behalf. */
  requests: number;
  viaTool: number;
  onBehalf: number;
  lastTs: number;
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

/** Squared distance from a point to a segment. */
function segDist2(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  const x = a[0] + t * dx - p[0];
  const y = a[1] + t * dy - p[1];
  return x * x + y * y;
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
  private live = new Map<string, { agent: string; key: string; dest: string | undefined; held: boolean }>();
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
  /** Agents calling agents, drawn as arcs beside the agent column. */
  private agentLinks: AgentLink[] = [];
  /** Calls in the last day per station (agents and destinations): an idle line's thickness. */
  private day = new Map<string, number>();
  /** Key id → the station drawing it: its agent group when several keys share an agent id, else the key. */
  private keyStation = new Map<string, string>();
  /** Agent station → the keys it stands for (one for a plain key, all copies for a group, a whole team). */
  private stationKeys = new Map<string, TopologyKey[]>();
  private levelPref: AgentLevel | 'auto' = 'auto';
  /** Stations to keep lit while nothing is traced (the attention list); the rest recede. */
  private highlight: Set<string> | null = null;
  /** A view's teams (null: the whole organization), and the keys it draws. */
  private scope: Set<string> | null = null;
  private keys: TopologyKey[] = [];
  private level: AgentLevel = 'agents';
  /** Teams opened into their agents while the map shows teams. */
  private openTeams = new Set<string>();
  /** Headers over opened teams (world coordinates); clicking one closes the team. */
  private teamHeads: Array<{ team: string; x: number; y: number; w: number; h: number; agents: number }> = [];
  /** The region below the tower holding observed systems (world coordinates). */
  private obsBand: { x: number; y: number; w: number; h: number; left: number } | null = null;
  /** Agent → observed system, drawn straight across (not through the tower). */
  private obsLines: Array<{ edge: ObservedEdge; agent: Station; target: Station; pts: Pt[] }> = [];
  /** Which connections to show: everything, only live ones, only gateway traffic, or only traffic outside it. */
  private layer: 'all' | 'active' | 'gateway' | 'outside' = 'all';
  private hub: Pt = [0, 0];
  private hubR = 36;
  private holdR = 70;
  private rightInset = 0;
  private pointer: Pt | null = null;
  private hovered: string | null = null;
  private lasso: Pt[] | null = null;
  private hoverCb: ((h: HoverInfo | null) => void) | null = null;
  private levelCb: (() => void) | null = null;
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
      // A click, not a drag. A team header closes its team; a team's chevron opens it.
      for (const th of this.teamHeads) {
        if (wp[0] >= th.x && wp[0] <= th.x + th.w && wp[1] >= th.y && wp[1] <= th.y + th.h) {
          this.toggleTeam(th.team);
          return;
        }
      }
      for (const s of this.stations.values()) {
        if (s.team && wp[0] >= s.x + s.w - 26 && wp[0] <= s.x + s.w && wp[1] >= s.y && wp[1] <= s.y + s.headH) {
          this.toggleTeam(s.team.name);
          return;
        }
      }
      // Chevron on a tool server toggles its tool list.
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
      // No motion: redraw when something changed, plus a slow tick for ageing states.
      if (this.dirty || now - this.lastDraw > 1000) {
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
    // Room for agent-to-agent arcs beside the agent column.
    if (this.agentLinks.length) x0 -= 70;
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

  // ------------------------------------------------------------ levels, search

  /**
   * Show one part of the organization: only these teams' agents, what they reach
   * and their traffic (null: everything). The map is fitted to what is left.
   */
  setScope(teams: string[] | null): void {
    const next = teams ? new Set(teams) : null;
    if (next && this.scope && next.size === this.scope.size && [...next].every((t) => this.scope!.has(t))) return;
    if (!next && !this.scope) return;
    this.scope = next;
    this.openTeams.clear();
    this.resetActivity();
    if (this.topology) this.setTopology(this.topology);
    if (this.focusId && !this.stations.has(this.focusId)) this.setFocus(null);
    this.fit();
    this.levelCb?.();
  }
  /** Whether a key is drawn in the current view. */
  inScope(keyId: string): boolean {
    return this.keyStation.has(keyId);
  }

  /** Draw agents per team or per agent; 'auto' draws teams once there are more agents than fit. */
  setLevel(level: AgentLevel | 'auto'): void {
    this.levelPref = level;
    this.openTeams.clear();
    if (this.topology) this.setTopology(this.topology);
    if (this.focusId && !this.stations.has(this.focusId)) this.setFocus(null);
    this.fit();
    this.levelCb?.();
  }
  getLevel(): { level: AgentLevel; pref: AgentLevel | 'auto'; teams: number } {
    const teams = new Set(this.keys.map((k) => k.team).filter(Boolean)).size;
    return { level: this.level, pref: this.levelPref, teams };
  }
  onLevelChange(cb: () => void): void {
    this.levelCb = cb;
  }
  /** Open a team into its agents, or close it back into one station. */
  toggleTeam(team: string): void {
    const opening = !this.openTeams.has(team);
    if (opening) this.openTeams.add(team);
    else this.openTeams.delete(team);
    if (this.topology) this.setTopology(this.topology);
    if (opening) {
      // Bring the opened team's agents into view (top first if they are taller than the screen).
      const members = [...this.stations.values()].filter((s) => s.teamOf === team);
      if (members.length) {
        const k = this.cam.k;
        const y0 = (Math.min(...members.map((s) => s.y)) - TEAM_HEAD) * k + this.cam.y;
        const y1 = Math.max(...members.map((s) => s.y + s.h)) * k + this.cam.y;
        const top = 110;
        const bottom = this.h - 60;
        if (y1 > bottom) this.cam.y -= Math.min(y1 - bottom, y0 - top);
        else if (y0 < top) this.cam.y += top - y0;
        this.dirty = true;
        this.camCb?.({ ...this.cam });
      }
    }
    if (this.focusId && !this.stations.has(this.focusId)) this.setFocus(null);
    this.levelCb?.();
  }

  /** Agents, keys, teams, models, tool servers and tools whose name contains the query. */
  search(query: string, limit = 12): SearchHit[] {
    const q = query.trim().toLowerCase();
    const t = this.topology;
    if (!q || !t) return [];
    const hits: Array<SearchHit & { score: number }> = [];
    // Names that start with the query first; agents and teams before single keys of an agent.
    const WEIGHT: Record<SearchHit['kind'], number> = { team: 0, agent: 0, model: 0.2, mcp: 0.2, tool: 0.4, observed: 0.4, key: 3 };
    const add = (h: SearchHit, text: string) => {
      const i = text.toLowerCase().indexOf(q);
      if (i >= 0) hits.push({ ...h, score: WEIGHT[h.kind] + (i === 0 ? 0 : 1) + text.length / 1000 });
    };
    const groups = agentGroups(this.keys);
    const teams = new Map<string, number>();
    for (const k of this.keys) if (k.team) teams.set(k.team, (teams.get(k.team) ?? 0) + 1);
    for (const [team, n] of teams) add({ ref: `team:${team}`, label: team, sub: `team · ${n.toLocaleString()} key${n === 1 ? '' : 's'}`, kind: 'team' }, team);
    for (const [agentId, keys] of groups) {
      const count = new Map<string, number>();
      for (const k of keys) if (k.team) count.set(k.team, (count.get(k.team) ?? 0) + 1);
      const team = [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'no team';
      add({ ref: `agent:${groupStation(agentId)}`, label: agentId, sub: `agent · ×${keys.length} · ${team}`, kind: 'agent' }, agentId);
    }
    for (const k of this.keys) {
      const grouped = k.agent_id && groups.has(k.agent_id);
      add({ ref: grouped ? `key:${k.id}` : `agent:${k.id}`, label: k.name, sub: grouped ? `key · copy of ${k.agent_id}` : `agent · ${[k.team, k.project].filter(Boolean).join(' · ') || 'no team'}`, kind: grouped ? 'key' : 'agent' }, k.name);
    }
    for (const s of this.stations.values()) {
      if (s.kind === 'model' || s.kind === 'mcp' || s.kind === 'observed') add({ ref: `station:${s.id}`, label: s.label, sub: s.sub, kind: s.kind }, s.label);
      if (s.kind === 'mcp') for (const r of s.tools) add({ ref: `tool:${s.id}|${r.name}`, label: r.name, sub: `tool · ${s.label}`, kind: 'tool' }, r.name);
    }
    hits.sort((a, b) => a.score - b.score || a.label.localeCompare(b.label));
    // A few keys at most: the agent above them already covers every copy.
    let keys = 0;
    return hits
      .filter((h) => h.kind !== 'key' || ++keys <= 4)
      .slice(0, limit)
      .map(({ score: _score, ...h }) => h);
  }

  /** Bring a search hit into view: open its team if it is folded into one, then centre and focus it. Returns the focused station. */
  reveal(ref: string, rightInset?: number): string | null {
    const t = this.topology;
    if (!t) return null;
    // The panel that opens beside the map is part of the view to centre in.
    if (rightInset !== undefined) this.setRightInset(rightInset);
    const i = ref.indexOf(':');
    const kind = ref.slice(0, i);
    const id = ref.slice(i + 1);
    let target: string | undefined;
    let toolY: number | undefined;
    if (kind === 'team') {
      target = teamStation(id);
      if (this.level === 'teams') {
        if (this.openTeams.has(id)) this.toggleTeam(id);
      } else {
        // Per-agent view: trace the first of its agents.
        const k = this.keys.find((x) => x.team === id);
        target = k ? this.stationOf(k.id) : undefined;
      }
    } else if (kind === 'agent' || kind === 'key') {
      const keyIds = kind === 'key' ? [id] : this.agentKeyIds(id);
      const k = this.keys.find((x) => x.id === keyIds[0]);
      if (k?.team && this.level === 'teams' && !this.openTeams.has(k.team)) this.toggleTeam(k.team);
      target = k ? this.stationOf(k.id) : undefined;
    } else if (kind === 'station') {
      target = id;
    } else if (kind === 'tool') {
      const [server, tool] = id.split('|') as [string, string];
      const s = this.stations.get(server);
      if (s && !s.expanded) {
        s.expanded = true;
        s.userToggled = true;
        this.layout();
      }
      target = server;
      toolY = s?.tools.find((r) => r.name === tool)?.y;
    }
    const s = target ? this.stations.get(target) : undefined;
    if (!s) return null;
    this.centerOn(s.x + s.w / 2, toolY ?? s.y + s.headH / 2);
    this.setFocus(s.id);
    return s.id;
  }

  /** The key ids an agent-level station id stands for (a group's copies, or one key). */
  private agentKeyIds(stationId: string): string[] {
    const t = this.topology;
    if (!t) return [];
    if (stationId.startsWith('group:')) {
      const agentId = stationId.slice(6);
      return this.keys.filter((k) => k.agent_id === agentId).map((k) => k.id);
    }
    return [stationId];
  }

  /** Pan (and zoom in to a readable scale if needed) so a world point sits in the middle of the visible map. */
  private centerOn(wx: number, wy: number): void {
    const k = Math.max(this.cam.k, 0.9);
    const vw = this.w - this.rightInset;
    this.cam = { k, x: vw / 2 - wx * k, y: this.h / 2 - wy * k };
    this.dirty = true;
    this.camCb?.({ ...this.cam });
  }

  // ------------------------------------------------------------ attention

  /** Keep these stations lit and dim the rest (null: everything lit). */
  setHighlight(ids: Iterable<string> | null): void {
    this.highlight = ids ? new Set(ids) : null;
    this.dirty = true;
  }

  /**
   * What needs a person, most urgent first: calls waiting for approval, calls
   * blocked or failing now, agents calling a provider directly, destructive
   * tools in use with no gate, connections never used before, and traffic far
   * above its usual rate. Plus the busiest stations right now.
   */
  attention(): { items: AttentionItem[]; busiest: Array<{ id: string; label: string; kind: StationKind; rpm: number }> } {
    const now = Date.now();
    const items: AttentionItem[] = [];
    const t = this.topology;
    const since = t?.paths_since ?? null;
    const agents = [...this.stations.values()].filter((s) => s.kind === 'agent');
    const dests = [...this.stations.values()].filter((s) => s.kind === 'model' || s.kind === 'mcp');
    const ago = (ts: number) => {
      const m = Math.round((now - ts) / 60_000);
      return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
    };
    const where = (s: Station) => (s.team ? `team ${s.label}` : s.label);

    for (const s of agents) {
      if (s.held) items.push({ kind: 'holding', severity: 3, stationId: s.id, ref: `station:${s.id}`, title: `${where(s)}: ${s.held} waiting for approval`, detail: 'Held at a gate until someone approves or denies' });
      if (s.denials.length) items.push({ kind: 'blocked', severity: 3, stationId: s.id, ref: `station:${s.id}`, title: `${where(s)}: ${s.denials.length} blocked in the last minute`, detail: `${s.recent.length ? Math.round((100 * s.denials.length) / s.recent.length) : 100}% of its calls` });
    }
    for (const s of this.stations.values()) {
      if (s.kind === 'observed' && s.obs?.bypass && s.obs.count24h > 0)
        items.push({ kind: 'bypass', severity: 3, stationId: s.id, ref: `station:${s.id}`, title: `${s.label} called directly, skipping the gateway`, detail: `${s.obs.count24h.toLocaleString()} call${s.obs.count24h === 1 ? '' : 's'} in 24 h, last ${ago(s.obs.lastSeen)} — no gates or budgets apply` });
    }
    for (const s of dests) {
      // A handful of failures a minute on a busy model is normal; a real share of its calls failing is not.
      if (s.errors.length >= 3 && s.errors.length >= 0.05 * s.recent.length) items.push({ kind: 'errors', severity: 2, stationId: s.id, ref: `station:${s.id}`, title: `${s.label}: ${s.errors.length} failed calls in the last minute`, detail: `${s.recent.length ? Math.round((100 * s.errors.length) / s.recent.length) : 100}% of its calls` });
      // Destructive tools in use with no gate that could stop them.
      for (const row of s.tools) {
        if (row.op !== 'admin' || (!row.count24h && !row.recent.length) || this.toolGated(s, row)) continue;
        items.push({ kind: 'ungated', severity: 2, stationId: s.id, ref: `tool:${s.id}|${row.name}`, title: `${s.label} → ${row.name} has no gate`, detail: `A destructive ${s.protocol === 'http' ? 'route' : 'tool'} used ${row.count24h.toLocaleString()} time${row.count24h === 1 ? '' : 's'} in 24 h` });
      }
    }
    // Connections first used in the last day — once there is a day of history to compare with.
    if (since !== null && now - since > LEARNING_MS) {
      for (const e of this.edges) {
        if (!e.first_ts || now - e.first_ts > 24 * 3600_000 || e.first_ts - since < LEARNING_MS) continue;
        const a = this.stations.get(e.key_id);
        const d = this.stations.get(e.target_id);
        if (!a || !d) continue;
        items.push({ kind: 'new', severity: 2, stationId: a.id, ref: e.tool ? `tool:${d.id}|${e.tool}` : `station:${a.id}`, title: `${a.label} → ${d.label}${e.tool ? ` · ${e.tool}` : ''}: new connection`, detail: `First used ${ago(e.first_ts)} · ${e.requests.toLocaleString()} call${e.requests === 1 ? '' : 's'} since`, also: d.id });
      }
    }
    // Far above the usual rate (averaged over the history there is, up to a day).
    const window = Math.min(24 * 3600_000, since === null ? 0 : now - since);
    if (window > 3600_000) {
      const perMin = new Map<string, number>();
      for (const e of this.edges) {
        perMin.set(e.key_id, (perMin.get(e.key_id) ?? 0) + e.requests);
        perMin.set(e.target_id, (perMin.get(e.target_id) ?? 0) + e.requests);
      }
      for (const s of [...agents, ...dests]) {
        const usual = (perMin.get(s.id) ?? 0) / (window / 60_000);
        const rate = s.recent.length;
        if (rate >= 30 && rate > 3 * usual) items.push({ kind: 'spike', severity: 1, stationId: s.id, ref: `station:${s.id}`, title: `${where(s)}: ${rate.toLocaleString()} calls/min`, detail: usual >= 1 ? `${Math.round(rate / usual)}× its usual ${Math.round(usual)}/min` : 'Usually close to idle' });
      }
    }
    items.sort((a, b) => b.severity - a.severity);
    const busiest = [...agents, ...dests]
      .filter((s) => s.recent.length)
      .sort((a, b) => b.recent.length - a.recent.length)
      .slice(0, 6)
      .map((s) => ({ id: s.id, label: where(s), kind: s.kind, rpm: s.recent.length }));
    return { items, busiest };
  }

  // ------------------------------------------------------------ matrix

  /**
   * Who talks to what, as a grid: a row per agent station (per team at the
   * organization level), a column per destination, a cell per connection with
   * its last day of traffic, whether it is live now and the gates that apply.
   */
  matrix(): MatrixData {
    const now = Date.now();
    const rows = [...this.stations.values()].filter((s) => s.kind === 'agent');
    const cols = [...this.stations.values()].filter((s) => s.kind === 'model' || s.kind === 'mcp' || s.kind === 'observed');
    const cells = new Map<string, MatrixCell>();
    const cell = (a: string, d: string) => {
      const k = `${a}>${d}`;
      let c = cells.get(k);
      if (!c) cells.set(k, (c = { requests: 0, cost: 0, denied: 0, errors: 0, live: false, tools: [], gates: [], outside: false }));
      return c;
    };
    for (const e of this.edges) {
      if (!this.stations.has(e.key_id) || !this.stations.has(e.target_id)) continue;
      const c = cell(e.key_id, e.target_id);
      c.requests += e.requests;
      c.cost += e.cost_nanousd;
      c.denied += e.denied;
      c.errors += e.errors;
      if (e.tool) {
        const t = c.tools.find((x) => x.name === e.tool);
        if (t) t.requests += e.requests;
        else c.tools.push({ name: e.tool, requests: e.requests });
      }
    }
    for (const e of this.obsEdges) {
      if (!this.stations.has(e.key_id) || !this.stations.has(e.target_id)) continue;
      const c = cell(e.key_id, e.target_id);
      c.outside = true;
      c.requests += e.count_24h;
      c.errors += e.errors_24h;
      if (now - e.last_seen < WINDOW_MS) c.live = true;
    }
    for (const [k, ts] of this.livePairs) if (now - ts < WINDOW_MS && cells.has(k)) cells.get(k)!.live = true;
    for (const [k, c] of cells) {
      c.tools.sort((a, b) => b.requests - a.requests);
      if (c.outside) continue; // outside the gateway: nothing can gate it
      const [a, d] = k.split('>') as [string, string];
      c.gates = this.pairGates(this.stations.get(a)!, this.stations.get(d)!);
    }
    const total = new Map<string, number>();
    for (const [k, c] of cells) {
      const [a, d] = k.split('>') as [string, string];
      total.set(a, (total.get(a) ?? 0) + c.requests);
      total.set(d, (total.get(d) ?? 0) + c.requests);
    }
    const head = (s: Station) => ({ id: s.id, label: s.label, sub: s.sub, kind: s.kind, color: s.color, total: total.get(s.id) ?? 0, rpm: s.recent.length, team: s.team?.name, outside: s.kind === 'observed', bypass: !!s.obs?.bypass, agent: s.agentOf });
    const byTotal = (a: { total: number; label: string }, b: { total: number; label: string }) => b.total - a.total || a.label.localeCompare(b.label);
    return { rows: rows.map(head).sort(byTotal), cols: cols.map(head).sort((a, b) => Number(a.outside) - Number(b.outside) || byTotal(a, b)), cells };
  }

  /** The gates that can deny, hold, limit or inspect calls from this agent station to this destination. */
  private pairGates(a: Station, d: Station): Rule[] {
    const keys = this.stationKeys.get(a.id) ?? [];
    const out: Rule[] = [];
    for (const r of this.policy?.rules ?? []) {
      if (!r.enabled || r.effect === 'allow') continue;
      if (r.target_kind === 'model' && d.kind !== 'model') continue;
      if (r.target_kind === 'tool' && d.kind !== 'mcp') continue;
      const m = r.match as { keys?: string[]; groups?: string[]; teams?: string[]; deployments?: string[]; mcp_servers?: string[]; tools?: string[]; models?: string[] };
      if ((m.keys?.length || m.groups?.length || m.teams?.length) && !keys.some((k) => m.keys?.includes(k.id) || (!!k.agent_id && m.groups?.includes(k.agent_id)) || (!!k.team && m.teams?.includes(k.team)))) continue;
      const from = r.from_zone ? this.policy?.zones.find((z) => z.id === r.from_zone) : undefined;
      if (r.from_zone && (!from || !this.zoneMembers(from).some((x) => x.id === a.id))) continue;
      if ((m.deployments?.length || m.mcp_servers?.length) && ![...(m.deployments ?? []), ...(m.mcp_servers ?? [])].includes(d.id)) continue;
      if (m.tools?.length && !(d.kind === 'mcp' && d.tools.some((t) => m.tools!.some((g) => globMatch(g, t.full))))) continue;
      if (m.models?.length && !(d.kind === 'model' && m.models.some((g) => globMatch(g, d.label)))) continue;
      const to = r.to_zone ? this.policy?.zones.find((z) => z.id === r.to_zone) : undefined;
      if (r.to_zone && (!to || !this.zoneMembers(to).some((x) => x.id === d.id))) continue;
      out.push(r);
    }
    return out;
  }

  /** Whether any gate that can stop or hold a call could apply to this tool. */
  private toolGated(server: Station, row: ToolRow): boolean {
    if (row.gates.length) return true;
    for (const r of this.policy?.rules ?? []) {
      if (!r.enabled || r.effect === 'allow' || r.target_kind === 'model') continue;
      const m = r.match as { tools?: string[]; mcp_servers?: string[]; deployments?: string[]; operations?: string[] };
      if (m.deployments?.length) continue;
      if (m.tools?.length && !m.tools.some((g) => globMatch(g, row.full))) continue;
      if (m.mcp_servers?.length && !m.mcp_servers.includes(server.id)) continue;
      if (m.operations?.length && !m.operations.includes(row.op)) continue;
      const to = r.to_zone ? this.policy?.zones.find((z) => z.id === r.to_zone) : undefined;
      if (to && !this.zoneMembers(to).some((x) => x.id === server.id)) continue;
      return true;
    }
    return false;
  }

  setFocus(id: string | null): void {
    this.focusId = id && this.stations.has(id) ? id : null;
    this.relatedCache = null;
    this.dirty = true;
  }

  // ---------------------------------------------------------------- topology

  private blank(id: string, kind: StationKind, label: string, sub: string, color: number, slug = ''): Station {
    return { id, kind, label, sub, slug, color, x: 0, y: 0, w: 0, h: 0, headH: 46, px: 0, py: 0, tools: [], expanded: true, userToggled: false, recent: [], denials: [], errors: [], lastAt: 0, held: 0 };
  }

  setTopology(t: Topology): void {
    this.topology = t;
    // In a view, only its teams' keys are drawn; everything below works on those.
    const scope = this.scope;
    this.keys = scope ? t.keys.filter((k) => !!k.team && scope.has(k.team)) : t.keys;
    const inKeys = this.keys;
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
    // Agents: per agent (a group, or a single key), or per team at the organization level.
    const groups = agentGroups(inKeys);
    const agentOf = keyStations(inKeys, groups);
    const teams = new Map<string, TopologyKey[]>();
    for (const k of inKeys) if (k.team) (teams.get(k.team) ?? teams.set(k.team, []).get(k.team)!).push(k);
    const agentCount = new Set(agentOf.values()).size;
    // Teams only mean something with two or more of them (a one-team view always shows its agents).
    this.level = teams.size < 2 ? 'agents' : this.levelPref === 'auto' ? (agentCount > AUTO_TEAMS_ABOVE ? 'teams' : 'agents') : this.levelPref;
    const oldKeys = this.stationKeys;
    this.keyStation = new Map();
    // A team with a single agent is drawn as that agent: folding it would only hide its name.
    const teamAgents = new Map<string, Set<string>>();
    for (const k of inKeys) if (k.team) (teamAgents.get(k.team) ?? teamAgents.set(k.team, new Set()).get(k.team)!).add(agentOf.get(k.id)!);
    const folded = (k: TopologyKey) => this.level === 'teams' && !!k.team && !this.openTeams.has(k.team) && teamAgents.get(k.team)!.size > 1;
    for (const k of inKeys) this.keyStation.set(k.id, folded(k) ? teamStation(k.team!) : agentOf.get(k.id)!);
    this.stationKeys = new Map();
    for (const k of inKeys) {
      const id = this.keyStation.get(k.id)!;
      (this.stationKeys.get(id) ?? this.stationKeys.set(id, []).get(id)!).push(k);
    }
    for (const [id, keys] of this.stationKeys) {
      const k = keys[0]!;
      let st: Station;
      if (isTeam(id)) {
        const agents = new Set(keys.map((x) => agentOf.get(x.id))).size;
        st = upsert(id, 'agent', k.team!, `team · ${keys.length.toLocaleString()} key${keys.length === 1 ? '' : 's'}`, agentColor(id));
        st.team = { name: k.team!, agents, keys: keys.length };
        st.copies = undefined;
        st.copiesOf = undefined;
      } else if (keys.length > 1 || (k.agent_id && groups.has(k.agent_id))) {
        const ts = [...new Set(keys.map((x) => x.team).filter(Boolean))];
        const all = groups.get(k.agent_id!)?.length ?? keys.length;
        st = upsert(id, 'agent', k.agent_id!, `${ts.length > 1 ? `${ts.length} teams` : (ts[0] ?? 'agent')} · ${keys.length.toLocaleString()}${all > keys.length ? ` of ${all.toLocaleString()}` : ''} keys`, agentColor(k.agent_id!));
        st.copies = keys.length;
        // Some copies are drawn inside a folded team: say how many of the agent's copies this station is.
        st.copiesOf = all > keys.length ? all : undefined;
        st.team = undefined;
      } else {
        st = upsert(id, 'agent', k.name, [k.team, k.project].filter(Boolean).join(' · ') || 'agent', agentColor(k.agent_id ?? k.id));
        st.copies = undefined;
        st.copiesOf = undefined;
        st.team = undefined;
      }
      // Inside an opened team: the open team most of its keys are in (an agent's copies can span teams).
      st.teamOf = undefined;
      if (this.level === 'teams' && !st.team) {
        const votes = new Map<string, number>();
        for (const x of keys) if (x.team && this.openTeams.has(x.team)) votes.set(x.team, (votes.get(x.team) ?? 0) + 1);
        st.teamOf = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0];
      }
    }
    // Switching level (or opening a team) replaces agent stations: carry their last minute over.
    for (const [oldId, keys] of oldKeys) {
      if (keep.has(oldId)) continue;
      const from = this.stations.get(oldId);
      const into = new Set(keys.map((k) => this.keyStation.get(k.id)).filter((x): x is string => !!x));
      if (!from || into.size !== 1) continue; // split: the new stations are seeded from the topology below
      const to = this.stations.get([...into][0]!);
      if (!to) continue;
      to.recent.push(...from.recent);
      to.recent.sort((a, b) => a - b);
      to.denials.push(...from.denials);
      to.lastAt = Math.max(to.lastAt, from.lastAt);
      for (const pairs of [this.livePairs, this.liveToolPairs])
        for (const [pk, ts] of [...pairs]) {
          if (!pk.startsWith(`${oldId}>`)) continue;
          pairs.delete(pk);
          const nk = `${to.id}${pk.slice(oldId.length)}`;
          pairs.set(nk, Math.max(pairs.get(nk) ?? 0, ts));
        }
    }
    // In a view: the destinations its agents reach (all of them while they reach none yet, so a first gate can be drawn).
    const edgesIn = (t.edges ?? []).filter((e) => this.keyStation.has(e.key_id));
    const obsIn = (t.observed?.edges ?? []).filter((e) => this.keyStation.has(e.key_id));
    const reached = new Set([...edgesIn.map((e) => e.target_id), ...obsIn.map((e) => e.target_id)]);
    const shows = (id: string, observed = false) => !scope || reached.has(id) || (!observed && !edgesIn.length);
    const provById = new Map(t.providers.map((p) => [p.id, p]));
    for (const d of t.deployments) {
      if (!shows(d.id)) continue;
      const prov = provById.get(d.provider_id);
      upsert(d.id, 'model', d.public_name ?? d.upstream_model, prov?.name ?? prov?.kind ?? 'model', PROVIDER_COLORS[providerLook(prov)] ?? 0x475569);
    }
    for (const m of t.mcp_servers ?? []) {
      if (!shows(m.id)) continue;
      const http = m.protocol === 'http';
      const n = m.tools.length;
      const s = upsert(
        m.id,
        'mcp',
        m.name,
        m.agent_id ? `agent ${m.agent_id} · via ${http ? 'HTTP' : 'MCP'}` : http ? `HTTP API · ${n ? `${n} route${n === 1 ? '' : 's'}` : 'no calls yet'}` : `MCP server · ${n} tool${n === 1 ? '' : 's'}`,
        m.agent_id ? agentColor(m.agent_id) : MCP_COLOR,
        m.slug,
      );
      s.protocol = http ? 'http' : 'mcp';
      s.agentOf = m.agent_id;
      const prev = new Map(s.tools.map((r) => [r.name, r]));
      s.tools = m.tools.map((tool) => {
        const old = prev.get(tool.name);
        return { name: tool.name, full: `${m.slug}__${tool.name}`, op: tool.op, recent: old?.recent ?? [], lastAt: old?.lastAt ?? 0, count24h: 0, gates: [], y: 0, gateHits: [] };
      });
    }
    const OBS_KIND: Record<string, string> = { http: 'service', database: 'database', queue: 'queue', model: 'model API', saas: 'SaaS', rpc: 'service', tool: 'tool', other: 'system' };
    for (const o of t.observed?.targets ?? []) {
      if (!shows(o.id, true)) continue;
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
    this.obsEdges = this.mergeByStation(obsIn, (e) => e.target_id, (into, e) => {
      into.count_24h += e.count_24h;
      into.errors_24h += e.errors_24h;
      into.writes_24h += e.writes_24h;
      into.last_seen = Math.max(into.last_seen, e.last_seen);
    });
    for (const id of [...this.stations.keys()]) if (!keep.has(id) && id !== '__unknown') this.stations.delete(id);
    // Calls in the air follow their key to whichever station draws it now.
    for (const st of this.stations.values()) if (st.kind === 'agent') st.held = 0;
    for (const f of this.live.values()) {
      f.agent = this.stationOf(f.key);
      const a = f.held ? this.stations.get(f.agent) : undefined;
      if (a) a.held++;
    }

    this.edges = this.mergeByStation(edgesIn, (e) => `${e.target_id}|${e.tool ?? ''}`, (into, e) => {
      into.requests += e.requests;
      into.errors += e.errors;
      into.denied += e.denied;
      into.cost_nanousd += e.cost_nanousd;
      into.last_ts = Math.max(into.last_ts, e.last_ts);
      if (e.recent?.length) (into.recent ??= []).push(...e.recent);
    });
    // Agents calling agents: through a server that fronts an agent, and on someone's behalf.
    const stationOfAgent = new Map<string, string>();
    for (const k of inKeys) {
      const st = this.keyStation.get(k.id);
      if (!st) continue;
      if (k.agent_id && !stationOfAgent.has(k.agent_id)) stationOfAgent.set(k.agent_id, st);
      stationOfAgent.set(k.id, st);
    }
    const links = new Map<string, AgentLink>();
    // The same exchange shows up twice — A's calls to B's server, and B's calls on A's behalf — so each is counted on its own.
    const link = (from: string | undefined, to: string | undefined, via: 'viaTool' | 'onBehalf', requests: number, lastTs: number) => {
      if (!from || !to || from === to) return;
      const l = links.get(`${from}>${to}`) ?? links.set(`${from}>${to}`, { from, to, requests: 0, viaTool: 0, onBehalf: 0, lastTs: 0 }).get(`${from}>${to}`)!;
      l[via] += requests;
      l.requests = l.viaTool || l.onBehalf;
      l.lastTs = Math.max(l.lastTs, lastTs);
    };
    for (const e of this.edges) {
      const agent = this.stations.get(e.target_id)?.agentOf;
      if (agent) link(e.key_id, stationOfAgent.get(agent), 'viaTool', e.requests, e.last_ts);
    }
    for (const d of t.delegations ?? []) link(stationOfAgent.get(d.from), this.keyStation.get(d.key_id), 'onBehalf', d.requests, d.last_ts);
    this.agentLinks = [...links.values()];
    this.used24h.clear();
    this.day.clear();
    for (const e of this.edges) {
      this.day.set(e.key_id, (this.day.get(e.key_id) ?? 0) + e.requests);
      this.day.set(e.target_id, (this.day.get(e.target_id) ?? 0) + e.requests);
    }
    // Seed the per-minute counters from the server, so traffic from just before the map opened reads as active.
    const seeded = new Set<string>();
    // Each 5-second bucket's calls become points spread over the bucket (capped so the bucket's end is not in the future).
    const now = Date.now();
    const points = (buckets: Array<[number, number]>) => {
      const out: number[] = [];
      for (const [b, n] of buckets) {
        const span = Math.max(1, Math.min(5000, now - b));
        for (let i = 0; i < n; i++) out.push(b + ((i + 0.5) * span) / n);
      }
      return out.sort((a, b) => a - b);
    };
    const seed = (id: string, into: { recent: number[]; lastAt: number }, ts: number[]) => {
      if (!ts.length || (into.recent.length && !seeded.has(id))) return;
      seeded.add(id);
      into.recent.push(...ts);
      into.recent.sort((a, b) => a - b);
      into.lastAt = Math.max(into.lastAt, ts[ts.length - 1]!);
    };
    const hub: number[] = [];
    for (const e of this.edges) {
      this.used24h.add(e.key_id);
      this.used24h.add(e.target_id);
      const row = e.tool ? this.stations.get(e.target_id)?.tools.find((r) => r.name === e.tool) : undefined;
      if (row) row.count24h += e.requests;
      const ts = points(e.recent ?? []);
      if (!ts.length) continue;
      hub.push(...ts);
      const agent = this.stations.get(e.key_id);
      const dest = this.stations.get(e.target_id);
      if (agent) seed(agent.id, agent, ts);
      if (dest) seed(dest.id, dest, ts);
      if (row) seed(`${e.target_id}|${e.tool}`, row, ts);
      const last = ts[ts.length - 1]!;
      if (agent && dest) this.livePairs.set(`${agent.id}>${dest.id}`, Math.max(this.livePairs.get(`${agent.id}>${dest.id}`) ?? 0, last));
      if (agent && dest && e.tool) this.liveToolPairs.set(`${agent.id}>${dest.id}|${e.tool}`, Math.max(this.liveToolPairs.get(`${agent.id}>${dest.id}|${e.tool}`) ?? 0, last));
    }
    if (!this.hubRecent.length) this.hubRecent.push(...hub.sort((x, y) => x - y));
    this.relatedCache = null;
    this.layout();
  }

  /** Per-key rows re-keyed by the station that draws each key, rows landing on the same station and target summed. */
  private mergeByStation<E extends { key_id: string }>(rows: E[], target: (e: E) => string, add: (into: E, e: E) => void): E[] {
    const out = new Map<string, E>();
    for (const e of rows) {
      const key_id = this.keyStation.get(e.key_id) ?? e.key_id;
      const k = `${key_id}>${target(e)}`;
      const into = out.get(k);
      if (into) add(into, e);
      else out.set(k, { ...e, key_id, ...('recent' in e && Array.isArray(e.recent) ? { recent: [...e.recent] } : {}) });
    }
    return [...out.values()];
  }

  /** The station drawing an agent (by agent id), if it is on the map. */
  private agentStation(agentId: string): string | undefined {
    const k = this.keys.find((x) => x.agent_id === agentId || x.id === agentId);
    return k ? this.keyStation.get(k.id) : undefined;
  }

  /** The station that draws a key's traffic. */
  private stationOf(keyId: string): string {
    return this.keyStation.get(keyId) ?? keyId;
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
        for (const id of [this.stationOf(l.key_id), l.target_id]) {
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
    return s.kind === 'agent' ? agentRef(s.id) : s.kind === 'mcp' ? `mcp:${s.id}` : `deployment:${s.id}`;
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
        // A group is in the zone when any of its keys is (the policy engine decides per key).
        const m = z.match as { teams?: string[]; projects?: string[]; tags?: string[] };
        const inZone = (k: TopologyKey) =>
          z.stations.includes(`key:${k.id}`) ||
          (k.agent_id && z.stations.includes(groupStation(k.agent_id))) ||
          (k.team && z.stations.includes(teamStation(k.team))) || (m.teams?.length && k.team && m.teams.includes(k.team)) || (m.projects?.length && k.project && m.projects.includes(k.project)) || (m.tags?.length && k.tags.some((tg) => m.tags!.includes(tg)));
        if ((this.stationKeys.get(s.id) ?? []).some(inZone)) out.push(s);
      }
    }
    return out;
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
    // Each station sorts under the first zone it belongs to (computed once: this runs inside a sort).
    const firstZone = new Map<string, number>();
    zones.forEach((z, i) => {
      for (const s of this.zoneMembers(z)) if (!firstZone.has(s.id)) firstZone.set(s.id, i);
    });
    const rank = (s: Station) => firstZone.get(s.id) ?? 999;
    const kindRank = (s: Station) => (s.kind === 'model' ? 0 : s.kind === 'mcp' ? 1 : s.kind === 'observed' ? 3 : 2);
    // At the organization level agents sort by team, so an opened team's agents sit together where the team was.
    const byTeam = this.level === 'teams';
    const teamKey = (s: Station) => s.team?.name ?? s.teamOf ?? '\uffff';
    const cluster = (s: Station | undefined) => (s?.teamOf ?? '');
    const place = (list: Station[], x: number, side: 'left' | 'right') => {
      const teamSort = byTeam && side === 'left';
      list.sort((a, b) => rank(a) - rank(b) || (teamSort ? teamKey(a).localeCompare(teamKey(b)) : kindRank(a) - kindRank(b)) || a.label.localeCompare(b.label));
      const n = list.length;
      if (!n) return;
      for (const s of list) if (!s.userToggled) s.expanded = s.kind === 'mcp' && s.tools.length > 0;
      let head = 46;
      let gap = 10;
      const zoneGap = 16;
      const header = 24;
      // Space above each card: a zone header where a zone starts, a team header where an opened team starts.
      const above = list.map((s, i) => {
        const prev = list[i - 1];
        const zoneStart = !prev || rank(s) !== rank(prev);
        const teamStart = !!cluster(s) && (zoneStart || cluster(s) !== cluster(prev));
        const teamEnd = !zoneStart && !!cluster(prev) && cluster(prev) !== cluster(s);
        if (!zoneStart && !teamStart && !teamEnd) return null;
        return (zoneStart && i > 0 ? zoneGap : 0) + (zoneStart && rank(s) !== 999 ? header : 0) + (teamStart ? (zoneStart ? 4 : zoneGap) + TEAM_HEAD : 0) + (teamEnd && !teamStart ? zoneGap : 0);
      });
      const heightOf = (s: Station) => head + (s.expanded && s.tools.length ? s.tools.length * TOOL_ROW + 8 : 0);
      const need = () => list.reduce((sum, s, i) => sum + heightOf(s) + (above[i] ?? (i ? gap : 0)), 0);
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
        y += above[i] ?? (i ? gap : 0);
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
    // Observed systems get their own region below the tower: "outside the gateway" made literal.
    const observed = [...this.stations.values()].filter((s) => s.kind === 'observed').sort((a, b) => Number(!!b.obs?.bypass) - Number(!!a.obs?.bypass) || a.label.localeCompare(b.label));
    this.obsBand = null;
    if (observed.length) {
      // Between the columns, leaving room for the routing channel beside the agents.
      const left = 28 + cardW + 64;
      const right = W - 28 - cardW - 24;
      const bw = Math.max(300, right - left);
      const cols = Math.max(Math.min(2, observed.length), Math.min(3, observed.length, Math.floor((bw + 10) / 170)));
      const ow = Math.min(196, Math.max(140, (bw - 24) / cols - 10));
      const perRow = cols;
      const rows = Math.ceil(observed.length / perRow);
      const oh = 40;
      const gutter = 18; // room for routed lines between rows and columns
      const bandH = 44 + rows * (oh + gutter) + 4;
      const bandTop = padTop + avail - bandH;
      this.hub = [Math.round(W / 2), Math.round(padTop + Math.max(this.holdR + 20, (avail - bandH - 40) / 2))];
      const rowW = Math.min(observed.length, perRow) * (ow + gutter) - gutter;
      const x0 = Math.round(Math.max(left, Math.min(W / 2 - rowW / 2, right - rowW)));
      observed.forEach((s, i) => {
        const r = Math.floor(i / perRow);
        const c = i % perRow;
        s.expanded = false;
        s.w = Math.round(ow);
        s.headH = oh;
        s.h = oh;
        s.x = x0 + c * (ow + gutter);
        s.y = bandTop + 42 + r * (oh + gutter);
        s.px = s.x;
        s.py = s.y + oh / 2;
      });
      this.obsBand = { x: x0 - 12, y: bandTop, w: rowW + 24, h: bandH, left: x0 };
    }
    place([...this.stations.values()].filter((s) => s.kind === 'agent'), 28, 'left');
    place([...this.stations.values()].filter((s) => s.kind !== 'agent' && s.kind !== 'observed'), W - 28 - cardW, 'right');

    // User arrangement wins over the automatic columns; ports always face the tower.
    const hubPos = this.positions.get('__hub');
    if (hubPos) this.hub = [hubPos[0], hubPos[1]];
    for (const s of this.stations.values()) {
      const p = this.positions.get(s.id);
      if (p) {
        s.x = p[0];
        s.y = p[1];
      }
      if (s.kind === 'observed') {
        s.px = s.x + s.w / 2;
        s.py = s.y;
      } else {
        s.px = s.x + s.w / 2 < this.hub[0] ? s.x + s.w : s.x;
        s.py = s.y + s.headH / 2;
      }
      s.tools.forEach((r, j) => (r.y = s.y + s.headH + 4 + j * TOOL_ROW));
    }
    // A header over each opened team's agents (over the topmost, wherever they were dragged); clicking it closes the team.
    this.teamHeads = [];
    for (const team of this.openTeams) {
      const members = [...this.stations.values()].filter((s) => s.teamOf === team);
      if (!members.length) continue;
      const top = members.reduce((a, b) => (b.y < a.y ? b : a));
      this.teamHeads.push({ team, x: top.x, y: top.y - TEAM_HEAD, w: top.w, h: TEAM_HEAD - 4, agents: members.length });
    }

    this.spokes.clear();
    const [hx, hy] = this.hub;
    this.obsLines = this.routeObserved();
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
      const m = r.match as { tools?: string[]; keys?: string[]; groups?: string[]; teams?: string[]; deployments?: string[]; mcp_servers?: string[] };
      const toolGlobs = m.tools;
      const toZone = r.to_zone ? zones.find((x) => x.id === r.to_zone) : undefined;
      if (toolGlobs?.length) {
        let servers = toZone ? this.zoneMembers(toZone).filter((s) => s.kind === 'mcp') : [...this.stations.values()].filter((s) => s.kind === 'mcp');
        if (m.mcp_servers?.length) servers = servers.filter((s) => m.mcp_servers!.includes(s.id));
        for (const s of servers) for (const row of s.tools) if (toolGlobs.some((g) => globMatch(g, row.full))) row.gates.push(r);
        continue;
      }
      const destIds = [...(m.deployments ?? []), ...(m.mcp_servers ?? [])];
      if (m.keys?.length || m.groups?.length || m.teams?.length) {
        // Scoped to specific agents: the gate sits on the line of each station drawing them (once, however many of its keys it names).
        const scope = { keys: new Set(m.keys), groups: new Set(m.groups), teams: new Set(m.teams) };
        const ids = new Set<string>();
        for (const k of this.topology?.keys ?? []) if (scope.keys.has(k.id) || (k.agent_id && scope.groups.has(k.agent_id)) || (k.team && scope.teams.has(k.team))) ids.add(this.stationOf(k.id));
        for (const id of ids) this.addGate(id, r, 0.66);
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

  /**
   * Transit-map routing for observed traffic. Each line leaves its agent from a
   * second port just below the gateway port, drops down a shared channel beside
   * the agents (one lane per line), runs along a rail above the "outside" region,
   * then enters its system from the side. Lines never pass through the tower,
   * never overlap each other, and cross gateway lines only at right angles.
   *
   * Lane order is chosen so the bundle itself has no crossings: the highest
   * agent takes the outermost lane and turns first.
   */
  private routeObserved(): Array<{ edge: ObservedEdge; agent: Station; target: Station; pts: Pt[] }> {
    const items = this.obsEdges
      .map((edge) => ({ edge, agent: this.stations.get(edge.key_id), target: this.stations.get(edge.target_id) }))
      .filter((x): x is { edge: ObservedEdge; agent: Station; target: Station } => !!x.agent && !!x.target && x.target.kind === 'observed');
    if (!items.length) return [];
    const lane = 4;
    const agents = [...this.stations.values()].filter((s) => s.kind === 'agent');
    const agentsRight = Math.max(...agents.map((s) => s.x + s.w), ...items.map((i) => i.agent.x + i.agent.w));
    const trunk0 = agentsRight + 18;
    // Each line: out of the agent at y=a, down (or up) a lane at x, into the system's side at y=t.
    const perTarget = new Map<string, number>();
    const geo = items.map((it) => {
      const slot = perTarget.get(it.target.id) ?? 0;
      perTarget.set(it.target.id, slot + 1);
      return { ...it, a: it.agent.py + 9, t: it.target.y + it.target.h / 2 + slot * lane, slot };
    });
    // Z-routes cross when one line's horizontal passes through another's vertical.
    // Try a few natural lane orders and keep the one with the fewest crossings.
    const crossings = (order: typeof geo): number => {
      let c = 0;
      order.forEach((p, i) => {
        order.forEach((q, j) => {
          if (i === j) return;
          const lo = Math.min(q.a, q.t);
          const hi = Math.max(q.a, q.t);
          // p's first horizontal (y=p.a) spans lanes < i's... it runs from the agents to lane i.
          if (j < i && p.a > lo && p.a < hi) c++;
          // p's last horizontal (y=p.t) runs from lane i to the systems.
          if (j > i && p.t > lo && p.t < hi) c++;
        });
      });
      return c;
    };
    const candidates = [
      [...geo].sort((p, q) => p.a - q.a || p.t - q.t),
      [...geo].sort((p, q) => q.a - p.a || q.t - p.t),
      [...geo].sort((p, q) => p.t - q.t || p.a - q.a),
      [...geo].sort((p, q) => q.t - p.t || q.a - p.a),
      [...geo].sort((p, q) => Math.abs(p.t - p.a) - Math.abs(q.t - q.a)),
      [...geo].sort((p, q) => Math.abs(q.t - q.a) - Math.abs(p.t - p.a)),
    ];
    let best = candidates[0]!;
    let bestC = Infinity;
    for (const c of candidates) {
      const n = crossings(c);
      if (n < bestC) {
        bestC = n;
        best = c;
      }
    }
    // Lines into a system that has other cards to its left travel along the gutter
    // above its row, then down the gutter beside it — never across another card.
    const leftCol = this.obsBand?.left ?? Infinity;
    const rowUse = new Map<number, number>();
    return best.map((g, i) => {
      const { agent: a, target: o } = g;
      const start: Pt = [a.x + a.w, g.a];
      const cy = Math.max(o.y + 8, Math.min(o.y + o.h - 8, o.y + o.h / 2 + (g.slot % 3) * lane - lane));
      if (a.x + a.w >= o.x) return { edge: g.edge, agent: a, target: o, pts: [start, [start[0] + 16, start[1]], [start[0] + 16, cy], [o.x + o.w, cy]] };
      const tx = Math.min(trunk0 + i * lane, o.x - 12);
      if (o.x <= leftCol + 1) return { edge: g.edge, agent: a, target: o, pts: [start, [tx, start[1]], [tx, cy], [o.x, cy]] };
      const k = rowUse.get(o.y) ?? 0;
      rowUse.set(o.y, k + 1);
      const gapY = o.y - 6 - (k % 3) * 3;
      const dropX = o.x - 6 - (g.slot % 3) * 3;
      return { edge: g.edge, agent: a, target: o, pts: [start, [tx, start[1]], [tx, gapY], [dropX, gapY], [dropX, cy], [o.x, cy]] };
    });
  }

  /** Stroke a polyline with rounded corners. */
  private roundedPath(pts: Pt[], r = 9): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(pts[0]![0], pts[0]![1]);
    for (let i = 1; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i - 1]!;
      const [x1, y1] = pts[i]!;
      const [x2, y2] = pts[i + 1]!;
      const rr = Math.min(r, Math.hypot(x1 - x0, y1 - y0) / 2, Math.hypot(x2 - x1, y2 - y1) / 2);
      ctx.arcTo(x1, y1, x2, y2, rr);
    }
    const last = pts[pts.length - 1]!;
    ctx.lineTo(last[0], last[1]);
  }

  /** Show all connections, only live ones, only gateway traffic, or only traffic outside it. */
  setLayer(layer: 'all' | 'active' | 'gateway' | 'outside'): void {
    this.layer = layer;
    this.dirty = true;
  }

  private addGate(stationId: string, rule: Rule, baseT: number): void {
    const sp = this.spokes.get(stationId);
    if (!sp) return;
    const t = sp.station.kind === 'agent' ? baseT - sp.gates.length * 0.1 : baseT + sp.gates.length * 0.1;
    const [x, y] = bezAt(sp.bez, t);
    sp.gates.push({ rule, x, y });
  }

  // ------------------------------------------------------------------ events

  /** Forget all live activity (per-minute counts, held flights, recent denials) — before and after a replay. */
  resetActivity(): void {
    for (const s of this.stations.values()) {
      s.recent.length = 0;
      s.denials.length = 0;
      s.errors.length = 0;
      s.held = 0;
      for (const r of s.tools) r.recent.length = 0;
    }
    this.livePairs.clear();
    this.liveToolPairs.clear();
    this.live.clear();
    this.ruleHits.clear();
    this.hubRecent.length = 0;
    this.relatedCache = null;
    this.dirty = true;
  }

  /**
   * A second of live traffic, summed per path: each call becomes a point in the
   * per-minute counts, spread over the second it happened in.
   */
  ingestTick(t: LiveTick): { flights: number; errors: number; denied: number; cost_nanousd: number } {
    const mine = { flights: 0, errors: 0, denied: 0, cost_nanousd: 0 };
    if (!this.ready) return mine;
    const from = t.ts - t.ms;
    const spread = (n: number, into: number[]) => {
      for (let i = 0; i < n; i++) into.push(from + ((i + 0.5) * t.ms) / n);
    };
    for (const [keyId, target, tool, n, errors, denied, cost] of t.paths) {
      if (!this.keyStation.has(keyId)) continue; // another part of the organization
      mine.flights += n;
      mine.errors += errors;
      mine.denied += denied;
      mine.cost_nanousd += cost;
      const agent = this.stations.get(this.stationOf(keyId));
      if (!agent || !n) continue;
      const dest = target ? this.stations.get(target) : this.ensureUnknown();
      spread(n, agent.recent);
      agent.lastAt = t.ts;
      spread(n, this.hubRecent);
      if (!dest) continue;
      spread(n, dest.recent);
      dest.lastAt = t.ts;
      this.livePairs.set(`${agent.id}>${dest.id}`, t.ts);
      if (tool) {
        const row = dest.tools.find((r) => r.name === tool);
        if (row) {
          spread(n, row.recent);
          row.lastAt = t.ts;
        }
        this.liveToolPairs.set(`${agent.id}>${dest.id}|${tool}`, t.ts);
      }
    }
    for (const [rule, n] of Object.entries(t.rules)) spread(n, this.ruleHits.get(rule) ?? this.ruleHits.set(rule, []).get(rule)!);
    // Points arrive a second at a time; keep each list in time order for pruning.
    for (const s of this.stations.values()) if (s.recent.length > 1 && s.recent[s.recent.length - 1]! < s.recent[s.recent.length - 2]!) s.recent.sort((a, b) => a - b);
    if (this.focusId) this.relatedCache = null;
    this.dirty = true;
    return mine;
  }

  /**
   * One flight event. Live, only held, denied and failed flights arrive this way
   * and their traffic is already counted by ticks (`counted` false); a replay
   * sends every event and counts it here.
   */
  handle(e: FlightEvent, counted = true): void {
    if (!this.ready) return;
    const now = Date.now();
    if (now - e.ts > STALE_MS) return;
    this.dirty = true;
    switch (e.t) {
      case 'flight.started': {
        const agent = this.stations.get(this.stationOf(e.key_id));
        if (!agent) return;
        const destId = e.deployment_id ?? e.mcp_server_id;
        const dest = (destId && this.stations.get(destId)) || (destId ? undefined : this.ensureUnknown());
        this.live.set(e.flight_id, { agent: agent.id, key: e.key_id, dest: dest?.id, held: false });
        if (!counted) break;
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
        break;
      }
      case 'flight.decision': {
        if (counted && e.rule_id && (e.decision === 'deny' || e.decision === 'hold' || e.decision === 'mutate' || e.decision === 'flagged')) {
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
        if (f && e.status === 'error') {
          this.stations.get(f.agent)?.errors.push(e.ts);
          if (f.dest) this.stations.get(f.dest)?.errors.push(e.ts);
        }
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

  private activePairs(now: number): number {
    let n = 0;
    for (const ts of this.livePairs.values()) if (now - ts < WINDOW_MS) n++;
    return n;
  }

  /**
   * What to highlight: the clicked (pinned) node, else whatever is hovered —
   * a node traces all its connections, an observed line just its two ends.
   */
  private related(): Set<string> | null {
    const h = this.hovered;
    const hoverId = h?.startsWith('station:') ? h.slice(8) : h?.startsWith('spoke:') ? h.slice(6) : null;
    const fid = this.focusId ?? hoverId;
    if (!fid) {
      if (this.hovered?.startsWith('obs:')) return new Set(this.hovered.slice(4).split('>'));
      return this.highlight;
    }
    if (this.relatedCache?.id === fid) return this.relatedCache.set;
    const f = this.stations.get(fid);
    if (!f || f.kind === 'unknown') return null;
    const set = new Set<string>([f.id]);
    const add = (a: string, d: string) => {
      if (f.kind === 'agent' && a === f.id) set.add(d);
      else if (f.kind !== 'agent' && d === f.id) set.add(a);
    };
    for (const e of this.edges) add(e.key_id, e.target_id);
    for (const e of this.obsEdges) add(e.key_id, e.target_id);
    for (const l of this.agentLinks) {
      if (l.from === f.id) set.add(l.to);
      if (l.to === f.id) set.add(l.from);
    }
    // A server that fronts an agent traces to that agent too.
    if (f.agentOf) {
      const own = this.agentStation(f.agentOf);
      if (own) set.add(own);
    }
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
    if (f.kind === 'agent') {
      for (const l of this.agentLinks) {
        const other = l.from === f.id ? l.to : l.to === f.id ? l.from : null;
        if (!other) continue;
        const o = this.stations.get(other);
        if (!o) continue;
        byId.set(`agent:${other}:${l.from === f.id ? 'out' : 'in'}`, {
          id: o.id, label: o.label, kind: o.kind, color: o.color, requests: l.requests, cost: 0, denied: 0, errors: 0, live: now - l.lastTs < WINDOW_MS, tools: [], relation: l.from === f.id ? 'calls' : 'called by',
        });
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
    return { id: s.id, kind: s.kind, label: s.label, sub: s.sub, color: s.color, rpm: s.recent.length, held: s.held, state: this.stateOf(s, now), requests24h, cost24h, errors24h, denied24h, observed24h, obs: s.obs, protocol: s.protocol, grouping: s.team ? 'team' : s.copies ? 'group' : undefined };
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
      prune(s.errors, cutoff);
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

    // Connections as flows: state by colour, volume by thickness — calls in the last minute on a
    // live line, the last day's calls (thinner, grey) on an idle one — relative to the busiest line
    // on the map. Nothing moves. Thin and idle lines first, so heavy and live ones sit on top.
    const order: LinkState[] = ['unused', 'idle', 'active', 'blocked', 'holding'];
    const spokes = [...this.spokes.values()].map((sp) => ({ sp, st: this.stateOf(sp.station, now) }));
    let maxRpm = 1;
    let maxDay = 1;
    for (const { sp } of spokes) {
      maxRpm = Math.max(maxRpm, sp.station.recent.length);
      maxDay = Math.max(maxDay, this.day.get(sp.station.id) ?? 0);
    }
    const flowWidth = (sp: Spoke, st: LinkState) =>
      st === 'unused' ? 1 : st === 'idle' ? 1 + 2 * Math.sqrt((this.day.get(sp.station.id) ?? 0) / maxDay) : 1.5 + 8.5 * Math.sqrt(sp.station.recent.length / maxRpm);
    spokes.sort((a, b) => order.indexOf(a.st) - order.indexOf(b.st) || a.sp.station.recent.length - b.sp.station.recent.length);
    for (const { sp, st } of spokes) {
      const s = sp.station;
      const { p0, p1, p2, p3 } = sp.bez;
      ctx.beginPath();
      ctx.moveTo(p0[0], p0[1]);
      ctx.bezierCurveTo(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]);
      let color = LINE_IDLE;
      let width = flowWidth(sp, st);
      let dash: number[] = [];
      switch (st) {
        case 'unused':
          color = LINE_UNUSED;
          dash = [3, 5];
          break;
        case 'idle':
          break;
        case 'active':
          color = rgba(s.color, 0.62);
          break;
        case 'blocked':
          color = rgba(STATUS_COLORS.denied, 0.72);
          break;
        case 'holding':
          color = rgba(STATUS_COLORS.held, 0.78);
          break;
      }
      if (this.hovered === `spoke:${s.id}`) {
        width += 1.5;
        if (st === 'active') color = rgba(s.color, 0.9);
        dash = [];
        if (st === 'idle' || st === 'unused') color = '#8ea1bb';
      }
      let alpha = dim(s.id);
      if (this.layer === 'outside') alpha *= 0.15;
      else if (this.layer === 'active' && (st === 'idle' || st === 'unused')) alpha *= 0.1;
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

    // The "outside the gateway" region.
    if (this.obsBand) {
      const b = this.obsBand;
      roundRect(ctx, b.x, b.y, b.w, b.h, 14);
      ctx.fillStyle = 'rgba(100,116,139,0.04)';
      ctx.fill();
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = 'rgba(100,116,139,0.45)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = `600 10.5px ${FONT}`;
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(246,248,251,0.95)';
      ctx.lineWidth = 5;
      ctx.strokeText('OUTSIDE THE GATEWAY · SEEN, NOT ENFORCED', b.x + 14, b.y + 14);
      ctx.fillStyle = '#64748b';
      ctx.fillText('OUTSIDE THE GATEWAY · SEEN, NOT ENFORCED', b.x + 14, b.y + 14);
    }

    // Observed traffic: dashed, straight from agent to system, never through the tower.
    const maxObs = Math.max(1, ...this.obsLines.map((l) => l.edge.count_24h));
    for (const l of this.obsLines) {
      const live = now - l.edge.last_seen < WINDOW_MS;
      if (this.layer === 'gateway' || (this.layer === 'active' && !live)) continue;
      const bypass = !!l.target.obs?.bypass;
      const base = bypass ? STATUS_COLORS.denied : 0x64748b;
      const hot = this.hovered === `obs:${l.agent.id}>${l.target.id}`;
      const focused = rel && rel.has(l.agent.id) && rel.has(l.target.id);
      this.roundedPath(l.pts);
      ctx.strokeStyle = rgba(base, hot || focused ? 0.95 : live ? 0.75 : bypass ? 0.6 : 0.42);
      // Thicker with more calls over the last day (up to 3 px): observed volume is reported, not measured per minute.
      const obsW = 1.2 + 1.8 * Math.sqrt(l.edge.count_24h / maxObs);
      ctx.lineWidth = hot || focused ? obsW + 1 : obsW;
      ctx.setLineDash([5, 4]);
      ctx.globalAlpha = Math.min(dim(l.agent.id), dim(l.target.id)) * (this.sim ? 0.25 : 1);
      ctx.stroke();
      ctx.setLineDash([]);
      // The agent's "direct" port: a small hollow dot under its gateway port.
      const [px, py] = l.pts[0]!;
      ctx.beginPath();
      ctx.arc(px, py, 3, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = rgba(base, 0.8);
      ctx.lineWidth = 1.2;
      ctx.stroke();
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

    this.drawAgentLinks(now, rel);
    for (const s of this.stations.values()) {
      ctx.globalAlpha = dim(s.id);
      this.drawCard(s, now, rel);
      ctx.globalAlpha = 1;
    }
    for (const th of this.teamHeads) this.drawTeamHead(th);

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
    // A white halo keeps the labels legible where lines pass underneath.
    const halo = (text: string, x: number, y: number) => {
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(246,248,251,0.95)';
      ctx.lineWidth = 5;
      ctx.strokeText(text, x, y);
      ctx.fillText(text, x, y);
    };
    ctx.font = `700 10px ${FONT}`;
    ctx.fillStyle = '#334155';
    halo('CONTROL TOWER', hx, hy + this.holdR + 22);
    ctx.font = `500 11px ${FONT}`;
    ctx.fillStyle = INK_FAINT;
    halo(`${active} active link${active === 1 ? '' : 's'} · ${rpm}/min${held ? ` · ${held} holding` : ''}`, hx, hy + this.holdR + 37);
    ctx.textAlign = 'left';
  }

  /**
   * Agents calling agents: an arc beside the agent column from caller to callee, arrow at the callee,
   * thicker with more calls; bright while live. The call itself still goes through the tower (the
   * callee's server on the right); the arc says who is acting for whom.
   */
  private drawAgentLinks(now: number, rel: Set<string> | null): void {
    if (!this.agentLinks.length) return;
    const ctx = this.ctx;
    const max = Math.max(1, ...this.agentLinks.map((l) => l.requests));
    const tone = 0x7c3aed;
    for (const l of this.agentLinks) {
      const a = this.stations.get(l.from);
      const b = this.stations.get(l.to);
      if (!a || !b) continue;
      const live = now - l.lastTs < WINDOW_MS;
      const ay = a.y + a.headH / 2;
      const by = b.y + b.headH / 2;
      const cx = Math.min(a.x, b.x) - 24 - Math.min(110, Math.abs(by - ay) * 0.22);
      const w = 1.4 + 2.6 * Math.sqrt(l.requests / max);
      const lit = !rel || (rel.has(a.id) && rel.has(b.id));
      ctx.globalAlpha = lit ? 1 : 0.18;
      ctx.beginPath();
      ctx.moveTo(a.x, ay);
      ctx.quadraticCurveTo(cx, (ay + by) / 2, b.x - 6, by);
      ctx.strokeStyle = rgba(tone, live ? 0.85 : 0.4);
      ctx.lineWidth = w;
      ctx.stroke();
      // Arrowhead into the callee's card.
      ctx.beginPath();
      ctx.moveTo(b.x - 1, by);
      ctx.lineTo(b.x - 9, by - 4.5);
      ctx.lineTo(b.x - 9, by + 4.5);
      ctx.closePath();
      ctx.fillStyle = rgba(tone, live ? 0.9 : 0.5);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  /** "▾ SUPPORT · 12 agents" over an opened team; click to close it. */
  private drawTeamHead(th: (typeof this.teamHeads)[number]): void {
    const ctx = this.ctx;
    const hot = this.hovered === `teamhead:${th.team}`;
    const c = agentColor(teamStation(th.team));
    ctx.beginPath();
    ctx.moveTo(th.x + 2, th.y + th.h - 1);
    ctx.lineTo(th.x + th.w - 2, th.y + th.h - 1);
    ctx.strokeStyle = rgba(c, 0.35);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.font = `700 10.5px ${FONT}`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = hot ? hex(c) : '#334155';
    const my = th.y + th.h / 2;
    // Down-pointing chevron: this team is open.
    ctx.beginPath();
    ctx.moveTo(th.x + 3, my - 2);
    ctx.lineTo(th.x + 6.5, my + 1.5);
    ctx.lineTo(th.x + 10, my - 2);
    ctx.strokeStyle = ctx.fillStyle;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    const name = th.team.toUpperCase();
    ctx.fillText(name, th.x + 16, my);
    const nw = ctx.measureText(name).width;
    ctx.font = `500 10.5px ${FONT}`;
    ctx.fillStyle = INK_FAINT;
    ctx.fillText(` · ${th.agents} agent${th.agents === 1 ? '' : 's'}${hot ? ' · close' : ''}`, th.x + 16 + nw, my);
    ctx.textBaseline = 'alphabetic';
  }

  private drawCard(s: Station, now: number, rel: Set<string> | null): void {
    const ctx = this.ctx;
    const hot = this.hovered === `station:${s.id}` || this.focusId === s.id;
    const st = this.stateOf(s, now);
    // An agent group is a small stack of cards: one agent, several copies.
    const many = s.team ? s.team.agents : (s.copies ?? 0);
    if (many > 1 && s.headH >= 40) {
      for (const d of many > 2 ? [6, 3] : [3]) {
        roundRect(ctx, s.x + d, s.y - d, s.w, s.h, 10);
        ctx.fillStyle = '#f8fafc';
        ctx.fill();
        ctx.strokeStyle = '#e1e7ef';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
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
    const chevronW = (s.kind === 'mcp' && s.tools.length) || s.team ? 22 : 0;
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
    // A group's copy count rides on the title line, so it survives compact cards.
    // The name comes first: the count badge shortens ("12 agents" → "12"), then goes, before the name is cut.
    const titleFont = `600 ${compact ? 11.5 : 12.5}px ${FONT}`;
    const room = right - tx - statusW;
    ctx.font = titleFont;
    const nameW = ctx.measureText(s.label).width;
    ctx.font = `600 10.5px ${FONT}`;
    const n = s.team?.agents ?? s.copies;
    let copies = '';
    const short = s.team ? (n ?? 0).toLocaleString() : `×${(n ?? 0).toLocaleString()}`;
    const long = s.team ? `${short} agent${n === 1 ? '' : 's'}` : s.copiesOf ? `${short} of ${s.copiesOf.toLocaleString()}` : short;
    // "×1" alone would misstate an agent with more copies elsewhere: it gets the long form or nothing.
    for (const c of n ? (s.copiesOf ? [long] : [long, short]) : []) {
      if (nameW + ctx.measureText(c).width + 12 <= room) {
        copies = c;
        break;
      }
    }
    // A name too long to fit is cut either way; keep the short count so the card still reads as a team or group.
    if (!copies && n && !s.copiesOf && room - nameW < 0 && room > 90) copies = short;
    const copiesW = copies ? ctx.measureText(copies).width + 12 : 0;
    ctx.font = titleFont;
    const title = fitText(ctx, s.label, room - copiesW);
    ctx.fillText(title, tx, titleY);
    if (copies) {
      const cx = tx + ctx.measureText(title).width + 5;
      ctx.font = `600 10.5px ${FONT}`;
      roundRect(ctx, cx, titleY - 11, copiesW - 4, 15, 7.5);
      ctx.fillStyle = rgba(s.color, 0.12);
      ctx.fill();
      ctx.fillStyle = hex(s.color);
      ctx.fillText(copies, cx + 4, titleY);
    }
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
      if (s.expanded && !s.team) {
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

    // Port (observed systems have none: their lines enter from the side).
    if (s.kind === 'observed') return;
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
        if (s.protocol === 'http') {
          // A globe: a plain web API.
          ctx.beginPath();
          ctx.arc(cx, cy, 7, 0, Math.PI * 2);
          ctx.stroke();
          ctx.beginPath();
          ctx.ellipse(cx, cy, 3, 7, 0, 0, Math.PI * 2);
          ctx.moveTo(cx - 7, cy);
          ctx.lineTo(cx + 7, cy);
          ctx.stroke();
          break;
        }
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
      if (x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) {
        const { k, x: cx, y: cy } = this.cam;
        const rect: [number, number, number, number] = [s.x * k + cx, s.y * k + cy, (s.x + s.w) * k + cx, (s.y + s.h) * k + cy];
        return { kind: 'station', station: this.view(s, now), x: sx, y: sy, rect };
      }
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
    for (const th of this.teamHeads) {
      if (x >= th.x && x <= th.x + th.w && y >= th.y && y <= th.y + th.h) {
        this.setHovered(`teamhead:${th.team}`);
        this.canvas.style.cursor = 'pointer';
        this.hoverCb?.(null);
        return;
      }
    }
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
      if (this.layer === 'gateway') break;
      let near = false;
      for (let i = 1; i < l.pts.length && !near; i++) near = segDist2([x, y], l.pts[i - 1]!, l.pts[i]!) < 25;
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
