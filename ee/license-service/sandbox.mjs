// The license service end to end against a Stripe SANDBOX, on this machine. Licensed under the Elastic License 2.0.
//
//   CT_TEST_LICENSE_KEYS=1 pnpm build && node ee/license-service/sandbox.mjs
//
// Reads a sandbox secret key from data/license/stripe-test.key (it refuses a live key) and:
//   1. sets up the sandbox: two products, the four prices by lookup key, and a customer-portal configuration;
//   2. runs the license service (localhost, with a throwaway signing key: nothing it issues is a real license) and
//      a Control Tower test build that trusts that key and renews from it;
//   3. buys through real Stripe Checkout with Stripe's test card, then uses test clocks to go through a renewal,
//      more and fewer seats, a cancellation, and a renewal whose payment fails — checking the license each time.
// Writes data/license/sandbox-results.json.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = fs.readFileSync(path.join(REPO, 'data/license/stripe-test.key'), 'utf8').trim();
if (!/^(sk|rk)_test_/.test(KEY)) throw new Error('data/license/stripe-test.key must hold a sandbox key (sk_test_…); refusing anything else');
const VERSION = '2026-08-26.dahlia';
/** "Downloadable Software - business use": prewritten software the buyer downloads, for a business. To confirm before live. */
const TAX_CODE = 'txcd_10202003';
const SVC_PORT = 4820, CT_PORT = 4830, MAIL_PORT = 4821;
const SVC = `http://127.0.0.1:${SVC_PORT}`, CT = `http://127.0.0.1:${CT_PORT}`;
const ADMIN = 'sandbox-admin-key-0123456789abcdef';
const DAY = 86_400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-sandbox-'));
const SHOTS = path.join(REPO, 'data/license/sandbox-shots');
fs.mkdirSync(SHOTS, { recursive: true });

// ---------- Stripe (the sandbox) ----------
function form(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (typeof v === 'object') form(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}
async function stripe(method, p, body) {
  const r = await fetch(`https://api.stripe.com${p}`, { method, headers: { authorization: `Bearer ${KEY}`, 'stripe-version': VERSION, ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, ...(body ? { body: form(body).toString() } : {}) });
  const j = await r.json();
  if (!r.ok) throw new Error(`Stripe ${method} ${p}: ${j.error?.message ?? r.status}`);
  return j;
}
const PRICES = [
  { lookup_key: 'ct_enterprise_platform_year', product: 'platform', unit_amount: 600000, interval: 'year' },
  { lookup_key: 'ct_enterprise_platform_month', product: 'platform', unit_amount: 60000, interval: 'month' },
  { lookup_key: 'ct_enterprise_seat_year', product: 'seat', interval: 'year', tiers: [[20, 60000], ['inf', 45000]] },
  { lookup_key: 'ct_enterprise_seat_month', product: 'seat', interval: 'month', tiers: [[20, 6000], ['inf', 4500]] },
];
async function setup() {
  const q = new URLSearchParams();
  for (const p of PRICES) q.append('lookup_keys[]', p.lookup_key);
  q.append('expand[]', 'data.tiers');
  const have = Object.fromEntries((await stripe('GET', `/v1/prices?${q}`)).data.map((p) => [p.lookup_key, p]));
  const products = {};
  const productFor = async (kind) => {
    if (products[kind]) return products[kind];
    const name = kind === 'platform' ? 'Control Tower Enterprise' : 'Control Tower Enterprise seats';
    const found = (await stripe('GET', `/v1/products/search?query=${encodeURIComponent(`metadata['ct']:'${kind}'`)}`)).data[0];
    // A tax code on each product (needed for Managed Payments and Stripe Tax).
    if (found && found.tax_code !== TAX_CODE) await stripe('POST', `/v1/products/${found.id}`, { tax_code: TAX_CODE });
    products[kind] = found ?? (await stripe('POST', '/v1/products', { name, tax_code: TAX_CODE, metadata: { ct: kind }, description: kind === 'platform' ? 'Per deployment: every Enterprise feature, 5 single sign-on seats and 100M requests a year' : 'Single sign-on seats beyond the five included' }));
    return products[kind];
  };
  const made = [];
  for (const kind of ['platform', 'seat']) await productFor(kind);
  for (const p of PRICES) {
    if (have[p.lookup_key]) continue;
    const product = await productFor(p.product);
    const body = { product: product.id, currency: 'usd', lookup_key: p.lookup_key, recurring: { interval: p.interval }, nickname: p.lookup_key };
    if (p.tiers) Object.assign(body, { billing_scheme: 'tiered', tiers_mode: 'graduated', tiers: Object.fromEntries(p.tiers.map(([up, amt], i) => [i, { up_to: up, unit_amount: amt }])) });
    else body.unit_amount = p.unit_amount;
    have[p.lookup_key] = await stripe('POST', '/v1/prices', body);
    made.push(p.lookup_key);
  }
  // The portal: card, invoices, billing details, and cancelling at the end of the period (seat changes are ours).
  const configs = (await stripe('GET', '/v1/billing_portal/configurations?limit=100')).data;
  let portal = configs.find((c) => c.metadata?.ct === 'license-service' && c.active);
  if (!portal)
    portal = await stripe('POST', '/v1/billing_portal/configurations', {
      metadata: { ct: 'license-service' },
      business_profile: { headline: 'Control Tower Enterprise: your subscription' },
      default_return_url: 'https://license.agentcontroltower.app/',
      features: {
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true },
        customer_update: { enabled: true, allowed_updates: { 0: 'email', 1: 'address', 2: 'tax_id', 3: 'name' } },
        subscription_cancel: { enabled: true, mode: 'at_period_end', cancellation_reason: { enabled: true, options: { 0: 'too_expensive', 1: 'missing_features', 2: 'switched_service', 3: 'unused', 4: 'other' } } },
      },
    });
  return { prices: have, made, portal: portal.id };
}

// ---------- results ----------
const checks = [];
const c = (what, pass, detail) => {
  checks.push({ what, pass, detail });
  console.log(`${pass ? '✓' : '✗'} ${what} — ${detail}`);
};
const decode = (key) => JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString());
const keyIn = (html) => /(ctl1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/.exec(html)?.[1];
const day = (s) => new Date(s * 1000).toISOString().slice(0, 10);

// ---------- local services ----------
const emails = [];
const mail = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    emails.push(JSON.parse(b || '{}'));
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"id":"em_sandbox"}');
  });
});
await new Promise((r) => mail.listen(MAIL_PORT, '127.0.0.1', r));
const lastLink = (re) => re.exec(emails.at(-1)?.text ?? '')?.[0];

const signing = crypto.generateKeyPairSync('ed25519');
const procs = [];
function start(name, args, env, url) {
  const p = spawn(process.execPath, args, { cwd: REPO, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
  for (const s of [p.stdout, p.stderr]) s.on('data', (d) => log.push(String(d)));
  procs.push(p);
  return (async () => {
    for (let i = 0; i < 100; i++) {
      if (p.exitCode !== null) throw new Error(`${name} exited: ${log.join('').slice(-400)}`);
      if ((await fetch(url).catch(() => null))?.ok) return log;
      await sleep(200);
    }
    throw new Error(`${name} didn't start`);
  })();
}

// A visible browser: Stripe's invisible bot check doesn't pass in headless mode (and nothing here tries to get past one).
const browser = await chromium.launch({ headless: false });
/** Pay on Stripe Checkout (a sandbox page) with Stripe's test card, as a buyer would. */
async function payOnCheckout(url, { card = '4242424242424242', email, name = 'Acme Corp', expectDecline = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    // Wait for Checkout to finish building the form (anything typed before is thrown away).
    const cardButton = page.locator('[data-testid="card-accordion-item-button"]');
    await cardButton.waitFor({ state: 'attached', timeout: 30_000 });
    await page.waitForTimeout(1500);
    const em = page.locator('#email');
    if (email && (await em.isVisible().catch(() => false))) await em.fill(email);
    // Choose "Card" among the payment methods; its fields appear then.
    await cardButton.evaluate((b) => b.click());
    await page.locator('#cardNumber').waitFor({ timeout: 20_000 });
    await page.locator('#cardNumber').fill(card);
    await page.locator('#cardExpiry').fill('12 / 34');
    await page.locator('#cardCvc').fill('123');
    await page.locator('#billingName').fill(name);
    const country = page.locator('#billingCountry');
    if (await country.count()) await country.selectOption('US');
    await page.locator('#billingAddressLine1').fill('354 Oyster Point Blvd');
    // Close the address suggestions, which otherwise cover the city and ZIP fields.
    await page.waitForTimeout(800);
    await page.keyboard.press('Escape');
    await page.locator('#billingLocality').fill('South San Francisco');
    await page.locator('#billingPostalCode').fill('94080');
    await page.keyboard.press('Escape');
    const state = page.locator('#billingAdministrativeArea');
    if (await state.count()) await state.selectOption('CA');
    // Link's "save my info" would ask for a phone number: not wanted here.
    const link = page.locator('#enableStripePass');
    if ((await link.count()) && (await link.isChecked().catch(() => false))) await link.uncheck();
    await page.locator('[data-testid="hosted-payment-submit-button"]').click();
    if (expectDecline) {
      // The buyer stays on Checkout (Stripe shows its own message); the key page is never reached.
      await page.waitForTimeout(15_000);
      return { declined: !page.url().includes('127.0.0.1:4820'), url: page.url() };
    }
    await page.waitForURL(/127\.0\.0\.1:4820\/success/, { timeout: 60_000 });
    // The service shows the key once the payment is in (it may ask to wait a moment first).
    for (let i = 0; i < 15; i++) {
      const k = keyIn(await page.content());
      if (k) return k;
      await sleep(2000);
      await page.reload();
    }
    throw new Error('no key on the success page');
  } catch (err) {
    await page.screenshot({ path: path.join(SHOTS, `checkout-failure-${Date.now()}.png`), fullPage: true }).catch(() => undefined);
    throw err;
  } finally {
    await page.close();
  }
}

const ct = (method, p, body) => fetch(CT + p, { method, headers: { authorization: `Bearer ${ADMIN}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const refresh = async () => (await ct('POST', '/admin/api/license/refresh')).body;
async function advance(clock, toSeconds) {
  await stripe('POST', `/v1/test_helpers/test_clocks/${clock}/advance`, { frozen_time: toSeconds });
  for (let i = 0; i < 120; i++) {
    const t = await stripe('GET', `/v1/test_helpers/test_clocks/${clock}`);
    if (t.status === 'ready') return t;
    if (t.status === 'internal_failure') throw new Error('test clock failed');
    await sleep(2000);
  }
  throw new Error('test clock never ready');
}
const subOf = (id) => stripe('GET', `/v1/subscriptions/${id}?expand[]=latest_invoice`);
async function subscribeOnClock(clock, { email, name, seats }) {
  const cust = await stripe('POST', '/v1/customers', { email, name, test_clock: clock });
  const pm = await stripe('POST', '/v1/payment_methods/pm_card_visa/attach', { customer: cust.id });
  const items = { 0: { price: prices.ct_enterprise_platform_month.id, quantity: 1 }, ...(seats > 5 ? { 1: { price: prices.ct_enterprise_seat_month.id, quantity: seats - 5 } } : {}) };
  const sub = await stripe('POST', '/v1/subscriptions', { customer: cust.id, items, default_payment_method: pm.id, metadata: { product: 'controltower-enterprise', seats: String(seats) } });
  const end = sub.items.data[0].current_period_end * 1000;
  const payload = { v: 1, kid: 'test', id: `lic_${sub.id}`, customer: name, email, plan: 'enterprise', seats, requests_per_year: 100_000_000, features: ['*'], issued_at: Date.now(), expires_at: end, sub: sub.id, period_start: sub.start_date * 1000 };
  const head = `ctl1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  return { cust, sub, key: `${head}.${crypto.sign(null, Buffer.from(head), signing.privateKey).toString('base64url')}` };
}
let prices;
const clocks = [];

try {
  // ---- 1. The sandbox.
  const setupResult = await setup();
  prices = setupResult.prices;
  const { made, portal } = setupResult;
  const amounts = PRICES.map((p) => `${p.lookup_key}: ${prices[p.lookup_key].unit_amount ?? (prices[p.lookup_key].tiers ?? []).map((t) => t.unit_amount).join('/')}`);
  c('the sandbox has the four prices, by lookup key, and a portal configuration', PRICES.every((p) => prices[p.lookup_key]?.active) && !!portal, `${made.length ? `created ${made.join(', ')}` : 'all already there'}; ${amounts.join(', ')}; portal ${portal}`);

  // ---- 2. The license service and Control Tower, here.
  await start('license service', ['ee/license-service/server.mjs'], { PORT: String(SVC_PORT), PUBLIC_URL: SVC, STRIPE_SECRET_KEY: KEY, STRIPE_API_VERSION: VERSION, STRIPE_PORTAL_CONFIGURATION: portal, LICENSE_SIGNING_KEY: signing.privateKey.export({ type: 'pkcs8', format: 'pem' }), LICENSE_KEY_ID: 'test', RESEND_API_KEY: 're_sandbox', EMAIL_API_BASE: `http://127.0.0.1:${MAIL_PORT}`, NODE_ENV: 'production' }, `${SVC}/healthz`);
  await start('Control Tower', ['server/dist/server.mjs', '--port', String(CT_PORT)], { CT_DATA_DIR: path.join(TMP, 'ct'), CT_ADMIN_KEY: ADMIN, CT_UI_DIR: path.join(REPO, 'ui/dist'), CT_LOG_LEVEL: 'warn', CT_LICENSE_PUBLIC_KEY: signing.publicKey.export({ format: 'jwk' }).x, CT_LICENSE_SERVER: SVC, CT_MODEL_HEALTH_INTERVAL_S: '0' }, `${CT}/healthz`);
  const plans = await (await fetch(SVC)).text();
  c('the plans page shows the sandbox prices, and checkout is open', plans.includes('"unit_amount":600000') && !plans.includes('Checkout opens soon'), plans.includes('Checkout opens soon') ? 'still "opens soon"' : 'live prices');

  // ---- 3. A purchase through the service's own checkout: 12 seats, yearly, with the test card.
  const buy = await fetch(`${SVC}/checkout`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ seats: '12', interval: 'year' }) });
  const checkoutUrl = buy.headers.get('location');
  const k1 = await payOnCheckout(checkoutUrl, { email: 'buyer@acme.example' });
  const l1 = decode(k1);
  c('a yearly purchase through Stripe Checkout issues a key: 12 seats, a year, for the buyer', l1.plan === 'enterprise' && l1.seats === 12 && Math.abs(l1.expires_at - Date.now() - 365 * DAY * 1000) < 3 * DAY * 1000 && l1.customer === 'Acme Corp', `${l1.customer}, ${l1.seats} seats, until ${new Date(l1.expires_at).toISOString().slice(0, 10)}, ${l1.sub}`);
  const s1 = await subOf(l1.sub);
  c('Stripe has the subscription: active, paid, platform plus 7 extra seats', s1.status === 'active' && s1.latest_invoice?.status === 'paid' && s1.items.data.length === 2, `${s1.status}, invoice ${s1.latest_invoice?.status} $${(s1.latest_invoice?.amount_paid ?? 0) / 100}, items ${s1.items.data.map((i) => `${i.price.lookup_key}×${i.quantity}`).join(' + ')}`);
  await ct('PUT', '/admin/api/license', { key: k1 });
  const lic1 = (await ct('GET', '/admin/api/license')).body;
  const audit1 = (await ct('GET', '/admin/api/audit')).status;
  c('pasted into Control Tower, the key turns Enterprise on', lic1.status === 'valid' && lic1.license?.seats === 12 && audit1 === 200, `${lic1.status}, ${lic1.license?.seats} seats; audit log ${audit1}`);
  const portalRes = await fetch(`${SVC}/portal`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: k1 }) });
  c('the key opens Stripe’s customer portal (card, invoices, cancel)', portalRes.status === 303 && /^https:\/\/billing\.stripe\.com\//.test(portalRes.headers.get('location') ?? ''), `${portalRes.status} → ${(portalRes.headers.get('location') ?? '').slice(0, 40)}…`);

  // Seats on the subscription bought through Checkout (sold through Link, with Managed Payments): more now, fewer later.
  await fetch(`${SVC}/seats`, { method: 'POST', body: new URLSearchParams({ key: k1, seats: '14' }) });
  const mpUp = await (await fetch(lastLink(/http:\/\/127\.0\.0\.1:4820\/seats\/confirm\?t=\S+/))).text();
  const mpKey = keyIn(mpUp);
  const s1b = await subOf(l1.sub);
  c('Managed Payments: more seats on a Checkout subscription are charged and the key follows', !!mpKey && decode(mpKey).seats === 14 && s1b.latest_invoice?.status === 'paid', mpKey ? `14-seat key; proration invoice ${s1b.latest_invoice?.status} $${(s1b.latest_invoice?.amount_paid ?? 0) / 100}` : `no key: ${/<h1>([^<]+)/.exec(mpUp)?.[1] ?? mpUp.slice(0, 120)}`);
  await fetch(`${SVC}/seats`, { method: 'POST', body: new URLSearchParams({ key: k1, seats: '10' }) });
  const mpDown = await (await fetch(lastLink(/http:\/\/127\.0\.0\.1:4820\/seats\/confirm\?t=\S+/))).text();
  const s1c = await subOf(l1.sub);
  c('Managed Payments: fewer seats on a Checkout subscription are scheduled for the renewal', /10 seats from/.test(mpDown) && typeof s1c.schedule === 'string', `page "${/(\d+ seats from [^<]+)|<h1>([^<]+)/.exec(mpDown)?.slice(1).find(Boolean) ?? '?'}", schedule ${s1c.schedule ?? 'none'}`);

  // A card that's declined at checkout: no subscription, no key.
  const declineBuy = await fetch(`${SVC}/checkout`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ seats: '5', interval: 'month' }) });
  const declined = await payOnCheckout(declineBuy.headers.get('location'), { card: '4000000000000002', email: 'declined@acme.example', name: 'Declined Co', expectDecline: true }).catch((e) => ({ error: e.message }));
  const declinedCustomers = (await stripe('GET', `/v1/customers?email=${encodeURIComponent('declined@acme.example')}&expand[]=data.subscriptions`)).data;
  const declinedSubs = declinedCustomers.flatMap((cu) => cu.subscriptions?.data ?? []).filter((sb) => ['active', 'trialing'].includes(sb.status));
  c('a card declined at checkout: the buyer stays on Checkout, no subscription, no key', declined.declined === true && declinedSubs.length === 0, declined.declined ? `still on Checkout after paying; active subscriptions for that email: ${declinedSubs.length}` : String(declined.error ?? declined.url).slice(0, 120));

  // Seats can't go below the people using them (Control Tower reports them with each renewal check).
  await ct('PUT', '/admin/api/license', { key: k1 });
  await refresh(); // Control Tower reports its seats in use (none here) with the check
  const reported = (await subOf(l1.sub)).metadata?.seats_used;
  await stripe('POST', `/v1/subscriptions/${l1.sub}`, { metadata: { seats_used: '13' } }); // as a server with 13 people would
  const floor = await fetch(`${SVC}/seats`, { method: 'POST', body: new URLSearchParams({ key: k1, seats: '9' }) });
  const floorText = await floor.text();
  c('seats can\'t be reduced below the people using them', reported === '0' && floor.status === 409 && /13 people use seats now/.test(floorText), `Control Tower reported ${reported} in use; asking for 9 with 13 in use: ${floor.status}`);

  // Cancelled at once (as with a refund): the license is cut short in Control Tower, not left running for the year.
  const sched1 = (await subOf(l1.sub)).schedule;
  if (sched1) await stripe('POST', `/v1/subscription_schedules/${sched1}/release`, {});
  await stripe('DELETE', `/v1/subscriptions/${l1.sub}`);
  const rCut = await refresh();
  const licCut = (await ct('GET', '/admin/api/license')).body;
  c('cancelled at once (a refund): the license ends now, not at the end of the paid year', rCut.result === 'ended' && Math.abs((licCut.license?.expires_at ?? 0) - Date.now()) < 10 * 60_000 && licCut.status === 'grace', `refresh ${rCut.result}; the license now ends ${licCut.license ? new Date(licCut.license.expires_at).toISOString() : '?'} (was ${new Date(l1.expires_at).toISOString().slice(0, 10)}); status ${licCut.status} (14 days' grace, then off)`);

  // ---- 4. Monthly, on a test clock: renewal, seats up and down, cancellation.
  const now = Math.floor(Date.now() / 1000);
  const clockA = (await stripe('POST', '/v1/test_helpers/test_clocks', { frozen_time: now, name: 'ct renewal, seats, cancel' })).id;
  clocks.push(clockA);
  const { key: kA } = await subscribeOnClock(clockA, { email: 'billing@globex.example', name: 'Globex', seats: 8 });
  const lA = decode(kA);
  await ct('PUT', '/admin/api/license', { key: kA });
  c('a monthly subscription on a test clock (made through the API): 8 seats, a month', lA.seats === 8 && Math.abs(lA.expires_at / 1000 - now - 31 * DAY) < 4 * DAY, `${lA.seats} seats, until ${day(lA.expires_at / 1000)}`);

  // Renewal: a month on, the card is charged and the server picks up the renewed key.
  let sA = await subOf(lA.sub);
  const endA = sA.items.data[0].current_period_end;
  // A minute past the end date: Stripe has moved the period on and says "active", but the renewal invoice is still a
  // draft (Stripe charges it about an hour later). Nothing is paid, so nothing is extended.
  await advance(clockA, endA + 60);
  const sA0 = await subOf(lA.sub);
  const rA0 = await refresh();
  c('in the hour between the end date and the charge, the renewal isn\'t issued yet', sA0.status === 'active' && sA0.items.data[0].current_period_end > endA && sA0.latest_invoice?.status === 'draft' && rA0.result === 'unchanged' && rA0.license?.expires_at === lA.expires_at, `Stripe ${sA0.status}, period to ${day(sA0.items.data[0].current_period_end)}, invoice ${sA0.latest_invoice?.status}; refresh ${rA0.result}, the license still ends ${rA0.license ? day(rA0.license.expires_at / 1000) : '?'}`);
  await advance(clockA, endA + 7200);
  sA = await subOf(lA.sub);
  const rA = await refresh();
  c('a month on, the renewal is charged and Control Tower picks up the renewed key', sA.status === 'active' && sA.latest_invoice?.status === 'paid' && rA.result === 'renewed' && rA.license?.expires_at > lA.expires_at, `Stripe ${sA.status}, invoice ${sA.latest_invoice?.status}; refresh ${rA.result}, until ${rA.license ? day(rA.license.expires_at / 1000) : '?'}`);

  // More seats: asked with the key, confirmed from the billing email, charged now, the new key at once.
  // (Any key of the subscription asks: the license id and subscription are the same across renewals.)
  let latestKey = kA;
  const seatsUp = await fetch(`${SVC}/seats`, { method: 'POST', body: new URLSearchParams({ key: latestKey, seats: '15' }) });
  const upLink = lastLink(/http:\/\/127\.0\.0\.1:4820\/seats\/confirm\?t=\S+/);
  const before = (await subOf(lA.sub)).latest_invoice?.id;
  const upPage = await (await fetch(upLink)).text();
  const kUp = keyIn(upPage);
  const sUp = await subOf(lA.sub);
  c('more seats: confirmed from the billing email, charged now (prorated), the new key at once', seatsUp.status === 200 && emails.at(-1)?.to?.[0] === 'billing@globex.example' && kUp && decode(kUp).seats === 15 && sUp.latest_invoice?.id !== before && sUp.latest_invoice?.status === 'paid', `email to ${emails.at(-1)?.to?.[0]}; key ${kUp ? decode(kUp).seats : '-'} seats; proration invoice ${sUp.latest_invoice?.status} $${(sUp.latest_invoice?.amount_paid ?? 0) / 100}`);
  if (kUp) latestKey = kUp;
  const rUp = await refresh();
  c('Control Tower picks up the new seats', (rUp.license?.seats ?? (await ct('GET', '/admin/api/license')).body.license?.seats) === 15, `refresh ${rUp.result}, ${rUp.license?.seats} seats`);

  // Fewer seats: from the next renewal.
  await fetch(`${SVC}/seats`, { method: 'POST', body: new URLSearchParams({ key: latestKey, seats: '9' }) });
  const downPage = await (await fetch(lastLink(/http:\/\/127\.0\.0\.1:4820\/seats\/confirm\?t=\S+/))).text();
  sA = await subOf(lA.sub);
  const stillNow = sA.items.data.find((i) => i.price.lookup_key.startsWith('ct_enterprise_seat'))?.quantity;
  await advance(clockA, sA.items.data[0].current_period_end + 7200);
  sA = await subOf(lA.sub);
  const after = sA.items.data.find((i) => i.price.lookup_key.startsWith('ct_enterprise_seat'))?.quantity;
  const rDown = await refresh();
  c('fewer seats: unchanged until the renewal, then 9 (and Control Tower follows)', /9 seats from/.test(downPage) && stillNow === 10 && after === 4 && rDown.license?.seats === 9, `page "${/(\d+ seats from [^<]+)/.exec(downPage)?.[1] ?? '?'}"; seat item ${stillNow} → ${after}; Control Tower ${rDown.license?.seats} seats`);

  // Cancel at the end of the period, then change your mind: the renewal goes on.
  await stripe('POST', `/v1/subscriptions/${lA.sub}`, { cancel_at_period_end: true });
  await stripe('POST', `/v1/subscriptions/${lA.sub}`, { cancel_at_period_end: false });
  sA = await subOf(lA.sub);
  await advance(clockA, sA.items.data[0].current_period_end + 7200);
  sA = await subOf(lA.sub);
  const rResume = await refresh();
  c('cancelled, then resumed before the end: the next renewal is charged and the license extended', sA.status === 'active' && sA.latest_invoice?.status === 'paid' && rResume.result === 'renewed', `Stripe ${sA.status}, invoice ${sA.latest_invoice?.status}; refresh ${rResume.result}, until ${rResume.license ? day(rResume.license.expires_at / 1000) : '?'}`);
  const resumedEnd = rResume.license?.expires_at;

  // Cancellation at the end of the period (as the portal does it): working until then, ended after.
  await stripe('POST', `/v1/subscriptions/${lA.sub}`, { cancel_at_period_end: true });
  const rCancel = await refresh();
  sA = await subOf(lA.sub);
  await advance(clockA, sA.items.data[0].current_period_end + 7200);
  const rEnded = await refresh();
  const licEnded = (await ct('GET', '/admin/api/license')).body;
  c('cancelled: the key keeps its end date, and after it the subscription is ended (no renewal)', rCancel.result === 'unchanged' && rEnded.result === 'ended' && licEnded.license?.expires_at === resumedEnd, `before the end: ${rCancel.result}; after: ${rEnded.result}; the license still ends ${licEnded.license ? day(licEnded.license.expires_at / 1000) : '?'}`);

  // ---- 5. A renewal whose payment fails.
  const clockB = (await stripe('POST', '/v1/test_helpers/test_clocks', { frozen_time: now, name: 'ct failed renewal' })).id;
  clocks.push(clockB);
  const { key: kB, cust: custB } = await subscribeOnClock(clockB, { email: 'billing@initech.example', name: 'Initech', seats: 5 });
  const lB = decode(kB);
  await ct('PUT', '/admin/api/license', { key: kB });
  // The card on file now declines (Stripe's test card for that).
  const pm = await stripe('POST', '/v1/payment_methods/pm_card_chargeCustomerFail/attach', { customer: custB.id }).catch(async () => stripe('POST', '/v1/payment_methods', { type: 'card', card: { token: 'tok_chargeCustomerFail' } }));
  if (!pm.customer) await stripe('POST', `/v1/payment_methods/${pm.id}/attach`, { customer: custB.id });
  await stripe('POST', `/v1/subscriptions/${lB.sub}`, { default_payment_method: pm.id });
  let sB = await subOf(lB.sub);
  const endB = sB.items.data[0].current_period_end;
  // The draft hour with a card that will fail: nothing for it either.
  await advance(clockB, endB + 60);
  const rB0 = await refresh();
  c('a card that will fail gets nothing in the hour before the charge either', rB0.result === 'unchanged' && rB0.license?.expires_at === lB.expires_at, `refresh ${rB0.result}; the license still ends ${rB0.license ? day(rB0.license.expires_at / 1000) : '?'}`);
  await advance(clockB, endB + 7200);
  sB = await subOf(lB.sub);
  const rB = await refresh();
  const licB = (await ct('GET', '/admin/api/license')).body;
  c('the renewal payment fails: the license is not extended', sB.status === 'past_due' && rB.result === 'unchanged' && licB.license?.expires_at === lB.expires_at, `Stripe ${sB.status}, invoice ${sB.latest_invoice?.status}; refresh ${rB.result}; the license still ends ${day(lB.expires_at / 1000)}`);
  // The customer fixes their card and pays: the license is extended.
  const good = await stripe('POST', '/v1/payment_methods/pm_card_visa/attach', { customer: custB.id });
  await stripe('POST', `/v1/subscriptions/${lB.sub}`, { default_payment_method: good.id });
  await stripe('POST', `/v1/invoices/${sB.latest_invoice.id}/pay`, { payment_method: good.id });
  sB = await subOf(lB.sub);
  const rRecover = await refresh();
  c('the failed renewal is then paid with a new card: the license is extended', sB.status === 'active' && rRecover.result === 'renewed' && rRecover.license?.expires_at > lB.expires_at, `Stripe ${sB.status}; refresh ${rRecover.result}, until ${rRecover.license ? day(rRecover.license.expires_at / 1000) : '?'}`);
  // The next renewal fails, and this time it isn't fixed.
  await stripe('POST', `/v1/subscriptions/${lB.sub}`, { default_payment_method: pm.id });
  const recoveredEnd = rRecover.license?.expires_at;
  await advance(clockB, sB.items.data[0].current_period_end + 7200);
  sB = await subOf(lB.sub);
  const rB3 = await refresh();
  c('the next renewal fails too: not extended again', sB.status === 'past_due' && rB3.result === 'unchanged' && (await ct('GET', '/admin/api/license')).body.license?.expires_at === recoveredEnd, `Stripe ${sB.status}; refresh ${rB3.result}`);
  // Stripe retries; when it gives up the subscription ends, and so does the license.
  for (let d = 7; d <= 35; d += 7) {
    await advance(clockB, sB.items.data[0].current_period_start + d * DAY);
    if (!['past_due', 'active'].includes((await subOf(lB.sub)).status)) break;
  }
  sB = await subOf(lB.sub);
  const rB2 = await refresh();
  c('when Stripe gives up, the subscription is over and so is the license (never renewed)', !['active', 'trialing', 'past_due'].includes(sB.status) && rB2.result === 'ended', `Stripe ${sB.status}; refresh ${rB2.result}`);

  // ---- 5b. Renewal with a card that needs the customer to authenticate (3-D Secure), which they can't while away.
  const clockC = (await stripe('POST', '/v1/test_helpers/test_clocks', { frozen_time: now, name: 'ct 3ds renewal' })).id;
  clocks.push(clockC);
  const { key: kC, cust: custC } = await subscribeOnClock(clockC, { email: 'billing@umbrella.example', name: 'Umbrella', seats: 5 });
  const lC = decode(kC);
  await ct('PUT', '/admin/api/license', { key: kC });
  const auth = await stripe('POST', '/v1/payment_methods/pm_card_authenticationRequired/attach', { customer: custC.id });
  await stripe('POST', `/v1/subscriptions/${lC.sub}`, { default_payment_method: auth.id });
  let sC = await subOf(lC.sub);
  await advance(clockC, sC.items.data[0].current_period_end + 7200);
  sC = await subOf(lC.sub);
  const rC = await refresh();
  c('a renewal that needs the customer to authenticate (3-D Secure) isn\'t paid, and the license isn\'t extended', ['past_due', 'incomplete'].includes(sC.status) && rC.result !== 'renewed' && (await ct('GET', '/admin/api/license')).body.license?.expires_at === lC.expires_at, `Stripe ${sC.status}, invoice ${sC.latest_invoice?.status}; refresh ${rC.result}`);

  // ---- 6. A trial, by email (the service's own flow).
  await fetch(`${SVC}/trial`, { method: 'POST', body: new URLSearchParams({ company: 'Hooli', email: 'dev@hooli.example' }) });
  const trialKey = keyIn(await (await fetch(lastLink(/http:\/\/127\.0\.0\.1:4820\/trial\/confirm\?t=\S+/))).text());
  c('a trial key arrives by email: 30 days, 5 seats', !!trialKey && decode(trialKey).plan === 'trial' && decode(trialKey).seats === 5, trialKey ? `${decode(trialKey).customer}, until ${day(decode(trialKey).expires_at / 1000)}` : 'no key');
} catch (err) {
  c('the run finished', false, String(err.message ?? err).slice(0, 300));
} finally {
  for (const id of clocks) await stripe('DELETE', `/v1/test_helpers/test_clocks/${id}`).catch(() => undefined);
  await browser.close();
  for (const p of procs) p.kill();
  mail.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.writeFileSync(path.join(REPO, 'data/license/sandbox-results.json'), JSON.stringify({ ran_at: new Date().toISOString(), api_version: VERSION, checks }, null, 2));
}
console.log(`\n${checks.filter((x) => x.pass).length} of ${checks.length} passed`);
process.exit(checks.every((x) => x.pass) ? 0 : 1);
