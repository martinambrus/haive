import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { taskRootMergeBusy } from '../src/root-merge-busy.js';

const h = vi.hoisted(() => ({ live: true }));
// Claim lifecycle itself is exercised on Postgres by the API START controls.
vi.mock('../src/merge-dir-claim.js', () => ({
  liveClaimHolder: async () =>
    h.live
      ? {
          id: '00000000-0000-4000-8000-000000000003',
          title: '00000000-0000-4000-8000-000000000003',
        }
      : null,
}));
beforeEach(() => {
  h.live = true;
});

function world() {
  const fake = createFakeDb({
    repositories: schema.repositories,
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
    mergeDirClaims: schema.mergeDirClaims,
  });
  fake.insert(schema.repositories, {
    id: '00000000-0000-4000-8000-000000000001',
    storagePath: '/repo',
  });
  fake.insert(schema.tasks, {
    id: '00000000-0000-4000-8000-000000000002',
    repositoryId: '00000000-0000-4000-8000-000000000001',
  });
  fake.insert(schema.tasks, { id: '00000000-0000-4000-8000-000000000003', status: 'waiting_user' });
  fake.insert(schema.taskSteps, {
    id: '00000000-0000-4000-8000-000000000004',
    taskId: '00000000-0000-4000-8000-000000000003',
    status: 'waiting_cli',
    mergeResolveState: { mode: 'same-branch', phase: 'resolving' },
  });
  fake.insert(schema.mergeDirClaims, {
    mergeDir: '/repo',
    taskId: '00000000-0000-4000-8000-000000000003',
    taskStepId: '00000000-0000-4000-8000-000000000004',
  });
  const busy = () =>
    fake.db.transaction((tx) =>
      taskRootMergeBusy(tx as never, '00000000-0000-4000-8000-000000000002'),
    );
  return { fake, busy };
}

describe('root merge re-drive predicate', () => {
  it('holds a live same-branch claim and releases once it is done', async () => {
    const { fake, busy } = world();
    expect(await busy()).toBe(true);
    fake.patch(schema.taskSteps, '00000000-0000-4000-8000-000000000004', {
      mergeResolveState: { mode: 'same-branch', phase: 'done' },
    });
    expect(await busy()).toBe(false);
  });
  it.each(['worktree', 'cross-branch', 'skipped', 'completed', 'pushing', 'cancelled-finished'])(
    'does not hold %s',
    async (kind) => {
      const { fake, busy } = world();
      if (kind === 'worktree')
        fake.patch(schema.tasks, '00000000-0000-4000-8000-000000000002', {
          worktreePath: '/repo/wt',
        });
      if (kind === 'cross-branch' || kind === 'pushing')
        fake.patch(schema.taskSteps, '00000000-0000-4000-8000-000000000004', {
          mergeResolveState: {
            mode: kind === 'cross-branch' ? kind : 'same-branch',
            phase: kind === 'pushing' ? kind : 'resolving',
          },
        });
      if (kind === 'skipped')
        fake.patch(schema.taskSteps, '00000000-0000-4000-8000-000000000004', { status: 'skipped' });
      if (kind === 'completed')
        fake.patch(schema.tasks, '00000000-0000-4000-8000-000000000003', { status: 'completed' });
      if (kind === 'cancelled-finished') {
        fake.patch(schema.tasks, '00000000-0000-4000-8000-000000000003', { status: 'cancelled' });
        fake.insert(schema.taskEvents, {
          taskId: '00000000-0000-4000-8000-000000000003',
          eventType: 'task.cancel_finished',
        });
      }
      if (['skipped', 'completed', 'cancelled-finished'].includes(kind)) h.live = false;
      expect(await busy()).toBe(false);
    },
  );
  it('uses a skipped latest setup over stale worktree columns', async () => {
    const { fake, busy } = world();
    fake.patch(schema.tasks, '00000000-0000-4000-8000-000000000002', { worktreePath: '/repo/wt' });
    fake.insert(schema.taskSteps, {
      taskId: '00000000-0000-4000-8000-000000000002',
      stepId: '01-worktree-setup',
      round: 0,
      status: 'done',
    });
    fake.insert(schema.taskSteps, {
      taskId: '00000000-0000-4000-8000-000000000002',
      stepId: '01-worktree-setup',
      round: 1,
      status: 'skipped',
    });
    expect(await busy()).toBe(true);
  });
  it('holds a cancelled merge until its left-open report is settled', async () => {
    const { fake, busy } = world();
    h.live = false;
    fake.patch(schema.tasks, '00000000-0000-4000-8000-000000000003', { status: 'completed' });
    fake.insert(schema.taskEvents, {
      taskId: '00000000-0000-4000-8000-000000000003',
      eventType: 'merge.left_open',
      payload: { dir: '/repo', ref: 'main', head: 'h', mergeHead: 'm' },
    });
    expect(await busy()).toBe(true);
    fake.insert(schema.taskEvents, {
      taskId: '00000000-0000-4000-8000-000000000003',
      eventType: 'merge.left_open_settled',
      payload: { dir: '/repo', mergeHead: 'm', outcome: 'aborted', reason: 'settled' },
    });
    expect(await busy()).toBe(false);
  });
  it('propagates a lock failure instead of allowing the re-drive', async () => {
    const { fake, busy } = world();
    fake.hooks.beforeLock = () => {
      throw new Error('read failed');
    };
    await expect(busy()).rejects.toThrow('read failed');
  });
});
