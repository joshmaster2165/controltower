import { sql } from 'kysely';
import type { AppContext } from '../context.js';
import type { PolicyService } from '../policy/policy.js';
import { seedDemo, seedDemoPolicy, DEMO_ALIASES, DEMO_DEPLOYMENTS } from './seed.js';
import { seedDemoMcp, seedDemoMcpPolicy, seedDemoAlerts, seedDemoInspectGates, DEMO_MCP_IDS } from './mcp-servers.js';
import { seedDemoHttp } from './http-apis.js';
import { DemoFleet } from './fleet.js';

/**
 * Demo mode, switchable at runtime: at boot with CT_DEMO=1, or from the
 * console ("Fill the map with a demo fleet" / "Stop demo and clear it").
 * Every demo row is tagged demo=1, so stopping removes exactly what starting added.
 */
let unsubscribeApprover: (() => void) | undefined;

async function reloadAll(ctx: AppContext): Promise<void> {
  await ctx.mcp.reload();
  await ctx.http.reload();
  await ctx.registry.reload();
  await (ctx.policy as PolicyService).reload();
  await ctx.alerts.reload();
}

/** Refused start: demo names already used by the real setup. */
export class DemoConflict extends Error {
  constructor(readonly names: string[]) {
    super(`Demo mode would reuse names your setup already has (${names.join(', ')}). Demo agents must never reach real models or tools, so it stays off. Try it on a fresh install.`);
  }
}

/**
 * Names the demo fleet calls by. If a real model, alias or tool server already
 * has one, demo traffic could land on it — so the demo refuses to start instead.
 */
function conflicts(ctx: AppContext): string[] {
  const out: string[] = [];
  for (const d of DEMO_DEPLOYMENTS) {
    const real = ctx.registry.deploymentsByPublicName.get(d.upstream);
    if (real && !real.demo) out.push(d.upstream);
  }
  for (const a of DEMO_ALIASES) {
    const real = ctx.registry.aliasesByName.get(a.name);
    if (real && real.id !== a.id) out.push(a.name);
  }
  for (const slug of [...Object.keys(DEMO_MCP_IDS), 'statuspage']) {
    const m = ctx.mcp.bySlug.get(slug);
    const h = ctx.http.bySlug.get(slug);
    if ((m && !m.demo) || (h && !h.demo)) out.push(slug);
  }
  return out;
}

export async function startDemo(ctx: AppContext): Promise<void> {
  if (ctx.demo) return;
  const clash = conflicts(ctx);
  if (clash.length) throw new DemoConflict(clash);
  const base = `http://127.0.0.1:${ctx.config.port}`;
  const keys = await seedDemo(ctx.db.write, ctx.secrets);
  await seedDemoPolicy(ctx.db.write);
  await seedDemoMcp(ctx.db.write, base);
  await seedDemoMcpPolicy(ctx.db.write);
  await seedDemoInspectGates(ctx.db.write);
  await seedDemoAlerts(ctx.db.write);
  await seedDemoHttp(ctx.db.write, ctx.secrets, base);
  await reloadAll(ctx);
  // Demo approver: answers demo agents' held flights after ~8–12 s unless a human got there first.
  // Never anyone else's: a real agent held by a real gate waits for a real person, demo or not.
  unsubscribeApprover = ctx.bus.subscribe((e) => {
    if (e.t !== 'flight.held' || e.budget_ms === 0) return;
    const t = setTimeout(() => {
      void (async () => {
        const row = await ctx.db.read.selectFrom('approvals').select(['demo', 'status']).where('id', '=', e.approval_id).executeTakeFirst();
        if (row?.demo !== 1 || row.status !== 'pending') return;
        await ctx.approvals.decide(e.approval_id, 'demo-approver', Math.random() < 0.85 ? 'approve' : 'deny', { note: 'auto-decided by the demo approver' });
      })().catch(() => undefined);
    }, 8000 + Math.random() * 4000);
    t.unref?.();
  });
  const fleet = new DemoFleet(base, keys, ctx.log);
  ctx.demo = fleet;
  fleet.start();
  ctx.log.info('demo started');
}

/** Stops the fleet and removes every demo row, including the traffic it generated. */
export async function stopDemo(ctx: AppContext): Promise<void> {
  ctx.demo?.stop();
  ctx.demo = undefined;
  unsubscribeApprover?.();
  unsubscribeApprover = undefined;
  const w = ctx.db.write;
  for (const table of ['api_keys', 'aliases', 'deployments', 'providers', 'rules', 'zones', 'approvals', 'mcp_servers', 'http_apis', 'alert_rules'] as const) {
    await w.deleteFrom(table).where('demo', '=', 1).execute();
  }
  await sql`DELETE FROM flights WHERE key_id LIKE 'key_demo_%'`.execute(w);
  await sql`DELETE FROM flight_events WHERE flight_id NOT IN (SELECT id FROM flights)`.execute(w);
  await sql`DELETE FROM usage_hourly WHERE key_id LIKE 'key_demo_%'`.execute(w);
  await sql`DELETE FROM usage_daily WHERE key_id LIKE 'key_demo_%'`.execute(w);
  await sql`DELETE FROM observed_hourly WHERE key_id LIKE 'key_demo_%'`.execute(w);
  await sql`DELETE FROM observed_targets WHERE target NOT IN (SELECT DISTINCT target FROM observed_hourly)`.execute(w);
  await reloadAll(ctx);
  ctx.observedVersion.bump();
  ctx.log.info('demo stopped and cleared');
}
