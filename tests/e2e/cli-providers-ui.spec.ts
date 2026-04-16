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

  test('Edit form: Test connection disabled by any unsaved form change', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('cli-ui-test-gate');
      userId = await registerAndGetUserId(page.request, email);

      const createRes = await page.request.post(`${API_BASE}/cli-providers`, {
        data: { name: 'claude-code', label: 'Gate target', authMode: 'subscription' },
      });
      expect(createRes.status()).toBe(201);
      const {
        provider: { id: providerId },
      } = (await createRes.json()) as { provider: { id: string } };

      await page.goto(`/settings/cli-providers/${providerId}`);
      await expect(page.getByRole('heading', { level: 1, name: 'Gate target' })).toBeVisible();

      const testButton = page.getByRole('button', { name: 'Test connection' });
      const notice = page.getByText(/Unsaved form changes/);

      // Clean state on load.
      await expect(testButton).toBeEnabled();
      await expect(notice).toHaveCount(0);

      // Each of these fields, when touched, should disable the Test button and
      // show the yellow notice. The baseline resets between cases so we can
      // verify each field independently.
      const dirtyCases: Array<{
        name: string;
        dirty: () => Promise<void>;
        clean: () => Promise<void>;
      }> = [
        {
          name: 'executablePath',
          dirty: async () => page.getByLabel('Executable path').fill('/usr/local/bin/claude-timed'),
          clean: async () => page.getByLabel('Executable path').fill(''),
        },
        {
          name: 'wrapperPath',
          dirty: async () => page.getByLabel('Wrapper script path').fill('/opt/wrap.sh'),
          clean: async () => page.getByLabel('Wrapper script path').fill(''),
        },
        {
          name: 'wrapperContent',
          dirty: async () => page.getByLabel('Wrapper script content').fill('#!/bin/bash\nexit 0'),
          clean: async () => page.getByLabel('Wrapper script content').fill(''),
        },
        {
          name: 'authMode',
          dirty: async () => page.locator('#authMode').selectOption('api_key'),
          clean: async () => page.locator('#authMode').selectOption('subscription'),
        },
        {
          name: 'sandboxDockerfileExtra',
          dirty: async () => page.locator('#sandboxDockerfileExtra').fill('RUN echo hi'),
          clean: async () => page.locator('#sandboxDockerfileExtra').fill(''),
        },
        {
          name: 'envVars',
          dirty: async () => page.locator('#envVars').fill('FOO=bar'),
          clean: async () => page.locator('#envVars').fill(''),
        },
        {
          name: 'cliArgs',
          dirty: async () => page.locator('#cliArgs').fill('--verbose'),
          clean: async () => page.locator('#cliArgs').fill(''),
        },
        {
          name: 'networkMode',
          dirty: async () => page.getByRole('radio', { name: /No network/ }).check(),
          clean: async () => page.getByRole('radio', { name: /Full internet/ }).check(),
        },
      ];

      for (const tc of dirtyCases) {
        await tc.dirty();
        await expect(testButton, `dirty via ${tc.name}`).toBeDisabled();
        await expect(notice, `notice for ${tc.name}`).toBeVisible();

        await tc.clean();
        await expect(testButton, `cleaned ${tc.name}`).toBeEnabled();
        await expect(notice, `notice cleared for ${tc.name}`).toHaveCount(0);
      }
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('Edit form: Rebuild persists form and keeps Test disabled through dirty->building handoff', async ({
    page,
  }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('cli-ui-rebuild');
      userId = await registerAndGetUserId(page.request, email);

      const createRes = await page.request.post(`${API_BASE}/cli-providers`, {
        data: { name: 'claude-code', label: 'Rebuild target', authMode: 'subscription' },
      });
      expect(createRes.status()).toBe(201);
      const {
        provider: { id: providerId },
      } = (await createRes.json()) as { provider: { id: string } };

      await page.goto(`/settings/cli-providers/${providerId}`);
      await expect(page.getByRole('heading', { level: 1, name: 'Rebuild target' })).toBeVisible();

      const testButton = page.getByRole('button', { name: 'Test connection' });

      // Wait for the initial build kicked off by provider creation to settle
      // so the baseline is the enabled state (not the building gate).
      await expect(testButton).toBeEnabled({ timeout: 30_000 });

      // Non-image field (executablePath) plus image field (Dockerfile extra):
      // Rebuild must persist both and keep the button disabled throughout
      // the dirty -> building transition.
      await page.getByLabel('Executable path').fill('/usr/local/bin/claude-custom');
      await page.locator('#sandboxDockerfileExtra').fill('# e2e rebuild marker');

      // Dirty state disables the button with the save-first notice.
      await expect(testButton).toBeDisabled();
      await expect(page.getByText(/Unsaved form changes/)).toBeVisible();

      await page.getByRole('button', { name: /Rebuild image/ }).click();

      // persistEdit runs synchronously with the click: DB must reflect both
      // the non-image and image field immediately.
      await expect
        .poll(
          async () => {
            const rows = await sql<
              {
                executable_path: string | null;
                sandbox_dockerfile_extra: string | null;
              }[]
            >`
              select executable_path, sandbox_dockerfile_extra from cli_providers
              where id = ${providerId}
            `;
            return rows[0];
          },
          { timeout: 5_000 },
        )
        .toEqual({
          executable_path: '/usr/local/bin/claude-custom',
          sandbox_dockerfile_extra: '# e2e rebuild marker',
        });

      // After the click, the dirty gate clears but the building gate kicks in,
      // so the notice swaps text and the button must stay disabled.
      await expect(page.getByText(/Sandbox image is currently rebuilding/)).toBeVisible({
        timeout: 10_000,
      });
      await expect(testButton).toBeDisabled();
      await expect(page.getByText(/Unsaved form changes/)).toHaveCount(0);
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('Edit form: clearing executablePath persists as null', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('cli-ui-clear');
      userId = await registerAndGetUserId(page.request, email);

      const createRes = await page.request.post(`${API_BASE}/cli-providers`, {
        data: {
          name: 'claude-code',
          label: 'Clearable UI',
          authMode: 'subscription',
          executablePath: '/usr/local/bin/claude-timed',
        },
      });
      expect(createRes.status()).toBe(201);
      const {
        provider: { id: providerId },
      } = (await createRes.json()) as { provider: { id: string } };

      await page.goto(`/settings/cli-providers/${providerId}`);
      await expect(page.getByRole('heading', { level: 1, name: 'Clearable UI' })).toBeVisible();

      const execField = page.getByLabel('Executable path');
      await expect(execField).toHaveValue('/usr/local/bin/claude-timed');
      await execField.fill('');

      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.waitForURL(/\/settings\/cli-providers$/, { timeout: 10_000 });

      const rows = await sql<{ executable_path: string | null }[]>`
        select executable_path from cli_providers where id = ${providerId}
      `;
      expect(rows[0]!.executable_path).toBeNull();
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('Clone button on list page creates a Copy and reloads the list', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('cli-ui-clone');
      userId = await registerAndGetUserId(page.request, email);

      const createRes = await page.request.post(`${API_BASE}/cli-providers`, {
        data: {
          name: 'claude-code',
          label: 'Clone me UI',
          authMode: 'subscription',
        },
      });
      expect(createRes.status()).toBe(201);

      await page.goto('/settings/cli-providers');
      await expect(page.getByRole('heading', { level: 1, name: 'CLI Providers' })).toBeVisible();
      await expect(page.getByRole('heading', { level: 3, name: 'Clone me UI' })).toBeVisible();

      await page.getByRole('button', { name: 'Clone', exact: true }).click();

      await expect(page.getByRole('heading', { level: 3, name: 'Clone me UI Copy' })).toBeVisible({
        timeout: 10_000,
      });

      const rows = await sql<{ label: string; sandbox_image_build_status: string }[]>`
        select label, sandbox_image_build_status from cli_providers
        where user_id = ${userId}
        order by label
      `;
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.label)).toEqual(['Clone me UI', 'Clone me UI Copy']);
      // Clone synchronously flips status to 'building' then the worker flips
      // back to 'ready' after the cached image is reused. Either is valid.
      expect(['building', 'ready']).toContain(rows[1]!.sandbox_image_build_status);
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
