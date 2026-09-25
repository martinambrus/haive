import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stubs = vi.hoisted(() => ({
  runInSandbox: vi.fn(),
  isRunSuperseded: vi.fn(async (_id: string) => false),
  started: 0,
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
import type { DockerRunner } from '../src/sandbox/docker-runner.js';

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
  stubs.started = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

/** A runner that starts only once `beforeRun` agrees, as runInSandbox does. */
const startsWhenAllowed =
  (started: () => Promise<unknown>) =>
  async (input: { beforeRun?: () => Promise<boolean> }): Promise<unknown> => {
    if (input.beforeRun && !(await input.beforeRun())) {
      return { ...ran, exitCode: null, durationMs: 0, capturedLog: null };
    }
    stubs.started += 1;
    return started();
  };

describe('a run a Retry or a Stop superseded', () => {
  it('starts no sandbox once it is superseded', async () => {
    stubs.isRunSuperseded.mockResolvedValue(true);
    stubs.runInSandbox.mockImplementation(startsWhenAllowed(async () => ran));
    const result = await spawn();
    expect(stubs.started).toBe(0);
    expect(result).toMatchObject({ exitCode: null, error: SUPERSEDED_RUN_ERROR });
  });

  it('starts no sandbox when it is superseded while the sandbox is being prepared', async () => {
    stubs.runInSandbox.mockImplementation(async (input: { beforeRun?: () => Promise<boolean> }) => {
      // The image, the egress gateway and the mounts are set up here; a Retry lands meanwhile.
      stubs.isRunSuperseded.mockResolvedValue(true);
      return startsWhenAllowed(async () => ran)(input);
    });
    const result = await spawn();
    expect(stubs.started).toBe(0);
    expect(result).toMatchObject({ exitCode: null, error: SUPERSEDED_RUN_ERROR });
  });

  it('stops the sandbox it started once it reads superseded', async () => {
    vi.useFakeTimers();
    stubs.isRunSuperseded.mockResolvedValueOnce(false).mockResolvedValue(true);
    stubs.runInSandbox.mockImplementation(
      (input: { signal?: AbortSignal; beforeRun?: () => Promise<boolean> }) =>
        startsWhenAllowed(
          () =>
            new Promise((resolve) => {
              input.signal?.addEventListener('abort', () => resolve({ ...ran, exitCode: null }));
            }),
        )(input),
    );
    const pending = spawn();
    await vi.advanceTimersByTimeAsync(SUPERSEDED_POLL_MS);
    await expect(pending).resolves.toMatchObject({ exitCode: null, error: SUPERSEDED_RUN_ERROR });
  });

  it('reads the run again as soon as its sandbox first speaks', async () => {
    vi.useFakeTimers();
    stubs.isRunSuperseded.mockResolvedValueOnce(false).mockResolvedValue(true);
    stubs.runInSandbox.mockImplementation(
      (input: {
        signal?: AbortSignal;
        beforeRun?: () => Promise<boolean>;
        onStdoutChunk?: (chunk: string) => void;
      }) =>
        startsWhenAllowed(
          () =>
            new Promise((resolve) => {
              input.signal?.addEventListener('abort', () => resolve({ ...ran, exitCode: null }));
              input.onStdoutChunk?.('{"type":"system","subtype":"init"}\n');
            }),
        )(input),
    );
    // No timer is advanced: the first line of output is what reads the run again.
    await expect(spawn()).resolves.toMatchObject({ exitCode: null, error: SUPERSEDED_RUN_ERROR });
    expect(stubs.started).toBe(1);
  });

  it('leaves a run nothing superseded alone, and stops reading once it ends', async () => {
    vi.useFakeTimers();
    stubs.runInSandbox.mockImplementation(startsWhenAllowed(async () => ran));
    await expect(spawn()).resolves.toMatchObject({ exitCode: 0 });
    expect((stubs.runInSandbox.mock.calls[0]![0] as { signal?: AbortSignal }).signal?.aborted).toBe(
      false,
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('runInSandbox', () => {
  it('creates no container when it is told not to', async () => {
    const { runInSandbox } = await vi.importActual<
      typeof import('../src/sandbox/sandbox-runner.js')
    >('../src/sandbox/sandbox-runner.js');
    const run = vi.fn();
    const result = await runInSandbox(
      { command: 'claude', args: [], beforeRun: async () => false },
      { image: 'haive-test-image', docker: { run } as unknown as DockerRunner },
    );
    expect(run).not.toHaveBeenCalled();
    expect(result).toMatchObject({ exitCode: null, stdout: '', stderr: '' });
  });
});
