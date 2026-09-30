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
import type { EventRing } from './events/ring.js';
import type { LiveFrames } from './admin/live.js';
import type { PathsStore } from './events/paths.js';
import type { ModelChecker } from './guardrails/model-check.js';
import type { Delegations } from './policy/delegation.js';
import type { A2aRegistry } from './a2a/registry.js';
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
  /** Guardrail services inspect gates can ask. */
  guardrails?: import('./guardrails/service-registry.js').GuardrailServices;
  /** Who changed what, and who tried (admin API, sign-ins, single sign-on). */
  audit?: import('./ee/audit.js').AuditLog;
  /** The Enterprise license in force, and which features it turns on. */
  license: import('./ee/license.js').Licensing;
  /** Flight records sent to customers' own monitoring. */
  exporter?: import('./exports/exporter.js').Exporter;
  /** Requests against the license's yearly allowance (Enterprise; warns, never limits). */
  metering?: import('./ee/metering.js').Metering;
  /** Whether the server's clock has been set back (licenses are checked against it). */
  clock?: import('./ee/clock.js').ClockWatch;
  /** The control plane of a multi-region deployment: sends regions their configuration (Enterprise). */
  controlPlane?: import('./ee/multi-region/control-plane.js').ControlPlane;
  /** Rate limits that count other regions' traffic too (multi-region, Enterprise). */
  sharedLimiter?: import('./ee/multi-region/shared-limits.js').SharedLimiter;
  /** On the control plane: what each region hasn't heard yet about the others' traffic. */
  limitExchange?: import('./ee/multi-region/shared-limits.js').LimitExchange;
  /** On the control plane: how the console reaches into regions (Enterprise). */
  regionHub?: import('./ee/multi-region/hub.js').RegionHub;
  /** On a control plane shared by several instances: pass a region's live frame to the others too. */
  liveRelay?: (m: import('@controltower/shared').WsServerMessage) => void;
  /** In a region: the secret that marks a question from the control plane, run in-process (never leaves it). */
  internalSecret?: string;
  /** This install is a region: its configuration comes from the control plane (Enterprise). */
  regionSync?: import('./ee/multi-region/region.js').RegionSync;
  /** Organisations, teams and who belongs to them (Enterprise). */
  orgs?: import('./ee/orgs.js').Orgs;
  /** This instance's id (shared by name with the others on the database). */
  instanceId?: string;
  /** Agents authenticating with tokens from a trusted issuer (Enterprise). */
  tokens?: import('./ee/tokens.js').TokenAuth;
  /** The audit log to SIEMs (Enterprise). */
  auditShipper?: import('./ee/siem.js').AuditShipper;
  /** Cached answers, for models that opt in. */
  cache?: import('./cache/response-cache.js').CacheStore;
  /** Background health checks of models. */
  modelHealth?: import('./models/health.js').ModelHealth;
  pricing: PricingTable;
  limiter: Limiter;
  spend: SpendTracker;
  budgets: Budgets;
  bus: FlightBus;
  dbSink: EventSink;
  ring: EventRing;
  /** Summed live frames for the console's WebSocket. */
  live: LiveFrames;
  /** Every connection agents have used, with first and last use. */
  paths: PathsStore;
  /** Model-based prompt-injection checks for inspect gates that ask for them. */
  modelChecker: ModelChecker;
  /** Signs and checks delegation tokens (agents calling agents). */
  delegations: Delegations;
  /** Remote agents reached over A2A, served at /a2a/<slug>. */
  a2a: A2aRegistry;
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
  /** Bumped when Airspace views change, so open consoles refresh the map. */
  viewsVersion: Versioned;
  demo: DemoFleet | undefined;
  log: FastifyBaseLogger;
  startedAt: number;
  shuttingDown: boolean;
}

/** Where flight events are written: SQLite's DbSink or Postgres's PgSink. */
export interface EventSink {
  push: (e: import('@controltower/shared').FlightEvent) => void;
  flush(): void | Promise<void>;
  readonly pendingCount: number;
  backpressure: boolean;
  flushedEvents: number;
}
