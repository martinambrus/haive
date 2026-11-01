import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { configService, TASK_JOB_NAMES } from '@haive/shared';

const h = vi.hoisted(() => ({
  /** What the task queue was asked to enqueue. */
  adds: [] as { name: string; data: unknown }[],
  refusals: 0,
  tries: 0,
}));

vi.mock('../src/redis.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/redis.js')>()),
  getBullRedis: () => ({}),
}));
vi.mock('bullmq', async (importOriginal) => ({
  ...(await importOriginal<typeof import('bullmq')>()),
  Queue: class {
    async add(name: string, data: unknown) {
      h.tries++;
      if (h.refusals-- > 0) throw new Error('the queue refused the job');
      h.adds.push({ name, data });
    }
    async close() {}
  },
}));

import { closePrPollQueue, runPrPollTick } from '../src/queues/pr-poll-queue.js';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const STEP_ROW_ID = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-10-16T12:00:00.000Z');
const TEN_MINUTES_MS = 10 * 60_000;
const INT4_MAX = 2_147_483_647;

const MERGED_TASK = {
  id: TASK_ID,
  userId: USER_ID,
  repositoryId: null,
  prProvider: 'github',
  prNumber: '7',
  prUrl: 'https://github.com/acme/app/pull/7',
  prState: 'merged',
  prFinalizeMode: 'auto',
  prCredentialId: null,
};

interface ParkedStep {
  id: string;
  round: number;
  idleMs: number;
  waitingStartedAt: Date | null;
}

const parkedSinceTenMinutes = (over: Partial<ParkedStep> = {}): ParkedStep => ({
  id: STEP_ROW_ID,
  round: 0,
  idleMs: 5_000,
  waitingStartedAt: new Date(NOW.getTime() - TEN_MINUTES_MS),
  ...over,
});

/** The tick reads one merged task and the step row it parks on; `matched` is what the guarded update
 *  reports it wrote. */
function makeDb(step: ParkedStep | undefined, matched: { id: string }[] = [{ id: STEP_ROW_ID }]) {
  const writes: { table: unknown; values: Record<string, unknown>; where: SQL }[] = [];
  const db = {
    query: {
      tasks: { findMany: async () => [MERGED_TASK] },
      taskSteps: { findFirst: async () => step },
    },
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: (where: SQL) => {
          writes.push({ table, values, where });
          return { returning: async () => matched };
        },
      }),
    }),
  };
  return { db: db as unknown as Database, writes };
}

describe('the PR poller finalizing a merged pull request', () => {
  beforeEach(() => {
    h.adds.length = 0;
    h.refusals = 0;
    h.tries = 0;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await closePrPollQueue();
  });

  it('closes the open wait in the update that writes the form, as the submit route does', async () => {
    const { db, writes } = makeDb(parkedSinceTenMinutes());
    await runPrPollTick(db);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.table).toBe(schema.taskSteps);
    expect(writes[0]!.values.formValues).toEqual({});
    expect(writes[0]!.values.waitingStartedAt).toBeNull();
    expect(writes[0]!.values.idleMs).toBe(5_000 + TEN_MINUTES_MS);
    expect(h.adds).toEqual([
      {
        name: TASK_JOB_NAMES.ADVANCE_STEP,
        data: { taskId: TASK_ID, userId: USER_ID, stepId: '13-pr-wait', round: 0, formValues: {} },
      },
    ]);
  });

  it('retries a refused auto-finalize add after closing the wait and queues exactly one advance', async () => {
    vi.useFakeTimers();
    const { db, writes } = makeDb(parkedSinceTenMinutes());
    h.refusals = 1;

    const finalized = runPrPollTick(db);
    await vi.advanceTimersByTimeAsync(1_000);
    await finalized;

    expect(h.tries).toBe(2);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.values.waitingStartedAt).toBeNull();
    expect(writes[0]!.values.idleMs).toBe(5_000 + TEN_MINUTES_MS);
    expect(h.adds).toEqual([
      {
        name: TASK_JOB_NAMES.ADVANCE_STEP,
        data: { taskId: TASK_ID, userId: USER_ID, stepId: '13-pr-wait', round: 0, formValues: {} },
      },
    ]);
  });

  it('adds nothing to the idle time on a re-drive, once the wait is closed', async () => {
    const { db, writes } = makeDb(parkedSinceTenMinutes({ waitingStartedAt: null }));
    await runPrPollTick(db);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.values.idleMs).toBe(5_000);
    expect(writes[0]!.values.waitingStartedAt).toBeNull();
    expect(h.adds).toHaveLength(1);
  });

  it('keeps the idle time within its integer column', async () => {
    const { db, writes } = makeDb(parkedSinceTenMinutes({ idleMs: INT4_MAX - 1_000 }));
    await runPrPollTick(db);
    expect(writes[0]!.values.idleMs).toBe(INT4_MAX);
    expect(h.adds).toHaveLength(1);
  });

  it('writes and queues nothing when the step is no longer parked', async () => {
    const { db, writes } = makeDb(undefined);
    await runPrPollTick(db);
    expect(writes).toEqual([]);
    expect(h.adds).toEqual([]);
  });

  it('queues nothing when the row moved on between the read and the write', async () => {
    const { db, writes } = makeDb(parkedSinceTenMinutes(), []);
    await runPrPollTick(db);
    expect(writes).toHaveLength(1);
    expect(h.adds).toEqual([]);
  });

  it('writes only while the step still waits on the wait it read', async () => {
    const open = makeDb(parkedSinceTenMinutes());
    await runPrPollTick(open.db);
    const closed = makeDb(parkedSinceTenMinutes({ waitingStartedAt: null }));
    await runPrPollTick(closed.db);
    const dialect = new PgDialect();
    const openQuery = dialect.sqlToQuery(open.writes[0]!.where);
    const closedQuery = dialect.sqlToQuery(closed.writes[0]!.where);
    expect(openQuery.params).toEqual([STEP_ROW_ID, 'waiting_form']);
    expect(openQuery.sql).toMatch(/"status" = \$\d+/);
    expect(openQuery.sql).toContain('"waiting_started_at" is not null');
    expect(closedQuery.params).toEqual([STEP_ROW_ID, 'waiting_form']);
    expect(closedQuery.sql).toMatch(/"status" = \$\d+/);
    expect(closedQuery.sql).toContain('"waiting_started_at" is null');
  });
});
