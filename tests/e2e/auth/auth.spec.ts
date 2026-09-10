import { expect, test } from '@playwright/test';
import { cleanupUser, getSql } from '../helpers/db.js';
import { API_BASE, PASSWORD, registerUser, seedInvite, uniqueEmail } from '../helpers/auth.js';

test.describe('auth', () => {
  test('unauthenticated dashboard redirects to login', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'Sign in to Haive' })).toBeVisible();
  });

  // Replaces a test that asserted the register form's fields render. It cannot: registration is
  // `closed` by default, and the page withholds the whole form rather than collecting an email
  // and a password it would then answer 403 to. Asserting the absence is the honest version.
  test('register page offers no form while registration is closed', async ({ page }) => {
    await page.goto('/register');
    await expect(page.getByRole('heading', { name: 'Registration is closed' })).toBeVisible();
    await expect(page.getByLabel('Email')).toHaveCount(0);
    await expect(page.getByLabel('Password')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Create account' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
  });

  // The other half of the same rule: an invite admits its holder whatever the mode says, so the
  // form comes back for a visitor arriving on the link.
  test('register page renders the form for an invited visitor', async ({ page }) => {
    const sql = getSql();
    let inviteId = '';
    try {
      const invite = await seedInvite(sql);
      inviteId = invite.id;

      await page.goto(`/register?invite=${invite.token}`);
      await expect(page.getByRole('heading', { name: 'Create your Haive account' })).toBeVisible();
      await expect(page.getByLabel('Email')).toBeVisible();
      await expect(page.getByLabel('Password')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Create account' })).toBeVisible();
    } finally {
      // Never redeemed, so nothing else will ever reclaim it.
      if (inviteId) await sql`delete from user_invites where id = ${inviteId}`;
      await sql.end({ timeout: 5 });
    }
  });

  test('register sets cookies and dashboard layout renders', async ({ page, context }) => {
    const sql = getSql();
    let userId = '';
    try {
      userId = (await registerUser(sql, page.request, { prefix: 'register' })).userId;

      const cookies = await context.cookies();
      expect(cookies.some((c) => c.name === 'haive_access')).toBe(true);
      expect(cookies.some((c) => c.name === 'haive_refresh')).toBe(true);

      await page.goto('/dashboard');
      await expect(page).toHaveURL(/\/dashboard$/);
      await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('logged-in visit to /login redirects to dashboard', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      userId = (await registerUser(sql, page.request, { prefix: 'already-in' })).userId;

      await page.goto('/login');
      await expect(page).toHaveURL(/\/dashboard$/);
      await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('register then logout then login returns to dashboard', async ({ page, context }) => {
    const sql = getSql();
    let userId = '';
    try {
      const user = await registerUser(sql, page.request, { prefix: 'roundtrip' });
      userId = user.userId;

      await context.clearCookies();
      await page.goto('/dashboard');
      await expect(page).toHaveURL(/\/login$/);

      const res = await page.request.post(`${API_BASE}/auth/login`, {
        data: { email: user.email, password: PASSWORD },
      });
      expect(res.status(), `login for ${user.email} failed: ${await res.text()}`).toBe(200);

      await page.goto('/dashboard');
      await expect(page).toHaveURL(/\/dashboard$/);
      await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  // No invite on the second attempt, and that is the point: the register route checks the email
  // for an existing account BEFORE it validates any invite or consults the registration mode, so
  // a duplicate is still a 409 rather than the 403 a closed instance gives everyone else.
  test('duplicate register returns 409 conflict', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      const user = await registerUser(sql, page.request, { prefix: 'dupe' });
      userId = user.userId;

      const second = await page.request.post(`${API_BASE}/auth/register`, {
        data: { email: user.email, password: PASSWORD },
      });
      expect(second.status()).toBe(409);
      const body = (await second.json()) as { error?: string };
      expect(body.error).toMatch(/already registered/i);
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('wrong password on login returns 401', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      const user = await registerUser(sql, page.request, { prefix: 'wrongpw' });
      userId = user.userId;

      const res = await page.request.post(`${API_BASE}/auth/login`, {
        data: { email: user.email, password: 'totally-wrong-password' },
      });
      expect(res.status()).toBe(401);
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('an unknown email cannot register itself in', async ({ page }) => {
    const res = await page.request.post(`${API_BASE}/auth/register`, {
      data: { email: uniqueEmail('uninvited'), password: PASSWORD },
    });
    expect(res.status(), 'registration is closed without an invite').toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error ?? '').toMatch(/closed/i);
  });
});
