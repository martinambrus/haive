import { expect, test, type Page } from '@playwright/test';
import {
  cleanupTaskFixture,
  cleanupUser,
  getSql,
  readStepStatus,
  seedTaskFixture,
  type TaskFixture,
} from '../helpers/db.js';
import { registerUser, uniqueEmail } from '../helpers/auth.js';

async function waitForStepStatus(
  sql: ReturnType<typeof getSql>,
  stepPkId: string,
  expected: string,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = (await readStepStatus(sql, stepPkId)) ?? '';
    if (last === expected) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `step ${stepPkId} did not reach ${expected} within ${timeoutMs}ms (last: ${last})`,
  );
}

async function gotoTaskDetail(page: Page, taskId: string): Promise<void> {
  await page.goto(`/tasks/${taskId}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

test.describe('step retry/skip UI', () => {
  test('retry button on failed step resets step to pending', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    let fixture: TaskFixture | null = null;

    try {
      const email = uniqueEmail('retry-ui');
      userId = (await registerUser(sql, page.request, { email })).userId;
      fixture = await seedTaskFixture(sql, userId, 'retry');

      page.on('dialog', (d) => {
        void d.accept();
      });

      await gotoTaskDetail(page, fixture.taskId);

      // Scope to the step card — the page also renders a task-level "Retry"
      // button at the top when the task is failed, which would otherwise
      // collide with this selector.
      // The card is keyed on the step ROW id, not the step_id slug — page.tsx renders
      // `data-step-id={step.id}`. The old spec used the slug and never matched; it simply
      // never ran to find out.
      const stepCard = page.locator(`[data-step-id="${fixture.failedStepId}"]`);
      const stepRetry = stepCard.getByRole('button', { name: 'Retry', exact: true });
      await expect(stepCard).toBeVisible();
      await expect(stepRetry).toBeVisible();

      await stepRetry.click();

      // Deliberately NOT polling for status === 'pending'. Retry writes that synchronously, then
      // the worker picks the task up and moves it straight on — to running, and then back to
      // failed, because a fixture task has no resolvable repo path. The poll ticks every 200ms,
      // so whether it catches that window is a coin flip: CI reported this test flaky on exactly
      // that race, passing on retry. The durable evidence is the event below, written in the same
      // transaction as the flip, which is what this test's own comment already says.
      //
      // The step.retry event is inserted in the same transaction as the
      // step flip, so it is observable even if the worker has already
      // re-processed and re-failed the task. Polled, because the click only sends the request.
      const { taskId } = fixture;
      await expect
        .poll(
          async () => {
            const events = await sql<{ event_type: string }[]>`
              select event_type from task_events
              where task_id = ${taskId} and event_type = 'step.retry'
            `;
            return events.length;
          },
          { timeout: 10_000 },
        )
        .toBe(1);
      // Payload-shape assertions (priorStatus, cascadedSteps) are covered by
      // the API-level retry tests; the UI test only verifies that the button
      // wired up to the action endpoint.

      // The button's disappearance is NOT asserted, and this is the same race as the status poll
      // above wearing a different hat: Retry hides while the step is pending and comes back the
      // moment the worker re-fails it, which on a repo-less fixture is immediate. CI caught this
      // one on the run after the poll was removed. What the test is actually for — that the
      // button is wired to the action endpoint — is proven by the event.
    } finally {
      if (fixture) await cleanupTaskFixture(sql, fixture.taskId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('skip button marks the failed step skipped', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    let fixture: TaskFixture | null = null;

    try {
      const email = uniqueEmail('skip-ui');
      userId = (await registerUser(sql, page.request, { email })).userId;
      fixture = await seedTaskFixture(sql, userId, 'skip');

      page.on('dialog', (d) => {
        void d.accept();
      });

      await gotoTaskDetail(page, fixture.taskId);
      const stepCard = page.locator(`[data-step-id="${fixture.failedStepId}"]`);
      const skipButton = stepCard.getByRole('button', { name: 'Skip', exact: true });
      await expect(skipButton).toBeVisible();

      await skipButton.click();

      const finalStatus = await waitForStepStatus(sql, fixture.failedStepId, 'skipped');
      expect(finalStatus).toBe('skipped');

      // Advancement is NOT asserted, for the reason the api's own skip handler gives: it cannot
      // see unmaterialized future steps, so it enqueues ADVANCE_STEP and the worker walks the run
      // list. On a fixture task that worker loses — it fails with "has no resolvable repo path",
      // because the fixture has no repository. Measured: the task stays failed on the skipped
      // step. What skip guarantees synchronously is the step row and the event, both below.

      const events = await sql<{ event_type: string }[]>`
        select event_type from task_events
        where task_id = ${fixture.taskId} and event_type = 'step.skip'
      `;
      expect(events).toHaveLength(1);
    } finally {
      if (fixture) await cleanupTaskFixture(sql, fixture.taskId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });
});
