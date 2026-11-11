import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database, MergeResolveState } from '@haive/database';

const h = vi.hoisted(() => ({ resync: vi.fn(), restore: vi.fn(), remember: vi.fn() }));
vi.mock('../project-state/set-aside.js', () => ({
  resyncHaiveProjections: h.resync,
  resyncWithKeptMetadata: h.resync,
  restoreKeptMetadata: h.restore,
}));
vi.mock('../project-state/kept-metadata.js', async (original) => ({
  ...(await original<typeof import('../project-state/kept-metadata.js')>()),
  rememberKeptMetadata: h.remember,
}));
import { settleProjections } from './merge-projections.js';

beforeEach(() => {
  h.resync.mockReset().mockResolvedValue(true);
  h.restore.mockReset().mockResolvedValue(true);
  h.remember.mockReset().mockResolvedValue(undefined);
});

describe('merge metadata settlement', () => {
  it.each(['crash', 'guard-refused'] as const)(
    'atomically hands off legacy metadata when the marker save is %s',
    async (failure) => {
      const state = {
        mergeDir: '/repo',
        keptMetadata: { '.haive-data/plan.json': { mode: 0o600 } },
      } as unknown as MergeResolveState;
      let pending = false;
      let stored = false;
      const tx = { transactionMarker: true };
      const db = {
        transaction: async (run: (tx: unknown) => Promise<unknown>) => {
          const before = { pending, stored };
          try {
            return await run(tx);
          } catch (err) {
            pending = before.pending;
            stored = before.stored;
            throw err;
          }
        },
      } as unknown as Database;
      h.remember.mockImplementation(async () => {
        pending = true;
      });
      const save = vi.fn(async (_next, _handle) => {
        if (failure === 'guard-refused') return false;
        stored = true;
        throw new Error('crash before commit');
      });
      if (failure === 'crash')
        await expect(settleProjections(db, 'r1', state, save)).rejects.toThrow(
          'crash before commit',
        );
      else expect(await settleProjections(db, 'r1', state, save)).toBe(false);
      expect(pending).toBe(false);
      expect(stored).toBe(false);
      expect(save.mock.calls[0]?.[1]).toBe(tx);
      expect(h.resync).not.toHaveBeenCalled();
    },
  );

  it('writes the legacy marker and map on the same transaction handle', async () => {
    const state = {
      mergeDir: '/repo',
      keptMetadata: { 'a.json': { mode: 0o600 } },
    } as unknown as MergeResolveState;
    const tx = { marker: true };
    const db = {
      transaction: async (run: (tx: unknown) => Promise<unknown>) => run(tx),
    } as unknown as Database;
    const save = vi.fn(async () => true);
    h.resync.mockResolvedValue(false);
    expect(await settleProjections(db, 'r1', state, save)).toBe(false);
    expect(save).toHaveBeenCalledExactlyOnceWith({ ...state, keptMetadataStored: true }, tx);
    expect(h.remember).toHaveBeenCalledExactlyOnceWith(tx, 'r1', '/repo', state.keptMetadata);
  });

  it.each(['held', 'success'] as const)(
    'settles only once recovery finished: %s',
    async (outcome) => {
      const state = {
        mergeDir: '/repo',
        keptMetadata: { '.haive-data/plan.json': { owner: { uid: 1000, gid: 1000 }, mode: 0o600 } },
        keptMetadataStored: true,
      } as unknown as MergeResolveState;
      const save = vi.fn();
      if (outcome === 'held') h.resync.mockResolvedValue(false);
      expect(await settleProjections({} as Database, 'r1', state, save)).toBe(
        outcome === 'success',
      );
      expect(state.keptMetadata).toBeDefined();
      expect(h.remember).not.toHaveBeenCalled();
      expect(h.restore).not.toHaveBeenCalled();
      if (outcome === 'success')
        expect(save).toHaveBeenCalledExactlyOnceWith(
          { ...state, keptMetadata: undefined },
          expect.anything(),
        );
      else expect(save).not.toHaveBeenCalled();
    },
  );
});
