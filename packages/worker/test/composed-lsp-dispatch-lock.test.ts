import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { configService } from '@haive/shared';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';

const snapshotMock = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('../src/repo/committed-snapshot.js', async (original) => ({
  ...(await original<object>()),
  resolveTaskCommittedSnapshots: async () => snapshotMock.value,
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
import {
  resolveDispatch,
  resolveTaskDispatch,
  type DispatchInput,
} from '../src/orchestrator/dispatcher.js';

function provider(id: string, name: string, createdAt: number): CliProviderRecord {
  return {
    id,
    userId: 'u',
    name,
    label: name,
    executablePath: null,
    wrapperPath: null,
    envVars: null,
    cliArgs: null,
    cliVersion: '1.0.0',
    rulesContent: '',
    supportsSubagents: false,
    authMode: 'subscription',
    enabled: true,
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
  } as unknown as CliProviderRecord;
}

const B = provider('prov-b', 'codex', 1);
const A = provider('prov-a', 'claude-code', 2);
const C = provider('prov-c', 'gemini', 3);
const prompt: DispatchInput = { kind: 'prompt', prompt: 'work', capabilities: [] };
const base = { providers: [A, B], input: prompt, invokeOpts: {} };

afterEach(() => {
  vi.restoreAllMocks();
  snapshotMock.value = null;
});

describe('resolveDispatch with a composed LSP provider set', () => {
  it('refuses a preferred provider outside the set', () => {
    const plan = resolveDispatch({
      ...base,
      preferredProviderId: B.id,
      composedLspProviderIds: [A.id],
    });
    expect(plan.mode).toBe('skip');
    expect(plan.providerId).toBeNull();
  });

  it('keeps a preferred provider inside the set', () => {
    const plan = resolveDispatch({
      ...base,
      preferredProviderId: A.id,
      composedLspProviderIds: [A.id],
    });
    expect(plan.mode).toBe('cli');
    expect(plan.providerId).toBe(A.id);
  });

  it('floats only inside the set when nothing is preferred', () => {
    const plan = resolveDispatch({
      ...base,
      preferredProviderId: null,
      composedLspProviderIds: [A.id],
    });
    expect(plan.providerId).toBe(A.id);
  });

  it('does not fall through to a provider outside the set on a capability gap', () => {
    const AMP = provider('prov-amp', 'amp', 2);
    const CLAUDE = provider('prov-claude', 'claude-code', 1);
    const req = {
      providers: [AMP, CLAUDE],
      preferredProviderId: AMP.id,
      requiresMcp: true,
      input: prompt,
      invokeOpts: {},
    };
    expect(resolveDispatch(req).providerId).toBe(CLAUDE.id);
    const locked = resolveDispatch({ ...req, composedLspProviderIds: [AMP.id] });
    expect(locked.mode).toBe('skip');
    expect(locked.providerId).toBeNull();
  });

  it.each([A.id, null])(
    'before any image is effective, launches only the verified provider (preferred %s)',
    (preferred) => {
      const plan = resolveDispatch({
        ...base,
        providers: [A, B, C],
        preferredProviderId: preferred,
        composedLspProviderIds: [],
      });
      expect(plan.mode).toBe('cli');
      expect(plan.providerId).toBe(A.id);
    },
  );

  it('before any image is effective, refuses an unverified preferred provider', () => {
    const plan = resolveDispatch({
      ...base,
      preferredProviderId: B.id,
      composedLspProviderIds: [],
    });
    expect(plan.mode).toBe('skip');
    expect(plan.providerId).toBeNull();
  });

  it('before any image is effective, skips when no verified provider exists', () => {
    const plan = resolveDispatch({
      ...base,
      providers: [B, C],
      preferredProviderId: null,
      composedLspProviderIds: [],
    });
    expect(plan.mode).toBe('skip');
    expect(plan.providerId).toBeNull();
  });

  it.each([null, undefined])('a %s set leaves the plan unchanged', (set) => {
    const plan = resolveDispatch({
      ...base,
      preferredProviderId: B.id,
      composedLspProviderIds: set,
    });
    expect(plan.providerId).toBe(B.id);
  });
});

const ref = (tag: string) => ({
  tag,
  imageId: `sha256:${tag}`,
  identityHash: `id-${tag}`,
  inputs: { rtkVersion: '1', baseImageId: null, rtkPin: null, requestedHash: `h-${tag}` },
});

function fakeDb(contract: number | undefined, metadata: unknown) {
  const task = vi.fn(async () => ({ envTemplateId: 'e', repositoryId: null, metadata }));
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
  return { db, task, env, step };
}

const dispatch = (db: Database, preferredProviderId: string | null) =>
  resolveTaskDispatch(db, 't', {
    providers: [A, B, C],
    preferredProviderId,
    input: prompt,
    invokeOpts: {},
    toolProfile: 'none',
  });

const refs = {
  composedLspImageRefs: {
    schemaVersion: 1,
    entries: [
      { providerId: A.id, effective: ref('a') },
      { providerId: C.id, verifying: ref('c') },
    ],
  },
};

describe('resolveTaskDispatch on a contract 2 task', () => {
  it('lets only a provider with an effective ref dispatch', async () => {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    const { db } = fakeDb(2, refs);
    expect((await dispatch(db, B.id)).mode).toBe('skip');
    expect((await dispatch(db, C.id)).mode).toBe('skip');
    const plan = await dispatch(db, A.id);
    expect(plan.mode).toBe('cli');
    expect(plan.providerId).toBe(A.id);
  });

  it('before the first image, launches only the verified provider', async () => {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    const { db } = fakeDb(2, {});
    expect((await dispatch(db, B.id)).mode).toBe('skip');
    for (const id of [A.id, null]) {
      const plan = await dispatch(db, id);
      expect(plan.mode).toBe('cli');
      expect(plan.providerId).toBe(A.id);
    }
  });

  it('adds no template read to the per-provider composed readiness reads', async () => {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    const { db, env } = fakeDb(2, refs);
    await dispatch(db, A.id);
    expect(env.mock.calls.length).toBe(2);
  });

  it('refuses on the snapshot path too', async () => {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    snapshotMock.value = { target: { workerRoot: '/snapshot', tracked: [] }, base: null };
    const locked = fakeDb(2, refs);
    expect((await dispatch(locked.db, B.id)).mode).toBe('skip');
    const legacy = fakeDb(1, {});
    const plan = await dispatch(legacy.db, B.id);
    expect(plan.mode).toBe('cli');
    expect(plan.providerId).toBe(B.id);
  });
});

describe('legacy contracts dispatch as before', () => {
  it.each([undefined, 1])('contract %s keeps the query counts', async (contract) => {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    const { db, task, env, step } = fakeDb(contract, {});
    const plan = await dispatch(db, B.id);
    expect(plan.providerId).toBe(B.id);
    expect([task.mock.calls.length, env.mock.calls.length, step.mock.calls.length]).toEqual([
      1, 1, 2,
    ]);
  });
});
