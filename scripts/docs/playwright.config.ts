import { defineConfig } from '@playwright/test';

/**
 * Screenshots for docs/: `pnpm build && pnpm docs:screenshots`. Each test
 * starts its own server (a fresh install, or the demo fleet) and writes PNGs
 * to docs/images/. Not part of the test suite.
 */
export default defineConfig({
  testDir: '.',
  testMatch: ['screenshots.spec.ts', 'clients.spec.ts'],
  timeout: 240_000,
  expect: { timeout: 20_000 },
  workers: 1,
  reporter: 'list',
  use: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
});
