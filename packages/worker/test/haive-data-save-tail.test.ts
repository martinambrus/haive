import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeDb } from '@haive/database/testing';
import { schema } from '@haive/database';
import { eq } from 'drizzle-orm';
import { cleanup, h, payload, REPO, USER, setup } from './support/plan-mirror-failure.js';
const calls = vi.hoisted(() => ({ commit: vi.fn(), refresh: vi.fn() }));
vi.mock('@haive/shared/fs-safe', async (original) => ({
  ...(await original<object>()),
  lstatNoFollow: async () => null,
}));
vi.mock('../src/repo/checkout-head.js', () => ({ checkoutMissing: async () => false }));
vi.mock('../src/project-state/refresh.js', () => ({
  refreshProjectStateOutcome: calls.refresh,
}));
vi.mock('../src/project-state/commit.js', () => ({
  commitHaiveProjections: calls.commit,
  HaiveProjectionRefusal: class extends Error {},
}));
import * as push from '../src/repo/git-push.js';
import * as workspace from '../src/repo/git-workspace.js';
import * as operations from '../src/repo/git-operation.js';
import * as mirror from '../src/plan/mirror.js';
import * as merge from '../src/plan/merge.js';
import { saveCore, SavePreconditionError } from '../src/queues/plan-mirror-queue.js';
import { saveHaiveData } from '../src/project-state/save.js';
let fake: ReturnType<typeof createFakeDb>;
beforeEach(() => {
  setup();
  calls.refresh.mockResolvedValue({ outcome: 'written' });
  fake = createFakeDb({
    repositories: schema.repositories,
    tasks: schema.tasks,
    planMirrorState: schema.planMirrorState,
    projectStateOutbox: schema.projectStateOutbox,
    projectStateConflicts: schema.projectStateConflicts,
  });
  fake.insert(schema.repositories, {
    id: REPO,
    userId: USER,
    storagePath: '/repo',
    status: 'ready',
  });
  fake.insert(schema.planMirrorState, { repositoryId: REPO, revision: 1, writtenRevision: 1 });
  h.db = fake.db;
  calls.commit.mockImplementation(async () =>
    calls.commit.mock.calls.length > 1
      ? { committed: false, commitSha: null, files: [], skipped: [], indexSynced: true }
      : {
          committed: true,
          commitSha: 'local',
          files: ['.haive-data/state/format.json'],
          skipped: ['unknown'],
        },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe('the Haive data Save push seam', () => {
  it('returns a structured refusal when the plan keeps changing during its flush', async () => {
    await fake.db
      .update(schema.planMirrorState)
      .set({ writtenRevision: 0 })
      .where(eq(schema.planMirrorState.repositoryId, REPO));
    expect(await saveHaiveData(payload)).toMatchObject({
      outcome: 'refused',
      committed: false,
      pushed: false,
      refusal: { code: 'projections_changing' },
    });
    expect(calls.commit).not.toHaveBeenCalled();
  });
  it('returns a structured integration hold while preserving the local commit', async () => {
    h.aside.mockResolvedValue({ outcome: 'held', holding: 3 });
    expect(await saveHaiveData(payload)).toMatchObject({
      outcome: 'refused',
      committed: true,
      commitSha: 'local',
      pushed: false,
      refusal: { code: 'integration_held', count: 3 },
      skipped: ['unknown'],
    });
  });
  it.each(['projection_not_owned', 'projection_rewritten', 'write_pending'] as const)(
    'maps integration refusal %s without parsing its text',
    async (code) => {
      h.aside.mockResolvedValue({
        outcome: 'refused',
        code,
        file: '.haive-data/state/unknown',
        reason: 'any diagnostic in any language',
      });
      expect(await saveHaiveData(payload)).toMatchObject({
        outcome: 'refused',
        committed: true,
        pushed: false,
        refusal: { code, file: '.haive-data/state/unknown' },
      });
    },
  );
  it('does not recommit or push when a landed merge raises a project-state question', async () => {
    h.resync.mockImplementation(async () => {
      fake.insert(schema.projectStateConflicts, {
        id: '00000000-0000-4000-8000-000000000003',
        repositoryId: REPO,
        unit: 'project/render.json#framework',
        resolvedAt: null,
      });
      return true;
    });
    const result = await saveHaiveData(payload);
    expect(result).toMatchObject({
      outcome: 'refused',
      committed: true,
      pushed: false,
      refusal: { code: 'project_state_questions', units: ['project/render.json#framework'] },
    });
    expect(calls.commit).toHaveBeenCalledOnce();
    expect(h.metadata).toHaveBeenCalled();
  });
});

describe('data Save failure and race controls', () => {
  const preserved = {
    committed: true,
    commitSha: 'local',
    files: ['.haive-data/state/format.json'],
    skipped: ['unknown'],
    pushed: false,
  };
  it.each(['fetch', 'push', 'branch', 'tip', 'merge'] as const)(
    'preserves landed commit fields after %s fails and never records a plan error',
    async (site) => {
      if (site === 'fetch') h.fetch.mockRejectedValue(new Error('network diagnostic'));
      if (site === 'merge')
        vi.spyOn(merge, 'mergeOriginInto').mockRejectedValue(new Error('merge diagnostic'));
      if (site === 'push' || site === 'tip') {
        const run = push.gitRun;
        vi.spyOn(push, 'gitRun').mockImplementation(async (cwd, args, ...rest) =>
          args.includes('refs/heads/main^{commit}')
            ? { code: site === 'tip' ? 128 : 0, stdout: site === 'tip' ? '' : 'merged', stderr: '' }
            : run(cwd, args, ...rest),
        );
        if (site === 'push')
          vi.spyOn(push, 'pushBranch').mockRejectedValue(new Error('push diagnostic'));
      }
      if (site === 'branch')
        calls.commit.mockImplementation(async () => {
          vi.spyOn(push, 'gitRun').mockResolvedValue({
            code: 128,
            stdout: '',
            stderr: 'branch diagnostic',
          });
          return { ...preserved };
        });
      const result = await saveHaiveData(payload);
      expect(result).toMatchObject({
        ...preserved,
        ...(site === 'push' || site === 'tip' ? { commitSha: 'merged' } : {}),
        outcome: 'failed',
        failure: {
          code:
            site === 'fetch' || site === 'merge'
              ? 'integration_failed'
              : site === 'branch'
                ? 'branch_unreadable'
                : site === 'tip'
                  ? 'branch_tip_unreadable'
                  : 'push_failed',
        },
      });
      expect(h.record).not.toHaveBeenCalled();
      expect(fake.rows(schema.planMirrorState)[0]!.lastError).toBeNull();
    },
  );
  it('reports the pushed tip after a landed merge with no second commit', async () => {
    calls.commit.mockResolvedValueOnce({ ...preserved }).mockResolvedValueOnce({
      committed: false,
      commitSha: null,
      files: [],
      skipped: [],
      indexSynced: true,
    });
    const run = push.gitRun;
    vi.spyOn(push, 'gitRun').mockImplementation(async (cwd, args, ...rest) =>
      args.includes('refs/heads/main^{commit}')
        ? { code: 0, stdout: 'merged', stderr: '' }
        : run(cwd, args, ...rest),
    );
    vi.spyOn(mirror, 'advancePlanBaseFromCommit').mockResolvedValue(undefined);
    expect(await saveHaiveData(payload)).toMatchObject({
      outcome: 'saved',
      commitSha: 'merged',
      pushed: true,
    });
  });
  it('retains the pushed tip distinct from the merge when post-push bookkeeping fails', async () => {
    const run = push.gitRun;
    vi.spyOn(push, 'gitRun').mockImplementation(async (cwd, args, ...rest) =>
      args.includes('refs/heads/main^{commit}')
        ? { code: 0, stdout: 'pushed-tip', stderr: '' }
        : run(cwd, args, ...rest),
    );
    vi.spyOn(mirror, 'advancePlanBaseFromCommit').mockRejectedValue(new Error('after push'));
    expect(await saveHaiveData(payload)).toMatchObject({
      outcome: 'failed',
      pushed: true,
      committed: true,
      commitSha: 'pushed-tip',
      failure: { code: 'save_failed' },
    });
    expect(h.head).toBe('merged');
    expect(push.pushBranch).toHaveBeenCalledWith(expect.objectContaining({ sha: 'pushed-tip' }));
    expect(h.record).not.toHaveBeenCalled();
  });
  it('reports failed index sync', async () => {
    calls.commit.mockResolvedValue({ ...preserved, indexSynced: false });
    expect(await saveHaiveData({ ...payload, push: false })).toMatchObject({ indexSynced: false });
  });
  it.each(['not_git_checkout', 'detached_head', 'no_origin'] as const)(
    'converts late %s through the push core',
    async (code) => {
      if (code === 'not_git_checkout')
        vi.spyOn(workspace, 'requireUsableGit')
          .mockResolvedValueOnce(true)
          .mockResolvedValueOnce(false);
      else
        calls.commit.mockImplementation(async () => {
          if (code === 'no_origin') vi.spyOn(push, 'detectOrigin').mockResolvedValue(false);
          else vi.spyOn(push, 'gitRun').mockResolvedValue({ code: 0, stdout: '', stderr: '' });
          return { ...preserved };
        });
      // Detached-head conversion is also exercised by saveCore directly below: the data seam
      // deliberately gives checkout_changed priority when a named branch moved.
      expect(await saveHaiveData(payload)).toMatchObject({
        outcome: 'refused',
        refusal: { code: code === 'detached_head' ? 'checkout_changed' : code },
      });
      expect(h.record).not.toHaveBeenCalled();
    },
  );
  it.each(['first', 'last'] as const)(
    'refuses checkout_changed at the %s branch recheck',
    async (site) => {
      if (site === 'first')
        calls.commit.mockImplementation(async () => {
          vi.spyOn(push, 'gitRun').mockResolvedValue({ code: 0, stdout: 'other', stderr: '' });
          return { ...preserved };
        });
      else {
        calls.commit.mockResolvedValueOnce({ ...preserved }).mockImplementationOnce(async () => {
          const run = push.gitRun;
          vi.spyOn(push, 'gitRun').mockImplementation(async (cwd, args, ...rest) =>
            args.includes('refs/heads/main^{commit}')
              ? { code: 0, stdout: 'merged', stderr: '' }
              : args[0] === 'branch'
                ? { code: 0, stdout: 'other', stderr: '' }
                : run(cwd, args, ...rest),
          );
          return { committed: false, commitSha: null, files: [], skipped: [] };
        });
      }
      expect(await saveHaiveData(payload)).toMatchObject({
        outcome: 'refused',
        refusal: { code: 'checkout_changed' },
      });
      expect(push.pushBranch).not.toHaveBeenCalled();
      if (site === 'first') expect(h.fetch).not.toHaveBeenCalled();
      else expect(h.fetch).toHaveBeenCalledOnce();
    },
  );
  it('refuses a failed resync after landing and retains the merged tip', async () => {
    h.resync.mockResolvedValue(false);
    expect(await saveHaiveData(payload)).toMatchObject({
      outcome: 'refused',
      commitSha: 'merged',
      refusal: { code: 'resync_failed' },
    });
    expect(push.pushBranch).not.toHaveBeenCalled();
  });
  it('reports plan_merge opened inside integrateOrigin after prechecks', async () => {
    h.fetch.mockImplementation(async () => {
      fake.insert(schema.tasks, {
        id: USER,
        repositoryId: REPO,
        type: 'plan_merge',
        status: 'running',
      });
    });
    expect(await saveHaiveData(payload)).toMatchObject({
      outcome: 'refused',
      refusal: { code: 'plan_merge', taskId: USER },
    });
  });
  it.each([
    [{ outcome: 'missing' }, 'checkout_missing'],
    [{ outcome: 'refused', reason: 'record' }, 'record_refused'],
    [{ outcome: 'absent' }, 'record_absent'],
    [{ outcome: 'superseded' }, 'checkout_changed'],
    [{ outcome: 'held', reason: 'checkout' }, 'checkout_held'],
    [{ outcome: 'held', reason: 'recovery' }, 'write_pending'],
    [{ outcome: 'held', reason: 'sync', code: 'write_pending' }, 'write_pending'],
    [{ outcome: 'held', reason: 'sync', code: 'git_operation' }, 'git_operation'],
    [{ outcome: 'held', reason: 'git_operation' }, 'git_operation'],
    [
      {
        outcome: 'blocked',
        code: 'unowned_malformed_rtk',
        file: '.haive-data/state/settings/rtk-enabled.json',
      },
      'unowned_malformed_rtk',
    ],
  ])('maps flush %j to %s', async (outcome, code) => {
    calls.refresh.mockResolvedValue(outcome);
    expect(await saveHaiveData({ ...payload, push: false })).toMatchObject({
      outcome: 'refused',
      refusal: { code },
    });
    expect(calls.refresh).toHaveBeenCalledOnce();
    expect(calls.commit).not.toHaveBeenCalled();
  });
  it.each([
    'checkout_unreadable',
    'git_operation_unreadable',
    'branch_unreadable',
    'origin_unreadable',
  ] as const)('classifies a failed %s fact read', async (code) => {
    if (code === 'checkout_unreadable')
      vi.spyOn(workspace, 'requireUsableGit').mockRejectedValue(new Error('unreadable'));
    if (code === 'git_operation_unreadable')
      vi.spyOn(operations, 'gitOperationInProgress').mockRejectedValue(new Error('unreadable'));
    if (code === 'branch_unreadable')
      vi.spyOn(push, 'gitRun').mockResolvedValue({ code: 128, stdout: '', stderr: '' });
    if (code === 'origin_unreadable')
      vi.spyOn(push, 'detectOrigin').mockRejectedValue(new push.OriginUrlError('file:///unsafe'));
    expect(await saveHaiveData(payload)).toMatchObject({
      outcome: 'refused',
      committed: false,
      refusal: { code },
    });
    expect(calls.commit).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    'allows a workflow holder without a checkout move (push %s)',
    async (pushRequested) => {
      fake.insert(schema.tasks, {
        id: USER,
        repositoryId: REPO,
        type: 'workflow',
        status: 'running',
        deadAt: null,
      });
      vi.spyOn(merge, 'divergence').mockResolvedValue({ ahead: 1, behind: 0, unrelated: false });
      const run = push.gitRun;
      vi.spyOn(push, 'gitRun').mockImplementation(async (cwd, args, ...rest) =>
        args.includes('refs/heads/main^{commit}')
          ? { code: 0, stdout: 'local', stderr: '' }
          : run(cwd, args, ...rest),
      );
      vi.spyOn(mirror, 'advancePlanBaseFromCommit').mockResolvedValue(undefined);
      expect(await saveHaiveData({ ...payload, push: pushRequested })).toMatchObject({
        outcome: 'saved',
        pushed: pushRequested,
      });
      expect(h.aside).not.toHaveBeenCalled();
    },
  );
  it('fences a workflow holder when origin is ahead', async () => {
    fake.insert(schema.tasks, {
      id: USER,
      repositoryId: REPO,
      type: 'workflow',
      status: 'running',
      deadAt: null,
    });
    h.aside.mockResolvedValue({ outcome: 'held', holding: 1 });
    expect(await saveHaiveData(payload)).toMatchObject({
      committed: true,
      outcome: 'refused',
      refusal: { code: 'integration_held', count: 1 },
    });
  });
});

it('converts detached HEAD inside the shared tail when no branch fence was requested', async () => {
  vi.spyOn(push, 'gitRun').mockResolvedValue({ code: 0, stdout: '', stderr: '' });
  const operation = saveCore(payload, {
    prepare: async () => ({ files: [], repoPath: '/repo' }),
    commit: async () => ({ committed: true, commitSha: 'local' }),
    afterLanding: async () => {},
    onFailure: () => {},
  });
  await expect(operation).rejects.toBeInstanceOf(SavePreconditionError);
  await expect(operation).rejects.toHaveProperty('refusal.code', 'detached_head');
  expect(h.record).not.toHaveBeenCalled();
});
it.each(['git_operation', 'checkout_missing', 'checkout_changed', 'plan_mirror_held'] as const)(
  'maps the mirror flush code %s',
  async (code) => {
    h.flush.mockRejectedValue(new mirror.PlanMirrorHeldError('diagnostic only', code));
    expect(await saveHaiveData({ ...payload, push: false })).toMatchObject({
      outcome: 'refused',
      refusal: { code },
    });
  },
);

it('retains commit fields when the surrounding database transaction fails after the Git commit', async () => {
  const transaction = fake.db.transaction.bind(fake.db);
  vi.spyOn(fake.db, 'transaction').mockImplementation(async (...args) => {
    await transaction(...args);
    throw new Error('database COMMIT failed');
  });
  expect(await saveHaiveData({ ...payload, push: false })).toMatchObject({
    outcome: 'failed',
    committed: true,
    commitSha: 'local',
    files: ['.haive-data/state/format.json'],
    skipped: ['unknown'],
    failure: { code: 'save_failed' },
  });
  expect(h.record).not.toHaveBeenCalled();
});

it.each(['refresh', 'mirror'] as const)(
  'prioritizes the live fact hold after a held %s flush',
  async (site) => {
    const hold = async () => {
      fake.insert(schema.tasks, {
        id: USER,
        repositoryId: REPO,
        type: 'onboarding',
        status: 'running',
        deadAt: null,
      });
    };
    if (site === 'refresh')
      calls.refresh.mockImplementation(async () => {
        await hold();
        return { outcome: 'held', reason: 'recovery' };
      });
    else
      h.flush.mockImplementation(async () => {
        await hold();
        throw new mirror.PlanMirrorHeldError('copy only');
      });
    expect(await saveHaiveData({ ...payload, push: false })).toMatchObject({
      outcome: 'refused',
      refusal: { code: 'checkout_held', taskIds: [USER] },
    });
    expect(calls.commit).not.toHaveBeenCalled();
  },
);
