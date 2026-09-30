import { ulid } from 'ulid';
import type { Cluster } from '../../cluster/cluster.js';
import type { SerializedScope } from '../../admin/scope.js';

/**
 * How the control plane's console reaches into regions (Enterprise), without regions having to be reachable:
 * each region keeps a request open to the control plane (a long poll); a question from the console — this region's
 * flights, its ledger, a held call to decide — is handed to it, the region answers from its own API, and the
 * answer comes back. Nothing a region answers is stored here: it's shown and gone.
 *
 * With several control-plane instances, a question is offered to all of them (over Redis) and the first instance
 * holding one of the region's polls claims it; the answer is passed back the same way.
 */
export interface RpcRequest {
  id: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  body?: unknown;
  /** What the person asking may see and do (their teams), applied by the region. */
  scope?: SerializedScope;
  /** Who is asking (a held call decided from the console is decided by them). */
  acting?: string;
}
export interface RpcResponse {
  id: string;
  status: number;
  body: unknown;
}

const POLL_MS = 25_000;

export class RegionHub {
  private queues = new Map<string, Array<{ req: RpcRequest; until: number }>>();
  private waiters = new Map<string, Set<() => void>>();
  private pending = new Map<string, { resolve: (r: RpcResponse) => void; timer: NodeJS.Timeout }>();
  /** Polls open per region, and when one last ended (a region polls again at once). */
  private open = new Map<string, number>();
  private lastEnd = new Map<string, number>();

  constructor(private readonly cluster: Cluster | undefined) {
    cluster?.on('region-rq', (p: { region: string; req: RpcRequest; until: number }) => this.enqueue(p.region, p.req, p.until));
    cluster?.on('region-rs', (r: RpcResponse) => this.settle(r));
  }

  /** Ask a region; rejects after `timeoutMs` (the region is slow or gone). */
  request(region: string, req: Omit<RpcRequest, 'id'>, timeoutMs = 6_000): Promise<RpcResponse> {
    const full: RpcRequest = { ...req, id: ulid() };
    const until = Date.now() + timeoutMs;
    const p = new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(full.id);
        reject(new Error(`region ${region} didn't answer in ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(full.id, { resolve, timer });
    });
    this.enqueue(region, full, until);
    this.cluster?.publish('region-rq', { region, req: full, until });
    return p;
  }

  /**
   * Whether a region is connected to this instance now (a poll open, or one ended in the last 1.5 s). Known only with a single
   * control-plane instance; with several, undefined (the region's last check-in decides).
   */
  connected(region: string): boolean | undefined {
    if (this.cluster?.shared) return undefined;
    return (this.open.get(region) ?? 0) > 0 || Date.now() - (this.lastEnd.get(region) ?? 0) < 1_500;
  }

  /** A region's poll: what's waiting for it, now or within 25 s (or until it hangs up). */
  async next(region: string, waitMs = POLL_MS, closed?: Promise<void>): Promise<RpcRequest[]> {
    this.open.set(region, (this.open.get(region) ?? 0) + 1);
    try {
      return await this.wait(region, waitMs, closed);
    } finally {
      this.open.set(region, (this.open.get(region) ?? 1) - 1);
      this.lastEnd.set(region, Date.now());
    }
  }

  private async wait(region: string, waitMs: number, closed?: Promise<void>): Promise<RpcRequest[]> {
    const take = async () => {
      const q = (this.queues.get(region) ?? []).filter((x) => x.until > Date.now());
      this.queues.set(region, []);
      const out: RpcRequest[] = [];
      for (const x of q) if (await this.claim(x.req.id)) out.push(x.req);
      return out;
    };
    const now = await take();
    if (now.length) return now;
    await new Promise<void>((resolve) => {
      const set = this.waiters.get(region) ?? this.waiters.set(region, new Set()).get(region)!;
      const done = () => {
        set.delete(done);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, waitMs);
      timer.unref?.();
      set.add(done);
      void closed?.then(done);
      // A question that arrived while this poll was looking (between the look and now) is not missed.
      if ((this.queues.get(region)?.length ?? 0) > 0) done();
    });
    return take();
  }

  /** A region's answers. */
  answer(responses: RpcResponse[]): void {
    for (const r of responses) {
      if (!this.settle(r)) this.cluster?.publish('region-rs', r);
    }
  }

  private settle(r: RpcResponse): boolean {
    const p = this.pending.get(r.id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(r.id);
    p.resolve(r);
    return true;
  }

  private enqueue(region: string, req: RpcRequest, until: number): void {
    (this.queues.get(region) ?? this.queues.set(region, []).get(region)!).push({ req, until });
    for (const w of [...(this.waiters.get(region) ?? [])]) w();
  }

  /** Only one control-plane instance hands a request to a region. */
  private async claim(id: string): Promise<boolean> {
    const redis = this.cluster?.redis;
    if (!redis) return true;
    return (await redis.set(`ct:region-rq:${id}`, '1', 'PX', 60_000, 'NX').catch(() => 'OK')) === 'OK';
  }
}
