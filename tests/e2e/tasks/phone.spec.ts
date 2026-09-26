import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type postgres from 'postgres';
import {
  cleanupRepoFixture,
  cleanupTaskFixture,
  cleanupUser,
  getSql,
  seedRepoFixture,
} from '../helpers/db.js';
import { registerUser } from '../helpers/auth.js';

/** A summary holding a before/after pair, which renders as a side-by-side diff. */
const BEFORE_AFTER_SUMMARY = [
  'Changed the retry loop.',
  '',
  '```before',
  'const retries = options.retries ?? DEFAULT_RETRY_COUNT;',
  '```',
  '```after',
  'const retries = Math.max(0, options.retries ?? DEFAULT_RETRY_COUNT);',
  '```',
].join('\n');

interface TaskPageFixture {
  taskId: string;
  userId: string;
  repoId: string;
}

/**
 * A running task carrying everything that competes for the header and the fixed title strip: a
 * repository whose name has no break in it and an execution path badge, a long title, two live
 * usage meters (the current step's default CLI and one of its seats on a second provider), and both
 * estimates, which is the widest those rows get. A finished step carries a duration and a round
 * badge beside its title.
 *
 * Fills `fx` as it goes, so the cleanup removes whatever was created before a failure.
 */
async function seedTaskPage(
  sql: postgres.Sql,
  page: Page,
  prefix: string,
  fx: TaskPageFixture,
): Promise<void> {
  fx.userId = (await registerUser(sql, page.request, { prefix })).userId;
  fx.repoId = (await seedRepoFixture(sql, fx.userId, 'phone')).repoId;
  await sql`update repositories set name = ${`phone_${'x'.repeat(48)}`} where id = ${fx.repoId}`;
  const [claude, codex] = [randomUUID(), randomUUID()];
  await sql`
    insert into cli_providers (id, user_id, name, label)
    values (${claude}, ${fx.userId}, 'claude-code', 'Claude'), (${codex}, ${fx.userId}, 'codex', 'Codex')
  `;
  const reset = new Date(Date.now() + 3 * 3_600_000);
  await sql`
    insert into usage_window_snapshots (
      provider_id, user_id, provider_name, five_hour_pct, five_hour_reset_at,
      seven_day_pct, seven_day_reset_at, status
    ) values
      (${claude}, ${fx.userId}, 'claude-code', 41, ${reset}, 52, ${reset}, 'ok'),
      (${codex}, ${fx.userId}, 'codex', 12, ${reset}, 33, ${reset}, 'ok')
  `;
  await sql`
    insert into user_step_cli_role_preferences (user_id, step_id, role, cli_provider_id, explicit)
    values (${fx.userId}, '08c-code-review', 'peer-reviewer', ${codex}, true)
  `;
  const started = new Date(Date.now() - 2 * 3_600_000);
  const ended = new Date(started.getTime() + 37 * 60_000 + 13_000);
  await sql`
    insert into tasks (
      id, user_id, type, title, status, repository_id, cli_provider_id, execution_path,
      current_step_id, current_step_index, estimated_time_hours, ai_estimated_time_hours,
      started_at, created_at, updated_at
    ) values (
      ${fx.taskId}, ${fx.userId}, 'workflow',
      'A task title long enough that a phone has to truncate it somewhere',
      'running', ${fx.repoId}, ${claude}, 'full_workflow', '08c-code-review', 1, 3, 1.5,
      ${started}, ${started}, ${started}
    )
  `;
  await sql`
    insert into task_steps (
      id, task_id, step_id, step_index, title, status, iteration_count, started_at, ended_at,
      summary, created_at, updated_at
    ) values
      (${randomUUID()}, ${fx.taskId}, '08b-test-management', 0, 'Phase 5b: Test management',
       'done', 2, ${started}, ${ended}, ${BEFORE_AFTER_SUMMARY}, ${started}, ${ended}),
      (${randomUUID()}, ${fx.taskId}, '08c-code-review', 1, 'Phase 6: Code review',
       'running', 0, ${ended}, null, null, ${ended}, ${ended})
  `;
}

async function cleanupTaskPage(sql: postgres.Sql, fx: TaskPageFixture): Promise<void> {
  await cleanupTaskFixture(sql, fx.taskId);
  if (fx.userId) {
    await sql`delete from user_step_cli_role_preferences where user_id = ${fx.userId}`;
    await sql`delete from usage_window_snapshots where user_id = ${fx.userId}`;
    await sql`delete from cli_providers where user_id = ${fx.userId}`;
  }
  if (fx.repoId) await cleanupRepoFixture(sql, fx.repoId);
  if (fx.userId) await cleanupUser(sql, fx.userId);
}

test.describe('task page on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('fits the screen, and the title strip keeps to one line', async ({ page }) => {
    const sql = getSql();
    const fx: TaskPageFixture = { taskId: randomUUID(), userId: '', repoId: '' };
    try {
      await seedTaskPage(sql, page, 'task-phone', fx);

      await page.goto(`/tasks/${fx.taskId}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.locator('[title*="subscription usage"]')).toHaveCount(2);

      const main = page.locator('main');
      expect(
        await main.evaluate((el) => el.scrollWidth - el.clientWidth),
        'nothing pushes the page sideways',
      ).toBeLessThanOrEqual(1);

      const duration = page.locator('[data-step-id] [title="Active work time"]').first();
      expect(
        (await duration.boundingBox())!.height,
        'a step duration keeps to one line',
      ).toBeLessThan(20);

      // The document scrolls, not <main> (see sidebar-nav.tsx), and the strip shows only once the
      // header is scrolled out of view.
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const strip = page.locator('[data-fixed-title-strip]');
      await expect(strip).toBeVisible();
      const fit = await strip.evaluate((el) => {
        const box = el.getBoundingClientRect();
        return {
          height: box.height,
          outside: Array.from(el.children).filter((child) => {
            const b = child.getBoundingClientRect();
            return b.width > 0 && (b.right > box.right + 1 || b.left < box.left - 1);
          }).length,
        };
      });
      expect(fit.outside, 'every item of the strip is inside it').toBe(0);
      expect(fit.height, 'the strip keeps to one line').toBeLessThan(48);
    } finally {
      await cleanupTaskPage(sql, fx);
      await sql.end({ timeout: 5 });
    }
  });

  test('a before/after pair leaves each half room to read', async ({ page }) => {
    const sql = getSql();
    const fx: TaskPageFixture = { taskId: randomUUID(), userId: '', repoId: '' };
    try {
      await seedTaskPage(sql, page, 'task-phone-diff', fx);

      await page.goto(`/tasks/${fx.taskId}`);
      const step = page.locator('[data-step-id]', {
        has: page.getByRole('heading', { name: 'Phase 5b: Test management' }),
      });
      await step.getByText('What the agent did').click();
      const half = step.locator('pre', { hasText: 'DEFAULT_RETRY_COUNT' }).first();
      await expect(half).toBeVisible();
      expect(
        (await half.boundingBox())!.width,
        'a half shows a line of code, not a few characters of it',
      ).toBeGreaterThan(200);
      expect(
        await page.locator('main').evaluate((el) => el.scrollWidth - el.clientWidth),
        'the pair scrolls inside itself, not the page',
      ).toBeLessThanOrEqual(1);

      // A tablet with the sidebar open leaves the pair less room than a phone does.
      await page.setViewportSize({ width: 768, height: 1024 });
      await expect
        .poll(async () => (await half.boundingBox())!.width, { message: 'the same holds at 768px' })
        .toBeGreaterThan(200);
      expect(
        await page.locator('main').evaluate((el) => el.scrollWidth - el.clientWidth),
        'the pair scrolls inside itself at 768px too',
      ).toBeLessThanOrEqual(1);
    } finally {
      await cleanupTaskPage(sql, fx);
      await sql.end({ timeout: 5 });
    }
  });
});

test.describe('task title strip', () => {
  test('keeps its title readable at every width, with the sidebar open or folded', async ({
    page,
  }) => {
    const sql = getSql();
    const fx: TaskPageFixture = { taskId: randomUUID(), userId: '', repoId: '' };
    try {
      await seedTaskPage(sql, page, 'task-strip', fx);

      // Short, so the header scrolls out of view even at the widest width.
      await page.setViewportSize({ width: 1920, height: 500 });
      await page.goto(`/tasks/${fx.taskId}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.locator('html[data-shell-hydrated="true"]')).toHaveCount(1);

      const strip = page.locator('[data-fixed-title-strip]');
      const misfits: string[] = [];
      for (const sidebar of ['open', 'folded'] as const) {
        if (sidebar === 'folded') {
          await page.setViewportSize({ width: 1920, height: 500 });
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.getByRole('button', { name: 'Collapse sidebar' }).click();
          await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
        }
        for (let width = 375; width <= 1920; width += 25) {
          await page.setViewportSize({ width, height: 500 });
          await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
          await expect(strip).toBeVisible();
          // The strip's own usage chip fetches when the strip mounts; hidden or not, its two
          // meters are in the DOM once it has loaded.
          await expect(strip.locator('[title*="subscription usage"]')).toHaveCount(2);
          const fit = await strip.evaluate((el) => ({
            overflow: el.scrollWidth - el.clientWidth,
            title: Math.round(el.querySelector('p')!.getBoundingClientRect().width),
          }));
          // 80px is about ten characters of the title, the one thing the strip is there to show.
          if (fit.overflow > 1 || fit.title < 80) {
            misfits.push(
              `${width}px, sidebar ${sidebar}: overflow ${fit.overflow}px, title ${fit.title}px`,
            );
          }
        }
      }
      expect(misfits, 'the strip holds all its items and a readable title').toEqual([]);
    } finally {
      await cleanupTaskPage(sql, fx);
      await sql.end({ timeout: 5 });
    }
  });
});
