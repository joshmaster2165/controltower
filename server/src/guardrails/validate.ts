import { detectorCatalog } from './detectors.js';
import { validatePattern, type InspectConfig } from './scan.js';

/** Why an inspect gate's configuration can't be used, or null when it can. */
export function inspectConfigError(c: InspectConfig): string | null {
  if (c.action && !['block', 'mask', 'flag'].includes(c.action)) return 'action must be block | mask | flag';
  if (c.direction && !['input', 'output', 'both'].includes(c.direction)) return 'direction must be input | output | both';
  const known = new Set(['secrets', 'pii', 'injection', ...detectorCatalog().map((d) => d.id)]);
  const unknown = (c.detectors ?? []).filter((d) => !known.has(d));
  if (unknown.length) return `unknown detector(s): ${unknown.join(', ')}`;
  for (const p of c.patterns ?? []) {
    const err = validatePattern(p.regex ?? '');
    if (err) return `pattern "${p.name}": ${err}`;
  }
  if (c.model_check !== undefined) {
    if (!c.model_check || typeof c.model_check.model !== 'string' || !c.model_check.model.trim()) return 'model_check needs the model to ask (a model name Control Tower serves)';
    if (c.model_check.on_error && !['allow', 'block'].includes(c.model_check.on_error)) return 'model_check.on_error must be allow | block';
  }
  if (!(c.detectors?.length || c.keywords?.length || c.patterns?.length || c.model_check?.model)) return 'an inspect gate needs at least one detector, keyword, pattern or a model check';
  return null;
}

/** Why an allow-with-limits gate's limits can't be used, or null when they can. */
export function limitsConfigError(c: { limits?: unknown }): string | null {
  const l = c.limits as Record<string, unknown> | undefined;
  if (!l || typeof l !== 'object' || Array.isArray(l)) return 'an allow-with-limits gate needs limits: rpm, tpm and/or max_tokens';
  for (const k of Object.keys(l)) if (!['rpm', 'tpm', 'max_tokens'].includes(k)) return `unknown limit "${k}" (use rpm, tpm, max_tokens)`;
  const set = ['rpm', 'tpm', 'max_tokens'].filter((k) => l[k] !== undefined && l[k] !== null);
  for (const k of set) if (typeof l[k] !== 'number' || !Number.isFinite(l[k] as number) || (l[k] as number) <= 0) return `${k} must be a positive number`;
  if (!set.length) return 'an allow-with-limits gate needs at least one of rpm, tpm, max_tokens';
  return null;
}
