import { expect, test, type APIRequestContext } from '@playwright/test';
import {
  cleanupRepoFixture,
  cleanupTaskFixture,
  cleanupUser,
  getSql,
  seedRepoFixture,
  seedTaskFixture,
  type RepoFixture,
  type TaskFixture,
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

test.describe('multi-user isolation', () => {
  test('user B cannot see, fetch, mutate, or delete user A resources', async ({ playwright }) => {
    const sql = getSql();
    const ctxA = await playwright.request.newContext();
    const ctxB = await playwright.request.newContext();

    let userAId = '';
    let userBId = '';
    let repoFixture: RepoFixture | null = null;
    let taskFixture: TaskFixture | null = null;
    let providerAId = '';

    try {
      const emailA = uniqueEmail('iso-a');
      const emailB = uniqueEmail('iso-b');
      userAId = await registerAndGetUserId(ctxA, emailA);
      userBId = await registerAndGetUserId(ctxB, emailB);

      repoFixture = await seedRepoFixture(sql, userAId, 'iso-a-repo');
      taskFixture = await seedTaskFixture(sql, userAId, 'iso-a-task');

      const createProviderRes = await ctxA.post(`${API_BASE}/cli-providers`, {
        data: {
          name: 'claude-code',
          label: 'A Claude Code',
          authMode: 'api_key',
        },
      });
      expect(createProviderRes.status()).toBe(201);
      const providerBody = (await createProviderRes.json()) as {
        provider: { id: string };
      };
      providerAId = providerBody.provider.id;

      const setSecretRes = await ctxA.post(`${API_BASE}/cli-providers/${providerAId}/secrets`, {
        data: { secretName: 'ANTHROPIC_API_KEY', value: 'sk-iso-a-only' },
      });
      expect(setSecretRes.status()).toBe(201);

      // --- User B sees nothing in their own lists ---

      const bRepos = await ctxB.get(`${API_BASE}/repos`);
      expect(bRepos.status()).toBe(200);
      expect((await bRepos.json()).repositories).toEqual([]);

      const bTasks = await ctxB.get(`${API_BASE}/tasks`);
      expect(bTasks.status()).toBe(200);
      expect((await bTasks.json()).tasks).toEqual([]);

      const bProviders = await ctxB.get(`${API_BASE}/cli-providers`);
      expect(bProviders.status()).toBe(200);
      expect((await bProviders.json()).providers).toEqual([]);

      // --- User B cannot fetch A's resources by id ---

      const bRepoFetch = await ctxB.get(`${API_BASE}/repos/${repoFixture.repoId}`);
      expect(bRepoFetch.status()).toBe(404);

      const bTaskFetch = await ctxB.get(`${API_BASE}/tasks/${taskFixture.taskId}`);
      expect(bTaskFetch.status()).toBe(404);

      const bTaskSteps = await ctxB.get(`${API_BASE}/tasks/${taskFixture.taskId}/steps`);
      expect(bTaskSteps.status()).toBe(404);

      const bTaskEvents = await ctxB.get(`${API_BASE}/tasks/${taskFixture.taskId}/events`);
      expect(bTaskEvents.status()).toBe(404);

      const bProviderFetch = await ctxB.get(`${API_BASE}/cli-providers/${providerAId}`);
      expect(bProviderFetch.status()).toBe(404);

      const bSecrets = await ctxB.get(`${API_BASE}/cli-providers/${providerAId}/secrets`);
      expect(bSecrets.status()).toBe(404);

      // --- User B cannot mutate or delete A's resources ---

      const bPatch = await ctxB.patch(`${API_BASE}/cli-providers/${providerAId}`, {
        data: { label: 'hijacked' },
      });
      expect(bPatch.status()).toBe(404);

      const bDelProvider = await ctxB.delete(`${API_BASE}/cli-providers/${providerAId}`);
      expect(bDelProvider.status()).toBe(404);

      const bDelRepo = await ctxB.delete(`${API_BASE}/repos/${repoFixture.repoId}`);
      expect(bDelRepo.status()).toBe(404);

      const bRetryStep = await ctxB.post(
        `${API_BASE}/tasks/${taskFixture.taskId}/steps/failing-step/action`,
        { data: { action: 'retry' } },
      );
      expect(bRetryStep.status()).toBe(404);

      const bSkipStep = await ctxB.post(
        `${API_BASE}/tasks/${taskFixture.taskId}/steps/failing-step/action`,
        { data: { action: 'skip' } },
      );
      expect(bSkipStep.status()).toBe(404);

      const bSubmitStep = await ctxB.post(
        `${API_BASE}/tasks/${taskFixture.taskId}/steps/failing-step/submit`,
        { data: { values: { hijack: true } } },
      );
      expect(bSubmitStep.status()).toBe(404);

      const bTaskAction = await ctxB.post(`${API_BASE}/tasks/${taskFixture.taskId}/action`, {
        data: { action: 'cancel' },
      });
      expect(bTaskAction.status()).toBe(404);

      // --- User A's resources are still intact ---

      const aReposAfter = await ctxA.get(`${API_BASE}/repos`);
      const aReposBody = (await aReposAfter.json()) as {
        repositories: Array<{ id: string }>;
      };
      expect(aReposBody.repositories.map((r) => r.id)).toContain(repoFixture.repoId);

      const aTasksAfter = await ctxA.get(`${API_BASE}/tasks`);
      const aTasksBody = (await aTasksAfter.json()) as {
        tasks: Array<{ id: string; status: string }>;
      };
      const aTaskRow = aTasksBody.tasks.find((t) => t.id === taskFixture!.taskId);
      expect(aTaskRow).toBeDefined();
      expect(aTaskRow!.status).toBe('failed');

      const aProviderAfter = await ctxA.get(`${API_BASE}/cli-providers/${providerAId}`);
      expect(aProviderAfter.status()).toBe(200);
      const aProviderBody = (await aProviderAfter.json()) as {
        provider: { label: string };
      };
      expect(aProviderBody.provider.label).toBe('A Claude Code');

      const aSecretsAfter = await ctxA.get(`${API_BASE}/cli-providers/${providerAId}/secrets`);
      expect(aSecretsAfter.status()).toBe(200);
      const aSecretsBody = (await aSecretsAfter.json()) as {
        secrets: Array<{ secretName: string }>;
      };
      expect(aSecretsBody.secrets.map((s) => s.secretName)).toContain('ANTHROPIC_API_KEY');
    } finally {
      if (taskFixture) await cleanupTaskFixture(sql, taskFixture.taskId);
      if (repoFixture) await cleanupRepoFixture(sql, repoFixture.repoId);
      if (userAId) await cleanupUser(sql, userAId);
      if (userBId) await cleanupUser(sql, userBId);
      await sql.end({ timeout: 5 });
      await ctxA.dispose();
      await ctxB.dispose();
    }
  });
});
