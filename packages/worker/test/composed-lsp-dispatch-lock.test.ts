import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
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
import { ProviderBuildError } from '../src/cli-adapters/prompt-delivery.js';
import { resolvePreferredCli } from '../src/step-engine/step-runner.js';

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

const B = provider(randomUUID(), 'codex', 1);
const A = provider(randomUUID(), 'claude-code', 2);
const C = provider(randomUUID(), 'gemini', 3);
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

describe('a saved CLI the composed-LSP lock refuses', () => {
  const userId = randomUUID();
  const taskId = randomUUID();
  const stepId = '07-phase-2-implement';
  const PROVIDERS = [A, B, C];

  function savedAndChosen(opts: {
    saved?: { role: string; provider: CliProviderRecord; effort?: string };
    choice?: { role: string; provider: CliProviderRecord };
  }): Database {
    const fake = createFakeDb({
      taskStepCliChoices: schema.taskStepCliChoices,
      taskStepCliTouched: schema.taskStepCliTouched,
      userStepCliRolePreferences: schema.userStepCliRolePreferences,
      userStepCliPreferences: schema.userStepCliPreferences,
    });
    if (opts.saved && opts.saved.role === 'default') {
      fake.insert(schema.userStepCliPreferences, {
        userId,
        stepId,
        cliProviderId: opts.saved.provider.id,
        effortLevel: opts.saved.effort ?? null,
        explicit: true,
      });
    } else if (opts.saved) {
      fake.insert(schema.userStepCliRolePreferences, {
        userId,
        stepId,
        role: opts.saved.role,
        cliProviderId: opts.saved.provider.id,
        effortLevel: opts.saved.effort ?? null,
        explicit: true,
      });
    }
    if (opts.choice) {
      fake.insert(schema.taskStepCliChoices, {
        taskId,
        stepId,
        role: opts.choice.role,
        cliProviderId: opts.choice.provider.id,
        effortLevel: null,
      });
    }
    return fake.db as unknown as Database;
  }

  async function run(
    prefs: Database,
    taskDb: Database,
    role = 'default',
    taskCli: CliProviderRecord | null = A,
  ) {
    const resolved = await resolvePreferredCli(
      prefs,
      userId,
      stepId,
      taskCli?.id ?? null,
      PROVIDERS,
      role,
      taskId,
    );
    const plan = await resolveTaskDispatch(taskDb, 't', {
      providers: PROVIDERS,
      preferredProviderId: resolved.cliProviderId,
      savedPreference: resolved.savedPreference,
      input: prompt,
      invokeOpts: { effortLevel: resolved.effortLevel ?? undefined },
      toolProfile: 'none',
    });
    return { resolved, plan };
  }

  it.each(['default', 'reviewer'])('runs a saved %s pick on the task CLI instead', async (role) => {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    const { plan } = await run(
      savedAndChosen({ saved: { role, provider: B, effort: 'high' } }),
      fakeDb(2, refs).db,
      role,
    );
    expect(plan.mode).toBe('cli');
    expect(plan.providerId).toBe(A.id);
    expect(plan.skippedSavedPreference?.providerId).toBe(B.id);
    expect(plan.effort?.source).not.toBe('step');
  });

  it('runs it before any image is effective, on the verified provider', async () => {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    const { plan } = await run(
      savedAndChosen({ saved: { role: 'default', provider: B } }),
      fakeDb(2, {}).db,
    );
    expect(plan.mode).toBe('cli');
    expect(plan.providerId).toBe(A.id);
    expect(plan.skippedSavedPreference?.providerId).toBe(B.id);
  });

  it('floats inside the set when the task CLI is outside it or unset', async () => {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    for (const taskCli of [C, null]) {
      const { plan } = await run(
        savedAndChosen({ saved: { role: 'default', provider: B } }),
        fakeDb(2, refs).db,
        'default',
        taskCli,
      );
      expect(plan.providerId).toBe(A.id);
      expect(plan.skippedSavedPreference?.providerId).toBe(B.id);
    }
  });

  it('never moves a pick made in this task', async () => {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    const { resolved, plan } = await run(
      savedAndChosen({
        saved: { role: 'default', provider: C },
        choice: { role: 'default', provider: B },
      }),
      fakeDb(2, refs).db,
    );
    expect(resolved.cliProviderId).toBe(B.id);
    expect(resolved.savedPreference).toBeUndefined();
    expect(plan.mode).toBe('skip');
    expect(plan.skippedSavedPreference).toBeUndefined();
  });

  it('honours the same saved pick when nothing is locked', async () => {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    const { plan } = await run(
      savedAndChosen({ saved: { role: 'default', provider: B } }),
      fakeDb(1, {}).db,
    );
    expect(plan.providerId).toBe(B.id);
    expect(plan.skippedSavedPreference).toBeUndefined();
  });

  it('honours a saved pick inside the set', async () => {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    const { plan } = await run(
      savedAndChosen({ saved: { role: 'default', provider: A, effort: 'high' } }),
      fakeDb(2, refs).db,
      'default',
      C,
    );
    expect(plan.providerId).toBe(A.id);
    expect(plan.skippedSavedPreference).toBeUndefined();
    expect(plan.effort?.source).toBe('step');
  });
});

describe('resolveDispatch with a saved preference outside the set', () => {
  const locked = { ...base, providers: [A, B, C], composedLspProviderIds: [A.id] };

  it('keeps the refusal when the caller does not say the pick is saved', () => {
    const plan = resolveDispatch({ ...locked, preferredProviderId: B.id });
    expect(plan.mode).toBe('skip');
    expect(plan.skippedSavedPreference).toBeUndefined();
  });

  it('keeps the disabled refusal for a disabled saved pick', () => {
    const off = { ...B, enabled: false } as CliProviderRecord;
    const plan = resolveDispatch({
      ...locked,
      providers: [A, off, C],
      preferredProviderId: B.id,
      savedPreference: { taskProviderId: A.id },
    });
    expect(plan.mode).toBe('skip');
    expect(plan.reason).toContain('is disabled');
  });

  it('refuses a disabled task CLI as disabled rather than floating past it', () => {
    const off = { ...A, enabled: false } as CliProviderRecord;
    const plan = resolveDispatch({
      ...locked,
      providers: [off, B, C],
      preferredProviderId: B.id,
      composedLspProviderIds: [A.id, C.id],
      savedPreference: { taskProviderId: A.id },
    });
    expect(plan.mode).toBe('skip');
    expect(plan.reason).toContain('is disabled');
  });

  it('floats to the set when the task CLI is outside it', () => {
    const plan = resolveDispatch({
      ...locked,
      preferredProviderId: B.id,
      savedPreference: { taskProviderId: C.id },
    });
    expect(plan.providerId).toBe(A.id);
    expect(plan.skippedSavedPreference).toEqual({ providerId: B.id, label: B.label });
  });

  it('runs the task CLI, not the oldest provider, when it is the newer of two in the set', () => {
    const plan = resolveDispatch({
      ...locked,
      composedLspProviderIds: [A.id, B.id],
      preferredProviderId: C.id,
      savedPreference: { taskProviderId: A.id },
    });
    expect(plan.providerId).toBe(A.id);
    expect(plan.skippedSavedPreference).toEqual({ providerId: C.id, label: C.label });
  });

  it('floats inside the set, not as a disabled skip, when the task CLI is outside it and disabled', () => {
    const off = { ...C, enabled: false } as CliProviderRecord;
    const plan = resolveDispatch({
      ...locked,
      providers: [A, B, off],
      preferredProviderId: B.id,
      savedPreference: { taskProviderId: C.id },
    });
    expect(plan.mode).toBe('cli');
    expect(plan.providerId).toBe(A.id);
    expect(plan.skippedSavedPreference).toEqual({ providerId: B.id, label: B.label });
  });

  it('rethrows a build failure of the task CLI it substituted, and skips a floated one', () => {
    const O = provider(randomUUID(), 'ollama', 0);
    const inSet = { ...locked, providers: [O, A, B], composedLspProviderIds: [O.id, A.id] };
    expect(() =>
      resolveDispatch({
        ...inSet,
        preferredProviderId: B.id,
        savedPreference: { taskProviderId: O.id },
      }),
    ).toThrow(ProviderBuildError);
    const floated = resolveDispatch({
      ...inSet,
      preferredProviderId: B.id,
      savedPreference: { taskProviderId: null },
    });
    expect(floated.providerId).toBe(A.id);
  });
});
