import type { Page } from '@playwright/test';
import { seedRepoFixture } from '../helpers/db.js';
import { expect, test } from '../helpers/fixtures.js';

const REMEMBERED = '00000000-0000-4000-8000-0000000000c1';
const PICKED = '00000000-0000-4000-8000-0000000000c2';

/** Two providers, faked on top of the api's own response so its headers stay the api's. */
async function fakeProviders(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname === '/cli-providers',
    async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        json: {
          providers: [
            { id: REMEMBERED, name: 'claude-code', label: 'Remembered' },
            { id: PICKED, name: 'codex', label: 'Picked' },
          ],
        },
      });
    },
  );
}

/** Answers `/tasks/last-cli` with REMEMBERED for both dropdowns, once `release` is called. */
async function holdLastCli(page: Page): Promise<{ asked: Promise<void>; release: () => void }> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let markAsked!: () => void;
  const asked = new Promise<void>((resolve) => (markAsked = resolve));
  await page.route(
    (url) => url.pathname === '/tasks/last-cli',
    async (route) => {
      markAsked();
      const response = await route.fetch();
      await released;
      await route.fulfill({
        response,
        json: {
          cliChoice: { providerId: REMEMBERED },
          summaryChoice: { providerId: REMEMBERED, llmEnabled: true },
        },
      });
    },
  );
  return { asked, release };
}

test.describe('New Task form remembers the last CLI choice', () => {
  test('a CLI picked while the remembered choice loads stands', async ({ page, sql, users }) => {
    const { userId } = await users.register(page.request, { prefix: 'cli-memory' });
    const { repoId } = await seedRepoFixture(sql, userId, 'cli-memory');
    await fakeProviders(page);
    const lastCli = await holdLastCli(page);

    await page.goto(`/tasks/new?repositoryId=${repoId}`);
    await lastCli.asked;
    await expect(page.locator(`#cliProviderId option[value="${PICKED}"]`)).toBeAttached();
    await page.locator('#cliProviderId').selectOption(PICKED);
    lastCli.release();

    // The answer fills the dropdown nobody picked, which is how this knows it has landed.
    await expect(page.locator('#summaryCliProviderId')).toHaveValue(REMEMBERED);
    await expect(page.locator('#cliProviderId')).toHaveValue(PICKED);
  });

  test('a summary CLI picked while the remembered choice loads stands', async ({
    page,
    sql,
    users,
  }) => {
    const { userId } = await users.register(page.request, { prefix: 'cli-memory' });
    const { repoId } = await seedRepoFixture(sql, userId, 'cli-memory');
    await fakeProviders(page);
    const lastCli = await holdLastCli(page);

    await page.goto(`/tasks/new?repositoryId=${repoId}`);
    await lastCli.asked;
    await expect(page.locator(`#summaryCliProviderId option[value="${PICKED}"]`)).toBeAttached();
    await page.locator('#summaryCliProviderId').selectOption(PICKED);
    lastCli.release();

    await expect(page.locator('#cliProviderId')).toHaveValue(REMEMBERED);
    await expect(page.locator('#summaryCliProviderId')).toHaveValue(PICKED);
  });

  test('the remembered choice fills both dropdowns, and a pick does not follow to another repository', async ({
    page,
    sql,
    users,
  }) => {
    const { userId } = await users.register(page.request, { prefix: 'cli-memory' });
    const first = await seedRepoFixture(sql, userId, 'cli-memory-a');
    const second = await seedRepoFixture(sql, userId, 'cli-memory-b');
    await fakeProviders(page);
    const lastCli = await holdLastCli(page);
    lastCli.release();

    await page.goto(`/tasks/new?repositoryId=${first.repoId}`);
    await expect(page.locator('#cliProviderId')).toHaveValue(REMEMBERED);
    await expect(page.locator('#summaryCliProviderId')).toHaveValue(REMEMBERED);

    await page.locator('#cliProviderId').selectOption(PICKED);
    await page.locator('#repositoryId').selectOption(second.repoId);
    await expect(page.locator('#cliProviderId')).toHaveValue(REMEMBERED);
  });
});
