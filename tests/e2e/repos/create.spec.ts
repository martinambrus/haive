import type { APIRequestContext } from '@playwright/test';
import { API_BASE } from '../helpers/auth.js';
import { expect, test } from '../helpers/fixtures.js';

interface FsEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  hasGit: boolean;
  hidden: boolean;
}

async function findFirstGitDir(request: APIRequestContext): Promise<FsEntry | null> {
  const res = await request.get(`${API_BASE}/filesystem`);
  expect(res.status()).toBe(200);
  const listing = (await res.json()) as { entries: FsEntry[] };
  return listing.entries.find((e) => e.isDirectory && e.hasGit) ?? null;
}

test.describe('repos create UI', () => {
  test('local_path happy path: pick git dir, submit, redirected, row in db', async ({
    page,
    sql,
    users,
  }) => {
    const { userId } = await users.register(page.request, { prefix: 'repo-local' });

    const gitDir = await findFirstGitDir(page.request);
    test.skip(!gitDir, 'no git directory available under filesystem root');

    await page.goto('/repos/new');
    await expect(page.getByRole('heading', { name: 'Add a repository' })).toBeVisible();

    const repoName = `e2e-local-${Date.now().toString(36)}`;
    await page.getByLabel('Display name').fill(repoName);

    // default source is local_path
    await expect(page.locator('#repo-source')).toHaveValue('local_path');

    await page.getByRole('button', { name: 'Pick' }).first().click();
    await expect(page.getByText(/Selected:/)).toBeVisible();

    await page.getByRole('button', { name: /create repository/i }).click();
    await page.waitForURL(/\/repos$/, { timeout: 10_000 });

    const rows = await sql<
      {
        name: string;
        source: string;
        local_path: string | null;
        branch: string | null;
      }[]
    >`
      select name, source, local_path, branch
      from repositories where user_id = ${userId} and name = ${repoName}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe('local_path');
    expect(rows[0]!.local_path).toBe(gitDir!.path);
    expect(rows[0]!.branch).toBe('main');

    await expect(page.getByRole('heading', { level: 2, name: repoName })).toBeVisible();
  });

  test('remote git_https submit records row with remote_url', async ({ page, sql, users }) => {
    // Note: the form's "Git (HTTPS)" option is `git_https`. The legacy
    // `github_https` source enum value still exists in shared/types but the UI
    // consolidated all https flows (github + gitlab + generic) under git_https.
    const { userId } = await users.register(page.request, { prefix: 'repo-remote' });

    await page.goto('/repos/new');
    await expect(page.getByRole('heading', { name: 'Add a repository' })).toBeVisible();

    const repoName = `e2e-remote-${Date.now().toString(36)}`;
    await page.getByLabel('Display name').fill(repoName);

    await page.locator('#repo-source').selectOption('git_https');
    await expect(page.getByLabel('Repository URL')).toBeVisible();

    const remoteUrl = 'https://github.com/octocat/Hello-World.git';
    await page.getByLabel('Repository URL').fill(remoteUrl);
    await page.getByLabel('Branch (optional)').fill('master');

    await page.getByRole('button', { name: /create repository/i }).click();
    await page.waitForURL(/\/repos$/, { timeout: 10_000 });

    const rows = await sql<
      {
        source: string;
        remote_url: string | null;
        branch: string | null;
      }[]
    >`
      select source, remote_url, branch
      from repositories where user_id = ${userId} and name = ${repoName}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe('git_https');
    expect(rows[0]!.remote_url).toBe(remoteUrl);
    expect(rows[0]!.branch).toBe('master');

    await expect(page.getByRole('heading', { level: 2, name: repoName })).toBeVisible();
  });

  test('local_path without selection shows validation error', async ({ page, users }) => {
    await users.register(page.request, { prefix: 'repo-noselect' });

    await page.goto('/repos/new');
    await expect(page.getByRole('heading', { name: 'Add a repository' })).toBeVisible();

    await page.getByLabel('Display name').fill('e2e-no-pick');
    await page.getByRole('button', { name: /create repository/i }).click();

    await expect(page.getByText(/Pick a local directory containing a \.git folder/)).toBeVisible();
    expect(page.url()).toMatch(/\/repos\/new$/);
  });
});
