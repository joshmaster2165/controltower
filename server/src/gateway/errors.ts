import type { WireDialect } from '../providers/adapter.js';

/**
 * Error envelopes in the inbound dialect's shape. Every gateway error carries
 * x-ct-flight-id so a user can find the flight in the console.
 */
export interface GatewayError {
  status: number;
  code: string;
  message: string;
  /** OpenAI `type` field / Anthropic error `type`. */
  type?: string;
  extra?: Record<string, unknown>;
}

const OPENAI_TYPE_BY_STATUS: Record<number, string> = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'invalid_request_error',
  429: 'rate_limit_error',
  500: 'server_error',
  502: 'server_error',
  503: 'server_error',
  504: 'server_error',
};

const ANTHROPIC_TYPE_BY_STATUS: Record<number, string> = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'not_found_error',
  413: 'request_too_large',
  429: 'rate_limit_error',
  500: 'api_error',
  502: 'api_error',
  503: 'overloaded_error',
  504: 'api_error',
};

export function errorBody(dialect: WireDialect, e: GatewayError): Record<string, unknown> {
  if (dialect === 'anthropic-messages') {
    return {
      type: 'error',
      error: {
        type: e.type ?? ANTHROPIC_TYPE_BY_STATUS[e.status] ?? 'api_error',
        message: e.message,
        code: e.code,
        ...(e.extra ?? {}),
      },
    };
  }
  return {
    error: {
      message: e.message,
      type: e.type ?? OPENAI_TYPE_BY_STATUS[e.status] ?? 'server_error',
      param: null,
      code: e.code,
      ...(e.extra ?? {}),
    },
  };
}

/** SSE error frame for a stream that has already started. */
export function errorFrame(dialect: WireDialect, e: GatewayError): string {
  const body = errorBody(dialect, e);
  if (dialect === 'anthropic-messages') return `event: error\ndata: ${JSON.stringify(body)}\n\n`;
  // Responses API streams carry typed events; errors are {type: 'error', code, message, param}.
  if (dialect === 'openai-responses') return `event: error\ndata: ${JSON.stringify({ type: 'error', code: e.code, message: e.message, param: null })}\n\n`;
  return `data: ${JSON.stringify(body)}\n\n`;
}

export const E = {
  unauthorized: (msg = 'Missing or invalid API key. Pass it as `Authorization: Bearer ct_sk_...` or `x-api-key`.'): GatewayError => ({
    status: 401,
    code: 'invalid_api_key',
    message: msg,
  }),
  keyDisabled: (): GatewayError => ({ status: 401, code: 'key_disabled', message: 'This API key is disabled.' }),
  keyExpired: (): GatewayError => ({ status: 401, code: 'key_expired', message: 'This API key has expired.' }),
  modelNotAllowed: (model: string): GatewayError => ({
    status: 403,
    code: 'model_not_allowed',
    message: `This API key is not allowed to use model "${model}".`,
  }),
  modelNotFound: (model: string): GatewayError => ({
    status: 404,
    code: 'model_not_found',
    message: `No connected provider serves the model "${model}". Connect the provider that offers it (Providers in the Control Tower console) and retry — models are added on first use — or pin one with "<provider>/${model}".`,
  }),
  badRequest: (msg: string): GatewayError => ({ status: 400, code: 'invalid_request', message: msg }),
  delegationRequired: (why: string): GatewayError => ({
    status: 403,
    code: 'delegation_required',
    message: `This key acts only on behalf of other agents, and ${why}. Pass on the x-ct-delegation header of the request that called this agent.`,
  }),
  delegationTooDeep: (): GatewayError => ({ status: 403, code: 'delegation_too_deep', message: 'Too many agents deep: this call is at the end of a chain of agents calling agents that is longer than Control Tower allows.' }),
  rateLimited: (which: string, retryAfterMs: number): GatewayError => ({
    status: 429,
    code: 'rate_limit_exceeded',
    message: `Rate limit exceeded (${which}). Retry after ${Math.ceil(retryAfterMs / 1000)}s.`,
  }),
  tooManyParallel: (max: number): GatewayError => ({
    status: 429,
    code: 'too_many_parallel_requests',
    message: `This key allows at most ${max} concurrent requests.`,
  }),
  budgetExceeded: (scope: string): GatewayError => ({
    status: 429,
    code: 'budget_exceeded',
    type: 'insufficient_quota',
    message: `Budget exceeded for ${scope}. Raise the budget in the Control Tower console.`,
  }),
  policyDenied: (reason: string | undefined, ruleId: string | undefined): GatewayError => ({
    status: 403,
    code: 'policy_denied',
    message: reason ?? 'Blocked by Control Tower policy.',
    ...(ruleId ? { extra: { rule_id: ruleId } } : {}),
  }),
  approvalRequired: (message: string, extra: Record<string, unknown>): GatewayError => ({
    status: 403,
    code: 'approval_required',
    message,
    extra,
  }),
  contentBlocked: (message: string, ruleId: string, findings: Record<string, number>): GatewayError => ({
    status: 400,
    code: 'content_blocked',
    message,
    extra: { rule_id: ruleId, findings },
  }),
  shuttingDown: (): GatewayError => ({ status: 503, code: 'shutting_down', message: 'Control Tower is restarting. Retry shortly.' }),
};
