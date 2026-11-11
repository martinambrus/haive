import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database, MergeResolveState } from '@haive/database';

const h = vi.hoisted(() => ({ resync: vi.fn(), restore: vi.fn() }));
vi.mock('../project-state/set-aside.js', () => ({
  resyncHaiveProjections: h.resync,
  resyncWithKeptMetadata: h.resync,
  restoreKeptMetadata: h.restore,
}));
import { settleProjections } from './merge-projections.js';

beforeEach(() => {
  h.resync.mockReset().mockResolvedValue(true);
  h.restore.mockReset().mockResolvedValue(true);
});

describe('merge metadata settlement', () => {
  it.each(['held', 'restore-failed', 'success'] as const)(
    'settles only once recovery finished: %s',
    async (outcome) => {
      const state = {
        mergeDir: '/repo',
        keptMetadata: { '.haive-data/plan.json': { owner: { uid: 1000, gid: 1000 }, mode: 0o600 } },
      } as unknown as MergeResolveState;
      const save = vi.fn();
      if (outcome === 'held') h.resync.mockResolvedValue(false);
      if (outcome === 'restore-failed') h.restore.mockResolvedValue(false);
      expect(await settleProjections({} as Database, 'r1', state, save)).toBe(
        outcome === 'success',
      );
      expect(state.keptMetadata).toBeDefined();
      if (outcome === 'success')
        expect(save).toHaveBeenCalledExactlyOnceWith({ ...state, keptMetadata: undefined });
      else expect(save).not.toHaveBeenCalled();
    },
  );
});
