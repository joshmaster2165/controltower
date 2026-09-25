import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { OUT, nav, shot, startServer } from './helpers';
import { mcpUpstream, openAiUpstream, type Upstream } from '../../e2e/support/upstreams';
import { field } from '../../e2e/support/ui';
import { smtpCapture } from '../../e2e/support/smtp';

/**
 * Drives real Control Tower servers through the steps the docs describe and
 * saves what the console shows. Local stand-ins are used only where a real
 * service would sit on this machine anyway (Ollama on :11434, an MCP server
 * on :3001), so every screenshot is exactly what a user sees.
 */
test.describe.configure({ mode: 'serial' });

// ------------------------------------------------------------ a fresh install
test('fresh install: first run, a provider, a key, the first request', async ({ page }) => {
  const ollama: Upstream = await openAiUpstream({ port: 11434, models: ['llama3.2', 'qwen2.5:7b', 'nomic-embed-text'], reply: 'Hi! I am running on your own machine through Control Tower.' });
  const files = await mcpUpstream('files-token', 3001);
  const ct = await startServer(4000, {});
  try {
    // First run: create the admin account.
    await page.goto(ct.url);
    await expect(page.getByRole('heading', { name: /Set up your tower/ })).toBeVisible();
    await field(page, /^Email/).fill('you@example.com');
    await field(page, /^Password/).fill('a-long-admin-password');
    await shot(page, 'setup-admin');
    await page.getByRole('button', { name: /Create admin/ }).click();

    // Get started: three steps.
    await expect(page.getByRole('heading', { name: 'Get started' })).toBeVisible();
    await shot(page, 'get-started');

    // Providers: the catalogue, then the OpenAI form as you'd fill it in.
    await nav(page, 'Providers');
    await page.waitForTimeout(400);
    await shot(page, 'providers-catalog');
    await page.locator('button.card', { hasText: 'OpenAI' }).first().click();
    const form = page.locator('form.card');
    await field(form, /^API key$/).fill('sk-proj-••••••••••••••••••••');
    await shot(page, 'provider-openai-form', { clip: form });
    await form.getByRole('button', { name: 'Cancel' }).click().catch(() => page.keyboard.press('Escape'));

    // A local Ollama, connected for real.
    await nav(page, 'Providers');
    await page.locator('button.card', { hasText: 'Ollama' }).first().click();
    await field(page.locator('form.card'), /^Base URL$/).fill('http://localhost:11434/v1');
    await page.locator('form.card').getByRole('button', { name: /Connect & test/ }).click();
    await expect(page.getByText(/Connected in \d+ ms/).first()).toBeVisible();
    await shot(page, 'provider-connected');

    // Keys: create one for an agent, and the connect panel it opens.
    await nav(page, 'Keys');
    await page.getByRole('button', { name: 'Create key', exact: true }).click();
    await field(page, /Name \(agent\)/).fill('support-bot');
    await field(page, /^Team/).fill('support');
    await field(page, /Monthly budget/).fill('50');
    await shot(page, 'key-create', { clip: page.locator('form.card') });
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.locator('.keybox')).toBeVisible();
    const secret = (await page.locator('.keybox').innerText()).trim();
    await expect(page.locator('.connect-status')).toContainText("Waiting for this agent's first request");
    await shot(page, 'key-connect-panel');

    // The agent's first request (what the OpenAI SDK sends), and the panel turns green.
    const r = await fetch(`${ct.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'llama3.2', messages: [{ role: 'user', content: 'Where are you running?' }] }),
    });
    expect(r.status).toBe(200);
    await expect(page.locator('.connect-status')).toContainText('Connected');
    await shot(page, 'key-connected', { clip: page.locator('.connect-agent') });

    // Playground.
    await nav(page, 'Playground');
    await field(page, /^Model$/).selectOption('llama3.2');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('pre').first()).toContainText('own machine');
    await shot(page, 'playground');

    // Models: added on first use.
    await nav(page, 'Models');
    await page.waitForTimeout(300);
    await shot(page, 'models');

    // MCP: register a tool server.
    await nav(page, 'MCP servers');
    await page.getByRole('button', { name: /Add server/ }).click();
    await field(page, /^Name$/).fill('Files');
    await field(page, /^Slug/).fill('files');
    await field(page, /Streamable HTTP endpoint/).fill('http://localhost:3001/mcp');
    await field(page, /^Auth$/).selectOption('bearer');
    await field(page, /^Token/).fill('files-token');
    await shot(page, 'mcp-add', { clip: page.locator('form.card') });
    await page.getByRole('button', { name: 'Add & test' }).click();
    await expect(page.getByText('read_file').first()).toBeVisible();
    await shot(page, 'mcp-server');

    // Flights and the map with the first agent on it.
    await nav(page, 'Flights');
    await page.waitForTimeout(500);
    await shot(page, 'flights');
    await nav(page, 'Airspace');
    await page.waitForTimeout(2500);
    await page.evaluate(() => (window as unknown as { __ctScene?: { fit(): void } }).__ctScene?.fit());
    await page.waitForTimeout(600);
    await shot(page, 'airspace-first-agent');
  } finally {
    await ct.stop();
    await ollama.close();
    await files.close();
  }
});

// ------------------------------------------------------------ the demo fleet
const ADMIN_KEY = 'docs-screenshots-admin-key-0123456789';

/** Screen position of a station on the Airspace canvas (dx/dy in map units from its top-left corner). */
async function stationAt(page: Page, label: string, dx = 60, dy = 20): Promise<[number, number]> {
  let pt: [number, number] | null = null;
  await expect
    .poll(async () => {
      pt = await page.evaluate(
        ([l, x, y]) => {
          const s = (window as unknown as { __ctScene?: any }).__ctScene;
          const st = s ? [...s.stations.values()].find((v: any) => v.label === l) : undefined;
          if (!st) return null;
          const c = s.getCamera();
          const r = s.canvas.getBoundingClientRect();
          return [(st.x + x) * c.k + c.x + r.left, (st.y + y) * c.k + c.y + r.top] as [number, number];
        },
        [label, dx, dy] as const,
      );
      return pt !== null;
    })
    .toBe(true);
  return pt!;
}

test('demo fleet: the map, gates, approvals, zones, alerts, spend', async ({ page }) => {
  const ct = await startServer(4000, { CT_DEMO: '1', CT_ADMIN_KEY: ADMIN_KEY });
  const hideToasts = () => page.addStyleTag({ content: '.toasts { display: none !important; }' });
  try {
    await page.goto(ct.url);
    await field(page, /^Email or username/).fill('admin');
    await field(page, /^Password/).fill(ADMIN_KEY);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('link', { name: 'Airspace', exact: true })).toBeVisible();
    await nav(page, 'Airspace');
    await hideToasts();
    await page.waitForTimeout(20_000); // let the fleet build up traffic
    const fit = () => page.evaluate(() => (window as unknown as { __ctScene: { fit(): void } }).__ctScene.fit());
    await fit();
    await shot(page, 'airspace');

    // Flight Recorder: the last hour played back.
    await page.getByRole('button', { name: 'Replay' }).click();
    const bar = page.locator('.replay');
    await expect(bar).toContainText(/of [\d,]+ flights/);
    await bar.getByLabel('Speed').selectOption('10');
    await page.waitForTimeout(2500);
    await shot(page, 'replay');
    await bar.getByRole('button', { name: 'Back to live' }).click();
    await page.waitForTimeout(800);

    // Trace one agent.
    const [ax, ay] = await stationAt(page, 'support-triage');
    await page.mouse.click(ax, ay);
    await page.waitForTimeout(700);
    await shot(page, 'airspace-trace');
    await page.keyboard.press('Escape');

    // A gate: drag from the agent to a tool server, pick the tool and the effect.
    await page.getByRole('button', { name: 'Add gate' }).click();
    const [sx, sy] = await stationAt(page, 'support-triage');
    const [tx, ty] = await stationAt(page, 'Salesforce', 50, 16);
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(tx, ty, { steps: 12 });
    await page.mouse.up();
    const pop = page.locator('.popover').filter({ hasText: 'New gate' });
    const tool = pop.locator('select').nth(2);
    const opt = (await tool.locator('option').allTextContents()).find((o) => o.includes('search_contacts'))!;
    await tool.selectOption({ label: opt });
    await pop.getByRole('button', { name: 'Require approval', exact: true }).click();
    await shot(page, 'gate-composer', { clip: pop, pad: 8 });
    await pop.getByRole('button', { name: 'Inspect', exact: true }).click();
    await page.waitForTimeout(300);
    await shot(page, 'gate-inspect', { clip: pop, pad: 8 });
    await pop.getByRole('button', { name: 'Block', exact: true }).first().click();
    await pop.getByRole('button', { name: /Simulate on last 24 h/ }).click();
    await expect(pop.getByRole('button', { name: /Simulate again/ })).toBeVisible();
    await pop.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await page.waitForTimeout(500);
    await shot(page, 'gate-simulate', { clip: pop, pad: 8 });
    await pop.getByRole('button', { name: 'Require approval', exact: true }).click();
    const add = pop.getByRole('button', { name: 'Add gate', exact: true });
    await add.scrollIntoViewIfNeeded();
    await add.click();
    await page.getByRole('button', { name: 'Add gate', exact: true }).first().click(); // leave add-gate mode

    // The held call, in the approvals drawer and in the Tower.
    await page.getByRole('button', { name: /^Approvals/ }).click();
    await expect(page.locator('.tower-drawer .approval').filter({ hasText: 'support-triage' }).first()).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(400);
    await shot(page, 'approvals-drawer');
    await nav(page, 'Tower');
    await hideToasts();
    await page.waitForTimeout(600);
    await shot(page, 'tower');

    // A zone: lasso two agents.
    await nav(page, 'Airspace');
    if (await page.locator('.tower-drawer').isVisible()) await page.getByRole('button', { name: /^Approvals/ }).click();
    await hideToasts();
    await page.waitForTimeout(1200);
    await fit();
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: 'Draw zone' }).click();
    const [m1x, m1y] = await stationAt(page, 'market-research', -12, -12);
    const [m2x, m2y] = await stationAt(page, 'support-triage', 220, 60);
    await page.mouse.move(m1x, m1y);
    await page.mouse.down();
    for (const [x, y] of [[m2x, m1y], [m2x, m2y], [m1x, m2y], [m1x, m1y]]) await page.mouse.move(x!, y!, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    const zonePop = page.locator('.popover').last();
    await zonePop.locator('input').first().fill('Customer-facing agents');
    await shot(page, 'zone-create');
    await page.keyboard.press('Escape');

    // Policy as YAML.
    await page.getByRole('button', { name: 'Export' }).click();
    await shot(page, 'export-menu', { clip: page.locator('.menu'), pad: 8 });
    await page.getByRole('menuitem', { name: /Import policy/ }).click();
    await page.getByLabel('Policy YAML').fill('zones:\n  - name: Customer-facing agents\n    members: [agent:support-triage, agent:market-research]\ngates:\n  - name: Customer-facing agents never merge code\n    from: Customer-facing agents\n    target: tool\n    match: { servers: [github], tools: [github__merge_pr] }\n    effect: deny\n');
    await page.getByRole('button', { name: 'Preview' }).click();
    await expect(page.getByRole('button', { name: /^Apply/ })).toBeVisible();
    await shot(page, 'policy-import', { clip: page.locator('.pi'), pad: 8 });
    await page.getByRole('button', { name: 'Close' }).click();

    // Monitoring pages.
    for (const [link, name] of [['Alerts', 'alerts'], ['Ledger', 'ledger'], ['Inventory', 'inventory'], ['Flights', 'flights-demo'], ['Models', 'models-aliases'], ['Keys', 'keys'], ['HTTP APIs', 'http-apis'], ['MCP servers', 'mcp-servers-demo']] as const) {
      await nav(page, link);
      await hideToasts();
      await page.waitForTimeout(900);
      await shot(page, name);
    }

    // Email approvals: the channel form, and a real approval email as it arrives.
    const smtp = await smtpCapture();
    try {
      await nav(page, 'Alerts');
      await hideToasts();
      await page.getByRole('button', { name: 'Add channel' }).click();
      const form = page.locator('.card').filter({ has: page.getByRole('button', { name: 'Add channel', exact: true }) }).filter({ hasText: 'Recipients' }).or(page.locator('.card').filter({ has: page.getByRole('button', { name: 'Add channel', exact: true }) }).filter({ hasText: 'Webhook' })).first();
      await form.getByRole('button', { name: 'Email', exact: true }).click();
      await field(form, /^Name$/).fill('Security on-call');
      await field(form, /^Recipients/).fill('oncall@example.com, security@example.com');
      await field(form, /^SMTP host/).fill('smtp.example.com');
      await field(form, /^Port/).fill('587');
      await field(form, /^Username/).fill('tower@example.com');
      await field(form, /^Password/).fill('app-password');
      await field(form, /^From/).fill('Control Tower <tower@example.com>');
      await page.setViewportSize({ width: 1280, height: 1100 });
      await form.scrollIntoViewIfNeeded();
      await shot(page, 'email-channel', { clip: form, pad: 8 });
      await page.setViewportSize({ width: 1280, height: 800 });
      // Deliver to the local test server instead.
      await field(form, /^SMTP host/).fill('127.0.0.1');
      await field(form, /^Port/).fill(String(smtp.port));
      await field(form, /^Username/).fill('');
      await field(form, /^Password/).fill('');
      await form.getByRole('button', { name: 'Add channel', exact: true }).click();
      await expect(page.locator('.channel', { hasText: 'Security on-call' })).toBeVisible();
      const channelId = await page.evaluate(async () => {
        const r = await (await fetch('/admin/api/alert-channels')).json();
        return r.channels.find((c: { name: string }) => c.name === 'Security on-call').id as string;
      });
      await page.evaluate(async (ch) => {
        const me = await (await fetch('/admin/api/me')).json();
        const policy = await (await fetch('/admin/api/policy')).json();
        const gate = policy.rules.find((g: { name: string }) => /Salesforce contact/i.test(g.name)).id as string;
        const r = await fetch('/admin/api/alert-rules', { method: 'POST', headers: { 'x-ct-csrf': me.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'gate', rule_id: gate, triggers: ['held'], threshold: 1, window_s: 300, cooldown_s: 0, channels: [ch], name: 'Contact deletions by email' }) });
        return `${r.status} ${await r.text()}`;
      }, channelId).then((r) => expect(r).toMatch(/^201/));
      await expect.poll(() => smtp.messages.filter((m) => m.subject?.startsWith('[Approval needed]')).length, { timeout: 90_000 }).toBeGreaterThan(0);
      const mail = smtp.messages.find((m) => m.subject?.startsWith('[Approval needed]'))!;
      const inbox = await page.context().newPage();
      await inbox.setViewportSize({ width: 720, height: 460 });
      await inbox.setContent(String(mail.html));
      await inbox.screenshot({ path: path.join(OUT, 'email-approval.png'), fullPage: true });
      await inbox.close();
    } finally {
      await smtp.close();
    }

    // A team budget from the Ledger.
    await nav(page, 'Ledger');
    await hideToasts();
    const card = page.locator('.budgets-card');
    await card.getByRole('button', { name: 'Add budget' }).click();
    await card.locator('.field', { hasText: 'Team' }).locator('input').fill('sales');
    await field(card, /^Limit/).fill('25');
    await card.scrollIntoViewIfNeeded();
    await shot(page, 'budget-add', { clip: card, pad: 8 });
    await card.getByRole('button', { name: 'Add budget' }).click();
    await expect(card).toContainText('Team sales');
    await shot(page, 'budgets', { clip: card, pad: 8 });

    // The connect panel's other tabs.
    await nav(page, 'Keys');
    await page.getByRole('button', { name: 'Create key', exact: true }).click();
    await field(page, /Name \(agent\)/).fill('coding-agent');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    const panel = page.locator('.connect-agent');
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: /MCP clients/ }).click();
    await shot(page, 'connect-mcp', { clip: panel });

    // Config file import.
    await nav(page, 'Models');
    await page.getByRole('button', { name: /Import config/ }).click();
    await page.locator('.import-card textarea').fill('model_list:\n  - model_name: gpt-4o\n    params:\n      model: openai/gpt-4o\n      api_key: os.environ/OPENAI_API_KEY\n  - model_name: claude-sonnet\n    params:\n      model: anthropic/claude-sonnet-4-5\n      api_key: os.environ/ANTHROPIC_API_KEY\nsettings:\n  fallbacks: [{"gpt-4o": ["claude-sonnet"]}]\n');
    await page.getByRole('button', { name: 'Preview import' }).click();
    await page.waitForTimeout(700);
    await shot(page, 'config-import', { clip: page.locator('.import-card'), pad: 8 });
  } finally {
    await ct.stop();
  }
});
