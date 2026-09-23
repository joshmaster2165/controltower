import type { IncomingHttpHeaders } from 'node:http';
import type { PolicyTarget } from '../policy/engine.js';

/**
 * Pure helpers for the HTTP gateway: how a request is named, classified,
 * joined onto its upstream, and which headers cross the boundary.
 */

export interface HttpApiAuth {
  type: 'none' | 'bearer' | 'header';
  /** bearer token, or the header value */
  token?: string;
  /** header name for type 'header', e.g. "x-api-key" */
  header?: string;
}

/** GET/HEAD/OPTIONS read; POST/PUT/PATCH write; DELETE is destructive ('admin'). */
export function httpOperation(method: string): PolicyTarget['operation'] {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return 'read';
  if (m === 'DELETE') return 'admin';
  if (m === 'POST' || m === 'PUT' || m === 'PATCH') return 'write';
  return 'unknown';
}

/** Operation from a stored route label like "DELETE /v2/users/:id". */
export function routeOperation(route: string | null | undefined): PolicyTarget['operation'] {
  return httpOperation((route ?? '').split(' ')[0] ?? '');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIXED_ID = /^[a-z]{1,5}_[A-Za-z0-9]*\d[A-Za-z0-9]*$/; // cus_9a8B7c, c_8812, inc_42

function isIdentifier(seg: string): boolean {
  return /^\d+$/.test(seg) || UUID.test(seg) || /^[0-9a-f]{16,}$/i.test(seg) || PREFIXED_ID.test(seg) || seg.length >= 24;
}

/**
 * "GET /v2/users/8812/orders" → "GET /v2/users/:id/orders". Identifiers are
 * folded so the map shows a handful of routes, not one row per record.
 */
export function routeLabel(method: string, path: string): string {
  const segs = path
    .split('/')
    .filter(Boolean)
    .map((s) => {
      let d = s;
      try {
        d = decodeURIComponent(s);
      } catch {
        // keep the raw segment
      }
      return isIdentifier(d) ? ':id' : d;
    });
  return `${method.toUpperCase()} /${segs.join('/')}`.slice(0, 200);
}

/**
 * Joins the agent's path onto the API's base URL. Anything that could climb
 * out of the base (dot segments, encoded dots, backslashes) is refused: an
 * agent may reach only what the admin registered.
 */
export function upstreamUrl(baseUrl: string, rest: string, search: string): URL | null {
  let base: URL;
  try {
    base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  } catch {
    return null;
  }
  if (/(^|\/)\.{1,2}(\/|$)/.test(rest) || /%2e/i.test(rest) || rest.includes('\\')) return null;
  const u = new URL(rest.replace(/^\/+/, ''), base);
  if (u.origin !== base.origin || !u.pathname.startsWith(base.pathname)) return null;
  u.search = search;
  return u;
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']);

/** Where the agent's Control Tower key came from, so it is never forwarded. */
export type KeySource = 'x-ct-key' | 'authorization' | 'x-api-key';

/** The agent's key: `x-ct-key`, else a ct_sk_ bearer token or x-api-key. */
export function ctKey(h: IncomingHttpHeaders): { key: string; source: KeySource } | undefined {
  const x = h['x-ct-key'];
  if (typeof x === 'string' && x.trim()) return { key: x.trim(), source: 'x-ct-key' };
  const a = h.authorization;
  if (typeof a === 'string' && a.toLowerCase().startsWith('bearer ') && a.slice(7).trim().startsWith('ct_sk_')) return { key: a.slice(7).trim(), source: 'authorization' };
  const k = h['x-api-key'];
  if (typeof k === 'string' && k.trim().startsWith('ct_sk_')) return { key: k.trim(), source: 'x-api-key' };
  return undefined;
}

/**
 * Headers sent upstream: the agent's own headers minus hop-by-hop ones, the
 * Control Tower key and every x-ct-* header; then the API's stored
 * credentials, which win over anything the agent sent.
 */
export function upstreamHeaders(h: IncomingHttpHeaders, source: KeySource, auth: HttpApiAuth): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    const name = k.toLowerCase();
    if (v === undefined || HOP_BY_HOP.has(name) || name.startsWith('x-ct-') || name === source || name === 'accept-encoding') continue;
    out[name] = Array.isArray(v) ? v.join(', ') : v;
  }
  // Uncompressed replies, so inspect gates can read them.
  out['accept-encoding'] = 'identity';
  if (auth.type === 'bearer' && auth.token) out.authorization = `Bearer ${auth.token}`;
  if (auth.type === 'header' && auth.header && auth.token) out[auth.header.toLowerCase()] = auth.token;
  return out;
}

/** Response headers passed back to the agent. */
export function downstreamHeaders(h: Record<string, string | string[] | undefined>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(h)) {
    const name = k.toLowerCase();
    if (v === undefined || HOP_BY_HOP.has(name)) continue;
    out[name] = v;
  }
  return out;
}

/** Content types worth parsing for policy arguments and inspect gates. */
export function isTextual(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const c = contentType.toLowerCase();
  return c.includes('json') || c.startsWith('text/') || c.includes('xml') || c.includes('x-www-form-urlencoded') || c.includes('graphql');
}
