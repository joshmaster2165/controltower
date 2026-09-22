import { defineConfig } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';

const PORT = 4400;
const dataDir = path.join(os.tmpdir(), `ct-e2e-${process.pid}`);

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure', viewport: { width: 1400, height: 900 } },
  webServer: {
    command: `node server/dist/server.mjs`,
    url: `http://127.0.0.1:${PORT}/healthz`,
    env: { CT_PORT: String(PORT), CT_DATA_DIR: dataDir, CT_DEMO: '0', CT_LOG_LEVEL: 'warn', CT_UI_DIR: path.resolve('ui/dist') },
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
