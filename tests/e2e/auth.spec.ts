import { expect, test, type APIRequestContext } from '@playwright/test';

const API_BASE = process.env.PLAYWRIGHT_API_BASE ?? 'http://localhost:3001';
const PASSWORD = 'e2e-password-12345';

function uniqueEmail(prefix: string): string {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${stamp}-${rand}@haive-e2e.test`;
}

async function registerViaApi(request: APIRequestContext, email: string): Promise<void> {
  const res = await request.post(`${API_BASE}/auth/register`, {
    data: { email, password: PASSWORD },
  });
  expect(res.status(), `register for ${email} failed: ${await res.text()}`).toBe(201);
}

async function loginViaApi(request: APIRequestContext, email: string): Promise<void> {
  const res = await request.post(`${API_BASE}/auth/login`, {
    data: { email, password: PASSWORD },
  });
  expect(res.status(), `login for ${email} failed: ${await res.text()}`).toBe(200);
}

test.describe('auth', () => {
  test('unauthenticated dashboard redirects to login', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'Sign in to Haive' })).toBeVisible();
  });

  test('register form renders required fields and signin link', async ({ page }) => {
    await page.goto('/register');
    await expect(page.getByRole('heading', { name: 'Create your Haive account' })).toBeVisible();
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create account' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
  });

  test('register sets cookies and dashboard layout renders', async ({ page, context }) => {
    const email = uniqueEmail('register');
    await registerViaApi(page.request, email);

    const cookies = await context.cookies();
    expect(cookies.some((c) => c.name === 'haive_access')).toBe(true);
    expect(cookies.some((c) => c.name === 'haive_refresh')).toBe(true);

    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Manage repositories' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Manage tasks' })).toBeVisible();
  });

  test('logged-in visit to /login redirects to dashboard', async ({ page }) => {
    const email = uniqueEmail('already-in');
    await registerViaApi(page.request, email);

    await page.goto('/login');
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });

  test('register then logout then login returns to dashboard', async ({ page, context }) => {
    const email = uniqueEmail('roundtrip');
    await registerViaApi(page.request, email);

    await context.clearCookies();
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login$/);

    await loginViaApi(page.request, email);

    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });

  test('duplicate register returns 409 conflict', async ({ page }) => {
    const email = uniqueEmail('dupe');
    await registerViaApi(page.request, email);

    const second = await page.request.post(`${API_BASE}/auth/register`, {
      data: { email, password: PASSWORD },
    });
    expect(second.status()).toBe(409);
    const body = (await second.json()) as { error?: string };
    expect(body.error).toMatch(/already registered/i);
  });

  test('wrong password on login returns 401', async ({ page }) => {
    const email = uniqueEmail('wrongpw');
    await registerViaApi(page.request, email);

    const res = await page.request.post(`${API_BASE}/auth/login`, {
      data: { email, password: 'totally-wrong-password' },
    });
    expect(res.status()).toBe(401);
  });
});
