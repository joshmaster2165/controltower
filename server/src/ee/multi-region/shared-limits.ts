import type { Redis } from 'ioredis';
import type { Admit, Limiter, Limits } from '../../limits/limiter.js';

/**
 * Rate limits shared across regions (Enterprise). Every install counts, as before, in its own limiter; this
 * wrapper also notes what it let through for limits that are global — an agent's key, a model deployment, a gate
 * with limits — and takes in what the other regions let through, charging it to its own limiter. Swapped every
 * two seconds through the control plane, so one agent's 60 requests a minute are 60 across every region, give or
 * take what the others let through in the last couple of seconds. Concurrency (calls at once) stays per region.
 */
export interface LimitUsage {
  scope: string;
  requests: number;
  tokens: number;
  rpm?: number;
  tpm?: number;
}

/** Limits that span regions: an agent's key, a deployment (the provider's quota), a gate's limits. */
const SHARED = /^(key|dep|gate):/;

export class SharedLimiter implements Limiter {
  private pending = new Map<string, LimitUsage>();

  constructor(readonly base: Limiter) {}

  private note(scope: string, requests: number, tokens: number, limits: Limits): void {
    if (!SHARED.test(scope) || (!limits.rpm && !limits.tpm)) return;
    const cur = this.pending.get(scope) ?? { scope, requests: 0, tokens: 0 };
    cur.requests += requests;
    cur.tokens += tokens;
    if (limits.rpm) cur.rpm = limits.rpm;
    if (limits.tpm) cur.tpm = limits.tpm;
    this.pending.set(scope, cur);
  }

  async admit(scope: string, estTokens: number, limits: Limits, now?: number): Promise<Admit> {
    const r = await this.base.admit(scope, estTokens, limits, now);
    if (r.ok) this.note(scope, 1, Math.max(1, estTokens), limits);
    return r;
  }

  reconcile(scope: string, deltaTokens: number, limits: Limits, now?: number): void {
    this.base.reconcile(scope, deltaTokens, limits, now);
    if (deltaTokens > 0) this.note(scope, 0, deltaTokens, limits);
  }

  acquireSlot(scope: string, max: number) {
    return this.base.acquireSlot(scope, max);
  }

  charge(scope: string, requests: number, tokens: number, limits: Limits, now?: number) {
    return this.base.charge(scope, requests, tokens, limits, now);
  }

  /** What this install let through since it last said, for the others. */
  take(): LimitUsage[] {
    const out = [...this.pending.values()];
    this.pending = new Map();
    return out;
  }

  /** Usage that couldn't be sent: kept for the next time. */
  putBack(usage: LimitUsage[]): void {
    for (const u of usage) this.note(u.scope, u.requests, u.tokens, { ...(u.rpm ? { rpm: u.rpm } : {}), ...(u.tpm ? { tpm: u.tpm } : {}) });
  }

  /** What the other regions let through: counted here too. */
  async apply(usage: LimitUsage[]): Promise<void> {
    for (const u of usage) {
      const limits: Limits = { ...(u.rpm ? { rpm: u.rpm } : {}), ...(u.tpm ? { tpm: u.tpm } : {}) };
      await this.base.charge(u.scope, Math.max(0, Math.round(u.requests)), Math.max(0, Math.round(u.tokens)), limits);
    }
  }
}

/**
 * On the control plane: what each region hasn't heard yet about the others. Usage from one region (or the control
 * plane's own traffic) is added for every other region, and handed over once — to whichever of that region's
 * instances asks first. In memory, or in Redis when several control-plane instances share the work.
 */
export class LimitExchange {
  private boxes = new Map<string, Map<string, LimitUsage>>();

  constructor(private readonly redis: Redis | undefined) {}

  /** Usage from `from` (a region's name, or "" for the control plane) for every other region in `regions`. */
  async offer(from: string, regions: string[], usage: LimitUsage[]): Promise<void> {
    if (!usage.length) return;
    for (const to of regions) {
      if (to === from) continue;
      if (this.redis) {
        const m = this.redis.multi();
        for (const u of usage) {
          m.hincrby(`ct:rlx:${to}`, `${u.scope}\u0000r`, Math.round(u.requests));
          m.hincrby(`ct:rlx:${to}`, `${u.scope}\u0000t`, Math.round(u.tokens));
          m.hset(`ct:rlx:${to}`, `${u.scope}\u0000l`, `${u.rpm ?? 0}/${u.tpm ?? 0}`);
        }
        m.pexpire(`ct:rlx:${to}`, 60_000);
        await m.exec();
        continue;
      }
      const box = this.boxes.get(to) ?? this.boxes.set(to, new Map()).get(to)!;
      for (const u of usage) {
        const cur = box.get(u.scope) ?? { scope: u.scope, requests: 0, tokens: 0 };
        cur.requests += u.requests;
        cur.tokens += u.tokens;
        if (u.rpm) cur.rpm = u.rpm;
        if (u.tpm) cur.tpm = u.tpm;
        box.set(u.scope, cur);
      }
    }
  }

  /** What `region` hasn't heard yet (and now has). */
  async drain(region: string): Promise<LimitUsage[]> {
    if (this.redis) {
      const key = `ct:rlx:${region}`;
      const res = await this.redis.multi().hgetall(key).del(key).exec();
      const all = (res?.[0]?.[1] ?? {}) as Record<string, string>;
      const by = new Map<string, LimitUsage>();
      for (const [field, v] of Object.entries(all)) {
        const [scope, kind] = field.split('\u0000') as [string, string];
        const u = by.get(scope) ?? by.set(scope, { scope, requests: 0, tokens: 0 }).get(scope)!;
        if (kind === 'r') u.requests = Number(v);
        else if (kind === 't') u.tokens = Number(v);
        else {
          const [rpm, tpm] = v.split('/').map(Number);
          if (rpm) u.rpm = rpm;
          if (tpm) u.tpm = tpm;
        }
      }
      return [...by.values()];
    }
    const box = this.boxes.get(region);
    this.boxes.delete(region);
    return box ? [...box.values()] : [];
  }
}
