import { expect, test } from '@playwright/test';
import {
  cleanupRepoFixture,
  cleanupUser,
  getSql,
  seedRepoFixture,
  type RepoFixture,
} from '../helpers/db.js';
import { API_BASE, registerUser, uniqueEmail } from '../helpers/auth.js';
import { invokeAction } from '../helpers/actions.js';

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
      userId = (await registerUser(sql, page.request, { email })).userId;

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
      userId = (await registerUser(sql, page.request, { email })).userId;

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
      userId = (await registerUser(sql, page.request, { email })).userId;

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
      userId = (await registerUser(sql, page.request, { email })).userId;

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
      userId = (await registerUser(sql, page.request, { email })).userId;

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
      userId = (await registerUser(sql, page.request, { email })).userId;
      fixture = await seedRepoFixture(sql, userId, 'ui-list');

      page.on('dialog', (d) => {
        void d.accept();
      });

      await page.goto('/repos');
      await expect(page.getByRole('heading', { level: 2, name: fixture.name })).toBeVisible();

      // Delete moved behind the row's "Actions" menu when repos gained more than one action, so
      // it is a role="menuitem" now and a plain button query finds nothing. The spec registers
      // its own user, so this list holds exactly the one repository it seeded — asserted rather
      // than assumed, because that is what makes the unscoped trigger unambiguous.
      await expect(page.getByRole('button', { name: 'Actions', exact: true })).toHaveCount(1);
      await invokeAction(page, 'Delete');

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
