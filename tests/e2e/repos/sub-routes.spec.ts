import { expect, test } from '@playwright/test';
import { cleanupRepoFixture, cleanupUser, getSql, seedRepoFixture } from '../helpers/db.js';
import { API_BASE, registerUser } from '../helpers/auth.js';

/**
 * The repository's own sub-routes: tooling and estimates.
 *
 * Small on purpose. These are per-repo read surfaces that nothing in the suite touched, and the
 * regression worth catching is the cheap one — a route that stops resolving, or one that answers
 * for a repository its caller does not own. The tooling page has a wide settings form behind it,
 * but its individual controls are ordinary PATCH round trips of the kind the settings specs
 * already cover; repeating that per control would buy runtime rather than coverage.
 */

const SUB_ROUTES = ['tooling', 'estimates'] as const;

test.describe('repository sub-routes', () => {
  test('tooling and estimates resolve for the owner', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    let repo = null as Awaited<ReturnType<typeof seedRepoFixture>> | null;
    try {
      userId = (await registerUser(sql, page.request, { prefix: 'repo-sub' })).userId;
      repo = await seedRepoFixture(sql, userId, 'sub-routes');

      for (const route of SUB_ROUTES) {
        await page.goto(`/repos/${repo.repoId}/${route}`);
        await expect(page, route).toHaveURL(new RegExp(`/${route}$`), { timeout: 45_000 });
        // Something of the page's own, rather than the app shell it shares with every route:
        // a failed fetch on either of these leaves the chrome standing and the panel empty.
        await expect(page.getByRole('heading').first()).toBeVisible({ timeout: 30_000 });
      }
    } finally {
      if (repo) await cleanupRepoFixture(sql, repo.repoId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('the tooling config is refused to a stranger', async ({ page, playwright }) => {
    const sql = getSql();
    let ownerId = '';
    let strangerId = '';
    let repo = null as Awaited<ReturnType<typeof seedRepoFixture>> | null;
    const strangerCtx = await playwright.request.newContext();
    try {
      ownerId = (await registerUser(sql, page.request, { prefix: 'tooling-owner' })).userId;
      repo = await seedRepoFixture(sql, ownerId, 'tooling-private');

      // The owner can read it.
      const mine = await page.request.get(`${API_BASE}/repositories/${repo.repoId}/tooling-config`);
      expect(mine.status()).toBe(200);

      strangerId = (await registerUser(sql, strangerCtx, { prefix: 'tooling-stranger' })).userId;
      const theirs = await strangerCtx.get(
        `${API_BASE}/repositories/${repo.repoId}/tooling-config`,
      );
      // This config decides what agents may read inside that repository — the secret-mask globs
      // live here — so a cross-account read is the one failure worth pinning.
      expect([403, 404]).toContain(theirs.status());
    } finally {
      if (repo) await cleanupRepoFixture(sql, repo.repoId);
      if (strangerId) await cleanupUser(sql, strangerId);
      if (ownerId) await cleanupUser(sql, ownerId);
      await sql.end({ timeout: 5 });
      await strangerCtx.dispose();
    }
  });
});
