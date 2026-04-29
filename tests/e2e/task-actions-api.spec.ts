import { expect, test, type APIRequestContext } from '@playwright/test';
import {
  cleanupTaskFixture,
  cleanupUser,
  getSql,
  readTaskStatus,
  seedTaskFixture,
  type TaskFixture,
} from './helpers/db.js';
import type postgres from 'postgres';

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

async function setTaskStatus(sql: postgres.Sql, taskId: string, status: string): Promise<void> {
  await sql`update tasks set status = ${status}::task_status, updated_at = now() where id = ${taskId}`;
}

test.describe('task actions API', () => {
  test('retry rejects non-failed task with 409', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    let fixture: TaskFixture | null = null;
    try {
      const email = uniqueEmail('task-retry-rej');
      userId = await registerAndGetUserId(page.request, email);
      fixture = await seedTaskFixture(sql, userId, 'retry-rej');
      await setTaskStatus(sql, fixture.taskId, 'running');

      const res = await page.request.post(`${API_BASE}/tasks/${fixture.taskId}/action`, {
        data: { action: 'retry' },
      });
      expect(res.status()).toBe(409);
    } finally {
      if (fixture) await cleanupTaskFixture(sql, fixture.taskId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('cancel is idempotent on already-cancelled or completed task', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    let fixture: TaskFixture | null = null;
    try {
      const email = uniqueEmail('task-cancel-idem');
      userId = await registerAndGetUserId(page.request, email);
      fixture = await seedTaskFixture(sql, userId, 'cancel-idem');
      await setTaskStatus(sql, fixture.taskId, 'cancelled');

      const cancelAgain = await page.request.post(`${API_BASE}/tasks/${fixture.taskId}/action`, {
        data: { action: 'cancel' },
      });
      expect(cancelAgain.status()).toBe(200);
      expect((await cancelAgain.json()).status).toBe('cancelled');

      await setTaskStatus(sql, fixture.taskId, 'completed');
      const cancelCompleted = await page.request.post(
        `${API_BASE}/tasks/${fixture.taskId}/action`,
        { data: { action: 'cancel' } },
      );
      expect(cancelCompleted.status()).toBe(200);
      expect((await cancelCompleted.json()).status).toBe('completed');
    } finally {
      if (fixture) await cleanupTaskFixture(sql, fixture.taskId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('retry on failed task transitions to queued and clears errorMessage', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    let fixture: TaskFixture | null = null;
    try {
      const email = uniqueEmail('task-retry-ok');
      userId = await registerAndGetUserId(page.request, email);
      fixture = await seedTaskFixture(sql, userId, 'retry-ok');

      const res = await page.request.post(`${API_BASE}/tasks/${fixture.taskId}/action`, {
        data: { action: 'retry' },
      });
      expect(res.status()).toBe(200);
      expect((await res.json()).status).toBe('queued');

      // errorMessage is cleared synchronously in the retry transaction and
      // is not restored to the original value when the worker re-fails the
      // fixture task (markTaskFailed writes a new message). The presence of
      // task.retried in the event log proves the synchronous handler ran.
      const events = await sql<{ event_type: string }[]>`
        select event_type from task_events
        where task_id = ${fixture.taskId} and event_type = 'task.retried'
      `;
      expect(events).toHaveLength(1);

      const rows = await sql<{ error_message: string | null }[]>`
        select error_message from tasks where id = ${fixture.taskId}
      `;
      expect(rows[0]!.error_message).not.toBe('simulated failure');
    } finally {
      if (fixture) await cleanupTaskFixture(sql, fixture.taskId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('unknown action returns 400', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    let fixture: TaskFixture | null = null;
    try {
      const email = uniqueEmail('task-unknown');
      userId = await registerAndGetUserId(page.request, email);
      fixture = await seedTaskFixture(sql, userId, 'unknown');

      const res = await page.request.post(`${API_BASE}/tasks/${fixture.taskId}/action`, {
        data: { action: 'launch_nukes' },
      });
      expect([400, 422]).toContain(res.status());
    } finally {
      if (fixture) await cleanupTaskFixture(sql, fixture.taskId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });
});

interface StepRow {
  status: string;
  form_schema: unknown;
  form_values: unknown;
  output: unknown;
  detect_output: unknown;
}

async function readStepRow(sql: postgres.Sql, stepPkId: string): Promise<StepRow | null> {
  const rows = await sql<StepRow[]>`
    select status, form_schema, form_values, output, detect_output
    from task_steps where id = ${stepPkId}
  `;
  return rows[0] ?? null;
}

test.describe('step retry API', () => {
  test('retry on done step cascades downstream + clears formSchema/formValues/output', async ({
    page,
  }) => {
    const sql = getSql();
    let userId = '';
    let fixture: TaskFixture | null = null;
    try {
      const email = uniqueEmail('step-retry-done');
      userId = await registerAndGetUserId(page.request, email);
      fixture = await seedTaskFixture(sql, userId, 'step-retry-done');

      // Mutate fixture: step 0 done w/ form data + output, step 1 done w/ form
      // data + output, step 2 pending. Task → completed.
      await sql`
        update task_steps set status = 'done',
          form_schema = ${JSON.stringify({ title: 'old' })}::jsonb,
          form_values = ${JSON.stringify({ x: 1 })}::jsonb,
          output = ${JSON.stringify({ result: 'a' })}::jsonb,
          detect_output = ${JSON.stringify({ d: 1 })}::jsonb,
          ended_at = now()
        where id = ${fixture.failedStepId}
      `;
      await sql`
        update task_steps set status = 'done',
          form_schema = ${JSON.stringify({ title: 'mid' })}::jsonb,
          form_values = ${JSON.stringify({ y: 2 })}::jsonb,
          output = ${JSON.stringify({ result: 'b' })}::jsonb,
          ended_at = now()
        where id = ${fixture.middleStepId}
      `;
      await setTaskStatus(sql, fixture.taskId, 'completed');

      const res = await page.request.post(
        `${API_BASE}/tasks/${fixture.taskId}/steps/failing-step/action`,
        { data: { action: 'retry' } },
      );
      const resBody = await res.text();
      expect(res.status(), `retry failed body=${resBody}`).toBe(200);
      expect(JSON.parse(resBody).status).toBe('pending');

      const target = await readStepRow(sql, fixture.failedStepId);
      expect(target?.status).toBe('pending');
      expect(target?.form_schema).toBeNull();
      expect(target?.form_values).toBeNull();
      expect(target?.output).toBeNull();
      expect(target?.detect_output).toBeNull();

      const middle = await readStepRow(sql, fixture.middleStepId);
      expect(middle?.status).toBe('pending');
      expect(middle?.form_schema).toBeNull();
      expect(middle?.output).toBeNull();

      const last = await readStepRow(sql, fixture.lastStepId);
      expect(last?.status).toBe('pending');

      // task.status raced with the worker re-failing the fictitious step
      // (handleAdvanceStep falls through to markTaskFailed for unknown step
      // ids). currentStepId is durable because markTaskFailed doesn't touch
      // it; step rows are durable because failure path doesn't update them.
      const taskRow = await readTaskStatus(sql, fixture.taskId);
      expect(taskRow?.currentStepId).toBe('failing-step');

      const events = await sql<{ payload: Record<string, unknown> }[]>`
        select payload from task_events
        where task_id = ${fixture.taskId} and event_type = 'step.retry'
      `;
      expect(events).toHaveLength(1);
      expect(events[0]!.payload.priorStatus).toBe('done');
      // Step 1 (middle) was 'done' → cascaded. Step 2 (last) was 'pending' → not counted.
      expect(events[0]!.payload.cascadedSteps).toBe(1);
    } finally {
      if (fixture) await cleanupTaskFixture(sql, fixture.taskId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('retry on waiting_form step clears stale form schema (regression: KB acquisition bug)', async ({
    page,
  }) => {
    // Verifies the bug where step-runner kept a stale form_schema after retry
    // because the retry endpoint did not clear the form_schema column. Without
    // this clearing, the runner skips stepDef.form() regen and the UI stays
    // pinned to the prior diagnostic.
    const sql = getSql();
    let userId = '';
    let fixture: TaskFixture | null = null;
    try {
      const email = uniqueEmail('step-retry-wf');
      userId = await registerAndGetUserId(page.request, email);
      fixture = await seedTaskFixture(sql, userId, 'step-retry-wf');

      const stalePayload = { title: 'stale unparseable form', fields: [] };
      await sql`
        update task_steps set status = 'waiting_form',
          form_schema = ${JSON.stringify(stalePayload)}::jsonb,
          form_values = ${JSON.stringify({ manualTopics: 'old' })}::jsonb
        where id = ${fixture.failedStepId}
      `;
      await setTaskStatus(sql, fixture.taskId, 'waiting_user');

      const res = await page.request.post(
        `${API_BASE}/tasks/${fixture.taskId}/steps/failing-step/action`,
        { data: { action: 'retry' } },
      );
      expect(res.status()).toBe(200);

      const after = await readStepRow(sql, fixture.failedStepId);
      expect(after?.status).toBe('pending');
      expect(after?.form_schema).toBeNull();
      expect(after?.form_values).toBeNull();
    } finally {
      if (fixture) await cleanupTaskFixture(sql, fixture.taskId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('retry on skipped step succeeds', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    let fixture: TaskFixture | null = null;
    try {
      const email = uniqueEmail('step-retry-skip');
      userId = await registerAndGetUserId(page.request, email);
      fixture = await seedTaskFixture(sql, userId, 'step-retry-skip');

      await sql`update task_steps set status = 'skipped' where id = ${fixture.failedStepId}`;

      const res = await page.request.post(
        `${API_BASE}/tasks/${fixture.taskId}/steps/failing-step/action`,
        { data: { action: 'retry' } },
      );
      expect(res.status()).toBe(200);

      const after = await readStepRow(sql, fixture.failedStepId);
      expect(after?.status).toBe('pending');

      const events = await sql<{ payload: Record<string, unknown> }[]>`
        select payload from task_events
        where task_id = ${fixture.taskId} and event_type = 'step.retry'
      `;
      expect(events[0]!.payload.priorStatus).toBe('skipped');
    } finally {
      if (fixture) await cleanupTaskFixture(sql, fixture.taskId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  for (const status of ['running', 'waiting_cli', 'pending'] as const) {
    test(`retry on ${status} step returns 409`, async ({ page }) => {
      const sql = getSql();
      let userId = '';
      let fixture: TaskFixture | null = null;
      try {
        const email = uniqueEmail(`step-retry-${status}`);
        userId = await registerAndGetUserId(page.request, email);
        fixture = await seedTaskFixture(sql, userId, `step-retry-${status}`);

        await sql`update task_steps set status = ${status}::step_status where id = ${fixture.failedStepId}`;

        const res = await page.request.post(
          `${API_BASE}/tasks/${fixture.taskId}/steps/failing-step/action`,
          { data: { action: 'retry' } },
        );
        expect(res.status()).toBe(409);
      } finally {
        if (fixture) await cleanupTaskFixture(sql, fixture.taskId);
        if (userId) await cleanupUser(sql, userId);
        await sql.end({ timeout: 5 });
      }
    });
  }

  test('retry rejected when downstream step is running (409)', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    let fixture: TaskFixture | null = null;
    try {
      const email = uniqueEmail('step-retry-blocked');
      userId = await registerAndGetUserId(page.request, email);
      fixture = await seedTaskFixture(sql, userId, 'step-retry-blocked');

      await sql`update task_steps set status = 'done', ended_at = now() where id = ${fixture.failedStepId}`;
      await sql`update task_steps set status = 'running', started_at = now() where id = ${fixture.middleStepId}`;

      const res = await page.request.post(
        `${API_BASE}/tasks/${fixture.taskId}/steps/failing-step/action`,
        { data: { action: 'retry' } },
      );
      expect(res.status()).toBe(409);
      const body = await res.text();
      expect(body.toLowerCase()).toContain('downstream');

      // Step row must remain unchanged.
      const target = await readStepRow(sql, fixture.failedStepId);
      expect(target?.status).toBe('done');
    } finally {
      if (fixture) await cleanupTaskFixture(sql, fixture.taskId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('retry supersedes cli_invocations for cascaded steps', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    let fixture: TaskFixture | null = null;
    try {
      const email = uniqueEmail('step-retry-supersede');
      userId = await registerAndGetUserId(page.request, email);
      fixture = await seedTaskFixture(sql, userId, 'step-retry-supersede');

      await sql`update task_steps set status = 'done', ended_at = now() where id = ${fixture.failedStepId}`;
      await sql`update task_steps set status = 'done', ended_at = now() where id = ${fixture.middleStepId}`;

      // Insert one live cli_invocation per step. cli_provider_id is nullable
      // (onDelete: set null), so leaving it null avoids needing a provider row.
      const invTarget = await sql<{ id: string }[]>`
        insert into cli_invocations (task_id, task_step_id, mode, prompt)
        values (${fixture.taskId}, ${fixture.failedStepId}, 'cli', 'p1')
        returning id
      `;
      const invDownstream = await sql<{ id: string }[]>`
        insert into cli_invocations (task_id, task_step_id, mode, prompt)
        values (${fixture.taskId}, ${fixture.middleStepId}, 'cli', 'p2')
        returning id
      `;

      const res = await page.request.post(
        `${API_BASE}/tasks/${fixture.taskId}/steps/failing-step/action`,
        { data: { action: 'retry' } },
      );
      expect(res.status()).toBe(200);

      const rows = await sql<{ id: string; superseded_at: Date | null }[]>`
        select id, superseded_at from cli_invocations
        where id in (${invTarget[0]!.id}, ${invDownstream[0]!.id})
      `;
      for (const r of rows) {
        expect(r.superseded_at, `invocation ${r.id} should be superseded`).not.toBeNull();
      }

      // Cleanup the rows we inserted (cleanupTaskFixture only deletes from
      // task_events/task_steps/tasks; cli_invocations cascade on tasks delete).
    } finally {
      if (fixture) await cleanupTaskFixture(sql, fixture.taskId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });
});
