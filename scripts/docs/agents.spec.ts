import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openAiUpstream, subAgentUpstream } from '../../e2e/support/upstreams';
import { field } from '../../e2e/support/ui';
import { nav, shot, startServer } from './helpers';

/**
 * Screenshots for docs/agent-to-agent.md, from a real exchange: support-bot
 * calls research-agent — an agent exposed as an MCP tool, registered as
 * fronting that agent — and research-agent's tool asks a model through
 * Control Tower with its own delegated-only key, passing the delegation
 * token on. The model is a local stand-in.
 */
test.describe.configure({ mode: 'serial' });

const ADMIN_KEY = 'docs-admin-key-0123456789';

test('agents calling agents', async ({ page }) => {
  const oai = await openAiUpstream({ reply: 'Refunds within 30 days, no questions asked.', models: ['gpt-4.1-mini'] });
  const ct = await startServer(4710, { CT_ADMIN_KEY: ADMIN_KEY });
  const admin = (p: string, body?: unknown) =>
    fetch(`${ct.url}${p}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${ADMIN_KEY}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }).then((r) => r.json());
  let researchKey = '';
  const sub = await subAgentUpstream(async (question, token) => {
    const r = await fetch(`${ct.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${researchKey}`, 'content-type': 'application/json', ...(token ? { 'x-ct-delegation': token } : {}) },
      body: JSON.stringify({ model: 'gpt-4.1-mini', messages: [{ role: 'user', content: question }] }),
    });
    const j = (await r.json()) as { choices?: Array<{ message: { content: string } }> };
    return j.choices?.[0]?.message.content ?? `error ${r.status}`;
  });
  try {
    await admin('/admin/api/providers', { catalog_id: 'custom', name: 'OpenAI', slug: 'openai', base_url: `${oai.url}/v1`, credentials: { api_key: 'sk-docs' } });

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(ct.url);
    await field(page, /^Email or username/).fill('admin');
    await field(page, /^Password/).fill(ADMIN_KEY);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('link', { name: 'Keys' })).toBeVisible();

    // The research agent's key: it only acts on behalf of others.
    await nav(page, 'Keys');
    await page.getByRole('button', { name: 'Create key', exact: true }).click();
    const keyForm = page.locator('form.card');
    await field(page, /Name \(agent\)/).fill('research-agent');
    await field(page, /^Team/).fill('research');
    const onlyFor = keyForm.locator('.check-row');
    await onlyFor.locator('input').check();
    await shot(page, 'a2a-key-delegated', { clip: keyForm, el: onlyFor });
    await keyForm.getByRole('button', { name: 'Create', exact: true }).click();
    const card = page.locator('.card', { has: page.locator('.keybox') });
    await expect(card).toContainText('Key created: research-agent');
    researchKey = (await card.locator('.keybox').innerText()).trim();

    // The research agent's MCP server, registered as fronting that agent.
    await nav(page, 'MCP servers');
    await page.getByRole('button', { name: /Add server/ }).click();
    const form = page.locator('form.card');
    await field(form, /^Name$/).fill('Research agent');
    await field(form, /^Slug/).fill('research');
    await field(form, /Streamable HTTP endpoint/).fill(`${sub.url}/mcp`);
    const fronts = field(form, /Fronts an agent/);
    await fronts.fill('research-agent');
    await shot(page, 'a2a-server-form', { clip: form, el: fronts });
    await form.getByRole('button', { name: /Add & test/ }).click();
    await expect(page.getByText('Research agent').first()).toBeVisible();

    // support-bot asks the research agent a few questions, and talks to a model itself.
    const bot = (await admin('/admin/api/keys', { name: 'support-bot', team: 'support' })) as { key: string };
    const client = new Client({ name: 'support-bot', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${ct.url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${bot.key}` } } }));
    for (const q of ['What is the refund policy?', 'Do refunds cover shipping?', 'Can a refund go to a different card?']) {
      const r = (await client.callTool({ name: 'research__ask', arguments: { question: q } })) as { content: Array<{ text: string }> };
      expect(r.content[0]!.text).toContain('Refunds within 30 days');
    }
    await client.close();
    await fetch(`${ct.url}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${bot.key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'hi' }] }) });

    // Flights: the research agent's model calls, made for support-bot.
    await nav(page, 'Flights');
    const row = page.locator('table.table tbody tr', { hasText: 'for support-bot' }).first();
    await expect(row).toBeVisible();
    await shot(page, 'a2a-flights', { el: row.locator('td').nth(1) });

    // The map: support-bot → research-agent, and research-agent's own traffic.
    await nav(page, 'Airspace');
    await page.waitForTimeout(1200);
    await page.evaluate(() => (window as unknown as { __ctScene: { fit(): void } }).__ctScene.fit());
    await page.waitForTimeout(500);
    await shot(page, 'a2a-map');
    // Trace the research agent: called by support-bot.
    const at = await page.evaluate(() => {
      const s = (window as unknown as { __ctScene: { stations: Map<string, { label: string; kind: string; x: number; y: number; headH: number }>; getCamera(): { x: number; y: number; k: number }; canvas: HTMLCanvasElement } }).__ctScene;
      const st = [...s.stations.values()].find((x) => x.label === 'research-agent' && x.kind === 'agent')!;
      const c = s.getCamera();
      const r = s.canvas.getBoundingClientRect();
      return [(st.x + 40) * c.k + c.x + r.left, (st.y + st.headH / 2) * c.k + c.y + r.top] as const;
    });
    await page.mouse.click(at[0], at[1]);
    await expect(page.locator('.focus-panel')).toContainText('called by');
    await shot(page, 'a2a-trace');
  } finally {
    await ct.stop();
    await Promise.all([oai.close(), sub.close()]);
  }
});
