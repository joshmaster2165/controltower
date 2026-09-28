import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { globMatch, type DeploymentRecord, type KeyRecord } from '../registry.js';
import { E } from '../gateway/errors.js';

/**
 * How a call picks where it goes, beyond its model name: the regions its key may be served in (data
 * residency), the tags it carries (tag routing, and spend by tag), and the customer it is for.
 */

/** An alias's (or a deployment's) routing: fallback models, retries, caching. */
export interface RouteConfig {
  /** Models (aliases or names) to try once this one's deployments have failed. */
  fallbacks?: {
    /** When the prompt is too long for the model. */
    context_window?: string[];
    /** When the provider refused the content. */
    content_policy?: string[];
    /** When every deployment failed otherwise (rate limited, down, timed out). */
    default?: string[];
  };
  /** Tries on the same deployment before moving on, by what went wrong, and a cap on attempts in all. */
  retry?: { rate_limited?: number; timeout?: number; server_error?: number; unreachable?: number; max_attempts?: number };
  /** Answers kept and served again for identical requests (opt-in). */
  cache?: { ttl_s?: number };
}

/** A deployment's own routing settings, kept in its caps. */
export interface DeploymentCaps extends RouteConfig {
  /** Where the provider serves it, e.g. eu-west-1, swedencentral. */
  region?: string;
  /** Requests carrying one of these tags are routed here; `default` serves untagged requests too. */
  tags?: string[];
  /** The model's context window, when the price table doesn't know it. */
  context?: number;
  rpm?: number;
  tpm?: number;
  max_parallel?: number;
  headers_timeout_ms?: number;
}

export function capsOf(d: DeploymentRecord): DeploymentCaps {
  return d.caps as DeploymentCaps;
}

export interface RequestMeta {
  tags: string[];
  customer: string | undefined;
  region: string | undefined;
}

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/**
 * Tags, customer and region from the request: `x-ct-tags` (comma-separated), `x-ct-customer` and
 * `x-ct-region` headers, or a `ct` object in the body ({tags, customer, region}). Tags may also come as
 * `metadata.tags` (taken out of the body: providers want string metadata). The customer falls back to the
 * request's own `user` field (OpenAI) or `metadata.user_id` (Anthropic).
 */
export function requestMeta(req: FastifyRequest, body: Record<string, unknown>): RequestMeta {
  const ct = (body.ct && typeof body.ct === 'object' ? body.ct : {}) as { tags?: unknown; customer?: unknown; region?: unknown };
  const tags = new Set<string>();
  const add = (t: unknown) => {
    const s = str(t, 64);
    if (s && tags.size < 16) tags.add(s);
  };
  const h = req.headers['x-ct-tags'];
  if (typeof h === 'string') for (const t of h.split(',')) add(t);
  if (Array.isArray(ct.tags)) for (const t of ct.tags) add(t);
  const md = body.metadata as Record<string, unknown> | undefined;
  if (md && typeof md === 'object' && Array.isArray(md.tags)) {
    for (const t of md.tags) add(t);
    const { tags: _t, ...rest } = md;
    if (Object.keys(rest).length) body.metadata = rest;
    else delete body.metadata;
  }
  const hc = req.headers['x-ct-customer'];
  const customer = str(hc, 128) ?? str(ct.customer, 128) ?? str(body.user, 128) ?? str(md?.user_id, 128);
  const region = str(req.headers['x-ct-region'], 64) ?? str(ct.region, 64);
  return { tags: [...tags], customer, region };
}

/** Where a deployment is served: its own region, else its provider's (Bedrock's credentials, or a region set on the provider). */
export function regionOf(ctx: AppContext, d: DeploymentRecord): string | undefined {
  const own = capsOf(d).region;
  if (own) return own;
  const p = ctx.registry.providers.get(d.providerId);
  return p ? ((p.extra.region as string | undefined) ?? p.creds.region ?? undefined) : undefined;
}

/**
 * The candidates this call may use: in the regions its key allows (and the one it asked for), and — when it
 * carries tags that some deployments are tagged with — those deployments. Deployments tagged for routing
 * serve only requests with one of their tags, unless tagged `default`.
 */
export function routeCandidates(ctx: AppContext, key: KeyRecord, model: string, meta: RequestMeta, candidates: DeploymentRecord[]): DeploymentRecord[] {
  let out = candidates;
  const allowed = key.regions;
  if (meta.region && allowed.length && !allowed.some((p) => globMatch(p, meta.region!))) throw E.regionNotAllowed(meta.region, allowed);
  const wanted = meta.region ? [meta.region] : allowed;
  if (wanted.length) {
    out = out.filter((d) => {
      const r = regionOf(ctx, d);
      return !!r && wanted.some((p) => globMatch(p, r));
    });
    if (!out.length) throw E.noDeploymentInRegion(model, wanted, candidates.map((d) => regionOf(ctx, d) ?? 'no region'));
  }
  const tagged = (d: DeploymentRecord) => capsOf(d).tags ?? [];
  const matching = meta.tags.length ? out.filter((d) => tagged(d).some((t) => meta.tags.includes(t))) : [];
  if (matching.length) return matching;
  const open = out.filter((d) => !tagged(d).length || tagged(d).includes('default'));
  if (!open.length) throw E.noDeploymentForTags(model, meta.tags, [...new Set(out.flatMap(tagged))]);
  return open;
}
