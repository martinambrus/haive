import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: null as unknown,
  sha: 'a'.repeat(40),
  status: { code: 0, stdout: '', stderr: '' },
  branch: { code: 0, stdout: 'main', stderr: '' },
  fetch: vi.fn(),
  recordError: vi.fn(),
  recover: vi.fn(),
  detectOrigin: vi.fn(),
  realDetectOrigin: null as unknown as (cwd: string) => Promise<boolean>,
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/secrets/user-git-identity.js', () => ({ resolveGitEnv: async () => ({}) }));
vi.mock('../src/repo/refresh.js', () => ({ checkoutHoldingTasks: async () => 0 }));
vi.mock('../src/repo/git-push.js', async (original) => {
  const real = await original<typeof import('../src/repo/git-push.js')>();
  h.realDetectOrigin = real.detectOrigin;
  return {
    ...real,
    detectOrigin: (cwd: string) => h.detectOrigin(cwd),
    pushBranch: vi.fn(),
    gitRun: async (_cwd: string, args: string[]) => {
      if (args.includes('status')) return h.status;
      if (args.join(' ') === 'rev-parse --is-inside-work-tree') {
        return { code: 0, stdout: 'true', stderr: '' };
      }
      if (args.join(' ') === 'branch --show-current') {
        return h.branch;
      }
      if (args.join(' ') === 'rev-parse HEAD') return { code: 0, stdout: h.sha, stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
  };
});
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
  h.branch = { code: 0, stdout: 'main', stderr: '' };
  h.detectOrigin.mockReset().mockResolvedValue(true);
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

describe('plan pull reads the current branch', () => {
  it.each([
    [
      { code: 128, stderr: 'fatal: simulated branch failure', stdout: '' },
      'fatal: simulated branch failure',
    ],
    [{ code: 1, stderr: '', stdout: 'detail on stdout' }, 'detail on stdout'],
  ])('refuses to pull when branch fails: %j', async (branch, output) => {
    h.branch = branch;
    await expect(pull({ repositoryId: 'r1', userId: 'u1' })).rejects.toThrow(
      `git branch failed in /repo: ${output}`,
    );
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.recordError).toHaveBeenCalledTimes(1);
  });

  it('still calls an empty answer a detached HEAD', async () => {
    h.branch = { code: 0, stdout: '', stderr: '' };
    await expect(pull({ repositoryId: 'r1', userId: 'u1' })).rejects.toThrow(
      'cannot pull onto a detached HEAD',
    );
  });
});

describe('plan pull reads the origin remote', () => {
  const pullIt = () => pull({ repositoryId: 'r1', userId: 'u1' });

  it('rejects with the origin read error and does nothing further', async () => {
    const message = 'git remote get-url origin failed in /repo: boom';
    h.detectOrigin.mockRejectedValue(new Error(message));

    await expect(pullIt()).rejects.toThrow(new RegExp(`^${message}$`));

    expect(h.recordError).toHaveBeenCalledTimes(1);
    expect(h.recordError).toHaveBeenCalledWith(h.db, 'r1', expect.objectContaining({ message }));
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.recover).not.toHaveBeenCalled();
  });

  it('names the failed read, not a missing remote, when git cannot run', async () => {
    h.detectOrigin.mockImplementation((cwd) => h.realDetectOrigin(cwd));

    const err = await pullIt().then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(err?.message).toMatch(/git remote get-url origin failed in \/repo/);
    expect(err?.message).not.toMatch(/has no origin remote/);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('keeps the old message when there is no origin', async () => {
    h.detectOrigin.mockResolvedValue(false);

    await expect(pullIt()).rejects.toThrow('this repository has no origin remote to pull from');
    expect(h.fetch).not.toHaveBeenCalled();
  });
});
