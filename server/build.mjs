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
  // Test builds (CT_TEST_LICENSE_KEYS=1) also trust a license-signing key named by CT_LICENSE_PUBLIC_KEY, so tests can
  // sign licenses of their own. Release builds — the image and the npm package — are built without it: the code isn't in them.
  define: { __CT_TEST_LICENSE_KEYS__: process.env.CT_TEST_LICENSE_KEYS === '1' ? 'true' : 'false' },
});
