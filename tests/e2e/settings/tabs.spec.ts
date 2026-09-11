import { expect, test } from '@playwright/test';
import { cleanupUser, getSql } from '../helpers/db.js';
import { registerUser } from '../helpers/auth.js';

/**
 * The settings section: seven tabs, each one user-scoped row.
 *
 * Cheap breadth rather than depth, and aimed at one failure in particular — a tab that renders
 * while its save is broken. Every one of these is a GET that fills a form and a PUT that stores
 * it, so the thing worth proving is the round trip: type, save, reload, still there. A unit test
 * on the route cannot see the form that feeds it.
 */

const TABS = [
  { label: 'Account', path: '/settings/account' },
  { label: 'Editor', path: '/settings/ide' },
  { label: 'Git Credentials', path: '/settings/credentials' },
  { label: 'Git Identity', path: '/settings/git-identity' },
  { label: 'Global KB', path: '/settings/global-kb' },
  { label: 'Integrations', path: '/settings/integrations' },
  { label: 'Notifications', path: '/settings/notifications' },
] as const;

test.describe('settings', () => {
  test('/settings redirects to the account tab', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      userId = (await registerUser(sql, page.request, { prefix: 'settings-root' })).userId;

      // The section has no landing page of its own — the layout is a tab bar. Signed OUT this
      // path lands on /login, which the guard sweep covers; signed IN it must reach a real tab
      // rather than a 404, which is what a bookmark or a pasted link gets.
      await page.goto('/settings');
      await expect(page).toHaveURL(/\/settings\/account$/);
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('every tab is reachable from the tab bar', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      userId = (await registerUser(sql, page.request, { prefix: 'settings-tabs' })).userId;
      await page.goto('/settings/account');

      for (const tab of TABS) {
        await page.getByRole('link', { name: tab.label, exact: true }).click();
        // Generous, because the stack under test is a DEV build that compiles a route on its
        // first visit — the server log shows "Compiling /settings/global-kb" and the navigation
        // simply has not landed yet at five seconds. Nothing about the product is slow here, and
        // CI runs the same dev images.
        await expect(page, `${tab.label} should navigate to ${tab.path}`).toHaveURL(
          new RegExp(`${tab.path}$`),
          { timeout: 30_000 },
        );
        // Something of the tab's own rendered, not merely a URL change: every one of these
        // pages fetches its row on mount, and a failed fetch leaves an empty shell behind.
        await expect(page.getByRole('heading').first()).toBeVisible();
      }
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('the git identity round-trips through a reload', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      userId = (await registerUser(sql, page.request, { prefix: 'settings-git' })).userId;

      await page.goto('/settings/git-identity');
      await expect(page.getByText('Commit author')).toBeVisible();

      await page.getByLabel('Name', { exact: true }).fill('E2E Committer');
      await page.getByLabel('Email', { exact: true }).fill('committer@haive-e2e.test');
      await page.getByRole('button', { name: 'Save' }).click();

      // Stored on the USER row rather than a settings blob, which is why this is worth
      // asserting at the database as well: it is the identity every commit the product makes
      // will carry.
      await expect
        .poll(
          async () => {
            const rows = await sql<{ git_name: string | null; git_email: string | null }[]>`
              select git_name, git_email from users where id = ${userId}
            `;
            return rows[0];
          },
          { timeout: 10_000 },
        )
        .toEqual({ git_name: 'E2E Committer', git_email: 'committer@haive-e2e.test' });

      await page.reload();
      await expect(page.getByLabel('Name', { exact: true })).toHaveValue('E2E Committer');
      await expect(page.getByLabel('Email', { exact: true })).toHaveValue(
        'committer@haive-e2e.test',
      );
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('clearing the git identity stores null rather than an empty string', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      userId = (await registerUser(sql, page.request, { prefix: 'settings-git-clear' })).userId;
      await sql`update users set git_name = 'Old Name', git_email = 'old@haive-e2e.test' where id = ${userId}`;

      await page.goto('/settings/git-identity');
      await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Old Name');

      await page.getByLabel('Name', { exact: true }).fill('');
      await page.getByLabel('Email', { exact: true }).fill('');
      await page.getByRole('button', { name: 'Save' }).click();

      // NULL, not ''. The route maps an empty string to null deliberately, and anything reading
      // this later asks "is there an identity", which an empty string answers wrongly.
      await expect
        .poll(
          async () => {
            const rows = await sql<{ git_name: string | null; git_email: string | null }[]>`
              select git_name, git_email from users where id = ${userId}
            `;
            return rows[0];
          },
          { timeout: 10_000 },
        )
        .toEqual({ git_name: null, git_email: null });
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });
});
