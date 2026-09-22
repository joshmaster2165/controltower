/** Stable, pleasant per-agent hues; providers get a fixed family colour. */

const AGENT_PALETTE = [0x64d2ff, 0x8b7bff, 0x3ddc97, 0xffb547, 0xff7ad9, 0x7cf2ff, 0xa5ff8b, 0xffa26b, 0xc9b6ff, 0x6bd6ff];

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
  openai: 0x74e3b2,
  'azure-openai': 0x5fb5ff,
  'openai-compatible': 0x9fb7ff,
  anthropic: 0xf2b97a,
  gemini: 0x8ea8ff,
  vertex: 0x8ea8ff,
  bedrock: 0xffb64d,
  mock: 0xb69dff,
};

export const STATUS_COLORS = {
  ok: 0x3ddc97,
  error: 0xff5c7a,
  denied: 0xff5c7a,
  held: 0xffb547,
  ticketed: 0xffb547,
  info: 0x64d2ff,
} as const;

export function hex(n: number): string {
  return '#' + n.toString(16).padStart(6, '0');
}
