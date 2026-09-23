// Assembles the npm package (`npx controltower-ai`) in dist-npm/ from the built
// server bundle and console. Run after `pnpm build`:
//   node scripts/build-npm.mjs && (cd dist-npm && npm pack)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const out = path.join(root, 'dist-npm');
const require = createRequire(path.join(root, 'server', 'package.json'));
const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const sqliteVersion = require('better-sqlite3/package.json').version;

for (const need of ['server/dist/server.mjs', 'ui/dist/index.html']) {
  if (!fs.existsSync(path.join(root, need))) throw new Error(`${need} is missing — run \`pnpm build\` first`);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'bin'), { recursive: true });
fs.cpSync(path.join(root, 'server', 'dist'), path.join(out, 'dist'), { recursive: true });
fs.cpSync(path.join(root, 'ui', 'dist'), path.join(out, 'ui'), { recursive: true });
for (const f of ['LICENSE', 'THIRD_PARTY.md']) fs.copyFileSync(path.join(root, f), path.join(out, f));

fs.writeFileSync(
  path.join(out, 'package.json'),
  JSON.stringify(
    {
      name: 'controltower-ai',
      version: rootPkg.version,
      description: 'Self-hosted AI gateway for LLM, MCP and HTTP traffic with a live map of every agentic data flow — gate, approve, inspect and account for each call.',
      license: 'Apache-2.0',
      homepage: 'https://joshmaster2165.github.io/controltower/',
      repository: { type: 'git', url: 'git+https://github.com/joshmaster2165/controltower.git' },
      bugs: 'https://github.com/joshmaster2165/controltower/issues',
      keywords: ['ai-gateway', 'llm-gateway', 'mcp', 'ai-agents', 'guardrails', 'observability', 'self-hosted'],
      type: 'module',
      bin: { 'controltower-ai': 'bin/controltower.mjs' },
      files: ['bin', 'dist', 'ui', 'LICENSE', 'THIRD_PARTY.md'],
      engines: { node: '>=24' },
      dependencies: { 'better-sqlite3': `^${sqliteVersion}` },
    },
    null,
    2,
  ) + '\n',
);

fs.writeFileSync(
  path.join(out, 'bin', 'controltower.mjs'),
  `#!/usr/bin/env node
// npx controltower-ai [--port 4000] [--data ~/.controltower] [--demo]
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [major] = process.versions.node.split('.').map(Number);
if (major < 24) {
  console.error(\`Control Tower needs Node.js 24 or newer; this is \${process.version}. Or run it with Docker: docker run -p 4000:4000 -v controltower-data:/data ghcr.io/joshmaster2165/controltower\`);
  process.exit(1);
}

const args = process.argv.slice(2);
const value = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
if (args.includes('--help') || args.includes('-h')) {
  console.log(\`Control Tower — self-hosted AI gateway with a live map of your agents.

  npx controltower-ai [options]

  --port <n>     listen port (default 4000, or CT_PORT / PORT)
  --data <dir>   where the database and master key live (default ~/.controltower, or CT_DATA_DIR)
  --demo         start with a synthetic agent fleet on the map
  --version      print the version

Every CT_* setting in the README works as an environment variable too.\`);
  process.exit(0);
}
const here = path.dirname(fileURLToPath(import.meta.url));
if (args.includes('--version')) {
  const { default: pkg } = await import(path.join(here, '..', 'package.json'), { with: { type: 'json' } });
  console.log(pkg.version);
  process.exit(0);
}
if (value('--port')) process.env.CT_PORT = value('--port');
if (value('--data')) process.env.CT_DATA_DIR = path.resolve(value('--data'));
if (args.includes('--demo')) process.env.CT_DEMO = '1';
process.env.CT_DATA_DIR ??= path.join(os.homedir(), '.controltower');
process.env.CT_UI_DIR ??= path.join(here, '..', 'ui');
process.env.NODE_ENV ??= 'production';

await import('../dist/server.mjs');
`,
  { mode: 0o755 },
);

fs.writeFileSync(
  path.join(out, 'README.md'),
  `# Control Tower

Self-hosted AI gateway for LLM, MCP and HTTP traffic with a live map of every agentic data flow — gate, approve, inspect and account for each call.

\`\`\`bash
npx controltower-ai
\`\`\`

Then open http://localhost:4000 and follow **Get started**: connect a provider, create a key for your agent, and point it at Control Tower with two environment variables. Data lives in \`~/.controltower\` (back up \`master.key\`). Needs Node.js 24+.

\`\`\`bash
npx controltower-ai --port 4100 --demo     # another port, with a demo fleet on the map
\`\`\`

Docker, Render, Fly.io and docs: https://github.com/joshmaster2165/controltower
`,
);

console.log(`dist-npm/ ready: controltower-ai@${rootPkg.version} (better-sqlite3 ^${sqliteVersion})`);
