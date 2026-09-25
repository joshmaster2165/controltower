import type { AppContext } from '../context.js';
import type { KeyRecord } from '../registry.js';
import { E, type GatewayError } from '../gateway/errors.js';
import type { PolicyDecision } from './engine.js';

/**
 * An allow-with-limits gate lets a call through within its limits: requests and tokens per minute,
 * counted per agent on the gate's path. Over them, the call is refused like a key's own rate limit.
 */
export function gateLimitRefusal(ctx: Pick<AppContext, 'limiter'>, decision: PolicyDecision, key: KeyRecord, estTokens = 1): GatewayError | undefined {
  const l = decision.limits;
  if (!l || !decision.ruleId || !(l.rpm || l.tpm)) return undefined;
  const r = ctx.limiter.admit(`gate:${decision.ruleId}:${key.id}`, Math.max(1, estTokens), { ...(l.rpm ? { rpm: l.rpm } : {}), ...(l.tpm ? { tpm: l.tpm } : {}) });
  if (r.ok) return undefined;
  const e = E.rateLimited(`${r.which} limit of a gate`, r.retryAfterMs);
  return { ...e, message: `${e.message} ${decision.reason ?? ''}`.trim() };
}

/** A model call's reply length, capped at the gate's max_tokens, in whichever field the API uses. */
export function capMaxTokens(body: Record<string, unknown>, decision: PolicyDecision): void {
  const cap = decision.limits?.max_tokens;
  if (!cap || cap <= 0) return;
  for (const field of ['max_tokens', 'max_completion_tokens', 'max_output_tokens']) {
    const v = body[field];
    if (typeof v === 'number') body[field] = Math.min(v, cap);
  }
  if (!['max_tokens', 'max_completion_tokens', 'max_output_tokens'].some((f) => typeof body[f] === 'number')) body[defaultMaxField(body)] = cap;
}

const defaultMaxField = (body: Record<string, unknown>): string => ('input' in body && !('messages' in body) ? 'max_output_tokens' : 'max_tokens');
