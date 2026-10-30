import { expect, test } from '@playwright/test';
import { cleanupRepoFixture, cleanupUser, getSql, seedRepoFixture } from '../helpers/db.js';
import { registerUser } from '../helpers/auth.js';

/**
 * The AGENTS.md rules card on the Tooling page, in Override mode.
 *
 * The card edits an override in the markdown editor with autofocus off, and that editor once drew
 * nothing: the card showed its text and buttons around an empty box, so an override could not be
 * edited at all. The unit tests render no DOM, so only a real page can say whether the editor is
 * there. Each step is one way the card comes to hold an editor: choosing the override, a save
 * that remounts it, and a page load with an override stored.
 */

const RULE = 'Run the linter before every commit.';
// A navigation or a save has to finish before the page can show its result.
const SLOW = { timeout: 30_000 };

test('the AGENTS.md rules override can be chosen, edited, saved and reopened', async ({ page }) => {
  test.setTimeout(120_000);
  const sql = getSql();
  let userId = '';
  let repo = null as Awaited<ReturnType<typeof seedRepoFixture>> | null;
  try {
    userId = (await registerUser(sql, page.request, { prefix: 'rules-editor' })).userId;
    repo = await seedRepoFixture(sql, userId, 'rules-editor');
    const tooling = `/repos/${repo.repoId}/tooling`;
    const override = page.getByRole('radio', { name: 'Override for this repository' });
    const toolbar = page.getByRole('toolbar', { name: 'Formatting' });
    const editor = page.getByRole('group').filter({ has: toolbar }).getByRole('textbox');

    await test.step('choosing the override shows the editor', async () => {
      await page.goto(tooling);
      await override.check();
      await expect(toolbar).toBeVisible(SLOW);
      await expect(editor).toBeVisible(SLOW);
    });

    await test.step('saving keeps the editor on the page', async () => {
      await editor.click();
      await page.keyboard.press('ControlOrMeta+a');
      await page.keyboard.type(RULE);
      await page.getByRole('button', { name: 'Save AGENTS.md rules' }).click();
      await expect(page.getByText('Saved.', { exact: true })).toBeVisible(SLOW);
      await expect(toolbar).toBeVisible(SLOW);
      await expect(editor).toContainText(RULE, SLOW);
    });

    await test.step('a stored override opens in the editor', async () => {
      await page.reload();
      await expect(override).toBeChecked(SLOW);
      await expect(toolbar).toBeVisible(SLOW);
      await expect(editor).toContainText(RULE, SLOW);
    });
  } finally {
    if (repo) await cleanupRepoFixture(sql, repo.repoId);
    if (userId) await cleanupUser(sql, userId);
    await sql.end({ timeout: 5 });
  }
});
