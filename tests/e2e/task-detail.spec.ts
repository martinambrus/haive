import { expect, test, type APIRequestContext } from '@playwright/test';
import {
  cleanupTaskFixture,
  cleanupUser,
  getSql,
  seedTaskFixture,
  type TaskFixture,
} from './helpers/db.js';

const API_BASE = process.env.PLAYWRIGHT_API_BASE ?? 'http://localhost:3001';
const PASSWORD = 'e2e-password-12345';

function uniqueEmail(prefix: string): string {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${stamp}-${rand}@haive-e2e.test`;
}

async function registerAndGetUserId(request: APIRequestContext, email: string): Promise<string> {
  const res = await request.post(`${API_BASE}/auth/register`, {
    data: { email, password: PASSWORD },
  });
  expect(res.status(), `register failed: ${await res.text()}`).toBe(201);
  const body = (await res.json()) as { user: { id: string } };
  return body.user.id;
}

test.describe('task detail page', () => {
  test('renders heading, status, all step cards, error, and tab switching', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    let fixture: TaskFixture | null = null;
    try {
      const email = uniqueEmail('task-detail');
      userId = await registerAndGetUserId(page.request, email);
      fixture = await seedTaskFixture(sql, userId, 'detail');

      await page.goto(`/tasks/${fixture.taskId}`);

      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Back to tasks' })).toBeVisible();

      // status + type badges
      await expect(page.getByText('failed', { exact: true }).first()).toBeVisible();
      await expect(page.getByText('workflow', { exact: true })).toBeVisible();

      // all 3 steps render
      await expect(page.getByRole('heading', { level: 3, name: 'Failing step' })).toBeVisible();
      await expect(page.getByRole('heading', { level: 3, name: 'Middle step' })).toBeVisible();
      await expect(page.getByRole('heading', { level: 3, name: 'Last step' })).toBeVisible();

      // error message rendered for failed step
      await expect(page.getByText('kaboom')).toBeVisible();

      // step action buttons present on failed step (scoped to the step card,
      // since "Retry" also appears as the task-level button at the page top)
      const failingStepCard = page.locator('[data-step-id="failing-step"]');
      await expect(
        failingStepCard.getByRole('button', { name: 'Retry', exact: true }),
      ).toBeVisible();
      await expect(
        failingStepCard.getByRole('button', { name: 'Skip', exact: true }),
      ).toBeVisible();

      // task-level Retry button visible (status=failed). Both step-level and
      // task-level buttons are labeled "Retry" — match by count rather than
      // strict locator, since the strict-mode locator now has 2 matches.
      await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(2);

      // Pause/Resume are not implemented in the current API/UI.
      await expect(page.getByRole('button', { name: 'Pause' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Resume' })).toHaveCount(0);

      // Cancel IS visible for failed tasks — page.tsx exposes Cancel for any
      // status not in {completed, cancelled} so failed tasks remain abortable.
      await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();

      // Tabs present + switch to Activity
      await page.getByRole('button', { name: 'Activity' }).click();
      await expect(page.getByText('No events yet.')).toBeVisible();

      await page.getByRole('button', { name: 'Steps' }).click();
      await expect(page.getByRole('heading', { level: 3, name: 'Failing step' })).toBeVisible();
    } finally {
      if (fixture) await cleanupTaskFixture(sql, fixture.taskId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('Activity tab renders seeded task_events rows with type and payload', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    let fixture: TaskFixture | null = null;
    try {
      const email = uniqueEmail('task-activity');
      userId = await registerAndGetUserId(page.request, email);
      fixture = await seedTaskFixture(sql, userId, 'activity');

      await sql`
        insert into task_events (task_id, task_step_id, event_type, payload)
        values (
          ${fixture.taskId}, null, 'task.created',
          ${sql.json({ note: 'seed-event-note' })}
        )
      `;

      await page.goto(`/tasks/${fixture.taskId}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

      await page.getByRole('button', { name: 'Activity' }).click();

      await expect(page.getByText('No events yet.')).toHaveCount(0);
      await expect(page.getByText('task.created')).toBeVisible();
      await expect(page.getByText(/seed-event-note/)).toBeVisible();
    } finally {
      if (fixture) await cleanupTaskFixture(sql, fixture.taskId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('clicking task-level Retry transitions task to queued', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    let fixture: TaskFixture | null = null;
    try {
      const email = uniqueEmail('task-detail-retry');
      userId = await registerAndGetUserId(page.request, email);
      fixture = await seedTaskFixture(sql, userId, 'retry-task');

      await page.goto(`/tasks/${fixture.taskId}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

      // The page renders 2 "Retry" buttons (task-level in the page header,
      // step-level in the failing step card). Click the task-level one — it's
      // the first match, in the page-header region.
      await page.getByRole('button', { name: 'Retry', exact: true }).first().click();

      // The retry transaction inserts task.retried in task_events and clears
      // errorMessage synchronously. Both are race-proof even when the worker
      // picks up the START job and re-fails the fixture task immediately.
      const deadline = Date.now() + 10_000;
      let retried = false;
      while (Date.now() < deadline) {
        const events = await sql<{ event_type: string }[]>`
          select event_type from task_events
          where task_id = ${fixture.taskId} and event_type = 'task.retried'
        `;
        if (events.length > 0) {
          retried = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(retried).toBe(true);
    } finally {
      if (fixture) await cleanupTaskFixture(sql, fixture.taskId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });
});
