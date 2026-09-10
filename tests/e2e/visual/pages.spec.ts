import { expect, test } from '@playwright/test';
import { cleanupUser, getSql } from '../helpers/db.js';
import { registerUser } from '../helpers/auth.js';
import { assertPinnedRunner } from '../helpers/visual.js';

/**
 * Five baselines, deliberately not fifty.
 *
 * Every page here is one a FRESH user sees, because that is what makes a screenshot stable: empty
 * states have no timestamps, no durations, no token counts and no ids. The dashboard and the stats
 * tabs were left out of this first set on purpose — their heatmap prints month labels that shift
 * with the calendar, so a baseline of either rots on its own within weeks. They are worth adding
 * once this mechanism has proven itself, with those regions masked.
 *
 * The one dynamic thing that cannot be avoided is the signed-in user's own address in the sidebar,
 * which is unique per run by construction. It is masked rather than worked around.
 */

test.use({ viewport: { width: 1280, height: 800 } });

test.beforeAll(() => {
  assertPinnedRunner();
});

test.describe('visual baselines', () => {
  test('login page', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Sign in to Haive' })).toBeVisible();
    await expect(page).toHaveScreenshot('login.png', { fullPage: true });
  });

  // The closed state is the one every visitor of a default install meets, so it is the one worth
  // pinning.
  test('register page, registration closed', async ({ page }) => {
    await page.goto('/register');
    await expect(page.getByRole('heading', { name: 'Registration is closed' })).toBeVisible();
    await expect(page).toHaveScreenshot('register-closed.png', { fullPage: true });
  });

  test('tasks list, empty', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      const user = await registerUser(sql, page.request, { prefix: 'vis-tasks' });
      userId = user.userId;

      await page.goto('/tasks');
      await expect(page.getByRole('heading', { level: 1, name: 'Tasks' })).toBeVisible();
      await expect(page).toHaveScreenshot('tasks-empty.png', {
        fullPage: true,
        mask: [page.getByText(user.email)],
      });
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('repositories list, empty', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      const user = await registerUser(sql, page.request, { prefix: 'vis-repos' });
      userId = user.userId;

      await page.goto('/repos');
      await expect(page.getByRole('heading', { level: 1, name: 'Repositories' })).toBeVisible();
      await expect(page).toHaveScreenshot('repos-empty.png', {
        fullPage: true,
        mask: [page.getByText(user.email)],
      });
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  // This one earns its place beyond layout: the page renders a card per catalog entry, so adding
  // or renaming a CLI shows up here as a real, reviewable picture rather than a number in a test.
  test('cli providers, none configured', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      const user = await registerUser(sql, page.request, { prefix: 'vis-cli' });
      userId = user.userId;

      await page.goto('/cli-providers');
      await expect(page.getByRole('heading', { level: 1, name: 'CLI Providers' })).toBeVisible();
      await expect(page).toHaveScreenshot('cli-providers-empty.png', {
        fullPage: true,
        mask: [page.getByText(user.email)],
      });
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });
});
