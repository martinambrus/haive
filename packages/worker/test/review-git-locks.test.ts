import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { logger } from '@haive/shared/logger';
import type { StepContext } from '@haive/shared/step';
import { createStepHostServices } from '../src/step-engine/step-host-services.js';
import { collectImplementationFiles } from '../src/step-engine/steps/workflow/_impl-changes.js';
import { loadDependencyPolicy } from '../src/step-engine/steps/workflow/_dependency-policy.js';
import { gitExec, gitRun } from '../src/repo/git-exec.js';
import { loadPreviousStepOutput } from '../src/step-engine/steps/onboarding/_helpers.js';

vi.mock('../src/step-engine/steps/onboarding/_helpers.js', () => ({
  loadPreviousStepOutput: vi.fn(),
}));
vi.mock('../src/step-engine/review-dimension-context.js', () => ({
  resolveTaskReviewDimensions: vi.fn(async () => ({ enabled: [] })),
}));
vi.mock('../src/queues/cli-exec/secret-mask.js', async () => {
  const { secretMaskPolicy } = await import('../src/queues/cli-exec/secret-mask-policy.js');
  return { taskSecretMaskPolicy: vi.fn(async () => secretMaskPolicy({})) };
});
vi.mock('../src/repo/git-exec.js', () => ({
  gitRun: vi.fn(),
  gitExec: vi.fn(),
  gitGaveNoAnswer: () => false,
}));
const sha = 'a'.repeat(40);
const diff = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n';
let root: string;
let ctx: StepContext;
beforeEach(async () => {
  vi.clearAllMocks();
  root = await mkdtemp(join(tmpdir(), 'review-git-locks-'));
  await mkdir(join(root, 'worktree/nested/.git'), { recursive: true });
  const worktree = join(root, 'worktree');
  await writeFile(join(worktree, 'a'), 'new\n');
  vi.mocked(loadPreviousStepOutput).mockResolvedValue({
    id: 'row',
    stepId: '01-worktree-setup',
    status: 'done',
    round: 0,
    detect: null,
    output: { baseBranch: 'base', filesTouched: ['a'] },
    iterations: [],
  });
  vi.mocked(gitExec).mockImplementation(async (args) => ({
    stdout: args.includes('status')
      ? '?? nested/\0 M a\0'
      : args.includes('merge-base') || args.includes('rev-parse')
        ? sha
        : args.includes('--name-status')
          ? 'M\0a\0'
          : diff,
    stderr: '',
  }));
  vi.mocked(gitRun).mockImplementation(async (_cwd, args) => {
    const absent =
      args.includes('show') ||
      args.includes('cat-file') ||
      (args.includes('rev-parse') && args.some((a) => a.startsWith(sha + ':')));
    return {
      code: absent ? 1 : 0,
      stderr: '',
      stdout: absent
        ? ''
        : args.includes('merge-base') || args.includes('rev-parse')
          ? sha
          : args.includes('--name-status')
            ? 'M\0a\0'
            : args.includes('--others')
              ? 'nested/\0'
              : args.includes('ls-files')
                ? ''
                : diff,
    };
  });
  ctx = {
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
    logger: logger.child({ test: 'review-locks' }),
    throwIfCancelled() {},
    async emitProgress() {},
  };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it.each(['review-diff', 'host-collector', 'built-in'])(
  'disables optional locks on every git read through %s, including helper chains and nested HEAD',
  async (entry) => {
    const worktree = ctx.workspacePath;
    if (entry === 'review-diff') {
      expect(
        await createStepHostServices(ctx).readReviewDiff({
          worktreePath: worktree,
          maxBytes: 10000,
        }),
      ).toMatchObject({ status: 'ready' });
    } else if (entry === 'host-collector') {
      expect(await createStepHostServices(ctx).collectImplementationFiles(worktree)).toMatchObject({
        scanError: null,
      });
    } else {
      expect(await collectImplementationFiles(ctx, worktree)).toMatchObject({ scanError: null });
      await loadDependencyPolicy(ctx, worktree);
    }
    const calls = [
      ...vi.mocked(gitExec).mock.calls.map(([args]) => args),
      ...vi.mocked(gitRun).mock.calls.map(([, args]) => args),
    ];
    expect(calls.some((args) => args.includes('--git-dir=.git'))).toBe(true);
    if (entry !== 'host-collector') {
      expect(calls.some((args) => args.includes('show'))).toBe(true);
      expect(calls.some((args) => args.includes('cat-file'))).toBe(true);
      expect(calls.some((args) => args.includes('-q'))).toBe(true);
    }
    expect(calls.filter((args) => args[0] !== '--no-optional-locks')).toEqual([]);
  },
);

it('disables optional locks on HEAD fallbacks without a recorded base', async () => {
  vi.mocked(loadPreviousStepOutput).mockResolvedValue({
    id: 'row',
    stepId: '01-worktree-setup',
    status: 'done',
    round: 0,
    detect: null,
    output: { filesTouched: ['a'] },
    iterations: [],
  });
  await collectImplementationFiles(ctx, ctx.workspacePath);
  await loadDependencyPolicy(ctx, ctx.workspacePath);
  for (const [args] of vi.mocked(gitExec).mock.calls) expect(args[0]).toBe('--no-optional-locks');
  for (const [, args] of vi.mocked(gitRun).mock.calls) expect(args[0]).toBe('--no-optional-locks');
});
