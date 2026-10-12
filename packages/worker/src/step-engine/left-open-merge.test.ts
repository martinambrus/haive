import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';

const git = vi.hoisted(() => ({
  abortMerge: vi.fn(),
  relocateFixerChanges: vi.fn(),
  revParse: vi.fn(),
}));

vi.mock('./git-merge.js', () => ({
  abortFailureNote: () => 'abort failed',
  abortMerge: git.abortMerge,
  isHostCheckout: () => false,
  mergeOpenFor: async () => true,
  recordFixerLeftovers: async () => undefined,
  relocateFixerChanges: git.relocateFixerChanges,
  revParse: git.revParse,
}));
vi.mock('./merge-dir-claim.js', () => ({
  inMergeDirLock: async (_db: unknown, _dir: string, fn: (tx: unknown) => unknown) =>
    fn(chainDb([[]]).db),
  liveClaimHolder: async () => null,
}));
vi.mock('../repo/worktree-claims.js', () => ({ findWorktreePathClaimant: async () => null }));
vi.mock('../queues/cli-exec/secret-mask.js', () => ({ taskSecretMaskPolicy: async () => ({}) }));
vi.mock('./step-ownership.js', () => ({
  addStepWarning: async (_db: unknown, row: unknown) => row,
}));

import { abortLeftMerge, recordLeftOpenMerges } from './left-open-merge.js';

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

describe('abortLeftMerge', () => {
  beforeEach(() => {
    git.abortMerge.mockReset().mockResolvedValue({ ok: true });
    git.revParse.mockImplementation(async (_dir: string, ref: string) =>
      ref === 'MERGE_HEAD' ? 'm1' : 'h1',
    );
  });

  it('leaves the merge open while the index still holds what the fixer staged', async () => {
    git.relocateFixerChanges.mockResolvedValue({ moved: [], indexHeld: 'index.lock exists' });
    const events = [
      {
        eventType: 'merge.left_open',
        payload: { dir: '/repo', ref: 'feat/a', head: 'h1', mergeHead: 'm1' },
      },
    ];
    const steps = [
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
    const { db, inserted } = chainDb([events, steps, [{ worktreePath: null }]], {
      status: 'cancelled',
    });
    await abortLeftMerge(db, { taskId: 'task-1', userId: 'u', dir: '/repo' });
    expect(git.abortMerge).not.toHaveBeenCalled();
    expect(inserted).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ outcome: 'refused', dir: '/repo', mergeHead: 'm1' }),
      }),
    ]);
  });
});
