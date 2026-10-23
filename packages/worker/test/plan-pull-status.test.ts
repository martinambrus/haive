import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: null as unknown,
  sha: 'a'.repeat(40),
  status: { code: 0, stdout: '', stderr: '' },
  fetch: vi.fn(),
  recordError: vi.fn(),
  recover: vi.fn(),
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/secrets/user-git-identity.js', () => ({ resolveGitEnv: async () => ({}) }));
vi.mock('../src/repo/refresh.js', () => ({ checkoutHoldingTasks: async () => 0 }));
vi.mock('../src/repo/git-push.js', async (original) => ({
  ...(await original<typeof import('../src/repo/git-push.js')>()),
  detectOrigin: async () => true,
  pushBranch: vi.fn(),
  gitRun: async (_cwd: string, args: string[]) => {
    if (args.includes('status')) return h.status;
    if (args.join(' ') === 'rev-parse --is-inside-work-tree') {
      return { code: 0, stdout: 'true', stderr: '' };
    }
    if (args.join(' ') === 'branch --show-current') {
      return { code: 0, stdout: 'main', stderr: '' };
    }
    if (args.join(' ') === 'rev-parse HEAD') return { code: 0, stdout: h.sha, stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  },
}));
vi.mock('../src/plan/mirror.js', () => ({
  PlanMirrorHeldError: class extends Error {},
  flushPlanMirrorForRepository: async () => ({ files: [] }),
  advancePlanBaseFromCommit: vi.fn(),
  recordPlanMirrorError: h.recordError,
  reconcilePlanFromCheckout: async () => ({ skipped: false }),
  seedPlanBaseFromCheckout: async () => {},
  writePlanMirror: async () => {},
}));
vi.mock('../src/plan/snapshot-git.js', () => ({
  commitPlanSnapshotFiles: async () => ({ committed: false, commitSha: null }),
}));
vi.mock('../src/project-state/set-aside.js', () => ({
  MOVE_ATTEMPTS: 3,
  setAsideHaiveProjections: async () => ({ outcome: 'clean' }),
  restoreProjectionsInTx: async () => ({ outcome: 'clean' }),
  putBackProjections: async () => {},
  restoreKeptMetadata: async () => {},
  resyncHaiveProjections: async () => {},
  recoverAfterMoveFailure: h.recover,
}));
vi.mock('../src/plan/merge.js', async (original) => ({
  ...(await original<typeof import('../src/plan/merge.js')>()),
  fetchOrigin: h.fetch,
  divergence: async () => ({ behind: 0, ahead: 0, unrelated: false }),
}));

import { pull } from '../src/queues/plan-mirror-queue.js';

beforeEach(() => {
  vi.clearAllMocks();
  h.status = { code: 0, stdout: '', stderr: '' };
  h.fetch.mockResolvedValue(undefined);
  h.recordError.mockResolvedValue(undefined);
  h.recover.mockImplementation(async (...a: unknown[]) => {
    throw a[5];
  });
  const db = {
    query: {
      repositories: {
        findFirst: async () => ({
          id: 'r1',
          userId: 'u1',
          credentialsSecretId: null,
          storagePath: '/repo',
          localPath: null,
          branch: 'main',
        }),
      },
      planMirrorState: { findFirst: async () => ({ revision: 1, writtenRevision: 1 }) },
    },
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    execute: async () => {},
    transaction: async (fn: (conn: unknown) => Promise<unknown>) => fn(db),
    insert: () => ({ values: async () => {} }),
  };
  h.db = db;
});

describe('plan pull reads the whole-checkout git status', () => {
  it.each([
    [
      { code: 128, stderr: 'fatal: simulated status failure', stdout: '' },
      'fatal: simulated status failure',
    ],
    [
      { code: 124, stderr: 'git status timed out after 30 s', stdout: '' },
      'git status timed out after 30 s',
    ],
    [{ code: 1, stderr: '', stdout: 'detail on stdout' }, 'detail on stdout'],
  ])('refuses to pull when status fails: %j', async (status, output) => {
    h.status = status;
    const message = `git status failed in /repo: ${output}`;
    await expect(pull({ repositoryId: 'r1', userId: 'u1' })).rejects.toThrow(message);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.recover).toHaveBeenCalledTimes(1);
    expect(h.recover.mock.calls[0]?.[5]).toEqual(expect.objectContaining({ message }));
  });

  it('pulls when status is clean', async () => {
    await expect(pull({ repositoryId: 'r1', userId: 'u1' })).resolves.toBeDefined();
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses a checkout with modified tracked files', async () => {
    h.status = { code: 0, stdout: ' M tracked.txt\n', stderr: '' };
    await expect(pull({ repositoryId: 'r1', userId: 'u1' })).rejects.toThrow(
      /^this checkout has uncommitted changes; commit or discard them first$/,
    );
    expect(h.fetch).not.toHaveBeenCalled();
  });
});
