import { request } from 'undici';
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';
import type { SecretBox } from '../crypto/secrets.js';
import type { HttpApiAuth } from '../http/route.js';
import { cardCandidates, jsonRpcEndpoint } from './card.js';
import { readCapped } from '../util/body.js';

const MAX_CARD = 1024 * 1024;

type Json = Record<string, unknown>;

export interface A2aAgentRecord {
  id: string;
  slug: string;
  name: string;
  /** Where the Agent Card was found (or the base URL it was looked for under). */
  cardUrl: string;
  /** The agent's JSON-RPC endpoint, from its card. */
  endpoint: string | undefined;
  protocolVersion: string | undefined;
  auth: HttpApiAuth;
  /**
   * The agent ID on the remote agent's own Control Tower key, when it has one: calls to it are then
   * drawn agent to agent, and it is sent a delegation token to pass on. Without it, it is a destination.
   */
  agentId: string | undefined;
  card: Json | undefined;
  timeoutMs: number;
  enabled: boolean;
  health: string;
  healthDetail: string | undefined;
  lastCheckedAt: number | undefined;
  demo: boolean;
}

/** The credentials Control Tower presents to the agent: never the caller's key. */
export function authHeaders(auth: HttpApiAuth): Record<string, string> {
  if (auth.type === 'bearer' && auth.token) return { authorization: `Bearer ${auth.token}` };
  if (auth.type === 'header' && auth.token && auth.header) return { [auth.header.toLowerCase()]: auth.token };
  return {};
}

/** Remote agents reached over A2A, served to agents at /a2a/<slug>. */
export class A2aRegistry {
  agents = new Map<string, A2aAgentRecord>();
  bySlug = new Map<string, A2aAgentRecord>();
  version = 0;
  private listeners = new Set<() => void>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly db: Kysely<Database>,
    private readonly secrets: SecretBox,
  ) {}

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async reload(): Promise<void> {
    const rows = await this.db.selectFrom('a2a_agents').selectAll().execute();
    const agents = new Map<string, A2aAgentRecord>();
    const bySlug = new Map<string, A2aAgentRecord>();
    for (const r of rows) {
      let auth: HttpApiAuth = { type: 'none' };
      if (r.auth_enc) {
        try {
          auth = JSON.parse(this.secrets.decrypt(r.auth_enc, `a2a_agents.auth_enc.${r.id}`)) as HttpApiAuth;
        } catch {
          auth = { type: 'none' };
        }
      }
      let card: Json | undefined;
      try {
        card = r.card_cache ? (JSON.parse(r.card_cache) as Json) : undefined;
      } catch {
        card = undefined;
      }
      const rec: A2aAgentRecord = {
        id: r.id,
        slug: r.slug,
        name: r.name,
        cardUrl: r.card_url,
        endpoint: r.endpoint ?? undefined,
        protocolVersion: r.protocol_version ?? undefined,
        auth,
        agentId: r.agent_id ?? undefined,
        card,
        timeoutMs: r.timeout_ms,
        enabled: r.enabled === 1,
        health: r.health,
        healthDetail: r.health_detail ?? undefined,
        lastCheckedAt: r.last_checked_at ?? undefined,
        demo: r.demo === 1,
      };
      agents.set(rec.id, rec);
      bySlug.set(rec.slug, rec);
    }
    this.agents = agents;
    this.bySlug = bySlug;
    this.version++;
    for (const l of this.listeners) {
      try {
        l();
      } catch (err) {
        console.error('[a2a] listener error', err);
      }
    }
  }

  /**
   * Fetch the agent's card and find its JSON-RPC endpoint. The card, endpoint and health are
   * stored; a card that can't be fetched keeps the last good one and marks the agent down.
   */
  async discover(agent: A2aAgentRecord): Promise<{ ok: boolean; detail: string; latencyMs: number }> {
    const t0 = Date.now();
    let detail = '';
    let found: { card: Json; url: string } | undefined;
    for (const url of cardCandidates(agent.cardUrl)) {
      try {
        const res = await request(url, { method: 'GET', headers: { accept: 'application/json', ...authHeaders(agent.auth) }, headersTimeout: 8000, bodyTimeout: 8000, signal: AbortSignal.timeout(10_000) });
        const raw = await readCapped(res.body, MAX_CARD);
        if (res.statusCode >= 400) {
          detail = `${url}: HTTP ${res.statusCode}`;
          continue;
        }
        if (!raw) {
          detail = `${url}: the card is larger than 1 MB`;
          continue;
        }
        const card = JSON.parse(raw.toString('utf8')) as unknown;
        if (!card || typeof card !== 'object' || Array.isArray(card)) {
          detail = `${url}: not an Agent Card (a JSON object)`;
          continue;
        }
        found = { card: card as Json, url };
        break;
      } catch (err) {
        detail = `${url}: ${(err as Error).message}`;
      }
    }
    const now = Date.now();
    if (!found) {
      await this.db.updateTable('a2a_agents').set({ health: 'down', health_detail: detail || 'no Agent Card found', last_checked_at: now, updated_at: now }).where('id', '=', agent.id).execute();
      await this.reload();
      return { ok: false, detail: detail || 'no Agent Card found', latencyMs: now - t0 };
    }
    let ep = jsonRpcEndpoint(found.card, found.url);
    // The agent's credentials go wherever its endpoint is: only to the server that serves its card.
    if (!('error' in ep) && new URL(ep.url).origin !== new URL(found.url).origin)
      ep = { error: `the card sends calls to ${new URL(ep.url).origin}, a different server from the card's (${new URL(found.url).origin}). Control Tower only sends the agent's credentials to the server its card comes from: register the card as served by ${new URL(ep.url).origin}.` };
    if ('error' in ep) {
      await this.db.updateTable('a2a_agents').set({ health: 'down', health_detail: ep.error, card_cache: JSON.stringify(found.card), last_checked_at: now, updated_at: now }).where('id', '=', agent.id).execute();
      await this.reload();
      return { ok: false, detail: ep.error, latencyMs: now - t0 };
    }
    // The card can be fine while nothing answers at its endpoint: ask the endpoint something harmless.
    const answers = await this.probeEndpoint(agent, ep.url, ep.version);
    if (!answers.ok) {
      const at = Date.now();
      await this.db.updateTable('a2a_agents').set({ health: 'down', health_detail: `its card is fine, but ${answers.detail}`, card_cache: JSON.stringify(found.card), endpoint: ep.url, protocol_version: ep.version, last_checked_at: at, updated_at: at }).where('id', '=', agent.id).execute();
      await this.reload();
      return { ok: false, detail: `its card is fine, but ${answers.detail}`, latencyMs: at - t0 };
    }
    const skills = Array.isArray(found.card.skills) ? found.card.skills.length : 0;
    detail = `A2A ${ep.version} · ${skills} skill${skills === 1 ? '' : 's'} · card in ${now - t0} ms · endpoint answers`;
    await this.db
      .updateTable('a2a_agents')
      .set({ health: 'ok', health_detail: detail, card_cache: JSON.stringify(found.card), endpoint: ep.url, protocol_version: ep.version, last_checked_at: now, updated_at: now })
      .where('id', '=', agent.id)
      .execute();
    await this.reload();
    return { ok: true, detail, latencyMs: now - t0 };
  }

  /**
   * Is anything answering JSON-RPC at the endpoint? Asks for a task that doesn't exist: any JSON-RPC
   * reply — an error saying so included — means the agent is there. Reads nothing and changes nothing.
   */
  private async probeEndpoint(agent: A2aAgentRecord, url: string, version: string): Promise<{ ok: boolean; detail: string }> {
    const method = version.startsWith('0.') ? 'tasks/get' : 'GetTask';
    try {
      const res = await request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...authHeaders(agent.auth) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'controltower-health', method, params: { id: 'controltower-health-check' } }),
        headersTimeout: 8000,
        bodyTimeout: 8000,
        signal: AbortSignal.timeout(10_000),
      });
      const raw = await readCapped(res.body, 64 * 1024);
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw.toString('utf8')) : undefined;
      } catch {
        body = undefined;
      }
      if (body && typeof body === 'object' && (body as { jsonrpc?: unknown }).jsonrpc === '2.0') return { ok: true, detail: 'endpoint answers' };
      return { ok: false, detail: `its endpoint answered HTTP ${res.statusCode} without JSON-RPC` };
    } catch (err) {
      return { ok: false, detail: `its endpoint can't be reached: ${(err as Error).message}` };
    }
  }

  private rechecked = new Map<string, number>();
  /** After a call finds an agent's endpoint broken, check its health again — at most once a minute per agent. */
  recheck(agent: A2aAgentRecord): void {
    const last = this.rechecked.get(agent.id) ?? 0;
    if (Date.now() - last < 60_000) return;
    this.rechecked.set(agent.id, Date.now());
    void this.discover(agent).catch(() => undefined);
  }

  startHealthLoop(intervalMs = 10 * 60_000): void {
    const tick = async () => {
      for (const a of this.agents.values()) if (a.enabled) await this.discover(a).catch(() => undefined);
    };
    this.timer = setInterval(() => void tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
