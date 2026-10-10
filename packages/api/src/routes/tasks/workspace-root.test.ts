import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { taskScratchSubpath } from '@haive/shared';
import { resolveWorkspaceRoot } from './_helpers.js';

type Db = Parameters<typeof resolveWorkspaceRoot>[0];

const USER = 'user-1';
const TASK = 'task-1';

// The function takes its db, so two stubs are the whole fixture: what the task row says, and
// what the repository row says when the task names one.
// The 01-worktree-setup rows (newest round last) are served to whichever query shape reads them:
// `db.query.taskSteps` or a `db.select()` builder chain, awaited at any depth.
function stepChain(rows: unknown[]): unknown {
  const self: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(rows).then(resolve, reject);
      }
      return () => self;
    },
    apply: () => self,
  });
  return self;
}

interface StepRow {
  status: string;
  round?: number;
  output: unknown;
}

function fakeDb(
  task: Record<string, unknown>,
  repo: Record<string, unknown> | null,
  steps: StepRow[] = [],
): Db {
  const rows = steps
    .map((s) => ({ stepId: '01-worktree-setup', round: 0, ...s }))
    .sort((a, b) => b.round - a.round);
  return {
    query: {
      tasks: { findFirst: async () => task },
      repositories: { findFirst: async () => repo },
      taskSteps: { findFirst: async () => rows[0], findMany: async () => rows },
    },
    select: () => stepChain(rows),
  } as unknown as Db;
}

function task(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: TASK,
    userId: USER,
    repositoryId: 'repo-1',
    worktreePath: null,
    type: 'workflow',
    metadata: {},
    ...over,
  };
}

// The anchor is what an fs-safe walk may follow. A worktree lives under `.haive/worktrees/`,
// which the sandbox and the task terminal can rewrite, so it is never the anchor — and a
// worktree whose repository was deleted (`repository_id` is `ON DELETE SET NULL`) has no
// trusted directory left to anchor at, so it is refused rather than anchored at itself.
describe('resolveWorkspaceRoot', () => {
  let storage: string;
  let repo: string;

  beforeEach(async () => {
    storage = await mkdtemp(path.join(tmpdir(), 'ws-root-'));
    process.env.REPO_STORAGE_ROOT = storage;
    repo = path.join(storage, USER, 'repo-1');
    await mkdir(repo, { recursive: true });
  });

  afterEach(async () => {
    delete process.env.REPO_STORAGE_ROOT;
    await rm(storage, { recursive: true, force: true });
  });

  it('anchors a worktree at its repository', async () => {
    const worktree = path.join(repo, '.haive', 'worktrees', 'wt');
    await mkdir(worktree, { recursive: true });
    const db = fakeDb(task({ worktreePath: worktree }), { storagePath: repo, localPath: null });
    await expect(resolveWorkspaceRoot(db, TASK, USER)).resolves.toMatchObject({
      root: worktree,
      anchor: repo,
    });
  });

  // C5 (#214): Retry nulled 01's output, the person Skipped 01, worktree_path still names the tree.
  it('C5 roots a task whose latest 01 round is skipped at the repository', async () => {
    const worktree = path.join(repo, '.haive', 'worktrees', 'wt');
    await mkdir(worktree, { recursive: true });
    const db = fakeDb(
      task({ worktreePath: worktree, worktreeBranch: 'wt' }),
      { storagePath: repo, localPath: null },
      [{ status: 'skipped', output: null }],
    );
    await expect(resolveWorkspaceRoot(db, TASK, USER)).resolves.toMatchObject({
      root: repo,
      anchor: repo,
    });
  });

  // C5 (#221): cleanup or cancel removed the directory; worktree_path still names it.
  it('C5 answers 409 for a worktree whose directory was removed', async () => {
    const worktree = path.join(repo, '.haive', 'worktrees', 'wt');
    const db = fakeDb(
      task({ worktreePath: worktree, worktreeBranch: 'wt' }),
      { storagePath: repo, localPath: null },
      [{ status: 'done', output: { mode: 'worktree', worktreePath: worktree } }],
    );
    await expect(resolveWorkspaceRoot(db, TASK, USER)).rejects.toMatchObject({ status: 409 });
  });

  // G2: Retry state, output nulled, 01 not skipped, directory on disk.
  it('G2 keeps the worktree for a Retry state', async () => {
    const worktree = path.join(repo, '.haive', 'worktrees', 'wt');
    await mkdir(worktree, { recursive: true });
    const db = fakeDb(
      task({ worktreePath: worktree, worktreeBranch: 'wt' }),
      { storagePath: repo, localPath: null },
      [{ status: 'waiting_form', output: null }],
    );
    await expect(resolveWorkspaceRoot(db, TASK, USER)).resolves.toMatchObject({
      root: worktree,
      anchor: repo,
    });
  });

  // G4: onboarding / plan tasks never recorded a worktree.
  it('G4 roots a task that never recorded a worktree at the repository', async () => {
    const db = fakeDb(task({ worktreePath: null, worktreeBranch: null }), {
      storagePath: repo,
      localPath: null,
    });
    await expect(resolveWorkspaceRoot(db, TASK, USER)).resolves.toMatchObject({
      root: repo,
      anchor: repo,
    });
  });

  it('anchors a repository-only task at the repository', async () => {
    const db = fakeDb(task({}), { storagePath: repo, localPath: null });
    await expect(resolveWorkspaceRoot(db, TASK, USER)).resolves.toMatchObject({
      root: repo,
      anchor: repo,
    });
  });

  it('refuses a worktree whose repository is gone', async () => {
    const worktree = path.join(repo, '.haive', 'worktrees', 'wt');
    const db = fakeDb(task({ repositoryId: null, worktreePath: worktree }), null);
    await expect(resolveWorkspaceRoot(db, TASK, USER)).rejects.toThrow(
      /no longer belongs to a repository/i,
    );
  });

  it('refuses a worktree outside its repository', async () => {
    const elsewhere = path.join(storage, 'elsewhere');
    const db = fakeDb(task({ worktreePath: elsewhere }), { storagePath: repo, localPath: null });
    await expect(resolveWorkspaceRoot(db, TASK, USER)).rejects.toThrow(
      /not inside its repository/i,
    );
  });

  it('anchors a repo-less scratch task at its scratch directory', async () => {
    const scratch = path.join(storage, taskScratchSubpath(USER, TASK));
    await mkdir(scratch, { recursive: true });
    const db = fakeDb(
      task({ repositoryId: null, type: 'kb_author', metadata: { anchorRepositoryId: null } }),
      null,
    );
    await expect(resolveWorkspaceRoot(db, TASK, USER)).resolves.toMatchObject({
      root: scratch,
      anchor: scratch,
    });
  });

  it('refuses a task with no workspace at all', async () => {
    const db = fakeDb(task({ repositoryId: null }), null);
    await expect(resolveWorkspaceRoot(db, TASK, USER)).rejects.toThrow(/no resolvable workspace/i);
  });
});
