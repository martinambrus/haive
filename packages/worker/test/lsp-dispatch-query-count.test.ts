import { expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { configService } from '@haive/shared';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';

// All other dispatch consumers are independent of this query-count control.
vi.mock('../src/repo/committed-snapshot.js', async (original) => ({
  ...(await original<object>()),
  resolveTaskCommittedSnapshots: async () => null,
}));
vi.mock('../src/repo/worktree-git-boundary.js', async (original) => ({
  ...(await original<object>()),
  resolveInvocationUsesWorktreeGitBoundary: async () => false,
  taskHasRepository: async () => false,
  resolveInvocationWorkerTree: async () => null,
}));
vi.mock('../src/orchestrator/global-kb-context.js', () => ({
  resolveGlobalKbContext: async () => ({
    digest: { entries: [], omitted: 0, scanSaturated: false },
  }),
}));
vi.mock('../src/queues/cli-exec/app-reach.js', async (original) => ({
  ...(await original<object>()),
  resolveAppReach: async () => ({ mode: 'none', url: null, reason: 'no-app' }),
}));
vi.mock('../src/orchestrator/sandbox-toolchain.js', () => ({
  resolveDispatchSandboxToolchain: async () => ({}),
}));
vi.mock('../src/orchestrator/agent-isolation.js', async (original) => ({
  ...(await original<object>()),
  resolveAgentIsolationEnabled: async () => false,
}));
vi.mock('../src/orchestrator/agent-rules.js', async (original) => ({
  ...(await original<object>()),
  resolveAgentRulesInjectionEnabled: async () => false,
}));
import { resolveTaskDispatch } from '../src/orchestrator/dispatcher.js';

it.each([undefined, 1])(
  'legacy contract %s evaluates readiness once for the entire provider list (four queries)',
  async (contract) => {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    const task = vi.fn(async () => ({ envTemplateId: 'e', repositoryId: null }));
    const env = vi.fn(async () => ({
      status: 'ready',
      generatedDockerfile: 'FROM ubuntu:24.04',
      lastBuiltAt: new Date(0),
      declaredDeps: { lspInstallContractVersion: contract, lspServers: ['go'] },
    }));
    const step = vi.fn(async (opts: { columns?: { endedAt?: boolean } }) =>
      opts.columns?.endedAt
        ? {
            status: 'done',
            endedAt: new Date(100),
            output: { envTemplateId: 'e', reports: [{ id: 'lsp-gopls', passed: true }] },
          }
        : { status: 'done', output: { skipped: false } },
    );
    const db = {
      query: {
        tasks: { findFirst: task },
        envTemplates: { findFirst: env },
        taskSteps: { findFirst: step },
      },
    } as unknown as Database;
    const provider = {
      id: 'p',
      userId: 'u',
      name: 'claude-code',
      enabled: true,
      cliVersion: '1.0.0',
      cliArgs: null,
      envVars: null,
      createdAt: new Date(0),
      rulesContent: '',
    } as CliProviderRecord;
    const providers = [
      provider,
      { ...provider, id: 'p2' },
      { ...provider, id: 'p3', name: 'codex' as const, enabled: false },
    ];
    const plan = await resolveTaskDispatch(db, 't', {
      providers,
      input: { kind: 'prompt', prompt: 'work', capabilities: [] },
      invokeOpts: {},
      toolProfile: 'none',
    });
    expect(plan.invocation?.kind).toBe('cli');
    expect([task.mock.calls.length, env.mock.calls.length, step.mock.calls.length]).toEqual([
      1, 1, 2,
    ]);
    vi.restoreAllMocks();
  },
);
