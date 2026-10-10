import { expect, test } from '@playwright/test';
import { cleanupUser, getSql } from '../helpers/db.js';
import { registerUser } from '../helpers/auth.js';

/** A failed entry as the list route sends it, seeded by a task now in `sourceTaskStatus`. */
function failedEntry(id: string, title: string, sourceTaskStatus: string) {
  const at = new Date().toISOString();
  return {
    id,
    namespace: 'default',
    userId: null,
    title,
    seedText: 'Seed notes the person wrote',
    body: '',
    category: 'general',
    facets: {},
    status: 'failed',
    source: 'user',
    sourceTaskId: `${id.slice(0, -1)}f`,
    sourceTaskStatus,
    sourceRepoId: null,
    contentHash: null,
    embedStatus: 'pending',
    createdAt: at,
    updatedAt: at,
    supersedesEntryId: null,
    supersededAt: null,
  };
}

test.describe('global KB entries', () => {
  test('a failed entry offers Retry only while its task can be retried', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      userId = (await registerUser(sql, page.request, { prefix: 'kb-retry' })).userId;
      // Fulfilled without the real call, which in CI outlasted the 5 s expect below.
      await page.route(
        (url) => url.pathname === '/global-kb/entries',
        async (route) => {
          await route.fulfill({
            headers: {
              'access-control-allow-origin': 'http://localhost:3000',
              'access-control-allow-credentials': 'true',
            },
            json: {
              entries: [
                failedEntry('00000000-0000-4000-8000-0000000000e1', 'Can run again', 'failed'),
                failedEntry(
                  '00000000-0000-4000-8000-0000000000e2',
                  'Task was cancelled',
                  'cancelled',
                ),
              ],
              total: 2,
              page: 1,
              pageSize: 12,
              frameworks: [],
            },
          });
        },
      );
      await page.goto('/settings/global-kb');

      const row = (title: string) => page.getByText(title, { exact: true }).locator('xpath=..');
      const card = (title: string) => row(title).locator('xpath=..');
      await expect(row('Can run again').getByRole('button', { name: 'Retry' })).toBeVisible();
      await expect(card('Can run again')).toContainText(
        'Enrichment failed — retry, or open the task for details.',
      );
      const cancelled = row('Task was cancelled');
      await expect(cancelled.getByRole('button', { name: 'Go to task' })).toBeVisible();
      await expect(cancelled.getByRole('button', { name: 'Delete' })).toBeVisible();
      await expect(cancelled.getByRole('button', { name: 'Retry' })).toHaveCount(0);
      await expect(card('Task was cancelled')).toContainText(
        'Enrichment failed — open the task for details.',
      );
      await expect(card('Task was cancelled')).not.toContainText('retry');
    } finally {
      // The page polls the list. Drain route callbacks before deleting its user
      // or closing the fixture, otherwise a callback can outlive the test.
      await page.unrouteAll({ behavior: 'wait' });
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });
});
