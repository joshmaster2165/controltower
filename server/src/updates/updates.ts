import fs from 'node:fs';
import path from 'node:path';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/schema.js';
import { BACKUP_DIR, listBackups, type UpgradeInfo } from '../db/upgrade.js';

/**
 * Updates: knowing a new version is out, and how to install it where this one runs.
 *
 * Once a day (and when an admin asks) Control Tower fetches the release feed: a small JSON file published with each
 * release on the website. The request carries this version in its User-Agent and nothing else: no install id, no
 * address, no usage. CT_UPDATE_CHECK=off turns it off; an install that can't reach the internet just never hears.
 */
export const IMAGE = 'ghcr.io/joshmaster2165/controltower';
const DAY = 24 * 3600_000;

export interface Release {
  version: string;
  date: string;
  /** A release that fixes a security problem: said louder. */
  security: boolean;
  summary: string;
  /** What to know before upgrading to it, if anything. */
  notes: string[];
  url: string;
}
interface Feed {
  schema: 1;
  latest: string;
  releases: Release[];
}

/** Compare dotted versions numerically (0.2.13 < 0.2.14 < 0.10.0). A pre-release suffix sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [main, pre] = v.replace(/^v/, '').split('-', 2) as [string, string | undefined];
    return { nums: main.split('.').map((n) => Number(n) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre && !y.pre) return -1;
  if (!x.pre && y.pre) return 1;
  return (x.pre ?? '').localeCompare(y.pre ?? '');
}

/** A feed as published; anything malformed is dropped rather than shown. */
export function parseFeed(j: unknown): Feed | null {
  const f = j as Partial<Feed> | null;
  if (!f || typeof f !== 'object' || !Array.isArray(f.releases)) return null;
  const ok = (r: Partial<Release>): r is Release => typeof r.version === 'string' && /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(r.version) && typeof r.date === 'string';
  const releases = (f.releases as Array<Partial<Release>>)
    .filter(ok)
    .map((r) => ({ version: r.version, date: r.date, security: r.security === true, summary: String(r.summary ?? '').slice(0, 600), notes: (Array.isArray(r.notes) ? r.notes : []).map((n) => String(n).slice(0, 600)).slice(0, 10), url: /^https:\/\//.test(String(r.url)) ? String(r.url) : '' }))
    .sort((a, b) => compareVersions(b.version, a.version));
  if (!releases.length) return null;
  return { schema: 1, latest: releases[0]!.version, releases };
}

// ---- Where this runs, and how to update it there ----

export type Platform = 'railway' | 'render' | 'fly' | 'kubernetes' | 'docker' | 'source';
export function detectPlatform(env: NodeJS.ProcessEnv = process.env): Platform {
  if (env.RAILWAY_ENVIRONMENT_ID || env.RAILWAY_SERVICE_ID) return 'railway';
  if (env.RENDER || env.RENDER_SERVICE_ID) return 'render';
  if (env.FLY_APP_NAME) return 'fly';
  if (env.KUBERNETES_SERVICE_HOST) return 'kubernetes';
  if (fs.existsSync('/.dockerenv') || env.CT_IN_CONTAINER === '1') return 'docker';
  return 'source';
}

export interface HowTo {
  platform: Platform;
  label: string;
  steps: string[];
  commands: string[];
}
/** What to do to move to `v` where this runs. The data stays where it is: on the volume, or in Postgres. */
export function howToUpdate(platform: Platform, v: string, env: NodeJS.ProcessEnv = process.env): HowTo {
  const image = `${IMAGE}:${v}`;
  switch (platform) {
    case 'railway':
      return {
        platform,
        label: 'Railway',
        steps: [
          `Open the service in Railway → Settings → Source, and set the image to ${image}.`,
          'Railway redeploys on the same volume: the data stays, and the database is backed up before it is upgraded.',
          'Following :latest instead? Redeploy the service (Deployments → ⋮ → Redeploy) to pull it.',
        ],
        commands: [],
      };
    case 'render':
      return { platform, label: 'Render', steps: [`In Render, set the service's image to ${image} (Settings → Image), then Manual Deploy → Deploy latest reference.`, 'The disk keeps the data.'], commands: [] };
    case 'fly':
      return { platform, label: 'Fly.io', steps: ['Deploy the new image; the volume keeps the data.'], commands: [`fly deploy --image ${image}${env.FLY_APP_NAME ? ` -a ${env.FLY_APP_NAME}` : ''}`] };
    case 'kubernetes':
      return {
        platform,
        label: 'Kubernetes (Helm)',
        steps: ['Upgrade the release; the persistent volume (or Postgres) keeps the data. With several replicas on Postgres, pods are replaced one at a time.'],
        commands: [`helm upgrade controltower oci://${IMAGE.replace('/controltower', '/charts/controltower')} --version ${v} --reuse-values`],
      };
    case 'docker':
      return {
        platform,
        label: 'Docker',
        steps: ['Pull the new image, then start it with the same volume and settings as now (Docker Compose: change the tag, then pull and up).'],
        commands: [`docker pull ${image}`, `docker rm -f controltower && docker run -d --name controltower -p 4000:4000 -v controltower-data:/data ${image}`, `docker compose pull && docker compose up -d`],
      };
    default:
      return { platform, label: 'From source', steps: [`Check out v${v}, build, and restart; the data directory stays.`], commands: [`git fetch --tags && git checkout v${v} && pnpm install && pnpm build`] };
  }
}

/** Whether the data directory is on its own volume, in a container (null outside one, or when unknown). */
export function dataOnVolume(dataDir: string): boolean | null {
  if (!(fs.existsSync('/.dockerenv') || process.env.CT_IN_CONTAINER === '1')) return null;
  try {
    return fs.statSync(dataDir).dev !== fs.statSync('/').dev;
  } catch {
    return null;
  }
}

/**
 * SQLite: how much of the database is in use (what the next upgrade's backup copies), the file's size, and the room
 * on the disk it's on. The backup needs about the data in use, plus some.
 */
export async function sqliteDisk(db: Kysely<Database>, dataDir: string) {
  const one = async (pragma: string) => Number(Object.values((await sql.raw(`PRAGMA ${pragma}`).execute(db)).rows[0] ?? {})[0] ?? 0);
  const [pages, free, size] = [await one('page_count'), await one('freelist_count'), await one('page_size')];
  const used = (pages - free) * size;
  let file = 0;
  for (const f of ['controltower.db', 'controltower.db-wal']) {
    try {
      file += fs.statSync(path.join(dataDir, f)).size;
    } catch {
      /* none */
    }
  }
  let disk: { free: number; total: number } | null = null;
  try {
    const s = fs.statfsSync(dataDir);
    disk = { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    /* unknown */
  }
  const needed = Math.ceil(used * 1.1) + 64 * 1048576;
  return { database_in_use: used, database_file: file, disk_free: disk?.free ?? null, disk_total: disk?.total ?? null, backup_needs: needed, room_for_backup: disk ? disk.free >= needed : null };
}

// ---- What happened at each start ----

export interface UpgradeRecord {
  at: number;
  from_version: string | null;
  to_version: string;
  from_schema: number;
  to_schema: number;
  backup: string | null;
}
const getJson = async <T,>(db: Kysely<Database>, key: string): Promise<T | null> => {
  const r = await db.selectFrom('settings').select('value').where('key', '=', key).executeTakeFirst();
  try {
    return r ? (JSON.parse(r.value) as T) : null;
  } catch {
    return null;
  }
};
const putJson = (db: Kysely<Database>, key: string, v: unknown) => {
  const value = JSON.stringify(v);
  const now = Date.now();
  return db.insertInto('settings').values({ key, value, updated_at: now }).onConflict((oc) => oc.column('key').doUpdateSet({ value, updated_at: now })).execute();
};

/** At each start: note this version, and an upgrade (a new version, or schema changes) in the history. */
export async function recordStart(db: Kysely<Database>, version: string, up: UpgradeInfo): Promise<UpgradeRecord | null> {
  const prev = up.from_version;
  await putJson(db, 'app.version', version);
  if (prev === version && up.from_schema === up.to_schema) return null;
  // A first start isn't an upgrade.
  if (!prev && up.from_schema === 0) return null;
  const rec: UpgradeRecord = { at: Date.now(), from_version: prev, to_version: version, from_schema: up.from_schema, to_schema: up.to_schema, backup: up.backup ? path.basename(up.backup) : null };
  const hist = (await getJson<UpgradeRecord[]>(db, 'app.upgrades')) ?? [];
  await putJson(db, 'app.upgrades', [rec, ...hist].slice(0, 20));
  return rec;
}

// ---- The daily check ----

export class Updates {
  private feed: Feed | null = null;
  private checkedAt: number | null = null;
  private error: string | null = null;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly o: { version: string; db: Kysely<Database>; check: boolean; url: string; dataDir: string; dialect: 'sqlite' | 'postgres'; log?: (msg: string) => void; fetcher?: typeof fetch },
  ) {}

  /** Last feed seen (kept across restarts), then a check a minute after start and every day. */
  async start(): Promise<void> {
    const saved = await getJson<{ feed: Feed; at: number; version?: string }>(this.o.db, 'updates.feed');
    if (saved) {
      this.feed = parseFeed(saved.feed);
      this.checkedAt = saved.at;
    }
    if (!this.o.check) return;
    // Soon after start when there's no recent check, or it was made by another version (an upgrade: the feed it saw
    // may not know this one yet); otherwise a day after the last.
    const stale = this.checkedAt === null || Date.now() - this.checkedAt > DAY || saved?.version !== this.o.version || (this.feed !== null && compareVersions(this.feed.latest, this.o.version) < 0);
    const due = stale ? 60_000 : this.checkedAt! + DAY - Date.now();
    this.timer = setTimeout(() => void this.loop(), due);
    this.timer.unref();
  }
  stop(): void {
    clearTimeout(this.timer);
  }
  private async loop(): Promise<void> {
    await this.check();
    this.timer = setTimeout(() => void this.loop(), DAY);
    this.timer.unref();
  }

  async check(): Promise<void> {
    try {
      const r = await (this.o.fetcher ?? fetch)(this.o.url, { headers: { 'user-agent': `controltower/${this.o.version}`, accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`the release feed answered ${r.status}`);
      const feed = parseFeed(await r.json());
      if (!feed) throw new Error("the release feed couldn't be read");
      const was = this.feed?.latest;
      this.feed = feed;
      this.checkedAt = Date.now();
      this.error = null;
      await putJson(this.o.db, 'updates.feed', { feed, at: this.checkedAt, version: this.o.version });
      const newer = this.newer();
      if (newer.length && was !== feed.latest) this.o.log?.(`Control Tower ${feed.latest} is out (this is ${this.o.version})${newer.some((x) => x.security) ? ': it includes a security fix' : ''}. See Updates in the console.`);
    } catch (err) {
      this.error = (err as Error).message;
    }
  }

  newer(): Release[] {
    return (this.feed?.releases ?? []).filter((r) => compareVersions(r.version, this.o.version) > 0);
  }

  async status() {
    const newer = this.newer();
    const target = newer[0]?.version ?? this.o.version;
    const platform = detectPlatform();
    const backupsDir = path.join(this.o.dataDir, BACKUP_DIR);
    return {
      current: this.o.version,
      latest: this.feed?.latest ?? null,
      update_available: newer.length > 0,
      security: newer.some((r) => r.security),
      newer,
      checked_at: this.checkedAt,
      check: this.o.check ? 'on' : 'off',
      error: this.error,
      how: howToUpdate(platform, target),
      data: {
        database: this.o.dialect,
        on_volume: this.o.dialect === 'postgres' ? true : dataOnVolume(this.o.dataDir),
        backups: this.o.dialect === 'sqlite' ? listBackups(backupsDir).map(({ name, size, created_at, schema, from_version, before_version }) => ({ name, size, created_at, schema, from_version, before_version })) : [],
        backups_dir: this.o.dialect === 'sqlite' ? backupsDir : null,
        storage: this.o.dialect === 'sqlite' ? await sqliteDisk(this.o.db, this.o.dataDir).catch(() => null) : null,
      },
      history: (await getJson<UpgradeRecord[]>(this.o.db, 'app.upgrades')) ?? [],
    };
  }
}
