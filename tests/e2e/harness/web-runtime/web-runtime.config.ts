import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'web-runtime.spec.ts',
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: 'http://127.0.0.1:46112',
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE },
    trace: 'retain-on-failure',
  },
  outputDir: process.env.WEB_RUNTIME_RESULTS ?? '/tmp/haive-web-runtime-results',
  webServer: {
    command: 'pnpm exec tsx tests/e2e/harness/web-runtime/server.mts',
    cwd: '../../../..',
    url: 'http://127.0.0.1:46112/tests/e2e/harness/web-runtime/index.html',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
