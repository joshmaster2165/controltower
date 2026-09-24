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
  /** A config.yaml loaded at boot (`--config`); the file is the source of truth for what it declares. */
  configFile: string | undefined;
  /** `--model provider/model`: serve one model with credentials from the environment (quick start). */
  quickModel: string | undefined;
  /** Policy YAML applied at every start (--policy / CT_POLICY), merged or replacing the policy. */
  policyFile: string | undefined;
  policyMode: 'merge' | 'replace';
  /** Days to keep per-request rows (flights / their event trail); 0 keeps them forever. */
  retention: { flightsDays: number; eventsDays: number };
  /**
   * Admin API key: a bearer token for the admin API and
   * the /key and /model management routes, an all-access key for model
   * and tool calls, and the console password for UI_USERNAME. From CT_ADMIN_KEY,
   * or general_settings.master_key in the --config file (LITELLM_MASTER_KEY is accepted too).
   */
  adminKey: string | undefined;
  /** Console sign-in created from the admin key (UI_USERNAME / UI_PASSWORD). */
  uiUsername: string;
  uiPassword: string | undefined;
  /** Settings seen but not used, reported once at startup. */
  notices: string[];
}

/** `--flag value`, `--flag=value` and bare `--flag`. */
function flags(argv: string[]): Map<string, string | true> {
  const out = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('-')) continue;
    const eq = a.indexOf('=');
    const name = (eq > 0 ? a.slice(0, eq) : a).replace(/^-+/, '');
    if (eq > 0) out.set(name, a.slice(eq + 1));
    else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('-')) out.set(name, argv[++i]!);
    else out.set(name, true);
  }
  return out;
}

function int(v: string | undefined, d: number): number {
  const n = v == null ? NaN : Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}

function bool(v: string | undefined, d = false): boolean {
  if (v == null || v === '') return d;
  return /^(1|true|yes|on)$/i.test(v);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv.slice(2)): Config {
  const f = flags(argv);
  const val = (...names: string[]) => {
    for (const n of names) {
      const v = f.get(n);
      if (typeof v === 'string') return v;
    }
    return undefined;
  };
  const notices: string[] = [];
  if (f.has('num_workers')) notices.push('--num_workers is not needed: Control Tower runs as one process (scale with more instances).');
  if (env.DATABASE_URL && !env.CT_DATABASE_URL) notices.push('DATABASE_URL is not used: Control Tower keeps its data in SQLite under CT_DATA_DIR (/data in the container).');
  if (env.STORE_MODEL_IN_DB) notices.push('STORE_MODEL_IN_DB is not needed: models added in the console are always stored.');
  const logEnv = env.LITELLM_LOG ? env.LITELLM_LOG.toLowerCase() : undefined;
  const debug = f.has('detailed_debug') || f.has('debug');
  const dataDir = path.resolve(env.CT_DATA_DIR ?? './data');
  const configFile = val('config', 'c') ?? env.CT_CONFIG ?? env.CONFIG_FILE_PATH;
  return {
    version: pkg.version,
    // PORT is what most platforms (Render, Railway, Fly, Heroku-likes) hand the app.
    port: int(val('port', 'p') ?? (env.CT_PORT || env.PORT), 4000),
    host: val('host') ?? env.CT_HOST ?? '0.0.0.0',
    dataDir,
    databaseUrl: env.CT_DATABASE_URL || undefined,
    demo: bool(env.CT_DEMO),
    autoModels: bool(env.CT_AUTO_MODELS, true),
    mode: env.CT_MODE === 'off' ? 'off' : 'on',
    // Detected on Render, Fly.io and Railway (once the service has a public domain).
    publicUrl:
      env.CT_PUBLIC_URL ||
      env.RENDER_EXTERNAL_URL ||
      (env.FLY_APP_NAME ? `https://${env.FLY_APP_NAME}.fly.dev` : undefined) ||
      (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : undefined),
    metricsToken: env.CT_METRICS_TOKEN || undefined,
    masterKeyEnv: env.CT_MASTER_KEY || undefined,
    shutdownGraceMs: int(env.CT_SHUTDOWN_GRACE_MS, 15_000),
    maxHeld: int(env.CT_MAX_HELD, 500),
    holdBudgetMs: int(env.CT_HOLD_BUDGET_MS, 20_000),
    logLevel: debug ? 'debug' : (env.CT_LOG_LEVEL ?? (logEnv && ['debug', 'info', 'warn', 'error'].includes(logEnv) ? logEnv : undefined) ?? (env.NODE_ENV === 'production' ? 'info' : 'debug')),
    sessionTtlMs: int(env.CT_SESSION_TTL_MS, 7 * 24 * 3600 * 1000),
    uiDir: env.CT_UI_DIR ? path.resolve(env.CT_UI_DIR) : undefined,
    configFile: configFile ? path.resolve(configFile) : undefined,
    quickModel: val('model', 'm'),
    policyFile: (val('policy') ?? env.CT_POLICY) ? path.resolve((val('policy') ?? env.CT_POLICY)!) : undefined,
    policyMode: env.CT_POLICY_MODE === 'replace' ? 'replace' : 'merge',
    retention: { flightsDays: Math.max(0, int(env.CT_RETENTION_DAYS, 30)), eventsDays: Math.max(0, int(env.CT_EVENT_RETENTION_DAYS, 7)) },
    adminKey: env.CT_ADMIN_KEY || env.LITELLM_MASTER_KEY || undefined,
    uiUsername: env.UI_USERNAME || 'admin',
    uiPassword: env.UI_PASSWORD || undefined,
    notices,
  };
}
