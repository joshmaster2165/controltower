// Copyright Agent Control Tower. Licensed under the Elastic License 2.0 (see ../LICENSE).
//
// Trials, followed: who asked, who opened their key, whose server uses it and how much, the emails each was sent,
// and the requests turned away as bots. SQLite (Node's own), one file on the service's volume.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DAY = 86_400_000;
export const TRIAL_DAYS = 30;
/** Automatic emails, by trial day: a welcome when the key is opened, then these. */
export const FOLLOW_UPS = [
  { kind: 'day7', at: 7 },
  { kind: 'ending', at: TRIAL_DAYS - 5 },
];
/** Kept a year after a trial ends (then deleted), bot refusals 90 days. */
const KEEP_TRIAL_MS = 365 * DAY;
const KEEP_BLOCKED_MS = 90 * DAY;

export function openStore(dir) {
  let file = ':memory:';
  if (dir) {
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'trials.db');
  }
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS trials (
  id TEXT PRIMARY KEY, email TEXT NOT NULL, company TEXT NOT NULL,
  requested_at INTEGER NOT NULL, confirmed_at INTEGER, expires_at INTEGER NOT NULL,
  first_seen INTEGER, last_seen INTEGER, version TEXT, requests INTEGER, seats_used INTEGER,
  unsubscribed_at INTEGER, bought_at INTEGER, note TEXT);
CREATE INDEX IF NOT EXISTS trials_email ON trials(email);
CREATE TABLE IF NOT EXISTS checkins (trial_id TEXT NOT NULL, day TEXT NOT NULL, at INTEGER NOT NULL, requests INTEGER, seats_used INTEGER, version TEXT, PRIMARY KEY (trial_id, day));
CREATE TABLE IF NOT EXISTS emails (id INTEGER PRIMARY KEY, trial_id TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL, body TEXT, at INTEGER NOT NULL, ok INTEGER NOT NULL, error TEXT);
CREATE INDEX IF NOT EXISTS emails_trial ON emails(trial_id, kind);
CREATE TABLE IF NOT EXISTS blocked (at INTEGER NOT NULL, reason TEXT NOT NULL, email TEXT);
CREATE INDEX IF NOT EXISTS blocked_at ON blocked(at);`);
  const q = (sql) => db.prepare(sql);
  const s = {
    insert: q(`INSERT INTO trials (id, email, company, requested_at, expires_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`),
    confirm: q(`UPDATE trials SET confirmed_at = COALESCE(confirmed_at, ?) WHERE id = ?`),
    get: q(`SELECT * FROM trials WHERE id = ?`),
    seen: q(`UPDATE trials SET first_seen = COALESCE(first_seen, ?), last_seen = ?, version = COALESCE(?, version), requests = COALESCE(?, requests), seats_used = COALESCE(?, seats_used) WHERE id = ?`),
    checkin: q(`INSERT INTO checkins (trial_id, day, at, requests, seats_used, version) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(trial_id, day) DO UPDATE SET at = excluded.at, requests = excluded.requests, seats_used = excluded.seats_used, version = excluded.version`),
    email: q(`INSERT INTO emails (trial_id, kind, subject, body, at, ok, error) VALUES (?, ?, ?, ?, ?, ?, ?)`),
    sentKind: q(`SELECT 1 FROM emails WHERE trial_id = ? AND kind = ? AND ok = 1 LIMIT 1`),
    unsub: q(`UPDATE trials SET unsubscribed_at = COALESCE(unsubscribed_at, ?) WHERE id = ?`),
    bought: q(`UPDATE trials SET bought_at = COALESCE(bought_at, ?) WHERE email = ?`),
    blocked: q(`INSERT INTO blocked (at, reason, email) VALUES (?, ?, ?)`),
    list: q(`SELECT t.*, (SELECT COUNT(*) FROM emails e WHERE e.trial_id = t.id AND e.ok = 1) AS emails_sent, (SELECT MAX(at) FROM emails e WHERE e.trial_id = t.id AND e.ok = 1) AS last_emailed FROM trials t WHERE t.requested_at >= ? ORDER BY t.requested_at DESC LIMIT ?`),
    emailsOf: q(`SELECT kind, subject, body, at, ok, error FROM emails WHERE trial_id = ? ORDER BY at DESC`),
    checkinsOf: q(`SELECT day, at, requests, seats_used, version FROM checkins WHERE trial_id = ? ORDER BY day DESC LIMIT 60`),
    blockedSince: q(`SELECT reason, COUNT(*) AS n FROM blocked WHERE at >= ? GROUP BY reason ORDER BY n DESC`),
    blockedRecent: q(`SELECT at, reason, email FROM blocked ORDER BY at DESC LIMIT ?`),
    due: q(`SELECT * FROM trials WHERE confirmed_at IS NOT NULL AND unsubscribed_at IS NULL AND bought_at IS NULL AND requested_at <= ? AND expires_at > ?`),
    purgeTrials: q(`DELETE FROM trials WHERE expires_at < ?`),
    purgeEmails: q(`DELETE FROM emails WHERE trial_id NOT IN (SELECT id FROM trials)`),
    purgeCheckins: q(`DELETE FROM checkins WHERE trial_id NOT IN (SELECT id FROM trials)`),
    purgeBlocked: q(`DELETE FROM blocked WHERE at < ?`),
  };
  return {
    file,
    /** A trial asked for (its id is the license id the key will carry). */
    requested(t) {
      s.insert.run(t.id, t.email, t.company, t.at, t.at + TRIAL_DAYS * DAY);
    },
    /** The link in the email opened: a person, with the key. Returns true the first time. */
    confirmed(t) {
      s.insert.run(t.id, t.email, t.company, t.at, t.at + TRIAL_DAYS * DAY); // asked before this store existed
      const before = s.get.get(t.id)?.confirmed_at;
      s.confirm.run(Date.now(), t.id);
      return before == null;
    },
    /** A server using the key checked in (once a day). */
    checkin(t, c, now = Date.now()) {
      s.insert.run(t.id, t.email, t.company, t.at, t.at + TRIAL_DAYS * DAY);
      s.confirm.run(now, t.id); // a key in use was opened, whether or not we saw it happen
      const requests = Number.isFinite(c.requests) ? Math.round(c.requests) : null;
      const seats = Number.isFinite(c.seats_used) ? Math.round(c.seats_used) : null;
      const version = typeof c.version === 'string' ? c.version.slice(0, 40) : null;
      s.seen.run(now, now, version, requests, seats, t.id);
      s.checkin.run(t.id, new Date(now).toISOString().slice(0, 10), now, requests, seats, version);
    },
    emailed(id, kind, subject, body, ok, error, now = Date.now()) {
      s.email.run(id, kind, subject, body ?? null, now, ok ? 1 : 0, error ?? null);
    },
    wasSent: (id, kind) => !!s.sentKind.get(id, kind),
    unsubscribe(id, now = Date.now()) {
      s.unsub.run(now, id);
    },
    bought(email, now = Date.now()) {
      s.bought.run(now, String(email ?? '').toLowerCase());
    },
    blocked(reason, maskedEmail, now = Date.now()) {
      s.blocked.run(now, reason, maskedEmail ?? null);
    },
    get: (id) => s.get.get(id),
    list: (sinceMs, limit = 500) => s.list.all(sinceMs, limit),
    emailsOf: (id) => s.emailsOf.all(id),
    checkinsOf: (id) => s.checkinsOf.all(id),
    blockedSince: (sinceMs) => s.blockedSince.all(sinceMs),
    blockedRecent: (n = 20) => s.blockedRecent.all(n),
    /** Trials whose next automatic email is due: [{ trial, kind }]. */
    due(now = Date.now()) {
      const out = [];
      for (const t of s.due.all(now, now)) {
        // Only the latest one that applies: a trial first seen late gets "ending", not a week-one check-in as well.
        const dayOf = (now - t.requested_at) / DAY;
        const f = FOLLOW_UPS.filter((x) => dayOf >= x.at).at(-1);
        if (f && !this.wasSent(t.id, f.kind) && t.expires_at - now > DAY) out.push({ trial: t, kind: f.kind });
      }
      return out;
    },
    purge(now = Date.now()) {
      s.purgeTrials.run(now - KEEP_TRIAL_MS);
      s.purgeEmails.run();
      s.purgeCheckins.run();
      s.purgeBlocked.run(now - KEEP_BLOCKED_MS);
    },
    close: () => db.close(),
  };
}

/** Where a trial is: the furthest step it reached. */
export function stageOf(t, now = Date.now()) {
  if (t.bought_at) return 'bought';
  if (t.expires_at <= now) return t.first_seen ? 'ended (used)' : 'ended';
  if (t.last_seen && now - t.last_seen < 3 * DAY) return 'active';
  if (t.first_seen) return 'went quiet';
  if (t.confirmed_at) return 'opened key';
  return 'asked';
}

// ---------- emails ----------
const escH = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const dateOf = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const n = (x) => Number(x ?? 0).toLocaleString('en-US');

/** The frame every trial email shares; paragraphs are plain text, the footer says how to stop them. */
function frame({ eyebrow, title, paras, button, unsubUrl, ends }) {
  const p = (t) => `<p style="color:#33435a;line-height:1.65;margin:0 0 16px">${t}</p>`;
  const html = `<div style="font-family:-apple-system,'Segoe UI',sans-serif;max-width:540px;margin:0 auto;padding:32px 24px;color:#0f1b2d">
<div style="font-weight:600;font-size:17px">Control Tower</div>
<p style="font:500 11px ui-monospace,Menlo,monospace;letter-spacing:.12em;color:#1f5eff;margin:28px 0 8px">${escH(eyebrow)}</p>
<h1 style="font-size:26px;font-weight:500;letter-spacing:-.02em;margin:0 0 16px">${escH(title)}</h1>
${paras.map((x) => p(x.html ?? escH(x))).join('\n')}
${button ? `<a href="${button.url}" style="display:inline-block;background:#1f5eff;color:#fff;text-decoration:none;font-weight:600;padding:12px 18px;border-radius:10px;margin:4px 0 8px">${escH(button.label)}</a>` : ''}
<p style="color:#8a98ad;font-size:12.5px;line-height:1.6;margin:28px 0 0">${ends ? `Your trial ends on ${dateOf(ends)}. ` : ''}You're getting this because you started a Control Tower Enterprise trial. <a href="${unsubUrl}" style="color:#8a98ad">Stop trial emails</a>.</p></div>`;
  const text = [title, '', ...paras.map((x) => x.text ?? x), ...(button ? ['', `${button.label}: ${button.url}`] : []), '', `${ends ? `Your trial ends on ${dateOf(ends)}. ` : ''}Stop trial emails: ${unsubUrl}`].join('\n');
  return { html, text };
}

/**
 * The automatic emails. Each is written to be answered: replies go to a person (Reply-To). What a server reported
 * (requests, seats) is mentioned only when it has checked in; older servers never do, so nothing assumes they didn't use it.
 */
export function followUp(kind, t, { site, buyUrl, unsubUrl, now = Date.now() }) {
  const ends = t.expires_at;
  const docs = `${site}/docs`;
  if (kind === 'welcome') {
    return {
      subject: 'Your Control Tower trial: where to start',
      ...frame({
        eyebrow: 'TRIAL · DAY 1',
        title: 'Your key is in. Here’s where to start.',
        paras: [
          'Paste the key into License in Control Tower (or set CT_LICENSE_KEY on the server) and every Enterprise feature switches on. Three things worth trying first:',
          { html: `<b>Single sign-on.</b> Connect your identity provider so people sign in as themselves, and SCIM keeps teams in step. <a href="${docs}/sso.html">How</a>`, text: `Single sign-on: connect your identity provider; SCIM keeps teams in step. ${docs}/sso.html` },
          { html: `<b>Airspace.</b> Classes and Reach show what each agent can get to, and where data could leave. <a href="${docs}/airspace.html">How</a>`, text: `Airspace: Classes and Reach show what each agent can reach. ${docs}/airspace.html` },
          { html: `<b>Laptops.</b> Roll Control Tower out to Claude Code, Claude Desktop and Codex, signed in as each person. <a href="${docs}/laptops.html">How</a>`, text: `Laptops: roll it out to Claude Code, Claude Desktop and Codex. ${docs}/laptops.html` },
          'If anything gets in the way, reply to this email. It reaches a person.',
        ],
        unsubUrl,
        ends,
      }),
    };
  }
  if (kind === 'day7') {
    const used = t.first_seen
      ? `Your server has sent ${n(t.requests)} request${t.requests === 1 ? '' : 's'} through Control Tower this trial${t.seats_used ? `, with ${n(t.seats_used)} ${t.seats_used === 1 ? 'person' : 'people'} signed in` : ''}.`
      : 'If the key isn’t in yet: open License in Control Tower, paste it and save. It’s checked on your own server, so nothing needs to connect.';
    return {
      subject: 'How’s your Control Tower trial going?',
      ...frame({
        eyebrow: 'TRIAL · WEEK 1',
        title: 'A week in. How’s it going?',
        paras: [used, 'What would make Control Tower work for you, and what’s in the way? Reply and tell us: we read every answer, and we can help with setup, single sign-on or a rollout.'],
        button: { label: 'Read the guides', url: docs },
        unsubUrl,
        ends,
      }),
    };
  }
  if (kind === 'ending') {
    const left = Math.max(1, Math.ceil((ends - now) / DAY));
    return {
      subject: `Your Control Tower trial ends in ${left} day${left === 1 ? '' : 's'}`,
      ...frame({
        eyebrow: 'TRIAL · ENDING',
        title: `Your trial ends on ${dateOf(ends)}`,
        paras: [
          ...(t.first_seen ? [`So far your server has sent ${n(t.requests)} request${t.requests === 1 ? '' : 's'} through Control Tower.`] : []),
          'When it ends, the Enterprise features switch off and nothing else changes: the gateway, your keys and your data keep working.',
          'To keep them on, choose a plan: the key you get replaces the trial key, and renews by itself. Need more time to decide? Reply to this email.',
        ],
        button: { label: 'See plans', url: buyUrl },
        unsubUrl,
        ends,
      }),
    };
  }
  throw new Error(`no email "${kind}"`);
}

/** An email written by hand on the Trials page: plain text, paragraphs kept, the same footer. */
export function written(subject, body, t, { unsubUrl }) {
  const paras = String(body).split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
  const f = frame({ eyebrow: 'CONTROL TOWER', title: subject, paras: paras.map((x) => ({ html: escH(x).replace(/\n/g, '<br>'), text: x })), unsubUrl, ends: t.expires_at });
  return { subject, ...f };
}

// ---------- the Trials page ----------
const ago = (ms, now = Date.now()) => {
  if (!ms) return '—';
  const d = now - ms;
  if (d < 3600_000) return `${Math.max(1, Math.round(d / 60_000))} min ago`;
  if (d < DAY) return `${Math.round(d / 3600_000)} h ago`;
  return `${Math.round(d / DAY)} d ago`;
};
const STAGE_TONE = { bought: 'good', active: 'good', 'went quiet': 'warn', 'opened key': 'info', asked: 'dim', ended: 'dim', 'ended (used)': 'dim' };
const REASONS = { honeypot: 'filled the hidden field', no_form: 'posted without the form', too_fast: 'sent within seconds', stale_form: 'an old form, replayed', daily_cap: 'over the daily limit' };

const ADMIN_CSS = `:root{--bg:#f4f6fa;--paper:#fff;--ink:#0f1b2d;--dim:#5b6b82;--faint:#8a98ad;--line:#e3e8f0;--accent:#1f5eff;--good:#0f8a5f;--warn:#b26a00}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:400 14px/1.5 -apple-system,'Segoe UI',system-ui,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
main{max-width:1180px;margin:0 auto;padding:28px 20px 60px}h1{font-size:24px;font-weight:600;margin:0 0 4px}h2{font-size:15px;margin:28px 0 10px}
.sub{color:var(--dim);margin:0 0 20px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.card{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:14px 16px}.card b{display:block;font-size:24px;font-weight:600;font-variant-numeric:tabular-nums}.card span{color:var(--dim);font-size:12.5px}
.tw{overflow-x:auto;background:var(--paper);border:1px solid var(--line);border-radius:12px}table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);white-space:nowrap;vertical-align:top}th{color:var(--dim);font-weight:500;font-size:12px}tr:last-child td{border-bottom:0}
td.num{text-align:right;font-variant-numeric:tabular-nums}.chip{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:500;background:#eef1f6;color:var(--dim)}
.chip.good{background:#e3f5ec;color:var(--good)}.chip.warn{background:#fff3e0;color:var(--warn)}.chip.info{background:#e8efff;color:var(--accent)}
.muted{color:var(--faint)}.row{display:flex;gap:16px;flex-wrap:wrap;align-items:baseline}.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}
form.mail{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:16px;display:grid;gap:10px;max-width:720px}
input,textarea{font:inherit;padding:9px 11px;border:1px solid #d3dbe7;border-radius:8px;width:100%}textarea{min-height:170px}
button{font:inherit;font-weight:600;background:var(--accent);color:#fff;border:0;border-radius:9px;padding:10px 16px;cursor:pointer;justify-self:start}
.flash{background:#e3f5ec;color:var(--good);border-radius:10px;padding:10px 14px;margin:0 0 16px}.flash.bad{background:#fdecec;color:#b42318}
details{background:var(--paper);border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin:6px 0}summary{cursor:pointer}pre{white-space:pre-wrap;font:13px/1.55 ui-monospace,Menlo,monospace;color:var(--dim)}`;
const shell = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escH(title)}</title><style>${ADMIN_CSS}</style></head><body><main>${body}</main></body></html>`;

export function trialsPage(store, { now = Date.now(), showAll = false } = {}) {
  const month = store.list(now - 30 * DAY);
  const all = store.list(now - 400 * DAY);
  const count = (f) => month.filter(f).length;
  const blocked7 = store.blockedSince(now - 7 * DAY);
  const blockedTotal = blocked7.reduce((s, b) => s + b.n, 0);
  const shown = showAll ? all : all.filter((t) => t.confirmed_at);
  const hidden = all.length - shown.length;
  const rows = shown
    .map((t) => {
      const stage = stageOf(t, now);
      const left = Math.ceil((t.expires_at - now) / DAY);
      return `<tr><td><a href="/admin/trial?id=${encodeURIComponent(t.id)}">${escH(t.company)}</a><div class="muted">${escH(t.email)}</div></td>
<td><span class="chip ${STAGE_TONE[stage] ?? ''}">${escH(stage)}</span>${t.unsubscribed_at ? ' <span class="chip">unsubscribed</span>' : ''}</td>
<td>${new Date(t.requested_at).toISOString().slice(0, 10)}</td><td>${left > 0 ? `${left} d` : '<span class="muted">ended</span>'}</td>
<td>${ago(t.last_seen, now)}</td><td class="num">${t.requests == null ? '—' : n(t.requests)}</td><td class="num">${t.seats_used ?? '—'}</td><td>${escH(t.version ?? '—')}</td>
<td class="num">${t.emails_sent}</td></tr>`;
    })
    .join('');
  return shell(
    'Trials',
    `<h1>Trials</h1><p class="sub">Enterprise trials: who asked, who opened their key, whose server uses it, and what they've been sent. Servers on Control Tower 0.2.16 or later check in once a day; older ones never do.</p>
<div class="cards">
<div class="card"><b>${count(() => true)}</b><span>asked, last 30 days</span></div>
<div class="card"><b>${count((t) => t.confirmed_at)}</b><span>opened their key</span></div>
<div class="card"><b>${count((t) => t.first_seen)}</b><span>used it on a server</span></div>
<div class="card"><b>${all.filter((t) => stageOf(t, now) === 'active').length}</b><span>active now (seen in 3 days)</span></div>
<div class="card"><b>${count((t) => t.bought_at)}</b><span>bought</span></div>
<div class="card"><b>${blockedTotal}</b><span>turned away as bots, 7 days</span></div>
</div>
<h2>Trials ${showAll ? '' : '(keys opened)'}</h2>
${shown.length ? `<div class="tw"><table><tr><th>Company</th><th>Stage</th><th>Started</th><th>Left</th><th>Server seen</th><th>Requests</th><th>Seats</th><th>Version</th><th>Emails</th></tr>${rows}</table></div>` : '<p class="muted">No trials yet.</p>'}
<p class="muted">${showAll ? '<a href="/admin">Only keys that were opened</a>' : hidden ? `${hidden} more asked and never opened their key (most are bots or typos). <a href="/admin?all=1">Show them</a>` : ''}</p>
<h2>Turned away as bots</h2>
${blocked7.length ? `<div class="tw"><table><tr><th>Why, last 7 days</th><th>Requests</th></tr>${blocked7.map((b) => `<tr><td>${escH(REASONS[b.reason] ?? b.reason)}</td><td class="num">${b.n}</td></tr>`).join('')}</table></div>` : '<p class="muted">None in the last 7 days.</p>'}
<p class="muted">No email is sent for these. They get the usual "check your inbox" page.</p>`,
  );
}

export function trialPage(store, id, { now = Date.now(), flash } = {}) {
  const t = store.get(id);
  if (!t) return undefined;
  const stage = stageOf(t, now);
  const checkins = store.checkinsOf(id);
  const emails = store.emailsOf(id);
  const fact = (k, v) => `<div class="card"><span>${k}</span><b style="font-size:16px">${v}</b></div>`;
  return shell(
    `${t.company} · Trial`,
    `<p><a href="/admin">← Trials</a></p><h1>${escH(t.company)}</h1><p class="sub">${escH(t.email)} · <span class="chip ${STAGE_TONE[stage] ?? ''}">${escH(stage)}</span>${t.unsubscribed_at ? ' <span class="chip">unsubscribed from trial emails</span>' : ''}</p>
${flash ? `<div class="flash${flash.bad ? ' bad' : ''}">${escH(flash.text)}</div>` : ''}
<div class="facts">${fact('Asked', new Date(t.requested_at).toISOString().slice(0, 10))}${fact('Opened key', t.confirmed_at ? new Date(t.confirmed_at).toISOString().slice(0, 10) : '—')}${fact('Ends', new Date(t.expires_at).toISOString().slice(0, 10))}${fact('Server first seen', t.first_seen ? new Date(t.first_seen).toISOString().slice(0, 10) : '—')}${fact('Last seen', ago(t.last_seen, now))}${fact('Requests (trial)', t.requests == null ? '—' : n(t.requests))}${fact('Seats in use', t.seats_used ?? '—')}${fact('Version', escH(t.version ?? '—'))}${t.bought_at ? fact('Bought', new Date(t.bought_at).toISOString().slice(0, 10)) : ''}</div>
<h2>Daily check-ins</h2>
${checkins.length ? `<div class="tw"><table><tr><th>Day</th><th>Requests (trial so far)</th><th>Seats</th><th>Version</th></tr>${checkins.map((c) => `<tr><td>${c.day}</td><td class="num">${c.requests == null ? '—' : n(c.requests)}</td><td class="num">${c.seats_used ?? '—'}</td><td>${escH(c.version ?? '—')}</td></tr>`).join('')}</table></div>` : '<p class="muted">No check-ins yet. A server on 0.2.16 or later checks in a minute after the key is added, then daily.</p>'}
<h2>Emails</h2>
${emails.length ? emails.map((e) => `<details><summary>${new Date(e.at).toISOString().slice(0, 16).replace('T', ' ')} · ${escH(e.kind)} · ${escH(e.subject)}${e.ok ? '' : ` <span class="chip warn">not sent: ${escH(e.error ?? '')}</span>`}</summary>${e.body ? `<pre>${escH(e.body)}</pre>` : ''}</details>`).join('') : '<p class="muted">None yet.</p>'}
<h2>Write to ${escH(t.company)}</h2>
${t.unsubscribed_at ? '<p class="muted">They stopped trial emails, so this page won’t send them any.</p>' : `<form class="mail" method="post" action="/admin/trial/email"><input type="hidden" name="id" value="${escH(t.id)}">
<input name="subject" required maxlength="150" placeholder="Subject" value="How can we help with your trial?">
<textarea name="body" required maxlength="5000" placeholder="Plain text. A blank line starts a new paragraph."></textarea>
<span class="muted">Sent from trials@agentcontroltower.app; replies go to support. The footer with their trial's end date and an unsubscribe link is added.</span><button>Send</button></form>`}`,
  );
}

export function unsubscribePage(done) {
  return shell(
    'Trial emails',
    done
      ? '<h1>Done</h1><p class="sub">You won’t get any more trial emails from Control Tower. Your trial key keeps working until it ends.</p>'
      : '<h1>Stop trial emails?</h1><p class="sub">You won’t get any more emails about your Control Tower trial. Your key keeps working until the trial ends.</p><form method="post"><button>Stop trial emails</button></form>',
  );
}
