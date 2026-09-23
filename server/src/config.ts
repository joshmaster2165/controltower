import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export interface Config {
  version: string;
  port: number;
  host: string;
  dataDir: string;
  databaseUrl: string | undefined;
  demo: boolean;
  /** Add a deployment the first time a request names a model a connected provider serves. */
  autoModels: boolean;
  /** `off` disables policy enforcement entirely (kill switch). */
  mode: 'on' | 'off';
  publicUrl: string | undefined;
  /** Bearer token Prometheus uses to scrape /metrics (admins may also scrape with their session). */
  metricsToken: string | undefined;
  masterKeyEnv: string | undefined;
  shutdownGraceMs: number;
  maxHeld: number;
  holdBudgetMs: number;
  logLevel: string;
  sessionTtlMs: number;
  /** Serve the built UI from this directory (relative to cwd or absolute). */
  uiDir: string | undefined;
}

function int(v: string | undefined, d: number): number {
  const n = v == null ? NaN : Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}

function bool(v: string | undefined, d = false): boolean {
  if (v == null || v === '') return d;
  return /^(1|true|yes|on)$/i.test(v);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = path.resolve(env.CT_DATA_DIR ?? './data');
  return {
    version: pkg.version,
    // PORT is what most platforms (Render, Railway, Fly, Heroku-likes) hand the app.
    port: int(env.CT_PORT || env.PORT, 4000),
    host: env.CT_HOST ?? '0.0.0.0',
    dataDir,
    databaseUrl: env.CT_DATABASE_URL || undefined,
    demo: bool(env.CT_DEMO),
    autoModels: bool(env.CT_AUTO_MODELS, true),
    mode: env.CT_MODE === 'off' ? 'off' : 'on',
    publicUrl: env.CT_PUBLIC_URL || env.RENDER_EXTERNAL_URL || (env.FLY_APP_NAME ? `https://${env.FLY_APP_NAME}.fly.dev` : undefined),
    metricsToken: env.CT_METRICS_TOKEN || undefined,
    masterKeyEnv: env.CT_MASTER_KEY || undefined,
    shutdownGraceMs: int(env.CT_SHUTDOWN_GRACE_MS, 15_000),
    maxHeld: int(env.CT_MAX_HELD, 500),
    holdBudgetMs: int(env.CT_HOLD_BUDGET_MS, 20_000),
    logLevel: env.CT_LOG_LEVEL ?? (env.NODE_ENV === 'production' ? 'info' : 'debug'),
    sessionTtlMs: int(env.CT_SESSION_TTL_MS, 7 * 24 * 3600 * 1000),
    uiDir: env.CT_UI_DIR ? path.resolve(env.CT_UI_DIR) : undefined,
  };
}
