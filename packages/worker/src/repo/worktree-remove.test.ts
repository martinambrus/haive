import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, it, expect } from 'vitest';
import type { Database } from '@haive/database';
import { removeTaskWorktree, removeWorktreeDir } from './worktree-remove.js';

const exec = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};
async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd: dir, env: GIT_ENV });
  return stdout.toString();
}
async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** A repo on `main` with one commit plus a linked worktree at .haive/worktrees/feat,
 *  mirroring 01-worktree-setup's layout. */
async function setupRepoWithWorktree(): Promise<{ root: string; wt: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'wt-root-'));
  await git(root, ['init', '-b', 'main']);
  await writeFile(path.join(root, 'f.txt'), 'one\n', 'utf8');
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-m', 'one']);
  const wt = path.join(root, '.haive', 'worktrees', 'feat');
  await git(root, ['worktree', 'add', '-b', 'feat', wt, 'main']);
  return { root, wt };
}

describe('removeWorktreeDir', () => {
  it('removes a live worktree via git and clears the admin entry', async () => {
    const { root, wt } = await setupRepoWithWorktree();
    try {
      expect((await git(root, ['worktree', 'list'])).trim().split('\n')).toHaveLength(2);
      const res = await removeWorktreeDir(root, wt);
      expect(res).toEqual({ removed: true, worktreePath: wt, method: 'git' });
      expect(await exists(wt)).toBe(false);
      // The parent's .git/worktrees admin entry is gone too (back to one worktree).
      expect((await git(root, ['worktree', 'list'])).trim().split('\n')).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('falls back to rm when the parent .git is gone (orphaned worktree)', async () => {
    const { root, wt } = await setupRepoWithWorktree();
    try {
      // Simulate a repo reset: drop the parent .git so the linked worktree dangles
      // and `git worktree remove` can no longer resolve it.
      await rm(path.join(root, '.git'), { recursive: true, force: true });
      expect(await exists(wt)).toBe(true);
      const res = await removeWorktreeDir(root, wt);
      expect(res.removed).toBe(true);
      expect(res.method).toBe('rmdir');
      expect(await exists(wt)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rm-only path when no parent repo root is known', async () => {
    const { root, wt } = await setupRepoWithWorktree();
    try {
      const res = await removeWorktreeDir(null, wt);
      expect(res).toMatchObject({ removed: true, method: 'rmdir' });
      expect(await exists(wt)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/** db stub: the task row carries the durable columns, the repositories row the repo
 *  root, and the 01-worktree-setup step row whatever `stepOutput` says (null models a
 *  Retry cascade having wiped it). */
function mkDb(
  task: { worktreePath: string | null; worktreeBranch: string | null },
  storagePath: string,
  stepOutput: unknown = null,
): Database {
  return {
    query: {
      tasks: { findFirst: async () => ({ repositoryId: 'r1', ...task }) },
      repositories: { findFirst: async () => ({ storagePath }) },
    },
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({ limit: () => Promise.resolve([{ output: stepOutput }]) }),
        }),
      }),
    }),
  } as unknown as Database;
}

async function branchExists(root: string, branch: string): Promise<boolean> {
  try {
    await git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

describe('removeTaskWorktree', () => {
  // The task-27706aba leak: Retry cascaded over 01-worktree-setup and nulled its
  // output, so the reaper could no longer find the worktree it had created.
  it('removes the worktree from the task row even when the step output was reset', async () => {
    const { root, wt } = await setupRepoWithWorktree();
    try {
      const db = mkDb({ worktreePath: wt, worktreeBranch: 'feat' }, root, null);
      const res = await removeTaskWorktree(db, 'task1');
      expect(res.removed).toBe(true);
      expect(await exists(wt)).toBe(false);
      // 'feat' has no commits of its own, so the safe delete succeeds.
      expect(res.branchDeleted).toBe(true);
      expect(await branchExists(root, 'feat')).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('falls back to the step output for tasks predating the columns', async () => {
    const { root, wt } = await setupRepoWithWorktree();
    try {
      const db = mkDb({ worktreePath: null, worktreeBranch: null }, root, {
        mode: 'worktree',
        worktreePath: wt,
        branchName: 'feat',
      });
      const res = await removeTaskWorktree(db, 'task1');
      expect(res.removed).toBe(true);
      expect(await exists(wt)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps an unmerged branch: cancel must not destroy committed work', async () => {
    const { root, wt } = await setupRepoWithWorktree();
    try {
      await writeFile(path.join(wt, 'work.txt'), 'wip\n', 'utf8');
      await git(wt, ['add', '-A']);
      await git(wt, ['commit', '-m', 'work on the feature branch']);

      const db = mkDb({ worktreePath: wt, worktreeBranch: 'feat' }, root, null);
      const res = await removeTaskWorktree(db, 'task1');
      expect(res.removed).toBe(true);
      expect(res.branchDeleted).toBe(false);
      expect(await branchExists(root, 'feat')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('no-ops when neither the task row nor the step output names a worktree', async () => {
    const { root } = await setupRepoWithWorktree();
    try {
      const db = mkDb({ worktreePath: null, worktreeBranch: null }, root, null);
      const res = await removeTaskWorktree(db, 'task1');
      expect(res).toMatchObject({ removed: false, worktreePath: null, method: null });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
