import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StepContext } from '../src/step-engine/step-definition.js';

const h = vi.hoisted(() => ({
  db: null as unknown,
  sha: 'a'.repeat(40),
  headReads: 0,
  failRead: 0,
  probe: null as { code: number; stdout: string; stderr: string } | null,
  upstream: { code: 0, stdout: 'origin/main', stderr: '' } as {
    code: number;
    stdout: string;
    stderr: string;
    noExit?: string;
  },
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
      if (args.join(' ') === 'rev-parse --abbrev-ref @{upstream}') return h.upstream;
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
  h.upstream = { code: 0, stdout: 'origin/main', stderr: '' };
  h.aside.mockReset().mockResolvedValue({ outcome: 'set-aside', kept: new Map() });
  h.land.mockReset().mockImplementation(async () => h.sha);
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

const confirm = () => {
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
  return planMergeStep.apply(ctx, {
    detected,
    formValues: { decision: 'confirm' },
    iteration: 0,
    previousIterations: [],
    llmOutput: undefined,
  });
};

const runs: Array<[string, () => Promise<unknown>]> = [
  ['save', () => save({ repositoryId: 'r1', userId: 'u1', push: true })],
  ['planMergeStep.apply', confirm],
];

const probes = [
  [
    'no exit status',
    {
      code: -1,
      stdout: '',
      stderr: 'git ended without an exit status in /repo (SIGKILL)',
      noExit: 'SIGKILL',
    },
    false,
  ],
  ['time bound', { code: 124, stdout: '', stderr: 'git rev-parse timed out after 600 s' }, false],
  [
    'no upstream configured (negative control)',
    { code: 128, stdout: '', stderr: 'fatal: no upstream configured for branch main' },
    true,
  ],
  ['upstream present (negative control)', { code: 0, stdout: 'origin/main', stderr: '' }, false],
] as const;

describe.each(runs)('%s upstream probe', (_name, run) => {
  it.each(probes)('%s', async (_label, probe, expected) => {
    h.upstream = { ...probe };
    await run();
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(h.push).toHaveBeenCalledWith(
      expect.objectContaining({ sha: h.sha, branch: 'main', setUpstream: expected }),
    );
  });
});
