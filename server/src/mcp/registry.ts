import crypto from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';
import type { SecretBox } from '../crypto/secrets.js';
import { McpUpstream, type McpAuth, type McpTool } from './upstream.js';

export interface McpServerRecord {
  id: string;
  slug: string;
  name: string;
  url: string;
  transport: string;
  auth: McpAuth;
  timeoutMs: number;
  enabled: boolean;
  health: string;
  healthDetail: string | undefined;
  tools: McpTool[];
  toolsHash: string | undefined;
  lastCheckedAt: number | undefined;
  demo: boolean;
  /** The agent this server fronts, when it is one (a sub-agent exposed as tools): calls to it are agent-to-agent. */
  agentId: string | undefined;
}

export const TOOL_SEP = '__';

export function namespaced(slug: string, tool: string): string {
  return `${slug}${TOOL_SEP}${tool}`;
}

export function splitNamespaced(name: string): { slug: string; tool: string } | null {
  const i = name.indexOf(TOOL_SEP);
  if (i <= 0) return null;
  return { slug: name.slice(0, i), tool: name.slice(i + TOOL_SEP.length) };
}

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/**
 * MCP server registry + upstream connection pool + health/tool discovery.
 * Tool lists are cached so `tools/list` on the gateway never fans out to
 * upstreams on the hot path.
 */
export class McpRegistry {
  servers = new Map<string, McpServerRecord>();
  bySlug = new Map<string, McpServerRecord>();
  private clients = new Map<string, McpUpstream>();
  private timer: NodeJS.Timeout | undefined;
  version = 0;
  private listeners = new Set<() => void>();

  constructor(
    private readonly db: Kysely<Database>,
    private readonly secrets: SecretBox,
  ) {}

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async reload(): Promise<void> {
    const rows = await this.db.selectFrom('mcp_servers').selectAll().execute();
    const servers = new Map<string, McpServerRecord>();
    const bySlug = new Map<string, McpServerRecord>();
    for (const r of rows) {
      let auth: McpAuth = { type: 'none' };
      if (r.auth_enc) {
        try {
          auth = JSON.parse(this.secrets.decrypt(r.auth_enc, `mcp_servers.auth_enc.${r.id}`)) as McpAuth;
        } catch (err) {
          console.error(`[mcp] cannot decrypt auth for ${r.slug}:`, (err as Error).message);
        }
      }
      const rec: McpServerRecord = {
        id: r.id,
        slug: r.slug,
        name: r.name,
        url: r.url,
        transport: r.transport,
        auth,
        timeoutMs: r.timeout_ms,
        enabled: r.enabled === 1,
        health: r.health,
        healthDetail: r.health_detail ?? undefined,
        tools: parseJson<McpTool[]>(r.tools_cache, []),
        toolsHash: r.tools_hash ?? undefined,
        lastCheckedAt: r.last_checked_at ?? undefined,
        demo: r.demo === 1,
        agentId: r.agent_id ?? undefined,
      };
      servers.set(rec.id, rec);
      bySlug.set(rec.slug, rec);
      // Drop stale clients whose config changed.
      const c = this.clients.get(rec.id);
      if (c && (c.url !== rec.url)) this.clients.delete(rec.id);
    }
    for (const id of this.clients.keys()) if (!servers.has(id)) this.clients.delete(id);
    this.servers = servers;
    this.bySlug = bySlug;
    this.version++;
    for (const l of this.listeners) {
      try {
        l();
      } catch (err) {
        console.error('[mcp] listener error', err);
      }
    }
  }

  client(server: McpServerRecord): McpUpstream {
    let c = this.clients.get(server.id);
    if (!c) {
      c = new McpUpstream(server.slug, server.url, server.auth, server.timeoutMs);
      this.clients.set(server.id, c);
    }
    return c;
  }

  /** Initialize, list tools, persist health + cache. */
  async check(server: McpServerRecord): Promise<{ ok: boolean; latencyMs: number; detail?: string; tools: McpTool[] }> {
    const t0 = Date.now();
    const c = this.client(server);
    try {
      c.reset();
      const tools = await c.listTools();
      const hash = crypto.createHash('sha256').update(JSON.stringify(tools.map((t) => [t.name, t.description ?? '', t.inputSchema ?? null]))).digest('hex').slice(0, 16);
      const detail = `${tools.length} tools · ${c.serverInfo?.name ?? 'server'} ${c.serverInfo?.version ?? ''}`.trim();
      await this.db
        .updateTable('mcp_servers')
        .set({ health: 'ok', health_detail: detail, tools_cache: JSON.stringify(tools), tools_hash: hash, last_checked_at: Date.now(), updated_at: Date.now() })
        .where('id', '=', server.id)
        .execute();
      await this.reload();
      return { ok: true, latencyMs: Date.now() - t0, detail, tools };
    } catch (err) {
      const detail = (err as Error).message;
      await this.db.updateTable('mcp_servers').set({ health: 'down', health_detail: detail, last_checked_at: Date.now(), updated_at: Date.now() }).where('id', '=', server.id).execute();
      await this.reload();
      return { ok: false, latencyMs: Date.now() - t0, detail, tools: server.tools };
    }
  }

  startHealthLoop(intervalMs = 60_000): void {
    const tick = async () => {
      for (const s of this.servers.values()) {
        if (!s.enabled) continue;
        await this.check(s).catch(() => undefined);
      }
    };
    this.timer = setInterval(() => void tick(), intervalMs);
    this.timer.unref?.();
    // First check shortly after boot so demo servers show tools immediately.
    setTimeout(() => void tick(), 1500).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
