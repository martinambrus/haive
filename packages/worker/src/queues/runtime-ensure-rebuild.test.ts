import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  classify: vi.fn(),
  rebuild: vi.fn(),
  add: vi.fn(),
  close: vi.fn(),
  worker: vi.fn(),
}));
vi.mock('bullmq', () => ({
  Queue: class {
    add = h.add;
    close = h.close;
  },
  Worker: class {
    constructor(_queue: string, run: unknown) {
      h.worker(run);
    }
    on() {}
  },
}));
vi.mock('../redis.js', () => ({ getBullRedis: () => ({}) }));
vi.mock('../db.js', () => ({
  getDb: () => ({
    query: {
      tasks: { findFirst: async () => ({ repositoryId: 'repo' }) },
      repositories: { findFirst: async () => ({ storagePath: '/repos/user/repo' }) },
    },
  }),
}));
vi.mock('../step-engine/steps/workflow/_app-runtime.js', () => ({ classifyRuntime: h.classify }));
vi.mock('../sandbox/ddev-runner.js', async (original) => ({
  ...(await original<typeof import('../sandbox/ddev-runner.js')>()),
  rebuildDdevRunner: h.rebuild,
}));
vi.mock('./safe-processor.js', () => ({ safeProcessor: (fn: unknown) => fn }));
import { rebuildDdevForTask, startRuntimeEnsureWorker } from './runtime-ensure-queue.js';
const payload = { taskId: 'task', userId: 'owner' };
beforeEach(() => {
  vi.clearAllMocks();
  h.classify.mockResolvedValue({ mode: 'ddev', repoSubpath: 'user/repo' });
  h.rebuild.mockImplementation(async (_task, _workspace, _user, enqueue) => enqueue());
  h.add.mockResolvedValue({});
  h.close.mockResolvedValue(undefined);
});
it('dispatches the dedicated rebuild job and enqueues ordinary ensure without joining an older ensure', async () => {
  startRuntimeEnsureWorker();
  const run = h.worker.mock.calls[0]![0] as (job: unknown) => Promise<unknown>;
  await expect(run({ name: 'rebuild-ddev', data: payload })).resolves.toEqual({
    ok: true,
    mode: 'ddev',
    url: null,
  });
  expect(h.rebuild).toHaveBeenCalledWith('task', 'user/repo', 'owner', expect.any(Function));
  expect(h.add).toHaveBeenCalledWith('ensure-runtime', payload, {
    jobId: expect.stringMatching(/^ensure-rebuild-task-[0-9a-f-]+$/),
    removeOnComplete: true,
    removeOnFail: true,
  });
  expect(h.close).toHaveBeenCalledOnce();
});
it.each([
  ['busy', true],
  ['foreign-runner', false],
  ['workspace-mismatch', false],
] as const)('returns a %s refusal without enqueueing', async (reason, retryable) => {
  const { DdevRebuildRefusedError } = await import('../sandbox/ddev-runner.js');
  h.rebuild.mockRejectedValue(
    new DdevRebuildRefusedError({ reason, message: 'refused', retryable }),
  );
  await expect(rebuildDdevForTask(payload)).resolves.toMatchObject({
    ok: false,
    rebuildRefusal: { reason, message: 'refused', retryable },
  });
  expect(h.add).not.toHaveBeenCalled();
});
it('rejects a non-DDEV task without removal', async () => {
  h.classify.mockResolvedValue({ mode: 'app-runner' });
  await expect(rebuildDdevForTask(payload)).resolves.toMatchObject({
    ok: false,
    rebuildRefusal: {
      reason: 'no-ddev',
      retryable: false,
      message: expect.stringMatching(/no DDEV/),
    },
  });
  expect(h.rebuild).not.toHaveBeenCalled();
});
it('fails the job if ensure could not be queued, and closes the queue', async () => {
  h.add.mockRejectedValue(new Error('queue unavailable'));
  await expect(rebuildDdevForTask(payload)).rejects.toThrow('queue unavailable');
  expect(h.close).toHaveBeenCalledOnce();
});

it('never coalesces a later rebuild recovery into an earlier rebuild’s finishing ensure', async () => {
  await rebuildDdevForTask(payload);
  await rebuildDdevForTask(payload);
  const ids = h.add.mock.calls.map((call) => call[2].jobId);
  expect(new Set(ids).size).toBe(2);
});

it('returns an unknown probe as a retryable refusal', async () => {
  const { RunnerProbeError } = await import('../sandbox/runner-probe.js');
  h.rebuild.mockRejectedValueOnce(new RunnerProbeError('runner', new Error('timeout')));
  await expect(rebuildDdevForTask(payload)).resolves.toMatchObject({
    ok: false,
    rebuildRefusal: { reason: 'probe-unknown', retryable: true },
  });
  expect(h.add).not.toHaveBeenCalled();
});
