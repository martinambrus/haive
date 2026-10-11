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
  });

  it('starts it in front of the CLI, which still gets its own argv', async () => {
    await run(null, reach({ port: 3000, host: "app'; x" }));
    const c = call();
    expect(c.command).toBe('sh');
    const [flag, text, name, ...rest] = c.args;
    expect(flag).toBe('-c');
    expect(name).toBe('sh');
    expect(text).toContain(`'3000' 'app'\\''; x'`);
    expect(text).toMatch(/exec "\$@"$/);
    expect(rest).toEqual(['claude', '-p', 'x y']);
    expect(c.extraFiles?.map((f) => f.containerPath).join()).toContain('loopback-forward');
  });

  it('puts it inside the provider wrapper, after the shebang, when there is one', async () => {
    await run('#!/bin/bash\nexec claude "$@"', reach({ port: 3000, host: 'app' }));
    const c = call();
    expect(c.command).toBe('claude');
    expect(c.args).toEqual(['-p', 'x y']);
    expect(c.wrapperContent?.startsWith('#!/bin/bash\n')).toBe(true);
    expect(c.wrapperContent?.indexOf('loopback-forward')).toBeGreaterThan(0);
    expect(c.wrapperContent?.indexOf('loopback-forward')).toBeLessThan(
      c.wrapperContent!.indexOf('exec claude'),
    );
    expect(c.extraFiles?.map((f) => f.containerPath).join()).toContain('loopback-forward');
  });
});
