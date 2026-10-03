import crypto from 'node:crypto';
import fs from 'node:fs';

/**
 * Rolling Control Tower out to company laptops (Enterprise): the files IT uploads to Jamf, Intune, Kandji or Group
 * Policy, with this Control Tower's address filled in. They install the ct-auth helper and point Claude Code, Claude
 * Desktop and Codex at the gateway, each person signing in as themselves. Nothing secret is in any of them.
 *
 * The client settings follow each vendor's documented managed configuration: Claude Code's managed settings
 * (`com.anthropic.claudecode`, `HKLM\SOFTWARE\Policies\ClaudeCode`, managed-settings.json, managed-mcp.json), Claude
 * Desktop's (`com.anthropic.claudefordesktop`, `HKLM\SOFTWARE\Policies\Claude`, /etc/claude-desktop), and Codex's
 * requirements.toml and managed_config.toml (`com.openai.codex`). GitHub Copilot CLI has no managed configuration for
 * its model provider, only environment variables: they're set machine-wide (Windows), or in a file every shell reads
 * (macOS and Linux).
 */
export type RolloutClient = 'claude-code' | 'claude-desktop' | 'codex' | 'copilot';
export const ROLLOUT_CLIENTS: RolloutClient[] = ['claude-code', 'claude-desktop', 'codex', 'copilot'];
/** Chosen when nothing is: the clients rolled out before GitHub Copilot CLI joined (it's opted into). */
export const DEFAULT_CLIENTS: RolloutClient[] = ['claude-code', 'claude-desktop', 'codex'];

export interface RolloutOptions {
  /** The address laptops reach Control Tower at (https, in production). */
  url: string;
  clients: RolloutClient[];
  /** Give each client Control Tower's MCP endpoint (the tools you've registered, behind the same sign-in). */
  mcp: boolean;
  /** Also stop the clients going anywhere else: other providers, other MCP servers, local extensions. */
  lockdown: boolean;
  /**
   * How people sign in: with Control Tower (they approve each computer in the console), or with your identity
   * provider directly (its device sign-in; Control Tower checks the tokens through a trusted issuer, so people need
   * no Control Tower account).
   */
  idp?: { issuer: string; clientId: string; scope?: string | undefined; token?: 'id_token' | 'access_token' | undefined } | undefined;
  /** The model GitHub Copilot CLI uses (it needs one named): one Control Tower serves. */
  copilotModel?: string | undefined;
}

/** What's wrong with the Copilot model name, if anything (it goes into scripts). */
export function copilotModelProblem(model: string): string | undefined {
  return /^[A-Za-z0-9._:/@-]{1,120}$/.test(model) ? undefined : 'The Copilot model is a model name Control Tower serves, such as claude-sonnet-4-5 (letters, digits and . _ : / @ - only).';
}

/** What's wrong with identity-provider settings, if anything (they go into a config file and scripts). */
export function idpProblem(idp: NonNullable<RolloutOptions['idp']>): string | undefined {
  const issuer = rolloutUrlProblem(idp.issuer);
  if (issuer) return `The identity provider's issuer: ${issuer}`;
  if (!idp.issuer.startsWith('https://') && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(idp.issuer)) return "The identity provider's issuer must be https.";
  if (!/^[A-Za-z0-9._:/-]{1,200}$/.test(idp.clientId)) return 'Enter the client ID of the app registered at your identity provider (letters, digits and . _ : / - only).';
  if (idp.scope !== undefined && !/^[A-Za-z0-9 ._:/-]{1,300}$/.test(idp.scope)) return 'Scopes are space-separated names, such as "openid email profile offline_access".';
  return undefined;
}

/** ct-auth's config file: the address, and how to sign in. */
function confText(o: RolloutOptions): string {
  const lines = [`url=${o.url}`];
  if (o.idp) {
    lines.push(`idp_issuer=${o.idp.issuer}`, `idp_client_id=${o.idp.clientId}`);
    if (o.idp.scope) lines.push(`idp_scope=${o.idp.scope}`);
    if (o.idp.token && o.idp.token !== 'id_token') lines.push(`idp_token=${o.idp.token}`);
  }
  return `${lines.join('\n')}\n`;
}

export type Platform = 'macos' | 'windows' | 'linux' | 'any';
export interface RolloutFile {
  name: string;
  platform: Platform;
  /** What it is and how to deploy it, in a sentence. */
  use: string;
  content: string;
  mime: string;
}

const UNIX_HELPER = '/usr/local/bin/ct-auth';
const WIN_DIR = 'C:\\Program Files\\ControlTower';
const WIN_HELPER = `${WIN_DIR}\\ct-auth.cmd`;
const MAC_CONF = '/Library/Application Support/ControlTower/ct-auth.conf';

let scripts: { sh: string; ps1: string } | undefined;
/** The helper scripts, shipped next to the server (src/ee/laptops in development, dist/ in a build). */
export function helperScripts(): { sh: string; ps1: string } {
  if (scripts) return scripts;
  const read = (name: string) => {
    for (const u of [new URL(`./${name}`, import.meta.url), new URL(`./laptops/${name}`, import.meta.url)]) {
      try {
        return fs.readFileSync(u, 'utf8');
      } catch {
        /* the next place */
      }
    }
    throw new Error(`${name} is missing from this build`);
  };
  scripts = { sh: read('ct-auth.sh'), ps1: read('ct-auth.ps1') };
  return scripts;
}

/** A plain https/http origin with an optional path, without a trailing slash; anything else is refused. */
export function rolloutUrlProblem(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'Enter the address laptops reach Control Tower at, such as https://ai-gateway.example.com.';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'The address must start with https://.';
  if (u.search || u.hash || u.username || u.password) return 'The address must be just the origin (and path, if any): no query, fragment or credentials.';
  if (/["'\\\s%`$]/.test(url)) return 'The address has characters that are not allowed in it.';
  return undefined;
}

const has = (o: RolloutOptions, c: RolloutClient) => o.clients.includes(c);
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

// ---- each client's settings ----

/** A command line for a shell (sh, or cmd on Windows): the program quoted when its path has a space. */
const shellCommand = (program: string, args: string) => `${program.includes(' ') ? `"${program}"` : program} ${args}`;

function claudeCodeSettings(o: RolloutOptions, helper: string) {
  return {
    env: { ANTHROPIC_BASE_URL: o.url },
    apiKeyHelper: shellCommand(helper, 'token --client claude-code'),
    ...(o.lockdown ? { allowedProviders: ['customEndpoint'] } : {}),
    ...(o.lockdown && o.mcp ? { allowManagedMcpServersOnly: true, allowedMcpServers: [{ serverUrl: `${o.url}/mcp*` }] } : {}),
  };
}

function claudeCodeMcp(o: RolloutOptions, helper: string) {
  return { mcpServers: { controltower: { type: 'http', url: `${o.url}/mcp`, headersHelper: shellCommand(helper, 'header --client claude-code') } } };
}

/** Claude Desktop's keys, every value a string as its managed preferences expect (JSON documents as strings). */
function claudeDesktopKeys(o: RolloutOptions, windows: boolean): Record<string, string> {
  const unixMcpHelper = '/usr/local/bin/ct-auth-mcp-claude-desktop';
  return {
    inferenceProvider: 'gateway',
    inferenceGatewayBaseUrl: o.url,
    inferenceCredentialKind: 'helper-script',
    // A helper of its own that needs no arguments: Claude Desktop 1.44121 on Windows ignores both
    // inferenceCredentialHelperArgs and inferenceCredentialHelperWindows. Windows policy only reaches Windows, so the
    // helper's own key carries the Windows path there.
    inferenceCredentialHelper: windows ? `${WIN_DIR}\\ct-auth-claude-desktop.cmd` : '/usr/local/bin/ct-auth-claude-desktop',
    inferenceCredentialHelperWindows: `${WIN_DIR}\\ct-auth-claude-desktop.cmd`,
    // Tokens last an hour; reused for 50 minutes. The first sign-in waits for the browser, so it may take minutes.
    inferenceCredentialHelperTtlSec: '3000',
    inferenceCredentialHelperTimeoutSec: '300',
    ...(o.mcp
      ? { managedMcpServers: JSON.stringify([{ name: 'controltower', transport: 'http', url: `${o.url}/mcp`, headersHelper: windows ? `${WIN_DIR}\\ct-auth-mcp-claude-desktop.cmd` : unixMcpHelper, headersHelperTtlSec: 1800 }]) }
      : {}),
    ...(o.lockdown ? { isLocalDevMcpEnabled: 'false', isDesktopExtensionEnabled: 'false' } : {}),
  };
}

/** Claude Desktop on Linux reads real JSON types. */
function claudeDesktopLinux(o: RolloutOptions) {
  const k = claudeDesktopKeys(o, false);
  const out: Record<string, unknown> = {};
  for (const [name, v] of Object.entries(k)) {
    if (name === 'inferenceCredentialHelperWindows') continue;
    if (v === 'true' || v === 'false') out[name] = v === 'true';
    else if (/^\d+$/.test(v)) out[name] = Number(v);
    else if (v.startsWith('[') || v.startsWith('{')) out[name] = JSON.parse(v);
    else out[name] = v;
  }
  return out;
}

const toml = (s: string) => JSON.stringify(s);
const tomlList = (a: string[]) => `[${a.map(toml).join(', ')}]`;

function codexRequirements(o: RolloutOptions, helper: string, args: string[]): string {
  const lines = [
    '# Control Tower: every Codex model call goes through the gateway, as the person signed in on this computer.',
    '# Admin-enforced (requirements.toml): users can\'t point Codex at another provider.',
    'model_provider = "controltower"',
    '',
    '[model_providers.controltower]',
    'name = "Control Tower"',
    `base_url = ${toml(`${o.url}/v1`)}`,
    'wire_api = "responses"',
    '',
    '[model_providers.controltower.auth]',
    `command = ${toml(helper)}`,
    `args = ${tomlList(args)}`,
    '# The first sign-in waits for the browser.',
    'timeout_ms = 300000',
    'refresh_interval_ms = 1800000',
  ];
  if (o.mcp && o.lockdown) lines.push('', '# Only Control Tower\'s MCP endpoint may be enabled.', '[mcp_servers.controltower.identity]', `url = ${toml(`${o.url}/mcp`)}`);
  return `${lines.join('\n')}\n`;
}

function codexManagedConfig(o: RolloutOptions, headersHelper: string): string {
  return [
    '# Control Tower: the tools registered in Control Tower, behind the same sign-in (managed defaults).',
    '[mcp_servers.controltower]',
    `url = ${toml(`${o.url}/mcp`)}`,
    `http_headers_helper = ${toml(headersHelper)}`,
    '',
  ].join('\n');
}

/**
 * GitHub Copilot CLI's settings: its own model provider pointed at Control Tower (the Anthropic Messages API, so a
 * held request is told in the reply as it waits), its credential from ct-auth through a helper with no arguments.
 * Locked down, it talks to nothing but Control Tower (no GitHub sign-in, no telemetry).
 */
function copilotEnv(o: RolloutOptions, helper: string): Record<string, string> {
  return {
    COPILOT_PROVIDER_TYPE: 'anthropic',
    COPILOT_PROVIDER_BASE_URL: o.url,
    COPILOT_PROVIDER_API_KEY_COMMAND: helper,
    COPILOT_MODEL: o.copilotModel ?? 'claude-sonnet-4-5',
    ...(o.lockdown ? { COPILOT_OFFLINE: 'true' } : {}),
  };
}
const COPILOT_MARK = '# Control Tower: GitHub Copilot CLI';
/** The variables as sh lines, and the lines that make every shell read them (added once; run again, nothing doubles). */
function copilotShell(o: RolloutOptions, envFile: string, rcFiles: string[]): string {
  const sh = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
  const lines = [`${COPILOT_MARK} (${o.url}). Written by the Control Tower install script.`, ...Object.entries(copilotEnv(o, '/usr/local/bin/ct-auth-copilot')).map(([k, v]) => `export ${k}=${sh(v)}`)];
  const parts = [heredoc(envFile, `${lines.join('\n')}\n`, '644')];
  // (Only where that shell is installed: its folder exists.)
  for (const rc of rcFiles) parts.push(`if [ -d "$(dirname "${rc}")" ]; then touch "${rc}"; grep -qF '${COPILOT_MARK}' "${rc}" || printf '\\n%s\\n[ -r "%s" ] && . "%s"\\n' '${COPILOT_MARK}' '${envFile}' '${envFile}' >> "${rc}"; fi\n`);
  return parts.join('');
}

// ---- macOS ----

function plistEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function plistValue(v: unknown, indent: string): string {
  if (typeof v === 'boolean') return `${indent}<${v}/>`;
  if (typeof v === 'number') return `${indent}<integer>${v}</integer>`;
  if (typeof v === 'string') return `${indent}<string>${plistEscape(v)}</string>`;
  if (Array.isArray(v)) return `${indent}<array>\n${v.map((x) => plistValue(x, `${indent}  `)).join('\n')}\n${indent}</array>`;
  if (v && typeof v === 'object') {
    const body = Object.entries(v as Record<string, unknown>).map(([k, x]) => `${indent}  <key>${plistEscape(k)}</key>\n${plistValue(x, `${indent}  `)}`);
    return `${indent}<dict>\n${body.join('\n')}\n${indent}</dict>`;
  }
  throw new Error(`can't put ${typeof v} in a profile`);
}
/** Stable UUIDs: downloading again gives the same profile, so MDM replaces it rather than adding a second one. */
function uuid(seed: string): string {
  const h = crypto.createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`.toUpperCase();
}

function mobileconfig(o: RolloutOptions): string {
  const host = new URL(o.url).host;
  const base = `app.agentcontroltower.laptops.${host.replace(/[^A-Za-z0-9.-]/g, '-')}`;
  const payloads: Array<{ type: string; name: string; keys: Record<string, unknown> }> = [];
  if (has(o, 'claude-code')) payloads.push({ type: 'com.anthropic.claudecode', name: 'Claude Code', keys: claudeCodeSettings(o, UNIX_HELPER) });
  if (has(o, 'claude-desktop')) payloads.push({ type: 'com.anthropic.claudefordesktop', name: 'Claude Desktop', keys: claudeDesktopKeys(o, false) });
  if (has(o, 'codex')) {
    const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
    payloads.push({
      type: 'com.openai.codex',
      name: 'Codex',
      keys: {
        requirements_toml_base64: b64(codexRequirements(o, UNIX_HELPER, ['token', '--client', 'codex'])),
        ...(o.mcp ? { config_toml_base64: b64(codexManagedConfig(o, '/usr/local/bin/ct-auth-mcp-codex')) } : {}),
      },
    });
  }
  const content = payloads.map((p) => ({
    PayloadType: p.type,
    PayloadVersion: 1,
    PayloadIdentifier: `${base}.${p.type}`,
    PayloadUUID: uuid(`${o.url}|${p.type}`),
    PayloadDisplayName: `${p.name} through Control Tower`,
    ...p.keys,
  }));
  const profile = {
    PayloadContent: content,
    PayloadDisplayName: `Control Tower (${host})`,
    PayloadDescription: `Sends Claude Code, Claude Desktop and Codex through Control Tower at ${o.url}, each person signed in as themselves.`,
    PayloadIdentifier: base,
    PayloadOrganization: 'Control Tower',
    PayloadScope: 'System',
    PayloadType: 'Configuration',
    PayloadUUID: uuid(`${o.url}|profile|${o.clients.join(',')}`),
    PayloadVersion: 1,
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${plistValue(profile, '')}\n</plist>\n`;
}

/** A here-document that writes a file exactly (quoted delimiter: nothing in it is expanded). */
function heredoc(path: string, content: string, mode: string): string {
  const tag = 'CT_EOF';
  if (content.includes(`\n${tag}\n`)) throw new Error('content contains the here-document delimiter');
  return `mkdir -p "$(dirname "${path}")"\ncat > "${path}" <<'${tag}'\n${content.endsWith('\n') ? content : `${content}\n`}${tag}\nchmod ${mode} "${path}"\n`;
}

function unixWrappers(): string {
  return [
    heredoc('/usr/local/bin/ct-auth-claude-desktop', '#!/bin/sh\nexec /usr/local/bin/ct-auth token --client claude-desktop\n', '755'),
    heredoc('/usr/local/bin/ct-auth-mcp-claude-desktop', '#!/bin/sh\nexec /usr/local/bin/ct-auth header --client claude-desktop\n', '755'),
    heredoc('/usr/local/bin/ct-auth-mcp-codex', '#!/bin/sh\nexec /usr/local/bin/ct-auth header --client codex\n', '755'),
    heredoc('/usr/local/bin/ct-auth-copilot', '#!/bin/sh\nexec /usr/local/bin/ct-auth token --client copilot\n', '755'),
  ].join('');
}

function installMac(o: RolloutOptions): string {
  const parts = [
    '#!/bin/sh',
    `# Control Tower laptop sign-in for ${o.url}: installs ct-auth (and the files only a file can carry).`,
    '# Run as root, from Jamf (a policy script), Intune (a macOS shell script) or Kandji (a custom script).',
    '# Pair it with controltower.mobileconfig, which sets up Claude Code, Claude Desktop and Codex.',
    'set -eu',
    heredoc(UNIX_HELPER, helperScripts().sh, '755'),
    unixWrappers(),
    heredoc(MAC_CONF, confText(o), '644'),
  ];
  // Claude Code's MCP servers with a sign-in helper can only come from a file (a profile can't name a command).
  if (has(o, 'claude-code') && o.mcp) parts.push(heredoc('/Library/Application Support/ClaudeCode/managed-mcp.json', json(claudeCodeMcp(o, UNIX_HELPER)), '644'));
  // GitHub Copilot CLI reads only environment variables: a file zsh and bash read for every shell.
  if (has(o, 'copilot')) parts.push(copilotShell(o, '/Library/Application Support/ControlTower/copilot.env', ['/etc/zshenv', '/etc/profile', '/etc/bashrc']));
  parts.push('echo "Control Tower: ct-auth installed for ' + o.url + '"', '');
  return parts.join('\n');
}

// ---- Linux ----

function installLinux(o: RolloutOptions): string {
  const parts = [
    '#!/bin/sh',
    `# Control Tower laptop sign-in for ${o.url}: installs ct-auth and sets up the clients chosen, system-wide.`,
    '# Run as root (your configuration management, or by hand).',
    'set -eu',
    heredoc(UNIX_HELPER, helperScripts().sh, '755'),
    unixWrappers(),
    heredoc('/etc/controltower/ct-auth.conf', confText(o), '644'),
  ];
  if (has(o, 'claude-code')) {
    parts.push(heredoc('/etc/claude-code/managed-settings.json', json(claudeCodeSettings(o, UNIX_HELPER)), '644'));
    if (o.mcp) parts.push(heredoc('/etc/claude-code/managed-mcp.json', json(claudeCodeMcp(o, UNIX_HELPER)), '644'));
  }
  if (has(o, 'claude-desktop')) parts.push(heredoc('/etc/claude-desktop/managed-settings.json', json(claudeDesktopLinux(o)), '644'));
  if (has(o, 'codex')) {
    parts.push(heredoc('/etc/codex/requirements.toml', codexRequirements(o, UNIX_HELPER, ['token', '--client', 'codex']), '644'));
    if (o.mcp) parts.push(heredoc('/etc/codex/managed_config.toml', codexManagedConfig(o, '/usr/local/bin/ct-auth-mcp-codex'), '644'));
  }
  if (has(o, 'copilot')) {
    // /etc/profile.d covers login shells; bash.bashrc and zshenv the others.
    parts.push(copilotShell(o, '/etc/controltower/copilot.env', ['/etc/profile.d/controltower-copilot.sh', '/etc/bash.bashrc', '/etc/zsh/zshenv']));
  }
  parts.push('echo "Control Tower: set up for ' + o.url + '"', '');
  return parts.join('\n');
}

// ---- Windows ----

/** A PowerShell single-quoted here-string: nothing in it is expanded. */
function psHere(content: string): string {
  if (/^'@/m.test(content)) throw new Error("content contains a here-string terminator");
  return `@'\n${content.replace(/\n$/, '')}\n'@`;
}

function installWindows(o: RolloutOptions): string {
  const ps = [
    `# Control Tower laptop sign-in for ${o.url}: installs ct-auth and sets up the clients chosen.`,
    '# Run as SYSTEM: Intune (Devices > Scripts, "Run this script using the logged on credentials" = No, 64-bit),',
    '# or any tool that runs PowerShell as an administrator.',
    "$ErrorActionPreference = 'Stop'",
    '# UTF-8 without a byte-order mark (Windows PowerShell adds one, which JSON and TOML readers refuse).',
    'function Write-File([string]$Path, [string]$Text) { [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }',
    `$dir = '${WIN_DIR}'`,
    'New-Item -ItemType Directory -Path $dir -Force | Out-Null',
    `Write-File (Join-Path $dir 'ct-auth.ps1') ${psHere(helperScripts().ps1)}`,
    `Set-Content -LiteralPath (Join-Path $dir 'ct-auth.cmd') -Encoding ASCII -Value '@powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0ct-auth.ps1" %*'`,
    `Set-Content -LiteralPath (Join-Path $dir 'ct-auth-claude-desktop.cmd') -Encoding ASCII -Value '@powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0ct-auth.ps1" token --client claude-desktop'`,
    `Set-Content -LiteralPath (Join-Path $dir 'ct-auth-mcp-claude-desktop.cmd') -Encoding ASCII -Value '@powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0ct-auth.ps1" header --client claude-desktop'`,
    `Set-Content -LiteralPath (Join-Path $dir 'ct-auth-mcp-codex.cmd') -Encoding ASCII -Value '@powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0ct-auth.ps1" header --client codex'`,
    `Set-Content -LiteralPath (Join-Path $dir 'ct-auth-copilot.cmd') -Encoding ASCII -Value '@powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0ct-auth.ps1" token --client copilot'`,
    "New-Item -ItemType Directory -Path (Join-Path $env:ProgramData 'ControlTower') -Force | Out-Null",
    `Write-File (Join-Path $env:ProgramData 'ControlTower\\ct-auth.conf') ${psHere(confText(o))}`,
  ];
  if (has(o, 'claude-code')) {
    ps.push(
      '',
      '# Claude Code: managed settings (HKLM policy) and, for MCP, managed-mcp.json.',
      "New-Item -Path 'HKLM:\\SOFTWARE\\Policies\\ClaudeCode' -Force | Out-Null",
      `New-ItemProperty -Path 'HKLM:\\SOFTWARE\\Policies\\ClaudeCode' -Name 'Settings' -PropertyType String -Force -Value ${psHere(JSON.stringify(claudeCodeSettings(o, WIN_HELPER)))} | Out-Null`,
    );
    if (o.mcp) ps.push("New-Item -ItemType Directory -Path 'C:\\Program Files\\ClaudeCode' -Force | Out-Null", `Write-File 'C:\\Program Files\\ClaudeCode\\managed-mcp.json' ${psHere(json(claudeCodeMcp(o, WIN_HELPER)))}`);
  }
  if (has(o, 'claude-desktop')) {
    ps.push('', '# Claude Desktop: machine policy (every value a string).', "New-Item -Path 'HKLM:\\SOFTWARE\\Policies\\Claude' -Force | Out-Null");
    for (const [k, v] of Object.entries(claudeDesktopKeys(o, true))) ps.push(`New-ItemProperty -Path 'HKLM:\\SOFTWARE\\Policies\\Claude' -Name '${k}' -PropertyType String -Force -Value ${psHere(v)} | Out-Null`);
  }
  if (has(o, 'codex')) {
    ps.push(
      '',
      '# Codex: admin-enforced requirements.',
      "New-Item -ItemType Directory -Path (Join-Path $env:ProgramData 'OpenAI\\Codex') -Force | Out-Null",
      `Write-File (Join-Path $env:ProgramData 'OpenAI\\Codex\\requirements.toml') ${psHere(codexRequirements(o, `${WIN_DIR}\\ct-auth.cmd`, ['token', '--client', 'codex']))}`,
    );
    if (o.mcp) {
      ps.push(
        '# Codex on Windows has no system-wide defaults file (it no longer reads ~\\.codex\\managed_config.toml): Control',
        "# Tower's MCP server goes into each person's ~\\.codex\\config.toml, added only where it isn't there yet (nothing",
        '# else in the file is changed). The Default profile covers people who sign in for the first time later.',
        `$codexDefaults = ${psHere(codexManagedConfig(o, `${WIN_DIR}\\ct-auth-mcp-codex.cmd`))}`,
        "$profiles = @(Get-ChildItem 'C:\\Users' -Directory -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -notin @('Public', 'All Users', 'Default User') } | ForEach-Object { $_.FullName })",
        'foreach ($p in $profiles) {',
        "  $d = Join-Path $p '.codex'",
        "  $f = Join-Path $d 'config.toml'",
        '  New-Item -ItemType Directory -Path $d -Force | Out-Null',
        "  $now = if (Test-Path -LiteralPath $f) { [IO.File]::ReadAllText($f) } else { '' }",
        "  if ($now -notmatch '(?m)^\\[mcp_servers\\.controltower\\]') { Write-File $f (($now.TrimEnd() + [Environment]::NewLine + [Environment]::NewLine + $codexDefaults).TrimStart()) }",
        '}',
      );
    }
  }
  if (has(o, 'copilot')) {
    ps.push('', '# GitHub Copilot CLI: environment variables, machine-wide (it has no managed configuration for its model provider).');
    // (The helper's path quoted: Copilot runs the command through the shell, and the path has a space in it.)
    for (const [k, v] of Object.entries(copilotEnv(o, `"${WIN_DIR}\\ct-auth-copilot.cmd"`))) ps.push(`[Environment]::SetEnvironmentVariable('${k}', ${psHere(v)}, 'Machine')`);
  }
  ps.push('', `Write-Output 'Control Tower: set up for ${o.url}'`, '');
  return ps.join('\r\n');
}

/** Registry only (Group Policy Preferences, or regedit): Claude Code and Claude Desktop. REGEDIT4 keeps it plain ASCII. */
function registryFile(o: RolloutOptions): string {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const lines = ['REGEDIT4', '', `; Control Tower (${o.url}). Install ct-auth too: install-controltower-windows.ps1 does both.`];
  if (has(o, 'claude-code')) lines.push('', '[HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\ClaudeCode]', `"Settings"="${esc(JSON.stringify(claudeCodeSettings(o, WIN_HELPER)))}"`);
  if (has(o, 'claude-desktop')) {
    lines.push('', '[HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Claude]');
    for (const [k, v] of Object.entries(claudeDesktopKeys(o, true))) lines.push(`"${k}"="${esc(v)}"`);
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** Every file for these options. */
export function rolloutFiles(o: RolloutOptions): RolloutFile[] {
  const files: RolloutFile[] = [
    { name: 'install-ct-auth-macos.sh', platform: 'macos', use: 'Jamf policy script, Intune macOS shell script or Kandji custom script (runs as root): installs ct-auth.', content: installMac(o), mime: 'text/x-shellscript' },
    { name: 'controltower.mobileconfig', platform: 'macos', use: 'Configuration profile (Jamf: upload; Intune: Templates → Custom; Kandji: Custom Profile): sets up the clients.', content: mobileconfig(o), mime: 'application/x-apple-aspen-config' },
    { name: 'install-controltower-windows.ps1', platform: 'windows', use: 'Intune platform script (runs as SYSTEM, 64-bit): installs ct-auth and sets up the clients.', content: installWindows(o), mime: 'text/plain' },
    { name: 'controltower-windows.reg', platform: 'windows', use: 'Registry only, for Group Policy: Claude Code and Claude Desktop settings (install ct-auth separately).', content: registryFile(o), mime: 'text/plain' },
    { name: 'install-controltower-linux.sh', platform: 'linux', use: 'Run as root by your configuration management: installs ct-auth and the clients\' system settings.', content: installLinux(o), mime: 'text/x-shellscript' },
  ];
  if (has(o, 'claude-code')) {
    files.push({ name: 'claude-code/managed-settings.json', platform: 'any', use: 'Claude Code managed settings, for your own tooling (macOS and Linux paths).', content: json(claudeCodeSettings(o, UNIX_HELPER)), mime: 'application/json' });
    if (o.mcp) files.push({ name: 'claude-code/managed-mcp.json', platform: 'any', use: 'Claude Code\'s MCP servers: Control Tower\'s, with the sign-in helper.', content: json(claudeCodeMcp(o, UNIX_HELPER)), mime: 'application/json' });
  }
  if (has(o, 'claude-desktop')) files.push({ name: 'claude-desktop/managed-settings.json', platform: 'any', use: 'Claude Desktop\'s managed configuration (Linux file format).', content: json(claudeDesktopLinux(o)), mime: 'application/json' });
  if (has(o, 'codex')) {
    files.push({ name: 'codex/requirements.toml', platform: 'any', use: 'Codex admin-enforced requirements: the Control Tower provider.', content: codexRequirements(o, UNIX_HELPER, ['token', '--client', 'codex']), mime: 'text/plain' });
    if (o.mcp) files.push({ name: 'codex/managed_config.toml', platform: 'any', use: 'Codex managed defaults: Control Tower\'s MCP endpoint.', content: codexManagedConfig(o, '/usr/local/bin/ct-auth-mcp-codex'), mime: 'text/plain' });
  }
  if (has(o, 'copilot')) {
    const env = copilotEnv(o, '/usr/local/bin/ct-auth-copilot');
    files.push({ name: 'copilot/copilot.env', platform: 'any', use: 'GitHub Copilot CLI\'s environment variables (macOS and Linux paths), for your own packaging: set them for every shell.', content: `${Object.entries(env).map(([k, v]) => `export ${k}='${v}'`).join('\n')}\n`, mime: 'text/plain' });
  }
  files.push(
    { name: 'ct-auth', platform: 'any', use: 'The helper itself, for macOS and Linux (/usr/local/bin/ct-auth).', content: helperScripts().sh, mime: 'text/x-shellscript' },
    { name: 'ct-auth.ps1', platform: 'any', use: 'The helper itself, for Windows.', content: helperScripts().ps1, mime: 'text/plain' },
  );
  return files;
}
