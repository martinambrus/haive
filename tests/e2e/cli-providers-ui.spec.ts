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

test.describe('cli providers UI', () => {
  test('Add Claude Code from available card: fill form, submit, appears under Configured', async ({
    page,
  }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('cli-ui-create');
      userId = await registerAndGetUserId(page.request, email);

      await page.goto('/settings/cli-providers');
      await expect(page.getByRole('heading', { level: 1, name: 'CLI Providers' })).toBeVisible();

      // Available card has an Add button that links to /new?name=claude-code
      await page
        .locator('div')
        .filter({ has: page.getByRole('heading', { level: 2, name: 'Claude Code' }) })
        .getByRole('link', { name: 'Add' })
        .first()
        .click();

      await page.waitForURL(/\/settings\/cli-providers\/new\?name=claude-code$/);

      await expect(page.getByRole('heading', { level: 1, name: /Add Claude Code/ })).toBeVisible();

      const uniqueLabel = `E2E Claude ${Date.now().toString(36)}`;
      await page.getByLabel('Label').fill(uniqueLabel);

      await page.getByRole('button', { name: 'Create', exact: true }).click();

      await page.waitForURL(/\/settings\/cli-providers$/, { timeout: 10_000 });

      await expect(page.getByRole('heading', { level: 3, name: uniqueLabel })).toBeVisible();

      const rows = await sql<{ label: string; name: string }[]>`
        select label, name from cli_providers
        where user_id = ${userId} and label = ${uniqueLabel}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.name).toBe('claude-code');
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('Edit flow: change label via form, DB reflects new label', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('cli-ui-edit');
      userId = await registerAndGetUserId(page.request, email);

      // seed via API
      const createRes = await page.request.post(`${API_BASE}/cli-providers`, {
        data: {
          name: 'claude-code',
          label: 'Before label',
          authMode: 'subscription',
        },
      });
      expect(createRes.status()).toBe(201);
      const {
        provider: { id: providerId },
      } = (await createRes.json()) as { provider: { id: string } };

      await page.goto(`/settings/cli-providers/${providerId}`);
      await expect(page.getByRole('heading', { level: 1, name: 'Before label' })).toBeVisible();

      await page.getByLabel('Label').fill('After label');
      await page.getByRole('button', { name: 'Save', exact: true }).click();

      await expect
        .poll(
          async () => {
            const rows = await sql<{ label: string }[]>`
            select label from cli_providers where id = ${providerId}
          `;
            return rows[0]?.label;
          },
          { timeout: 5_000 },
        )
        .toBe('After label');
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('Secrets panel: add secret via UI, appears in list, encrypted in DB', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    const PLAINTEXT = 'sk-ui-never-leak-this';
    try {
      const email = uniqueEmail('cli-ui-sec');
      userId = await registerAndGetUserId(page.request, email);

      const createRes = await page.request.post(`${API_BASE}/cli-providers`, {
        data: {
          name: 'claude-code',
          label: 'Secrets target',
          authMode: 'api_key',
        },
      });
      expect(createRes.status()).toBe(201);
      const {
        provider: { id: providerId },
      } = (await createRes.json()) as { provider: { id: string } };

      await page.goto(`/settings/cli-providers/${providerId}`);
      await expect(page.getByRole('heading', { level: 1, name: 'Secrets target' })).toBeVisible();
      await expect(page.getByText('No secrets stored.')).toBeVisible();

      // secretName is pre-filled with apiKeyEnvName for claude-code (ANTHROPIC_API_KEY)
      await expect(page.getByLabel('Secret name')).toHaveValue(/ANTHROPIC/);
      await page.getByLabel('Value', { exact: true }).fill(PLAINTEXT);
      await page.getByRole('button', { name: 'Save secret' }).click();

      await expect(page.getByText('No secrets stored.')).toHaveCount(0);
      await expect(
        page.locator('li').filter({ hasText: 'ANTHROPIC_API_KEY' }).first(),
      ).toBeVisible();

      // DB: encrypted_value must not contain plaintext
      const rows = await sql<{ encrypted_value: string }[]>`
        select encrypted_value from cli_provider_secrets
        where provider_id = ${providerId}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.encrypted_value).not.toContain(PLAINTEXT);
      expect(rows[0]!.encrypted_value.length).toBeGreaterThan(0);
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('Secrets panel: Delete button removes secret via confirm dialog', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('cli-ui-sec-del');
      userId = await registerAndGetUserId(page.request, email);

      const createRes = await page.request.post(`${API_BASE}/cli-providers`, {
        data: {
          name: 'claude-code',
          label: 'Delete target',
          authMode: 'api_key',
        },
      });
      expect(createRes.status()).toBe(201);
      const {
        provider: { id: providerId },
      } = (await createRes.json()) as { provider: { id: string } };

      const seedSecretRes = await page.request.post(
        `${API_BASE}/cli-providers/${providerId}/secrets`,
        { data: { secretName: 'ANTHROPIC_API_KEY', value: 'sk-to-delete' } },
      );
      expect(seedSecretRes.status()).toBe(201);

      await page.goto(`/settings/cli-providers/${providerId}`);
      await expect(page.getByRole('heading', { level: 1, name: 'Delete target' })).toBeVisible();

      const secretRow = page.locator('li').filter({ hasText: 'ANTHROPIC_API_KEY' }).first();
      await expect(secretRow).toBeVisible();

      const dialogMessages: string[] = [];
      page.on('dialog', (dialog) => {
        dialogMessages.push(dialog.message());
        void dialog.accept();
      });

      await secretRow.getByRole('button', { name: 'Delete' }).click();

      await expect(secretRow).toHaveCount(0);
      await expect(page.getByText('No secrets stored.')).toBeVisible();

      expect(dialogMessages).toHaveLength(1);
      expect(dialogMessages[0]).toContain('ANTHROPIC_API_KEY');

      const rows = await sql<{ secret_name: string }[]>`
        select secret_name from cli_provider_secrets
        where provider_id = ${providerId}
      `;
      expect(rows).toHaveLength(0);
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('Secrets panel: Delete dismissed (confirm cancelled) keeps secret', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('cli-ui-sec-cancel');
      userId = await registerAndGetUserId(page.request, email);

      const createRes = await page.request.post(`${API_BASE}/cli-providers`, {
        data: {
          name: 'claude-code',
          label: 'Keep target',
          authMode: 'api_key',
        },
      });
      expect(createRes.status()).toBe(201);
      const {
        provider: { id: providerId },
      } = (await createRes.json()) as { provider: { id: string } };

      await page.request.post(`${API_BASE}/cli-providers/${providerId}/secrets`, {
        data: { secretName: 'ANTHROPIC_API_KEY', value: 'sk-keep' },
      });

      await page.goto(`/settings/cli-providers/${providerId}`);
      const secretRow = page.locator('li').filter({ hasText: 'ANTHROPIC_API_KEY' }).first();
      await expect(secretRow).toBeVisible();

      page.on('dialog', (dialog) => {
        void dialog.dismiss();
      });

      await secretRow.getByRole('button', { name: 'Delete' }).click();

      // row still there after dismiss
      await expect(secretRow).toBeVisible();

      const rows = await sql<{ secret_name: string }[]>`
        select secret_name from cli_provider_secrets
        where provider_id = ${providerId}
      `;
      expect(rows).toHaveLength(1);
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });
});
