import crypto from 'node:crypto';
import dns from 'node:dns';
import net from 'node:net';
import { Agent, request } from 'undici';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import type { A2aAgentRecord } from './registry.js';
import { newFlight } from '../pipeline/flight.js';
import { keyProblem } from '../gateway/key.js';
import { inspect } from '../guardrails/inspect.js';
import { emitInspectOutcomes } from '../guardrails/emit.js';
import { namespaced } from '../mcp/registry.js';
import { readCapped } from '../util/body.js';

/**
 * A2A push notifications, relayed through Control Tower.
 *
 * When a caller asks an agent for push notifications — with the setup call, or inside a message — the
 * agent is given a Control Tower address and a token of its own instead of the caller's webhook. Each
 * notification the agent sends there is checked against that token, recorded as a call
 * (`<slug>__PushNotification`, linked to the call that set it up), put through gates and inspect gates
 * like anything the caller reads, and forwarded to the caller's webhook with the caller's own token or
 * credentials. Replies that show a configuration show the caller's webhook, not the relay.
 *
 * Control Tower delivers only to public addresses unless CT_PUSH_ALLOW_PRIVATE is set: a caller can't use
 * it to reach services on Control Tower's own network. CT_A2A_PUSH_RELAY=off lets agents send notifications
 * straight to the webhook instead.
 */

type Json = Record<string, unknown>;
interface Target {
  url: string;
  token?: string;
  authentication?: { scheme?: string; credentials?: string };
}
export const PUSH_METHOD = 'PushNotification';
const MAX_NOTIFICATION = 1024 * 1024;
const AAD = (id: string) => `a2a_push_relays.target_enc.${id}`;
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

// ---------------------------------------------------------------- where a push configuration sits

/** Every push configuration in a request: the setup call's params (1.0), its pushNotificationConfig (0.3), or a message's. */
export function pushConfigs(params: Json): Json[] {
  const conf = params.configuration as Json | undefined;
  const found = [params, params.pushNotificationConfig, conf?.taskPushNotificationConfig, conf?.pushNotificationConfig];
  return found.filter((c): c is Json => !!c && typeof c === 'object' && typeof (c as Json).url === 'string' && !!(c as Json).url);
}

// ---------------------------------------------------------------- only public addresses

const V4_PRIVATE: Array<[string, number]> = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]];
const v4int = (ip: string) => ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
/** Loopback, private, link-local, carrier-grade NAT, multicast and reserved addresses — and IPv6's equivalents. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return V4_PRIVATE.some(([base, bits]) => (v4int(ip) >>> (32 - bits)) === (v4int(base) >>> (32 - bits)));
  const v6 = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return isPrivateAddress(mapped[1]!);
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('ff');
}

/** A connection pool that refuses to connect to private addresses — checked on the address it actually connects to. */
function guardedAgent(allowPrivate: boolean): Agent {
  return new Agent({
    connect: {
      lookup: (host: string, opts: dns.LookupOptions, cb: (err: Error | null, address: string | dns.LookupAddress[], family?: number) => void) => {
        dns.lookup(host, { all: true }, (err, addrs) => {
          if (err) return cb(err, '');
          const ok = allowPrivate ? addrs : addrs.filter((a) => !isPrivateAddress(a.address));
          if (!ok.length) return cb(new Error(`${host} resolves only to private addresses`), '');
          if (opts.all) return cb(null, ok);
          cb(null, ok[0]!.address, ok[0]!.family);
        });
      },
    },
  } as never);
}

/** Whether a caller's webhook may be delivered to: http(s), and a public address unless private ones are allowed. */
export async function checkWebhook(url: string, allowPrivate: boolean): Promise<string | undefined> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'the webhook URL is not a valid URL';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'the webhook URL must be http or https';
  if (allowPrivate) return undefined;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return isPrivateAddress(host) ? 'the webhook is on a private address, which Control Tower does not deliver to' : undefined;
  try {
    const addrs = await dns.promises.lookup(host, { all: true });
    if (addrs.every((a) => isPrivateAddress(a.address))) return 'the webhook resolves only to private addresses, which Control Tower does not deliver to';
  } catch {
    return `the webhook's host ${host} could not be resolved`;
  }
  return undefined;
}

// ---------------------------------------------------------------- the relay

export class PushRelay {
  private agent: Agent;

  constructor(private readonly ctx: AppContext) {
    this.agent = guardedAgent(ctx.config.pushAllowPrivate);
  }

  get enabled(): boolean {
    return this.ctx.config.a2aPushRelay;
  }

  /**
   * Swap every push configuration in a request for a relay: the agent gets a Control Tower address and a
   * token of its own. Returns an error to refuse the call with, or undefined.
   */
  async relayIn(params: Json, a2a: A2aAgentRecord, keyId: string, flightId: string, chain: string[], base: string): Promise<string | undefined> {
    for (const c of pushConfigs(params)) {
      const bad = await checkWebhook(String(c.url), this.ctx.config.pushAllowPrivate);
      if (bad) return bad;
      const id = `rly_${crypto.randomBytes(12).toString('base64url')}`;
      const secret = crypto.randomBytes(24).toString('base64url');
      const auth = c.authentication as Target['authentication'] | undefined;
      const target: Target = { url: String(c.url), ...(typeof c.token === 'string' && c.token ? { token: c.token } : {}), ...(auth?.scheme && auth.credentials ? { authentication: { scheme: auth.scheme, credentials: auth.credentials } } : {}) };
      await this.ctx.db.write
        .insertInto('a2a_push_relays')
        .values({ id, a2a_agent_id: a2a.id, key_id: keyId, target_enc: this.ctx.secrets.encrypt(JSON.stringify(target), AAD(id)), secret_hash: sha(secret), flight_id: flightId, on_behalf_of: chain.length ? JSON.stringify(chain) : null, last_used_at: null, created_at: Date.now() })
        .execute();
      c.url = `${base}/a2a/${a2a.slug}/push/${id}`;
      c.token = secret;
      delete c.authentication;
    }
    return undefined;
  }

  /** In a reply, show the caller its own webhook wherever the agent shows the relay's address. */
  async restoreOut(result: unknown, a2a: A2aAgentRecord, base: string): Promise<unknown> {
    const prefix = `${base}/a2a/${a2a.slug}/push/`;
    const text = JSON.stringify(result ?? null);
    if (!text.includes(prefix)) return result;
    const ids = [...new Set([...text.matchAll(/\/push\/(rly_[A-Za-z0-9_-]+)/g)].map((m) => m[1]!))];
    const rows = await this.ctx.db.read.selectFrom('a2a_push_relays').select(['id', 'target_enc']).where('id', 'in', ids).where('a2a_agent_id', '=', a2a.id).execute();
    const targets = new Map(rows.map((r) => [r.id, JSON.parse(this.ctx.secrets.decrypt(r.target_enc, AAD(r.id))) as Target]));
    const walk = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(walk);
      if (!v || typeof v !== 'object') return v;
      const o: Json = {};
      for (const [k, x] of Object.entries(v as Json)) o[k] = walk(x);
      if (typeof o.url === 'string' && o.url.startsWith(prefix)) {
        const t = targets.get(o.url.slice(prefix.length));
        if (t) {
          o.url = t.url;
          if (t.token) o.token = t.token;
          else delete o.token;
          if (t.authentication) o.authentication = t.authentication;
        }
      }
      return o;
    };
    return walk(result);
  }

  register(app: FastifyInstance): void {
    // Agents send notifications in whatever content type their SDK uses: take the body as it comes.
    void app.register(async (p) => {
      p.removeAllContentTypeParsers();
      p.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: MAX_NOTIFICATION }, (_req, body, done) => done(null, body));
      p.post('/a2a/:slug/push/:relay', (req, reply) => this.receive(req, reply));
    });
  }

  /** A notification from the agent: check it, record it, gate and inspect it, and deliver it to the caller. */
  private async receive(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    const ctx = this.ctx;
    const { slug, relay } = req.params as { slug: string; relay: string };
    const a2a = ctx.a2a.bySlug.get(slug);
    const row = a2a ? await ctx.db.read.selectFrom('a2a_push_relays').selectAll().where('id', '=', relay).where('a2a_agent_id', '=', a2a.id).executeTakeFirst() : undefined;
    if (!a2a || !row) return reply.status(404).send({ error: 'unknown push address' });
    const auth = req.headers.authorization;
    const presented = (req.headers['x-a2a-notification-token'] as string | undefined) ?? (auth?.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : undefined);
    if (!presented || !crypto.timingSafeEqual(Buffer.from(sha(presented)), Buffer.from(row.secret_hash))) return reply.status(401).send({ error: 'wrong or missing notification token' });
    const key = ctx.registry.keysById.get(row.key_id);
    if (!key || keyProblem(key)) return reply.status(410).send({ error: 'the caller that asked for these notifications is no longer allowed to receive them' });

    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? ''));
    const full = namespaced(a2a.slug, PUSH_METHOD);
    const chain = row.on_behalf_of ? (JSON.parse(row.on_behalf_of) as string[]) : [];
    const f = newFlight('a2a.call', 'openai-chat', { name: full });
    f.modelRequested = full;
    f.key = key;
    ctx.bus.emit({ t: 'flight.started', flight_id: f.id, ts: f.t.start, key_id: key.id, key_name: key.name, agent_id: key.agentId, team: key.team, project: key.project, kind: 'a2a.call', dialect: 'a2a', stream: false, model_requested: full, mcp_server_id: a2a.id, tool: PUSH_METHOD, ...(chain.length ? { on_behalf_of: chain } : {}), ...(row.flight_id ? { parent_flight_id: row.flight_id } : {}), est_input_tokens: Math.round(body.length / 4), projected_nanousd: 0 });
    const complete = (status: 'ok' | 'error' | 'denied', http: number, error?: { code: string; message: string }) =>
      ctx.bus.emit({ t: 'flight.completed', flight_id: f.id, ts: Date.now(), status, http_status: http, usage: { input: Math.round(body.length / 4), output: 0, cacheRead: 0, cacheWrite: 0 }, usage_source: 'estimated', cost_nanousd: 0, cost_confidence: 'exact', duration_ms: Date.now() - f.t.start, gateway_overhead_ms: 0, ...(error ? { error } : {}) });

    // Gates on the caller receiving notifications from this agent.
    const target = { kind: 'tool' as const, name: full, mcpServerId: a2a.id, operation: 'read' as const };
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      payload = undefined;
    }
    const decision = await ctx.policy.evaluate({ flightId: f.id, key, target, args: {}, onBehalfOf: [], estInputTokens: 0, projectedNanousd: 0 });
    ctx.bus.emit({ t: 'flight.decision', flight_id: f.id, ts: Date.now(), decision: decision.effect === 'hold' ? 'hold' : decision.effect, rule_id: decision.ruleId, reason: decision.reason });
    if (decision.effect === 'deny' || decision.effect === 'hold') {
      complete('denied', 403, { code: 'policy_denied', message: decision.reason ?? 'blocked by a gate' });
      return reply.status(403).send({ error: 'Control Tower did not deliver this notification: a gate blocks it' });
    }
    // Inspect gates read what the caller is about to read.
    let out: Buffer = body;
    const gates = (ctx.policy.inspectors?.(key, target, []) ?? []).filter((g) => g.compiled.direction !== 'input');
    if (gates.length && payload !== undefined) {
      const r = await inspect(ctx, key, gates, 'output', payload);
      emitInspectOutcomes(ctx.bus, f.id, r.outcomes, 'in the push notification');
      if (r.blocked) {
        complete('denied', 403, { code: 'content_blocked', message: 'an inspect gate blocked the notification' });
        return reply.status(403).send({ error: 'Control Tower did not deliver this notification: an inspect gate blocks its content' });
      }
      if (r.value !== payload) out = Buffer.from(JSON.stringify(r.value));
    }

    // Deliver to the caller's webhook, with the caller's token or credentials.
    const t = JSON.parse(ctx.secrets.decrypt(row.target_enc, AAD(row.id))) as Target;
    const headers: Record<string, string> = { 'content-type': String(req.headers['content-type'] ?? 'application/json') };
    if (t.authentication?.scheme && t.authentication.credentials) headers.authorization = `${t.authentication.scheme} ${t.authentication.credentials}`;
    else if (t.token) headers['x-a2a-notification-token'] = t.token;
    f.t.upstreamSent = Date.now();
    try {
      const res = await request(t.url, { method: 'POST', headers, body: out, dispatcher: this.agent, headersTimeout: 10_000, bodyTimeout: 10_000, signal: AbortSignal.timeout(15_000) });
      await readCapped(res.body, 64 * 1024).catch(() => undefined);
      await ctx.db.write.updateTable('a2a_push_relays').set((eb) => ({ deliveries: eb('deliveries', '+', 1), last_used_at: Date.now() })).where('id', '=', row.id).execute();
      if (res.statusCode >= 200 && res.statusCode < 300) {
        complete('ok', res.statusCode);
        return reply.status(200).send({ delivered: true });
      }
      complete('error', 502, { code: 'webhook_error', message: `the caller's webhook answered HTTP ${res.statusCode}` });
      return reply.status(502).send({ error: `the caller's webhook answered HTTP ${res.statusCode}` });
    } catch (err) {
      complete('error', 502, { code: 'webhook_unreachable', message: (err as Error).message });
      return reply.status(502).send({ error: "Control Tower could not reach the caller's webhook" });
    }
  }
}
