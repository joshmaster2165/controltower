import { test, expect, type Page } from '@playwright/test';
import { CT, admin } from './support/admin';

/**
 * Every page of the console, as every role: no script errors, no console errors, and no request the page makes
 * fails (a 5xx, or a 4xx the role should never be shown). Catches the pages nobody has opened in a while.
 */
test.describe.configure({ mode: 'serial' });

const ROUTES = ['airspace', 'tower', 'requests', 'alerts', 'report', 'ledger', 'flights', 'exports', 'providers', 'models', 'keys', 'agent-identity', 'laptops', 'mcp', 'http', 'a2a', 'secret-managers', 'guardrails', 'users', 'teams', 'regions', 'audit', 'compliance', 'license', 'updates', 'welcome', 'playground'];
const MODES = ['map', 'matrix', 'classes', 'coverage', 'reach'];
const run = Date.now().toString(36);

/** Sign a person in (made by the admin with a role, their first password changed) and hand the browser their session. */
async function as(page: Page, role: 'admin' | 'approver' | 'viewer' | 'member') {
  if (role === 'admin') {
    await page.context().addCookies(admin.cookie.split('; ').map((c) => ({ name: c.split('=')[0]!, value: c.split('=').slice(1).join('='), url: CT })));
    return;
  }
  const email = `sweep-${role}-${run}@example.com`;
  let password: string;
  if (role === 'member') {
    const teams = (await admin.get('/admin/api/teams')).body.teams as Array<{ id: string; name: string }>;
    const team = teams.find((t) => t.name === `sweep-${run}`) ?? (await admin.post('/admin/api/teams', { name: `sweep-${run}` })).body.team ?? (await admin.get('/admin/api/teams')).body.teams.find((t: { name: string }) => t.name === `sweep-${run}`);
    password = (await admin.put(`/admin/api/teams/${team.id}/members`, { email, role: 'member' })).body.password;
  } else password = (await admin.post('/admin/api/users', { email, role })).body.password;
  const login = async (pw: string) => {
    const r = await fetch(`${CT}/admin/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: pw }) });
    return { cookie: r.headers.getSetCookie().map((x) => x.split(';')[0]).join('; '), csrf: ((await r.json()) as { csrf: string }).csrf };
  };
  let s = await login(password);
  await fetch(`${CT}/admin/api/me/password`, { method: 'POST', headers: { cookie: s.cookie, 'x-ct-csrf': s.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ current: password, password: `${password}-sweep` }) });
  s = await login(`${password}-sweep`);
  await page.context().addCookies(s.cookie.split('; ').map((c) => ({ name: c.split('=')[0]!, value: c.split('=').slice(1).join('='), url: CT })));
}

test.beforeAll(async () => {
  await admin.signIn();
});

for (const role of ['admin', 'approver', 'viewer', 'member'] as const) {
  test(`every page as ${role === 'admin' || role === 'approver' ? 'an' : 'a'} ${role}: no errors`, async ({ page }) => {
    test.setTimeout(180_000);
    await as(page, role);
    const problems: string[] = [];
    let where = '';
    page.on('pageerror', (e) => problems.push(`${where}: script error: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(`${where}: console: ${m.text().slice(0, 200)}`);
    });
    page.on('response', (r) => {
      const u = new URL(r.url());
      if (!u.pathname.startsWith('/admin/api/')) return;
      const s = r.status();
      // 5xx is always wrong. A 4xx means the page asked for something its role can't have, or that isn't there.
      if (s >= 500 || (s >= 400 && s !== 401)) problems.push(`${where}: ${r.request().method()} ${u.pathname}${u.search} → ${s}`);
    });
    await page.goto(`${CT}/`);
    await page.getByRole('link', { name: 'Airspace', exact: true }).first().waitFor({ timeout: 15000 });
    for (const route of ROUTES) {
      where = route;
      await page.goto(`${CT}/#/${route}`);
      await page.waitForTimeout(900);
    }
    for (const mode of MODES) {
      where = `airspace/${mode}`;
      await page.evaluate((m) => localStorage.setItem('ct.airspace.mode', m), mode);
      await page.goto(`${CT}/#/airspace`);
      await page.reload();
      await page.waitForTimeout(1500);
    }
    await page.evaluate(() => localStorage.setItem('ct.airspace.mode', 'map'));
    expect(problems, problems.join('\n')).toEqual([]);
  });
}
