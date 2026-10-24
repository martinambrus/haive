// This module calls vi.mock itself, so a test must import it BEFORE plan-mirror-queue.js; a
// later import leaves the queue on the real modules.
import { vi, type Mock } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';

type Hook =
  | 'aside'
  | 'restore'
  | 'fetch'
  | 'reconcile'
  | 'flush'
  | 'commit'
  | 'resync'
  | 'metadata'
  | 'putBack'
  | 'record';

const h: { db: unknown; head: string } & Record<Hook, Mock> = vi.hoisted(() => ({
  db: null as unknown,
  head: 'before',
  aside: vi.fn(),
  restore: vi.fn(),
  fetch: vi.fn(),
  reconcile: vi.fn(),
  flush: vi.fn(),
  commit: vi.fn(),
  resync: vi.fn(),
  metadata: vi.fn(),
  putBack: vi.fn(),
  record: vi.fn(),
}));

export { h };

vi.mock('../../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../../src/secrets/user-git-identity.js', () => ({ resolveGitEnv: async () => ({}) }));
vi.mock('../../src/repo/refresh.js', () => ({ checkoutHoldingTasks: async () => 0 }));
vi.mock('../../src/repo/git-workspace.js', () => ({ requireUsableGit: async () => true }));
vi.mock('../../src/repo/git-operation.js', async (original) => ({
  ...(await original<typeof import('../../src/repo/git-operation.js')>()),
  gitOperationInProgress: async () => false,
}));
vi.mock('../../src/repo/git-push.js', async (original) => ({
  ...(await original<typeof import('../../src/repo/git-push.js')>()),
  detectOrigin: async () => true,
  pushBranch: vi.fn(),
}));
vi.mock('../../src/repo/git-exec.js', async (original) => ({
  ...(await original<typeof import('../../src/repo/git-exec.js')>()),
  gitRun: async (_cwd: string, args: string[]) => {
    const command = args.join(' ');
    const stdout =
      command === 'rev-parse --is-inside-work-tree'
        ? 'true'
        : command === 'branch --show-current'
          ? 'main'
          : command === 'rev-parse HEAD'
            ? h.head
            : '';
    return { code: 0, stdout, stderr: '' };
  },
}));
vi.mock('../../src/plan/mirror.js', async (original) => ({
  ...(await original<typeof import('../../src/plan/mirror.js')>()),
  flushPlanMirrorForRepository: h.flush,
  reconcilePlanFromCheckout: h.reconcile,
  seedPlanBaseFromCheckout: async () => {},
  recordPlanMirrorError: h.record,
}));
vi.mock('../../src/plan/snapshot-git.js', () => ({ commitPlanSnapshotFiles: h.commit }));
vi.mock('../../src/project-state/set-aside.js', async (original) => ({
  ...(await original<typeof import('../../src/project-state/set-aside.js')>()),
  setAsideHaiveProjections: h.aside,
  restoreProjectionsInTx: h.restore,
  resyncHaiveProjections: h.resync,
  restoreKeptMetadata: h.metadata,
}));
vi.mock('../../src/project-state/sync.js', () => ({
  syncProjectStateFromCheckout: async () => ({ outcome: 'unchanged' }),
}));
vi.mock('../../src/plan/sync-checkout.js', () => ({ syncPlanFromCheckout: async () => {} }));
vi.mock('../../src/plan/merge-baseline.js', () => ({ moveAsideRecordedLeftovers: async () => {} }));
vi.mock('../../src/step-engine/git-merge.js', () => ({ handBackAfterMove: async () => {} }));
vi.mock('../../src/plan/merge.js', async (original) => ({
  ...(await original<typeof import('../../src/plan/merge.js')>()),
  headCommit: async () => h.head,
  fetchOrigin: h.fetch,
  divergence: async () => ({ ahead: 0, behind: 1, unrelated: false }),
  ensurePlanMergeWorktree: async () => '/repo/merge',
  mergeOriginInto: async () => ({ clean: true }),
  commitMerge: async () => 'merged',
  removePlanMergeWorktree: async () => {},
  landPlanMerge: async () => {
    const before = h.head;
    h.head = 'merged';
    return before;
  },
}));

import { restoreFaults, type KeptFiles } from '../../src/project-state/set-aside.js';

export const REPO = '00000000-0000-4000-8000-000000000001';
export const USER = '00000000-0000-4000-8000-000000000002';
export const payload = { repositoryId: REPO, userId: USER, push: true };
export const PULL_BUSY = 'this repository has a task in flight; finish or cancel it before pulling';
export const SAVE_BUSY =
  'this repository has a task in flight; the plan commit stays local and nothing was pushed; finish or cancel it before saving and pushing';
export const REASON = '.haive-data/plan.json was not written by Haive';

export function setup() {
  vi.resetAllMocks();
  h.head = 'before';
  h.aside.mockResolvedValue({ outcome: 'clean' });
  h.restore.mockResolvedValue({ outcome: 'clean' });
  h.flush.mockResolvedValue({ files: ['.haive-data/plan.json'], repoPath: '/repo' });
  h.reconcile.mockResolvedValue({ skipped: false });
  h.commit.mockResolvedValue({ committed: true, commitSha: 'saved' });
  h.resync.mockResolvedValue(true);
  h.metadata.mockResolvedValue(undefined);
  const fake = createFakeDb({
    repositories: schema.repositories,
    tasks: schema.tasks,
    planMirrorState: schema.planMirrorState,
    projectStateOutbox: schema.projectStateOutbox,
  });
  fake.insert(schema.repositories, {
    id: REPO,
    userId: USER,
    name: 'test',
    source: 'blank',
    storagePath: '/repo',
    status: 'ready',
  });
  fake.insert(schema.planMirrorState, {
    repositoryId: REPO,
    revision: 1,
    writtenRevision: 1,
    lastError: null,
  });
  h.db = fake.db;
  h.record.mockImplementation(async (...args: unknown[]) => {
    const real = await vi.importActual<typeof import('../../src/plan/mirror.js')>(
      '../../src/plan/mirror.js',
    );
    await real.recordPlanMirrorError(...(args as Parameters<typeof real.recordPlanMirrorError>));
  });
  restoreFaults.beforePutBack = h.putBack;
  return {
    state: () => fake.rows(schema.planMirrorState)[0]!,
    keep: () => {
      const kept: KeptFiles = new Map([
        ['.haive-data/plan.json', { bytes: undefined, index: null }],
      ]);
      h.aside.mockResolvedValue({ outcome: 'set-aside', kept });
    },
    openConversation: () => {
      fake.insert(schema.tasks, {
        id: USER,
        repositoryId: REPO,
        type: 'plan_merge',
        status: 'running',
        deadAt: null,
      });
    },
    busy: () => {
      fake.insert(schema.tasks, { id: USER, repositoryId: REPO, status: 'running', deadAt: null });
    },
  };
}

export function cleanup() {
  delete restoreFaults.beforePutBack;
}
