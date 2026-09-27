import { randomUUID } from 'node:crypto';
import { seedRepoFixture } from '../helpers/db.js';
import { API_BASE } from '../helpers/auth.js';
import { expect, test } from '../helpers/fixtures.js';

test.describe('tasks list and create', () => {
  test('fresh user sees empty tasks list and "No tasks yet" card', async ({ page, users }) => {
    await users.register(page.request, { prefix: 'tasks-empty' });

    await page.goto('/tasks');
    await expect(page.getByRole('heading', { level: 1, name: 'Tasks' })).toBeVisible();
    await expect(page.getByText('No tasks yet')).toBeVisible();
    await expect(page.getByRole('link', { name: 'New task' }).first()).toBeVisible();
  });

  test('new task page warns when no ready repositories exist', async ({ page, users }) => {
    await users.register(page.request, { prefix: 'tasks-no-repos' });

    await page.goto('/tasks/new');
    await expect(page.getByRole('heading', { level: 1, name: 'New task' })).toBeVisible();
    await expect(page.getByLabel('Title')).toBeVisible();
    await expect(page.getByText('No ready repositories.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Add one' })).toHaveAttribute('href', '/repos/new');
  });

  test('happy path: fill form, create task, redirected, listed on /tasks', async ({
    page,
    sql,
    users,
  }) => {
    const { userId } = await users.register(page.request, { prefix: 'tasks-create' });
    const repoFixture = await seedRepoFixture(sql, userId, 'tasks-create');

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
    // The task is queued before its START, and the worker picks it up near-instantly, so by
    // the time this query runs it may already be running, waiting on a form, or failed. It is
    // never left `created`, which nothing starts.
    expect(['queued', 'running', 'waiting_user', 'waiting_form', 'failed']).toContain(
      dbRows[0]!.status,
    );
    expect(dbRows[0]!.repository_id).toBe(repoFixture.repoId);
    expect(dbRows[0]!.cli_provider_id).toBe(providerId);

    await page.goto('/tasks');
    await expect(page.getByRole('heading', { level: 2, name: taskTitle })).toBeVisible();
  });

  test('tasks list renders multiple rows with status badges and newest first', async ({
    page,
    sql,
    users,
  }) => {
    const { userId } = await users.register(page.request, { prefix: 'tasks-list-multi' });

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
        type: 'workflow' as const,
        typeLabel: 'Workflow',
        title: `e2e list workflow2 ${base}`,
        status: 'completed',
        createdAt: new Date(base),
      },
    ];

    for (const s of seeds) {
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

    // The page defaults to hiding finished work, and the seed list includes a completed task.
    // The "Show completed" BUTTON this used to click no longer exists — the filter is a status
    // select now, whose "All statuses" is the same intent expressed on the current UI.
    await page.getByLabel('Filter by status').selectOption('');

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
  });

  test('POST /tasks accepts onboarding and workflow types, rejects env_replicate', async ({
    page,
    sql,
    users,
  }) => {
    await users.register(page.request, { prefix: 'tasks-type-variants' });

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
    expect(onboardingBody.task.status).toBe('queued');

    // A workflow task REQUIRES a description — createTaskRequestSchema refines exactly that,
    // and this request omitted it and expected 201. Both halves of the rule are pinned now.
    const noDescription = await page.request.post(`${API_BASE}/tasks`, {
      data: { type: 'workflow', title: `e2e workflow nodesc ${Date.now().toString(36)}` },
    });
    expect(noDescription.status(), 'a workflow task with no description is refused').toBe(400);

    const workflowRes = await page.request.post(`${API_BASE}/tasks`, {
      data: {
        type: 'workflow',
        title: `e2e workflow ${Date.now().toString(36)}`,
        description: 'e2e workflow task description',
      },
    });
    expect(workflowRes.status()).toBe(201);
    const workflowBody = (await workflowRes.json()) as {
      task: { id: string; type: string; status: string };
    };
    expect(workflowBody.task.type).toBe('workflow');
    expect(workflowBody.task.status).toBe('queued');

    const rows = await sql<{ id: string; type: string }[]>`
      select id, type from tasks
      where id in (${onboardingBody.task.id}, ${workflowBody.task.id})
    `;
    const byId = new Map(rows.map((r) => [r.id, r.type]));
    expect(byId.get(onboardingBody.task.id)).toBe('onboarding');
    expect(byId.get(workflowBody.task.id)).toBe('workflow');

    const envRes = await page.request.post(`${API_BASE}/tasks`, {
      data: { type: 'env_replicate', title: 'e2e deprecated type' },
    });
    expect(envRes.status()).toBe(400);

    const badRes = await page.request.post(`${API_BASE}/tasks`, {
      data: { type: 'not_a_real_type', title: 'e2e bad type' },
    });
    expect(badRes.status()).toBe(400);
  });
});
