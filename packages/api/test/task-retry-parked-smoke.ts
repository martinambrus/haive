/* Task-level Retry over a PARKED step.
 *
 * Regression cover for the deadlock that made a task unrecoverable through the UI: a task
 * that failed with a step still in waiting_cli used to restart from step 0 while that step
 * stayed active, and the worker's other-step guard then refused every advance forever.
 * Retry now ends the live run, re-runs the step the task stopped on and bumps the epoch.
 *
 * Run manually (the -smoke.ts suffix keeps vitest from auto-running it):
 *   docker exec haive-api sh -c 'cd /app/packages/api && ./node_modules/.bin/tsx test/task-retry-parked-smoke.ts'
 *
 * The BullMQ task queue is PAUSED for the duration so the advance this enqueues for a
 * throwaway task is never executed by the live worker; it is removed and the queue resumed
 * in the finally block.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  configService,
  secretsService,
  userSecretsService,
  logger,
  TASK_JOB_NAMES,
} from '@haive/shared';
import { initDatabase, getDb } from '../src/db.js';
import { initRedis, closeRedis } from '../src/redis.js';
import { closeQueues, getTaskQueue } from '../src/queues.js';
import { createApiApp } from '../src/index.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { ACCESS_COOKIE } from '../src/auth/cookies.js';

const log = logger.child({ module: 'task-retry-parked-smoke' });

const REQUIRED_ENV = ['DATABASE_URL', 'REDIS_URL', 'CONFIG_ENCRYPTION_KEY'] as const;
for (const k of REQUIRED_ENV) {
  if (!process.env[k]) {
    console.error(`[smoke] missing env ${k}`);
    process.exit(2);
  }
}

interface State {
  userId?: string;
  taskId?: string;
  paused?: boolean;
}

function assertStatus(label: string, actual: number, expected: number): void {
  if (actual !== expected) throw new Error(`${label}: expected status ${expected}, got ${actual}`);
}

function assertEq(label: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

async function main(): Promise<void> {
  const state: State = {};
  let exitCode = 0;
  try {
    initRedis(process.env.REDIS_URL!);
    await configService.initialize(process.env.REDIS_URL!);
    const db = initDatabase(process.env.DATABASE_URL!);
    await secretsService.initialize(db);
    const masterKek = await secretsService.getMasterKek();
    await userSecretsService.initialize(db, masterKek);

    // Pause BEFORE the first retry so the advance can never reach the live worker.
    await getTaskQueue().pause();
    state.paused = true;
    log.info('task queue paused for the smoke');

    const app = createApiApp('http://localhost:3000');

    const userId = randomUUID();
    state.userId = userId;
    const now = new Date();
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'retry-parked-smoke@test.local',
      emailBlindIndex: `parked-${randomBytes(4).toString('hex')}`,
      passwordHash: 'smoke-not-real',
      role: 'user',
      status: 'active',
      tokenVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
    const cookie = `${ACCESS_COOKIE}=${await signAccessToken({ sub: userId, role: 'user', tv: 0 })}`;

    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId,
        type: 'workflow',
        title: 'retry parked smoke',
        status: 'failed',
        errorMessage: 'simulated failure',
        currentStepId: 'parked-step',
      })
      .returning();
    if (!task) throw new Error('task insert failed');
    state.taskId = task.id;
    const epochBefore = task.orchestrationEpoch;

    const [parkedStep] = await db
      .insert(schema.taskSteps)
      .values({
        taskId: task.id,
        stepId: 'parked-step',
        stepIndex: 0,
        title: 'Parked step',
        // The state a worker killed mid-run leaves behind: still "active" as far as the
        // orchestrator's other-step guard is concerned, with nothing actually running.
        status: 'waiting_cli',
        startedAt: now,
        waitingStartedAt: now,
        statusMessage: 'Waiting for AI analysis...',
      })
      .returning();
    if (!parkedStep) throw new Error('step insert failed');

    const [liveInv] = await db
      .insert(schema.cliInvocations)
      .values({
        taskId: task.id,
        taskStepId: parkedStep.id,
        mode: 'cli',
        prompt: 'smoke',
        startedAt: now,
      })
      .returning();
    if (!liveInv) throw new Error('invocation insert failed');

    // --- 1. Retry over a waiting_cli park -------------------------------------------
    const res = await app.request(`/tasks/${task.id}/action`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'retry' }),
    });
    assertStatus('POST /action retry', res.status, 200);

    const invAfter = await db.query.cliInvocations.findFirst({
      where: eq(schema.cliInvocations.id, liveInv.id),
    });
    if (!invAfter?.supersededAt) throw new Error('live invocation was not superseded');
    if (!invAfter.endedAt) throw new Error('live invocation was not ended');

    const stepAfter = await db.query.taskSteps.findFirst({
      where: eq(schema.taskSteps.id, parkedStep.id),
    });
    // The step the task stopped on is re-run, so it is reset rather than failed.
    assertEq('parked step reset', stepAfter?.status, 'pending');

    const blocking = await db
      .select({ id: schema.taskSteps.id, status: schema.taskSteps.status })
      .from(schema.taskSteps)
      .where(eq(schema.taskSteps.taskId, task.id));
    const stillActive = blocking.filter((s) =>
      ['running', 'waiting_cli', 'waiting_form'].includes(s.status),
    );
    if (stillActive.length > 0) {
      throw new Error(`retry left ${stillActive.length} step(s) active — restart would deadlock`);
    }

    const taskAfter = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, task.id) });
    assertEq('task status', taskAfter?.status, 'running');
    assertEq('epoch bumped', taskAfter?.orchestrationEpoch, epochBefore + 1);

    // bullmq 6 removed 'paused' from JobType — a paused queue's jobs report as 'waiting'.
    const advanceFor = async (epoch: number) =>
      (await getTaskQueue().getJobs(['wait', 'delayed', 'prioritized'])).find((j) => {
        const data = j.data as { taskId?: string; stepId?: string; epoch?: number };
        return (
          j.name === TASK_JOB_NAMES.ADVANCE_STEP &&
          data.taskId === task.id &&
          data.stepId === 'parked-step' &&
          data.epoch === epoch
        );
      });
    if (!(await advanceFor(epochBefore + 1))) {
      throw new Error('retry did not enqueue an advance for the step at the new epoch');
    }

    // --- 2. Retry over a waiting_form park ------------------------------------------
    // A form park is re-offered as it was: back to pending, rather than left blocking.
    await db
      .update(schema.taskSteps)
      .set({ status: 'waiting_form', waitingStartedAt: new Date(), endedAt: null })
      .where(eq(schema.taskSteps.id, parkedStep.id));
    await db
      .update(schema.tasks)
      .set({ status: 'failed', errorMessage: 'simulated failure 2' })
      .where(eq(schema.tasks.id, task.id));

    const res2 = await app.request(`/tasks/${task.id}/action`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'retry' }),
    });
    assertStatus('POST /action retry (form park)', res2.status, 200);

    const stepAfterForm = await db.query.taskSteps.findFirst({
      where: eq(schema.taskSteps.id, parkedStep.id),
    });
    assertEq('form park reset', stepAfterForm?.status, 'pending');
    if (stepAfterForm?.waitingStartedAt) throw new Error('waitingStartedAt not cleared');

    const taskAfter2 = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, task.id) });
    assertEq('epoch bumped twice', taskAfter2?.orchestrationEpoch, epochBefore + 2);
    if (!(await advanceFor(epochBefore + 2))) {
      throw new Error('retry over the form park did not enqueue an advance');
    }

    console.log(JSON.stringify({ smoke: 'TASK_RETRY_PARKED_OK' }));
  } catch (err) {
    exitCode = 1;
    log.error({ err }, 'smoke failed');
    console.error('[smoke] FAILED:', err);
  } finally {
    try {
      const db = getDb();
      if (state.taskId) {
        for (const job of await getTaskQueue().getJobs(['wait', 'delayed', 'prioritized'])) {
          if ((job.data as { taskId?: string })?.taskId === state.taskId) {
            await job.remove().catch(() => {});
          }
        }
        await db
          .delete(schema.cliInvocations)
          .where(eq(schema.cliInvocations.taskId, state.taskId));
        await db.delete(schema.taskEvents).where(eq(schema.taskEvents.taskId, state.taskId));
        await db.delete(schema.taskSteps).where(eq(schema.taskSteps.taskId, state.taskId));
        await db.delete(schema.tasks).where(eq(schema.tasks.id, state.taskId));
      }
      if (state.userId) {
        await db.delete(schema.users).where(eq(schema.users.id, state.userId));
      }
    } catch (cleanupErr) {
      log.warn({ err: cleanupErr }, 'cleanup failed');
    }
    if (state.paused) {
      await getTaskQueue()
        .resume()
        .catch((err) => log.error({ err }, 'FAILED TO RESUME THE TASK QUEUE — resume it manually'));
    }
    await closeQueues().catch(() => {});
    await closeRedis().catch(() => {});
    process.exit(exitCode);
  }
}

void main();
