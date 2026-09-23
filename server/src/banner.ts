/**
 * The first thing a new user reads in their terminal: where to open the
 * console and how to point agents at the gateway. Plain text on stdout,
 * separate from the structured logs.
 */
export function startupBanner(o: { version: string; url: string; setupDone: boolean; dataDir: string; masterKey: string; demo: boolean; inContainer: boolean }): string {
  const row = (label: string, value: string) => `     ${label.padEnd(12)}${value}`;
  const lines = [
    '',
    `  Control Tower ${o.version} is running`,
    '',
    row('Open', `${o.url}  → ${o.setupDone ? 'sign in' : 'create your admin account'}${o.inContainer ? '  (or the host port you published)' : ''}`),
    row('Models', `OPENAI_BASE_URL=${o.url}/v1       (OpenAI SDKs)`),
    row('', `ANTHROPIC_BASE_URL=${o.url}      (Claude Code, Anthropic SDKs)`),
    row('Tools', `${o.url}/mcp    ·    REST APIs: ${o.url}/http/<name>`),
    row('Data', o.dataDir),
    row('Back up', `${o.masterKey} — stored credentials are unreadable without it`),
  ];
  if (o.demo) lines.push(row('Demo', 'a synthetic agent fleet is flying; clear it from the console when you connect real providers'));
  lines.push('');
  return lines.join('\n') + '\n';
}
