import { getTableName } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { configService } from '@haive/shared';
import { markTaskRunningWithStep, markTaskWaiting } from '../src/queues/task-queue.js';
import { autoResumeFailedStep } from '../src/queues/_step-reset.js';

vi.mock('../src/db.js', () => ({
  getDb: vi.fn(() => {
    throw new Error('no database in this test');
  }),
}));

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000c1';
const TASK = '00000000-0000-4000-8000-000000000001';
const ROW = '00000000-0000-4000-8000-0000000000d1';
const STEP = '11d-skill-sync';
const FENCE = 'select pg_advisory_xact_lock_shared(hashtextextended($1, 0))';
const READS_STATE = 'reads the state';

/** A failed task; `log` lists what each transaction sends, in order: locks, state reads, updates. */
function setup(status: 'failed' | 'running' = 'failed') {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
    cliInvocations: schema.cliInvocations,
    taskStepAgentMinings: schema.taskStepAgentMinings,
    repositories: schema.repositories,
    onboardingArtifacts: schema.onboardingArtifacts,
    projectStateConflicts: schema.projectStateConflicts,
  });
  fake.insert(schema.repositories, { id: REPO, userId: USER, name: 'repo', status: 'ready' });
  fake.insert(schema.tasks, {
    id: TASK,
    userId: USER,
    repositoryId: REPO,
    type: 'workflow',
    title: 'failed',
    status,
    errorMessage: status === 'failed' ? 'boom' : null,
    orchestrationEpoch: 3,
    currentStepId: STEP,
    completedAt: fake.now(),
    allowanceAutoResumeCount: 0,
  });
  fake.insert(schema.taskSteps, {
    id: ROW,
    taskId: TASK,
    stepId: STEP,
    round: 0,
    status: 'failed',
    errorMessage: 'boom',
  });
  const log: string[] = [];
  const dialect = new PgDialect();
  const db = {
    ...fake.db,
    transaction: (fn: (tx: unknown) => Promise<unknown>) =>
      fake.db.transaction((tx) =>
        fn({
          ...tx,
          execute: async (query: Parameters<typeof tx.execute>[0]) => {
            log.push(dialect.sqlToQuery(query as never).sql);
            return tx.execute(query);
          },
        }),
      ),
  } as unknown as Database;
  fake.hooks.beforeUpdate = (table) => {
    log.push(`updates ${getTableName(table)}`);
  };
  const stored = (value: string) =>
    vi.spyOn(configService, 'getFresh').mockImplementation(async () => {
      log.push(READS_STATE);
      return value;
    });
  const task = () => fake.rows(schema.tasks).find((r) => r.id === TASK)!;
  const events = () => fake.rows(schema.taskEvents).map((r) => r.eventType);
  const revive = () =>
    markTaskRunningWithStep(db, TASK, STEP, 1, 0, { epoch: 3, reviveFailed: true });
  const park = () =>
    markTaskWaiting(db, TASK, STEP, 1, 0, 'waiting_user', { epoch: 3, reviveFailed: true });
  const resume = () =>
    autoResumeFailedStep(db, {
      taskId: TASK,
      stepId: STEP,
      round: 0,
      providerId: null,
      via: 'test',
      watchSince: null,
    });
  return { fake, log, stored, task, events, revive, park, resume };
}

afterEach(() => vi.restoreAllMocks());

describe.each([
  {
    write: 'a pointer write',
    reopen: (t: ReturnType<typeof setup>) => t.revive(),
    lands: 'running',
  },
  { write: 'a park', reopen: (t: ReturnType<typeof setup>) => t.park(), lands: 'waiting_user' },
])('$write that reopens a failed task', ({ reopen, lands }) => {
  it('takes the shared fence first, reads the state under it, and only then writes', async () => {
    const t = setup();
    t.stored('normal');

    expect(await reopen(t)).toBe(true);

    expect(t.log.slice(0, 2)).toEqual([FENCE, READS_STATE]);
    expect(t.log.indexOf('updates tasks')).toBeGreaterThan(1);
    expect(t.task()).toMatchObject({ status: lands });
  });

  it.each(['draining', 'maintenance'])(
    'reopens nothing and writes nothing when the system is %s under the fence',
    async (state) => {
      const t = setup();
      t.stored(state);

      await expect(reopen(t)).rejects.toMatchObject({ name: 'NewWorkHeld' });

      expect(t.task()).toMatchObject({ status: 'failed', errorMessage: 'boom' });
      expect(t.events()).toEqual([]);
      expect(t.log).toEqual([FENCE, READS_STATE]);
    },
  );

  it('writes when the task is no longer failed, whatever the system holds', async () => {
    const t = setup('running');
    t.stored('draining');

    expect(await reopen(t)).toBe(true);
    expect(t.task()).toMatchObject({ status: lands });
  });

  it('writes when the stored state cannot be read', async () => {
    const t = setup();
    vi.spyOn(configService, 'getFresh').mockRejectedValue(new Error('redis went away'));

    expect(await reopen(t)).toBe(true);
    expect(t.task()).toMatchObject({ status: lands });
  });
});

describe('the allowance auto-resume of a failed task', () => {
  it('takes the shared fence first, reads the state under it, and only then writes', async () => {
    const t = setup();
    t.stored('normal');

    expect(await t.resume()).toBe(true);

    expect(t.log.slice(0, 2)).toEqual([FENCE, READS_STATE]);
    expect(t.log.indexOf('updates task_steps')).toBeGreaterThan(1);
    expect(t.task()).toMatchObject({ status: 'running', allowanceAutoResumeCount: 1 });
  });

  it.each(['draining', 'maintenance'])(
    'resumes nothing and writes nothing when the system is %s under the fence',
    async (state) => {
      const t = setup();
      t.stored(state);

      await expect(t.resume()).rejects.toMatchObject({ name: 'NewWorkHeld' });

      expect(t.task()).toMatchObject({ status: 'failed', allowanceAutoResumeCount: 0 });
      expect(t.fake.rows(schema.taskSteps)[0]).toMatchObject({ status: 'failed' });
      expect(t.events()).toEqual([]);
      expect(t.log).toEqual([FENCE, READS_STATE]);
    },
  );

  it('answers false for a task that is no longer failed, whatever the system holds', async () => {
    const t = setup('running');
    t.stored('draining');

    expect(await t.resume()).toBe(false);
  });
});
