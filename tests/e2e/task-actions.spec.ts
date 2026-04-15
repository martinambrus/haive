import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import {
  cleanupTaskFixture,
  cleanupUser,
  getSql,
  readStepStatus,
  readTaskStatus,
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
      userId = await registerAndGetUserId(page.request, email);
      fixture = await seedTaskFixture(sql, userId, 'retry');

      page.on('dialog', (d) => {
        void d.accept();
      });

      await gotoTaskDetail(page, fixture.taskId);

      const failingCard = page
        .locator('div')
        .filter({ hasText: /Failing step/ })
        .first();
      await expect(failingCard).toBeVisible();
      await expect(page.getByRole('button', { name: 'Retry step' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Skip step' })).toBeVisible();

      await page.getByRole('button', { name: 'Retry step' }).click();

      const finalStatus = await waitForStepStatus(sql, fixture.failedStepId, 'pending');
      expect(finalStatus).toBe('pending');

      const taskState = await waitForTaskState(sql, fixture.taskId, {
        currentStepId: 'failing-step',
      });
      expect(taskState.currentStepId).toBe('failing-step');

      // The step.retry event is inserted in the same transaction as the
      // step flip, so it is observable even if the worker has already
      // re-processed and re-failed the task (the fixture uses a fake
      // step_id so the orchestrator cannot actually advance it).
      const events = await sql<{ event_type: string }[]>`
        select event_type from task_events
        where task_id = ${fixture.taskId} and event_type = 'step.retry'
      `;
      expect(events).toHaveLength(1);

      await expect(page.getByRole('button', { name: 'Retry step' })).toBeHidden({
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
      userId = await registerAndGetUserId(page.request, email);
      fixture = await seedTaskFixture(sql, userId, 'skip');

      page.on('dialog', (d) => {
        void d.accept();
      });

      await gotoTaskDetail(page, fixture.taskId);
      await expect(page.getByRole('button', { name: 'Skip step' })).toBeVisible();

      await page.getByRole('button', { name: 'Skip step' }).click();

      const finalStatus = await waitForStepStatus(sql, fixture.failedStepId, 'skipped');
      expect(finalStatus).toBe('skipped');

      const taskState = await waitForTaskState(sql, fixture.taskId, {
        currentStepId: 'middle-step',
      });
      expect(taskState.currentStepId).toBe('middle-step');

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
