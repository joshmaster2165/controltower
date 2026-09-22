import { readBodyText, sendUpstream } from '../providers/http.js';
import { SseParser } from '../streaming/sse.js';

/**
 * Minimal MCP Streamable-HTTP client: JSON-RPC over POST with optional SSE
 * responses, session ids and protocol-version headers. Enough for
 * initialize / tools/list / tools/call / ping / resources / prompts, which is
 * everything the gateway proxies in v0.1. stdio upstreams are deliberately
 * out of scope (see the plan: spawning processes from an admin UI is RCE by
 * design); run them behind an HTTP bridge sidecar.
 */
export interface McpAuth {
  type: 'none' | 'bearer' | 'headers';
  token?: string;
  headers?: Record<string, string>;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export class McpUpstreamError extends Error {
  constructor(
    message: string,
    readonly code: 'unreachable' | 'http' | 'rpc' | 'timeout' | 'protocol',
    readonly rpc?: JsonRpcError,
    readonly status?: number,
  ) {
    super(message);
  }
}

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26'];

let nextId = 1;

export class McpUpstream {
  sessionId: string | undefined;
  protocolVersion = PROTOCOL_VERSIONS[0]!;
  serverInfo: { name?: string; version?: string } | undefined;
  capabilities: Record<string, unknown> = {};
  private initialized = false;
  private initializing: Promise<void> | null = null;

  constructor(
    readonly slug: string,
    readonly url: string,
    private readonly auth: McpAuth,
    private readonly timeoutMs = 120_000,
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (this.auth.type === 'bearer' && this.auth.token) h.authorization = `Bearer ${this.auth.token}`;
    if (this.auth.type === 'headers' && this.auth.headers) for (const [k, v] of Object.entries(this.auth.headers)) h[k.toLowerCase()] = v;
    if (this.sessionId) h['mcp-session-id'] = this.sessionId;
    if (this.initialized) h['mcp-protocol-version'] = this.protocolVersion;
    return h;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      this.sessionId = undefined;
      const result = (await this.rpc('initialize', {
        protocolVersion: PROTOCOL_VERSIONS[0],
        capabilities: {},
        clientInfo: { name: 'controltower', version: '0.1.0' },
      })) as { protocolVersion?: string; serverInfo?: { name?: string; version?: string }; capabilities?: Record<string, unknown> };
      if (result.protocolVersion) this.protocolVersion = result.protocolVersion;
      this.serverInfo = result.serverInfo;
      this.capabilities = result.capabilities ?? {};
      this.initialized = true;
      await this.notify('notifications/initialized');
    })();
    try {
      await this.initializing;
    } finally {
      this.initializing = null;
    }
  }

  reset(): void {
    this.initialized = false;
    this.sessionId = undefined;
  }

  async listTools(): Promise<McpTool[]> {
    await this.initialize();
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = (await this.call('tools/list', cursor ? { cursor } : {})) as { tools?: McpTool[]; nextCursor?: string };
      tools.push(...(r.tools ?? []));
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    await this.initialize();
    return (await this.call('tools/call', { name, arguments: args }, signal)) as Record<string, unknown>;
  }

  async ping(): Promise<void> {
    await this.initialize();
    await this.call('ping', {});
  }

  /** Generic passthrough for resources/* and prompts/*. */
  async call(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    try {
      return await this.rpc(method, params, signal);
    } catch (err) {
      // A 404 means the upstream forgot our session: re-initialize once.
      if (err instanceof McpUpstreamError && err.status === 404 && this.initialized) {
        this.reset();
        await this.initialize();
        return this.rpc(method, params, signal);
      }
      throw err;
    }
  }

  private async notify(method: string, params?: unknown): Promise<void> {
    const r = await sendUpstream(this.slug, { url: this.url, method: 'POST', headers: this.headers(), body: JSON.stringify({ jsonrpc: '2.0', method, params }) }, AbortSignal.timeout(this.timeoutMs));
    if (r.ok) {
      this.captureSession(r.res.headers);
      // Drain any body.
      await readBodyText(r.res.body, 64 * 1024).catch(() => undefined);
    }
  }

  private captureSession(headers: Record<string, string>): void {
    const sid = headers['mcp-session-id'];
    if (sid) this.sessionId = sid;
  }

  private async rpc(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const id = nextId++;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('timeout')), this.timeoutMs);
    const onAbort = () => ctrl.abort(signal?.reason ?? new Error('aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const r = await sendUpstream(this.slug, { url: this.url, method: 'POST', headers: this.headers(), body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) }, ctrl.signal);
      if (!r.ok) {
        if (r.err.code === 'provider_timeout' || ctrl.signal.aborted) throw new McpUpstreamError(`${this.slug}: ${method} timed out`, 'timeout');
        throw new McpUpstreamError(`${this.slug}: ${r.err.message}`, 'unreachable');
      }
      const res = r.res;
      this.captureSession(res.headers);
      if (res.status === 202) return {};
      if (res.status < 200 || res.status >= 300) {
        const text = await readBodyText(res.body, 64 * 1024).catch(() => '');
        throw new McpUpstreamError(`${this.slug}: HTTP ${res.status} ${text.slice(0, 200)}`, 'http', undefined, res.status);
      }
      const ctype = res.headers['content-type'] ?? '';
      let msg: { result?: unknown; error?: JsonRpcError; id?: number | string } | undefined;
      if (ctype.includes('text/event-stream')) {
        const parser = new SseParser();
        outer: for await (const chunk of res.body) {
          for (const f of parser.push(chunk as Uint8Array)) {
            if (!f.data) continue;
            try {
              const j = JSON.parse(f.data) as typeof msg;
              if (j && j.id === id && ('result' in j || 'error' in j)) {
                msg = j;
                break outer;
              }
            } catch {
              /* ignore non-json frames */
            }
          }
        }
        // Stop reading the stream once we have our answer.
        ctrl.abort(new Error('done'));
      } else {
        const text = await readBodyText(res.body, 8 * 1024 * 1024);
        const j = JSON.parse(text) as typeof msg | Array<NonNullable<typeof msg>>;
        msg = Array.isArray(j) ? j.find((m) => m.id === id) : j;
      }
      if (!msg) throw new McpUpstreamError(`${this.slug}: no response for ${method}`, 'protocol');
      if (msg.error) throw new McpUpstreamError(`${this.slug}: ${msg.error.message}`, 'rpc', msg.error);
      return msg.result ?? {};
    } catch (err) {
      if (err instanceof McpUpstreamError) throw err;
      if (ctrl.signal.aborted && String(ctrl.signal.reason?.message).includes('done')) throw new McpUpstreamError(`${this.slug}: stream ended`, 'protocol');
      throw new McpUpstreamError(`${this.slug}: ${(err as Error).message}`, ctrl.signal.aborted ? 'timeout' : 'unreachable');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}
