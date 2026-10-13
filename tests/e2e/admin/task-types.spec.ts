import { randomBytes, randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type postgres from 'postgres';
import { cleanupUser, getSql } from '../helpers/db.js';
import { API_BASE, registerUser } from '../helpers/auth.js';

/**
 * The admin Task types page and the step composer behind it.
 *
 * Every type created here is a row in a table all admins share, so each is named e2e-tt-<hex> and
 * removed by slug in the `finally`. The global custom-types switch is deliberately not touched:
 * creating, editing and listing a type do not depend on it, only creating a TASK of one does.
 */

const STEP = {
  discovery: 'Phase 0a: Knowledge discovery',
  prePlanning: 'Phase 0b: Pre-planning',
  specQuality: 'Phase 0b.5: Spec quality review',
  gate1: 'Gate 1: Spec approval',
  worktree: 'Worktree setup',
  implement: 'Phase 2: Implement',
  validate: 'Phase 4: Implementation validation',
} as const;

const newSlug = () => `e2e-tt-${randomBytes(3).toString('hex')}`;

async function withAdmin(
  page: Page,
  run: (ctx: { sql: postgres.Sql; userId: string; slugs: string[] }) => Promise<void>,
) {
  const sql = getSql();
  const slugs: string[] = [];
  let userId = '';
  try {
    userId = (await registerUser(sql, page.request, { prefix: 'admin-tt', role: 'admin' })).userId;
    await run({ sql, userId, slugs });
  } finally {
    for (const slug of slugs) {
      await sql`delete from tasks where type = ${slug}`;
      await sql`delete from task_type_definitions where slug = ${slug} and source = 'admin'`;
    }
    if (userId) await cleanupUser(sql, userId);
    await sql.end({ timeout: 5 });
  }
}

async function createViaApi(
  request: APIRequestContext,
  slugs: string[],
  body: { stepIds: string[]; requiresRepository: boolean },
): Promise<string> {
  const slug = newSlug();
  slugs.push(slug);
  const res = await request.post(`${API_BASE}/admin/task-types`, {
    data: { slug, displayName: `E2E ${slug}`, ...body },
  });
  expect(res.status(), await res.text()).toBe(201);
  return slug;
}

const addStep = (page: Page, label: string) =>
  page.getByRole('button', { name: `Add ${label}`, exact: true }).click();
const row = (page: Page, index: number) => page.locator(`ol > li[data-row="${index}"]`);

test.describe('admin task types', () => {
  test('A1: the tab lists built-in and custom types with availability and task counts', async ({
    page,
  }) => {
    await withAdmin(page, async ({ slugs }) => {
      const slug = await createViaApi(page.request, slugs, {
        stepIds: ['03-phase-0a-discovery'],
        requiresRepository: false,
      });
      await page.goto('/admin');
      await page.getByRole('main').getByRole('link', { name: 'Task types', exact: true }).click();
      await expect(page).toHaveURL(/\/admin\/task-types$/, { timeout: 30_000 });

      for (const builtin of ['onboarding', 'workflow', 'run_app']) {
        const card = page.locator(`[data-task-type="${builtin}"]`);
        await expect(card).toBeVisible({ timeout: 30_000 });
        await expect(card).toContainText('Built-in');
        await expect(card).toContainText(/\d+ tasks?/);
        await expect(card).toContainText(/Available|Unavailable/);
      }
      const custom = page.locator(`[data-task-type="${slug}"]`);
      await expect(custom).toContainText('Custom');
      await expect(custom).toContainText('0 tasks');
      await expect(custom).toContainText('No repository');
      await expect(page.getByRole('link', { name: 'New task type' })).toBeVisible();
    });
  });

  test('A2: a repository-less type is composed, saved and listed', async ({ page }) => {
    await withAdmin(page, async ({ sql, slugs }) => {
      const slug = newSlug();
      slugs.push(slug);
      await page.goto('/admin/task-types/new');
      await page.getByLabel('Slug').fill(slug);
      await page.getByLabel('Name').fill(`E2E ${slug}`);
      await page.getByLabel('Requires a repository').uncheck();
      await expect(page.getByRole('button', { name: 'Create task type' })).toBeDisabled();

      for (const label of [STEP.discovery, STEP.prePlanning, STEP.specQuality, STEP.gate1]) {
        await addStep(page, label);
      }
      await expect(page.getByText('No problems', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Create task type' }).click();

      await expect(page).toHaveURL(new RegExp(`/admin/task-types/${slug}$`), { timeout: 30_000 });
      const [saved] = await sql<{ step_ids: string[]; requires_repository: boolean }[]>`
        select step_ids, requires_repository from task_type_definitions where slug = ${slug}
      `;
      expect(saved?.requires_repository).toBe(false);
      expect(saved?.step_ids).toEqual([
        '03-phase-0a-discovery',
        '04-phase-0b-pre-planning',
        '05-phase-0b5-spec-quality',
        '06-gate-1-spec-approval',
      ]);

      await page.goto('/admin/task-types');
      await expect(page.locator(`[data-task-type="${slug}"]`)).toContainText('Custom');
    });
  });

  test('A3: the composer flags an order problem per row, buttons fix it, and the server agrees', async ({
    page,
  }) => {
    await withAdmin(page, async ({ slugs }) => {
      const slug = newSlug();
      slugs.push(slug);
      await page.goto('/admin/task-types/new');
      await page.getByLabel('Slug').fill(slug);
      await page.getByLabel('Name').fill(`E2E ${slug}`);
      await page.getByLabel('Requires a repository').uncheck();
      await addStep(page, STEP.specQuality);
      await addStep(page, STEP.prePlanning);

      await expect(row(page, 0)).toContainText('Needs spec first');
      await expect(row(page, 0)).toContainText(`Provided by: ${STEP.prePlanning}`);
      await expect(page.getByText('1 problem', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Create task type' })).toBeDisabled();

      await page.getByRole('button', { name: `Move ${STEP.specQuality} down` }).click();
      await expect(page.getByText('No problems', { exact: true })).toBeVisible();
      await expect(row(page, 1)).toContainText(STEP.specQuality);
      await expect(page.getByRole('button', { name: `Move ${STEP.specQuality} up` })).toBeFocused();
      await expect(page.getByRole('button', { name: 'Create task type' })).toBeEnabled();

      // Negative control: the server's own composition verdict is shown against the row it names,
      // not as the "(root) — undefined" the generic issue formatter used to print.
      const probe = await page.request.post(`${API_BASE}/admin/task-types`, {
        data: {
          slug: newSlug(),
          displayName: 'probe',
          stepIds: ['05-phase-0b5-spec-quality', '04-phase-0b-pre-planning'],
          requiresRepository: false,
        },
      });
      expect(probe.status()).toBe(400);
      const rejected = await probe.json();
      expect(rejected.issues[0].kind).toBe('unmet-need');
      await page.route(`${API_BASE}/admin/task-types`, async (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        const issue = { ...rejected.issues[0], index: 1, stepId: '05-phase-0b5-spec-quality' };
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ error: rejected.error, issues: [issue] }),
        });
      });
      await page.getByRole('button', { name: 'Create task type' }).click();
      await expect(row(page, 1)).toContainText('Needs spec first', { timeout: 10_000 });
      await expect(page.getByText('(root)')).toHaveCount(0);
      await expect(page.getByText('undefined')).toHaveCount(0);
      await page.unroute(`${API_BASE}/admin/task-types`);

      await page.getByRole('button', { name: 'Create task type' }).click();
      await expect(page).toHaveURL(new RegExp(`/admin/task-types/${slug}$`), { timeout: 30_000 });
    });
  });

  test('A4: a fix-loop step before its target is flagged until the target is added', async ({
    page,
  }) => {
    await withAdmin(page, async ({ slugs }) => {
      const slug = newSlug();
      slugs.push(slug);
      await page.goto('/admin/task-types/new');
      await page.getByLabel('Slug').fill(slug);
      await page.getByLabel('Name').fill(`E2E ${slug}`);
      await addStep(page, STEP.worktree);
      await addStep(page, STEP.validate);

      await expect(row(page, 1)).toContainText(`Loops back to ${STEP.implement}`);
      await expect(row(page, 1)).toContainText(`Fix loops return to ${STEP.implement}`);
      await page.getByRole('button', { name: `Add ${STEP.implement} before this` }).click();

      await expect(page.getByText('Loops back to')).toHaveCount(0);
      await expect(row(page, 1)).toContainText(STEP.implement);
      await expect(row(page, 2)).toContainText(STEP.validate);
    });
  });

  test('A5: a built-in type edits only what the api allows and shows its steps read-only', async ({
    page,
  }) => {
    await withAdmin(page, async () => {
      await page.goto('/admin/task-types/workflow');
      await expect(page.getByLabel('Name')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByLabel('Description')).toBeVisible();
      await expect(page.getByLabel('Sort order')).toBeVisible();
      await expect(page.getByLabel('Requires a repository')).toHaveCount(0);
      await expect(page.getByLabel('Slug')).toHaveCount(0);
      await expect(page.getByText('Steps chosen at run time')).toBeVisible();
      await expect(page.getByRole('button', { name: /^Move .* (up|down)$/ })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /^Remove / })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Delete task type' })).toHaveCount(0);
    });
  });

  test('A6: delete asks first, Escape cancels, a used type is refused and an unused one goes', async ({
    page,
  }) => {
    await withAdmin(page, async ({ sql, userId, slugs }) => {
      const unused = await createViaApi(page.request, slugs, {
        stepIds: ['03-phase-0a-discovery'],
        requiresRepository: false,
      });
      const used = await createViaApi(page.request, slugs, {
        stepIds: ['03-phase-0a-discovery'],
        requiresRepository: false,
      });
      await sql`
        insert into tasks (id, user_id, type, title, status, current_step_index, created_at, updated_at)
        values (${randomUUID()}, ${userId}, ${used}, 'e2e task type in use', 'cancelled', 0, now(), now())
      `;

      await page.goto('/admin/task-types');
      const usedCard = page.locator(`[data-task-type="${used}"]`);
      await usedCard.getByRole('button', { name: 'Delete' }).click();
      const dialog = page.locator('[data-haive-dialog]');
      await expect(dialog).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);

      await usedCard.getByRole('button', { name: 'Delete' }).click();
      await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(dialog).toContainText('Tasks of this type exist; disable it instead');
      await page.keyboard.press('Escape');
      await expect(usedCard).toBeVisible();

      const unusedCard = page.locator(`[data-task-type="${unused}"]`);
      await unusedCard.getByRole('button', { name: 'Delete' }).click();
      await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(unusedCard).toHaveCount(0, { timeout: 10_000 });
      const gone = await sql`select 1 from task_type_definitions where slug = ${unused}`;
      expect(gone).toHaveLength(0);
    });
  });
});
