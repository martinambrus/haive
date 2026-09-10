import { expect, test } from '@playwright/test';
import { cleanupUser, getSql } from '../helpers/db.js';
import { API_BASE, registerUser, uniqueEmail } from '../helpers/auth.js';

test.describe('app layout and navigation', () => {
  test('sidebar renders branding, email, and all nav links', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('nav-sidebar');
      userId = (await registerUser(sql, page.request, { email })).userId;

      await page.goto('/dashboard');
      await expect(page).toHaveURL(/\/dashboard$/);

      const aside = page.locator('aside');
      await expect(aside.getByRole('heading', { name: 'Haive' })).toBeVisible();
      await expect(aside.getByText('Multi-CLI orchestration')).toBeVisible();
      await expect(aside.getByText(email)).toBeVisible();

      await expect(aside.getByRole('link', { name: 'Dashboard' })).toBeVisible();
      await expect(aside.getByRole('link', { name: 'Tasks' })).toBeVisible();
      await expect(aside.getByRole('link', { name: 'Repositories' })).toBeVisible();
      await expect(aside.getByRole('link', { name: 'CLI Providers' })).toBeVisible();
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
      userId = (await registerUser(sql, page.request, { email })).userId;

      await page.goto('/dashboard');
      const aside = page.locator('aside');

      await aside.getByRole('link', { name: 'Tasks' }).click();
      await expect(page).toHaveURL(/\/tasks$/);
      await expect(page.getByRole('heading', { level: 1, name: 'Tasks' })).toBeVisible();

      await aside.getByRole('link', { name: 'Repositories' }).click();
      await expect(page).toHaveURL(/\/repos$/);
      await expect(page.getByRole('heading', { level: 1, name: 'Repositories' })).toBeVisible();

      await aside.getByRole('link', { name: 'CLI Providers' }).click();
      await expect(page).toHaveURL(/\/cli-providers$/);
      await expect(page.getByRole('heading', { level: 1, name: 'CLI Providers' })).toBeVisible();

      await aside.getByRole('link', { name: 'Settings' }).click();
      await expect(page).toHaveURL(/\/settings\/account$/);
      await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();

      // Settings links to one tab but owns the whole section, so it must stay lit on the other
      // six. Asserted on a tab that is NOT the link target, which is the case that regressed.
      await page.getByRole('link', { name: 'Editor' }).click();
      await expect(page).toHaveURL(/\/settings\/ide$/);
      await expect(aside.getByRole('link', { name: 'Settings' })).toHaveClass(/bg-indigo-950/);

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
      userId = (await registerUser(sql, page.request, { email })).userId;

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
      userId = (await registerUser(sql, page.request, { email })).userId;

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
