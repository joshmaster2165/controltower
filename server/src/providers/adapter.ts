import type { ProviderKind, Usage } from '@controltower/shared';
import type { ProviderRecord, DeploymentRecord } from '../registry.js';

/**
 * Provider adapter contract.
 *
 * Three inbound dialects reach the gateway. An adapter declares which it
 * speaks natively; the pipeline translates chat ↔ messages when the inbound
 * dialect differs from the adapter's native one, otherwise the body is
 * forwarded with auth injection and a model rename (this is what keeps
 * Claude Code's cache_control / thinking / tool_use semantics intact).
 * OpenAI's Responses API is never translated: only adapters that speak it
 * natively can serve it.
 */
export type WireDialect = 'openai-chat' | 'openai-responses' | 'anthropic-messages';

export interface NormalizedError {
  /** Stable machine code, e.g. provider_rate_limited. */
  code: string;
  message: string;
  /** Status we return to the client. */
  httpStatus: number;
  upstreamStatus?: number;
  /** May the router try the next candidate deployment? */
  fallback: boolean;
  /** Should this deployment be put on cooldown? */
  cooldown: boolean;
}

export interface UpstreamCtx {
  flightId: string;
  provider: ProviderRecord;
  deployment: DeploymentRecord;
  signal: AbortSignal;
  /** Set when the first body byte arrives. */
  onFirstByte?: () => void;
}

export type UpstreamEvent =
  | { t: 'frame'; raw: Uint8Array; hasContent: boolean; usageOnly?: boolean; parsed?: unknown }
  | { t: 'usage'; usage: Partial<Usage>; final: boolean }
  | { t: 'error'; err: NormalizedError }
  | { t: 'done' };

export interface SendOptions {
  inboundDialect: WireDialect;
  stream: boolean;
  upstreamModel: string;
}

export type AdapterResult =
  | {
      kind: 'stream';
      status: number;
      contentType: string;
      events: AsyncIterable<UpstreamEvent>;
    }
  | {
      kind: 'json';
      status: number;
      contentType: string;
      body: Uint8Array;
      usage: Usage | undefined;
    }
  | { kind: 'error'; err: NormalizedError };

export interface ProviderAdapter {
  readonly kind: ProviderKind;
  readonly nativeDialects: ReadonlySet<WireDialect>;
  readonly caps: { streamUsage: 'yes' | 'no' | 'probe'; embeddings: boolean; listModels: boolean };

  /** Execute the request. Bodies are already in the adapter's native dialect. */
  send(ctx: UpstreamCtx, body: Record<string, unknown>, opts: SendOptions): Promise<AdapterResult>;

  listModels?(provider: ProviderRecord): Promise<Array<{ id: string; context?: number }>>;
  healthCheck?(provider: ProviderRecord): Promise<{ ok: boolean; latencyMs: number; detail?: string }>;
}

/** How providers say a prompt is longer than the model's context window. */
const CONTEXT_WINDOW = /context_length_exceeded|maximum context length|context window|prompt is too long|input is too long|too many (input )?tokens|exceeds? (the )?(model'?s? )?(maximum )?(context|token limit|input length)|reduce the length of the (messages|prompt)/i;
/** How providers say they refused the content. */
const CONTENT_POLICY = /content[_ ]policy|content management policy|content_filter|responsible ?ai|safety (system|filter)|flagged as (potentially )?(harmful|unsafe)/i;

export function normalizeHttpError(status: number, bodyText: string, provider: string): NormalizedError {
  const msg = extractMessage(bodyText) || `${provider} returned HTTP ${status}`;
  if (status === 401 || status === 403) {
    return { code: 'provider_auth_error', message: `Upstream authentication failed (${provider}): ${msg}`, httpStatus: 502, upstreamStatus: status, fallback: true, cooldown: false };
  }
  if (status === 429) {
    return { code: 'provider_rate_limited', message: msg, httpStatus: 429, upstreamStatus: status, fallback: true, cooldown: true };
  }
  if (status === 404) {
    return { code: 'provider_model_not_found', message: msg, httpStatus: 502, upstreamStatus: status, fallback: true, cooldown: false };
  }
  if (status === 400 || status === 413 || status === 422) {
    // Two refusals another model may not give: a prompt too long for this one, and content it won't handle.
    if (CONTEXT_WINDOW.test(bodyText)) return { code: 'provider_context_window_exceeded', message: msg, httpStatus: 400, upstreamStatus: status, fallback: false, cooldown: false };
    if (CONTENT_POLICY.test(bodyText)) return { code: 'provider_content_policy', message: msg, httpStatus: 400, upstreamStatus: status, fallback: false, cooldown: false };
    return { code: 'provider_bad_request', message: msg, httpStatus: 400, upstreamStatus: status, fallback: false, cooldown: false };
  }
  if (status >= 500) {
    return { code: 'provider_error', message: msg, httpStatus: 502, upstreamStatus: status, fallback: true, cooldown: true };
  }
  return { code: 'provider_error', message: msg, httpStatus: 502, upstreamStatus: status, fallback: false, cooldown: false };
}

export function timeoutError(provider: string, phase: string): NormalizedError {
  return { code: 'provider_timeout', message: `Upstream ${provider} timed out (${phase})`, httpStatus: 504, fallback: true, cooldown: true };
}

export function networkError(provider: string, err: unknown): NormalizedError {
  const m = err instanceof Error ? err.message : String(err);
  return { code: 'provider_unreachable', message: `Cannot reach ${provider}: ${scrub(m)}`, httpStatus: 502, fallback: true, cooldown: true };
}

function extractMessage(bodyText: string): string {
  if (!bodyText) return '';
  try {
    const j = JSON.parse(bodyText) as { error?: { message?: string } | string; message?: string };
    if (typeof j.error === 'string') return scrub(j.error);
    if (j.error?.message) return scrub(j.error.message);
    if (j.message) return scrub(j.message);
  } catch {
    /* not json */
  }
  return scrub(bodyText.slice(0, 300));
}

/** Providers occasionally echo headers back; never let a secret through. */
export function scrub(s: string): string {
  return s
    .replace(/ct_sk_[0-9A-Za-z_]+/g, 'ct_sk_***')
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-***')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/AKIA[0-9A-Z]{12,}/g, 'AKIA***')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer ***');
}
