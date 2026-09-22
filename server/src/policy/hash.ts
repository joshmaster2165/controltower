import crypto from 'node:crypto';

/**
 * Canonical JSON (sorted keys, no whitespace) so that an LLM re-serialising
 * the same arguments in a different key order still hashes identically.
 */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k])).join(',') + '}';
}

export function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function getPath(o: unknown, path: string): unknown {
  let cur: unknown = o;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Salient-argument hash: when a rule declares bind_fields, only those paths
 * participate, so approved retries survive irrelevant churn (timestamps,
 * regenerated idempotency keys, formatting).
 */
export function salientHash(args: Record<string, unknown> | undefined, bindFields: string[] | undefined): string {
  if (!args) return sha256('');
  if (!bindFields || bindFields.length === 0) return sha256(canonicalJson(args));
  const picked: Record<string, unknown> = {};
  for (const f of bindFields) picked[f] = getPath(args, f);
  return sha256(canonicalJson(picked));
}

export function scopeHash(parts: { keyId: string; targetKind: string; targetName: string; argHash: string; ruleId: string | undefined; ruleRevision: number | undefined }): string {
  return sha256(canonicalJson(parts));
}

export function dedupeKey(parts: { revision: number; keyId: string; targetName: string; argHash: string }): string {
  return sha256(canonicalJson(parts));
}

export function opaqueToken(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(24).toString('base64url')}`;
}
