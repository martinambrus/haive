import { defineConfig } from '@playwright/test';

// Explicit opt-in, no dev-stack startup or global setup. Start the fixture API and branch web
// server as described in docs/architecture/session-recovery.md.
export default defineConfig({
  testDir: '../..',
  testMatch: process.env.SESSION_RECOVERY_AUTH_CHECKS
    ? ['**/harness/session-recovery/session-recovery.spec.ts', '**/auth/session.spec.ts']
    : '**/harness/session-recovery/*.spec.ts',
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: 'http://127.0.0.1:46100',
    trace: 'retain-on-failure',
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE },
  },
  outputDir: process.env.SESSION_RECOVERY_RESULTS ?? '/tmp/haive-session-recovery-results',
});
