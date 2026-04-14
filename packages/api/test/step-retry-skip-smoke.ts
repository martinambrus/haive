import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { configService, secretsService, userSecretsService, logger } from '@haive/shared';
import { initDatabase, getDb } from '../src/db.js';
import { initRedis, closeRedis } from '../src/redis.js';
import { closeQueues } from '../src/queues.js';
import { createApiApp } from '../src/index.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { ACCESS_COOKIE } from '../src/auth/cookies.js';

const log = logger.child({ module: 'step-retry-skip-smoke' });

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
  stepIds?: string[];
}

function assertStatus(label: string, actual: number, expected: number): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected status ${expected}, got ${actual}`);
  }
}

async function main(): Promise<void> {
  const state: State = {};
  let exitCode = 0;
  try {
    log.info('bootstrapping');
    initRedis(process.env.REDIS_URL!);
    await configService.initialize(process.env.REDIS_URL!);
    const db = initDatabase(process.env.DATABASE_URL!);
    await secretsService.initialize(db);
    const masterKek = await secretsService.getMasterKek();
    await userSecretsService.initialize(db, masterKek);

    const app = createApiApp('http://localhost:3000');

    const userId = randomUUID();
    state.userId = userId;
    const now = new Date();
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'retry-smoke@test.local',
      emailBlindIndex: `retry-${randomBytes(4).toString('hex')}`,
      passwordHash: 'smoke-not-real',
      role: 'user',
      status: 'active',
      tokenVersion: 0,
      createdAt: now,
      updatedAt: now,
    });

    const token = await signAccessToken({ sub: userId, role: 'user', tv: 0 });
    const cookie = `${ACCESS_COOKIE}=${token}`;

    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId,
        type: 'workflow',
        title: 'retry skip smoke',
        status: 'failed',
        errorMessage: 'simulated failure',
      })
      .returning();
    if (!task) throw new Error('task insert failed');
    state.taskId = task.id;

    const [failedStep, middleStep, lastStep] = await db
      .insert(schema.taskSteps)
      .values([
        {
          taskId: task.id,
          stepId: 'failing-step',
          stepIndex: 0,
          title: 'Failing step',
          status: 'failed',
          errorMessage: 'kaboom',
          endedAt: now,
        },
        {
          taskId: task.id,
          stepId: 'middle-step',
          stepIndex: 1,
          title: 'Middle step',
          status: 'pending',
        },
        {
          taskId: task.id,
          stepId: 'last-step',
          stepIndex: 2,
          title: 'Last step',
          status: 'pending',
        },
      ])
      .returning();
    if (!failedStep || !middleStep || !lastStep) throw new Error('step insert failed');
    state.stepIds = [failedStep.id, middleStep.id, lastStep.id];

    // 1. Retry the failed step
    const retryRes = await app.request(`/tasks/${task.id}/steps/failing-step/action`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'retry', note: 'manual retry' }),
    });
    assertStatus('POST /retry', retryRes.status, 200);

    const afterRetry = await db.query.taskSteps.findFirst({
      where: eq(schema.taskSteps.id, failedStep.id),
    });
    if (!afterRetry) throw new Error('failed step vanished after retry');
    if (afterRetry.status !== 'pending') {
      throw new Error(`expected retry to reset step to pending, got ${afterRetry.status}`);
    }
    if (afterRetry.errorMessage !== null) {
      throw new Error('retry should clear errorMessage');
    }

    const taskAfterRetry = await db.query.tasks.findFirst({
      where: eq(schema.tasks.id, task.id),
    });
    if (taskAfterRetry?.status !== 'running') {
      throw new Error(`expected task running after retry, got ${taskAfterRetry?.status}`);
    }
    if (taskAfterRetry.currentStepId !== 'failing-step') {
      throw new Error(`expected currentStepId=failing-step, got ${taskAfterRetry.currentStepId}`);
    }

    // 2. Mark failing-step failed again, then skip it
    await db
      .update(schema.taskSteps)
      .set({ status: 'failed', errorMessage: 'kaboom again' })
      .where(eq(schema.taskSteps.id, failedStep.id));

    const skipRes = await app.request(`/tasks/${task.id}/steps/failing-step/action`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'skip', note: 'skip during smoke' }),
    });
    assertStatus('POST /skip', skipRes.status, 200);
    const skipBody = (await skipRes.json()) as { status: string; nextStepId: string | null };
    if (skipBody.status !== 'skipped') throw new Error(`expected skipped, got ${skipBody.status}`);
    if (skipBody.nextStepId !== 'middle-step') {
      throw new Error(`expected next=middle-step, got ${skipBody.nextStepId}`);
    }

    const afterSkip = await db.query.taskSteps.findFirst({
      where: eq(schema.taskSteps.id, failedStep.id),
    });
    if (afterSkip?.status !== 'skipped') {
      throw new Error(`expected step skipped, got ${afterSkip?.status}`);
    }

    const taskAfterSkip = await db.query.tasks.findFirst({
      where: eq(schema.tasks.id, task.id),
    });
    if (taskAfterSkip?.currentStepId !== 'middle-step') {
      throw new Error(`expected currentStepId=middle-step, got ${taskAfterSkip?.currentStepId}`);
    }

    // 3. Retry on a non-failed step is rejected
    const noRetry = await app.request(`/tasks/${task.id}/steps/middle-step/action`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'retry' }),
    });
    assertStatus('POST /retry on pending', noRetry.status, 409);

    // 4. Unknown action rejected at schema level
    const badAction = await app.request(`/tasks/${task.id}/steps/middle-step/action`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'restart' }),
    });
    if (badAction.status < 400) {
      throw new Error(`expected 4xx for unknown action, got ${badAction.status}`);
    }

    // 5. Task events recorded
    const events = await db
      .select()
      .from(schema.taskEvents)
      .where(eq(schema.taskEvents.taskId, task.id));
    const retryEvent = events.find((e) => e.eventType === 'step.retry');
    const skipEvent = events.find((e) => e.eventType === 'step.skip');
    if (!retryEvent) throw new Error('missing step.retry event');
    if (!skipEvent) throw new Error('missing step.skip event');

    log.info(
      {
        retries: events.filter((e) => e.eventType === 'step.retry').length,
        skips: events.filter((e) => e.eventType === 'step.skip').length,
      },
      'retry/skip wiring verified',
    );

    console.log(
      JSON.stringify({
        smoke: 'STEP_RETRY_SKIP_OK',
        taskStatusAfterRetry: taskAfterRetry.status,
        taskStatusAfterSkip: taskAfterSkip?.status,
      }),
    );
  } catch (err) {
    exitCode = 1;
    log.error({ err }, 'smoke failed');
    console.error('[smoke] FAILED:', err);
  } finally {
    try {
      const db = getDb();
      if (state.taskId) {
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
    await closeQueues().catch(() => {});
    await closeRedis().catch(() => {});
    process.exit(exitCode);
  }
}

void main();
