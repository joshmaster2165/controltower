/**
 * VS Code's chat (GitHub Copilot Chat) through Control Tower, for real: VS Code downloaded from Microsoft, the Copilot
 * Chat extension from the Marketplace, a Custom Endpoint provider and an MCP server pointing at a local Control Tower,
 * and a request made through VS Code's own language-model API (vscode.lm) by a throwaway test extension. No GitHub
 * account: Custom Endpoint models work without one.
 *
 * Linux, under a virtual display: `xvfb-run -a npx tsx scripts/clients/vscode-copilot.mts` (needs a test build:
 * CT_TEST_LICENSE_KEYS=1 pnpm build). Never on a laptop someone is using: it opens VS Code.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { anthropicUpstream, mcpUpstream, openAiUpstream } from '../../e2e/support/upstreams.ts';
import { TEST_LICENSE_PUBLIC_KEY, testLicense } from '../../e2e/support/license.ts';

const REPO = path.resolve(import.meta.dirname, '../..');
const PORT = 4951;
const CT = `http://127.0.0.1:${PORT}`;
const AK = 'vscode-admin-key-0123456789';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-vscode-'));
const RESULTS = process.env.RESULTS_DIR ?? TMP;
const REPLY = 'Connected through Control Tower from VS Code.';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const checks: Array<{ what: string; pass: boolean; detail: string }> = [];
const c = (what: string, pass: boolean, detail: string) => {
  checks.push({ what, pass, detail });
  console.log(`${pass ? '✓' : '✗'} ${what} — ${detail}`);
};
function run(cmd: string, args: string[], env: Record<string, string> = {}, timeoutMs = 600_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...env }, cwd: TMP });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('close', (code) => (clearTimeout(t), resolve({ code: code ?? -1, out })));
  });
}

const oai = await openAiUpstream({ models: ['gpt-5'], reply: REPLY });
const ant = await anthropicUpstream({ models: ['claude-sonnet-4-5'], reply: REPLY });
const files = await mcpUpstream('files-token');
const ct = spawn(process.execPath, ['server/dist/server.mjs', '--port', String(PORT)], {
  cwd: REPO,
  env: { ...process.env, CT_DATA_DIR: path.join(TMP, 'data'), CT_ADMIN_KEY: AK, CT_LOG_LEVEL: 'warn', CT_LICENSE_PUBLIC_KEY: TEST_LICENSE_PUBLIC_KEY, CT_LICENSE_KEY: testLicense(), CT_LICENSE_SERVER: 'off', CT_MODEL_HEALTH_INTERVAL_S: '0' },
  stdio: ['ignore', 'inherit', 'inherit'],
});
for (let i = 0; !(await fetch(`${CT}/healthz`).catch(() => null))?.ok; i++) {
  if (i > 150) throw new Error('Control Tower did not start (a test build is needed)');
  await sleep(200);
}
// A recorder in front of Control Tower: what VS Code sends (path, user agent, the headers that could name it).
const seen: Array<{ method: string; path: string; ua: string; hdrs: string }> = [];
const GW_PORT = 4952;
const GW = `http://127.0.0.1:${GW_PORT}`;
const recorder = http.createServer((req, res) => {
  const cred = (h: string) => (req.headers[h] ? `${h}=${String(req.headers[h]).includes('ct_sk_') ? 'the key' : `"${String(req.headers[h]).slice(0, 12)}…"`}` : '');
  seen.push({ method: req.method ?? '', path: (req.url ?? '').split('?')[0]!, ua: String(req.headers['user-agent'] ?? ''), hdrs: [cred('authorization'), cred('x-api-key')].filter(Boolean).join(' ') + ' ' + Object.keys(req.headers).filter((h) => !/^(host|content-length|content-type|accept|accept-encoding|connection|authorization|x-api-key)$/.test(h)).map((h) => `${h}=${String(req.headers[h]).slice(0, 50)}`).join(' ') });
  const up = http.request({ host: '127.0.0.1', port: PORT, path: req.url, method: req.method, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on('error', () => (res.headersSent ? res.destroy() : (res.writeHead(502), res.end())));
  req.pipe(up);
});
await new Promise<void>((r) => recorder.listen(GW_PORT, '127.0.0.1', () => r()));
const api = (method: string, p: string, body?: unknown) =>
  fetch(CT + p, { method, headers: { authorization: `Bearer ${AK}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }).then(async (r) => (await r.json().catch(() => ({}))) as any);

try {
  const op = await api('POST', '/admin/api/providers', { catalog_id: 'custom', name: 'OpenAI', slug: 'openai', base_url: `${oai.url}/v1`, credentials: { api_key: 'sk-real' } });
  await api('POST', '/admin/api/deployments', { provider_id: (op.provider ?? op).id, upstream_model: 'gpt-5', public_name: 'gpt-5' });
  const ap = await api('POST', '/admin/api/providers', { catalog_id: 'anthropic', base_url: ant.url, credentials: { api_key: 'sk-ant' } });
  await api('POST', '/admin/api/deployments', { provider_id: (ap.provider ?? ap).id, upstream_model: 'claude-sonnet-4-5', public_name: 'claude-sonnet-4-5' });
  await api('POST', '/admin/api/mcp/servers', { name: 'Files', slug: 'files', url: `${files.url}/mcp`, auth: { type: 'bearer', token: 'files-token' } });
  const key = await api('POST', '/admin/api/keys', { name: 'vscode', agent_id: 'vscode' });

  // ---- VS Code and Copilot Chat, from Microsoft ----
  const vsc = path.join(TMP, 'vscode');
  fs.mkdirSync(vsc, { recursive: true });
  const dl = await run('sh', ['-c', `curl -fsSL "https://update.code.visualstudio.com/latest/linux-x64/stable" -o vscode.tgz && tar -xzf vscode.tgz -C "${vsc}"`]);
  const app = path.join(vsc, 'VSCode-linux-x64');
  const cli = path.join(app, 'bin', 'code');
  const userData = path.join(TMP, 'user-data');
  const exts = path.join(TMP, 'extensions');
  c('VS Code downloads (stable, from update.code.visualstudio.com)', dl.code === 0 && fs.existsSync(cli), dl.out.trim().slice(-200) || 'ok');
  const ver = await run(cli, ['--version', '--user-data-dir', userData]);
  console.log('VS Code', ver.out.trim().split('\n').slice(0, 2).join(' '));
  // (GitHub Copilot Chat is built into VS Code: nothing to install.)

  // ---- The settings a person (or IT) puts in place: models and tools at Control Tower ----
  const user = path.join(userData, 'User');
  fs.mkdirSync(user, { recursive: true });
  fs.writeFileSync(
    path.join(user, 'chatLanguageModels.json'),
    JSON.stringify(
      [
        { name: 'Control Tower', vendor: 'customendpoint', apiKey: key.key, apiType: 'chat-completions', models: [{ id: 'gpt-5', name: 'GPT-5 (Control Tower)', url: `${GW}/v1/chat/completions`, requestHeaders: { Authorization: `Bearer ${key.key}` }, toolCalling: true, vision: false, maxInputTokens: 128000, maxOutputTokens: 8000 }] },
        { name: 'Control Tower (Claude)', vendor: 'customendpoint', apiKey: key.key, apiType: 'messages', models: [{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5 (Control Tower)', url: `${GW}/v1/messages`, requestHeaders: { Authorization: `Bearer ${key.key}` }, toolCalling: true, vision: false, maxInputTokens: 200000, maxOutputTokens: 8000 }] },
      ],
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(user, 'mcp.json'), JSON.stringify({ servers: { controltower: { type: 'http', url: `${GW}/mcp`, headers: { Authorization: `Bearer ${key.key}` } } } }, null, 2));
  // Chat set up once already, as a person does the first time ("Set up chat", then their own models): VS Code keeps the
  // built-in Copilot Chat turned off in a profile where that hasn't happened. Its record, in the profile's state.
  const Sqlite = createRequire(path.join(REPO, 'server', 'package.json'))('better-sqlite3') as new (file: string) => { exec(sql: string): void; prepare(sql: string): { run(...a: unknown[]): void }; close(): void };
  fs.mkdirSync(path.join(user, 'globalStorage'), { recursive: true });
  const state = new Sqlite(path.join(user, 'globalStorage', 'state.vscdb'));
  state.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  const put = state.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
  put.run('chat.setupContext', JSON.stringify({ entitlement: 1, completed: true, installed: true }));
  put.run('chat.setupContext.migrated.v1', 'true');
  put.run('builtinChatExtensionEnablementMigration', 'true');
  state.close();
  fs.writeFileSync(path.join(user, 'settings.json'), JSON.stringify({ 'security.workspace.trust.enabled': false, 'chat.mcp.autostart': 'newAndOutdated', 'chat.disableAIFeatures': false, 'telemetry.telemetryLevel': 'off', 'extensions.autoUpdate': false, 'update.mode': 'none' }, null, 2));

  // ---- A throwaway extension that asks through vscode.lm, as any chat feature would ----
  // (A development extension in an ordinary VS Code start, not an extension test run: a test run leaves the built-in
  // Copilot Chat disabled.)
  const probe = path.join(TMP, 'probe');
  fs.mkdirSync(probe, { recursive: true });
  fs.writeFileSync(path.join(probe, 'package.json'), JSON.stringify({ name: 'ct-probe', publisher: 'controltower', version: '0.0.1', engines: { vscode: '^1.95.0' }, main: './extension.js', activationEvents: ['onStartupFinished'] }));
  fs.writeFileSync(path.join(probe, 'extension.js'), "const vscode = require('vscode');\nexports.activate = () => { require('./run.js').run().catch((e) => require('fs').writeFileSync(process.env.CT_PROBE_ERR || '/tmp/ct-probe-err', String(e && e.stack))).finally(() => setTimeout(() => vscode.commands.executeCommand('workbench.action.quit'), 1000)); };\n");
  const out = path.join(TMP, 'probe-result.json');
  fs.writeFileSync(
    path.join(probe, 'run.js'),
    `const vscode = require('vscode');
const fs = require('fs');
exports.run = async () => {
  const r = { models: [], answers: {}, tools: [], toolResult: null, errors: [], chat: null };
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const chat = vscode.extensions.getExtension('GitHub.copilot-chat');
  r.chat = chat ? { version: chat.packageJSON.version, active: chat.isActive } : 'not present';
  if (chat && !chat.isActive) { try { await chat.activate(); r.chat.activated = true; } catch (e) { r.errors.push('activate copilot-chat: ' + e.message); } }
  let models = [];
  for (let i = 0; i < 90 && !models.length; i++) { try { models = await vscode.lm.selectChatModels({ vendor: 'customendpoint' }); } catch (e) { r.errors.push('select: ' + e.message); } if (!models.length) await sleep(1000); }
  if (!models.length) { const all = await vscode.lm.selectChatModels({}); r.errors.push('no customendpoint models; all: ' + all.map((m) => m.vendor + '/' + m.id).join(', ')); }
  r.models = models.map((m) => ({ id: m.id, vendor: m.vendor, family: m.family, name: m.name }));
  for (const m of models) {
    try {
      const resp = await m.sendRequest([vscode.LanguageModelChatMessage.User('Which gateway are you going through?')], {}, new vscode.CancellationTokenSource().token);
      let text = ''; for await (const part of resp.text) text += part;
      r.answers[m.id] = text;
    } catch (e) { r.errors.push(m.id + ': ' + (e && e.message)); r.answers[m.id] = 'ERROR ' + (e && e.message); }
  }
  // MCP servers start when chat first needs them, after the person trusts them once: started here, trusted.
  // (Again until its tools appear: the servers in mcp.json are read a moment after start-up.)
  for (let i = 0; i < 20 && !vscode.lm.tools.some((t) => /read_file/.test(t.name)); i++) {
    try { await Promise.race([vscode.commands.executeCommand('workbench.mcp.startServer', '*', { autoTrustChanges: true, promptType: 'never', waitForLiveTools: true }), sleep(10000)]); } catch (e) { r.errors.push('mcp start: ' + e.message); }
    await sleep(1500);
  }
  r.toolCount = vscode.lm.tools.length;
  r.tools = vscode.lm.tools.map((t) => t.name).filter((n) => /files|controltower/i.test(n));
  const tool = vscode.lm.tools.find((t) => /read_file/.test(t.name));
  if (tool) { try { const res = await vscode.lm.invokeTool(tool.name, { input: { path: 'README.md' }, toolInvocationToken: undefined }, new vscode.CancellationTokenSource().token); r.toolResult = res.content.map((p) => p.value || '').join(''); } catch (e) { r.errors.push('tool: ' + e.message); } }
  // What a person sees: a gate that refuses, then one that holds until an approver says yes.
  const admin = (method, p, body) => fetch(${JSON.stringify(CT)} + p, { method, headers: { authorization: 'Bearer ${AK}', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }).then((x) => x.json());
  const ask = async (m) => { try { const resp = await m.sendRequest([vscode.LanguageModelChatMessage.User('Draft the board update')], {}, new vscode.CancellationTokenSource().token); let t = ''; for await (const part of resp.text) t += part; return t; } catch (e) { return 'ERROR ' + (e && e.message); } };
  const gpt = models.find((m) => m.id === 'gpt-5');
  const claude = models.find((m) => m.id === 'claude-sonnet-4-5');
  if (gpt) {
    const deny = await admin('POST', '/admin/api/rules', { name: 'Not today', target_kind: 'model', effect: 'deny', priority: 1 });
    r.denied = await ask(gpt);
    await admin('DELETE', '/admin/api/rules/' + deny.id);
  }
  if (claude) {
    const hold = await admin('POST', '/admin/api/rules', { name: 'Needs a manager', target_kind: 'model', effect: 'require_approval', config: { hold_ms: 120000 }, priority: 1 });
    setTimeout(async () => { for (const a of (await admin('GET', '/admin/api/approvals?status=pending')).approvals || []) await admin('POST', '/admin/api/approvals/' + a.id + '/decide', { action: 'approve' }); }, 6000);
    r.held = await ask(claude);
    await admin('DELETE', '/admin/api/rules/' + hold.id);
  }
  fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify(r, null, 2));
};
`,
  );
  const electron = path.join(app, 'code');
  const work = path.join(TMP, 'work');
  fs.mkdirSync(path.join(work, '.vscode'), { recursive: true });
  // The same server in the project's own mcp.json too (the other place VS Code reads them from).
  fs.writeFileSync(path.join(work, '.vscode', 'mcp.json'), JSON.stringify({ servers: { 'controltower-project': { type: 'http', url: `${GW}/mcp`, headers: { Authorization: `Bearer ${key.key}` } } } }, null, 2));
  const vs = await run(electron, ['--no-sandbox', '--disable-gpu', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--user-data-dir', userData, '--extensions-dir', exts, '--verbose', '--log', 'trace', `--extensionDevelopmentPath=${probe}`, work], { CT_PROBE_ERR: path.join(TMP, 'probe-error.txt') }, 300_000);
  if (fs.existsSync(path.join(TMP, 'probe-error.txt'))) console.log('probe error:', fs.readFileSync(path.join(TMP, 'probe-error.txt'), 'utf8'));
  fs.writeFileSync(path.join(RESULTS, 'vscode-output.txt'), vs.out);
  // VS Code's own logs (MCP servers, the chat), for when something doesn't work.
  fs.cpSync(path.join(userData, 'logs'), path.join(RESULTS, 'vscode-logs'), { recursive: true });
  const r = fs.existsSync(out) ? (JSON.parse(fs.readFileSync(out, 'utf8')) as { models: Array<{ id: string; vendor: string }>; answers: Record<string, string>; tools: string[]; toolResult: string | null; errors: string[] }) : null;
  if (!r) console.log(vs.out.slice(-3000));
  c('VS Code lists Control Tower\'s models (Custom Endpoint, no GitHub account)', !!r && r.models.length === 2, r ? `copilot-chat ${JSON.stringify((r as any).chat)}; ${r.models.map((m) => `${m.vendor}/${m.id}`).join(', ')}${r.errors.length ? `; ${r.errors.join('; ').slice(0, 300)}` : ''}` : `no result; exit ${vs.code}`);
  c('VS Code chat answers through Control Tower on Chat Completions (gpt-5)', !!r && (r.answers['gpt-5'] ?? '').includes(REPLY), r ? (r.answers['gpt-5'] ?? 'no answer').slice(0, 200) : 'no result');
  c('VS Code chat answers through Control Tower on the Messages API (claude-sonnet-4-5)', !!r && (r.answers['claude-sonnet-4-5'] ?? '').includes(REPLY), r ? (r.answers['claude-sonnet-4-5'] ?? 'no answer').slice(0, 200) : 'no result');
  c('VS Code gets Control Tower\'s MCP tools (mcp.json), and a tool call goes through', !!r && r.tools.length > 0 && /contents of README\.md/.test(r.toolResult ?? ''), r ? `${r.tools.join(', ') || 'no tools'} (${(r as any).toolCount} tools in all); ${(r.toolResult ?? 'no tool result').slice(0, 120)}${r.errors.filter((e) => /mcp|tool/.test(e)).length ? `; ${r.errors.filter((e) => /mcp|tool/.test(e)).join('; ').slice(0, 200)}` : ''}` : 'no result');
  c('a refusal reaches the person in words (not as a failed sign-in)', !!r && /Control Tower blocked this request/.test((r as any).denied ?? ''), r ? String((r as any).denied ?? 'not asked').slice(0, 200) : 'no result');
  c('a held request says so in the chat as it waits, then who approved, then the answer', !!r && /waiting for approval/.test((r as any).held ?? '') && /approved by/.test((r as any).held ?? '') && ((r as any).held ?? '').includes(REPLY), r ? String((r as any).held ?? 'not asked').replace(/\n+/g, ' ').slice(0, 300) : 'no result');
  for (const x of seen) console.log('seen', x.method, x.path, '|', x.ua, '|', x.hdrs);
  const flights = ((await api('GET', '/admin/api/flights?limit=50')).flights ?? []) as Array<{ kind: string; model_requested: string; status: string; client: string | null }>;
  c('Control Tower records VS Code\'s calls, as VS Code', flights.filter((f) => /gpt-5|claude/.test(f.model_requested) && f.client === 'vscode').length >= 2, flights.map((f) => `${f.kind} ${f.model_requested} ${f.status} ${f.client ?? '-'}`).join(' | ').slice(0, 400));
} finally {
  const failed = checks.filter((x) => !x.pass).length;
  fs.writeFileSync(path.join(RESULTS, 'vscode-copilot-results.json'), JSON.stringify({ ran_at: new Date().toISOString(), checks, seen }, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### VS Code + Copilot Chat: ${checks.length - failed} of ${checks.length}\n\n${checks.map((x) => `- ${x.pass ? '✅' : '❌'} ${x.what} — ${x.detail.replace(/\n/g, ' ')}`).join('\n')}\n`);
  console.log(`${checks.length - failed} of ${checks.length} passed`);
  ct.kill();
  recorder.close();
  await oai.close();
  await ant.close();
  await files.close();
  process.exitCode = failed || !checks.length ? 1 : 0;
}
