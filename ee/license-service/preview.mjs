// The license service against a stand-in for Stripe, for working on its pages: node ee/license-service/preview.mjs
// Plans at http://127.0.0.1:4810, a paid key at /success?session_id=cs_preview; a trial's email link is printed to the
// console. Keys it shows are signed with a
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
  // The email service: the trial link is printed instead of sent.
  if (u.pathname === '/emails') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      console.log(`trial email to ${JSON.parse(body).to}: ${/http[^\s"]+\/trial\/confirm\?t=[^\s"]+/.exec(JSON.parse(body).text)?.[0]}`);
      j({ id: 'em_preview' });
    });
    return;
  }
  res.writeHead(404).end('{}');
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
process.env.STRIPE_API_BASE = `http://127.0.0.1:${fake.address().port}`;
process.env.STRIPE_SECRET_KEY = 'sk_test_preview';
process.env.RESEND_API_KEY = 're_preview';
process.env.EMAIL_API_BASE = process.env.STRIPE_API_BASE;
process.env.LICENSE_SIGNING_KEY = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
process.env.PUBLIC_URL = `http://127.0.0.1:${PORT}`;
// The Trials page (/admin), with sample trials at each stage. Local only: the password is "preview".
process.env.ADMIN_PASSWORD = 'preview';
const { createServer, trialsStore: store } = await import('./server.mjs');
{
  const D = 86_400_000;
  const now = Date.now();
  const sample = [
    ['Northwind Labs', 'platform@northwind.example', 12, true, [[1, 40, 2], [5, 2900, 4], [11, 9100, 6]], false],
    ['Contoso Health', 'it@contoso.example', 9, true, [[2, 120, 1], [3, 410, 1]], false],
    ['Fabrikam', 'devops@fabrikam.example', 3, true, [], false],
    ['Tailspin Air', 'cto@tailspin.example', 26, true, [[1, 300, 3], [24, 51000, 12]], true],
    ['Unopened Co', 'someone@unopened.example', 1, false, [], false],
  ];
  for (const [company, email, daysAgo, opened, checks, bought] of sample) {
    const at = now - daysAgo * D;
    const id = `lic_trial_${crypto.createHash('sha256').update(`${email}|${at}`).digest('hex').slice(0, 12)}`;
    store.requested({ id, email, company, at });
    if (opened) store.confirmed({ id, email, company, at });
    for (const [d, requests, seats] of checks) store.checkin({ id, email, company, at }, { requests, seats_used: seats, version: '0.2.16' }, at + d * D);
    if (opened) store.emailed(id, 'welcome', 'Your Control Tower trial: where to start', 'Your key is in…', true, undefined, at + 600_000);
    if (daysAgo >= 7 && opened) store.emailed(id, 'day7', 'How’s your Control Tower trial going?', 'A week in…', true, undefined, at + 7 * D);
    if (bought) store.bought(email, now - D);
  }
  for (const [reason, k] of [['no_form', 14], ['honeypot', 5], ['too_fast', 2]]) for (let i = 0; i < k; i++) store.blocked(reason, 'v•••@example.org', now - i * 3600_000);
}
createServer().listen(PORT, '127.0.0.1', () => console.log(`license service preview on http://127.0.0.1:${PORT}`));
