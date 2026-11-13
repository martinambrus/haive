import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { Database } from '@haive/database';

const h = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('@haive/shared', async (original) => ({
  ...(await original<typeof import('@haive/shared')>()),
  logger: { child: () => h },
}));
vi.mock('../src/queues/task-queue.js', () => ({
  retrying: async (attempt: () => Promise<void>) => attempt(),
  REDRIVE_RETRY_DELAYS_MS: [],
}));
import { configService } from '@haive/shared';
import { runPrPollTick } from '../src/queues/pr-poll-queue.js';

// No queue is constructed: the real poller's step lookup fails before enqueue.
describe('merged-PR recovery visibility', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('reports a failed step lookup and continues through this and later task batches', async () => {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
    const taskId = '11111111-1111-4111-8111-111111111111';
    const lookupFailure = new Error('step lookup unavailable');
    const findFirst = vi.fn().mockRejectedValueOnce(lookupFailure).mockResolvedValue(undefined);
    const taskIds = Array.from({ length: 6 }, (_, index) => taskId.slice(0, -1) + (index + 1));
    const db = {
      update: () => ({ set: () => ({ where: async () => undefined }) }),
      query: {
        tasks: {
          findMany: async () =>
            taskIds.map((id) => ({ id, prState: 'merged', prFinalizeMode: 'auto' })),
        },
        taskSteps: {
          findFirst,
        },
      },
    } as unknown as Database;

    // A per-task failure must remain visible even though the tick continues.
    await runPrPollTick(db);
    expect(findFirst).toHaveBeenCalledTimes(taskIds.length);
    expect([...h.warn.mock.calls, ...h.error.mock.calls]).toEqual(
      expect.arrayContaining([
        [expect.objectContaining({ taskId, error: lookupFailure.message }), expect.any(String)],
      ]),
    );
  });
  it('logs a sanitized settled rejection when persisting a poll error also fails', async () => {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
    const taskId = '11111111-1111-4111-8111-111111111111';
    const queryFailure = Object.assign(new Error('bound ' + randomBytes(12).toString('hex')), {
      query: 'update tasks set pr_poll_error = $1',
      params: [randomBytes(12).toString('hex')],
    });
    const db = {
      update: () => {
        throw queryFailure;
      },
      query: {
        tasks: {
          findMany: async () => [{ id: taskId, prState: 'merged', prFinalizeMode: 'auto' }],
        },
        taskSteps: {
          findFirst: async () => {
            throw new Error('lookup unavailable');
          },
        },
      },
    } as unknown as Database;

    await expect(runPrPollTick(db)).resolves.toBeUndefined();
    expect([...h.warn.mock.calls, ...h.error.mock.calls]).toEqual([
      [expect.objectContaining({ taskId, error: 'Database operation failed' }), expect.any(String)],
    ]);
  });
});
