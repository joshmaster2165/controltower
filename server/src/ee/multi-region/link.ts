import type { FastifyInstance } from 'fastify';
import type { WsServerMessage } from '@controltower/shared';
import type { RpcRequest, RpcResponse } from './hub.js';

/**
 * A region's side of the link to its control plane (Enterprise): it keeps a request open for the console's
 * questions and answers each from its own API (in-process, as the person who asked, within their teams), and
 * sends its live traffic every second. Only outbound connections: the region never has to be reachable.
 */
export class RegionLink {
  private stopped = false;
  private frames: WsServerMessage[] = [];
  private flags = { approvals: false, topology: false };
  private flusher: NodeJS.Timeout | undefined;
  private unsubs: Array<() => void> = [];
  connected = false;

  constructor(
    private readonly deps: {
      app: FastifyInstance;
      region: { name: string; controlPlaneUrl: string; token: string };
      instanceId: string;
      internalSecret: string;
      onLocalFrame: (fn: (m: WsServerMessage) => void) => () => void;
      onApprovals: (fn: () => void) => () => void;
      onTopology: (fn: () => void) => () => void;
      log: () => { warn(o: object, m: string): void };
    },
  ) {}

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.deps.region.token}`, 'x-ct-region': this.deps.region.name, 'x-ct-instance': this.deps.instanceId };
  }

  start(): void {
    this.unsubs.push(
      this.deps.onLocalFrame((m) => {
        if ((m.type === 'tick' || m.type === 'events') && this.frames.length < 600) this.frames.push(m);
      }),
      this.deps.onApprovals(() => void (this.flags.approvals = true)),
      this.deps.onTopology(() => void (this.flags.topology = true)),
    );
    this.flusher = setInterval(() => void this.flush(), 1_000);
    this.flusher.unref?.();
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.flusher) clearInterval(this.flusher);
    for (const u of this.unsubs) u();
  }

  private async loop(): Promise<void> {
    let backoff = 1_000;
    while (!this.stopped) {
      try {
        const r = await fetch(`${this.deps.region.controlPlaneUrl}/cp/v1/link/next`, { headers: this.headers(), signal: AbortSignal.timeout(40_000) });
        this.connected = r.status === 200 || r.status === 204;
        if (r.status === 200) {
          const { requests } = (await r.json()) as { requests: RpcRequest[] };
          for (const q of requests) void this.handle(q);
        } else if (r.status !== 204) throw new Error(`the control plane answered ${r.status}`);
        else await r.body?.cancel();
        backoff = 1_000;
      } catch (err) {
        this.connected = false;
        if (this.stopped) return;
        this.deps.log().warn({ err: (err as Error).message }, 'region: link to the control plane down (retrying)');
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 15_000);
      }
    }
  }

  /** Answer one question from this region's own API, as the person who asked. */
  private async handle(q: RpcRequest): Promise<void> {
    let res: RpcResponse;
    try {
      const r = await this.deps.app.inject({
        method: q.method,
        url: q.url,
        headers: { 'x-ct-internal': this.deps.internalSecret, ...(q.scope ? { 'x-ct-scope': JSON.stringify(q.scope) } : {}), ...(q.acting ? { 'x-ct-acting': q.acting } : {}), ...(q.body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(q.body !== undefined ? { payload: JSON.stringify(q.body) } : {}),
      });
      let body: unknown = r.body;
      try {
        body = r.json();
      } catch {
        // not JSON: sent as text
      }
      res = { id: q.id, status: r.statusCode, body };
    } catch (err) {
      res = { id: q.id, status: 500, body: { error: { code: 'region_error', message: (err as Error).message } } };
    }
    await fetch(`${this.deps.region.controlPlaneUrl}/cp/v1/link/res`, { method: 'POST', headers: { ...this.headers(), 'content-type': 'application/json' }, body: JSON.stringify({ responses: [res] }), signal: AbortSignal.timeout(20_000) }).catch((err: Error) =>
      this.deps.log().warn({ err: err.message }, 'region: an answer to the control plane was lost'),
    );
  }

  private async flush(): Promise<void> {
    if (!this.frames.length && !this.flags.approvals && !this.flags.topology) return;
    const body = { frames: this.frames, ...this.flags };
    this.frames = [];
    this.flags = { approvals: false, topology: false };
    await fetch(`${this.deps.region.controlPlaneUrl}/cp/v1/link/live`, { method: 'POST', headers: { ...this.headers(), 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
  }
}
