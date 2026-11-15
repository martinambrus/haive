import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { gitExec } from '../src/repo/git-exec.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import type { StepContext } from '@haive/shared/step';
import { logger } from '@haive/shared/logger';
import {
  createStepHostServices,
  StepHostBindingError,
} from '../src/step-engine/step-host-services.js';
import { collectImplementationFiles } from '../src/step-engine/steps/workflow/_impl-changes.js';
vi.mock('../src/step-engine/steps/workflow/_impl-changes.js', () => ({
  collectImplementationFiles: vi.fn(async () => ({ files: [] })),
}));
let root: string, tree: string, ctx: StepContext;
let pointer: { worktreePath?: string | null; worktreeBranch?: string | null };
let latest: { status?: string; output?: unknown };
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'sp3-binding-'));
  tree = join(root, '.haive/worktrees/task');
  mkdirSync(tree, { recursive: true });
  execFileSync('/usr/bin/git', ['init', '-q', tree]);
  symlinkSync(tree, join(root, 'link'));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  vi.clearAllMocks();
  pointer = { worktreePath: tree };
  latest = { status: 'done', output: { worktreePath: tree } };
  ctx = {
    taskId: 'task',
    taskStepId: 'step',
    userId: 'user',
    round: 2,
    repoPath: root,
    workspacePath: root,
    sandboxWorkdir: '/workspace',
    cliProviderId: null,
    db: {
      query: {
        tasks: { findFirst: vi.fn(async () => ({ userId: 'user', currentRound: 2, ...pointer })) },
        taskSteps: {
          findFirst: vi.fn(async (q) => (q.columns ? latest : { taskId: 'task', round: 2 })),
        },
      },
    } as unknown as Database,
    logger: logger.child({ test: 'binding' }),
    signal: new AbortController().signal,
    throwIfCancelled() {},
    async emitProgress() {},
  };
});
it('binds the repository root when the latest 01 is skipped despite a recorded worktree', async () => {
  latest.status = 'skipped';
  await createStepHostServices(ctx).collectImplementationFiles(root);
  expect(collectImplementationFiles).toHaveBeenCalledWith(
    expect.anything(),
    root,
    expect.anything(),
  );
});
it.each(['outside', 'link', 'missing'])('normalizes a real %s directory refusal', async (kind) => {
  pointer.worktreePath = kind === 'outside' ? join(root, '..', 'outside') : join(root, kind);
  await expect(
    createStepHostServices(ctx).collectImplementationFiles(pointer.worktreePath!),
  ).rejects.toBeInstanceOf(StepHostBindingError);
  expect(collectImplementationFiles).not.toHaveBeenCalled();
});
it.each(['column path', 'column branch', 'setup output', 'root'])(
  'uses the canonical %s decision',
  async (kind) => {
    pointer = {};
    latest = {};
    if (kind === 'column path') pointer.worktreePath = tree;
    if (kind === 'column branch') pointer.worktreeBranch = 'task';
    if (kind === 'setup output') latest.output = { worktreePath: tree };
    const expected = kind === 'root' ? root : tree;
    await createStepHostServices(ctx).collectImplementationFiles(expected);
    expect(collectImplementationFiles).toHaveBeenCalledWith(
      expect.anything(),
      expected,
      expect.anything(),
    );
  },
);

vi.mock('../src/queues/cli-exec/secret-mask.js', () => ({ taskSecretMaskPolicy: vi.fn() }));

vi.mock('../src/step-engine/steps/onboarding/_helpers.js', () => ({
  loadPreviousStepOutput: vi.fn(async () => ({ output: latest.output })),
}));

it('keeps git in the held worktree after its path is replaced, then closes the descriptor', async () => {
  let gitCwd: string | undefined;
  vi.mocked(collectImplementationFiles).mockImplementationOnce(async (_ctx, _path, options) => {
    gitCwd = (options as { gitCwd?: string })?.gitCwd;
    renameSync(tree, tree + '-moved');
    mkdirSync(tree);
    try {
      const result = await gitExec(['rev-parse', '--show-toplevel'], { cwd: gitCwd ?? tree });
      expect(result.stdout.trim()).toBe(tree + '-moved');
      return { files: [], total: 0, truncated: false, scanError: null };
    } finally {
      rmSync(tree, { recursive: true, force: true });
      renameSync(tree + '-moved', tree);
    }
  });
  await createStepHostServices(ctx).collectImplementationFiles(tree);
  expect(gitCwd).toMatch(/^\/proc\/self\/fd\/\d+$/);
  await expect(gitExec(['rev-parse', '--show-toplevel'], { cwd: gitCwd })).rejects.toBeDefined();
});
