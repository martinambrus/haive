import { expect, test, type Page } from '@playwright/test';
import {
  cleanupTaskFixture,
  cleanupUser,
  getSql,
  readStepStatus,
  readTaskStatus,
  seedTaskFixture,
  type TaskFixture,
  FIXTURE_FAILED_STEP_ID,
  FIXTURE_MIDDLE_STEP_ID,
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

async function waitForTaskState(
  sql: ReturnType<typeof getSql>,
  taskId: string,
  expected: { status?: string; currentStepId?: string },
  timeoutMs = 10_000,
): Promise<{ status: string; currentStepId: string | null }> {
  const deadline = Date.now() + timeoutMs;
  let last: { status: string; currentStepId: string | null } | null = null;
  while (Date.now() < deadline) {
    last = await readTaskStatus(sql, taskId);
    if (
      last &&
      (expected.status === undefined || last.status === expected.status) &&
      (expected.currentStepId === undefined || last.currentStepId === expected.currentStepId)
    ) {
      return last;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `task ${taskId} did not reach ${JSON.stringify(expected)} within ${timeoutMs}ms (last: ${JSON.stringify(last)})`,
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

      const finalStatus = await waitForStepStatus(sql, fixture.failedStepId, 'pending');
      expect(finalStatus).toBe('pending');

      const taskState = await waitForTaskState(sql, fixture.taskId, {
        currentStepId: FIXTURE_FAILED_STEP_ID,
      });
      expect(taskState.currentStepId).toBe(FIXTURE_FAILED_STEP_ID);

      // The step.retry event is inserted in the same transaction as the
      // step flip, so it is observable even if the worker has already
      // re-processed and re-failed the task (the fixture uses a fake
      // step_id so the orchestrator cannot actually advance it).
      const events = await sql<{ event_type: string }[]>`
        select event_type from task_events
        where task_id = ${fixture.taskId} and event_type = 'step.retry'
      `;
      expect(events).toHaveLength(1);
      // Payload-shape assertions (priorStatus, cascadedSteps) are covered by
      // the API-level retry tests; the UI test only verifies that the button
      // wired up to the action endpoint.

      await expect(stepRetry).toBeHidden({
        timeout: 10_000,
      });
    } finally {
      if (fixture) await cleanupTaskFixture(sql, fixture.taskId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('skip button on failed step advances to next step', async ({ page }) => {
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

      const taskState = await waitForTaskState(sql, fixture.taskId, {
        currentStepId: FIXTURE_MIDDLE_STEP_ID,
      });
      expect(taskState.currentStepId).toBe(FIXTURE_MIDDLE_STEP_ID);

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
