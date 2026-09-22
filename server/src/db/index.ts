import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import type { Database as Schema } from './schema.js';
import { migrations } from './migrations.js';

export interface Db {
  /** Kysely over the single write connection. */
  write: Kysely<Schema>;
  /** Kysely over a read-only connection (WAL allows concurrent readers). */
  read: Kysely<Schema>;
  /** Raw better-sqlite3 write handle for the hot-path batch sink. */
  raw: Database.Database;
  file: string;
  close(): void;
  checkpoint(mode?: 'PASSIVE' | 'TRUNCATE'): void;
  walBytes(): number;
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

  const write = new Kysely<Schema>({ dialect: new SqliteDialect({ database: raw }) });
  const read = new Kysely<Schema>({ dialect: new SqliteDialect({ database: rawRead }) });

  return {
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
