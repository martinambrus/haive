import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import {
  cleanupRepoFixture,
  cleanupTaskFixture,
  cleanupUser,
  getSql,
  seedRepoFixture,
  type RepoFixture,
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

test.describe('tasks list and create', () => {
  test('fresh user sees empty tasks list and "No tasks yet" card', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('tasks-empty');
      userId = await registerAndGetUserId(page.request, email);

      await page.goto('/tasks');
      await expect(page.getByRole('heading', { level: 1, name: 'Tasks' })).toBeVisible();
      await expect(page.getByText('No tasks yet')).toBeVisible();
      await expect(page.getByRole('link', { name: 'New task' }).first()).toBeVisible();
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('new task page warns when no ready repositories exist', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('tasks-no-repos');
      userId = await registerAndGetUserId(page.request, email);

      await page.goto('/tasks/new');
      await expect(page.getByRole('heading', { level: 1, name: 'New task' })).toBeVisible();
      await expect(page.getByLabel('Title')).toBeVisible();
      await expect(page.getByText('No ready repositories.')).toBeVisible();
      await expect(page.getByRole('link', { name: 'Add one' })).toHaveAttribute(
        'href',
        '/repos/new',
      );
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('happy path: fill form, create task, redirected, listed on /tasks', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    let repoFixture: RepoFixture | null = null;
    try {
      const email = uniqueEmail('tasks-create');
      userId = await registerAndGetUserId(page.request, email);
      repoFixture = await seedRepoFixture(sql, userId, 'tasks-create');

      const providerRes = await page.request.post(`${API_BASE}/cli-providers`, {
        data: {
          name: 'claude-code',
          label: 'Claude Code',
          authMode: 'subscription',
        },
      });
      expect(providerRes.status()).toBe(201);
      const providerBody = (await providerRes.json()) as {
        provider: { id: string };
      };
      const providerId = providerBody.provider.id;

      await page.goto('/tasks/new');
      await expect(page.getByRole('heading', { level: 1, name: 'New task' })).toBeVisible();

      const taskTitle = `e2e create ${Date.now().toString(36)}`;
      await page.getByLabel('Title').fill(taskTitle);
      await page.getByLabel('Description (optional)').fill('e2e happy path note');

      await expect(
        page.locator(`#repositoryId option[value="${repoFixture.repoId}"]`),
      ).toBeAttached();
      await page.locator('#repositoryId').selectOption(repoFixture.repoId);

      await expect(page.locator(`#cliProviderId option[value="${providerId}"]`)).toBeAttached();
      await page.locator('#cliProviderId').selectOption(providerId);

      await page.getByRole('button', { name: /create task/i }).click();

      await page.waitForURL(/\/tasks\/[0-9a-f-]{36}$/, { timeout: 10_000 });
      const detailUrl = page.url();
      const newTaskId = detailUrl.split('/').pop()!;
      expect(newTaskId).toMatch(/^[0-9a-f-]{36}$/);

      const dbRows = await sql<
        {
          title: string;
          status: string;
          repository_id: string | null;
          cli_provider_id: string | null;
        }[]
      >`
        select title, status, repository_id, cli_provider_id
        from tasks where id = ${newTaskId}
      `;
      expect(dbRows).toHaveLength(1);
      expect(dbRows[0]!.title).toBe(taskTitle);
      // Task is created with status='created' but the worker picks it up
      // near-instantly and starts advancing it, so by the time this query
      // runs the task may already be in running / waiting_user / failed.
      // Any of these proves the task row was inserted correctly.
      expect([
        'created',
        'queued',
        'running',
        'waiting_user',
        'waiting_form',
        'failed',
      ]).toContain(dbRows[0]!.status);
      expect(dbRows[0]!.repository_id).toBe(repoFixture.repoId);
      expect(dbRows[0]!.cli_provider_id).toBe(providerId);

      await page.goto('/tasks');
      await expect(page.getByRole('heading', { level: 2, name: taskTitle })).toBeVisible();
    } finally {
      if (repoFixture) await cleanupRepoFixture(sql, repoFixture.repoId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('tasks list renders multiple rows with status badges and newest first', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    const taskIds: string[] = [];
    try {
      const email = uniqueEmail('tasks-list-multi');
      userId = await registerAndGetUserId(page.request, email);

      const base = Date.now();
      const seeds = [
        {
          id: randomUUID(),
          type: 'onboarding' as const,
          typeLabel: 'Onboarding',
          title: `e2e list onboarding ${base}`,
          status: 'failed',
          createdAt: new Date(base - 4000),
        },
        {
          id: randomUUID(),
          type: 'workflow' as const,
          typeLabel: 'Workflow',
          title: `e2e list workflow ${base}`,
          status: 'running',
          createdAt: new Date(base - 2000),
        },
        {
          id: randomUUID(),
          type: 'env_replicate' as const,
          typeLabel: 'Env replicate',
          title: `e2e list env_replicate ${base}`,
          status: 'completed',
          createdAt: new Date(base),
        },
      ];

      for (const s of seeds) {
        taskIds.push(s.id);
        await sql`
          insert into tasks (
            id, user_id, type, title, status,
            current_step_index, created_at, updated_at
          ) values (
            ${s.id}, ${userId}, ${s.type}, ${s.title}, ${s.status},
            0, ${s.createdAt}, ${s.createdAt}
          )
        `;
      }

      await page.goto('/tasks');
      await expect(page.getByRole('heading', { level: 1, name: 'Tasks' })).toBeVisible();

      for (const s of seeds) {
        await expect(page.getByRole('heading', { level: 2, name: s.title })).toBeVisible();
      }

      for (const s of seeds) {
        const card = page.locator('a[href^="/tasks/"]').filter({
          has: page.getByRole('heading', { level: 2, name: s.title }),
        });
        await expect(card.getByText(s.status, { exact: true })).toBeVisible();
        await expect(card.getByText(s.typeLabel, { exact: true })).toBeVisible();
      }

      const headings = page.getByRole('heading', { level: 2 });
      await expect(headings.nth(0)).toHaveText(seeds[2]!.title);
      await expect(headings.nth(1)).toHaveText(seeds[1]!.title);
      await expect(headings.nth(2)).toHaveText(seeds[0]!.title);
    } finally {
      for (const id of taskIds) await cleanupTaskFixture(sql, id);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('POST /tasks accepts onboarding and env_replicate types', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    const createdIds: string[] = [];
    try {
      const email = uniqueEmail('tasks-type-variants');
      userId = await registerAndGetUserId(page.request, email);

      const onboardingRes = await page.request.post(`${API_BASE}/tasks`, {
        data: {
          type: 'onboarding',
          title: `e2e onboarding ${Date.now().toString(36)}`,
        },
      });
      expect(onboardingRes.status()).toBe(201);
      const onboardingBody = (await onboardingRes.json()) as {
        task: { id: string; type: string; status: string };
      };
      expect(onboardingBody.task.type).toBe('onboarding');
      expect(onboardingBody.task.status).toBe('created');
      createdIds.push(onboardingBody.task.id);

      const envRes = await page.request.post(`${API_BASE}/tasks`, {
        data: {
          type: 'env_replicate',
          title: `e2e env_replicate ${Date.now().toString(36)}`,
        },
      });
      expect(envRes.status()).toBe(201);
      const envBody = (await envRes.json()) as {
        task: { id: string; type: string; status: string };
      };
      expect(envBody.task.type).toBe('env_replicate');
      expect(envBody.task.status).toBe('created');
      createdIds.push(envBody.task.id);

      const rows = await sql<{ id: string; type: string }[]>`
        select id, type from tasks
        where id in (${onboardingBody.task.id}, ${envBody.task.id})
      `;
      const byId = new Map(rows.map((r) => [r.id, r.type]));
      expect(byId.get(onboardingBody.task.id)).toBe('onboarding');
      expect(byId.get(envBody.task.id)).toBe('env_replicate');

      const badRes = await page.request.post(`${API_BASE}/tasks`, {
        data: { type: 'not_a_real_type', title: 'e2e bad type' },
      });
      expect(badRes.status()).toBe(400);
    } finally {
      for (const id of createdIds) await cleanupTaskFixture(sql, id);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });
});
