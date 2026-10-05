import { expect, test, type Page } from '@playwright/test';
import { cleanupUser, getSql } from '../helpers/db.js';
import { registerUser } from '../helpers/auth.js';

const ENTRY_ID = '00000000-0000-4000-8000-0000000000d1';
const PREDECESSOR_ID = '00000000-0000-4000-8000-0000000000d2';

function article() {
  return {
    id: ENTRY_ID,
    title: 'AI-written house rule',
    namespace: 'default',
    body: '## House rule\n\nKeep **important** text.\n\n- First rule\n- Second rule',
    description: 'A rule worth reviewing.',
    category: 'best_practice',
    facets: {},
    status: 'draft',
    source: 'promoted',
    supersedesEntryId: PREDECESSOR_ID,
    embedStatus: 'pending',
    updatedAt: new Date().toISOString(),
  };
}

/** Keep writes local to the fixture: these tests must never activate or edit house standards. */
async function mockKb(page: Page) {
  let entry = article();
  const patches: Record<string, unknown>[] = [];
  let failSave = false;
  let configWrites = 0;
  await page.route(
    (url) => url.pathname.startsWith('/global-kb/'),
    async (route) => {
      const { pathname } = new URL(route.request().url());
      let json: unknown;
      let status = 200;
      if (pathname === '/global-kb/config') {
        if (route.request().method() === 'PUT') configWrites++;
        json = {
          enabled: false,
          digestEnabled: true,
          mode: 'internal',
          namespace: 'default',
          ollamaUrl: 'http://ollama:11434',
          embedModel: 'qwen3-embedding:4b',
          embedDimensions: 2560,
          archiveRetentionDays: 90,
          connectionStringSet: false,
        };
      } else if (pathname === '/global-kb/entries') {
        json = { entries: [entry], total: 1, frameworks: [] };
      } else if (pathname === `/global-kb/entries/${PREDECESSOR_ID}`) {
        json = { entry: { ...article(), id: PREDECESSOR_ID, body: 'The previous rule.' } };
      } else if (pathname === `/global-kb/entries/${ENTRY_ID}`) {
        if (route.request().method() === 'PATCH') {
          const patch = route.request().postDataJSON() as Record<string, unknown>;
          patches.push(patch);
          if (failSave) {
            status = 503;
            json = { error: 'Could not save this article.' };
          } else {
            entry = { ...entry, ...patch };
            json = { entry };
          }
        } else json = { entry };
      } else json = { ok: true, message: 'Fixture connection' };
      await route.fulfill({
        status,
        headers: {
          'access-control-allow-origin': 'http://localhost:3000',
          'access-control-allow-credentials': 'true',
        },
        contentType: 'application/json',
        body: JSON.stringify(json),
      });
    },
  );
  return {
    patches,
    fail: (value: boolean) => {
      failSave = value;
    },
    configWrites: () => configWrites,
  };
}

test.describe('global KB authoring and editing', () => {
  let userId = '';
  let sql: ReturnType<typeof getSql>;
  test.beforeEach(async ({ page }) => {
    sql = getSql();
    userId = (await registerUser(sql, page.request, { prefix: 'kb-edit' })).userId;
  });
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'wait' });
    if (userId) await cleanupUser(sql, userId);
    await sql.end({ timeout: 5 });
  });

  test('field limits use normalized descriptions and numeric settings reject invalid values', async ({
    page,
  }) => {
    const mock = await mockKb(page);
    await page.goto('/settings/global-kb');
    const title = page.getByLabel('Title', { exact: true });
    await title.fill('t'.repeat(300));
    await title.press('End');
    await title.press('x');
    await expect(title).toHaveValue('t'.repeat(300));
    const description = page.getByLabel('Description (optional)', { exact: true });
    await description.fill('d'.repeat(300));
    await description.press('End');
    await description.press('x');
    await expect(description).toHaveValue(`${'d'.repeat(300)}x`);
    await expect(page.locator('#enrich-description-limit')).toHaveText('301 / 300');
    await expect(description).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('button', { name: 'Add with AI' })).toBeDisabled();
    await expect(
      page.getByText('Description must be at most 300 characters after whitespace is collapsed.'),
    ).toBeVisible();
    const padded = `Keep${' '.repeat(400)}all words.`;
    await description.fill(padded);
    await expect(description).toHaveValue(padded);
    await expect(page.locator('#enrich-description-limit')).toHaveText('15 / 300');
    await expect(page.getByRole('button', { name: 'Add with AI' })).toBeEnabled();
    await page.getByLabel('House rules / notes').fill('n'.repeat(2000));
    await expect(page.getByLabel('House rules / notes')).toHaveValue('n'.repeat(2000));

    const namespace = page.getByLabel('Namespace', { exact: true });
    await namespace.fill('s'.repeat(120));
    await namespace.press('End');
    await namespace.press('x');
    await expect(namespace).toHaveValue('s'.repeat(120));
    await expect(page.locator('#cfg-namespace-limit')).toHaveText('120 / 120');
    await page.getByLabel('Dimensions', { exact: true }).fill('8193');
    await page.getByRole('button', { name: 'Save connection' }).click();
    await expect(page.getByText('Dimensions must be a whole number from 1 to 8192.')).toBeVisible();
    await page.getByLabel('Dimensions', { exact: true }).fill('');
    await expect(page.getByLabel('Dimensions', { exact: true })).toHaveValue('');
    await page.getByRole('button', { name: 'Save connection' }).click();
    await expect(page.getByText('Dimensions must be a whole number from 1 to 8192.')).toBeVisible();
    await page.getByLabel('Dimensions', { exact: true }).fill('2560');
    await page.getByLabel('Archive retention (days)').fill('-1');
    await expect(page.getByLabel('Archive retention (days)')).toHaveValue('-1');
    await page.getByRole('button', { name: 'Save connection' }).click();
    await expect(
      page.getByText('Archive retention must be a whole number from 0 to 3650 days.'),
    ).toBeVisible();
    expect(mock.configWrites()).toBe(0);

    await page.getByRole('button', { name: 'AI-written house rule', exact: false }).click();
    const dialog = page.locator('[data-haive-dialog]');
    await dialog.getByRole('button', { name: 'Edit description' }).click();
    await dialog.locator('#description-edit').fill('e'.repeat(300));
    await dialog.locator('#description-edit').press('End');
    await dialog.locator('#description-edit').press('x');
    await expect(dialog.locator('#description-edit')).toHaveValue(`${'e'.repeat(300)}x`);
    await expect(dialog.getByRole('button', { name: 'Save description' })).toBeDisabled();
    expect(mock.patches).toHaveLength(0);
    await dialog.locator('#description-edit').fill(padded);
    await expect(dialog.locator('#description-edit-limit')).toHaveText('15 / 300');
    await dialog.getByRole('button', { name: 'Save description' }).click();
    await expect(dialog.getByRole('button', { name: 'Edit description' })).toBeVisible();
    expect(mock.patches).toEqual([{ description: padded }]);
    await dialog.getByRole('button', { name: 'Edit description' }).click();
    await dialog.locator('#description-edit').fill('e'.repeat(300));
    await dialog.getByRole('button', { name: 'Save description' }).click();
    expect(mock.patches).toEqual([{ description: padded }, { description: 'e'.repeat(300) }]);
  });

  test('edits an AI replacement in the WYSIWYG editor and saves markdown back to the diff', async ({
    page,
  }) => {
    const mock = await mockKb(page);
    await page.goto('/settings/global-kb');
    await page.getByRole('button', { name: 'AI-written house rule', exact: false }).click();
    const dialog = page.locator('[data-haive-dialog]');
    await expect(dialog.getByText('Updates existing:', { exact: false })).toBeVisible();
    await dialog.getByRole('button', { name: 'Edit body' }).click();
    const editor = dialog.locator('[contenteditable="true"]');
    await expect(editor.locator('h2')).toHaveText('House rule');
    await expect(editor.locator('strong')).toHaveText('important');
    await expect(editor.locator('li')).toHaveCount(2);
    await expect(dialog.getByRole('button', { name: 'Activate', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Delete', exact: true })).toBeDisabled();
    await editor.press('Control+End');
    await editor.press('Enter');
    await editor.pressSequentially('A corrected rule');
    await dialog.getByRole('button', { name: 'Save body' }).click();
    await expect(dialog.getByRole('button', { name: 'Edit body' })).toBeVisible();
    expect(mock.patches).toHaveLength(1);
    expect(Object.keys(mock.patches[0]!)).toEqual(['body']);
    expect(mock.patches[0]!.body).toContain('## House rule');
    expect(mock.patches[0]!.body).toContain('**important**');
    expect(mock.patches[0]!.body).toContain('- A corrected rule');
    await expect(dialog.getByText('A corrected rule', { exact: false })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Activate', exact: true })).toBeEnabled();

    await dialog.getByRole('button', { name: 'Edit body' }).click();
    await editor.fill('Discard this change');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog.getByText('A corrected rule', { exact: false })).toBeVisible();
    expect(mock.patches).toHaveLength(1);
    await dialog.getByRole('button', { name: 'Edit body' }).click();
    await editor.fill('Discard via Escape');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Edit body' }).click();
    await expect(editor).not.toContainText('Discard');
  });

  test('rejects an empty body and preserves corrections when saving fails', async ({ page }) => {
    const mock = await mockKb(page);
    await page.goto('/settings/global-kb');
    await page.getByRole('button', { name: 'AI-written house rule', exact: false }).click();
    const dialog = page.locator('[data-haive-dialog]');
    await dialog.getByRole('button', { name: 'Edit body' }).click();
    const editor = dialog.locator('[contenteditable="true"]');
    await editor.fill('');
    await dialog.getByRole('button', { name: 'Save body' }).click();
    await expect(dialog.getByText('The article body cannot be empty.')).toBeVisible();
    expect(mock.patches).toHaveLength(0);
    await editor.fill('A correction to keep');
    mock.fail(true);
    await dialog.getByRole('button', { name: 'Save body' }).click();
    await expect(dialog.getByText('Could not save this article.')).toBeVisible();
    await expect(editor).toHaveText('A correction to keep');
    await expect(dialog.getByRole('button', { name: 'Activate', exact: true })).toBeDisabled();
    mock.fail(false);
    await dialog.getByRole('button', { name: 'Save body' }).click();
    await expect(dialog.getByRole('button', { name: 'Edit body' })).toBeVisible();
    await expect(dialog.getByText('A correction to keep', { exact: false })).toBeVisible();
  });
});
