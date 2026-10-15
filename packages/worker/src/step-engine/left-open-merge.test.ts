import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { logger } from '@haive/shared';

const lock = vi.hoisted(() => ({ txResults: [[]] as unknown[][], inserted: [] as unknown[] }));
const git = vi.hoisted(() => ({
  abortMerge: vi.fn(),
  mergeOpenFor: vi.fn(async (..._args: unknown[]) => true),
  recordFixerLeftovers: vi.fn(),
  relocateFixerChanges: vi.fn(),
  revParse: vi.fn(),
}));
const projections = vi.hoisted(() => ({ settleProjections: vi.fn() }));

vi.mock('./git-merge.js', () => ({
  abortFailureNote: () => 'abort failed',
  abortMerge: git.abortMerge,
  isHostCheckout: () => false,
  mergeOpenFor: (...args: unknown[]) => git.mergeOpenFor(...args),
  recordFixerLeftovers: git.recordFixerLeftovers,
  relocateFixerChanges: git.relocateFixerChanges,
  revParse: git.revParse,
}));
vi.mock('./merge-projections.js', () => ({
  settleProjections: (...args: unknown[]) => projections.settleProjections(...args),
}));
vi.mock('./merge-dir-claim.js', () => ({
  inMergeDirLock: async (_db: unknown, _dir: string, fn: (tx: unknown) => unknown) => {
    const tx = chainDb(lock.txResults);
    const value = await fn(tx.db);
    lock.inserted.push(...tx.inserted);
    return value;
  },
  liveClaimHolder: async () => null,
}));
vi.mock('../repo/worktree-claims.js', () => ({ findWorktreePathClaimant: async () => null }));
vi.mock('../queues/cli-exec/secret-mask.js', () => ({ taskSecretMaskPolicy: async () => ({}) }));
vi.mock('./step-ownership.js', () => ({
  addStepWarning: async (_db: unknown, row: unknown) => row,
}));

import {
  abortLeftMerge,
  noteAbortedByNext,
  recordLeftOpenMerges,
  relocateLeftOpenFixers,
  takeLeftOpenKept,
} from './left-open-merge.js';
import type { TaskStepRow } from './step-runner.js';

/** A query builder whose every chained call resolves to the next queued result, in call order. */
function chainDb(results: unknown[][], findFirst: unknown = null) {
  const inserted: unknown[] = [];
  const updates: unknown[] = [];
  const queue = [...results];
  const chain = (): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop) => {
        if (prop === 'then') {
          const value = queue.shift() ?? [];
          return (resolve: (v: unknown) => void) => resolve(value);
        }
        return () => chain();
      },
    });
  const db = {
    query: { tasks: { findFirst: async () => findFirst } },
    select: () => chain(),
    selectDistinct: () => chain(),
    insert: () => ({
      values: async (v: unknown) => {
        inserted.push(v);
      },
    }),
    update: () => ({
      set: (v: unknown) => ({
        where: async () => {
          updates.push(v);
        },
      }),
    }),
  };
  return { db: db as unknown as Database, inserted, updates };
}

describe('recordLeftOpenMerges', () => {
  it('throws when it cannot read, so the cancel is re-driven before it is marked finished', async () => {
    const failing = {
      select: () => {
        throw new Error('connection lost');
      },
    } as unknown as Database;
    await expect(recordLeftOpenMerges(failing, 'task-1')).rejects.toThrow('connection lost');
  });
});

describe('recordLeftOpenMerges on a re-driven cancel', () => {
  const steps = [
    {
      id: 'step-1',
      state: {
        phase: 'resolving',
        mergeDir: '/repo',
        featureBranch: 'origin/main',
        fixInvocationId: null,
      },
    },
  ];

  beforeEach(() => {
    lock.inserted = [];
    git.mergeOpenFor.mockReset().mockResolvedValue(true);
    git.revParse.mockImplementation(async (_dir: string, ref: string) =>
      ref === 'MERGE_HEAD' ? 'm1' : 'h1',
    );
  });

  it('reports nothing for a directory another task now holds the claim on', async () => {
    lock.txResults = [[{ taskId: 'other-task' }]];
    const { db } = chainDb([[], steps, [{ worktreePath: null }]]);
    await recordLeftOpenMerges(db, 'task-1');
    expect(lock.inserted).toEqual([]);
  });

  it('reports a merge whose ref moved since, when the fixer baseline names its commits', async () => {
    lock.txResults = [[{ taskId: 'task-1' }]];
    git.mergeOpenFor.mockResolvedValue(false);
    const moved = [
      {
        id: 'step-1',
        state: {
          ...steps[0]!.state,
          fixBaseline: {
            head: 'h1',
            mergeHead: 'm1',
            tree: 't',
            index: 'i',
            ignored: '',
            resolving: [],
          },
        },
      },
    ];
    const { db } = chainDb([[], moved, [{ worktreePath: null }]]);
    await recordLeftOpenMerges(db, 'task-1');
    expect(lock.inserted).toEqual([
      expect.objectContaining({
        eventType: 'merge.left_open',
        payload: expect.objectContaining({ mergeHead: 'm1' }),
      }),
    ]);
  });

  it('reports the open merge while the claim is still this task’s', async () => {
    lock.txResults = [[{ taskId: 'task-1' }]];
    const { db } = chainDb([[], steps, [{ worktreePath: null }]]);
    await recordLeftOpenMerges(db, 'task-1');
    expect(lock.inserted).toEqual([
      expect.objectContaining({ eventType: 'merge.left_open', taskStepId: 'step-1' }),
    ]);
  });
});

describe('recordLeftOpenMerges for a merge that is already gone', () => {
  const kept = { '.haive-data/state/a.json': { owner: { uid: 1, gid: 1 }, mode: 0o600 } };
  const step = (over: Record<string, unknown> = {}) => [
    {
      id: 'step-1',
      state: {
        phase: 'resolving',
        mode: 'same-branch',
        mergeDir: '/repo',
        featureBranch: 'origin/main',
        fixInvocationId: null,
        keptMetadata: kept,
        ...over,
      },
    },
  ];
  const run = async (steps: unknown[], claim: unknown[] = [{ taskId: 'task-1' }]) => {
    lock.txResults = [claim];
    const made = chainDb([[], steps, [{ worktreePath: null }]], { repositoryId: 'repo-1' });
    await recordLeftOpenMerges(made.db, 'task-1');
    return made;
  };

  beforeEach(() => {
    lock.inserted = [];
    git.revParse.mockReset().mockResolvedValue(null);
    projections.settleProjections.mockReset().mockResolvedValue(true);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  it('puts the files a same-branch merge set aside back, and writes the cleared state by id', async () => {
    const { db, updates } = await run(step());
    expect(lock.inserted).toEqual([]);
    expect(projections.settleProjections).toHaveBeenCalledTimes(1);
    const [calledDb, repositoryId, state, save] = projections.settleProjections.mock.calls[0]!;
    expect(calledDb).toBe(db);
    expect(repositoryId).toBe('repo-1');
    expect(state).toEqual(expect.objectContaining({ mode: 'same-branch', keptMetadata: kept }));
    await save({ ...state, keptMetadata: undefined });
    expect(updates).toEqual([
      expect.objectContaining({
        mergeResolveState: expect.objectContaining({ phase: 'resolving' }),
      }),
    ]);
  });

  it('leaves a directory another task now holds the claim on to that task', async () => {
    await run(step(), [{ taskId: 'other-task' }]);
    expect(projections.settleProjections).not.toHaveBeenCalled();
  });

  it('still re-syncs a same-branch state that kept no metadata, since the checkout moved all the same', async () => {
    await run(step({ keptMetadata: undefined }));
    expect(projections.settleProjections).toHaveBeenCalledTimes(1);
    const [, repositoryId, state] = projections.settleProjections.mock.calls[0]!;
    expect(repositoryId).toBe('repo-1');
    expect(state).toEqual(
      expect.objectContaining({ mode: 'same-branch', keptMetadata: undefined }),
    );
  });

  it('puts nothing back for a merge in a worktree of its own', async () => {
    await run(step({ mode: 'cross-branch' }));
    expect(projections.settleProjections).not.toHaveBeenCalled();
  });

  it('does not fail the cancel when the put-back fails', async () => {
    projections.settleProjections.mockRejectedValue(new Error('disk full'));
    await expect(run(step())).resolves.toBeDefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-1', dir: '/repo' }),
      expect.any(String),
    );
  });
});

describe('abortLeftMerge', () => {
  beforeEach(() => {
    lock.txResults = [[]];
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    git.abortMerge.mockReset().mockResolvedValue({ ok: true });
    git.recordFixerLeftovers.mockReset().mockResolvedValue(undefined);
    git.relocateFixerChanges.mockReset();
    git.revParse.mockImplementation(async (_dir: string, ref: string) =>
      ref === 'MERGE_HEAD' ? 'm1' : 'h1',
    );
  });

  const reportedOpen = () => [
    {
      eventType: 'merge.left_open',
      payload: { dir: '/repo', ref: 'feat/a', head: 'h1', mergeHead: 'm1' },
    },
  ];
  const fixerStep = () => [
    {
      id: 'step-1',
      state: {
        phase: 'resolving',
        mergeDir: '/repo',
        featureBranch: 'feat/a',
        fixInvocationId: 'inv-1',
        fixBaseline: { head: 'h1', mergeHead: 'm1', tree: 't1' },
      },
    },
  ];
  const fixture = () =>
    chainDb([reportedOpen(), fixerStep(), [{ worktreePath: null }]], { status: 'cancelled' });

  it('leaves the merge open while the index still holds what the fixer staged', async () => {
    git.relocateFixerChanges.mockResolvedValue({ moved: [], indexHeld: 'index.lock exists' });
    const { db, inserted } = fixture();
    await abortLeftMerge(db, { taskId: 'task-1', userId: 'u', dir: '/repo', mergeHead: 'm1' });
    expect(git.abortMerge).not.toHaveBeenCalled();
    expect(inserted).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ outcome: 'refused', dir: '/repo', mergeHead: 'm1' }),
      }),
    ]);
  });

  it('refuses while a cancelled task sharing the worktree has not finished tearing down', async () => {
    git.relocateFixerChanges.mockResolvedValue({ moved: [], interrupted: [] });
    const { db, inserted } = chainDb(
      [reportedOpen(), fixerStep(), [{ worktreePath: null }], [{ id: 'sharer', title: 'other' }]],
      { status: 'cancelled' },
    );
    await abortLeftMerge(db, { taskId: 'task-1', userId: 'u', dir: '/repo', mergeHead: 'm1' });
    expect(git.abortMerge).not.toHaveBeenCalled();
    expect(inserted).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ outcome: 'refused' }) }),
    ]);
  });

  it('reports the changes as unchecked when the fixer baseline could not be recorded', async () => {
    const unchecked = { moved: [], interrupted: [], unchecked: 'nothing was recorded' };
    git.relocateFixerChanges.mockResolvedValue(unchecked);
    const step = [
      {
        id: 'step-1',
        state: { ...fixerStep()[0]!.state, fixBaseline: { unavailable: 'index read failed' } },
      },
    ];
    const { db } = chainDb([reportedOpen(), step, [{ worktreePath: null }]], {
      status: 'cancelled',
    });
    await abortLeftMerge(db, { taskId: 'task-1', userId: 'u', dir: '/repo', mergeHead: 'm1' });
    expect(git.relocateFixerChanges).toHaveBeenCalledWith(
      '/repo',
      { unavailable: 'index read failed' },
      expect.anything(),
      expect.any(Function),
    );
    expect(git.recordFixerLeftovers).toHaveBeenCalledWith(
      db,
      'task-1',
      'step-1',
      'feat/a',
      unchecked,
    );
    expect(git.abortMerge).toHaveBeenCalled();
  });

  it('is retried, not settled as refused, when reporting fails after the abort went through', async () => {
    git.relocateFixerChanges.mockResolvedValue({ moved: ['a.txt'], interrupted: [] });
    git.recordFixerLeftovers.mockRejectedValue(new Error('connection lost'));
    const { db, inserted } = fixture();
    await expect(
      abortLeftMerge(db, { taskId: 'task-1', userId: 'u', dir: '/repo', mergeHead: 'm1' }),
    ).rejects.toThrow('connection lost');
    expect(git.abortMerge).toHaveBeenCalled();
    expect(inserted).toEqual([]);
  });

  it('reports a moved-aside attempt left unreported when the merge is already gone', async () => {
    git.revParse.mockResolvedValue(null);
    const unreported = { moved: [], interrupted: ['.haive/merge-leftovers/task-1/inv-1'] };
    git.relocateFixerChanges.mockResolvedValue(unreported);
    const { db, inserted } = fixture();
    await abortLeftMerge(db, { taskId: 'task-1', userId: 'u', dir: '/repo', mergeHead: 'm1' });
    expect(git.relocateFixerChanges).toHaveBeenCalledWith(
      '/repo',
      null,
      expect.objectContaining({ taskId: 'task-1' }),
      expect.any(Function),
    );
    expect(git.recordFixerLeftovers).toHaveBeenCalledWith(
      db,
      'task-1',
      'step-1',
      'feat/a',
      unreported,
    );
    expect(inserted).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ outcome: 'moved' }) }),
    ]);
  });

  describe('for a same-branch merge', () => {
    const sameBranch = () => [
      {
        id: 'step-1',
        state: {
          ...fixerStep()[0]!.state,
          mode: 'same-branch',
          keptMetadata: { 'a.json': { mode: 0o600 } },
        },
      },
    ];
    const settleFixture = () =>
      chainDb([reportedOpen(), sameBranch(), [{ worktreePath: null }]], {
        status: 'cancelled',
        repositoryId: 'repo-1',
      });
    const job = { taskId: 'task-1', userId: 'u', dir: '/repo', mergeHead: 'm1' };

    beforeEach(() => {
      projections.settleProjections.mockReset().mockResolvedValue(true);
      git.relocateFixerChanges.mockResolvedValue(null);
    });

    it('is retried, not settled as refused, when putting Haive’s files back fails', async () => {
      git.revParse.mockResolvedValue(null);
      projections.settleProjections.mockRejectedValue(new Error('disk full'));
      const { db, inserted } = settleFixture();
      await expect(abortLeftMerge(db, job)).rejects.toThrow('disk full');
      expect(inserted).toEqual([]);
    });

    it('says Haive put its own project files back when it did, for a merge already gone', async () => {
      git.revParse.mockResolvedValue(null);
      const { db, inserted } = settleFixture();
      await abortLeftMerge(db, job);
      expect(inserted).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            outcome: 'moved',
            reason: expect.stringContaining('Haive put its own project files back'),
          }),
        }),
      ]);
    });

    it('keeps saying nothing was changed when a merge open there left nothing to put back', async () => {
      git.revParse.mockResolvedValue(null);
      projections.settleProjections.mockResolvedValue(false);
      const { db, inserted } = settleFixture();
      await abortLeftMerge(db, job);
      expect(inserted).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            outcome: 'moved',
            reason: expect.stringContaining('nothing was changed'),
          }),
        }),
      ]);
    });

    it('settles an abort with its own reason', async () => {
      git.relocateFixerChanges.mockResolvedValue({ moved: [], interrupted: [] });
      const { db, inserted } = settleFixture();
      await abortLeftMerge(db, job);
      expect(inserted).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            outcome: 'aborted',
            reason: expect.stringContaining('The checkout is back to how it was'),
          }),
        }),
      ]);
    });
  });
});

describe('noteAbortedByNext', () => {
  it('does not fail the resolver when settling the report fails after its merge was aborted', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const owners = [{ taskId: 'cancelled-1', title: 'old' }];
    const events = [
      {
        eventType: 'merge.left_open',
        payload: { dir: '/repo', ref: 'feat/a', head: 'h1', mergeHead: 'm1' },
      },
    ];
    const { db } = chainDb([owners, events]);
    (db as unknown as { insert: () => unknown }).insert = () => ({
      values: async () => {
        throw new Error('connection lost');
      },
    });
    const row = { id: 'step-2' } as TaskStepRow;
    await expect(
      noteAbortedByNext(db, row, 'task-2', '/repo', { head: 'h1', mergeHead: 'm1' }),
    ).resolves.toBe(row);
  });
});

describe('takeLeftOpenKept', () => {
  const owners = [{ taskId: 'cancelled-1', title: 'old' }];
  const ownerStep = (over: Record<string, unknown> = {}) => [
    {
      id: 'owner-step',
      state: {
        phase: 'resolving',
        mode: 'same-branch',
        mergeDir: '/repo',
        featureBranch: 'origin/main',
        fixInvocationId: null,
        keptMetadata: { 'a.json': { mode: 0o600 } },
        ...over,
      },
    },
  ];
  const open = { head: 'h1', mergeHead: 'm1' };

  it('gives save what the owners’ same-branch steps kept for the directory, and frees them after', async () => {
    const { db, updates } = chainDb([owners, ownerStep(), [{ worktreePath: null }]]);
    const save = vi.fn(async () => {
      expect(updates).toEqual([]);
    });
    const kept = await takeLeftOpenKept(db, 'next-task', '/repo', open, save);
    expect(save).toHaveBeenCalledWith({ 'a.json': { mode: 0o600 } });
    expect(kept).toEqual({ 'a.json': { mode: 0o600 } });
    expect(updates).toEqual([expect.objectContaining({ updatedAt: expect.any(Date) })]);
  });

  it('takes nothing off the owners when saving fails', async () => {
    const { db, updates } = chainDb([owners, ownerStep(), [{ worktreePath: null }]]);
    const save = vi.fn().mockRejectedValue(new Error('step was reset'));
    await expect(takeLeftOpenKept(db, 'next-task', '/repo', open, save)).rejects.toThrow(
      'step was reset',
    );
    expect(updates).toEqual([]);
  });

  it.each([
    ['kept nothing', { keptMetadata: undefined }],
    ['merged in another directory', { mergeDir: '/other' }],
    ['merged in a worktree of its own', { mode: 'cross-branch' }],
  ])('takes nothing from a step that %s', async (_name, over) => {
    const { db, updates } = chainDb([owners, ownerStep(over), [{ worktreePath: null }]]);
    const save = vi.fn();
    const kept = await takeLeftOpenKept(db, 'next-task', '/repo', open, save);
    expect(kept).toEqual({});
    expect(save).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });
});

describe('relocateLeftOpenFixers', () => {
  const owners = [{ taskId: 'cancelled-1', title: 'old' }];
  const report = [
    {
      eventType: 'merge.left_open',
      payload: { dir: '/repo', ref: 'feat/a', head: 'h1', mergeHead: 'm1' },
    },
  ];
  const ownerStep = [
    {
      id: 'owner-step',
      state: {
        phase: 'resolving',
        mergeDir: '/repo',
        featureBranch: 'feat/a',
        fixInvocationId: 'inv-9',
        fixBaseline: { head: 'h1', mergeHead: 'm1', tree: 't1' },
      },
    },
  ];

  beforeEach(() => {
    git.relocateFixerChanges.mockReset();
    git.recordFixerLeftovers.mockReset().mockResolvedValue(undefined);
  });

  it('moves the cancelled task’s fixer changes aside under its own report before the clear', async () => {
    const leftovers = { moved: ['x.txt'], interrupted: [] };
    git.relocateFixerChanges.mockResolvedValue(leftovers);
    const { db } = chainDb([owners, report, ownerStep, [{ worktreePath: null }]]);
    const held = await relocateLeftOpenFixers(db, 'next-task', '/repo', {
      head: 'h1',
      mergeHead: 'm1',
    });
    expect(held).toBeNull();
    expect(git.relocateFixerChanges).toHaveBeenCalledWith(
      '/repo',
      { head: 'h1', mergeHead: 'm1', tree: 't1' },
      expect.objectContaining({ taskId: 'cancelled-1', runId: 'inv-9' }),
      expect.any(Function),
    );
    expect(git.recordFixerLeftovers).toHaveBeenCalledWith(
      db,
      'cancelled-1',
      'owner-step',
      'feat/a',
      leftovers,
    );
  });

  it('says why the clear must not go ahead while the index still holds what the fixer staged', async () => {
    git.relocateFixerChanges.mockResolvedValue({ moved: [], interrupted: [], indexHeld: 'locked' });
    const { db } = chainDb([owners, report, ownerStep, [{ worktreePath: null }]]);
    const held = await relocateLeftOpenFixers(db, 'next-task', '/repo', {
      head: 'h1',
      mergeHead: 'm1',
    });
    expect(held).toContain('locked');
  });
});
