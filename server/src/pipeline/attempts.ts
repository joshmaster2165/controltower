import type { AppContext } from '../context.js';
import type { DeploymentRecord, KeyRecord, ProviderRecord } from '../registry.js';
import type { NormalizedError } from '../providers/adapter.js';
import { E, type GatewayError } from '../gateway/errors.js';
import { capsOf, type RouteConfig } from './routing.js';
import type { Flight } from './flight.js';

/**
 * Which deployment a call tries next, and when to stop. In order:
 *   - the same deployment again, when its retry rules allow it for what went wrong (rate limited, timed out, …);
 *   - the next candidate — skipping one whose context window the prompt can't fit, or that is at its own
 *     rate or concurrency limit;
 *   - after a prompt too long for the model, only candidates with a larger (or unknown) window;
 *   - once the candidates are spent, the alias's fallback models: for the context window, for a content
 *     refusal, or by default — each still subject to the key's allowed models and to policy.
 */
export type ErrClass = 'rate_limited' | 'timeout' | 'server_error' | 'unreachable' | 'context_window' | 'content_policy' | 'auth' | 'not_found' | 'other';

export function classify(e: NormalizedError): ErrClass {
  switch (e.code) {
    case 'provider_rate_limited':
      return 'rate_limited';
    case 'provider_timeout':
      return 'timeout';
    case 'provider_unreachable':
      return 'unreachable';
    case 'provider_context_window_exceeded':
      return 'context_window';
    case 'provider_content_policy':
      return 'content_policy';
    case 'provider_auth_error':
      return 'auth';
    case 'provider_model_not_found':
      return 'not_found';
    case 'provider_error':
      return (e.upstreamStatus ?? 0) >= 500 ? 'server_error' : 'other';
    default:
      return 'other';
  }
}

const RETRYABLE: ReadonlySet<ErrClass> = new Set(['rate_limited', 'timeout', 'server_error', 'unreachable']);

export interface Attempt {
  dep: DeploymentRecord;
  prov: ProviderRecord;
}

export interface PlanOptions {
  /** Tokens the call needs room for: the prompt, plus the reply it asked for. 0 skips the check. */
  needTokens: number;
  /** Providers that can serve this kind of call. */
  servedBy?: ((p: ProviderRecord) => boolean) | undefined;
  /** Whether policy lets this key reach a fallback model (a gate on it applies to fallbacks too). */
  allowFallback?: ((model: string) => Promise<boolean>) | undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class AttemptPlan {
  private queue: DeploymentRecord[];
  private tried = new Set<string>();
  private retries = new Map<string, number>();
  private fallbacksUsed = new Set<string>();
  private busy = 0;
  private release: (() => void) | undefined;
  private readonly cfg: RouteConfig;
  private maxAttempts: number;
  private smallest: { need: number; largest: number } | undefined;

  constructor(
    private readonly ctx: AppContext,
    private readonly f: Flight,
    private readonly key: KeyRecord,
    private readonly o: PlanOptions,
  ) {
    const route = f.route!;
    this.cfg = route.alias?.config ?? (route.candidates[0] ? capsOf(route.candidates[0]) : {});
    this.maxAttempts = Math.max(1, this.cfg.retry?.max_attempts ?? 3);
    this.queue = this.fitting([...route.candidates]);
  }

  /** The context window a deployment is known to have, if any. */
  contextOf(d: DeploymentRecord): number | undefined {
    const own = capsOf(d).context;
    if (typeof own === 'number' && own > 0) return own;
    const p = this.ctx.registry.providers.get(d.providerId);
    return p ? this.ctx.pricing.resolve(p.kind, d.upstreamModel, d.pricingOverride, p.slug).entry?.context : undefined;
  }

  /** Candidates the prompt fits in (unknown windows are given the benefit of the doubt). */
  private fitting(ds: DeploymentRecord[]): DeploymentRecord[] {
    if (!this.o.needTokens) return ds;
    const out = ds.filter((d) => {
      const c = this.contextOf(d);
      return c == null || c >= this.o.needTokens;
    });
    if (out.length < ds.length) {
      const largest = Math.max(...ds.map((d) => this.contextOf(d) ?? 0));
      this.smallest = { need: this.o.needTokens, largest };
    }
    return out;
  }

  /** Let go of the slot held on the deployment last tried. */
  done(): void {
    this.release?.();
    this.release = undefined;
  }

  /**
   * The next deployment to try, after `last` failed (or the first). Undefined when there is nothing left:
   * the caller refuses with `refusal()`, or rethrows the last error.
   */
  async next(last?: { dep: DeploymentRecord; err: NormalizedError }): Promise<Attempt | undefined> {
    this.done();
    const f = this.f;
    let cls: ErrClass | undefined;
    if (last) {
      cls = classify(last.err);
      if (f.bytesWritten > 0) return undefined;
      // The same deployment again, when its rules allow it for this kind of failure.
      const rules = capsOf(last.dep).retry ?? this.cfg.retry ?? {};
      const allowed = RETRYABLE.has(cls) ? (rules[cls as 'rate_limited' | 'timeout' | 'server_error' | 'unreachable'] ?? 0) : 0;
      const n = this.retries.get(last.dep.id) ?? 0;
      if (n < allowed && f.attempts < this.maxAttempts + this.fallbacksUsed.size * this.maxAttempts) {
        this.retries.set(last.dep.id, n + 1);
        await sleep(Math.min(4000, 250 * 2 ** n));
        const again = await this.acquire(last.dep);
        if (again) return again;
      }
      if (cls === 'context_window') {
        // Only larger windows can help now.
        const failed = this.contextOf(last.dep);
        this.queue = this.queue.filter((d) => {
          const c = this.contextOf(d);
          return c == null || failed == null || c > failed;
        });
      } else if (cls === 'content_policy') {
        this.queue = []; // another deployment of the same model would refuse it too
      } else if (!last.err.fallback) return undefined;
    }
    for (;;) {
      if (f.attempts >= this.maxAttempts * (1 + this.fallbacksUsed.size)) return undefined;
      const dep = this.queue.shift();
      if (!dep) {
        if (await this.addFallbacks(cls)) continue;
        return undefined;
      }
      if (this.tried.has(dep.id)) continue;
      this.tried.add(dep.id);
      const got = await this.acquire(dep);
      if (got) return got;
      this.busy++;
      this.ctx.bus.emit({ t: 'flight.upstream', flight_id: f.id, ts: Date.now(), attempt: f.attempts + 1, deployment_id: dep.id, provider_id: dep.providerId, upstream_model: dep.upstreamModel, outcome: 'fallback', error_code: 'deployment_busy' });
    }
  }

  /** Why nothing was tried, when nothing was: every deployment busy, or the prompt too long for all of them. */
  refusal(): GatewayError | undefined {
    if (this.f.attempts > 0) return undefined;
    if (this.busy) return E.deploymentBusy(this.f.modelRequested);
    if (this.smallest) return E.contextWindowExceeded(this.f.modelRequested, this.smallest.need, this.smallest.largest);
    return undefined;
  }

  /** Take a deployment's own rate and concurrency limits; undefined when it is at one of them. */
  private async acquire(dep: DeploymentRecord): Promise<Attempt | undefined> {
    const prov = this.ctx.registry.providers.get(dep.providerId);
    if (!prov) return undefined;
    const caps = capsOf(dep);
    if ((caps.rpm ?? 0) > 0 || (caps.tpm ?? 0) > 0) {
      const a = await this.ctx.limiter.admit(`dep:${dep.id}`, this.f.estInput, { ...(caps.rpm ? { rpm: caps.rpm } : {}), ...(caps.tpm ? { tpm: caps.tpm } : {}) });
      if (!a.ok) return undefined;
    }
    if ((caps.max_parallel ?? 0) > 0) {
      const r = await this.ctx.limiter.acquireSlot(`dep:${dep.id}`, caps.max_parallel!);
      if (!r) return undefined;
      this.release = r;
    }
    return { dep, prov };
  }

  /** The alias's fallback models for what went wrong, added to the queue (each used once). */
  private async addFallbacks(cls: ErrClass | undefined): Promise<boolean> {
    const fb = this.cfg.fallbacks ?? {};
    const list = cls === 'context_window' ? (fb.context_window ?? fb.default) : cls === 'content_policy' ? fb.content_policy : cls ? fb.default : this.smallest ? fb.context_window : undefined;
    for (const model of list ?? []) {
      if (this.fallbacksUsed.has(model)) continue;
      this.fallbacksUsed.add(model);
      if (!this.ctx.registry.keyMayUseModel(this.key, model)) continue;
      if (this.o.allowFallback && !(await this.o.allowFallback(model))) continue;
      let res = this.ctx.registry.resolveModel(model);
      if (!res.candidates.length && (await this.ctx.autoModels.ensure(model))) res = this.ctx.registry.resolveModel(model);
      const served = res.candidates.filter((d) => {
        const p = this.ctx.registry.providers.get(d.providerId);
        return !!p && (!this.o.servedBy || this.o.servedBy(p)) && !this.tried.has(d.id);
      });
      const fits = this.fitting(served);
      if (fits.length) {
        this.queue.push(...fits);
        return true;
      }
    }
    return false;
  }
}
