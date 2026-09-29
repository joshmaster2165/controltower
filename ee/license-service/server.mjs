// Control Tower Enterprise license service. Licensed under the Elastic License 2.0 (see ../LICENSE).
//
// Sells Enterprise through Stripe and issues license keys. Stateless: Stripe is the record of who paid; a key
// names its subscription, so renewals and seat changes are read back from Stripe when a server refreshes.
//
//   GET  /                plans, with a seat slider and live prices from Stripe
//   POST /checkout        → Stripe Checkout (subscription: platform price + per-seat price)
//   GET  /success         the key, once Checkout completes
//   POST /trial           a 30-day trial key (5 seats), no card
//   POST /refresh         {key} → a renewed key for an active subscription (Control Tower calls this daily)
//   POST /portal          {key} → Stripe's customer portal (seats, card, cancel)
//
// Environment: LICENSE_SIGNING_KEY (Ed25519 private key, PEM), STRIPE_SECRET_KEY, PUBLIC_URL, PORT.
import crypto from 'node:crypto';
import http from 'node:http';

const PORT = Number(process.env.PORT ?? 8080);
const PUBLIC_URL = (process.env.PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/+$/, '');
const STRIPE = process.env.STRIPE_API_BASE ?? 'https://api.stripe.com';
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY ?? '';
const SIGNING = process.env.LICENSE_SIGNING_KEY ? crypto.createPrivateKey(process.env.LICENSE_SIGNING_KEY.replace(/\\n/g, '\n')) : undefined;
const KID = process.env.LICENSE_KEY_ID ?? 'k1';
const PUBLIC = SIGNING ? crypto.createPublicKey(SIGNING) : undefined;

/** Stripe prices, found by lookup key (so no ids are configured here). */
const LOOKUP = { platform_year: 'ct_enterprise_platform_year', seat_year: 'ct_enterprise_seat_year', platform_month: 'ct_enterprise_platform_month', seat_month: 'ct_enterprise_seat_month' };
export const INCLUDED_SEATS = 5;
export const MAX_SELF_SERVE_SEATS = 100;
const REQUESTS_PER_YEAR = 100_000_000;
const DAY = 86_400_000;

// ---------- licenses ----------
const b64u = (b) => Buffer.from(b).toString('base64url');
export function sign(payload, key = SIGNING) {
  const head = `ctl1.${b64u(JSON.stringify(payload))}`;
  return `${head}.${b64u(crypto.sign(null, Buffer.from(head), key))}`;
}
export function verify(token, pub = PUBLIC) {
  const [v, body, sig] = String(token ?? '').trim().split('.');
  if (v !== 'ctl1' || !body || !sig) return undefined;
  if (!crypto.verify(null, Buffer.from(`${v}.${body}`), pub, Buffer.from(sig, 'base64url'))) return undefined;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}
function licenseFor(sub, customer) {
  const seatItem = sub.items.data.find((i) => i.price.lookup_key?.startsWith('ct_enterprise_seat'));
  const end = (sub.items.data[0]?.current_period_end ?? sub.current_period_end) * 1000;
  return {
    v: 1,
    kid: KID,
    id: `lic_${sub.id}`,
    customer: customer.name || customer.email || 'Customer',
    email: customer.email ?? '',
    plan: 'enterprise',
    seats: INCLUDED_SEATS + (seatItem?.quantity ?? 0),
    requests_per_year: REQUESTS_PER_YEAR,
    features: ['*'],
    issued_at: Date.now(),
    expires_at: end,
    sub: sub.id,
  };
}

// ---------- Stripe ----------
function form(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (typeof v === 'object') form(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}
async function stripe(method, path, body) {
  const r = await fetch(`${STRIPE}${path}`, {
    method,
    headers: { authorization: `Bearer ${STRIPE_KEY}`, ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    ...(body ? { body: form(body).toString() } : {}),
  });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.error?.message ?? `Stripe ${r.status}`), { status: r.status });
  return j;
}
let priceCache;
async function prices() {
  if (priceCache && priceCache.at > Date.now() - 10 * 60_000) return priceCache.prices;
  const q = new URLSearchParams();
  for (const k of Object.values(LOOKUP)) q.append('lookup_keys[]', k);
  q.append('expand[]', 'data.tiers');
  q.append('active', 'true');
  const list = await stripe('GET', `/v1/prices?${q}`);
  const by = Object.fromEntries(list.data.map((p) => [p.lookup_key, p]));
  priceCache = { at: Date.now(), prices: by };
  return by;
}
/** What a subscription costs for `seats` seats, in cents, from the prices' own tiers. */
export function total(platform, seat, seats) {
  let cents = platform?.unit_amount ?? 0;
  let extra = Math.max(0, seats - INCLUDED_SEATS);
  let from = 0;
  for (const t of seat?.tiers ?? []) {
    const upTo = t.up_to ?? Infinity;
    const n = Math.max(0, Math.min(extra, upTo - from));
    cents += n * (t.unit_amount ?? 0) + (n > 0 ? (t.flat_amount ?? 0) : 0);
    extra -= n;
    from = upTo;
    if (extra <= 0) break;
  }
  return cents;
}

// ---------- pages ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
:root{--bg:#f6f8fb;--card:#fff;--ink:#0f1a2b;--dim:#5b6b80;--line:#dfe6ef;--accent:#1f5eff;--ok:#1b8a4b}
@media (prefers-color-scheme:dark){:root{--bg:#0c1320;--card:#131c2c;--ink:#e6edf7;--dim:#94a3b8;--line:#243044;--accent:#6b93ff;--ok:#4cc38a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;padding:32px 16px}
main{max-width:760px;margin:0 auto;display:grid;gap:18px}h1{font-size:28px;margin:0}h2{font-size:18px;margin:0}p{margin:0;color:var(--dim)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;display:grid;gap:12px}
.price{font-size:34px;font-weight:650;font-variant-numeric:tabular-nums}.price small{font-size:14px;color:var(--dim);font-weight:400}
input[type=range]{width:100%}input[type=text],input[type=email],textarea{width:100%;padding:9px 11px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);font:inherit}
button,.btn{display:inline-block;padding:10px 16px;border-radius:8px;border:0;background:var(--accent);color:#fff;font:600 14px system-ui;cursor:pointer;text-decoration:none}
.ghost{background:transparent;color:var(--accent);border:1px solid var(--line)}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
ul{margin:0;padding-left:20px;color:var(--dim)}code,textarea.key{font:13px ui-monospace,Menlo,monospace}.seg button{background:transparent;color:var(--ink);border:1px solid var(--line)}.seg button.on{background:var(--accent);color:#fff}
.err{color:#c0392b}
</style></head><body><main>${body}</main></body></html>`;
}
const money = (cents) => `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

async function plansPage() {
  let p;
  try {
    p = await prices();
  } catch {
    p = {};
  }
  const data = JSON.stringify({ year: { platform: p[LOOKUP.platform_year] ?? null, seat: p[LOOKUP.seat_year] ?? null }, month: { platform: p[LOOKUP.platform_month] ?? null, seat: p[LOOKUP.seat_month] ?? null } });
  const ready = !!p[LOOKUP.platform_year];
  return page(
    'Control Tower Enterprise',
    `<h1>Control Tower Enterprise</h1>
<p>Single sign-on, SCIM, the audit log, secret managers, organisations and more on top of the open-source gateway, checked by a license key on your own server (air-gap friendly). The key appears as soon as you've paid.</p>
<section class="card">
  <div class="row seg"><button type="button" id="y" class="on">Yearly</button><button type="button" id="m">Monthly</button></div>
  <label for="seats"><b id="seatsLabel">5 people</b> signing in with single sign-on</label>
  <input id="seats" type="range" min="${INCLUDED_SEATS}" max="${MAX_SELF_SERVE_SEATS}" value="${INCLUDED_SEATS}">
  <div class="price" id="price">${ready ? '' : 'Prices are being set up'}</div>
  <ul><li>${INCLUDED_SEATS} seats and ${(REQUESTS_PER_YEAR / 1e6).toLocaleString()} million requests a year included</li><li>Volume pricing: each block of seats costs less per seat</li><li>Every Enterprise feature, and support</li></ul>
  <form method="post" action="/checkout" class="row"><input type="hidden" name="seats" id="seatsField" value="${INCLUDED_SEATS}"><input type="hidden" name="interval" id="intervalField" value="year"><button ${ready ? '' : 'disabled'}>Buy</button><span style="color:var(--dim)">More than ${MAX_SELF_SERVE_SEATS} seats or a billion requests a year? Contact sales for volume pricing.</span></form>
</section>
<section class="card" id="trial">
  <h2>Free 30-day trial</h2><p>${INCLUDED_SEATS} seats, every feature, no card.</p>
  <form method="post" action="/trial" class="row" style="display:grid;gap:8px"><input type="text" name="company" placeholder="Company" required maxlength="100"><input type="email" name="email" placeholder="Work email" required maxlength="200"><div><button>Get a trial key</button></div></form>
</section>
<script>
const P=${data};let interval='year';
const s=document.getElementById('seats'),out=document.getElementById('price'),lab=document.getElementById('seatsLabel');
function total(pl,se,n){let c=pl?pl.unit_amount:0,x=Math.max(0,n-${INCLUDED_SEATS}),f=0;for(const t of (se&&se.tiers)||[]){const u=t.up_to==null?Infinity:t.up_to,k=Math.max(0,Math.min(x,u-f));c+=k*(t.unit_amount||0);x-=k;f=u;if(x<=0)break}return c}
function draw(){const n=+s.value,p=P[interval];lab.textContent=n+(n===1?' person':' people');document.getElementById('seatsField').value=n;document.getElementById('intervalField').value=interval;if(!p.platform){return}out.innerHTML='$'+Math.round(total(p.platform,p.seat,n)/100).toLocaleString('en-US')+' <small>per '+interval+'</small>'}
s.oninput=draw;document.getElementById('y').onclick=()=>{interval='year';y.className='on';m.className='';draw()};document.getElementById('m').onclick=()=>{interval='month';m.className='on';y.className='';draw()};draw();
</script>`,
  );
}

function keyPage(title, key, note) {
  return page(
    title,
    `<h1>${esc(title)}</h1><p>${esc(note)}</p>
<section class="card"><label for="k"><b>Your license key</b></label><textarea id="k" class="key" rows="5" readonly>${esc(key)}</textarea>
<div class="row"><button type="button" onclick="navigator.clipboard.writeText(document.getElementById('k').value).then(()=>this.textContent='Copied')">Copy</button></div>
<p>In Control Tower: <b>License</b> → paste it → Save. Or set <code>CT_LICENSE_KEY</code> on the server. Keep it like a password.</p></section>`,
  );
}

// ---------- server ----------
const hits = new Map();
function limited(ip, what, max, windowMs) {
  const k = `${what}:${ip}`;
  const now = Date.now();
  const list = (hits.get(k) ?? []).filter((t) => t > now - windowMs);
  list.push(now);
  hits.set(k, list);
  return list.length > max;
}
async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw Object.assign(new Error('too large'), { status: 413 });
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if ((req.headers['content-type'] ?? '').includes('application/json')) return JSON.parse(text || '{}');
  return Object.fromEntries(new URLSearchParams(text));
}
const send = (res, status, type, text, extra = {}) => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self' https://checkout.stripe.com https://billing.stripe.com; frame-ancestors 'none'", ...extra });
  res.end(text);
};
const json = (res, status, obj) => send(res, status, 'application/json', JSON.stringify(obj));
const html = (res, status, text) => send(res, status, 'text/html; charset=utf-8', text);
const redirect = (res, url) => send(res, 303, 'text/plain', '', { location: url });

export function createServer() {
  return http.createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', PUBLIC_URL);
    const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
    try {
      if (req.method === 'GET' && u.pathname === '/healthz') return json(res, 200, { ok: true, signing: !!SIGNING, stripe: !!STRIPE_KEY });
      if (req.method === 'GET' && u.pathname === '/') return html(res, 200, await plansPage());

      if (req.method === 'POST' && u.pathname === '/checkout') {
        if (limited(ip, 'checkout', 20, 3600_000)) return html(res, 429, page('Slow down', '<h1>Too many attempts</h1><p>Try again in a while.</p>'));
        const b = await body(req);
        const seats = Math.min(MAX_SELF_SERVE_SEATS, Math.max(INCLUDED_SEATS, Math.round(Number(b.seats) || INCLUDED_SEATS)));
        const month = b.interval === 'month';
        const p = await prices();
        const platform = p[month ? LOOKUP.platform_month : LOOKUP.platform_year];
        const seat = p[month ? LOOKUP.seat_month : LOOKUP.seat_year];
        if (!platform || !seat) return html(res, 503, page('Not ready', '<h1>Checkout is being set up</h1><p>Try again soon, or contact sales.</p>'));
        const items = [{ price: platform.id, quantity: 1 }, ...(seats > INCLUDED_SEATS ? [{ price: seat.id, quantity: seats - INCLUDED_SEATS }] : [])];
        const session = await stripe('POST', '/v1/checkout/sessions', {
          mode: 'subscription',
          line_items: Object.fromEntries(items.map((it, i) => [i, it])),
          success_url: `${PUBLIC_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${PUBLIC_URL}/`,
          allow_promotion_codes: 'true',
          billing_address_collection: 'required',
          subscription_data: { metadata: { product: 'controltower-enterprise', seats: String(seats) } },
        });
        return redirect(res, session.url);
      }

      if (req.method === 'GET' && u.pathname === '/success') {
        const id = u.searchParams.get('session_id') ?? '';
        if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return html(res, 400, page('Not found', '<h1>That checkout was not found</h1>'));
        const s = await stripe('GET', `/v1/checkout/sessions/${id}?expand[]=subscription&expand[]=customer`);
        if (s.status !== 'complete' || !s.subscription) return html(res, 402, page('Payment pending', '<h1>Payment not complete yet</h1><p>Refresh this page in a moment.</p>'));
        const customer = { name: s.customer_details?.name ?? s.customer?.name, email: s.customer_details?.email ?? s.customer?.email };
        return html(res, 200, keyPage('Thank you', sign(licenseFor(s.subscription, customer)), `Your Control Tower Enterprise license, for ${customer.name ?? customer.email}. It renews with your subscription; servers that can reach this service pick up the renewed key themselves.`));
      }

      if (req.method === 'POST' && u.pathname === '/trial') {
        if (limited(ip, 'trial', 3, 24 * 3600_000)) return html(res, 429, page('Slow down', '<h1>Trial limit reached</h1><p>Contact sales for a longer trial.</p>'));
        const b = await body(req);
        const company = String(b.company ?? '').trim().slice(0, 100);
        const email = String(b.email ?? '').trim().toLowerCase().slice(0, 200);
        if (!company || !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) return html(res, 400, page('Check the form', '<h1>Enter your company and a work email</h1>'));
        const now = Date.now();
        const key = sign({ v: 1, kid: KID, id: `lic_trial_${crypto.randomBytes(6).toString('hex')}`, customer: company, email, plan: 'trial', seats: INCLUDED_SEATS, requests_per_year: REQUESTS_PER_YEAR, features: ['*'], issued_at: now, expires_at: now + 30 * DAY });
        console.log(JSON.stringify({ event: 'trial', company, email, at: new Date(now).toISOString() }));
        return html(res, 200, keyPage('Your trial key', key, `30 days of Control Tower Enterprise for ${company}, with ${INCLUDED_SEATS} seats.`));
      }

      if (req.method === 'POST' && u.pathname === '/refresh') {
        if (limited(ip, 'refresh', 60, 3600_000)) return json(res, 429, { error: 'rate_limited' });
        const b = await body(req);
        const lic = verify(b.key);
        if (!lic) return json(res, 400, { error: 'invalid_license' });
        if (!lic.sub) return json(res, 200, { status: 'unchanged' }); // trials and hand-issued keys don't renew here
        const sub = await stripe('GET', `/v1/subscriptions/${encodeURIComponent(lic.sub)}?expand[]=customer`);
        if (!['active', 'trialing', 'past_due'].includes(sub.status)) return json(res, 200, { status: 'ended', subscription: sub.status });
        const next = licenseFor(sub, { name: sub.customer?.name ?? lic.customer, email: sub.customer?.email ?? lic.email });
        if (next.expires_at === lic.expires_at && next.seats === lic.seats) return json(res, 200, { status: 'unchanged' });
        return json(res, 200, { status: 'renewed', key: sign(next) });
      }

      if (req.method === 'POST' && u.pathname === '/portal') {
        const b = await body(req);
        const lic = verify(b.key);
        if (!lic?.sub) return html(res, 400, page('Not found', '<h1>That license has no subscription to manage</h1>'));
        const sub = await stripe('GET', `/v1/subscriptions/${encodeURIComponent(lic.sub)}`);
        const portal = await stripe('POST', '/v1/billing_portal/sessions', { customer: sub.customer, return_url: `${PUBLIC_URL}/` });
        return redirect(res, portal.url);
      }
      return json(res, 404, { error: 'not_found' });
    } catch (err) {
      console.error(JSON.stringify({ error: err.message, path: u.pathname }));
      return json(res, err.status === 413 ? 413 : 502, { error: 'unavailable', message: 'Something went wrong. Try again, or contact sales.' });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!SIGNING) console.warn('LICENSE_SIGNING_KEY is not set: keys cannot be issued.');
  if (!STRIPE_KEY) console.warn('STRIPE_SECRET_KEY is not set: checkout and renewals are off.');
  createServer().listen(PORT, () => console.log(`license service on :${PORT} (${PUBLIC_URL})`));
}
