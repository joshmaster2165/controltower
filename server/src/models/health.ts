import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';
import type { DeploymentRecord, ProviderRecord, Registry } from '../registry.js';
import type { ProviderAdapter } from '../providers/adapter.js';
import { capsOf } from '../pipeline/routing.js';

/**
 * Background health checks for models, so a model that stops answering shows on the map — and alerts —
 * before an agent's call fails on it. Every few minutes each connected provider is asked for its models:
 *   - a provider that doesn't answer marks its models down;
 *   - a model the provider no longer lists is marked missing (for providers whose lists name models exactly);
 *   - a deployment with `health_probe` set gets a real one-token call, for providers that answer lists but
 *     not calls (a quota spent, a model not enabled in a region).
 * Demo stand-ins are skipped. With several instances, one does the checking (the others see it in the database).
 */
export interface HealthResult {
  health: 'ok' | 'down' | 'missing';
  detail: string;
  latencyMs: number;
}

/** A failed model list that means the provider is down, not merely without a list. */
const UNHEALTHY = /cannot reach|timed out|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up|authentication failed|HTTP 5\d\d|server had an error|unavailable|overloaded/i;

/** Providers whose model list names models exactly as agents' deployments do. */
const EXACT_LISTS = new Set(['openai', 'openai-compatible', 'anthropic']);

export class ModelHealth {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly deps: {
      db: Kysely<Database>;
      registry: Registry;
      adapters: { get(kind: string): ProviderAdapter | undefined };
      log: { info(o: object, m: string): void; warn(o: object, m: string): void };
      /** Told when a model goes down or comes back. */
      onChange?: (d: DeploymentRecord, label: string, r: HealthResult, was: string | undefined) => void;
      /** With several instances: whether this one does the checking now. */
      isLeader?: (() => Promise<boolean>) | undefined;
    },
  ) {}

  start(intervalMs: number): void {
    if (intervalMs <= 0) return;
    const tick = () => void this.checkAll().catch((err) => this.deps.log.warn({ err: (err as Error).message }, 'model health check failed'));
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref?.();
    setTimeout(tick, 5_000).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Check every connected provider and its models once. */
  async checkAll(): Promise<number> {
    if (this.running) return 0;
    if (this.deps.isLeader && !(await this.deps.isLeader())) return 0;
    this.running = true;
    let n = 0;
    try {
      const r = this.deps.registry;
      for (const p of r.providers.values()) {
        if (p.demo) continue;
        const deps = [...r.deployments.values()].filter((d) => d.providerId === p.id && d.enabled);
        if (!deps.length) continue;
        const listed = await this.list(p);
        for (const d of deps) {
          const res = capsOf(d).health_probe ? await this.probe(p, d) : this.fromList(p, d, listed);
          await this.record(d, res);
          n++;
        }
      }
    } finally {
      this.running = false;
    }
    return n;
  }

  /** One deployment, with a real call: for the console's "Check now". */
  async checkOne(id: string): Promise<HealthResult | undefined> {
    const d = this.deps.registry.deployments.get(id);
    const p = d ? this.deps.registry.providers.get(d.providerId) : undefined;
    if (!d || !p) return undefined;
    const res = await this.probe(p, d);
    await this.record(d, res);
    return res;
  }

  private async list(p: ProviderRecord): Promise<{ ok: boolean; ids: Set<string>; detail: string; latencyMs: number }> {
    const a = this.deps.adapters.get(p.kind);
    const t0 = Date.now();
    if (!a?.listModels) {
      if (!a?.healthCheck) return { ok: true, ids: new Set(), detail: 'no health check for this provider', latencyMs: 0 };
      const h = await a.healthCheck(p);
      return { ok: h.ok, ids: new Set(), detail: h.detail ?? '', latencyMs: h.latencyMs };
    }
    try {
      const models = await a.listModels(p);
      return { ok: true, ids: new Set(models.map((m) => m.id)), detail: `${models.length} models listed`, latencyMs: Date.now() - t0 };
    } catch (err) {
      const e = err as Error & { status?: number; code?: string };
      const detail = e.message.slice(0, 300);
      // Some servers simply have no model list (404): that says nothing about their health. Unreachable,
      // refusing the credentials, or failing, does.
      const down = e.status != null ? e.status >= 500 || e.status === 401 || e.status === 403 : e.code === 'provider_unreachable' || e.code === 'provider_timeout' || UNHEALTHY.test(detail);
      return { ok: !down, ids: new Set(), detail: down ? detail : 'no model list', latencyMs: Date.now() - t0 };
    }
  }

  private fromList(p: ProviderRecord, d: DeploymentRecord, l: { ok: boolean; ids: Set<string>; detail: string; latencyMs: number }): HealthResult {
    if (!l.ok) return { health: 'down', detail: `${p.name} is not answering: ${l.detail}`, latencyMs: l.latencyMs };
    if (EXACT_LISTS.has(p.kind) && l.ids.size && !l.ids.has(d.upstreamModel)) return { health: 'missing', detail: `${p.name} no longer lists ${d.upstreamModel}`, latencyMs: l.latencyMs };
    return { health: 'ok', detail: l.detail, latencyMs: l.latencyMs };
  }

  /** A real, tiny call: one token (or one embedding). */
  private async probe(p: ProviderRecord, d: DeploymentRecord): Promise<HealthResult> {
    const a = this.deps.adapters.get(p.kind);
    if (!a) return { health: 'down', detail: `no adapter for ${p.kind}`, latencyMs: 0 };
    const t0 = Date.now();
    const embed = capsOf(d).mode === 'embedding';
    const body = embed ? { model: d.upstreamModel, input: 'ping' } : { model: d.upstreamModel, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] };
    const r = await a.send({ flightId: 'health', provider: p, deployment: d, signal: AbortSignal.timeout(30_000) }, body, { inboundDialect: 'openai-chat', stream: false, upstreamModel: d.upstreamModel });
    const latencyMs = Date.now() - t0;
    if (r.kind === 'error') return { health: 'down', detail: r.err.message.slice(0, 300), latencyMs };
    if (r.kind === 'stream') for await (const _ of r.events) void _;
    return { health: 'ok', detail: `answered in ${latencyMs} ms`, latencyMs };
  }

  private async record(d: DeploymentRecord, res: HealthResult): Promise<void> {
    const was = d.health;
    const now = Date.now();
    await this.deps.db.updateTable('deployments').set({ health: res.health, health_detail: res.detail, health_checked_at: now }).where('id', '=', d.id).execute();
    d.health = res.health;
    d.healthDetail = res.detail;
    d.healthCheckedAt = now;
    if (was !== res.health) {
      const label = d.publicName ?? d.upstreamModel;
      if (res.health !== 'ok' || (was && was !== 'ok')) this.deps.log.info({ model: label, health: res.health, was: was ?? 'unknown', detail: res.detail }, 'model health changed');
      this.deps.onChange?.(d, label, res, was);
    }
  }
}
