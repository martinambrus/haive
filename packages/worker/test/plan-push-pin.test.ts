import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StepContext } from '../src/step-engine/step-definition.js';

const h = vi.hoisted(() => ({
  db: null as unknown,
  sha: 'a'.repeat(40),
  headReads: 0,
  switched: false,
  otherSha: 'b'.repeat(40),
  fail: false,
  empty: false,
  push: vi.fn(),
  advance: vi.fn(),
  recordError: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/secrets/user-git-identity.js', () => ({ resolveGitEnv: async () => ({}) }));
vi.mock('../src/repo/refresh.js', () => ({ checkoutHoldingTasks: async () => 0 }));
vi.mock('../src/repo/git-push.js', async (original) => ({
  ...(await original<typeof import('../src/repo/git-push.js')>()),
  detectOrigin: async () => true,
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
      if (h.headReads === 3)
        return {
          code: h.fail ? 128 : 0,
          stdout: h.empty ? '' : h.switched ? h.otherSha : 'unreadable',
          stderr: 'unreadable',
        };
      return { code: 0, stdout: h.sha, stderr: '' };
    }
    return {
      code: 0,
      stdout: args.includes('--is-inside-work-tree') ? 'true' : 'main',
      stderr: '',
    };
  },
}));
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
  setAsideHaiveProjections: async () => ({ outcome: 'set-aside', kept: new Map() }),
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
  landPlanMerge: async () => {},
  removePlanMergeWorktree: h.remove,
  fetchOrigin: async () => {},
  divergence: async () => ({ behind: 0, ahead: 1 }),
}));

import { planMergeStep } from '../src/step-engine/steps/plan/01-plan-merge.js';
import { save } from '../src/queues/plan-mirror-queue.js';

beforeEach(() => {
  vi.clearAllMocks();
  h.headReads = 0;
  h.switched = false;
  h.fail = false;
  h.empty = false;
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
