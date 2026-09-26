import { beforeEach, describe, expect, it, vi } from 'vitest';

const { db, taskQueue, order, inserted } = vi.hoisted(() => {
  const order: string[] = [];
  const inserted: Record<string, unknown>[] = [];
  const db = {
    insert: () => ({
      values: (row: Record<string, unknown>) => ({
        returning: async () => {
          inserted.push(row);
          order.push('insert');
          return [{ id: 'task-1' }];
        },
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => {
            order.push('queued');
            return [{ id: 'task-1', status: 'queued' }];
          },
        }),
      }),
    }),
  };
  const taskQueue = {
    add: vi.fn(async () => {
      order.push('enqueue');
    }),
  };
  return { db, taskQueue, order, inserted };
});

vi.mock('../src/db.js', () => ({ getDb: () => db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => taskQueue }));

import { spawnPlanTask } from '../src/lib/spawn-plan-task.js';

/**
 * The ordering the seed hook exists for.
 *
 * A plan chat's opening message is written by the ROUTE, and its step's
 * detect() derives the pending question from the transcript. Enqueue first and
 * the worker wins the race: it picks the job up, finds an empty transcript, and
 * parks asking for a message the user already sent. Measured on a live
 * conversation - the opening turn was never answered.
 */
describe('spawnPlanTask seeding', () => {
  beforeEach(() => {
    order.length = 0;
    taskQueue.add.mockClear();
  });

  const args = {
    userId: 'u1',
    repositoryId: 'r1',
    type: 'plan_chat' as const,
    title: 'chat',
    metadata: {},
    cliProviderId: null,
  };

  it('seeds after the row exists and queues the task only once seeded', async () => {
    await spawnPlanTask({
      ...args,
      seed: async (taskId) => {
        order.push(`seed:${taskId}`);
      },
    });
    expect(order).toEqual(['insert', 'seed:task-1', 'queued', 'enqueue']);
  });

  it('hands the seed the id of the row it just wrote', async () => {
    const seen: string[] = [];
    await spawnPlanTask({ ...args, seed: async (id) => void seen.push(id) });
    expect(seen).toEqual(['task-1']);
  });

  it('still enqueues when there is nothing to seed', async () => {
    await spawnPlanTask(args);
    expect(order).toEqual(['insert', 'queued', 'enqueue']);
  });

  it('creates without enqueueing when the start is deferred', async () => {
    // A plan build whose attachments are still to be uploaded. The step's detect
    // reads the uploads dir and the worker picks a job up immediately, so the
    // row is created unstarted and the `start` action enqueues it once every
    // file has landed. Enqueueing here would be the exact race the deferral
    // exists to avoid.
    const id = await spawnPlanTask({ ...args, type: 'plan_build' as const, enqueue: false });
    expect(id).toBe('task-1');
    expect(order).toEqual(['insert']);
    expect(taskQueue.add).not.toHaveBeenCalled();
  });

  it('still runs the seed when the start is deferred', async () => {
    await spawnPlanTask({
      ...args,
      type: 'plan_build' as const,
      enqueue: false,
      seed: async (taskId) => {
        order.push(`seed:${taskId}`);
      },
    });
    expect(order).toEqual(['insert', 'seed:task-1']);
  });

  it('does not enqueue a task whose seed failed', async () => {
    // Half a chat - a task row with no opening message - would park asking for
    // a message the user believes they already sent.
    await expect(
      spawnPlanTask({
        ...args,
        seed: async () => {
          throw new Error('message insert failed');
        },
      }),
    ).rejects.toThrow('message insert failed');
    expect(taskQueue.add).not.toHaveBeenCalled();
  });
});

describe('spawnPlanTask CLI choice', () => {
  const base = {
    userId: 'u1',
    repositoryId: 'r1',
    type: 'plan_chat' as const,
    title: 'chat',
    metadata: {},
    cliProviderId: 'provider-1',
  };

  beforeEach(() => {
    inserted.length = 0;
  });

  it('keeps saved per-step CLIs when the caller named none', async () => {
    await spawnPlanTask(base);
    expect(inserted[0]).toMatchObject({ ignoreSavedStepClis: false });
  });

  it('lets a picked CLI win over a saved per-step preference', async () => {
    await spawnPlanTask({ ...base, ignoreSavedStepClis: true });
    expect(inserted[0]).toMatchObject({ cliProviderId: 'provider-1', ignoreSavedStepClis: true });
  });
});
