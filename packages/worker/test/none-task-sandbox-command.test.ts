import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';

const runInSandbox = vi.fn();
const release = vi.fn(async () => undefined);
const acquireAgentLease = vi.fn();
const resolveAppReach = vi.fn();
const resolveSandboxImageTag = vi.fn();

vi.mock('../src/sandbox/npm-cache.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/npm-cache.js')>()),
  ensureNpmCacheVolume: vi.fn(async () => {}),
}));
vi.mock('../src/sandbox/sandbox-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/sandbox-runner.js')>()),
  runInSandbox: (...args: unknown[]) => runInSandbox(...args),
}));
vi.mock('../src/queues/cli-exec/agent-lease.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/queues/cli-exec/agent-lease.js')>()),
  acquireAgentLease: (...args: unknown[]) => acquireAgentLease(...args),
}));
vi.mock('../src/queues/cli-exec/app-reach.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/queues/cli-exec/app-reach.js')>()),
  resolveAppReach: (...args: unknown[]) => resolveAppReach(...args),
}));
vi.mock('../src/queues/cli-exec/agent-pool-cap.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/queues/cli-exec/agent-pool-cap.js')>()),
  currentAgentCap: async () => 3,
  agentPoolCap: async () => 7,
}));
vi.mock('../src/queues/cli-exec-queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/queues/cli-exec-queue.js')>()),
  resolveAuthMounts: async () => [],
  resolveSandboxImageTag: (...args: unknown[]) => resolveSandboxImageTag(...args),
  resolveInvocationRepoMount: async () => ({
    repoMount: { source: 'haive_repos', target: '/haive/workdir', subpath: 'u/r/wt' },
    hasWorktree: true,
    hasRepo: true,
  }),
}));
vi.mock('../src/queues/cli-exec/secret-mask.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/queues/cli-exec/secret-mask.js')>()),
  resolveSecretMasks: async () => [],
}));
vi.mock('../src/queues/cli-exec/gitfile-mask.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/queues/cli-exec/gitfile-mask.js')>()),
  repoGitDataBoundary: async () => ({ mounts: [], masks: [] }),
}));
vi.mock('../src/queues/cli-exec/haive-data-boundary.js', () => ({
  haiveDataBoundary: async () => [],
}));
vi.mock('../src/queues/cli-exec/worktrees-boundary.js', () => ({
  worktreesBoundary: async () => [],
}));

const { runStepCommandInSandbox } = await import('../src/sandbox/step-command.js');
const { realStepContext } = await import('./support/real-step-context.js');

const USER = 'dddddddd-0000-4000-8000-0000000000d1';
const POLICY_A = { mode: 'none', domains: [], ips: [] };
const POLICY_B = { mode: 'allowlist', domains: ['example.com'], ips: [] };
const DEFAULT_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const NEWER_ID = 'bbbbbbbb-0000-4000-8000-000000000002';

const def = {
  id: DEFAULT_ID,
  userId: USER,
  name: 'claude-code',
  enabled: true,
  createdAt: new Date(Date.UTC(2026, 0, 1)),
  networkPolicy: POLICY_A,
};
const newer = {
  id: NEWER_ID,
  userId: USER,
  name: 'codex',
  enabled: true,
  createdAt: new Date(Date.UTC(2026, 0, 9)),
  networkPolicy: POLICY_B,
};

function dbWith(rows: Record<string, unknown>[]): Database {
  const fake = createFakeDb({ cliProviders: schema.cliProviders });
  for (const r of rows) fake.insert(schema.cliProviders, r);
  return fake.db as unknown as Database;
}

beforeEach(() => {
  runInSandbox.mockReset();
  runInSandbox.mockResolvedValue({
    exitCode: 0,
    stdout: 'ok',
    stderr: '',
    durationMs: 1,
    timedOut: false,
  });
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
  resolveSandboxImageTag.mockReset();
  resolveSandboxImageTag.mockResolvedValue('haive-img:test');
});

describe('runStepCommandInSandbox for a task with no CLI of its own', () => {
  it('runs on the default provider: its image, its network policy, a lease', async () => {
    const rows = [newer, def];
    const ctx = await realStepContext({
      cliProviderId: null,
      providers: rows,
      db: dbWith(rows),
      userId: USER,
    });
    const res = await runStepCommandInSandbox(ctx, { argv: ['pnpm', 'test'], timeoutMs: 1000 });
    expect(res).toEqual({ ran: true, exitCode: 0, output: expect.any(String) });
    expect(resolveSandboxImageTag).toHaveBeenCalledTimes(1);
    const provider = resolveSandboxImageTag.mock.calls[0]![2] as { id: string; name: string };
    expect(provider).toMatchObject({ id: DEFAULT_ID, name: 'claude-code' });
    expect(acquireAgentLease).toHaveBeenCalledTimes(1);
    const options = runInSandbox.mock.calls[0]![1] as { networkPolicy?: unknown };
    expect(options.networkPolicy).toEqual(POLICY_A);
  });

  it('reports not run, and takes no lease, when the user has no provider', async () => {
    const ctx = await realStepContext({
      cliProviderId: null,
      providers: [],
      db: dbWith([]),
      userId: USER,
    });
    const res = await runStepCommandInSandbox(ctx, { argv: ['pnpm', 'test'], timeoutMs: 1000 });
    expect(res).toEqual({ ran: false, note: 'not run: no CLI provider, so no sandbox image' });
    expect(acquireAgentLease).not.toHaveBeenCalled();
    expect(runInSandbox).not.toHaveBeenCalled();
  });
});
