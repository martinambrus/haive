import { expect, test } from '@playwright/test';
import { cleanupUser, getSql } from '../helpers/db.js';
import { API_BASE, PASSWORD, registerUser, uniqueEmail } from '../helpers/auth.js';

/**
 * A user holding a password an administrator minted (`POST /admin/users` sets
 * `must_change_password`): they are held on the password form, the shell around it stays quiet
 * while they are, and after the change the shell works again WITHOUT a reload. One test, because
 * every step starts from what the one before it left: a user is flagged once and unflagged once.
 *
 * The shell polls the api's origin, not the page's, so what it sends is collected by origin and
 * path on the page's `request` event rather than read off a response.
 */

const API_ORIGIN = new URL(API_BASE).origin;

/** The paths of the shell's periodic requests: the sidebar and notification task feeds, the
 *  notification settings, the usage window and the system state. */
const SHELL_POLL_PATHS = new Set([
  '/tasks',
  '/user-settings/notifications',
  '/usage-window',
  '/system/state',
]);

/** A collected `METHOD pathname+search` entry that is a GET of the task feed carrying `key=value`.
 *  The feeds are told apart by what identifies them, not by the page size they ask for. */
function isTaskFeed(entry: string, key: string, value: string): boolean {
  const [method, target = ''] = entry.split(' ');
  const url = new URL(target, API_ORIGIN);
  return method === 'GET' && url.pathname === '/tasks' && url.searchParams.get(key) === value;
}
const isSidebarFeed = (entry: string) => isTaskFeed(entry, 'status', 'unfinished');
const isNotificationFeed = (entry: string) => isTaskFeed(entry, 'sort', 'updated');

test.describe('forced password change', () => {
  test('a user holding a minted password', async ({ page, playwright }) => {
    // The quiet window alone is 16 s, and under `next dev` the first visit to a route compiles it.
    test.setTimeout(120_000);
    const sql = getSql();
    // The administrator gets its own context, so the page's cookie jar holds only the minted user.
    const adminApi = await playwright.request.newContext();
    let adminId = '';
    let userId = '';
    try {
      adminId = (await registerUser(sql, adminApi, { prefix: 'forced-admin', role: 'admin' }))
        .userId;
      const email = uniqueEmail('forced');
      const minted = await adminApi.post(`${API_BASE}/admin/users`, {
        data: { email, role: 'user' },
      });
      expect(minted.status(), `minting ${email} failed: ${await minted.text()}`).toBe(201);
      const { user, temporaryPassword } = (await minted.json()) as {
        user: { id: string };
        temporaryPassword: string;
      };
      userId = user.id;

      // Attached before the first navigation, so nothing the page sends to the api goes unseen.
      const collected: string[] = [];
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.origin === API_ORIGIN && SHELL_POLL_PATHS.has(url.pathname)) {
          collected.push(`${request.method()} ${url.pathname}${url.search}`);
        }
      });

      const settle = { timeout: 30_000 };
      const banner = page
        .getByRole('status')
        .filter({ hasText: 'Choose a new password to continue.' });
      const currentPassword = page.getByLabel('Current password', { exact: true });
      const newPassword = page.getByLabel('New password', { exact: true });
      const confirmPassword = page.getByLabel('Confirm new password', { exact: true });
      const changePassword = page.getByRole('button', { name: 'Change password', exact: true });
      const profile = page.getByRole('heading', { name: 'Profile', exact: true });
      const profileEmail = page.getByLabel('Email', { exact: true });
      const passwordError = page.getByRole('main').getByRole('alert');

      // Signing in with the minted password lands on the one page it is allowed to be on.
      await page.goto('/login');
      await expect(page.getByRole('heading', { name: 'Sign in to Haive' })).toBeVisible();
      await page.getByLabel('Email', { exact: true }).fill(email);
      await page.getByLabel('Password', { exact: true }).fill(temporaryPassword);
      await page.getByRole('button', { name: 'Sign in' }).click();

      await expect(page).toHaveURL(/\/settings\/account$/, settle);
      await expect(banner).toBeVisible(settle);
      await expect(currentPassword).toBeVisible(settle);
      // Only after the Password card is up: it renders once the account read has been refused, so
      // an absent Profile card is the page's decision and not a page that has not loaded yet.
      await expect(profileEmail).toHaveCount(0);
      await expect(profile).toHaveCount(0);

      // Asking for any other page turns them back to it.
      await page.goto('/dashboard');
      await expect(page).toHaveURL(/\/settings\/account$/, settle);
      await expect(currentPassword).toBeVisible(settle);

      // A fixed wait, on purpose: that a periodic request is NOT sent can only be seen by waiting
      // longer than its period, and there is no event to wait for. 16 s clears the slowest tick
      // the shell has apart from the usage window, /system/state at 15 s; the usage window's 60 s
      // tick is covered by its request on mount, which the collector, attached before sign-in,
      // records too. Done before the direct api calls below, so the window holds only the page.
      await page.waitForTimeout(16_000);
      expect(collected, 'the shell polled the api while the password must change').toEqual([]);

      // The api enforces it too; everything above is only the page's manners.
      const refused = await page.request.get(`${API_BASE}/tasks`);
      expect(refused.status()).toBe(403);
      expect(((await refused.json()) as { code?: string }).code).toBe('must_change_password');
      const flagged = await page.request.get(`${API_BASE}/auth/me`);
      expect(flagged.status()).toBe(200);
      expect(
        ((await flagged.json()) as { user: { mustChangePassword: boolean } }).user
          .mustChangePassword,
      ).toBe(true);

      // "Changing" it to itself is refused, or the minted secret would stay in place.
      await currentPassword.fill(temporaryPassword);
      await newPassword.fill(temporaryPassword);
      await confirmPassword.fill(temporaryPassword);
      await changePassword.click();
      await expect(passwordError).toContainText(
        'Choose a password different from the one you were given',
        settle,
      );
      await expect(banner).toBeVisible();

      // A full page load would clear this: it is how the end of the test knows there was none.
      await page.evaluate(() => {
        (window as unknown as { __e2eNoReload: boolean }).__e2eNoReload = true;
      });
      await currentPassword.fill(temporaryPassword);
      await newPassword.fill(PASSWORD);
      await confirmPassword.fill(PASSWORD);
      await changePassword.click();
      await expect(
        page.getByText('Password changed. Other devices have been signed out.', { exact: true }),
      ).toBeVisible(settle);
      await expect(banner).toHaveCount(0, settle);
      await expect(profile).toBeVisible(settle);
      await expect(profileEmail).toHaveValue(email, settle);

      // The shell is back: both task feeds are requested again, and the sidebar's again after its
      // interval, so one request that slipped out as it mounted would not pass for polling.
      await expect.poll(() => collected.some(isSidebarFeed), { timeout: 20_000 }).toBe(true);
      await expect.poll(() => collected.some(isNotificationFeed), { timeout: 20_000 }).toBe(true);
      await expect
        .poll(() => collected.filter(isSidebarFeed).length, { timeout: 20_000 })
        .toBeGreaterThanOrEqual(2);
      await expect(page.locator('aside')).toContainText('No active tasks', { timeout: 20_000 });
      expect(
        await page.evaluate(() => (window as unknown as { __e2eNoReload?: boolean }).__e2eNoReload),
        'the page was reloaded rather than refreshed',
      ).toBe(true);

      // And the user is not locked out: the guard lets them go where they like.
      await page.locator('aside').getByRole('link', { name: 'Dashboard', exact: true }).click();
      await expect(page).toHaveURL(/\/dashboard$/, settle);
      await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible(settle);
      const cleared = await page.request.get(`${API_BASE}/auth/me`);
      expect(cleared.status()).toBe(200);
      expect(
        ((await cleared.json()) as { user: { mustChangePassword: boolean } }).user
          .mustChangePassword,
      ).toBe(false);
      expect((await page.request.get(`${API_BASE}/tasks`)).status()).toBe(200);
    } finally {
      if (userId) await cleanupUser(sql, userId);
      if (adminId) await cleanupUser(sql, adminId);
      await sql.end({ timeout: 5 });
      await adminApi.dispose();
    }
  });
});
