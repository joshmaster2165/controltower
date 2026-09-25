import type { FlightEvent } from '@controltower/shared';
import { isToolKind } from '@controltower/shared';
import { NANO_PER_USD } from '@controltower/shared';

/**
 * Prometheus text exposition (format 0.0.4), fed from the flight bus.
 *
 * Label values are bounded on purpose: agents, deployments, gates and MCP
 * servers are things an admin created, and a model name the gateway does not
 * know is collapsed to "other" — a client cannot mint new series by sending
 * made-up model names. Keys appear by name, never by secret or hash.
 */

type Labels = Record<string, string>;

function esc(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function labelStr(l: Labels): string {
  const parts = Object.entries(l).map(([k, v]) => `${k}="${esc(v)}"`);
  return parts.length ? `{${parts.join(',')}}` : '';
}

const MAX_SERIES = 10_000;

class Counter {
  private series = new Map<string, { labels: Labels; value: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  inc(labels: Labels, by = 1): void {
    const k = labelStr(labels);
    const s = this.series.get(k);
    if (s) s.value += by;
    else if (this.series.size < MAX_SERIES) this.series.set(k, { labels, value: by });
  }
  render(out: string[]): void {
    out.push(`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`);
    for (const [k, s] of this.series) out.push(`${this.name}${k} ${s.value}`);
  }
}

class Histogram {
  private series = new Map<string, { labels: Labels; counts: number[]; sum: number; n: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly buckets: number[],
  ) {}
  observe(labels: Labels, v: number): void {
    const k = labelStr(labels);
    let s = this.series.get(k);
    if (!s) {
      if (this.series.size >= MAX_SERIES) return;
      s = { labels, counts: this.buckets.map(() => 0), sum: 0, n: 0 };
      this.series.set(k, s);
    }
    for (let i = 0; i < this.buckets.length; i++) if (v <= this.buckets[i]!) s.counts[i]!++;
    s.sum += v;
    s.n++;
  }
  render(out: string[]): void {
    out.push(`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`);
    for (const s of this.series.values()) {
      this.buckets.forEach((b, i) => out.push(`${this.name}_bucket${labelStr({ ...s.labels, le: String(b) })} ${s.counts[i]}`));
      out.push(`${this.name}_bucket${labelStr({ ...s.labels, le: '+Inf' })} ${s.n}`);
      out.push(`${this.name}_sum${labelStr(s.labels)} ${s.sum}`);
      out.push(`${this.name}_count${labelStr(s.labels)} ${s.n}`);
    }
  }
}

/** Seconds: 5 ms … 10 min, so the default 600 s request timeout lands in a bucket. */
const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600];
const OVERHEAD_BUCKETS = [0.0005, 0.001, 0.002, 0.004, 0.008, 0.016, 0.032, 0.064, 0.128, 0.256];

export interface GaugeSample {
  labels: Labels;
  value: number;
}

export interface MetricsSources {
  version: string;
  startedAt: number;
  modelName(deploymentId: string | undefined): string | undefined;
  providerKind(providerId: string | undefined): string | undefined;
  mcpName(serverId: string | undefined): string | undefined;
  gateName(ruleId: string): string | undefined;
  heldRequests(): number;
  pendingEvents(): number;
  deployments(): Array<{ model: string; provider: string; coolingDown: boolean }>;
  mcpServers(): Array<{ server: string; up: boolean }>;
  budgets(): Array<{ scope: string; limitUsd: number; spentUsd: number }>;
}

interface Tracked {
  agent: string;
  team: string;
  kind: string;
  model: string;
  provider: string;
  stream: boolean;
}

export class Metrics {
  private requests = new Counter('controltower_requests_total', 'Requests through the gateway (LLM calls and MCP tool calls), by outcome.');
  private tokens = new Counter('controltower_tokens_total', 'Tokens, by type (input, output, cache_read, cache_write).');
  private spend = new Counter('controltower_spend_usd_total', 'Spend in USD, from provider-reported or estimated usage.');
  private duration = new Histogram('controltower_request_duration_seconds', 'Total request duration, including upstream time.', LATENCY_BUCKETS);
  private ttft = new Histogram('controltower_time_to_first_token_seconds', 'Time to first token on streamed replies.', LATENCY_BUCKETS);
  private overhead = new Histogram('controltower_gateway_overhead_seconds', 'Time spent in Control Tower before the upstream request left.', OVERHEAD_BUCKETS);
  private upstreamFailures = new Counter('controltower_upstream_failures_total', 'Failed upstream attempts, by deployment and error code.');
  private fallbacks = new Counter('controltower_fallbacks_total', 'Upstream attempts that failed over to another deployment.');
  private gateDecisions = new Counter('controltower_gate_decisions_total', 'Gate decisions: deny, hold, allow, mutate (masked), flagged.');
  private approvals = new Counter('controltower_approvals_total', 'Held requests by outcome: approved, denied, expired, ticketed.');
  private live = new Map<string, Tracked>();

  constructor(private readonly src: MetricsSources) {}

  push = (e: FlightEvent): void => {
    switch (e.t) {
      case 'flight.started': {
        if (this.live.size > 50_000) this.live.delete(this.live.keys().next().value!);
        const model = isToolKind(e.kind) ? (this.src.mcpName(e.mcp_server_id) ?? 'other') : (this.src.modelName(e.deployment_id) ?? 'other');
        this.live.set(e.flight_id, {
          agent: e.key_name,
          team: e.team ?? '',
          kind: e.kind,
          model,
          provider: e.kind === 'mcp.tool' ? 'mcp' : e.kind === 'http.request' ? 'http' : e.kind === 'a2a.call' ? 'a2a' : (e.provider_kind ?? this.src.providerKind(e.provider_id) ?? ''),
          stream: e.stream,
        });
        return;
      }
      case 'flight.decision':
        if (e.rule_id) this.gateDecisions.inc({ gate: this.src.gateName(e.rule_id) ?? 'deleted', decision: e.decision });
        return;
      case 'flight.resolved':
        this.approvals.inc({ outcome: e.outcome });
        return;
      case 'flight.upstream': {
        if (e.outcome === 'ok') return;
        const model = this.src.modelName(e.deployment_id) ?? this.src.mcpName(e.deployment_id) ?? 'other';
        this.upstreamFailures.inc({ model, code: e.error_code ?? String(e.status ?? 'unknown') });
        if (e.outcome === 'fallback') this.fallbacks.inc({ model });
        return;
      }
      case 'flight.completed': {
        const t = this.live.get(e.flight_id);
        this.live.delete(e.flight_id);
        if (!t) return;
        // The deployment that actually served the request, which may differ after a fallback.
        const model = isToolKind(t.kind) ? t.model : (this.src.modelName(e.deployment_id) ?? t.model);
        this.requests.inc({ agent: t.agent, team: t.team, kind: t.kind, model, provider: t.provider, status: e.status });
        this.duration.observe({ kind: t.kind, model, provider: t.provider }, e.duration_ms / 1000);
        this.overhead.observe({}, e.gateway_overhead_ms / 1000);
        if (t.stream && e.ttft_ms != null) this.ttft.observe({ model, provider: t.provider }, e.ttft_ms / 1000);
        if (e.usage && !isToolKind(t.kind)) {
          const base = { agent: t.agent, model };
          if (e.usage.input) this.tokens.inc({ ...base, type: 'input' }, e.usage.input);
          if (e.usage.output) this.tokens.inc({ ...base, type: 'output' }, e.usage.output);
          if (e.usage.cacheRead) this.tokens.inc({ ...base, type: 'cache_read' }, e.usage.cacheRead);
          if (e.usage.cacheWrite) this.tokens.inc({ ...base, type: 'cache_write' }, e.usage.cacheWrite);
        }
        if (e.cost_nanousd) this.spend.inc({ agent: t.agent, team: t.team, model }, e.cost_nanousd / NANO_PER_USD);
        return;
      }
      default:
        return;
    }
  };

  render(): string {
    const out: string[] = [];
    const gauge = (name: string, help: string, samples: GaugeSample[]) => {
      out.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
      for (const s of samples) out.push(`${name}${labelStr(s.labels)} ${s.value}`);
    };
    gauge('controltower_build_info', 'Always 1; the version label identifies the build.', [{ labels: { version: this.src.version }, value: 1 }]);
    gauge('controltower_uptime_seconds', 'Seconds since the process started.', [{ labels: {}, value: Math.round((Date.now() - this.src.startedAt) / 1000) }]);
    gauge('controltower_requests_in_flight', 'Requests started and not yet completed.', [{ labels: {}, value: this.live.size }]);
    gauge('controltower_held_requests', 'Requests currently held at an approval gate.', [{ labels: {}, value: this.src.heldRequests() }]);
    gauge('controltower_event_backlog', 'Flight events waiting to be written to the database.', [{ labels: {}, value: this.src.pendingEvents() }]);
    gauge('controltower_deployment_state', '0 = healthy, 1 = cooling down after upstream failures.', this.src.deployments().map((d) => ({ labels: { model: d.model, provider: d.provider }, value: d.coolingDown ? 1 : 0 })));
    gauge('controltower_mcp_server_up', '1 when the MCP server answered its last health check.', this.src.mcpServers().map((s) => ({ labels: { server: s.server }, value: s.up ? 1 : 0 })));
    const budgets = this.src.budgets();
    gauge('controltower_budget_limit_usd', 'Budget limit per scope (key:, team:, project:).', budgets.map((b) => ({ labels: { scope: b.scope }, value: b.limitUsd })));
    gauge('controltower_budget_spent_usd', 'Spend against the budget in the current period.', budgets.map((b) => ({ labels: { scope: b.scope }, value: b.spentUsd })));
    gauge('controltower_budget_remaining_usd', 'Budget left in the current period.', budgets.map((b) => ({ labels: { scope: b.scope }, value: Math.max(0, b.limitUsd - b.spentUsd) })));
    for (const m of [this.requests, this.tokens, this.spend, this.upstreamFailures, this.fallbacks, this.gateDecisions, this.approvals]) m.render(out);
    for (const h of [this.duration, this.ttft, this.overhead]) h.render(out);
    return out.join('\n') + '\n';
  }
}
