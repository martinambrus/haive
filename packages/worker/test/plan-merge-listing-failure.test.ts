import { networkGitArgs, httpOrigin } from './support/git-http.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { failGit, type FakeGit } from './support/fake-git.js';

const h = vi.hoisted(() => ({
  db: null as unknown,
  repo: '',
  recovered: [] as { before: string; err: unknown }[],
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
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
vi.mock('../src/repo/refresh.js', () => ({ checkoutHoldingTasks: async () => 0 }));
vi.mock('../src/plan/merge-baseline.js', async (original) => ({
  ...(await original<typeof import('../src/plan/merge-baseline.js')>()),
  moveAsideRecordedLeftovers: async () => {},
}));
vi.mock('../src/plan/mirror.js', () => ({
  PlanMirrorHeldError: class extends Error {},
  flushPlanMirrorForRepository: async () => ({
    files: ['.haive-data/plan.json'],
    repoPath: h.repo,
  }),
  advancePlanBaseFromCommit: async () => {},
  recordPlanMirrorError: async () => {},
  reconcilePlanFromCheckout: async () => {},
  seedPlanBaseFromCheckout: async () => {},
  writePlanMirror: async () => {},
}));
vi.mock('../src/plan/snapshot-git.js', () => ({
  commitPlanSnapshotFiles: async () => ({ committed: false, commitSha: null }),
}));
vi.mock('../src/project-state/set-aside.js', () => ({
  MOVE_ATTEMPTS: 3,
  setAsideHaiveProjections: async () => ({ outcome: 'set-aside', kept: new Map() }),
  restoreProjectionsInTx: async () => ({ outcome: 'clean' }),
  putBackProjections: async () => {},
  restoreKeptMetadata: async () => {},
  resyncHaiveProjections: async () => {},
  recoverAfterMoveFailure: async (...args: unknown[]) => {
    h.recovered.push({ before: args[4] as string, err: args[5] });
    throw args[5];
  },
}));
vi.mock('../src/plan/merge.js', async (original) => ({
  ...(await original<typeof import('../src/plan/merge.js')>()),
  fetchOrigin: async () => {},
}));

import { integrateOrigin, save } from '../src/queues/plan-mirror-queue.js';
import { planMergeWorktreePath } from '../src/plan/merge.js';

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};
const COMMIT_ENV = {
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};
const LISTING = ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--diff-filter=U'];
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', networkGitArgs(args), { cwd, env: ENV, encoding: 'utf8' }).trim();

let root = '';
let shim: FakeGit | null = null;

/** local and origin each hold one commit the other lacks, both editing a.txt. */
function conflictingFixture(): void {
  root = mkdtempSync(path.join(tmpdir(), 'plan-merge-listing-'));
  const origin = path.join(root, 'origin');
  h.repo = path.join(root, 'local');
  execFileSync('git', ['init', '-q', '-b', 'main', origin], { env: ENV });
  git(origin, 'config', 'gc.auto', '0');
  writeFileSync(path.join(origin, 'a.txt'), 'a\n');
  git(origin, 'add', '-A');
  git(origin, 'commit', '-qm', 'base');
  execFileSync('git', ['clone', '-q', httpOrigin(origin), h.repo], { env: ENV });
  git(h.repo, 'config', 'gc.auto', '0');
  writeFileSync(path.join(origin, 'a.txt'), 'theirs\n');
  git(origin, 'commit', '-qam', 'theirs');
  writeFileSync(path.join(h.repo, 'a.txt'), 'mine\n');
  git(h.repo, 'commit', '-qam', 'mine');
  git(h.repo, 'fetch', '-q', 'origin');
}

const hasScratch = () =>
  git(h.repo, 'worktree', 'list', '--porcelain').includes(planMergeWorktreePath(h.repo));

beforeEach(() => {
  h.recovered = [];
  const db = {
    query: {
      repositories: {
        findFirst: async () => ({ id: 'r1', userId: 'u1', credentialsSecretId: null }),
      },
      planMirrorState: { findFirst: async () => ({ revision: 1, writtenRevision: 1 }) },
    },
    transaction: async (fn: (conn: unknown) => Promise<unknown>) => fn(db),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  };
  h.db = db;
  conflictingFixture();
});

afterEach(async () => {
  await shim?.restore();
  shim = null;
  rmSync(root, { recursive: true, force: true });
});

describe('a Save or Pull merge whose unmerged listing fails', () => {
  it('rejects with the failed listing, leaving no scratch worktree and HEAD where it was', async () => {
    const before = git(h.repo, 'rev-parse', 'HEAD');
    shim = await failGit(LISTING);
    await expect(
      integrateOrigin({
        repositoryId: 'r1',
        repoPath: h.repo,
        branch: 'main',
        userId: 'u1',
        identity: COMMIT_ENV,
        kept: new Map(),
      }),
    ).rejects.toThrow(/git diff .* failed in /);
    await shim.restore();
    shim = null;
    expect(hasScratch()).toBe(false);
    expect(git(h.repo, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('hands Save the failure while HEAD is still where the recovery will look for it', async () => {
    const before = git(h.repo, 'rev-parse', 'HEAD');
    shim = await failGit(LISTING);
    await expect(
      save({ repositoryId: 'r1', userId: 'u1', push: true } as Parameters<typeof save>[0]),
    ).rejects.toThrow(/git diff .* failed in /);
    await shim.restore();
    shim = null;
    expect(h.recovered).toHaveLength(1);
    expect(h.recovered[0]!.before).toBe(before);
    expect(String(h.recovered[0]!.err)).toMatch(/git diff .* failed in /);
    expect(git(h.repo, 'rev-parse', 'HEAD')).toBe(before);
    expect(hasScratch()).toBe(false);
  });
});
