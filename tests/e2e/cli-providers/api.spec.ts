import { expect, test } from '@playwright/test';
import { cleanupUser, getSql } from '../helpers/db.js';
import { API_BASE, registerUser, uniqueEmail } from '../helpers/auth.js';

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
    // Deliberately NOT a count. This asserted `toBe(9)` and broke the day openrouter was added
    // as the tenth — a failure that reported "the catalog is wrong" when the catalog was right.
    // Growing the list of shipped providers is not a regression; a malformed entry, a duplicate
    // name, or a missing provider is. So assert the shape and the membership, never the size.
    const names = body.providers.map((p) => p.name);
    expect(new Set(names).size, 'provider names must be unique').toBe(names.length);
    for (const p of body.providers) {
      expect(p.name, `${p.name}: name`).toBeTruthy();
      expect(p.displayName, `${p.name}: displayName`).toBeTruthy();
      expect(typeof p.supportsSubagents, `${p.name}: supportsSubagents`).toBe('boolean');
    }
    expect(names).toEqual(
      expect.arrayContaining([
        'claude-code',
        'codex',
        'gemini',
        'amp',
        'zai',
        'antigravity',
        'ollama',
        'muse',
        'grok',
        'openrouter',
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
      userId = (await registerUser(sql, page.request, { email })).userId;

      const listRes = await page.request.get(`${API_BASE}/cli-providers`);
      expect(listRes.status()).toBe(200);
      const body = (await listRes.json()) as { providers: unknown[] };
      expect(body.providers).toEqual([]);

      await page.goto('/cli-providers');
      await expect(page.getByRole('heading', { level: 1, name: 'CLI Providers' })).toBeVisible();
      await expect(page.getByText('None yet. Pick a CLI below to get started.')).toBeVisible();
      await expect(page.getByRole('heading', { level: 2, name: 'Add another CLI' })).toBeVisible();
      await expect(page.getByRole('heading', { level: 2, name: 'Claude Code' })).toBeVisible();
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('create provider, list returns it, second instance with same name is allowed', async ({
    page,
  }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('cli-create');
      userId = (await registerUser(sql, page.request, { email })).userId;

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

      const secondRes = await page.request.post(`${API_BASE}/cli-providers`, {
        data: {
          name: 'claude-code',
          label: 'Claude Code (second)',
          authMode: 'subscription',
        },
      });
      expect(secondRes.status(), `second create failed: ${await secondRes.text()}`).toBe(201);

      const listAgain = await page.request.get(`${API_BASE}/cli-providers`);
      const listAgainBody = (await listAgain.json()) as {
        providers: Array<{ id: string; name: string; label: string }>;
      };
      expect(listAgainBody.providers).toHaveLength(2);
      const labels = listAgainBody.providers.map((p) => p.label).sort();
      expect(labels).toEqual(['Claude Code', 'Claude Code (second)']);
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
      userId = (await registerUser(sql, page.request, { email })).userId;

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

  test('PATCH with empty strings clears executablePath, wrapperPath, wrapperContent', async ({
    page,
  }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('cli-patch-clear');
      userId = (await registerUser(sql, page.request, { email })).userId;

      const createRes = await page.request.post(`${API_BASE}/cli-providers`, {
        data: {
          name: 'claude-code',
          label: 'Clearable',
          authMode: 'subscription',
          executablePath: '/usr/local/bin/claude-timed',
          wrapperPath: '/opt/wrappers/w.sh',
          wrapperContent: '#!/bin/bash\nexec /usr/local/bin/claude "$@"',
        },
      });
      expect(createRes.status()).toBe(201);
      const { provider } = (await createRes.json()) as {
        provider: {
          id: string;
          executablePath: string | null;
          wrapperPath: string | null;
          wrapperContent: string | null;
        };
      };
      expect(provider.executablePath).toBe('/usr/local/bin/claude-timed');
      expect(provider.wrapperPath).toBe('/opt/wrappers/w.sh');
      expect(provider.wrapperContent).toContain('#!/bin/bash');

      const patchRes = await page.request.patch(`${API_BASE}/cli-providers/${provider.id}`, {
        data: { executablePath: '', wrapperPath: '', wrapperContent: '' },
      });
      expect(patchRes.status()).toBe(200);

      const rows = await sql<
        {
          executable_path: string | null;
          wrapper_path: string | null;
          wrapper_content: string | null;
        }[]
      >`
        select executable_path, wrapper_path, wrapper_content
        from cli_providers where id = ${provider.id}
      `;
      expect(rows[0]!.executable_path).toBeNull();
      expect(rows[0]!.wrapper_path).toBeNull();
      expect(rows[0]!.wrapper_content).toBeNull();
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
      userId = (await registerUser(sql, page.request, { email })).userId;

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
      userId = (await registerUser(sql, page.request, { email })).userId;

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

  test('POST /cli-providers flips sandboxImageBuildStatus to building synchronously', async ({
    page,
  }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('cli-build-flip');
      userId = (await registerUser(sql, page.request, { email })).userId;

      const createRes = await page.request.post(`${API_BASE}/cli-providers`, {
        data: { name: 'claude-code', label: 'Build flip', authMode: 'subscription' },
      });
      expect(createRes.status()).toBe(201);
      const createBody = (await createRes.json()) as {
        provider: { id: string; sandboxImageBuildStatus: string };
      };
      // HTTP response is the only race-proof observation: the handler hard-
      // codes 'building' into the returned body regardless of whether the
      // worker has already reused a cached image and flipped the DB row.
      expect(createBody.provider.sandboxImageBuildStatus).toBe('building');

      // DB side-effect is transient but must have occurred in one of the two
      // valid post-flip states.
      const rows = await sql<{ sandbox_image_build_status: string }[]>`
        select sandbox_image_build_status from cli_providers
        where id = ${createBody.provider.id}
      `;
      expect(['building', 'ready']).toContain(rows[0]!.sandbox_image_build_status);
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('PATCH /cli-providers/:id only flips to building when image inputs change', async ({
    page,
  }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('cli-patch-flip');
      userId = (await registerUser(sql, page.request, { email })).userId;

      const createRes = await page.request.post(`${API_BASE}/cli-providers`, {
        data: { name: 'claude-code', label: 'Patch target', authMode: 'subscription' },
      });
      expect(createRes.status()).toBe(201);
      const { provider } = (await createRes.json()) as { provider: { id: string } };

      // Wait for the worker to finish reusing the cached image so the DB row
      // settles on 'ready'. Without this the label-only PATCH below races.
      await expect
        .poll(
          async () => {
            const r = await sql<{ sandbox_image_build_status: string }[]>`
              select sandbox_image_build_status from cli_providers where id = ${provider.id}
            `;
            return r[0]?.sandbox_image_build_status;
          },
          { timeout: 10_000 },
        )
        .toBe('ready');

      // Label-only PATCH does not change any image inputs. Handler returns the
      // row as-is, so status stays 'ready'.
      const labelRes = await page.request.patch(`${API_BASE}/cli-providers/${provider.id}`, {
        data: { label: 'Patched label' },
      });
      expect(labelRes.status()).toBe(200);
      const labelBody = (await labelRes.json()) as {
        provider: { label: string; sandboxImageBuildStatus: string };
      };
      expect(labelBody.provider.label).toBe('Patched label');
      expect(labelBody.provider.sandboxImageBuildStatus).toBe('ready');

      // sandboxDockerfileExtra change IS an image input. Handler hard-codes
      // 'building' in the response regardless of how fast the worker runs.
      const dockerRes = await page.request.patch(`${API_BASE}/cli-providers/${provider.id}`, {
        data: { sandboxDockerfileExtra: '# test comment' },
      });
      expect(dockerRes.status()).toBe(200);
      const dockerBody = (await dockerRes.json()) as {
        provider: { sandboxImageBuildStatus: string; sandboxImageBuildError: string | null };
      };
      expect(dockerBody.provider.sandboxImageBuildStatus).toBe('building');
      expect(dockerBody.provider.sandboxImageBuildError).toBeNull();
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('POST /:id/clone creates a copy with " Copy" label and copies secrets', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('cli-clone');
      userId = (await registerUser(sql, page.request, { email })).userId;

      const createRes = await page.request.post(`${API_BASE}/cli-providers`, {
        data: {
          name: 'claude-code',
          label: 'Claude Prod',
          authMode: 'api_key',
          executablePath: '/usr/local/bin/claude',
          envVars: { NODE_ENV: 'production' },
          cliArgs: ['--verbose'],
        },
      });
      expect(createRes.status()).toBe(201);
      const { provider: source } = (await createRes.json()) as {
        provider: { id: string };
      };

      const seedRes = await page.request.post(`${API_BASE}/cli-providers/${source.id}/secrets`, {
        data: { secretName: 'ANTHROPIC_API_KEY', value: 'sk-cloned-from-source' },
      });
      expect(seedRes.status()).toBe(201);

      const cloneRes = await page.request.post(`${API_BASE}/cli-providers/${source.id}/clone`);
      expect(cloneRes.status(), `clone failed: ${await cloneRes.text()}`).toBe(201);
      const { provider: clone } = (await cloneRes.json()) as {
        provider: {
          id: string;
          name: string;
          label: string;
          executablePath: string | null;
          envVars: Record<string, string> | null;
          cliArgs: string[];
          authMode: string;
          sandboxImageBuildStatus: string;
        };
      };

      expect(clone.id).not.toBe(source.id);
      expect(clone.label).toBe('Claude Prod Copy');
      expect(clone.name).toBe('claude-code');
      expect(clone.authMode).toBe('api_key');
      expect(clone.executablePath).toBe('/usr/local/bin/claude');
      expect(clone.envVars).toEqual({ NODE_ENV: 'production' });
      expect(clone.cliArgs).toEqual(['--verbose']);
      expect(clone.sandboxImageBuildStatus).toBe('building');

      // Secrets copied verbatim (envelope encryption uses master KEK so the
      // ciphertext does not need to be re-wrapped for the new provider).
      const cloneSecretsRes = await page.request.get(
        `${API_BASE}/cli-providers/${clone.id}/secrets`,
      );
      expect(cloneSecretsRes.status()).toBe(200);
      const cloneSecrets = (await cloneSecretsRes.json()) as {
        secrets: Array<{ secretName: string }>;
      };
      expect(cloneSecrets.secrets).toHaveLength(1);
      expect(cloneSecrets.secrets[0]!.secretName).toBe('ANTHROPIC_API_KEY');

      // Both providers appear in the list.
      const listRes = await page.request.get(`${API_BASE}/cli-providers`);
      const listBody = (await listRes.json()) as {
        providers: Array<{ id: string; label: string }>;
      };
      expect(listBody.providers).toHaveLength(2);
      const labels = listBody.providers.map((p) => p.label).sort();
      expect(labels).toEqual(['Claude Prod', 'Claude Prod Copy']);
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('POST /:id/clone picks " Copy N" when earlier copies already exist', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('cli-clone-n');
      userId = (await registerUser(sql, page.request, { email })).userId;

      const createRes = await page.request.post(`${API_BASE}/cli-providers`, {
        data: { name: 'gemini', label: 'Gemini', authMode: 'api_key' },
      });
      expect(createRes.status()).toBe(201);
      const { provider: source } = (await createRes.json()) as {
        provider: { id: string };
      };

      const firstClone = await page.request.post(`${API_BASE}/cli-providers/${source.id}/clone`);
      expect(firstClone.status()).toBe(201);
      expect(((await firstClone.json()) as { provider: { label: string } }).provider.label).toBe(
        'Gemini Copy',
      );

      const secondClone = await page.request.post(`${API_BASE}/cli-providers/${source.id}/clone`);
      expect(secondClone.status()).toBe(201);
      expect(((await secondClone.json()) as { provider: { label: string } }).provider.label).toBe(
        'Gemini Copy 2',
      );

      const thirdClone = await page.request.post(`${API_BASE}/cli-providers/${source.id}/clone`);
      expect(thirdClone.status()).toBe(201);
      expect(((await thirdClone.json()) as { provider: { label: string } }).provider.label).toBe(
        'Gemini Copy 3',
      );

      const listRes = await page.request.get(`${API_BASE}/cli-providers`);
      const listBody = (await listRes.json()) as { providers: Array<{ label: string }> };
      const labels = listBody.providers.map((p) => p.label).sort();
      expect(labels).toEqual(['Gemini', 'Gemini Copy', 'Gemini Copy 2', 'Gemini Copy 3']);
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('POST /:id/clone 404s on unknown id and cannot cross users', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    let otherUserId = '';
    try {
      const email = uniqueEmail('cli-clone-iso');
      userId = (await registerUser(sql, page.request, { email })).userId;

      const createRes = await page.request.post(`${API_BASE}/cli-providers`, {
        data: { name: 'codex', label: 'Codex', authMode: 'api_key' },
      });
      const { provider } = (await createRes.json()) as { provider: { id: string } };

      const missingRes = await page.request.post(
        `${API_BASE}/cli-providers/00000000-0000-0000-0000-000000000000/clone`,
      );
      expect(missingRes.status()).toBe(404);

      // Other user cannot clone user A's provider. Registering through the helper, like every
      // other spec: a bare POST /auth/register is refused now, and this one was missed because it
      // is inline rather than a call to the shared register function.
      otherUserId = (await registerUser(sql, page.request, { prefix: 'cli-clone-iso-b' })).userId;

      const crossRes = await page.request.post(`${API_BASE}/cli-providers/${provider.id}/clone`);
      expect(crossRes.status()).toBe(404);
    } finally {
      if (userId) await cleanupUser(sql, userId);
      if (otherUserId) await cleanupUser(sql, otherUserId);
      await sql.end({ timeout: 5 });
    }
  });
});
