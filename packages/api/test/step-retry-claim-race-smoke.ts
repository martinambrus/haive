/**
 * A row a worker pass activates while a Retry, a fan-out Resume or a task retry is being applied,
 * against a database: each action leaves no row active behind it. The pass's writes are held open
 * in their own transaction, in the shape the worker writes them.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { configService, secretsService, userSecretsService, logger } from '@haive/shared';
import { initDatabase, getDb } from '../src/db.js';
import { initRedis, closeRedis } from '../src/redis.js';
import { closeQueues, getTaskQueue } from '../src/queues.js';
import { settleActiveSteps } from '../src/lib/task-control.js';
import { createApiApp } from '../src/index.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { ACCESS_COOKIE } from '../src/auth/cookies.js';

const log = logger.child({ module: 'step-retry-claim-race-smoke' });

for (const k of ['DATABASE_URL', 'REDIS_URL', 'CONFIG_ENCRYPTION_KEY'] as const) {
  if (!process.env[k]) {
    console.error(`[smoke] missing env ${k}`);
    process.exit(2);
  }
}

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    log.info({ check: name }, 'ok');
    return;
  }
  failures += 1;
  log.error({ check: name, detail }, 'FAILED');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Run `writes` in a transaction held open until the returned release is called. */
async function holdOpen(db: Db, writes: (tx: Tx) => Promise<void>) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let written!: () => void;
  const done = new Promise<void>((resolve) => (written = resolve));
  const tx = db.transaction(async (t) => {
    await writes(t);
    written();
    await gate;
  });
  await done;
  return async () => {
    release();
    await tx;
  };
}

/** The worker's claim (`openPendingStep`): flip the row, then read the task FOR SHARE. */
function claimWrites(taskId: string, stepRowId: string, epoch: number) {
  return async (tx: Tx) => {
    await tx
      .update(schema.taskSteps)
      .set({ status: 'running', startedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(schema.taskSteps.id, stepRowId), eq(schema.taskSteps.status, 'pending')));
    await tx
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.orchestrationEpoch, epoch)))
      .for('share');
  };
}

async function main(): Promise<void> {
  let userId: string | undefined;
  let taskId: string | undefined;
  let paused = false;
  let exitCode = 0;
  try {
    initRedis(process.env.REDIS_URL!);
    await configService.initialize(process.env.REDIS_URL!);
    const db = initDatabase(process.env.DATABASE_URL!);
    await secretsService.initialize(db);
    await userSecretsService.initialize(db, await secretsService.getMasterKek());
    // No worker may pick up the advances these actions queue while the rows are being checked.
    await getTaskQueue().pause();
    paused = true;

    const app = createApiApp('http://localhost:3000');
    userId = randomUUID();
    const now = new Date();
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'retry-claim-race-smoke@test.local',
      emailBlindIndex: `retry-claim-race-${randomBytes(4).toString('hex')}`,
      passwordHash: 'smoke-not-real',
      role: 'user',
      status: 'active',
      tokenVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
    const cookie = `${ACCESS_COOKIE}=${await signAccessToken({ sub: userId, role: 'user', tv: 0 })}`;
    const post = async (path: string, body: unknown) =>
      app.request(path, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    const [task] = await db
      .insert(schema.tasks)
      .values({ userId, type: 'workflow', title: 'claim race smoke', status: 'failed' })
      .returning();
    taskId = task!.id;
    const [retried, sibling, parked] = await db
      .insert(schema.taskSteps)
      .values([
        {
          taskId,
          stepId: '03b-business-requirements',
          stepIndex: 0,
          title: 'Retried step',
          status: 'failed',
          errorMessage: 'kaboom',
          endedAt: now,
        },
        {
          taskId,
          stepId: 'late-claim',
          stepIndex: 5,
          round: 1,
          title: 'Sibling',
          status: 'pending',
        },
        { taskId, stepId: 'parked-form', stepIndex: 6, title: 'Parked form', status: 'pending' },
      ])
      .returning();
    const statusOf = async (id: string) =>
      (await db.query.taskSteps.findFirst({ where: eq(schema.taskSteps.id, id) }))?.status;
    const epochNow = async () =>
      (await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId!) }))!.orchestrationEpoch;
    const leftActiveOf = async (eventType: string) => {
      const events = await db
        .select()
        .from(schema.taskEvents)
        .where(
          and(eq(schema.taskEvents.taskId, taskId!), eq(schema.taskEvents.eventType, eventType)),
        );
      return events.flatMap(
        (e) => (e.payload as { leftActive?: { stepId?: string }[] }).leftActive ?? [],
      );
    };
    const stepAction = `/tasks/${taskId}/steps/03b-business-requirements/action`;

    // 1. A Retry whose read missed a sibling a pass claimed: the bump waits for the claim, and the
    //    row it activated is reset rather than left for the other-step guard.
    let releaseClaim = await holdOpen(db, claimWrites(taskId, sibling!.id, await epochNow()));
    let settled = false;
    let action = post(stepAction, { action: 'retry', round: 0 }).finally(() => {
      settled = true;
    });
    await sleep(1000);
    check('the Retry waits for the claim in flight', !settled);
    await releaseClaim();
    let res = await action;
    check('the Retry answers 200', res.status === 200, res.status);
    check(
      'the Retry resets the row the claim activated',
      (await statusOf(sibling!.id)) === 'pending',
    );
    check(
      'the Retry names that row as one it left active',
      (await leftActiveOf('step.retry')).some((r) => r.stepId === 'late-claim'),
    );

    // 2. The same race against a fan-out Resume, whose own row stays running.
    await db
      .update(schema.taskSteps)
      .set({ status: 'failed', errorMessage: 'one agent failed', endedAt: now })
      .where(eq(schema.taskSteps.id, retried!.id));
    await db
      .insert(schema.taskStepAgentMinings)
      .values({ taskStepId: retried!.id, agentId: 'smoke-reviewer', status: 'failed' });
    releaseClaim = await holdOpen(db, claimWrites(taskId, sibling!.id, await epochNow()));
    settled = false;
    action = post(stepAction, { action: 'resume', round: 0 }).finally(() => {
      settled = true;
    });
    await sleep(1000);
    check('the Resume waits for the claim in flight', !settled);
    await releaseClaim();
    res = await action;
    check('the Resume answers 200', res.status === 200, res.status);
    check(
      'the Resume resets the row the claim activated',
      (await statusOf(sibling!.id)) === 'pending',
    );
    check('the Resume keeps its own row running', (await statusOf(retried!.id)) === 'running');
    check(
      'the Resume names that row as one it left active',
      (await leftActiveOf('step.resume')).some((r) => r.stepId === 'late-claim'),
    );

    // 3. A task retry racing an answer to a parked form, which revives the task and opens its row.
    await db
      .update(schema.taskSteps)
      .set({ status: 'waiting_form', waitingStartedAt: now })
      .where(eq(schema.taskSteps.id, parked!.id));
    await db.update(schema.tasks).set({ status: 'failed' }).where(eq(schema.tasks.id, taskId));
    const releaseAnswer = await holdOpen(db, async (tx) => {
      await tx
        .update(schema.taskSteps)
        .set({ status: 'running', updatedAt: new Date() })
        .where(eq(schema.taskSteps.id, parked!.id));
    });
    settled = false;
    action = post(`/tasks/${taskId}/action`, { action: 'retry' }).finally(() => {
      settled = true;
    });
    await sleep(500);
    check('the task retry waits for the answer in flight', !settled);
    await releaseAnswer();
    res = await action;
    check('the task retry answers 200', res.status === 200, res.status);
    check(
      'the task retry leaves the answered row inactive',
      (await statusOf(parked!.id)) === 'failed',
      await statusOf(parked!.id),
    );

    // 3b. A pass at the old epoch activates rows after the task retry's first settle: a claim and a
    //     form it parked, holding the task row as a claim does, so the bump waits for them. The
    //     settle after the bump takes both.
    await db.update(schema.tasks).set({ status: 'failed' }).where(eq(schema.tasks.id, taskId));
    const [lateClaim, lateForm] = await db
      .insert(schema.taskSteps)
      .values([
        { taskId, stepId: 'late-claim-2', stepIndex: 9, title: 'Late claim', status: 'pending' },
        { taskId, stepId: 'late-form', stepIndex: 10, title: 'Late form', status: 'pending' },
      ])
      .returning();
    const epochBefore = await epochNow();
    const releaseLate = await holdOpen(db, async (tx) => {
      await claimWrites(taskId!, lateClaim!.id, epochBefore)(tx);
      await tx
        .update(schema.taskSteps)
        .set({ status: 'waiting_form', waitingStartedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.taskSteps.id, lateForm!.id));
    });
    settled = false;
    action = post(`/tasks/${taskId}/action`, { action: 'retry' }).finally(() => {
      settled = true;
    });
    await sleep(1000);
    check('the task retry bump waits for the pass in flight', !settled);
    await releaseLate();
    res = await action;
    check('the second task retry answers 200', res.status === 200, res.status);
    check(
      'the settle after the bump fails the row claimed at the old epoch',
      (await statusOf(lateClaim!.id)) === 'failed',
      await statusOf(lateClaim!.id),
    );
    check(
      'the settle after the bump re-offers the form parked at the old epoch',
      (await statusOf(lateForm!.id)) === 'pending',
      await statusOf(lateForm!.id),
    );

    // 4. The settle itself: an answer moving its row from the form to running between the settle's
    //    writes is failed with the rest, and a form nobody answered is re-offered.
    const [moved, stillParked] = await db
      .insert(schema.taskSteps)
      .values([
        {
          taskId,
          stepId: 'moved-form',
          stepIndex: 7,
          title: 'Moved form',
          status: 'waiting_form',
          waitingStartedAt: now,
        },
        {
          taskId,
          stepId: 'still-parked',
          stepIndex: 8,
          title: 'Still parked',
          status: 'waiting_form',
          waitingStartedAt: now,
        },
      ])
      .returning();
    const releaseMove = await holdOpen(db, async (tx) => {
      await tx
        .update(schema.taskSteps)
        .set({ status: 'running', updatedAt: new Date() })
        .where(eq(schema.taskSteps.id, moved!.id));
    });
    settled = false;
    const settle = settleActiveSteps(db, taskId).finally(() => {
      settled = true;
    });
    await sleep(500);
    check('the settle waits for the move in flight', !settled);
    await releaseMove();
    await settle;
    check(
      'the settle fails the row the answer moved',
      (await statusOf(moved!.id)) === 'failed',
      await statusOf(moved!.id),
    );
    check(
      'the settle re-offers the form nobody answered',
      (await statusOf(stillParked!.id)) === 'pending',
    );
  } catch (err) {
    exitCode = 1;
    log.error({ err }, 'smoke crashed');
  } finally {
    try {
      const db = getDb();
      if (taskId) {
        for (const job of await getTaskQueue().getJobs(['wait', 'delayed', 'prioritized'])) {
          if ((job.data as { taskId?: string })?.taskId === taskId)
            await job.remove().catch(() => {});
        }
        await db.delete(schema.tasks).where(eq(schema.tasks.id, taskId));
      }
      if (userId) await db.delete(schema.users).where(eq(schema.users.id, userId));
    } catch (cleanupErr) {
      log.warn({ err: cleanupErr }, 'cleanup failed');
    }
    if (paused) {
      await getTaskQueue()
        .resume()
        .catch((err) => log.error({ err }, 'FAILED TO RESUME THE TASK QUEUE — resume it manually'));
    }
    await closeQueues().catch(() => {});
    await closeRedis().catch(() => {});
    const ok = exitCode === 0 && failures === 0;
    log.info({ failures }, ok ? 'claim race smoke passed' : 'FAILED');
    process.exit(ok ? 0 : 1);
  }
}

void main();
