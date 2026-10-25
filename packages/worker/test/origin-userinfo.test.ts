import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { configService } from '@haive/shared';
import {
  buildCredentialHelper,
  getOriginUrl,
  gitRun,
  taskRemoteUrl,
} from '../src/repo/git-push.js';
import { gate4PushStep } from '../src/step-engine/steps/workflow/11a-gate-4-push.js';
import { worktreeCleanupStep } from '../src/step-engine/steps/workflow/12-worktree-cleanup.js';
vi.mock('../src/project-state/branch-revert.js', async (original) => ({
  ...(await original<typeof import('../src/project-state/branch-revert.js')>()),
  listBranchProjectionEdits: async () => [],
}));

it('returns an origin safe for step output without changing the transport address', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haive-origin-userinfo-'));
  try {
    await gitRun(root, ['init']);
    const raw = 'https://fixture-user:fixture-password@example.test/owner/repo.git';
    await gitRun(root, ['remote', 'add', 'origin', raw]);
    expect((await getOriginUrl(root)) === 'https://example.test/owner/repo.git').toBe(true);
    expect(
      (await gitRun(root, ['config', '--get', 'remote.origin.url'])).stdout.trim() === raw,
    ).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each([gate4PushStep, worktreeCleanupStep])(
  'keeps userinfo out of $metadata.id detect and form output',
  async (step) => {
    const root = await mkdtemp(path.join(tmpdir(), 'haive-step-userinfo-'));
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    try {
      await gitRun(root, ['init', '-b', 'main']);
      await gitRun(root, [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit',
        '--allow-empty',
        '-m',
        'seed',
      ]);
      await gitRun(root, [
        'remote',
        'add',
        'origin',
        'https://fixture-user:fixture-password@example.test/owner/repo.git',
      ]);
      const output = {
        mode: 'worktree',
        worktreePath: root,
        branchName: 'main',
        baseBranch: 'main',
      };
      const ctx = {
        repoPath: root,
        workspacePath: root,
        taskId: 'task',
        userId: 'user',
        logger: { warn: vi.fn() },
        db: {
          select: () => ({
            from: () => ({
              where: () => ({ orderBy: () => ({ limit: async () => [{ output }] }) }),
            }),
          }),
          query: {
            tasks: { findFirst: async () => ({ repositoryId: null }) },
            repoCredentials: { findMany: async () => [] },
          },
        },
      } as never;
      const detected = await step.detect!(ctx);
      const form = await step.form!(ctx, detected as never);
      expect(JSON.stringify({ detected, form }).includes('fixture-password')).toBe(false);
      expect(JSON.stringify({ detected, form }).includes('fixture-user')).toBe(false);
    } finally {
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  },
);

vi.mock('../src/repo/credentials.js', () => ({
  getDecryptedCredentials: async () => ({
    username: 'fixture-user',
    secret: 'fixture-password',
    host: 'example.test',
  }),
}));
it.each(['https://example.test:443/owner/repo.git', 'http://example.test:80/owner/repo.git'])(
  'binds the detected and approved local-path URL to Git default-port scope: %s',
  async (raw) => {
    const root = await mkdtemp(path.join(tmpdir(), 'haive-port-binding-'));
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    try {
      await gitRun(root, ['init', '-b', 'main']);
      await gitRun(root, ['remote', 'add', 'origin', raw]);
      const db = {
        select: () => ({
          from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }),
        }),
        query: {
          tasks: { findFirst: async () => ({ repositoryId: 'repo' }) },
          repositories: { findFirst: async () => ({ remoteUrl: null }) },
          repoCredentials: { findMany: async () => [] },
          taskSteps: {
            findMany: async () => [
              { stepId: '11a-gate-4-push', formValues: { push: true }, detectOutput: detected },
            ],
          },
        },
      };
      const ctx = {
        repoPath: root,
        workspacePath: root,
        taskId: 'task',
        userId: 'user',
        db,
        logger: { warn: vi.fn() },
      } as never;
      const detected = await gate4PushStep.detect!(ctx);
      const form = await gate4PushStep.form!(ctx, detected as never);
      expect(JSON.stringify(form)).toContain('example.test');
      const remote = await taskRemoteUrl(ctx);
      expect(remote === raw).toBe(true);
      const auth = await buildCredentialHelper(db as never, 'cred', 'user', remote);
      const res = await gitRun(
        root,
        [...auth.argv, 'credential', 'fill'],
        { ...auth.env, GIT_TERMINAL_PROMPT: '0' },
        { input: Buffer.from(`url=${raw}\n\n`) },
      );
      expect(res.code === 0).toBe(true);
      expect(res.stdout.includes('password=fixture-password')).toBe(true);
    } finally {
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  },
);
