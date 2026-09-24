import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import {
  cleanupRepoFixture,
  cleanupTaskFixture,
  cleanupUser,
  getSql,
  seedRepoFixture,
} from '../helpers/db.js';
import { registerUser } from '../helpers/auth.js';

/**
 * The task page at a phone's width. The fixture carries everything that competes for the header
 * and the fixed title strip: a repository and an execution path badge, a long title, and two live
 * usage meters (the current step's default CLI and one of its seats on a second provider), which is
 * the widest those rows get. A finished step carries a duration and a round badge beside its title.
 */
test.describe('task page on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('fits the screen, and the title strip keeps to one line', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    let repoId = '';
    const taskId = randomUUID();
    const providerIds = [randomUUID(), randomUUID()];
    try {
      userId = (await registerUser(sql, page.request, { prefix: 'task-phone' })).userId;
      repoId = (await seedRepoFixture(sql, userId, 'phone')).repoId;
      const [claude, codex] = providerIds as [string, string];
      await sql`
        insert into cli_providers (id, user_id, name, label)
        values (${claude}, ${userId}, 'claude-code', 'Claude'), (${codex}, ${userId}, 'codex', 'Codex')
      `;
      const reset = new Date(Date.now() + 3 * 3_600_000);
      await sql`
        insert into usage_window_snapshots (
          provider_id, user_id, provider_name, five_hour_pct, five_hour_reset_at,
          seven_day_pct, seven_day_reset_at, status
        ) values
          (${claude}, ${userId}, 'claude-code', 41, ${reset}, 52, ${reset}, 'ok'),
          (${codex}, ${userId}, 'codex', 12, ${reset}, 33, ${reset}, 'ok')
      `;
      await sql`
        insert into user_step_cli_role_preferences (user_id, step_id, role, cli_provider_id, explicit)
        values (${userId}, '08c-code-review', 'peer-reviewer', ${codex}, true)
      `;
      const started = new Date(Date.now() - 2 * 3_600_000);
      const ended = new Date(started.getTime() + 37 * 60_000 + 13_000);
      await sql`
        insert into tasks (
          id, user_id, type, title, status, repository_id, cli_provider_id, execution_path,
          current_step_id, current_step_index, started_at, created_at, updated_at
        ) values (
          ${taskId}, ${userId}, 'workflow',
          'A task title long enough that a phone has to truncate it somewhere',
          'running', ${repoId}, ${claude}, 'full_workflow', '08c-code-review', 1,
          ${started}, ${started}, ${started}
        )
      `;
      await sql`
        insert into task_steps (
          id, task_id, step_id, step_index, title, status, iteration_count, started_at, ended_at,
          created_at, updated_at
        ) values
          (${randomUUID()}, ${taskId}, '08b-test-management', 0, 'Phase 5b: Test management',
           'done', 2, ${started}, ${ended}, ${started}, ${ended}),
          (${randomUUID()}, ${taskId}, '08c-code-review', 1, 'Phase 6: Code review',
           'running', 0, ${ended}, null, ${ended}, ${ended})
      `;

      await page.goto(`/tasks/${taskId}`);
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

      await main.evaluate((el) => el.scrollTo(0, el.scrollHeight));
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
      await cleanupTaskFixture(sql, taskId);
      if (userId) {
        await sql`delete from user_step_cli_role_preferences where user_id = ${userId}`;
        await sql`delete from usage_window_snapshots where user_id = ${userId}`;
        await sql`delete from cli_providers where user_id = ${userId}`;
      }
      if (repoId) await cleanupRepoFixture(sql, repoId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });
});
