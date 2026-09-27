import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import pg from 'pg';
import { Kysely, PostgresDialect, SqliteDialect } from 'kysely';
import type { Database as Schema } from './schema.js';
import { migrations, toPostgres } from './migrations.js';
import { setDialect, type Dialect } from './sqlfn.js';

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
}

/** Open the database Control Tower is configured for: Postgres when a URL is given, else SQLite in the data directory. */
export async function openDatabase(o: { dataDir: string; databaseUrl?: string | undefined }): Promise<Db> {
  return o.databaseUrl ? openPostgres(o.databaseUrl) : openSqlite(o.dataDir);
}

/**
 * Postgres: every instance shares it. Migrations run under an advisory lock so instances starting together
 * don't race. 64-bit integers and numerics come back as JavaScript numbers, as they do from SQLite.
 */
export async function openPostgres(url: string): Promise<Db> {
  pg.types.setTypeParser(20, (v) => Number(v)); // int8 (BIGINT, COUNT)
  pg.types.setTypeParser(1700, (v) => Number(v)); // numeric (SUM of BIGINT)
  const pool = new pg.Pool({ connectionString: url, max: Number(process.env.CT_DB_POOL ?? 20), ...(/sslmode=require/.test(url) ? { ssl: { rejectUnauthorized: false } } : {}) });
  pool.on('error', (err) => console.error('[db] idle connection error:', err.message));
  await migratePostgres(pool);
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
  };
}

async function migratePostgres(pool: pg.Pool): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock(7461230)');
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (version BIGINT PRIMARY KEY, name TEXT NOT NULL, applied_at BIGINT NOT NULL)');
    const applied = new Set((await c.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map((r) => Number(r.version)));
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

export function openSqlite(dataDir: string, opts: { file?: string; memory?: boolean } = {}): Db {
  let file: string;
  if (opts.memory) {
    file = ':memory:';
  } else {
    fs.mkdirSync(dataDir, { recursive: true });
    file = opts.file ?? path.join(dataDir, 'controltower.db');
  }

  const raw = new Database(file);
  for (const p of PRAGMAS_WRITE) raw.pragma(p);
  migrate(raw);

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

function migrate(raw: Database.Database): void {
  raw.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
  const applied = new Set(
    (raw.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version),
  );
  const insert = raw.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)');
  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    const run = raw.transaction(() => {
      raw.exec(m.sqlite);
      insert.run(m.version, m.name, Date.now());
    });
    run();
  }
}
