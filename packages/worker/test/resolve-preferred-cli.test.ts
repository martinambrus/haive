import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { resolvePreferredCli } from '../src/step-engine/step-runner.js';

const USER = '11111111-1111-4111-8111-111111111111';
const TASK = '22222222-2222-4222-8222-222222222222';
const STEP = '05-phase-0b5-spec-quality';
const TASK_CLI = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SAVED_CLI = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PICKED_CLI = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DISABLED_CLI = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const UNLISTED_CLI = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const PROVIDERS = [
  { id: TASK_CLI, enabled: true },
  { id: SAVED_CLI, enabled: true },
  { id: PICKED_CLI, enabled: true },
  { id: DISABLED_CLI, enabled: false },
];

interface Choice {
  cliProviderId: string | null;
  effortLevel: string | null;
}

/** Answers each findFirst from the role its WHERE binds, so one fake serves every table the
 *  resolver reads without modelling drizzle's query builder. */
function fakeDb(opts: {
  choices?: Record<string, Choice>;
  saved?: Record<string, Choice & { cliProviderId: string }>;
}): Database {
  const dialect = new PgDialect();
  const roleOf = (where: SQL, fallback?: string): string | undefined => {
    const params = dialect.sqlToQuery(where).params;
    return (
      (params.find((p) => typeof p === 'string' && !p.includes('-') && p !== STEP) as
        string | undefined) ?? fallback
    );
  };
  return {
    query: {
      taskStepCliChoices: {
        findFirst: async ({ where }: { where: SQL }) => opts.choices?.[roleOf(where)!],
      },
      userStepCliRolePreferences: {
        findFirst: async ({ where }: { where: SQL }) => {
          const role = roleOf(where)!;
          return role === 'default' ? undefined : opts.saved?.[role];
        },
      },
      userStepCliPreferences: {
        findFirst: async () => opts.saved?.default,
      },
    },
  } as unknown as Database;
}

const resolve = (db: Database, role = 'default', ignoreSaved = false) =>
  resolvePreferredCli(db, USER, STEP, TASK_CLI, PROVIDERS, role, TASK, ignoreSaved);

describe('resolvePreferredCli', () => {
  it("runs a step on the CLI picked in this task, over the user's saved one", async () => {
    const db = fakeDb({
      choices: { default: { cliProviderId: PICKED_CLI, effortLevel: 'high' } },
      saved: { default: { cliProviderId: SAVED_CLI, effortLevel: null } },
    });
    expect(await resolve(db)).toEqual({ cliProviderId: PICKED_CLI, effortLevel: 'high' });
  });

  it('keeps the saved preference out of a slot this task cleared', async () => {
    const db = fakeDb({
      choices: { default: { cliProviderId: null, effortLevel: null } },
      saved: { default: { cliProviderId: SAVED_CLI, effortLevel: 'low' } },
    });
    expect(await resolve(db)).toEqual({ cliProviderId: TASK_CLI, effortLevel: null });
  });

  it('keeps the CLI picked in this task when it was disabled since', async () => {
    const db = fakeDb({
      choices: { default: { cliProviderId: DISABLED_CLI, effortLevel: 'max' } },
      saved: { default: { cliProviderId: SAVED_CLI, effortLevel: null } },
    });
    expect(await resolve(db)).toEqual({ cliProviderId: DISABLED_CLI, effortLevel: 'max' });
  });

  it('keeps a disabled role pick made in this task', async () => {
    const db = fakeDb({
      choices: { reviewer: { cliProviderId: DISABLED_CLI, effortLevel: 'low' } },
    });
    expect(await resolve(db, 'reviewer')).toEqual({
      cliProviderId: DISABLED_CLI,
      effortLevel: 'low',
    });
  });

  it('keeps a disabled saved default preference', async () => {
    const db = fakeDb({ saved: { default: { cliProviderId: DISABLED_CLI, effortLevel: 'low' } } });
    expect(await resolve(db)).toEqual({
      cliProviderId: DISABLED_CLI,
      effortLevel: 'low',
      savedPreference: { taskProviderId: TASK_CLI },
    });
  });

  it('keeps a disabled saved role preference', async () => {
    const db = fakeDb({ saved: { reviewer: { cliProviderId: DISABLED_CLI, effortLevel: 'low' } } });
    expect(await resolve(db, 'reviewer')).toEqual({
      cliProviderId: DISABLED_CLI,
      effortLevel: 'low',
      savedPreference: { taskProviderId: TASK_CLI },
    });
  });

  it('leaves a disabled saved preference out under ignore_saved_step_clis', async () => {
    const db = fakeDb({ saved: { default: { cliProviderId: DISABLED_CLI, effortLevel: 'low' } } });
    expect(await resolve(db, 'default', true)).toEqual({
      cliProviderId: TASK_CLI,
      effortLevel: null,
    });
  });

  it('falls back to the task CLI when the picked id has no provider row', async () => {
    const db = fakeDb({
      choices: { default: { cliProviderId: UNLISTED_CLI, effortLevel: 'max' } },
    });
    expect(await resolve(db)).toEqual({ cliProviderId: TASK_CLI, effortLevel: null });
  });

  it('still reads the saved preference where this task chose nothing', async () => {
    const db = fakeDb({ saved: { default: { cliProviderId: SAVED_CLI, effortLevel: 'low' } } });
    expect(await resolve(db)).toEqual({
      cliProviderId: SAVED_CLI,
      effortLevel: 'low',
      savedPreference: { taskProviderId: TASK_CLI },
    });
  });

  it("honours this task's choice under ignore_saved_step_clis", async () => {
    const db = fakeDb({ choices: { default: { cliProviderId: PICKED_CLI, effortLevel: null } } });
    expect(await resolve(db, 'default', true)).toEqual({
      cliProviderId: PICKED_CLI,
      effortLevel: null,
    });
  });

  it("gives a role this task's own pick, and a cleared role the step's default slot", async () => {
    const picked = fakeDb({
      choices: { reviewer: { cliProviderId: PICKED_CLI, effortLevel: null } },
      saved: {
        reviewer: { cliProviderId: SAVED_CLI, effortLevel: null },
        default: { cliProviderId: SAVED_CLI, effortLevel: null },
      },
    });
    expect((await resolve(picked, 'reviewer')).cliProviderId).toBe(PICKED_CLI);

    const cleared = fakeDb({
      choices: {
        reviewer: { cliProviderId: null, effortLevel: null },
        default: { cliProviderId: PICKED_CLI, effortLevel: null },
      },
      saved: { reviewer: { cliProviderId: SAVED_CLI, effortLevel: null } },
    });
    expect((await resolve(cleared, 'reviewer')).cliProviderId).toBe(PICKED_CLI);
  });

  it('reads no task choice without a task id', async () => {
    const db = fakeDb({
      choices: { default: { cliProviderId: PICKED_CLI, effortLevel: null } },
      saved: { default: { cliProviderId: SAVED_CLI, effortLevel: null } },
    });
    const out = await resolvePreferredCli(db, USER, STEP, TASK_CLI, PROVIDERS, 'default');
    expect(out.cliProviderId).toBe(SAVED_CLI);
  });
});

const savedRow = (cliProviderId: string, effortLevel: string | null = 'low') => ({
  cliProviderId,
  effortLevel,
});
const taskOnly = { cliProviderId: TASK_CLI, effortLevel: null };
const withMarker = (cliProviderId: string, effortLevel: string | null = 'low') => ({
  cliProviderId,
  effortLevel,
  savedPreference: { taskProviderId: TASK_CLI },
});

describe('resolvePreferredCli with and without ignore_saved_step_clis', () => {
  // [name, role, fake options, result with the flag off, result with the flag on]
  const cases: [string, string, Parameters<typeof fakeDb>[0], object, object][] = [
    [
      'default: task pick over a saved row',
      'default',
      {
        choices: { default: savedRow(PICKED_CLI, 'high') },
        saved: { default: savedRow(SAVED_CLI) },
      },
      savedRow(PICKED_CLI, 'high'),
      savedRow(PICKED_CLI, 'high'),
    ],
    [
      'default: cleared task pick with a saved row',
      'default',
      {
        choices: { default: { cliProviderId: null, effortLevel: null } },
        saved: { default: savedRow(SAVED_CLI) },
      },
      taskOnly,
      taskOnly,
    ],
    [
      'default: task pick on an unlisted provider',
      'default',
      {
        choices: { default: savedRow(UNLISTED_CLI, 'max') },
        saved: { default: savedRow(SAVED_CLI) },
      },
      taskOnly,
      taskOnly,
    ],
    [
      'default: saved row only',
      'default',
      { saved: { default: savedRow(SAVED_CLI) } },
      withMarker(SAVED_CLI),
      taskOnly,
    ],
    [
      'default: saved row on a disabled provider',
      'default',
      { saved: { default: savedRow(DISABLED_CLI) } },
      withMarker(DISABLED_CLI),
      taskOnly,
    ],
    [
      'default: saved row on an unlisted provider',
      'default',
      { saved: { default: savedRow(UNLISTED_CLI) } },
      taskOnly,
      taskOnly,
    ],
    ['default: nothing', 'default', {}, taskOnly, taskOnly],
    [
      'role: role pick',
      'reviewer',
      {
        choices: { reviewer: savedRow(PICKED_CLI, 'high') },
        saved: { reviewer: savedRow(SAVED_CLI), default: savedRow(SAVED_CLI) },
      },
      savedRow(PICKED_CLI, 'high'),
      savedRow(PICKED_CLI, 'high'),
    ],
    [
      'role: cleared role pick with a default pick',
      'reviewer',
      {
        choices: {
          reviewer: { cliProviderId: null, effortLevel: null },
          default: savedRow(PICKED_CLI, 'high'),
        },
        saved: { reviewer: savedRow(SAVED_CLI) },
      },
      savedRow(PICKED_CLI, 'high'),
      savedRow(PICKED_CLI, 'high'),
    ],
    [
      'role: role saved only',
      'reviewer',
      { saved: { reviewer: savedRow(SAVED_CLI) } },
      withMarker(SAVED_CLI),
      taskOnly,
    ],
    [
      'role: role saved plus default saved',
      'reviewer',
      { saved: { reviewer: savedRow(SAVED_CLI), default: savedRow(PICKED_CLI) } },
      withMarker(SAVED_CLI),
      taskOnly,
    ],
    [
      'role: default saved only',
      'reviewer',
      { saved: { default: savedRow(PICKED_CLI) } },
      withMarker(PICKED_CLI),
      taskOnly,
    ],
  ];

  it.each(cases)('%s', async (_name, role, opts, flagOff, flagOn) => {
    expect(await resolve(fakeDb(opts), role, false)).toEqual(flagOff);
    expect(await resolve(fakeDb(opts), role, true)).toEqual(flagOn);
  });

  it.each([
    [false, withMarker(SAVED_CLI)],
    [true, taskOnly],
  ])('with a saved row and no task id, ignore_saved_step_clis %s', async (flag, expected) => {
    const db = fakeDb({ saved: { default: savedRow(SAVED_CLI) } });
    expect(
      await resolvePreferredCli(db, USER, STEP, TASK_CLI, PROVIDERS, 'default', undefined, flag),
    ).toEqual(expected);
  });
});

describe('resolvePreferredCli saved-preference marker', () => {
  it('marks a saved default and a saved named role, naming the task CLI', async () => {
    const saved = { cliProviderId: SAVED_CLI, effortLevel: 'low' };
    const db = fakeDb({ saved: { default: saved, reviewer: saved } });
    expect((await resolve(db)).savedPreference).toEqual({ taskProviderId: TASK_CLI });
    expect((await resolve(db, 'reviewer')).savedPreference).toEqual({ taskProviderId: TASK_CLI });
  });

  it('leaves a leftover touch-marker row without effect under ignore_saved_step_clis', async () => {
    const fake = createFakeDb({
      taskStepCliChoices: schema.taskStepCliChoices,
      taskStepCliTouched: schema.taskStepCliTouched,
      userStepCliRolePreferences: schema.userStepCliRolePreferences,
      userStepCliPreferences: schema.userStepCliPreferences,
    });
    fake.insert(schema.taskStepCliTouched, { taskId: TASK, stepId: STEP, role: 'default' });
    fake.insert(schema.userStepCliPreferences, {
      userId: USER,
      stepId: STEP,
      cliProviderId: SAVED_CLI,
      effortLevel: 'low',
      explicit: true,
    });
    const out = await resolve(fake.db as unknown as Database, 'default', true);
    expect(out).toEqual({ cliProviderId: TASK_CLI, effortLevel: null });
    expect(out.savedPreference).toBeUndefined();
  });

  it.each([
    [
      'a role pick made in this task',
      { choices: { reviewer: { cliProviderId: PICKED_CLI, effortLevel: null } } },
      'reviewer',
    ],
    [
      'a default pick made in this task',
      {
        choices: { default: { cliProviderId: PICKED_CLI, effortLevel: null } },
        saved: { default: { cliProviderId: SAVED_CLI, effortLevel: null } },
      },
      'default',
    ],
    [
      'a task pick without a provider row',
      { choices: { default: { cliProviderId: UNLISTED_CLI, effortLevel: null } } },
      'default',
    ],
    [
      'a saved pick without a provider row',
      { saved: { default: { cliProviderId: UNLISTED_CLI, effortLevel: null } } },
      'default',
    ],
    ['nothing saved', {}, 'default'],
  ])('carries no marker for %s', async (_name, opts, role) => {
    expect((await resolve(fakeDb(opts), role)).savedPreference).toBeUndefined();
  });

  it('carries no marker for a saved pick left out under ignore_saved_step_clis', async () => {
    const db = fakeDb({ saved: { default: { cliProviderId: SAVED_CLI, effortLevel: null } } });
    expect((await resolve(db, 'default', true)).savedPreference).toBeUndefined();
  });
});

it('resolves a module dimension seat from its task choice while an unset seat inherits the step default', async () => {
  const fake = createFakeDb({
    taskStepCliChoices: schema.taskStepCliChoices,
    userStepCliRolePreferences: schema.userStepCliRolePreferences,
    userStepCliPreferences: schema.userStepCliPreferences,
  });
  const stepId = 'module.fx.analyze';
  fake.insert(schema.userStepCliPreferences, {
    userId: USER,
    stepId,
    cliProviderId: SAVED_CLI,
    effortLevel: 'low',
    explicit: true,
  });
  fake.insert(schema.taskStepCliChoices, {
    taskId: TASK,
    stepId,
    role: 'security',
    cliProviderId: PICKED_CLI,
    effortLevel: 'high',
  });
  const db = fake.db as unknown as Database;
  expect(
    await resolvePreferredCli(db, USER, stepId, TASK_CLI, PROVIDERS, 'security', TASK, false),
  ).toEqual({ cliProviderId: PICKED_CLI, effortLevel: 'high' });
  expect(
    await resolvePreferredCli(db, USER, stepId, TASK_CLI, PROVIDERS, 'coherence', TASK, false),
  ).toEqual({
    cliProviderId: SAVED_CLI,
    effortLevel: 'low',
    savedPreference: { taskProviderId: TASK_CLI },
  });
});
