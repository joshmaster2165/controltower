import { agentColor, hex, PROVIDER_COLORS } from '../airspace/colors';

/** A neutral lettermark tile — recognisable without borrowing vendors' logos. */
export function Monogram({ name, kind, size = 32 }: { name: string; kind?: string; size?: number }) {
  const words = name.replace(/[()]/g, '').split(/[\s-]+/).filter(Boolean);
  const letters = (words.length > 1 ? words[0]![0]! + words[1]![0]! : name.slice(0, 2)).toUpperCase();
  const color = hex((kind && kind !== 'openai-compatible' ? PROVIDER_COLORS[kind] : undefined) ?? agentColor(name));
  return (
    <span className="monogram" style={{ width: size, height: size, fontSize: size * 0.36, color, background: `${color}14`, borderColor: `${color}33` }} aria-hidden="true">
      {letters}
    </span>
  );
}
