import type { CSSProperties } from 'react';
import { useStore } from '../../store';
import type { LinkState } from '../../airspace/scene';
import type { AlertRule, Rule, Topology, Zone } from '../../api';


export const SWATCHES = ['#1f5eff', '#0b3d91', '#0e9aa7', '#6366f1', '#1a9e6b', '#d9860b', '#d3374e', '#7c3aed'];

/** Prefill for the gate composer: `from` is 'all' | 'zone:<id>' | 'key:<id>', `to` is '' | 'dep:<id>' | 'mcp:<id>'. */
export interface GateDraft {
  from: string;
  to: string;
  tool?: string | undefined;
}


export const STATE_LABEL: Record<LinkState, string> = {
  active: 'active',
  idle: 'idle (24h)',
  unused: 'no traffic',
  holding: 'holding for approval',
  blocked: 'blocked',
};

export const KIND_LABEL = { agent: 'agent', model: 'model', mcp: 'MCP server', observed: 'observed system', unknown: 'unrouted' } as const;
export const kindLabel = (s: { kind: keyof typeof KIND_LABEL; protocol?: 'mcp' | 'http' | undefined }) => (s.protocol === 'http' ? 'HTTP API' : KIND_LABEL[s.kind]);

export function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86_400 ? `${Math.floor(s / 3600)}h ago` : new Date(ts).toLocaleDateString();
}

/** Place a side panel near the click, fully on screen; it scrolls if taller than the room left. */
export function panelPos(x: number, y: number, h: number): CSSProperties {
  const room = window.innerHeight - 52;
  const top = Math.max(12, Math.min(y - 40, room - h));
  return { left: Math.max(12, Math.min(x, window.innerWidth - 740)), top, maxHeight: room - top - 12 };
}

/** Beside the clicked card (never on it), clear of the station inspector docked on the right. */
export function bringPos([l, t, r]: [number, number, number, number]): CSSProperties {
  const host = document.querySelector('.airspace');
  const w = host?.clientWidth ?? window.innerWidth;
  const h = host?.clientHeight ?? window.innerHeight;
  const width = 420;
  const right = w - 372;
  const left = r + 16 + width <= right ? r + 16 : l - 16 - width >= 12 ? l - 16 - width : Math.max(12, right - width);
  const top = Math.max(76, Math.min(t - 140, h - 600));
  return { left, top, maxHeight: h - top - 64 };
}

export function alertedGates(rules: AlertRule[]): string[] {
  return rules.filter((r) => r.enabled && r.rule_id).map((r) => r.rule_id!);
}

export function destRef(id: string): string {
  const t = useStore.getState().topology;
  return t?.mcp_servers.some((m) => m.id === id) ? `mcp:${id}` : `dep:${id}`;
}

/** Plain-language description of what a gate covers. */
export function describeRule(r: Rule, t: Topology | null, zones: Zone[]): string {
  const m = r.match as { keys?: string[]; groups?: string[]; deployments?: string[]; mcp_servers?: string[]; tools?: string[] };
  const keyName = (id: string) => t?.keys.find((k) => k.id === id)?.name ?? id;
  const depName = (id: string) => {
    const d = t?.deployments.find((x) => x.id === id);
    return d?.public_name ?? d?.upstream_model ?? id;
  };
  const mcpName = (id: string) => t?.mcp_servers.find((x) => x.id === id)?.name ?? id;
  const zoneName = (id: string) => zones.find((z) => z.id === id)?.name ?? id;
  const who = [...(m.keys ?? []).map(keyName), ...(m.groups ?? []).map((g) => `${g} (every copy)`)];
  const from = who.length ? who.join(', ') : r.from_zone ? `${zoneName(r.from_zone)} agents` : 'any agent';
  let to = 'anything';
  if (m.deployments?.length) to = m.deployments.map(depName).join(', ');
  else if (m.mcp_servers?.length) to = m.mcp_servers.map(mcpName).join(', ');
  else if (r.to_zone) to = zoneName(r.to_zone);
  if (m.tools?.length) to += ` → ${m.tools.map((x) => x.split('__').pop()).join(', ')}`;
  return `${from} → ${to}`;
}
