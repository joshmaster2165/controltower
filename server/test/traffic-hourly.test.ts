import { describe, expect, it } from 'vitest';
import { openSqlite } from '../src/db/index.js';
import { DbSink } from '../src/events/db-sink.js';
import type { FlightEvent } from '@controltower/shared';

const H = 3_600_000;

describe('hourly traffic summary', () => {
  it('counts each path per hour as calls complete, the same as counting the raw calls', () => {
    const db = openSqlite('', { memory: true });
    const sink = new DbSink(db.raw);
    const t0 = Date.UTC(2026, 8, 27, 10, 15);
    let n = 0;
    const call = (o: { ts: number; key: string; model?: string; server?: string; tool?: string; status: string; cost?: number; rule?: string; held?: boolean; behalf?: string[] }) => {
      const id = `f${++n}`;
      const events: FlightEvent[] = [
        { t: 'flight.started', flight_id: id, ts: o.ts, key_id: o.key, key_name: o.key, kind: o.server ? 'mcp.tool' : 'chat', dialect: o.server ? 'mcp' : 'openai-chat', model_requested: o.model ?? `${o.server}__${o.tool}`, ...(o.server ? { mcp_server_id: o.server, tool: o.tool } : { deployment_id: 'dep1' }), ...(o.behalf ? { on_behalf_of: o.behalf } : {}), est_input_tokens: 1, projected_nanousd: 0 } as never,
        ...(o.rule ? [{ t: 'flight.decision', flight_id: id, ts: o.ts, decision: o.held ? 'hold' : 'deny', rule_id: o.rule } as never] : []),
        ...(o.held ? [{ t: 'flight.held', flight_id: id, ts: o.ts, approval_id: `apr_${id}`, budget_ms: 1000, summary: 's' } as never] : []),
        { t: 'flight.completed', flight_id: id, ts: o.ts + 50, status: o.status, http_status: 200, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, usage_source: 'provider', cost_nanousd: o.cost ?? 100, cost_confidence: 'exact', duration_ms: 50, gateway_overhead_ms: 0 } as never,
      ];
      for (const e of events) sink.push(e);
    };
    call({ ts: t0, key: 'a', model: 'gpt', status: 'ok' });
    call({ ts: t0 + 60_000, key: 'a', model: 'gpt', status: 'error' });
    call({ ts: t0 + 2 * H, key: 'a', model: 'gpt', status: 'ok', cost: 300 });
    call({ ts: t0, key: 'b', server: 'crm', tool: 'delete', status: 'denied', rule: 'r1' });
    call({ ts: t0, key: 'b', server: 'crm', tool: 'delete', status: 'ok', rule: 'r2', held: true, behalf: ['boss'] });
    call({ ts: t0, key: 'b', server: 'crm', tool: 'delete', status: 'rejected' });
    sink.flush();

    const rows = db.raw.prepare('SELECT * FROM traffic_hourly ORDER BY bucket, key_id, rule_id').all() as Array<Record<string, unknown>>;
    const gpt = rows.filter((r) => r.key_id === 'a');
    expect(gpt.map((r) => [r.bucket, r.requests, r.errors, r.cost_nanousd, r.deployment_id])).toEqual([
      [Math.floor(t0 / H) * H, 2, 1, 200, 'dep1'],
      [Math.floor(t0 / H) * H + 2 * H, 1, 0, 300, 'dep1'],
    ]);
    const crm = rows.filter((r) => r.key_id === 'b');
    expect(crm.map((r) => [r.rule_id, r.requests, r.denied, r.rejected, r.held, r.on_behalf_of, r.tool])).toEqual([
      ['', 1, 0, 1, 0, '', 'delete'],
      ['r1', 1, 1, 0, 0, '', 'delete'],
      ['r2', 1, 0, 0, 1, '["boss"]', 'delete'],
    ]);
    // The summary agrees with counting the raw calls.
    const raw = db.raw.prepare("SELECT key_id, COUNT(*) AS n, SUM(cost_nanousd) AS c FROM flights GROUP BY key_id ORDER BY key_id").all();
    const sum = db.raw.prepare('SELECT key_id, SUM(requests) AS n, SUM(cost_nanousd) AS c FROM traffic_hourly GROUP BY key_id ORDER BY key_id').all();
    expect(sum).toEqual(raw);
  });
});
