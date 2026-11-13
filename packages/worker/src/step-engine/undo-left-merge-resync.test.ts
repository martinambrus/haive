import { beforeEach, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { leftCommittedMerges } from '@haive/shared/merge-left-open';
import { undoLeftMerge } from './undo-left-merge.js';

const h = vi.hoisted(() => ({
  sync: vi.fn(),
  git: vi.fn(),
  revParse: vi.fn(),
  handBack: vi.fn(),
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
  revParse: h.revParse,
  handBackAfterMove: h.handBack,
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
  featureBranch: 'feature',
  featureSha: 'f'.repeat(40),
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
  h.git.mockResolvedValue({ code: 0, stdout: 'refs/heads/main\n' });
  h.revParse.mockResolvedValue(payload.baseShaBefore);
  h.handBack.mockResolvedValue(undefined);
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
it('hands back a settled checkout before re-sync without git writes and completes once on redelivery', async () => {
  await run();
  await run();
  expect(h.sync).toHaveBeenCalledTimes(1);
  expect(h.git.mock.calls).toEqual([[payload.dir, ['symbolic-ref', '-q', 'HEAD']]]);
  expect(h.revParse).toHaveBeenCalledExactlyOnceWith(payload.dir, 'HEAD');
  // Strict: a chown that fails must throw, so the completion is not recorded over root-owned files.
  expect(h.handBack).toHaveBeenCalledExactlyOnceWith(payload.dir, payload.baseShaAfter, true);
  expect(h.handBack.mock.invocationCallOrder[0]).toBeLessThan(h.sync.mock.invocationCallOrder[0]!);
  expect(events.filter((e) => e.eventType === 'merge.left_committed_resynced')).toHaveLength(1);
  expect(leftCommittedMerges(events)[0]?.resyncOwed).toBe(false);
});
it('retries a failed hand-back before re-sync and keeps recovery owed meanwhile', async () => {
  h.handBack.mockRejectedValueOnce(new Error('hand-back failed'));
  await expect(run()).rejects.toThrow('hand-back failed');
  expect(h.sync).not.toHaveBeenCalled();
  expect(h.insert).not.toHaveBeenCalled();
  expect(h.release).toHaveBeenCalledTimes(1);
  expect(leftCommittedMerges(events)[0]?.resyncOwed).toBe(true);
  await run();
  expect(h.handBack).toHaveBeenCalledTimes(2);
  expect(h.handBack.mock.invocationCallOrder[1]).toBeLessThan(h.sync.mock.invocationCallOrder[0]!);
  expect(leftCommittedMerges(events)[0]?.resyncOwed).toBe(false);
});
it.each(['switched', 'detached', 'moved'])(
  're-syncs projections without handing back an unrelated %s checkout',
  async (kind) => {
    if (kind === 'switched') h.git.mockResolvedValue({ code: 0, stdout: 'refs/heads/other' });
    else if (kind === 'detached') h.git.mockResolvedValue({ code: 1, stdout: '' });
    else h.revParse.mockResolvedValue('c'.repeat(40));
    await run();
    expect(h.git).toHaveBeenCalledExactlyOnceWith(payload.dir, ['symbolic-ref', '-q', 'HEAD']);
    expect(h.handBack).not.toHaveBeenCalled();
    expect(h.sync).toHaveBeenCalledTimes(1);
    expect(leftCommittedMerges(events)[0]?.resyncOwed).toBe(false);
  },
);
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
