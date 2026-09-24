/**
 * Light, enterprise palette for the Airspace canvas. Agent hues are a
 * restrained blue/teal/indigo family so the map reads as one system; status
 * colours are the only saturated non-blue accents.
 */

const AGENT_PALETTE = [0x1f5eff, 0x0b3d91, 0x0e9aa7, 0x5b6cff, 0x2a9d8f, 0x3b82f6, 0x6366f1, 0x0891b2, 0x1d4ed8, 0x0d9488];

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function agentColor(id: string): number {
  return AGENT_PALETTE[hashString(id) % AGENT_PALETTE.length]!;
}

export const PROVIDER_COLORS: Record<string, number> = {
  openai: 0x0f766e,
  'azure-openai': 0x0369a1,
  'openai-compatible': 0x475569,
  anthropic: 0xb45309,
  gemini: 0x2563eb,
  vertex: 0x2563eb,
  bedrock: 0xc2410c,
  mock: 0x6d28d9,
};

/** Demo providers run on the mock adapter but stand in for a real vendor, named by their slug. */
export function providerLook(p: { kind: string; slug?: string } | undefined): string {
  if (!p) return '';
  return p.kind === 'mock' && p.slug ? p.slug.replace(/-demo$/, '') : p.kind;
}

export const MCP_COLOR = 0x0e7490;

export const STATUS_COLORS = {
  ok: 0x1a9e6b,
  error: 0xd3374e,
  denied: 0xd3374e,
  held: 0xd9860b,
  ticketed: 0xd9860b,
  info: 0x1f5eff,
} as const;

export function hex(n: number): string {
  return '#' + n.toString(16).padStart(6, '0');
}
