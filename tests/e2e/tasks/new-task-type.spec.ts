import { randomBytes } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import type postgres from 'postgres';
import { API_BASE, registerUser } from '../helpers/auth.js';
import { seedRepoFixture } from '../helpers/db.js';
import { expect, test as base } from '../helpers/fixtures.js';

const SPEC_STEPS = [
  '03-phase-0a-discovery',
  '04-phase-0b-pre-planning',
  '05-phase-0b5-spec-quality',
  '06-gate-1-spec-approval',
];

interface TypeLab {
  repoLess: string;
  needsRepo: string;
  unavailable: string;
}

/**
 * Three custom types behind the instance's custom-types switch. The switch is instance-wide, so it
 * is put back as found; the type rows go with it. Declare this fixture BEFORE `users` in a test's
 * arguments: it is then torn down after the users, whose own cleanup still looks the types up.
 */
const test = base.extend<{ typeLab: TypeLab }>({
  typeLab: async ({ sql, playwright }, use) => {
    const admin = await playwright.request.newContext();
    await registerUser(sql, admin, { prefix: 'ntt-admin', role: 'admin' });
    const switches = (await (await admin.get(`${API_BASE}/admin/config/task-types`)).json()) as {
      customEnabled: boolean;
      moduleEnabled: boolean;
    };
    const suffix = randomBytes(3).toString('hex');
    const lab: TypeLab = {
      repoLess: `e2e-ntt-spec-${suffix}`,
      needsRepo: `e2e-ntt-repo-${suffix}`,
      unavailable: `e2e-ntt-gone-${suffix}`,
    };
    try {
      expect(
        (
          await admin.put(`${API_BASE}/admin/config/task-types`, {
            data: { ...switches, customEnabled: true },
          })
        ).status(),
      ).toBe(200);
      await createType(admin, lab.repoLess, SPEC_STEPS, false);
      await createType(admin, lab.needsRepo, ['01-worktree-setup'], true);
      await createType(admin, lab.unavailable, SPEC_STEPS, false);
      await sql`
        update task_type_definitions set step_ids = '["e2e-no-such-step"]'::jsonb
        where slug = ${lab.unavailable}
      `;
      await use(lab);
    } finally {
      await admin.put(`${API_BASE}/admin/config/task-types`, { data: switches });
      await sql`
        delete from task_type_definitions where slug in ${sql([lab.repoLess, lab.needsRepo, lab.unavailable])}
      `;
      await admin.dispose();
    }
  },
});

async function createType(
  admin: APIRequestContext,
  slug: string,
  stepIds: string[],
  requiresRepository: boolean,
): Promise<void> {
  const res = await admin.post(`${API_BASE}/admin/task-types`, {
    data: { slug, displayName: `Type ${slug}`, stepIds, requiresRepository },
  });
  expect(res.status(), `create ${slug}: ${await res.text()}`).toBe(201);
}

/** Holds the POST /tasks the form sends and answers it with a refusal, so no task is created. */
async function captureTaskPost(page: Page): Promise<{ bodies: string[] }> {
  const bodies: string[] = [];
  await page.route(
    (url) => url.pathname === '/tasks',
    async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      bodies.push(route.request().postData() ?? '');
      return route.fulfill({ status: 400, json: { error: 'captured by the spec' } });
    },
  );
  return { bodies };
}

async function rowCount(sql: postgres.Sql, userId: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from tasks where user_id = ${userId}
  `;
  return rows[0]!.n;
}

test.describe('New Task type select', () => {
  // typeLab flips the instance-wide custom-types switch; parallel tests would race its restore.
  test.describe.configure({ mode: 'serial' });

  test('a user cannot reach the admin task-type api', async ({ page, users }) => {
    await users.register(page.request, { prefix: 'ntt-denied' });
    const res = await page.request.get(`${API_BASE}/admin/task-types`);
    expect(res.status()).toBe(403);
  });

  test('lists Workflow and Run the app first, then the enabled custom types', async ({
    page,
    typeLab: lab,
    users,
  }) => {
    await users.register(page.request, { prefix: 'ntt-list' });
    await page.goto('/tasks/new');

    const select = page.locator('#taskType');
    await expect(select.locator(`option[value="${lab.repoLess}"]`)).toBeAttached();
    const values = await select
      .locator('option')
      .evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    expect(values.slice(0, 2)).toEqual(['workflow', 'run_app']);
    expect(values).toEqual(expect.arrayContaining([lab.repoLess, lab.needsRepo, lab.unavailable]));
    for (const builtin of ['onboarding', 'onboarding_upgrade']) {
      expect(values).not.toContain(builtin);
    }
    expect(values.filter((v) => v === 'workflow' || v === 'run_app')).toHaveLength(2);

    const gone = select.locator(`option[value="${lab.unavailable}"]`);
    await expect(gone).toBeDisabled();
    await expect(gone).toContainText('unavailable');
    await expect(select.locator(`option[value="${lab.repoLess}"]`)).toBeEnabled();
  });

  test('a repo-less custom type is created without a repository', async ({
    page,
    sql,
    typeLab: lab,
    users,
  }) => {
    const { userId } = await users.register(page.request, { prefix: 'ntt-repoless' });
    const repo = await seedRepoFixture(sql, userId, 'ntt-repoless');
    await page.goto(`/tasks/new?repositoryId=${repo.repoId}`);
    // The fixture repository's status box is what a Workflow choice shows and a custom type does not.
    await expect(
      page.getByText(/Will run:|Not onboarded|Empty project|Onboarded/).first(),
    ).toBeVisible();
    await expect(page.getByLabel('Feature / area (optional)')).toHaveCount(0);

    await page.locator('#taskType').selectOption(lab.repoLess);
    await expect(page.locator('#repositoryId option[value=""]')).toHaveText('(no repository)');
    await expect(page.locator('#repositoryId')).not.toHaveAttribute('required', '');
    await expect(page.getByText(/Will run:|Not onboarded|Empty project|Onboarded/)).toHaveCount(0);
    await expect(page.getByLabel('Feature / area (optional)')).toHaveCount(0);
    await expect(page.getByText('This is a bug fix')).toHaveCount(0);

    await page.locator('#repositoryId').selectOption('');
    await page.getByLabel('Title').fill('e2e repo-less custom task');
    await page.getByRole('button', { name: /create task/i }).click();
    await page.waitForURL(/\/tasks\/[0-9a-f-]{36}$/, { timeout: 15_000 });
    const taskId = page.url().split('/').pop()!;

    const rows = await sql<
      { type: string; repository_id: string | null; run_list_snapshot: string[] | null }[]
    >`select type, repository_id, run_list_snapshot from tasks where id = ${taskId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe(lab.repoLess);
    expect(rows[0]!.repository_id).toBeNull();
    expect(rows[0]!.run_list_snapshot).toEqual(['00-model-health-workflow', ...SPEC_STEPS]);
  });

  test('a custom type that needs a repository is blocked without one', async ({
    page,
    sql,
    typeLab: lab,
    users,
  }) => {
    const { userId } = await users.register(page.request, { prefix: 'ntt-needs-repo' });
    await page.goto('/tasks/new');
    await page.locator('#taskType').selectOption(lab.needsRepo);
    await expect(page.locator('#repositoryId')).toHaveAttribute('required', '');
    await expect(page.locator('#repositoryId option[value=""]')).toHaveText(
      '(select a repository)',
    );

    const posted = await captureTaskPost(page);
    await page.getByLabel('Title').fill('e2e blocked custom task');
    await page.getByRole('button', { name: /create task/i }).click();
    await expect(page).toHaveURL(/\/tasks\/new$/);
    expect(posted.bodies).toEqual([]);

    // The form is not the only door: the api refuses the same request on its own.
    const forced = await page.request.post(`${API_BASE}/tasks`, {
      data: { type: lab.needsRepo, title: 'e2e forced custom task' },
    });
    expect(forced.status()).toBe(400);
    expect(await rowCount(sql, userId)).toBe(0);
  });

  test('Workflow and Run the app still post the bodies they always did', async ({
    page,
    sql,
    users,
  }) => {
    const { userId } = await users.register(page.request, { prefix: 'ntt-builtin' });
    const repo = await seedRepoFixture(sql, userId, 'ntt-builtin');
    const posted = await captureTaskPost(page);

    await page.goto(`/tasks/new?repositoryId=${repo.repoId}`);
    await expect(page.locator('#taskType')).toHaveValue('workflow');
    await expect(page.getByText(/Will run:/)).toBeVisible();
    const inferred =
      (await page
        .getByText(/Will run:/)
        .locator('strong')
        .textContent()) ?? '';
    expect(['workflow', 'onboarding']).toContain(inferred);
    await page.getByLabel('Title').fill('e2e workflow body');
    await page.getByLabel(/^Description/).fill('e2e note');
    await page.getByRole('button', { name: /create task/i }).click();
    await expect.poll(() => posted.bodies.length).toBe(1);
    const head = `"type":"${inferred}","title":"e2e workflow body","repositoryId":"${repo.repoId}","description":"e2e note"`;
    const tail = '"cliProviderId":null,"summaryLlmEnabled":true,"summaryCliProviderId":null';
    expect(posted.bodies[0]).toBe(
      `{${head},${tail}${inferred === 'workflow' ? ',"isBugFix":false' : ''}}`,
    );

    await page.goto(`/tasks/new?repositoryId=${repo.repoId}&mode=run_app`);
    await expect(page.locator('#taskType')).toHaveValue('run_app');
    await expect(page.getByRole('heading', { level: 1, name: 'Run app' })).toBeVisible();
    await expect(page.getByText(/Will run:/)).toBeVisible();
    await page.getByRole('button', { name: /start app/i }).click();
    await expect.poll(() => posted.bodies.length).toBe(2);
    expect(posted.bodies[1]).toBe(
      `{"type":"run_app","title":"run ${repo.name} app","repositoryId":"${repo.repoId}",${tail}}`,
    );
    expect(await rowCount(sql, userId)).toBe(0);
  });
});
