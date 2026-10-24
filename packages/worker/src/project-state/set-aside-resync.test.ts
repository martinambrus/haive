import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database, MergeResolveState } from '@haive/database';
import type { ProjectStateSyncOutcome } from './sync.js';

const calls = vi.hoisted(() => ({
  outcome: 'applied' as string,
  refreshed: true,
  dirty: { state: false, plan: false },
  unreadable: false,
}));

vi.mock('../repo/git-operation.js', () => {
  class GitOperationUnreadableError extends Error {}
  return {
    GitOperationUnreadableError,
    gitOperationInProgress: async () => {
      if (calls.unreadable) {
        throw new GitOperationUnreadableError(
          'git rev-parse --git-path MERGE_HEAD failed in /repo: fatal: bad config line 11',
        );
      }
      return false;
    },
  };
});
vi.mock('./sync.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sync.js')>()),
  syncProjectStateFromCheckout: async () => ({ outcome: calls.outcome }),
}));
vi.mock('./refresh.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./refresh.js')>()),
  refreshProjectState: async () => calls.refreshed,
}));
vi.mock('../plan/sync-checkout.js', () => ({ syncPlanFromCheckout: async () => undefined }));
vi.mock('../plan/mirror.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../plan/mirror.js')>()),
  flushPlanMirrorForRepository: async () => ({ files: [], repoPath: '/repo' }),
}));

const { resyncHaiveProjections } = await import('./set-aside.js');
const { settleProjections } = await import('../step-engine/merge-projections.js');
const { schema } = await import('@haive/database');

/** The outbox and plan mark rows the re-sync reads, nothing else. */
function marksDb(): Database {
  const select = () => ({
    from: (table: unknown) => ({
      where: () => ({
        limit: async () => {
          const dirty = table === schema.projectStateOutbox ? calls.dirty.state : calls.dirty.plan;
          return [{ revision: 2, written: dirty ? 1 : 2 }];
        },
      }),
    }),
  });
  return { select } as unknown as Database;
}

beforeEach(() => {
  calls.outcome = 'applied';
  calls.refreshed = true;
  calls.dirty = { state: false, plan: false };
  calls.unreadable = false;
});

describe('resyncHaiveProjections settles only a state sync that finished', () => {
  it.each<ProjectStateSyncOutcome>(['held', 'superseded', 'refused'])(
    'answers false when the state sync was %s',
    async (outcome) => {
      calls.outcome = outcome;
      expect(await resyncHaiveProjections(marksDb(), 'repo-1', '/repo')).toBe(false);
    },
  );

  it.each<ProjectStateSyncOutcome>(['applied', 'unchanged', 'absent', 'conflict', 'deferred'])(
    'answers true when the state sync was %s',
    async (outcome) => {
      calls.outcome = outcome;
      expect(await resyncHaiveProjections(marksDb(), 'repo-1', '/repo')).toBe(true);
    },
  );

  it('answers false when the pending state could not be written', async () => {
    calls.dirty.state = true;
    calls.refreshed = false;
    expect(await resyncHaiveProjections(marksDb(), 'repo-1', '/repo')).toBe(false);
  });

  it('answers true for a deferred sync whose pending write deferred with it', async () => {
    calls.outcome = 'deferred';
    calls.dirty.state = true;
    calls.refreshed = false;
    expect(await resyncHaiveProjections(marksDb(), 'repo-1', '/repo')).toBe(true);
  });

  it('answers true when the pending state was written', async () => {
    calls.dirty.state = true;
    expect(await resyncHaiveProjections(marksDb(), 'repo-1', '/repo')).toBe(true);
  });
});

describe('an unreadable git never makes a re-sync throw', () => {
  it('answers false from resyncHaiveProjections', async () => {
    calls.unreadable = true;
    expect(await resyncHaiveProjections(marksDb(), 'repo-1', '/repo')).toBe(false);
  });

  it('answers false from settleProjections and saves nothing', async () => {
    calls.unreadable = true;
    const save = vi.fn();
    const given = { mergeDir: '/repo', keptMetadata: { 'a.json': { mode: 0o600 } } };
    expect(
      await settleProjections(marksDb(), 'repo-1', given as unknown as MergeResolveState, save),
    ).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });
});
