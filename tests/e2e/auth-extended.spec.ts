import { expect, test, type APIRequestContext } from '@playwright/test';
import { cleanupUser, getSql } from './helpers/db.js';

const API_BASE = process.env.PLAYWRIGHT_API_BASE ?? 'http://localhost:3001';
const PASSWORD = 'e2e-password-12345';

function uniqueEmail(prefix: string): string {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${stamp}-${rand}@haive-e2e.test`;
}

async function register(request: APIRequestContext, email: string): Promise<string> {
  const res = await request.post(`${API_BASE}/auth/register`, {
    data: { email, password: PASSWORD },
  });
  expect(res.status(), `register failed: ${await res.text()}`).toBe(201);
  const body = (await res.json()) as { user: { id: string } };
  return body.user.id;
}

test.describe('auth extended endpoints', () => {
  test('GET /auth/me requires auth', async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    try {
      const res = await ctx.get(`${API_BASE}/auth/me`);
      expect(res.status()).toBe(401);
    } finally {
      await ctx.dispose();
    }
  });

  test('GET /auth/me returns decrypted email and profile', async ({ playwright }) => {
    const sql = getSql();
    const ctx = await playwright.request.newContext();
    let userId = '';
    try {
      const email = uniqueEmail('me');
      userId = await register(ctx, email);

      const res = await ctx.get(`${API_BASE}/auth/me`);
      expect(res.status()).toBe(200);
      const body = (await res.json()) as {
        user: {
          id: string;
          email: string;
          role: string;
          status: string;
          createdAt: string;
        };
      };
      expect(body.user.id).toBe(userId);
      expect(body.user.email).toBe(email);
      expect(body.user.role).toBe('user');
      expect(body.user.status).toBe('active');
      expect(new Date(body.user.createdAt).getTime()).toBeGreaterThan(0);
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
      await ctx.dispose();
    }
  });

  test('POST /auth/refresh rotates tokens; old refresh rejected', async ({ playwright }) => {
    const sql = getSql();
    const ctx = await playwright.request.newContext();
    let userId = '';
    try {
      const email = uniqueEmail('refresh-rotate');
      userId = await register(ctx, email);

      const cookiesBefore = await ctx.storageState();
      const oldRefresh = cookiesBefore.cookies.find((c) => c.name === 'haive_refresh');
      expect(oldRefresh, 'refresh cookie should exist after register').toBeDefined();

      const refreshRes = await ctx.post(`${API_BASE}/auth/refresh`);
      expect(refreshRes.status()).toBe(200);

      const cookiesAfter = await ctx.storageState();
      const newRefresh = cookiesAfter.cookies.find((c) => c.name === 'haive_refresh');
      expect(newRefresh).toBeDefined();
      expect(newRefresh!.value).not.toBe(oldRefresh!.value);

      // /auth/me still works after rotation
      const meRes = await ctx.get(`${API_BASE}/auth/me`);
      expect(meRes.status()).toBe(200);

      // prior refresh token is now marked revoked in DB
      const rows = await sql<{ revoked_at: Date | null }[]>`
        select revoked_at from refresh_tokens where user_id = ${userId}
      `;
      const revokedCount = rows.filter((r) => r.revoked_at !== null).length;
      expect(revokedCount).toBeGreaterThanOrEqual(1);
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
      await ctx.dispose();
    }
  });

  test('POST /auth/refresh without cookie returns 401', async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    try {
      const res = await ctx.post(`${API_BASE}/auth/refresh`);
      expect(res.status()).toBe(401);
    } finally {
      await ctx.dispose();
    }
  });

  test('POST /auth/logout revokes refresh token and clears cookies', async ({ playwright }) => {
    const sql = getSql();
    const ctx = await playwright.request.newContext();
    let userId = '';
    try {
      const email = uniqueEmail('logout');
      userId = await register(ctx, email);

      const logoutRes = await ctx.post(`${API_BASE}/auth/logout`);
      expect(logoutRes.status()).toBe(200);

      const state = await ctx.storageState();
      const access = state.cookies.find((c) => c.name === 'haive_access');
      const refresh = state.cookies.find((c) => c.name === 'haive_refresh');
      // cookies cleared: either absent or empty value
      expect(access?.value || '').toBe('');
      expect(refresh?.value || '').toBe('');

      const meAfter = await ctx.get(`${API_BASE}/auth/me`);
      expect(meAfter.status()).toBe(401);

      // refresh token row marked revoked
      const rows = await sql<{ revoked_at: Date | null }[]>`
        select revoked_at from refresh_tokens where user_id = ${userId}
      `;
      expect(rows.length).toBeGreaterThanOrEqual(1);
      const stillActive = rows.filter((r) => r.revoked_at === null).length;
      expect(stillActive).toBe(0);
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
      await ctx.dispose();
    }
  });

  test('POST /auth/refresh rejects revoked refresh token after logout', async ({ playwright }) => {
    const sql = getSql();
    const ctx = await playwright.request.newContext();
    let userId = '';
    try {
      const email = uniqueEmail('refresh-after-logout');
      userId = await register(ctx, email);

      const stateBefore = await ctx.storageState();
      const oldRefresh = stateBefore.cookies.find((c) => c.name === 'haive_refresh');
      expect(oldRefresh).toBeDefined();

      await ctx.post(`${API_BASE}/auth/logout`);

      // manually set the old refresh cookie back on a fresh context
      const ctx2 = await playwright.request.newContext({
        storageState: {
          cookies: [
            {
              name: 'haive_refresh',
              value: oldRefresh!.value,
              domain: oldRefresh!.domain,
              path: oldRefresh!.path,
              expires: oldRefresh!.expires,
              httpOnly: oldRefresh!.httpOnly,
              secure: oldRefresh!.secure,
              sameSite: oldRefresh!.sameSite,
            },
          ],
          origins: [],
        },
      });
      try {
        const res = await ctx2.post(`${API_BASE}/auth/refresh`);
        expect(res.status()).toBe(401);
      } finally {
        await ctx2.dispose();
      }
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
      await ctx.dispose();
    }
  });

  test('POST /auth/register rejects password under 12 chars with 400', async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    try {
      const res = await ctx.post(`${API_BASE}/auth/register`, {
        data: {
          email: uniqueEmail('weak'),
          password: 'short',
        },
      });
      expect(res.status()).toBe(400);
      const body = (await res.json()) as {
        error: string;
        issues?: Array<{ path: string; message: string }>;
      };
      expect(body.error).toBe('Validation failed');
      const pwIssue = body.issues?.find((i) => i.path === 'password');
      expect(pwIssue?.message).toMatch(/12 characters/);
    } finally {
      await ctx.dispose();
    }
  });

  test('tampered haive_access cookie causes /auth/me to return 401', async ({ playwright }) => {
    const sql = getSql();
    let userId = '';
    const ctx = await playwright.request.newContext();
    try {
      const email = uniqueEmail('tampered');
      userId = await register(ctx, email);

      const state = await ctx.storageState();
      const access = state.cookies.find((c) => c.name === 'haive_access');
      expect(access).toBeDefined();

      // flip a character in the signature segment
      const parts = access!.value.split('.');
      expect(parts).toHaveLength(3);
      const sig = parts[2]!;
      const mutated = sig[0] === 'A' ? `B${sig.slice(1)}` : `A${sig.slice(1)}`;
      const tamperedValue = `${parts[0]}.${parts[1]}.${mutated}`;

      const ctx2 = await playwright.request.newContext({
        storageState: {
          cookies: [
            {
              name: 'haive_access',
              value: tamperedValue,
              domain: access!.domain,
              path: access!.path,
              expires: access!.expires,
              httpOnly: access!.httpOnly,
              secure: access!.secure,
              sameSite: access!.sameSite,
            },
          ],
          origins: [],
        },
      });
      try {
        const res = await ctx2.get(`${API_BASE}/auth/me`);
        expect(res.status()).toBe(401);
      } finally {
        await ctx2.dispose();
      }
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
      await ctx.dispose();
    }
  });
});
