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
function fakeDb(task: Record<string, unknown>, repo: Record<string, unknown> | null): Db {
  return {
    query: {
      tasks: { findFirst: async () => task },
      repositories: { findFirst: async () => repo },
    },
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
    const db = fakeDb(task({ worktreePath: worktree }), { storagePath: repo, localPath: null });
    await expect(resolveWorkspaceRoot(db, TASK, USER)).resolves.toMatchObject({
      root: worktree,
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
