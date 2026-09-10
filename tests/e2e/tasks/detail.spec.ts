import { expect, test } from '@playwright/test';
import {
  cleanupTaskFixture,
  cleanupUser,
  getSql,
  seedTaskFixture,
  type TaskFixture,
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
      // The card is keyed on the step ROW id, not the step_id slug — page.tsx renders
      // `data-step-id={step.id}`. The old spec used the slug and never matched; it simply
      // never ran to find out.
      const failingStepCard = page.locator(`[data-step-id="${fixture.failedStepId}"]`);
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
      // EVERY step card carries its own Retry button — retry is permitted on any status, not
      // only a failed one — so the count tracks the number of cards. What matters is that the
      // task-level action is not among them: it is a menuitem, asserted below.
      const stepCards = page.locator('[data-step-id]');
      await expect(
        page.getByRole('button', { name: 'Retry', exact: true }),
        'each step card has a Retry button and the header has none',
      ).toHaveCount(await stepCards.count());

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

  test('the header Retry recovers the failed step', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    let fixture: TaskFixture | null = null;
    try {
      const email = uniqueEmail('task-detail-retry');
      userId = (await registerUser(sql, page.request, { email })).userId;
      fixture = await seedTaskFixture(sql, userId, 'retry-task');

      await page.goto(`/tasks/${fixture.taskId}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

      // The header's Retry is CONTEXTUAL and this test used to misread it. Whenever the task has
      // a failed step, `primaryRecovery` makes the header offer that step's own recovery — "the
      // header Retry and the failed step's own card must offer the SAME primary action" — so it
      // posts to /tasks/:id/steps/:id/action and emits step.retry. `task.retried` fires only for
      // a failed task with no failed step, which this fixture is not. Asserting it here could
      // never have passed.
      //
      // It also goes through window.confirm, which Playwright DISMISSES by default — so without
      // this handler the click did nothing at all and the failure looked like a timing problem.
      page.on('dialog', (d) => {
        void d.accept();
      });
      const menu = await openActionMenu(page);
      await menu.getByRole('menuitem', { name: 'Retry', exact: true }).click();

      // The step reset is synchronous in the handler's transaction, so this is race-proof even
      // though the worker picks the task up and re-fails it moments later.
      const deadline = Date.now() + 10_000;
      let recovered = false;
      while (Date.now() < deadline) {
        const events = await sql<{ event_type: string }[]>`
          select event_type from task_events
          where task_id = ${fixture.taskId} and event_type = 'step.retry'
        `;
        if (events.length > 0) {
          recovered = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(recovered, 'the header action recovers the failed step').toBe(true);

      const step = await sql<{ status: string }[]>`
        select status from task_steps where id = ${fixture.failedStepId}
      `;
      expect(step[0]!.status, 'the failed step is reset').not.toBe('failed');
    } finally {
      if (fixture) await cleanupTaskFixture(sql, fixture.taskId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });
});
