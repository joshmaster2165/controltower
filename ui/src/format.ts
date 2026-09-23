import { formatUsd } from '@controltower/shared';

/** Spend for tables: '—' for none, '<$0.001' for dust, compact otherwise. */
export function usd(nano: number | null | undefined): string {
  if (!nano) return '—';
  if (nano < 1_000_000) return '<$0.001';
  return formatUsd(nano, { compact: true });
}

export function num(n: number | null | undefined): string {
  return n == null ? '—' : n.toLocaleString('en-US');
}

/** "12s ago", "5m ago", "3h ago", then a date. */
export function ago(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  if (s < 7 * 86_400) return `${Math.round(s / 86_400)}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function ms(v: number | null | undefined): string {
  if (v == null) return '—';
  return v >= 10_000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`;
}

/** Model allow-lists read better in words than globs. */
export function globList(xs: string[]): string {
  if (!xs.length) return 'none';
  if (xs.length === 1 && xs[0] === '*') return 'all';
  return xs.join(', ');
}
