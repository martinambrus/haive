import { expect, test } from '@playwright/test';
import {
  cleanupTaskFixture,
  cleanupUser,
  getSql,
  seedTaskFixture,
  type TaskFixture,
  FIXTURE_FAILED_STEP_ID,
} from '../helpers/db.js';
import { registerUser, uniqueEmail } from '../helpers/auth.js';
import { actionLabels, openActionMenu } from '../helpers/actions.js';

test.describe('task detail page', () => {
  test('renders heading, status, all step cards, error, and tab switching', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    let fixture: TaskFixture | null = null;
    try {
      const email = uniqueEmail('task-detail');
      userId = (await registerUser(sql, page.request, { email })).userId;
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
      const failingStepCard = page.locator(`[data-step-id="${FIXTURE_FAILED_STEP_ID}"]`);
      await expect(
        failingStepCard.getByRole('button', { name: 'Retry', exact: true }),
      ).toBeVisible();
      await expect(
        failingStepCard.getByRole('button', { name: 'Skip', exact: true }),
      ).toBeVisible();

      // The task's own actions live behind the header's "Actions" menu — ActionMenu collapses
      // two or more into a role="menu" — while a failed step card keeps its Retry as a plain
      // button. So the only Retry BUTTON on the page is the step's, and the task-level one is a
      // menuitem. That distinction is the whole point: they post to different routes.
      await expect(
        page.getByRole('button', { name: 'Retry', exact: true }),
        'the step card owns the only plain Retry button',
      ).toHaveCount(1);

      const labels = await actionLabels(page);
      expect(labels).toContain('Retry');
      // Cancel stays available on a failed task: the page offers it for any status outside
      // {completed, cancelled}, so a failed task remains abortable.
      expect(labels).toContain('Cancel');
      // Resume is Pause's complement and must not be offered on a task nobody paused. This
      // replaces an assertion that claimed Pause/Resume were "not implemented" — they are
      // (POST /tasks/:id/action handles both); it passed only because the menu was shut.
      expect(labels).not.toContain('Resume');
      await page.keyboard.press('Escape');

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
      userId = (await registerUser(sql, page.request, { email })).userId;
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
      userId = (await registerUser(sql, page.request, { email })).userId;
      fixture = await seedTaskFixture(sql, userId, 'retry-task');

      await page.goto(`/tasks/${fixture.taskId}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

      // Through the header menu, NOT `getByRole('button', { name: 'Retry' }).first()`. Once the
      // task-level actions moved behind ActionMenu, the only Retry button left on the page was
      // the STEP card's, so `.first()` quietly retried the step instead: it posts to
      // /tasks/:id/steps/:id/action, emits step.retry rather than task.retried, and the poll
      // below would then spin for its full 10s and fail — after the click had already done
      // something. There is exactly one ActionMenu on this page, so the menu is unambiguous.
      const menu = await openActionMenu(page);
      await menu.getByRole('menuitem', { name: 'Retry', exact: true }).click();

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
