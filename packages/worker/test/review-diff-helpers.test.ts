import { beforeEach, expect, it, vi } from 'vitest';
import type { StepContext } from '@haive/shared/step';
import { readTextNoFollow } from '@haive/shared/fs-safe';
import { gitExec, gitRun } from '../src/repo/git-exec.js';
import { collectImplementationFiles } from '../src/step-engine/steps/workflow/_impl-changes.js';
import {
  loadDependencyPolicy,
  OWNERSHIP_POLICY_PATH,
} from '../src/step-engine/steps/workflow/_dependency-policy.js';

vi.mock('../src/repo/git-exec.js', () => ({
  gitExec: vi.fn(),
  gitRun: vi.fn(),
  gitGaveNoAnswer: (result: { code: number }) => result.code === -1 || result.code === 124,
}));
vi.mock('../src/step-engine/steps/onboarding/_helpers.js', () => ({
  loadPreviousStepOutput: vi.fn(async (_db, _task, step) => ({
    output: step === '01-worktree-setup' ? { baseBranch: 'main' } : { filesTouched: ['safe'] },
  })),
}));
vi.mock('@haive/shared/fs-safe', async (original) => ({
  ...(await original<typeof import('@haive/shared/fs-safe')>()),
  readTextNoFollow: vi.fn(async () => null),
  lstatNoFollow: vi.fn(async () => null),
}));
const ctx = { db: {}, taskId: 'task' } as StepContext;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(gitExec).mockImplementation(
    async (args) =>
      ({
        stdout: args.includes('status')
          ? ' M safe\0 M denied\0'
          : args.includes('--name-status')
            ? 'M\0safe\0M\0denied\0'
            : args.includes('diff')
              ? ''
              : 'a'.repeat(40),
        stderr: '',
      }) as never,
  );
  vi.mocked(gitRun).mockImplementation(async (_cwd, args) => ({
    code: args.includes('rev-parse') || args.includes('cat-file') ? 1 : 0,
    stdout: args.includes('merge-base') ? 'a'.repeat(40) : '',
    stderr: '',
  }));
});

it('never requests denied patch bytes while retaining the complete path scope', async () => {
  const result = await collectImplementationFiles(ctx, '/repo', {
    denyContent: (p: string) => p === 'denied',
  });
  expect(result.files).toEqual(['safe', 'denied']);
  const patches = vi.mocked(gitExec).mock.calls.filter(([args]) => args.includes('--unified=0'));
  expect(patches).toHaveLength(1);
  expect(patches[0]![0].slice(patches[0]![0].indexOf('--') + 1)).toEqual([':(literal)safe']);
});

it('never requests denied dependency metadata from git or the current manifest', async () => {
  await loadDependencyPolicy(ctx, '/repo', {
    denyContent: (p: string) => [OWNERSHIP_POLICY_PATH, 'composer.json'].includes(p),
  });
  expect(readTextNoFollow).not.toHaveBeenCalled();
  expect(
    vi
      .mocked(gitRun)
      .mock.calls.some(([, args]) =>
        args.some(
          (arg) => arg.endsWith(':' + OWNERSHIP_POLICY_PATH) || arg.endsWith(':composer.json'),
        ),
      ),
  ).toBe(false);
});
