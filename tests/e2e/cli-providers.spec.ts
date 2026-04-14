import { expect, test, type APIRequestContext } from '@playwright/test';
import { cleanupUser, getSql } from './helpers/db.js';

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

test.describe('cli providers', () => {
  test('GET /cli-providers/catalog is public and lists all providers', async ({ request }) => {
    const res = await request.get(`${API_BASE}/cli-providers/catalog`);
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      providers: Array<{
        name: string;
        displayName: string;
        description: string;
        supportsSubagents: boolean;
      }>;
    };
    expect(body.providers.length).toBe(8);
    const names = body.providers.map((p) => p.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'claude-code',
        'codex',
        'gemini',
        'amp',
        'grok',
        'qwen',
        'kiro',
        'zai',
      ]),
    );
    const claudeCode = body.providers.find((p) => p.name === 'claude-code');
    expect(claudeCode?.supportsSubagents).toBe(true);
  });

  test('GET /cli-providers requires auth', async ({ request }) => {
    const res = await request.get(`${API_BASE}/cli-providers`);
    expect(res.status()).toBe(401);
  });

  test('fresh user sees empty configured list and available cards in UI', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('cli-empty');
      userId = await registerAndGetUserId(page.request, email);

      const listRes = await page.request.get(`${API_BASE}/cli-providers`);
      expect(listRes.status()).toBe(200);
      const body = (await listRes.json()) as { providers: unknown[] };
      expect(body.providers).toEqual([]);

      await page.goto('/settings/cli-providers');
      await expect(page.getByRole('heading', { level: 1, name: 'CLI Providers' })).toBeVisible();
      await expect(page.getByText('None yet. Pick a CLI below to get started.')).toBeVisible();
      await expect(page.getByRole('heading', { level: 2, name: 'Available' })).toBeVisible();
      await expect(page.getByRole('heading', { level: 2, name: 'Claude Code' })).toBeVisible();
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('create provider, list returns it, duplicate returns 409', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('cli-create');
      userId = await registerAndGetUserId(page.request, email);

      const createRes = await page.request.post(`${API_BASE}/cli-providers`, {
        data: {
          name: 'claude-code',
          label: 'Claude Code',
          authMode: 'subscription',
        },
      });
      expect(createRes.status(), `create failed: ${await createRes.text()}`).toBe(201);
      const created = (await createRes.json()) as {
        provider: { id: string; name: string; label: string; authMode: string };
      };
      expect(created.provider.name).toBe('claude-code');
      expect(created.provider.label).toBe('Claude Code');

      const listRes = await page.request.get(`${API_BASE}/cli-providers`);
      const listBody = (await listRes.json()) as {
        providers: Array<{ id: string; name: string }>;
      };
      expect(listBody.providers).toHaveLength(1);
      expect(listBody.providers[0]!.name).toBe('claude-code');

      const dupRes = await page.request.post(`${API_BASE}/cli-providers`, {
        data: {
          name: 'claude-code',
          label: 'Duplicate',
          authMode: 'subscription',
        },
      });
      expect(dupRes.status()).toBe(409);
      const dupBody = (await dupRes.json()) as { error?: string };
      expect(dupBody.error ?? '').toMatch(/already/i);
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('PATCH updates label but rejects name change', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('cli-patch');
      userId = await registerAndGetUserId(page.request, email);

      const createRes = await page.request.post(`${API_BASE}/cli-providers`, {
        data: { name: 'codex', label: 'Codex', authMode: 'api_key' },
      });
      expect(createRes.status()).toBe(201);
      const { provider } = (await createRes.json()) as {
        provider: { id: string };
      };

      const patchRes = await page.request.patch(`${API_BASE}/cli-providers/${provider.id}`, {
        data: { label: 'Codex renamed' },
      });
      expect(patchRes.status()).toBe(200);
      const patched = (await patchRes.json()) as {
        provider: { label: string };
      };
      expect(patched.provider.label).toBe('Codex renamed');

      const renameRes = await page.request.patch(`${API_BASE}/cli-providers/${provider.id}`, {
        data: { name: 'gemini' },
      });
      expect(renameRes.status()).toBe(400);
      const renameBody = (await renameRes.json()) as { error?: string };
      expect(renameBody.error ?? '').toMatch(/name/i);
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('DELETE removes provider', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('cli-delete');
      userId = await registerAndGetUserId(page.request, email);

      const createRes = await page.request.post(`${API_BASE}/cli-providers`, {
        data: { name: 'gemini', label: 'Gemini', authMode: 'api_key' },
      });
      const { provider } = (await createRes.json()) as {
        provider: { id: string };
      };

      const delRes = await page.request.delete(`${API_BASE}/cli-providers/${provider.id}`);
      expect(delRes.status()).toBe(200);

      const listRes = await page.request.get(`${API_BASE}/cli-providers`);
      const listBody = (await listRes.json()) as { providers: unknown[] };
      expect(listBody.providers).toEqual([]);

      const missingRes = await page.request.delete(`${API_BASE}/cli-providers/${provider.id}`);
      expect(missingRes.status()).toBe(404);
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('secret lifecycle never exposes plaintext on GET', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('cli-secrets');
      userId = await registerAndGetUserId(page.request, email);

      const createRes = await page.request.post(`${API_BASE}/cli-providers`, {
        data: { name: 'claude-code', label: 'Claude Code', authMode: 'api_key' },
      });
      const { provider } = (await createRes.json()) as {
        provider: { id: string };
      };

      const plaintext = 'sk-ant-super-secret-e2e-only-do-not-use';
      const setRes = await page.request.post(`${API_BASE}/cli-providers/${provider.id}/secrets`, {
        data: { secretName: 'ANTHROPIC_API_KEY', value: plaintext },
      });
      expect(setRes.status()).toBe(201);
      const setBody = (await setRes.json()) as {
        secret: { secretName: string; fingerprint: string | null };
      };
      expect(setBody.secret.secretName).toBe('ANTHROPIC_API_KEY');
      expect(setBody.secret.fingerprint).toBeTruthy();
      const setBodyText = JSON.stringify(setBody);
      expect(setBodyText).not.toContain(plaintext);

      const listRes = await page.request.get(`${API_BASE}/cli-providers/${provider.id}/secrets`);
      expect(listRes.status()).toBe(200);
      const listBody = (await listRes.json()) as {
        secrets: Array<{ secretName: string; fingerprint: string | null }>;
      };
      expect(listBody.secrets).toHaveLength(1);
      expect(listBody.secrets[0]!.secretName).toBe('ANTHROPIC_API_KEY');
      const listText = JSON.stringify(listBody);
      expect(listText).not.toContain(plaintext);

      const dbRows = await sql<{ encrypted_value: string }[]>`
        select encrypted_value from cli_provider_secrets
        where provider_id = ${provider.id}
      `;
      expect(dbRows).toHaveLength(1);
      expect(dbRows[0]!.encrypted_value).not.toContain(plaintext);

      const delRes = await page.request.delete(
        `${API_BASE}/cli-providers/${provider.id}/secrets/ANTHROPIC_API_KEY`,
      );
      expect(delRes.status()).toBe(200);

      const afterRes = await page.request.get(`${API_BASE}/cli-providers/${provider.id}/secrets`);
      const afterBody = (await afterRes.json()) as { secrets: unknown[] };
      expect(afterBody.secrets).toEqual([]);
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });
});
