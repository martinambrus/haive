import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { cleanupRepoFixture, cleanupUser, getSql, seedRepoFixture } from '../helpers/db.js';
import { API_BASE, registerUser } from '../helpers/auth.js';
import { seedPlan } from '../helpers/plan.js';

test.describe('human plan resolutions', () => {
  test('exposes human actions without offering an implementation task', async ({ page }) => {
    test.setTimeout(240_000);
    const sql = getSql();
    let userId = '';
    let repo: Awaited<ReturnType<typeof seedRepoFixture>> | null = null;
    try {
      userId = (await registerUser(sql, page.request, { prefix: 'human-plan-actions' })).userId;
      repo = await seedRepoFixture(sql, userId, 'human-actions');
      const plan = await seedPlan(sql, repo.repoId, 'human-actions');
      const question = 'Is a revision an inspection record or a version of the product data?';
      await sql`update plan_nodes set kind = 'decision', taskable = false, body = ${question} where id = ${plan.todoId}`;
      await sql`update plan_nodes set kind = 'external', taskable = false, body = 'Hosting account and deployment access must be ready.' where id = ${plan.blockedId}`;

      await page.goto(`/repos/${repo.repoId}/plan?node=${plan.todoId}`);
      const panel = page
        .locator('aside')
        .filter({ has: page.getByRole('button', { name: 'Record decision', exact: true }) });
      await expect(panel).toBeVisible({ timeout: 120_000 });
      await expect(panel.getByText('Needs your decision', { exact: true })).toBeVisible();
      await expect(panel.getByRole('button', { name: 'Create a task from this' })).toHaveCount(0);
      await expect(
        panel.getByRole('button', { name: 'Help me evaluate the options' }),
      ).toBeVisible();
      await panel.getByRole('button', { name: 'Record decision', exact: true }).click();
      const form = page
        .locator('form')
        .filter({ has: page.getByRole('heading', { name: 'Record decision', exact: true }) });
      await expect(form).toContainText(question);
      await expect(form.getByRole('radio', { name: /Still waiting/ })).toBeChecked();
      await form.getByRole('button', { name: 'Save answer and status' }).click();
      await expect(form.getByRole('textbox', { name: /What did you decide/ })).toHaveValue('');
      const [unchanged] = await sql<
        { version: number; status: string }[]
      >`select version, status from plan_nodes where id = ${plan.todoId}`;
      expect(unchanged).toEqual({ version: 1, status: 'todo' });

      await page.goto(`/repos/${repo.repoId}/plan?node=${plan.blockedId}`);
      await page
        .getByRole('button', { name: 'Record outcome', exact: true })
        .click({ timeout: 120_000 });
      await expect(page.getByRole('textbox', { name: /What is the outcome/ })).toBeVisible();
      await expect(
        page.getByText('Only choose Resolved when the requirements below are satisfied.', {
          exact: false,
        }),
      ).toBeVisible();
    } finally {
      if (repo) await cleanupRepoFixture(sql, repo.repoId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('records a decision with its status and offers the dependent work next', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const sql = getSql();
    let userId = '';
    let repo: Awaited<ReturnType<typeof seedRepoFixture>> | null = null;
    try {
      userId = (await registerUser(sql, page.request, { prefix: 'human-plan-resolve' })).userId;
      repo = await seedRepoFixture(sql, userId, 'human-resolve');
      const plan = await seedPlan(sql, repo.repoId, 'human-resolve');
      const question = 'What does revision mean?';
      const answer = 'Inspection records with a date, result and inspector.';
      await sql`update plan_nodes set kind = 'decision', taskable = false, body = ${question} where id = ${plan.todoId}`;
      await sql`update plan_nodes set status = 'done' where id = ${plan.blockedId}`;
      const workId = randomUUID();
      await sql`insert into plan_nodes (id, repository_id, parent_id, path, ordinal, title, taskable)
        values (${workId}, ${repo.repoId}, ${plan.rootId}, ${`/${plan.rootId}/${workId}/`}, 3, 'Build inspection records', true)`;
      await sql`insert into plan_node_edges (repository_id, from_node_id, to_node_id, kind)
        values (${repo.repoId}, ${workId}, ${plan.todoId}, 'depends_on')`;

      await page.goto(`/repos/${repo.repoId}/plan?node=${plan.todoId}`);
      await page
        .getByRole('button', { name: 'Record decision', exact: true })
        .click({ timeout: 120_000 });
      await page.getByRole('textbox', { name: /What did you decide/ }).fill(answer);
      await page.getByRole('radio', { name: /^Resolved/ }).check();
      const saved = page.waitForResponse(
        (res) =>
          res.request().method() === 'POST' &&
          res.url().endsWith(`/nodes/${plan.todoId}/resolution`),
      );
      await page.getByRole('button', { name: 'Save answer and status' }).click();
      expect((await saved).status()).toBe(200);
      await expect(page.getByRole('button', { name: /^Start next/ })).toHaveAttribute(
        'title',
        /Build inspection records/,
      );
      const [row] = await sql<
        { body: string; status: string; version: number }[]
      >`select body, status, version from plan_nodes where id = ${plan.todoId}`;
      expect(row).toEqual({
        body: `${question}\n\n## Decision\n\n${answer}`,
        status: 'done',
        version: 2,
      });
      const ready = await page.request.get(`${API_BASE}/repositories/${repo.repoId}/plan/ready`);
      expect(await ready.json()).toMatchObject({ matches: [{ id: workId }] });
    } finally {
      if (repo) await cleanupRepoFixture(sql, repo.repoId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });
});
