import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { openSqlite } from './db/index.js';
import { loadOrCreateMasterKey, SecretBox } from './crypto/secrets.js';
import { Registry } from './registry.js';
import { Adapters } from './providers/index.js';
import { PricingTable } from './pricing/index.js';
import { MemoryLimiter, SpendTracker } from './limits/limiter.js';
import { Budgets } from './limits/budgets.js';
import { FlightBus } from './events/bus.js';
import { DbSink } from './events/db-sink.js';
import { EventRing } from './events/ring.js';
import { PolicyService } from './policy/policy.js';
import { ApprovalService } from './policy/approvals.js';
import { Versioned } from './util/versioned.js';
import { buildApp } from './app.js';
import type { AppContext } from './context.js';
import { seedDemo, seedDemoPolicy } from './demo/seed.js';
import { DemoFleet } from './demo/fleet.js';
import { ensurePlaygroundKey } from './admin/playground.js';
import { McpRegistry } from './mcp/registry.js';
import { seedDemoMcp, seedDemoMcpPolicy, seedDemoAlerts } from './demo/mcp-servers.js';
import { AlertService } from './alerts/alerts.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const here = path.dirname(fileURLToPath(import.meta.url));
  const uiDir = config.uiDir ?? [path.resolve(here, '../../ui/dist'), path.resolve(here, '../ui')].find((p) => fs.existsSync(path.join(p, 'index.html')));

  const mk = loadOrCreateMasterKey(config.dataDir, config.masterKeyEnv);
  const secrets = new SecretBox(mk);
  const db = openSqlite(config.dataDir);

  await ensurePlaygroundKey(db.write);
  const registry = new Registry(db.read, secrets);
  await registry.reload();

  const bus = new FlightBus();
  const dbSink = new DbSink(db.raw);
  const ring = new EventRing();
  bus.subscribe(dbSink.push);
  bus.subscribe(ring.push);

  const mcp = new McpRegistry(db.write, secrets);
  await mcp.reload();
  const policy = new PolicyService(db.read, registry, () => config.mode === 'on');
  await policy.reload();
  const approvalsVersion = new Versioned();
  let logRef: import('fastify').FastifyBaseLogger | undefined;
  const approvals = new ApprovalService(db.write, bus, approvalsVersion, () => logRef ?? (console as unknown as import('fastify').FastifyBaseLogger), {
    holdBudgetMs: config.holdBudgetMs,
    maxHeld: config.maxHeld,
    publicUrl: config.publicUrl,
    policyRevision: () => policy.version,
  });

  const alertsVersion = new Versioned();
  const alerts = new AlertService(db.write, secrets, alertsVersion, {
    publicUrl: config.publicUrl ?? `http://localhost:${config.port}`,
    gate: (id) => {
      const r = policy.rules.find((x) => x.id === id);
      return r ? { name: r.name, effect: r.effect } : undefined;
    },
    log: () => logRef ?? (console as unknown as import('fastify').FastifyBaseLogger),
  });
  await alerts.reload();
  bus.subscribe(alerts.push);

  const spend = new SpendTracker();
  const budgets = new Budgets(db.write, spend);
  await budgets.reload();
  budgets.startPersisting();

  const ctx: Omit<AppContext, 'log'> = {
    config,
    db,
    secrets,
    registry,
    adapters: new Adapters(),
    pricing: new PricingTable(),
    limiter: new MemoryLimiter(),
    spend,
    budgets,
    bus,
    dbSink,
    ring,
    policy,
    approvals,
    approvalsVersion,
    mcp,
    alerts,
    alertsVersion,
    demo: undefined,
    startedAt: Date.now(),
    shuttingDown: false,
  };

  const app = await buildApp(ctx, { uiDir });
  const full = ctx as AppContext;
  logRef = app.log;
  approvals.start();
  alerts.start();

  if (mk.source === 'generated') {
    app.log.warn(`Generated a new master key at ${mk.file}. BACK IT UP: provider credentials are unreadable without it.`);
  }
  if (!fs.existsSync(config.dataDir)) fs.mkdirSync(config.dataDir, { recursive: true });

  await app.listen({ port: config.port, host: config.host });
  const url = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`;
  app.log.info(`Control Tower ${config.version} listening on ${url}  (ui: ${uiDir ?? 'not built'})`);

  if (config.demo) {
    const keys = await seedDemo(db.write, secrets);
    await seedDemoPolicy(db.write);
    await seedDemoMcp(db.write, `http://127.0.0.1:${config.port}`);
    await seedDemoMcpPolicy(db.write);
    await seedDemoAlerts(db.write);
    await mcp.reload();
    await registry.reload();
    await policy.reload();
    await alerts.reload();
    // Demo approver: answers held flights after ~8–12 s unless a human got there first.
    bus.subscribe((e) => {
      if (e.t !== 'flight.held' || e.budget_ms === 0) return;
      const t = setTimeout(() => {
        void approvals.decide(e.approval_id, 'demo-approver', Math.random() < 0.85 ? 'approve' : 'deny', { note: 'auto-decided by the demo approver' }).catch(() => undefined);
      }, 8000 + Math.random() * 4000);
      t.unref?.();
    });
    const fleet = new DemoFleet(`http://127.0.0.1:${config.port}`, keys, app.log);
    full.demo = fleet;
    fleet.start();
  }

  mcp.startHealthLoop();

  const checkpoint = setInterval(() => {
    try {
      db.checkpoint('PASSIVE');
    } catch (err) {
      app.log.warn({ err }, 'wal checkpoint failed');
    }
  }, 60_000);
  checkpoint.unref?.();

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    full.shuttingDown = true;
    app.log.info({ signal }, 'shutting down: draining holds, finishing streams');
    full.demo?.stop();
    full.approvals.drain();
    approvals.stop();
    alerts.stop();
    mcp.stop();
    const grace = new Promise<void>((r) => setTimeout(r, config.shutdownGraceMs));
    await Promise.race([app.close(), grace]);
    dbSink.flush();
    await budgets.stop();
    clearInterval(checkpoint);
    db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[controltower] fatal:', err);
  process.exit(1);
});
