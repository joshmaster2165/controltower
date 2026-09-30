import crypto from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { SignatureV4 } from '@smithy/signature-v4';
import { Hash } from '@smithy/hash-node';
import type { HttpRequest } from '@smithy/types';
import { readBodyText, sendUpstream } from '../providers/http.js';
import type { FlightRecord } from './record.js';

/**
 * Where flight records go, and how each destination wants them:
 *   otlp     OpenTelemetry (OTLP/HTTP JSON) — as spans, joining the agent's own trace when it sent a
 *            traceparent, or as log records. GenAI semantic-convention attributes.
 *   datadog  Datadog's log intake.
 *   splunk   Splunk's HTTP Event Collector.
 *   s3       Gzipped JSON Lines files in an S3 bucket (or MinIO, R2 — any S3-compatible store).
 *   webhook  JSON batches to any URL, signed like alert webhooks.
 */
export const EXPORT_KINDS = ['otlp', 'datadog', 'splunk', 's3', 'webhook'] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

export interface ExportConfig {
  // otlp
  endpoint?: string;
  signal?: 'traces' | 'logs';
  headers?: Record<string, string>;
  // datadog
  site?: string;
  api_key?: string;
  service?: string;
  ddtags?: string;
  // splunk
  url?: string;
  token?: string;
  index?: string;
  sourcetype?: string;
  /** The index for audit events, when not the same as calls'. */
  audit_index?: string;
  // s3
  bucket?: string;
  region?: string;
  prefix?: string;
  access_key_id?: string;
  secret_access_key?: string;
  session_token?: string;
  // webhook
  secret?: string;
}

/** Which config fields are secrets: never returned by the API. */
export const SECRET_FIELDS = ['api_key', 'token', 'secret_access_key', 'session_token', 'secret', 'headers'] as const;

/** What's wrong with a destination's settings, if anything. */
export function configProblem(kind: ExportKind, c: ExportConfig): string | undefined {
  const url = (u: string | undefined, what: string) => (!u || !/^https?:\/\//.test(u) ? `${what} must be an http(s) URL` : undefined);
  switch (kind) {
    case 'otlp':
      return url(c.endpoint, 'endpoint') ?? (c.signal && c.signal !== 'traces' && c.signal !== 'logs' ? 'signal must be traces or logs' : undefined);
    case 'datadog':
      return !c.api_key ? 'api_key is required' : undefined;
    case 'splunk':
      return url(c.url, 'url') ?? (!c.token ? 'token is required' : undefined);
    case 's3':
      if (!c.bucket || !/^[a-z0-9][a-z0-9.-]{1,62}$/.test(c.bucket)) return 'bucket must be an S3 bucket name';
      if (!c.access_key_id || !c.secret_access_key) return 'access_key_id and secret_access_key are required';
      return c.endpoint ? url(c.endpoint, 'endpoint') : undefined;
    case 'webhook':
      return url(c.url, 'url');
  }
}

/** A short description of where it goes, safe to show: host, bucket, site. */
export function targetHint(kind: ExportKind, c: ExportConfig): string {
  const host = (u?: string) => {
    try {
      return u ? new URL(u).host : '';
    } catch {
      return '';
    }
  };
  switch (kind) {
    case 'otlp':
      return `${host(c.endpoint)} · ${c.signal ?? 'traces'}`;
    case 'datadog':
      return c.site ?? 'datadoghq.com';
    case 'splunk':
      return host(c.url);
    case 's3':
      return `s3://${c.bucket}/${c.prefix ?? ''}${c.endpoint ? ` · ${host(c.endpoint)}` : ''}`;
    case 'webhook':
      return host(c.url);
  }
}

/** Send one batch; throws with a readable reason when the destination refuses it. */
export async function deliver(kind: ExportKind, c: ExportConfig, records: FlightRecord[], meta: { version: string }): Promise<void> {
  if (!records.length) return;
  switch (kind) {
    case 'otlp':
      return post(`${c.endpoint!.replace(/\/+$/, '')}/v1/${c.signal === 'logs' ? 'logs' : 'traces'}`, { 'content-type': 'application/json', ...(c.headers ?? {}) }, JSON.stringify(c.signal === 'logs' ? otlpLogs(records, meta) : otlpTraces(records, meta)));
    case 'datadog': {
      const site = (c.site ?? 'datadoghq.com').replace(/^https?:\/\//, '');
      // Datadog's `status` is the log level: the flight's own status goes in flight_status.
      const body = records.map(({ status, ...r }) => ({ ddsource: 'controltower', service: c.service ?? 'controltower', ...(c.ddtags ? { ddtags: c.ddtags } : {}), hostname: r.instance, message: summary({ ...r, status }), ...r, flight_status: status, status: status === 'error' ? 'error' : status === 'ok' ? 'info' : 'warn' }));
      return post(`https://http-intake.logs.${site}/api/v2/logs`, { 'content-type': 'application/json', 'dd-api-key': c.api_key! }, JSON.stringify(body), c.endpoint);
    }
    case 'splunk': {
      const body = records.map((r) => JSON.stringify({ time: r.end_ms / 1000, source: 'controltower', sourcetype: c.sourcetype ?? 'controltower:flight', ...(c.index ? { index: c.index } : {}), event: r })).join('\n');
      return post(`${c.url!.replace(/\/+$/, '')}/services/collector/event`, { 'content-type': 'application/json', authorization: `Splunk ${c.token}` }, body);
    }
    case 's3':
      return putS3(c, records.map((r) => JSON.stringify(r)));
    case 'webhook':
      return postSigned(c, JSON.stringify({ type: 'controltower.flights', count: records.length, records }));
  }
}

/** POST to a webhook, signed (`x-ct-signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<body>">`) when it has a secret. */
export function postSigned(c: ExportConfig, body: string): Promise<void> {
  const h: Record<string, string> = { 'content-type': 'application/json', ...(c.headers ?? {}) };
  if (c.secret) {
    const ts = Math.floor(Date.now() / 1000);
    h['x-ct-signature'] = `t=${ts},v1=${crypto.createHmac('sha256', c.secret).update(`${ts}.${body}`).digest('hex')}`;
  }
  return post(c.url!, h, body);
}

/** POST, and throw unless it was accepted. `override` replaces the URL's origin (tests and private intakes). */
export async function post(url: string, headers: Record<string, string>, body: string | Buffer, override?: string): Promise<void> {
  const target = override ? `${override.replace(/\/+$/, '')}${new URL(url).pathname}` : url;
  const r = await sendUpstream('export', { url: target, method: 'POST', headers, body }, AbortSignal.timeout(20_000), { headersTimeoutMs: 20_000 });
  if (!r.ok) throw new Error(r.err.message);
  const text = await readBodyText(r.res.body, 64 * 1024);
  if (r.res.status < 200 || r.res.status >= 300) throw new Error(`HTTP ${r.res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
}

function summary(r: FlightRecord): string {
  const to = r.target.tool ? `${r.target.mcp_server_id ?? ''} ${r.target.tool}` : r.target.model_requested;
  return `${r.agent.key_name} → ${to}: ${r.status}${r.decision && r.decision.effect !== 'allow' ? ` (${r.decision.effect})` : ''}`;
}

// ---------------------------------------------------------------- OpenTelemetry

type AnyValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean } | { arrayValue: { values: AnyValue[] } };
const av = (v: string | number | boolean | string[]): AnyValue =>
  Array.isArray(v) ? { arrayValue: { values: v.map((x) => ({ stringValue: x })) } } : typeof v === 'boolean' ? { boolValue: v } : typeof v === 'number' ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }) : { stringValue: v };
export function attrs(o: Record<string, string | number | boolean | string[] | undefined | null>): Array<{ key: string; value: AnyValue }> {
  return Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && !v.length))
    .map(([key, v]) => ({ key, value: av(v as string | number | boolean | string[]) }));
}
export const nanos = (ms: number) => (BigInt(Math.round(ms)) * 1_000_000n).toString();
const hex = (s: string, n: number) => crypto.createHash('sha256').update(s).digest('hex').slice(0, n);

const GEN_AI_OP: Record<string, string> = { chat: 'chat', messages: 'chat', responses: 'chat', embeddings: 'embeddings', completions: 'text_completion', 'mcp.tool': 'execute_tool', 'http.request': 'execute_tool', 'a2a.call': 'invoke_agent' };
const GEN_AI_SYSTEM: Record<string, string> = { openai: 'openai', 'azure-openai': 'azure.ai.openai', 'openai-compatible': 'openai', anthropic: 'anthropic', gemini: 'gcp.gemini', vertex: 'gcp.vertex_ai', bedrock: 'aws.bedrock' };

/** A flight's attributes: GenAI semantic conventions where they fit, controltower.* for the rest. */
function flightAttrs(r: FlightRecord) {
  return attrs({
    'gen_ai.operation.name': GEN_AI_OP[r.kind] ?? r.kind,
    'gen_ai.system': r.target.provider_kind ? (GEN_AI_SYSTEM[r.target.provider_kind] ?? r.target.provider_kind) : undefined,
    'gen_ai.request.model': r.target.tool ? undefined : r.target.model_requested,
    'gen_ai.response.model': r.target.upstream_model,
    'gen_ai.tool.name': r.target.tool,
    'gen_ai.usage.input_tokens': r.usage?.input,
    'gen_ai.usage.output_tokens': r.usage?.output,
    'gen_ai.agent.name': r.agent.agent_id ?? r.agent.key_name,
    'http.response.status_code': r.http_status,
    'controltower.flight_id': r.id,
    'controltower.status': r.status,
    'controltower.kind': r.kind,
    'controltower.endpoint': r.endpoint,
    'controltower.key_id': r.agent.key_id,
    'controltower.key_name': r.agent.key_name,
    'controltower.team': r.agent.team,
    'controltower.project': r.agent.project,
    'controltower.on_behalf_of': r.on_behalf_of,
    'controltower.customer': r.customer,
    'controltower.tags': r.tags,
    'controltower.mcp_server_id': r.target.mcp_server_id,
    'controltower.deployment_id': r.target.deployment_id,
    'controltower.decision': r.decision?.effect,
    'controltower.rule_id': r.decision?.rule_id,
    'controltower.decision_reason': r.decision?.reason,
    'controltower.approval_id': r.approval?.id,
    'controltower.approval_outcome': r.approval?.outcome,
    'controltower.cost_usd': r.cost_usd ?? undefined,
    'controltower.cost_confidence': r.cost_confidence,
    'controltower.cache_hit': r.cache_hit,
    'controltower.attempts': r.attempts,
    'controltower.gateway_overhead_ms': r.latency.gateway_overhead_ms,
    'controltower.ttft_ms': r.latency.ttft_ms,
    'error.type': r.error?.code,
  });
}

export const resource = (meta: { version: string }, instance?: string) => ({ attributes: attrs({ 'service.name': 'controltower', 'service.version': meta.version, 'service.instance.id': instance }) });

export function otlpTraces(records: FlightRecord[], meta: { version: string }) {
  return {
    resourceSpans: [
      {
        resource: resource(meta, records[0]?.instance),
        scopeSpans: [
          {
            scope: { name: 'controltower', version: meta.version },
            spans: records.map((r) => {
              const failed = r.status === 'error' || r.status === 'shutdown' || r.http_status >= 500;
              return {
                traceId: r.trace?.trace_id ?? hex(`trace:${r.id}`, 32),
                spanId: hex(`span:${r.id}`, 16),
                ...(r.trace?.parent_span_id ? { parentSpanId: r.trace.parent_span_id } : {}),
                name: `${GEN_AI_OP[r.kind] ?? r.kind} ${r.target.tool ?? r.target.model_requested}`,
                kind: 3,
                startTimeUnixNano: nanos(r.start_ms),
                endTimeUnixNano: nanos(r.end_ms),
                attributes: flightAttrs(r),
                status: failed ? { code: 2, message: r.error?.message ?? r.status } : r.status === 'ok' ? { code: 1 } : { code: 0 },
              };
            }),
          },
        ],
      },
    ],
  };
}

export function otlpLogs(records: FlightRecord[], meta: { version: string }) {
  return {
    resourceLogs: [
      {
        resource: resource(meta, records[0]?.instance),
        scopeLogs: [
          {
            scope: { name: 'controltower', version: meta.version },
            logRecords: records.map((r) => ({
              timeUnixNano: nanos(r.end_ms),
              observedTimeUnixNano: nanos(Date.now()),
              severityNumber: r.status === 'error' ? 17 : r.status === 'ok' ? 9 : 13,
              severityText: r.status === 'error' ? 'ERROR' : r.status === 'ok' ? 'INFO' : 'WARN',
              body: { stringValue: JSON.stringify(r) },
              attributes: flightAttrs(r),
              ...(r.trace ? { traceId: r.trace.trace_id } : {}),
            })),
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------- S3

/** Write one gzipped JSON Lines file under `<prefix><under>YYYY/MM/DD/HH/`. */
export async function putS3(c: ExportConfig, lines: string[], under = ''): Promise<void> {
  const region = c.region || 'us-east-1';
  const now = new Date();
  const p2 = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getUTCFullYear()}${p2(now.getUTCMonth() + 1)}${p2(now.getUTCDate())}T${p2(now.getUTCHours())}${p2(now.getUTCMinutes())}${p2(now.getUTCSeconds())}Z`;
  const prefix = (c.prefix ?? 'controltower/').replace(/^\/+/, '');
  const key = `${prefix}${under}${now.getUTCFullYear()}/${p2(now.getUTCMonth() + 1)}/${p2(now.getUTCDate())}/${p2(now.getUTCHours())}/${stamp}-${crypto.randomBytes(4).toString('hex')}.jsonl.gz`;
  const body = gzipSync(Buffer.from(lines.join('\n') + '\n'));
  const base = c.endpoint ? c.endpoint.replace(/\/+$/, '') : `https://s3.${region}.amazonaws.com`;
  // Path-style (bucket in the path) works for AWS and every S3-compatible store.
  const u = new URL(`${base}/${c.bucket}/${key}`);
  const signer = new SignatureV4({
    credentials: { accessKeyId: c.access_key_id!, secretAccessKey: c.secret_access_key!, ...(c.session_token ? { sessionToken: c.session_token } : {}) },
    region,
    service: 's3',
    sha256: Hash.bind(null, 'sha256'),
    uriEscapePath: false,
  });
  const req: HttpRequest = {
    method: 'PUT',
    protocol: u.protocol,
    hostname: u.hostname,
    ...(u.port ? { port: Number(u.port) } : {}),
    path: u.pathname,
    query: {},
    headers: { host: u.host, 'content-type': 'application/x-ndjson', 'content-encoding': 'gzip', 'content-length': String(body.length), 'x-amz-content-sha256': crypto.createHash('sha256').update(body).digest('hex') },
    body,
  };
  const signed = await signer.sign(req);
  const r = await sendUpstream('export', { url: u.toString(), method: 'PUT', headers: signed.headers, body }, AbortSignal.timeout(30_000));
  if (!r.ok) throw new Error(r.err.message);
  const text = await readBodyText(r.res.body, 16 * 1024);
  if (r.res.status < 200 || r.res.status >= 300) throw new Error(`S3 HTTP ${r.res.status}${text ? `: ${(/<Message>([^<]*)<\/Message>/.exec(text)?.[1] ?? text).slice(0, 200)}` : ''}`);
}
