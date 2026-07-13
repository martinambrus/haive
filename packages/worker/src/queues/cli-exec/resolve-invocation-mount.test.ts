import { describe, expect, it } from 'vitest';
import type { Database } from '@haive/database';
import { SANDBOX_WORKDIR } from '../../sandbox/sandbox-runner.js';
import { resolveInvocationRepoMount } from './resolvers.js';

function mkDb(
  task: { userId: string; repositoryId: string | null; worktreeBranch: string | null } | null,
  repo: { source?: string; storagePath?: string | null; localPath?: string | null } | null,
): Database {
  return {
    query: {
      tasks: { findFirst: async () => task ?? undefined },
      repositories: { findFirst: async () => repo ?? undefined },
    },
  } as unknown as Database;
}

const VOLUME_TASK = { userId: 'u1', repositoryId: 'r1', worktreeBranch: 'feature/x' };
const VOLUME_REPO = { source: 'clone', storagePath: null, localPath: null };

describe('resolveInvocationRepoMount', () => {
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

  it('returns no mount for a repo-less task', async () => {
    const db = mkDb({ userId: 'u1', repositoryId: null, worktreeBranch: null }, null);
    expect(await resolveInvocationRepoMount(db, 't1')).toEqual({
      repoMount: null,
      hasWorktree: false,
    });
  });
});
