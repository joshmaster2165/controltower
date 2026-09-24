import type { IncomingHttpHeaders } from 'node:http';
import type { AppContext } from '../context.js';
import type { KeyRecord } from '../registry.js';

/**
 * The key a client presented, from the headers SDKs and tools send it in:
 * `Authorization: Bearer` (OpenAI SDKs, Claude Code's ANTHROPIC_AUTH_TOKEN),
 * `x-api-key` (Anthropic SDKs), `x-litellm-api-key` (LiteLLM clients) and
 * `api-key` (Azure SDKs). A "Bearer " prefix is accepted on any of them.
 */
export function extractApiKey(req: { headers: IncomingHttpHeaders }): string | undefined {
  const h = req.headers;
  for (const v of [h.authorization, h['x-api-key'], h['x-litellm-api-key'], h['api-key']]) {
    if (typeof v !== 'string' || !v.trim() || /^basic\s/i.test(v)) continue;
    return v.trim().replace(/^bearer(\s+|$)/i, '').trim() || undefined;
  }
  return undefined;
}

/** Why a key can't be used right now, or undefined when it can. */
export function keyProblem(key: KeyRecord): 'disabled' | 'expired' | undefined {
  if (!key.enabled) return 'disabled';
  if (key.expiresAt && key.expiresAt < Date.now()) return 'expired';
  return undefined;
}

/** The presented key, if it exists and may be used now (not blocked, not expired). */
export function usableKey(ctx: AppContext, req: { headers: IncomingHttpHeaders }): KeyRecord | undefined {
  const presented = extractApiKey(req);
  const key = presented ? ctx.registry.authenticate(presented) : undefined;
  return key && !keyProblem(key) ? key : undefined;
}
