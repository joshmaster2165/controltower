import { test, expect } from '@playwright/test';
import http from 'node:http';
import { CT, admin } from './support/admin';

/**
 * Updates: the release feed (served here, where CT_UPDATE_URL points in the test server) says a newer version with a
 * security fix is out; the console says so at the top and on the Updates page, with how to update.
 */
test.describe.configure({ mode: 'serial' });

let feed: http.Server;
test.beforeAll(async () => {
  feed = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ schema: 1, latest: '99.1.0', releases: [{ version: '99.1.0', date: '2099-01-02', security: true, summary: 'Fix: a security problem in something.', notes: ['Upgrading: restart every instance.'], url: 'https://agentcontroltower.app/docs/changelog.html' }, { version: '99.0.0', date: '2099-01-01', summary: 'Many new things.' }, { version: '0.0.1', date: '2020-01-01' }] }));
  });
  await new Promise<void>((r) => feed.listen(4499, '127.0.0.1', () => r()));
  await admin.signIn();
});
test.afterAll(() => feed.close());

test('the check: newer versions, a security fix, and how to update here', async () => {
  const s = (await admin.post('/admin/api/updates/check')).body;
  expect(s).toMatchObject({ latest: '99.1.0', update_available: true, security: true, check: 'on', error: null });
  expect(s.newer.map((r: { version: string }) => r.version)).toEqual(['99.1.0', '99.0.0']);
  expect(s.how.platform).toBe('source');
  expect(s.data.database).toBe(process.env.E2E_DATABASE_URL ? 'postgres' : 'sqlite');
  // Admins only.
  const anon = await fetch(`${CT}/admin/api/updates`);
  expect(anon.status).toBe(401);
});

test('the console: a security banner, and the Updates page', async ({ page }) => {
  await page.context().addCookies(admin.cookie.split('; ').map((c) => ({ name: c.split('=')[0]!, value: c.split('=').slice(1).join('='), url: CT })));
  await page.goto(`${CT}/#/keys`);
  const banner = page.getByRole('status').filter({ hasText: 'Control Tower 99.1.0 is available' });
  await expect(banner).toContainText('Security update');
  await banner.getByRole('link', { name: /how to update/ }).click();
  await expect(page.getByRole('heading', { name: 'Updates' })).toBeVisible();
  await expect(page.getByText('security update', { exact: true })).toBeVisible();
  await expect(page.getByText('Fix: a security problem in something.')).toBeVisible();
  await expect(page.getByText('Upgrading: restart every instance.')).toBeVisible();
  await expect(page.getByRole('heading', { name: /Update to 99\.1\.0/ })).toBeVisible();
  await expect(page.getByText('The daily check sends only this version number.')).toBeVisible();
});
