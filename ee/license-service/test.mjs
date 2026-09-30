// Tests for the license service against a fake Stripe. Run: node --test ee/license-service/test.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { test, before, after } from 'node:test';

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const tiers = [
  { up_to: 20, unit_amount: 60000, flat_amount: null },
  { up_to: 95, unit_amount: 45000, flat_amount: null },
];
const PRICES = [
  { id: 'price_py', lookup_key: 'ct_enterprise_platform_year', unit_amount: 600000 },
  { id: 'price_sy', lookup_key: 'ct_enterprise_seat_year', unit_amount: null, tiers },
  { id: 'price_pm', lookup_key: 'ct_enterprise_platform_month', unit_amount: 60000 },
  { id: 'price_sm', lookup_key: 'ct_enterprise_seat_month', unit_amount: null, tiers: [{ up_to: 20, unit_amount: 6000 }, { up_to: 95, unit_amount: 4500 }] },
];
const periodEnd = Math.floor(Date.now() / 1000) + 365 * 86400;
const stripe = { sessions: [], subStatus: 'active', seatQty: 7, periodEnd, metadata: [] };
const emails = [];
const sub = () => ({
  id: 'sub_123',
  status: stripe.subStatus,
  start_date: 1788000000,
  customer: { id: 'cus_1', name: 'Acme Inc', email: 'buyer@acme.com' },
  items: { data: [{ price: { id: 'price_py', lookup_key: 'ct_enterprise_platform_year' }, quantity: 1, current_period_end: stripe.periodEnd }, { price: { id: 'price_sy', lookup_key: 'ct_enterprise_seat_year' }, quantity: stripe.seatQty, current_period_end: stripe.periodEnd }] },
});

let fake, svc, base;
before(async () => {
  fake = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const j = (s, o) => {
        res.writeHead(s, { 'content-type': 'application/json' });
        res.end(JSON.stringify(o));
      };
      // The email service (Resend's API).
      if (u.pathname === '/emails') {
        assert.equal(req.headers.authorization, 'Bearer re_test_fake');
        emails.push(JSON.parse(body));
        return j(200, { id: `em_${emails.length}` });
      }
      assert.equal(req.headers.authorization, 'Bearer sk_test_fake');
      if (u.pathname === '/v1/prices') return j(200, { data: PRICES });
      if (u.pathname === '/v1/checkout/sessions' && req.method === 'POST') {
        stripe.sessions.push(Object.fromEntries(new URLSearchParams(body)));
        return j(200, { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
      }
      if (u.pathname === '/v1/checkout/sessions/cs_test_1') return j(200, { id: 'cs_test_1', status: 'complete', customer_details: { name: 'Acme Inc', email: 'buyer@acme.com' }, subscription: sub() });
      if (u.pathname === '/v1/subscriptions/sub_123' && req.method === 'POST') return (stripe.metadata.push(Object.fromEntries(new URLSearchParams(body))), j(200, sub()));
      if (u.pathname === '/v1/subscriptions/sub_123') return j(200, sub());
      if (u.pathname === '/v1/billing_portal/sessions') return j(200, { url: 'https://billing.stripe.com/p/session/x' });
      return j(404, { error: { message: 'no such thing' } });
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  process.env.STRIPE_API_BASE = `http://127.0.0.1:${fake.address().port}`;
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
  process.env.LICENSE_SIGNING_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' });
  process.env.PUBLIC_URL = 'https://license.example.com';
  process.env.RESEND_API_KEY = 're_test_fake';
  process.env.EMAIL_API_BASE = process.env.STRIPE_API_BASE;
  const mod = await import(`./server.mjs?${Date.now()}`);
  svc = mod.createServer();
  await new Promise((r) => svc.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${svc.address().port}`;
});
after(() => {
  svc.close();
  fake.close();
});

const decode = (key) => {
  const [v, b, s] = key.split('.');
  assert.ok(crypto.verify(null, Buffer.from(`${v}.${b}`), publicKey, Buffer.from(s, 'base64url')), 'signed by the licensor key');
  return JSON.parse(Buffer.from(b, 'base64url').toString());
};

test('the plans page shows live prices and a seat slider', async () => {
  const t = await (await fetch(base)).text();
  assert.match(t, /type="range" min="5" max="100"/);
  assert.match(t, /ct_enterprise_platform_year/);
});

test('checkout: the platform price plus seats beyond the five included', async () => {
  const r = await fetch(`${base}/checkout`, { method: 'POST', body: new URLSearchParams({ seats: '12', interval: 'year' }), redirect: 'manual' });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), 'https://checkout.stripe.com/c/pay/cs_test_1');
  const s = stripe.sessions.at(-1);
  assert.equal(s.mode, 'subscription');
  assert.equal(s['line_items[0][price]'], 'price_py');
  assert.equal(s['line_items[1][price]'], 'price_sy');
  assert.equal(s['line_items[1][quantity]'], '7');
  assert.equal(s.success_url, 'https://license.example.com/success?session_id={CHECKOUT_SESSION_ID}');
  // Five seats: the platform price alone; out-of-range seats are clamped.
  await fetch(`${base}/checkout`, { method: 'POST', body: new URLSearchParams({ seats: '2', interval: 'month' }), redirect: 'manual' });
  assert.equal(stripe.sessions.at(-1)['line_items[0][price]'], 'price_pm');
  assert.equal(stripe.sessions.at(-1)['line_items[1][price]'], undefined);
});

test('success shows a signed key for the subscription', async () => {
  const t = await (await fetch(`${base}/success?session_id=cs_test_1`)).text();
  const key = /(ctl1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/.exec(t)[1];
  const l = decode(key);
  assert.deepEqual({ plan: l.plan, seats: l.seats, customer: l.customer, sub: l.sub, id: l.id }, { plan: 'enterprise', seats: 12, customer: 'Acme Inc', sub: 'sub_123', id: 'lic_sub_123' });
  assert.equal(l.expires_at, periodEnd * 1000);
  assert.equal((await fetch(`${base}/success?session_id=../../v1/prices`)).status, 400);
});

test('refresh: unchanged, renewed with new seats or period, ended when cancelled; forged keys refused', async () => {
  const t = await (await fetch(`${base}/success?session_id=cs_test_1`)).text();
  const key = /(ctl1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/.exec(t)[1];
  const refresh = (k) => fetch(`${base}/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: k }) }).then((r) => r.json());
  assert.deepEqual(await refresh(key), { status: 'unchanged' });
  stripe.seatQty = 20;
  stripe.periodEnd += 365 * 86400;
  const r = await refresh(key);
  assert.equal(r.status, 'renewed');
  assert.equal(decode(r.key).seats, 25);
  stripe.subStatus = 'canceled';
  assert.deepEqual(await refresh(key), { status: 'ended', subscription: 'canceled' });
  const other = crypto.generateKeyPairSync('ed25519').privateKey;
  const head = `ctl1.${Buffer.from(JSON.stringify({ sub: 'sub_123' })).toString('base64url')}`;
  assert.equal((await fetch(`${base}/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: `${head}.${crypto.sign(null, Buffer.from(head), other).toString('base64url')}` }) })).status, 400);
  stripe.subStatus = 'active';
});

test('refresh: keys carry when the subscription began; the request count is kept on the subscription', async () => {
  const t = await (await fetch(`${base}/success?session_id=cs_test_1`)).text();
  const key = /(ctl1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/.exec(t)[1];
  assert.equal(decode(key).period_start, 1788000000 * 1000);
  const r = await fetch(`${base}/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, usage: { requests: 412345, period_start: 1788000000 * 1000, period_end: 1819536000 * 1000 } }) }).then((x) => x.json());
  assert.equal(r.status, 'unchanged');
  const m = stripe.metadata.at(-1);
  assert.equal(m['metadata[requests_this_year]'], '412345');
  assert.equal(m['metadata[requests_period_start]'], new Date(1788000000 * 1000).toISOString().slice(0, 10));
  // A count that isn't a number is ignored.
  const before = stripe.metadata.length;
  await fetch(`${base}/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, usage: { requests: 'lots' } }) });
  assert.equal(stripe.metadata.length, before);
});

test('trials: the key goes by email, behind a link that works for a day; 30 days, 5 seats', async () => {
  const t = await (await fetch(`${base}/trial`, { method: 'POST', body: new URLSearchParams({ company: 'Tryco', email: 'Dev@Tryco.io' }) })).text();
  assert.match(t, /Check your inbox/);
  assert.doesNotMatch(t, /ctl1\./, 'no key on the page: only the mailbox gets it');
  const mail = emails.at(-1);
  assert.deepEqual(mail.to, ['dev@tryco.io']);
  const link = /https:\/\/license\.example\.com\/trial\/confirm\?t=[^"\s]+/.exec(mail.html)[0];
  assert.ok(mail.text.includes(link));
  const open = async () => (await fetch(`${base}${new URL(link).pathname}${new URL(link).search}`)).text();
  const page = await open();
  const key = /(ctl1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/.exec(page)[1];
  const l = decode(key);
  assert.deepEqual({ plan: l.plan, seats: l.seats, customer: l.customer, email: l.email }, { plan: 'trial', seats: 5, customer: 'Tryco', email: 'dev@tryco.io' });
  assert.ok(Math.abs(l.expires_at - Date.now() - 30 * 86_400_000) < 60_000);
  // Opening the link again gives the same key, not a second trial.
  assert.equal(/(ctl1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/.exec(await open())[1], key);
  // A changed link, or a license key passed off as one, is refused; so is a link more than a day old.
  const tok = new URL(link).searchParams.get('t');
  const [k, b, sig] = tok.split('.');
  const edited = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(b, 'base64url')), email: 'someone@else.io' })).toString('base64url');
  assert.equal((await fetch(`${base}/trial/confirm?t=${k}.${edited}.${sig}`)).status, 400);
  assert.equal((await fetch(`${base}/trial/confirm?t=${encodeURIComponent(key)}`)).status, 400);
  const oldHead = `ctt1.${Buffer.from(JSON.stringify({ company: 'Tryco', email: 'dev@tryco.io', iat: Date.now() - 2 * 86_400_000, exp: Date.now() - 86_400_000 })).toString('base64url')}`;
  const old = `${oldHead}.${crypto.sign(null, Buffer.from(oldHead), privateKey).toString('base64url')}`;
  assert.equal((await fetch(`${base}/trial/confirm?t=${encodeURIComponent(old)}`)).status, 410);
  // The same address can't ask again and again.
  await fetch(`${base}/trial`, { method: 'POST', body: new URLSearchParams({ company: 'Tryco', email: 'dev@tryco.io' }) });
  assert.equal((await fetch(`${base}/trial`, { method: 'POST', headers: { 'x-real-ip': '203.0.113.9' }, body: new URLSearchParams({ company: 'Tryco', email: 'dev@tryco.io' }) })).status, 429);
});

test('without an email service, the trial key is shown at once', async () => {
  const saved = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  const mod = await import(`./server.mjs?noemail=${Date.now()}`);
  process.env.RESEND_API_KEY = saved;
  const s2 = mod.createServer();
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  const t = await (await fetch(`http://127.0.0.1:${s2.address().port}/trial`, { method: 'POST', body: new URLSearchParams({ company: 'Walkin', email: 'a@walkin.io' }) })).text();
  s2.close();
  assert.equal(decode(/(ctl1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/.exec(t)[1]).customer, 'Walkin');
});

test('a client can\'t dodge the limit by writing its own X-Forwarded-For', async () => {
  const ask = (i) => fetch(`${base}/trial`, { method: 'POST', headers: { 'x-forwarded-for': `198.51.100.${i}` }, body: new URLSearchParams({ company: 'Spoof', email: `s${i}@spoof.io` }) }).then((r) => r.status);
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push(await ask(i));
  assert.ok(codes.includes(429), codes.join(' '));
});

test('trials: rate-limited, and the form is checked', async () => {
  const from = { 'x-real-ip': '192.0.2.50' };
  assert.equal((await fetch(`${base}/trial`, { method: 'POST', headers: from, body: new URLSearchParams({ company: 'x', email: 'bad' }) })).status, 400);
  for (let i = 0; i < 3; i++) await fetch(`${base}/trial`, { method: 'POST', headers: from, body: new URLSearchParams({ company: 'y', email: `y${i}@y.io` }) });
  assert.equal((await fetch(`${base}/trial`, { method: 'POST', headers: from, body: new URLSearchParams({ company: 'z', email: 'z@z.io' }) })).status, 429);
});

test('prices: graduated seat tiers give the volume discount', async () => {
  const { total } = await import('./server.mjs');
  const [py, sy] = PRICES;
  assert.equal(total(py, sy, 5), 600000);
  assert.equal(total(py, sy, 25), 600000 + 20 * 60000);
  assert.equal(total(py, sy, 30), 600000 + 20 * 60000 + 5 * 45000);
});
