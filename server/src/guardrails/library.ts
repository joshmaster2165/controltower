import { detectorCatalog } from './detectors.js';
import { validatePattern, type InspectConfig, type PolicyCheck } from './scan.js';

/**
 * Your own guardrails: named sets of checks, built in Control Tower — no outside service. A guardrail picks built-in
 * detectors, lists keywords, adds patterns (regexes), and can state a policy in your own words that a model Control
 * Tower serves judges. Inspect gates use guardrails by name (`config.guardrails`); what a gate does on a finding
 * (mask, block, flag) and in which direction stay the gate's. Editing a guardrail changes every gate that uses it.
 */

export interface GuardrailChecks {
  detectors?: string[];
  keywords?: string[];
  patterns?: Array<{ name: string; regex: string }>;
  /** A policy in your own words. */
  policy?: { model: string; instructions: string; on_error?: 'allow' | 'block' };
}

export interface GuardrailRecord {
  id: string;
  name: string;
  description: string | null;
  checks: GuardrailChecks;
}

const MAX_KEYWORDS = 500;
const MAX_PATTERNS = 50;

/** Why a guardrail can't be saved, or null. */
export function guardrailProblem(b: { name?: unknown; description?: unknown; checks?: unknown }): string | null {
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) return 'Give the guardrail a name.';
  if (name.length > 60) return 'Keep the name to 60 characters.';
  if (b.description !== undefined && b.description !== null && (typeof b.description !== 'string' || b.description.length > 500)) return 'Keep the description to 500 characters.';
  const c = (b.checks ?? {}) as GuardrailChecks;
  if (typeof c !== 'object' || Array.isArray(c)) return 'checks must be an object.';
  const known = new Set(['secrets', 'pii', 'injection', ...detectorCatalog().map((d) => d.id)]);
  if (c.detectors !== undefined) {
    if (!Array.isArray(c.detectors)) return 'detectors must be a list.';
    const unknown = c.detectors.filter((d) => !known.has(d));
    if (unknown.length) return `Unknown detector(s): ${unknown.join(', ')}.`;
  }
  if (c.keywords !== undefined) {
    if (!Array.isArray(c.keywords) || !c.keywords.every((k) => typeof k === 'string')) return 'keywords must be a list of words or phrases.';
    if (c.keywords.length > MAX_KEYWORDS) return `Up to ${MAX_KEYWORDS} keywords.`;
    if (c.keywords.some((k) => k.length > 200)) return 'Keep each keyword to 200 characters.';
  }
  if (c.patterns !== undefined) {
    if (!Array.isArray(c.patterns)) return 'patterns must be a list of {name, regex}.';
    if (c.patterns.length > MAX_PATTERNS) return `Up to ${MAX_PATTERNS} patterns.`;
    for (const p of c.patterns) {
      if (!p || typeof p.regex !== 'string' || !p.regex) return 'Each pattern needs a regex.';
      if (typeof p.name !== 'string' || !p.name.trim()) return 'Each pattern needs a name (it names what was found).';
      const err = validatePattern(p.regex);
      if (err) return `Pattern "${p.name}": ${err}.`;
    }
  }
  if (c.policy !== undefined && c.policy !== null) {
    if (typeof c.policy.model !== 'string' || !c.policy.model.trim()) return 'A policy needs the model that judges it (one Control Tower serves).';
    if (typeof c.policy.instructions !== 'string' || c.policy.instructions.trim().length < 10) return "Write the policy: what isn't allowed, in a sentence or two.";
    if (c.policy.instructions.length > 4000) return 'Keep the policy to 4,000 characters.';
    if (c.policy.on_error && !['allow', 'block'].includes(c.policy.on_error)) return 'policy.on_error must be allow or block.';
  }
  const any = c.detectors?.length || c.keywords?.some((k) => k.trim()) || c.patterns?.length || c.policy?.instructions;
  if (!any) return 'A guardrail needs something to look for: detectors, keywords, patterns or a policy.';
  return null;
}

/** The checks as stored: trimmed, empties dropped. */
export function tidyChecks(c: GuardrailChecks): GuardrailChecks {
  const keywords = [...new Set((c.keywords ?? []).map((k) => k.trim()).filter(Boolean))];
  return {
    ...(c.detectors?.length ? { detectors: [...new Set(c.detectors)] } : {}),
    ...(keywords.length ? { keywords } : {}),
    ...(c.patterns?.length ? { patterns: c.patterns.map((p) => ({ name: p.name.trim(), regex: p.regex })) } : {}),
    ...(c.policy?.instructions ? { policy: { model: c.policy.model.trim(), instructions: c.policy.instructions.trim(), ...(c.policy.on_error ? { on_error: c.policy.on_error } : {}) } } : {}),
  };
}

/** A name safe in findings and masks: "Board figures" → "board-figures". */
export function slugOf(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'guardrail'
  );
}

/**
 * A gate's checks with its guardrails' added: detectors, keywords, patterns and policies, each found under the
 * guardrail's name. Guardrails that no longer exist add nothing.
 */
export function withGuardrails(cfg: InspectConfig, library: Map<string, GuardrailRecord>): InspectConfig {
  if (!cfg.guardrails?.length) return cfg;
  const detectors = new Set(cfg.detectors ?? []);
  const keywords = [...(cfg.keywords ?? [])];
  const patterns = [...(cfg.patterns ?? [])];
  const policies: PolicyCheck[] = [...(cfg.policies ?? [])];
  for (const id of cfg.guardrails) {
    const g = library.get(id);
    if (!g) continue;
    const slug = slugOf(g.name);
    for (const d of g.checks.detectors ?? []) detectors.add(d);
    keywords.push(...(g.checks.keywords ?? []));
    for (const p of g.checks.patterns ?? []) patterns.push({ name: `${slug}_${p.name}`, regex: p.regex });
    if (g.checks.policy) policies.push({ name: slug, ...g.checks.policy });
  }
  return { ...cfg, detectors: [...detectors], keywords, patterns, policies };
}
