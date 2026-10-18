/**
 * The showcase's daily check (the deployed demo the website's tour and the posts are recorded from). It keeps the
 * story alive (the finance agent's calls, so its High exfiltration risk stays in the 24-hour window) and checks:
 * it answers; it runs the latest release; the demo fleet is sending traffic; the High risk shows; the audit chain
 * holds; the update check works; there's room on its disk for the next update's backup.
 *
 *   SHOWCASE_URL=… SHOWCASE_ADMIN_KEY=… SHOWCASE_FINANCE_KEY=… npx tsx scripts/showcase/health.mts
 * Writes a Markdown summary to $GITHUB_STEP_SUMMARY (and showcase-health.md); exits 1 if anything is off.
 */
import fs from 'node:fs';

const CT = (process.env.SHOWCASE_URL ?? 'https://showcase-production-b625.up.railway.app').replace(/\/+$/, '');
const AK = process.env.SHOWCASE_ADMIN_KEY ?? '';
const FIN = process.env.SHOWCASE_FINANCE_KEY ?? '';
if (!AK) throw new Error('SHOWCASE_ADMIN_KEY is needed');
const checks: Array<{ what: string; pass: boolean; detail: string }> = [];
const c = (what: string, pass: boolean, detail = '') => {
  checks.push({ what, pass, detail });
  console.log(`${pass ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`);
};
const get = async (p: string, key = AK) => {
  const r = await fetch(CT + p, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const gb = (n: number) => `${(n / 1073741824).toFixed(2)} GB`;

try {
  const health = await fetch(`${CT}/healthz`, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
  c('it answers', !!health?.ok, health ? String(health.status) : 'no answer');

  // Keep the story: the finance agent reads the billing ledger and posts to the partner webhook.
  if (FIN) {
    let ok = 0;
    for (let i = 0; i < 3; i++) for (const api of ['billing-ledger', 'partner-webhook']) ok += (await fetch(`${CT}/http/${api}/healthz`, { headers: { authorization: `Bearer ${FIN}` } }).catch(() => null))?.ok ? 1 : 0;
    c("the finance agent's calls go through (they keep its High risk on the Classes view)", ok === 6, `${ok} of 6`);
  }

  const status = (await get('/admin/api/status')).body;
  const feed = (await (await fetch('https://agentcontroltower.app/releases.json')).json().catch(() => ({}))) as { latest?: string };
  c('it runs the latest release', !!feed.latest && status.version === feed.latest, `${status.version} (latest ${feed.latest ?? 'unknown'})`);
  c('the demo fleet is on', status.demo === true);

  const flights = ((await get('/admin/api/flights?limit=500')).body.flights ?? []) as Array<{ ts: number }>;
  const recent = flights.filter((f) => f.ts > Date.now() - 10 * 60_000).length;
  c('traffic in the last 10 minutes', recent >= 50, `${recent} calls`);

  await new Promise((r) => setTimeout(r, 2000));
  const classes = (await get('/admin/api/airspace/classes')).body;
  const high = (classes.risks ?? []).filter((r: { level: string }) => r.level === 'high' || r.level === 'critical').length;
  c('Classes shows a High exfiltration risk (the story the videos tell)', high >= 1, `${high} High or Critical of ${(classes.risks ?? []).length} risks`);

  const audit = (await get('/admin/api/audit/verify')).body;
  c('the audit chain holds', audit.ok === true, `${audit.events} events${audit.ok ? '' : `: ${audit.reason}`}`);

  const up = (await get('/admin/api/updates')).body;
  c('the update check works', up.check === 'on' && !up.error && !!up.checked_at, up.error ?? `checked ${up.checked_at ? new Date(up.checked_at).toISOString() : 'never'}`);
  const st = up.data?.storage;
  c("room on the disk for the next update's backup", st?.room_for_backup === true, st ? `${gb(st.database_in_use)} in use, file ${gb(st.database_file)}, ${gb(st.disk_free)} free of ${gb(st.disk_total)}; a backup needs ${gb(st.backup_needs)}` : 'no storage report');
} catch (err) {
  c('the check ran', false, (err as Error).message);
} finally {
  const failed = checks.filter((x) => !x.pass);
  const md = `### Showcase health: ${failed.length ? `${failed.length} problem${failed.length === 1 ? '' : 's'}` : 'all good'}\n\n${CT}\n\n${checks.map((x) => `- ${x.pass ? '✅' : '❌'} ${x.what}${x.detail ? ` — ${x.detail}` : ''}`).join('\n')}\n`;
  fs.writeFileSync('showcase-health.md', md);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  process.exitCode = failed.length ? 1 : 0;
}
