import { httpOrigin } from './support/git-http.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StepContext } from '../src/step-engine/step-definition.js';

const h = vi.hoisted(() => ({
  db: null as unknown,
  repo: '',
  locked: false,
  lockRequests: [] as string[],
  handBacks: [] as { locked: boolean; dir: string; before: string }[],
  removes: 0,
  restore: 'clean' as 'clean' | 'retry' | 'refused' | 'throw',
  holding: 0,
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('@haive/database', async (original) => ({
  ...(await original<typeof import('@haive/database')>()),
  lockRepositoryTasksKey: async () => {
    h.locked = true;
    const { execFileSync: run } = await import('node:child_process');
    h.lockRequests.push(
      run('git', ['worktree', 'list', '--porcelain'], { cwd: h.repo, encoding: 'utf8' }),
    );
  },
}));
vi.mock('@haive/shared/plan', async (original) => ({
  ...(await original<typeof import('@haive/shared/plan')>()),
  lockPlanMerge: async () => {},
}));
vi.mock('../src/secrets/user-git-identity.js', () => ({
  resolveGitEnv: async () => ({
    GIT_AUTHOR_NAME: 'T',
    GIT_AUTHOR_EMAIL: 't@haive.local',
    GIT_COMMITTER_NAME: 'T',
    GIT_COMMITTER_EMAIL: 't@haive.local',
  }),
}));
vi.mock('../src/repo/refresh.js', () => ({ checkoutHoldingTasks: async () => h.holding }));
vi.mock('../src/plan/merge-baseline.js', async (original) => ({
  ...(await original<typeof import('../src/plan/merge-baseline.js')>()),
  moveAsideRecordedLeftovers: async () => {},
}));
vi.mock('../src/plan/mirror.js', () => ({
  PlanMirrorHeldError: class extends Error {},
  flushPlanMirrorForRepository: async () => ({ files: [], repoPath: h.repo }),
  advancePlanBaseFromCommit: async () => {},
  recordPlanMirrorError: async () => {},
  reconcilePlanFromCheckout: async () => {
    throw new Error('stop after the move');
  },
  seedPlanBaseFromCheckout: async () => {},
  writePlanMirror: async () => {},
}));
vi.mock('../src/plan/snapshot-git.js', () => ({
  commitPlanSnapshotFiles: async () => ({ committed: false, commitSha: null }),
}));
vi.mock('../src/project-state/set-aside.js', () => ({
  MOVE_ATTEMPTS: 3,
  setAsideHaiveProjections: async () => ({ outcome: 'set-aside', kept: new Map() }),
  restoreProjectionsInTx: async () => {
    if (h.restore === 'throw') throw new Error('restore blew up');
    return h.restore === 'refused'
      ? { outcome: 'refused', reason: 'files in the way' }
      : { outcome: h.restore };
  },
  putBackProjections: async () => {},
  restoreKeptMetadata: async () => {},
  resyncHaiveProjections: async () => {},
  recoverAfterMoveFailure: async (...args: unknown[]) => {
    throw args[5];
  },
}));
vi.mock('../src/plan/merge.js', async (original) => {
  const real = await original<typeof import('../src/plan/merge.js')>();
  return {
    ...real,
    fetchOrigin: async () => {},
    removePlanMergeWorktree: async (repoPath: string) => {
      h.removes += 1;
      await real.removePlanMergeWorktree(repoPath);
    },
  };
});
vi.mock('../src/step-engine/git-merge.js', async (original) => {
  const real = await original<typeof import('../src/step-engine/git-merge.js')>();
  return {
    ...real,
    handBackAfterMove: async (dir: string, before: string, strict?: boolean) => {
      h.handBacks.push({ locked: h.locked, dir, before });
      await real.handBackAfterMove(dir, before, strict);
    },
  };
});

import { integrateOrigin } from '../src/queues/plan-mirror-queue.js';
import { planMergeStep } from '../src/step-engine/steps/plan/01-plan-merge.js';
import {
  commitMerge,
  divergence,
  ensurePlanMergeWorktree,
  mergeOriginInto,
  planMergeWorktreePath,
} from '../src/plan/merge.js';

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim();
const COMMIT_ENV = {
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};

let root = '';
let origin = '';

/** local and origin each hold one commit the other lacks; `conflict` makes both edit the same file. */
function fixture(conflict: boolean): void {
  root = mkdtempSync(path.join(tmpdir(), 'plan-move-lock-'));
  origin = path.join(root, 'origin');
  h.repo = path.join(root, 'local');
  execFileSync('git', ['init', '-q', '-b', 'main', origin], { env: ENV });
  git(origin, 'config', 'gc.auto', '0');
  writeFileSync(path.join(origin, 'a.txt'), 'a\n');
  git(origin, 'add', '-A');
  git(origin, 'commit', '-qm', 'base');
  execFileSync('git', ['clone', '-q', httpOrigin(origin), h.repo], { env: ENV });
  git(h.repo, 'config', 'gc.auto', '0');
  writeFileSync(path.join(origin, conflict ? 'a.txt' : 'theirs.txt'), 'theirs\n');
  git(origin, 'add', '-A');
  git(origin, 'commit', '-qm', 'theirs');
  writeFileSync(path.join(h.repo, conflict ? 'a.txt' : 'mine.txt'), 'mine\n');
  git(h.repo, 'add', '-A');
  git(h.repo, 'commit', '-qm', 'mine');
  git(h.repo, 'fetch', '-q', 'origin');
}

const worktrees = () => git(h.repo, 'worktree', 'list', '--porcelain');
const hasScratch = (listing: string) => listing.includes(planMergeWorktreePath(h.repo));

const run = () =>
  integrateOrigin({
    repositoryId: 'r1',
    repoPath: h.repo,
    branch: 'main',
    userId: 'u1',
    identity: COMMIT_ENV,
    kept: new Map(),
  });

beforeEach(() => {
  h.locked = false;
  h.lockRequests = [];
  h.handBacks = [];
  h.removes = 0;
  h.restore = 'clean';
  h.holding = 0;
  const db = {
    transaction: async (fn: (conn: unknown) => Promise<unknown>) => {
      try {
        return await fn(db);
      } finally {
        h.locked = false;
      }
    },
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  };
  h.db = db;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('a Save/Pull landing', () => {
  it('lets go of the creation lock before the hand-back and the scratch worktree is gone before it is asked for', async () => {
    fixture(false);
    const before = git(h.repo, 'rev-parse', 'HEAD');
    const out = await run();
    expect(out.landed).toBe(true);
    expect(h.removes).toBe(1);
    expect(h.lockRequests).toHaveLength(1);
    expect(hasScratch(h.lockRequests[0]!)).toBe(false);
    expect(h.handBacks).toEqual([{ locked: false, dir: h.repo, before }]);
    expect(hasScratch(worktrees())).toBe(false);
    expect(out).not.toHaveProperty('movedFrom');
  });

  it.each([
    ['conflict', true, 'clean', 0, 0, 1],
    ['held', false, 'clean', 1, 1, 1],
    ['refused', false, 'refused', 0, 1, 1],
    ['retry', false, 'retry', 0, 3, 3],
    ['throw', false, 'throw', 0, 1, 1],
  ] as const)(
    'removes the scratch worktree exactly once per exit on %s and hands nothing back',
    async (kind, conflict, restore, holding, locks, removes) => {
      fixture(conflict);
      h.restore = restore;
      h.holding = holding;
      const out = await run().catch((err: unknown) => err);
      if (kind === 'throw') expect(out).toBeInstanceOf(Error);
      else expect((out as { landed: boolean }).landed).toBe(false);
      expect(h.removes).toBe(removes);
      expect(h.lockRequests).toHaveLength(locks);
      for (const listing of h.lockRequests) expect(hasScratch(listing)).toBe(false);
      expect(hasScratch(worktrees())).toBe(false);
      expect(h.handBacks).toEqual([]);
    },
  );
});

describe('a confirm landing', () => {
  it('hands back once, after the transaction has let go of the creation lock', async () => {
    fixture(false);
    const before = git(h.repo, 'rev-parse', 'HEAD');
    const wt = await ensurePlanMergeWorktree(h.repo);
    await mergeOriginInto(wt, 'main', (await divergence(h.repo, 'main')).unrelated, COMMIT_ENV);
    await commitMerge(wt, 'Merge origin/main', COMMIT_ENV);
    const ctx = {
      db: h.db,
      repoPath: h.repo,
      taskId: 't1',
      taskStepId: 's1',
      userId: 'u1',
    } as StepContext;
    const detected = {
      repositoryId: 'r1',
      branch: 'main',
      worktreePath: wt,
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
    ).rejects.toThrow('stop after the move');
    expect(h.lockRequests).toHaveLength(1);
    expect(h.handBacks).toEqual([{ locked: false, dir: h.repo, before }]);
  });
});
