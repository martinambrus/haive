import { beforeEach, describe, expect, it, vi } from 'vitest';

const { db, tx, taskQueue, order, inserted } = vi.hoisted(() => {
  const order: string[] = [];
  const inserted: Record<string, unknown>[] = [];
  const tx = {
    execute: async (query: { queryChunks: unknown[] }) => {
      const head = (query.queryChunks[0] as { value: string[] }).value.join('');
      order.push(
        /pg_advisory_xact_lock_shared\(hashtextextended\($/.test(head)
          ? `fence:${String(query.queryChunks[1])}`
          : /pg_advisory_xact_lock\(hashtextextended\($/.test(head)
            ? `lock:${String(query.queryChunks[1])}`
            : 'execute',
      );
    },
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
    select: () => ({ from: () => ({ where: async () => [{ repositoryId: 'r1' }] }) }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => fn(db),
  };
  const db = {
    ...tx,
    transaction: async (run: (handle: typeof tx) => Promise<unknown>) => {
      const result = await run(tx);
      order.push('commit');
      return result;
    },
  };
  const taskQueue = {
    add: vi.fn(async () => {
      order.push('enqueue');
    }),
  };
  return { db, tx, taskQueue, order, inserted };
});

vi.mock('../src/db.js', () => ({ getDb: () => db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => taskQueue }));

vi.mock('../src/lib/task-type-definition.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/task-type-definition.js')>()),
  definitionForCreate: async () => ({ runListSnapshot: null }),
}));

import { configService } from '@haive/shared';
import { enqueuePlanTask, spawnPlanTask } from '../src/lib/spawn-plan-task.js';

const FENCE = 'fence:haive-new-work-fence';
const LOCK = 'lock:onboarding-upgrade:r1';
const BOUNDED_LOCK = ['execute', LOCK, 'execute'];

beforeEach(() => {
  vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');
});

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
    inserted.length = 0;
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

  it('seeds after the row exists and queues START only once it is seeded and committed', async () => {
    await spawnPlanTask({
      ...args,
      seed: async (taskId) => {
        order.push(`seed:${taskId}`);
      },
    });
    expect(order).toEqual([
      FENCE,
      ...BOUNDED_LOCK,
      'insert',
      'seed:task-1',
      ...BOUNDED_LOCK,
      'queued',
      'commit',
      'enqueue',
    ]);
  });

  it('hands the seed the id of the row it just wrote and the transaction it was written in', async () => {
    const seen: unknown[] = [];
    await spawnPlanTask({ ...args, seed: async (id, handle) => void seen.push(id, handle) });
    expect(seen).toEqual(['task-1', tx]);
  });

  it('still enqueues when there is nothing to seed', async () => {
    await spawnPlanTask({ ...args, expectedAttachmentCount: 3 });
    expect(inserted[0]).toMatchObject({ expectedAttachmentCount: null });
    expect(order).toEqual([
      FENCE,
      ...BOUNDED_LOCK,
      'insert',
      ...BOUNDED_LOCK,
      'queued',
      'commit',
      'enqueue',
    ]);
  });

  it('creates without enqueueing when the start is deferred', async () => {
    // A plan build whose attachments are still to be uploaded. The step's detect
    // reads the uploads dir and the worker picks a job up immediately, so the
    // row is created unstarted and the `start` action enqueues it once every
    // file has landed. Enqueueing here would be the exact race the deferral
    // exists to avoid.
    const id = await spawnPlanTask({
      ...args,
      type: 'plan_build' as const,
      enqueue: false,
      expectedAttachmentCount: 3,
    });
    expect(inserted[0]).toMatchObject({ expectedAttachmentCount: 3 });
    expect(id).toBe('task-1');
    expect(order).toEqual([FENCE, ...BOUNDED_LOCK, 'insert', 'commit']);
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
    expect(order).toEqual([FENCE, ...BOUNDED_LOCK, 'insert', 'seed:task-1', 'commit']);
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
    expect(order).toEqual([FENCE, ...BOUNDED_LOCK, 'insert']);
    expect(taskQueue.add).not.toHaveBeenCalled();
  });
});

describe('spawnPlanTask while the system drains', () => {
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

  it('takes the fence in the transaction a caller owns, before it writes the task', async () => {
    await spawnPlanTask({ ...args, db: tx as never });

    expect(order).toEqual([FENCE, ...BOUNDED_LOCK, 'insert', ...BOUNDED_LOCK, 'queued']);
  });

  it.each(['draining', 'maintenance'])(
    'writes and queues nothing when the state is %s once the fence is held',
    async (state) => {
      vi.spyOn(configService, 'getFresh').mockResolvedValue(state);

      await expect(spawnPlanTask(args)).rejects.toMatchObject({ status: 503 });
      await expect(spawnPlanTask({ ...args, db: tx as never })).rejects.toMatchObject({
        status: 503,
      });

      expect(order).toEqual([FENCE, FENCE]);
      expect(taskQueue.add).not.toHaveBeenCalled();
    },
  );
});

describe('enqueuePlanTask', () => {
  beforeEach(() => {
    order.length = 0;
    taskQueue.add.mockClear();
  });

  it('claims the started task under the fence and queues START after the commit', async () => {
    await enqueuePlanTask('task-1', 'u1');

    expect(order).toEqual([FENCE, ...BOUNDED_LOCK, 'queued', 'commit', 'enqueue']);
  });

  it('claims and queues nothing when the state is draining once the fence is held', async () => {
    vi.spyOn(configService, 'getFresh').mockResolvedValue('draining');

    await expect(enqueuePlanTask('task-1', 'u1')).rejects.toMatchObject({ status: 503 });

    expect(order).toEqual([FENCE]);
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
