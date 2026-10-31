import { eq, sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';

const url = process.env.STEP_FOLD_PREREAD_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/step_fold_preread_test'))
  throw new Error(
    'Use a dedicated step_fold_preread_test database for the step fold pre-read tests',
  );

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000f2');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  thrown: undefined as unknown,
  /** What the task queue was asked to enqueue. */
  jobs: [] as { name: string; data: unknown }[],
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => {
  const queue = () => ({
    add: async (name: string, data: unknown) => {
      h.jobs.push({ name, data });
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
import { MODEL_HEALTH_STEP_IDS, PROVIDER_SENSITIVE_STEP_IDS } from '@haive/shared';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { resetRowsForRerun } from '../src/routes/tasks/steps.js';
import type { AppEnv } from '../src/context.js';

// Every case seeds one step row with live idle_ms 4000 and user_active_ms 800 and carried work / idle /
// user of 1000 / 200 / 50. A peer transaction on a second connection adds 7000 / 3000 / 500 to
// carried_* and 2000 to idle_ms and holds the row. The writer under test starts, is seen waiting for the
// peer, and the peer commits. The writer must fold the row as the peer left it (idle_ms 6000), so the
// final carried_* is the seed, plus the peer's share, plus that fold. A writer that folds the row it
// read before the peer's commit writes carried_* without the peer's share.
// F2b and F3b seed a second row with the higher id. F3b's peer finishes the first row instead of folding it.
const STEP = {
  id: '00000000-0000-4000-8000-0000000000a1',
  stepId: PROVIDER_SENSITIVE_STEP_IDS[0]!,
  index: 1,
} as const;
// A second row with the higher id, so a batch taken in id order reaches STEP first and OTHER second.
const OTHER = {
  id: '00000000-0000-4000-8000-0000000000b1',
  stepId: PROVIDER_SENSITIVE_STEP_IDS[1]!,
  index: 2,
} as const;
// The one step Skip accepts here: the static flags answer while step_catalog is empty, and list it as skippable.
const SKIPPABLE = {
  id: '00000000-0000-4000-8000-0000000000c1',
  stepId: '11g-save-database',
  index: 3,
} as const;
// The model-health canary: a CLI swap on it also rewrites the task's default CLI and records the change.
const CANARY = {
  id: '00000000-0000-4000-8000-0000000000d1',
  stepId: MODEL_HEALTH_STEP_IDS[1]!,
  index: 0,
} as const;
const BLIND_INDEX = 'step-fold-preread-test-user';
const BLOCKED_WITHIN_MS = 10_000;
const TEST_TIMEOUT = 30_000;
// H cases: a form row parked this long, whose idle_ms a peer adds to while the writer waits for the row.
const PARKED_FOR_MS = 10 * 60_000;
const PEER_IDLE_MS = 20_000;

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
type TaskStatus = (typeof schema.tasks.$inferSelect)['status'];
type StepInsert = Partial<typeof schema.taskSteps.$inferInsert>;

const settle = <T>(run: Promise<T>): Promise<Outcome<T>> =>
  run.then(
    (value): Outcome<T> => ({ ok: true, value }),
    (error: unknown): Outcome<T> => ({ ok: false, error }),
  );

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const backendPid = async (tx: Tx): Promise<number> => {
  const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
  return row!.pid;
};

const app = new Hono<AppEnv>();
app.route('/tasks', taskRoutes);
app.onError((err, c) => {
  h.thrown = err;
  return c.json({ error: 'the route threw' }, 500);
});

describe.skipIf(!url)(
  'step folds and the CLI switch beside a peer that changes the row after the writer read it, on Postgres',
  () => {
    let db: Database;
    let peer: Database;
    let providerId: string;

    beforeAll(async () => {
      db = createDatabase(url as string);
      peer = createDatabase(url as string);
      h.db = db;
      await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, BLIND_INDEX));
      await db.insert(schema.users).values({
        id: USER,
        emailEncrypted: 'step-fold-preread-test@test.local',
        emailBlindIndex: BLIND_INDEX,
        passwordHash: 'not-real',
        role: 'user',
      });
      const [provider] = await db
        .insert(schema.cliProviders)
        .values({ userId: USER, name: 'claude-code', label: 'step fold pre-read', enabled: true })
        .returning({ id: schema.cliProviders.id });
      providerId = provider!.id;
    });

    beforeEach(async () => {
      h.jobs.length = 0;
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
          title: 'step fold pre-read',
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
      which: { id: string; stepId: string; index: number } = STEP,
    ) => {
      const [row] = await db
        .insert(schema.taskSteps)
        .values({
          id: which.id,
          taskId,
          stepId: which.stepId,
          stepIndex: which.index,
          runSeq: which.index,
          title: which.stepId,
          status: 'pending',
          idleMs: 4000,
          userActiveMs: 800,
          carriedWorkMs: 1000,
          carriedIdleMs: 200,
          carriedUserActiveMs: 50,
          ...over,
        })
        .returning();
      return row!;
    };

    const finalRow = async (id: string = STEP.id) => {
      const [row] = await db
        .select({
          status: schema.taskSteps.status,
          idleMs: schema.taskSteps.idleMs,
          userActiveMs: schema.taskSteps.userActiveMs,
          carriedWorkMs: schema.taskSteps.carriedWorkMs,
          carriedIdleMs: schema.taskSteps.carriedIdleMs,
          carriedUserActiveMs: schema.taskSteps.carriedUserActiveMs,
        })
        .from(schema.taskSteps)
        .where(eq(schema.taskSteps.id, id));
      return row!;
    };

    const peerFolds = (id: string) => (tx: Tx) =>
      tx.execute(sql`
        update task_steps set
          carried_work_ms = carried_work_ms + 7000,
          carried_idle_ms = carried_idle_ms + 3000,
          carried_user_active_ms = carried_user_active_ms + 500,
          idle_ms = idle_ms + 2000
        where id = ${id}`);

    async function besidePeer<T>(
      codeUnderTest: () => Promise<T>,
      peerWrites: (tx: Tx) => Promise<unknown> = peerFolds(STEP.id),
    ): Promise<T> {
      let peerHolds!: () => void;
      const holding = new Promise<void>((resolve) => (peerHolds = resolve));
      let proceed!: () => void;
      const proceeding = new Promise<void>((resolve) => (proceed = resolve));
      let peerPid = 0;
      let holdsRow = false;
      const peerRun = settle(
        peer.transaction(async (tx) => {
          peerPid = await backendPid(tx);
          await peerWrites(tx);
          holdsRow = true;
          peerHolds();
          await proceeding;
        }),
      );
      await Promise.race([holding, peerRun]);
      if (!holdsRow) {
        const early = await peerRun;
        throw new Error(
          `the peer ended before holding the row: ${early.ok ? 'no error' : String(early.error)}`,
        );
      }

      let underTestEnded = false;
      const underTest = settle(codeUnderTest());
      void underTest.then(() => (underTestEnded = true));

      try {
        const deadline = Date.now() + BLOCKED_WITHIN_MS;
        for (;;) {
          if (underTestEnded) {
            const early = await underTest;
            throw new Error(
              `the code under test ended without waiting for the peer: ${early.ok ? 'no error' : String(early.error)}`,
            );
          }
          const [row] = await db.execute<{ blocked: boolean }>(sql`
            select exists (
              select 1 from pg_stat_activity
              where wait_event_type = 'Lock' and ${peerPid}::int = any (pg_blocking_pids(pid))
            ) as blocked`);
          if (row?.blocked) break;
          if (Date.now() > deadline) {
            throw new Error(
              `the code under test was not blocked by the peer within ${BLOCKED_WITHIN_MS} ms`,
            );
          }
          await sleep(20);
        }
      } finally {
        proceed();
        await Promise.all([peerRun, underTest]);
      }

      const [peerOutcome, underTestOutcome] = await Promise.all([peerRun, underTest]);
      if (!peerOutcome.ok) throw peerOutcome.error;
      if (!underTestOutcome.ok) throw underTestOutcome.error;
      return underTestOutcome.value;
    }

    const patch = async (path: string, body: Record<string, unknown>) => {
      h.thrown = undefined;
      const res = await app.request(path, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (h.thrown !== undefined) throw h.thrown;
      return { status: res.status, body: (await res.json()) as unknown };
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

    it(
      'F1: resetRowsForRerun folds the row as a peer left it while the reset waited, not the row its caller read',
      async () => {
        const taskId = await seedTask('failed');
        const stale = await seedStep(taskId, {
          status: 'done',
          startedAt: new Date('2026-01-01T00:00:00Z'),
          endedAt: new Date('2026-01-01T00:01:00Z'),
        });

        await besidePeer(() =>
          db.transaction((tx) => resetRowsForRerun(tx, taskId, [stale], new Date())),
        );

        expect(await finalRow()).toEqual({
          status: 'pending',
          idleMs: 0,
          userActiveMs: 0,
          carriedWorkMs: 1000 + 7000 + (60_000 - 6000),
          carriedIdleMs: 200 + 3000 + 6000,
          carriedUserActiveMs: 50 + 500 + 800,
        });
      },
      TEST_TIMEOUT,
    );

    it(
      'F2: the per-step CLI switch folds the row as a peer left it while the switch waited, not the row it read first',
      async () => {
        const taskId = await seedTask('running');
        await seedStep(taskId);

        const response = await besidePeer(() =>
          patch(`/tasks/${taskId}/steps/${STEP.stepId}/cli-provider`, { cliProviderId: null }),
        );

        expect(response).toMatchObject({ status: 200, body: { ok: true } });
        expect(await finalRow()).toEqual({
          status: 'pending',
          idleMs: 0,
          userActiveMs: 0,
          carriedWorkMs: 1000 + 7000,
          carriedIdleMs: 200 + 3000 + 6000,
          carriedUserActiveMs: 50 + 500 + 800,
        });
      },
      TEST_TIMEOUT,
    );

    it(
      'F2b: the per-step CLI switch that moves the task folds the clicked row as a peer left it while its batch waited',
      async () => {
        const taskId = await seedTask('failed', { currentStepId: OTHER.stepId, currentRound: 0 });
        await seedStep(taskId, { status: 'running', startedAt: new Date(Date.now() - 60_000) });
        await seedStep(taskId, { status: 'failed' }, OTHER);

        const response = await besidePeer(
          () =>
            patch(`/tasks/${taskId}/steps/${OTHER.stepId}/cli-provider`, { cliProviderId: null }),
          peerFolds(OTHER.id),
        );

        expect(response).toMatchObject({ status: 200, body: { ok: true } });
        expect(await finalRow(OTHER.id)).toEqual({
          status: 'pending',
          idleMs: 0,
          userActiveMs: 0,
          carriedWorkMs: 1000 + 7000,
          carriedIdleMs: 200 + 3000 + 6000,
          carriedUserActiveMs: 50 + 500 + 800,
        });
        expect((await finalRow(STEP.id)).status).toBe('pending');
      },
      TEST_TIMEOUT,
    );

    it(
      'F3: the task-level CLI switch folds the row as a peer left it while the switch waited, not the row it read first',
      async () => {
        const taskId = await seedTask('running');
        await seedStep(taskId);

        const response = await besidePeer(() =>
          patch(`/tasks/${taskId}/cli-provider`, { cliProviderId: null }),
        );

        expect(response).toMatchObject({
          status: 200,
          body: { ok: true, invalidatedSteps: [STEP.stepId] },
        });
        expect(await finalRow()).toEqual({
          status: 'pending',
          idleMs: 0,
          userActiveMs: 0,
          carriedWorkMs: 1000 + 7000,
          carriedIdleMs: 200 + 3000 + 6000,
          carriedUserActiveMs: 50 + 500 + 800,
        });
      },
      TEST_TIMEOUT,
    );

    it(
      'F3b: a step that finished while the task-level switch waited is left as it is and not reported',
      async () => {
        const taskId = await seedTask('running');
        await seedStep(taskId, { status: 'running', startedAt: new Date(Date.now() - 60_000) });
        await seedStep(taskId, {}, OTHER);

        const response = await besidePeer(
          () => patch(`/tasks/${taskId}/cli-provider`, { cliProviderId: null }),
          (tx) =>
            tx.execute(
              sql`update task_steps set status = 'done', ended_at = now() where id = ${STEP.id}`,
            ),
        );

        expect(response).toMatchObject({
          status: 200,
          body: { ok: true, invalidatedSteps: [OTHER.stepId] },
        });
        expect((await finalRow(STEP.id)).status).toBe('done');
        expect((await finalRow(OTHER.id)).status).toBe('pending');
      },
      TEST_TIMEOUT,
    );

    // H1-H3 close a parked form's wait into idle_ms: the row is parked PARKED_FOR_MS with idle_ms 4000, and the
    // peer adds PEER_IDLE_MS to idle_ms and holds the row. The final idle_ms is the seed, plus the peer's share,
    // plus the wait up to the moment the writer ran (between `before` and `after`). A writer that adds the wait to
    // the idle_ms it read before the peer committed writes 4000 plus the wait and takes the peer's share back.
    const peerAddsIdle = (id: string) => (tx: Tx) =>
      tx.execute(sql`update task_steps set idle_ms = idle_ms + ${PEER_IDLE_MS} where id = ${id}`);

    const seedParkedForm = async (
      taskId: string,
      which: { id: string; stepId: string; index: number } = STEP,
    ) => {
      const parkedAt = new Date(Date.now() - PARKED_FOR_MS);
      await seedStep(
        taskId,
        {
          status: 'waiting_form',
          startedAt: new Date(parkedAt.getTime() - 60_000),
          waitingStartedAt: parkedAt,
        },
        which,
      );
      return parkedAt;
    };

    const wholeRow = async (id: string = STEP.id) => {
      const [row] = await db.select().from(schema.taskSteps).where(eq(schema.taskSteps.id, id));
      return row!;
    };

    const choiceRows = (taskId: string) =>
      db
        .select({
          stepId: schema.taskStepCliChoices.stepId,
          cliProviderId: schema.taskStepCliChoices.cliProviderId,
        })
        .from(schema.taskStepCliChoices)
        .where(eq(schema.taskStepCliChoices.taskId, taskId));

    const eventTypes = async (taskId: string) =>
      (
        await db
          .select({ type: schema.taskEvents.eventType })
          .from(schema.taskEvents)
          .where(eq(schema.taskEvents.taskId, taskId))
      ).map((e) => e.type);

    const taskRow = async (taskId: string) => {
      const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId));
      return row!;
    };

    const expectIdleIncludesPeer = (
      idleMs: number,
      parkedAt: Date,
      window: { before: number; after: number },
    ) => {
      const seeded = 4000 + PEER_IDLE_MS;
      expect(idleMs, 'idle_ms: the seed, the peer and the wait').toBeGreaterThanOrEqual(
        seeded + (window.before - parkedAt.getTime()),
      );
      expect(idleMs, 'idle_ms: the seed, the peer and the wait').toBeLessThanOrEqual(
        seeded + (window.after - parkedAt.getTime()),
      );
    };

    it(
      'H1: the form submit adds the wait to the idle_ms a peer left, not to the one it read first',
      async () => {
        const taskId = await seedTask('running');
        const parkedAt = await seedParkedForm(taskId);

        const before = Date.now();
        const response = await besidePeer(
          () => post(`/tasks/${taskId}/steps/${STEP.stepId}/submit`, { values: { answer: 'yes' } }),
          peerAddsIdle(STEP.id),
        );
        const after = Date.now();

        expect(response).toMatchObject({ status: 200, body: { ok: true, queued: true } });
        const row = await wholeRow();
        expect(row).toMatchObject({
          status: 'waiting_form',
          waitingStartedAt: null,
          formValues: { answer: 'yes' },
        });
        expectIdleIncludesPeer(row.idleMs, parkedAt, { before, after });
      },
      TEST_TIMEOUT,
    );

    it(
      'H2: the merge clarification answer adds the wait to the idle_ms a peer left, not to the one it read first',
      async () => {
        const taskId = await seedTask('running');
        const parkedAt = await seedParkedForm(taskId);

        const before = Date.now();
        const response = await besidePeer(
          () => post(`/tasks/${taskId}/steps/${STEP.stepId}/clarify`, { answer: 'keep both' }),
          peerAddsIdle(STEP.id),
        );
        const after = Date.now();

        expect(response).toMatchObject({ status: 200, body: { ok: true, queued: true } });
        const row = await wholeRow();
        expect(row).toMatchObject({ status: 'waiting_form', waitingStartedAt: null });
        expectIdleIncludesPeer(row.idleMs, parkedAt, { before, after });
      },
      TEST_TIMEOUT,
    );

    it(
      'H3: Skip adds the wait to the idle_ms a peer left, not to the one it read first',
      async () => {
        const taskId = await seedTask('running', { currentStepId: SKIPPABLE.stepId });
        const parkedAt = await seedParkedForm(taskId, SKIPPABLE);

        const before = Date.now();
        const response = await besidePeer(
          () => post(`/tasks/${taskId}/steps/${SKIPPABLE.stepId}/action`, { action: 'skip' }),
          peerAddsIdle(SKIPPABLE.id),
        );
        const after = Date.now();

        expect(response).toMatchObject({ status: 200, body: { ok: true, status: 'skipped' } });
        const row = await wholeRow(SKIPPABLE.id);
        expect(row).toMatchObject({ status: 'skipped', waitingStartedAt: null });
        expectIdleIncludesPeer(row.idleMs, parkedAt, { before, after });
      },
      TEST_TIMEOUT,
    );

    // H4 and H5: a pass activates the row between the handler's read of its status and the row lock. The peer
    // flips it as the pass does, the claim of a pending row and the flip of an answered form, and the switch
    // that read the row first must refuse it as it refuses a row it read live, leaving the row as the pass has it
    // and saving no choice: the refusal changes nothing, as the one on the first read does.
    const peerClaims = (id: string) => (tx: Tx) =>
      tx.execute(sql`
        update task_steps set status = 'running', started_at = now()
        where id = ${id} and status in ('pending', 'waiting_form')`);

    it.each([
      ['H4', 'pending'],
      ['H5', 'waiting_form'],
    ] as const)(
      '%s: the per-step CLI switch refuses a %s row that a pass activated after the status was read',
      async (_label, readAs) => {
        const taskId = await seedTask('running');
        await seedStep(taskId, { status: readAs });

        const outcome = await settle(
          besidePeer(
            () =>
              patch(`/tasks/${taskId}/steps/${STEP.stepId}/cli-provider`, { cliProviderId: null }),
            peerClaims(STEP.id),
          ),
        );

        expect.soft(outcome).toMatchObject({
          ok: false,
          error: { status: 409, message: 'Cannot change provider while step is running' },
        });
        expect.soft(await finalRow()).toEqual({
          status: 'running',
          idleMs: 4000,
          userActiveMs: 800,
          carriedWorkMs: 1000,
          carriedIdleMs: 200,
          carriedUserActiveMs: 50,
        });
        expect.soft(await choiceRows(taskId), 'task_step_cli_choices').toEqual([]);
      },
      TEST_TIMEOUT,
    );

    // The model-health canary also rewrites the task's default CLI and records that, so a refused switch on it
    // must leave those alone too.
    const canaryPatch = (taskId: string) =>
      patch(`/tasks/${taskId}/steps/${CANARY.stepId}/cli-provider`, { cliProviderId: providerId });

    it(
      'H4c: a refused switch on the model-health canary leaves the task default, the choice and the event alone',
      async () => {
        const taskId = await seedTask('running');
        await seedStep(taskId, {}, CANARY);

        const outcome = await settle(besidePeer(() => canaryPatch(taskId), peerClaims(CANARY.id)));

        expect.soft(outcome).toMatchObject({
          ok: false,
          error: { status: 409, message: 'Cannot change provider while step is running' },
        });
        expect.soft((await wholeRow(CANARY.id)).status).toBe('running');
        expect.soft(await choiceRows(taskId), 'task_step_cli_choices').toEqual([]);
        expect.soft((await taskRow(taskId)).cliProviderId, 'tasks.cli_provider_id').toBeNull();
        expect.soft(await eventTypes(taskId)).not.toContain('task.cli_provider_changed');
      },
      TEST_TIMEOUT,
    );

    it('H4d: a switch on the model-health canary that nothing refuses saves the choice, rewrites the task default and records it', async () => {
      const taskId = await seedTask('running');
      await seedStep(taskId, {}, CANARY);

      const response = await canaryPatch(taskId);

      expect(response).toMatchObject({ status: 200, body: { ok: true } });
      expect((await wholeRow(CANARY.id)).status).toBe('pending');
      expect(await choiceRows(taskId)).toEqual([
        { stepId: CANARY.stepId, cliProviderId: providerId },
      ]);
      expect((await taskRow(taskId)).cliProviderId).toBe(providerId);
      expect(await eventTypes(taskId)).toContain('task.cli_provider_changed');
    });

    it('H4f: a disabled CLI on a pending row is still refused with the same 400, and nothing of the switch stays', async () => {
      const taskId = await seedTask('running');
      await seedStep(taskId);
      const [disabled] = await db
        .insert(schema.cliProviders)
        .values({ userId: USER, name: 'codex', label: 'step fold disabled', enabled: false })
        .returning({ id: schema.cliProviders.id });

      const outcome = await settle(
        patch(`/tasks/${taskId}/steps/${STEP.stepId}/cli-provider`, {
          cliProviderId: disabled!.id,
        }),
      );

      expect(outcome).toMatchObject({
        ok: false,
        error: { status: 400, code: 'cli_provider_disabled' },
      });
      expect(await choiceRows(taskId)).toEqual([]);
      expect(await finalRow()).toEqual({
        status: 'pending',
        idleMs: 4000,
        userActiveMs: 800,
        carriedWorkMs: 1000,
        carriedIdleMs: 200,
        carriedUserActiveMs: 50,
      });
    });

    // H6-H8: a pass runs the row while the switch waits for its lock and leaves it where the handler's own read
    // would not have re-run it that way: finished, parked on a form after a pending row was read, or in its next
    // loop iteration. The reset the handler decided on from its first read would undo that work, or leave a row no
    // advance claims, so the switch refuses with the 409 it gives a live row, and the row stays as the pass left it.
    const peerSets = (id: string, set: SQL) => (tx: Tx) =>
      tx.execute(sql`update task_steps set ${set} where id = ${id}`);

    it.each([
      ['H6', 'pending', 0, 'done', sql`status = 'done', ended_at = now()`],
      [
        'H7',
        'pending',
        0,
        'waiting_form',
        sql`status = 'waiting_form', waiting_started_at = now()`,
      ],
      ['H8', 'waiting_form', 1, 'waiting_form', sql`iteration_count = 1`],
    ] as const)(
      '%s: the per-step CLI switch refuses a %s row that a pass has since taken to iteration %s as %s',
      async (_label, readAs, iterations, leftAs, set) => {
        const taskId = await seedTask('running');
        await seedStep(taskId, { status: readAs });

        const outcome = await settle(
          besidePeer(
            () =>
              patch(`/tasks/${taskId}/steps/${STEP.stepId}/cli-provider`, { cliProviderId: null }),
            peerSets(STEP.id, set),
          ),
        );

        expect.soft(outcome).toMatchObject({
          ok: false,
          error: { status: 409, message: `Cannot change provider while step is ${leftAs}` },
        });
        expect.soft(await wholeRow()).toMatchObject({
          status: leftAs,
          iterationCount: iterations,
          idleMs: 4000,
          userActiveMs: 800,
          carriedWorkMs: 1000,
          carriedIdleMs: 200,
          carriedUserActiveMs: 50,
        });
        expect.soft(await choiceRows(taskId), 'task_step_cli_choices').toEqual([]);
        expect.soft((await taskRow(taskId)).orchestrationEpoch, 'the task was not moved').toBe(3);
      },
      TEST_TIMEOUT,
    );

    it(
      'H9: a peer that only resets a parked row to pending does not make the switch refuse',
      async () => {
        const taskId = await seedTask('running');
        await seedStep(taskId, { status: 'waiting_form' });

        const response = await besidePeer(
          () =>
            patch(`/tasks/${taskId}/steps/${STEP.stepId}/cli-provider`, { cliProviderId: null }),
          peerSets(STEP.id, sql`status = 'pending', waiting_started_at = null`),
        );

        expect(response).toMatchObject({ status: 200, body: { ok: true } });
        expect((await wholeRow()).status).toBe('pending');
        expect(await choiceRows(taskId)).toEqual([{ stepId: STEP.stepId, cliProviderId: null }]);
        expect((await taskRow(taskId)).orchestrationEpoch, 'the task moved to the step').toBe(4);
      },
      TEST_TIMEOUT,
    );

    // A row the switch does not re-run takes the choice and nothing else, and does not enter the transaction.
    it.each([
      ['a finished step', { status: 'done' }],
      ['a step in its next loop iteration', { status: 'waiting_form', iterationCount: 1 }],
    ] as const)(
      'H4e: the switch on %s saves the choice and leaves the row alone',
      async (_what, over) => {
        const taskId = await seedTask('running');
        await seedStep(taskId, over);

        const response = await patch(`/tasks/${taskId}/steps/${STEP.stepId}/cli-provider`, {
          cliProviderId: providerId,
        });

        expect(response).toMatchObject({ status: 200, body: { ok: true } });
        expect(await choiceRows(taskId)).toEqual([
          { stepId: STEP.stepId, cliProviderId: providerId },
        ]);
        expect(await finalRow()).toEqual({
          status: over.status,
          idleMs: 4000,
          userActiveMs: 800,
          carriedWorkMs: 1000,
          carriedIdleMs: 200,
          carriedUserActiveMs: 50,
        });
      },
    );
  },
);
