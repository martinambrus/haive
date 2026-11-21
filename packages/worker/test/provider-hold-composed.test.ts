import { describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { providerHoldFor } from '../src/queues/task-queue.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';
import type { ResolvedTaskContext } from '../src/queues/run-list.js';

vi.mock('../src/db.js', () => ({ getDb: () => undefined }));
vi.mock('../src/redis.js', () => ({
  getBullRedis: () => ({}),
  getRedis: () => ({ scan: async () => ['0', []], del: async () => 0 }),
}));
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
const STEP = 'hold-composed-llm';
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
}

async function hold(o: Setup) {
  const fake = createFakeDb({
    tasks: schema.tasks,
    envTemplates: schema.envTemplates,
    cliProviders: schema.cliProviders,
    taskStepCliChoices: schema.taskStepCliChoices,
    userStepCliPreferences: schema.userStepCliPreferences,
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
  const ctx = {
    userId: USER,
    taskId: TASK,
    cliProviderId: o.own,
    ignoreSavedStepClis: false,
  } as unknown as ResolvedTaskContext;
  return providerHoldFor(fake.db as unknown as Database, ctx, stepDef, 0, 0);
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
});
