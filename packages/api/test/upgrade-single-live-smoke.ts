/* One live upgrade or rollback per repository, on a real database.
 *
 * The create routes refuse a second live one, and the index behind them
 * (tasks_one_live_upgrade_per_repo_idx) also refuses reviving a FAILED one beside it: a task Retry
 * and a step Retry both answer 409, and a direct write is rejected by the database itself. Once
 * the live one ends, the failed one retries as before.
 *
 * Run manually (the -smoke.ts suffix keeps vitest from auto-running it):
 *   docker exec haive-api sh -c 'cd /app/packages/api && ./node_modules/.bin/tsx test/upgrade-single-live-smoke.ts'
 *
 * The BullMQ task queue is PAUSED for the duration so the advance a Retry enqueues for a
 * throwaway task is never executed by a live worker; it is removed and the queue resumed after.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { isUniqueViolationOf, ONE_LIVE_UPGRADE_INDEX, schema } from '@haive/database';
import { configService, secretsService, userSecretsService, logger } from '@haive/shared';
import { initDatabase, getDb } from '../src/db.js';
import { initRedis, closeRedis } from '../src/redis.js';
import { closeQueues, getTaskQueue } from '../src/queues.js';
import { createApiApp } from '../src/index.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { ACCESS_COOKIE } from '../src/auth/cookies.js';

const log = logger.child({ module: 'upgrade-single-live-smoke' });

const REQUIRED_ENV = ['DATABASE_URL', 'REDIS_URL', 'CONFIG_ENCRYPTION_KEY'] as const;
for (const k of REQUIRED_ENV) {
  if (!process.env[k]) {
    console.error(`[smoke] missing env ${k}`);
    process.exit(2);
  }
}

function assertEq(label: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

async function main(): Promise<void> {
  const state: { userId?: string; repositoryId?: string; taskIds: string[]; paused?: boolean } = {
    taskIds: [],
  };
  let exitCode = 0;
  try {
    initRedis(process.env.REDIS_URL!);
    await configService.initialize(process.env.REDIS_URL!);
    const db = initDatabase(process.env.DATABASE_URL!);
    await secretsService.initialize(db);
    const masterKek = await secretsService.getMasterKek();
    await userSecretsService.initialize(db, masterKek);

    await getTaskQueue().pause();
    state.paused = true;

    const app = createApiApp('http://localhost:3000');
    const now = new Date();
    const userId = randomUUID();
    state.userId = userId;
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'upgrade-single-live-smoke@test.local',
      emailBlindIndex: `single-live-${randomBytes(4).toString('hex')}`,
      passwordHash: 'smoke-not-real',
      role: 'user',
      status: 'active',
      tokenVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
    const cookie = `${ACCESS_COOKIE}=${await signAccessToken({ sub: userId, role: 'user', tv: 0 })}`;
    const repositoryId = randomUUID();
    state.repositoryId = repositoryId;
    await db.insert(schema.repositories).values({
      id: repositoryId,
      userId,
      name: `upgrade-single-live-smoke-${repositoryId.slice(0, 8)}`,
      source: 'blank',
      createdAt: now,
      updatedAt: now,
    });

    const [failed] = await db
      .insert(schema.tasks)
      .values({
        userId,
        repositoryId,
        type: 'onboarding_upgrade',
        title: 'upgrade that failed',
        status: 'failed',
        errorMessage: 'simulated failure',
        currentStepId: '02-upgrade-apply',
        completedAt: now,
      })
      .returning();
    if (!failed) throw new Error('failed task insert failed');
    state.taskIds.push(failed.id);
    await db.insert(schema.taskSteps).values({
      taskId: failed.id,
      stepId: '02-upgrade-apply',
      stepIndex: 2,
      title: 'Apply',
      status: 'failed',
      startedAt: now,
      endedAt: now,
      errorMessage: 'simulated failure',
    });

    const [live] = await db
      .insert(schema.tasks)
      .values({
        userId,
        repositoryId,
        type: 'onboarding_upgrade',
        title: 'upgrade parked on its form',
        status: 'waiting_user',
        currentStepId: '02-upgrade-apply',
      })
      .returning();
    if (!live) throw new Error('live task insert failed');
    state.taskIds.push(live.id);

    const post = (path: string, body: unknown) =>
      app.request(path, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const statusOf = async (id: string) =>
      (await db.query.tasks.findFirst({ where: eq(schema.tasks.id, id) }))?.status;

    // --- 1. Neither a task Retry nor a step Retry revives it beside the live one -------------
    assertEq(
      'task Retry beside a live upgrade',
      (await post(`/tasks/${failed.id}/action`, { action: 'retry' })).status,
      409,
    );
    assertEq('still failed after the task Retry', await statusOf(failed.id), 'failed');
    assertEq(
      'step Retry beside a live upgrade',
      (await post(`/tasks/${failed.id}/steps/02-upgrade-apply/action`, { action: 'retry' })).status,
      409,
    );
    assertEq('still failed after the step Retry', await statusOf(failed.id), 'failed');

    // --- 2. Any other writer is refused by the database itself --------------------------------
    let refused = false;
    try {
      await db
        .update(schema.tasks)
        .set({ status: 'running' })
        .where(eq(schema.tasks.id, failed.id));
    } catch (err) {
      refused = isUniqueViolationOf(err, ONE_LIVE_UPGRADE_INDEX);
      if (!refused) throw err;
    }
    assertEq('a direct revival refused by the index', refused, true);

    // --- 3. Nor does answering its parked form: the worker would revive it, so the api refuses --
    const [parked] = await db
      .insert(schema.tasks)
      .values({
        userId,
        repositoryId,
        type: 'onboarding_upgrade',
        title: 'upgrade failed while its form waited',
        status: 'failed',
        errorMessage: 'simulated failure',
        currentStepId: '02-upgrade-apply',
        completedAt: now,
      })
      .returning();
    if (!parked) throw new Error('parked task insert failed');
    state.taskIds.push(parked.id);
    const [parkedRow] = await db
      .insert(schema.taskSteps)
      .values({
        taskId: parked.id,
        stepId: '02-upgrade-apply',
        stepIndex: 2,
        title: 'Apply',
        status: 'waiting_form',
        startedAt: now,
        waitingStartedAt: now,
      })
      .returning();
    if (!parkedRow) throw new Error('parked step insert failed');
    assertEq(
      'answering its form beside a live upgrade',
      (await post(`/tasks/${parked.id}/steps/02-upgrade-apply/submit`, { values: {} })).status,
      409,
    );
    const rowAfter = await db.query.taskSteps.findFirst({
      where: eq(schema.taskSteps.id, parkedRow.id),
    });
    assertEq('the answer was not stored', rowAfter?.formValues ?? null, null);
    if (!rowAfter?.waitingStartedAt) throw new Error('the form was closed although refused');

    // --- 4. Once the live one ends, the failed one retries as before --------------------------
    await db
      .update(schema.tasks)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(schema.tasks.id, live.id));
    assertEq(
      'task Retry once the other ended',
      (await post(`/tasks/${failed.id}/action`, { action: 'retry' })).status,
      200,
    );
    assertEq('revived', await statusOf(failed.id), 'running');

    console.log(JSON.stringify({ smoke: 'UPGRADE_SINGLE_LIVE_OK' }));
  } catch (err) {
    exitCode = 1;
    log.error({ err }, 'smoke failed');
    console.error('[smoke] FAILED:', err);
  } finally {
    try {
      const db = getDb();
      if (state.taskIds.length > 0) {
        for (const job of await getTaskQueue().getJobs(['wait', 'delayed', 'prioritized'])) {
          if (state.taskIds.includes((job.data as { taskId?: string })?.taskId ?? '')) {
            await job.remove().catch(() => {});
          }
        }
        await db
          .delete(schema.cliInvocations)
          .where(inArray(schema.cliInvocations.taskId, state.taskIds));
        await db.delete(schema.taskEvents).where(inArray(schema.taskEvents.taskId, state.taskIds));
        await db.delete(schema.taskSteps).where(inArray(schema.taskSteps.taskId, state.taskIds));
        await db.delete(schema.tasks).where(inArray(schema.tasks.id, state.taskIds));
      }
      if (state.repositoryId) {
        await db.delete(schema.repositories).where(eq(schema.repositories.id, state.repositoryId));
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
