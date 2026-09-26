import { describe, expect, it } from 'vitest';
import type { Job, Queue } from 'bullmq';
import { CLI_EXEC_JOB_NAMES } from '@haive/shared';
import {
  BOOT_REQUEUE_LIMIT,
  cliExecJobRequeuedAtBoot,
  requeueOrphanedActiveJobs,
} from '../src/queues/boot-requeue.js';

interface FakeJob {
  id: string;
  name: string;
  timestamp: number;
  moved: string[];
  moveToWait(token: string): Promise<number>;
}

function fakeJob(id: string, name: string, timestamp = 1000): FakeJob {
  return {
    id,
    name,
    timestamp,
    moved: [],
    async moveToWait(token: string) {
      this.moved.push(token);
      return 0;
    },
  };
}

function fakeQueue(workers: number | Error, jobs: FakeJob[]) {
  let jobsRead = 0;
  const queue = {
    name: 'q',
    async getWorkersCount() {
      if (workers instanceof Error) throw workers;
      return workers;
    },
    async getJobs(types: string[]) {
      expect(types).toEqual(['active']);
      jobsRead += 1;
      return jobs;
    },
  };
  return { queue: queue as unknown as Queue, jobsRead: () => jobsRead };
}

const accept = (job: Job) => job.name !== 'skip';

function counter(counts: Record<string, number> = {}) {
  const keys: string[] = [];
  return {
    keys,
    count: async (key: string) => {
      keys.push(key);
      const n = counts[key] ?? 1;
      if (n < 0) throw new Error('redis down');
      return n;
    },
  };
}

describe('requeueOrphanedActiveJobs', () => {
  it('moves every accepted active job back to waiting while no worker is connected', async () => {
    const a = fakeJob('1', 'advance-step');
    const b = fakeJob('2', 'skip');
    const c = fakeJob('3', 'start-task');
    const { queue } = fakeQueue(0, [a, b, c]);
    const moved = await requeueOrphanedActiveJobs(queue, accept, counter().count);
    expect(moved).toBe(2);
    expect(a.moved).toEqual(['0']);
    expect(b.moved).toEqual([]);
    expect(c.moved).toEqual(['0']);
  });

  it('moves nothing while any worker is connected', async () => {
    const a = fakeJob('1', 'advance-step');
    const { queue, jobsRead } = fakeQueue(1, [a]);
    expect(await requeueOrphanedActiveJobs(queue, accept, counter().count)).toBe(0);
    expect(a.moved).toEqual([]);
    expect(jobsRead()).toBe(0);
  });

  it('moves nothing when the worker count cannot be read', async () => {
    const a = fakeJob('1', 'advance-step');
    const { queue } = fakeQueue(new Error('CLIENT LIST refused'), [a]);
    expect(await requeueOrphanedActiveJobs(queue, accept, counter().count)).toBe(0);
    expect(a.moved).toEqual([]);
  });

  it('counts requeues per job incarnation and leaves one past the limit to its lock', async () => {
    const atLimit = fakeJob('1', 'advance-step', 111);
    const pastLimit = fakeJob('2', 'advance-step', 222);
    const { queue } = fakeQueue(0, [atLimit, pastLimit]);
    const c = counter({
      'haive:boot-requeue:q:1:111': BOOT_REQUEUE_LIMIT,
      'haive:boot-requeue:q:2:222': BOOT_REQUEUE_LIMIT + 1,
    });
    expect(await requeueOrphanedActiveJobs(queue, accept, c.count)).toBe(1);
    expect(c.keys).toEqual(['haive:boot-requeue:q:1:111', 'haive:boot-requeue:q:2:222']);
    expect(atLimit.moved).toEqual(['0']);
    expect(pastLimit.moved).toEqual([]);
  });

  it('leaves a job whose requeue could not be counted and carries on with the rest', async () => {
    const uncounted = fakeJob('1', 'advance-step');
    const next = fakeJob('2', 'advance-step');
    const { queue } = fakeQueue(0, [uncounted, next]);
    const c = counter({ 'haive:boot-requeue:q:1:1000': -1 });
    expect(await requeueOrphanedActiveJobs(queue, accept, c.count)).toBe(1);
    expect(uncounted.moved).toEqual([]);
    expect(next.moved).toEqual(['0']);
  });
});

describe('cliExecJobRequeuedAtBoot', () => {
  it('takes an agent run and the version refresh, and no other cli-exec job', () => {
    const taken = Object.values(CLI_EXEC_JOB_NAMES).filter((name) =>
      cliExecJobRequeuedAtBoot({ name }),
    );
    expect(taken.sort()).toEqual(
      [CLI_EXEC_JOB_NAMES.INVOKE, CLI_EXEC_JOB_NAMES.REFRESH_VERSIONS].sort(),
    );
  });
});
