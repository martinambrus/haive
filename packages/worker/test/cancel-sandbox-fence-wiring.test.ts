import { beforeEach, describe, expect, it, vi } from 'vitest';

const stubs = vi.hoisted(() => ({
  runInSandbox: vi.fn(),
  createUnlessSuperseded: vi.fn(),
}));
vi.mock('../src/sandbox/sandbox-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/sandbox-runner.js')>()),
  runInSandbox: stubs.runInSandbox,
}));
vi.mock('../src/sandbox/cli-sandbox-fence.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/cli-sandbox-fence.js')>()),
  createUnlessSuperseded: stubs.createUnlessSuperseded,
}));
vi.mock('../src/db.js', () => ({ getDb: () => ({ marker: 'db' }) }));
vi.mock('../src/queues/cli-exec/run-superseded.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/queues/cli-exec/run-superseded.js')>();
  return {
    ...actual,
    watchSupersededRun: (id: string) => actual.watchSupersededRun(id, async () => false),
  };
});
vi.mock('../src/queues/cli-exec/preempt-mark.js', () => ({
  markPreempted: async () => {},
  consumePreemptionMark: async () => false,
}));

import { createSandboxSpawner } from '../src/queues/cli-exec/exec-core.js';
import { SANDBOX_WORKDIR } from '../src/sandbox/sandbox-runner.js';
import type { CliCommandSpec } from '../src/cli-adapters/types.js';
import type { DockerRunner } from '../src/sandbox/docker-runner.js';

const spec = { command: 'claude', args: ['-p'], env: {} } as unknown as CliCommandSpec;
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
  stubs.runInSandbox.mockReset().mockResolvedValue(ran);
  stubs.createUnlessSuperseded.mockReset();
});

describe('the CLI run creates its container through the task fence', () => {
  it('hands the sandbox runner a fence that is createUnlessSuperseded for this task and run', async () => {
    await createSandboxSpawner(
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
    const input = stubs.runInSandbox.mock.calls[0]![0] as {
      createFence?: (create: () => Promise<unknown>) => Promise<unknown>;
    };
    expect(input.createFence).toBeTypeOf('function');
    const create = async () => 'container';
    stubs.createUnlessSuperseded.mockResolvedValue('container');
    await input.createFence!(create);
    expect(stubs.createUnlessSuperseded).toHaveBeenCalledWith(
      { marker: 'db' },
      { taskId: 'task-1', invocationId: 'run-1' },
      create,
    );
  });

  it('passes the fence on to the docker runner as the guard of its container create', async () => {
    const { runInSandbox } = await vi.importActual<
      typeof import('../src/sandbox/sandbox-runner.js')
    >('../src/sandbox/sandbox-runner.js');
    const run = vi.fn().mockResolvedValue({ ...ran, stdout: '' });
    const createFence = vi.fn();
    await runInSandbox(
      { command: 'claude', args: [], createFence },
      { image: 'haive-test-image', docker: { run } as unknown as DockerRunner },
    );
    expect(run.mock.calls[0]![0]).toMatchObject({ guardCreate: expect.any(Function) });
  });
});
