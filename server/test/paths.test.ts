import { describe, expect, it } from 'vitest';
import type { FlightEvent } from '@controltower/shared';
import { openSqlite } from '../src/db/index.js';
import { PathsStore } from '../src/events/paths.js';

const started = (id: string, ts: number, extra: Partial<Extract<FlightEvent, { t: 'flight.started' }>>): FlightEvent => ({
  t: 'flight.started',
  flight_id: id,
  ts,
  key_id: 'k1',
  key_name: 'k1',
  kind: 'mcp.tool',
  dialect: 'mcp',
  stream: false,
  model_requested: '',
  est_input_tokens: 0,
  projected_nanousd: 0,
  ...extra,
});

describe('paths', () => {
  it('records when each agent first and last used a connection, and keeps it across restarts', () => {
    const db = openSqlite('', { memory: true });
    const paths = new PathsStore(db.raw);
    expect(paths.since).toBeNull();
    paths.push(started('f1', 1000, { agent_id: 'bot', mcp_server_id: 'srv', tool: 'merge_pr' }));
    paths.push(started('f2', 5000, { agent_id: 'bot', mcp_server_id: 'srv', tool: 'merge_pr' }));
    paths.push(started('f3', 2000, { key_id: 'k2', deployment_id: 'dep' })); // no agent id: the key stands in
    expect(paths.get('bot', 'srv', 'merge_pr')).toEqual({ first: 1000, last: 5000 });
    expect(paths.get('k2', 'dep', null)).toEqual({ first: 2000, last: 2000 });
    expect(paths.since).toBe(1000);
    paths.stop(); // flushes

    const again = new PathsStore(db.raw);
    expect(again.get('bot', 'srv', 'merge_pr')).toEqual({ first: 1000, last: 1000 + 4000 });
    expect(again.since).toBe(1000);
    again.stop();
  });

  it('fills from flights already recorded when the table is created', () => {
    const db = openSqlite('', { memory: true });
    // The migration ran on an empty database; run its backfill again over a recorded flight.
    db.raw.prepare("INSERT INTO flights (id, ts, key_id, key_name, agent_id, kind, dialect, model_requested, mcp_server_id, tool, stream) VALUES ('f', 42, 'k', 'k', 'bot', 'mcp.tool', 'mcp', '', 'srv', 'search', 0)").run();
    db.raw.exec(`INSERT INTO paths (agent, target, tool, first_seen, last_seen)
      SELECT COALESCE(agent_id, key_id), COALESCE(mcp_server_id, deployment_id), COALESCE(tool, ''), MIN(ts), MAX(ts) FROM flights
      WHERE key_id IS NOT NULL AND COALESCE(mcp_server_id, deployment_id) IS NOT NULL GROUP BY 1, 2, 3`);
    const paths = new PathsStore(db.raw);
    expect(paths.get('bot', 'srv', 'search')).toEqual({ first: 42, last: 42 });
    paths.stop();
  });
});
