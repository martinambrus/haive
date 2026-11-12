import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database, MergeResolveState } from '@haive/database';
import { logger } from '@haive/shared';
import type { ProjectStateSyncOutcome } from './sync.js';
import type { ProjectStateRefreshOutcome } from './refresh.js';

const calls = vi.hoisted(() => ({
  outcome: 'applied' as string,
  refreshOutcome: { outcome: 'written' } as ProjectStateRefreshOutcome,
  dirty: { state: false, plan: false },
  unreadable: false,
  open: false,
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
      return calls.open;
    },
  };
});
vi.mock('./sync.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sync.js')>()),
  syncProjectStateFromCheckout: async () => ({
    outcome: calls.outcome,
    reason: 'record read refused',
    code: 'write_pending',
  }),
}));
vi.mock('./refresh.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./refresh.js')>()),
  refreshProjectStateOutcome: async () => calls.refreshOutcome,
}));
vi.mock('../plan/sync-checkout.js', () => ({ syncPlanFromCheckout: async () => undefined }));
vi.mock('../plan/mirror.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../plan/mirror.js')>()),
  flushPlanMirrorForRepository: async () => ({ files: [], repoPath: '/repo' }),
}));

const { resyncHaiveProjections, restoreFaults } = await import('./set-aside.js');
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
  const db = {
    select,
    insert: () => ({ values: () => ({ onConflictDoUpdate: async () => [] }) }),
    execute: async () => [],
    transaction: async (fn: (tx: Database) => Promise<unknown>) => fn(db),
  } as unknown as Database;
  return db;
}

beforeEach(() => {
  calls.outcome = 'applied';
  calls.refreshOutcome = { outcome: 'written' };
  calls.dirty = { state: false, plan: false };
  calls.unreadable = false;
  calls.open = false;
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
    calls.refreshOutcome = { outcome: 'held', reason: 'checkout' };
    expect(await resyncHaiveProjections(marksDb(), 'repo-1', '/repo')).toBe(false);
  });

  it('answers false for a deferred sync whose pending write deferred with it', async () => {
    calls.outcome = 'deferred';
    calls.dirty.state = true;
    calls.refreshOutcome = { outcome: 'held', reason: 'checkout' };
    expect(await resyncHaiveProjections(marksDb(), 'repo-1', '/repo')).toBe(false);
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

  it('answers false from settleProjections and retains the durable handoff', async () => {
    calls.unreadable = true;
    const save = vi.fn();
    const given = { mergeDir: '/repo', keptMetadata: { 'a.json': { mode: 0o600 } } };
    expect(
      await settleProjections(marksDb(), 'repo-1', given as unknown as MergeResolveState, save),
    ).toBe(false);
    expect(save).toHaveBeenCalledExactlyOnceWith(
      { ...given, keptMetadataStored: true },
      expect.anything(),
    );
  });
});

afterEach(() => vi.restoreAllMocks());
it.each<ProjectStateSyncOutcome>(['held', 'superseded', 'refused'])(
  'warns once for a standing structured %s diagnosis',
  async (outcome) => {
    calls.outcome = outcome;
    const repositoryId = `standing-${outcome}`;
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(await resyncHaiveProjections(marksDb(), repositoryId, '/repo')).toBe(false);
    }
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      {
        repositoryId,
        reasons: [
          { phase: 'state_sync', outcome, reason: 'record read refused', code: 'write_pending' },
        ],
      },
      expect.any(String),
    );
  },
);

it('warns for changed reasons and re-arms all reasons after success for that repository', async () => {
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const retry = () => resyncHaiveProjections(marksDb(), 'changed-reasons', '/repo');
  calls.outcome = 'held';
  expect(await retry()).toBe(false);
  calls.outcome = 'refused';
  expect(await retry()).toBe(false);
  expect(await retry()).toBe(false);
  expect(warn).toHaveBeenCalledTimes(2);
  calls.outcome = 'applied';
  expect(await retry()).toBe(true);
  calls.outcome = 'held';
  expect(await retry()).toBe(false);
  calls.outcome = 'refused';
  expect(await retry()).toBe(false);
  expect(warn).toHaveBeenCalledTimes(4);
});

it('deduplicates admission failures independently per repository', async () => {
  calls.open = true;
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  for (const repositoryId of ['admission-a', 'admission-a', 'admission-b', 'admission-b']) {
    expect(await resyncHaiveProjections(marksDb(), repositoryId, '/repo')).toBe(false);
  }
  expect(warn).toHaveBeenCalledTimes(2);
});

it('evicts the oldest warning at the 4096-entry bound', async () => {
  calls.open = true;
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const retry = (n: number) => resyncHaiveProjections(marksDb(), `bounded-${n}`, '/repo');
  for (let n = 0; n <= 4096; n++) expect(await retry(n)).toBe(false);
  expect(warn).toHaveBeenCalledTimes(4097);
  expect(await retry(4096)).toBe(false);
  expect(warn).toHaveBeenCalledTimes(4097);
  expect(await retry(0)).toBe(false);
  expect(warn).toHaveBeenCalledTimes(4098);
});

it('retains sanitized database diagnostics in an incomplete attempt', async () => {
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  restoreFaults.beforeResync = (phase) => {
    if (phase === 'state')
      throw Object.assign(new Error('bound secret'), {
        params: ['secret'],
        code: '23505',
        query: 'UPDATE x SET v = $1',
      });
  };
  try {
    expect(await resyncHaiveProjections(marksDb(), 'repo-1', '/repo')).toBe(false);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      {
        repositoryId: 'repo-1',
        reasons: [
          {
            phase: 'state',
            reason: 'Database operation failed',
            error: { type: 'Error', code: '23505', query: 'UPDATE x SET v = $1' },
          },
        ],
      },
      expect.any(String),
    );
  } finally {
    delete restoreFaults.beforeResync;
  }
});

it.each<ProjectStateRefreshOutcome>([
  { outcome: 'missing' },
  { outcome: 'absent' },
  { outcome: 'superseded' },
  { outcome: 'held', reason: 'git_operation' },
  { outcome: 'held', reason: 'recovery' },
  { outcome: 'held', reason: 'checkout' },
  { outcome: 'held', reason: 'sync', code: 'write_pending', detail: 'record recovery pending' },
  { outcome: 'refused', reason: 'record' },
  { outcome: 'refused', reason: 'context' },
])('diagnoses the state writer outcome $outcome $reason', async (result) => {
  calls.dirty.state = true;
  calls.refreshOutcome = result;
  const repositoryId = `writer-${JSON.stringify(result)}`;
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  expect(await resyncHaiveProjections(marksDb(), repositoryId, '/repo')).toBe(false);
  expect(warn).toHaveBeenCalledExactlyOnceWith(
    { repositoryId, reasons: [{ phase: 'state_write', ...result }] },
    expect.any(String),
  );
});

it('logs the sync result only once when the writer also holds', async () => {
  calls.outcome = 'held';
  calls.dirty.state = true;
  calls.refreshOutcome = { outcome: 'held', reason: 'sync', code: 'write_pending' };
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  expect(await resyncHaiveProjections(marksDb(), 'sync-and-write-held', '/repo')).toBe(false);
  expect(warn).toHaveBeenCalledExactlyOnceWith(
    {
      repositoryId: 'sync-and-write-held',
      reasons: [
        {
          phase: 'state_sync',
          outcome: 'held',
          reason: 'record read refused',
          code: 'write_pending',
        },
        { phase: 'state_write', ...calls.refreshOutcome },
      ],
    },
    expect.any(String),
  );
});

it('continues to accept a stable writer blockage as completed', async () => {
  calls.dirty.state = true;
  calls.refreshOutcome = {
    outcome: 'blocked',
    code: 'unowned_malformed_rtk',
    file: 'settings/rtk-enabled.json',
  };
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  expect(await resyncHaiveProjections(marksDb(), 'writer-blocked', '/repo')).toBe(true);
  expect(warn).not.toHaveBeenCalled();
});

it('retains caller context in the shared warning without bypassing deduplication', async () => {
  calls.outcome = 'held';
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const { resyncWithKeptMetadata } = await import('./set-aside.js');
  for (const context of ['refresh', 'sync_base', 'plan_pull']) {
    expect(
      await resyncWithKeptMetadata(marksDb(), 'context-repo', '/repo', new Map(), context),
    ).toBe(false);
  }
  expect(warn).toHaveBeenCalledExactlyOnceWith(
    {
      repositoryId: 'context-repo',
      context: 'refresh',
      reasons: [
        {
          phase: 'state_sync',
          outcome: 'held',
          reason: 'record read refused',
          code: 'write_pending',
        },
      ],
    },
    expect.any(String),
  );
});
