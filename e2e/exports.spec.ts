import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { CT, admin } from './support/admin';
import { routingUpstream, type RoutingUpstream } from './support/routing-upstream';

/**
 * Every flight goes, as it completes, to the customer's own monitoring — OpenTelemetry (spans joining the
 * agent's trace, or logs), Datadog, Splunk, S3 and signed webhooks — as metadata only: never a prompt or
 * an answer. A destination that is down keeps its records waiting, then says what failed.
 */
test.describe.configure({ mode: 'serial' });

interface Got {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}
let receiver: http.Server;
let rUrl = '';
const got: Got[] = [];
let up: RoutingUpstream;
let key = '';
let providerId = '';
const destIds: string[] = [];
const SECRET = 'whsec-exports-e2e';
const PROMPT = 'the quarterly numbers are 4,211,007 — do not leak';

const at = (prefix: string) => got.filter((g) => g.path.startsWith(prefix));
const json = (g: Got) => JSON.parse(g.body.toString('utf8'));

test.beforeAll(async () => {
  receiver = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const g = { path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) };
      // An S3 stand-in that, like S3, refuses anything not SigV4-signed.
      if (req.method === 'PUT' && !String(req.headers.authorization ?? '').startsWith('AWS4-HMAC-SHA256 Credential=AKIAEXPORTTEST/')) {
        res.writeHead(403, { 'content-type': 'application/xml' });
        return res.end('<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>');
      }
      got.push(g);
      if (req.url?.startsWith('/down')) {
        res.writeHead(503);
        return res.end('unavailable');
      }
      res.writeHead(req.url?.startsWith('/dd') ? 202 : 200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', () => r()));
  rUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  up = await routingUpstream('ex');
  await admin.signIn();
  const p = await admin.post('/admin/api/providers', { catalog_id: 'custom', name: 'Export upstream', slug: 'exup', base_url: `${up.url}/v1`, credentials: { api_key: 'sk-ex' } });
  providerId = (p.body.provider ?? p.body).id;
  await admin.post('/admin/api/deployments', { provider_id: providerId, upstream_model: 'ok-export', public_name: 'ex-model', pricing_override: { input: 1, output: 2 } });
  key = (await admin.post('/admin/api/keys', { name: 'export-agent', agent_id: 'export-agent', team: 'finance' })).body.key;
});

test.afterAll(async () => {
  for (const id of destIds) await admin.del(`/admin/api/exports/${id}`);
  await admin.del(`/admin/api/providers/${providerId}`);
  await up.close();
  await new Promise<void>((r) => receiver.close(() => r()));
});

test('destinations are checked before they are saved, and their secrets never come back', async () => {
  expect((await admin.post('/admin/api/exports', { kind: 'datadog', config: {} })).body.error.message).toContain('api_key');
  expect((await admin.post('/admin/api/exports', { kind: 'splunk', config: { url: 'not a url', token: 't' } })).status).toBe(400);
  const add = async (name: string, kind: string, config: Record<string, unknown>) => {
    const r = await admin.post('/admin/api/exports', { name, kind, config });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    destIds.push(r.body.id);
    return r.body.id as string;
  };
  await add('Collector (traces)', 'otlp', { endpoint: `${rUrl}/otel`, signal: 'traces', headers: { authorization: 'Bearer otel-secret' } });
  await add('Collector (logs)', 'otlp', { endpoint: `${rUrl}/otel`, signal: 'logs' });
  await add('Datadog', 'datadog', { api_key: 'dd-secret-key', site: 'datadoghq.eu', endpoint: `${rUrl}/dd`, service: 'agents', ddtags: 'env:e2e' });
  await add('Splunk', 'splunk', { url: `${rUrl}/splunk`, token: 'hec-secret', index: 'ai' });
  await add('Archive', 's3', { bucket: 'ct-flights', region: 'eu-west-1', prefix: 'prod/', endpoint: `${rUrl}/s3`, access_key_id: 'AKIAEXPORTTEST', secret_access_key: 's3-secret-value' });
  await add('SIEM hook', 'webhook', { url: `${rUrl}/hook`, secret: SECRET });
  const list = (await admin.get('/admin/api/exports')).body.destinations as any[];
  expect(list).toHaveLength(6);
  const text = JSON.stringify(list);
  for (const s of ['otel-secret', 'dd-secret-key', 'hec-secret', 's3-secret-value', SECRET]) expect(text).not.toContain(s);
  expect(list.find((d) => d.name === 'Datadog').secrets_set).toEqual(['api_key']);
  expect(list.find((d) => d.name === 'Archive').target_hint).toContain('s3://ct-flights/prod/');
});

test('a call reaches every destination as metadata, in each one\'s own format', async () => {
  const traceId = crypto.randomBytes(16).toString('hex');
  const parentSpan = crypto.randomBytes(8).toString('hex');
  const r = await fetch(`${CT}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', traceparent: `00-${traceId}-${parentSpan}-01`, 'x-ct-tags': 'quarterly', 'x-ct-customer': 'acme' },
    body: JSON.stringify({ model: 'ex-model', max_tokens: 5, messages: [{ role: 'user', content: PROMPT }] }),
  });
  expect(r.status).toBe(200);
  const flightId = r.headers.get('x-ct-flight-id')!;
  for (const d of destIds) await admin.post(`/admin/api/exports/${d}/flush`);
  const everything = got.map((g) => (g.path.startsWith('/s3') ? gunzipSync(g.body).toString('utf8') : g.body.toString('utf8'))).join('\n');
  // Metadata only: the prompt and the answer never leave.
  expect(everything).not.toContain('4,211,007');
  expect(everything).not.toContain('ex:ok-export');

  // OpenTelemetry spans, inside the agent's own trace, with GenAI attributes.
  const tr = at('/otel/v1/traces').map(json).flatMap((b) => b.resourceSpans[0].scopeSpans[0].spans);
  const span = tr.find((s: any) => s.attributes.some((a: any) => a.key === 'controltower.flight_id' && a.value.stringValue === flightId));
  expect(span).toMatchObject({ traceId, parentSpanId: parentSpan, name: 'chat ex-model', kind: 3, status: { code: 1 } });
  const attr = (k: string) => span.attributes.find((a: any) => a.key === k)?.value;
  expect(attr('gen_ai.request.model')).toEqual({ stringValue: 'ex-model' });
  expect(attr('gen_ai.usage.input_tokens')).toEqual({ intValue: '10' });
  expect(attr('controltower.team')).toEqual({ stringValue: 'finance' });
  expect(attr('controltower.customer')).toEqual({ stringValue: 'acme' });
  expect(at('/otel/v1/traces')[0]!.headers.authorization).toBe('Bearer otel-secret');
  // …and as log records.
  const logs = at('/otel/v1/logs').map(json).flatMap((b) => b.resourceLogs[0].scopeLogs[0].logRecords);
  const log = logs.find((l: any) => JSON.parse(l.body.stringValue).id === flightId);
  expect(log).toMatchObject({ severityText: 'INFO', traceId });

  // Datadog: the log intake's shape, keyed with the API key.
  const dd = at('/dd/api/v2/logs');
  expect(dd[0]!.headers['dd-api-key']).toBe('dd-secret-key');
  const ddRec = dd.flatMap(json).find((x: any) => x.id === flightId);
  expect(ddRec).toMatchObject({ ddsource: 'controltower', service: 'agents', ddtags: 'env:e2e', status: 'info', flight_status: 'ok', customer: 'acme', tags: ['quarterly'] });
  expect(ddRec.message).toBe('export-agent → ex-model: ok');

  // Splunk HEC.
  const hec = at('/splunk/services/collector/event');
  expect(hec[0]!.headers.authorization).toBe('Splunk hec-secret');
  const ev = hec.flatMap((g) => g.body.toString('utf8').split('\n').map((l) => JSON.parse(l))).find((x: any) => x.event.id === flightId);
  expect(ev).toMatchObject({ index: 'ai', sourcetype: 'controltower:flight', event: { agent: { key_name: 'export-agent', team: 'finance' }, target: { model_requested: 'ex-model' } } });

  // S3: a gzipped JSON Lines file under the prefix, dated, SigV4-signed.
  const put = at('/s3/ct-flights/prod/').at(-1)!;
  expect(put.path).toMatch(/^\/s3\/ct-flights\/prod\/\d{4}\/\d{2}\/\d{2}\/\d{2}\/\d{8}T\d{6}Z-[0-9a-f]{8}\.jsonl\.gz$/);
  expect(put.headers['x-amz-content-sha256']).toBe(crypto.createHash('sha256').update(put.body).digest('hex'));
  expect(put.headers.authorization).toContain('/eu-west-1/s3/aws4_request');
  const lines = gunzipSync(put.body).toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(lines.find((x) => x.id === flightId)).toMatchObject({ type: 'controltower.flight', status: 'ok', usage: { input: 10, output: 5 } });

  // A webhook, signed.
  const hook = at('/hook').at(-1)!;
  const [, t] = /t=(\d+)/.exec(String(hook.headers['x-ct-signature']))!;
  const [, v1] = /v1=([0-9a-f]+)/.exec(String(hook.headers['x-ct-signature']))!;
  expect(crypto.createHmac('sha256', SECRET).update(`${t}.${hook.body.toString('utf8')}`).digest('hex')).toBe(v1);
  expect(json(hook)).toMatchObject({ type: 'controltower.flights' });

  // Delivery shows in the console.
  const list = (await admin.get('/admin/api/exports')).body.destinations as any[];
  for (const d of list) expect(d, d.name).toMatchObject({ last_status: 'ok', queued: 0 });
  expect(list.every((d) => d.sent >= 1)).toBe(true);
});

test('a blocked call is exported with the gate that stopped it', async () => {
  const rule = await admin.post('/admin/api/rules', { name: 'ex: no ex-model on Fridays', target_kind: 'model', match: { models: ['ex-model'] }, effect: 'deny' });
  try {
    const r = await fetch(`${CT}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'ex-model', messages: [{ role: 'user', content: 'x' }] }) });
    expect(r.status).toBe(403);
    const id = r.headers.get('x-ct-flight-id')!;
    await admin.post(`/admin/api/exports/${destIds[5]}/flush`);
    const rec = at('/hook').flatMap((g) => json(g).records).find((x: any) => x.id === id);
    expect(rec).toMatchObject({ status: 'denied', http_status: 403, decision: { effect: 'deny', rule_id: rule.body.id ?? rule.body.rule?.id } });
  } finally {
    await admin.del(`/admin/api/rules/${rule.body.id ?? rule.body.rule?.id}`);
  }
});

test('"Test" sends an example record; a destination that is down reports why', async () => {
  const ok = await admin.post('/admin/api/exports/test', { id: destIds[5] });
  expect(ok.body).toEqual({ ok: true });
  const bad = await admin.post('/admin/api/exports/test', { kind: 'splunk', config: { url: `${rUrl}/down`, token: 't' } });
  expect(bad.body.ok).toBe(false);
  expect(bad.body.error).toContain('503');
  const s3 = await admin.post('/admin/api/exports/test', { kind: 's3', config: { bucket: 'ct-flights', endpoint: `${rUrl}/s3`, access_key_id: 'AKIAWRONG', secret_access_key: 'x' } });
  expect(s3.body).toMatchObject({ ok: false });
  expect(s3.body.error).toContain('Access Denied');

  // Changing settings keeps the stored secret when it is left out.
  const hookId = destIds[5]!;
  expect((await admin.patch(`/admin/api/exports/${hookId}`, { config: { url: `${rUrl}/hook2` } })).status).toBe(200);
  await admin.post('/admin/api/exports/test', { id: hookId });
  const h2 = at('/hook2').at(-1)!;
  expect(String(h2.headers['x-ct-signature'])).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
});

test('the audit log goes to a SIEM in order, with its chain; a SIEM that was down catches up (Enterprise)', async () => {
  // Only the audit log, from every event still kept.
  const r = await admin.post('/admin/api/exports', { name: 'SIEM (audit)', kind: 'webhook', config: { url: `${rUrl}/audit`, secret: SECRET }, send_flights: false, send_audit: true, audit_from: 'start' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const siem = r.body.id as string;
  destIds.push(siem);
  const splunk = await admin.post('/admin/api/exports', { name: 'Splunk (audit)', kind: 'splunk', config: { url: `${rUrl}/splunk-audit`, token: 'hec-secret', index: 'ai', audit_index: 'security' }, send_flights: false, send_audit: true });
  destIds.push(splunk.body.id);
  expect((await admin.post('/admin/api/exports', { kind: 'webhook', config: { url: `${rUrl}/x` }, send_flights: false, send_audit: false })).status).toBe(400);

  // A change, and a call (which an audit-only destination doesn't get).
  const k = await admin.post('/admin/api/keys', { name: 'siem-audited-agent' });
  await fetch(`${CT}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'ex-model', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }) });
  await admin.post(`/admin/api/exports/${siem}/flush`);
  await admin.post(`/admin/api/exports/${splunk.body.id}/flush`);

  const batches = at('/audit').map(json);
  expect(batches.every((b) => b.type === 'controltower.audit')).toBe(true);
  const events = batches.flatMap((b) => b.events);
  const seqs = events.map((e: any) => e.seq);
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  for (let i = 1; i < events.length; i++) {
    expect(events[i].seq).toBe(events[i - 1].seq + 1);
    expect(events[i].prev_hash).toBe(events[i - 1].hash);
  }
  const made = events.find((e: any) => e.action === 'keys.create' && e.target?.id === k.body.id);
  expect(made).toMatchObject({ outcome: 'success', status: 201, actor: { type: 'person' } });
  expect(JSON.stringify(events)).not.toContain(k.body.key); // the key it returned is never recorded
  expect(events.some((e: any) => e.action === 'exports.create')).toBe(true); // including setting this up
  const sig = at('/audit')[0]!.headers['x-ct-signature'];
  const [t, v1] = String(sig).replace('t=', '').split(',v1=');
  expect(v1).toBe(crypto.createHmac('sha256', SECRET).update(`${t}.${at('/audit')[0]!.body.toString('utf8')}`).digest('hex'));

  // Splunk: its own source type and index; from when it was added, not before.
  const hec = at('/splunk-audit/services/collector/event').flatMap((g) => g.body.toString('utf8').split('\n').map((l) => JSON.parse(l)));
  expect(hec.length).toBeGreaterThan(0);
  expect(hec.every((x) => x.sourcetype === 'controltower:audit' && x.index === 'security')).toBe(true);
  expect(hec.some((x) => x.event.action === 'keys.create' && x.event.target?.id === k.body.id)).toBe(true);
  expect(Math.min(...hec.map((x) => x.event.seq))).toBeGreaterThan(Math.min(...seqs));

  // The SIEM goes down: events wait in the log, and it says so; back up, it gets them all, none twice.
  await admin.patch(`/admin/api/exports/${siem}`, { config: { url: `${rUrl}/down-audit` } });
  const whileDown = await admin.post('/admin/api/keys', { name: 'siem-while-down' });
  await admin.post(`/admin/api/exports/${siem}/flush`);
  const failing = ((await admin.get('/admin/api/exports')).body.destinations as any[]).find((d) => d.id === siem);
  expect(failing).toMatchObject({ send_flights: false, send_audit: true, audit: { last_status: 'error', last_error: expect.stringContaining('503') } });
  expect(failing.audit.behind).toBeGreaterThan(0);
  await admin.patch(`/admin/api/exports/${siem}`, { config: { url: `${rUrl}/audit` } });
  await admin.post(`/admin/api/exports/${siem}/flush`);
  const after = at('/audit').map(json).flatMap((b) => b.events);
  const all = after.map((e: any) => e.seq);
  expect(new Set(all).size).toBe(all.length);
  for (let i = 1; i < after.length; i++) expect(after[i].seq).toBe(after[i - 1].seq + 1);
  expect(after.some((e: any) => e.action === 'keys.create' && e.detail?.body?.name === 'siem-while-down')).toBe(true);
  const ok = ((await admin.get('/admin/api/exports')).body.destinations as any[]).find((d) => d.id === siem);
  expect(ok.audit).toMatchObject({ last_status: 'ok' });

  // "Test" on an audit destination sends an example event.
  expect((await admin.post('/admin/api/exports/test', { id: siem, stream: 'audit' })).body).toEqual({ ok: true });
  expect(at('/audit').map(json).at(-1).events[0]).toMatchObject({ action: 'audit.test', seq: 0 });
  // Leave the fleet as it was (later specs count agents on the map).
  for (const id of [k.body.id, whileDown.body.id]) await admin.del(`/admin/api/keys/${id}`);
});
