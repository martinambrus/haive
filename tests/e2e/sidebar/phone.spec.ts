import { expect, test, type Page } from '@playwright/test';
import { cleanupUser, getSql } from '../helpers/db.js';
import { registerUser } from '../helpers/auth.js';
import { waitForShellHydration } from '../helpers/shell.js';

/**
 * Below md the sidebar is a rail until someone opens it. The rail is painted before any script
 * runs, and opening it never touches the saved preference, which belongs to the wider layout.
 */

const PHONE = { width: 375, height: 800 };

async function railWidth(page: Page): Promise<number> {
  return (await page.locator('aside').boundingBox())!.width;
}

test.describe('the sidebar at phone width', () => {
  test.describe('before any script runs', () => {
    test.use({ javaScriptEnabled: false, viewport: PHONE });

    test('paints the rail, not the saved column', async ({ page }) => {
      const sql = getSql();
      let userId = '';
      try {
        userId = (await registerUser(sql, page.request, { prefix: 'side-phone-ssr' })).userId;

        await page.goto('/dashboard');
        expect(await railWidth(page)).toBe(56);
        await expect(page.locator('aside').getByText('Active tasks', { exact: true })).toBeHidden();
      } finally {
        if (userId) await cleanupUser(sql, userId);
        await sql.end({ timeout: 5 });
      }
    });
  });

  test.describe('once hydrated', () => {
    test.use({ viewport: PHONE });

    test('opens over the page and saves nothing', async ({ page }) => {
      const sql = getSql();
      let userId = '';
      try {
        userId = (await registerUser(sql, page.request, { prefix: 'side-phone-open' })).userId;

        await page.goto('/dashboard');
        await waitForShellHydration(page);
        const aside = page.locator('aside');
        expect(await railWidth(page)).toBe(56);
        const mainLeft = (await page.locator('main').boundingBox())!.x;

        await aside.getByRole('button', { name: 'Expand sidebar' }).click();
        await expect(aside.getByText('Active tasks', { exact: true })).toBeVisible();
        expect(await railWidth(page)).toBeGreaterThan(56);
        // Over the page, not beside it: the page stays where the rail left it.
        expect((await page.locator('main').boundingBox())!.x).toBe(mainLeft);

        // The page under the backdrop is out of the keyboard's reach too.
        for (let i = 0; i < 30; i++) {
          await page.keyboard.press('Tab');
          expect(await page.evaluate(() => !!document.activeElement?.closest('main'))).toBe(false);
        }

        // A tap outside the column closes it.
        await page
          .getByRole('button', { name: 'Close sidebar' })
          .click({ position: { x: PHONE.width - 10, y: PHONE.height / 2 } });
        await expect(aside.getByText('Active tasks', { exact: true })).toBeHidden();
        expect(await railWidth(page)).toBe(56);
        await expect(page.locator('main')).not.toHaveAttribute('inert');

        const rows = await sql<{ settings_json: string }[]>`
          select settings_json from user_ui_prefs where user_id = ${userId}
        `;
        const saved = rows[0] ? (JSON.parse(rows[0].settings_json) as Record<string, unknown>) : {};
        expect(saved.sidebarCollapsed).toBeUndefined();
      } finally {
        if (userId) await cleanupUser(sql, userId);
        await sql.end({ timeout: 5 });
      }
    });

    test('Escape closes it', async ({ page }) => {
      const sql = getSql();
      let userId = '';
      try {
        userId = (await registerUser(sql, page.request, { prefix: 'side-phone-esc' })).userId;

        await page.goto('/dashboard');
        await waitForShellHydration(page);
        const aside = page.locator('aside');

        await aside.getByRole('button', { name: 'Expand sidebar' }).click();
        await expect(page.getByRole('button', { name: 'Close sidebar' })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(aside.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
      } finally {
        if (userId) await cleanupUser(sql, userId);
        await sql.end({ timeout: 5 });
      }
    });

    test('a navigation closes it, and coming back does not reopen it', async ({ page }) => {
      const sql = getSql();
      let userId = '';
      try {
        userId = (await registerUser(sql, page.request, { prefix: 'side-phone-nav' })).userId;

        await page.goto('/dashboard');
        await waitForShellHydration(page);
        const aside = page.locator('aside');

        await aside.getByRole('button', { name: 'Expand sidebar' }).click();
        await aside.getByRole('link', { name: 'Tasks', exact: true }).click();
        await expect(page).toHaveURL(/\/tasks$/);
        await expect(aside.getByText('Active tasks', { exact: true })).toBeHidden();

        await page.goBack();
        await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
        await expect(aside.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
      } finally {
        if (userId) await cleanupUser(sql, userId);
        await sql.end({ timeout: 5 });
      }
    });

    test('leaving the phone layout closes it, and coming back does not reopen it', async ({
      page,
    }) => {
      const sql = getSql();
      let userId = '';
      try {
        userId = (await registerUser(sql, page.request, { prefix: 'side-phone-rotate' })).userId;

        await page.goto('/dashboard');
        await waitForShellHydration(page);
        const aside = page.locator('aside');

        await aside.getByRole('button', { name: 'Expand sidebar' }).click();
        await expect(page.getByRole('button', { name: 'Close sidebar' })).toBeVisible();

        // The resizer exists only in the wide layout, so it proves that layout has rendered.
        await page.setViewportSize({ width: 1024, height: PHONE.height });
        await expect(page.getByRole('separator', { name: 'Resize sidebar' })).toBeVisible();

        await page.setViewportSize(PHONE);
        await expect(aside.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
      } finally {
        if (userId) await cleanupUser(sql, userId);
        await sql.end({ timeout: 5 });
      }
    });
  });
});
