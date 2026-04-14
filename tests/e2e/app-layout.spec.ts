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

test.describe('app layout and navigation', () => {
  test('sidebar renders branding, email, and all nav links', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('nav-sidebar');
      userId = await registerAndGetUserId(page.request, email);

      await page.goto('/dashboard');
      await expect(page).toHaveURL(/\/dashboard$/);

      const aside = page.locator('aside');
      await expect(aside.getByRole('heading', { name: 'Haive' })).toBeVisible();
      await expect(aside.getByText('Multi-CLI orchestration')).toBeVisible();
      await expect(aside.getByText(email)).toBeVisible();

      await expect(aside.getByRole('link', { name: 'Dashboard' })).toBeVisible();
      await expect(aside.getByRole('link', { name: 'Tasks' })).toBeVisible();
      await expect(aside.getByRole('link', { name: 'Repositories' })).toBeVisible();
      await expect(aside.getByRole('link', { name: 'Settings' })).toBeVisible();

      await expect(aside.getByRole('button', { name: 'Sign out' })).toBeVisible();
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('sidebar navigation walks through all sections', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('nav-walk');
      userId = await registerAndGetUserId(page.request, email);

      await page.goto('/dashboard');
      const aside = page.locator('aside');

      await aside.getByRole('link', { name: 'Tasks' }).click();
      await expect(page).toHaveURL(/\/tasks$/);
      await expect(page.getByRole('heading', { level: 1, name: 'Tasks' })).toBeVisible();

      await aside.getByRole('link', { name: 'Repositories' }).click();
      await expect(page).toHaveURL(/\/repos$/);
      await expect(page.getByRole('heading', { level: 1, name: 'Repositories' })).toBeVisible();

      await aside.getByRole('link', { name: 'Settings' }).click();
      await expect(page).toHaveURL(/\/settings\/cli-providers$/);
      await expect(page.getByRole('heading', { level: 1, name: 'CLI Providers' })).toBeVisible();

      await aside.getByRole('link', { name: 'Dashboard' }).click();
      await expect(page).toHaveURL(/\/dashboard$/);
      await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('dashboard cards link to /repos and /tasks', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('dash-cards');
      userId = await registerAndGetUserId(page.request, email);

      await page.goto('/dashboard');

      await page.getByRole('button', { name: 'Manage repositories' }).click();
      await expect(page).toHaveURL(/\/repos$/);

      await page.goto('/dashboard');
      await page.getByRole('button', { name: 'Manage tasks' }).click();
      await expect(page).toHaveURL(/\/tasks$/);
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('Sign out button clears session and redirects to /login', async ({ page, context }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('nav-logout');
      userId = await registerAndGetUserId(page.request, email);

      await page.goto('/dashboard');
      await page.locator('aside').getByRole('button', { name: 'Sign out' }).click();

      await expect(page).toHaveURL(/\/login$/, { timeout: 10_000 });

      const cookies = await context.cookies();
      const access = cookies.find((c) => c.name === 'haive_access');
      const refresh = cookies.find((c) => c.name === 'haive_refresh');
      expect(access?.value || '').toBe('');
      expect(refresh?.value || '').toBe('');

      const me = await page.request.get(`${API_BASE}/auth/me`);
      expect(me.status()).toBe(401);
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });
});
