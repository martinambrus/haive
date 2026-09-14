import { mkdir, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  taskMayRunWithoutRepository,
  taskScratchSubpath,
  taskTypeAllowsNoRepository,
  taskWasCreatedRepoLess,
} from '../src/repo/scratch-workspace.js';

// A null `tasks.repository_id` has TWO meanings — a task deliberately created without one, and
// a task whose repository was deleted out from under it (the column is ON DELETE SET NULL).
// Only the first is a mode; the second must keep failing loudly, which is why this is an
// allowlist rather than a blanket "null is fine".
describe('taskTypeAllowsNoRepository', () => {
  it('allows the KB author, whose article is meant to be repo-independent', () => {
    expect(taskTypeAllowsNoRepository('kb_author')).toBe(true);
  });

  it('refuses every type whose work IS a repository', () => {
    for (const type of ['workflow', 'onboarding', 'run_app', 'plan_build', 'plan_chat']) {
      expect(taskTypeAllowsNoRepository(type)).toBe(false);
    }
  });
});

// The allowlist keys on TYPE, so for kb_author it cannot separate "created without a repo" from
// "had one until the repository was deleted" — and the second is the torn state the hard failure
// exists for. Deleting a repository nulls the FK and leaves TERMINAL tasks alone, so a failed
// anchored task retries straight into the repo-less branch.
describe('taskWasCreatedRepoLess', () => {
  it('reads the recorded choice, not the current column', () => {
    expect(taskWasCreatedRepoLess({ anchorRepositoryId: null })).toBe(true);
    expect(taskWasCreatedRepoLess({ anchorRepositoryId: 'r1' })).toBe(false);
  });

  it('says "not recorded" for a task that predates the record', () => {
    // null, never false: a legacy task keeps the answer it had, so no backfill is needed.
    expect(taskWasCreatedRepoLess({ globalKbEntryId: 'e1' })).toBeNull();
    expect(taskWasCreatedRepoLess(null)).toBeNull();
    expect(taskWasCreatedRepoLess(undefined)).toBeNull();
    expect(taskWasCreatedRepoLess('not an object')).toBeNull();
  });

  it('separates a recorded null from an absent key', () => {
    // The two are the same JSON value on read; only the KEY's presence tells them apart.
    expect(taskWasCreatedRepoLess({ anchorRepositoryId: null })).toBe(true);
    expect(taskWasCreatedRepoLess({})).toBeNull();
  });
});

// Three call sites reach this decision by different routes — resolveTaskContext when the task
// runs, and both mount resolvers, one of which the human Terminal calls WITHOUT going through the
// task context. Splitting the two halves across them is how the deleted-anchor case survived
// being closed in one of them.
describe('taskMayRunWithoutRepository', () => {
  it('allows a task actually created without a repository', () => {
    expect(
      taskMayRunWithoutRepository({ type: 'kb_author', metadata: { anchorRepositoryId: null } }),
    ).toBe(true);
  });

  it('refuses a task whose recorded anchor is gone', () => {
    expect(
      taskMayRunWithoutRepository({ type: 'kb_author', metadata: { anchorRepositoryId: 'r1' } }),
    ).toBe(false);
  });

  it('still allows a task that predates the record', () => {
    expect(taskMayRunWithoutRepository({ type: 'kb_author', metadata: null })).toBe(true);
    expect(taskMayRunWithoutRepository({ type: 'kb_author', metadata: {} })).toBe(true);
  });

  it('refuses every type whose work IS a repository, recorded or not', () => {
    for (const type of ['workflow', 'onboarding', 'run_app']) {
      expect(taskMayRunWithoutRepository({ type, metadata: { anchorRepositoryId: null } })).toBe(
        false,
      );
    }
  });
});

describe('taskScratchSubpath', () => {
  it('sits under the user directory, where no repository UUID can collide with it', () => {
    expect(taskScratchSubpath('u1', 't1')).toBe('u1/_scratch/t1');
  });

  it('is per task, so two repo-less tasks never share a working directory', () => {
    expect(taskScratchSubpath('u1', 't1')).not.toBe(taskScratchSubpath('u1', 't2'));
  });
});

// `markTaskCompleted` stamps the status FIRST and reaps LAST, so a worker that exits between the
// two abandons the directory: a `completed` task is never advanced again, so redelivery cannot
// recover it and nothing else in the tree looks at these. The sweep is the reconciliation, and
// what it must never do is take a workspace from a task that is still using one.
describe('sweepOrphanScratchWorkspaces', () => {
  const TASK = '11111111-1111-4111-8111-111111111111';

  /** The storage root is read at module load, so the module is re-imported per root. */
  async function loadWithRoot(root: string) {
    vi.resetModules();
    process.env.REPO_STORAGE_ROOT = root;
    return import('../src/repo/scratch-workspace.js');
  }

  function fakeDb(task: unknown, pendingSummary: unknown = undefined) {
    return {
      query: {
        tasks: { findFirst: async () => task },
        cliInvocations: { findFirst: async () => pendingSummary },
      },
    } as never;
  }

  async function rootWithScratch(): Promise<{ root: string; userId: string }> {
    const root = await mkdtemp(path.join(tmpdir(), 'scratch-sweep-'));
    const userId = 'u1';
    await mkdir(path.join(root, userId, '_scratch', TASK), { recursive: true });
    return { root, userId };
  }

  async function scratchNames(root: string, userId: string): Promise<string[]> {
    return readdir(path.join(root, userId, '_scratch'));
  }

  it('removes a workspace whose task row is gone', async () => {
    // The one case cleanupTaskScratchWorkspace cannot handle: it keys on a task it cannot read.
    const { root, userId } = await rootWithScratch();
    const mod = await loadWithRoot(root);
    await mod.sweepOrphanScratchWorkspaces(fakeDb(undefined));
    expect(await scratchNames(root, userId)).toEqual([]);
  });

  it('leaves a live task its working directory', async () => {
    // The whole safety argument. A task parked on a form is not settled, and taking its
    // workspace would break the run this sweep is supposed to be invisible to.
    const { root, userId } = await rootWithScratch();
    const mod = await loadWithRoot(root);
    await mod.sweepOrphanScratchWorkspaces(
      fakeDb({ id: TASK, userId, type: 'kb_author', repositoryId: null, status: 'waiting_user' }),
    );
    expect(await scratchNames(root, userId)).toEqual([TASK]);
  });

  it('finishes the reap a crash interrupted', async () => {
    const { root, userId } = await rootWithScratch();
    const mod = await loadWithRoot(root);
    await mod.sweepOrphanScratchWorkspaces(
      fakeDb({ id: TASK, userId, type: 'kb_author', repositoryId: null, status: 'completed' }),
    );
    expect(await scratchNames(root, userId)).toEqual([]);
  });

  it('keeps a settled task whose recap has not finished', async () => {
    const { root, userId } = await rootWithScratch();
    const mod = await loadWithRoot(root);
    await mod.sweepOrphanScratchWorkspaces(
      fakeDb(
        { id: TASK, userId, type: 'kb_author', repositoryId: null, status: 'completed' },
        { id: 'inv1' },
      ),
    );
    expect(await scratchNames(root, userId)).toEqual([TASK]);
  });
});
