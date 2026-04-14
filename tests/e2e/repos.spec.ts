import { expect, test, type APIRequestContext } from '@playwright/test';
import {
  cleanupRepoFixture,
  cleanupUser,
  getSql,
  seedRepoFixture,
  type RepoFixture,
} from './helpers/db.js';

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

test.describe('repositories', () => {
  test('GET /repos requires auth', async ({ request }) => {
    const res = await request.get(`${API_BASE}/repos`);
    expect(res.status()).toBe(401);
  });

  test('fresh user sees empty repos list and UI empty state', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('repos-empty');
      userId = await registerAndGetUserId(page.request, email);

      const listRes = await page.request.get(`${API_BASE}/repos`);
      expect(listRes.status()).toBe(200);
      const body = (await listRes.json()) as { repositories: unknown[] };
      expect(body.repositories).toEqual([]);

      await page.goto('/repos');
      await expect(page.getByRole('heading', { level: 1, name: 'Repositories' })).toBeVisible();
      await expect(page.getByText('No repositories yet')).toBeVisible();
      await expect(page.getByRole('link', { name: 'Add repository' }).first()).toBeVisible();
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('POST /repos rejects local path outside filesystem root', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('repos-outside');
      userId = await registerAndGetUserId(page.request, email);

      const res = await page.request.post(`${API_BASE}/repos`, {
        data: {
          name: 'bogus',
          source: 'local_path',
          localPath: '/etc/passwd',
        },
      });
      expect(res.status()).toBe(403);
      const body = (await res.json()) as { error?: string };
      expect(body.error ?? '').toMatch(/outside/i);
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('POST /repos rejects nonexistent local path', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('repos-missing');
      userId = await registerAndGetUserId(page.request, email);

      const res = await page.request.post(`${API_BASE}/repos`, {
        data: {
          name: 'bogus',
          source: 'local_path',
          localPath: '/host-fs/__e2e_definitely_does_not_exist',
        },
      });
      expect(res.status()).toBe(404);
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('POST /repos rejects existing non-git path', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('repos-nogit');
      userId = await registerAndGetUserId(page.request, email);

      const res = await page.request.post(`${API_BASE}/repos`, {
        data: {
          name: 'bogus',
          source: 'local_path',
          localPath: '/host-fs',
        },
      });
      expect(res.status()).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error ?? '').toMatch(/git/i);
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('GET /filesystem lists root and rejects outside paths', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('fs');
      userId = await registerAndGetUserId(page.request, email);

      const rootRes = await page.request.get(`${API_BASE}/filesystem`);
      expect(rootRes.status()).toBe(200);
      const rootBody = (await rootRes.json()) as {
        path: string;
        entries: Array<{ name: string; isDirectory: boolean }>;
      };
      expect(rootBody.path.length).toBeGreaterThan(0);
      expect(Array.isArray(rootBody.entries)).toBe(true);

      const outsideRes = await page.request.get(`${API_BASE}/filesystem?path=/etc`);
      expect(outsideRes.status()).toBe(403);
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('UI shows seeded repo and delete removes it', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    let fixture: RepoFixture | null = null;
    try {
      const email = uniqueEmail('repos-seeded');
      userId = await registerAndGetUserId(page.request, email);
      fixture = await seedRepoFixture(sql, userId, 'ui-list');

      page.on('dialog', (d) => {
        void d.accept();
      });

      await page.goto('/repos');
      await expect(page.getByRole('heading', { level: 2, name: fixture.name })).toBeVisible();

      await page.getByRole('button', { name: 'Delete' }).click();

      const deadline = Date.now() + 10_000;
      let gone = false;
      while (Date.now() < deadline) {
        const rows = await sql<{ id: string }[]>`
          select id from repositories where id = ${fixture.repoId}
        `;
        if (rows.length === 0) {
          gone = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(gone, 'repo row should be deleted').toBe(true);

      await expect(page.getByText('No repositories yet')).toBeVisible({
        timeout: 10_000,
      });
    } finally {
      if (fixture) await cleanupRepoFixture(sql, fixture.repoId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });
});
