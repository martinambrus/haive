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

async function loginAndGetUserId(request: APIRequestContext, email: string): Promise<string> {
  const res = await request.post(`${API_BASE}/auth/login`, {
    data: { email, password: PASSWORD },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { user: { id: string } };
  return body.user.id;
}

test.describe('auth forms (UI submission)', () => {
  test('register form: fill, submit, redirected to dashboard with cookies', async ({
    page,
    context,
    playwright,
  }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('reg-ui');

      await page.goto('/register');
      await expect(page.getByRole('heading', { name: 'Create your Haive account' })).toBeVisible();

      await page.getByLabel('Email').fill(email);
      await page.getByLabel('Password').fill(PASSWORD);
      await page.getByRole('button', { name: 'Create account' }).click();

      await page.waitForURL(/\/dashboard$/, { timeout: 10_000 });
      await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();

      const cookies = await context.cookies();
      expect(cookies.some((c) => c.name === 'haive_access')).toBe(true);
      expect(cookies.some((c) => c.name === 'haive_refresh')).toBe(true);

      // look up the created user via /auth/me for cleanup
      const meRes = await page.request.get(`${API_BASE}/auth/me`);
      expect(meRes.status()).toBe(200);
      userId = ((await meRes.json()) as { user: { id: string } }).user.id;
      expect(userId).toMatch(/^[0-9a-f-]{36}$/);
      // unused but required by TS strict
      void playwright;
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('register form: duplicate email shows inline API error', async ({ page, playwright }) => {
    const sql = getSql();
    let userId = '';
    const ctx = await playwright.request.newContext();
    try {
      const email = uniqueEmail('reg-dupe-ui');
      userId = await registerAndGetUserId(ctx, email);

      await page.goto('/register');
      await page.getByLabel('Email').fill(email);
      await page.getByLabel('Password').fill(PASSWORD);
      await page.getByRole('button', { name: 'Create account' }).click();

      await expect(page.getByText('Email already registered', { exact: true })).toBeVisible();
      expect(page.url()).toMatch(/\/register$/);
    } finally {
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
      const email = uniqueEmail('login-ui');
      userId = await registerAndGetUserId(ctx, email);

      await page.goto('/login');
      await expect(page.getByRole('heading', { name: 'Sign in to Haive' })).toBeVisible();

      await page.getByLabel('Email').fill(email);
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
      const email = uniqueEmail('login-wrong');
      userId = await registerAndGetUserId(ctx, email);

      await page.goto('/login');
      await page.getByLabel('Email').fill(email);
      await page.getByLabel('Password').fill('totally-wrong-password');
      await page.getByRole('button', { name: 'Sign in' }).click();

      await expect(page.getByText(/invalid credentials/i)).toBeVisible();
      expect(page.url()).toMatch(/\/login$/);

      // sanity: login still succeeds with correct password
      const id = await loginAndGetUserId(ctx, email);
      expect(id).toBe(userId);
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
      await ctx.dispose();
    }
  });
});
