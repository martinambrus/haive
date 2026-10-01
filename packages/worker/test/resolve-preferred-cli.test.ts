import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import type { Database } from '@haive/database';
import { resolvePreferredCli } from '../src/step-engine/step-runner.js';

const USER = '11111111-1111-4111-8111-111111111111';
const TASK = '22222222-2222-4222-8222-222222222222';
const STEP = '05-phase-0b5-spec-quality';
const TASK_CLI = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SAVED_CLI = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PICKED_CLI = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DISABLED_CLI = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
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
  touched?: string[];
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
      taskStepCliTouched: {
        findFirst: async ({ where }: { where: SQL }) =>
          opts.touched?.includes(roleOf(where)!) ? { role: roleOf(where) } : undefined,
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

  it('falls back to the task CLI when the picked one was disabled since', async () => {
    const db = fakeDb({
      choices: { default: { cliProviderId: DISABLED_CLI, effortLevel: 'max' } },
      saved: { default: { cliProviderId: SAVED_CLI, effortLevel: null } },
    });
    expect(await resolve(db)).toEqual({ cliProviderId: TASK_CLI, effortLevel: null });
  });

  it('still reads the saved preference where this task chose nothing', async () => {
    const db = fakeDb({ saved: { default: { cliProviderId: SAVED_CLI, effortLevel: 'low' } } });
    expect(await resolve(db)).toEqual({ cliProviderId: SAVED_CLI, effortLevel: 'low' });
  });

  it("honours this task's choice under ignore_saved_step_clis with no touch marker", async () => {
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
