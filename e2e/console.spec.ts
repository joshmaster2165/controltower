import { test, expect, type Page, type Locator } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

/**
 * End-to-end: first boot → connect Gemini, Bedrock and Vertex (against fake
 * upstreams) → add models → send playground requests through each → keys →
 * flights → Airspace renders. Runs against the production bundle + built console.
 */
let fakes: ChildProcess;
let urls: { gemini: string; bedrock: string; vertex: string; serviceAccount: string };

test.beforeAll(async () => {
  fakes = spawn('npx', ['tsx', 'test/fakes-cli.ts'], { cwd: path.resolve('server'), stdio: ['ignore', 'pipe', 'inherit'] });
  urls = await new Promise((resolve, reject) => {
    let buf = '';
    fakes.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      const line = buf.split('\n').find((l) => l.startsWith('{'));
      if (line) resolve(JSON.parse(line));
    });
    fakes.on('exit', (c) => reject(new Error(`fakes exited ${c}`)));
  });
});
test.afterAll(() => {
  fakes?.kill('SIGTERM');
});

const EMAIL = 'e2e@example.com';
const PASSWORD = 'e2e-password-123';

/** Form controls are wrapped in `.field` with a plain <label>; find the control through its wrapper. */
function field(scope: Page | Locator, label: string | RegExp): Locator {
  const pg = 'page' in scope ? scope.page() : scope;
  return scope.locator('.field', { has: pg.locator('label', { hasText: label }) }).first().locator('input, select, textarea').first();
}

async function signIn(page: Page) {
  await page.goto('/');
  const setup = page.getByRole('heading', { name: /Set up your tower/ });
  const login = page.getByRole('heading', { name: /^Sign in$/ });
  await expect(setup.or(login)).toBeVisible();
  await field(page, /^Email$/).fill(EMAIL);
  await field(page, /^Password/).fill(PASSWORD);
  if (await setup.isVisible()) await page.getByRole('button', { name: /Create admin/ }).click();
  else await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('link', { name: 'Airspace' })).toBeVisible();
}

async function connectProvider(page: Page, card: string, fill: (form: Locator) => Promise<void>) {
  await page.getByRole('link', { name: 'Providers' }).click();
  await page.locator('button.card', { hasText: card }).click();
  const form = page.locator('form.card');
  await expect(form).toContainText(`Connect ${card}`);
  await fill(form);
  await form.getByRole('button', { name: /Connect & test/ }).click();
  await expect(page.getByText(/Connected in \d+ ms/).first()).toBeVisible({ timeout: 20_000 });
}

test('first boot, three cloud providers, playground round-trips, keys, flights, Airspace', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);

  // ---- Gemini ----
  await connectProvider(page, 'Google Gemini', async (f) => {
    await field(f, /^Base URL$/).fill(urls.gemini);
    await field(f, /^API key$/).fill('gem-key');
  });
  const geminiCard = page.locator('div.card', { hasText: 'Google Gemini' }).first();
  await geminiCard.getByRole('button', { name: '+ Add model' }).first().click();
  await expect(geminiCard.getByText('added', { exact: true })).toBeVisible();

  // ---- Bedrock (SigV4) ----
  await connectProvider(page, 'AWS Bedrock', async (f) => {
    await field(f, /^Access key ID$/).fill('AKIATEST12345');
    await field(f, /^Secret access key$/).fill('secret');
    await field(f, /^Region$/).fill('us-east-1');
    await field(f, /Endpoint override/).fill(urls.bedrock);
  });
  const bedrockCard = page.locator('div.card', { hasText: 'AWS Bedrock' }).first();
  const claudeRow = bedrockCard.locator('div', { hasText: /^anthropic\.claude-sonnet-4-5/ }).last();
  await claudeRow.getByRole('button', { name: '+ Add model' }).click();
  await expect(bedrockCard.getByText('added', { exact: true })).toBeVisible();

  // ---- Vertex (service-account JWT → OAuth token) ----
  await connectProvider(page, 'Google Vertex AI', async (f) => {
    await field(f, /Service account JSON/).fill(urls.serviceAccount);
    await field(f, /GCP project id/).fill('test-proj');
    await field(f, /^Location$/).fill('us-central1');
    await field(f, /Endpoint override/).fill(urls.vertex);
  });
  await page.getByRole('link', { name: 'Models' }).click();
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  const modelForm = page.locator('form.card');
  await field(modelForm, /^Provider$/).selectOption({ label: 'Google Vertex AI (vertex)' });
  await field(modelForm, /Upstream model id/).fill('gemini-2.5-pro');
  await field(modelForm, /Public name/).fill('vertex-gemini');
  await modelForm.getByRole('button', { name: 'Add model', exact: true }).click();
  await expect(page.locator('table.table').last()).toContainText('vertex-gemini'); // deployments (aliases come first)

  // ---- Playground through each provider ----
  const ask = async (model: string, expected: RegExp) => {
    await page.getByRole('link', { name: 'Playground' }).click();
    await field(page, /^Model$/).selectOption(model);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('pre').first()).toContainText(expected, { timeout: 20_000 });
    await expect(page.getByText(/status/).locator('b', { hasText: '200' })).toBeVisible();
  };
  await ask('gemini-2.5-flash', /Hello from Gemini/);
  await ask('anthropic.claude-sonnet-4-5', /Hello from Bedrock/);
  await ask('vertex-gemini', /Hello from Vertex/);

  // ---- Keys ----
  await page.getByRole('link', { name: 'Keys' }).click();
  await page.getByRole('button', { name: 'Create key', exact: true }).click();
  await field(page, /Name \(agent\)/).fill('e2e-agent');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('.keybox')).toContainText(/ct_sk_[0-9A-Za-z]{32}_[0-9A-Za-z]{6}/);

  // ---- Flights recorded with provider usage ----
  await page.getByRole('link', { name: 'Flights' }).click();
  await expect(page.locator('table.table')).toContainText('playground');
  await expect(page.locator('table.table')).toContainText('gemini-2.5-flash');
  await expect(page.locator('table.table')).toContainText('vertex-gemini');

  // ---- Airspace renders a WebGL canvas, live socket ----
  await page.getByRole('link', { name: 'Airspace' }).click();
  await expect(page.locator('.airspace canvas')).toBeVisible();
  await expect(page.locator('.legend .pill.live')).toBeVisible({ timeout: 15_000 });

  // ---- Alerts: a rule on every gate, notifying the console ----
  await page.getByRole('link', { name: 'Alerts' }).click();
  await page.getByRole('button', { name: 'New alert' }).click();
  await field(page, /^Gate$/).selectOption({ label: 'Any gate' });
  await page.getByRole('button', { name: 'Add alert', exact: true }).click();
  await expect(page.locator('.rule-list')).toContainText('Alert on any gate');
  await expect(page.locator('.rule-list')).toContainText('Notifies Console');

  // Observed system → "Bring it inside" → HTTP API form pre-filled with its name and base URL.
  await page.evaluate(async () => {
    const me = await (await fetch('/admin/api/me')).json();
    const k = await (
      await fetch('/admin/api/keys', { method: 'POST', headers: { 'x-ct-csrf': me.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'side-door-agent' }) })
    ).json();
    await fetch('/v1/observe', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + k.key },
      body: JSON.stringify({ events: [{ target: 'https://api.github.com/repos', count: 3 }] }),
    });
  });
  await page.getByRole('link', { name: 'Airspace' }).click();
  await page.reload();
  const cardAt = () =>
    page.evaluate(() => {
      const s = (window as unknown as { __ctScene: any }).__ctScene;
      s.fit();
      const st = [...s.stations.values()].find((x: any) => x.label === 'GitHub');
      if (!st) return null;
      const c = s.getCamera();
      const r = s.canvas.getBoundingClientRect();
      return [(st.x + 40) * c.k + c.x + r.left, (st.y + 16) * c.k + c.y + r.top] as [number, number];
    });
  await expect.poll(cardAt).not.toBeNull();
  const at = (await cardAt())!;
  await page.mouse.click(at[0], at[1]);
  await expect(page.locator('.bring-inside')).toContainText('Bring GitHub inside');
  await page.locator('.bring-inside').getByRole('button', { name: 'Register GitHub' }).click();
  await expect(field(page, /^Name$/)).toHaveValue('GitHub');
  await expect(field(page, /^Base URL$/)).toHaveValue('https://api.github.com');
  await expect(page).toHaveURL(/#\/http$/);
});

/** GET without URL normalisation, so `..` reaches the server exactly as written. */
function rawGet(path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: 4400, path, method: 'GET', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    r.on('error', reject);
    r.end();
  });
}

test('HTTP APIs: register, call through the gateway, gate deletes', async ({ page }) => {
  // A tiny upstream that records exactly what reaches it.
  const seen: Array<{ method: string; url: string; auth: string | undefined; ctKey: string | undefined }> = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, ctKey: req.headers['x-ct-key'] as string | undefined });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const port = (upstream.address() as AddressInfo).port;
  try {
    await signIn(page);
    await page.getByRole('link', { name: 'HTTP APIs' }).click();
    await page.getByRole('button', { name: 'Add API' }).click();
    await field(page, /^Name$/).fill('Orders API');
    await field(page, /^Base URL$/).fill(`http://127.0.0.1:${port}/v1`);
    await field(page, /^Credentials$/).selectOption('bearer');
    await field(page, /^Token/).fill('upstream-secret');
    await page.getByRole('button', { name: 'Add & test' }).click();
    await expect(page.locator('.provider-card', { hasText: 'Orders API' })).toContainText('reachable');

    const { key, csrf } = await page.evaluate(async () => {
      const me = await (await fetch('/admin/api/me')).json();
      const k = await (await fetch('/admin/api/keys', { method: 'POST', headers: { 'x-ct-csrf': me.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'orders-agent', team: 'ops' }) })).json();
      return { key: k.key as string, csrf: me.csrf as string };
    });
    const base = 'http://127.0.0.1:4400/http/orders-api';

    // A read goes through with the API's stored credentials — never the agent's own key.
    const r1 = await fetch(`${base}/orders/8812?expand=items`, { headers: { authorization: `Bearer ${key}` } });
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ ok: true, path: '/v1/orders/8812?expand=items' });
    expect(seen.at(-1)).toMatchObject({ method: 'GET', auth: 'Bearer upstream-secret', ctKey: undefined });
    expect(JSON.stringify(seen)).not.toContain(key);

    // Climbing out of the base URL is refused before anything is sent.
    const before = seen.length;
    expect(await rawGet('/http/orders-api/../../admin/api/keys', { 'x-ct-key': key })).toBe(400);
    expect(await rawGet('/http/orders-api/%2e%2e/admin', { 'x-ct-key': key })).toBe(400);
    expect(seen.length).toBe(before);

    // A deny gate on deletes applies to the very next call.
    const rule = await page.evaluate(
      async (c) =>
        (
          await fetch('/admin/api/rules', {
            method: 'POST',
            headers: { 'x-ct-csrf': c, 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'Agents never delete orders', target_kind: 'tool', match: { tools: ['orders-api__DELETE *'] }, effect: 'deny', config: { reason: 'Orders are never deleted by agents' }, priority: 5 }),
          })
        ).status,
      csrf,
    );
    expect(rule).toBe(201);
    const r3 = await fetch(`${base}/orders/8812`, { method: 'DELETE', headers: { 'x-ct-key': key } });
    expect(r3.status).toBe(403);
    expect((await r3.json()).error.code).toBe('policy_denied');
    expect(seen.length).toBe(before);

    // Both calls are flights, named by route.
    await page.getByRole('link', { name: 'Flights' }).click();
    await expect(page.locator('table').first()).toContainText('GET /orders/:id');
    await expect(page.locator('table').first()).toContainText('DELETE /orders/:id');
  } finally {
    upstream.close();
  }
});
