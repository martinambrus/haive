import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, h, payload, setup } from './support/plan-mirror-failure.js';
import { saveCore } from '../src/queues/plan-mirror-queue.js';
beforeEach(setup);
afterEach(cleanup);
describe('the Save core seams', () => {
  it('prepares then commits before the shared push tail, preserving the caller message', async () => {
    const calls: string[] = [];
    const result = await saveCore(
      { ...payload, push: false, commitMessage: '  custom  ' },
      {
        prepare: async () => {
          calls.push('prepare');
          return { files: ['record'], repoPath: '/repo' };
        },
        commit: async (args) => {
          calls.push('commit');
          expect(args.message).toBe('custom');
          return { committed: true, commitSha: 'sha' };
        },
        afterLanding: async () => {
          calls.push('landed');
        },
      },
    );
    expect(calls).toEqual(['prepare', 'commit']);
    expect(result).toMatchObject({
      committed: true,
      commitSha: 'sha',
      files: ['record'],
      pushed: false,
    });
    expect(h.flush).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
  });
  it('calls the scope after a landed integration and recovers its failure', async () => {
    const error = new Error('landed seam failed');
    const afterLanding = vi.fn().mockRejectedValue(error);
    await expect(
      saveCore(payload, {
        prepare: async () => ({ files: ['record'], repoPath: '/repo' }),
        commit: async () => ({ committed: false, commitSha: null }),
        afterLanding,
      }),
    ).rejects.toBe(error);
    expect(afterLanding).toHaveBeenCalledOnce();
    expect(h.reconcile).not.toHaveBeenCalled();
    expect(h.record).toHaveBeenCalled();
  });
});
