import { expect, test } from '@playwright/test';
import { cleanupUser, getSql } from '../helpers/db.js';
import { registerUser } from '../helpers/auth.js';

/**
 * The admin console: who may reach it, and that its pages render for someone who may.
 *
 * Deliberately READ-ONLY about global state. Most of what this console does — the pause switch in
 * its own layout, the ~30 config toggles, pricing sync — is INSTANCE-wide, and these specs run
 * against a shared dev stack where flipping any of it would reach into somebody's live work.
 * Invitations are the exception and the one thing written here: they are per-row, they are the
 * mechanism every other spec in this suite already uses, and they clean up.
 *
 * The redirect test is the gap #84 left behind. `decideAdminAccess` got unit tests and a manual
 * browser check, and neither of those would notice the guard being unmounted from the layout.
 */

test.describe('admin console', () => {
  test('a non-admin is redirected away from every admin path', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      userId = (await registerUser(sql, page.request, { prefix: 'admin-denied' })).userId;

      for (const path of ['/admin', '/admin/users', '/admin/pricing', '/admin/audit']) {
        await page.goto(path);
        // The api refuses these reads anyway; this is about not parking someone on a console
        // full of errors they can do nothing about. The guard withholds the children and
        // replaces the route, so the URL is what proves it.
        await expect(page, `${path} should not be reachable`).toHaveURL(/\/dashboard$/, {
          timeout: 30_000,
        });
      }

      // And the nav never offers it in the first place.
      await expect(page.locator('aside').getByRole('link', { name: 'Admin' })).toHaveCount(0);
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('an admin reaches the console and every one of its tabs', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      // The invite carries the role, which is the only way a spec can mint an administrator.
      userId = (await registerUser(sql, page.request, { prefix: 'admin-ok', role: 'admin' }))
        .userId;

      await page.goto('/admin');
      await expect(page.getByRole('heading', { name: 'Admin console' })).toBeVisible();
      await expect(page.locator('aside').getByRole('link', { name: 'Admin' })).toBeVisible();

      for (const tab of [
        { label: 'Users', path: '/admin/users' },
        { label: 'Pricing', path: '/admin/pricing' },
        { label: 'Audit log', path: '/admin/audit' },
        { label: 'Settings', path: '/admin' },
      ]) {
        // Scoped to <main>: the admin tab bar and the sidebar both have a "Settings" link, and
        // the sidebar's lives outside that landmark.
        await page.getByRole('main').getByRole('link', { name: tab.label, exact: true }).click();
        await expect(page, `${tab.label}`).toHaveURL(new RegExp(`${tab.path}$`), {
          timeout: 30_000,
        });
        await expect(page.getByRole('heading', { name: 'Admin console' })).toBeVisible();
      }
      // Maintenance is deliberately not visited: it manages this deployment's own containers,
      // and a spec that pokes it would be reaching for the machine it is running on.
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('an invitation created in the console lands in the table', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      userId = (await registerUser(sql, page.request, { prefix: 'admin-invite', role: 'admin' }))
        .userId;

      await page.goto('/admin/users');
      await expect(page.getByRole('heading', { name: 'Invitations' })).toBeVisible({
        timeout: 30_000,
      });

      // Scoped to THIS admin, not the whole table. A global count is a shared counter: the
      // helper seeds an invite per registration, so any other spec starting in this window moves
      // it and the assertion fails on a row this test never touched. `created_by` is the column
      // the teardown below already keys on.
      const before = await sql<{ n: number }[]>`
        select count(*)::int as n from user_invites where created_by = ${userId}
      `;
      await page.getByRole('button', { name: 'Create invitation' }).click();

      // The raw token is shown ONCE and never stored, so the assertion is on the row it created
      // rather than on the link — the same property `hashInviteToken` exists for.
      await expect
        .poll(
          async () => {
            const rows = await sql<{ n: number }[]>`
              select count(*)::int as n from user_invites where created_by = ${userId}
            `;
            return rows[0]!.n;
          },
          { timeout: 10_000 },
        )
        .toBe(before[0]!.n + 1);

      await expect(page.getByText(/copy now/i)).toBeVisible();
    } finally {
      // The invite is unredeemed, so nothing else will reclaim it; it is tied to its creator.
      if (userId) await sql`delete from user_invites where created_by = ${userId}`;
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('the audit log renders for an admin', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      userId = (await registerUser(sql, page.request, { prefix: 'admin-audit', role: 'admin' }))
        .userId;

      await page.goto('/admin/audit');
      await expect(page.getByRole('heading', { name: 'Admin console' })).toBeVisible({
        timeout: 30_000,
      });
      // Read-only on purpose: what the log CONTAINS is this install's history, which a spec must
      // not depend on. That it loads at all is the regression worth catching.
      await expect(page.getByRole('alert')).toHaveCount(0);
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });
});
