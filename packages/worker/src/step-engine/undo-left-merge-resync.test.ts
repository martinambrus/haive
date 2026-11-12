import { beforeEach, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { leftCommittedMerges } from '@haive/shared/merge-left-open';
import { undoLeftMerge } from './undo-left-merge.js';

const h = vi.hoisted(() => ({
  sync: vi.fn(),
  git: vi.fn(),
  release: vi.fn(),
  insert: vi.fn(),
  holder: false,
}));
vi.mock('@haive/database', async (original) => ({
  ...(await original<object>()),
  acquireRootClaim: async () => ({ release: h.release }),
  lockRepositoryTasksKey: async () => undefined,
}));
vi.mock('@haive/shared/fs-safe', async (original) => ({
  ...(await original<object>()),
  lstatNoFollow: async () => ({ kind: 'directory' }),
}));
vi.mock('./merge-dir-claim.js', () => ({
  inMergeDirLock: async (db: unknown, _dir: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn(db),
  liveClaimHolder: async () => (h.holder ? { id: 'other', title: 'Other' } : null),
  otherLiveClaim: async () => null,
}));
vi.mock('../repo/refresh.js', () => ({ checkoutHoldingTasks: async () => 0 }));
vi.mock('../repo/worktree-claims.js', () => ({ findWorktreePathClaimant: async () => null }));
vi.mock('../repo/git-push.js', () => ({
  gitRun: h.git,
  originGitRun: h.git,
  detectOrigin: h.git,
  buildCredentialHelper: h.git,
  scrubSecret: (s: string) => s,
}));
vi.mock('./git-merge.js', () => ({
  isHostCheckout: () => false,
  revParse: h.git,
  handBackAfterMove: h.git,
}));
vi.mock('../project-state/set-aside.js', () => ({
  resyncHaiveProjections: h.sync,
  setAsideHaiveProjections: h.git,
  putBackProjections: h.git,
  restoreProjectionsInTx: h.git,
}));

const payload = {
  dir: '/repo',
  repoPath: '/repo',
  landedOn: 'main',
  landedAt: '2026-11-11T00:00:00Z',
  baseShaBefore: 'a'.repeat(40),
  baseShaAfter: 'b'.repeat(40),
};
let events: { eventType: string; payload: Record<string, unknown> }[];
let db: Database;
const run = () =>
  undoLeftMerge(db, {
    taskId: 't',
    userId: 'u',
    dir: payload.dir,
    baseShaAfter: payload.baseShaAfter,
  });
beforeEach(() => {
  vi.clearAllMocks();
  h.holder = false;
  h.sync.mockResolvedValue(true);
  h.git.mockResolvedValue({ code: 1, stdout: '' });
  events = [
    { eventType: 'task.cancel_finished', payload: {} },
    { eventType: 'merge.left_committed', payload },
    { eventType: 'merge.left_committed_settled', payload: { ...payload, outcome: 'undone' } },
  ];
  h.insert.mockImplementation(async (event: (typeof events)[number]) => {
    events.push(event);
  });
  db = {
    query: {
      tasks: { findFirst: async () => ({ status: 'cancelled', repositoryId: 'r' }) },
      repositories: { findFirst: async () => ({ storagePath: '/repo' }) },
    },
    select: () => ({
      from: (table: unknown) => ({
        where: () =>
          table === schema.mergeDirClaims
            ? { for: async () => [{ taskId: 'other' }] }
            : { orderBy: async () => events },
      }),
    }),
    insert: () => ({ values: h.insert }),
  } as unknown as Database;
});
it('re-syncs a settled report without any git move and records completion once on redelivery', async () => {
  await run();
  await run();
  expect(h.sync).toHaveBeenCalledTimes(1);
  expect(h.git).not.toHaveBeenCalled();
  expect(events.filter((e) => e.eventType === 'merge.left_committed_resynced')).toHaveLength(1);
  expect(leftCommittedMerges(events)[0]?.resyncOwed).toBe(false);
});
it('leaves recovery owed until re-sync returns true', async () => {
  h.sync.mockResolvedValueOnce(false);
  await expect(run()).rejects.toThrow(/re-sync/);
  expect(h.insert).not.toHaveBeenCalled();
  expect(leftCommittedMerges(events)[0]?.resyncOwed).toBe(true);
  await run();
  expect(leftCommittedMerges(events)[0]?.resyncOwed).toBe(false);
});
it('keeps recovery owed when writing completion fails and retries the journal', async () => {
  h.insert.mockRejectedValueOnce(new Error('journal unavailable'));
  await expect(run()).rejects.toThrow('journal unavailable');
  expect(leftCommittedMerges(events)[0]?.resyncOwed).toBe(true);
  await run();
  expect(events.filter((e) => e.eventType === 'merge.left_committed_resynced')).toHaveLength(1);
});
it('keeps recovery owed behind a live directory holder', async () => {
  h.holder = true;
  await expect(run()).rejects.toThrow(/pending/);
  expect(h.sync).not.toHaveBeenCalled();
  expect(h.insert).not.toHaveBeenCalled();
});
