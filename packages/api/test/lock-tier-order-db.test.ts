import { and, eq, notInArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDatabase,
  hasPgCode,
  isLockNotAvailable,
  lockStepRows,
  schema,
  type Database,
} from '@haive/database';

const url = process.env.LOCK_TIER_ORDER_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/lock_tier_order_test'))
  throw new Error('Use a dedicated lock_tier_order_test database for the lock tier-order tests');

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000f2');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  queued: [] as { name: string; payload: unknown }[],
  thrown: undefined as unknown,
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => {
  const queue = () => ({
    add: async (name: string, payload: unknown) => {
      h.queued.push({ name, payload });
    },
  });
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
import { TASK_JOB_NAMES } from '@haive/shared';
import { HttpError, type AppEnv } from '../src/context.js';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { resetRowsForRerun } from '../src/routes/tasks/steps.js';
import { cancelLiveRuns } from '../src/lib/task-control.js';

// Lock tiers, as every Retry-family transaction takes them: runs (cli_invocations), then agent minings
// (task_step_agent_minings), then the DAG, then step rows (lockStepRows, id order), then the task row. A writer
// that takes a lower tier after a higher one, or waits for a run from under step rows it already holds, closes a
// cycle with a Retry, a Stop or a pass that takes them in the tiers' order (40P01).
//
// Every case is a two-connection interleave. A peer holds a row of the tier the code under test wants second and
// then wants a row of the tier the code under test already holds. While the code under test waits for the peer's
// first lock, a third connection asks for the higher-tier row with NOWAIT (55P03: the code under test holds it).
//
//   AS    sanity: beside a peer that takes a run and then a mining row, a writer in that order is clean and one in
//         the reverse order is seen holding the mining row and deadlocks, so a setup that cannot cycle fails here.
//         A late sweep that asks for the run with NOWAIT meets the A7 and A7c criteria, so they can be met.
//   A6    the fan-out Resume writes the mining rows of the failed agents and then supersedes the run that blocks
//         the step; a Retry holds that run and wants the mining row.
//   A7    the late sweep (`resetRowsForRerun` with `rowsHeld`) of a Retry or Resume that holds the step rows and
//         the task row waits for the run of a row a pass activated meanwhile; the pass holds that run and then
//         wants the step row (`writeLoginHint`). The sweep must refuse at once (55P03, or a 503) instead.
//   A7c   the same sweep beside a Stop that has ended the live run and then wants the step rows.
//   A7d   the same sweep reached through the Retry action's route, which must answer 503.
const STEP = { id: '00000000-0000-4000-8000-0000000000a1', stepId: 'step-a' } as const;
const LATE = { id: '00000000-0000-4000-8000-0000000000a2', stepId: 'step-b' } as const;
const RUN = '00000000-0000-4000-8000-0000000000c1';
const RUN_LATE = '00000000-0000-4000-8000-0000000000c2';
const MINING = '00000000-0000-4000-8000-0000000000d1';
const OTHER_FAILED_MINING = '00000000-0000-4000-8000-0000000000d2';
const DONE_MINING = '00000000-0000-4000-8000-0000000000d3';
const BLIND_INDEX = 'lock-tier-order-test-user';
const LOGIN_HINT = {
  type: 'cli_login_required',
  providerId: 'lock-tier-order-test-provider',
  providerName: 'claude',
} as const;
const BLOCKED_WITHIN_MS = 10_000;
const REFUSES_WITHIN_MS = 1_000;
const TEST_TIMEOUT = 30_000;

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Lock = (tx: Tx) => PromiseLike<unknown>;
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
type TaskStatus = (typeof schema.tasks.$inferSelect)['status'];
type StepInsert = Partial<typeof schema.taskSteps.$inferInsert>;
type RunInsert = Partial<typeof schema.cliInvocations.$inferInsert>;
type MiningInsert = Partial<typeof schema.taskStepAgentMinings.$inferInsert>;
type RunShape = 'ended' | 'live';
/** A row the probe asks for with NOWAIT; `name` is what a failure message calls it. */
type Held = {
  name: string;
  table:
    | typeof schema.cliInvocations
    | typeof schema.taskStepAgentMinings
    | typeof schema.taskSteps
    | typeof schema.tasks;
  id: string;
};
/** What `expectRefusedAtOnce` reads of a run in which the late sweep was the code under test. */
type LateRun = {
  deadlocked: string[];
  heldWhileWaiting: string[];
  peerOutcome: Outcome<unknown>;
  underTestOutcome: Outcome<unknown>;
  elapsedMs: number;
};

const HELD_MINING: Held = { name: 'M', table: schema.taskStepAgentMinings, id: MINING };
const HELD_STEP: Held = { name: 'S', table: schema.taskSteps, id: STEP.id };

const settle = <T>(run: Promise<T>): Promise<Outcome<T>> =>
  run.then(
    (value): Outcome<T> => ({ ok: true, value }),
    (error: unknown): Outcome<T> => ({ ok: false, error }),
  );

const describeError = (error: unknown): string =>
  hasPgCode(error, '40P01') ? 'deadlock detected (40P01)' : String(error);

const killedByPostgres = (outcome: Outcome<unknown>, side: string): string[] =>
  !outcome.ok && hasPgCode(outcome.error, '40P01') ? [side] : [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const backendPid = async (tx: Tx): Promise<number> => {
  const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
  return row!.pid;
};

const lockRun =
  (id: string, mode: 'update' | 'no key update' = 'no key update'): Lock =>
  (tx) =>
    tx
      .select({ id: schema.cliInvocations.id })
      .from(schema.cliInvocations)
      .where(eq(schema.cliInvocations.id, id))
      .for(mode);

const lockMining =
  (id: string): Lock =>
  (tx) =>
    tx
      .select({ id: schema.taskStepAgentMinings.id })
      .from(schema.taskStepAgentMinings)
      .where(eq(schema.taskStepAgentMinings.id, id))
      .for('no key update');

/** What a pass does once it holds the run (`writeLoginHint`, worker cli-exec/handlers.ts). */
const writeLoginHint =
  (stepRowId: string): Lock =>
  (tx) =>
    tx
      .update(schema.taskSteps)
      .set({ errorHint: LOGIN_HINT, updatedAt: new Date() })
      .where(
        and(
          eq(schema.taskSteps.id, stepRowId),
          notInArray(schema.taskSteps.status, ['pending', 'skipped']),
        ),
      );

/** A Retry's order: the run first, then the mining row. */
const retryOrderPeer = { first: lockRun(RUN), second: lockMining(MINING) };
/** A pass's order: it holds the run, then wants its step row. */
const passPeer = { first: lockRun(RUN, 'update'), second: writeLoginHint(STEP.id) };
/** A Stop's order: its first sweep ends the live runs of the task, then it takes the step rows. */
const stopPeer = (taskId: string) => ({
  first: (tx: Tx) => cancelLiveRuns(tx, taskId, 'user', new Date()),
  second: (tx: Tx) => lockStepRows(tx, eq(schema.taskSteps.taskId, taskId)),
});

/** The refusals a late sweep may end with: a lock-not-available error, or the 503 the route answers. */
const isRefusal = (error: unknown): boolean =>
  isLockNotAvailable(error) || isServiceUnavailable(error);
const isServiceUnavailable = (error: unknown): boolean =>
  error instanceof HttpError && error.status === 503;

const app = new Hono<AppEnv>();
app.route('/tasks', taskRoutes);
// Not the real errorHandler: it answers a 40P01 with a bare 500 and hides which error ended the route.
app.onError((err, c) => {
  h.thrown = err;
  return c.json({ error: 'the route threw' }, 500);
});

describe.skipIf(!url)(
  'the fan-out Resume and the late sweep beside peers that take runs, minings and step rows in the Retry order, on Postgres',
  () => {
    let db: Database;
    let peer: Database;

    beforeAll(async () => {
      db = createDatabase(url as string);
      peer = createDatabase(url as string);
      h.db = db;
      await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, BLIND_INDEX));
      await db.insert(schema.users).values({
        id: USER,
        emailEncrypted: 'lock-tier-order-test@test.local',
        emailBlindIndex: BLIND_INDEX,
        passwordHash: 'not-real',
        role: 'user',
      });
    });

    beforeEach(async () => {
      h.queued = [];
      h.thrown = undefined;
      await db.delete(schema.tasks).where(eq(schema.tasks.userId, USER));
    });

    afterAll(async () => {
      await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, BLIND_INDEX));
      await db.$client.end({ timeout: 5 });
      await peer.$client.end({ timeout: 5 });
    });

    const seedTask = async (
      status: TaskStatus,
      over: Partial<typeof schema.tasks.$inferInsert> = {},
    ) => {
      const [task] = await db
        .insert(schema.tasks)
        .values({
          userId: USER,
          type: 'workflow',
          title: 'lock tier order',
          status,
          orchestrationEpoch: 3,
          ...over,
        })
        .returning({ id: schema.tasks.id });
      return task!.id;
    };

    const seedStep = async (
      taskId: string,
      over: StepInsert = {},
      row: { id: string; stepId: string } = STEP,
    ) => {
      await db.insert(schema.taskSteps).values({
        id: row.id,
        taskId,
        stepId: row.stepId,
        stepIndex: row === LATE ? 2 : 1,
        title: row.stepId,
        status: 'pending',
        ...over,
      });
    };

    /** The run R of the step: `ended` has failed (exit 1), `live` is still running. A step has at most one
     *  live run that is not an agent_mining one, so R is the only run of S. */
    const seedRun = async (taskId: string, shape: RunShape, over: RunInsert = {}) => {
      await db.insert(schema.cliInvocations).values({
        id: RUN,
        taskId,
        taskStepId: STEP.id,
        mode: 'cli',
        prompt: `an ${shape} run of S`,
        startedAt: new Date(Date.now() - 60_000),
        ...(shape === 'ended'
          ? { exitCode: 1, errorMessage: 'the CLI failed', endedAt: new Date(Date.now() - 30_000) }
          : {}),
        ...over,
      });
    };

    const seedMining = async (over: MiningInsert = {}) => {
      await db.insert(schema.taskStepAgentMinings).values({
        id: MINING,
        taskStepId: STEP.id,
        agentId: 'agent-m',
        status: 'failed',
        ...over,
      });
    };

    /** A task whose step S is running with the run R, the row a pass activated meanwhile. */
    const seedLateRow = async (shape: RunShape) => {
      const taskId = await seedTask('running');
      await seedStep(taskId, { status: 'running', startedAt: new Date(Date.now() - 60_000) });
      await seedRun(taskId, shape);
      return { taskId, step: await rowOf(STEP.id) };
    };

    const rowOf = async (id: string) =>
      (await db.query.taskSteps.findFirst({ where: eq(schema.taskSteps.id, id) }))!;
    const taskOf = async (id: string) =>
      (await db.query.tasks.findFirst({ where: eq(schema.tasks.id, id) }))!;
    const runOf = async (id: string) =>
      (await db.query.cliInvocations.findFirst({ where: eq(schema.cliInvocations.id, id) }))!;
    const miningOf = async (id: string) =>
      (await db.query.taskStepAgentMinings.findFirst({
        where: eq(schema.taskStepAgentMinings.id, id),
      }))!;

    /** The rows among `rows` that someone holds right now, asked by a third connection with NOWAIT. */
    const rowsHeld = async (rows: Held[]): Promise<string[]> => {
      const held: string[] = [];
      for (const row of rows) {
        await db
          .transaction((tx) =>
            tx.execute(
              sql`select id from ${row.table} where id = ${row.id} for no key update nowait`,
            ),
          )
          .catch((error: unknown) => {
            if (!isLockNotAvailable(error)) throw error;
            held.push(row.name);
          });
      }
      return held;
    };

    /** Whether some backend waits for a lock the backend `pid` holds. */
    const blockedBy = async (pid: number): Promise<boolean> => {
      const [row] = await db.execute<{ blocked: boolean }>(sql`
        select exists (
          select 1 from pg_stat_activity
          where wait_event_type = 'Lock' and ${pid}::int = any (pg_blocking_pids(pid))
        ) as blocked`);
      return row?.blocked === true;
    };

    const waitUntil = async (condition: () => Promise<boolean>, what: string) => {
      const deadline = Date.now() + BLOCKED_WITHIN_MS;
      while (!(await condition())) {
        if (Date.now() > deadline) throw new Error(`${what} within ${BLOCKED_WITHIN_MS} ms`);
        await sleep(20);
      }
    };

    /** A second connection that takes `first`, and takes `second` and commits once `release` is called. It
     *  returns when `first` is held. */
    async function holdingPeer(first: Lock, second: Lock) {
      let holds!: () => void;
      const holding = new Promise<void>((resolve) => (holds = resolve));
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      const state = { pid: 0, holdsFirst: false };
      const run = settle(
        peer.transaction(async (tx) => {
          state.pid = await backendPid(tx);
          await first(tx);
          state.holdsFirst = true;
          holds();
          await released;
          await second(tx);
        }),
      );
      await Promise.race([holding, run]);
      if (!state.holdsFirst) {
        const early = await run;
        throw new Error(
          `the peer ended before holding its first lock: ${early.ok ? 'no error' : describeError(early.error)}`,
        );
      }
      return { pid: state.pid, release, run };
    }

    /** The peer takes `first`; once the code under test is blocked on it, the peer takes `second` and commits.
     *  `mustNotHold` are the rows asked for with NOWAIT while the code under test waits. A code under test that
     *  is expected to refuse at once (`mayRefuseAtOnce`) may end before it ever waits; the peer then goes on. */
    async function interleave<T>(
      codeUnderTest: () => Promise<T>,
      { first, second }: { first: Lock; second: Lock },
      mustNotHold: Held[],
      { mayRefuseAtOnce = false }: { mayRefuseAtOnce?: boolean } = {},
    ) {
      const holder = await holdingPeer(first, second);

      const startedAt = Date.now();
      let endedAt = 0;
      let underTestEnded = false;
      const underTest = settle(codeUnderTest());
      void underTest.then(() => {
        underTestEnded = true;
        endedAt = Date.now();
      });

      let heldWhileWaiting: string[] = [];
      try {
        const deadline = Date.now() + BLOCKED_WITHIN_MS;
        for (;;) {
          if (underTestEnded) {
            if (mayRefuseAtOnce) break;
            const early = await underTest;
            throw new Error(
              `the code under test ended without waiting for the peer: ${early.ok ? 'no error' : describeError(early.error)}`,
            );
          }
          if (await blockedBy(holder.pid)) {
            heldWhileWaiting = await rowsHeld(mustNotHold);
            break;
          }
          if (Date.now() > deadline) {
            throw new Error(
              `the code under test was not blocked by the peer within ${BLOCKED_WITHIN_MS} ms`,
            );
          }
          await sleep(20);
        }
      } finally {
        holder.release();
        await Promise.all([holder.run, underTest]);
      }

      const [peerOutcome, underTestOutcome] = await Promise.all([holder.run, underTest]);
      return {
        failures: [
          ...(peerOutcome.ok ? [] : [`peer: ${describeError(peerOutcome.error)}`]),
          ...(underTestOutcome.ok
            ? []
            : [`code under test: ${describeError(underTestOutcome.error)}`]),
        ],
        deadlocked: [
          ...killedByPostgres(peerOutcome, 'peer'),
          ...killedByPostgres(underTestOutcome, 'code under test'),
        ],
        heldWhileWaiting,
        peerOutcome,
        underTestOutcome,
        result: underTestOutcome.ok ? underTestOutcome.value : undefined,
        elapsedMs: endedAt - startedAt,
      };
    }
    type Interleaved = Awaited<ReturnType<typeof interleave>>;

    /** Neither side failed and the code under test held none of the higher-tier rows while it waited. */
    const expectClean = ({ failures, heldWhileWaiting }: Interleaved) => {
      const held = heldWhileWaiting.join(', ') || 'no higher-tier row';
      expect(
        failures,
        `while it waited, the code under test held ${held}; ${failures.join('; ') || 'nothing failed'}`,
      ).toEqual([]);
      expect(heldWhileWaiting, 'rows the code under test held while it waited').toEqual([]);
    };

    /** The late sweep ended within a second with a refusal and no side was killed. What it held while it waited
     *  is not asserted (a refusal after a bounded wait meets the criterion too); it is named in the message. */
    const expectRefusedAtOnce = (
      run: LateRun,
      refusal: (error: unknown) => boolean = isRefusal,
    ) => {
      const held = run.heldWhileWaiting.join(', ') || 'nothing';
      const ended = run.underTestOutcome.ok
        ? 'finished without an error'
        : describeError(run.underTestOutcome.error);
      expect(
        run.deadlocked,
        `while the late sweep waited for R it held ${held}; it ended with ${ended} after ${run.elapsedMs} ms; sides killed by Postgres`,
      ).toEqual([]);
      expect(
        run.peerOutcome.ok ? 'finished' : describeError(run.peerOutcome.error),
        'how the peer ended',
      ).toBe('finished');
      expect(
        !run.underTestOutcome.ok && refusal(run.underTestOutcome.error),
        `the late sweep did not refuse: it ${ended}`,
      ).toBe(true);
      expect(run.elapsedMs, 'ms the late sweep took to refuse').toBeLessThan(REFUSES_WITHIN_MS);
    };

    /** The refused sweep rolled back, and the pass's write landed. */
    const expectPassLanded = async (taskId: string, shape: RunShape) => {
      const step = await rowOf(STEP.id);
      expect(step.status, 'S after the refused sweep').toBe('running');
      expect(step.errorHint, 'the pass wrote its hint').toEqual(LOGIN_HINT);
      const run = await runOf(RUN);
      expect(run.supersededAt, 'R after the refused sweep').toBeNull();
      expect(run.endedAt === null, 'R is still live').toBe(shape === 'live');
      expect((await taskOf(taskId)).orchestrationEpoch, 'epoch after the rollback').toBe(3);
    };

    /** The refused sweep rolled back, and the Stop ended the run. */
    const expectStopFinished = async (taskId: string) => {
      expect((await rowOf(STEP.id)).status, 'S after the refused sweep').toBe('running');
      const run = await runOf(RUN);
      expect(run.endedAt, 'the Stop ended R').not.toBeNull();
      expect(run.supersededAt, 'the Stop superseded R').not.toBeNull();
      expect(run.exitCode, 'the Stop killed R').toBe(137);
      expect((await taskOf(taskId)).orchestrationEpoch, 'epoch after the rollback').toBe(3);
    };

    const post = async (path: string, body: Record<string, unknown>) => {
      h.thrown = undefined;
      const res = await app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (h.thrown !== undefined) throw h.thrown;
      return { status: res.status, body: (await res.json()) as unknown };
    };

    const stepAction = (taskId: string, action: 'resume' | 'retry') =>
      post(`/tasks/${taskId}/steps/${STEP.stepId}/action`, { action });

    /** What a Retry or Resume holds once it reaches its late sweep: every step row of the task, and the task row. */
    const holdRowsAndBump = async (tx: Tx, taskId: string) => {
      await lockStepRows(tx, eq(schema.taskSteps.taskId, taskId));
      await tx
        .update(schema.tasks)
        .set({ orchestrationEpoch: sql`${schema.tasks.orchestrationEpoch} + 1` })
        .where(eq(schema.tasks.id, taskId));
    };

    /** What the Retry and the Resume do from there: reset the rows a pass activated meanwhile, rows held. */
    const lateSweep = (taskId: string, step: Awaited<ReturnType<typeof rowOf>>) =>
      db.transaction(async (tx) => {
        await holdRowsAndBump(tx, taskId);
        await resetRowsForRerun(tx, taskId, [step], new Date(), { rowsHeld: true });
      });

    /** The late sweep in the shape the fix is meant to give it: the run of its row is asked for with NOWAIT. */
    const refusingSweep = (taskId: string) =>
      db.transaction(async (tx) => {
        await holdRowsAndBump(tx, taskId);
        await tx
          .select({ id: schema.cliInvocations.id })
          .from(schema.cliInvocations)
          .where(eq(schema.cliInvocations.taskStepId, STEP.id))
          .for('no key update', { noWait: true });
      });

    const lateProbes = (taskId: string): Held[] => [
      HELD_STEP,
      { name: 'T', table: schema.tasks, id: taskId },
    ];

    describe('sanity: the setup can produce the cycle, and the criteria can be met', () => {
      it(
        'AS: a writer taking the run and then the mining row finishes clean beside a peer that takes them in that order',
        async () => {
          const taskId = await seedTask('failed');
          await seedStep(taskId, { status: 'failed' });
          await seedRun(taskId, 'ended');
          await seedMining();

          const run = await interleave(
            () =>
              db.transaction(async (tx) => {
                await lockRun(RUN)(tx);
                await lockMining(MINING)(tx);
              }),
            retryOrderPeer,
            [HELD_MINING],
          );

          expectClean(run);
        },
        TEST_TIMEOUT,
      );

      it(
        'AS: a writer taking the mining row and then the run is seen holding the mining row and deadlocks with that peer',
        async () => {
          const taskId = await seedTask('failed');
          await seedStep(taskId, { status: 'failed' });
          await seedRun(taskId, 'ended');
          await seedMining();

          const run = await interleave(
            () =>
              db.transaction(async (tx) => {
                await lockMining(MINING)(tx);
                await lockRun(RUN)(tx);
              }),
            retryOrderPeer,
            [HELD_MINING],
          );

          expect(
            run.heldWhileWaiting,
            'rows the reverse-order writer held while it waited',
          ).toEqual(['M']);
          expect(run.deadlocked, 'sides killed by Postgres').toHaveLength(1);
          expect(run.failures, 'the only failure is the deadlock').toHaveLength(1);
        },
        TEST_TIMEOUT,
      );

      it(
        'AS: a late sweep that asks for the run with NOWAIT refuses at once beside a pass that holds the run and wants the step row',
        async () => {
          const { taskId } = await seedLateRow('live');

          const run = await interleave(() => refusingSweep(taskId), passPeer, lateProbes(taskId), {
            mayRefuseAtOnce: true,
          });

          expectRefusedAtOnce(run);
          await expectPassLanded(taskId, 'live');
        },
        TEST_TIMEOUT,
      );

      it(
        'AS: a late sweep that asks for the run with NOWAIT refuses at once beside a Stop that has ended the run and wants the step rows',
        async () => {
          const { taskId } = await seedLateRow('live');

          const run = await interleave(
            () => refusingSweep(taskId),
            stopPeer(taskId),
            lateProbes(taskId),
            { mayRefuseAtOnce: true },
          );

          expectRefusedAtOnce(run);
          await expectStopFinished(taskId);
        },
        TEST_TIMEOUT,
      );
    });

    describe('the fan-out Resume', () => {
      it(
        'A6: takes the run that blocks the step before it writes the mining rows, so a Retry holding the run and wanting the mining row does not deadlock it',
        async () => {
          const taskId = await seedTask('failed', { currentStepId: STEP.stepId, currentRound: 0 });
          await seedStep(taskId, { status: 'failed' });
          await seedRun(taskId, 'ended');
          await seedMining();

          const run = await interleave(() => stepAction(taskId, 'resume'), retryOrderPeer, [
            HELD_MINING,
          ]);

          expectClean(run);
          expect(run.result).toMatchObject({
            status: 200,
            body: { ok: true, status: 'running', retriedAgents: 1 },
          });
          expect((await runOf(RUN)).supersededAt).not.toBeNull();
          expect((await miningOf(MINING)).userRetryRequestedAt).not.toBeNull();
          expect((await rowOf(STEP.id)).status).toBe('running');
          expect((await taskOf(taskId)).status).toBe('running');
          expect(h.queued).toMatchObject([
            {
              name: TASK_JOB_NAMES.ADVANCE_STEP,
              payload: { taskId, stepId: STEP.stepId, round: 0, epoch: 4 },
            },
          ]);
        },
        TEST_TIMEOUT,
      );

      it(
        'A6b: with no run that blocks the step, marks the failed mining rows, leaves the finished one and resumes the task',
        async () => {
          const taskId = await seedTask('failed', { currentStepId: STEP.stepId, currentRound: 0 });
          await seedStep(taskId, { status: 'failed' });
          await seedMining();
          await seedMining({ id: OTHER_FAILED_MINING, agentId: 'agent-f' });
          await seedMining({ id: DONE_MINING, agentId: 'agent-d', status: 'done' });

          const result = await stepAction(taskId, 'resume');

          expect(result).toMatchObject({
            status: 200,
            body: { ok: true, status: 'running', retriedAgents: 2 },
          });
          expect((await miningOf(MINING)).userRetryRequestedAt).not.toBeNull();
          expect((await miningOf(OTHER_FAILED_MINING)).userRetryRequestedAt).not.toBeNull();
          expect((await miningOf(DONE_MINING)).userRetryRequestedAt).toBeNull();
          expect((await rowOf(STEP.id)).status).toBe('running');
          expect((await taskOf(taskId)).status).toBe('running');
          expect(h.queued).toMatchObject([
            {
              name: TASK_JOB_NAMES.ADVANCE_STEP,
              payload: { taskId, stepId: STEP.stepId, round: 0, epoch: 4 },
            },
          ]);
        },
        TEST_TIMEOUT,
      );

      it(
        'A6c: with a run that blocks the step and nobody holding it, supersedes the run, marks the mining row and resumes the task',
        async () => {
          const taskId = await seedTask('failed', { currentStepId: STEP.stepId, currentRound: 0 });
          await seedStep(taskId, { status: 'failed' });
          await seedRun(taskId, 'ended');
          await seedMining();

          const result = await stepAction(taskId, 'resume');

          expect(result).toMatchObject({
            status: 200,
            body: { ok: true, status: 'running', retriedAgents: 1 },
          });
          expect((await runOf(RUN)).supersededAt).not.toBeNull();
          expect((await miningOf(MINING)).userRetryRequestedAt).not.toBeNull();
          expect((await rowOf(STEP.id)).status).toBe('running');
          expect((await taskOf(taskId)).status).toBe('running');
          expect(h.queued).toMatchObject([
            {
              name: TASK_JOB_NAMES.ADVANCE_STEP,
              payload: { taskId, stepId: STEP.stepId, round: 0, epoch: 4 },
            },
          ]);
        },
        TEST_TIMEOUT,
      );
    });

    describe('the late sweep of a Retry or Resume that holds the step rows and the task row', () => {
      const shapes = [
        ['R ended with an error', 'ended'],
        ['R live', 'live'],
      ] as const;

      for (const [label, shape] of shapes) {
        it(
          `A7 (${label}): refuses at once instead of waiting for the run a pass holds, so the pass that then wants the step row does not deadlock it`,
          async () => {
            const { taskId, step } = await seedLateRow(shape);

            const run = await interleave(
              () => lateSweep(taskId, step),
              passPeer,
              lateProbes(taskId),
              { mayRefuseAtOnce: true },
            );

            expectRefusedAtOnce(run);
            await expectPassLanded(taskId, shape);
          },
          TEST_TIMEOUT,
        );

        it(
          `A7b (${label}, pin): with nobody holding the run, finishes, supersedes the run and resets the row`,
          async () => {
            const { taskId, step } = await seedLateRow(shape);

            await lateSweep(taskId, step);

            expect((await runOf(RUN)).supersededAt).not.toBeNull();
            expect((await rowOf(STEP.id)).status).toBe('pending');
            expect((await taskOf(taskId)).orchestrationEpoch).toBe(4);
          },
          TEST_TIMEOUT,
        );
      }

      it(
        'A7c: refuses at once instead of waiting for the live run a Stop has ended, so the Stop that then wants the step rows finishes',
        async () => {
          const { taskId, step } = await seedLateRow('live');

          const run = await interleave(
            () => lateSweep(taskId, step),
            stopPeer(taskId),
            lateProbes(taskId),
            { mayRefuseAtOnce: true },
          );

          expectRefusedAtOnce(run);
          await expectStopFinished(taskId);
        },
        TEST_TIMEOUT,
      );

      it(
        'A7d: the Retry action answers 503 at once when the run of a row a pass activated meanwhile is held, instead of waiting for it with the step rows and the task row held',
        async () => {
          const taskId = await seedTask('failed', { currentStepId: STEP.stepId, currentRound: 0 });
          await seedStep(taskId, { status: 'failed' });
          await seedRun(taskId, 'ended');
          await seedStep(taskId, {}, LATE);

          // The Retry reads the task, then waits for the run of its clicked step: a peer holds that run. While it
          // waits, a pass activates the idle row LATE and holds its run, as writeLoginHint does.
          const stall = await holdingPeer(lockRun(RUN, 'update'), async () => undefined);
          let retryEndedAt = 0;
          const retry = settle(stepAction(taskId, 'retry'));
          void retry.then(() => (retryEndedAt = Date.now()));
          let pass: Awaited<ReturnType<typeof holdingPeer>> | undefined;
          let releasedAt = 0;
          let heldWhileWaiting: string[] = [];
          try {
            await waitUntil(() => blockedBy(stall.pid), 'the Retry was not blocked by the stall');
            await db
              .update(schema.taskSteps)
              .set({ status: 'running', startedAt: new Date() })
              .where(eq(schema.taskSteps.id, LATE.id));
            await db.insert(schema.cliInvocations).values({
              id: RUN_LATE,
              taskId,
              taskStepId: LATE.id,
              mode: 'cli',
              prompt: 'a live run of LATE',
              startedAt: new Date(),
            });
            pass = await holdingPeer(lockRun(RUN_LATE, 'update'), writeLoginHint(LATE.id));
            const passPid = pass.pid;

            releasedAt = Date.now();
            stall.release();
            await waitUntil(
              async () => retryEndedAt > 0 || (await blockedBy(passPid)),
              'the Retry neither ended nor waited for the pass',
            );
            if (retryEndedAt === 0) {
              heldWhileWaiting = await rowsHeld([
                { name: 'L', table: schema.taskSteps, id: LATE.id },
                { name: 'T', table: schema.tasks, id: taskId },
              ]);
            }
          } finally {
            stall.release();
            pass?.release();
          }
          const [stallOutcome, passOutcome, retryOutcome] = await Promise.all([
            stall.run,
            pass ? pass.run : Promise.resolve<Outcome<unknown>>({ ok: true, value: undefined }),
            retry,
          ]);

          expect(stallOutcome.ok, 'the peer that stalled the Retry').toBe(true);
          expectRefusedAtOnce(
            {
              deadlocked: [
                ...killedByPostgres(passOutcome, 'peer'),
                ...killedByPostgres(retryOutcome, 'code under test'),
              ],
              heldWhileWaiting,
              peerOutcome: passOutcome,
              underTestOutcome: retryOutcome,
              elapsedMs: retryEndedAt - releasedAt,
            },
            isServiceUnavailable,
          );
          expect(await rowOf(STEP.id), 'the clicked step after the 503').toMatchObject({
            status: 'failed',
          });
          expect((await runOf(RUN)).supersededAt, 'the run of the clicked step').toBeNull();
          expect(await rowOf(LATE.id), 'the late row after the 503').toMatchObject({
            status: 'running',
            errorHint: LOGIN_HINT,
          });
          expect((await runOf(RUN_LATE)).supersededAt, 'the run of the late row').toBeNull();
          expect(await taskOf(taskId)).toMatchObject({ status: 'failed', orchestrationEpoch: 3 });
          expect(h.queued, 'jobs queued by the refused Retry').toEqual([]);
        },
        TEST_TIMEOUT,
      );
    });
  },
);
