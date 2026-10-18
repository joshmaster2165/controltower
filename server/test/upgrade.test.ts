import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openSqlite } from '../src/db/index.js';
import { migrations } from '../src/db/migrations.js';
import { LATEST_SCHEMA, listBackups, NewerDataError, restoreBackup } from '../src/db/upgrade.js';
import { compareVersions, detectPlatform, howToUpdate, parseFeed, recordStart, Updates } from '../src/updates/updates.js';
// @ts-expect-error a plain .mjs build script, without types
import { releaseFeed } from '../../scripts/release-feed.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ct-upgrade-'));
// The newest migration, undone: as if the data were last used by the version before it.
const last = migrations.find((m) => m.version === LATEST_SCHEMA)!;
function olderData(dir: string, version: string) {
  const db = openSqlite(dir);
  db.raw.exec(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('app.version', '"${version}"', 0), ('marker', '"kept"', 0)`);
  db.raw.prepare('DELETE FROM schema_migrations WHERE version = ?').run(last.version);
  // Undo what it created (every migration here creates or alters tables; dropping the ones it made is enough).
  for (const t of [...last.sqlite.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/g)].map((m) => m[1])) db.raw.exec(`DROP TABLE IF EXISTS ${t}`);
  db.close();
}
const up = (version: string, keep = 3) => ({ upgrade: { appVersion: version, backup: true, keep } });

describe('upgrading the database', () => {
  it('a new install takes no backup', () => {
    const dir = tmp();
    const db = openSqlite(dir, up('1.0.0'));
    expect(db.upgrade).toMatchObject({ from_schema: 0, to_schema: LATEST_SCHEMA, backup: null });
    db.close();
    expect(listBackups(path.join(dir, 'backups'))).toEqual([]);
  });

  it('backs up before migrating, names the backup, and keeps the newest few', () => {
    const dir = tmp();
    olderData(dir, '0.2.12');
    const db = openSqlite(dir, up('0.2.14'));
    expect(db.upgrade.backup).toMatch(new RegExp(`controltower-schema${LATEST_SCHEMA - 1}-v0\\.2\\.12-before-v0\\.2\\.14-\\d{8}T\\d{6}Z\\.db$`));
    expect(db.upgrade).toMatchObject({ from_schema: LATEST_SCHEMA - 1, to_schema: LATEST_SCHEMA, from_version: '0.2.12' });
    db.close();
    // The backup is the data as it was: the old schema, and what was in it.
    const b = new Database(db.upgrade.backup!, { readonly: true });
    expect((b.prepare("SELECT value FROM settings WHERE key = 'marker'").get() as { value: string }).value).toBe('"kept"');
    expect(b.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(LATEST_SCHEMA)).toBeUndefined();
    b.close();
    // Nothing to apply: no new backup.
    const again = openSqlite(dir, up('0.2.14'));
    expect(again.upgrade.backup).toBeNull();
    again.close();
    // Several upgrades: only the newest `keep` backups stay.
    for (let i = 0; i < 4; i++) {
      olderData(dir, `0.3.${i}`);
      openSqlite(dir, up(`0.3.${i + 1}`, 2)).close();
    }
    const kept = listBackups(path.join(dir, 'backups'));
    expect(kept).toHaveLength(2);
    expect(kept.map((k) => k.before_version)).toEqual(['0.3.4', '0.3.3']);
  });

  it('turned off, upgrades without a backup', () => {
    const dir = tmp();
    olderData(dir, '0.2.12');
    const db = openSqlite(dir, { upgrade: { appVersion: '0.2.14', backup: false, keep: 3 } });
    expect(db.upgrade.backup).toBeNull();
    db.close();
  });

  it('an older version refuses data a newer one upgraded, and says what to do', () => {
    const dir = tmp();
    olderData(dir, '0.2.12');
    openSqlite(dir, up('0.2.14')).close();
    const raw = new Database(path.join(dir, 'controltower.db'));
    raw.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, 0)').run(LATEST_SCHEMA + 1, 'from the future');
    raw.prepare("UPDATE settings SET value = '\"9.0.0\"' WHERE key = 'app.version'").run();
    raw.close();
    let err: Error | undefined;
    try {
      openSqlite(dir, up('0.2.14'));
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeInstanceOf(NewerDataError);
    expect(err!.message).toContain('upgraded by a newer Control Tower (9.0.0)');
    expect(err!.message).toContain('Run 9.0.0 or newer');
    expect(err!.message).toMatch(/controltower --restore .*before-v0\.2\.14/);
  });

  it('a restore puts the backup back and keeps the database it replaced', () => {
    const dir = tmp();
    olderData(dir, '0.2.12');
    const db = openSqlite(dir, up('0.2.14'));
    db.raw.exec(`INSERT INTO settings (key, value, updated_at) VALUES ('after', '"written after the upgrade"', 0)`);
    const backup = db.upgrade.backup!;
    db.close();
    const r = restoreBackup(dir, backup, Database);
    expect(r).toMatchObject({ schema: LATEST_SCHEMA - 1, from_version: '0.2.12' });
    expect(fs.existsSync(r.replaced!)).toBe(true);
    const back = new Database(path.join(dir, 'controltower.db'), { readonly: true });
    expect(back.prepare("SELECT 1 FROM settings WHERE key = 'after'").get()).toBeUndefined();
    expect(back.prepare("SELECT 1 FROM settings WHERE key = 'marker'").get()).toBeTruthy();
    back.close();
    // The set-aside database is never pruned with the automatic backups.
    expect(listBackups(path.join(dir, 'backups')).some((b) => b.file === r.replaced && b.schema === null)).toBe(true);
    expect(() => restoreBackup(dir, path.join(dir, 'nope.db'), Database)).toThrow(/no such file/);
  });

  it('records each upgrade', async () => {
    const dir = tmp();
    olderData(dir, '0.2.12');
    const db = openSqlite(dir, up('0.2.14'));
    const rec = await recordStart(db.write, '0.2.14', db.upgrade);
    expect(rec).toMatchObject({ from_version: '0.2.12', to_version: '0.2.14', from_schema: LATEST_SCHEMA - 1, to_schema: LATEST_SCHEMA });
    expect(rec!.backup).toMatch(/^controltower-schema/);
    // A plain restart is not an upgrade.
    expect(await recordStart(db.write, '0.2.14', { ...db.upgrade, from_version: '0.2.14', from_schema: LATEST_SCHEMA })).toBeNull();
    db.close();
  });
});

describe('knowing about new versions', () => {
  it('compares versions numerically', () => {
    expect(compareVersions('0.2.13', '0.2.14')).toBe(-1);
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
  });

  it('reads the feed, dropping what is malformed', () => {
    expect(parseFeed({ releases: [{ version: 'banana', date: 'x' }] })).toBeNull();
    const f = parseFeed({ releases: [{ version: '0.2.13', date: '2026-10-16' }, { version: '0.2.14', date: '2026-10-18', security: true, url: 'javascript:alert(1)' }] })!;
    expect(f.latest).toBe('0.2.14');
    expect(f.releases[0]).toMatchObject({ version: '0.2.14', security: true, url: '' });
  });

  it('checks the feed with only its version, and says what is newer', async () => {
    const dir = tmp();
    const db = openSqlite(dir);
    const seen: Array<{ url: string; ua: string }> = [];
    const feed = { schema: 1, latest: '0.3.0', releases: [{ version: '0.3.0', date: '2026-11-01', security: true, summary: 'Fixes a thing', notes: ['Upgrading: read this'], url: 'https://agentcontroltower.app/docs/changelog.html#030' }, { version: '0.2.14', date: '2026-10-18', summary: 'Smaller' }, { version: '0.2.12', date: '2026-10-07' }] };
    const u = new Updates({
      version: '0.2.13',
      db: db.write,
      check: true,
      url: 'https://example.test/releases.json',
      dataDir: dir,
      dialect: 'sqlite',
      fetcher: (async (url: string, init: RequestInit) => {
        seen.push({ url, ua: (init.headers as Record<string, string>)['user-agent']! });
        return new Response(JSON.stringify(feed), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await u.check();
    expect(seen).toEqual([{ url: 'https://example.test/releases.json', ua: 'controltower/0.2.13' }]);
    const s = await u.status();
    expect(s).toMatchObject({ current: '0.2.13', latest: '0.3.0', update_available: true, security: true, check: 'on', error: null });
    expect(s.newer.map((r) => r.version)).toEqual(['0.3.0', '0.2.14']);
    // Storage: the data in use, the file, the disk, and whether the next update's backup would fit.
    expect(s.data.storage).toMatchObject({ room_for_backup: true });
    expect(s.data.storage!.database_in_use).toBeGreaterThan(0);
    expect(s.data.storage!.backup_needs).toBeGreaterThan(s.data.storage!.database_in_use);
    expect(s.data.storage!.disk_free).toBeGreaterThan(0);
    // Kept across a restart.
    const again = new Updates({ version: '0.2.13', db: db.write, check: false, url: '', dataDir: dir, dialect: 'sqlite' });
    await again.start();
    expect((await again.status()).latest).toBe('0.3.0');
    // After an upgrade, the feed saved by the old version is checked again soon (not a day later).
    let timers: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      timers.push(ms);
      return realSetTimeout(() => undefined, 0);
    }) as unknown as typeof setTimeout;
    try {
      await new Updates({ version: '0.2.13', db: db.write, check: true, url: 'x', dataDir: dir, dialect: 'sqlite' }).start();
      await new Updates({ version: '0.3.0', db: db.write, check: true, url: 'x', dataDir: dir, dialect: 'sqlite' }).start();
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    expect(timers[0]).toBeGreaterThan(3600_000); // same version, checked just now: a day after
    expect(timers[1]).toBe(60_000); // a new version: a minute after start
    timers = [];
    // A feed that can't be reached: no news, and why.
    const down = new Updates({ version: '0.2.13', db: db.write, check: true, url: 'x', dataDir: dir, dialect: 'sqlite', fetcher: (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch });
    await down.check();
    expect((await down.status()).error).toMatch(/503/);
    db.close();
  });

  it('tells each platform how to update', () => {
    expect(detectPlatform({ RAILWAY_ENVIRONMENT_ID: 'x' })).toBe('railway');
    expect(detectPlatform({ KUBERNETES_SERVICE_HOST: '10.0.0.1' })).toBe('kubernetes');
    expect(detectPlatform({ FLY_APP_NAME: 'ct' })).toBe('fly');
    expect(howToUpdate('kubernetes', '0.3.0').commands[0]).toBe('helm upgrade controltower oci://ghcr.io/joshmaster2165/charts/controltower --version 0.3.0 --reuse-values');
    expect(howToUpdate('railway', '0.3.0').steps[0]).toContain('ghcr.io/joshmaster2165/controltower:0.3.0');
    expect(howToUpdate('fly', '0.3.0', { FLY_APP_NAME: 'acme-ct' }).commands[0]).toBe('fly deploy --image ghcr.io/joshmaster2165/controltower:0.3.0 -a acme-ct');
  });

  it('the website builds the feed from the changelog', () => {
    const f = releaseFeed(`# Changelog

## Unreleased

- Not out yet.

## 0.2.15 — 3 November 2026 (security)

- **Fix:** a [thing](x.md) that mattered,
  over two lines.
- **Upgrading:** restart every instance.

## 0.2.14 — 18 October 2026

- **Updates:** Control Tower tells you.
`);
    expect(f.latest).toBe('0.2.15');
    expect(f.releases).toEqual([
      { version: '0.2.15', date: '2026-11-03', security: true, summary: 'Fix: a thing that mattered, over two lines.', notes: ['Upgrading: restart every instance.'], url: 'https://agentcontroltower.app/docs/changelog.html#0215--3-november-2026-security' },
      { version: '0.2.14', date: '2026-10-18', security: false, summary: 'Updates: Control Tower tells you.', notes: [], url: 'https://agentcontroltower.app/docs/changelog.html#0214--18-october-2026' },
    ]);
  });
});
