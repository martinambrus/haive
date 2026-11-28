import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  classify: vi.fn(),
  rebuild: vi.fn(),
  add: vi.fn(),
  close: vi.fn(),
  worker: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  task: vi.fn(),
  ensure: vi.fn(),
  repoStatus: { value: 'ready' },
  repoFail: { value: undefined as Error | undefined },
}));
vi.mock('@haive/shared', async (original) => ({
  ...(await original<typeof import('@haive/shared')>()),
  logger: { child: () => ({ error: h.error, info: h.info, warn: vi.fn() }) },
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
      tasks: { findFirst: h.task },
      repositories: {
        findFirst: async () => {
          if (h.repoFail.value) throw h.repoFail.value;
          return { storagePath: '/repos/user/repo', status: h.repoStatus.value };
        },
      },
    },
  }),
}));
vi.mock('../step-engine/steps/workflow/_app-runtime.js', () => ({
  classifyRuntime: h.classify,
  ensureAppServing: h.ensure,
}));
vi.mock('../sandbox/ddev-runner.js', async (original) => ({
  ...(await original<typeof import('../sandbox/ddev-runner.js')>()),
  rebuildDdevRunner: h.rebuild,
}));
vi.mock('./safe-processor.js', () => ({ safeProcessor: (fn: unknown) => fn }));
import { CheckoutUnavailableError } from '@haive/shared/checkout-access';
import { interactiveCheckouts } from '../repo/interactive-checkout.js';
import { rebuildDdevForTask, startRuntimeEnsureWorker } from './runtime-ensure-queue.js';
const payload = { taskId: 'task', userId: 'owner' };
beforeEach(() => {
  vi.clearAllMocks();
  h.repoStatus.value = 'ready';
  h.repoFail.value = undefined;
  h.ensure.mockResolvedValue(null);
  h.task.mockResolvedValue({ repositoryId: 'repo' });
  h.classify.mockResolvedValue({ mode: 'ddev', repoSubpath: 'user/repo' });
  h.rebuild.mockImplementation(async (_task, _workspace, _user, enqueue) => {
    await enqueue();
    return { removed: true };
  });
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
    removed: true,
  });
  expect(h.rebuild).toHaveBeenCalledWith('task', 'user/repo', 'owner', expect.any(Function));
  expect(h.add).toHaveBeenCalledWith('ensure-runtime', payload, {
    jobId: expect.stringMatching(/^ensure-rebuild-task-[0-9a-f-]+$/),
    removeOnComplete: true,
    removeOnFail: true,
  });
  expect(h.close).toHaveBeenCalledOnce();
  expect(h.info).not.toHaveBeenCalled();
});
it('carries the already absent runner outcome through the job result', async () => {
  h.rebuild.mockImplementationOnce(async (_task, _workspace, _user, enqueue) => {
    await enqueue();
    return { removed: false };
  });
  await expect(rebuildDdevForTask(payload)).resolves.toMatchObject({ ok: true, removed: false });
  expect(h.add).toHaveBeenCalledOnce();
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
  expect(h.info).toHaveBeenCalledExactlyOnceWith(
    { taskId: 'task', reason },
    'DDEV rebuild refused',
  );
  expect(h.error).not.toHaveBeenCalled();
});
it.each(['missing workspace', 'non-DDEV runtime'])(
  'refuses a %s without removal',
  async (source) => {
    if (source === 'missing workspace') h.task.mockResolvedValueOnce(undefined);
    else h.classify.mockResolvedValue({ mode: 'app-runner' });
    await expect(rebuildDdevForTask(payload)).resolves.toMatchObject({
      ok: false,
      rebuildRefusal: {
        reason: 'no-ddev',
        retryable: false,
        message: expect.stringMatching(/DDEV/),
      },
    });
    expect(h.rebuild).not.toHaveBeenCalled();
    expect(h.info).toHaveBeenCalledExactlyOnceWith(
      { taskId: 'task', reason: 'no-ddev' },
      'DDEV rebuild refused',
    );
    expect(h.error).not.toHaveBeenCalled();
  },
);
it.each(['rm', 'audit-insert', 'enqueue', 'context'] as const)(
  'returns a typed failure and logs an error when %s fails',
  async (source) => {
    const error = Object.assign(new Error(`${source} failed with private details`), {
      params: ['secret'],
    });
    if (source === 'enqueue') h.add.mockRejectedValueOnce(error);
    else if (source === 'context') h.classify.mockRejectedValueOnce(error);
    else h.rebuild.mockRejectedValueOnce(error);
    await expect(rebuildDdevForTask(payload)).resolves.toMatchObject({
      ok: false,
      rebuildFailure: { message: 'DDEV rebuild failed. Try again; recovery may still be needed.' },
    });
    expect(h.error).toHaveBeenCalledWith({ taskId: 'task', err: error }, 'DDEV rebuild failed');
    expect(h.info).not.toHaveBeenCalled();
    if (source === 'enqueue') expect(h.close).toHaveBeenCalledOnce();
  },
);

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
  expect(h.info).toHaveBeenCalledExactlyOnceWith(
    { taskId: 'task', reason: 'probe-unknown' },
    'DDEV rebuild refused',
  );
  expect(h.error).not.toHaveBeenCalled();
});

const pinnedJobs = ['ensure-runtime', 'navigate-mailpit', 'rebuild-ddev'];
const rejectedJobs = ['ensure-runtime', 'navigate-mailpit'];
const refusedRebuild = {
  ok: false,
  url: null,
  mode: 'none',
  rebuildRefusal: {
    reason: 'checkout-unavailable',
    message: new CheckoutUnavailableError().message,
    retryable: true,
  },
};
const runner = () => {
  startRuntimeEnsureWorker();
  return h.worker.mock.calls[0]![0] as (job: unknown) => Promise<unknown>;
};
it.each(rejectedJobs)(
  '%s rejects with checkout_unavailable while the repository is cloning',
  async (name) => {
    h.repoStatus.value = 'cloning';
    await expect(runner()({ name, data: payload })).rejects.toMatchObject({
      code: 'checkout_unavailable',
    });
    expect(h.ensure).not.toHaveBeenCalled();
    expect(h.classify).not.toHaveBeenCalled();
    expect(h.rebuild).not.toHaveBeenCalled();
  },
);
const expectRefused = async () => {
  await expect(runner()({ name: 'rebuild-ddev', data: payload })).resolves.toEqual(refusedRebuild);
  expect(h.rebuild).not.toHaveBeenCalled();
  expect(h.classify).not.toHaveBeenCalled();
  expect(h.ensure).not.toHaveBeenCalled();
  expect(h.info).toHaveBeenCalledExactlyOnceWith(
    { taskId: 'task', reason: 'checkout-unavailable' },
    'DDEV rebuild refused',
  );
};
it('rebuild-ddev resolves a typed refusal while the repository is cloning', async () => {
  h.repoStatus.value = 'cloning';
  await expectRefused();
});
it('rebuild-ddev resolves a typed refusal while the process barrier is suspended', async () => {
  const release = await interactiveCheckouts.suspend('repo', async () => {});
  try {
    await expectRefused();
  } finally {
    release();
  }
});
it('rebuild-ddev still rejects when the durable read fails for an unknown reason', async () => {
  h.repoFail.value = new Error('boom');
  await expect(runner()({ name: 'rebuild-ddev', data: payload })).rejects.toThrow('boom');
  expect(h.rebuild).not.toHaveBeenCalled();
});

it.each(pinnedJobs)('%s dispatches when the repository is ready', async (name) => {
  startRuntimeEnsureWorker();
  const run = h.worker.mock.calls[0]![0] as (job: unknown) => Promise<unknown>;
  await run({ name, data: payload });
  expect(name === 'rebuild-ddev' ? h.rebuild : h.ensure).toHaveBeenCalled();
});
