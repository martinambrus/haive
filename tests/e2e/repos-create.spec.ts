import { expect, test, type APIRequestContext } from '@playwright/test';
import { cleanupUser, getSql } from './helpers/db.js';

const API_BASE = process.env.PLAYWRIGHT_API_BASE ?? 'http://localhost:3001';
const PASSWORD = 'e2e-password-12345';

function uniqueEmail(prefix: string): string {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${stamp}-${rand}@haive-e2e.test`;
}

async function registerAndGetUserId(request: APIRequestContext, email: string): Promise<string> {
  const res = await request.post(`${API_BASE}/auth/register`, {
    data: { email, password: PASSWORD },
  });
  expect(res.status(), `register failed: ${await res.text()}`).toBe(201);
  const body = (await res.json()) as { user: { id: string } };
  return body.user.id;
}

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
  test('local_path happy path: pick git dir, submit, redirected, row in db', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    const createdRepoIds: string[] = [];
    try {
      const email = uniqueEmail('repo-local');
      userId = await registerAndGetUserId(page.request, email);

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
          id: string;
          name: string;
          source: string;
          local_path: string | null;
          branch: string | null;
        }[]
      >`
        select id, name, source, local_path, branch
        from repositories where user_id = ${userId} and name = ${repoName}
      `;
      expect(rows).toHaveLength(1);
      createdRepoIds.push(rows[0]!.id);
      expect(rows[0]!.source).toBe('local_path');
      expect(rows[0]!.local_path).toBe(gitDir!.path);
      expect(rows[0]!.branch).toBe('main');

      await expect(page.getByRole('heading', { level: 2, name: repoName })).toBeVisible();
    } finally {
      for (const id of createdRepoIds) {
        await sql`delete from repositories where id = ${id}`;
      }
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('remote git_https submit records row with remote_url', async ({ page }) => {
    // Note: the form's "Git (HTTPS)" option is `git_https`. The legacy
    // `github_https` source enum value still exists in shared/types but the UI
    // consolidated all https flows (github + gitlab + generic) under git_https.
    const sql = getSql();
    let userId = '';
    const createdRepoIds: string[] = [];
    try {
      const email = uniqueEmail('repo-remote');
      userId = await registerAndGetUserId(page.request, email);

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
          id: string;
          source: string;
          remote_url: string | null;
          branch: string | null;
        }[]
      >`
        select id, source, remote_url, branch
        from repositories where user_id = ${userId} and name = ${repoName}
      `;
      expect(rows).toHaveLength(1);
      createdRepoIds.push(rows[0]!.id);
      expect(rows[0]!.source).toBe('git_https');
      expect(rows[0]!.remote_url).toBe(remoteUrl);
      expect(rows[0]!.branch).toBe('master');

      await expect(page.getByRole('heading', { level: 2, name: repoName })).toBeVisible();
    } finally {
      for (const id of createdRepoIds) {
        await sql`delete from repositories where id = ${id}`;
      }
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('local_path without selection shows validation error', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('repo-noselect');
      userId = await registerAndGetUserId(page.request, email);

      await page.goto('/repos/new');
      await expect(page.getByRole('heading', { name: 'Add a repository' })).toBeVisible();

      await page.getByLabel('Display name').fill('e2e-no-pick');
      await page.getByRole('button', { name: /create repository/i }).click();

      await expect(
        page.getByText(/Pick a local directory containing a \.git folder/),
      ).toBeVisible();
      expect(page.url()).toMatch(/\/repos\/new$/);
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });
});
