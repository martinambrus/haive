import { beforeEach, describe, expect, it, vi } from 'vitest';

const stubs = vi.hoisted(() => ({ runInSandbox: vi.fn() }));
vi.mock('../src/sandbox/sandbox-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/sandbox-runner.js')>()),
  runInSandbox: stubs.runInSandbox,
}));

import { createSandboxSpawner } from '../src/queues/cli-exec/exec-core.js';
import { SANDBOX_WORKDIR } from '../src/sandbox/sandbox-runner.js';
import type { AppReach } from '../src/queues/cli-exec/app-reach.js';
import type { CliCommandSpec } from '../src/cli-adapters/types.js';
import type { DockerRunner } from '../src/sandbox/docker-runner.js';

const spec = { command: 'claude', args: ['-p', 'x y'], env: {} } as unknown as CliCommandSpec;
const reach = (loopbackForward: AppReach['loopbackForward']): AppReach => ({
  mode: 'sandbox_http',
  url: 'http://app:3000',
  addHosts: [],
  mounts: [],
  env: {},
  noProxyHosts: [],
  tlsTrusted: false,
  loopbackForward,
});
const run = (wrapper: string | null, appReach: AppReach | null) =>
  createSandboxSpawner(
    wrapper,
    null,
    null,
    SANDBOX_WORKDIR,
    null,
    [],
    [],
    [],
    'task-1',
    'run-1',
    [],
    appReach,
  )(spec);

type Call = {
  command: string;
  args: string[];
  wrapperContent?: string;
  prelude?: string;
  extraFiles?: { containerPath: string }[];
};
const call = (): Call => stubs.runInSandbox.mock.calls[0]![0] as Call;

beforeEach(() => {
  stubs.runInSandbox.mockReset();
  stubs.runInSandbox.mockResolvedValue({
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 1,
    timedOut: false,
    resolvedCommand: 'claude',
    wrapperId: null,
  });
});

describe('the agent sandbox loopback forwarder', () => {
  it('leaves the run alone when the reach has no loopbackForward', async () => {
    await run(null, reach(null));
    expect(call().command).toBe('claude');
    expect(call().args).toEqual(['-p', 'x y']);
    expect(call().extraFiles).toBeUndefined();
    expect(call().prelude).toBeUndefined();
  });

  it('starts it as a prelude and leaves the command and its argv alone', async () => {
    await run(null, reach({ port: 3000, host: "app'; x" }));
    const c = call();
    expect(c.command).toBe('claude');
    expect(c.args).toEqual(['-p', 'x y']);
    expect(c.prelude).toContain(`'3000' 'app'\\''; x'`);
    expect(c.extraFiles?.map((f) => f.containerPath).join()).toContain('loopback-forward');
  });

  it('leaves a provider wrapper byte for byte, whatever its interpreter', async () => {
    const wrapper =
      '#!/usr/bin/env python3\nimport os, sys\nos.execvp("claude", ["claude", *sys.argv[1:]])';
    await run(wrapper, reach({ port: 3000, host: 'app' }));
    const c = call();
    expect(c.wrapperContent).toBe(wrapper);
    expect(c.prelude).toContain('loopback-forward');
  });
});

describe('runInSandbox with a prelude', () => {
  const cmdOf = async (prelude?: string): Promise<string[]> => {
    const { runInSandbox } = await vi.importActual<
      typeof import('../src/sandbox/sandbox-runner.js')
    >('../src/sandbox/sandbox-runner.js');
    const run = vi.fn(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 1,
      timedOut: false,
    }));
    await runInSandbox(
      { command: 'claude', args: ['-p', 'x y'], ...(prelude ? { prelude } : {}) },
      { image: 'test-image', docker: { run } as unknown as DockerRunner },
    );
    return (run.mock.calls[0] as unknown as [{ cmd: string[] }])[0].cmd;
  };

  it('runs the command unchanged without one', async () => {
    expect(await cmdOf()).toEqual(['claude', '-p', 'x y']);
  });

  it('runs the prelude in an outer sh that then execs the command with its argv', async () => {
    expect(await cmdOf('start; ')).toEqual([
      'sh',
      '-c',
      'start; exec "$@"',
      'sh',
      'claude',
      '-p',
      'x y',
    ]);
  });
});
