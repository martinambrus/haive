import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/db.js', () => ({ getDb: () => undefined }));

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

function setup() {
  const fake = createFakeDb({
    cliProviders: schema.cliProviders,
    taskStepCliChoices: schema.taskStepCliChoices,
    taskStepCliTouched: schema.taskStepCliTouched,
    userStepCliPreferences: schema.userStepCliPreferences,
    userStepCliRolePreferences: schema.userStepCliRolePreferences,
  });
  for (const id of [TASK_CLI, SAVED_CLI, PICKED_CLI]) {
    fake.insert(schema.cliProviders, { id, userId: USER, name: 'codex', enabled: true });
  }
  const save = (stepId: string, cliProviderId: string, role = 'default') =>
    role === 'default'
      ? fake.insert(schema.userStepCliPreferences, {
          userId: USER,
          stepId,
          cliProviderId,
          effortLevel: 'low',
          explicit: true,
        })
      : fake.insert(schema.userStepCliRolePreferences, {
          userId: USER,
          stepId,
          role,
          cliProviderId,
          explicit: true,
        });
  const choose = (stepId: string, cliProviderId: string | null, role = 'default') =>
    fake.insert(schema.taskStepCliChoices, {
      taskId: TASK,
      stepId,
      role,
      cliProviderId,
      effortLevel: cliProviderId ? 'high' : null,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { fake, db: fake.db as any, save, choose };
}

describe("a step card's CLI", () => {
  it("shows this task's pick over the saved one, with its effort", async () => {
    const { db, save, choose } = setup();
    save('08c-code-review', SAVED_CLI);
    choose('08c-code-review', PICKED_CLI);
    const [step] = await enrichStepsWithCliPreferences(
      db,
      flags,
      USER,
      [{ stepId: '08c-code-review' }],
      TASK,
    );
    expect(step).toMatchObject({
      preferredCliProviderId: PICKED_CLI,
      preferredEffortLevel: 'high',
    });
  });

  it('shows nothing saved in a slot this task cleared, and the saved one elsewhere', async () => {
    const { db, save, choose } = setup();
    save('08c-code-review', SAVED_CLI);
    save('08d-adversarial-qa', SAVED_CLI);
    choose('08c-code-review', null);
    const steps = await enrichStepsWithCliPreferences(
      db,
      flags,
      USER,
      [{ stepId: '08c-code-review' }, { stepId: '08d-adversarial-qa' }],
      TASK,
    );
    expect(steps.map((s) => s.preferredCliProviderId)).toEqual([null, SAVED_CLI]);
  });

  it("shows this task's pick under ignore_saved_step_clis with no touch marker", async () => {
    const { db, save, choose } = setup();
    save('08c-code-review', SAVED_CLI);
    save('08d-adversarial-qa', SAVED_CLI);
    choose('08c-code-review', PICKED_CLI);
    const steps = await enrichStepsWithCliPreferences(
      db,
      flags,
      USER,
      [{ stepId: '08c-code-review' }, { stepId: '08d-adversarial-qa' }],
      TASK,
      true,
    );
    expect(steps.map((s) => s.preferredCliProviderId)).toEqual([PICKED_CLI, null]);
  });

  it('shows no effort for a slot whose chosen provider was deleted since', async () => {
    const { fake, db, save } = setup();
    save('08c-code-review', SAVED_CLI);
    // What ON DELETE SET NULL leaves: the provider gone, the effort that went with it kept.
    fake.insert(schema.taskStepCliChoices, {
      taskId: TASK,
      stepId: '08c-code-review',
      role: 'default',
      cliProviderId: null,
      effortLevel: 'max',
    });
    const [step] = await enrichStepsWithCliPreferences(
      db,
      flags,
      USER,
      [{ stepId: '08c-code-review' }],
      TASK,
    );
    expect(step).toMatchObject({ preferredCliProviderId: null, preferredEffortLevel: null });
  });

  it("shows a role's own pick in this task", async () => {
    const { db, save, choose } = setup();
    save('08a-browser-verify', SAVED_CLI, 'fixer');
    choose('08a-browser-verify', PICKED_CLI, 'fixer');
    const [step] = await enrichStepsWithCliPreferences(
      db,
      flags,
      USER,
      [{ stepId: '08a-browser-verify' }],
      TASK,
    );
    expect(step?.cliRoleProviders).toMatchObject({ fixer: PICKED_CLI, tester: null });
  });
});

describe("the listing's usage strip", () => {
  const task = (currentStepId: string) => ({
    id: TASK,
    currentStepId,
    cliProviderId: TASK_CLI,
    ignoreSavedStepClis: false,
  });

  it("meters this task's pick, and the task CLI where it cleared the slot", async () => {
    const picked = setup();
    picked.save('08c-code-review', SAVED_CLI);
    picked.choose('08c-code-review', PICKED_CLI);
    const a = await resolveCurrentStepCliProviderIds(picked.db, flags, USER, [
      task('08c-code-review'),
    ]);
    expect(a.get(TASK)?.[0]).toBe(PICKED_CLI);

    const cleared = setup();
    cleared.save('08c-code-review', SAVED_CLI);
    cleared.choose('08c-code-review', null);
    const b = await resolveCurrentStepCliProviderIds(cleared.db, flags, USER, [
      task('08c-code-review'),
    ]);
    expect(b.get(TASK)?.[0]).toBe(TASK_CLI);
  });

  it('falls back to the task CLI when the picked one was disabled since', async () => {
    const { fake, db, save, choose } = setup();
    save('08c-code-review', SAVED_CLI);
    choose('08c-code-review', PICKED_CLI);
    fake.patch(schema.cliProviders, PICKED_CLI, { enabled: false });
    const out = await resolveCurrentStepCliProviderIds(db, flags, USER, [task('08c-code-review')]);
    expect(out.get(TASK)?.[0]).toBe(TASK_CLI);
  });
});

describe("the listing's usage strip for a task with no CLI of its own", () => {
  const OTHER_USER = '00000000-0000-4000-8000-0000000000a2';
  const P1 = '00000000-0000-4000-8000-0000000000c1';
  const P2 = '00000000-0000-4000-8000-0000000000c2';
  const P3 = '00000000-0000-4000-8000-0000000000c3';
  const day = (n: number) => new Date(Date.UTC(2026, 0, n));
  const none = (currentStepId = '08c-code-review') => ({
    id: TASK,
    currentStepId,
    cliProviderId: null,
    ignoreSavedStepClis: false,
  });

  function providers(rows: { id: string; createdAt: Date; enabled?: boolean; userId?: string }[]) {
    const fake = createFakeDb({
      cliProviders: schema.cliProviders,
      taskStepCliChoices: schema.taskStepCliChoices,
      taskStepCliTouched: schema.taskStepCliTouched,
      userStepCliPreferences: schema.userStepCliPreferences,
      userStepCliRolePreferences: schema.userStepCliRolePreferences,
    });
    for (const r of rows) {
      fake.insert(schema.cliProviders, {
        name: 'codex',
        userId: USER,
        enabled: true,
        ...r,
      });
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { fake, db: fake.db as any };
  }

  it('meters the oldest enabled provider whatever the insert order', async () => {
    const { db } = providers([
      { id: P3, createdAt: day(3) },
      { id: P1, createdAt: day(1) },
      { id: P2, createdAt: day(2) },
    ]);
    const out = await resolveCurrentStepCliProviderIds(db, flags, USER, [none()]);
    expect(out.get(TASK)).toEqual([P1]);
  });

  it('breaks a createdAt tie on the lowest id', async () => {
    const { db } = providers([
      { id: P2, createdAt: day(1) },
      { id: P1, createdAt: day(1) },
      { id: P3, createdAt: day(2) },
    ]);
    const out = await resolveCurrentStepCliProviderIds(db, flags, USER, [none()]);
    expect(out.get(TASK)).toEqual([P1]);
  });

  it('skips a disabled oldest provider', async () => {
    const { db } = providers([
      { id: P1, createdAt: day(1), enabled: false },
      { id: P2, createdAt: day(2) },
      { id: P3, createdAt: day(3) },
    ]);
    const out = await resolveCurrentStepCliProviderIds(db, flags, USER, [none()]);
    expect(out.get(TASK)).toEqual([P2]);
  });

  it("ignores another user's older provider", async () => {
    const { db } = providers([
      { id: P1, createdAt: day(1), userId: OTHER_USER },
      { id: P2, createdAt: day(2) },
    ]);
    const out = await resolveCurrentStepCliProviderIds(db, flags, USER, [none()]);
    expect(out.get(TASK)).toEqual([P2]);
  });

  it('keeps a saved step pick over the default', async () => {
    const { fake, db } = providers([
      { id: P1, createdAt: day(1) },
      { id: P2, createdAt: day(2) },
    ]);
    fake.insert(schema.userStepCliPreferences, {
      userId: USER,
      stepId: '08c-code-review',
      cliProviderId: P2,
      effortLevel: 'low',
      explicit: true,
    });
    const out = await resolveCurrentStepCliProviderIds(db, flags, USER, [none()]);
    expect(out.get(TASK)).toEqual([P2]);
  });

  it("keeps the task's own CLI over the default", async () => {
    const { db } = providers([
      { id: P1, createdAt: day(1) },
      { id: P2, createdAt: day(2) },
    ]);
    const out = await resolveCurrentStepCliProviderIds(db, flags, USER, [
      { ...none(), cliProviderId: P2 },
    ]);
    expect(out.get(TASK)).toEqual([P2]);
  });

  it('names nothing when the user has no enabled provider', async () => {
    const { db } = providers([{ id: P1, createdAt: day(1), enabled: false }]);
    const out = await resolveCurrentStepCliProviderIds(db, flags, USER, [none()]);
    expect(out.get(TASK)).toEqual([]);
  });
});
