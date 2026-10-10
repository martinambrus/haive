import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { SANDBOX_WORKDIR } from '../../sandbox/sandbox-runner.js';
import { ensureTaskScratchWorkspace } from '../../repo/scratch-workspace.js';
import { invocationRepoSubpath } from '../../repo/worktree-git-boundary.js';
import {
  makePointerFixture,
  pointerDb,
  POINTER_BRANCH,
  type PointerFixture,
} from '../../../test/support/worktree-pointer-db.js';
import { resolveInvocationRepoMount } from './resolvers.js';

vi.hoisted(() => {
  process.env.REPO_STORAGE_ROOT = `${process.env.TMPDIR ?? '/tmp'}/wt-pointer-mount-${process.pid}-${Math.random().toString(36).slice(2)}`;
});

// Only the filesystem half is stubbed: the subpath and the repo-less predicate stay real, and
// the resolver MUST create the directory, because docker refuses a volume-subpath that does not
// exist (MEASURED: `cannot access path ... no such file or directory`).
vi.mock('../../repo/scratch-workspace.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../repo/scratch-workspace.js')>();
  return { ...actual, ensureTaskScratchWorkspace: vi.fn(async () => '/scratch/dir') };
});

function mkDb(
  task: {
    userId: string;
    repositoryId: string | null;
    worktreeBranch: string | null;
    type?: string;
    metadata?: Record<string, unknown> | null;
  } | null,
  repo: { source?: string; storagePath?: string | null; localPath?: string | null } | null,
): Database {
  return {
    query: {
      tasks: { findFirst: async () => task ?? undefined },
      repositories: { findFirst: async () => repo ?? undefined },
      taskSteps: { findFirst: async () => undefined },
    },
  } as unknown as Database;
}

const VOLUME_TASK = { userId: 'u1', repositoryId: 'r1', worktreeBranch: 'feature/x' };
const VOLUME_REPO = { source: 'clone', storagePath: null, localPath: null };

describe('resolveInvocationRepoMount', () => {
  let liveFx: PointerFixture;
  beforeEach(async () => {
    liveFx = await makePointerFixture();
    await liveFx.mkWorktree();
  });
  afterEach(async () => {
    await liveFx.cleanup();
  });

  it('mounts the feature worktree alone at the workdir root by default', async () => {
    const db = mkDb(VOLUME_TASK, VOLUME_REPO);
    const { repoMount, hasWorktree } = await resolveInvocationRepoMount(db, 't1');
    expect(repoMount).toEqual({
      source: 'haive_repos',
      target: SANDBOX_WORKDIR,
      subpath: 'u1/r1/.haive/worktrees/feature-x',
    });
    expect(hasWorktree).toBe(true);
  });

  it('honors a worktreeRel override (a DAG issue sibling)', async () => {
    const db = mkDb(VOLUME_TASK, VOLUME_REPO);
    const { repoMount, hasWorktree } = await resolveInvocationRepoMount(
      db,
      't1',
      '.haive/worktrees/feature-x--issue-3',
    );
    expect(repoMount?.subpath).toBe('u1/r1/.haive/worktrees/feature-x--issue-3');
    expect(hasWorktree).toBe(true);
  });

  // A 12-cleanup same-branch merge runs at the parent checkout (repo root), where `.git`
  // is a directory — mount the repo root and DON'T flag a worktree (so no gitfile mask).
  it('mounts the repo root with hasWorktree=false for an empty-string override', async () => {
    const db = mkDb(VOLUME_TASK, VOLUME_REPO);
    const { repoMount, hasWorktree } = await resolveInvocationRepoMount(db, 't1', '');
    expect(repoMount?.subpath).toBe('u1/r1');
    expect(hasWorktree).toBe(false);
  });

  it('mounts the repo root when the task has no worktree (onboarding)', async () => {
    const db = mkDb({ userId: 'u1', repositoryId: 'r1', worktreeBranch: null }, VOLUME_REPO);
    const { repoMount, hasWorktree } = await resolveInvocationRepoMount(db, 't1');
    expect(repoMount?.subpath).toBe('u1/r1');
    expect(hasWorktree).toBe(false);
  });

  it('binds a read-only local-path repo at the repo root, no worktree', async () => {
    const db = mkDb(VOLUME_TASK, {
      source: 'local',
      storagePath: '/host-fs/proj',
      localPath: null,
    });
    const { repoMount, hasWorktree } = await resolveInvocationRepoMount(db, 't1');
    expect(repoMount?.readOnly).toBe(true);
    expect(repoMount?.subpath).toBeUndefined();
    expect(hasWorktree).toBe(false);
  });

  it('mounts EXACTLY the subpath invocationRepoSubpath derives, for every shape', async () => {
    // The two answers agree today only because this resolver calls that function — the dispatcher
    // needs the same tree and cannot import this file, so the rule lives there. Pin the agreement
    // rather than the strings: a change to either side that drifts them apart would otherwise mount
    // one tree while the persona reader and the exec recheck reason about another.
    const shapes: { worktreeBranch: string | null; worktreeRel?: string }[] = [
      { worktreeBranch: 'feature/x' },
      { worktreeBranch: 'feature/x', worktreeRel: '.haive/worktrees/feature-x--issue-3' },
      { worktreeBranch: 'feature/x', worktreeRel: '' },
      { worktreeBranch: null },
    ];
    for (const shape of shapes) {
      const task = { userId: 'u1', repositoryId: 'r1', worktreeBranch: shape.worktreeBranch };
      const db = mkDb(task, VOLUME_REPO);
      const { repoMount } = await resolveInvocationRepoMount(db, 't1', shape.worktreeRel);
      expect(repoMount?.subpath, JSON.stringify(shape)).toBe(
        invocationRepoSubpath({
          storagePath: VOLUME_REPO.storagePath,
          localPath: VOLUME_REPO.localPath,
          userId: task.userId,
          repositoryId: task.repositoryId,
          worktreeBranch: task.worktreeBranch,
          worktreeRel: shape.worktreeRel,
        }),
      );
    }

    // The one case it declines, and the resolver returns before consulting it: a local-path repo is
    // bound from a host path with no subpath at all, so "undefined" has to mean the same thing on
    // both sides.
    const localDb = mkDb(VOLUME_TASK, { source: 'local', storagePath: '/host-fs/proj' });
    const { repoMount: localMount } = await resolveInvocationRepoMount(localDb, 't1');
    expect(localMount?.subpath).toBeUndefined();
    expect(
      invocationRepoSubpath({
        storagePath: '/host-fs/proj',
        userId: 'u1',
        repositoryId: 'r1',
        worktreeBranch: 'feature/x',
      }),
    ).toBeUndefined();
  });

  it('returns no mount for a repo-less task of a type that requires one', async () => {
    // A null repositoryId on a workflow task is a TORN state — the column is ON DELETE SET
    // NULL — not a mode, so nothing is mounted and resolveTaskContext still fails it loudly.
    const db = mkDb(
      { userId: 'u1', repositoryId: null, worktreeBranch: null, type: 'workflow' },
      null,
    );
    expect(await resolveInvocationRepoMount(db, 't1')).toEqual({
      repoMount: null,
      hasWorktree: false,
      hasRepo: false,
    });
    // And nothing is created for it: a torn state must not be handed a workspace.
    expect(ensureTaskScratchWorkspace).not.toHaveBeenCalled();
  });

  it('refuses a workspace to a task whose recorded anchor was deleted', async () => {
    // Same null column, opposite meaning. Deleting a repository nulls the FK and leaves TERMINAL
    // tasks alone, so a failed anchored task reaches here looking repo-less — and the Terminal
    // calls this resolver without passing resolveTaskContext's guard. A fresh empty workspace
    // there is a recovery shell that was never this task's workspace.
    const db = mkDb(
      {
        userId: 'u1',
        repositoryId: null,
        worktreeBranch: null,
        type: 'kb_author',
        metadata: { anchorRepositoryId: 'r-gone' },
      },
      null,
    );
    expect(await resolveInvocationRepoMount(db, 't1')).toEqual({
      repoMount: null,
      hasWorktree: false,
      hasRepo: false,
    });
    expect(ensureTaskScratchWorkspace).not.toHaveBeenCalled();
  });

  it('mounts an empty scratch workspace for a type allowed to run repo-less', async () => {
    // The sandbox always runs with `-w /haive/workdir`; with nothing mounted there that path is
    // the image WORKDIR, created root:root while the CLI runs as uid 1000, so anything written
    // relative to the CWD fails EACCES.
    // `metadata.anchorRepositoryId: null` is what makes this a task CREATED repo-less rather
    // than an anchored one whose repository was deleted — the two arrive with the same null
    // column, and only the second must be refused a workspace.
    const db = mkDb(
      {
        userId: 'u1',
        repositoryId: null,
        worktreeBranch: null,
        type: 'kb_author',
        metadata: { anchorRepositoryId: null },
      },
      null,
    );
    expect(await resolveInvocationRepoMount(db, 't1')).toEqual({
      repoMount: { source: 'haive_repos', target: SANDBOX_WORKDIR, subpath: 'u1/_scratch/t1' },
      hasWorktree: false,
      // The point of the separate flag: there IS a mount, and there is NO repository. A null
      // check on repoMount can no longer answer the second question.
      hasRepo: false,
    });
    // The mount is only valid if the directory EXISTS by the time it is returned: docker
    // refuses a volume-subpath that does not, and the human Terminal resolves this before
    // `resolveTaskContext` ever runs for a task still sitting in `created`.
    expect(ensureTaskScratchWorkspace).toHaveBeenCalledWith('u1', 't1');
  });
});

// tasks.worktree_branch / worktree_path are audit history and are never cleared, so a reader that
// needs the CURRENT worktree has to ask whether 01-worktree-setup still stands behind them.
describe('resolveInvocationRepoMount against a recorded worktree pointer', () => {
  let fx: PointerFixture;
  beforeEach(async () => {
    fx = await makePointerFixture();
  });
  afterEach(async () => {
    await fx.cleanup();
  });

  const repo = () => ({ source: 'clone', storagePath: fx.repoRoot, localPath: null });
  const recorded = () => ({
    worktreeBranch: POINTER_BRANCH,
    worktreePath: fx.worktreePath,
  });
  const doneOutput = () => ({
    mode: 'worktree',
    worktreePath: fx.worktreePath,
    branchName: POINTER_BRANCH,
    sandboxWorktreePath: '/haive/workdir/.haive/worktrees/feature-x',
  });

  // C1 (#214): Retry nulled 01's output, the person Skipped 01, the column still names the tree.
  it('C1 mounts the repository root when the latest 01 round is skipped', async () => {
    await fx.mkWorktree();
    const db = pointerDb({
      task: recorded(),
      repo: repo(),
      steps: [{ status: 'skipped', output: null }],
    });
    const { repoMount, hasWorktree } = await resolveInvocationRepoMount(db, 't1');
    expect(repoMount?.subpath).toBe('u1/r1');
    expect(hasWorktree).toBe(false);
  });

  it('G5 follows the LATEST round: an earlier skipped round does not hide a later done one', async () => {
    await fx.mkWorktree();
    const db = pointerDb({
      task: recorded(),
      repo: repo(),
      steps: [
        { status: 'skipped', output: null, round: 0 },
        { status: 'done', output: doneOutput(), round: 1 },
      ],
    });
    const { repoMount, hasWorktree } = await resolveInvocationRepoMount(db, 't1');
    expect(repoMount?.subpath).toBe('u1/r1/.haive/worktrees/feature-x');
    expect(hasWorktree).toBe(true);
  });

  // C4 (#221): cleanup or cancel removed the directory; the column still names it.
  it('C4 refuses a worktree whose directory was removed', async () => {
    const db = pointerDb({
      task: recorded(),
      repo: repo(),
      steps: [{ status: 'done', output: doneOutput() }],
    });
    await expect(resolveInvocationRepoMount(db, 't1')).rejects.toThrow(/worktree.*removed/is);
  });

  // G2: a Retry nulled 01's output and parked it; the tree is on disk and is still the task's.
  it('G2 keeps the worktree for a Retry state (output null, 01 not skipped, directory present)', async () => {
    await fx.mkWorktree();
    const db = pointerDb({
      task: recorded(),
      repo: repo(),
      steps: [{ status: 'waiting_form', output: null }],
    });
    const { repoMount, hasWorktree } = await resolveInvocationRepoMount(db, 't1');
    expect(repoMount?.subpath).toBe('u1/r1/.haive/worktrees/feature-x');
    expect(hasWorktree).toBe(true);
  });

  // G3: a DAG issue worktree is named by the override; the feature directory is not consulted.
  it('G3 mounts a DAG issue worktree although the feature worktree directory is gone', async () => {
    await fx.mkWorktree('feature-x--issue-3');
    const db = pointerDb({
      task: recorded(),
      repo: repo(),
      steps: [{ status: 'done', output: doneOutput() }],
    });
    const { repoMount, hasWorktree } = await resolveInvocationRepoMount(
      db,
      't1',
      '.haive/worktrees/feature-x--issue-3',
    );
    expect(repoMount?.subpath).toBe('u1/r1/.haive/worktrees/feature-x--issue-3');
    expect(hasWorktree).toBe(true);
  });

  it('G3 mounts the repository root for the merge-fix override although the worktree is gone', async () => {
    const db = pointerDb({
      task: recorded(),
      repo: repo(),
      steps: [{ status: 'done', output: doneOutput() }],
    });
    const { repoMount, hasWorktree } = await resolveInvocationRepoMount(db, 't1', '');
    expect(repoMount?.subpath).toBe('u1/r1');
    expect(hasWorktree).toBe(false);
  });

  // G4: onboarding / plan tasks never recorded a worktree.
  it('G4 mounts the repository root when no worktree was ever recorded', async () => {
    const db = pointerDb({
      task: { worktreeBranch: null, worktreePath: null },
      repo: repo(),
      steps: [],
    });
    const { repoMount, hasWorktree } = await resolveInvocationRepoMount(db, 't1');
    expect(repoMount?.subpath).toBe('u1/r1');
    expect(hasWorktree).toBe(false);
  });
});
