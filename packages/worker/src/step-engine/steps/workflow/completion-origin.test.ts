import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configService, extractFormDefaults } from '@haive/shared';
import type { StepContext } from '../../step-definition.js';
import * as gitExec from '../../../repo/git-exec.js';
import { OriginUrlError } from '../../../repo/git-push.js';
import { gate4PushStep } from './11a-gate-4-push.js';
import { worktreeCleanupStep } from './12-worktree-cleanup.js';
import { onboardingPushStep } from '../onboarding/13-onboarding-push.js';

vi.mock('../../../project-state/branch-revert.js', async (original) => ({
  ...(await original<typeof import('../../../project-state/branch-revert.js')>()),
  listBranchProjectionEdits: async () => [],
  putBackProjections: async () => [],
  warnStep: async () => undefined,
}));

const exec = promisify(execFile);
const dirs: string[] = [];
async function git(cwd: string, ...args: string[]) {
  return exec('git', args, { cwd });
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setup(kind: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'completion-origin-'));
  dirs.push(root);
  const repo = path.join(root, 'repo');
  const bare = path.join(root, 'bare.git');
  const wt = path.join(root, 'wt');
  await mkdir(repo);
  await git(root, 'init', '--bare', '-b', 'main', bare);
  await git(repo, 'init', '-b', 'main');
  await git(
    repo,
    '-c',
    'user.name=T',
    '-c',
    'user.email=t@example.test',
    'commit',
    '--allow-empty',
    '-m',
    'initial',
  );
  await git(repo, 'worktree', 'add', '-b', 'feature', wt);
  const url = kind === 'git' ? 'git://example.test/repo.git' : kind === 'path' ? bare : 'origin';
  if (kind === 'pushurl-only') await git(repo, 'config', 'remote.origin.pushurl', bare);
  else await git(repo, 'remote', 'add', 'origin', url);
  const output = {
    mode: 'worktree',
    worktreePath: wt,
    branchName: 'feature',
    baseBranch: 'main',
    pushRequested: true,
  };
  const ctx = {
    repoPath: repo,
    workspacePath: wt,
    userId: 'u',
    taskId: 't',
    taskStepId: 's',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    db: {
      select: () => ({
        from: () => ({
          where: () => ({ orderBy: () => ({ limit: async () => [{ output, iterations: [] }] }) }),
        }),
      }),
      query: {
        tasks: { findFirst: async () => ({ repositoryId: null }) },
        repoCredentials: { findMany: async () => [] },
      },
    },
  } as unknown as StepContext;
  vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
  return { ctx, bare, reason: new OriginUrlError(url).message };
}

const steps = [gate4PushStep, worktreeCleanupStep, onboardingPushStep] as const;
for (const step of steps) {
  describe(`${step.metadata.id} refused origin completion`, () => {
    it.each(['path', 'git', 'pushurl-only'])(
      'completes with the %s refusal recorded and no transport',
      async (kind) => {
        const { ctx, bare, reason } = await setup(kind);
        const run = vi.spyOn(gitExec, 'gitRun');
        const detected = (await step.detect!(ctx)) as never;
        expect(detected).toMatchObject({ hasOrigin: false, originUrl: null, originError: reason });
        const form = await step.form!(ctx, detected);
        expect(form!.fields).toContainEqual(
          expect.objectContaining({
            id: 'originError',
            variant: 'warning',
            body: expect.stringContaining(reason),
          }),
        );
        expect(
          form!.fields.some(
            (f) =>
              f.id === 'push' ||
              (f.id === 'pushBase' && f.type === 'checkbox' && f.default === true),
          ),
        ).toBe(false);
        const values =
          step === worktreeCleanupStep ? { action: 'keep' } : extractFormDefaults(form!);
        const result = await step.apply!(ctx, {
          detected,
          formValues: values,
          iteration: 0,
          previousIterations: [],
          llmOutput: null,
        } as never);
        if (step !== worktreeCleanupStep)
          expect(result).toMatchObject({ pushed: false, message: expect.stringContaining(reason) });
        expect(
          run.mock.calls.some(([, args]) =>
            args.some((a) => ['push', 'pull', 'fetch', 'ls-remote'].includes(a)),
          ),
        ).toBe(false);
        expect((await git(bare, 'for-each-ref', '--format=%(refname)')).stdout).toBe('');
      },
    );
  });
}
