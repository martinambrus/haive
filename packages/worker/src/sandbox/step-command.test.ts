import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskCancelledError, type StepContext } from '../step-engine/step-definition.js';

const runInSandbox = vi.fn();
const release = vi.fn(async () => undefined);
const acquireAgentLease = vi.fn();
const resolveAppReach = vi.fn();

vi.mock('./npm-cache.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./npm-cache.js')>()),
  ensureNpmCacheVolume: vi.fn(async () => {}),
}));
vi.mock('./sandbox-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sandbox-runner.js')>()),
  runInSandbox: (...args: unknown[]) => runInSandbox(...args),
}));
vi.mock('../queues/cli-exec/agent-lease.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../queues/cli-exec/agent-lease.js')>()),
  acquireAgentLease: (...args: unknown[]) => acquireAgentLease(...args),
}));
vi.mock('../queues/cli-exec/app-reach.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../queues/cli-exec/app-reach.js')>()),
  resolveAppReach: (...args: unknown[]) => resolveAppReach(...args),
}));
vi.mock('../queues/cli-exec/agent-pool-cap.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../queues/cli-exec/agent-pool-cap.js')>()),
  currentAgentCap: async () => 3,
  agentPoolCap: async () => 7,
}));
vi.mock('../queues/cli-exec-queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../queues/cli-exec-queue.js')>()),
  resolveAuthMounts: async () => [
    { source: 'auth-vol', target: '/home/node/.claude', kind: 'auth' },
  ],
  resolveSandboxImageTag: async () => 'haive-img:test',
  resolveInvocationRepoMount: async () => ({
    repoMount: { source: 'haive_repos', target: '/haive/workdir', subpath: 'u/r/wt' },
    hasWorktree: true,
    hasRepo: true,
  }),
}));
vi.mock('../queues/cli-exec/secret-mask.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../queues/cli-exec/secret-mask.js')>()),
  resolveSecretMasks: async () => [{ containerPath: '/haive/workdir/.env', content: '' }],
}));
vi.mock('../queues/cli-exec/gitfile-mask.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../queues/cli-exec/gitfile-mask.js')>()),
  repoGitDataBoundary: async () => ({
    mounts: [{ source: '/tmp/gitdata', target: '/haive/workdir/.git', readOnly: true }],
    masks: [{ containerPath: '/haive/workdir/.git/config', content: '' }],
  }),
}));

const { runStepCommandInSandbox, BINARY_MISSING_EXIT } = await import('./step-command.js');
const { AgentLeaseAbortedError, AgentLeaseTimeoutError } =
  await import('../queues/cli-exec/agent-lease.js');

function ctx(over: Partial<StepContext> = {}): StepContext {
  return {
    db: {
      query: {
        cliProviders: {
          findFirst: async () => ({
            id: 'p1',
            name: 'claude-code',
            envVars: { ANTHROPIC_API_KEY: 'sk-secret' },
            networkPolicy: { mode: 'none' },
            wrapperContent: '#!/bin/sh',
          }),
        },
      },
    },
    taskId: 'task-1',
    cliProviderId: 'p1',
    signal: new AbortController().signal,
    ...over,
  } as unknown as StepContext;
}

function ran(exitCode: number | null, stdout = '', stderr = '') {
  runInSandbox.mockResolvedValue({ exitCode, stdout, stderr, durationMs: 1, timedOut: false });
}

beforeEach(() => {
  runInSandbox.mockReset();
  release.mockClear();
  acquireAgentLease.mockReset();
  acquireAgentLease.mockResolvedValue({ id: 'lease-1', release });
  resolveAppReach.mockReset();
  resolveAppReach.mockResolvedValue({
    mode: 'none',
    url: null,
    addHosts: [],
    mounts: [],
    env: {},
    noProxyHosts: [],
    tlsTrusted: false,
  });
});

describe('runStepCommandInSandbox', () => {
  it('sizes its lease by the published pool cap, not a fresh read', async () => {
    ran(0);
    await runStepCommandInSandbox(ctx(), { argv: ['pnpm', 'test'], timeoutMs: 1 });
    const deps = acquireAgentLease.mock.calls[0]![0] as { agentCap: () => Promise<number> };
    expect(await deps.agentCap()).toBe(7);
  });

  it('starts the loopback forwarder, with host and port quoted, only when the reach asks for it', async () => {
    ran(0);
    await runStepCommandInSandbox(ctx(), { argv: ['pnpm', 'test'], timeoutMs: 1 });
    const plain = runInSandbox.mock.calls[0]![0] as {
      args: string[];
      extraFiles: { containerPath: string }[];
    };
    expect(plain.args[1]).not.toContain('loopback-forward');
    expect(plain.extraFiles.map((f) => f.containerPath)).toEqual([
      '/haive/workdir/.env',
      '/haive/workdir/.git/config',
    ]);

    resolveAppReach.mockResolvedValue({
      mode: 'sandbox_http',
      url: 'http://app:3000',
      addHosts: [],
      mounts: [],
      env: {},
      noProxyHosts: [],
      tlsTrusted: false,
      loopbackForward: { port: 3000, host: "app'; touch /pwned #" },
    });
    runInSandbox.mockClear();
    ran(0);
    await runStepCommandInSandbox(ctx(), { argv: ['pnpm', 'test'], timeoutMs: 1 });
    const fwd = runInSandbox.mock.calls[0]![0] as {
      args: string[];
      extraFiles: { containerPath: string; content: string }[];
    };
    const script = fwd.extraFiles.find((f) => f.containerPath.includes('loopback-forward'));
    expect(script?.content).toContain("'127.0.0.1'");
    expect(script?.content).toContain("'::1'");
    const [, shellText, , ...argv] = fwd.args;
    expect(shellText).toContain(`'3000' 'app'\\''; touch /pwned #'`);
    expect(shellText).toContain('command -v node');
    expect(argv).toEqual(['pnpm', 'test']);
    expect(shellText!.indexOf('loopback-forward')).toBeLessThan(
      shellText!.indexOf('step-bin-missing'),
    );
  });

  it('reports not run when the task has no CLI provider, and takes no lease', async () => {
    const res = await runStepCommandInSandbox(ctx({ cliProviderId: null }), {
      argv: ['pnpm', 'test'],
      timeoutMs: 1000,
    });
    expect(res).toEqual({ ran: false, note: 'not run: no CLI provider, so no sandbox image' });
    expect(acquireAgentLease).not.toHaveBeenCalled();
    expect(runInSandbox).not.toHaveBeenCalled();
  });

  it('maps the Haive sentinel to not run, naming the binary', async () => {
    runInSandbox.mockImplementation(async (spec: { args: string[] }) => {
      const marker = /step-bin-missing-[0-9a-f]{16}/.exec(spec.args[1] ?? '')?.[0];
      return {
        exitCode: BINARY_MISSING_EXIT,
        stdout: `${marker}\n`,
        stderr: '',
        durationMs: 1,
        timedOut: false,
      };
    });
    const res = await runStepCommandInSandbox(ctx(), {
      argv: ['vendor/bin/phpunit'],
      timeoutMs: 1,
    });
    expect(res).toEqual({
      ran: false,
      note: 'not run: vendor/bin/phpunit is not in the sandbox image',
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("leaves the command's own exit 199 as a run", async () => {
    ran(BINARY_MISSING_EXIT, 'my own failure\n');
    const res = await runStepCommandInSandbox(ctx(), { argv: ['pnpm', 'test'], timeoutMs: 1 });
    expect(res).toEqual({ ran: true, exitCode: 199, output: 'my own failure\n' });
  });

  it("does not accept another run's marker", async () => {
    ran(BINARY_MISSING_EXIT, 'step-bin-missing-0000000000000000\n');
    const res = await runStepCommandInSandbox(ctx(), { argv: ['pnpm', 'test'], timeoutMs: 1 });
    expect(res).toMatchObject({ ran: true, exitCode: 199 });
  });

  it('draws a fresh marker for every run', async () => {
    ran(0);
    await runStepCommandInSandbox(ctx(), { argv: ['pnpm'], timeoutMs: 1 });
    await runStepCommandInSandbox(ctx(), { argv: ['pnpm'], timeoutMs: 1 });
    const markers = runInSandbox.mock.calls.map(
      (c) => /step-bin-missing-[0-9a-f]{16}/.exec(c[0].args[1])?.[0],
    );
    expect(markers[0]).toBeDefined();
    expect(markers[0]).not.toBe(markers[1]);
  });

  it("leaves the command's own exit 127 as a run", async () => {
    ran(127, 'sh: foo: not found\n');
    const res = await runStepCommandInSandbox(ctx(), { argv: ['pnpm', 'test'], timeoutMs: 1 });
    expect(res).toEqual({ ran: true, exitCode: 127, output: 'sh: foo: not found\n' });
  });

  it('returns the exit code and both streams', async () => {
    ran(1, 'out', 'err');
    expect(await runStepCommandInSandbox(ctx(), { argv: ['pnpm', 'test'], timeoutMs: 1 })).toEqual({
      ran: true,
      exitCode: 1,
      output: 'outerr',
    });
  });

  it('passes the argv as separate words behind the preamble', async () => {
    ran(0);
    await runStepCommandInSandbox(ctx(), {
      argv: ['npx', 'vitest', 'run', 'a b; rm -rf /'],
      timeoutMs: 1,
    });
    const spec = runInSandbox.mock.calls[0]![0];
    expect(spec.command).toBe('sh');
    expect(spec.args.slice(0, 2)).toEqual([
      '-c',
      expect.stringContaining(`exit ${BINARY_MISSING_EXIT}`),
    ]);
    expect(spec.args.slice(2)).toEqual(['sh', 'npx', 'vitest', 'run', 'a b; rm -rf /']);
    expect(spec.args[1]).not.toContain('vitest');
  });

  it('carries no auth mount and no provider env, but the task and lease labels', async () => {
    ran(0);
    await runStepCommandInSandbox(ctx(), { argv: ['pnpm', 'test'], cwdRel: 'web', timeoutMs: 1 });
    const [spec, options] = runInSandbox.mock.calls[0]!;
    expect(spec.env).toEqual({ npm_config_cache: '/haive-npm-cache' });
    expect(spec.wrapperContent).toBeUndefined();
    expect(options.extraMounts.some((m: { kind?: string }) => m.kind === 'auth')).toBe(false);
    expect(options.extraMounts.map((m: { target: string }) => m.target)).toEqual([
      '/haive/workdir/.git',
      '/haive/workdir',
      '/haive-npm-cache',
    ]);
    expect(options.addHosts).toBeUndefined();
    expect(options.noProxyHosts).toBeUndefined();
    expect(spec.extraFiles).toHaveLength(2);
    expect(options.taskId).toBe('task-1');
    expect(options.invocationId).toBe('lease:lease-1');
    expect(options.workdir).toBe('/haive/workdir/web');
    expect(options.image).toBe('haive-img:test');
    expect(options.networkPolicy).toEqual({ mode: 'none' });
  });

  it('refuses a cwdRel that leaves the worktree', async () => {
    await expect(
      runStepCommandInSandbox(ctx(), { argv: ['pnpm'], cwdRel: '../x', timeoutMs: 1 }),
    ).rejects.toThrow('leaves the worktree');
    expect(acquireAgentLease).not.toHaveBeenCalled();
  });

  it('releases the lease after a thrown docker error', async () => {
    runInSandbox.mockRejectedValue(new Error('docker daemon gone'));
    await expect(
      runStepCommandInSandbox(ctx(), { argv: ['pnpm', 'test'], timeoutMs: 1 }),
    ).rejects.toThrow('docker daemon gone');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('reports not run when no agent slot frees in time', async () => {
    acquireAgentLease.mockRejectedValue(new AgentLeaseTimeoutError(600_000));
    const res = await runStepCommandInSandbox(ctx(), { argv: ['pnpm', 'test'], timeoutMs: 1 });
    expect(res).toEqual({ ran: false, note: 'not run: no agent slot became free within 600s' });
    expect(runInSandbox).not.toHaveBeenCalled();
  });

  it('turns a Stop during the wait into a task cancellation', async () => {
    acquireAgentLease.mockRejectedValue(new AgentLeaseAbortedError());
    await expect(
      runStepCommandInSandbox(ctx(), { argv: ['pnpm', 'test'], timeoutMs: 1 }),
    ).rejects.toBeInstanceOf(TaskCancelledError);
    expect(runInSandbox).not.toHaveBeenCalled();
  });

  it('hands the wait callback and the abort signal to the lease', async () => {
    ran(0);
    const onWait = vi.fn();
    const signal = new AbortController().signal;
    await runStepCommandInSandbox(ctx({ signal }), { argv: ['pnpm'], timeoutMs: 1, onWait });
    expect(acquireAgentLease.mock.calls[0]![1]).toEqual({ signal, onWait });
  });

  it("gives the sandbox the task's app reach as an agent gets it", async () => {
    ran(0);
    resolveAppReach.mockResolvedValue({
      mode: 'sandbox_http',
      url: 'http://app-runner-task-1:3000',
      addHosts: ['app.ddev.site:172.20.0.5'],
      mounts: [{ source: 'ca-vol', subpath: 'rootCA.pem', target: '/etc/ssl/certs/ca.pem' }],
      env: { NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/ca.pem' },
      noProxyHosts: ['app.ddev.site'],
      tlsTrusted: true,
    });
    await runStepCommandInSandbox(ctx(), { argv: ['npx', 'playwright', 'test'], timeoutMs: 1 });
    const [spec, options] = runInSandbox.mock.calls[0]!;
    expect(resolveAppReach.mock.calls[0]![1]).toBe('task-1');
    expect(options.extraMounts.map((m: { target: string }) => m.target)).toEqual([
      '/haive/workdir/.git',
      '/haive/workdir',
      '/etc/ssl/certs/ca.pem',
      '/haive-npm-cache',
    ]);
    expect(options.addHosts).toEqual(['app.ddev.site:172.20.0.5']);
    expect(options.noProxyHosts).toEqual(['app.ddev.site']);
    expect(spec.env).toEqual({
      npm_config_cache: '/haive-npm-cache',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/ca.pem',
    });
  });

  it('turns a Stop during the run into a task cancellation, whatever the exit status', async () => {
    const controller = new AbortController();
    runInSandbox.mockImplementation(async () => {
      controller.abort();
      return { exitCode: null, stdout: '', stderr: '', durationMs: 1, timedOut: false };
    });
    await expect(
      runStepCommandInSandbox(ctx({ signal: controller.signal }), {
        argv: ['pnpm', 'test'],
        timeoutMs: 1,
      }),
    ).rejects.toBeInstanceOf(TaskCancelledError);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('keeps a null exit without a Stop as a failed run, with a note', async () => {
    runInSandbox.mockResolvedValue({
      exitCode: null,
      stdout: 'partial\n',
      stderr: '',
      durationMs: 1,
      timedOut: false,
      error: 'spawn docker ENOENT',
    });
    const res = await runStepCommandInSandbox(ctx(), { argv: ['pnpm', 'test'], timeoutMs: 1 });
    expect(res).toMatchObject({ ran: true, exitCode: 1 });
    expect(res.ran && res.output).toContain('partial');
    expect(res.ran && res.output).toContain('ended without an exit status');
    expect(res.ran && res.output).toContain('spawn docker ENOENT');
  });

  it('keeps a timeout as a failed run, noting the timeout', async () => {
    runInSandbox.mockResolvedValue({
      exitCode: null,
      stdout: '',
      stderr: '',
      durationMs: 5000,
      timedOut: true,
    });
    const res = await runStepCommandInSandbox(ctx(), { argv: ['pnpm', 'test'], timeoutMs: 5000 });
    expect(res).toMatchObject({ ran: true, exitCode: 1 });
    expect(res.ran && res.output).toContain('timed out after 5s');
  });
});
