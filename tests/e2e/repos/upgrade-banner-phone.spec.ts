import { expect, test, type Page } from '@playwright/test';
import { cleanupRepoFixture, cleanupUser, getSql, seedRepoFixture } from '../helpers/db.js';
import { registerUser } from '../helpers/auth.js';

// The repository card's upgrade banner at phone width: every action it offers stays on screen.
const PHONE = { width: 375, height: 812 };

test.use({ viewport: PHONE });

async function expectActionsOnScreen(page: Page, actions: string[]): Promise<void> {
  for (const name of actions) {
    const action = page.getByRole('main').getByRole('button', { name, exact: true });
    await expect(action).toBeVisible();
    const box = await action.boundingBox();
    expect(box, name).not.toBeNull();
    expect
      .soft(box!.x + box!.width, `${name} ends inside the screen`)
      .toBeLessThanOrEqual(PHONE.width);
  }
  const [scrollWidth, clientWidth] = await page
    .getByRole('main')
    .evaluate((main) => [main.scrollWidth, main.clientWidth]);
  expect.soft(scrollWidth, 'the page does not scroll sideways').toBeLessThanOrEqual(clientWidth);
}

test('the upgrade banner keeps its actions on a phone screen', async ({ page }) => {
  const sql = getSql();
  let userId = '';
  let repoId = '';
  try {
    userId = (await registerUser(sql, page.request, { prefix: 'banner-phone' })).userId;
    repoId = (await seedRepoFixture(sql, userId, 'banner-phone')).repoId;
    const [template] = await sql<{ id: string; kind: string; version: number; hash: string }[]>`
      select template_id as id, template_kind as kind, schema_version as version,
             content_hash as hash
      from template_manifest_cache where template_kind = 'agent' order by template_id limit 1`;
    if (!template) throw new Error('the template manifest cache is empty');
    await sql`update repositories set applicable_template_ids = ${sql.array([template.id])}
              where id = ${repoId}`;
    const [onboarding] = await sql<{ id: string }[]>`
      insert into tasks (user_id, repository_id, type, title, status, completed_at)
      values (${userId}, ${repoId}, 'onboarding', 'banner-phone onboarding', 'completed', now())
      returning id`;
    const [artifact] = await sql<{ id: string }[]>`
      insert into onboarding_artifacts (user_id, repository_id, task_id, disk_path, template_id,
        template_kind, template_schema_version, template_content_hash, written_hash, source_step_id)
      values (${userId}, ${repoId}, ${onboarding!.id}, '.claude/agents/banner-phone.md',
        ${template.id}, ${template.kind}, ${template.version}, ${template.hash}, ${template.hash},
        '12-post-onboarding')
      returning id`;
    const [upgrade] = await sql<{ id: string }[]>`
      insert into tasks (user_id, repository_id, type, title, status)
      values (${userId}, ${repoId}, 'onboarding_upgrade', 'banner-phone upgrade', 'waiting_user')
      returning id`;

    // An upgrade in progress with nothing left to review.
    await page.goto('/repos');
    await expect(page.getByText('Upgrade in progress', { exact: true })).toBeVisible();
    await expectActionsOnScreen(page, ['Open task']);

    // That upgrade completed: nothing to review, and it can be rolled back.
    await sql`update tasks set status = 'completed', completed_at = now() where id = ${upgrade!.id}`;
    await sql`update onboarding_artifacts set source = 'upgrade', task_id = ${upgrade!.id}
              where id = ${artifact!.id}`;
    await page.goto('/repos');
    await expect(page.getByText('Up to date', { exact: true })).toBeVisible();
    await expectActionsOnScreen(page, ['Roll back last upgrade']);

    // A template changed since, so both the review and the rollback are offered.
    await sql`update onboarding_artifacts set template_content_hash = 'banner-phone-stale'
              where id = ${artifact!.id}`;
    await page.goto('/repos');
    await expect(page.getByText('Upgrade available', { exact: true })).toBeVisible();
    await expectActionsOnScreen(page, ['Review & apply', 'Roll back last upgrade']);
  } finally {
    if (repoId) {
      await sql`delete from onboarding_artifacts where repository_id = ${repoId}`;
      await sql`delete from tasks where repository_id = ${repoId}`;
      await cleanupRepoFixture(sql, repoId);
    }
    if (userId) await cleanupUser(sql, userId);
    await sql.end({ timeout: 5 });
  }
});
