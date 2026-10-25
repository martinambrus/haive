import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { configService } from '@haive/shared';
import { getOriginUrl, gitRun } from '../src/repo/git-push.js';
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
