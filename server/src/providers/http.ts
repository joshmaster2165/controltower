import { Agent, request, type Dispatcher } from 'undici';
import { networkError, timeoutError, type NormalizedError } from './adapter.js';

/**
 * Shared upstream HTTP: one keep-alive pool per origin, explicit timeouts,
 * abortable. Adapters build requests; this sends them.
 */
const CONNECT_TIMEOUT_MS = 10_000;
const HEADERS_TIMEOUT_MS = 60_000;
const BODY_IDLE_TIMEOUT_MS = 60_000;

const agents = new Map<string, Agent>();

function agentFor(url: string): Agent {
  const origin = new URL(url).origin;
  let a = agents.get(origin);
  if (!a) {
    a = new Agent({
      connections: 128,
      pipelining: 1,
      keepAliveTimeout: 30_000,
      connect: { timeout: CONNECT_TIMEOUT_MS },
    });
    agents.set(origin, a);
  }
  return a;
}

export interface UpstreamResponse {
  status: number;
  headers: Record<string, string>;
  body: Dispatcher.ResponseData['body'];
}

export async function sendUpstream(
  provider: string,
  req: { url: string; method: 'POST' | 'GET' | 'DELETE'; headers: Record<string, string>; body?: string | Uint8Array },
  signal: AbortSignal,
  opts: { headersTimeoutMs?: number | undefined; bodyTimeoutMs?: number | undefined } = {},
): Promise<{ ok: true; res: UpstreamResponse } | { ok: false; err: NormalizedError }> {
  try {
    const res = await request(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body ?? null,
      signal,
      dispatcher: agentFor(req.url),
      headersTimeout: opts.headersTimeoutMs ?? HEADERS_TIMEOUT_MS,
      bodyTimeout: opts.bodyTimeoutMs ?? BODY_IDLE_TIMEOUT_MS,
    });
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers)) {
      if (typeof v === 'string') headers[k.toLowerCase()] = v;
      else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(', ');
    }
    return { ok: true, res: { status: res.statusCode, headers, body: res.body } };
  } catch (err) {
    const e = err as Error & { code?: string };
    if (signal.aborted) return { ok: false, err: { code: 'client_aborted', message: 'client disconnected', httpStatus: 499, fallback: false, cooldown: false } };
    if (e.code === 'UND_ERR_HEADERS_TIMEOUT') return { ok: false, err: timeoutError(provider, 'headers') };
    if (e.code === 'UND_ERR_BODY_TIMEOUT') return { ok: false, err: timeoutError(provider, 'body') };
    if (e.code === 'UND_ERR_CONNECT_TIMEOUT') return { ok: false, err: timeoutError(provider, 'connect') };
    return { ok: false, err: networkError(provider, e) };
  }
}

export async function readBodyText(body: Dispatcher.ResponseData['body'], cap = 2 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of body) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array);
    size += b.length;
    if (size > cap) break;
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function closeAllAgents(): Promise<void> {
  await Promise.all([...agents.values()].map((a) => a.close().catch(() => undefined)));
  agents.clear();
}
