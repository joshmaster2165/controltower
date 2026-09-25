import type { KeyRecord } from '../registry.js';

/**
 * Policy decision point. The real engine (zones, gates, hold → ticket →
 * grant) lands in build step 5; the pipeline is already wired to it through
 * this interface so nothing else changes when it does.
 */
export interface PolicyTarget {
  kind: 'model' | 'tool';
  /** Model alias/public name, or namespaced tool name `server__tool`. */
  name: string;
  providerId?: string | undefined;
  providerKind?: string | undefined;
  deploymentId?: string | undefined;
  mcpServerId?: string | undefined;
  /** read | write | admin | unknown — used for fail-mode defaults. */
  operation: 'read' | 'write' | 'admin' | 'unknown';
}

export interface PolicyInput {
  flightId: string;
  key: KeyRecord;
  target: PolicyTarget;
  /** Tool arguments or a reduced view of the request. Never logged. */
  args: Record<string, unknown> | undefined;
  /**
   * Whom the call is made on behalf of, from a verified delegation token: `agent:<id>` for each agent in
   * the chain and `team:<name>` for their teams. Empty for a call an agent makes on its own account.
   */
  onBehalfOf?: string[];
  estInputTokens: number;
  projectedNanousd: number;
}

export interface PolicyDecision {
  effect: 'allow' | 'deny' | 'hold';
  ruleId?: string | undefined;
  reason?: string | undefined;
  zoneFrom?: string | undefined;
  zoneTo?: string | undefined;
  /** Present on hold: what the approval card should show. */
  summary?: string | undefined;
  argHash?: string | undefined;
  /** Set by an allow-with-limits gate: what the call is allowed within. */
  limits?: GateLimits | undefined;
}

/** An allow-with-limits gate's limits: per agent on the gate's path. */
export interface GateLimits {
  /** Requests per minute. */
  rpm?: number;
  /** Tokens per minute (model calls: the prompt's estimated size). */
  tpm?: number;
  /** A cap on the length of a model's reply. */
  max_tokens?: number;
}

/** An inspect gate that applies to a path (see guardrails/scan.ts). */
export interface InspectGate {
  rule: { id: string; name: string; config: import('../guardrails/scan.js').InspectConfig };
  compiled: import('../guardrails/scan.js').CompiledInspector;
}

export interface PolicyEngine {
  readonly version: number;
  /** Content-inspection gates on this path, in priority order. */
  inspectors?(key: KeyRecord, target: PolicyTarget, onBehalfOf?: string[]): InspectGate[];
  evaluate(input: PolicyInput): PolicyDecision | Promise<PolicyDecision>;
  /** Static decision (no args) used to filter MCP tools/list pre-emptively. */
  staticDecision(key: KeyRecord, target: PolicyTarget): 'deny' | 'maybe';
  /** Optional change notification (zones/rules edited). */
  onChange?(fn: () => void): () => void;
}

