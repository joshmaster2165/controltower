import type { Redis } from 'ioredis';
import { MemoryLimiter, type Admit, type Limiter, type Limits } from './limiter.js';

/**
 * The rate limiter shared by every instance: the same GCRA as MemoryLimiter, one theoretical arrival time per
 * scope, kept in Redis and moved atomically by a script using Redis's clock. Concurrency slots are counters
 * that expire, so a crashed instance's slots free themselves. If Redis can't be reached, each instance falls
 * back to limiting on its own rather than refusing everything.
 */
const ADMIT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local burst = 60000
local function check(key, perMin, cost)
  if perMin <= 0 then return {1, now, -1, 0} end
  local emission = 60000 / perMin
  local tat = tonumber(redis.call('GET', key) or now)
  if tat < now then tat = now end
  local newTat = tat + cost * emission
  local allowAt = newTat - burst
  if allowAt <= now then return {1, newTat, math.floor((now + burst - newTat) / emission), 0} end
  return {0, tat, 0, math.ceil(allowAt - now)}
end
local rpm, tpm = tonumber(ARGV[1]), tonumber(ARGV[2])
local r = check(KEYS[1], rpm, 1)
if r[1] == 0 then return {0, 'rpm', r[4], 0, -1} end
local q = check(KEYS[2], tpm, tonumber(ARGV[3]))
if q[1] == 0 then return {0, 'tpm', q[4], r[3], 0} end
if rpm > 0 then redis.call('SET', KEYS[1], tostring(r[2]), 'PX', 120000) end
if tpm > 0 then redis.call('SET', KEYS[2], tostring(q[2]), 'PX', 120000) end
return {1, '', 0, r[3], q[3]}`;

const RECONCILE = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local tat = tonumber(redis.call('GET', KEYS[1]))
if not tat then return 0 end
local nt = tat + tonumber(ARGV[1]) * (60000 / tonumber(ARGV[2]))
if nt < now then nt = now end
redis.call('SET', KEYS[1], tostring(nt), 'PX', 120000)
return 1`;

const CHARGE = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local tat = tonumber(redis.call('GET', KEYS[1]) or now)
if tat < now then tat = now end
redis.call('SET', KEYS[1], tostring(tat + tonumber(ARGV[1]) * (60000 / tonumber(ARGV[2]))), 'PX', 120000)
return 1`;

export class RedisLimiter implements Limiter {
  private local = new MemoryLimiter();
  private warned = 0;

  constructor(private readonly redis: Redis) {}

  private fallback(err: unknown): void {
    if (Date.now() - this.warned > 60_000) {
      this.warned = Date.now();
      console.error(`[limiter] Redis unavailable, limiting per instance: ${(err as Error).message}`);
    }
  }

  async admit(scope: string, estTokens: number, limits: Limits): Promise<Admit> {
    const rpm = limits.rpm && limits.rpm > 0 ? limits.rpm : 0;
    const tpm = limits.tpm && limits.tpm > 0 ? limits.tpm : 0;
    if (!rpm && !tpm) return { ok: true, retryAfterMs: 0, remaining: { rpm: Infinity, tpm: Infinity } };
    try {
      const [ok, which, retry, remRpm, remTpm] = (await this.redis.eval(ADMIT, 2, `ct:rl:rpm:${scope}`, `ct:rl:tpm:${scope}`, rpm, tpm, Math.max(1, estTokens))) as [number, string, number, number, number];
      const rem = (n: number) => (n < 0 ? Infinity : n);
      if (ok === 1) return { ok: true, retryAfterMs: 0, remaining: { rpm: rem(remRpm), tpm: rem(remTpm) } };
      return { ok: false, retryAfterMs: retry, which: which as 'rpm' | 'tpm', remaining: { rpm: rem(remRpm), tpm: rem(remTpm) } };
    } catch (err) {
      this.fallback(err);
      return this.local.admit(scope, estTokens, limits);
    }
  }

  reconcile(scope: string, deltaTokens: number, limits: Limits): void {
    if (!limits.tpm || limits.tpm <= 0 || deltaTokens === 0) return;
    this.redis.eval(RECONCILE, 1, `ct:rl:tpm:${scope}`, deltaTokens, limits.tpm).catch((err: unknown) => this.fallback(err));
  }

  async charge(scope: string, requests: number, tokens: number, limits: Limits): Promise<void> {
    try {
      if (limits.rpm && limits.rpm > 0 && requests > 0) await this.redis.eval(CHARGE, 1, `ct:rl:rpm:${scope}`, requests, limits.rpm);
      if (limits.tpm && limits.tpm > 0 && tokens > 0) await this.redis.eval(CHARGE, 1, `ct:rl:tpm:${scope}`, tokens, limits.tpm);
    } catch (err) {
      this.fallback(err);
      this.local.charge(scope, requests, tokens, limits);
    }
  }

  async acquireSlot(scope: string, max: number): Promise<(() => void) | null> {
    if (!(max > 0)) return () => undefined;
    const key = `ct:slots:${scope}`;
    try {
      const n = await this.redis.incr(key);
      await this.redis.pexpire(key, 600_000);
      if (n > max) {
        await this.redis.decr(key);
        return null;
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.redis.decr(key).catch((err: unknown) => this.fallback(err));
      };
    } catch (err) {
      this.fallback(err);
      return this.local.acquireSlot(scope, max);
    }
  }

  close(): void {
    this.local.close();
  }
}
