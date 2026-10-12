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

vi.mock('./git-merge.js', () => ({
  abortFailureNote: () => 'abort failed',
  abortMerge: git.abortMerge,
  isHostCheckout: () => false,
  mergeOpenFor: (...args: unknown[]) => git.mergeOpenFor(...args),
  recordFixerLeftovers: git.recordFixerLeftovers,
  relocateFixerChanges: git.relocateFixerChanges,
  revParse: git.revParse,
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

import { abortLeftMerge, noteAbortedByNext, recordLeftOpenMerges } from './left-open-merge.js';
import type { TaskStepRow } from './step-runner.js';

/** A query builder whose every chained call resolves to the next queued result, in call order. */
function chainDb(results: unknown[][], findFirst: unknown = null) {
  const inserted: unknown[] = [];
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
  };
  return { db: db as unknown as Database, inserted };
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
