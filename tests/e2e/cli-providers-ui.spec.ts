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

  test('Secrets textarea: add secret via UI Save, encrypted in DB', async ({ page }) => {
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

      const secretsField = page.getByLabel('Secrets', { exact: true });
      await expect(secretsField).toHaveValue('');
      await secretsField.fill(`ANTHROPIC_API_KEY=${PLAINTEXT}`);

      await page.getByRole('button', { name: 'Save', exact: true }).click();

      await page.waitForURL(/\/settings\/cli-providers$/, { timeout: 10_000 });

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

  test('Secrets textarea: clearing the line and saving deletes the secret', async ({ page }) => {
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

      const secretsField = page.getByLabel('Secrets', { exact: true });
      await expect(secretsField).toHaveValue('ANTHROPIC_API_KEY=');
      await secretsField.fill('');

      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.waitForURL(/\/settings\/cli-providers$/, { timeout: 10_000 });

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

  test('Secrets textarea: leaving value blank keeps existing secret unchanged', async ({
    page,
  }) => {
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

      const before = await sql<{ encrypted_value: string }[]>`
        select encrypted_value from cli_provider_secrets
        where provider_id = ${providerId}
      `;
      expect(before).toHaveLength(1);
      const beforeEncrypted = before[0]!.encrypted_value;

      await page.goto(`/settings/cli-providers/${providerId}`);
      await expect(page.getByRole('heading', { level: 1, name: 'Keep target' })).toBeVisible();

      // Auto-filled with name= placeholder; do not touch, click Save.
      const secretsField = page.getByLabel('Secrets', { exact: true });
      await expect(secretsField).toHaveValue('ANTHROPIC_API_KEY=');

      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.waitForURL(/\/settings\/cli-providers$/, { timeout: 10_000 });

      const after = await sql<{ secret_name: string; encrypted_value: string }[]>`
        select secret_name, encrypted_value from cli_provider_secrets
        where provider_id = ${providerId}
      `;
      expect(after).toHaveLength(1);
      expect(after[0]!.secret_name).toBe('ANTHROPIC_API_KEY');
      expect(after[0]!.encrypted_value).toBe(beforeEncrypted);
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });
});
