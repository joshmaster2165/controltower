import { describe, expect, it } from 'vitest';
import { Metrics } from '../src/metrics/metrics.js';

describe('prometheus metrics', () => {
  it('counts requests, tokens, spend and decisions with bounded labels', () => {
    const m = new Metrics({
      version: '0.1.0',
      startedAt: Date.now(),
      modelName: (id) => (id === 'dep_fast' ? 'mock-fast' : undefined),
      providerKind: () => 'mock',
      mcpName: (id) => (id === 'mcp_crm' ? 'crm' : undefined),
      gateName: (id) => (id === 'rule_x' ? 'Block secrets' : undefined),
      heldRequests: () => 2,
      pendingEvents: () => 0,
      deployments: () => [{ model: 'mock-fast', provider: 'mock', coolingDown: true }],
      mcpServers: () => [{ server: 'crm', up: true }],
      budgets: () => [{ scope: 'team:growth', limitUsd: 10, spentUsd: 4 }],
    });
    const base = { kind: 'chat' as const, dialect: 'openai-chat' as const, stream: true, est_input_tokens: 1, projected_nanousd: 0, key_id: 'k', key_name: 'researcher', team: 'product' };
    m.push({ t: 'flight.started', flight_id: 'a', ts: 1, model_requested: 'fast', deployment_id: 'dep_fast', provider_kind: 'mock', ...base });
    m.push({ t: 'flight.completed', flight_id: 'a', ts: 2, status: 'ok', http_status: 200, deployment_id: 'dep_fast', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, usage_source: 'provider', cost_nanousd: 1_500_000_000, cost_confidence: 'exact', ttft_ms: 300, duration_ms: 1200, gateway_overhead_ms: 1 });
    // A made-up model name must not create a new series.
    m.push({ t: 'flight.started', flight_id: 'b', ts: 1, model_requested: 'gpt-made-up-123', ...base });
    m.push({ t: 'flight.decision', flight_id: 'b', ts: 1, decision: 'deny', rule_id: 'rule_x' });
    m.push({ t: 'flight.completed', flight_id: 'b', ts: 2, status: 'denied', http_status: 400, usage_source: 'unknown', cost_nanousd: null, cost_confidence: 'unknown', duration_ms: 3, gateway_overhead_ms: 1 });
    const text = m.render();
    expect(text).toContain('controltower_requests_total{agent="researcher",team="product",kind="chat",model="mock-fast",provider="mock",status="ok"} 1');
    expect(text).toContain('controltower_requests_total{agent="researcher",team="product",kind="chat",model="other",provider="mock",status="denied"} 1');
    expect(text).not.toContain('gpt-made-up-123');
    expect(text).toContain('controltower_tokens_total{agent="researcher",model="mock-fast",type="output"} 5');
    expect(text).toContain('controltower_spend_usd_total{agent="researcher",team="product",model="mock-fast"} 1.5');
    expect(text).toContain('controltower_gate_decisions_total{gate="Block secrets",decision="deny"} 1');
    expect(text).toContain('controltower_request_duration_seconds_bucket{kind="chat",model="mock-fast",provider="mock",le="2"} 1');
    expect(text).toContain('controltower_request_duration_seconds_bucket{kind="chat",model="mock-fast",provider="mock",le="1"} 0');
    expect(text).toContain('controltower_time_to_first_token_seconds_count{model="mock-fast",provider="mock"} 1');
    expect(text).toContain('controltower_deployment_state{model="mock-fast",provider="mock"} 1');
    expect(text).toContain('controltower_budget_remaining_usd{scope="team:growth"} 6');
    expect(text).toContain('controltower_held_requests 2');
    // Every sample line is `name{labels} value` or `name value`.
    for (const line of text.trim().split('\n')) if (!line.startsWith('#')) expect(line).toMatch(/^[a-z_]+(\{.*\})? [-0-9.e+]+$/);
  });
});
