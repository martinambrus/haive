import { expect, test } from '@playwright/test';
import { cleanupUser, getSql } from '../helpers/db.js';
import { API_BASE, PASSWORD, registerUser, seedInvite, uniqueEmail } from '../helpers/auth.js';

/**
 * The register form is only reachable on an invitation link now — the page withholds it entirely
 * while registration is closed — so every spec here that drives that form arrives at
 * `/register?invite=<token>`. The login form is unaffected.
 *
 * Inline errors are asserted through `role="alert"` rather than by their copy: the banner is a
 * live region, which is both the accessible behaviour and the durable selector.
 */
test.describe('auth forms (UI submission)', () => {
  test('register form: fill, submit, redirected to dashboard with cookies', async ({
    page,
    context,
  }) => {
    const sql = getSql();
    let userId = '';
    try {
      const invite = await seedInvite(sql);
      const email = uniqueEmail('reg-ui');

      await page.goto(`/register?invite=${invite.token}`);
      await expect(page.getByRole('heading', { name: 'Create your Haive account' })).toBeVisible();

      await page.getByLabel('Email').fill(email);
      await page.getByLabel('Password').fill(PASSWORD);
      await page.getByRole('button', { name: 'Create account' }).click();

      await page.waitForURL(/\/dashboard$/, { timeout: 10_000 });
      await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();

      const cookies = await context.cookies();
      expect(cookies.some((c) => c.name === 'haive_access')).toBe(true);
      expect(cookies.some((c) => c.name === 'haive_refresh')).toBe(true);

      const meRes = await page.request.get(`${API_BASE}/auth/me`);
      expect(meRes.status()).toBe(200);
      userId = ((await meRes.json()) as { user: { id: string } }).user.id;
      expect(userId).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      // The invite was redeemed by the registration, so cleanupUser takes it with the user.
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('register form: duplicate email shows inline API error', async ({ page, playwright }) => {
    const sql = getSql();
    let userId = '';
    let inviteId = '';
    const ctx = await playwright.request.newContext();
    try {
      const user = await registerUser(sql, ctx, { prefix: 'reg-dupe-ui' });
      userId = user.userId;

      // A second invite, because the FORM needs one to render at all. It stays unredeemed: the
      // route rejects the duplicate email before it ever looks at the invite.
      const invite = await seedInvite(sql);
      inviteId = invite.id;

      await page.goto(`/register?invite=${invite.token}`);
      await page.getByLabel('Email').fill(user.email);
      await page.getByLabel('Password').fill(PASSWORD);
      await page.getByRole('button', { name: 'Create account' }).click();

      await expect(page.getByRole('alert')).toContainText('Email already registered');
      expect(page.url()).toContain('/register');
    } finally {
      if (inviteId) await sql`delete from user_invites where id = ${inviteId}`;
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
      await ctx.dispose();
    }
  });

  test('login form: register via API, then sign in via form, redirected to dashboard', async ({
    page,
    playwright,
  }) => {
    const sql = getSql();
    let userId = '';
    const ctx = await playwright.request.newContext();
    try {
      const user = await registerUser(sql, ctx, { prefix: 'login-ui' });
      userId = user.userId;

      await page.goto('/login');
      await expect(page.getByRole('heading', { name: 'Sign in to Haive' })).toBeVisible();

      await page.getByLabel('Email').fill(user.email);
      await page.getByLabel('Password').fill(PASSWORD);
      await page.getByRole('button', { name: 'Sign in' }).click();

      await page.waitForURL(/\/dashboard$/, { timeout: 10_000 });
      await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
      await ctx.dispose();
    }
  });

  test('login form: wrong password shows inline error, stays on /login', async ({
    page,
    playwright,
  }) => {
    const sql = getSql();
    let userId = '';
    const ctx = await playwright.request.newContext();
    try {
      const user = await registerUser(sql, ctx, { prefix: 'login-wrong' });
      userId = user.userId;

      await page.goto('/login');
      await page.getByLabel('Email').fill(user.email);
      await page.getByLabel('Password').fill('totally-wrong-password');
      await page.getByRole('button', { name: 'Sign in' }).click();

      await expect(page.getByRole('alert')).toContainText(/invalid credentials/i);
      expect(page.url()).toMatch(/\/login$/);

      // The failure did not break the account: the right password still works.
      const ok = await ctx.post(`${API_BASE}/auth/login`, {
        data: { email: user.email, password: PASSWORD },
      });
      expect(ok.status()).toBe(200);
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
      await ctx.dispose();
    }
  });
});
