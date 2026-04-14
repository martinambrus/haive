import { expect, test } from '@playwright/test';

const API_BASE = process.env.PLAYWRIGHT_API_BASE ?? 'http://localhost:3001';
const FAKE_UUID = '00000000-0000-4000-8000-000000000000';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

interface ApiRoute {
  method: Method;
  path: string;
  body?: Record<string, unknown>;
}

const PROTECTED_API_ROUTES: ApiRoute[] = [
  { method: 'GET', path: '/auth/me' },
  { method: 'POST', path: '/auth/logout' },

  { method: 'GET', path: '/cli-providers' },
  { method: 'POST', path: '/cli-providers', body: {} },
  { method: 'GET', path: `/cli-providers/${FAKE_UUID}` },
  { method: 'PATCH', path: `/cli-providers/${FAKE_UUID}`, body: {} },
  { method: 'DELETE', path: `/cli-providers/${FAKE_UUID}` },
  { method: 'GET', path: `/cli-providers/${FAKE_UUID}/secrets` },
  { method: 'POST', path: `/cli-providers/${FAKE_UUID}/secrets`, body: {} },
  {
    method: 'DELETE',
    path: `/cli-providers/${FAKE_UUID}/secrets/SOME_KEY`,
  },

  { method: 'GET', path: '/repos' },
  { method: 'POST', path: '/repos', body: {} },
  { method: 'GET', path: `/repos/${FAKE_UUID}` },
  { method: 'DELETE', path: `/repos/${FAKE_UUID}` },
  { method: 'POST', path: `/repos/${FAKE_UUID}/refresh-tree` },

  { method: 'GET', path: '/repo-credentials' },
  { method: 'POST', path: '/repo-credentials', body: {} },
  { method: 'DELETE', path: `/repo-credentials/${FAKE_UUID}` },

  { method: 'GET', path: '/filesystem' },
  { method: 'POST', path: '/filesystem/validate-git', body: { path: '/host-fs' } },

  { method: 'GET', path: '/tasks' },
  { method: 'POST', path: '/tasks', body: {} },
  { method: 'GET', path: `/tasks/${FAKE_UUID}` },
  { method: 'GET', path: `/tasks/${FAKE_UUID}/steps` },
  { method: 'GET', path: `/tasks/${FAKE_UUID}/events` },
  { method: 'POST', path: `/tasks/${FAKE_UUID}/action`, body: { action: 'cancel' } },
  {
    method: 'POST',
    path: `/tasks/${FAKE_UUID}/steps/some-step/submit`,
    body: { values: {} },
  },
  {
    method: 'POST',
    path: `/tasks/${FAKE_UUID}/steps/some-step/action`,
    body: { action: 'retry' },
  },
];

const PUBLIC_API_ROUTES: ApiRoute[] = [
  { method: 'GET', path: '/health' },
  { method: 'GET', path: '/cli-providers/catalog' },
];

const PROTECTED_WEB_PATHS = [
  '/dashboard',
  '/tasks',
  '/tasks/new',
  `/tasks/${FAKE_UUID}`,
  '/repos',
  '/repos/new',
  '/settings/cli-providers',
  '/settings/cli-providers/new?name=claude-code',
  `/settings/cli-providers/${FAKE_UUID}`,
];

test.describe('auth guard sweep', () => {
  test('every protected API route returns 401 without auth cookies', async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    try {
      for (const route of PROTECTED_API_ROUTES) {
        const url = `${API_BASE}${route.path}`;
        const res = await ctx.fetch(url, {
          method: route.method,
          ...(route.body ? { data: route.body } : {}),
        });
        expect(
          res.status(),
          `${route.method} ${route.path} should be 401, got ${res.status()}`,
        ).toBe(401);
      }
    } finally {
      await ctx.dispose();
    }
  });

  test('public API routes stay reachable without auth cookies', async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    try {
      for (const route of PUBLIC_API_ROUTES) {
        const res = await ctx.fetch(`${API_BASE}${route.path}`, {
          method: route.method,
        });
        expect(
          res.status(),
          `${route.method} ${route.path} should be 200, got ${res.status()}`,
        ).toBe(200);
      }
    } finally {
      await ctx.dispose();
    }
  });

  test('every protected web page redirects to /login without cookies', async ({
    page,
    context,
  }) => {
    await context.clearCookies();
    for (const path of PROTECTED_WEB_PATHS) {
      await page.goto(path);
      await expect(page, `visiting ${path} should redirect to /login`).toHaveURL(/\/login(\?|$)/);
    }
  });
});
