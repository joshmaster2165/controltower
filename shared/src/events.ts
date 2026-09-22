import { z } from 'zod';

/**
 * Flight events are the single contract between the gateway pipeline and every
 * consumer: the DB sink, the WebSocket bus feeding the Airspace, the rollup
 * accumulators and the demo generator. They never carry request/response
 * bodies, headers, keys or credentials — redaction is structural.
 *
 * Money is an integer number of nanousd (1e-9 USD). A JS number holds this
 * exactly up to ~$9M per value, which is fine per flight; aggregates live in
 * 64-bit DB integers.
 */

export const FlightKind = z.enum(['chat', 'embeddings', 'messages', 'mcp.tool']);
export type FlightKind = z.infer<typeof FlightKind>;

export const Dialect = z.enum(['openai-chat', 'anthropic-messages', 'mcp']);
export type Dialect = z.infer<typeof Dialect>;

export const ProviderKind = z.enum([
  'openai',
  'azure-openai',
  'openai-compatible',
  'anthropic',
  'gemini',
  'vertex',
  'bedrock',
  'mock',
]);
export type ProviderKind = z.infer<typeof ProviderKind>;

export const UsageSource = z.enum(['provider', 'estimated', 'estimated_partial', 'unknown']);
export type UsageSource = z.infer<typeof UsageSource>;

export const CostConfidence = z.enum(['exact', 'estimated', 'unknown']);
export type CostConfidence = z.infer<typeof CostConfidence>;

export const Usage = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative().default(0),
  cacheWrite: z.number().int().nonnegative().default(0),
  reasoning: z.number().int().nonnegative().optional(),
});
export type Usage = z.infer<typeof Usage>;

export const Decision = z.enum(['allow', 'deny', 'hold', 'mutate', 'flagged']);
export type Decision = z.infer<typeof Decision>;

export const FlightStatus = z.enum([
  'ok',
  'error',
  'rejected',
  'denied',
  'ticketed',
  'client_aborted',
  'shutdown',
]);
export type FlightStatus = z.infer<typeof FlightStatus>;

const base = {
  flight_id: z.string(),
  ts: z.number(),
};

export const FlightStarted = z.object({
  t: z.literal('flight.started'),
  ...base,
  key_id: z.string(),
  key_name: z.string(),
  agent_id: z.string().optional(),
  team: z.string().optional(),
  project: z.string().optional(),
  kind: FlightKind,
  dialect: Dialect,
  stream: z.boolean(),
  model_requested: z.string(),
  alias_id: z.string().optional(),
  deployment_id: z.string().optional(),
  provider_id: z.string().optional(),
  provider_kind: ProviderKind.optional(),
  mcp_server_id: z.string().optional(),
  tool: z.string().optional(),
  est_input_tokens: z.number().int().nonnegative(),
  projected_nanousd: z.number().nonnegative(),
});

export const FlightDecision = z.object({
  t: z.literal('flight.decision'),
  ...base,
  decision: Decision,
  rule_id: z.string().optional(),
  zone_from: z.string().optional(),
  zone_to: z.string().optional(),
  reason: z.string().optional(),
  arg_hash: z.string().optional(),
});

export const FlightHeld = z.object({
  t: z.literal('flight.held'),
  ...base,
  approval_id: z.string(),
  budget_ms: z.number().int().nonnegative(),
  summary: z.string(),
});

export const FlightResolved = z.object({
  t: z.literal('flight.resolved'),
  ...base,
  approval_id: z.string(),
  outcome: z.enum(['approved', 'denied', 'expired', 'ticketed']),
  by: z.string().optional(),
  grant_id: z.string().optional(),
});

export const FlightUpstream = z.object({
  t: z.literal('flight.upstream'),
  ...base,
  attempt: z.number().int().positive(),
  deployment_id: z.string(),
  provider_id: z.string(),
  upstream_model: z.string(),
  outcome: z.enum(['ok', 'error', 'fallback']),
  status: z.number().int().optional(),
  error_code: z.string().optional(),
  ttfb_ms: z.number().nonnegative().optional(),
});

export const FlightCompleted = z.object({
  t: z.literal('flight.completed'),
  ...base,
  status: FlightStatus,
  http_status: z.number().int(),
  deployment_id: z.string().optional(),
  usage: Usage.optional(),
  usage_source: UsageSource,
  cost_nanousd: z.number().nullable(),
  cost_confidence: CostConfidence,
  ttfb_ms: z.number().nonnegative().optional(),
  ttft_ms: z.number().nonnegative().optional(),
  duration_ms: z.number().nonnegative(),
  gateway_overhead_ms: z.number().nonnegative(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      upstream_status: z.number().int().optional(),
    })
    .optional(),
});

export const FlightEvent = z.discriminatedUnion('t', [
  FlightStarted,
  FlightDecision,
  FlightHeld,
  FlightResolved,
  FlightUpstream,
  FlightCompleted,
]);
export type FlightEvent = z.infer<typeof FlightEvent>;
export type FlightStarted = z.infer<typeof FlightStarted>;
export type FlightDecision = z.infer<typeof FlightDecision>;
export type FlightHeld = z.infer<typeof FlightHeld>;
export type FlightResolved = z.infer<typeof FlightResolved>;
export type FlightUpstream = z.infer<typeof FlightUpstream>;
export type FlightCompleted = z.infer<typeof FlightCompleted>;
