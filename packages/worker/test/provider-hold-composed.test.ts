import { describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { providerHoldFor } from '../src/queues/task-queue.js';
import { resolveDispatch } from '../src/orchestrator/dispatcher.js';
import { FixRoundCliUnavailable } from '../src/step-engine/steps/workflow/_fix-round-cli.js';
import { resolvePreferredCli } from '../src/step-engine/step-runner.js';
import { lspDispatchState } from '../src/lsp/configured-lsp.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';
import type { ResolvedTaskContext } from '../src/queues/run-list.js';

vi.mock('../src/db.js', () => ({ getDb: () => undefined }));
vi.mock('../src/redis.js', () => ({
  getBullRedis: () => ({}),
  getRedis: () => ({ scan: async () => ['0', []], del: async () => 0 }),
}));
vi.mock('../src/lsp/configured-lsp.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lsp/configured-lsp.js')>();
  return { ...real, lspDispatchState: vi.fn(real.lspDispatchState) };
});
vi.mock('bullmq', async (importOriginal) => ({
  ...(await importOriginal<typeof import('bullmq')>()),
  Queue: class {
    async add() {
      return undefined;
    }
  },
}));

const USER = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-000000000001';
const TEMPLATE = '00000000-0000-4000-8000-0000000000e1';
const CLAUDE = '00000000-0000-4000-8000-0000000000b1';
const CODEX = '00000000-0000-4000-8000-0000000000b2';
const STEP = '07-phase-2-implement';
const IMAGE = {
  tag: 'img:1',
  imageId: 'sha256:1',
  identityHash: 'h',
  inputs: { rtkVersion: '1', baseImageId: null, rtkPin: null, requestedHash: 'r' },
};

const stepDef = {
  metadata: {
    id: STEP,
    workflowType: 'workflow',
    index: 0,
    title: STEP,
    description: 'a step for the composed provider hold test',
    requiresCli: false,
  },
  llm: { requiredCapabilities: [], buildPrompt: () => 'a prompt' },
  detect: async () => ({}),
  apply: async () => ({}),
} as unknown as StepDefinition;

interface Setup {
  composed: boolean;
  own: string | null;
  off: string[];
  saved?: string;
  chosen?: string;
  /** Providers holding an effective retained composed image: the lock's set. */
  refs?: string[];
  ignore?: boolean;
  roleSaved?: string;
  roundChoice?: string;
  round?: number;
  check?: (db: Database, ctx: ResolvedTaskContext) => Promise<void>;
}

async function hold(o: Setup) {
  const fake = createFakeDb({
    tasks: schema.tasks,
    envTemplates: schema.envTemplates,
    cliProviders: schema.cliProviders,
    taskStepCliChoices: schema.taskStepCliChoices,
    userStepCliPreferences: schema.userStepCliPreferences,
    userStepCliRolePreferences: schema.userStepCliRolePreferences,
    taskSteps: schema.taskSteps,
  });
  fake.insert(schema.tasks, {
    id: TASK,
    userId: USER,
    cliProviderId: o.own,
    envTemplateId: TEMPLATE,
    ...(o.refs && {
      metadata: {
        composedLspImageRefs: {
          schemaVersion: 1,
          entries: o.refs.map((providerId) => ({ providerId, effective: IMAGE })),
        },
      },
    }),
  });
  fake.insert(schema.envTemplates, {
    id: TEMPLATE,
    userId: USER,
    name: 't',
    baseImage: 'img',
    declaredDeps: o.composed ? { lspInstallContractVersion: 2 } : {},
  });
  for (const [id, name, at] of [
    [CLAUDE, 'claude-code', 1],
    [CODEX, 'codex', 2],
  ] as const)
    fake.insert(schema.cliProviders, {
      id,
      userId: USER,
      name,
      label: name,
      enabled: !o.off.includes(id),
      authMode: 'subscription',
      envVars: null,
      cliArgs: null,
      createdAt: new Date(at),
    });
  if (o.saved)
    fake.insert(schema.userStepCliPreferences, {
      userId: USER,
      stepId: STEP,
      cliProviderId: o.saved,
      effortLevel: null,
      explicit: true,
    });
  if (o.chosen)
    fake.insert(schema.taskStepCliChoices, {
      taskId: TASK,
      stepId: STEP,
      role: 'default',
      cliProviderId: o.chosen,
      effortLevel: null,
    });
  if (o.roleSaved)
    fake.insert(schema.userStepCliRolePreferences, {
      userId: USER,
      stepId: STEP,
      role: 'reviewer',
      cliProviderId: o.roleSaved,
      explicit: true,
    });
  if (o.roundChoice)
    fake.insert(schema.taskStepCliChoices, {
      taskId: TASK,
      stepId: STEP,
      role: 'fix:2:default',
      cliProviderId: o.roundChoice,
      updatedAt: new Date(2),
    });
  const ctx = {
    userId: USER,
    taskId: TASK,
    cliProviderId: o.own,
    ignoreSavedStepClis: o.ignore ?? false,
  } as unknown as ResolvedTaskContext;
  await o.check?.(fake.db as unknown as Database, ctx);
  return providerHoldFor(fake.db as unknown as Database, ctx, stepDef, o.round ?? 0, 0);
}

describe('the provider hold of a composed task resolves the provider as the dispatcher does', () => {
  it('H1 parks on the task CLI when an enabled saved pick outside the set is skipped', async () => {
    const r = await hold({ composed: true, own: CLAUDE, off: [CLAUDE], saved: CODEX });
    expect(r?.providerId).toBe(CLAUDE);
  });

  it('H2 does not park on a switched-off saved pick the lock skips', async () => {
    const r = await hold({ composed: true, own: CLAUDE, off: [CODEX], saved: CODEX });
    expect(r).toBeNull();
  });

  it('H3 does not park on a switched-off saved pick when the task CLI is unset', async () => {
    const r = await hold({ composed: true, own: null, off: [CODEX], saved: CODEX });
    expect(r).toBeNull();
  });

  it('H4 parks on a switched-off task CLI with nothing saved, and not when enabled', async () => {
    expect((await hold({ composed: true, own: CLAUDE, off: [CLAUDE] }))?.providerId).toBe(CLAUDE);
    expect(await hold({ composed: true, own: CLAUDE, off: [] })).toBeNull();
  });

  it('H5 keeps the saved pick for a task that is not composed', async () => {
    const parked = await hold({ composed: false, own: CLAUDE, off: [CODEX], saved: CODEX });
    expect(parked?.providerId).toBe(CODEX);
    expect(await hold({ composed: false, own: CLAUDE, off: [CLAUDE], saved: CODEX })).toBeNull();
  });

  it('H6 keeps disabled-first for a pick made in this task', async () => {
    const parked = await hold({ composed: true, own: CLAUDE, off: [CODEX], chosen: CODEX });
    expect(parked?.providerId).toBe(CODEX);
    expect(await hold({ composed: true, own: CLAUDE, off: [], chosen: CODEX })).toBeNull();
  });

  it('H7 parks on a switched-off saved pick inside the set', async () => {
    const r = await hold({ composed: true, own: CODEX, off: [CLAUDE], saved: CLAUDE });
    expect(r?.providerId).toBe(CLAUDE);
  });

  it('H8 reads the lock set from the task image references', async () => {
    const setup = { composed: true, own: CODEX, off: [CLAUDE], saved: CLAUDE };
    expect((await hold(setup))?.providerId).toBe(CLAUDE);
    expect(await hold({ ...setup, refs: [CODEX] })).toBeNull();
  });

  it('H9 reads the lock set only for a saved pick', async () => {
    const read = vi.mocked(lspDispatchState);
    read.mockClear();
    await hold({ composed: true, own: CLAUDE, off: [CLAUDE] });
    await hold({ composed: true, own: CLAUDE, off: [], chosen: CODEX });
    expect(read).not.toHaveBeenCalled();
    await hold({ composed: true, own: CLAUDE, off: [], saved: CODEX });
    expect(read).toHaveBeenCalledTimes(1);
  });
});

it.each([
  { own: CLAUDE, off: [CLAUDE], saved: CODEX },
  { own: CLAUDE, off: [CODEX], saved: CODEX },
  { own: null, off: [CODEX], saved: CODEX },
  { own: CLAUDE, off: [CLAUDE], saved: CODEX, ignore: true },
  { own: CLAUDE, off: [CODEX], roleSaved: CODEX },
  { own: CLAUDE, off: [CLAUDE], roleSaved: CODEX },
])('hold and dispatch agree: %j', async (setup) => {
  let disabled = false;
  const held = await hold({
    ...setup,
    composed: true,
    check: async (db, ctx) => {
      const providers = await db.select().from(schema.cliProviders);
      const resolved = await resolvePreferredCli(
        db,
        USER,
        STEP,
        ctx.cliProviderId,
        providers,
        'default',
        TASK,
        ctx.ignoreSavedStepClis,
      );
      const lock = await lspDispatchState(db, TASK, [], false);
      const plan = resolveDispatch({
        providers,
        preferredProviderId: resolved.cliProviderId,
        savedPreference: resolved.savedPreference,
        composedLspProviderIds: lock.composedProviderIds,
        input: { kind: 'prompt', prompt: 'work', capabilities: [] },
        invokeOpts: {},
      });
      disabled = plan.mode === 'skip' && plan.reason?.includes('is disabled') === true;
      if (!disabled) expect(plan.providerId).toBe(CLAUDE);
    },
  });
  expect(held !== null).toBe(disabled);
});

it('a fix-round task choice remains explicit for both hold and dispatch', async () => {
  let selected: string | null = null;
  const result = await hold({
    composed: true,
    own: CLAUDE,
    off: [],
    saved: CODEX,
    round: 2,
    roundChoice: CLAUDE,
    check: async (db, ctx) => {
      const providers = await db.select().from(schema.cliProviders);
      const resolved = await resolvePreferredCli(
        db,
        USER,
        STEP,
        ctx.cliProviderId,
        providers,
        'default',
        TASK,
        false,
        2,
      );
      expect(resolved.savedPreference).toBeUndefined();
      const plan = resolveDispatch({
        providers,
        preferredProviderId: resolved.cliProviderId,
        composedLspProviderIds: [],
        input: { kind: 'prompt', prompt: 'work', capabilities: [] },
        invokeOpts: {},
      });
      selected = plan.providerId;
    },
  });
  expect(selected).toBe(CLAUDE);
  expect(result).toBeNull();
});

it('an unavailable fix-round CLI refuses both the hold and dispatch resolution', async () => {
  await expect(
    hold({
      composed: true,
      own: CLAUDE,
      off: [CLAUDE],
      saved: CODEX,
      round: 2,
      roundChoice: CLAUDE,
    }),
  ).rejects.toBeInstanceOf(FixRoundCliUnavailable);
  await hold({
    composed: true,
    own: CLAUDE,
    off: [CLAUDE],
    roundChoice: CLAUDE,
    check: async (db, ctx) => {
      const providers = await db.select().from(schema.cliProviders);
      await expect(
        resolvePreferredCli(
          db,
          USER,
          STEP,
          ctx.cliProviderId,
          providers,
          'default',
          TASK,
          false,
          2,
        ),
      ).rejects.toBeInstanceOf(FixRoundCliUnavailable);
    },
  });
});

it('named roles skip their own saved pick to the task CLI rather than an ordinary step choice', async () => {
  await hold({
    composed: true,
    own: CLAUDE,
    off: [CODEX],
    chosen: CODEX,
    roleSaved: CODEX,
    check: async (db, ctx) => {
      const providers = await db.select().from(schema.cliProviders);
      const resolved = await resolvePreferredCli(
        db,
        USER,
        STEP,
        ctx.cliProviderId,
        providers,
        'reviewer',
        TASK,
        false,
      );
      const plan = resolveDispatch({
        providers,
        preferredProviderId: resolved.cliProviderId,
        savedPreference: resolved.savedPreference,
        composedLspProviderIds: [],
        input: { kind: 'prompt', prompt: 'work', capabilities: [] },
        invokeOpts: {},
      });
      expect(plan.providerId).toBe(CLAUDE);
      expect(plan.skippedSavedPreference?.providerId).toBe(CODEX);
    },
  });
});
