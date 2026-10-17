import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { migrations } from './migrations.js';

/**
 * Upgrading safely.
 *
 * - **Downgrade guard:** data a newer Control Tower has already upgraded is refused by an older one (its schema has
 *   migrations this version doesn't know), with what to run instead or which backup to restore. Otherwise an older
 *   version would start on it and quietly misbehave.
 * - **Backup before upgrading (SQLite):** when a new version is about to change the database, it first copies it to
 *   `<data>/backups/` (VACUUM INTO: a consistent, compact copy), after checking there's room. A fresh install has
 *   nothing to back up. Postgres is backed up with the provider's own snapshots; Control Tower says so in the log.
 * - **Restore:** `--restore <file>` puts a backup back (the current database is kept beside it).
 */
export const LATEST_SCHEMA = Math.max(...migrations.map((m) => m.version));
export const BACKUP_DIR = 'backups';

export interface UpgradeInfo {
  /** The schema version before and after this start. Equal when nothing changed. */
  from_schema: number;
  to_schema: number;
  /** The Control Tower version that last ran on this data (recorded at each start), when known. */
  from_version: string | null;
  /** The backup taken before migrating, when one was. */
  backup: string | null;
}

export class NewerDataError extends Error {}

/**
 * Releases from before each start recorded its version (up to 0.2.13), by the newest schema they had: data from one
 * of them, after a clean stop, is known only by its schema. Fixed: every later release records its version.
 */
const RELEASES_BY_SCHEMA: Record<number, string> = { 7: '0.1.0-0.1.1', 8: '0.1.2-0.1.4', 12: '0.1.5', 14: '0.1.6', 23: '0.1.7-0.1.8', 34: '0.2.0-0.2.4', 35: '0.2.5', 36: '0.2.6-0.2.9', 41: '0.2.10-0.2.12', 42: '0.2.13' };
export const releaseOfSchema = (schema: number): string | null => RELEASES_BY_SCHEMA[schema] ?? null;
export class BackupSpaceError extends Error {}

/**
 * The version that last ran on this data: recorded at each start (from this version on). For data from before that:
 * the version the last instance still running reported in its heartbeat, or else the releases its schema belongs to.
 */
export function recordedVersion(raw: Database.Database): string | null {
  try {
    const row = raw.prepare("SELECT value FROM settings WHERE key = 'app.version'").get() as { value: string } | undefined;
    if (row) return JSON.parse(row.value) as string;
  } catch {
    /* no settings table yet */
  }
  try {
    const v = (raw.prepare('SELECT version FROM instances WHERE version IS NOT NULL ORDER BY last_seen DESC LIMIT 1').get() as { version: string } | undefined)?.version;
    if (v) return v;
  } catch {
    /* no instances table */
  }
  try {
    return releaseOfSchema((raw.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null }).v ?? 0);
  } catch {
    return null;
  }
}

/** Refuse data from a newer Control Tower. `applied` is what schema_migrations holds. */
export function guardNewer(applied: Iterable<number>, info: { appVersion?: string | undefined; recorded: string | null; backupDir?: string | undefined }): void {
  const max = Math.max(0, ...applied);
  if (max <= LATEST_SCHEMA) return;
  const backups = info.backupDir ? listBackups(info.backupDir).filter((b) => b.schema !== null && b.schema <= LATEST_SCHEMA) : [];
  throw new NewerDataError(
    [
      `This data was upgraded by a newer Control Tower${info.recorded ? ` (${info.recorded})` : ''}: its database is at schema ${max}, and this is ${info.appVersion ? `Control Tower ${info.appVersion}` : 'a version'} at schema ${LATEST_SCHEMA}. An older version can't safely run on it.`,
      `Run ${info.recorded ? `${info.recorded} or newer` : 'the newer version again'}.`,
      backups.length
        ? `Or, to go back to this version, restore a backup taken before that upgrade (what was written since is lost): controltower --restore ${backups[0]!.file}${backups.length > 1 ? ` (${backups.length} backups in ${info.backupDir})` : ''}`
        : 'There is no backup from before that upgrade in this data directory.',
    ].join('\n'),
  );
}

export interface BackupFile {
  file: string;
  name: string;
  size: number;
  created_at: number;
  /** Parsed from the name: the schema it holds, and the versions around the upgrade it was taken for. */
  schema: number | null;
  from_version: string | null;
  before_version: string | null;
}

const NAME = /^controltower-schema(\d+)(?:-v([\w.-]+?))?-before-v([\w.-]+?)-(\d{8}T\d{6}Z)\.db$/;

export function listBackups(dir: string): BackupFile[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.db'));
  } catch {
    return [];
  }
  return names
    .map((name) => {
      const file = path.join(dir, name);
      const st = fs.statSync(file);
      const m = NAME.exec(name);
      return { file, name, size: st.size, created_at: st.mtimeMs, schema: m ? Number(m[1]) : null, from_version: m?.[2] ?? null, before_version: m?.[3] ?? null };
    })
    .sort((a, b) => b.created_at - a.created_at);
}

/** Free bytes where `dir` is, or null when the platform can't say. */
function freeBytes(dir: string): number | null {
  try {
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}
const mb = (n: number) => `${Math.ceil(n / 1048576).toLocaleString()} MB`;

/**
 * Before migrating a SQLite database that has migrations to apply: copy it to `<dir>/backups`. Throws BackupSpaceError
 * when there isn't room (the server then doesn't start: better than upgrading with no way back). Keeps the newest
 * `keep` backups.
 */
export function backupBeforeMigrate(raw: Database.Database, file: string, o: { fromSchema: number; fromVersion: string | null; toVersion: string; keep: number }): string {
  const dir = path.join(path.dirname(file), BACKUP_DIR);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // The copy holds the pages in use (free ones are left out), plus whatever the write-ahead log still holds.
  const pageSize = Number(raw.pragma('page_size', { simple: true }));
  let size = (Number(raw.pragma('page_count', { simple: true })) - Number(raw.pragma('freelist_count', { simple: true }))) * pageSize;
  try {
    size += fs.statSync(`${file}-wal`).size;
  } catch {
    /* no WAL */
  }
  const free = freeBytes(dir);
  // The copy is at most the database's size (VACUUM drops free pages), plus room for the migration itself.
  const need = Math.ceil(size * 1.1) + 64 * 1048576;
  if (free !== null && free < need) {
    throw new BackupSpaceError(
      `Not enough free space to back up the database before upgrading to ${o.toVersion}: it needs about ${mb(need)} in ${dir}, and ${mb(free)} is free. ` +
        `Free some space (or give the volume more), then start again. To upgrade without a backup, set CT_BACKUP_BEFORE_UPGRADE=off.`,
    );
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const safe = (v: string) => v.replace(/[^\w.-]/g, '_');
  const out = path.join(dir, `controltower-schema${o.fromSchema}${o.fromVersion ? `-v${safe(o.fromVersion)}` : ''}-before-v${safe(o.toVersion)}-${stamp}.db`);
  raw.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
  fs.chmodSync(out, 0o600);
  // Only automatic backups are pruned: a database set aside by a restore stays until someone removes it.
  for (const old of listBackups(dir).filter((b) => b.schema !== null).slice(Math.max(1, o.keep))) fs.rmSync(old.file, { force: true });
  return out;
}

/**
 * Put a backup back in place of the database (`--restore <file>`). The current database moves into the backups
 * directory first, so nothing is thrown away. The server must be stopped.
 */
export function restoreBackup(dataDir: string, backup: string, Db: typeof Database): { replaced: string | null; schema: number; from_version: string | null } {
  if (!fs.existsSync(backup)) throw new Error(`no such file: ${backup}`);
  let schema = 0;
  const probe = new Db(backup, { readonly: true, fileMustExist: true });
  try {
    schema = Math.max(0, ...(probe.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version));
  } catch {
    throw new Error(`${backup} isn't a Control Tower database`);
  } finally {
    probe.close();
  }
  const file = path.join(dataDir, 'controltower.db');
  const dir = path.join(dataDir, BACKUP_DIR);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let replaced: string | null = null;
  if (fs.existsSync(file)) {
    // Fold the write-ahead log into the file, so the copy kept is complete.
    const cur = new Db(file);
    try {
      cur.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      cur.close();
    }
    replaced = path.join(dir, `controltower-replaced-by-restore-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.db`);
    fs.renameSync(file, replaced);
  }
  for (const f of [`${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
  fs.copyFileSync(backup, file);
  fs.chmodSync(file, 0o600);
  return { replaced, schema, from_version: NAME.exec(path.basename(backup))?.[2] ?? null };
}
