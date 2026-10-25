import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { getOriginUrl, gitRun, taskRemoteUrl } from '../src/repo/git-push.js';

it.each([
  [
    'https://fixture-user:fixture-password@example.test:443/owner/repo?fixture-query#fixture-fragment',
    'https://example.test:443/owner/repo',
  ],
  [
    'ssh://fixture-login:fixture-password@example.test:22/owner/repo?fixture-query#fixture-fragment',
    'ssh://fixture-login@example.test:22/owner/repo',
  ],
])(
  'saves non-secret origin identity without losing authority or SSH login: case %#',
  async (raw, expected) => {
    const root = await mkdtemp(path.join(tmpdir(), 'haive-snapshot-identity-'));
    try {
      await gitRun(root, ['init']);
      await gitRun(root, ['remote', 'add', 'origin', raw!]);
      expect((await getOriginUrl(root)) === expected).toBe(true);
      const db = {
        query: {
          tasks: { findFirst: async () => ({ repositoryId: 'repo' }) },
          repositories: { findFirst: async () => ({ remoteUrl: null }) },
          taskSteps: {
            findMany: async () => [
              {
                stepId: '11a-gate-4-push',
                formValues: { push: true },
                detectOutput: { originUrl: raw },
              },
            ],
          },
        },
      };
      expect(
        (await taskRemoteUrl({ db: db as never, taskId: 'task', userId: 'user' })) === expected,
      ).toBe(true);
      expect(
        (await gitRun(root, ['config', '--get', 'remote.origin.url'])).stdout.trim() === raw,
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
