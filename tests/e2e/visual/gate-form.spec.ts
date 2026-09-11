import { expect, test } from '@playwright/test';
import { cleanupTaskFixture, cleanupUser, getSql } from '../helpers/db.js';
import { registerUser } from '../helpers/auth.js';
import { seedGate } from '../helpers/gate.js';
import { assertPinnedRunner } from '../helpers/visual.js';

/**
 * The gate form — the screen a person spends their decision time on, and the one surface in the
 * product whose layout nothing else pins.
 *
 * Screenshotted as an ELEMENT rather than a page, which is the whole reason this one can exist at
 * all. The task page around it carries a created-at timestamp and the sidebar carries the run's
 * unique email address; a full-page baseline would rot on the calendar and mask badly. The form
 * itself is rendered from a fixed schema in `helpers/gate.ts`, so it has no timestamp, no id and
 * nothing generated — it is the same picture today and next month.
 */

test.use({ viewport: { width: 1280, height: 900 } });

test.beforeAll(() => {
  assertPinnedRunner();
});

test.describe('visual baselines', () => {
  test('gate form', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    let gate = null as Awaited<ReturnType<typeof seedGate>> | null;
    try {
      userId = (await registerUser(sql, page.request, { prefix: 'vis-gate' })).userId;
      gate = await seedGate(sql, userId, 'visual');

      await page.goto(`/tasks/${gate.taskId}`);
      await expect(page.getByRole('heading', { name: 'E2E gate' })).toBeVisible();

      // The form the renderer produced: title, description, the three input shapes and the
      // schema's own submit label.
      const form = page.locator('form').filter({
        has: page.getByRole('button', { name: 'Submit gate' }),
      });
      await expect(form).toBeVisible();
      await expect(form).toHaveScreenshot('gate-form.png');
    } finally {
      if (gate) await cleanupTaskFixture(sql, gate.taskId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });
});
