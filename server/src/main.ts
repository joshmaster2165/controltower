import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { copySqliteToPostgres } from './db/copy.js';
import { PgSink } from './events/pg-sink.js';
import type { EventSink } from './context.js';
import { decodeKey, keyId, loadOrCreateMasterKey, SecretBox } from './crypto/secrets.js';
import { Registry } from './registry.js';
import { Adapters } from './providers/index.js';
import { PricingTable } from './pricing/index.js';
import { MemoryLimiter, SpendTracker } from './limits/limiter.js';
import { Budgets } from './limits/budgets.js';
import { FlightBus } from './events/bus.js';
import { DbSink } from './events/db-sink.js';
import { EventRing } from './events/ring.js';
import { LiveFrames } from './admin/live.js';
import { PathsStore, postgresPaths } from './events/paths.js';
import { ModelChecker, ensureGuardrailKey } from './guardrails/model-check.js';
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
import { isSetupComplete, setupCode } from './admin/auth.js';
import type { AppContext } from './context.js';
import { ensurePlaygroundKey } from './admin/playground.js';
import { McpRegistry } from './mcp/registry.js';
import { HttpApiRegistry } from './http/registry.js';
import { AutoModels } from './models/auto.js';
import { AlertService } from './alerts/alerts.js';
import { smtpFromEnv } from './alerts/email.js';
import { startRetention } from './db/retention.js';
import { OpenFlights, startInstance } from './events/open-flights.js';
import { Cluster } from './cluster/cluster.js';
import { ModelHealth } from './models/health.js';
import { MemoryStore, RedisStore } from './cache/response-cache.js';
import { Exporter } from './exports/exporter.js';
import { GuardrailServices } from './guardrails/service-registry.js';
import { RedisLimiter } from './limits/redis-limiter.js';
import { checkMasterKey } from './db/master-key-check.js';
import { startKeyRetirement } from './admin/key-lifecycle.js';
import { describeProxy, outboundProxyFromEnv, useOutboundProxy } from './net/proxy.js';
import { Metrics } from './metrics/metrics.js';
import { ObservedStore } from './observe/observe.js';
import { NANO_PER_USD } from '@controltower/shared';
import { supportBundle } from './support/bundle.js';
import { AuditLog } from './ee/audit.js';
import { AuditShipper } from './ee/siem.js';
import { LICENSE_STORE, Licensing } from './ee/license.js';

const USAGE = `Control Tower — self-hosted AI gateway with a live map of your agents.

Usage: controltower [options]            (docker: pass the same options after the image name)

  --config, -c <file>   load a config.yaml at startup (models, fallbacks,
                        aliases, MCP servers, master_key, Slack alerting)
  --model <p/model>     serve one model with credentials from the environment
  --policy <file>       apply a policy YAML (zones and gates) at startup; CT_POLICY_MODE=replace
                        makes the policy match the file
  --port <n>            listen port (default 4000; also CT_PORT or PORT)
  --host <addr>         listen address (default 0.0.0.0)
  --copy-to-postgres <url>  copy this install's SQLite data (CT_DATA_DIR) into an empty Postgres
                        database, to run several instances on it; then exit
  --support-bundle [file]  write a report for whoever helps you with a problem — version, settings
                        by name, database, health and error counts; no keys, prompts or names —
                        to the file, or print it; then exit
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
  if (argv.includes('--copy-to-postgres')) {
    const next = argv[argv.indexOf('--copy-to-postgres') + 1];
    const url = next && !next.startsWith('-') ? next : config.databaseUrl;
    if (!url) throw new Error('--copy-to-postgres needs the Postgres URL: --copy-to-postgres postgres://…');
    process.stdout.write(`Copying ${config.dataDir}/controltower.db into Postgres…\n`);
    const counts = await copySqliteToPostgres(config.dataDir, url, (l) => process.stdout.write(`${l}\n`));
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    process.stdout.write(`Done: ${total.toLocaleString()} rows in ${Object.keys(counts).length} tables. Start every instance with CT_DATABASE_URL set to it and this install's CT_MASTER_KEY.\n`);
    process.exit(0);
  }
  if (argv.includes('--support-bundle')) {
    // Reads what is there and changes nothing: no master key or data directory is created for it.
    const mkFile = path.join(config.dataDir, 'master.key');
    const mkRaw = config.masterKeyEnv ?? (fs.existsSync(mkFile) ? fs.readFileSync(mkFile, 'utf8').trim() : undefined);
    const masterKey = mkRaw ? { id: keyId(decodeKey(mkRaw, 'master key')), source: config.masterKeyEnv ? 'env' : 'file' } : { id: '', source: 'none' };
    if (!config.databaseUrl && !fs.existsSync(path.join(config.dataDir, 'controltower.db'))) {
      process.stderr.write(`No Control Tower data in ${config.dataDir}. Run this where the server runs (docker exec / kubectl exec), with the same CT_DATA_DIR or CT_DATABASE_URL.\n`);
      process.exit(1);
    }
    const db = await openDatabase({ dataDir: config.dataDir, databaseUrl: config.databaseUrl });
    const bundle = JSON.stringify(await supportBundle(db, config, masterKey), null, 2);
    await db.close();
    const next = argv[argv.indexOf('--support-bundle') + 1];
    if (next && !next.startsWith('-')) {
      fs.writeFileSync(next, `${bundle}\n`);
      process.stderr.write(`Support bundle written to ${next}. Read it before sending it.\n`);
    } else process.stdout.write(`${bundle}\n`);
    process.exit(0);
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const uiDir = config.uiDir ?? [path.resolve(here, '../../ui/dist'), path.resolve(here, '../ui')].find((p) => fs.existsSync(path.join(p, 'index.html')));

  const proxy = outboundProxyFromEnv(process.env, config.port);
  useOutboundProxy(proxy);
  const mk = loadOrCreateMasterKey(config.dataDir, config.masterKeyEnv);
  const secrets = new SecretBox(mk);
  const db = await openDatabase({ dataDir: config.dataDir, databaseUrl: config.databaseUrl });
  if (db.dialect === 'postgres') console.warn(`[controltower] data in Postgres (${db.file})`);
  await checkMasterKey(db, mk.id);
  // Several instances share a Postgres database and stay in step over Redis; SQLite is one instance's own.
  if (config.redisUrl && db.dialect !== 'postgres') console.warn('[controltower] CT_REDIS_URL is ignored: several instances need a shared Postgres database (CT_DATABASE_URL); this one keeps its data in SQLite.');
  if (db.dialect === 'postgres' && !config.redisUrl) console.warn('[controltower] no CT_REDIS_URL: run one instance on this database, or set it so several share rate limits, caches and the live console.');
  const cluster = new Cluster(db.dialect === 'postgres' ? config.redisUrl : undefined, config.instanceId);
  await cluster.start();
  // This instance says it is alive; what stopped instances left open (a crash: calls with no outcome, held calls
  // no agent can come back to) is closed out now and every minute.
  const instance = startInstance(
    db.write,
    { id: cluster.id, host: cluster.host, version: config.version },
    (r) => console.warn(`[controltower] closed out what a stopped instance left open: ${r.flights} unfinished call(s) marked stopped, ${r.approvals} approval(s) expired`),
    (err) => console.error('[controltower] instance heartbeat:', (err as Error).message),
  );
  await instance.sweep();

  await ensurePlaygroundKey(db.write);
  await ensureGuardrailKey(db.write);
  const registry = new Registry(db.read, secrets);
  await registry.reload();

  const bus = new FlightBus();
  const dbSink: EventSink = db.dialect === 'postgres' ? new PgSink(db.pool!, cluster.id) : new DbSink(db.raw, cluster.id);
  const ring = new EventRing();
  bus.subscribe(dbSink.push);
  bus.subscribe(ring.push);
  const openFlights = new OpenFlights();
  bus.subscribe(openFlights.push);
  const live = new LiveFrames(bus);
  const paths = new PathsStore(db.dialect === 'postgres' ? await postgresPaths(db.pool!) : db.raw);
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
    publicUrl: config.publicUrl ?? `http://localhost:${config.port}`,
    policyRevision: () => policy.version,
  });

  // Flight records to customers' own monitoring (OpenTelemetry, Datadog, Splunk, S3, webhooks).
  const exporter = new Exporter({ db: db.write, secrets, version: config.version, instance: cluster.shared ? cluster.id : undefined, log: () => logRef ?? (console as unknown as import('fastify').FastifyBaseLogger) });
  await exporter.reload();
  bus.subscribe(exporter.push);
  exporter.start();

  const guardrails = new GuardrailServices(db.write, secrets);
  await guardrails.reload();
  const guardrailSaver = setInterval(() => void guardrails.save(), 15_000);
  guardrailSaver.unref?.();

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
  // With a shared database, spend is exchanged more often so every instance meters the same budget.
  budgets.startPersisting(db.dialect === 'postgres' ? 3_000 : 10_000);

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
  const license = new Licensing(db.write, config.licenseKey);
  const ls = await license.load();
  if (ls.status === 'invalid') console.warn(`[controltower] license: ${ls.reason}`);
  else if (ls.license) console.warn(`[controltower] Enterprise license for ${ls.license.customer}: ${ls.status}, until ${new Date(ls.license.expires_at).toISOString().slice(0, 10)}`);
  // The audit log to SIEMs, from each destination's position in the log (Enterprise).
  const auditShipper = new AuditShipper({ db, destinations: () => exporter.auditDestinations(), allowed: () => license.allows('siem_export'), instanceId: cluster.id, version: config.version, log: () => logRef ?? (console as unknown as import('fastify').FastifyBaseLogger) });
  auditShipper.start();
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
    limiter: cluster.redis ? new RedisLimiter(cluster.redis) : new MemoryLimiter(),
    cache: cluster.redis ? new RedisStore(cluster.redis) : new MemoryStore(),
    exporter,
    auditShipper,
    guardrails,
    license,
    audit: new AuditLog(db, { warn: (o, m) => (logRef ?? console).warn?.(o, m) }, () => license.allows('audit')),
    spend,
    budgets,
    bus,
    dbSink,
    ring,
    live,
    paths,
    modelChecker: new ModelChecker(),
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
  // Renewals: daily, from the license service, unless CT_LICENSE_SERVER=off (air-gapped).
  license.startRefresh(config.licenseServer === 'off' ? undefined : (config.licenseServer ?? LICENSE_STORE ?? undefined), app.log);
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
      setupCode: setupCode(full),
    }),
  );

  mcp.startHealthLoop();
  http.startHealthLoop();
  a2a.startHealthLoop();
  // Models, checked in the background so one that stops answering shows before an agent's call fails on it.
  // With several instances, whichever holds the lock checks; the others read the result from the database.
  const modelHealth = new ModelHealth({
    db: db.write,
    registry,
    adapters,
    log: app.log,
    onChange: (d, label, r) => {
      alerts.probe({ kind: 'deployment', id: d.id }, label, r.health === 'ok', r.detail);
      void registry.reload().catch(() => undefined);
    },
    isLeader: cluster.redis
      ? async () => {
          const redis = cluster.redis!;
          const lockMs = Math.max(60_000, config.modelHealthIntervalMs * 2);
          if ((await redis.set('ct:lead:model-health', cluster.id, 'PX', lockMs, 'NX')) === 'OK') return true;
          if ((await redis.get('ct:lead:model-health')) !== cluster.id) return false;
          await redis.pexpire('ct:lead:model-health', lockMs);
          return true;
        }
      : undefined,
  });
  (ctx as AppContext).modelHealth = modelHealth;
  modelHealth.start(config.modelHealthIntervalMs);

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
  const stopRetirement = startKeyRetirement(
    full,
    (retired, days) => app.log.info({ retired: retired.map((k) => k.name), days }, 'keys retired after going unused'),
    (err) => app.log.warn({ err }, 'key retirement pass failed'),
  );
  // Keep the instances in step: caches reload together, consoles hear every bump and see every instance's traffic,
  // and a card decided on one instance releases the call held on another.
  cluster.syncReloads({ registry, mcp, http, a2a, policy, budgets, alerts, exporter, guardrails });
  cluster.syncVersions({ approvals: approvalsVersion, alerts: alertsVersion, observed: observedVersion, views: viewsVersion });
  if (cluster.shared) {
    live.onLocal = (m) => cluster.publish('live', m);
    cluster.on('live', (m) => live.receive(m));
    approvals.onDecided = (id, status) => cluster.publish('approval', { id, status });
    cluster.on('approval', (p: { id: string; status: 'approved' | 'denied' }) => approvals.decidedElsewhere(p.id, p.status));
    console.warn(`[controltower] instance ${cluster.id}: sharing Postgres and Redis with other instances`);
  }

  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    full.shuttingDown = true;
    app.log.info({ signal }, 'shutting down: draining holds, finishing streams');
    full.demo?.stop();
    full.approvals.drain();
    approvals.stop();
    alerts.stop();
    modelHealth.stop();
    await exporter.stop();
    await auditShipper.stop();
    clearInterval(guardrailSaver);
    await guardrails.save();
    observed.stop();
    mcp.stop();
    http.stop();
    a2a.stop();
    live.stop();
    const grace = new Promise<void>((r) => setTimeout(r, config.shutdownGraceMs));
    await Promise.race([app.close(), grace]);
    // Calls the grace period cut off are recorded as stopped, not left running.
    const cut = openFlights.closeAll(bus);
    if (cut) app.log.info({ calls: cut }, 'shutdown: calls still in flight recorded as stopped');
    await dbSink.flush();
    await paths.stop();
    await budgets.stop();
    clearInterval(checkpoint);
    stopRetention();
    stopRetirement();
    await instance.stop();
    await cluster.stop();
    await db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[controltower] fatal:', err);
  process.exit(1);
});
