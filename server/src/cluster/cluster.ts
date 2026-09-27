import os from 'node:os';
import crypto from 'node:crypto';
import { Redis } from 'ioredis';
import type { Versioned } from '../util/versioned.js';

/**
 * Several Control Tower instances behind a load balancer, sharing one Postgres database. What each keeps in
 * memory is kept in step over Redis (CT_REDIS_URL):
 *
 *  - a change made through one instance (a key, a gate, a server…) reloads that cache on the others;
 *  - version bumps the consoles follow (approvals, alerts, views…) reach consoles on every instance;
 *  - the live feed each instance produces reaches every console;
 *  - an approval decided on one instance wakes the call held on another at once.
 *
 * Without Redis nothing is sent: one instance, everything local.
 */
type Message = { from: string; type: string; payload: unknown };

/** Runs fn one call at a time; calls made while it runs share one more run after it, which sees everything before them. */
export function serial(fn: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  let next: Promise<void> | null = null;
  const start = (): Promise<void> => (running = fn().finally(() => (running = null)));
  return () => {
    if (!running) return start();
    next ??= running.catch(() => undefined).then(() => {
      next = null;
      return start();
    });
    return next;
  };
}
const CHANNEL = 'ct:cluster';

export class Cluster {
  readonly id: string;
  readonly host = os.hostname();
  private pub: Redis | undefined;
  private sub: Redis | undefined;
  private handlers = new Map<string, Set<(payload: any) => void>>();

  constructor(private readonly redisUrl: string | undefined, id?: string) {
    this.id = id || `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  }

  /** Whether instances are kept in step (Redis is configured). */
  get shared(): boolean {
    return !!this.redisUrl;
  }

  /** The Redis connection for shared counters (rate limits), when configured. */
  get redis(): Redis | undefined {
    return this.pub;
  }

  async start(): Promise<void> {
    if (!this.redisUrl) return;
    const opts = { lazyConnect: true, maxRetriesPerRequest: 2, enableAutoPipelining: true } as const;
    this.pub = new Redis(this.redisUrl, opts);
    this.sub = new Redis(this.redisUrl, { lazyConnect: true });
    for (const r of [this.pub, this.sub]) r.on('error', (err) => console.error(`[cluster] redis: ${err.message}`));
    await this.pub.connect();
    await this.sub.connect();
    await this.sub.subscribe(CHANNEL);
    this.sub.on('message', (_channel, raw) => {
      let m: Message;
      try {
        m = JSON.parse(raw) as Message;
      } catch {
        return;
      }
      if (m.from === this.id) return;
      for (const h of this.handlers.get(m.type) ?? []) {
        try {
          h(m.payload);
        } catch (err) {
          console.error(`[cluster] ${m.type} handler:`, err);
        }
      }
    });
  }

  publish(type: string, payload: unknown): void {
    if (!this.pub) return;
    this.pub.publish(CHANNEL, JSON.stringify({ from: this.id, type, payload } satisfies Message)).catch((err: Error) => console.error(`[cluster] publish ${type}: ${err.message}`));
  }

  on(type: string, fn: (payload: any) => void): () => void {
    const set = this.handlers.get(type) ?? this.handlers.set(type, new Set()).get(type)!;
    set.add(fn);
    return () => set.delete(fn);
  }

  /** A reload through this instance reloads the same cache on the others. */
  syncReloads(caches: Record<string, { reload(): Promise<void> }>): void {
    if (!this.shared) return;
    for (const [name, cache] of Object.entries(caches)) {
      // One reload at a time, and a burst becomes one more: an older reload finishing last would put back what a newer one removed.
      const original = serial(cache.reload.bind(cache));
      cache.reload = async () => {
        await original();
        this.publish('reload', name);
      };
      this.on('reload', (n: string) => {
        if (n === name) original().catch((err: unknown) => console.error(`[cluster] reload ${name}:`, err));
      });
    }
  }

  /** A bump on this instance bumps the same counter on the others, so their consoles hear of it. */
  syncVersions(versions: Record<string, Versioned>): void {
    if (!this.shared) return;
    for (const [name, v] of Object.entries(versions)) {
      const original = v.bump.bind(v);
      v.bump = () => {
        const r = original();
        this.publish('bump', name);
        return r;
      };
      this.on('bump', (n: string) => {
        if (n === name) original();
      });
    }
  }

  async stop(): Promise<void> {
    await Promise.allSettled([this.sub?.quit(), this.pub?.quit()]);
  }
}
