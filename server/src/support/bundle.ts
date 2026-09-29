import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'kysely';
import type { Db } from '../db/index.js';
import type { Config } from '../config.js';
import { scrub } from '../providers/adapter.js';

/**
 * `--support-bundle`: what someone helping with a problem needs to know about this install, as JSON — and
 * nothing they shouldn't see. Settings are reported by name (values only for the harmless ones), providers
 * and tool servers by kind and health, traffic as counts and error codes. Never keys, credentials, prompts,
 * answers, URLs of your own systems, or names of your agents and people.
 */

/** Settings whose values are safe to show; every other CT_* setting is reported as set or not. */
const SHOWN = new Set([
  'CT_PORT', 'PORT', 'CT_HOST', 'CT_LOG_LEVEL', 'CT_MODE', 'CT_POLICY_MODE', 'CT_DEMO', 'CT_AUTO_MODELS', 'CT_RETENTION_DAYS', 'CT_EVENT_RETENTION_DAYS',
  'CT_HOLD_BUDGET_MS', 'CT_MAX_HELD', 'CT_SESSION_TTL_MS', 'CT_SESSION_IDLE_MS', 'CT_LOGIN_RPM', 'CT_MODEL_HEALTH_INTERVAL_S', 'CT_PUSH_ALLOW_PRIVATE',
  'CT_A2A_PUSH_RELAY', 'CT_SHUTDOWN_GRACE_MS', 'CT_INSTANCE_TIMEOUT_MS', 'CT_DB_POOL', 'CT_IN_CONTAINER', 'NODE_ENV',
]);
/** Settings outside CT_* worth knowing about (whether they're set, never their values). */
const ALSO = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'UI_USERNAME', 'UI_PASSWORD', 'DATABASE_URL'];

/** Free text from the database (a provider's last error, say): secrets and every URL removed. */
function clean(s: string | null | undefined): string | null {
  if (!s) return null;
  return scrub(s.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, '<url>')).slice(0, 200);
}

async function count(db: Db, table: string): Promise<number | null> {
  try {
    const r = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM ${sql.table(table)}`.execute(db.read);
    return Number(r.rows[0]?.n ?? 0);
  } catch {
    return null;
  }
}

export async function supportBundle(db: Db, config: Config, masterKey: { id: string; source: string }): Promise<Record<string, unknown>> {
  const env = process.env;
  const settings: Record<string, string> = {};
  for (const name of Object.keys(env).filter((k) => k.startsWith('CT_')).concat(ALSO).sort()) {
    if (env[name] === undefined || env[name] === '') continue;
    settings[name] = SHOWN.has(name) ? String(env[name]) : 'set';
  }

  const since = Date.now() - 24 * 3600_000;
  const r = db.read;
  const migrations = await r.selectFrom('schema_migrations').select(({ fn }) => [fn.max('version').as('latest'), fn.countAll().as('applied')]).executeTakeFirst();
  const tables: Record<string, number | null> = {};
  for (const t of ['providers', 'deployments', 'aliases', 'api_keys', 'rules', 'zones', 'mcp_servers', 'http_apis', 'a2a_agents', 'admins', 'alert_rules', 'export_destinations', 'guardrail_services', 'customers', 'flights', 'flight_events', 'approvals']) {
    tables[t] = await count(db, t);
  }
  let databaseBytes: number | null = null;
  if (db.dialect === 'sqlite') {
    databaseBytes = 0;
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        databaseBytes += fs.statSync(path.join(config.dataDir, `controltower.db${suffix}`)).size;
      } catch {
        /* not there */
      }
    }
  }

  const providers = await r.selectFrom('providers').select(['kind', 'extra', 'health', 'health_detail', 'demo', 'source']).execute();
  const mcp = await r.selectFrom('mcp_servers').select(['health', 'health_detail']).execute();
  const exportsRows = await r.selectFrom('export_destinations').select(['kind', 'enabled', 'last_status', 'last_error', 'last_sent_at']).execute();
  const guardrails = await r.selectFrom('guardrail_services').select(['kind', 'enabled']).execute();
  const instances = await r.selectFrom('instances').select(['version', 'started_at', 'last_seen']).execute();

  const byStatus = await r.selectFrom('flights').select(['kind', 'status', ({ fn }) => fn.countAll<number>().as('n')]).where('ts', '>=', since).groupBy(['kind', 'status']).execute();
  const errors = await r
    .selectFrom('flights')
    .select(['error_code', 'http_status', ({ fn }) => fn.countAll<number>().as('n'), ({ fn }) => fn.max('ts').as('last')])
    .where('ts', '>=', since)
    .where('error_code', 'is not', null)
    .groupBy(['error_code', 'http_status'])
    .orderBy('n', 'desc')
    .limit(25)
    .execute();

  const extraOf = (e: unknown): Record<string, unknown> => (typeof e === 'string' ? (JSON.parse(e || '{}') as Record<string, unknown>) : ((e ?? {}) as Record<string, unknown>));
  return {
    about: 'Control Tower support bundle. It lists settings by name and counts, with no keys, credentials, prompts, answers, hostnames or names of agents and people. Read it before sending it.',
    generated_at: new Date().toISOString(),
    version: config.version,
    runtime: { node: process.version, platform: `${os.platform()} ${os.release()}`, arch: os.arch(), cpus: os.cpus().length, memory_gb: Math.round(os.totalmem() / 1e8) / 10, container: !!env.CT_IN_CONTAINER },
    settings,
    master_key: { source: masterKey.source, fingerprint: masterKey.id },
    database: { dialect: db.dialect, migrations: { latest: Number(migrations?.latest ?? 0), applied: Number(migrations?.applied ?? 0) }, bytes: databaseBytes, rows: tables },
    instances: instances.map((i) => ({ version: i.version, started_at: new Date(i.started_at).toISOString(), last_seen: new Date(i.last_seen).toISOString() })),
    providers: providers.map((p) => ({ kind: p.kind, catalog: extraOf(p.extra).catalog_id ?? null, health: p.health, detail: clean(p.health_detail), demo: !!p.demo, from_config_file: p.source === 'config' })),
    mcp_servers: mcp.map((m) => ({ health: m.health, detail: clean(m.health_detail) })),
    exports: exportsRows.map((e) => ({ kind: e.kind, enabled: !!e.enabled, last_status: e.last_status, last_error: clean(e.last_error), last_sent_at: e.last_sent_at ? new Date(e.last_sent_at).toISOString() : null })),
    guardrail_services: guardrails.map((g) => ({ kind: g.kind, enabled: !!g.enabled })),
    last_24h: {
      calls: byStatus.map((b) => ({ kind: b.kind, status: b.status, count: Number(b.n) })),
      errors: errors.map((e) => ({ code: e.error_code, http_status: e.http_status, count: Number(e.n), last: e.last ? new Date(Number(e.last)).toISOString() : null })),
    },
  };
}
