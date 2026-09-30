import type { Db } from '../../db/index.js';
import type { Budgets } from '../../limits/budgets.js';
import type { SharedLimiter, LimitUsage } from './shared-limits.js';

/**
 * A region's share of global limits (Enterprise): every two seconds it tells the control plane what it let
 * through and spent, and takes back what the other regions let through and every budget's total. Its requests
 * per day go too, for the license's yearly count. If the control plane can't be reached, the region goes on
 * limiting and metering by itself, and what it couldn't send goes next time.
 */
export class UsageSync {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  error: string | undefined;

  constructor(
    private readonly deps: {
      db: Db;
      region: { name: string; controlPlaneUrl: string; token: string };
      instanceId: string;
      limiter: SharedLimiter;
      budgets: Budgets;
      log: () => { warn(o: object, m: string): void };
      intervalMs?: number;
    },
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.deps.intervalMs ?? 2_000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.tick();
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const limits = this.deps.limiter.take();
    try {
      const { items, base } = this.deps.budgets.remoteItems();
      const since = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      const days = await this.deps.db.read.selectFrom('usage_daily').select(['bucket']).select((eb) => eb.fn.sum<number>('requests').as('requests')).where('bucket', '>=', since).groupBy('bucket').execute();
      const daily = Object.fromEntries(days.map((d) => [String(d.bucket), Number(d.requests ?? 0)]));
      const r = await fetch(`${this.deps.region.controlPlaneUrl}/cp/v1/link/usage`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.deps.region.token}`, 'x-ct-region': this.deps.region.name, 'x-ct-instance': this.deps.instanceId, 'content-type': 'application/json' },
        body: JSON.stringify({ limits, budgets: items, daily }),
        signal: AbortSignal.timeout(10_000),
      });
      if (r.status !== 200) throw new Error(`the control plane answered ${r.status}`);
      const res = (await r.json()) as { limits?: LimitUsage[]; budgets?: Array<{ scope: string; spent: number; resets_at: number | null }> };
      await this.deps.limiter.apply(res.limits ?? []);
      await this.deps.budgets.settleRemote(res.budgets ?? [], base);
      this.error = undefined;
    } catch (err) {
      this.deps.limiter.putBack(limits);
      const message = (err as Error).message;
      if (message !== this.error) this.deps.log().warn({ err: message }, 'region: limits and budgets not shared with the control plane just now (limiting here meanwhile)');
      this.error = message;
    } finally {
      this.running = false;
    }
  }
}
