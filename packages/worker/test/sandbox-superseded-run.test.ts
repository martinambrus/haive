import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stubs = vi.hoisted(() => ({
  runInSandbox: vi.fn(),
  isRunSuperseded: vi.fn(async (_id: string) => false),
}));
vi.mock('../src/sandbox/sandbox-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/sandbox-runner.js')>()),
  runInSandbox: stubs.runInSandbox,
}));
vi.mock('../src/queues/cli-exec/run-superseded.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/queues/cli-exec/run-superseded.js')>();
  return {
    ...actual,
    isRunSuperseded: stubs.isRunSuperseded,
    watchSupersededRun: (id: string) => actual.watchSupersededRun(id, stubs.isRunSuperseded),
  };
});
vi.mock('../src/queues/cli-exec/preempt-mark.js', () => ({
  markPreempted: async () => {},
  consumePreemptionMark: async () => false,
}));

import { createSandboxSpawner } from '../src/queues/cli-exec/exec-core.js';
import { SUPERSEDED_POLL_MS, SUPERSEDED_RUN_ERROR } from '../src/queues/cli-exec/run-superseded.js';
import { SANDBOX_WORKDIR } from '../src/sandbox/sandbox-runner.js';
import type { CliCommandSpec } from '../src/cli-adapters/types.js';

const spec = { command: 'claude', args: ['-p'], env: {} } as unknown as CliCommandSpec;
const spawn = () =>
  createSandboxSpawner(
    null,
    null,
    null,
    SANDBOX_WORKDIR,
    null,
    [],
    [],
    [],
    'task-1',
    'run-1',
  )(spec);
const ran = {
  exitCode: 0,
  stdout: '',
  stderr: '',
  durationMs: 1,
  timedOut: false,
  resolvedCommand: 'claude',
  wrapperId: null,
};

beforeEach(() => {
  stubs.runInSandbox.mockReset();
  stubs.isRunSuperseded.mockReset();
  stubs.isRunSuperseded.mockResolvedValue(false);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('a run a Retry or a Stop superseded', () => {
  it('starts no sandbox once it is superseded', async () => {
    stubs.isRunSuperseded.mockResolvedValue(true);
    const result = await spawn();
    expect(stubs.runInSandbox).not.toHaveBeenCalled();
    expect(result).toMatchObject({ exitCode: null, error: SUPERSEDED_RUN_ERROR });
  });

  it('stops the sandbox it started once it reads superseded', async () => {
    vi.useFakeTimers();
    stubs.isRunSuperseded.mockResolvedValueOnce(false).mockResolvedValue(true);
    stubs.runInSandbox.mockImplementation(
      (input: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          input.signal?.addEventListener('abort', () =>
            resolve({ ...ran, exitCode: null, stdout: '' }),
          );
        }),
    );
    const pending = spawn();
    await vi.advanceTimersByTimeAsync(SUPERSEDED_POLL_MS);
    await expect(pending).resolves.toMatchObject({ exitCode: null, error: SUPERSEDED_RUN_ERROR });
  });

  it('leaves a run nothing superseded alone, and stops reading once it ends', async () => {
    vi.useFakeTimers();
    stubs.runInSandbox.mockResolvedValue(ran);
    await expect(spawn()).resolves.toMatchObject({ exitCode: 0 });
    expect((stubs.runInSandbox.mock.calls[0]![0] as { signal?: AbortSignal }).signal?.aborted).toBe(
      false,
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});
