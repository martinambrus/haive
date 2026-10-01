import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { configService } from '@haive/shared';
import { ensureGitExcludeEntry } from '../src/repo/git-init.js';
import { WORKTREE_SUBDIR, worktreeDirName } from '../src/repo/worktree-paths.js';
import { worktreeSetupStep } from '../src/step-engine/steps/workflow/01-worktree-setup.js';
import type { StepApplyArgs, StepContext } from '../src/step-engine/step-definition.js';

const repair = vi.hoisted(() => ({ failWith: null as Error | null }));

vi.mock('../src/repo/worktree-permissions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/repo/worktree-permissions.js')>();
  return {
    ...actual,
    ensureSandboxWritableTree: (...args: Parameters<typeof actual.ensureSandboxWritableTree>) =>
      repair.failWith ? Promise.reject(repair.failWith) : actual.ensureSandboxWritableTree(...args),
  };
});

const run = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

type Detected = Awaited<ReturnType<NonNullable<typeof worktreeSetupStep.detect>>>;

/** True on a detect whose proposal is the task's own recorded branch. Optional: a detect output
 *  persisted before the flag existed lacks it, and that must read as false. */
const ownFlag = (d: Detected) =>
  (d as Detected & { proposalIsOwnBranch?: boolean }).proposalIsOwnBranch;

const todaysCopy = (base: string, clean: boolean) =>
  `Base branch: ${base}. Working tree ${clean ? 'clean' : 'dirty'}. A new worktree will be created inside the repo at .haive/worktrees/<branch>, branched from ${base}.`;

interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  metadata: unknown;
  repositoryId: string | null;
  worktreeBranch: string | null;
  worktreePath: string | null;
}

const roots: string[] = [];

afterEach(async () => {
  repair.failWith = null;
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function git(dir: string, args: string[]): Promise<string> {
  return (await run('git', args, { cwd: dir, env: GIT_ENV })).stdout.trim();
}

async function setupRepo(): Promise<string> {
  // git reports a worktree by its realpath and apply compares that string.
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'wt-retry-')));
  roots.push(root);
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'gc.auto', '0']);
  await writeFile(path.join(root, 'f.txt'), 'one\n', 'utf8');
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-m', 'one']);
  return root;
}

async function worktreePaths(root: string): Promise<string[]> {
  const list = await git(root, ['worktree', 'list', '--porcelain']);
  return list
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length))
    .sort();
}

function freshTask(over: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 'task1',
    title: 'Add DDEV',
    description: null,
    metadata: null,
    repositoryId: 'r1',
    worktreeBranch: null,
    worktreePath: null,
    ...over,
  };
}

async function addWorktree(root: string, branch: string): Promise<string> {
  await ensureGitExcludeEntry(root);
  const worktreePath = path.join(root, WORKTREE_SUBDIR, worktreeDirName(branch));
  await git(root, ['worktree', 'add', '-b', branch, worktreePath, 'main']);
  return worktreePath;
}

/** What a task's first pass through apply leaves behind: the branch forked from main, its
 *  registered worktree, and the tasks row naming both. */
async function appliedOnce(root: string, branch: string) {
  return freshTask({ worktreeBranch: branch, worktreePath: await addWorktree(root, branch) });
}

function recorded(root: string, row: TaskRow) {
  return {
    branch: row.worktreeBranch,
    path: row.worktreePath && path.relative(root, row.worktreePath),
  };
}

/** `apply` writes worktree_branch/worktree_path back to the row, so a later detect reads what the
 *  first pass left. Reads honour `columns` as drizzle does; the claimant lookups (the only reads
 *  that select `id`) answer null, since no other task is live in the fixture repository. */
function mkCtx(root: string, row: TaskRow): StepContext {
  const db = {
    query: {
      tasks: {
        findFirst: async (args?: { columns?: Record<string, boolean> }) => {
          const columns = args?.columns;
          if (columns?.id) return null;
          if (!columns) return { ...row };
          return Object.fromEntries(
            Object.keys(columns)
              .filter((k) => columns[k])
              .map((k) => [k, row[k as keyof TaskRow]]),
          );
        },
      },
      repositories: { findFirst: async () => null },
    },
    select: () => ({
      from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }),
    }),
    update: (table: unknown) => {
      if (table !== schema.tasks) throw new Error('01 wrote to a table other than tasks');
      return {
        set: (values: Partial<TaskRow>) => ({
          where: async () => {
            Object.assign(row, values);
          },
        }),
      };
    },
  } as unknown as Database;
  return {
    taskId: row.id,
    userId: 'u1',
    repoPath: root,
    sandboxWorkdir: '/haive/workdir',
    logger,
    db,
  } as unknown as StepContext;
}

function formOf(ctx: StepContext, detected: Detected) {
  return worktreeSetupStep.form!(ctx, detected)!;
}

function branchNameDefault(ctx: StepContext, detected: Detected): string {
  const field = formOf(ctx, detected).fields.find((f) => f.id === 'branchName');
  return (field as { default?: string }).default!;
}

function submit(detected: Detected, branchName: string): StepApplyArgs<Detected> {
  return {
    detected,
    formValues: { branchName },
    iteration: 0,
    previousIterations: [],
  } as unknown as StepApplyArgs<Detected>;
}

function submitDefault(ctx: StepContext, detected: Detected): StepApplyArgs<Detected> {
  return submit(detected, branchNameDefault(ctx, detected));
}

async function expectOwnBranchProposed(ctx: StepContext, own: string): Promise<void> {
  const d = await worktreeSetupStep.detect!(ctx);
  expect(d.proposedBranch).toBe(own);
  expect(d.proposalBumpedFrom).toBeNull();
  expect(ownFlag(d)).toBe(true);
  expect(branchNameDefault(ctx, d)).toBe(own);
  expect(formOf(ctx, d).fields.some((f) => f.id === 'branchTakenNote')).toBe(false);
}

async function expectRecordedAndProposed(
  root: string,
  row: TaskRow,
  ctx: StepContext,
  branch: string,
): Promise<void> {
  const worktree = path.join(WORKTREE_SUBDIR, worktreeDirName(branch));
  expect.soft(recorded(root, row)).toEqual({ branch, path: worktree });
  expect.soft((await worktreeSetupStep.detect!(ctx)).proposedBranch).toBe(branch);
}

describe('01 worktree setup after the task applied once (a Retry)', () => {
  it('C1: proposes the title-derived branch the task applied on, not a -2 fork of it', async () => {
    const root = await setupRepo();
    const ctx = mkCtx(root, await appliedOnce(root, 'feature/add-ddev'));
    await expectOwnBranchProposed(ctx, 'feature/add-ddev');
  }, 30_000);

  it('C2: proposes the custom name the person typed on the first run', async () => {
    const root = await setupRepo();
    const ctx = mkCtx(root, await appliedOnce(root, 'my-custom'));
    await expectOwnBranchProposed(ctx, 'my-custom');
  }, 30_000);

  it('C3: submitting the detected default re-enters the same worktree, work intact', async () => {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    const root = await setupRepo();
    const ctx = mkCtx(root, freshTask());

    const firstDetected = await worktreeSetupStep.detect!(ctx);
    const first = await worktreeSetupStep.apply(ctx, submitDefault(ctx, firstDetected));
    await writeFile(path.join(first.worktreePath, 'work.txt'), 'task work\n', 'utf8');
    await git(first.worktreePath, ['add', '-A']);
    await git(first.worktreePath, ['commit', '-m', 'task work']);
    const taskCommit = await git(first.worktreePath, ['rev-parse', 'HEAD']);

    // A Retry nulls 01's output; tasks.worktree_branch/worktree_path stay as apply wrote them.
    const retryDetected = await worktreeSetupStep.detect!(ctx);
    const retry = await worktreeSetupStep.apply(ctx, submitDefault(ctx, retryDetected));

    expect(path.relative(root, retry.worktreePath)).toBe(path.relative(root, first.worktreePath));
    expect(await worktreePaths(root)).toEqual([root, first.worktreePath].sort());
    expect(await git(retry.worktreePath, ['rev-parse', 'HEAD'])).toBe(taskCommit);
    expect(await readFile(path.join(retry.worktreePath, 'work.txt'), 'utf8')).toBe('task work\n');
  }, 30_000);

  it('C4: proposes the own branch when its worktree directory is gone but the branch stays', async () => {
    const root = await setupRepo();
    const row = await appliedOnce(root, 'feature/add-ddev');
    await git(root, ['worktree', 'remove', '--force', row.worktreePath!]);
    expect(await worktreePaths(root)).toEqual([root]);
    expect(await git(root, ['branch', '--list', 'feature/add-ddev'])).not.toBe('');
    await expectOwnBranchProposed(mkCtx(root, row), 'feature/add-ddev');
  }, 30_000);

  it('C6: the form says the task worktree is re-entered, not that a new one is created', async () => {
    const root = await setupRepo();
    const ctx = mkCtx(root, await appliedOnce(root, 'feature/add-ddev'));
    const { description } = formOf(ctx, await worktreeSetupStep.detect!(ctx));

    expect(description).toMatch(/re-?enter/i);
    expect(description).not.toMatch(/new worktree will be created/i);
    expect(description).toMatch(/keeps? (its|the|your) work/i);
    expect(description).toMatch(/different name[^.]*new worktree[^.]*\bmain\b/i);
  }, 30_000);
});

describe('01 worktree setup records the task worktree before the steps that can throw', () => {
  it('C5a: an apply that throws in the carry step has recorded the branch for the next detect', async () => {
    vi.spyOn(configService, 'getBoolean').mockRejectedValue(new Error('config unreadable'));
    const root = await setupRepo();
    const row = freshTask();
    const ctx = mkCtx(root, row);
    const detected = await worktreeSetupStep.detect!(ctx);

    await expect(worktreeSetupStep.apply(ctx, submitDefault(ctx, detected))).rejects.toThrow(
      'config unreadable',
    );
    expect(await worktreePaths(root)).toContain(
      path.join(root, WORKTREE_SUBDIR, 'feature-add-ddev'),
    );
    await expectRecordedAndProposed(root, row, ctx, 'feature/add-ddev');
  }, 30_000);

  it('C5b: an apply that throws in the sandbox repair has recorded the branch for the next detect', async () => {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    repair.failWith = new Error('repair refused');
    const root = await setupRepo();
    const row = freshTask();
    const ctx = mkCtx(root, row);
    const detected = await worktreeSetupStep.detect!(ctx);

    await expect(worktreeSetupStep.apply(ctx, submitDefault(ctx, detected))).rejects.toThrow(
      'repair refused',
    );
    expect(await worktreePaths(root)).toContain(
      path.join(root, WORKTREE_SUBDIR, 'feature-add-ddev'),
    );
    await expectRecordedAndProposed(root, row, ctx, 'feature/add-ddev');
  }, 30_000);

  it('C5c: a reused worktree is recorded before the repair throws', async () => {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    repair.failWith = new Error('repair refused');
    const root = await setupRepo();
    await addWorktree(root, 'feature/add-ddev');
    const row = freshTask();
    const ctx = mkCtx(root, row);
    const detected = await worktreeSetupStep.detect!(ctx);

    await expect(
      worktreeSetupStep.apply(ctx, submit(detected, 'feature/add-ddev')),
    ).rejects.toThrow('repair refused');
    await expectRecordedAndProposed(root, row, ctx, 'feature/add-ddev');
  }, 30_000);
});

describe('01 worktree setup proposals, copy and records that must not change', () => {
  it('P1: a fresh task gets the title-derived name, bumped past every other branch', async () => {
    const root = await setupRepo();
    const ctx = mkCtx(root, freshTask());

    const free = await worktreeSetupStep.detect!(ctx);
    expect(free.proposedBranch).toBe('feature/add-ddev');
    expect(free.proposalBumpedFrom).toBeNull();

    await git(root, ['branch', 'feature/add-ddev']);
    await git(root, ['branch', 'feature/add-ddev-2']);
    const bumped = await worktreeSetupStep.detect!(ctx);
    expect(bumped.proposedBranch).toBe('feature/add-ddev-3');
    expect(bumped.proposalBumpedFrom).toBe('feature/add-ddev');
  }, 30_000);

  it('P2: a recorded branch that no longer exists locally gets the usual proposal and copy', async () => {
    const root = await setupRepo();
    const row = await appliedOnce(root, 'my-custom');
    await git(root, ['worktree', 'remove', '--force', row.worktreePath!]);
    await git(root, ['branch', '-D', 'my-custom']);
    expect(await git(root, ['branch', '--list', 'my-custom'])).toBe('');
    await git(root, ['branch', 'feature/add-ddev']);
    const ctx = mkCtx(root, row);

    const d = await worktreeSetupStep.detect!(ctx);
    expect(d.proposedBranch).toBe('feature/add-ddev-2');
    expect(d.proposalBumpedFrom).toBe('feature/add-ddev');
    expect(ownFlag(d)).toBeFalsy();
    expect(formOf(ctx, d).description).toBe(todaysCopy('main', true));
  }, 30_000);

  it("P3: another task's branch is never proposed", async () => {
    const root = await setupRepo();
    await appliedOnce(root, 'feature/add-ddev'); // another task's branch and worktree

    const d = await worktreeSetupStep.detect!(mkCtx(root, freshTask()));
    expect(d.proposedBranch).toBe('feature/add-ddev-2');
    expect(d.proposalBumpedFrom).toBe('feature/add-ddev');
  }, 30_000);

  it("P4: a fresh task's form keeps today's copy, bumped name or not", async () => {
    const root = await setupRepo();
    const ctx = mkCtx(root, freshTask());

    const free = await worktreeSetupStep.detect!(ctx);
    expect(ownFlag(free)).toBeFalsy();
    expect(formOf(ctx, free).description).toBe(todaysCopy('main', true));

    await git(root, ['branch', 'feature/add-ddev']);
    const bumped = await worktreeSetupStep.detect!(ctx);
    expect(ownFlag(bumped)).toBeFalsy();
    expect(formOf(ctx, bumped).description).toBe(todaysCopy('main', true));
  }, 30_000);

  it("P5: a detect output persisted before the flag existed renders today's copy", () => {
    const ctx = {} as unknown as StepContext;
    const plain = {
      hasGit: true,
      currentBranch: 'main',
      isClean: true,
      proposedBranch: 'feature/add-ddev',
      proposalBumpedFrom: null,
      syncedBase: 'main',
    };
    const bumped = {
      ...plain,
      isClean: false,
      proposedBranch: 'feature/add-ddev-2',
      proposalBumpedFrom: 'feature/add-ddev',
    };

    expect(formOf(ctx, plain).description).toBe(todaysCopy('main', true));
    expect(formOf(ctx, bumped).description).toBe(todaysCopy('main', false));
  });

  it('P6: an apply whose git worktree add fails records nothing', async () => {
    const root = await setupRepo();
    const row = freshTask();
    const ctx = mkCtx(root, row);
    const detected = await worktreeSetupStep.detect!(ctx);

    await expect(
      worktreeSetupStep.apply(
        ctx,
        submit({ ...detected, syncedBase: 'no-such-base' }, 'feature/add-ddev'),
      ),
    ).rejects.toThrow(/git worktree add failed/);
    expect(recorded(root, row)).toEqual({ branch: null, path: null });
  }, 30_000);
});
