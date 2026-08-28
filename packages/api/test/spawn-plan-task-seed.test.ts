import { beforeEach, describe, expect, it, vi } from 'vitest';

const { db, taskQueue, order } = vi.hoisted(() => {
  const order: string[] = [];
  const db = {
    insert: () => ({
      values: () => ({
        returning: async () => {
          order.push('insert');
          return [{ id: 'task-1' }];
        },
      }),
    }),
  };
  const taskQueue = {
    add: vi.fn(async () => {
      order.push('enqueue');
    }),
  };
  return { db, taskQueue, order };
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

  it('seeds after the row exists and before the job is enqueued', async () => {
    await spawnPlanTask({
      ...args,
      seed: async (taskId) => {
        order.push(`seed:${taskId}`);
      },
    });
    expect(order).toEqual(['insert', 'seed:task-1', 'enqueue']);
  });

  it('hands the seed the id of the row it just wrote', async () => {
    const seen: string[] = [];
    await spawnPlanTask({ ...args, seed: async (id) => void seen.push(id) });
    expect(seen).toEqual(['task-1']);
  });

  it('still enqueues when there is nothing to seed', async () => {
    await spawnPlanTask(args);
    expect(order).toEqual(['insert', 'enqueue']);
  });

  it('writes a plan document before the job is enqueued', async () => {
    // The from_md case. The step's detect reads the uploads dir, and the worker
    // picks a job up immediately, so a document written after the enqueue is a
    // document the build may never see.
    const writes: string[] = [];
    await spawnPlanTask({
      ...args,
      type: 'plan_build' as const,
      seed: async (taskId) => {
        writes.push('attachment');
        order.push(`seed:${taskId}`);
      },
    });
    expect(order).toEqual(['insert', 'seed:task-1', 'enqueue']);
    expect(writes).toEqual(['attachment']);
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
