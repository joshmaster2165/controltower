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
import { LiveFrames } from './admin/live.js';
import { PathsStore } from './events/paths.js';
import { Delegations } from './policy/delegation.js';
import { A2aRegistry } from './a2a/registry.js';
import { PolicyService } from './policy/policy.js';
import { ApprovalService } from './policy/approvals.js';
import { Versioned } from './util/versioned.js';
import { buildApp } from './app.js';
import { startDemo } from './demo/control.js';
import { BootConfigError, loadBootConfig } from './importers/boot.js';
import { applyAdminKey } from './admin/admin-key.js';
import { BootPolicyError, loadBootPolicy } from './policy/boot.js';
import { startupBanner } from './banner.js';
import { isSetupComplete } from './admin/auth.js';
import type { AppContext } from './context.js';
import { ensurePlaygroundKey } from './admin/playground.js';
import { McpRegistry } from './mcp/registry.js';
import { HttpApiRegistry } from './http/registry.js';
import { AutoModels } from './models/auto.js';
import { AlertService } from './alerts/alerts.js';
import { smtpFromEnv } from './alerts/email.js';
import { startRetention } from './db/retention.js';
import { describeProxy, outboundProxyFromEnv, useOutboundProxy } from './net/proxy.js';
import { Metrics } from './metrics/metrics.js';
import { ObservedStore } from './observe/observe.js';
import { NANO_PER_USD } from '@controltower/shared';

const USAGE = `Control Tower — self-hosted AI gateway with a live map of your agents.

Usage: controltower [options]            (docker: pass the same options after the image name)

  --config, -c <file>   load a config.yaml at startup (models, fallbacks,
                        aliases, MCP servers, master_key, Slack alerting)
  --model <p/model>     serve one model with credentials from the environment
  --policy <file>       apply a policy YAML (zones and gates) at startup; CT_POLICY_MODE=replace
                        makes the policy match the file
  --port <n>            listen port (default 4000; also CT_PORT or PORT)
  --host <addr>         listen address (default 0.0.0.0)
  --detailed_debug      verbose logs (also --debug)
  --version             print the version

Environment: CT_ADMIN_KEY sets the admin key. Every setting:\nhttps://github.com/joshmaster2165/controltower/blob/main/docs/configuration.md`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  const config = loadConfig();
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${config.version}\n`);
    process.exit(0);
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const uiDir = config.uiDir ?? [path.resolve(here, '../../ui/dist'), path.resolve(here, '../ui')].find((p) => fs.existsSync(path.join(p, 'index.html')));

  const proxy = outboundProxyFromEnv(process.env, config.port);
  useOutboundProxy(proxy);
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
  const live = new LiveFrames(bus);
  const paths = new PathsStore(db.raw);
  bus.subscribe(paths.push);

  const mcp = new McpRegistry(db.write, secrets);
  await mcp.reload();
  const http = new HttpApiRegistry(db.write, secrets);
  const a2a = new A2aRegistry(db.write, secrets);
  await a2a.reload();
  await http.reload();
  const policy = new PolicyService(db.read, () => config.mode === 'on');
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
    smtp: smtpFromEnv(),
    gate: (id) => {
      const r = policy.rules.find((x) => x.id === id);
      return r ? { name: r.name, effect: r.effect } : undefined;
    },
    names: (kind, id) => {
      if (kind === 'key') return registry.keysById.get(id)?.name;
      if (kind === 'mcp') return mcp.servers.get(id)?.name ?? http.apis.get(id)?.name ?? a2a.agents.get(id)?.name;
      const d = registry.deployments.get(id);
      return d ? (d.publicName ?? d.upstreamModel) : undefined;
    },
    budget: (scope) => {
      const b = spend.get(scope);
      return b ? { limitNanousd: b.limitNanousd, spentNanousd: b.spent, resetsAt: b.resetsAt, period: b.period } : undefined;
    },
    log: () => logRef ?? (console as unknown as import('fastify').FastifyBaseLogger),
  });
  await alerts.reload();
  bus.subscribe(alerts.push);

  const spend = new SpendTracker();
  const budgets = new Budgets(db.write, spend);
  await budgets.reload();
  budgets.startPersisting();

  const startedAt = Date.now();
  const metrics = new Metrics({
    version: config.version,
    startedAt,
    modelName: (id) => {
      const d = id ? registry.deployments.get(id) : undefined;
      return d ? (d.publicName ?? d.upstreamModel) : undefined;
    },
    providerKind: (id) => (id ? registry.providers.get(id)?.kind : undefined),
    mcpName: (id) => (id ? (mcp.servers.get(id)?.slug ?? http.apis.get(id)?.slug ?? a2a.agents.get(id)?.slug) : undefined),
    gateName: (id) => policy.rules.find((r) => r.id === id)?.name,
    heldRequests: () => approvals.heldCount,
    pendingEvents: () => dbSink.pendingCount,
    deployments: () =>
      [...registry.deployments.values()].map((d) => ({ model: d.publicName ?? d.upstreamModel, provider: registry.providers.get(d.providerId)?.kind ?? '', coolingDown: (d.coolingUntil ?? 0) > Date.now() })),
    mcpServers: () => [...[...mcp.servers.values()].map((s) => ({ server: s.slug, up: s.health === 'ok' })), ...[...http.apis.values()].map((a) => ({ server: a.slug, up: a.health === 'ok' }))],
    budgets: () =>
      budgets.snapshot().map((b) => {
        const [type, id] = [b.scope.slice(0, b.scope.indexOf(':')), b.scope.slice(b.scope.indexOf(':') + 1)];
        const scope = type === 'key' ? `key:${registry.keysById.get(id)?.name ?? id}` : b.scope;
        return { scope, limitUsd: b.limit_nanousd / NANO_PER_USD, spentUsd: b.spent_nanousd / NANO_PER_USD };
      }),
  });
  bus.subscribe(metrics.push);
  const observedVersion = new Versioned();
  const viewsVersion = new Versioned();
  const observed = new ObservedStore(db.write, observedVersion);

  const adapters = new Adapters();
  const pricing = new PricingTable();
  const autoModels = new AutoModels({ db: db.write, registry, pricing, adapters, enabled: config.autoModels }, (msg) => (logRef ?? console).info?.(msg));

  const ctx: Omit<AppContext, 'log'> = {
    config,
    db,
    secrets,
    registry,
    adapters,
    autoModels,
    pricing,
    limiter: new MemoryLimiter(),
    spend,
    budgets,
    bus,
    dbSink,
    ring,
    live,
    paths,
    delegations: new Delegations(secrets.deriveKey('delegation')),
    a2a,
    policy,
    approvals,
    approvalsVersion,
    mcp,
    http,
    alerts,
    alertsVersion,
    metrics,
    observed,
    observedVersion,
    viewsVersion,
    demo: undefined,
    startedAt,
    shuttingDown: false,
  };

  const app = await buildApp(ctx, { uiDir });
  const full = ctx as AppContext;
  logRef = app.log;
  // The config file (--config / --model), then the admin key it or the environment sets.
  try {
    await loadBootConfig(full);
  } catch (err) {
    if (err instanceof BootConfigError) {
      app.log.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  await applyAdminKey(full);
  try {
    await loadBootPolicy(full);
  } catch (err) {
    if (err instanceof BootPolicyError) {
      app.log.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  for (const n of config.notices) app.log.warn(n);
  if (proxy) app.log.info({ no_proxy: proxy.noProxy }, `outbound requests go through ${describeProxy(proxy)}`);
  // In a container, a data directory on the image's own filesystem disappears with the container.
  if (fs.existsSync('/.dockerenv') || process.env.CT_IN_CONTAINER === '1') {
    try {
      if (fs.statSync(config.dataDir).dev === fs.statSync('/').dev) {
        app.log.warn(`${config.dataDir} is not on a volume: the database and master key are lost when this container is removed. Mount one, e.g. -v controltower-data:${config.dataDir}`);
      }
    } catch {
      /* data dir checks are advisory */
    }
  }
  approvals.start();
  alerts.start();
  observed.start();

  if (mk.source === 'generated') {
    app.log.warn(`Generated a new master key at ${mk.file}. BACK IT UP: provider credentials are unreadable without it.`);
  }
  if (!fs.existsSync(config.dataDir)) fs.mkdirSync(config.dataDir, { recursive: true });

  await app.listen({ port: config.port, host: config.host });
  const url = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`;
  app.log.info(`Control Tower ${config.version} listening on ${url}  (ui: ${uiDir ?? 'not built'})`);

  if (config.demo) {
    try {
      await startDemo(full);
    } catch (err) {
      app.log.warn(`CT_DEMO=1 ignored: ${(err as Error).message}`);
    }
  }

  process.stdout.write(
    startupBanner({
      version: config.version,
      url: config.publicUrl ?? url,
      setupDone: await isSetupComplete(full),
      dataDir: config.dataDir,
      masterKey: mk.source === 'env' ? 'CT_MASTER_KEY' : (mk.file ?? `${config.dataDir}/master.key`),
      demo: full.demo !== undefined,
      inContainer: fs.existsSync('/.dockerenv'),
      signIn: config.adminKey ? `${config.uiUsername} / ${config.uiPassword ? 'UI_PASSWORD' : 'the admin key'}` : undefined,
    }),
  );

  mcp.startHealthLoop();
  http.startHealthLoop();
  a2a.startHealthLoop();

  const checkpoint = setInterval(() => {
    try {
      db.checkpoint('PASSIVE');
    } catch (err) {
      app.log.warn({ err }, 'wal checkpoint failed');
    }
  }, 60_000);
  checkpoint.unref?.();

  let stopping = false;
  const stopRetention = startRetention(
    db.write,
    config.retention,
    (deleted) => app.log.info({ deleted }, 'retention: old rows removed'),
    (err) => app.log.warn({ err }, 'retention pass failed'),
  );
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    full.shuttingDown = true;
    app.log.info({ signal }, 'shutting down: draining holds, finishing streams');
    full.demo?.stop();
    full.approvals.drain();
    approvals.stop();
    alerts.stop();
    observed.stop();
    mcp.stop();
    http.stop();
    a2a.stop();
    live.stop();
    const grace = new Promise<void>((r) => setTimeout(r, config.shutdownGraceMs));
    await Promise.race([app.close(), grace]);
    dbSink.flush();
    paths.stop();
    await budgets.stop();
    clearInterval(checkpoint);
    stopRetention();
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
