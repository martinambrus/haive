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
import * as gitPush from '../../../repo/git-push.js';
import { gate4PushStep } from './11a-gate-4-push.js';
import { worktreeCleanupStep } from './12-worktree-cleanup.js';
import { onboardingPushStep } from '../onboarding/13-onboarding-push.js';

vi.mock('../../../project-state/branch-revert.js', async (original) => ({
  ...(await original<typeof import('../../../project-state/branch-revert.js')>()),
  listBranchProjectionEdits: async () => [],
  projectionRevertNotes: async () => [],
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
  const url =
    kind === 'userinfo'
      ? 'git://sensitive-user:sensitive-password@example.test/repo.git?sensitive-query#sensitive-fragment'
      : kind === 'git'
        ? 'git://example.test/repo.git'
        : kind === 'path'
          ? bare
          : 'origin';
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
        taskSteps: { findFirst: async () => ({ mergeResolveState: null }) },
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
    it.each(
      ['path', 'git', 'pushurl-only', 'userinfo'].flatMap((kind) =>
        (step === worktreeCleanupStep ? ['keep', 'merge_remove'] : ['keep']).map((action) => ({
          kind,
          action,
        })),
      ),
    )(
      'completes $action with the $kind refusal recorded and no transport',
      async ({ kind, action }) => {
        const { ctx, bare, reason } = await setup(kind);
        const run = vi.spyOn(gitExec, 'gitRun');
        const originRun = vi.spyOn(gitPush, 'originGitRun');
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
        if (step === worktreeCleanupStep) {
          for (const id of ['pushBase', 'credentialId', 'setUpstream'])
            expect(form!.fields.map((f) => f.id)).not.toContain(id);
        } else {
          expect(
            form!.fields.some(
              (f) =>
                f.id === 'push' ||
                (f.id === 'pushBase' && f.type === 'checkbox' && f.default === true),
            ),
          ).toBe(false);
        }
        const values = step === worktreeCleanupStep ? { action } : extractFormDefaults(form!);
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
        expect(originRun).not.toHaveBeenCalled();
        if (kind === 'userinfo') {
          for (const text of [
            JSON.stringify(form),
            JSON.stringify(detected),
            JSON.stringify(result),
          ]) {
            for (const secret of [
              'sensitive-user',
              'sensitive-password',
              'sensitive-query',
              'sensitive-fragment',
            ])
              expect(text).not.toContain(secret);
          }
        }
        expect((await git(bare, 'for-each-ref', '--format=%(refname)')).stdout).toBe('');
      },
    );
  });
}

it('explains that a cross-branch merge stays local when an existing origin is refused', async () => {
  const { ctx, reason } = await setup('git');
  const detected = await worktreeCleanupStep.detect!(ctx);
  const form = await worktreeCleanupStep.form!(ctx, { ...detected, parentBranch: 'other' });
  const note = form!.fields.find((f) => f.id === 'branchMismatchNote');
  expect(note).toMatchObject({
    type: 'note',
    variant: 'warning',
    body: expect.stringContaining('origin exists but its URL is refused'),
  });
  expect(note).toHaveProperty('body', expect.stringContaining('Retry this step'));
  expect(note).toHaveProperty('body', expect.stringContaining(reason));
});
