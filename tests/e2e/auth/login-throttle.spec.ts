import { expect, test } from '@playwright/test';
import { cleanupUser, getSql } from '../helpers/db.js';
import { API_BASE, loginUser, registerUser, uniqueEmail } from '../helpers/auth.js';

/**
 * The sign-in throttle (api lib/auth-throttle.ts) keys on the ACCOUNT: the email's blind index, 10
 * failed attempts per 60 s (a success is refunded). Its address bucket is not counted for a private
 * peer, and CI reaches the api as the Docker bridge gateway; there is no global bucket. It runs
 * after body validation and before any user lookup, so an email that was never registered is a
 * bucket nobody else shares: exhausting it cannot lock out another spec's sign-in, on a run or on a
 * retry, because `uniqueEmail` gives each of them its own.
 */
test.describe('sign-in throttle', () => {
  test('the 11th failed sign-in for one account is refused and no other account is', async ({
    page,
    playwright,
  }) => {
    const sql = getSql();
    const ctx = await playwright.request.newContext();
    let userId = '';
    try {
      // Registered first, on a context of its own: the install has an account before /login is
      // asked for (without one the page sends a visitor to /setup), and the page keeps no session.
      const other = await registerUser(sql, ctx, { prefix: 'throttle-other' });
      userId = other.userId;

      // Loaded BEFORE the first attempt opens the 60 s window, so the form's submit below lands
      // seconds after the eleventh attempt and not after a route compile.
      await page.goto('/login');
      await expect(page.getByRole('heading', { name: 'Sign in to Haive' })).toBeVisible();

      // Never registered, and a fresh one on every run and retry.
      const email = uniqueEmail('throttle');
      const attempt = () =>
        page.request.post(`${API_BASE}/auth/login`, {
          data: { email, password: 'totally-wrong-password' },
        });

      for (let i = 1; i <= 10; i += 1) {
        expect((await attempt()).status(), `attempt ${i}`).toBe(401);
      }

      const refused = await attempt();
      expect(refused.status(), 'attempt 11').toBe(429);
      const retryAfter = refused.headers()['retry-after'] ?? '';
      expect(retryAfter, 'Retry-After header').toMatch(/^\d+$/);
      expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
      expect(Number(retryAfter)).toBeLessThanOrEqual(60);
      const body = (await refused.json()) as {
        error: string;
        code: string;
        retryAfterSeconds: number;
      };
      expect(body.code).toBe('rate_limited');
      expect(body.error).toMatch(/Too many sign-in attempts/);
      expect(body.retryAfterSeconds).toBe(Number(retryAfter));

      // Another account is unaffected: its own bucket, and the reason this spec cannot break the
      // sign-ins of the specs around it.
      await loginUser(ctx, other.email);

      // The form says so, in the words the api chose.
      await page.getByLabel('Email', { exact: true }).fill(email);
      await page.getByLabel('Password', { exact: true }).fill('totally-wrong-password');
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page.getByRole('main').getByRole('alert')).toContainText(
        /Too many sign-in attempts/,
      );
      await expect(page).toHaveURL(/\/login$/);
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
      await ctx.dispose();
    }
  });
});
