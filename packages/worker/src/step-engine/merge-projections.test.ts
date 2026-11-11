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
        expect(save).toHaveBeenCalledExactlyOnceWith({ ...state, keptMetadata: undefined });
      else expect(save).not.toHaveBeenCalled();
    },
  );
});
