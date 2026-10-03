// Control Tower Enterprise license service. Licensed under the Elastic License 2.0 (see ../LICENSE).
//
// Sells Enterprise through Stripe and issues license keys. Stateless: Stripe is the record of who paid; a key
// names its subscription, so renewals and seat changes are read back from Stripe when a server refreshes.
//
//   GET  /                plans, with a seat slider and live prices from Stripe
//   POST /checkout        → Stripe Checkout (subscription: platform price + per-seat price)
//   GET  /success         the key, once Checkout completes
//   POST /trial           a 30-day trial (5 seats), no card: a link to the key, by email (Resend)
//   GET  /trial/confirm   the link from that email: the trial key
//   POST /refresh         {key} → a renewed key for an active subscription (Control Tower calls this daily)
//   GET  /seats           change seats: the license key asks, the billing email confirms (GET /seats/confirm)
//   POST /portal          {key} → Stripe's customer portal (card, invoices, cancel)
//
// Environment: LICENSE_SIGNING_KEY (Ed25519 private key, PEM), STRIPE_SECRET_KEY, STRIPE_API_VERSION, STRIPE_PORTAL_CONFIGURATION,
// RESEND_API_KEY, EMAIL_FROM, PUBLIC_URL, PORT.
import crypto from 'node:crypto';
import http from 'node:http';

const PORT = Number(process.env.PORT ?? 8080);
const PUBLIC_URL = (process.env.PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/+$/, '');
const STRIPE = process.env.STRIPE_API_BASE ?? 'https://api.stripe.com';
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY ?? '';
const SIGNING = process.env.LICENSE_SIGNING_KEY ? crypto.createPrivateKey(process.env.LICENSE_SIGNING_KEY.replace(/\\n/g, '\n')) : undefined;
const KID = process.env.LICENSE_KEY_ID ?? 'k1';
/** Trial keys are sent by email (Resend), so a trial needs a mailbox that works. Without RESEND_API_KEY, keys are shown at once. */
const RESEND_KEY = process.env.RESEND_API_KEY ?? '';
const EMAIL_API = (process.env.EMAIL_API_BASE ?? 'https://api.resend.com').replace(/\/+$/, '');
const EMAIL_FROM = process.env.EMAIL_FROM ?? 'Control Tower <trials@agentcontroltower.app>';
/** How long the link in a trial email works. */
const LINK_MS = 24 * 3600_000;
const PUBLIC = SIGNING ? crypto.createPublicKey(SIGNING) : undefined;

/** Stripe prices, found by lookup key (so no ids are configured here). */
const LOOKUP = { platform_year: 'ct_enterprise_platform_year', seat_year: 'ct_enterprise_seat_year', platform_month: 'ct_enterprise_platform_month', seat_month: 'ct_enterprise_seat_month' };
export const INCLUDED_SEATS = 5;
export const MAX_SELF_SERVE_SEATS = 100;
const REQUESTS_PER_YEAR = 100_000_000;
const DAY = 86_400_000;

// ---------- licenses ----------
const b64u = (b) => Buffer.from(b).toString('base64url');
export function sign(payload, key = SIGNING, kind = 'ctl1') {
  const head = `${kind}.${b64u(JSON.stringify(payload))}`;
  return `${head}.${b64u(crypto.sign(null, Buffer.from(head), key))}`;
}
export function verify(token, pub = PUBLIC, kind = 'ctl1') {
  const [v, body, sig] = String(token ?? '').trim().split('.');
  if (v !== kind || !body || !sig) return undefined;
  if (!crypto.verify(null, Buffer.from(`${v}.${body}`), pub, Buffer.from(sig, 'base64url'))) return undefined;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}
/**
 * A trial asked for: who, and when. Signed (kind "ctt1", never a license) and carried by the link in the email, so
 * nothing is stored here. The key it opens is the same however many times the link is opened.
 */
const trialRequest = (company, email, now) => sign({ company, email, iat: now, exp: now + LINK_MS }, SIGNING, 'ctt1');
function trialKey(r) {
  const id = `lic_trial_${crypto.createHash('sha256').update(`${r.email}|${r.iat}`).digest('hex').slice(0, 12)}`;
  return sign({ v: 1, kid: KID, id, customer: r.company, email: r.email, plan: 'trial', seats: INCLUDED_SEATS, requests_per_year: REQUESTS_PER_YEAR, features: ['*'], issued_at: r.iat, expires_at: r.iat + 30 * DAY, period_start: r.iat });
}
async function sendTrialEmail(to, company, link) {
  const html = `<div style="font-family:-apple-system,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#0f1b2d">
<div style="font-weight:600;font-size:17px">Control Tower</div>
<p style="font:500 11px ui-monospace,Menlo,monospace;letter-spacing:.12em;color:#1f5eff;margin:28px 0 8px">TRIAL CLEARANCE</p>
<h1 style="font-size:28px;font-weight:500;letter-spacing:-.02em;margin:0 0 12px">Your trial is ready for ${esc(company)}</h1>
<p style="color:#5b6b82;line-height:1.6;margin:0 0 24px">30 days of Control Tower Enterprise, with ${INCLUDED_SEATS} seats and every feature. Open your key, paste it into <b>License</b> in Control Tower, and you're cleared.</p>
<a href="${link}" style="display:inline-block;background:#1f5eff;color:#fff;text-decoration:none;font-weight:600;padding:13px 20px;border-radius:10px">Open my trial key</a>
<p style="color:#8a98ad;font-size:13px;line-height:1.6;margin:24px 0 0">The link works for 24 hours. If you didn't ask for a trial, ignore this email: nothing happens.</p></div>`;
  const text = `Your Control Tower Enterprise trial for ${company} is ready: 30 days, ${INCLUDED_SEATS} seats, every feature.\n\nOpen your key (the link works for 24 hours):\n${link}\n\nIf you didn't ask for a trial, ignore this email.`;
  const r = await fetch(`${EMAIL_API}/emails`, {
    method: 'POST',
    headers: { authorization: `Bearer ${RESEND_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject: 'Your Control Tower Enterprise trial key', html, text }),
    signal: AbortSignal.timeout(15_000),
  });
  // Resend says why it refused (an unverified domain, a key limited to another domain): keep that for the log.
  if (!r.ok) throw new Error(`the email service answered ${r.status}: ${(await r.text().catch(() => '')).slice(0, 300)}`);
}

/**
 * Seat changes. Stripe's customer portal can't change a subscription with more than one product (ours: the platform
 * and seats), so changes are made here. A license key asks; the billing email on the subscription confirms, so a
 * leaked key can't change anyone's bill. More seats: charged now for the rest of the period. Fewer: from the next
 * renewal (a subscription schedule), with nothing refunded for the current period.
 */
const seatRequest = (sub, seats, now) => sign({ sub, seats, iat: now, exp: now + LINK_MS }, SIGNING, 'cts1');
const masked = (email) => String(email).replace(/^(.)[^@]*(@.*)$/, '$1•••$2');
async function sendSeatEmail(to, seats, current, link) {
  const more = seats > current;
  const html = `<div style="font-family:-apple-system,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#0f1b2d">
<div style="font-weight:600;font-size:17px">Control Tower</div>
<h1 style="font-size:26px;font-weight:500;letter-spacing:-.02em;margin:28px 0 12px">Confirm ${seats} seats</h1>
<p style="color:#5b6b82;line-height:1.6;margin:0 0 24px">Someone with your Control Tower Enterprise license key asked to change it from ${current} to ${seats} single sign-on seats. ${more ? 'The extra seats are charged now, for the rest of this billing period.' : 'The change takes effect at your next renewal; nothing is refunded for this period.'}</p>
<a href="${link}" style="display:inline-block;background:#1f5eff;color:#fff;text-decoration:none;font-weight:600;padding:13px 20px;border-radius:10px">Confirm ${seats} seats</a>
<p style="color:#8a98ad;font-size:13px;line-height:1.6;margin:24px 0 0">The link works for 24 hours. If this wasn't you, ignore this email: nothing changes. Questions: billing@agentcontroltower.app</p></div>`;
  const text = `Confirm a change to your Control Tower Enterprise license: ${current} → ${seats} seats.\n${more ? 'The extra seats are charged now, for the rest of this billing period.' : 'It takes effect at your next renewal.'}\n\nConfirm (the link works for 24 hours):\n${link}\n\nIf this wasn't you, ignore this email.`;
  const r = await fetch(`${EMAIL_API}/emails`, {
    method: 'POST',
    headers: { authorization: `Bearer ${RESEND_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject: `Confirm ${seats} seats for Control Tower Enterprise`, html, text }),
    signal: AbortSignal.timeout(15_000),
  });
  // Resend says why it refused (an unverified domain, a key limited to another domain): keep that for the log.
  if (!r.ok) throw new Error(`the email service answered ${r.status}: ${(await r.text().catch(() => '')).slice(0, 300)}`);
}
/** The subscription's seats: those included plus the seat item's quantity. */
const seatsOf = (sub) => INCLUDED_SEATS + (sub.items.data.find((i) => i.price.lookup_key?.startsWith('ct_enterprise_seat'))?.quantity ?? 0);

/**
 * Why no key may be minted from this subscription now, or null: it isn't active, or its latest invoice isn't paid.
 * The second matters at every renewal: Stripe moves the period on at once but keeps the renewal's invoice a draft for
 * about an hour before charging the card, so "active" with next period's end date isn't yet paid for.
 * (`latest_invoice` must be expanded.)
 */
function owing(sub) {
  if (!['active', 'trialing'].includes(sub.status)) return sub.status;
  const inv = sub.latest_invoice;
  if (inv && typeof inv === 'object' && ['draft', 'open', 'uncollectible'].includes(inv.status) && (inv.amount_remaining ?? inv.amount_due) > 0) return `invoice_${inv.status}`;
  return null;
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
    // License years (the request allowance) run from when the subscription began.
    ...(sub.start_date ? { period_start: sub.start_date * 1000 } : {}),
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
/** Stripe's API version this service was written against (pinned so an account default can't change behaviour). */
const STRIPE_VERSION = process.env.STRIPE_API_VERSION ?? '2026-08-26.dahlia';
async function stripe(method, path, body) {
  const r = await fetch(`${STRIPE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${STRIPE_KEY}`,
      ...(STRIPE_VERSION ? { 'stripe-version': STRIPE_VERSION } : {}),
      // A write retried after a network failure is applied once.
      ...(method === 'POST' ? { 'idempotency-key': crypto.randomUUID() } : {}),
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(body ? { body: form(body).toString() } : {}),
  });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.error?.message ?? `Stripe ${r.status}`), { status: r.status });
  return j;
}
let priceCache;
async function prices() {
  // No Stripe key: nothing is for sale yet (checkout says it's being set up), rather than an error from Stripe.
  if (!STRIPE_KEY) return {};
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
// The look of agentcontroltower.app: Geist, the blue accent on light glass, night-blue bands, and the tower.
const SITE = 'https://agentcontroltower.app';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const day = (ms) => new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

const CSS = `
:root{--bg:#f4f6fa;--paper:#fff;--ink:#0f1b2d;--dim:#5b6b82;--faint:#8a98ad;--line:#e3e8f0;--line-2:#d3dbe7;--accent:#1f5eff;--deep:#0b3d91;--soft:#e8efff;--ok:#1a9e6b;--warn:#d9860b;--danger:#d3374e;--night:#0a1222;--night-2:#111d33;
--sans:'Geist',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;--mono:'Geist Mono',ui-monospace,SFMono-Regular,Menlo,monospace;--ease:cubic-bezier(.22,1,.36,1)}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--ink);font:400 15px/1.55 var(--sans);-webkit-font-smoothing:antialiased;overflow-x:hidden}
a{color:inherit;text-decoration:none}button{font:inherit}
@keyframes rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
@keyframes drift{to{background-position:1200px 0}}
@keyframes sweep{to{transform:rotate(360deg)}}
@keyframes blip{0%{opacity:1;transform:scale(1.9)}14%{opacity:1;transform:scale(1)}70%,100%{opacity:.22;transform:scale(1)}}
@keyframes blipLabel{0%,4%{opacity:1}70%,100%{opacity:.35}}
@keyframes ping{0%{opacity:.7;transform:scale(.6)}60%,100%{opacity:0;transform:scale(3)}}
@keyframes beacon{0%,55%{opacity:1}56%,100%{opacity:.2}}
@keyframes beaconGlow{0%{opacity:.6;transform:scale(.6)}55%{opacity:0;transform:scale(2)}100%{opacity:0}}
@keyframes wave{0%{opacity:0}20%{opacity:.85}70%,100%{opacity:0}}
@keyframes dot{50%{opacity:.25}}
@keyframes scan{0%{top:-12%}100%{top:112%}}
@keyframes cardScan{from{transform:translateX(-120%)}to{transform:translateX(320%)}}
@keyframes stamp{0%{opacity:0;transform:rotate(-14deg) scale(2.4)}60%{opacity:1;transform:rotate(-14deg) scale(.92)}100%{opacity:1;transform:rotate(-14deg) scale(1)}}
@keyframes reveal{from{clip-path:inset(0 0 100% 0)}to{clip-path:inset(0 0 0 0)}}
@keyframes ticker{to{transform:translateX(-50%)}}
.rise{animation:rise .7s var(--ease) both;animation-delay:var(--d,0ms)}
.frame{max-width:1200px;margin:0 auto;border-left:1px solid var(--line-2);border-right:1px solid var(--line-2);position:relative}
.pad{padding-left:56px;padding-right:56px}
.eyebrow{font:500 11px/1 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--accent)}
.accent{color:var(--accent)}.muted{color:var(--dim)}
.topbar{background:var(--night);color:#cfd8ea;font:400 12.5px/1.3 var(--mono);text-align:center;padding:11px 16px}.topbar a{color:#fff}
.nav{position:sticky;top:0;z-index:50;background:rgba(255,255,255,.8);backdrop-filter:blur(14px) saturate(1.4);-webkit-backdrop-filter:blur(14px) saturate(1.4);border-bottom:1px solid var(--line)}
.nav .frame{display:flex;align-items:center;gap:24px;height:64px;border:0;padding:0 24px}
.brand{display:flex;align-items:center;gap:9px;font-weight:600;font-size:17px;letter-spacing:-.2px;white-space:nowrap}.brand svg{width:26px;height:26px}
.chip{font:500 10.5px/1 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--accent);background:var(--soft);border:1px solid #cddcff;border-radius:999px;padding:5px 8px}
.nav-links{display:flex;gap:22px;font-size:14px;color:#33435a}.nav-links a:hover{color:var(--ink)}
.nav-right{margin-left:auto;display:flex;gap:10px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:42px;padding:0 18px;border-radius:10px;font:500 14.5px/1 var(--sans);cursor:pointer;border:1px solid transparent;transition:transform .2s var(--ease),box-shadow .2s,background .2s;white-space:nowrap}
.btn:hover{transform:translateY(-1px)}.btn svg{width:15px;height:15px}
.btn.primary{color:#fff;background:linear-gradient(#3a72ff,#1f5eff);border-color:#1a4fd8;box-shadow:0 1px 0 rgba(255,255,255,.25) inset,0 6px 18px rgba(31,94,255,.28)}
.btn.alt{color:var(--ink);background:linear-gradient(#fff,#f6f8fb);border-color:var(--line-2);box-shadow:0 1px 2px rgba(15,27,45,.06)}
.btn.onDark{color:#fff;background:rgba(255,255,255,.07);border-color:rgba(255,255,255,.2)}
.btn.full{width:100%}.btn.lg{height:50px;font-size:15.5px}
.btn[disabled]{opacity:.45;cursor:not-allowed;transform:none;box-shadow:none}
.hero{position:relative;overflow:hidden}
.hero-bars{position:absolute;inset:-40px -10% 0;background:repeating-linear-gradient(90deg,rgba(31,94,255,0) 0 40px,rgba(31,94,255,.55) 40px 64px,rgba(120,170,255,.35) 64px 92px,rgba(255,255,255,0) 92px 150px,rgba(76,56,230,.45) 150px 168px,rgba(130,205,255,.5) 168px 206px,rgba(255,255,255,0) 206px 260px,rgba(31,94,255,.35) 260px 276px,rgba(255,255,255,0) 276px 330px);filter:blur(22px);opacity:.75;animation:drift 90s linear infinite;-webkit-mask-image:linear-gradient(to bottom,#000 0%,#000 55%,transparent 100%);mask-image:linear-gradient(to bottom,#000 0%,#000 55%,transparent 100%)}
.hero .frame{background:rgba(255,255,255,.58);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-color:rgba(201,211,224,.9)}
.hero-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:40px;align-items:center;padding-top:72px;padding-bottom:64px}
.hero h1{font-size:60px;line-height:1.03;font-weight:450;letter-spacing:-.035em;margin:18px 0 20px;text-wrap:balance}
.hero h1 .accent{display:block}
.lede{font-size:17px;line-height:1.6;color:#33435a;max-width:31em;margin:0 0 28px}
.cta{display:flex;gap:10px;flex-wrap:wrap}
.note{font:400 12.5px/1.4 var(--mono);color:var(--faint);margin-top:18px}
.radar{max-width:520px;margin:0 auto;width:100%}
.radar svg{display:block;width:100%;height:auto;overflow:visible}
.r-ring{fill:none;stroke:#b9c8e6;stroke-width:1;stroke-dasharray:2 5}.r-ring.solid{stroke:#c9d6ef;stroke-dasharray:none}
.r-cross{stroke:#d8e1f1;stroke-width:1}
.r-sweep{transform-origin:220px 220px;animation:sweep 6s linear infinite}
.r-blip{transform-box:fill-box;transform-origin:center;fill:var(--accent);animation:blip 6s linear infinite}
.r-ping{transform-box:fill-box;transform-origin:center;fill:none;stroke:var(--accent);stroke-width:1.2;animation:ping 6s ease-out infinite}
.r-label{font:600 9px var(--mono);letter-spacing:.14em;fill:#33435a;animation:blipLabel 6s linear infinite}
.r-ringtext{font:500 7.5px var(--mono);letter-spacing:.26em;fill:#8aa0c6}
.beacon{animation:beacon 1.6s steps(1) infinite}
.beacon-glow{transform-box:fill-box;transform-origin:center;animation:beaconGlow 1.6s ease-out infinite}
.wave{fill:none;stroke:var(--accent);stroke-width:2.6;stroke-linecap:round;opacity:0;animation:wave 2.4s ease-out infinite}.wave.w2{animation-delay:.3s}.wave.w3{animation-delay:.6s}
.pill{display:flex;justify-content:center;margin-top:-6px}
.pill span{display:inline-flex;align-items:center;gap:8px;font:600 10.5px/1 var(--mono);letter-spacing:.16em;color:#0d6b47;background:#e9f8f1;border:1px solid #a9e2c8;border-radius:999px;padding:8px 12px}
.pill i{width:7px;height:7px;border-radius:50%;background:var(--ok);animation:dot 1.2s steps(1) infinite}
.ticker{background:var(--night);color:#8fa3c4;font:500 11.5px/1 var(--mono);letter-spacing:.08em;overflow:hidden;border-top:1px solid #1c2940;border-bottom:1px solid #1c2940}
.ticker div{display:flex;gap:48px;width:max-content;padding:13px 0;animation:ticker 40s linear infinite}
.ticker b{color:#fff;font-weight:500}.ticker em{font-style:normal;color:#57d6a0}.ticker u{text-decoration:none;color:#ffc46b}
.sec{border-top:1px solid var(--line-2)}.sec .frame{padding-top:80px;padding-bottom:80px}
.sec h2{font-size:38px;line-height:1.1;font-weight:450;letter-spacing:-.03em;margin:12px 0 10px;text-wrap:balance}
.sec .sub{color:var(--dim);max-width:40em;margin:0 0 36px}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}
.feat{position:relative;overflow:hidden;background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:20px 18px 18px;transition:border-color .3s,box-shadow .3s,transform .3s var(--ease)}
.feat:hover{border-color:#b7caff;box-shadow:0 10px 30px rgba(31,94,255,.12);transform:translateY(-2px)}
.feat::after{content:"";position:absolute;inset:0;width:40%;background:linear-gradient(90deg,transparent,rgba(31,94,255,.12),transparent);transform:translateX(-120%);pointer-events:none}
.feat:hover::after{animation:cardScan 1s var(--ease)}
.feat .ic{width:38px;height:38px;border-radius:10px;background:var(--soft);display:grid;place-items:center;color:var(--accent);margin-bottom:14px}
.feat .ic svg{width:20px;height:20px}
.feat h3{margin:0 0 4px;font-size:15.5px;font-weight:600}.feat p{margin:0;color:var(--dim);font-size:13.5px;line-height:1.5}
.feat .tag{position:absolute;top:18px;right:16px;font:500 9.5px var(--mono);letter-spacing:.12em;color:var(--faint)}
.buy{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:18px;align-items:stretch}
.card{background:var(--paper);border:1px solid var(--line);border-radius:18px;padding:28px;box-shadow:0 1px 2px rgba(15,27,45,.04)}
.card h3{margin:0;font-size:20px;font-weight:600;letter-spacing:-.01em}
.seg{display:inline-flex;background:#eef2f8;border:1px solid var(--line);border-radius:10px;padding:3px;margin:18px 0 22px}
.seg button{border:0;background:transparent;color:var(--dim);padding:8px 14px;border-radius:8px;cursor:pointer;font-weight:500;font-size:13.5px}
.seg button.on{background:#fff;color:var(--ink);box-shadow:0 1px 3px rgba(15,27,45,.12)}
.seg small{color:var(--ok);font:500 10.5px var(--mono);margin-left:4px}
.seats{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px;font-size:14px;color:var(--dim)}.seats b{color:var(--ink);font-size:15px}
input[type=range]{width:100%;accent-color:var(--accent);height:24px}
.price{font-size:46px;font-weight:500;letter-spacing:-.03em;font-variant-numeric:tabular-nums;margin:18px 0 2px;line-height:1.1}
.price small{font-size:15px;color:var(--dim);font-weight:400;letter-spacing:0}
.per{color:var(--faint);font:400 12.5px var(--mono);margin-bottom:20px}
.checks{list-style:none;padding:0;margin:0 0 24px;display:grid;gap:9px;font-size:14px;color:#33435a}
.checks li{display:flex;gap:10px;align-items:flex-start}.checks svg{flex:none;width:18px;height:18px;color:var(--ok);margin-top:1px}
.fine{color:var(--faint);font-size:12.5px;margin-top:12px}
.trial{position:relative;overflow:hidden;background:radial-gradient(420px 260px at 85% 0%,rgba(31,94,255,.35),transparent 70%),var(--night);color:#e7eefb;border-radius:18px;padding:28px;border:1px solid #1c2940;box-shadow:0 24px 60px rgba(10,18,34,.25)}
.trial .scanline{position:absolute;left:0;right:0;height:70px;background:linear-gradient(180deg,transparent,rgba(95,150,255,.16),transparent);animation:scan 4.5s linear infinite;pointer-events:none}
.trial h3{color:#fff}.trial .eyebrow{color:#8fb0ff}
.trial p{color:#a9b8d3;margin:8px 0 20px}
.field{display:grid;gap:6px;margin-bottom:12px}.field label{font:500 10.5px var(--mono);letter-spacing:.12em;color:#8fa3c4;text-transform:uppercase}
.field input{height:46px;border-radius:10px;border:1px solid #2a3a57;background:rgba(255,255,255,.05);color:#fff;padding:0 14px;font:inherit;font-size:15px;outline:none;transition:border-color .2s,box-shadow .2s}
.field input:focus{border-color:#5b8bff;box-shadow:0 0 0 3px rgba(31,94,255,.3)}
.field input::placeholder{color:#62739a}
.trial .fine{color:#7d8fb1}
.steps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;counter-reset:s}
.step{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:20px}
.step b{display:block;font:500 11px var(--mono);letter-spacing:.12em;color:var(--accent);margin-bottom:8px}
.step h3{margin:0 0 4px;font-size:15.5px;font-weight:600}.step p{margin:0;color:var(--dim);font-size:13.5px}
code{font:400 .92em var(--mono);background:var(--soft);padding:1px 6px;border-radius:5px}
footer{background:var(--night);color:#8b9ab5;font-size:13px;border-top:1px solid #1c2940}
footer .frame{border-color:#1c2940;display:flex;flex-wrap:wrap;align-items:center;gap:18px 28px;padding-top:30px;padding-bottom:30px}
footer .brand{color:#fff;font-size:15px}footer .brand svg{width:22px;height:22px}
footer nav{display:flex;gap:20px;flex-wrap:wrap}footer nav a:hover{color:#fff}footer .sp{flex:1}
/* clearance */
.clear{position:relative;overflow:hidden;background:radial-gradient(700px 360px at 50% -10%,rgba(31,94,255,.38),transparent 70%),var(--night);color:#e7eefb}
.clear .frame{border-color:#1c2940;padding-top:64px;padding-bottom:72px;text-align:center}
.clear h1{font-size:54px;line-height:1.05;font-weight:450;letter-spacing:-.035em;margin:16px auto 12px;color:#fff;text-wrap:balance}
.clear .lede{color:#a9b8d3;margin:0 auto 36px;max-width:36em}
.clear .eyebrow{color:#8fb0ff}
.tower-sm{width:86px;height:auto;margin:0 auto;display:block}
.strip{position:relative;max-width:720px;margin:0 auto;text-align:left;background:linear-gradient(180deg,#fdfefe,#f1f5fc);color:var(--ink);border-radius:16px;display:grid;grid-template-columns:auto minmax(0,1fr);overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.45),0 0 0 1px rgba(255,255,255,.08);animation:rise .8s var(--ease) .15s both}
.strip .side{background:var(--accent);color:#fff;writing-mode:vertical-rl;transform:rotate(180deg);font:600 11px var(--mono);letter-spacing:.3em;padding:18px 12px;text-align:center}
.strip .body{padding:22px 24px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px 20px;position:relative}
.strip .f span{display:block;font:500 9.5px var(--mono);letter-spacing:.14em;color:var(--faint);text-transform:uppercase;margin-bottom:4px}
.strip .f b{font-size:15px;font-weight:600;word-break:break-word}
.strip .f.wide{grid-column:span 2}
.strip .laser{position:absolute;left:0;right:0;height:3px;background:linear-gradient(90deg,transparent,#3dff9e,transparent);box-shadow:0 0 18px 4px rgba(61,255,158,.55);top:-12%;animation:scan 1.6s ease-in-out .5s 2 both}
.strip .stampbox{position:absolute;right:26px;bottom:18px;pointer-events:none}
.stamp{display:inline-block;font:800 22px/1 var(--mono);letter-spacing:.18em;color:var(--ok);border:3px solid var(--ok);border-radius:8px;padding:8px 12px;background:rgba(233,248,241,.85);animation:stamp .5s cubic-bezier(.2,1.4,.4,1) 3.7s both}
.keybox{max-width:720px;margin:26px auto 0;text-align:left;animation:rise .8s var(--ease) .5s both}
.keybox label{font:500 10.5px var(--mono);letter-spacing:.14em;color:#8fa3c4;text-transform:uppercase}
.keybox textarea{display:block;width:100%;margin:8px 0 12px;min-height:118px;resize:vertical;border-radius:12px;border:1px solid #2a3a57;background:#0d1729;color:#bcd0f5;font:400 12.5px/1.55 var(--mono);padding:14px;word-break:break-all;animation:reveal 1.2s steps(12) 1s both}
.keyrow{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.keyrow .muted{color:#7d8fb1;font-size:13px}
.msg{max-width:640px;margin:0 auto;text-align:center;padding:96px 24px;min-height:calc(100vh - 230px)}
.msg .code{font:600 11px var(--mono);letter-spacing:.16em;color:var(--warn);background:#fff6e6;border:1px solid #f2d59c;border-radius:999px;padding:7px 11px;display:inline-block}
.msg h1{font-size:40px;font-weight:450;letter-spacing:-.03em;margin:18px 0 10px}.msg p{color:var(--dim);margin:0 0 26px}
@media (max-width:1000px){.hero-grid{grid-template-columns:1fr;padding-top:56px}.radar{max-width:440px}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.buy{grid-template-columns:1fr}.nav-links{display:none}}
@media (max-width:640px){.pad{padding-left:18px;padding-right:18px}.frame{border:0}.hero h1{font-size:40px}.clear h1{font-size:36px}.sec h2{font-size:30px}.grid,.steps{grid-template-columns:1fr}.nav .frame{padding:0 16px;gap:12px}.nav-right .alt{display:none}.chip{display:none}.strip{grid-template-columns:1fr}.strip .side{writing-mode:horizontal-tb;transform:none;padding:10px}.strip .body{grid-template-columns:1fr 1fr}.strip .f.wide{grid-column:span 2}.strip .stampbox{position:static;grid-column:span 2;text-align:right;margin-top:2px}.topbar .long{display:none}.price{font-size:38px}.card,.trial{padding:22px}.stamp{font-size:18px}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.001ms!important;animation-iteration-count:1!important;animation-delay:0s!important;transition-duration:.001ms!important}.r-sweep{display:none}.r-blip,.r-label{opacity:1}}
`;

const LOGO = `<svg viewBox="0 0 64 64" fill="none" aria-hidden="true"><path d="M41 15a13 13 0 0 1 9 9" stroke="#1F5EFF" stroke-width="3" stroke-linecap="round" opacity=".6"/><path d="M44 8a20 20 0 0 1 13 13" stroke="#1F5EFF" stroke-width="3" stroke-linecap="round" opacity=".3"/><rect x="30.5" y="5" width="3" height="11" rx="1.5" fill="#0B3D91"/><path d="M13 18h38l-4.5 12H17.5z" fill="#1F5EFF"/><rect x="20" y="22.5" width="24" height="3" rx="1.5" fill="#FFFFFF" opacity=".85"/><path d="M26.5 30h11l3.5 25H23z" fill="#0B3D91"/><rect x="17" y="54" width="30" height="4.5" rx="2.25" fill="#0B3D91"/></svg>`;

/** The tower from the home page: beacon, radio waves, glass cab, shaft. Drawn in a 120 × 180 box. */
const TOWER = (id) => `<defs><linearGradient id="${id}G" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#eaf1ff"/><stop offset="1" stop-color="#86a8ff"/></linearGradient><linearGradient id="${id}S" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#3b74ff"/><stop offset=".55" stop-color="#1f5eff"/><stop offset="1" stop-color="#0b3d91"/></linearGradient></defs>
<ellipse cx="60" cy="177" rx="44" ry="4.5" fill="#0b3d91" opacity=".14"/>
<path class="wave" d="M63.8 15.84A9 9 0 0 1 68.69 21.67M56.2 15.84A9 9 0 0 0 51.31 21.67"/><path class="wave w2" d="M66.76 9.5A16 16 0 0 1 75.45 19.86M53.24 9.5A16 16 0 0 0 44.55 19.86"/><path class="wave w3" d="M69.72 3.16A23 23 0 0 1 82.22 18.05M50.28 3.16A23 23 0 0 0 37.78 18.05"/>
<rect x="58.6" y="24" width="2.8" height="27" rx="1.4" fill="#0b3d91"/><circle class="beacon-glow" cx="60" cy="24" r="5" fill="#ff4d5e"/><circle class="beacon" cx="60" cy="24" r="3.2" fill="#ff4d5e"/>
<path d="M33 50H87L83 57H37Z" fill="#0b3d91"/><path d="M29 57H91L83 82H37Z" fill="url(#${id}G)" stroke="#1f5eff" stroke-width="1.6" stroke-linejoin="round"/>
<path d="M44 57L46.5 82M56 57L56.8 82M64 57L63.2 82M76 57L73.5 82" stroke="#fff" stroke-width="1.6" opacity=".75"/><path d="M34 59H41L37.5 80H36Z" fill="#fff" opacity=".5"/>
<rect x="33" y="82" width="54" height="6" rx="2.5" fill="#0b3d91"/><path d="M46 88H74L79 166H41Z" fill="url(#${id}S)"/><path d="M49 88H53L50 166H45Z" fill="#fff" opacity=".13"/>
<rect x="56.5" y="104" width="7" height="9" rx="2" fill="#fff" opacity=".3"/><rect x="56.5" y="122" width="7" height="9" rx="2" fill="#fff" opacity=".3"/><rect x="56.5" y="140" width="7" height="9" rx="2" fill="#fff" opacity=".3"/><rect x="31" y="165" width="58" height="9" rx="3" fill="#0b3d91"/>`;

/** The radar: a sweep circling the tower, lighting each Enterprise feature as it passes. */
function radar() {
  const C = 220, SWEEP_S = 6;
  const feats = [['SSO', 24], ['SCIM', 68], ['AUDIT', 112], ['SIEM', 150], ['AGENT ID', 202], ['VAULTS', 246], ['TEAMS', 292], ['REGIONS', 334]];
  const at = (deg, r) => [C + r * Math.sin((deg * Math.PI) / 180), C - r * Math.cos((deg * Math.PI) / 180)];
  const wedge = (from, op) => {
    const [x1, y1] = at(from, 206);
    return `<path d="M${C} ${C}L${x1.toFixed(1)} ${y1.toFixed(1)}A206 206 0 0 1 ${C} ${C - 206}Z" fill="#1f5eff" opacity="${op}"/>`;
  };
  const blips = feats
    .map(([name, deg], i) => {
      const r = i % 2 ? 150 : 176;
      const [x, y] = at(deg, r);
      const [lx, ly] = at(deg, r + 18);
      const delay = `animation-delay:${((deg / 360) * SWEEP_S).toFixed(2)}s`;
      const anchor = Math.abs(lx - C) < 12 ? 'middle' : lx > C ? 'start' : 'end';
      return `<circle class="r-ping" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" style="${delay}"/><circle class="r-blip" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.5" style="${delay}"/><text class="r-label" x="${lx.toFixed(1)}" y="${(ly + 3).toFixed(1)}" text-anchor="${anchor}" style="${delay}">${name}</text>`;
    })
    .join('');
  return `<div class="radar rise" style="--d:160ms" role="img" aria-label="A radar sweeps around a control tower, lighting up each Enterprise feature: single sign-on, SCIM, the audit log, SIEM export, agent identity, secret managers, teams and regions.">
<svg viewBox="-40 -10 520 460" aria-hidden="true">
<defs><radialGradient id="rg" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#dbe6ff" stop-opacity=".95"/><stop offset=".62" stop-color="#eef3ff" stop-opacity=".55"/><stop offset="1" stop-color="#eef3ff" stop-opacity="0"/></radialGradient><path id="rt" d="M${C - 124} ${C - 42} A131 131 0 0 1 ${C + 124} ${C - 42}" fill="none"/></defs>
<circle cx="${C}" cy="${C}" r="212" fill="url(#rg)"/>
<circle class="r-ring solid" cx="${C}" cy="${C}" r="206"/><circle class="r-ring" cx="${C}" cy="${C}" r="163"/><circle class="r-ring" cx="${C}" cy="${C}" r="118"/><circle class="r-ring solid" cx="${C}" cy="${C}" r="72"/>
<path class="r-cross" d="M${C - 206} ${C}H${C + 206}M${C} ${C - 206}V${C + 206}"/>
<text class="r-ringtext"><textPath href="#rt" startOffset="50%" text-anchor="middle">ENTERPRISE CLEARANCE · SCANNING</textPath></text>
<g class="r-sweep">${wedge(-46, 0.07)}${wedge(-24, 0.08)}${wedge(-9, 0.12)}<path d="M${C} ${C}V${C - 206}" stroke="#1f5eff" stroke-width="1.6" opacity=".65"/></g>
${blips}
<g transform="translate(${C - 60 * 0.82} ${C - 118 * 0.82}) scale(.82)">${TOWER('t1')}</g>
</svg>
<div class="pill"><span><i></i>CLEARED FOR ENTERPRISE</span></div>
</div>`;
}

const ICONS = {
  sso: '<path d="M15 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM5 20a7 7 0 0 1 14 0" /><path d="M17 11l2 2 3-4"/>',
  audit: '<path d="M8 3h8l4 4v14H4V3h4Z"/><path d="M8 11h8M8 15h8M8 7h4"/>',
  siem: '<path d="M4 12h4l3-7 4 14 3-7h2"/>',
  id: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="12" r="2.5"/><path d="M14 10h4M14 14h3"/>',
  vault: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="12" cy="12" r="3.5"/><path d="M12 8.5V7M15.5 12H17"/>',
  teams: '<circle cx="8" cy="9" r="2.5"/><circle cx="16" cy="9" r="2.5"/><path d="M3 19a5 5 0 0 1 10 0M11 19a5 5 0 0 1 10 0"/>',
  meter: '<path d="M4 16a8 8 0 1 1 16 0"/><path d="M12 16l4-5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
};
const icon = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k]}</svg>`;
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const ARROW = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4"/></svg>';

function page(title, body, { head = '' } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<meta name="description" content="Control Tower Enterprise: single sign-on, SCIM, the audit log, agent identity, secret managers, teams and every region, turned on by a license key your own server checks.">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(LOGO.replace('aria-hidden="true"', 'xmlns="http://www.w3.org/2000/svg"'))}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;450;500;600;700;800&family=Geist+Mono:wght@400;500;600;800&display=swap" rel="stylesheet">${head}
<style>${CSS}</style></head><body>
<div class="topbar">License keys are checked on your own server<span class="long"> — no connection needed</span> · <a href="${SITE}">agentcontroltower.app →</a></div>
<header class="nav"><div class="frame"><a class="brand" href="${SITE}">${LOGO}Control Tower</a><span class="chip">Enterprise</span>
<nav class="nav-links"><a href="${SITE}/#map">Airspace</a><a href="${SITE}/pricing.html">Pricing</a><a href="${SITE}/docs/enterprise.html">How licensing works</a><a href="${SITE}/docs/">Docs</a></nav>
<div class="nav-right"><a class="btn alt" href="/#trial">Start a trial</a><a class="btn primary" href="/#buy">Buy</a></div></div></header>
${body}
<footer><div class="frame pad"><span class="brand">${LOGO}Control Tower</span><nav><a href="${SITE}">Home</a><a href="${SITE}/pricing.html">Pricing</a><a href="${SITE}/docs/">Docs</a><a href="${SITE}/docs/enterprise.html">Enterprise</a><a href="${SITE}/terms.html">Terms</a><a href="${SITE}/privacy.html">Privacy</a><a href="${SITE}/refunds.html">Refunds</a><a href="https://github.com/joshmaster2165/controltower">GitHub</a></nav><span class="sp"></span><span>Enterprise under the Elastic License 2.0</span></div></footer>
</body></html>`;
}

/** A short page for an answer that isn't a key: not found, slow down, payment pending. */
const note = (title, code, text, { head = '', back = true } = {}) =>
  page(title, `<main class="msg"><span class="code">${esc(code)}</span><h1>${esc(title)}</h1><p>${text}</p>${back ? `<a class="btn primary" href="/">Back to plans ${ARROW}</a>` : ''}</main>`, { head });

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
  const feats = [
    ['sso', 'SSO · SCIM', 'Single sign-on', 'OIDC and SAML, roles from your identity provider’s groups, people added and removed by SCIM.'],
    ['audit', 'AUDIT', 'Tamper-evident audit log', 'Every change and refused attempt, hash-chained, exportable, kept a year.'],
    ['siem', 'SIEM', 'Sent to your SIEM', 'Splunk, Datadog, OpenTelemetry, S3 or a webhook, in order, nothing lost.'],
    ['id', 'JWT', 'Agent identity', 'Agents sign in with Kubernetes, GitHub Actions or IdP tokens instead of secrets.'],
    ['vault', 'VAULTS', 'Secret managers', 'AWS, Google, Azure and Vault by reference, with keys rotated on a schedule.'],
    ['teams', 'TEAMS', 'Organisations and teams', 'Team admins run their own agents, budgets and held calls; members see only theirs.'],
    ['meter', 'METER', 'Requests metered', 'The year’s requests against your allowance. Going over never slows anything.'],
    ['globe', 'REGIONS', 'Every region, one console', 'Regions near your agents, configured in one place, serving through outages.'],
  ];
  const tick = ['<b>INVOICE-BOT</b> → github · <u>HELD AT GATE</u>', '<b>SSO</b> · okta · <em>CLEARED</em>', '<b>AUDIT</b> · 14,220 events · <em>CHAIN INTACT</em>', '<b>EU-WEST</b> · in sync · <em>1.8 s</em>', '<b>SCIM</b> · 3 people added · <em>CLEARED</em>', '<b>AGENT</b> ci-deploy · github oidc · <em>CLEARED</em>', '<b>BUDGET</b> research-team · 71% · <em>ON COURSE</em>', '<b>ASIA-SE</b> · held call approved from us-west · <em>1.1 s</em>'];
  const ticker = `<div class="ticker" aria-hidden="true"><div>${[...tick, ...tick].map((t) => `<span>${t}</span>`).join('')}</div></div>`;
  return page(
    'Control Tower Enterprise — plans and a free trial',
    `<section class="hero"><div class="hero-bars" aria-hidden="true"></div><div class="frame pad"><div class="hero-grid">
<div>
<span class="eyebrow rise">Control Tower Enterprise</span>
<h1 class="rise" style="--d:60ms">You’re cleared <span class="accent">for the whole fleet</span></h1>
<p class="lede rise" style="--d:140ms">Single sign-on, a tamper-evident audit log, agent identity, secret managers, teams and every region on one control plane — switched on by a license key your own server checks, with no connection needed.</p>
<div class="cta rise" style="--d:220ms"><a class="btn primary lg" href="#trial">Start a 30-day trial ${ARROW}</a><a class="btn alt lg" href="#buy">See the price</a></div>
<p class="note rise" style="--d:300ms">30 days · ${INCLUDED_SEATS} seats · no card · ${RESEND_KEY ? 'your key by email' : 'your key in seconds'}</p>
</div>
${radar()}
</div></div></section>
${ticker}
<section class="sec"><div class="frame pad">
<span class="eyebrow">What the key switches on</span><h2>Everything a company needs to run agents at scale</h2><p class="sub">On top of the open-source gateway you already run. Nothing to migrate: add the key, and the features appear.</p>
<div class="grid">${feats.map(([ic, tag, t, d]) => `<div class="feat"><span class="tag">${tag}</span><div class="ic">${icon(ic)}</div><h3>${t}</h3><p>${d}</p></div>`).join('')}</div>
</div></section>
<section class="sec" id="buy"><div class="frame pad">
<span class="eyebrow">Plans</span><h2>One price per deployment, never per token</h2><p class="sub">${INCLUDED_SEATS} single sign-on seats and ${(REQUESTS_PER_YEAR / 1e6).toLocaleString()} million requests a year included. Every seat beyond costs less the more you add.</p>
<div class="buy">
<div class="card">
<h3>Enterprise</h3>
<div class="seg" role="group" aria-label="Billing"><button type="button" id="y" class="on">Yearly</button><button type="button" id="m">Monthly</button></div>
<div class="seats"><label for="seats">People signing in with single sign-on</label><b id="seatsLabel">5 people</b></div>
<input id="seats" type="range" min="${INCLUDED_SEATS}" max="${MAX_SELF_SERVE_SEATS}" value="${INCLUDED_SEATS}">
<div class="price" id="price">${ready ? '' : 'Checkout opens soon'}</div>
<div class="per" id="perNote">${ready ? '' : 'Start a free trial meanwhile — it has every feature.'}</div>
<ul class="checks"><li>${CHECK}Every Enterprise feature, and support</li><li>${CHECK}${INCLUDED_SEATS} seats and ${(REQUESTS_PER_YEAR / 1e6).toLocaleString()}M requests a year included</li><li>${CHECK}Going over your requests never slows or stops anything</li><li>${CHECK}Cancel any time; traffic is never cut off</li></ul>
<form method="post" action="/checkout"><input type="hidden" name="seats" id="seatsField" value="${INCLUDED_SEATS}"><input type="hidden" name="interval" id="intervalField" value="year"><button class="btn primary lg full" ${ready ? '' : 'disabled'}>Buy with Stripe ${ARROW}</button></form>
<p class="fine">By buying you agree to our <a href="${SITE}/terms.html" style="text-decoration:underline">terms</a> and <a href="${SITE}/refunds.html" style="text-decoration:underline">refund policy</a>. Prices in US dollars, before tax. Sold through Link, Stripe’s merchant of record: checkout adds tax where it applies and may show your local currency. More than ${MAX_SELF_SERVE_SEATS} seats or a billion requests a year? Contact sales for volume pricing.</p>
</div>
<div class="trial" id="trial"><div class="scanline" aria-hidden="true"></div>
<span class="eyebrow">Free trial</span><h3 style="margin-top:12px">30 days of everything</h3>
<p>${INCLUDED_SEATS} seats, every feature, no card. ${RESEND_KEY ? 'We email you a link to your key' : 'Your key appears on the next page'} — paste it into <b>License</b> in Control Tower and you’re cleared.</p>
<form method="post" action="/trial"><div class="field"><label for="company">Company</label><input id="company" type="text" name="company" placeholder="Acme Corp" required maxlength="100" autocomplete="organization"></div>
<div class="field"><label for="email">Work email</label><input id="email" type="email" name="email" placeholder="you@acme.com" required maxlength="200" autocomplete="email"></div>
<button class="btn primary lg full" style="margin-top:6px">${RESEND_KEY ? 'Email me my trial key' : 'Get my trial key'} ${ARROW}</button></form>
<p class="fine">Ends on its own after 30 days. Nothing is charged, and your gateway keeps working. By starting a trial you agree to our <a href="${SITE}/terms.html" style="color:#a9b8d3;text-decoration:underline">terms</a> and <a href="${SITE}/privacy.html" style="color:#a9b8d3;text-decoration:underline">privacy policy</a>.</p>
</div>
</div></div></section>
<section class="sec"><div class="frame pad">
<span class="eyebrow">How the key works</span><h2>Cleared in three steps</h2><p class="sub">No agent to install and no call home needed: the key is signed, and your server checks the signature itself.</p>
<div class="steps"><div class="step"><b>01</b><h3>Get your key</h3><p>Start a trial or buy — the key appears straight away.</p></div><div class="step"><b>02</b><h3>Paste it in</h3><p>Open <b>License</b> in Control Tower, or set <code>CT_LICENSE_KEY</code> on the server.</p></div><div class="step"><b>03</b><h3>You’re cleared</h3><p>Enterprise features switch on. Servers that can reach us pick up renewals by themselves.</p></div></div>
</div></section>
<script>
const P=${data};let interval='year';
const s=document.getElementById('seats'),out=document.getElementById('price'),lab=document.getElementById('seatsLabel'),per=document.getElementById('perNote'),y=document.getElementById('y'),m=document.getElementById('m');
function total(pl,se,n){let c=pl?pl.unit_amount:0,x=Math.max(0,n-${INCLUDED_SEATS}),f=0;for(const t of (se&&se.tiers)||[]){const u=t.up_to==null?Infinity:t.up_to,k=Math.max(0,Math.min(x,u-f));c+=k*(t.unit_amount||0);x-=k;f=u;if(x<=0)break}return c}
function draw(){const n=+s.value,p=P[interval];lab.textContent=n+(n===1?' person':' people');document.getElementById('seatsField').value=n;document.getElementById('intervalField').value=interval;if(!p.platform)return;out.innerHTML='$'+Math.round(total(p.platform,p.seat,n)/100).toLocaleString('en-US')+' <small>/ '+interval+'</small>';per.textContent=n+' seats · '+(interval==='year'?'billed yearly':'billed monthly')}
s.oninput=draw;y.onclick=()=>{interval='year';y.className='on';m.className='';draw()};m.onclick=()=>{interval='month';m.className='on';y.className='';draw()};draw();
</script>`,
  );
}

/** After asking for a trial: the link is on its way. */
/** Change seats: paste the license key, choose the number. */
function seatsPage() {
  return page(
    'Change seats',
    `<main class="msg" style="max-width:620px;text-align:left"><span class="code" style="color:var(--accent);background:var(--soft);border-color:#cddcff">SEATS</span><h1>Change your seats</h1>
<p>Paste the license key from Control Tower’s <b>License</b> page and choose the number of people signing in with single sign-on. We email the billing address on your subscription to confirm.</p>
<form method="post" action="/seats" class="card" style="display:grid;gap:14px">
<label class="seats" for="key" style="margin:0"><span>License key</span></label>
<textarea id="key" name="key" required rows="4" style="font:12.5px/1.5 var(--mono);border:1px solid var(--line-2);border-radius:10px;padding:12px;width:100%;resize:vertical" placeholder="ctl1.…"></textarea>
<div class="seats" style="margin:0"><label for="seats">Seats</label><b><output id="sv">${INCLUDED_SEATS}</output></b></div>
<input id="seats" name="seats" type="range" min="${INCLUDED_SEATS}" max="${MAX_SELF_SERVE_SEATS}" value="${INCLUDED_SEATS}" oninput="sv.value=this.value">
<button class="btn primary lg full">Email me a confirmation ${ARROW}</button>
<p class="fine" style="margin:0">More seats are charged now for the rest of the period. Fewer seats take effect at your next renewal, with nothing refunded for this period. Over ${MAX_SELF_SERVE_SEATS}? Write to sales@agentcontroltower.app.</p>
</form></main>`,
  );
}

function inboxPage(email, what = 'see your trial key') {
  return page(
    'Check your inbox',
    `<section class="clear" style="min-height:calc(100vh - 230px)"><div class="frame pad">
<svg class="tower-sm rise" viewBox="0 0 120 180" aria-hidden="true">${TOWER('t3')}</svg>
<div class="eyebrow rise" style="--d:80ms;margin-top:14px">Awaiting clearance</div>
<h1 class="rise" style="--d:120ms">Check your inbox</h1>
<p class="lede rise" style="--d:180ms">We sent a link to <b style="color:#fff">${esc(email)}</b>. Open it within 24 hours to ${esc(what)}${what === 'see your trial key' ? ', ready to paste into Control Tower' : ''}.</p>
<div class="pill rise" style="--d:260ms"><span><i></i>LINK TRANSMITTED</span></div>
<p class="note rise" style="--d:320ms;color:#7d8fb1">Nothing there? Check spam, or ask again in a few minutes.</p>
</div></section>`,
  );
}

/** The key, as a flight strip: a laser scans it, and it's stamped cleared. */
function keyPage(title, key, text) {
  let l = {};
  try {
    l = JSON.parse(Buffer.from(String(key).split('.')[1], 'base64url').toString('utf8'));
  } catch {}
  const trial = l.plan === 'trial';
  return page(
    title,
    `<section class="clear"><div class="frame pad">
<svg class="tower-sm rise" viewBox="0 0 120 180" aria-hidden="true">${TOWER('t2')}</svg>
<div class="eyebrow rise" style="--d:80ms;margin-top:14px">${trial ? 'Trial clearance' : 'Enterprise clearance'}</div>
<h1 class="rise" style="--d:120ms">${esc(title)}</h1>
<p class="lede rise" style="--d:180ms">${esc(text)}</p>
<div class="strip"><div class="side">${trial ? 'TRIAL' : 'ENTERPRISE'} · CT-${esc(String(l.id ?? '').slice(-6).toUpperCase())}</div><div class="body">
<div class="laser" aria-hidden="true"></div>
<div class="f wide"><span>Licensed to</span><b>${esc(l.customer ?? '')}</b></div><div class="f"><span>Plan</span><b>${trial ? 'Enterprise trial' : 'Enterprise'}</b></div>
<div class="f"><span>Seats</span><b>${esc(l.seats ?? '')}</b></div><div class="f"><span>Valid until</span><b>${l.expires_at ? day(l.expires_at) : ''}</b></div><div class="f"><span>Features</span><b>${(l.features ?? []).includes('*') ? 'All' : esc((l.features ?? []).join(', '))}</b></div>
<div class="stampbox"><span class="stamp">CLEARED</span></div>
</div></div>
<div class="keybox"><label for="k">Your license key</label><textarea id="k" readonly spellcheck="false">${esc(key)}</textarea>
<div class="keyrow"><button type="button" class="btn primary" id="copy">Copy key</button><a class="btn onDark" href="${SITE}/docs/enterprise.html">How licensing works</a><span class="muted">Keep it like a password.</span></div>
</div>
</div></section>
<section class="sec"><div class="frame pad">
<span class="eyebrow">Next</span><h2>Switch it on</h2>
<div class="steps"><div class="step"><b>01</b><h3>Open License</h3><p>In Control Tower, open <b>License</b> in the sidebar.</p></div><div class="step"><b>02</b><h3>Paste the key</h3><p>Paste it and save — or set <code>CT_LICENSE_KEY</code> on the server instead.</p></div><div class="step"><b>03</b><h3>You’re cleared</h3><p>${trial ? 'Everything is on for 30 days. When the trial ends, Enterprise features stop and nothing else changes.' : 'Everything is on. Servers that can reach us renew the key by themselves.'}</p></div></div>
</div></section>
<script>
document.getElementById('copy').onclick=function(){const t=document.getElementById('k');const done=()=>{this.textContent='Copied ✓'};navigator.clipboard&&navigator.clipboard.writeText(t.value).then(done,()=>{t.select();document.execCommand('copy');done()})||(t.select(),document.execCommand('copy'),done())};
</script>`,
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
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:; script-src 'unsafe-inline'; form-action 'self' https://checkout.stripe.com https://billing.stripe.com; frame-ancestors 'none'", ...extra });
  res.end(text);
};
const json = (res, status, obj) => send(res, status, 'application/json', JSON.stringify(obj));
const html = (res, status, text) => send(res, status, 'text/html; charset=utf-8', text);
const redirect = (res, url) => send(res, 303, 'text/plain', '', { location: url });

export function createServer() {
  return http.createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', PUBLIC_URL);
    // The caller's address, as Railway's edge sets it in X-Real-IP. X-Forwarded-For is ignored: a client can write it.
    const ip = String(req.headers['x-real-ip'] ?? req.socket.remoteAddress ?? '').trim();
    try {
      if (req.method === 'GET' && u.pathname === '/healthz') return json(res, 200, { ok: true, signing: !!SIGNING, stripe: !!STRIPE_KEY });
      if (req.method === 'GET' && u.pathname === '/') return html(res, 200, await plansPage());

      if (req.method === 'POST' && u.pathname === '/checkout') {
        if (limited(ip, 'checkout', 20, 3600_000)) return html(res, 429, note('Too many attempts', 'HOLD · 429', 'Try again in a while.'));
        const b = await body(req);
        const seats = Math.min(MAX_SELF_SERVE_SEATS, Math.max(INCLUDED_SEATS, Math.round(Number(b.seats) || INCLUDED_SEATS)));
        const month = b.interval === 'month';
        const p = await prices();
        const platform = p[month ? LOOKUP.platform_month : LOOKUP.platform_year];
        const seat = p[month ? LOOKUP.seat_month : LOOKUP.seat_year];
        if (!platform || !seat) return html(res, 503, note('Checkout is being set up', 'STANDBY · 503', 'Try again soon — or start a free trial meanwhile: it has every feature.'));
        const items = [{ price: platform.id, quantity: 1 }, ...(seats > INCLUDED_SEATS ? [{ price: seat.id, quantity: seats - INCLUDED_SEATS }] : [])];
        const session = await stripe('POST', '/v1/checkout/sessions', {
          mode: 'subscription',
          line_items: Object.fromEntries(items.map((it, i) => [i, it])),
          success_url: `${PUBLIC_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${PUBLIC_URL}/`,
          allow_promotion_codes: 'true',
          billing_address_collection: 'required',
          // (No tax_id_collection: with Managed Payments, Link is the merchant of record and collects business details.)
          subscription_data: { metadata: { product: 'controltower-enterprise', seats: String(seats) } },
        });
        return redirect(res, session.url);
      }

      if (req.method === 'GET' && u.pathname === '/success') {
        const id = u.searchParams.get('session_id') ?? '';
        if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return html(res, 400, note('That checkout was not found', 'UNKNOWN · 400', 'Use the link from your receipt, or start again from the plans.'));
        const s = await stripe('GET', `/v1/checkout/sessions/${id}?expand[]=subscription&expand[]=subscription.latest_invoice&expand[]=customer`);
        const paid = s.payment_status === 'paid' || s.payment_status === 'no_payment_required';
        if (s.status !== 'complete' || !s.subscription || !paid || owing(s.subscription)) return html(res, 402, note('Payment not complete yet', 'HOLDING · 402', 'This page checks again every few seconds: your key appears as soon as the payment clears.', { head: '<meta http-equiv="refresh" content="4">', back: false }));
        const customer = { name: s.customer_details?.name ?? s.customer?.name, email: s.customer_details?.email ?? s.customer?.email };
        const issued = licenseFor(s.subscription, customer);
        // Each time the page is opened (a reload logs it again): who bought what, until when.
        console.log(JSON.stringify({ event: 'license_issued', license: issued.id, customer: issued.customer, email: issued.email, seats: issued.seats, until: new Date(issued.expires_at).toISOString(), live: s.livemode === true }));
        return html(res, 200, keyPage('You’re cleared', sign(issued), `Your Control Tower Enterprise license, for ${customer.name ?? customer.email}. It renews with your subscription; servers that can reach this service pick up the renewed key themselves.`));
      }

      if (req.method === 'POST' && u.pathname === '/trial') {
        if (limited(ip, 'trial', 3, 24 * 3600_000)) return html(res, 429, note('Trial limit reached', 'HOLD · 429', 'Contact sales for a longer trial.'));
        const b = await body(req);
        const company = String(b.company ?? '').trim().slice(0, 100);
        const email = String(b.email ?? '').trim().toLowerCase().slice(0, 200);
        if (!company || !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) return html(res, 400, note('Check the form', 'RETURNED · 400', 'Enter your company and a work email.'));
        if (limited(email, 'trial-email', 2, 24 * 3600_000)) return html(res, 429, note('Trial limit reached', 'HOLD · 429', 'We’ve already sent a trial link to that address today. Check your inbox, or contact sales for a longer trial.'));
        const now = Date.now();
        if (!RESEND_KEY) {
          console.log(JSON.stringify({ event: 'trial', company, email, verified: false, at: new Date(now).toISOString() }));
          return html(res, 200, keyPage('You’re cleared for 30 days', trialKey({ company, email, iat: now }), `30 days of Control Tower Enterprise for ${company}, with ${INCLUDED_SEATS} seats.`));
        }
        const link = `${PUBLIC_URL}/trial/confirm?t=${encodeURIComponent(trialRequest(company, email, now))}`;
        try {
          await sendTrialEmail(email, company, link);
        } catch (err) {
          console.error(JSON.stringify({ error: `trial email not sent: ${err.message}`, email }));
          return html(res, 502, note('We couldn’t send the email', 'NO CONTACT · 502', 'Try again in a minute, or contact sales.'));
        }
        console.log(JSON.stringify({ event: 'trial_requested', company, email, at: new Date(now).toISOString() }));
        return html(res, 200, inboxPage(email));
      }

      if (req.method === 'GET' && u.pathname === '/trial/confirm') {
        const r = verify(u.searchParams.get('t') ?? '', PUBLIC, 'ctt1');
        if (!r?.email || !r.company || !Number.isFinite(r.iat)) return html(res, 400, note('That link isn’t valid', 'UNKNOWN · 400', 'Open the link from your email as it is, or start a trial again.'));
        if (Date.now() > r.exp) return html(res, 410, note('That link has expired', 'EXPIRED · 410', 'Trial links work for 24 hours. Start a trial again for a new one.'));
        console.log(JSON.stringify({ event: 'trial', company: r.company, email: r.email, verified: true, at: new Date().toISOString() }));
        return html(res, 200, keyPage('You’re cleared for 30 days', trialKey(r), `30 days of Control Tower Enterprise for ${r.company}, with ${INCLUDED_SEATS} seats.`));
      }

      if (req.method === 'POST' && u.pathname === '/refresh') {
        if (limited(ip, 'refresh', 60, 3600_000)) return json(res, 429, { error: 'rate_limited' });
        const b = await body(req);
        const lic = verify(b.key);
        if (!lic) return json(res, 400, { error: 'invalid_license' });
        if (!lic.sub) return json(res, 200, { status: 'unchanged' }); // trials and hand-issued keys don't renew here
        let sub = await stripe('GET', `/v1/subscriptions/${encodeURIComponent(lic.sub)}?expand[]=customer&expand[]=latest_invoice`);
        // A seat reduction's schedule, once its last period has begun, lets go of the subscription: while attached it
        // stops the subscription being cancelled (in Stripe's portal too). Stripe's own "current phase" says when.
        if (typeof sub.schedule === 'string') {
          const sched = await stripe('GET', `/v1/subscription_schedules/${encodeURIComponent(sub.schedule)}`).catch(() => undefined);
          const last = sched?.phases?.at(-1);
          if (sched?.status === 'active' && last && sched.current_phase?.start_date === last.start_date) {
            await stripe('POST', `/v1/subscription_schedules/${sched.id}/release`, {}).catch((err) => console.error(JSON.stringify({ error: `schedule not released: ${err.message}`, subscription: sub.id })));
            sub = await stripe('GET', `/v1/subscriptions/${encodeURIComponent(lic.sub)}?expand[]=customer&expand[]=latest_invoice`);
          }
        }
        // The server's request count this license year (a number, nothing else): kept on the subscription, for renewals.
        const u = b.usage;
        if (u && Number.isFinite(u.requests) && u.requests >= 0 && Number.isFinite(u.period_start)) {
          console.log(JSON.stringify({ event: 'usage', license: lic.id, customer: lic.customer, requests: Math.round(u.requests), allowance: lic.requests_per_year, period_start: new Date(u.period_start).toISOString() }));
          await stripe('POST', `/v1/subscriptions/${encodeURIComponent(lic.sub)}`, { metadata: { requests_this_year: String(Math.round(u.requests)), requests_allowance: String(lic.requests_per_year), requests_period_start: new Date(u.period_start).toISOString().slice(0, 10), usage_reported_at: new Date().toISOString() } }).catch((err) => console.error(JSON.stringify({ error: `usage not recorded: ${err.message}`, license: lic.id })));
        }
        // How many people use seats on that server: kept on the subscription, so seats aren't reduced below it.
        if (Number.isFinite(b.seats_used) && b.seats_used >= 0) {
          await stripe('POST', `/v1/subscriptions/${encodeURIComponent(lic.sub)}`, { metadata: { seats_used: String(Math.round(b.seats_used)), seats_used_at: new Date().toISOString() } }).catch((err) => console.error(JSON.stringify({ error: `seats in use not recorded: ${err.message}`, license: lic.id })));
        }
        // A server whose clock was found set back says so (how far, and the latest time it had seen): kept on the subscription.
        const c = b.clock;
        if (c && Number.isFinite(c.behind_ms) && c.behind_ms > 0) {
          const days = Math.round(c.behind_ms / DAY);
          console.log(JSON.stringify({ event: 'clock_behind', license: lic.id, customer: lic.customer, days_behind: days, latest_seen: Number.isFinite(c.latest_seen) ? new Date(c.latest_seen).toISOString() : null }));
          await stripe('POST', `/v1/subscriptions/${encodeURIComponent(lic.sub)}`, { metadata: { clock_behind_days: String(days), clock_reported_at: new Date().toISOString() } }).catch((err) => console.error(JSON.stringify({ error: `clock report not recorded: ${err.message}`, license: lic.id })));
        }
        if (sub.status === 'past_due') {
          console.log(JSON.stringify({ event: 'renewal_unpaid', license: lic.id, customer: lic.customer }));
          return json(res, 200, { status: 'unchanged', subscription: 'past_due' });
        }
        if (!['active', 'trialing'].includes(sub.status)) {
          // Ended before the key's end date (cancelled at once, refunded, or Stripe gave up): the key ends then too, so a
          // refund doesn't leave Enterprise running for the rest of a paid year.
          const endedAt = (sub.ended_at ?? sub.canceled_at ?? 0) * 1000;
          if (endedAt && endedAt < lic.expires_at) {
            console.log(JSON.stringify({ event: 'license_shortened', license: lic.id, customer: lic.customer, from: new Date(lic.expires_at).toISOString(), to: new Date(endedAt).toISOString(), subscription: sub.status }));
            return json(res, 200, { status: 'ended', subscription: sub.status, key: sign({ ...lic, issued_at: Date.now(), expires_at: endedAt }) });
          }
          return json(res, 200, { status: 'ended', subscription: sub.status });
        }
        // Active, but the renewal's invoice isn't paid yet (a draft for its first hour, or open while retried).
        const due = owing(sub);
        if (due) {
          console.log(JSON.stringify({ event: 'renewal_unpaid', license: lic.id, customer: lic.customer, invoice: due }));
          return json(res, 200, { status: 'unchanged', subscription: 'payment_pending' });
        }
        const next = licenseFor(sub, { name: sub.customer?.name ?? lic.customer, email: sub.customer?.email ?? lic.email });
        if (next.expires_at === lic.expires_at && next.seats === lic.seats && next.period_start === lic.period_start) return json(res, 200, { status: 'unchanged' });
        console.log(JSON.stringify({ event: 'license_renewed', license: next.id, customer: next.customer, seats: next.seats, until: new Date(next.expires_at).toISOString() }));
        return json(res, 200, { status: 'renewed', key: sign(next) });
      }

      if (req.method === 'GET' && u.pathname === '/seats') return html(res, 200, seatsPage());

      if (req.method === 'POST' && u.pathname === '/seats') {
        if (limited(ip, 'seats', 10, 3600_000)) return html(res, 429, note('Too many attempts', 'HOLD · 429', 'Try again in a while.'));
        const b = await body(req);
        const lic = verify(String(b.key ?? '').trim());
        const seats = Math.round(Number(b.seats));
        if (!lic?.sub) return html(res, 400, note('That key has no subscription', 'UNKNOWN · 400', 'Paste the license key from Control Tower’s License page (a trial has no seats to change).'));
        if (!(seats >= INCLUDED_SEATS && seats <= MAX_SELF_SERVE_SEATS)) return html(res, 400, note('Check the number of seats', 'RETURNED · 400', `Between ${INCLUDED_SEATS} and ${MAX_SELF_SERVE_SEATS}; for more, write to sales@agentcontroltower.app.`));
        const sub = await stripe('GET', `/v1/subscriptions/${encodeURIComponent(lic.sub)}?expand[]=customer&expand[]=latest_invoice`);
        if (!['active', 'trialing'].includes(sub.status)) return html(res, 409, note('That subscription isn’t active', 'HOLD · 409', 'Seats can be changed on an active subscription. Write to billing@agentcontroltower.app.'));
        if (owing(sub)) return html(res, 402, note('An invoice is waiting', 'HOLD · 402', 'Seats can be changed once your latest invoice is paid. Pay it from the customer portal (the link is in your receipts), then try again.'));
        const current = seatsOf(sub);
        if (seats === current) return html(res, 200, note('Nothing to change', 'NO CHANGE', `Your license already has ${current} seats.`));
        // Not below the people using seats now, as Control Tower last reported.
        const inUse = Number(sub.metadata?.seats_used);
        if (seats < current && Number.isFinite(inUse) && seats < inUse) return html(res, 409, note(`${inUse} people use seats now`, 'HOLD · 409', `Control Tower reports ${inUse} people signing in with single sign-on or provisioned by SCIM. Remove or deactivate people first (in Control Tower, or at your identity provider), then reduce to ${seats}.`));
        const email = sub.customer?.email;
        if (!RESEND_KEY || !email) return html(res, 503, note('Write to us to change seats', 'STANDBY · 503', 'Email billing@agentcontroltower.app with the number of seats you want, and we’ll change it for you.'));
        try {
          await sendSeatEmail(email, seats, current, `${PUBLIC_URL}/seats/confirm?t=${encodeURIComponent(seatRequest(sub.id, seats, Date.now()))}`);
        } catch (err) {
          console.error(JSON.stringify({ error: `seat email not sent: ${err.message}`, license: lic.id }));
          return html(res, 502, note('We couldn’t send the email', 'NO CONTACT · 502', 'Try again in a minute, or write to billing@agentcontroltower.app.'));
        }
        console.log(JSON.stringify({ event: 'seats_requested', license: lic.id, from: current, to: seats }));
        return html(res, 200, inboxPage(masked(email), `confirm ${seats} seats`));
      }

      if (req.method === 'GET' && u.pathname === '/seats/confirm') {
        const r = verify(u.searchParams.get('t') ?? '', PUBLIC, 'cts1');
        if (!r?.sub || !Number.isFinite(r.seats)) return html(res, 400, note('That link isn’t valid', 'UNKNOWN · 400', 'Open the link from your email as it is.'));
        if (Date.now() > r.exp) return html(res, 410, note('That link has expired', 'EXPIRED · 410', 'Links work for 24 hours. Ask again from the seats page.'));
        let sub = await stripe('GET', `/v1/subscriptions/${encodeURIComponent(r.sub)}?expand[]=customer&expand[]=latest_invoice`);
        // The subscription may have changed since the email was sent (cancelled, refunded, a renewal unpaid).
        if (owing(sub)) return html(res, 409, note('That subscription can’t change now', 'HOLD · 409', 'It isn’t active, or an invoice is waiting to be paid. Settle it from the customer portal, or write to billing@agentcontroltower.app.'));
        const current = seatsOf(sub);
        const customer = { name: sub.customer?.name, email: sub.customer?.email };
        if (r.seats === current || (sub.schedule && r.seats < current)) {
          return html(res, 200, keyPage('You’re cleared', sign(licenseFor(sub, customer)), `Your license has ${current} seats${sub.schedule ? ', and a change is already scheduled for your next renewal' : ''}.`));
        }
        const seatItem = sub.items.data.find((i) => i.price.lookup_key?.startsWith('ct_enterprise_seat'));
        if (r.seats > current) {
          // More seats now, charged for the rest of the period; the payment must go through.
          const opts = { quantity: r.seats - INCLUDED_SEATS, proration_behavior: 'always_invoice', payment_behavior: 'error_if_incomplete' };
          if (seatItem) await stripe('POST', `/v1/subscription_items/${seatItem.id}`, opts);
          else {
            const month = sub.items.data[0]?.price?.recurring?.interval === 'month';
            const seatPrice = (await prices())[month ? LOOKUP.seat_month : LOOKUP.seat_year];
            await stripe('POST', '/v1/subscription_items', { subscription: sub.id, price: seatPrice.id, ...opts });
          }
          sub = await stripe('GET', `/v1/subscriptions/${encodeURIComponent(r.sub)}?expand[]=customer&expand[]=latest_invoice`);
          console.log(JSON.stringify({ event: 'seats_added', subscription: sub.id, from: current, to: seatsOf(sub) }));
          return html(res, 200, keyPage('You’re cleared', sign(licenseFor(sub, customer)), `Your license now has ${seatsOf(sub)} seats. Paste this key into Control Tower, or let your servers pick it up within a day.`));
        }
        // Fewer seats from the next renewal: the current period as it is, then the new quantity.
        const sched = await stripe('POST', '/v1/subscription_schedules', { from_subscription: sub.id });
        const now = sched.phases[0];
        const next = sub.items.data
          .map((i) => (i === seatItem ? { price: i.price.id, quantity: r.seats - INCLUDED_SEATS } : { price: i.price.id, quantity: i.quantity }))
          .filter((i) => i.quantity > 0);
        await stripe('POST', `/v1/subscription_schedules/${sched.id}`, {
          end_behavior: 'release',
          proration_behavior: 'none',
          phases: {
            0: { start_date: now.start_date, end_date: now.end_date, items: Object.fromEntries(now.items.map((i, k) => [k, { price: typeof i.price === 'string' ? i.price : i.price.id, quantity: i.quantity }])) },
            // One billing period at the new quantity, then the subscription carries on as it is (Stripe's API has
            // `duration` here; `iterations` is gone).
            1: { duration: { interval: sub.items.data[0]?.price?.recurring?.interval === 'month' ? 'month' : 'year', interval_count: 1 }, items: Object.fromEntries(next.map((i, k) => [k, i])) },
          },
        });
        console.log(JSON.stringify({ event: 'seats_reduced_at_renewal', subscription: sub.id, from: current, to: r.seats, from_date: new Date(now.end_date * 1000).toISOString() }));
        return html(res, 200, note(`${r.seats} seats from ${day(now.end_date * 1000)}`, 'SCHEDULED', `Your license keeps ${current} seats until your next renewal on ${day(now.end_date * 1000)}; from then it has ${r.seats}, and your servers pick up the new key by themselves.`, { back: false }));
      }

      if (req.method === 'POST' && u.pathname === '/portal') {
        const b = await body(req);
        const lic = verify(b.key);
        if (!lic?.sub) return html(res, 400, note('No subscription to manage', 'UNKNOWN · 400', 'That license has no subscription to manage.'));
        const sub = await stripe('GET', `/v1/subscriptions/${encodeURIComponent(lic.sub)}`);
        const portal = await stripe('POST', '/v1/billing_portal/sessions', { customer: sub.customer, return_url: `${PUBLIC_URL}/`, ...(process.env.STRIPE_PORTAL_CONFIGURATION ? { configuration: process.env.STRIPE_PORTAL_CONFIGURATION } : {}) });
        return redirect(res, portal.url);
      }
      return json(res, 404, { error: 'not_found' });
    } catch (err) {
      console.error(JSON.stringify({ error: err.message, path: u.pathname }));
      // A person in a browser gets a page; Control Tower servers (renewals) get JSON.
      if (String(req.headers.accept ?? '').includes('text/html')) return html(res, 502, note('Something went wrong', 'FAULT · 502', 'Nothing was charged. Try again in a minute, or start a free trial meanwhile: it has every feature.'));
      return json(res, err.status === 413 ? 413 : 502, { error: 'unavailable', message: 'Something went wrong. Try again, or contact sales.' });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!SIGNING) console.warn('LICENSE_SIGNING_KEY is not set: keys cannot be issued.');
  if (!STRIPE_KEY) console.warn('STRIPE_SECRET_KEY is not set: checkout and renewals are off.');
  createServer().listen(PORT, () => console.log(`license service on :${PORT} (${PUBLIC_URL})`));
}
