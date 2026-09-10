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
      // 0.1%, not 1%. At 1280x800 one percent is ten thousand pixels — enough for a button to
      // move, or for Next's dev-tools badge to appear, without the comparison noticing. MEASURED:
      // that badge is ~0.35% of the viewport and slipped under the old threshold, so a stale
      // baseline containing it kept "passing". The rendering environment is pinned, so the only
      // thing this tolerance has to absorb is the odd antialiased edge.
      maxDiffPixelRatio: 0.001,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
      // Hides Next's dev-tools badge, which carries a live issue count and would otherwise
      // change a baseline whenever the dev server's warning count did. See the file.
      stylePath: './tests/e2e/visual/screenshot.css',
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
