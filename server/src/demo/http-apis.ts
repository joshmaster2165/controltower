import type { FastifyInstance } from 'fastify';
import { ulid } from 'ulid';
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';
import type { SecretBox } from '../crypto/secrets.js';

/**
 * A small in-process REST API for demo mode: a status page (fictional data,
 * nothing leaves the process). It is registered as an ordinary HTTP API
 * pointing at loopback, so demo calls go through the real /http gateway, and
 * it insists on its own bearer token — which only Control Tower holds.
 */
export const DEMO_HTTP_ID = 'http_demo_statuspage';
const TOKEN = 'demo-statuspage-token';

const COMPONENTS = [
  { id: 'cmp_api', name: 'Payments API', status: 'operational' },
  { id: 'cmp_checkout', name: 'Checkout', status: 'operational' },
  { id: 'cmp_webhooks', name: 'Webhooks', status: 'degraded_performance' },
];
const incidents: Array<{ id: string; name: string; status: string; created_at: string }> = [];

export async function mountDemoHttpApis(app: FastifyInstance): Promise<void> {
  const base = '/demo/http/statuspage/api/v1';
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/demo/http/')) return;
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return reply.status(401).send({ error: 'missing or wrong token' });
  });
  app.get(`${base}/components`, async () => COMPONENTS);
  app.get(`${base}/incidents`, async () => incidents.slice(-20));
  app.post(`${base}/incidents`, async (req, reply) => {
    const b = (req.body ?? {}) as { name?: string; status?: string };
    const inc = { id: `inc_${ulid().slice(-8).toLowerCase()}`, name: b.name ?? 'Untitled incident', status: b.status ?? 'investigating', created_at: new Date().toISOString() };
    incidents.push(inc);
    if (incidents.length > 200) incidents.shift();
    return reply.status(201).send(inc);
  });
  app.get('/demo/http/statuspage', async () => ({ ok: true }));
}

/** Registers the demo API, plus a gate: opening or changing incidents needs a human. Idempotent. */
export async function seedDemoHttp(db: Kysely<Database>, secrets: SecretBox, baseUrl: string): Promise<void> {
  const now = Date.now();
  const url = `${baseUrl}/demo/http/statuspage`;
  await db
    .insertInto('http_apis')
    .values({
      id: DEMO_HTTP_ID,
      slug: 'statuspage',
      name: 'Statuspage',
      base_url: url,
      auth_enc: secrets.encrypt(JSON.stringify({ type: 'bearer', token: TOKEN }), `http_apis.auth_enc.${DEMO_HTTP_ID}`),
      timeout_ms: 10_000,
      enabled: 1,
      health: 'ok',
      health_detail: 'demo API',
      last_checked_at: now,
      demo: 1,
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) => oc.column('id').doUpdateSet({ base_url: url, enabled: 1, updated_at: now }))
    .execute();
  await db
    .insertInto('zones')
    .values({ id: 'zone_demo_statuspage', name: 'Statuspage', color: '#0e7490', selector: JSON.stringify({ stations: [`mcp:${DEMO_HTTP_ID}`] }), position: null, demo: 1, created_at: now, updated_at: now })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  await db
    .insertInto('rules')
    .values({
      id: 'rule_demo_statuspage_writes',
      name: 'Public incident updates need approval',
      from_zone: null,
      to_zone: 'zone_demo_statuspage',
      target_kind: 'tool',
      match: JSON.stringify({ operations: ['write', 'admin'] }),
      effect: 'require_approval',
      config: JSON.stringify({ reason: 'Incidents on the public status page are seen by customers — a human approves each one', hold_ms: 20000 }),
      priority: 12,
      enabled: 1,
      revision: 1,
      demo: 1,
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
}
