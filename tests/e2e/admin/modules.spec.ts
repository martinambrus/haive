import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { cleanupUser, getSql } from '../helpers/db.js';
import { API_BASE, registerUser } from '../helpers/auth.js';

/**
 * The admin Modules tab: the intent table's rows next to what the api and the worker loaded.
 *
 * The table is shared by every admin and written by the worker boot, so the spec seeds one row of
 * its own, named e2e-mod-<hex>, as a module that went missing, and removes it by id.
 */

test.describe('admin modules', () => {
  test('B1: the tab lists a recorded module that is no longer loaded as missing', async ({
    page,
  }) => {
    const sql = getSql();
    const moduleId = `e2e-mod-${randomBytes(3).toString('hex')}`;
    let userId = '';
    try {
      userId = (await registerUser(sql, page.request, { prefix: 'admin-mod', role: 'admin' }))
        .userId;
      await sql`
        insert into modules (module_id, package_name, name, installed_version, missing_at)
        values (${moduleId}, ${`@haive/module-${moduleId}`}, ${`E2E ${moduleId}`}, '0.0.1', now())
      `;
      await page.goto('/admin');
      await page.getByRole('main').getByRole('link', { name: 'Modules', exact: true }).click();
      await expect(page).toHaveURL(/\/admin\/modules$/, { timeout: 30_000 });

      const row = page.locator(`tr[data-module-id="${moduleId}"]`);
      await expect(row).toBeVisible({ timeout: 30_000 });
      await expect(row).toHaveAttribute('data-state', 'missing');
      await expect(row).toContainText(`E2E ${moduleId}`);
      await expect(row).toContainText('0.0.1');
      await expect(row).toContainText('Missing');
      await expect(page.getByTestId('worker-report')).toContainText(
        /Worker report|No worker report/,
      );
    } finally {
      await sql`delete from modules where module_id = ${moduleId}`;
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('B2: the loaded report is for an admin only', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      userId = (await registerUser(sql, page.request, { prefix: 'user-mod', role: 'user' })).userId;
      const res = await page.request.get(`${API_BASE}/modules/loaded`);
      expect(res.status()).toBe(403);
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });
});
