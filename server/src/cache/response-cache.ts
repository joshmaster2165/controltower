import crypto from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Usage } from '@controltower/shared';

/**
 * Answers kept and served again for identical requests — opt-in per model (an alias's or a model's routing:
 * `cache.ttl_s`). Only after the call has passed its gates and inspection is the cache consulted, so a cached
 * answer is never a way around them; answers are stored after output inspection. Cached per agent key unless
 * the model's cache is `shared`. Stored in memory, or in Redis when instances share one.
 */
export interface CachedResponse {
  status: number;
  contentType: string;
  /** base64 of the body as the client got it (a JSON answer, or the whole event stream). */
  body: string;
  stream: boolean;
  usage?: Usage | undefined;
  deploymentId?: string | undefined;
  storedAt: number;
}

export interface CacheStore {
  get(key: string): Promise<CachedResponse | undefined>;
  set(key: string, value: CachedResponse, ttlS: number): Promise<void>;
  clear(): Promise<number>;
}

export class MemoryStore implements CacheStore {
  private items = new Map<string, { v: CachedResponse; exp: number; bytes: number }>();
  private bytes = 0;
  constructor(
    private readonly maxEntries = 5000,
    private readonly maxBytes = 64 * 1024 * 1024,
  ) {}

  async get(key: string): Promise<CachedResponse | undefined> {
    const it = this.items.get(key);
    if (!it) return undefined;
    if (it.exp < Date.now()) {
      this.drop(key);
      return undefined;
    }
    // Most recently used last: the oldest go first when full.
    this.items.delete(key);
    this.items.set(key, it);
    return it.v;
  }

  async set(key: string, v: CachedResponse, ttlS: number): Promise<void> {
    const bytes = v.body.length + 256;
    if (bytes > this.maxBytes / 8) return; // one answer never crowds out the rest
    this.drop(key);
    this.items.set(key, { v, exp: Date.now() + ttlS * 1000, bytes });
    this.bytes += bytes;
    while (this.items.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.items.keys().next().value;
      if (oldest === undefined) break;
      this.drop(oldest);
    }
  }

  async clear(): Promise<number> {
    const n = this.items.size;
    this.items.clear();
    this.bytes = 0;
    return n;
  }

  private drop(key: string): void {
    const it = this.items.get(key);
    if (!it) return;
    this.bytes -= it.bytes;
    this.items.delete(key);
  }
}

const PREFIX = 'ct:cache:';

export class RedisStore implements CacheStore {
  constructor(private readonly redis: Redis) {}
  async get(key: string): Promise<CachedResponse | undefined> {
    const s = await this.redis.get(PREFIX + key).catch(() => null);
    if (!s) return undefined;
    try {
      return JSON.parse(s) as CachedResponse;
    } catch {
      return undefined;
    }
  }
  async set(key: string, v: CachedResponse, ttlS: number): Promise<void> {
    await this.redis.set(PREFIX + key, JSON.stringify(v), 'EX', Math.max(1, Math.round(ttlS))).catch(() => undefined);
  }
  async clear(): Promise<number> {
    let n = 0;
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${PREFIX}*`, 'COUNT', 500);
      cursor = next;
      if (keys.length) n += await this.redis.del(...keys);
    } while (cursor !== '0');
    return n;
  }
}

/** Request fields that don't change the answer. */
const IGNORED = new Set(['stream_options', 'user', 'metadata', 'ct', 'store', 'service_tier', 'safety_identifier', 'prompt_cache_key']);

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  return v;
}

/** The cache key: the request as it would be answered, for this agent (or everyone, for a shared cache). */
export function cacheKey(parts: { model: string; dialect: string; stream: boolean; body: Record<string, unknown>; scope: string; namespace: string }): string {
  const body = Object.fromEntries(Object.entries(parts.body).filter(([k]) => !IGNORED.has(k) && k !== 'stream'));
  const text = JSON.stringify(canonical({ v: 1, model: parts.model, dialect: parts.dialect, stream: parts.stream, scope: parts.scope, ns: parts.namespace, body }));
  return crypto.createHash('sha256').update(text).digest('hex');
}

export interface CacheControl {
  /** Skip the lookup (the answer is still stored). */
  noCache: boolean;
  /** Don't store this answer. */
  noStore: boolean;
  ttlS: number | undefined;
  namespace: string;
}

/** `x-ct-cache: no-cache, no-store, ttl=60, namespace=eval-run-3`, or `"ct": {"cache": {...}}` in the body. */
export function cacheControl(header: string | string[] | undefined, body: Record<string, unknown>): CacheControl {
  const c: CacheControl = { noCache: false, noStore: false, ttlS: undefined, namespace: '' };
  const h = Array.isArray(header) ? header.join(',') : (header ?? '');
  for (const part of h.split(',').map((x) => x.trim().toLowerCase())) {
    if (part === 'no-cache') c.noCache = true;
    else if (part === 'no-store') c.noStore = true;
    else if (part.startsWith('ttl=') && Number(part.slice(4)) >= 0) c.ttlS = Number(part.slice(4));
    else if (part.startsWith('namespace=')) c.namespace = part.slice(10).slice(0, 64);
  }
  const b = ((body.ct as { cache?: Record<string, unknown> } | undefined)?.cache ?? {}) as { no_cache?: unknown; no_store?: unknown; ttl?: unknown; namespace?: unknown };
  if (b.no_cache === true) c.noCache = true;
  if (b.no_store === true) c.noStore = true;
  if (typeof b.ttl === 'number' && b.ttl >= 0) c.ttlS = b.ttl;
  if (typeof b.namespace === 'string') c.namespace = b.namespace.slice(0, 64);
  return c;
}
