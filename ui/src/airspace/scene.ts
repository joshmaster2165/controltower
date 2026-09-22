import { Application, Container, Graphics, Sprite, Text, TextStyle, Texture } from 'pixi.js';
import type { FlightEvent } from '@controltower/shared';
import type { PolicyBundle, Rule, Topology, Zone } from '../api';
import { agentColor, CANVAS, MCP_COLOR, PROVIDER_COLORS, STATUS_COLORS } from './colors';

/**
 * The Airspace. Stations (agents on the left, model deployments on the right)
 * connected by lanes; every request is a Flight particle that travels along
 * its lane and comes back as a response particle sized by output tokens.
 * Zones are translucent regions around their stations; gates are markers on
 * lanes that cross a zone boundary with a rule on it. Denied flights shatter
 * at the gate; held flights orbit it until a human decides.
 */
export interface Station {
  id: string;
  kind: 'agent' | 'model' | 'mcp' | 'unknown';
  label: string;
  sub: string;
  color: number;
  x: number;
  y: number;
  r: number;
  heat: number;
  requests: number;
  denied: number;
  errors: number;
  cost: number;
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

interface Particle {
  sprite: Sprite;
  from: Station;
  to: Station;
  lane: Lane;
  t: number;
  duration: number;
  phase: 'out' | 'hover' | 'back' | 'shatter' | 'hold';
  color: number;
  size: number;
  flightId: string;
  born: number;
  hoverAngle: number;
  shards?: Sprite[];
  shardVel?: Array<[number, number]>;
  life?: number;
}

export interface SceneStats {
  particles: number;
  stations: number;
}

export interface HoverInfo {
  x: number;
  y: number;
  station?: Station;
  lane?: Lane & { fromLabel: string; toLabel: string };
  zone?: Zone;
  gate?: { rule: Rule; lane: Lane };
}

export type ClickInfo =
  | { kind: 'station'; station: Station; x: number; y: number }
  | { kind: 'zone'; zone: Zone; x: number; y: number }
  | { kind: 'gate'; rule: Rule; lane: Lane; x: number; y: number }
  | { kind: 'lasso'; stationIds: string[]; x: number; y: number }
  | { kind: 'empty'; x: number; y: number };

const OUT_MS = 900;
const BACK_MS = 800;
const HOVER_MAX_MS = 45_000;
const STALE_MS = 8_000;

function hexToNum(h: string): number {
  return Number.parseInt(h.replace('#', ''), 16) || 0x64d2ff;
}

function pointInPoly(x: number, y: number, poly: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export class AirspaceScene {
  app = new Application();
  private stations = new Map<string, Station>();
  private lanes = new Map<string, Lane>();
  private particles: Particle[] = [];
  private byFlight = new Map<string, Particle>();
  private zoneGfx = new Graphics();
  private zoneLabels = new Container();
  private laneGfx = new Graphics();
  private gateGfx = new Graphics();
  private lassoGfx = new Graphics();
  private stationLayer = new Container();
  private stationGfx = new Map<string, { glow: Sprite; body: Graphics; label: Text }>();
  private particleLayer = new Container();
  private glowTex!: Texture;
  private dotTex!: Texture;
  private topology: Topology | null = null;
  private policy: PolicyBundle | null = null;
  private zoneBoxes = new Map<string, { x: number; y: number; w: number; h: number }>();
  private w = 0;
  private h = 0;
  private ready = false;
  private lastLaneDraw = 0;
  private hoverCb: ((h: HoverInfo | null) => void) | null = null;
  private clickCb: ((c: ClickInfo) => void) | null = null;
  private pointer = { x: -1, y: -1 };
  private unknownStation: Station | null = null;
  private lasso: Array<[number, number]> | null = null;
  private rightInset = 0;
  drawMode = false;

  /** Reserve horizontal space on the right (e.g. for the Tower drawer). */
  setRightInset(px: number): void {
    if (this.rightInset === px) return;
    this.rightInset = px;
    this.layout();
  }

  async init(host: HTMLElement): Promise<void> {
    await this.app.init({
      background: CANVAS.bg,
      resizeTo: host,
      antialias: true,
      resolution: Math.min(2, window.devicePixelRatio || 1),
      autoDensity: true,
      preference: 'webgl',
    });
    host.appendChild(this.app.canvas);
    this.app.stage.addChild(this.zoneGfx, this.zoneLabels, this.laneGfx, this.gateGfx, this.stationLayer, this.particleLayer, this.lassoGfx);

    const g = new Graphics();
    for (let i = 8; i > 0; i--) g.circle(16, 16, i * 2).fill({ color: 0xffffff, alpha: 0.06 + (8 - i) * 0.02 });
    g.circle(16, 16, 3).fill({ color: 0xffffff, alpha: 1 });
    this.glowTex = this.app.renderer.generateTexture(g);
    const d = new Graphics();
    d.circle(4, 4, 3).fill({ color: 0xffffff });
    this.dotTex = this.app.renderer.generateTexture(d);

    this.w = this.app.screen.width;
    this.h = this.app.screen.height;
    this.app.renderer.on('resize', () => {
      this.w = this.app.screen.width;
      this.h = this.app.screen.height;
      this.layout();
    });
    const canvas = this.app.canvas;
    const pos = (ev: PointerEvent): [number, number] => {
      const rect = canvas.getBoundingClientRect();
      return [ev.clientX - rect.left, ev.clientY - rect.top];
    };
    canvas.addEventListener('pointermove', (ev) => {
      const [x, y] = pos(ev);
      this.pointer = { x, y };
      if (this.lasso) {
        this.lasso.push([x, y]);
        this.drawLasso();
      }
    });
    canvas.addEventListener('pointerleave', () => {
      this.pointer = { x: -1, y: -1 };
    });
    canvas.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      const [x, y] = pos(ev);
      if (this.drawMode) {
        this.lasso = [[x, y]];
        canvas.setPointerCapture(ev.pointerId);
      }
    });
    canvas.addEventListener('pointerup', (ev) => {
      const [x, y] = pos(ev);
      if (this.lasso) {
        const poly = this.lasso;
        this.lasso = null;
        this.lassoGfx.clear();
        if (poly.length > 2) {
          // A straight drag has no area: treat it as a marquee rectangle instead of a lasso.
          let area = 0;
          for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) area += (poly[j]![0] + poly[i]![0]) * (poly[j]![1] - poly[i]![1]);
          let inside: (s: Station) => boolean;
          if (Math.abs(area / 2) < 600) {
            const [x0, y0] = poly[0]!;
            const [x1, y1] = poly[poly.length - 1]!;
            const [minX, maxX] = [Math.min(x0, x1), Math.max(x0, x1)];
            const [minY, maxY] = [Math.min(y0, y1), Math.max(y0, y1)];
            inside = (s) => s.x >= minX && s.x <= maxX && s.y >= minY && s.y <= maxY;
          } else {
            inside = (s) => pointInPoly(s.x, s.y, poly);
          }
          const ids = [...this.stations.values()].filter((s) => s.kind !== 'unknown' && inside(s)).map((s) => s.id);
          this.clickCb?.({ kind: 'lasso', stationIds: ids, x, y });
          return;
        }
      }
      this.clickCb?.(this.hitTest(x, y));
    });

    this.app.ticker.add((t) => this.tick(t.deltaMS));
    this.ready = true;
    this.layout();
  }

  onHover(cb: (h: HoverInfo | null) => void): void {
    this.hoverCb = cb;
  }
  onClick(cb: (c: ClickInfo) => void): void {
    this.clickCb = cb;
  }

  destroy(): void {
    this.app.destroy(true, { children: true, texture: true });
  }

  stats(): SceneStats {
    return { particles: this.particles.length, stations: this.stations.size };
  }

  debug(): Record<string, number> {
    const out: Record<string, number> = { tracked: this.byFlight.size };
    for (const p of this.particles) out[p.phase] = (out[p.phase] ?? 0) + 1;
    return out;
  }

  stationList(): Station[] {
    return [...this.stations.values()];
  }

  // ---- topology & policy ----

  setTopology(t: Topology): void {
    this.topology = t;
    const keep = new Set<string>();
    for (const k of t.keys) {
      keep.add(k.id);
      const label = k.name;
      const sub = [k.team, k.project].filter(Boolean).join(' / ');
      const st = this.stations.get(k.id);
      if (st) {
        st.label = label;
        st.sub = sub;
      } else {
        this.stations.set(k.id, { id: k.id, kind: 'agent', label, sub, color: agentColor(k.agent_id ?? k.id), x: 0, y: 0, r: 14, heat: 0, requests: 0, denied: 0, errors: 0, cost: 0 });
      }
    }
    const provById = new Map(t.providers.map((p) => [p.id, p]));
    for (const d of t.deployments) {
      keep.add(d.id);
      const prov = provById.get(d.provider_id);
      const label = d.public_name ?? d.upstream_model;
      const sub = prov?.name ?? prov?.kind ?? '';
      const color = PROVIDER_COLORS[prov?.kind ?? ''] ?? 0x475569;
      const st = this.stations.get(d.id);
      if (st) {
        st.label = label;
        st.sub = sub;
        st.color = color;
      } else {
        this.stations.set(d.id, { id: d.id, kind: 'model', label, sub, color, x: 0, y: 0, r: 16, heat: 0, requests: 0, denied: 0, errors: 0, cost: 0 });
      }
    }
    for (const m of t.mcp_servers ?? []) {
      keep.add(m.id);
      const sub = `MCP · ${m.tools.length} tool${m.tools.length === 1 ? '' : 's'}`;
      const st = this.stations.get(m.id);
      if (st) {
        st.label = m.name;
        st.sub = sub;
      } else {
        this.stations.set(m.id, { id: m.id, kind: 'mcp', label: m.name, sub, color: MCP_COLOR, x: 0, y: 0, r: 16, heat: 0, requests: 0, denied: 0, errors: 0, cost: 0 });
      }
    }
    for (const id of [...this.stations.keys()]) if (!keep.has(id) && id !== '__unknown') this.stations.delete(id);
    for (const l of t.lanes) {
      if (!l.key_id || !l.deployment_id) continue;
      if (!this.stations.has(l.key_id) || !this.stations.has(l.deployment_id)) continue;
      const lane = this.lane(l.key_id, l.deployment_id);
      lane.requests = l.requests;
      lane.cost = l.cost_nanousd;
      lane.errors = l.errors;
      lane.denied = l.denied;
      lane.avgMs = l.avg_ms;
    }
    this.layout();
  }

  setPolicy(p: PolicyBundle): void {
    this.policy = p;
    // Make sure every rule between two zones has visible lanes even before traffic.
    for (const r of p.rules) {
      if (!r.enabled || !r.from_zone || !r.to_zone) continue;
      const from = p.zones.find((z) => z.id === r.from_zone);
      const to = p.zones.find((z) => z.id === r.to_zone);
      if (!from || !to) continue;
      for (const a of this.zoneStations(from)) for (const b of this.zoneStations(to)) if (a.kind === 'agent' && b.kind !== 'agent') this.lane(a.id, b.id);
    }
    this.layout();
  }

  private stationKey(s: Station): string {
    return s.kind === 'agent' ? `key:${s.id}` : s.kind === 'mcp' ? `mcp:${s.id}` : `deployment:${s.id}`;
  }

  private zoneStations(z: Zone): Station[] {
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
      const k = t?.keys.find((x) => x.id === s.id);
      const m = z.match as { teams?: string[]; projects?: string[]; tags?: string[] };
      if (k && ((m.teams?.length && k.team && m.teams.includes(k.team)) || (m.projects?.length && k.project && m.projects.includes(k.project)) || (m.tags?.length && k.tags.some((tg) => m.tags!.includes(tg))))) out.push(s);
    }
    return out;
  }

  private zonesOf(s: Station): Zone[] {
    if (!this.policy) return [];
    return this.policy.zones.filter((z) => this.zoneStations(z).some((x) => x.id === s.id));
  }

  /** First enabled rule whose boundary this lane crosses, by priority. */
  private gateFor(from: Station, to: Station): Rule | null {
    if (!this.policy) return null;
    const src = new Set(this.zonesOf(from).map((z) => z.id));
    const dst = new Set(this.zonesOf(to).map((z) => z.id));
    for (const r of this.policy.rules) {
      if (!r.enabled) continue;
      if (r.from_zone && !src.has(r.from_zone)) continue;
      if (r.to_zone && !dst.has(r.to_zone)) continue;
      if (!r.from_zone && !r.to_zone) continue;
      return r;
    }
    return null;
  }

  private lane(from: string, to: string): Lane {
    const k = `${from}>${to}`;
    let l = this.lanes.get(k);
    if (!l) {
      l = { from, to, activity: 0, requests: 0, cost: 0, errors: 0, denied: 0, avgMs: null, cx: 0, cy: 0, gate: null };
      this.lanes.set(k, l);
    }
    return l;
  }

  private ensureUnknown(): Station {
    if (!this.unknownStation) {
      this.unknownStation = { id: '__unknown', kind: 'unknown', label: 'unrouted', sub: 'no matching model', color: 0x8a98ad, x: 0, y: 0, r: 12, heat: 0, requests: 0, denied: 0, errors: 0, cost: 0 };
      this.stations.set('__unknown', this.unknownStation);
      this.layout();
    }
    return this.unknownStation;
  }

  // ---- layout ----

  private layout(): void {
    if (!this.ready) return;
    const agents = [...this.stations.values()].filter((s) => s.kind === 'agent');
    const models = [...this.stations.values()].filter((s) => s.kind !== 'agent');
    // Group by zone so zone boxes are contiguous: stations in the same zone sit together.
    const zoneRank = (s: Station) => {
      const zs = this.zonesOf(s);
      return zs.length ? this.policy!.zones.findIndex((z) => z.id === zs[0]!.id) : 999;
    };
    const sorter = (a: Station, b: Station) => zoneRank(a) - zoneRank(b) || a.label.localeCompare(b.label);
    agents.sort(sorter);
    models.sort(sorter);

    const padTop = 120;
    const padBottom = 90;
    const usableW = this.w - this.rightInset;
    const leftX = Math.max(150, usableW * 0.2);
    const rightX = Math.min(usableW - 150, usableW * 0.74);
    // Stations in different zones get a gap between them so zone boxes never overlap.
    const place = (list: Station[], x: number) => {
      const n = list.length;
      const span = Math.max(0, this.h - padTop - padBottom);
      if (n === 1) {
        list[0]!.x = x;
        list[0]!.y = padTop + span / 2;
        return;
      }
      const breaks: number[] = [];
      for (let i = 1; i < n; i++) if (zoneRank(list[i]!) !== zoneRank(list[i - 1]!)) breaks.push(i);
      const GAP = 0.7; // extra slots per zone boundary
      const slots = n - 1 + breaks.length * GAP;
      const step = span / Math.max(1, slots);
      let y = padTop;
      list.forEach((s, i) => {
        if (i > 0) y += step * (breaks.includes(i) ? 1 + GAP : 1);
        s.x = x;
        s.y = y;
      });
    };
    place(agents, leftX);
    place(models, rightX);
    for (const l of this.lanes.values()) this.computeControl(l);
    this.rebuildStations();
    this.drawZones();
    this.drawLanes(true);
    this.drawGates();
  }

  private computeControl(l: Lane): void {
    const a = this.stations.get(l.from);
    const b = this.stations.get(l.to);
    if (!a || !b) return;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const dy = b.y - a.y;
    l.cx = mx;
    l.cy = my - dy * 0.25;
    l.gate = null;
    const rule = this.gateFor(a, b);
    if (rule) {
      const [gx, gy] = this.pointOnLane(l, 0.5);
      l.gate = { rule, x: gx, y: gy };
    }
  }

  private rebuildStations(): void {
    this.stationLayer.removeChildren();
    this.stationGfx.clear();
    const labelStyle = new TextStyle({ fill: CANVAS.label, fontSize: 12, fontFamily: 'Inter, system-ui, sans-serif', fontWeight: '500' });
    const subStyle = new TextStyle({ fill: CANVAS.sub, fontSize: 10.5, fontFamily: 'Inter, system-ui, sans-serif' });
    for (const s of this.stations.values()) {
      const glow = new Sprite(this.glowTex);
      glow.anchor.set(0.5);
      glow.tint = s.color;
      glow.alpha = 0.18;
      glow.scale.set(s.r / 8);
      glow.position.set(s.x, s.y);
      const body = new Graphics();
      this.drawStationBody(body, s);
      body.position.set(s.x, s.y);
      const label = new Text({ text: s.label, style: labelStyle });
      label.anchor.set(0.5, 0);
      label.position.set(s.x, s.y + s.r + 6);
      const sub = new Text({ text: s.sub, style: subStyle });
      sub.anchor.set(0.5, 0);
      sub.position.set(s.x, s.y + s.r + 22);
      this.stationLayer.addChild(glow, body, label, sub);
      this.stationGfx.set(s.id, { glow, body, label });
    }
  }

  private drawStationBody(g: Graphics, s: Station): void {
    g.clear();
    if (s.kind === 'agent') {
      g.circle(0, 0, s.r).fill({ color: CANVAS.stationFill }).stroke({ color: s.color, width: 2, alpha: 0.95 });
      g.circle(0, 0, s.r * 0.35).fill({ color: s.color, alpha: 0.9 });
    } else if (s.kind === 'mcp') {
      // Hexagon: a tool server.
      g.poly([0, -s.r, s.r * 0.87, -s.r * 0.5, s.r * 0.87, s.r * 0.5, 0, s.r, -s.r * 0.87, s.r * 0.5, -s.r * 0.87, -s.r * 0.5]).fill({ color: CANVAS.stationFill }).stroke({ color: s.color, width: 2, alpha: 0.95 });
      g.circle(0, 0, 3.5).fill({ color: s.color, alpha: 0.9 });
    } else if (s.kind === 'model') {
      g.roundRect(-s.r, -s.r * 0.75, s.r * 2, s.r * 1.5, 6).fill({ color: CANVAS.stationFill }).stroke({ color: s.color, width: 2, alpha: 0.95 });
      g.rect(-s.r * 0.5, -3, s.r, 6).fill({ color: s.color, alpha: 0.85 });
    } else {
      g.circle(0, 0, s.r).fill({ color: CANVAS.stationFill }).stroke({ color: s.color, width: 1.5, alpha: 0.8 });
    }
  }

  private drawZones(): void {
    const g = this.zoneGfx;
    g.clear();
    this.zoneLabels.removeChildren();
    this.zoneBoxes.clear();
    if (!this.policy) return;
    const style = new TextStyle({ fill: CANVAS.label, fontSize: 11.5, fontFamily: 'Inter, system-ui, sans-serif', fontWeight: '600', letterSpacing: 0.5 });
    for (const z of this.policy.zones) {
      const members = this.zoneStations(z);
      if (members.length === 0) continue;
      const color = hexToNum(z.color);
      // Zones may span both columns; draw one box per column so they hug their stations.
      const cols = [members.filter((m) => m.kind === 'agent'), members.filter((m) => m.kind !== 'agent')].filter((c) => c.length);
      cols.forEach((col, ci) => {
        const xs = col.map((s) => s.x);
        const ys = col.map((s) => s.y);
        const padX = 72;
        const x = Math.min(...xs) - padX;
        const y = Math.min(...ys) - 26;
        const w = Math.max(...xs) - Math.min(...xs) + padX * 2;
        const hh = Math.max(...ys) - Math.min(...ys) + 26 + 50;
        g.roundRect(x, y, w, hh, 16).fill({ color, alpha: 0.06 }).stroke({ color, width: 1.5, alpha: 0.55 });
        const t = new Text({ text: z.name.toUpperCase(), style });
        t.tint = color;
        t.position.set(x + 12, y - 16);
        this.zoneLabels.addChild(t);
        this.zoneBoxes.set(`${z.id}#${ci}`, { x, y: y - 18, w, h: hh + 18 });
      });
    }
  }

  private drawLanes(force = false): void {
    const now = performance.now();
    if (!force && now - this.lastLaneDraw < 120) return;
    this.lastLaneDraw = now;
    const g = this.laneGfx;
    g.clear();
    for (const l of this.lanes.values()) {
      const a = this.stations.get(l.from);
      const b = this.stations.get(l.to);
      if (!a || !b) continue;
      const base = 0.16 + Math.min(0.45, Math.log10(1 + l.requests) * 0.12);
      const alpha = Math.min(0.95, base + l.activity * 0.45);
      const width = 1 + Math.min(3, Math.log10(1 + l.cost / 1e6) * 0.9) + l.activity * 1.2;
      const effect = l.gate?.rule.effect;
      const color = effect === 'deny' ? STATUS_COLORS.denied : a.color;
      g.moveTo(a.x, a.y).quadraticCurveTo(l.cx, l.cy, b.x, b.y).stroke({ color, width, alpha: effect === 'deny' ? Math.max(alpha, 0.25) : alpha });
    }
  }

  private drawGates(): void {
    const g = this.gateGfx;
    g.clear();
    for (const l of this.lanes.values()) {
      if (!l.gate) continue;
      const { x, y, rule } = l.gate;
      switch (rule.effect) {
        case 'deny':
          g.circle(x, y, 9).fill({ color: CANVAS.stationFill }).stroke({ color: STATUS_COLORS.denied, width: 2 });
          g.rect(x - 5, y - 1.5, 10, 3).fill({ color: STATUS_COLORS.denied });
          break;
        case 'require_approval':
          g.circle(x, y, 9).fill({ color: CANVAS.stationFill }).stroke({ color: STATUS_COLORS.held, width: 2 });
          g.poly([x, y - 5, x + 5, y, x, y + 5, x - 5, y]).fill({ color: STATUS_COLORS.held });
          break;
        default:
          g.circle(x, y, 8).fill({ color: CANVAS.stationFill }).stroke({ color: STATUS_COLORS.ok, width: 2, alpha: 0.9 });
          g.circle(x, y, 2.5).fill({ color: STATUS_COLORS.ok });
      }
    }
  }

  private drawLasso(): void {
    const g = this.lassoGfx;
    g.clear();
    if (!this.lasso || this.lasso.length < 2) return;
    g.poly(this.lasso.flat(), true).fill({ color: 0x1f5eff, alpha: 0.08 }).stroke({ color: 0x1f5eff, width: 1.5, alpha: 0.9 });
  }

  private pointOnLane(l: Lane, t: number): [number, number] {
    const a = this.stations.get(l.from)!;
    const b = this.stations.get(l.to)!;
    const u = 1 - t;
    return [u * u * a.x + 2 * u * t * l.cx + t * t * b.x, u * u * a.y + 2 * u * t * l.cy + t * t * b.y];
  }

  // ---- events ----

  handle(e: FlightEvent): void {
    if (!this.ready) return;
    const stale = Date.now() - e.ts > STALE_MS;
    switch (e.t) {
      case 'flight.started': {
        if (stale) return;
        const from = this.stations.get(e.key_id);
        if (!from) return;
        const to = (e.deployment_id && this.stations.get(e.deployment_id)) || (e.mcp_server_id && this.stations.get(e.mcp_server_id)) || this.ensureUnknown();
        const lane = this.lane(from.id, to.id);
        if (lane.cx === 0 && lane.cy === 0) this.computeControl(lane);
        lane.activity = Math.min(1, lane.activity + 0.35);
        from.heat = Math.min(1, from.heat + 0.4);
        const size = 0.55 + Math.min(1.4, Math.log10(1 + e.est_input_tokens) * 0.35);
        this.spawn(e.flight_id, from, to, lane, from.color, size, 'out');
        break;
      }
      case 'flight.decision': {
        if (e.decision === 'deny') {
          const p = this.byFlight.get(e.flight_id);
          if (p) this.shatter(p, STATUS_COLORS.denied, true);
        }
        break;
      }
      case 'flight.held': {
        const p = this.byFlight.get(e.flight_id);
        if (p) {
          p.phase = 'hold';
          p.color = STATUS_COLORS.held;
          p.sprite.tint = p.color;
          p.lane.activity = Math.min(1, p.lane.activity + 0.3);
        }
        break;
      }
      case 'flight.resolved': {
        const p = this.byFlight.get(e.flight_id);
        if (!p) break;
        if (e.outcome === 'approved') {
          p.phase = 'out';
          p.t = 0.5;
          p.color = STATUS_COLORS.ok;
          p.sprite.tint = p.color;
          this.pulseLane(p.lane, 0.6);
        } else {
          this.shatter(p, e.outcome === 'denied' ? STATUS_COLORS.denied : STATUS_COLORS.held, true);
        }
        break;
      }
      case 'flight.upstream': {
        if (e.outcome === 'fallback') {
          const p = this.byFlight.get(e.flight_id);
          if (p) this.spark(p, STATUS_COLORS.held, 5);
        }
        break;
      }
      case 'flight.completed': {
        const p = this.byFlight.get(e.flight_id);
        if (!p) return;
        this.byFlight.delete(e.flight_id);
        const to = p.to;
        to.requests++;
        to.heat = Math.min(1, to.heat + 0.3);
        p.lane.requests++;
        if (e.cost_nanousd) {
          p.lane.cost += e.cost_nanousd;
          to.cost += e.cost_nanousd;
        }
        if (e.status === 'ok') {
          const out = e.usage?.output ?? 0;
          const size = 0.5 + Math.min(1.6, Math.log10(1 + out) * 0.45);
          this.remove(p);
          if (!stale) this.spawn(e.flight_id + ':r', to, p.from, p.lane, to.color, size, 'back');
          this.pulseStation(to, 0.6);
        } else if (e.status === 'error') {
          to.errors++;
          p.lane.errors++;
          this.shatter(p, STATUS_COLORS.denied);
        } else if (e.status === 'denied' || e.status === 'rejected' || e.status === 'ticketed') {
          p.lane.denied++;
          if (p.phase !== 'shatter') this.shatter(p, e.status === 'ticketed' ? STATUS_COLORS.held : STATUS_COLORS.denied, e.status !== 'rejected');
        } else {
          this.remove(p);
        }
        break;
      }
    }
  }

  private spawn(id: string, from: Station, to: Station, lane: Lane, color: number, size: number, phase: 'out' | 'back'): Particle {
    const sprite = new Sprite(this.glowTex);
    sprite.anchor.set(0.5);
    sprite.tint = color;
    sprite.scale.set(size * 0.55);
    sprite.alpha = 1;
    this.particleLayer.addChild(sprite);
    const p: Particle = { sprite, from, to, lane, t: 0, duration: phase === 'out' ? OUT_MS : BACK_MS, phase, color, size, flightId: id, born: performance.now(), hoverAngle: Math.random() * Math.PI * 2 };
    this.particles.push(p);
    if (phase === 'out') this.byFlight.set(id, p);
    return p;
  }

  private remove(p: Particle): void {
    p.sprite.destroy();
    if (p.shards) for (const s of p.shards) s.destroy();
    const i = this.particles.indexOf(p);
    if (i >= 0) this.particles.splice(i, 1);
  }

  /** Break the particle into shards; at the gate when the lane has one. */
  private shatter(p: Particle, color: number, atGate = false): void {
    if (p.phase === 'shatter') return;
    if (atGate && p.lane.gate) {
      p.phase = 'hold';
      p.hoverAngle = 0;
    }
    const [x, y] = atGate && p.lane.gate ? [p.lane.gate.x, p.lane.gate.y] : this.particlePos(p);
    p.phase = 'shatter';
    p.life = 700;
    p.sprite.visible = false;
    p.shards = [];
    p.shardVel = [];
    for (let i = 0; i < 9; i++) {
      const s = new Sprite(this.dotTex);
      s.anchor.set(0.5);
      s.tint = color;
      s.position.set(x, y);
      s.scale.set(0.6 + Math.random() * 0.5);
      this.particleLayer.addChild(s);
      const ang = Math.random() * Math.PI * 2;
      const sp = 40 + Math.random() * 120;
      p.shards.push(s);
      p.shardVel.push([Math.cos(ang) * sp, Math.sin(ang) * sp]);
    }
    if (!atGate) this.pulseStation(p.to, 0.3, color);
  }

  private spark(p: Particle, color: number, n: number): void {
    const [x, y] = this.particlePos(p);
    const ghost: Particle = { ...p, sprite: new Sprite(this.dotTex), phase: 'shatter', life: 400, shards: [], shardVel: [], flightId: p.flightId + ':spark' };
    ghost.sprite.visible = false;
    for (let i = 0; i < n; i++) {
      const s = new Sprite(this.dotTex);
      s.anchor.set(0.5);
      s.tint = color;
      s.position.set(x, y);
      s.scale.set(0.5);
      this.particleLayer.addChild(s);
      const ang = Math.random() * Math.PI * 2;
      const sp = 30 + Math.random() * 60;
      ghost.shards!.push(s);
      ghost.shardVel!.push([Math.cos(ang) * sp, Math.sin(ang) * sp]);
    }
    this.particles.push(ghost);
  }

  private pulseLane(lane: Lane, amount: number): void {
    lane.activity = Math.min(1, lane.activity + amount);
  }

  private pulseStation(s: Station, amount: number, color?: number): void {
    s.heat = Math.min(1, s.heat + amount);
    const g = this.stationGfx.get(s.id);
    if (g && color != null) {
      g.glow.tint = color;
      setTimeout(() => {
        g.glow.tint = s.color;
      }, 350);
    }
  }

  private particlePos(p: Particle): [number, number] {
    if (p.phase === 'hover' || p.phase === 'hold') {
      const gate = p.phase === 'hold' && p.lane.gate;
      const [bx, by] = gate ? [gate.x, gate.y] : this.pointOnLane(p.lane, p.phase === 'hold' ? 0.5 : 0.88);
      const r = p.phase === 'hold' ? 15 : 9;
      return [bx + Math.cos(p.hoverAngle) * r, by + Math.sin(p.hoverAngle) * r * 0.6];
    }
    const t = p.phase === 'back' ? 1 - p.t : p.t;
    return this.pointOnLane(p.lane, t);
  }

  // ---- frame ----

  private tick(dt: number): void {
    const decay = Math.exp(-dt / 900);
    for (const l of this.lanes.values()) l.activity *= decay;
    for (const s of this.stations.values()) {
      s.heat *= Math.exp(-dt / 1200);
      const g = this.stationGfx.get(s.id);
      if (g) g.glow.alpha = 0.18 + s.heat * 0.6;
    }
    const now = performance.now();
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]!;
      if (p.phase === 'shatter') {
        p.life = (p.life ?? 0) - dt;
        const k = Math.max(0, (p.life ?? 0) / 700);
        p.shards?.forEach((s, j) => {
          const v = p.shardVel![j]!;
          s.x += (v[0] * dt) / 1000;
          s.y += (v[1] * dt) / 1000;
          s.alpha = k;
        });
        if ((p.life ?? 0) <= 0) this.remove(p);
        continue;
      }
      if (p.phase === 'out' || p.phase === 'back') {
        p.t += dt / p.duration;
        if (p.t >= 1) {
          if (p.phase === 'out') {
            p.phase = 'hover';
            p.t = 1;
          } else {
            this.pulseStation(p.to, 0.2);
            this.remove(p);
            continue;
          }
        }
      }
      if (p.phase === 'hover' || p.phase === 'hold') {
        p.hoverAngle += (dt / 1000) * (p.phase === 'hold' ? 2.2 : 3.5);
        if (now - p.born > HOVER_MAX_MS) {
          this.byFlight.delete(p.flightId);
          this.remove(p);
          continue;
        }
      }
      const [x, y] = this.particlePos(p);
      p.sprite.position.set(x, y);
      const breathe = p.phase === 'hold' ? 1 + Math.sin(now / 160) * 0.25 : 1;
      p.sprite.scale.set(p.size * 0.55 * breathe);
    }
    this.drawLanes();
    this.hoverTest();
  }

  private hitTest(x: number, y: number): ClickInfo {
    for (const s of this.stations.values()) {
      const dx = s.x - x;
      const dy = s.y - y;
      if (dx * dx + dy * dy < (s.r + 8) * (s.r + 8)) return { kind: 'station', station: s, x, y };
    }
    for (const l of this.lanes.values()) {
      if (!l.gate) continue;
      const dx = l.gate.x - x;
      const dy = l.gate.y - y;
      if (dx * dx + dy * dy < 14 * 14) return { kind: 'gate', rule: l.gate.rule, lane: l, x, y };
    }
    if (this.policy) {
      for (const [k, b] of this.zoneBoxes) {
        const zid = k.split('#')[0]!;
        // Only the label strip counts as "clicking the zone" so stations stay clickable.
        if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + 22) {
          const zone = this.policy.zones.find((z) => z.id === zid);
          if (zone) return { kind: 'zone', zone, x, y };
        }
      }
    }
    return { kind: 'empty', x, y };
  }

  private hoverTest(): void {
    if (!this.hoverCb) return;
    const { x, y } = this.pointer;
    if (x < 0 || this.lasso) {
      this.hoverCb(null);
      return;
    }
    const hit = this.hitTest(x, y);
    if (hit.kind === 'station') {
      this.hoverCb({ x, y, station: hit.station });
      return;
    }
    if (hit.kind === 'gate') {
      this.hoverCb({ x, y, gate: { rule: hit.rule, lane: hit.lane } });
      return;
    }
    if (hit.kind === 'zone') {
      this.hoverCb({ x, y, zone: hit.zone });
      return;
    }
    let best: { l: Lane; d: number } | null = null;
    for (const l of this.lanes.values()) {
      if (!this.stations.has(l.from) || !this.stations.has(l.to)) continue;
      for (let t = 0.05; t < 0.96; t += 0.05) {
        const [px, py] = this.pointOnLane(l, t);
        const d = (px - x) * (px - x) + (py - y) * (py - y);
        if (d < 64 && (!best || d < best.d)) best = { l, d };
      }
    }
    if (best) {
      const a = this.stations.get(best.l.from)!;
      const b = this.stations.get(best.l.to)!;
      this.hoverCb({ x, y, lane: { ...best.l, fromLabel: a.label, toLabel: b.label } });
      return;
    }
    this.hoverCb(null);
  }
}
