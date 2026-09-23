import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';
import type { Versioned } from '../util/versioned.js';

/**
 * Observed traffic: calls agents make that do NOT pass through Control Tower —
 * databases, SaaS APIs, internal services, or a model provider called
 * directly. Agents report them (POST /v1/observe, or OpenTelemetry spans to
 * POST /v1/traces); the map draws them dashed, straight from the agent to the
 * system, because Control Tower can see them but cannot stop them.
 *
 * Only a target name is stored — never URLs' paths or query strings, never
 * credentials embedded in connection strings, never payloads.
 */

export type ObservedKind = 'http' | 'database' | 'queue' | 'model' | 'saas' | 'rpc' | 'tool' | 'other';
const KINDS: ObservedKind[] = ['http', 'database', 'queue', 'model', 'saas', 'rpc', 'tool', 'other'];

export interface ObservedEvent {
  target: string;
  kind: ObservedKind;
  system: string | undefined;
  write: boolean;
  error: boolean;
  durationMs: number;
  ts: number;
  count: number;
}

/** Hosts that are model providers: calling them directly bypasses the gateway. */
const MODEL_HOSTS: Array<[RegExp, string]> = [
  [/(^|\.)api\.openai\.com$/, 'OpenAI'],
  [/(^|\.)api\.anthropic\.com$/, 'Anthropic'],
  [/(^|\.)generativelanguage\.googleapis\.com$/, 'Google Gemini'],
  [/(^|\.)aiplatform\.googleapis\.com$/, 'Vertex AI'],
  [/^bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com$/, 'AWS Bedrock'],
  [/\.openai\.azure\.com$/, 'Azure OpenAI'],
  [/(^|\.)api\.mistral\.ai$/, 'Mistral'],
  [/(^|\.)api\.groq\.com$/, 'Groq'],
  [/(^|\.)api\.together\.(xyz|ai)$/, 'Together AI'],
  [/(^|\.)api\.deepseek\.com$/, 'DeepSeek'],
  [/(^|\.)api\.x\.ai$/, 'xAI'],
  [/(^|\.)openrouter\.ai$/, 'OpenRouter'],
];

const SAAS_HOSTS: Array<[RegExp, string]> = [
  [/(^|\.)stripe\.com$/, 'Stripe'],
  [/(^|\.)github\.com$|^api\.github\.com$/, 'GitHub'],
  [/(^|\.)slack\.com$/, 'Slack'],
  [/(^|\.)salesforce\.com$|\.force\.com$/, 'Salesforce'],
  [/(^|\.)hubspot\.com$|(^|\.)hubapi\.com$/, 'HubSpot'],
  [/(^|\.)atlassian\.net$|(^|\.)atlassian\.com$/, 'Atlassian'],
  [/(^|\.)zendesk\.com$/, 'Zendesk'],
  [/(^|\.)notion\.(so|com)$/, 'Notion'],
  [/(^|\.)googleapis\.com$/, 'Google APIs'],
  [/(^|\.)graph\.microsoft\.com$/, 'Microsoft Graph'],
  [/(^|\.)twilio\.com$/, 'Twilio'],
  [/(^|\.)sendgrid\.(com|net)$/, 'SendGrid'],
  [/\.s3[.-][a-z0-9-.]*amazonaws\.com$|^s3\.amazonaws\.com$/, 'AWS S3'],
];

/**
 * Normalise what an agent reports into a stable, credential-free target name.
 *   https://api.stripe.com/v1/charges?x=1   → api.stripe.com
 *   postgresql://app:pw@db.internal:5432/orders → postgresql://db.internal:5432/orders
 */
export function normalizeTarget(raw: string): string | null {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  if (s.includes('://')) {
    try {
      const u = new URL(s);
      const proto = u.protocol.replace(/:$/, '').toLowerCase();
      const host = u.host.toLowerCase();
      if (proto === 'http' || proto === 'https' || proto === 'ws' || proto === 'wss') s = host;
      else s = `${proto}://${host}${u.pathname && u.pathname !== '/' ? u.pathname.split('/').slice(0, 2).join('/') : ''}`;
    } catch {
      // Not a URL after all: strip anything that looks like user:password@.
      s = s.replace(/\/\/[^/@\s]*@/, '//');
    }
  } else {
    s = s.replace(/^[^/@\s]*@/, '').replace(/[/?#].*$/, '').toLowerCase();
  }
  s = s.replace(/[^\w.:/@-]/g, '').slice(0, 160);
  return s || null;
}

function hostOf(target: string): string {
  const t = target.includes('://') ? target.slice(target.indexOf('://') + 3) : target;
  return t.split('/')[0]!.replace(/:\d+$/, '');
}

export function classifyTarget(target: string, kind: ObservedKind | undefined, system: string | undefined): { kind: ObservedKind; system: string | undefined; bypass: boolean } {
  const host = hostOf(target);
  for (const [re, name] of MODEL_HOSTS) if (re.test(host)) return { kind: 'model', system: system ?? name, bypass: true };
  if (kind === 'model') return { kind, system, bypass: true };
  for (const [re, name] of SAAS_HOSTS) if (re.test(host)) return { kind: kind && kind !== 'http' ? kind : 'saas', system: system ?? name, bypass: false };
  return { kind: kind ?? 'other', system, bypass: false };
}

const clampInt = (v: unknown, lo: number, hi: number, d: number) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d;
};

/** POST /v1/observe body → events. Returns an error string for a malformed body. */
export function parseObserveBody(body: unknown, now = Date.now()): { events: ObservedEvent[] } | { error: string } {
  const list = Array.isArray(body) ? body : body && typeof body === 'object' && Array.isArray((body as { events?: unknown }).events) ? (body as { events: unknown[] }).events : null;
  if (!list) return { error: 'Expected {"events": [{"target": "api.stripe.com", ...}]}' };
  if (list.length > 1000) return { error: 'At most 1000 events per request.' };
  const events: ObservedEvent[] = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const o = e as Record<string, unknown>;
    const target = normalizeTarget(String(o.target ?? o.url ?? o.host ?? ''));
    if (!target) continue;
    const kind = KINDS.includes(o.kind as ObservedKind) ? (o.kind as ObservedKind) : undefined;
    const op = String(o.operation ?? '').toLowerCase();
    const ts = clampInt(o.ts, now - 7 * 86_400_000, now + 60_000, now);
    events.push({
      target,
      kind: kind ?? (target.includes('://') ? 'database' : 'http'),
      system: typeof o.system === 'string' && o.system.trim() ? o.system.trim().slice(0, 60) : undefined,
      write: op === 'write' || op === 'admin' || op === 'delete',
      error: o.status === 'error' || o.error === true,
      durationMs: clampInt(o.duration_ms, 0, 3_600_000, 0),
      ts,
      count: clampInt(o.count, 1, 100_000, 1),
    });
  }
  return { events };
}

type OtlpValue = { stringValue?: string; intValue?: string | number; boolValue?: boolean; doubleValue?: number };
type OtlpAttr = { key: string; value?: OtlpValue };

function attrs(list: OtlpAttr[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of list ?? []) {
    const v = a.value;
    if (!v) continue;
    const s = v.stringValue ?? (v.intValue !== undefined ? String(v.intValue) : v.boolValue !== undefined ? String(v.boolValue) : v.doubleValue !== undefined ? String(v.doubleValue) : undefined);
    if (s !== undefined) out[a.key] = s;
  }
  return out;
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const WRITE_SQL = /^(insert|update|delete|merge|upsert|drop|alter|truncate|create)/i;

/**
 * OTLP/HTTP JSON traces → events. Only outbound spans (CLIENT, PRODUCER) are
 * calls to another system; spans aimed at Control Tower itself are skipped —
 * that traffic is already recorded (and enforced) as flights. `selfHosts`
 * holds host[:port] forms of this Control Tower's own address.
 */
export function parseOtlpTraces(body: unknown, selfHosts: Set<string>, now = Date.now()): ObservedEvent[] {
  const out: ObservedEvent[] = [];
  const rs = (body as { resourceSpans?: unknown[] } | undefined)?.resourceSpans;
  if (!Array.isArray(rs)) return out;
  for (const r of rs as Array<{ scopeSpans?: Array<{ spans?: unknown[] }>; instrumentationLibrarySpans?: Array<{ spans?: unknown[] }> }>) {
    for (const ss of [...(r.scopeSpans ?? []), ...(r.instrumentationLibrarySpans ?? [])]) {
      for (const sp of (ss.spans ?? []) as Array<{ kind?: number | string; attributes?: OtlpAttr[]; status?: { code?: number | string }; startTimeUnixNano?: string | number; endTimeUnixNano?: string | number }>) {
        const kind = sp.kind;
        if (!(kind === 3 || kind === 4 || kind === 'SPAN_KIND_CLIENT' || kind === 'SPAN_KIND_PRODUCER')) continue;
        const a = attrs(sp.attributes);
        let target: string | null = null;
        let k: ObservedKind = 'http';
        let system: string | undefined;
        const server = a['server.address'] ?? a['net.peer.name'] ?? a['http.host'];
        const port = a['server.port'] ?? a['net.peer.port'];
        if (a['gen_ai.system']) {
          k = 'model';
          target = normalizeTarget(server ?? a['gen_ai.system']);
        } else if (a['db.system']) {
          k = 'database';
          const db = a['db.namespace'] ?? a['db.name'];
          target = normalizeTarget(`${a['db.system']}://${server ?? 'local'}${port ? `:${port}` : ''}${db ? `/${db}` : ''}`);
        } else if (a['messaging.system']) {
          k = 'queue';
          const dest = a['messaging.destination.name'] ?? a['messaging.destination'];
          target = normalizeTarget(`${a['messaging.system']}://${server ?? 'broker'}${dest ? `/${dest}` : ''}`);
        } else if (a['rpc.system'] || a['rpc.service']) {
          k = 'rpc';
          target = normalizeTarget(server ?? a['rpc.service'] ?? '');
          system = a['rpc.service'];
        } else {
          const url = a['url.full'] ?? a['http.url'];
          target = normalizeTarget(url ?? (server ? `${server}${port && port !== '443' && port !== '80' ? `:${port}` : ''}` : ''));
        }
        if (!target) continue;
        if (selfHosts.has(target)) continue;
        const method = (a['http.request.method'] ?? a['http.method'] ?? '').toUpperCase();
        const dbOp = a['db.operation.name'] ?? a['db.operation'] ?? a['db.statement'] ?? '';
        const write = WRITE_METHODS.has(method) || WRITE_SQL.test(dbOp.trim()) || a['messaging.operation'] === 'publish' || a['messaging.operation.type'] === 'send';
        const code = sp.status?.code;
        const start = Number(sp.startTimeUnixNano ?? 0) / 1e6;
        const end = Number(sp.endTimeUnixNano ?? 0) / 1e6;
        out.push({
          target,
          kind: k,
          system,
          write,
          error: code === 2 || code === 'STATUS_CODE_ERROR',
          durationMs: end > start ? Math.round(end - start) : 0,
          ts: end > 0 && end < now + 60_000 ? Math.round(end) : now,
          count: 1,
        });
      }
    }
  }
  return out;
}

export interface ObservedSummary {
  targets: Array<{ id: string; target: string; kind: ObservedKind; system: string | null; bypass: boolean; first_seen: number; last_seen: number; count_24h: number; errors_24h: number }>;
  edges: Array<{ key_id: string; target_id: string; count_24h: number; errors_24h: number; writes_24h: number; last_seen: number }>;
}

export const observedId = (target: string) => `obs:${target}`;

export class ObservedStore {
  private janitor: NodeJS.Timeout | undefined;
  private pendingBump: NodeJS.Timeout | undefined;

  constructor(
    private readonly db: Kysely<Database>,
    /** Bumped (at most every few seconds) when a new system or agent → system edge appears. */
    private readonly version: Versioned,
  ) {}

  start(): void {
    this.janitor = setInterval(() => {
      void this.db.deleteFrom('observed_hourly').where('bucket', '<', Date.now() - 30 * 86_400_000).execute().catch(() => undefined);
    }, 3600_000);
    this.janitor.unref?.();
  }

  stop(): void {
    if (this.janitor) clearInterval(this.janitor);
    if (this.pendingBump) clearTimeout(this.pendingBump);
  }

  async record(keyId: string, events: ObservedEvent[]): Promise<{ accepted: number; targets: number }> {
    if (!events.length) return { accepted: 0, targets: 0 };
    // Aggregate per hour and target before touching the database.
    const agg = new Map<string, { bucket: number; target: string; count: number; errors: number; writes: number; dur: number; last: number; kind: ObservedKind; system: string | undefined }>();
    for (const e of events) {
      const bucket = Math.floor(e.ts / 3600_000) * 3600_000;
      const k = `${bucket}|${e.target}`;
      const a = agg.get(k) ?? { bucket, target: e.target, count: 0, errors: 0, writes: 0, dur: 0, last: 0, kind: e.kind, system: e.system };
      a.count += e.count;
      if (e.error) a.errors += e.count;
      if (e.write) a.writes += e.count;
      a.dur += e.durationMs * e.count;
      a.last = Math.max(a.last, e.ts);
      agg.set(k, a);
    }
    let changed = false;
    await this.db.transaction().execute(async (trx) => {
      for (const a of agg.values()) {
        const c = classifyTarget(a.target, a.kind, a.system);
        const existing = await trx.selectFrom('observed_targets').select(['target']).where('target', '=', a.target).executeTakeFirst();
        if (!existing) changed = true;
        await trx
          .insertInto('observed_targets')
          .values({ target: a.target, kind: c.kind, system: c.system ?? null, bypass: c.bypass ? 1 : 0, first_seen: a.last, last_seen: a.last })
          .onConflict((oc) => oc.column('target').doUpdateSet((eb) => ({ last_seen: eb.fn('max', [eb.ref('observed_targets.last_seen'), eb.val(a.last)]) })))
          .execute();
        const edge = await trx.selectFrom('observed_hourly').select(['key_id']).where('key_id', '=', keyId).where('target', '=', a.target).limit(1).executeTakeFirst();
        if (!edge) changed = true;
        await trx
          .insertInto('observed_hourly')
          .values({ bucket: a.bucket, key_id: keyId, target: a.target, count: a.count, errors: a.errors, writes: a.writes, dur_ms_sum: a.dur, last_seen: a.last })
          .onConflict((oc) =>
            oc.columns(['bucket', 'key_id', 'target']).doUpdateSet((eb) => ({
              count: eb('observed_hourly.count', '+', a.count),
              errors: eb('observed_hourly.errors', '+', a.errors),
              writes: eb('observed_hourly.writes', '+', a.writes),
              dur_ms_sum: eb('observed_hourly.dur_ms_sum', '+', a.dur),
              last_seen: eb.fn('max', [eb.ref('observed_hourly.last_seen'), eb.val(a.last)]),
            })),
          )
          .execute();
      }
    });
    // New systems or edges change the map; recent activity is picked up on the console's regular refresh.
    if (changed) this.bump();
    return { accepted: events.reduce((n, e) => n + e.count, 0), targets: new Set(events.map((e) => e.target)).size };
  }

  private bump(): void {
    if (this.pendingBump) return;
    this.pendingBump = setTimeout(() => {
      this.pendingBump = undefined;
      this.version.bump();
    }, 2000);
    this.pendingBump.unref?.();
  }

  async summary(sinceMs: number): Promise<ObservedSummary> {
    const [targets, edges] = await Promise.all([
      this.db.selectFrom('observed_targets').selectAll().where('last_seen', '>', Date.now() - 30 * 86_400_000).execute(),
      this.db
        .selectFrom('observed_hourly')
        .select(['key_id', 'target'])
        .select((eb) => [eb.fn.sum<number>('count').as('count'), eb.fn.sum<number>('errors').as('errors'), eb.fn.sum<number>('writes').as('writes'), eb.fn.max<number>('last_seen').as('last_seen')])
        .where('bucket', '>=', Math.floor(sinceMs / 3600_000) * 3600_000)
        .groupBy(['key_id', 'target'])
        .execute(),
    ]);
    const byTarget = new Map<string, { count: number; errors: number }>();
    for (const e of edges) {
      const t = byTarget.get(e.target) ?? { count: 0, errors: 0 };
      t.count += Number(e.count);
      t.errors += Number(e.errors);
      byTarget.set(e.target, t);
    }
    return {
      targets: targets.map((t) => ({
        id: observedId(t.target),
        target: t.target,
        kind: t.kind as ObservedKind,
        system: t.system,
        bypass: t.bypass === 1,
        first_seen: t.first_seen,
        last_seen: t.last_seen,
        count_24h: byTarget.get(t.target)?.count ?? 0,
        errors_24h: byTarget.get(t.target)?.errors ?? 0,
      })),
      edges: edges.map((e) => ({ key_id: e.key_id, target_id: observedId(e.target), count_24h: Number(e.count), errors_24h: Number(e.errors), writes_24h: Number(e.writes), last_seen: Number(e.last_seen) })),
    };
  }
}
