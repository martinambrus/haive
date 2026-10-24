import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StepContext } from '../src/step-engine/step-definition.js';

const h = vi.hoisted(() => ({
  db: null as unknown,
  sha: 'a'.repeat(40),
  headReads: 0,
  failRead: 0,
  probe: null as { code: number; stdout: string; stderr: string } | null,
  aside: vi.fn(),
  land: vi.fn(),
  switched: false,
  otherSha: 'b'.repeat(40),
  fail: false,
  empty: false,
  branch: { code: 0, stdout: 'main', stderr: '' },
  push: vi.fn(),
  advance: vi.fn(),
  recordError: vi.fn(),
  remove: vi.fn(),
  detectOrigin: vi.fn(),
  realDetectOrigin: null as unknown as (cwd: string) => Promise<boolean>,
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/secrets/user-git-identity.js', () => ({ resolveGitEnv: async () => ({}) }));
vi.mock('../src/repo/git-workspace.js', () => ({
  requireUsableGit: async () => {
    if (h.probe && h.probe.code !== 0) throw new Error('git cannot use it: boom');
    return !h.probe || h.probe.stdout === 'true';
  },
}));
vi.mock('../src/repo/refresh.js', () => ({ checkoutHoldingTasks: async () => 0 }));
vi.mock('../src/repo/git-push.js', async (original) => {
  const real = await original<typeof import('../src/repo/git-push.js')>();
  h.realDetectOrigin = real.detectOrigin;
  return {
    ...real,
    detectOrigin: (cwd: string) => h.detectOrigin(cwd),
    pushBranch: h.push,
    gitRun: async (_cwd: string, args: string[]) => {
      if (args.join(' ') === 'rev-parse --verify refs/heads/main^{commit}') {
        return {
          code: h.fail ? 128 : 0,
          stdout: h.empty ? '' : h.sha,
          stderr: '',
        };
      }
      if (args.join(' ') === 'rev-parse HEAD') {
        h.headReads += 1;
        if (h.headReads === h.failRead) return { code: 128, stdout: '', stderr: 'boom' };
        if (h.headReads === 3)
          return {
            code: h.fail ? 128 : 0,
            stdout: h.empty ? '' : h.switched ? h.otherSha : 'unreadable',
            stderr: 'unreadable',
          };
        return { code: 0, stdout: h.sha, stderr: '' };
      }
      if (args.join(' ') === 'branch --show-current') return h.branch;
      if (h.probe && args.includes('--is-inside-work-tree')) return h.probe;
      return {
        code: 0,
        stdout: args.includes('--is-inside-work-tree') ? 'true' : 'main',
        stderr: '',
      };
    },
  };
});
vi.mock('../src/plan/mirror.js', () => ({
  PlanMirrorHeldError: class extends Error {},
  flushPlanMirrorForRepository: async () => ({
    files: ['.haive-data/plan.json'],
    repoPath: '/repo',
  }),
  advancePlanBaseFromCommit: h.advance,
  recordPlanMirrorError: h.recordError,
  reconcilePlanFromCheckout: async () => {},
  seedPlanBaseFromCheckout: async () => {},
  writePlanMirror: async () => {},
}));
vi.mock('../src/plan/snapshot-git.js', () => ({
  commitPlanSnapshotFiles: async () => ({ committed: true, commitSha: h.sha }),
}));
vi.mock('../src/project-state/set-aside.js', () => ({
  MOVE_ATTEMPTS: 3,
  setAsideHaiveProjections: h.aside,
  restoreProjectionsInTx: async () => ({ outcome: 'clean' }),
  putBackProjections: async () => {},
  restoreKeptMetadata: async () => {},
  resyncHaiveProjections: async () => {},
  recoverAfterMoveFailure: async (...args: unknown[]) => {
    throw args[5];
  },
}));
vi.mock('../src/plan/merge.js', async (original) => ({
  ...(await original<typeof import('../src/plan/merge.js')>()),
  conflictedPaths: async () => ({ paths: [], undecodable: 0 }),
  commitMerge: async () => h.sha,
  landPlanMerge: h.land,
  removePlanMergeWorktree: h.remove,
  fetchOrigin: async () => {},
  divergence: async () => ({ behind: 0, ahead: 1 }),
}));

import { planMergeStep } from '../src/step-engine/steps/plan/01-plan-merge.js';
import { save } from '../src/queues/plan-mirror-queue.js';

beforeEach(() => {
  vi.clearAllMocks();
  h.headReads = 0;
  h.failRead = 0;
  h.probe = null;
  h.aside.mockReset().mockResolvedValue({ outcome: 'set-aside', kept: new Map() });
  h.land.mockReset().mockImplementation(async () => h.sha);
  h.switched = false;
  h.fail = false;
  h.empty = false;
  h.branch = { code: 0, stdout: 'main', stderr: '' };
  h.detectOrigin.mockReset().mockResolvedValue(true);
  h.recordError.mockResolvedValue(undefined);
  h.push.mockResolvedValue({});
  const db = {
    query: {
      repositories: { findFirst: async () => ({ id: 'r1', storagePath: '/repo' }) },
      planMirrorState: { findFirst: async () => ({ revision: 1, writtenRevision: 1 }) },
    },
    execute: async () => {},
    transaction: async (fn: (conn: unknown) => Promise<unknown>) => fn(db),
    insert: () => ({ values: async () => {} }),
  };
  h.db = db;
});

describe('#280 fix2 plan pushes require a pinned sha', () => {
  it.each(['exit failure', 'empty output'])(
    'fails plan-merge confirm before push on %s',
    async (kind) => {
      h.fail = kind === 'exit failure';
      h.empty = kind === 'empty output';
      h.headReads = 1;
      const ctx = {
        db: h.db,
        repoPath: '/repo',
        taskId: 't1',
        taskStepId: 's1',
        userId: 'u1',
      } as StepContext;
      const detected = {
        repositoryId: 'r1',
        branch: 'main',
        worktreePath: '/repo/merge',
        worktreeRelPath: 'merge',
        unrelated: false,
        conflicts: [],
        undecodable: 0,
        attempts: 0,
        transcript: [],
        pendingGuidance: null,
        mergeOpen: false,
      } as Parameters<typeof planMergeStep.apply>[1]['detected'];
      await expect(
        planMergeStep.apply(ctx, {
          detected,
          formValues: { decision: 'confirm' },
          iteration: 0,
          previousIterations: [],
          llmOutput: undefined,
        }),
      ).rejects.toThrow('could not read branch tip');
      expect(h.headReads).toBe(2);
      expect(h.push).not.toHaveBeenCalled();
      expect(h.advance).not.toHaveBeenCalled();
      expect(h.remove).not.toHaveBeenCalled();
    },
  );

  it.each(['exit failure', 'empty output'])(
    '#280 fix3 fails and records the plan-mirror save error before push on %s',
    async (kind) => {
      h.fail = kind === 'exit failure';
      h.empty = kind === 'empty output';
      await expect(save({ repositoryId: 'r1', userId: 'u1', push: true })).rejects.toThrow(
        'could not read branch tip',
      );
      expect(h.headReads).toBe(2);
      expect(h.push).not.toHaveBeenCalled();
      expect(h.advance).not.toHaveBeenCalled();
      expect(h.recordError).toHaveBeenCalledWith(
        h.db,
        'r1',
        expect.objectContaining({
          message: 'could not read branch tip; the plan commit is saved locally, retry the push',
        }),
      );
    },
  );
});

describe('#280 fix5 plan pushes pin the destination branch after a checkout switch', () => {
  it('plan mirror pushes the destination sha and advances its base with that same sha', async () => {
    h.switched = true;
    const result = await save({ repositoryId: 'r1', userId: 'u1', push: true });
    expect(result.pushed).toBe(true);
    expect(h.headReads).toBeGreaterThanOrEqual(2);
    expect(h.push).toHaveBeenCalledWith(expect.objectContaining({ sha: h.sha, branch: 'main' }));
    expect(h.advance).toHaveBeenCalledWith(h.db, 'r1', '/repo', h.sha, 'main');
  });

  it('plan merge pushes the destination sha and advances its base with that same sha', async () => {
    h.switched = true;
    h.headReads = 1;
    const ctx = {
      db: h.db,
      repoPath: '/repo',
      taskId: 't1',
      taskStepId: 's1',
      userId: 'u1',
    } as StepContext;
    const detected = {
      repositoryId: 'r1',
      branch: 'main',
      worktreePath: '/repo/merge',
      worktreeRelPath: 'merge',
      unrelated: false,
      conflicts: [],
      undecodable: 0,
      attempts: 0,
      transcript: [],
      pendingGuidance: null,
      mergeOpen: false,
    } as Parameters<typeof planMergeStep.apply>[1]['detected'];
    const result = await planMergeStep.apply(ctx, {
      detected,
      formValues: { decision: 'confirm' },
      iteration: 0,
      previousIterations: [],
      llmOutput: undefined,
    });
    expect(result.pushed).toBe(true);
    expect(h.headReads).toBeGreaterThanOrEqual(2);
    expect(h.push).toHaveBeenCalledWith(expect.objectContaining({ sha: h.sha, branch: 'main' }));
    expect(h.advance).toHaveBeenCalledWith(h.db, 'r1', '/repo', h.sha, 'main');
  });
});

describe('plan save reads the current branch', () => {
  it('rejects a failed branch read when pushing', async () => {
    h.branch = { code: 128, stdout: '', stderr: 'fatal: simulated branch failure' };
    await expect(save({ repositoryId: 'r1', userId: 'u1', push: true })).rejects.toThrow(
      'git branch failed in /repo: fatal: simulated branch failure',
    );
    expect(h.push).not.toHaveBeenCalled();
  });

  it('keeps a saved commit when the branch read fails without a push', async () => {
    h.branch = { code: 128, stdout: '', stderr: 'fatal: simulated branch failure' };
    const result = await save({ repositoryId: 'r1', userId: 'u1', push: false });
    expect(result).toMatchObject({ pushed: false, branch: null });
    expect(h.push).not.toHaveBeenCalled();
  });

  it('still calls an empty answer a detached HEAD', async () => {
    h.branch = { code: 0, stdout: '', stderr: '' };
    await expect(save({ repositoryId: 'r1', userId: 'u1', push: true })).rejects.toThrow(
      'cannot push a plan snapshot from a detached HEAD',
    );
  });
});

describe('plan save reads the origin remote', () => {
  const saveIt = (push: boolean) => save({ repositoryId: 'r1', userId: 'u1', push });

  it('rejects with the origin read error and pushes nothing', async () => {
    const message = 'git remote get-url origin failed in /repo: boom';
    h.detectOrigin.mockRejectedValue(new Error(message));

    await expect(saveIt(true)).rejects.toThrow(new RegExp(`^${message}$`));

    expect(h.recordError).toHaveBeenCalledTimes(1);
    expect(h.recordError).toHaveBeenCalledWith(h.db, 'r1', expect.objectContaining({ message }));
    expect(h.push).not.toHaveBeenCalled();
  });

  it('names the failed read, not a missing remote, when git cannot run', async () => {
    h.detectOrigin.mockImplementation((cwd) => h.realDetectOrigin(cwd));

    const err = await saveIt(true).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(err?.message).toMatch(/git remote get-url origin failed in \/repo/);
    expect(err?.message).not.toMatch(/has no origin remote/);
    expect(h.push).not.toHaveBeenCalled();
  });

  it('keeps the old message when there is no origin', async () => {
    h.detectOrigin.mockResolvedValue(false);

    await expect(saveIt(true)).rejects.toThrow('this repository has no origin remote to push to');
    expect(h.push).not.toHaveBeenCalled();
  });

  it('never reads the origin when not pushing', async () => {
    await saveIt(false);

    expect(h.detectOrigin).not.toHaveBeenCalled();
  });
});

describe('plan save and confirm read git before they act', () => {
  it.each([128, 124, -1])(
    'save rejects a failed work-tree probe (%i), not a missing checkout',
    async (code) => {
      h.probe = { code, stdout: '', stderr: 'boom' };
      const err = await save({ repositoryId: 'r1', userId: 'u1', push: true }).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err?.message).toMatch(/git cannot use it/);
      expect(err?.message).not.toMatch(/not a Git checkout/);
      expect(h.push).not.toHaveBeenCalled();
    },
  );

  it('save keeps the old message when git answers false', async () => {
    h.probe = { code: 0, stdout: 'false', stderr: '' };
    await expect(save({ repositoryId: 'r1', userId: 'u1', push: true })).rejects.toThrow(
      'repository snapshot cannot be committed because this is not a Git checkout',
    );
  });

  it('save rejects a failed before read and pushes nothing', async () => {
    h.failRead = 1;
    await expect(save({ repositoryId: 'r1', userId: 'u1', push: true })).rejects.toThrow(
      /git rev-parse HEAD failed in \/repo/,
    );
    expect(h.push).not.toHaveBeenCalled();
  });

  it('plan-merge confirm rejects a failed before read and moves nothing', async () => {
    h.headReads = 1;
    h.failRead = 2;
    const ctx = {
      db: h.db,
      repoPath: '/repo',
      taskId: 't1',
      taskStepId: 's1',
      userId: 'u1',
    } as StepContext;
    const detected = {
      repositoryId: 'r1',
      branch: 'main',
      worktreePath: '/repo/merge',
      worktreeRelPath: 'merge',
      unrelated: false,
      conflicts: [],
      undecodable: 0,
      attempts: 0,
      transcript: [],
      pendingGuidance: null,
      mergeOpen: false,
    } as Parameters<typeof planMergeStep.apply>[1]['detected'];
    await expect(
      planMergeStep.apply(ctx, {
        detected,
        formValues: { decision: 'confirm' },
        iteration: 0,
        previousIterations: [],
        llmOutput: undefined,
      }),
    ).rejects.toThrow(/git rev-parse HEAD failed in \/repo/);
    expect(h.aside).not.toHaveBeenCalled();
    expect(h.land).not.toHaveBeenCalled();
    expect(h.push).not.toHaveBeenCalled();
  });
});
