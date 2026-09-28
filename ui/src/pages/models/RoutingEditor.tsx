import { useState, type FormEvent } from 'react';

/** Fallback models, retries and caching: an alias's config, or a deployment served under its own name. */
export interface RouteConfig {
  fallbacks?: { context_window?: string[]; content_policy?: string[]; default?: string[] };
  retry?: { rate_limited?: number; timeout?: number; server_error?: number; unreachable?: number; max_attempts?: number };
  cache?: { ttl_s?: number };
}

/** A deployment's own settings (kept in its caps). */
export interface DeploymentCaps extends RouteConfig {
  region?: string;
  tags?: string[];
  context?: number;
  rpm?: number;
  tpm?: number;
  max_parallel?: number;
  headers_timeout_ms?: number;
}

const list = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
const numOrNull = (s: string): number | null => (s.trim() === '' ? null : Number(s));
const joined = (l: string[] | undefined) => (l ?? []).join(', ');

/** Short phrases for the table: "eu-west-1", "tags: batch", "60 rpm", "then gpt-4o if too long". */
export function routingSummary(c: DeploymentCaps | RouteConfig | undefined): string[] {
  if (!c) return [];
  const d = c as DeploymentCaps;
  const out: string[] = [];
  if (d.region) out.push(d.region);
  if (d.tags?.length) out.push(`for ${d.tags.join(', ')}`);
  if (d.context) out.push(`${d.context.toLocaleString('en-US')} tokens`);
  if (d.rpm) out.push(`${d.rpm} rpm`);
  if (d.tpm) out.push(`${d.tpm.toLocaleString('en-US')} tpm`);
  if (d.max_parallel) out.push(`${d.max_parallel} at a time`);
  const fb = c.fallbacks ?? {};
  if (fb.context_window?.length) out.push(`too long → ${fb.context_window.join(', ')}`);
  if (fb.content_policy?.length) out.push(`refused → ${fb.content_policy.join(', ')}`);
  if (fb.default?.length) out.push(`failing → ${fb.default.join(', ')}`);
  const r = c.retry ?? {};
  const retries = [r.rate_limited ? `${r.rate_limited}× on 429` : '', r.timeout ? `${r.timeout}× on timeout` : '', r.server_error ? `${r.server_error}× on 5xx` : ''].filter(Boolean);
  if (retries.length) out.push(`retry ${retries.join(', ')}`);
  if (c.cache?.ttl_s) out.push(`cached ${c.cache.ttl_s} s`);
  return out;
}

/**
 * Edit where calls go and what happens when they fail. Deployments have their own region, tags, context
 * window and limits; aliases (and deployments agents call by name) have fallback models and retries.
 */
export function RoutingEditor({ kind, value, withRouting, onSave, onCancel }: { kind: 'alias' | 'deployment'; value: DeploymentCaps | RouteConfig | undefined; withRouting: boolean; onSave: (patch: Record<string, unknown>) => Promise<void>; onCancel: () => void }) {
  const d = (value ?? {}) as DeploymentCaps;
  const [f, setF] = useState({
    region: d.region ?? '',
    tags: joined(d.tags),
    context: d.context?.toString() ?? '',
    rpm: d.rpm?.toString() ?? '',
    tpm: d.tpm?.toString() ?? '',
    max_parallel: d.max_parallel?.toString() ?? '',
    timeout_s: d.headers_timeout_ms ? String(d.headers_timeout_ms / 1000) : '',
    fb_context: joined(d.fallbacks?.context_window),
    fb_policy: joined(d.fallbacks?.content_policy),
    fb_default: joined(d.fallbacks?.default),
    r_429: d.retry?.rate_limited?.toString() ?? '',
    r_timeout: d.retry?.timeout?.toString() ?? '',
    r_5xx: d.retry?.server_error?.toString() ?? '',
    r_max: d.retry?.max_attempts?.toString() ?? '',
    cache: d.cache?.ttl_s?.toString() ?? '',
  });
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const routing: RouteConfig = {};
    const fallbacks = Object.fromEntries(Object.entries({ context_window: list(f.fb_context), content_policy: list(f.fb_policy), default: list(f.fb_default) }).filter(([, l]) => l.length));
    if (Object.keys(fallbacks).length) routing.fallbacks = fallbacks;
    const retry = Object.fromEntries(Object.entries({ rate_limited: numOrNull(f.r_429), timeout: numOrNull(f.r_timeout), server_error: numOrNull(f.r_5xx), max_attempts: numOrNull(f.r_max) }).filter(([, v]) => v != null));
    if (Object.keys(retry).length) routing.retry = retry;
    if (numOrNull(f.cache)) routing.cache = { ttl_s: Number(f.cache) };
    let patch: Record<string, unknown>;
    if (kind === 'alias') patch = { config: routing };
    else {
      const caps: Record<string, unknown> = {
        region: f.region.trim() || null,
        tags: list(f.tags).length ? list(f.tags) : null,
        context: numOrNull(f.context),
        rpm: numOrNull(f.rpm),
        tpm: numOrNull(f.tpm),
        max_parallel: numOrNull(f.max_parallel),
        headers_timeout_ms: numOrNull(f.timeout_s) == null ? null : Math.round(Number(f.timeout_s) * 1000),
      };
      if (withRouting) Object.assign(caps, { fallbacks: routing.fallbacks ?? null, retry: routing.retry ?? null, cache: routing.cache ?? null });
      patch = { caps };
    }
    try {
      setErr(null);
      await onSave(patch);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    }
  };

  return (
    <form className="routing-editor" onSubmit={(e) => void submit(e)}>
      {kind === 'deployment' && (
        <fieldset>
          <legend>Where and how much</legend>
          <label>
            Region
            <input className="input" value={f.region} onChange={set('region')} placeholder="eu-west-1, swedencentral…" />
          </label>
          <label>
            Reserved for tags
            <input className="input" value={f.tags} onChange={set('tags')} placeholder="batch, default" />
          </label>
          <label>
            Context window (tokens)
            <input className="input" type="number" min={0} value={f.context} onChange={set('context')} placeholder="from the price table" />
          </label>
          <label>
            Requests / minute
            <input className="input" type="number" min={0} value={f.rpm} onChange={set('rpm')} />
          </label>
          <label>
            Tokens / minute
            <input className="input" type="number" min={0} value={f.tpm} onChange={set('tpm')} />
          </label>
          <label>
            At a time
            <input className="input" type="number" min={0} value={f.max_parallel} onChange={set('max_parallel')} />
          </label>
          <label>
            Wait for an answer (s)
            <input className="input" type="number" min={0} value={f.timeout_s} onChange={set('timeout_s')} placeholder="60" />
          </label>
        </fieldset>
      )}
      {(kind === 'alias' || withRouting) && (
        <fieldset>
          <legend>When a call fails</legend>
          <label>
            Prompt too long → try
            <input className="input" value={f.fb_context} onChange={set('fb_context')} placeholder="a model with a larger window" />
          </label>
          <label>
            Content refused → try
            <input className="input" value={f.fb_policy} onChange={set('fb_policy')} placeholder="model names" />
          </label>
          <label>
            Anything else → try
            <input className="input" value={f.fb_default} onChange={set('fb_default')} placeholder="model names" />
          </label>
          <label>
            Retries on 429
            <input className="input" type="number" min={0} max={20} value={f.r_429} onChange={set('r_429')} placeholder="0" />
          </label>
          <label>
            Retries on timeout
            <input className="input" type="number" min={0} max={20} value={f.r_timeout} onChange={set('r_timeout')} placeholder="0" />
          </label>
          <label>
            Retries on 5xx
            <input className="input" type="number" min={0} max={20} value={f.r_5xx} onChange={set('r_5xx')} placeholder="0" />
          </label>
          <label>
            Attempts in all
            <input className="input" type="number" min={1} max={20} value={f.r_max} onChange={set('r_max')} placeholder="3" />
          </label>
          <label>
            Cache answers (s)
            <input className="input" type="number" min={0} value={f.cache} onChange={set('cache')} placeholder="off" />
          </label>
        </fieldset>
      )}
      {err && <div className="error">{err}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn primary sm" type="submit">
          Save
        </button>
        <button className="btn ghost sm" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
