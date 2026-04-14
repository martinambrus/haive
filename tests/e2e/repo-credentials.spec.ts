import { expect, test, type APIRequestContext } from '@playwright/test';
import { cleanupUser, getSql } from './helpers/db.js';

const API_BASE = process.env.PLAYWRIGHT_API_BASE ?? 'http://localhost:3001';
const PASSWORD = 'e2e-password-12345';
const PLAINTEXT_SECRET = 'super-secret-token-pat-e2e';
const PLAINTEXT_USERNAME = 'e2e-username';

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

test.describe('repo credentials CRUD', () => {
  test('GET /repo-credentials requires auth', async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    try {
      const res = await ctx.get(`${API_BASE}/repo-credentials`);
      expect(res.status()).toBe(401);
    } finally {
      await ctx.dispose();
    }
  });

  test('fresh user sees empty credential list', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('cred-empty');
      userId = await register(page.request, email);

      const res = await page.request.get(`${API_BASE}/repo-credentials`);
      expect(res.status()).toBe(200);
      const body = (await res.json()) as { credentials: unknown[] };
      expect(body.credentials).toEqual([]);
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('POST creates credential; plaintext never in response or list', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('cred-create');
      userId = await register(page.request, email);

      const createRes = await page.request.post(`${API_BASE}/repo-credentials`, {
        data: {
          label: 'e2e github pat',
          host: 'github.com',
          username: PLAINTEXT_USERNAME,
          secret: PLAINTEXT_SECRET,
        },
      });
      expect(createRes.status()).toBe(201);
      const createBody = (await createRes.json()) as {
        credential: { id: string; label: string; host: string };
      };
      const credentialId = createBody.credential.id;
      expect(credentialId).toMatch(/^[0-9a-f-]{36}$/);
      expect(createBody.credential.label).toBe('e2e github pat');
      expect(createBody.credential.host).toBe('github.com');

      // plaintext MUST NOT appear anywhere in the create response
      const createText = JSON.stringify(createBody);
      expect(createText).not.toContain(PLAINTEXT_SECRET);
      expect(createText).not.toContain(PLAINTEXT_USERNAME);

      // GET list does not leak plaintext either
      const listRes = await page.request.get(`${API_BASE}/repo-credentials`);
      expect(listRes.status()).toBe(200);
      const listText = await listRes.text();
      expect(listText).not.toContain(PLAINTEXT_SECRET);
      expect(listText).not.toContain(PLAINTEXT_USERNAME);
      const listBody = JSON.parse(listText) as {
        credentials: Array<{ id: string; label: string; host: string }>;
      };
      expect(listBody.credentials).toHaveLength(1);
      expect(listBody.credentials[0]!.id).toBe(credentialId);

      // DB column holds encrypted bytes; plaintext must not appear there
      const rows = await sql<
        {
          username_encrypted: string;
          secret_encrypted: string;
          encrypted_dek: string;
        }[]
      >`
        select username_encrypted, secret_encrypted, encrypted_dek
        from repo_credentials where id = ${credentialId}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.username_encrypted).not.toContain(PLAINTEXT_USERNAME);
      expect(rows[0]!.secret_encrypted).not.toContain(PLAINTEXT_SECRET);
      expect(rows[0]!.encrypted_dek.length).toBeGreaterThan(0);
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('DELETE removes credential; second delete returns 404', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('cred-del');
      userId = await register(page.request, email);

      const createRes = await page.request.post(`${API_BASE}/repo-credentials`, {
        data: {
          label: 'to-delete',
          host: 'gitlab.com',
          username: 'u',
          secret: 'x',
        },
      });
      expect(createRes.status()).toBe(201);
      const { credential } = (await createRes.json()) as {
        credential: { id: string };
      };

      const delRes = await page.request.delete(`${API_BASE}/repo-credentials/${credential.id}`);
      expect(delRes.status()).toBe(200);
      expect((await delRes.json()).ok).toBe(true);

      const del2 = await page.request.delete(`${API_BASE}/repo-credentials/${credential.id}`);
      expect(del2.status()).toBe(404);

      const dbRows = await sql<{ id: string }[]>`
        select id from repo_credentials where id = ${credential.id}
      `;
      expect(dbRows).toHaveLength(0);
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('POST with missing fields returns 400', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('cred-400');
      userId = await register(page.request, email);

      const res = await page.request.post(`${API_BASE}/repo-credentials`, {
        data: { label: 'only label' },
      });
      expect([400, 422]).toContain(res.status());
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });
});
