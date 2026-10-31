import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';

const url = process.env.PARK_FOLD_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/park_fold_test'))
  throw new Error('Use a dedicated park_fold_test database for the park fold tests');

const USER = '00000000-0000-4000-8000-0000000000f4';
const BLIND_INDEX = 'park-fold-test-user';

const h = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => {
  const queue = () => ({ add: async () => undefined });
  return {
    getTaskQueue: queue,
    getRepoQueue: queue,
    getBundleQueue: queue,
    getCliExecQueue: queue,
    getUsagePollQueue: queue,
  };
});
vi.mock('../src/lib/sandbox-kill.js', () => ({ killTaskSandboxes: async () => 0 }));
vi.mock('../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/middleware/auth.js')>()),
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => unknown) => next(),
}));
vi.mock('@haive/shared', async (importOriginal) => {
  const shared = await importOriginal<typeof import('@haive/shared')>();
  return {
    ...shared,
    configService: {
      get: async () => null,
      getBoolean: async () => false,
      getFresh: async (key: string) =>
        key === shared.CONFIG_KEYS.MAINTENANCE_STATE ? 'normal' : null,
      set: async () => undefined,
    },
  };
});

import { Hono } from 'hono';
import { FIX_LOOP_ACTION_FIELD } from '@haive/shared';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { reofferParkedSteps } from '../src/lib/task-control.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const app = new Hono<AppEnv>();
app.route('/tasks', taskRoutes);
app.onError(errorHandler);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const INT4_MAX = 2_147_483_647;
const PARKED_FOR = 10 * MINUTE;
/** The clock gap between a seed and the statement that reads now(), far below any bug's size. */
const SLACK = MINUTE;
const STEP = '08b-test-management';
const TARGET_STEP = '07-phase-2-implement';

const ago = (ms: number) => new Date(Date.now() - ms);

type RowInsert = Partial<typeof schema.taskSteps.$inferInsert>;
/** What a column did: nothing, filled to the int4 maximum, or grew by about that many ms. */
type Moves = 'stays' | 'fills' | number;

const expectMoved = (column: string, before: number, after: number, moves: Moves) => {
  if (moves === 'stays') {
    expect(after, `${column} stays`).toBe(before);
  } else if (moves === 'fills') {
    expect(after, `${column} fills to the int4 maximum`).toBe(INT4_MAX);
  } else {
    expect(after - before, `${column} grows by about ${moves} ms`).toBeGreaterThan(moves - SLACK);
    expect(after - before, `${column} grows by about ${moves} ms`).toBeLessThan(moves + SLACK);
  }
};

type Case = { name: string; seed: () => RowInsert; idle: Moves; carried: Moves };

/** The park-fold matrix shared by the two writers. `started` is the status a row that is inside its
 *  run carries while it holds a marker: the writer's own (a form for a Retry's re-offer, a CLI
 *  step for a Stop). */
const foldCases = (started: 'waiting_form' | 'waiting_cli'): Case[] => [
  {
    name: 'a row parked before its run (pending, marker, started_at NULL) books its wait to carried_idle_ms and leaves idle_ms alone',
    seed: () => ({ status: 'pending', startedAt: null, waitingStartedAt: ago(PARKED_FOR) }),
    idle: 'stays',
    carried: PARKED_FOR,
  },
  {
    name: `a ${started} row (marker, started_at set) books its wait to idle_ms and leaves carried_idle_ms alone (pin)`,
    seed: () => ({ status: started, startedAt: ago(HOUR), waitingStartedAt: ago(PARKED_FOR) }),
    idle: PARKED_FOR,
    carried: 'stays',
  },
  {
    name: 'a pending row holding a marker AND a started_at is booked by started_at, to idle_ms (pin)',
    seed: () => ({ status: 'pending', startedAt: ago(HOUR), waitingStartedAt: ago(PARKED_FOR) }),
    idle: PARKED_FOR,
    carried: 'stays',
  },
  {
    name: 'a pre-run wait past the int4 range fills carried_idle_ms to 2147483647 instead of raising',
    seed: () => ({
      status: 'pending',
      startedAt: null,
      waitingStartedAt: ago(30 * DAY),
      carriedIdleMs: 0,
    }),
    idle: 'stays',
    carried: 'fills',
  },
  {
    name: 'a pre-run wait on a nearly full carried_idle_ms fills it to 2147483647 instead of raising',
    seed: () => ({
      status: 'pending',
      startedAt: null,
      waitingStartedAt: ago(PARKED_FOR),
      carriedIdleMs: INT4_MAX - 1000,
    }),
    idle: 'stays',
    carried: 'fills',
  },
  {
    name: `a ${started} wait past the int4 range fills idle_ms to 2147483647 and leaves carried_idle_ms alone (pin)`,
    seed: () => ({
      status: started,
      startedAt: ago(HOUR),
      waitingStartedAt: ago(30 * DAY),
      idleMs: 0,
    }),
    idle: 'fills',
    carried: 'stays',
  },
  {
    name: `a ${started} wait on a nearly full idle_ms fills it to 2147483647 instead of raising (pin)`,
    seed: () => ({
      status: started,
      startedAt: ago(HOUR),
      waitingStartedAt: ago(PARKED_FOR),
      idleMs: INT4_MAX - 1000,
    }),
    idle: 'fills',
    carried: 'stays',
  },
];

const NO_WAIT =
  'adds nothing to either column (pin: a missing marker is a wait of 0, not headroom)';

describe.skipIf(!url)('the park wait folded by a Retry re-offer and by a Stop, on Postgres', () => {
  let db: Database;

  const post = (path: string, body?: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });

  const seedTask = async (
    status: (typeof schema.tasks.$inferInsert)['status'],
    over: Partial<typeof schema.tasks.$inferInsert> = {},
  ) => {
    const [row] = await db
      .insert(schema.tasks)
      .values({
        userId: USER,
        type: 'workflow',
        title: 'park-fold',
        status,
        currentStepId: STEP,
        currentRound: 1,
        orchestrationEpoch: 3,
        ...over,
      })
      .returning();
    return row!;
  };
  const seedRow = async (taskId: string, over: RowInsert = {}) => {
    const [row] = await db
      .insert(schema.taskSteps)
      .values({
        taskId,
        stepId: STEP,
        stepIndex: 8.5,
        runSeq: 2,
        round: 1,
        title: 'Test management',
        status: 'pending',
        idleMs: 1234,
        carriedIdleMs: 4321,
        ...over,
      })
      .returning();
    return row!;
  };
  const rowOf = async (id: string) =>
    (await db.query.taskSteps.findFirst({ where: eq(schema.taskSteps.id, id) }))!;

  const reoffer = async (taskId: string) => {
    await db.transaction((tx) => reofferParkedSteps(tx, taskId, new Date(), []));
  };
  const stop = async (taskId: string) => {
    const res = await post(`/tasks/${taskId}/cancel-active-cli`);
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
  };

  beforeAll(async () => {
    db = createDatabase(url as string);
    h.db = db;
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, BLIND_INDEX));
    await db.insert(schema.users).values({
      id: USER,
      emailEncrypted: 'park-fold-test@test.local',
      emailBlindIndex: BLIND_INDEX,
      passwordHash: 'not-real',
      role: 'user',
    });
  });

  beforeEach(async () => {
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, USER));
  });

  afterAll(async () => {
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, BLIND_INDEX));
    await db.$client.end({ timeout: 5 });
  });

  describe.each([
    {
      writer: 'reofferParkedSteps (a task Retry)',
      started: 'waiting_form' as const,
      taskStatus: 'failed' as const,
      run: reoffer,
      endsAs: 'pending',
      unmarked: [
        {
          name: `a waiting_form row with no marker and no started_at ${NO_WAIT}`,
          seed: (): RowInsert => ({ status: 'waiting_form', startedAt: null }),
        },
      ],
    },
    {
      writer: 'failStuckSteps (a Stop)',
      started: 'waiting_cli' as const,
      taskStatus: 'running' as const,
      run: stop,
      endsAs: 'failed',
      unmarked: [
        {
          name: `a pending gate row holding an answer, with no marker and no started_at ${NO_WAIT}`,
          seed: (): RowInsert => ({
            status: 'pending',
            startedAt: null,
            formValues: { [FIX_LOOP_ACTION_FIELD]: 'continue' },
          }),
        },
        {
          name: `a running row with no marker ${NO_WAIT}`,
          seed: (): RowInsert => ({ status: 'running', startedAt: ago(HOUR) }),
        },
      ],
    },
  ])('$writer', ({ started, taskStatus, run, endsAs, unmarked }) => {
    const noWait: Pick<Case, 'idle' | 'carried'> = { idle: 'stays', carried: 'stays' };
    const cases: Case[] = [
      ...foldCases(started),
      ...unmarked.map((u) => ({ name: u.name, seed: u.seed, ...noWait })),
    ];

    it.each(cases)('$name', async ({ seed, idle, carried }) => {
      const task = await seedTask(taskStatus);
      const row = await seedRow(task.id, seed());
      const before = await rowOf(row.id);

      await run(task.id);

      const after = await rowOf(row.id);
      expect(after.status).toBe(endsAs);
      expect(after.waitingStartedAt).toBeNull();
      expectMoved('idle_ms', before.idleMs, after.idleMs, idle);
      expectMoved('carried_idle_ms', before.carriedIdleMs, after.carriedIdleMs, carried);
    });
  });

  describe('a task Retry through the route, which re-offers the parked rows besides the one it re-runs', () => {
    const retry = async (parked: RowInsert) => {
      const task = await seedTask('failed', { currentStepId: TARGET_STEP, currentRound: 1 });
      await seedRow(task.id, {
        stepId: TARGET_STEP,
        runSeq: 4,
        status: 'failed',
        startedAt: ago(HOUR),
        endedAt: ago(5 * MINUTE),
        errorMessage: 'boom',
      });
      const row = await seedRow(task.id, parked);
      const before = await rowOf(row.id);

      const res = await post(`/tasks/${task.id}/action`, { action: 'retry' });

      expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
      return { before, after: await rowOf(row.id) };
    };

    it('books a row parked before its run to carried_idle_ms, not idle_ms', async () => {
      const { before, after } = await retry({
        status: 'pending',
        startedAt: null,
        waitingStartedAt: ago(PARKED_FOR),
      });

      expect(after.status).toBe('pending');
      expect(after.waitingStartedAt).toBeNull();
      expectMoved('idle_ms', before.idleMs, after.idleMs, 'stays');
      expectMoved('carried_idle_ms', before.carriedIdleMs, after.carriedIdleMs, PARKED_FOR);
    });

    it('keeps booking a waiting_form row inside its run to idle_ms (pin)', async () => {
      const { before, after } = await retry({
        status: 'waiting_form',
        startedAt: ago(HOUR),
        waitingStartedAt: ago(PARKED_FOR),
      });

      expect(after.status).toBe('pending');
      expect(after.waitingStartedAt).toBeNull();
      expectMoved('idle_ms', before.idleMs, after.idleMs, PARKED_FOR);
      expectMoved('carried_idle_ms', before.carriedIdleMs, after.carriedIdleMs, 'stays');
    });
  });
});
