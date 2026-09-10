import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // Baselines are compared byte-for-byte, so they are only meaningful if the thing that renders
  // them is fixed. `scripts/visual.sh` runs this project inside a pinned Playwright image for that
  // reason, and the specs refuse to run outside it — hence no `{platform}` in the path below:
  // there is only ever one platform producing these.
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFileName}/{arg}{ext}',
  expect: {
    toHaveScreenshot: {
      // Font antialiasing still differs by a pixel here and there even in a fixed image; this is
      // tight enough to catch a moved element and loose enough not to fail on a rendered edge.
      maxDiffPixelRatio: 0.01,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    },
  },
  projects: [
    {
      name: 'chromium',
      // The visual project is opt-in: it needs the pinned container, and a normal run must not
      // try to compare screenshots taken wherever the developer happens to be.
      testIgnore: '**/visual/**',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'visual',
      testDir: './tests/e2e/visual',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: process.env.CI
    ? undefined
    : {
        command: 'pnpm docker:dev',
        url: 'http://localhost:3000',
        reuseExistingServer: true,
        timeout: 180_000,
      },
});
