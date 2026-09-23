import { request } from 'undici';
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';
import type { SecretBox } from '../crypto/secrets.js';
import { upstreamHeaders, type HttpApiAuth } from './route.js';

export interface HttpApiRecord {
  id: string;
  slug: string;
  name: string;
  baseUrl: string;
  auth: HttpApiAuth;
  timeoutMs: number;
  enabled: boolean;
  health: string;
  healthDetail: string | undefined;
  lastCheckedAt: number | undefined;
  demo: boolean;
}

/** Registered plain-HTTP APIs, reachable by agents at /http/<slug>/…. */
export class HttpApiRegistry {
  apis = new Map<string, HttpApiRecord>();
  bySlug = new Map<string, HttpApiRecord>();
  version = 0;
  private listeners = new Set<() => void>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly db: Kysely<Database>,
    private readonly secrets: SecretBox,
  ) {}

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async reload(): Promise<void> {
    const rows = await this.db.selectFrom('http_apis').selectAll().execute();
    const apis = new Map<string, HttpApiRecord>();
    const bySlug = new Map<string, HttpApiRecord>();
    for (const r of rows) {
      let auth: HttpApiAuth = { type: 'none' };
      if (r.auth_enc) {
        try {
          auth = JSON.parse(this.secrets.decrypt(r.auth_enc, `http_apis.auth_enc.${r.id}`)) as HttpApiAuth;
        } catch (err) {
          console.error(`[http] cannot decrypt auth for ${r.slug}:`, (err as Error).message);
        }
      }
      const rec: HttpApiRecord = {
        id: r.id,
        slug: r.slug,
        name: r.name,
        baseUrl: r.base_url,
        auth,
        timeoutMs: r.timeout_ms,
        enabled: r.enabled === 1,
        health: r.health,
        healthDetail: r.health_detail ?? undefined,
        lastCheckedAt: r.last_checked_at ?? undefined,
        demo: r.demo === 1,
      };
      apis.set(rec.id, rec);
      bySlug.set(rec.slug, rec);
    }
    this.apis = apis;
    this.bySlug = bySlug;
    this.version++;
    for (const l of this.listeners) {
      try {
        l();
      } catch (err) {
        console.error('[http] listener error', err);
      }
    }
  }

  /** Reachability: any HTTP answer below 500 counts (a 401 or 404 on the base URL still proves the API is up). */
  async check(api: HttpApiRecord): Promise<{ ok: boolean; latencyMs: number; detail: string }> {
    const t0 = Date.now();
    let ok = false;
    let detail: string;
    try {
      const res = await request(api.baseUrl, { method: 'GET', headers: upstreamHeaders({}, 'x-ct-key', api.auth), headersTimeout: 8000, bodyTimeout: 8000, signal: AbortSignal.timeout(10_000) });
      await res.body.dump();
      ok = res.statusCode < 500;
      detail = `HTTP ${res.statusCode} in ${Date.now() - t0} ms`;
    } catch (err) {
      detail = (err as Error).message;
    }
    await this.db
      .updateTable('http_apis')
      .set({ health: ok ? 'ok' : 'down', health_detail: detail, last_checked_at: Date.now(), updated_at: Date.now() })
      .where('id', '=', api.id)
      .execute();
    await this.reload();
    return { ok, latencyMs: Date.now() - t0, detail };
  }

  startHealthLoop(intervalMs = 5 * 60_000): void {
    const tick = async () => {
      for (const a of this.apis.values()) if (a.enabled) await this.check(a).catch(() => undefined);
    };
    this.timer = setInterval(() => void tick(), intervalMs);
    this.timer.unref?.();
    setTimeout(() => void tick(), 2000).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
