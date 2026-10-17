import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import pg from 'pg';
import { Kysely, PostgresDialect, SqliteDialect } from 'kysely';
import type { Database as Schema } from './schema.js';
import { migrations, toPostgres } from './migrations.js';
import { setDialect, type Dialect } from './sqlfn.js';
import { backupBeforeMigrate, guardNewer, LATEST_SCHEMA, recordedVersion, releaseOfSchema, type UpgradeInfo } from './upgrade.js';

export interface Db {
  /** SQLite (one instance, the default) or Postgres (CT_DATABASE_URL; several instances can share it). */
  dialect: Dialect;
  /** Kysely over the write connection (Postgres: the pool). */
  write: Kysely<Schema>;
  /** Kysely over a read-only connection (WAL allows concurrent readers); Postgres: the same pool. */
  read: Kysely<Schema>;
  /** Raw better-sqlite3 write handle for the hot-path batch sink (SQLite only). */
  raw: Database.Database;
  /** The connection pool (Postgres only): the batched event writer talks to it directly. */
  pool?: pg.Pool;
  file: string;
  close(): void | Promise<void>;
  checkpoint(mode?: 'PASSIVE' | 'TRUNCATE'): void;
  walBytes(): number;
  /** What this start did to the schema (and the backup it took first). */
  upgrade: UpgradeInfo;
}

/** How a server start upgrades its data: its version, and whether to back up first (SQLite). Tools and tests omit it. */
export interface UpgradeOptions {
  appVersion: string;
  backup: boolean;
  keep: number;
}

/** Open the database Control Tower is configured for: Postgres when a URL is given, else SQLite in the data directory. */
export async function openDatabase(o: { dataDir: string; databaseUrl?: string | undefined; upgrade?: UpgradeOptions | undefined }): Promise<Db> {
  return o.databaseUrl ? openPostgres(o.databaseUrl, o.upgrade) : openSqlite(o.dataDir, o.upgrade ? { upgrade: o.upgrade } : {});
}

/**
 * Postgres: every instance shares it. Migrations run under an advisory lock so instances starting together
 * don't race. 64-bit integers and numerics come back as JavaScript numbers, as they do from SQLite.
 */
export async function openPostgres(url: string, upgrade?: UpgradeOptions): Promise<Db> {
  pg.types.setTypeParser(20, (v) => Number(v)); // int8 (BIGINT, COUNT)
  pg.types.setTypeParser(1700, (v) => Number(v)); // numeric (SUM of BIGINT)
  const pool = new pg.Pool({ connectionString: url, max: Number(process.env.CT_DB_POOL ?? 20), ...(/sslmode=require/.test(url) ? { ssl: { rejectUnauthorized: false } } : {}) });
  pool.on('error', (err) => console.error('[db] idle connection error:', err.message));
  const info = await migratePostgres(pool, upgrade);
  setDialect('postgres');
  const k = new Kysely<Schema>({ dialect: new PostgresDialect({ pool }) });
  const shown = url.replace(/\/\/[^@/]*@/, '//***@');
  return {
    dialect: 'postgres',
    pool,
    write: k,
    read: k,
    get raw(): Database.Database {
      throw new Error('no raw SQLite handle: this Control Tower uses Postgres');
    },
    file: shown,
    close: () => pool.end(),
    checkpoint() {},
    walBytes: () => 0,
    upgrade: info,
  };
}

async function migratePostgres(pool: pg.Pool, upgrade?: UpgradeOptions): Promise<UpgradeInfo> {
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock(7461230)');
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (version BIGINT PRIMARY KEY, name TEXT NOT NULL, applied_at BIGINT NOT NULL)');
    const applied = new Set((await c.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map((r) => Number(r.version)));
    // What ran here last: recorded at each start, or (data from before that) the last instance's heartbeat.
    const recorded =
      (await c
        .query<{ value: string }>("SELECT value FROM settings WHERE key = 'app.version'")
        .then((r) => (r.rows[0] ? (JSON.parse(r.rows[0].value) as string) : null))
        .catch(() => null)) ??
      (await c
        .query<{ version: string }>('SELECT version FROM instances WHERE version IS NOT NULL ORDER BY last_seen DESC LIMIT 1')
        .then((r) => r.rows[0]?.version ?? null)
        .catch(() => null)) ??
      releaseOfSchema(Math.max(0, ...applied));
    guardNewer(applied, { appVersion: upgrade?.appVersion, recorded });
    const from = Math.max(0, ...applied);
    // Postgres is backed up with the database provider's snapshots, not by Control Tower.
    if (upgrade && applied.size && migrations.some((m) => !applied.has(m.version))) console.warn(`[db] upgrading the Postgres schema ${from} → ${LATEST_SCHEMA} for Control Tower ${upgrade.appVersion}: take a snapshot with your database provider first if you want to be able to go back.`);
    for (const m of migrations) {
      if (applied.has(m.version)) continue;
      await c.query('BEGIN');
      try {
        await c.query(m.postgres ?? toPostgres(m.sqlite));
        await c.query('INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, $3)', [m.version, m.name, Date.now()]);
        await c.query('COMMIT');
      } catch (err) {
        await c.query('ROLLBACK');
        throw new Error(`migration ${m.version} (${m.name}) failed on Postgres: ${(err as Error).message}`);
      }
    }
    return { from_schema: from, to_schema: LATEST_SCHEMA, from_version: recorded, backup: null };
  } finally {
    await c.query('SELECT pg_advisory_unlock(7461230)').catch(() => undefined);
    c.release();
  }
}

const PRAGMAS_WRITE = [
  'journal_mode = WAL',
  'synchronous = NORMAL',
  'foreign_keys = ON',
  'busy_timeout = 5000',
  'cache_size = -65536',
  'mmap_size = 268435456',
  'wal_autocheckpoint = 2000',
  'auto_vacuum = INCREMENTAL',
  'temp_store = MEMORY',
];

export function openSqlite(dataDir: string, opts: { file?: string; memory?: boolean; upgrade?: UpgradeOptions } = {}): Db {
  let file: string;
  if (opts.memory) {
    file = ':memory:';
  } else {
    fs.mkdirSync(dataDir, { recursive: true });
    file = opts.file ?? path.join(dataDir, 'controltower.db');
  }

  const raw = new Database(file);
  for (const p of PRAGMAS_WRITE) raw.pragma(p);
  const info = migrate(raw, opts.memory ? undefined : file, opts.upgrade);

  // In-memory databases cannot be shared across connections; reuse the handle.
  const rawRead = opts.memory ? raw : new Database(file, { readonly: true });
  if (!opts.memory) {
    rawRead.pragma('busy_timeout = 5000');
    rawRead.pragma('cache_size = -32768');
  }

  setDialect('sqlite');
  const write = new Kysely<Schema>({ dialect: new SqliteDialect({ database: raw }) });
  const read = new Kysely<Schema>({ dialect: new SqliteDialect({ database: rawRead }) });

  return {
    dialect: 'sqlite',
    write,
    read,
    raw,
    file,
    close() {
      try {
        if (!opts.memory) raw.pragma('wal_checkpoint(TRUNCATE)');
      } catch {
        /* ignore */
      }
      if (rawRead !== raw) rawRead.close();
      raw.close();
    },
    upgrade: info,
    checkpoint(mode = 'PASSIVE') {
      if (!opts.memory) raw.pragma(`wal_checkpoint(${mode})`);
    },
    walBytes() {
      if (opts.memory) return 0;
      try {
        return fs.statSync(`${file}-wal`).size;
      } catch {
        return 0;
      }
    },
  };
}

function migrate(raw: Database.Database, file?: string, upgrade?: UpgradeOptions): UpgradeInfo {
  raw.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
  const applied = new Set(
    (raw.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version),
  );
  const recorded = recordedVersion(raw);
  guardNewer(applied, { appVersion: upgrade?.appVersion, recorded, backupDir: file ? path.join(path.dirname(file), 'backups') : undefined });
  const from = Math.max(0, ...applied);
  // Something to apply, to data that already has some: copy it first (a new install has nothing to lose).
  let backup: string | null = null;
  if (upgrade?.backup && file && applied.size && migrations.some((m) => !applied.has(m.version))) {
    backup = backupBeforeMigrate(raw, file, { fromSchema: from, fromVersion: recorded, toVersion: upgrade.appVersion, keep: upgrade.keep });
  }
  const insert = raw.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)');
  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    const run = raw.transaction(() => {
      raw.exec(m.sqlite);
      insert.run(m.version, m.name, Date.now());
    });
    run();
  }
  return { from_schema: from, to_schema: LATEST_SCHEMA, from_version: recorded, backup };
}
