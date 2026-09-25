import { test, expect, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { anthropicUpstream, mcpUpstream, openAiUpstream } from '../../e2e/support/upstreams';
import { field } from '../../e2e/support/ui';
import { OUT, nav, shot, startServer } from './helpers';

/**
 * Screenshots for the client setup pages (docs/client-*.md), taken by doing
 * the setup for real: the actual Claude Code and Codex CLIs are pointed at a
 * fresh Control Tower and run, and their output is what the terminal images
 * show. The models behind the gateway are local stand-ins that speak the
 * Anthropic and OpenAI wire protocols, so no provider account is needed.
 *
 * Needs `claude` on the PATH (or CLAUDE_BIN) and, for the Codex images,
 * CODEX_BIN pointing at a Codex CLI (`npm i -g @openai/codex`).
 */
test.describe.configure({ mode: 'serial' });

const ADMIN_KEY = 'docs-admin-key-0123456789';
const REPLY = 'Connected through Control Tower — every call from this session is on the map and in Flights.';
const CLAUDE = process.env.CLAUDE_BIN ?? 'claude';
const CODEX = process.env.CODEX_BIN;

/** Run a CLI to completion (stdin closed), with a time limit; returns what it printed. */
function run(bin: string, args: string[], env: Record<string, string | undefined>, cwd: string, timeoutMs = 90_000): Promise<{ code: number | null; out: string; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { cwd, env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    const t = setTimeout(() => p.kill('SIGTERM'), timeoutMs);
    p.on('exit', (code) => {
      clearTimeout(t);
      resolve({ code, stdout: plain(stdout), stderr: plain(stderr), out: plain(stdout + stderr) });
    });
  });
}
/** Terminal colour codes out: the image draws its own colours. */
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** A terminal window with real commands and their real output, saved as a docs image. */
async function terminalShot(page: Page, name: string, title: string, steps: Array<{ cmd: string; out?: string }>): Promise<void> {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = steps.map((s) => `<div class="cmd"><span class="p">$</span> ${esc(s.cmd)}</div>${s.out ? `<pre>${esc(s.out.trimEnd())}</pre>` : ''}`).join('');
  const t = await page.context().newPage();
  await t.setViewportSize({ width: 1000, height: 800 });
  await t.setContent(`<!doctype html><html><head><style>
    body { margin: 0; padding: 24px; background: #eef2f7; font-family: -apple-system, 'Segoe UI', sans-serif; }
    .win { width: 900px; border-radius: 12px; overflow: hidden; box-shadow: 0 12px 40px rgba(15,27,45,.22); background: #0f1b2d; }
    .bar { display: flex; align-items: center; gap: 8px; padding: 11px 14px; background: #1c2a3f; color: #9fb0c8; font-size: 12.5px; }
    .bar i { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
    .bar span { margin-left: 10px; }
    .term { padding: 16px 20px 20px; font: 13px/1.55 'JetBrains Mono', ui-monospace, Menlo, monospace; color: #dbe4f0; }
    .cmd { color: #fff; white-space: pre-wrap; word-break: break-all; margin-top: 10px; }
    .cmd:first-child { margin-top: 0; }
    .p { color: #6ee7a8; }
    pre { margin: 4px 0 0; white-space: pre-wrap; word-break: break-word; color: #b8c6d9; font: inherit; }
  </style></head><body><div class="win"><div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i><span>${esc(title)}</span></div><div class="term">${body}</div></div></body></html>`);
  await t.locator('.win').screenshot({ path: path.join(OUT, `${name}.png`) });
  await t.close();
}

/** Show a key the way a person would share a screenshot of it: prefix and last four only. */
const mask = (text: string, key: string) => text.split(key).join(`${key.slice(0, 10)}…${key.slice(-4)}`);

async function createKey(page: Page, name: string, team: string, shotName?: string): Promise<string> {
  await nav(page, 'Keys');
  await page.getByRole('button', { name: 'Create key', exact: true }).click();
  const form = page.locator('form.card');
  await field(page, /Name \(agent\)/).fill(name);
  await field(page, /^Team/).fill(team);
  if (shotName) await shot(page, shotName, { clip: form, el: form.getByRole('button', { name: 'Create', exact: true }) });
  await form.getByRole('button', { name: 'Create', exact: true }).click();
  // Wait for this key's card: the previous key's card stays up until the new one replaces it.
  const card = page.locator('.card', { has: page.locator('.keybox') });
  await expect(card).toContainText(`Key created: ${name}`);
  return (await card.locator('.keybox').innerText()).trim();
}

test('client setup: Claude Code, Claude Desktop, Codex', async ({ page }) => {
  const ant = await anthropicUpstream({ reply: REPLY, models: ['claude-sonnet-4-5', 'claude-haiku-4-5'] });
  const oai = await openAiUpstream({ reply: REPLY, models: ['gpt-5', 'gpt-4.1-mini'] });
  const files = await mcpUpstream('files-token');
  const ct = await startServer(4700, { CT_ADMIN_KEY: ADMIN_KEY });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-clients-'));
  const admin = (p: string, body?: unknown) =>
    fetch(`${ct.url}${p}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${ADMIN_KEY}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }).then((r) => r.json());
  try {
    // Providers and a tool server, the way an admin would have them.
    await admin('/admin/api/providers', { catalog_id: 'anthropic', base_url: ant.url, credentials: { api_key: 'sk-ant-docs' } });
    await admin('/admin/api/providers', { catalog_id: 'custom', name: 'OpenAI', slug: 'openai', base_url: `${oai.url}/v1`, credentials: { api_key: 'sk-docs' } });
    await admin('/admin/api/mcp/servers', { name: 'Files', slug: 'files', url: `${files.url}/mcp`, auth: { type: 'bearer', token: 'files-token' } });

    // Tall enough for a created key's card with its Connect panel.
    await page.setViewportSize({ width: 1280, height: 1300 });
    await page.goto(ct.url);
    await field(page, /^Email or username/).fill('admin');
    await field(page, /^Password/).fill(ADMIN_KEY);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('link', { name: 'Keys' })).toBeVisible();
    const card = page.locator('.card', { has: page.locator('.keybox') });
    const tab = (label: string) => card.locator('.connect-agent .seg button', { hasText: label });

    // ---- Claude Code ----
    const ccKey = await createKey(page, 'claude-code', 'engineering', 'client-key-create');
    await tab('Claude Code').click();
    await shot(page, 'client-connect-claude-code', { clip: card, el: tab('Claude Code') });

    const ccHome = fs.mkdtempSync(path.join(tmp, 'claude-'));
    const ccEnv = { ...process.env, ANTHROPIC_API_KEY: undefined, CLAUDE_CONFIG_DIR: ccHome, ANTHROPIC_BASE_URL: ct.url, ANTHROPIC_AUTH_TOKEN: ccKey, ANTHROPIC_MODEL: 'claude-sonnet-4-5', ANTHROPIC_SMALL_FAST_MODEL: 'claude-haiku-4-5' };
    const prompt = 'Which gateway are you going through?';
    const cc = await run(CLAUDE, ['-p', prompt], ccEnv, tmp);
    expect(cc.out).toContain('Connected through Control Tower');
    await terminalShot(page, 'client-claude-code-run', 'Terminal — Claude Code through Control Tower', [
      { cmd: `export ANTHROPIC_BASE_URL=${ct.url}` },
      { cmd: mask(`export ANTHROPIC_AUTH_TOKEN=${ccKey}`, ccKey) },
      { cmd: `claude -p "${prompt}"`, out: cc.out },
    ]);
    // The Connect panel sees the first request.
    await expect(card.locator('.connect-status')).toContainText('Connected', { timeout: 15_000 });
    await shot(page, 'client-connected', { clip: card.locator('.connect-status'), pad: 12 });

    // Claude Code's MCP client, pointed at the gateway's one /mcp endpoint.
    const add = await run(CLAUDE, ['mcp', 'add', '--transport', 'http', 'controltower', `${ct.url}/mcp`, '--header', `Authorization: Bearer ${ccKey}`], ccEnv, tmp);
    expect(add.code).toBe(0);
    const list = await run(CLAUDE, ['mcp', 'list'], ccEnv, tmp);
    expect(list.out).toMatch(/controltower: .* Connected/);
    await terminalShot(page, 'client-claude-code-mcp', 'Terminal — Control Tower as Claude Code’s MCP server', [
      { cmd: mask(`claude mcp add --transport http controltower ${ct.url}/mcp --header "Authorization: Bearer ${ccKey}"`, ccKey) },
      { cmd: 'claude mcp list', out: list.out },
    ]);

    // ---- Claude Desktop ----
    await createKey(page, 'claude-desktop', 'engineering');
    await tab('Claude Desktop').click();
    await shot(page, 'client-connect-claude-desktop', { clip: card, el: tab('Claude Desktop') });

    // ---- Codex ----
    const cxKey = await createKey(page, 'codex', 'engineering');
    await tab('Codex').click();
    await expect(card.locator('.connect-status')).toContainText('Waiting'); // a new key starts from its own status
    await shot(page, 'client-connect-codex', { clip: card, el: tab('Codex') });
    if (CODEX) {
      const cxHome = fs.mkdtempSync(path.join(tmp, 'codex-'));
      const toml = (await card.locator('.connect-agent pre').first().innerText()).trim();
      expect(toml).toContain('model = "gpt-5"');
      fs.writeFileSync(path.join(cxHome, 'config.toml'), toml);
      fs.writeFileSync(path.join(cxHome, '.env'), `CONTROLTOWER_API_KEY=${cxKey}\n`);
      const cxEnv = { ...process.env, CODEX_HOME: cxHome };
      const ask = 'Which gateway are you going through?';
      const gpt = await run(CODEX, ['exec', '--skip-git-repo-check', ask], cxEnv, tmp);
      expect(gpt.out).toContain('Connected through Control Tower');
      const claude = await run(CODEX, ['exec', '--skip-git-repo-check', '-m', 'claude-sonnet-4-5', ask], cxEnv, tmp);
      expect(claude.out).toContain('Connected through Control Tower');
      // Codex logs its session to stderr and prints the answer to stdout: show the model, the provider and the answer.
      const tidy = (r: { stdout: string; stderr: string }) =>
        [...r.stderr.split('\n').filter((l) => /^(model|provider):/.test(l)), r.stdout.trim()].join('\n');
      await terminalShot(page, 'client-codex-run', 'Terminal — Codex through Control Tower', [
        { cmd: `codex exec "${ask}"`, out: tidy(gpt) },
        { cmd: `codex exec -m claude-sonnet-4-5 "${ask}"`, out: tidy(claude) },
      ]);
      const mcpList = await run(CODEX, ['mcp', 'list'], cxEnv, tmp);
      await terminalShot(page, 'client-codex-mcp', 'Terminal — Codex MCP servers', [{ cmd: 'codex mcp list', out: mcpList.out }]);
    } else {
      // Without the Codex CLI, the requests it sends: streamed Responses API calls with the codex key
      // (the terminal screenshots above keep their last recording).
      for (const model of ['gpt-5', 'claude-sonnet-4-5']) {
        const r = await fetch(`${ct.url}/v1/responses`, {
          method: 'POST',
          headers: { authorization: `Bearer ${cxKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model, stream: true, instructions: 'You are Codex.', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Which gateway are you going through?' }] }] }),
        });
        expect(r.status).toBe(200);
        await r.text();
      }
    }

    // ---- Verify: Flights, and the map ----
    await page.setViewportSize({ width: 1280, height: 860 });
    await nav(page, 'Flights');
    const row = page.locator('table.table tbody tr', { hasText: 'claude-code' }).first();
    await expect(row).toBeVisible();
    await expect(page.locator('table.table tbody tr', { hasText: 'codex' }).first()).toBeVisible();
    await shot(page, 'client-verify-flights', { el: row.locator('td').nth(1) });
    await nav(page, 'Airspace');
    await page.waitForTimeout(1500);
    await page.evaluate(() => (window as unknown as { __ctScene: { fit(): void } }).__ctScene.fit());
    await page.waitForTimeout(600);
    await shot(page, 'client-verify-airspace');
  } finally {
    await ct.stop();
    await Promise.all([ant.close(), oai.close(), files.close()]);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
