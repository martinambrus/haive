import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: null as unknown,
  sha: 'a'.repeat(40),
  status: { code: 0, stdout: '', stderr: '' },
  branch: { code: 0, stdout: 'main', stderr: '' },
  probe: { code: 0, stdout: 'true', stderr: '' },
  headReads: 0,
  failRead: 0,
  divergence: { behind: 0, ahead: 0, unrelated: false },
  aside: vi.fn(),
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
      if (args.join(' ') === 'rev-parse --is-inside-work-tree') return h.probe;
      if (args.join(' ') === 'branch --show-current') {
        return h.branch;
      }
      if (args.join(' ') === 'rev-parse HEAD') {
        h.headReads += 1;
        if (h.headReads === h.failRead) return { code: 128, stdout: '', stderr: 'boom' };
        return { code: 0, stdout: h.sha, stderr: '' };
      }
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
  setAsideHaiveProjections: h.aside,
  restoreProjectionsInTx: async () => ({ outcome: 'clean' }),
  putBackProjections: async () => {},
  restoreKeptMetadata: async () => {},
  resyncHaiveProjections: async () => {},
  recoverAfterMoveFailure: h.recover,
}));
vi.mock('../src/plan/merge.js', async (original) => ({
  ...(await original<typeof import('../src/plan/merge.js')>()),
  fetchOrigin: h.fetch,
  divergence: async () => h.divergence,
}));

import { pull } from '../src/queues/plan-mirror-queue.js';

beforeEach(() => {
  vi.clearAllMocks();
  h.probe = { code: 0, stdout: 'true', stderr: '' };
  h.headReads = 0;
  h.failRead = 0;
  h.divergence = { behind: 0, ahead: 0, unrelated: false };
  h.aside.mockReset().mockResolvedValue({ outcome: 'clean' });
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

describe('plan pull reads git before it acts', () => {
  const pullIt = () => pull({ repositoryId: 'r1', userId: 'u1' });
  const failure = (): Promise<Error | null> =>
    pullIt().then(
      () => null,
      (e: unknown) => e as Error,
    );

  it.each([128, 124, -1])(
    'rejects a failed work-tree probe (%i), not a missing checkout',
    async (code) => {
      h.probe = { code, stdout: '', stderr: 'boom' };
      const err = await failure();
      expect(err?.message).toMatch(/git rev-parse failed in \/repo/);
      expect(err?.message).not.toMatch(/not a Git checkout/);
      expect(h.fetch).not.toHaveBeenCalled();
    },
  );

  it('keeps the old message when git answers false', async () => {
    h.probe = { code: 0, stdout: 'false', stderr: '' };
    await expect(pullIt()).rejects.toThrow(
      'this repository is not a Git checkout, so there is nothing to pull',
    );
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('rejects a failed before read and touches nothing', async () => {
    h.failRead = 1;
    await expect(pullIt()).rejects.toThrow(/git rev-parse HEAD failed in \/repo/);
    expect(h.aside).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.recover).not.toHaveBeenCalled();
  });

  it('rejects a failed previousCommit read before fetching', async () => {
    h.failRead = 2;
    await expect(pullIt()).rejects.toThrow(/git rev-parse HEAD failed in \/repo/);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('reports no fast-forward when the read after integrate fails and nothing landed', async () => {
    h.failRead = 3;
    const result = await pullIt();
    expect(h.headReads).toBe(3);
    expect(result.pulled?.fastForwarded).toBe(false);
  });

  it('reports no fast-forward when every read is healthy and nothing landed', async () => {
    const result = await pullIt();
    expect(h.headReads).toBe(3);
    expect(result.pulled?.fastForwarded).toBe(false);
  });
});
