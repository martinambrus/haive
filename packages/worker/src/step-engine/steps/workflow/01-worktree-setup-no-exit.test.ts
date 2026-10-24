import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { configService } from '@haive/shared';
import { worktreeSetupStep } from './01-worktree-setup.js';
import type { StepApplyArgs, StepContext } from '../../step-definition.js';
import { killGit, type KilledGit } from '../../../../test/support/kill-git.js';

const exec = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};
const logger = { info: () => {}, warn: () => {}, error: () => {} };
const NOTE_ID = 'currentBranchUnreadable';

const roots: string[] = [];
let shim: KilledGit | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  await shim?.restore();
  shim = null;
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

async function git(dir: string, args: string[]): Promise<void> {
  await exec('git', args, { cwd: dir, env: GIT_ENV });
}

async function mkRepo(commit: boolean): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'wt-setup-noexit-'));
  roots.push(root);
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'gc.auto', '0']);
  if (commit) {
    await writeFile(path.join(root, 'f.txt'), 'one\n', 'utf8');
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-m', 'one']);
  }
  return root;
}

function mkCtx(root: string, syncRows: unknown[] = []): StepContext {
  return {
    taskId: 'task1',
    userId: 'u1',
    repoPath: root,
    sandboxWorkdir: '/haive/workdir',
    logger,
    db: {
      query: {
        tasks: {
          findFirst: async () => ({
            title: 'Add DDEV',
            description: null,
            metadata: null,
            repositoryId: 'r1',
          }),
        },
      },
      select: () => ({
        from: () => ({
          where: () => ({ orderBy: () => ({ limit: async () => syncRows }) }),
        }),
      }),
    } as unknown as Database,
  } as unknown as StepContext;
}

const DEVELOP_ROW = [{ detectOutput: null, output: { base: 'develop' }, iterations: [] }];

type Detect = NonNullable<Awaited<ReturnType<NonNullable<typeof worktreeSetupStep.detect>>>>;

function notes(ctx: StepContext, d: Detect) {
  const form = worktreeSetupStep.form!(ctx, d)!;
  return form.fields.filter((f) => f.id === NOTE_ID) as {
    type: string;
    variant?: string;
    body?: string;
  }[];
}

describe('01 worktree setup: a branch read that gave no answer', () => {
  it('records why and warns on the form when no earlier step recorded a base', async () => {
    const root = await mkRepo(true);
    shim = await killGit(['rev-parse', '--abbrev-ref', 'HEAD']);
    const ctx = mkCtx(root);
    const d = await worktreeSetupStep.detect!(ctx);
    expect(d.currentBranch).toBeNull();
    expect(d.currentBranchError).toMatch(/could not read the checkout's current branch/);
    const found = notes(ctx, d);
    expect(found).toHaveLength(1);
    expect(found[0]!.type).toBe('note');
    expect(found[0]!.variant).toBe('warning');
    expect(found[0]!.body).toContain(d.currentBranchError!);
  });

  it('keeps the error in detect but shows no note when 00a recorded a base', async () => {
    const root = await mkRepo(true);
    shim = await killGit(['rev-parse', '--abbrev-ref', 'HEAD']);
    const ctx = mkCtx(root, DEVELOP_ROW);
    const d = await worktreeSetupStep.detect!(ctx);
    expect(d.syncedBase).toBe('develop');
    expect(d.currentBranchError).toMatch(/could not read the checkout's current branch/);
    expect(notes(ctx, d)).toHaveLength(0);
  });

  it('negative control: a healthy read has the branch, no error, no note', async () => {
    const root = await mkRepo(true);
    const ctx = mkCtx(root);
    const d = await worktreeSetupStep.detect!(ctx);
    expect(d.currentBranch).toBe('main');
    expect(d.currentBranchError ?? null).toBeNull();
    expect(notes(ctx, d)).toHaveLength(0);
  });

  it('negative control: an unborn HEAD (plain exit) stays unknown without an error or note', async () => {
    const root = await mkRepo(false);
    const ctx = mkCtx(root);
    const d = await worktreeSetupStep.detect!(ctx);
    expect(d.currentBranch).toBeNull();
    expect(d.currentBranchError ?? null).toBeNull();
    expect(notes(ctx, d)).toHaveLength(0);
  });

  it('negative control: a stored detect without the field renders its form without the note', async () => {
    const root = await mkRepo(true);
    const ctx = mkCtx(root);
    const d = await worktreeSetupStep.detect!(ctx);
    delete d.currentBranchError;
    expect(() => worktreeSetupStep.form!(ctx, d)).not.toThrow();
    expect(notes(ctx, d)).toHaveLength(0);
  });
});

const UNREADABLE = "could not read the checkout's current branch: x";

function mkApplyCtx(root: string): StepContext {
  return {
    taskId: 'task1',
    userId: 'u1',
    repoPath: root,
    sandboxWorkdir: '/haive/workdir',
    logger,
    db: {
      query: {
        tasks: {
          findFirst: async (args?: { columns?: Record<string, boolean> }) =>
            args?.columns?.id
              ? null
              : { title: 'Add DDEV', description: null, metadata: null, repositoryId: 'r1' },
        },
        repositories: { findFirst: async () => null },
      },
      select: () => ({
        from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }),
      }),
      update: (table: unknown) => {
        if (table !== schema.tasks) throw new Error('01 wrote to a table other than tasks');
        return { set: () => ({ where: async () => {} }) };
      },
    } as unknown as Database,
  } as unknown as StepContext;
}

function applyArgs(
  detected: Record<string, unknown>,
  formValues: Record<string, unknown> = {},
): StepApplyArgs<Detect> {
  return {
    detected: {
      hasGit: true,
      currentBranch: null,
      syncedBase: null,
      isClean: true,
      proposedBranch: 'feature/x',
      proposalBumpedFrom: null,
      ...detected,
    },
    formValues: { branchName: 'feature/x', ...formValues },
    iteration: 0,
    previousIterations: [],
  } as unknown as StepApplyArgs<Detect>;
}

async function gitOut(dir: string, args: string[]): Promise<string> {
  return (await exec('git', args, { cwd: dir, env: GIT_ENV })).stdout.trim();
}

async function expectNothingCreated(root: string): Promise<void> {
  const list = await gitOut(root, ['worktree', 'list', '--porcelain']);
  expect(list.split('\n').filter((l) => l.startsWith('worktree '))).toHaveLength(1);
  await expect(stat(path.join(root, '.haive', 'worktrees'))).rejects.toThrow();
  expect(await gitOut(root, ['branch', '--list', 'feature/x'])).toBe('');
}

describe('01 worktree setup apply: a base that cannot be told', () => {
  it('R1: refuses to guess main when the read gave no answer and no base was recorded', async () => {
    const root = await mkRepo(true);
    await expect(
      worktreeSetupStep.apply(mkApplyCtx(root), applyArgs({ currentBranchError: UNREADABLE })),
    ).rejects.toThrow(/recorded no base branch/);
    await expectNothingCreated(root);
  });

  it('R2: the form no longer promises a branch from main', async () => {
    const root = await mkRepo(true);
    const ctx = mkCtx(root);
    const d = {
      hasGit: true,
      currentBranch: null,
      currentBranchError: UNREADABLE,
      syncedBase: null,
      isClean: true,
      proposedBranch: 'feature/x',
      proposalBumpedFrom: null,
    } as unknown as Detect;
    const form = worktreeSetupStep.form!(ctx, d)!;
    const body = notes(ctx, d)[0]!.body!;
    expect(body).not.toContain('branched from main');
    expect(body).toContain(UNREADABLE);
    expect(body).toContain('recorded no base branch');
    expect(form.description).not.toContain('main');
    expect(form.description).toContain('not known');
  });

  it('R3: a real unreadable detect, applied, refuses with the same text', async () => {
    const root = await mkRepo(true);
    shim = await killGit(['rev-parse', '--abbrev-ref', 'HEAD']);
    const d = await worktreeSetupStep.detect!(mkCtx(root));
    expect(d.currentBranchError).toBeTruthy();
    await expect(
      worktreeSetupStep.apply(mkApplyCtx(root), applyArgs(d as unknown as Record<string, unknown>)),
    ).rejects.toThrow(/recorded no base branch/);
    await expectNothingCreated(root);
  });

  it('N1: a recorded base is used even when the branch read failed', async () => {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    const root = await mkRepo(true);
    await git(root, ['branch', 'develop']);
    const out = await worktreeSetupStep.apply(
      mkApplyCtx(root),
      applyArgs({ syncedBase: 'develop', currentBranchError: UNREADABLE }),
    );
    expect(out.baseBranch).toBe('develop');
    expect(await gitOut(root, ['worktree', 'list'])).toContain('feature/x');
  });

  it('N2: a legacy form baseBranch is used even when the branch read failed', async () => {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    const root = await mkRepo(true);
    await git(root, ['branch', 'develop']);
    const out = await worktreeSetupStep.apply(
      mkApplyCtx(root),
      applyArgs({ currentBranchError: UNREADABLE }, { baseBranch: 'develop' }),
    );
    expect(out.baseBranch).toBe('develop');
  });

  it('N3: a healthy read forks from the current branch', async () => {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    const root = await mkRepo(true);
    const out = await worktreeSetupStep.apply(
      mkApplyCtx(root),
      applyArgs({ currentBranch: 'main' }),
    );
    expect(out.baseBranch).toBe('main');
    expect(await gitOut(root, ['worktree', 'list'])).toContain('feature/x');
  });

  it('N4: a plain-exit unknown (unborn HEAD) keeps falling back to main', async () => {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    const root = await mkRepo(false);
    const err = await worktreeSetupStep
      .apply(mkApplyCtx(root), applyArgs({ currentBranchError: null }))
      .then(
        () => '',
        (e: Error) => e.message,
      );
    expect(err).not.toMatch(/recorded no base branch/);
  });
});
