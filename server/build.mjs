import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  outfile: 'dist/server.mjs',
  sourcemap: true,
  external: ['better-sqlite3', 'pg'],
  banner: {
    js: "import { createRequire as __ctCreateRequire } from 'node:module'; const require = __ctCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
});
