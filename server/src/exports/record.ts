import type { FlightEvent } from '@controltower/shared';

/**
 * One call, as sent to a customer's own monitoring: who made it, where to, what the gates decided, what it
 * cost and how long it took. Metadata only — Control Tower never records prompts or answers, so none are sent.
 */
export interface FlightRecord {
  type: 'controltower.flight';
  version: 1;
  id: string;
  /** When the call started and ended (ISO 8601), and epoch milliseconds for spans. */
  started_at: string;
  ended_at: string;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  status: string;
  http_status: number;
  kind: string;
  endpoint?: string | undefined;
  agent: { key_id: string; key_name: string; agent_id?: string | undefined; team?: string | undefined; project?: string | undefined };
  /** Agents this call was made for, from a delegation token (origin first). */
  on_behalf_of?: string[] | undefined;
  parent_flight_id?: string | undefined;
  customer?: string | undefined;
  /** Who presented the token the call was made with (issuer · subject), when it wasn't a key's secret. */
  principal?: string | undefined;
  tags?: string[] | undefined;
  target: {
    model_requested: string;
    deployment_id?: string | undefined;
    provider_id?: string | undefined;
    provider_kind?: string | undefined;
    /** The model actually called, on the last attempt. */
    upstream_model?: string | undefined;
    mcp_server_id?: string | undefined;
    tool?: string | undefined;
  };
  decision?: { effect: string; rule_id?: string | undefined; reason?: string | undefined; zone_from?: string | undefined; zone_to?: string | undefined } | undefined;
  approval?: { id: string; outcome?: string | undefined; by?: string | undefined } | undefined;
  /** Inspect gates that flagged, masked or blocked something, and what (counts only). */
  findings?: Array<{ rule_id?: string | undefined; action?: string | undefined; detector?: string | undefined; count?: number | undefined }> | undefined;
  attempts: number;
  usage?: { input: number; output: number; cache_read: number; cache_write: number; reasoning?: number | undefined; source: string } | undefined;
  units?: Record<string, number> | undefined;
  cost_usd: number | null;
  cost_confidence: string;
  cache_hit?: boolean | undefined;
  latency: { ttfb_ms?: number | undefined; ttft_ms?: number | undefined; gateway_overhead_ms: number };
  error?: { code: string; message: string; upstream_status?: number | undefined } | undefined;
  trace?: { trace_id: string; parent_span_id?: string | undefined } | undefined;
  instance?: string | undefined;
}

type Partial = { started?: Extract<FlightEvent, { t: 'flight.started' }>; decision?: FlightRecord['decision']; approval?: FlightRecord['approval']; findings?: NonNullable<FlightRecord['findings']>; attempts: number; upstream?: string; at: number };

const TTL_MS = 2 * 3600_000;
const MAX_OPEN = 50_000;

/** Joins a call's events into one record when it completes. Calls that never complete are forgotten after two hours. */
export class Assembler {
  private open = new Map<string, Partial>();
  private swept = Date.now();

  constructor(private readonly instance?: string) {}

  /** Returns the finished record when this event completes a call. */
  push(e: FlightEvent): FlightRecord | undefined {
    const now = Date.now();
    if (now - this.swept > 60_000) this.sweep(now);
    let p = this.open.get(e.flight_id);
    if (!p) {
      if (e.t !== 'flight.started' && e.t !== 'flight.decision') return undefined;
      if (this.open.size >= MAX_OPEN) {
        // Full: the oldest open call gives way (Map keeps insertion order).
        const oldest = this.open.keys().next().value;
        if (oldest !== undefined) this.open.delete(oldest);
      }
      p = { attempts: 0, at: now };
      this.open.set(e.flight_id, p);
    }
    switch (e.t) {
      case 'flight.started':
        p.started = e;
        return undefined;
      case 'flight.decision':
        if (e.decision === 'flagged' || e.decision === 'mutate') {
          (p.findings ??= []).push({ rule_id: e.rule_id, action: e.decision, detector: e.reason });
        } else p.decision = { effect: e.decision, rule_id: e.rule_id, reason: e.reason, zone_from: e.zone_from, zone_to: e.zone_to };
        return undefined;
      case 'flight.held':
        p.approval = { id: e.approval_id };
        return undefined;
      case 'flight.resolved':
        p.approval = { id: e.approval_id, outcome: e.outcome, by: e.by };
        return undefined;
      case 'flight.upstream':
        p.attempts = Math.max(p.attempts, e.attempt);
        p.upstream = e.upstream_model;
        return undefined;
      case 'flight.completed': {
        this.open.delete(e.flight_id);
        const s = p.started;
        if (!s) return undefined;
        const u = e.usage;
        return {
          type: 'controltower.flight',
          version: 1,
          id: e.flight_id,
          started_at: new Date(s.ts).toISOString(),
          ended_at: new Date(e.ts).toISOString(),
          start_ms: s.ts,
          end_ms: e.ts,
          duration_ms: Math.round(e.duration_ms),
          status: e.status,
          http_status: e.http_status,
          kind: s.kind,
          endpoint: s.endpoint,
          agent: { key_id: s.key_id, key_name: s.key_name, agent_id: s.agent_id, team: s.team, project: s.project },
          on_behalf_of: s.on_behalf_of,
          parent_flight_id: s.parent_flight_id,
          customer: s.customer,
          ...(s.principal ? { principal: s.principal } : {}),
          tags: s.tags,
          target: { model_requested: s.model_requested, deployment_id: e.deployment_id ?? s.deployment_id, provider_id: s.provider_id, provider_kind: s.provider_kind, upstream_model: p.upstream, mcp_server_id: s.mcp_server_id, tool: s.tool },
          decision: p.decision,
          approval: p.approval,
          findings: p.findings,
          attempts: p.attempts,
          usage: u ? { input: u.input, output: u.output, cache_read: u.cacheRead ?? 0, cache_write: u.cacheWrite ?? 0, reasoning: u.reasoning, source: e.usage_source } : undefined,
          units: e.units as Record<string, number> | undefined,
          cost_usd: e.cost_nanousd == null ? null : e.cost_nanousd / 1e9,
          cost_confidence: e.cost_confidence,
          cache_hit: e.cache_hit,
          latency: { ttfb_ms: e.ttfb_ms, ttft_ms: e.ttft_ms, gateway_overhead_ms: Math.round(e.gateway_overhead_ms) },
          error: e.error,
          trace: s.trace,
          instance: this.instance,
        };
      }
      default:
        return undefined;
    }
  }

  private sweep(now: number): void {
    this.swept = now;
    for (const [id, p] of this.open) if (now - p.at > TTL_MS) this.open.delete(id);
  }
}
