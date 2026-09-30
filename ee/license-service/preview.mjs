// The license service against a stand-in for Stripe, for working on its pages: node ee/license-service/preview.mjs
// Plans at http://127.0.0.1:4810, a paid key at /success?session_id=cs_preview. Keys it shows are signed with a
// throwaway key: no Control Tower accepts them.
import crypto from 'node:crypto';
import http from 'node:http';

const PORT = Number(process.env.PORT ?? 4810);
const tiers = (a, b) => [{ up_to: 20, unit_amount: a }, { up_to: 95, unit_amount: b }];
const PRICES = [
  { id: 'p1', lookup_key: 'ct_enterprise_platform_year', unit_amount: 600000 },
  { id: 'p2', lookup_key: 'ct_enterprise_seat_year', unit_amount: null, tiers: tiers(60000, 45000) },
  { id: 'p3', lookup_key: 'ct_enterprise_platform_month', unit_amount: 60000 },
  { id: 'p4', lookup_key: 'ct_enterprise_seat_month', unit_amount: null, tiers: tiers(6000, 4500) },
];
const end = Math.floor(Date.now() / 1000) + 365 * 86400;
const sub = { id: 'sub_preview', status: 'active', start_date: Math.floor(Date.now() / 1000), customer: { name: 'Acme Corp', email: 'it@acme.com' }, items: { data: [{ price: { lookup_key: 'ct_enterprise_platform_year' }, quantity: 1, current_period_end: end }, { price: { lookup_key: 'ct_enterprise_seat_year' }, quantity: 20, current_period_end: end }] } };
const fake = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const j = (o) => (res.writeHead(200, { 'content-type': 'application/json' }), res.end(JSON.stringify(o)));
  if (u.pathname === '/v1/prices') return j({ data: PRICES });
  if (u.pathname.startsWith('/v1/checkout/sessions/')) return j({ id: 'cs_preview', status: 'complete', customer_details: { name: 'Acme Corp', email: 'it@acme.com' }, subscription: sub });
  if (u.pathname === '/v1/checkout/sessions') return j({ id: 'cs_preview', url: `http://127.0.0.1:${PORT}/success?session_id=cs_preview` });
  res.writeHead(404).end('{}');
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
process.env.STRIPE_API_BASE = `http://127.0.0.1:${fake.address().port}`;
process.env.STRIPE_SECRET_KEY = 'sk_test_preview';
process.env.LICENSE_SIGNING_KEY = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
process.env.PUBLIC_URL = `http://127.0.0.1:${PORT}`;
const { createServer } = await import('./server.mjs');
createServer().listen(PORT, '127.0.0.1', () => console.log(`license service preview on http://127.0.0.1:${PORT}`));
