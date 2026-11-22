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
const ctx = {
  db: { query: { tasks: { findFirst: async () => undefined } } },
  taskId: 'task',
} as unknown as StepContext;
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
    stdout: args.includes('merge-base')
      ? 'a'.repeat(40)
      : args.includes('show')
        ? JSON.stringify({ ownedPaths: [] })
        : '',
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

it('uses the held cwd for every collector and dependency git command', async () => {
  const gitCwd = '/proc/self/fd/42';
  await collectImplementationFiles(ctx, '/repo', { gitCwd, denyContent: () => false });
  for (const [, options] of vi.mocked(gitExec).mock.calls) expect(options?.cwd).toBe(gitCwd);
  await loadDependencyPolicy(ctx, '/repo', { gitCwd });
  for (const [cwd] of vi.mocked(gitRun).mock.calls) expect(cwd).toBe(gitCwd);
});

it.each(['EMFILE', 'ENFILE'])(
  'preserves %s at every collector read for host review only',
  async (code) => {
    const normal = vi.mocked(gitExec).getMockImplementation()!;
    const stages = [
      (args: string[]) => args.includes('status'),
      (args: string[]) => args.includes('merge-base'),
      (args: string[]) => args.includes('--unified=0'),
      (args: string[]) => args.includes('--name-status') && args.includes('HEAD'),
      (args: string[]) => args.includes('--name-status') && !args.includes('HEAD'),
    ];
    for (const stage of stages) {
      const error = Object.assign(new Error(code), { code });
      vi.mocked(gitExec).mockImplementation((args, io) =>
        stage(args) ? Promise.reject(error) : normal(args, io),
      );
      await expect(
        collectImplementationFiles(ctx, '/repo', {
          propagateResourceErrors: true,
        } as never),
      ).rejects.toBe(error);
      await expect(collectImplementationFiles(ctx, '/repo')).resolves.toBeDefined();
    }
  },
);

it.each(['EMFILE', 'ENFILE'])(
  'preserves %s at every dependency git read for host review only',
  async (code) => {
    const normal = vi.mocked(gitRun).getMockImplementation()!;
    for (const stage of [
      'merge-base',
      OWNERSHIP_POLICY_PATH,
      'composer.json',
      'cat-file',
      'rev-parse',
    ]) {
      vi.mocked(gitRun).mockImplementation((cwd, args, env, io) =>
        args.some((arg) => arg === stage || arg.endsWith(':' + stage))
          ? Promise.resolve({ code: -1, noExit: code, stdout: '', stderr: '' })
          : normal(cwd, args, env, io),
      );
      await expect(
        loadDependencyPolicy(ctx, '/repo', {
          propagateResourceErrors: true,
        } as never),
      ).rejects.toMatchObject({ code });
      await expect(loadDependencyPolicy(ctx, '/repo')).rejects.not.toHaveProperty('code');
    }
  },
);
