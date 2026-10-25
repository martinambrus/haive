import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const API = 'http://127.0.0.1:46101';
const PASSWORD = 'synthetic-original-password-1';
const NEW_PASSWORD = 'synthetic-replacement-password-2';

async function holdRefresh(context: BrowserContext) {
  let release!: () => void;
  let arrived!: (status: number) => void;
  let completed!: () => void;
  let used = false;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const ready = new Promise<number>((resolve) => (arrived = resolve));
  const finished = new Promise<void>((resolve) => (completed = resolve));
  await context.route(`${API}/auth/refresh`, async (route) => {
    if (used) return route.continue();
    used = true;
    // Node fetch has no browser cookie jar. The real transaction commits now, but replacement
    // headers reach the browser only after release, including when the browser aborts first.
    const response = await fetch(route.request().url(), {
      method: 'POST',
      headers: route.request().headers(),
    });
    arrived(response.status);
    await gate;
    try {
      await route.fulfill({
        status: response.status,
        headers: {
          'content-type': 'application/json',
          'set-cookie': response.headers.getSetCookie().join('\n'),
        },
        body: await response.text(),
      });
    } catch {
      // A red control may have aborted the request before release. The subsequent cookie/API
      // assertion, rather than a route-handler exception, must establish the lost session.
    } finally {
      completed();
    }
  });
  return { release, ready, finished };
}

async function account(page: Page) {
  await page.goto('/settings/account');
  await expect(page.getByRole('button', { name: 'Change password', exact: true })).toBeVisible();
}
async function keepalive(page: Page) {
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
}
async function me(context: BrowserContext) {
  return context.request.get(`${API}/auth/me`);
}
async function invalidCookies(context: BrowserContext) {
  await context.addCookies(
    ['haive_access', 'haive_refresh'].map((name) => ({
      name,
      value: 'retained-invalid',
      domain: '127.0.0.1',
      path: '/',
    })),
  );
}

test.describe('session ordering correction', () => {
  let userId: string;
  test.beforeEach(async ({ context }) => {
    const created = await context.request.post(`${API}/__fixture/session`, { data: {} });
    expect(created.status()).toBe(200);
    userId = ((await created.json()) as { id: string }).id;
  });
  test.afterEach(async ({ context }) => {
    await context.request.post(`${API}/__fixture/registration-mode`, { data: { mode: 'closed' } });
    await context.request.delete(`${API}/__fixture/session/${userId}`);
  });

  test('D1 zero-user setup remains reachable with retained invalid access', async ({
    page,
    context,
  }) => {
    await context.request.delete(`${API}/__fixture/session/${userId}`);
    expect(
      (await (await context.request.get(`${API}/auth/registration-status`)).json()).setupNeeded,
    ).toBe(true);
    await invalidCookies(context);
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Set up Haive', exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/setup$/);
  });

  test('D1 direct invitation preserves its token with retained invalid access', async ({
    page,
    context,
  }) => {
    await invalidCookies(context);
    await page.goto('/register?invite=synthetic-invitation-token');
    await expect(page.getByRole('button', { name: 'Create account', exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/register\?invite=synthetic-invitation-token$/);
  });

  test('D1 public navigation from login to open registration stays usable', async ({
    page,
    context,
  }) => {
    await context.request.post(`${API}/__fixture/registration-mode`, { data: { mode: 'open' } });
    await invalidCookies(context);
    await page.goto('/login?session=expired');
    await page.getByRole('link', { name: 'Create an account', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Create account', exact: true })).toBeVisible();
  });

  test('D2 a committed refresh held beyond five seconds still installs usable cookies', async ({
    page,
    context,
  }) => {
    await context.clearCookies({ name: 'haive_access' });
    const hold = await holdRefresh(context);
    try {
      await page.goto('/settings/account');
      expect(await hold.ready).toBe(200);
      await page.waitForTimeout(5_600);
      await expect(
        page.getByText(
          'Your session check is taking longer than usual. Keep this page open while it finishes.',
          { exact: true },
        ),
      ).toBeVisible();
      hold.release();
      await hold.finished;
      await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible();
      expect((await me(context)).status()).toBe(200);
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible();
      expect((await context.request.post(`${API}/auth/refresh`)).status()).toBe(200);
    } finally {
      hold.release();
    }
  });

  test('F1 logout waits for held refresh and cannot be undone by late headers', async ({
    page,
    context,
  }) => {
    await account(page);
    const other = await context.newPage();
    await account(other);
    const hold = await holdRefresh(context);
    try {
      await keepalive(page);
      expect(await hold.ready).toBe(200);
      await other.getByRole('button', { name: 'Sign out', exact: true }).click();
      await other.waitForTimeout(500);
      hold.release();
      await hold.finished;
      await expect(other.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
      expect((await me(context)).status()).toBe(401);
      expect((await context.request.post(`${API}/auth/refresh`)).status()).toBe(401);
    } finally {
      hold.release();
      await other.close();
    }
  });

  test('F1 a new login wins after an old-account refresh completes', async ({
    page,
    context,
    playwright,
  }) => {
    await account(page);
    const seed = await playwright.request.newContext();
    const created = await seed.post(`${API}/__fixture/session`, { data: {} });
    const second = (await created.json()) as { id: string; email: string };
    const login = await context.newPage();
    await login.goto('/login?session=expired');
    await login.getByLabel('Email').fill(second.email);
    await login.getByLabel('Password', { exact: true }).fill(PASSWORD);
    const hold = await holdRefresh(context);
    try {
      await keepalive(page);
      expect(await hold.ready).toBe(200);
      await login.getByRole('button', { name: 'Sign in', exact: true }).click();
      await login.waitForTimeout(500);
      hold.release();
      await hold.finished;
      await expect.poll(async () => (await (await me(context)).json()).user?.id).toBe(second.id);
      await account(login);
      expect((await (await me(context)).json()).user.id).toBe(second.id);
    } finally {
      hold.release();
      await login.close();
      await seed.delete(`${API}/__fixture/session/${second.id}`);
      await seed.dispose();
    }
  });

  test('F1 registration installs its account after an old-account refresh completes', async ({
    page,
    context,
  }) => {
    await account(page);
    await context.request.post(`${API}/__fixture/registration-mode`, { data: { mode: 'open' } });
    const email = `round2-register-${Date.now()}@fixture.test`;
    const register = await context.newPage();
    await register.goto('/register?session=expired');
    await register.getByLabel('Email').fill(email);
    await register.getByLabel('Password', { exact: true }).fill(PASSWORD);
    const hold = await holdRefresh(context);
    let createdId: string | undefined;
    try {
      await keepalive(page);
      expect(await hold.ready).toBe(200);
      const registered = register.waitForResponse(
        (response) =>
          response.url() === `${API}/auth/register` && response.request().method() === 'POST',
      );
      await register.getByRole('button', { name: 'Create account', exact: true }).click();
      await register.waitForTimeout(500);
      hold.release();
      await hold.finished;
      const response = await registered;
      expect(response.status()).toBe(201);
      createdId = (await response.json()).user.id;
      await expect.poll(async () => (await (await me(context)).json()).user?.email).toBe(email);
      await account(register);
      expect((await (await me(context)).json()).user.email).toBe(email);
    } finally {
      hold.release();
      await register.close();
      if (createdId) await context.request.delete(`${API}/__fixture/session/${createdId}`);
    }
  });

  test('F1 password replacement survives a late pre-change refresh response', async ({
    page,
    context,
  }) => {
    await account(page);
    const other = await context.newPage();
    await account(other);
    await other.getByLabel('Current password', { exact: true }).fill(PASSWORD);
    await other.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
    await other.getByLabel('Confirm new password', { exact: true }).fill(NEW_PASSWORD);
    const hold = await holdRefresh(context);
    try {
      await keepalive(page);
      expect(await hold.ready).toBe(200);
      await other.getByRole('button', { name: 'Change password', exact: true }).click();
      await other.waitForTimeout(500);
      hold.release();
      await hold.finished;
      await expect(
        other.getByText('Password changed. Other devices have been signed out.', { exact: true }),
      ).toBeVisible();
      expect((await me(context)).status()).toBe(200);
      expect((await context.request.post(`${API}/auth/refresh`)).status()).toBe(200);
      await other.reload();
      await expect(other.getByRole('heading', { name: 'Account', exact: true })).toBeVisible();
    } finally {
      hold.release();
      await other.close();
    }
  });

  test('F1 lock acquisition failure does not report sign-out success', async ({
    page,
    context,
  }) => {
    await account(page);
    await page.evaluate(() =>
      Object.defineProperty(navigator.locks, 'request', {
        value: () => Promise.reject(new DOMException('Synthetic lock failure', 'AbortError')),
      }),
    );
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByText('Could not sign out. Try again.', { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/settings\/account$/);
    expect((await me(context)).status()).toBe(200);
  });

  test('F1 native lock acquisition expires without sending a delayed logout', async ({
    page,
    context,
  }) => {
    await account(page);
    const holder = await context.newPage();
    await holder.goto('/login?session=expired');
    await holder.evaluate(() => {
      const state = window as unknown as {
        sessionLockHeld: boolean;
        releaseSessionLock: () => void;
      };
      void navigator.locks.request('haive:session-rotation', async () => {
        state.sessionLockHeld = true;
        await new Promise<void>((resolve) => {
          state.releaseSessionLock = resolve;
        });
      });
    });
    await expect
      .poll(() =>
        holder.evaluate(() => (window as unknown as { sessionLockHeld: boolean }).sessionLockHeld),
      )
      .toBe(true);
    let logoutRequests = 0;
    page.on('request', (request) => {
      if (request.url() === `${API}/auth/logout`) logoutRequests++;
    });
    try {
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(page.getByText('Could not sign out. Try again.', { exact: true })).toBeVisible({
        timeout: 25_000,
      });
      expect(logoutRequests).toBe(0);
      await holder.evaluate(() =>
        (window as unknown as { releaseSessionLock: () => void }).releaseSessionLock(),
      );
      await page.waitForTimeout(200);
      expect(logoutRequests).toBe(0);
      expect((await me(context)).status()).toBe(200);
      await expect(page).toHaveURL(/\/settings\/account$/);
    } finally {
      await holder.close();
    }
  });
});
