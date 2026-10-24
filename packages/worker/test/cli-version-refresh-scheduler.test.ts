import { beforeEach, describe, expect, it, vi } from 'vitest';

const queue = vi.hoisted(() => ({
  add: vi.fn(),
  getJobs: vi.fn(),
  upsertJobScheduler: vi.fn(),
  getJobSchedulers: vi.fn(async () => []),
}));

vi.mock('../src/queues/cli-exec/_shared.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/queues/cli-exec/_shared.js')>();
  return { ...actual, getCliExecQueue: () => queue };
});

import { CLI_EXEC_JOB_NAMES, VERSION_REFRESH_JOB_ID } from '@haive/shared';
import { scheduleCliVersionRefresh } from '../src/queues/cli-exec/handlers.js';

beforeEach(() => {
  vi.clearAllMocks();
  queue.getJobs.mockResolvedValue([]);
});

describe('version refresh scheduler', () => {
  it('keeps scheduler and boot results readable beyond the browser poll window', async () => {
    await scheduleCliVersionRefresh();

    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      VERSION_REFRESH_JOB_ID,
      { every: 12 * 60 * 60 * 1000 },
      expect.objectContaining({ name: CLI_EXEC_JOB_NAMES.REFRESH_VERSIONS }),
    );
    const scheduled = queue.upsertJobScheduler.mock.calls[0]![2];
    const boot = queue.add.mock.calls[0]!;
    for (const opts of [scheduled.opts, boot[2]]) {
      expect(opts.removeOnComplete.age).toBeGreaterThan(600);
      expect(opts.removeOnFail.age).toBeGreaterThan(600);
      expect(opts).not.toHaveProperty('jobId');
    }
    expect(scheduled.data).toEqual({});
    expect(boot[1]).toEqual({});
    expect(scheduled.name).toBe(CLI_EXEC_JOB_NAMES.REFRESH_VERSIONS);
    expect(boot[0]).toBe(CLI_EXEC_JOB_NAMES.REFRESH_VERSIONS);
  });

  it('skips the boot kick when a refresh is already in flight', async () => {
    queue.getJobs.mockResolvedValue([{ name: CLI_EXEC_JOB_NAMES.REFRESH_VERSIONS }]);
    await scheduleCliVersionRefresh();

    expect(queue.getJobs).toHaveBeenCalledWith(['active', 'wait', 'prioritized']);
    expect(queue.add).not.toHaveBeenCalled();
  });
});
