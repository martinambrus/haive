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
const FAKE_UUID = '00000000-0000-4000-8000-000000000000';

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

interface FsEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  hasGit: boolean;
  hidden: boolean;
}

async function findFirstGitDir(request: APIRequestContext): Promise<FsEntry | null> {
  const res = await request.get(`${API_BASE}/filesystem`);
  expect(res.status()).toBe(200);
  const listing = (await res.json()) as { entries: FsEntry[] };
  return listing.entries.find((e) => e.isDirectory && e.hasGit) ?? null;
}

async function findFirstNonGitDir(request: APIRequestContext): Promise<FsEntry | null> {
  const res = await request.get(`${API_BASE}/filesystem`);
  expect(res.status()).toBe(200);
  const listing = (await res.json()) as { entries: FsEntry[] };
  return listing.entries.find((e) => e.isDirectory && !e.hasGit && !e.hidden) ?? null;
}

test.describe('misc routes', () => {
  test('GET /health is public and returns ok payload', async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    try {
      const res = await ctx.get(`${API_BASE}/health`);
      expect(res.status()).toBe(200);
      const body = (await res.json()) as { status: string; service: string };
      expect(body.status).toBe('ok');
      expect(body.service).toBe('haive-api');
    } finally {
      await ctx.dispose();
    }
  });

  test('CORS preflight reflects allowed origin and credentials', async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    try {
      const webOrigin = process.env.PLAYWRIGHT_WEB_ORIGIN ?? 'http://localhost:3000';
      const res = await ctx.fetch(`${API_BASE}/auth/me`, {
        method: 'OPTIONS',
        headers: {
          Origin: webOrigin,
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'content-type',
        },
      });
      expect([200, 204]).toContain(res.status());
      expect(res.headers()['access-control-allow-origin']).toBe(webOrigin);
      expect(res.headers()['access-control-allow-credentials']).toBe('true');
    } finally {
      await ctx.dispose();
    }
  });

  test('POST /filesystem/validate-git returns valid=true for a git directory', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('vg-ok');
      userId = await registerAndGetUserId(page.request, email);

      const gitDir = await findFirstGitDir(page.request);
      test.skip(!gitDir, 'no git directory under filesystem root');

      const res = await page.request.post(`${API_BASE}/filesystem/validate-git`, {
        data: { path: gitDir!.path },
      });
      expect(res.status()).toBe(200);
      const body = (await res.json()) as { valid: boolean; path: string };
      expect(body.valid).toBe(true);
      expect(body.path).toBe(gitDir!.path);
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('POST /filesystem/validate-git returns valid=false for non-git dir', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('vg-no');
      userId = await registerAndGetUserId(page.request, email);

      const nonGit = await findFirstNonGitDir(page.request);
      test.skip(!nonGit, 'no non-git directory under filesystem root');

      const res = await page.request.post(`${API_BASE}/filesystem/validate-git`, {
        data: { path: nonGit!.path },
      });
      expect(res.status()).toBe(200);
      const body = (await res.json()) as { valid: boolean };
      expect(body.valid).toBe(false);
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('POST /filesystem/validate-git rejects path outside filesystem root', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('vg-escape');
      userId = await registerAndGetUserId(page.request, email);

      const res = await page.request.post(`${API_BASE}/filesystem/validate-git`, {
        data: { path: '/etc' },
      });
      expect(res.status()).toBe(403);
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('POST /filesystem/validate-git requires auth', async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    try {
      const res = await ctx.post(`${API_BASE}/filesystem/validate-git`, {
        data: { path: '/host-fs' },
      });
      expect(res.status()).toBe(401);
    } finally {
      await ctx.dispose();
    }
  });

  test('POST /repos/:id/refresh-tree flips status back to cloning', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    let fixture: RepoFixture | null = null;
    try {
      const email = uniqueEmail('refresh');
      userId = await registerAndGetUserId(page.request, email);
      fixture = await seedRepoFixture(sql, userId, 'refresh');

      const res = await page.request.post(`${API_BASE}/repos/${fixture.repoId}/refresh-tree`);
      expect(res.status()).toBe(200);
      expect((await res.json()).ok).toBe(true);

      const rows = await sql<{ status: string }[]>`
        select status from repositories where id = ${fixture.repoId}
      `;
      expect(rows[0]!.status).toBe('cloning');
    } finally {
      if (fixture) await cleanupRepoFixture(sql, fixture.repoId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('POST /repos/:id/refresh-tree returns 404 for unknown id', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('refresh-404');
      userId = await registerAndGetUserId(page.request, email);

      const res = await page.request.post(`${API_BASE}/repos/${FAKE_UUID}/refresh-tree`);
      expect(res.status()).toBe(404);
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });
});
