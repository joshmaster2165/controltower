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
  if (!(c.detectors?.length || c.keywords?.length || c.patterns?.length)) return 'an inspect gate needs at least one detector, keyword or pattern';
  return null;
}
