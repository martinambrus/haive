import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { logger } from '@haive/shared/logger';
import type { StepContext } from '@haive/shared/step';
import { createStepHostServices } from '../src/step-engine/step-host-services.js';
import { gitRun } from '../src/repo/git-exec.js';

vi.mock('../src/step-engine/steps/onboarding/_helpers.js', () => ({
  loadPreviousStepOutput: vi.fn(async () => ({ output: { baseBranch: 'base' } })),
}));
vi.mock('../src/step-engine/steps/workflow/_impl-changes.js', () => ({
  collectImplementationFiles: vi.fn(async () => ({
    files: ['a'],
    total: 1,
    truncated: false,
    scanError: null,
  })),
}));
vi.mock('../src/step-engine/steps/workflow/_dependency-policy.js', () => ({
  loadDependencyPolicy: vi.fn(async () => ({})),
}));
vi.mock('../src/step-engine/review-dimension-context.js', () => ({
  resolveTaskReviewDimensions: vi.fn(async () => ({ enabled: [] })),
}));
vi.mock('../src/queues/cli-exec/secret-mask.js', async () => {
  const { secretMaskPolicy } = await import('../src/queues/cli-exec/secret-mask-policy.js');
  return { taskSecretMaskPolicy: vi.fn(async () => secretMaskPolicy({})) };
});
vi.mock('../src/repo/git-exec.js', () => ({ gitRun: vi.fn() }));
let root: string;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

it.each(['before-files', 'after-files'])(
  'refuses a worktree renamed and replaced %s after host binding',
  async (when) => {
    root = await mkdtemp(join(tmpdir(), 'review-worktree-'));
    const worktree = join(root, 'worktree');
    await mkdir(worktree);
    await writeFile(join(worktree, 'a'), 'original\n');
    let replaced = false;
    vi.mocked(gitRun).mockImplementation(async (cwd, args) => {
      expect(cwd).toMatch(/^\/proc\/self\/fd\/\d+$/);
      if (!replaced && args.includes(when === 'before-files' ? '--stage' : '--full-index')) {
        replaced = true;
        await rename(worktree, join(root, 'held-worktree'));
        await mkdir(worktree);
        await writeFile(join(worktree, 'a'), 'replacement\n');
      }
      return {
        code: 0,
        stderr: '',
        stdout: args.includes('merge-base')
          ? 'a'.repeat(40)
          : args.includes('--name-status')
            ? 'M\0a\0'
            : args.includes('ls-files')
              ? ''
              : 'diff\n+original\n',
      };
    });
    const ctx = {
      taskId: 'task',
      taskStepId: 'step',
      userId: 'user',
      round: 0,
      repoPath: root,
      workspacePath: worktree,
      sandboxWorkdir: '/workspace',
      cliProviderId: null,
      signal: new AbortController().signal,
      db: {
        query: {
          tasks: {
            findFirst: async () => ({ userId: 'user', currentRound: 0, worktreePath: worktree }),
          },
          taskSteps: { findFirst: async () => ({ taskId: 'task', round: 0 }) },
        },
      } as unknown as Database,
      logger,
      throwIfCancelled() {},
      async emitProgress() {},
    } satisfies StepContext;
    const result = await createStepHostServices(ctx).readReviewDiff({
      worktreePath: worktree,
      maxBytes: 4096,
      includeFileContents: true,
    });
    expect(replaced).toBe(true);
    expect(result).toMatchObject({ status: 'unavailable' });
  },
);
