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
  test('pause/resume/cancel happy path on running task', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    let fixture: TaskFixture | null = null;
    try {
      const email = uniqueEmail('task-pause');
      userId = await registerAndGetUserId(page.request, email);
      fixture = await seedTaskFixture(sql, userId, 'pause');
      await setTaskStatus(sql, fixture.taskId, 'running');

      const pauseRes = await page.request.post(`${API_BASE}/tasks/${fixture.taskId}/action`, {
        data: { action: 'pause' },
      });
      expect(pauseRes.status()).toBe(200);
      expect((await pauseRes.json()).status).toBe('paused');
      expect((await readTaskStatus(sql, fixture.taskId))?.status).toBe('paused');

      const resumeRes = await page.request.post(`${API_BASE}/tasks/${fixture.taskId}/action`, {
        data: { action: 'resume' },
      });
      expect(resumeRes.status()).toBe(200);
      expect((await resumeRes.json()).status).toBe('running');
      expect((await readTaskStatus(sql, fixture.taskId))?.status).toBe('running');

      const cancelRes = await page.request.post(`${API_BASE}/tasks/${fixture.taskId}/action`, {
        data: { action: 'cancel' },
      });
      expect(cancelRes.status()).toBe(200);
      expect((await cancelRes.json()).status).toBe('cancelled');
      expect((await readTaskStatus(sql, fixture.taskId))?.status).toBe('cancelled');
    } finally {
      if (fixture) await cleanupTaskFixture(sql, fixture.taskId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('pause rejects non-running task with 409', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    let fixture: TaskFixture | null = null;
    try {
      const email = uniqueEmail('task-pause-rej');
      userId = await registerAndGetUserId(page.request, email);
      fixture = await seedTaskFixture(sql, userId, 'pause-rej');
      // fixture starts as 'failed'

      const res = await page.request.post(`${API_BASE}/tasks/${fixture.taskId}/action`, {
        data: { action: 'pause' },
      });
      expect(res.status()).toBe(409);
    } finally {
      if (fixture) await cleanupTaskFixture(sql, fixture.taskId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('resume rejects non-paused task with 409', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    let fixture: TaskFixture | null = null;
    try {
      const email = uniqueEmail('task-resume-rej');
      userId = await registerAndGetUserId(page.request, email);
      fixture = await seedTaskFixture(sql, userId, 'resume-rej');
      await setTaskStatus(sql, fixture.taskId, 'running');

      const res = await page.request.post(`${API_BASE}/tasks/${fixture.taskId}/action`, {
        data: { action: 'resume' },
      });
      expect(res.status()).toBe(409);
    } finally {
      if (fixture) await cleanupTaskFixture(sql, fixture.taskId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

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

      const rows = await sql<{ status: string; error_message: string | null }[]>`
        select status, error_message from tasks where id = ${fixture.taskId}
      `;
      expect(rows[0]!.status).toBe('queued');
      expect(rows[0]!.error_message).toBeNull();
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
