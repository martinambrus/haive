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
const FAKE_UUID = '00000000-0000-4000-8000-000000000000';

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

test.describe('task data API', () => {
  test('GET /tasks/:id returns task + 3 seeded steps in order', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    let fixture: TaskFixture | null = null;
    try {
      const email = uniqueEmail('task-get');
      userId = await registerAndGetUserId(page.request, email);
      fixture = await seedTaskFixture(sql, userId, 'get');

      const res = await page.request.get(`${API_BASE}/tasks/${fixture.taskId}`);
      expect(res.status()).toBe(200);
      const body = (await res.json()) as {
        task: { id: string; status: string };
        steps: Array<{ stepId: string; stepIndex: number; title: string }>;
      };
      expect(body.task.id).toBe(fixture.taskId);
      expect(body.task.status).toBe('failed');
      expect(body.steps).toHaveLength(3);
      expect(body.steps.map((s) => s.stepId)).toEqual(['failing-step', 'middle-step', 'last-step']);
      expect(body.steps.map((s) => s.stepIndex)).toEqual([0, 1, 2]);
    } finally {
      if (fixture) await cleanupTaskFixture(sql, fixture.taskId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('GET /tasks/:id/steps returns only steps subtree', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    let fixture: TaskFixture | null = null;
    try {
      const email = uniqueEmail('task-steps');
      userId = await registerAndGetUserId(page.request, email);
      fixture = await seedTaskFixture(sql, userId, 'steps');

      const res = await page.request.get(`${API_BASE}/tasks/${fixture.taskId}/steps`);
      expect(res.status()).toBe(200);
      const body = (await res.json()) as {
        steps: Array<{ stepId: string; status: string; errorMessage: string | null }>;
      };
      expect(body.steps).toHaveLength(3);
      const failing = body.steps.find((s) => s.stepId === 'failing-step');
      expect(failing?.status).toBe('failed');
      expect(failing?.errorMessage).toBe('kaboom');
    } finally {
      if (fixture) await cleanupTaskFixture(sql, fixture.taskId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('GET /tasks/:id/events returns empty array for fresh fixture', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    let fixture: TaskFixture | null = null;
    try {
      const email = uniqueEmail('task-events');
      userId = await registerAndGetUserId(page.request, email);
      fixture = await seedTaskFixture(sql, userId, 'events');

      const res = await page.request.get(`${API_BASE}/tasks/${fixture.taskId}/events`);
      expect(res.status()).toBe(200);
      const body = (await res.json()) as { events: unknown[] };
      expect(body.events).toEqual([]);
    } finally {
      if (fixture) await cleanupTaskFixture(sql, fixture.taskId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('nonexistent task ids return 404 on get, steps, events', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('task-404');
      userId = await registerAndGetUserId(page.request, email);

      const get = await page.request.get(`${API_BASE}/tasks/${FAKE_UUID}`);
      expect(get.status()).toBe(404);

      const steps = await page.request.get(`${API_BASE}/tasks/${FAKE_UUID}/steps`);
      expect(steps.status()).toBe(404);

      const events = await page.request.get(`${API_BASE}/tasks/${FAKE_UUID}/events`);
      expect(events.status()).toBe(404);
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('POST step retry on failed step transitions step to pending, task to running, emits event', async ({
    page,
  }) => {
    const sql = getSql();
    let userId = '';
    let fixture: TaskFixture | null = null;
    try {
      const email = uniqueEmail('step-retry');
      userId = await registerAndGetUserId(page.request, email);
      fixture = await seedTaskFixture(sql, userId, 'step-retry');

      const res = await page.request.post(
        `${API_BASE}/tasks/${fixture.taskId}/steps/failing-step/action`,
        { data: { action: 'retry' } },
      );
      expect(res.status()).toBe(200);
      expect((await res.json()).status).toBe('pending');

      const stepRows = await sql<{ status: string; error_message: string | null }[]>`
        select status, error_message from task_steps
        where task_id = ${fixture.taskId} and step_id = 'failing-step'
      `;
      expect(stepRows[0]!.status).toBe('pending');
      expect(stepRows[0]!.error_message).toBeNull();

      const taskRows = await sql<{ status: string; current_step_id: string | null }[]>`
        select status, current_step_id from tasks where id = ${fixture.taskId}
      `;
      expect(taskRows[0]!.status).toBe('running');
      expect(taskRows[0]!.current_step_id).toBe('failing-step');

      const eventRows = await sql<{ event_type: string }[]>`
        select event_type from task_events where task_id = ${fixture.taskId}
      `;
      expect(eventRows.map((e) => e.event_type)).toContain('step.retry');
    } finally {
      if (fixture) await cleanupTaskFixture(sql, fixture.taskId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('POST step skip on failed step advances currentStep to next pending', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    let fixture: TaskFixture | null = null;
    try {
      const email = uniqueEmail('step-skip');
      userId = await registerAndGetUserId(page.request, email);
      fixture = await seedTaskFixture(sql, userId, 'step-skip');

      const res = await page.request.post(
        `${API_BASE}/tasks/${fixture.taskId}/steps/failing-step/action`,
        { data: { action: 'skip' } },
      );
      expect(res.status()).toBe(200);
      const body = (await res.json()) as { status: string; nextStepId: string | null };
      expect(body.status).toBe('skipped');
      expect(body.nextStepId).toBe('middle-step');

      const stepRows = await sql<{ status: string }[]>`
        select status from task_steps
        where task_id = ${fixture.taskId} and step_id = 'failing-step'
      `;
      expect(stepRows[0]!.status).toBe('skipped');

      const taskRows = await sql<{ status: string; current_step_id: string | null }[]>`
        select status, current_step_id from tasks where id = ${fixture.taskId}
      `;
      expect(taskRows[0]!.status).toBe('running');
      expect(taskRows[0]!.current_step_id).toBe('middle-step');
    } finally {
      if (fixture) await cleanupTaskFixture(sql, fixture.taskId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('POST step action on nonexistent step returns 404', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    let fixture: TaskFixture | null = null;
    try {
      const email = uniqueEmail('step-404');
      userId = await registerAndGetUserId(page.request, email);
      fixture = await seedTaskFixture(sql, userId, 'step-404');

      const res = await page.request.post(
        `${API_BASE}/tasks/${fixture.taskId}/steps/does-not-exist/action`,
        { data: { action: 'retry' } },
      );
      expect(res.status()).toBe(404);
    } finally {
      if (fixture) await cleanupTaskFixture(sql, fixture.taskId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('POST step submit on non-waiting_form step returns 409', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    let fixture: TaskFixture | null = null;
    try {
      const email = uniqueEmail('step-submit-409');
      userId = await registerAndGetUserId(page.request, email);
      fixture = await seedTaskFixture(sql, userId, 'step-submit-409');

      // failing-step is in status 'failed', not 'waiting_form'
      const res = await page.request.post(
        `${API_BASE}/tasks/${fixture.taskId}/steps/failing-step/submit`,
        { data: { values: { foo: 'bar' } } },
      );
      expect(res.status()).toBe(409);
    } finally {
      if (fixture) await cleanupTaskFixture(sql, fixture.taskId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });
});
