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
