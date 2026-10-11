import { describe, expect, it, vi } from 'vitest';

const queue = vi.hoisted(() => ({ fail: false, added: [] as unknown[] }));

vi.mock('../src/queues.js', () => ({
  getTaskQueue: () => ({
    add: async (...args: unknown[]) => {
      if (queue.fail) throw new Error('redis down');
      queue.added.push(args);
    },
  }),
}));

import { enqueueCancelJob } from '../src/lib/cancel-task.js';

describe('enqueueCancelJob', () => {
  it('queues the teardown', async () => {
    queue.fail = false;
    await enqueueCancelJob('t1', 'u1');
    expect(queue.added).toHaveLength(1);
  });

  it('does not fail a cancel that already committed when the queue refuses: the sweep re-drives it', async () => {
    queue.fail = true;
    await expect(enqueueCancelJob('t2', 'u1')).resolves.toBeUndefined();
  });
});
