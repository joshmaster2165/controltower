import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import type { Registry } from './registry.js';
import type { Adapters } from './providers/index.js';
import type { AutoModels } from './models/auto.js';
import type { PricingTable } from './pricing/index.js';
import type { Limiter, SpendTracker } from './limits/limiter.js';
import type { Budgets } from './limits/budgets.js';
import type { FlightBus } from './events/bus.js';
import type { DbSink } from './events/db-sink.js';
import type { EventRing } from './events/ring.js';
import type { LiveFrames } from './admin/live.js';
import type { PolicyEngine } from './policy/engine.js';
import type { Approvals } from './policy/approvals.js';
import type { SecretBox } from './crypto/secrets.js';
import type { Versioned } from './util/versioned.js';
import type { DemoFleet } from './demo/fleet.js';
import type { McpRegistry } from './mcp/registry.js';
import type { HttpApiRegistry } from './http/registry.js';
import type { AlertService } from './alerts/alerts.js';
import type { Metrics } from './metrics/metrics.js';
import type { ObservedStore } from './observe/observe.js';

/** Everything a request handler may touch. Built once in main.ts. */
export interface AppContext {
  config: Config;
  db: Db;
  secrets: SecretBox;
  registry: Registry;
  adapters: Adapters;
  /** Adds deployments on first use for models a connected provider serves. */
  autoModels: AutoModels;
  pricing: PricingTable;
  limiter: Limiter;
  spend: SpendTracker;
  budgets: Budgets;
  bus: FlightBus;
  dbSink: DbSink;
  ring: EventRing;
  /** Summed live frames for the console's WebSocket. */
  live: LiveFrames;
  policy: PolicyEngine;
  approvals: Approvals;
  /** Bumped whenever the approvals queue changes; the console re-fetches. */
  approvalsVersion: Versioned;
  mcp: McpRegistry;
  /** Plain HTTP APIs proxied at /http/<slug>/…; treated as tool servers everywhere else. */
  http: HttpApiRegistry;
  alerts: AlertService;
  /** Bumped when an alert fires or alert configuration changes. */
  alertsVersion: Versioned;
  metrics: Metrics;
  observed: ObservedStore;
  /** Bumped when observed (non-gateway) systems or paths appear. */
  observedVersion: Versioned;
  demo: DemoFleet | undefined;
  log: FastifyBaseLogger;
  startedAt: number;
  shuttingDown: boolean;
}
