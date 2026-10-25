import { expect, test } from '@playwright/test';
const API = 'http://127.0.0.1:46101';

test.describe('browser-owned session recovery', () => {
  let userId: string;
  test.beforeEach(async ({ context }) => {
    const res = await context.request.post(`${API}/__fixture/session`, { data: {} });
    expect(res.status()).toBe(200);
    userId = ((await res.json()) as { id: string }).id;
  });
  test.afterEach(async ({ context }) => {
    await context.request.post(`${API}/__fixture/me-status`, { data: { status: null } });
    await context.request.post(`${API}/__fixture/release-me`);
    await context.request.delete(`${API}/__fixture/session/${userId}`);
  });

  test('returning visitor installs replacement cookies usable on hard navigation and API', async ({
    page,
    context,
  }) => {
    const old = (await context.cookies()).find((c) => c.name === 'haive_refresh')!.value;
    await context.clearCookies({ name: 'haive_access' });
    await page.goto('/settings/account');
    await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible();
    await expect.poll(async () => (await context.request.get(`${API}/auth/me`)).status()).toBe(200);
    expect((await context.cookies()).find((c) => c.name === 'haive_refresh')!.value).not.toBe(old);
    await expect(
      page.getByRole('link', { name: 'Authenticated fixture', exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible();
    expect(
      await page
        .locator('.haive-shell')
        .evaluate((el) => (el as HTMLElement).style.getPropertyValue('--haive-sidebar-w')),
    ).toBe('337px');
  });

  test('two tabs wait for a late winning rotation before reading the shared cookie jar', async ({
    page,
    context,
  }) => {
    await context.clearCookies({ name: 'haive_access' });
    let release!: () => void;
    let arrived!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const ready = new Promise<void>((resolve) => (arrived = resolve));
    let rotations = 0;
    await context.route(`${API}/auth/refresh`, async (route) => {
      rotations++;
      const response = await fetch(route.request().url(), {
        method: 'POST',
        headers: route.request().headers(),
      });
      if (rotations === 1) {
        arrived();
        await gate;
      }
      await route.fulfill({
        status: response.status,
        headers: {
          'content-type': 'application/json',
          'set-cookie': response.headers.getSetCookie().join('\n'),
        },
        body: await response.text(),
      });
    });
    const second = await context.newPage();
    try {
      await page.goto('/settings/account');
      await ready;
      await second.goto('/settings/account');
      await second.waitForTimeout(500);
      release();
      for (const tab of [page, second]) {
        await expect(tab.getByRole('heading', { name: 'Account' })).toBeVisible();
        await tab.reload();
        await expect(tab.getByRole('heading', { name: 'Account' })).toBeVisible();
      }
      expect(rotations).toBe(1);
      expect((await context.request.get(`${API}/auth/me`)).status()).toBe(200);
    } finally {
      release();
      await second.close();
    }
  });

  test('a delayed expired marker cannot delete a newer session', async ({ page, context }) => {
    const before = await context.cookies();
    await page.goto('/login?session=expired');
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible();
    expect(await context.cookies()).toEqual(before);
    expect((await context.request.get(`${API}/auth/me`)).status()).toBe(200);
  });

  test('a late SSR refusal rechecks cookies already rotated by the browser', async ({
    page,
    context,
  }) => {
    await page.goto('/login?session=expired');
    await context.clearCookies({ name: 'haive_access' });
    await context.request.post(`${API}/__fixture/hold-me`);
    const navigation = page.goto('/settings/account');
    await expect
      .poll(
        async () =>
          (
            (await (await context.request.get(`${API}/__fixture/held-me`)).json()) as {
              held: boolean;
            }
          ).held,
      )
      .toBe(true);
    // The API's successful response installs cookies while SSR still holds its old snapshot.
    expect((await context.request.post(`${API}/auth/refresh`)).status()).toBe(200);
    await context.request.post(`${API}/__fixture/release-me`);
    await navigation;
    await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible();
    expect((await context.request.get(`${API}/auth/me`)).status()).toBe(200);
  });

  test('transient upstream failure preserves cookies and offers bounded retry', async ({
    page,
    context,
  }) => {
    const before = await context.cookies();
    await context.request.post(`${API}/__fixture/me-status`, { data: { status: 503 } });
    await page.goto('/settings/account');
    await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
    expect(await context.cookies()).toEqual(before);
    await context.request.post(`${API}/__fixture/me-status`, { data: { status: null } });
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible();
  });

  test('invalid refresh reaches login without cookie deletion or loops', async ({
    page,
    context,
  }) => {
    await context.clearCookies({ name: 'haive_access' });
    await context.addCookies([
      { name: 'haive_refresh', value: 'invalid', domain: '127.0.0.1', path: '/' },
    ]);
    await page.goto('/settings/account');
    await expect(page).toHaveURL(/\/login\?session=expired$/);
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible();
    expect((await context.cookies()).find((c) => c.name === 'haive_refresh')?.value).toBe(
      'invalid',
    );
  });

  test('no cookies reaches login directly', async ({ page, context }) => {
    await context.clearCookies();
    await page.goto('/settings/account');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('a genuinely expired signed access token recovers with the valid refresh token', async ({
    page,
    context,
  }) => {
    await context.request.post(`${API}/__fixture/expire-access/${userId}`);
    expect((await context.request.get(`${API}/auth/me`)).status()).toBe(401);
    await page.goto('/settings/account');
    await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible();
    expect((await context.request.get(`${API}/auth/me`)).status()).toBe(200);
  });

  test('an inconsistent upstream is bounded to one automatic reload', async ({ page, context }) => {
    await context.request.post(`${API}/__fixture/me-status`, { data: { status: 503 } });
    // The browser sees a different upstream from SSR; a successful browser check must not
    // cause endless reloads when the server still cannot authenticate its own requests.
    await context.route(`${API}/auth/me`, (route) =>
      route.fulfill({ status: 200, json: { user: { id: userId } } }),
    );
    let documents = 0;
    page.on('request', (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents++;
    });
    await page.goto('/settings/account');
    await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
    expect(documents).toBe(2);
    await page.waitForTimeout(500);
    expect(documents).toBe(2);
    await expect(page).toHaveURL(/\/settings\/account$/);
  });

  test('a browser network failure offers retry and preserves the shared session', async ({
    page,
    context,
  }) => {
    await context.clearCookies({ name: 'haive_access' });
    const before = await context.cookies();
    await context.route(`${API}/auth/me`, (route) => route.abort('connectionfailed'));
    await page.goto('/settings/account');
    await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
    expect(await context.cookies()).toEqual(before);
    await context.unroute(`${API}/auth/me`);
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible();
  });

  test('recovery reloads role and forced-password guard data from the API', async ({
    page,
    context,
  }) => {
    await context.request.delete(`${API}/__fixture/session/${userId}`);
    const created = await context.request.post(`${API}/__fixture/session`, {
      data: { role: 'admin', mustChangePassword: true },
    });
    userId = ((await created.json()) as { id: string }).id;
    await context.clearCookies({ name: 'haive_access' });
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/settings\/account$/);
    await expect(
      page.getByText('Choose a new password to continue.', { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Admin', exact: true })).toBeVisible();
    expect(
      (
        (await (await context.request.get(`${API}/auth/me`)).json()) as {
          user: { role: string; mustChangePassword: boolean };
        }
      ).user,
    ).toMatchObject({ role: 'admin', mustChangePassword: true });
  });
});
