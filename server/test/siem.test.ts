import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openSqlite } from '../src/db/index.js';
import { AuditLog } from '../src/ee/audit.js';
import { AuditShipper, deliverAudit, otlpAuditLogs } from '../src/ee/siem.js';
import { publicEvent } from '../src/ee/audit.js';

const person = { type: 'person' as const, id: 'u1', email: 'dana@example.com', role: 'admin' };
const quiet = () => ({ warn: () => undefined });

let server: http.Server;
let url = '';
let down = false;
const batches: Array<{ path: string; body: any }> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (down) {
        res.writeHead(503);
        return res.end('down for maintenance');
      }
      const text = Buffer.concat(chunks).toString('utf8');
      batches.push({ path: req.url ?? '', body: req.url?.includes('collector') ? text.split('\n').map((l) => JSON.parse(l)) : JSON.parse(text) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function setup(instanceId = 'i1', db = openSqlite('', { memory: true }), dests = [{ id: 'd1', name: 'SIEM', kind: 'webhook' as const, config: { url: `${url}/hook` } }]) {
  const log = new AuditLog(db);
  let allowed = true;
  const shipper = new AuditShipper({ db, destinations: () => dests, allowed: () => allowed, instanceId, version: 'test', log: quiet });
  return { db, log, shipper, dests, allow: (v: boolean) => (allowed = v) };
}
const record = (log: AuditLog, n: number, from = 0) => Promise.all(Array.from({ length: n }, (_, i) => log.record({ action: 'keys.create', outcome: 'success', actor: person, status: 201, target: { type: 'keys', id: `k${from + i}` } })));
const received = () => batches.filter((b) => b.path === '/hook').flatMap((b) => b.body.events as any[]);

describe('audit log to a SIEM', () => {
  it('sends every event once, in order, with its chain; picks up after an outage where it stopped', async () => {
    batches.length = 0;
    const { log, shipper } = setup();
    await record(log, 3);
    await shipper.begin('d1', 'start');
    await shipper.drain('d1');
    expect(received().map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(batches[0]!.body).toMatchObject({ type: 'controltower.audit', count: 3 });

    // The SIEM goes down: nothing is lost, the position doesn't move, the failure is reported.
    down = true;
    await record(log, 2, 3);
    await shipper.drain('d1');
    const failing = (await shipper.states()).get('d1')!;
    expect(failing).toMatchObject({ last_seq: 3, behind: 2, last_status: 'error', last_error: expect.stringContaining('503') });
    down = false;
    await shipper.drain('d1');
    const all = received();
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    // Each event names the one before it, so the SIEM can check nothing is missing.
    for (let i = 1; i < all.length; i++) expect(all[i].prev_hash).toBe(all[i - 1].hash);
    expect((await shipper.states()).get('d1')).toMatchObject({ last_seq: 5, behind: 0, sent: 5, skipped: 0, last_status: 'ok' });
  });

  it('starts from now unless asked for the history; counts events retention removed before they were sent', async () => {
    batches.length = 0;
    const { db, log, shipper } = setup();
    await record(log, 4);
    await shipper.begin('d1', 'now');
    await record(log, 1, 4);
    await shipper.drain('d1');
    expect(received().map((e) => e.seq)).toEqual([5]);

    await record(log, 3, 5);
    db.raw.prepare('DELETE FROM audit_events WHERE seq IN (6, 7)').run();
    await shipper.drain('d1');
    expect(received().map((e) => e.seq)).toEqual([5, 8]);
    expect((await shipper.states()).get('d1')).toMatchObject({ skipped: 2, sent: 2 });
  });

  it('sends nothing without the license, and resumes from its position when it comes back', async () => {
    batches.length = 0;
    const { log, shipper, allow } = setup();
    await shipper.begin('d1', 'start');
    await record(log, 2);
    allow(false);
    await shipper.tick();
    await shipper.drain('d1');
    expect(received()).toHaveLength(0);
    allow(true);
    await shipper.tick();
    expect(received().map((e) => e.seq)).toEqual([1, 2]);
  });

  it('with several instances, the one holding the lease sends; another takes over when it stops', async () => {
    batches.length = 0;
    const a = setup('instance-a');
    const b = setup('instance-b', a.db);
    await a.shipper.begin('d1', 'start');
    await record(a.log, 3);
    await Promise.all([a.shipper.tick(), b.shipper.tick()]);
    await b.shipper.tick();
    expect(received().map((e) => e.seq)).toEqual([1, 2, 3]);
    const owner = a.db.raw.prepare("SELECT lease_owner FROM audit_exports WHERE destination_id = 'd1'").get() as { lease_owner: string };
    const [holder, other] = owner.lease_owner === 'instance-a' ? [a, b] : [b, a];
    await record(a.log, 1, 3);
    await other.shipper.tick();
    expect(received()).toHaveLength(3);
    await holder.shipper.stop();
    await other.shipper.tick();
    expect(received().map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it('a SIEM can recompute each event\'s hash from what it receives (the recipe in the docs)', async () => {
    batches.length = 0;
    const { log, shipper } = setup();
    await shipper.begin('d1', 'start');
    await log.record({ action: 'providers.create', outcome: 'success', actor: person, status: 201, target: { type: 'providers', id: 'p1' }, detail: { method: 'POST', body: { name: 'OpenAI', note: 'ünïcode — and "quotes"', n: 1.5 } }, ip: '10.0.0.1', userAgent: 'ua', requestId: 'r1' });
    await log.record({ action: 'auth.sign_in', outcome: 'denied', actor: { type: 'anonymous' }, status: 401 });
    await shipper.drain('d1');
    const { createHash } = await import('node:crypto');
    for (const e of received()) {
      const fields = [e.seq, e.id, Date.parse(e.time), e.actor.type, e.actor.id, e.actor.email, e.actor.role, e.action, e.outcome, e.status, e.target?.type ?? null, e.target?.id ?? null, e.detail === null ? null : JSON.stringify(e.detail), e.ip, e.user_agent, e.request_id, e.prev_hash];
      expect(createHash('sha256').update(JSON.stringify(fields)).digest('hex')).toBe(e.hash);
    }
  });

  it('formats events for Splunk, Datadog and OpenTelemetry', async () => {
    batches.length = 0;
    const { db, log } = setup();
    await log.record({ action: 'auth.sign_in', outcome: 'denied', actor: { type: 'anonymous' }, status: 401, ip: '10.0.0.9', userAgent: 'curl/8', requestId: 'req-9' });
    const events = (await db.read.selectFrom('audit_events').selectAll().execute()).map(publicEvent);

    await deliverAudit('splunk', { url: `${url}/splunk`, token: 't', index: 'ai', audit_index: 'security' }, events, { version: 'test' });
    const hec = batches.find((b) => b.path === '/splunk/services/collector/event')!.body[0];
    expect(hec).toMatchObject({ source: 'controltower', sourcetype: 'controltower:audit', index: 'security', event: { action: 'auth.sign_in', outcome: 'denied', seq: 1 } });

    await deliverAudit('datadog', { api_key: 'k', endpoint: `${url}/dd`, service: 'ct' }, events, { version: 'test' });
    const dd = batches.find((b) => b.path === '/dd/api/v2/logs')!.body[0];
    expect(dd).toMatchObject({ ddsource: 'controltower', service: 'ct', status: 'warn', message: 'someone not signed in auth.sign_in: denied (401)', evt: { name: 'auth.sign_in', outcome: 'denied' }, network: { client: { ip: '10.0.0.9' } }, http: { status_code: 401, useragent: 'curl/8', request_id: 'req-9' } });
    expect(dd.audit).toMatchObject({ seq: 1, http_status: 401 });

    const otel = otlpAuditLogs(events, { version: 'test' }).resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!;
    const attr = (k: string) => otel.attributes.find((a) => a.key === k)?.value;
    expect(otel.severityText).toBe('WARN');
    expect(attr('event.name')).toEqual({ stringValue: 'controltower.audit' });
    expect(attr('client.address')).toEqual({ stringValue: '10.0.0.9' });
    expect(attr('http.response.status_code')).toEqual({ intValue: '401' });
  });
});
