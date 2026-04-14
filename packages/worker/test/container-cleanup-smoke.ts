import { randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  configService,
  secretsService,
  userSecretsService,
  logger,
  QUEUE_NAMES,
  TASK_JOB_NAMES,
  type TaskJobPayload,
} from '@haive/shared';
import { Queue } from 'bullmq';
import { initDatabase, getDb } from '../src/db.js';
import { initRedis, getBullRedis, closeRedis } from '../src/redis.js';
import {
  closeTaskQueue,
  setContainerCleanupRunner,
  startTaskWorker,
} from '../src/queues/task-queue.js';

const log = logger.child({ module: 'container-cleanup-smoke' });

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
  worker?: Awaited<ReturnType<typeof startTaskWorker>>;
  queue?: Queue<TaskJobPayload>;
}

async function pollUntil<T>(
  fn: () => Promise<T | null>,
  predicate: (val: T) => boolean,
  label: string,
  timeoutMs = 15000,
  intervalMs = 200,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (val !== null && predicate(val)) return val;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function main(): Promise<void> {
  const state: State = {};
  let exitCode = 0;
  let stubCalls = 0;
  try {
    log.info('bootstrapping');
    initRedis(process.env.REDIS_URL!);
    await configService.initialize(process.env.REDIS_URL!);
    const db = initDatabase(process.env.DATABASE_URL!);
    await secretsService.initialize(db);
    const masterKek = await secretsService.getMasterKek();
    await userSecretsService.initialize(db, masterKek);

    setContainerCleanupRunner(async (_db, taskId) => {
      stubCalls += 1;
      log.info({ taskId, call: stubCalls }, 'stub cleanup runner invoked');
      return 3;
    });

    const now = new Date();
    const userId = randomUUID();
    state.userId = userId;
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'cleanup-smoke@test.local',
      emailBlindIndex: `cleanup-${randomBytes(4).toString('hex')}`,
      passwordHash: 'smoke-not-real',
      role: 'user',
      status: 'active',
      tokenVersion: 0,
      createdAt: now,
      updatedAt: now,
    });

    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId,
        type: 'workflow',
        title: 'container cleanup smoke',
        status: 'running',
      })
      .returning();
    if (!task) throw new Error('task insert failed');
    state.taskId = task.id;

    state.worker = startTaskWorker();
    state.queue = new Queue<TaskJobPayload>(QUEUE_NAMES.TASK, {
      connection: getBullRedis(),
    });

    log.info({ taskId: task.id }, 'enqueueing cancel');
    await state.queue.add(TASK_JOB_NAMES.CANCEL, { taskId: task.id, userId });

    const cancelled = await pollUntil(
      async () => {
        const row = await db.query.tasks.findFirst({
          where: eq(schema.tasks.id, task.id),
        });
        return row ?? null;
      },
      (t) => t.status === 'cancelled',
      'task cancelled',
    );

    const cleanupEvents = await db
      .select()
      .from(schema.taskEvents)
      .where(
        and(
          eq(schema.taskEvents.taskId, task.id),
          eq(schema.taskEvents.eventType, 'containers.destroyed'),
        ),
      )
      .orderBy(desc(schema.taskEvents.createdAt));

    if (stubCalls < 1) {
      throw new Error(`expected cleanup stub called at least once, got ${stubCalls}`);
    }
    if (cleanupEvents.length < 1) {
      throw new Error('expected at least one containers.destroyed task_event');
    }
    const payload = cleanupEvents[0]!.payload as { reason?: string; count?: number };
    if (payload.reason !== 'cancelled') {
      throw new Error(`expected reason=cancelled, got ${payload.reason}`);
    }
    if (payload.count !== 3) {
      throw new Error(`expected count=3, got ${payload.count}`);
    }

    log.info(
      { status: cancelled.status, stubCalls, eventCount: cleanupEvents.length },
      'cleanup wiring verified',
    );

    console.log(
      JSON.stringify({
        smoke: 'CLEANUP_OK',
        status: cancelled.status,
        stubCalls,
        cleanupEvents: cleanupEvents.length,
      }),
    );
  } catch (err) {
    exitCode = 1;
    log.error({ err }, 'smoke failed');
    console.error('[smoke] FAILED:', err);
  } finally {
    setContainerCleanupRunner(null);
    try {
      const db = getDb();
      if (state.taskId) {
        await db.delete(schema.taskEvents).where(eq(schema.taskEvents.taskId, state.taskId));
        await db.delete(schema.tasks).where(eq(schema.tasks.id, state.taskId));
      }
      if (state.userId) {
        await db.delete(schema.users).where(eq(schema.users.id, state.userId));
      }
    } catch (cleanupErr) {
      log.warn({ err: cleanupErr }, 'cleanup db rows failed');
    }
    if (state.worker) await state.worker.close().catch(() => {});
    if (state.queue) await state.queue.close().catch(() => {});
    await closeTaskQueue().catch(() => {});
    await closeRedis().catch(() => {});
    process.exit(exitCode);
  }
}

void main();
