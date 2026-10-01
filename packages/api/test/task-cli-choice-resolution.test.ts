import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/db.js', () => ({ getDb: () => undefined }));

import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import {
  enrichStepsWithCliPreferences,
  resolveCurrentStepCliProviderIds,
} from '../src/routes/tasks/_helpers.js';

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
      USER,
      [{ stepId: '08c-code-review' }, { stepId: '08d-adversarial-qa' }],
      TASK,
      true,
    );
    expect(steps.map((s) => s.preferredCliProviderId)).toEqual([PICKED_CLI, null]);
  });

  it("shows a role's own pick in this task", async () => {
    const { db, save, choose } = setup();
    save('08a-browser-verify', SAVED_CLI, 'fixer');
    choose('08a-browser-verify', PICKED_CLI, 'fixer');
    const [step] = await enrichStepsWithCliPreferences(
      db,
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
    const a = await resolveCurrentStepCliProviderIds(picked.db, USER, [task('08c-code-review')]);
    expect(a.get(TASK)?.[0]).toBe(PICKED_CLI);

    const cleared = setup();
    cleared.save('08c-code-review', SAVED_CLI);
    cleared.choose('08c-code-review', null);
    const b = await resolveCurrentStepCliProviderIds(cleared.db, USER, [task('08c-code-review')]);
    expect(b.get(TASK)?.[0]).toBe(TASK_CLI);
  });

  it('falls back to the task CLI when the picked one was disabled since', async () => {
    const { fake, db, save, choose } = setup();
    save('08c-code-review', SAVED_CLI);
    choose('08c-code-review', PICKED_CLI);
    fake.patch(schema.cliProviders, PICKED_CLI, { enabled: false });
    const out = await resolveCurrentStepCliProviderIds(db, USER, [task('08c-code-review')]);
    expect(out.get(TASK)?.[0]).toBe(TASK_CLI);
  });
});
