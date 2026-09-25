import { DETECTOR_BY_ID, INJECTION_DETECTORS, PII_DETECTORS, SECRET_DETECTORS, type Detector } from './detectors.js';
import type { ModelCheckConfig } from './model-check.js';

/**
 * Inspect gates: content scanning on the path an agent takes. A gate says
 * what to look for, in which direction (what the agent sends, what comes
 * back), and what to do on a match — mask it, block the request, or only
 * flag it for the map and alerts.
 *
 * Findings are reported as detector ids and counts. The matched text itself
 * is never stored, logged or put in an event.
 */

export type InspectAction = 'block' | 'mask' | 'flag';
export type InspectDirection = 'input' | 'output' | 'both';

export interface InspectConfig {
  /** Built-in detector ids, or the shorthands `secrets`, `pii`, `injection`. */
  detectors?: string[];
  keywords?: string[];
  patterns?: Array<{ name: string; regex: string }>;
  action?: InspectAction;
  direction?: InspectDirection;
  reason?: string;
  /** Also ask a model whether the content is a prompt injection (see model-check.ts). */
  model_check?: ModelCheckConfig;
}

export type Findings = Record<string, number>;

export interface CompiledInspector {
  detectors: Detector[];
  action: InspectAction;
  direction: InspectDirection;
}

/** Hard cap on text scanned per value, so one huge payload cannot stall the event loop. */
export const MAX_SCAN_CHARS = 2_000_000;

const SKIP_KEYS = new Set(['role', 'type', 'id', 'model', 'tool_call_id', 'tool_use_id', 'name', 'media_type', 'mime_type', 'mimeType', 'finish_reason', 'stop_reason', 'object', 'signature', 'index']);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function validatePattern(regex: string): string | null {
  if (regex.length > 500) return 'pattern is longer than 500 characters';
  try {
    new RegExp(regex, 'g');
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

export function compileInspector(cfg: InspectConfig): CompiledInspector {
  const ids = new Set<string>();
  for (const d of cfg.detectors ?? []) {
    if (d === 'secrets') SECRET_DETECTORS.forEach((x) => ids.add(x.id));
    else if (d === 'pii') PII_DETECTORS.forEach((x) => ids.add(x.id));
    else if (d === 'injection') INJECTION_DETECTORS.forEach((x) => ids.add(x.id));
    else if (DETECTOR_BY_ID.has(d)) ids.add(d);
  }
  const detectors: Detector[] = [...ids].map((id) => DETECTOR_BY_ID.get(id)!);
  const words = (cfg.keywords ?? []).map((k) => k.trim()).filter(Boolean);
  if (words.length) {
    detectors.push({ id: 'keyword', category: 'pii', label: 'Blocked keyword', re: new RegExp(`(?<![\\p{L}\\p{N}_])(?:${words.map(escapeRe).join('|')})(?![\\p{L}\\p{N}_])`, 'giu'), mask: '[REDACTED]' });
  }
  for (const p of cfg.patterns ?? []) {
    if (!p.regex || validatePattern(p.regex)) continue;
    const name = (p.name || 'custom').replace(/[^\w-]/g, '_').slice(0, 40);
    detectors.push({ id: `custom:${name}`, category: 'pii', label: p.name || 'Custom pattern', re: new RegExp(p.regex, 'g'), mask: `[REDACTED:${name.toUpperCase()}]` });
  }
  return { detectors, action: cfg.action ?? 'flag', direction: cfg.direction ?? 'both' };
}

/** Scan one string. When `mask` is set, return it with every finding replaced. */
export function scanText(text: string, detectors: Detector[], mask: boolean, findings: Findings): string {
  let out = text;
  for (const d of detectors) {
    d.re.lastIndex = 0;
    if (!d.re.test(out)) continue;
    d.re.lastIndex = 0;
    out = out.replace(d.re, (m: string, ...groups: unknown[]) => {
      const span = d.group ? (groups[d.group - 1] as string | undefined) : m;
      if (!span || (d.validate && !d.validate(span))) return m;
      findings[d.id] = (findings[d.id] ?? 0) + 1;
      if (!mask) return m;
      return d.group ? m.replace(span, d.mask) : d.mask;
    });
  }
  return out;
}

function looksBinary(s: string): boolean {
  return s.startsWith('data:') || (s.length > 2000 && /^[A-Za-z0-9+/=\s]+$/.test(s.slice(0, 2000)));
}

/**
 * Walk a JSON value, scanning every text leaf. Returns the (possibly masked)
 * value; the input is never mutated. `budget.left` bounds the characters scanned.
 */
export function scanValue(value: unknown, detectors: Detector[], mask: boolean, findings: Findings, budget: { left: number; truncated: boolean }, key?: string): unknown {
  if (typeof value === 'string') {
    if ((key && SKIP_KEYS.has(key)) || looksBinary(value)) return value;
    if (value.length > budget.left) {
      budget.truncated = true;
      return value;
    }
    budget.left -= value.length;
    return scanText(value, detectors, mask, findings);
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const r = scanValue(v, detectors, mask, findings, budget);
      if (r !== v) changed = true;
      return r;
    });
    return changed ? out : value;
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = scanValue(v, detectors, mask, findings, budget, k);
      if (r !== v) changed = true;
      out[k] = r;
    }
    return changed ? out : value;
  }
  return value;
}

const MODEL_LABELS: Record<string, string> = { injection_model: 'prompt injection (model check)', model_check_failed: 'no verdict from the check model' };

/** The text in a value, for a model to read: every string, skipping protocol fields; capped like scanning. */
export function textOfValue(value: unknown): string {
  const out: string[] = [];
  let left = MAX_SCAN_CHARS;
  const walk = (v: unknown, key?: string): void => {
    if (left <= 0 || (key && SKIP_KEYS.has(key))) return;
    if (typeof v === 'string') {
      out.push(v.slice(0, left));
      left -= v.length;
    } else if (Array.isArray(v)) v.forEach((x) => walk(x));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(value);
  return out.join('\n');
}

export function describeFindings(f: Findings): string {
  const parts = Object.entries(f)
    .sort((a, b) => b[1] - a[1])
    .map(([id, n]) => {
      const label = DETECTOR_BY_ID.get(id)?.label ?? MODEL_LABELS[id] ?? (id === 'keyword' ? 'blocked keyword' : id.startsWith('custom:') ? id.slice(7) : id);
      return n > 1 ? `${n} × ${label}` : label;
    });
  return parts.join(', ');
}

export interface GateOutcome<R> {
  ruleId: string;
  ruleName: string;
  action: InspectAction;
  findings: Findings;
  truncated: boolean;
  reason: string | undefined;
  rule: R;
}

/**
 * Run every applicable inspect gate over a value, in priority order. A block
 * stops the chain; masks compound (each gate sees the previous gate's output).
 */
export function runInspectors<R extends { id: string; name: string; config: InspectConfig }>(
  gates: Array<{ rule: R; compiled: CompiledInspector }>,
  direction: 'input' | 'output',
  value: unknown,
  /** On a reply that is already streaming, nothing can be masked or withheld: both degrade to flag. */
  opts: { streamed: boolean } = { streamed: false },
): { value: unknown; outcomes: Array<GateOutcome<R>>; blocked: GateOutcome<R> | undefined } {
  const outcomes: Array<GateOutcome<R>> = [];
  let cur = value;
  for (const g of gates) {
    if (g.compiled.direction !== 'both' && g.compiled.direction !== direction) continue;
    if (!g.compiled.detectors.length) continue;
    const findings: Findings = {};
    const budget = { left: MAX_SCAN_CHARS, truncated: false };
    const doMask = g.compiled.action === 'mask' && !opts.streamed;
    const next = scanValue(cur, g.compiled.detectors, doMask, findings, budget);
    if (!Object.keys(findings).length) continue;
    const action: InspectAction = opts.streamed ? 'flag' : g.compiled.action;
    const o: GateOutcome<R> = { ruleId: g.rule.id, ruleName: g.rule.name, action, findings, truncated: budget.truncated, reason: g.rule.config.reason, rule: g.rule };
    outcomes.push(o);
    if (action === 'block') return { value: cur, outcomes, blocked: o };
    if (action === 'mask') cur = next;
  }
  return { value: cur, outcomes, blocked: undefined };
}
