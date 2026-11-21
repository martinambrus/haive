import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/db.js', () => ({ getDb: () => undefined }));

import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import {
  enrichStepsWithCliPreferences,
  resolveCurrentStepCliProviderIds,
} from '../src/routes/tasks/_helpers.js';
import { staticStepFlags } from './step-flags-fixture.js';

const flags = staticStepFlags();
const USER = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-000000000001';
const TASK_CLI = '00000000-0000-4000-8000-0000000000b1';
const SAVED_CLI = '00000000-0000-4000-8000-0000000000b2';
const PICKED_CLI = '00000000-0000-4000-8000-0000000000b3';
const LEGACY = '07-phase-2-implement';
const CUSTOM = 'module.fix-demo.repair';
const OTHER_MODULE = 'module.fix-demo.other';
const ROUND = 'fix:2:default';

const pin = (stepId: string) => ({
  version: 1,
  guardedSpans: [],
  fixTarget: { stepId, capabilityVersion: 1 },
});

function setup(contract?: unknown, withTasks = true) {
  const fake = createFakeDb({
    ...(withTasks ? { tasks: schema.tasks } : {}),
    cliProviders: schema.cliProviders,
    taskStepCliChoices: schema.taskStepCliChoices,
    taskStepCliTouched: schema.taskStepCliTouched,
    userStepCliPreferences: schema.userStepCliPreferences,
    userStepCliRolePreferences: schema.userStepCliRolePreferences,
  });
  for (const id of [TASK_CLI, SAVED_CLI, PICKED_CLI]) {
    fake.insert(schema.cliProviders, { id, userId: USER, name: 'codex', enabled: true });
  }
  if (withTasks) fake.insert(schema.tasks, { id: TASK, executionContract: contract ?? null });
  const choose = (
    stepId: string,
    cliProviderId: string | null,
    role = 'default',
    updatedAt = new Date(1),
  ) =>
    fake.insert(schema.taskStepCliChoices, {
      taskId: TASK,
      stepId,
      role,
      cliProviderId,
      effortLevel: cliProviderId ? 'high' : null,
      updatedAt,
    });
  const save = (stepId: string) =>
    fake.insert(schema.userStepCliPreferences, {
      userId: USER,
      stepId,
      cliProviderId: SAVED_CLI,
      effortLevel: 'low',
      explicit: true,
    });
  const change = (set: Record<string, unknown>) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fake.db as any)
      .update(schema.cliProviders)
      .set(set)
      .where(eq(schema.cliProviders.id, PICKED_CLI));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { fake, db: fake.db as any, choose, save, change };
}

type Setup = ReturnType<typeof setup>;

const card = async (s: Setup, stepId: string) => {
  const [step] = await enrichStepsWithCliPreferences(
    s.db,
    flags,
    USER,
    [{ stepId, round: 2 }],
    TASK,
  );
  return step as {
    preferredCliProviderId: string | null;
    preferredEffortLevel: string | null;
    roundCliUnavailable?: true;
  };
};

const listing = async (s: Setup, stepId: string) =>
  (
    await resolveCurrentStepCliProviderIds(s.db, flags, USER, [
      {
        id: TASK,
        currentStepId: stepId,
        currentRound: 2,
        cliProviderId: TASK_CLI,
        ignoreSavedStepClis: false,
      },
    ])
  ).get(TASK);

describe('step card of a pinned custom fix target', () => {
  it('shows the round provider as the preferred CLI', async () => {
    const s = setup(pin(CUSTOM));
    s.save(CUSTOM);
    s.choose(CUSTOM, PICKED_CLI, ROUND);
    const step = await card(s, CUSTOM);
    expect(step.preferredCliProviderId).toBe(PICKED_CLI);
    expect(step.preferredEffortLevel).toBe('high');
    expect(step).not.toHaveProperty('roundCliUnavailable');
  });

  it.each([
    ['deleted', null, undefined],
    ['disabled', PICKED_CLI, { enabled: false }],
  ] as const)('flags a %s round provider as unavailable', async (_state, provider, change) => {
    const s = setup(pin(CUSTOM));
    s.choose(CUSTOM, provider, ROUND);
    if (change) await s.change(change);
    expect((await card(s, CUSTOM)).roundCliUnavailable).toBe(true);
  });

  it('lets a newer ordinary default row win over the round slot', async () => {
    const s = setup(pin(CUSTOM));
    s.choose(CUSTOM, PICKED_CLI, ROUND, new Date(1));
    s.choose(CUSTOM, SAVED_CLI, 'default', new Date(2));
    const step = await card(s, CUSTOM);
    expect(step.preferredCliProviderId).toBe(SAVED_CLI);
    expect(step).not.toHaveProperty('roundCliUnavailable');
  });

  it('shows ordinary resolution for 07 even with a round row on it', async () => {
    const s = setup(pin(CUSTOM));
    s.save(LEGACY);
    s.choose(LEGACY, PICKED_CLI, ROUND);
    const step = await card(s, LEGACY);
    expect(step.preferredCliProviderId).toBe(SAVED_CLI);
    expect(step.preferredEffortLevel).toBe('low');
    expect(step).not.toHaveProperty('roundCliUnavailable');
  });
});

describe('step card without a pin, parity', () => {
  it.each([['no contract', null]])('shows the round slot on 07 for %s', async (_name, contract) => {
    const s = setup(contract);
    s.save(LEGACY);
    s.choose(LEGACY, PICKED_CLI, ROUND);
    expect((await card(s, LEGACY)).preferredCliProviderId).toBe(PICKED_CLI);
  });

  it('shows ordinary resolution for a module step with a round row', async () => {
    const s = setup(null);
    s.save(OTHER_MODULE);
    s.choose(OTHER_MODULE, PICKED_CLI, ROUND);
    const step = await card(s, OTHER_MODULE);
    expect(step.preferredCliProviderId).toBe(SAVED_CLI);
    expect(step).not.toHaveProperty('roundCliUnavailable');
  });

  it('does not throw on a malformed pin', async () => {
    const s = setup({ fixTarget: 'nonsense' });
    s.choose(LEGACY, PICKED_CLI, ROUND);
    await expect(card(s, LEGACY)).resolves.toBeDefined();
  });
});

describe('a malformed pin names no round owner', () => {
  it.each([
    ['07', LEGACY],
    ['a module step', CUSTOM],
  ])('shows and lists the ordinary slot on %s', async (_name, stepId) => {
    const s = setup({ version: 99 });
    s.save(stepId);
    s.choose(stepId, PICKED_CLI, ROUND);
    const step = await card(s, stepId);
    expect(step.preferredCliProviderId).toBe(SAVED_CLI);
    expect(step.preferredEffortLevel).toBe('low');
    expect(await listing(s, stepId)).toEqual([SAVED_CLI]);
  });

  it.each([
    ['deleted', null, undefined],
    ['disabled', PICKED_CLI, { enabled: false }],
  ] as const)('does not flag a %s round provider', async (_state, provider, change) => {
    for (const stepId of [LEGACY, CUSTOM]) {
      const s = setup({ version: 99 });
      s.choose(stepId, provider, ROUND);
      if (change) await s.change(change);
      expect(await card(s, stepId)).not.toHaveProperty('roundCliUnavailable');
      expect(await listing(s, stepId)).not.toEqual([]);
    }
  });
});

describe('current-step provider listing of a pinned custom fix target', () => {
  it('lists the round provider', async () => {
    const s = setup(pin(CUSTOM));
    s.save(CUSTOM);
    s.choose(CUSTOM, PICKED_CLI, ROUND);
    expect(await listing(s, CUSTOM)).toEqual([PICKED_CLI]);
  });

  it.each([
    ['deleted', null, undefined],
    ['disabled', PICKED_CLI, { enabled: false }],
  ] as const)('lists nothing behind a %s round provider', async (_state, provider, change) => {
    const s = setup(pin(CUSTOM));
    s.choose(CUSTOM, provider, ROUND);
    if (change) await s.change(change);
    expect(await listing(s, CUSTOM)).toEqual([]);
  });

  it('lets a newer ordinary default row win over the round slot', async () => {
    const s = setup(pin(CUSTOM));
    s.choose(CUSTOM, PICKED_CLI, ROUND, new Date(1));
    s.choose(CUSTOM, SAVED_CLI, 'default', new Date(2));
    expect(await listing(s, CUSTOM)).toEqual([SAVED_CLI]);
  });

  it('lists ordinary resolution for 07 even with a round row on it', async () => {
    const s = setup(pin(CUSTOM));
    s.save(LEGACY);
    s.choose(LEGACY, PICKED_CLI, ROUND);
    expect(await listing(s, LEGACY)).toEqual([SAVED_CLI]);
  });
});

describe('current-step provider listing without a pin, parity', () => {
  it.each([['no contract', null]])(
    'lists the round provider for 07 with %s',
    async (_name, contract) => {
      const s = setup(contract);
      s.choose(LEGACY, PICKED_CLI, ROUND);
      expect(await listing(s, LEGACY)).toEqual([PICKED_CLI]);
    },
  );

  it('lists nothing behind a deleted round provider on 07', async () => {
    const s = setup(null);
    s.choose(LEGACY, null, ROUND);
    expect(await listing(s, LEGACY)).toEqual([]);
  });

  it('lists ordinary resolution for a module step with a round row', async () => {
    const s = setup(null);
    s.save(OTHER_MODULE);
    s.choose(OTHER_MODULE, PICKED_CLI, ROUND);
    expect(await listing(s, OTHER_MODULE)).toEqual([SAVED_CLI]);
  });
});

describe('the pin is read lazily', () => {
  it('works with no tasks table when no round row exists', async () => {
    const s = setup(undefined, false);
    s.save(LEGACY);
    s.choose(LEGACY, PICKED_CLI, 'default');
    expect((await card(s, LEGACY)).preferredCliProviderId).toBe(PICKED_CLI);
    expect(await listing(s, LEGACY)).toEqual([PICKED_CLI]);
  });
});
