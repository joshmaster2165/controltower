import { defineConfig } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import { TEST_LICENSE_PUBLIC_KEY, testLicense } from './e2e/support/license';

const PORT = 4400;
const dataDir = path.join(os.tmpdir(), `ct-e2e-${process.pid}`);

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // No retries on the same server: CI runs the whole suite again on a fresh one instead (see .github/workflows/ci.yml).
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure', viewport: { width: 1400, height: 900 } },
  webServer: {
    command: `node server/dist/server.mjs`,
    url: `http://127.0.0.1:${PORT}/healthz`,
    env: { CT_PORT: String(PORT), CT_DATA_DIR: dataDir, CT_DEMO: '0', CT_LOG_LEVEL: 'warn', CT_UI_DIR: path.resolve('ui/dist'), CT_PUSH_ALLOW_PRIVATE: '1', CT_MODEL_HEALTH_INTERVAL_S: '0', CT_SETUP_TOKEN: 'E2E-SETUP-CODE', CT_LOGIN_RPM: '1000', CT_NOTIFY_REQUESTERS_AFTER_S: '2', CT_LICENSE_PUBLIC_KEY: TEST_LICENSE_PUBLIC_KEY, CT_LICENSE_KEY: testLicense(), ...(process.env.E2E_DATABASE_URL ? { CT_DATABASE_URL: process.env.E2E_DATABASE_URL } : {}) },
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
