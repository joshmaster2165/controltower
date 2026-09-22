/** 1 USD = 1e9 nanousd. Rates in pricing files are USD per million tokens. */
export const NANO_PER_USD = 1_000_000_000;

export function usdPerMillionToNanoPerToken(usdPerMillion: number): number {
  // usd/1e6 tokens → nanousd/token = usdPerMillion * 1e9 / 1e6 = usdPerMillion * 1e3
  return Math.round(usdPerMillion * 1000);
}

export function nanoToUsd(nano: number | null | undefined): number | null {
  if (nano == null) return null;
  return nano / NANO_PER_USD;
}

export function formatUsd(nano: number | null | undefined, opts: { compact?: boolean } = {}): string {
  const usd = nanoToUsd(nano);
  if (usd == null) return '—';
  if (opts.compact) {
    if (usd >= 1000) return `$${(usd / 1000).toFixed(1)}k`;
    if (usd >= 1) return `$${usd.toFixed(2)}`;
    if (usd >= 0.01) return `$${usd.toFixed(3)}`;
    return `$${usd.toFixed(5)}`;
  }
  return `$${usd.toFixed(usd >= 1 ? 2 : 5)}`;
}
