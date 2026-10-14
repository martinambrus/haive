/**
 * A task whose run list holds a prompt step (`custom.<type>.<slug>`), driven through the real task
 * queue on a real database and Redis with the LLM bypassed. Run it with prompt-step-smoke.sh,
 * which starts the throwaway containers, migrates and cleans up; the command it wraps is
 *   HAIVE_TEST_BYPASS_LLM=1 EVIDENCE_FILE=<path> pnpm --filter @haive/worker exec tsx test/prompt-step-smoke.ts
 * with DATABASE_URL, REDIS_URL and CONFIG_ENCRYPTION_KEY pointing at a database and Redis of its own.
 * NEGATIVE_CONTROL=entry pins the missing step's entry on the second task; NEGATIVE_CONTROL=resolvable
 * gives the second task a run list that resolves, so neither is dead.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Queue } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  CONFIG_KEYS,
  QUEUE_NAMES,
  TASK_JOB_NAMES,
  configService,
  logger,
  secretsService,
  userSecretsService,
  type TaskJobPayload,
} from '@haive/shared';
import { initDatabase } from '../src/db.js';
import { closeRedis, getBullRedis, initRedis } from '../src/redis.js';
import {
  closeTaskQueue,
  setContainerCleanupRunner,
  startTaskWorker,
} from '../src/queues/task-queue.js';
import { stepRegistry } from '../src/step-engine/registry.js';
import { syncStepCatalog } from '../src/step-engine/step-catalog.js';
import { registerStepsOnce } from '../src/step-engine/boot.js';

const log = logger.child({ module: 'prompt-step-smoke' });

for (const k of ['DATABASE_URL', 'REDIS_URL', 'CONFIG_ENCRYPTION_KEY'] as const) {
  if (!process.env[k]) {
    console.error(`[smoke] missing env ${k}`);
    process.exit(2);
  }
}
if (process.env.HAIVE_TEST_BYPASS_LLM !== '1') {
  console.error('[smoke] HAIVE_TEST_BYPASS_LLM=1 is required: no CLI runs in this smoke');
  process.exit(2);
}

const TYPE = 'smoke-prompt';
const STEP_ID = `custom.${TYPE}.summarise`;
const MISSING_ID = `custom.${TYPE}.missing`;
const MODEL_HEALTH_STEP_ID = '00-model-health-workflow';
const WAIT_MS = 90_000;
const control = process.env.NEGATIVE_CONTROL ?? '';

interface CheckResult {
  id: string;
  name: string;
  pass: boolean;
  detail: unknown;
}
const results: CheckResult[] = [];
function check(id: string, name: string, pass: boolean, detail: unknown): void {
  results.push({ id, name, pass, detail });
  if (pass) log.info({ check: id }, name);
  else log.error({ check: id, detail }, `FAILED: ${name}`);
}

async function main(): Promise<void> {
  initRedis(process.env.REDIS_URL!);
  await configService.initialize(process.env.REDIS_URL!);
  const db = initDatabase(process.env.DATABASE_URL!);
  await secretsService.initialize(db);
  await userSecretsService.initialize(db, await secretsService.getMasterKek());
  setContainerCleanupRunner(async () => 0);
  await configService.set(CONFIG_KEYS.CUSTOM_TASK_TYPES_ENABLED, 'true');

  const dir = await mkdtemp(path.join(os.tmpdir(), 'haive-prompt-step-smoke-'));
  await writeFile(path.join(dir, 'README.md'), 'prompt step smoke fixture\n');
  const userId = randomUUID();
  const now = new Date();
  let worker: ReturnType<typeof startTaskWorker> | null = null;
  let queue: Queue<TaskJobPayload> | null = null;

  const view = async (taskId: string) => {
    const rows = (await db.execute(sql`
      select status, error_message as "errorMessage", dead_at::text as "deadAt",
             dead_reason as "deadReason", current_step_id as "currentStepId"
      from tasks where id = ${taskId}`)) as unknown as Array<{
      status: string;
      errorMessage: string | null;
      deadAt: string | null;
      deadReason: string | null;
      currentStepId: string | null;
    }>;
    return rows[0]!;
  };
  const settle = async (taskId: string) => {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const v = await view(taskId);
      if (v.deadAt !== null || ['completed', 'failed', 'cancelled'].includes(v.status)) return v;
      if (Date.now() > deadline) return { ...v, timedOut: true };
      await new Promise((r) => setTimeout(r, 500));
    }
  };
  const catalogState = async () => {
    const rows = (await db.execute(sql`
      select count(*)::int as total,
             count(*) filter (where step_id like 'custom.%')::int as custom,
             count(*) filter (where source <> 'core')::int as noncore
      from step_catalog`)) as unknown as Array<{ total: number; custom: number; noncore: number }>;
    return rows[0]!;
  };
  const taskFor = async (title: string, snapshot: string[] | null, customSteps: unknown) => {
    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId,
        repositoryId,
        type: TYPE,
        title,
        description: 'prompt step smoke',
        status: 'created',
        runListSnapshot: snapshot,
        customSteps: customSteps as Record<string, unknown> | null,
      })
      .returning({ id: schema.tasks.id });
    return task!.id;
  };
  const start = (taskId: string) => queue!.add(TASK_JOB_NAMES.START, { taskId, userId });

  let repositoryId = '';
  try {
    registerStepsOnce();
    await syncStepCatalog(db, stepRegistry);
    const catalogBefore = await catalogState();

    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'prompt-step-smoke@test.local',
      emailBlindIndex: `prompt-step-${randomBytes(4).toString('hex')}`,
      passwordHash: 'smoke-not-real',
      role: 'user',
      status: 'active',
      tokenVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
    const [repo] = await db
      .insert(schema.repositories)
      .values({
        userId,
        name: 'prompt-step-smoke',
        source: 'local_path',
        localPath: dir,
        storagePath: dir,
        status: 'ready',
      })
      .returning();
    repositoryId = repo!.id;
    await db.insert(schema.taskTypeDefinitions).values({
      slug: TYPE,
      displayName: 'Smoke prompt',
      runListStrategy: 'static',
      stepIds: [STEP_ID],
      source: 'admin',
      requiresRepository: false,
      promptSteps: {
        summarise: {
          slug: 'summarise',
          title: 'Summarise',
          template: 'Summarise {{task.title}}',
          capabilities: [],
          timeoutMs: 120_000,
        },
      },
    });

    // Loaded at run time: the worker's typecheck must not pull api source into its program.
    const apiDefinitions = (await import(
      new URL('../../api/src/lib/task-type-definition.ts', import.meta.url).href
    )) as {
      definitionForCreate: (
        handle: unknown,
        slug: string,
        opts: { generic: boolean },
      ) => Promise<{
        runListSnapshot: string[] | null;
        customSteps?: Record<string, unknown> | null;
      }>;
    };
    const def = await apiDefinitions.definitionForCreate(db, TYPE, { generic: true });
    const okTask = await taskFor('Prompt step smoke', def.runListSnapshot, def.customSteps);
    const missingSnapshot =
      control === 'resolvable' ? [MODEL_HEALTH_STEP_ID] : [MODEL_HEALTH_STEP_ID, MISSING_ID];
    const missingEntries =
      control === 'entry'
        ? {
            [MISSING_ID]: {
              slug: 'missing',
              title: 'Missing',
              template: 'Missing {{task.title}}',
              capabilities: [],
              timeoutMs: 120_000,
            },
          }
        : null;
    const missingTask = await taskFor('Prompt step missing', missingSnapshot, missingEntries);

    worker = startTaskWorker();
    queue = new Queue<TaskJobPayload>(QUEUE_NAMES.TASK, { connection: getBullRedis() });

    await start(okTask);
    const okEnd = await settle(okTask);
    await start(missingTask);
    const missingEnd = await settle(missingTask);

    check(
      'C1',
      'the task reaches completed, neither dead nor failed',
      okEnd.status === 'completed',
      {
        snapshot: def.runListSnapshot,
        ...okEnd,
      },
    );

    const [row] = await db
      .select({ status: schema.taskSteps.status, output: schema.taskSteps.output })
      .from(schema.taskSteps)
      .where(and(eq(schema.taskSteps.taskId, okTask), eq(schema.taskSteps.stepId, STEP_ID)));
    check(
      'C2',
      'the custom step row exists, done, with a non-null output',
      row !== undefined && row.status === 'done' && row.output !== null,
      row ?? 'no step row',
    );

    const catalogAfter = await catalogState();
    check(
      'C3',
      'step_catalog holds only core ids and its count is unchanged',
      catalogAfter.custom === 0 &&
        catalogAfter.noncore === 0 &&
        catalogAfter.total === catalogBefore.total,
      { before: catalogBefore, after: catalogAfter },
    );

    check(
      'C4',
      'tasks.dead_at is null on the completed task',
      (await view(okTask)).deadAt === null,
      {
        deadAt: (await view(okTask)).deadAt,
      },
    );

    check(
      'C5',
      'a task naming a custom step with no custom_steps entry ends dead, naming that id',
      missingEnd.deadAt !== null && (missingEnd.deadReason ?? '').includes(MISSING_ID),
      { control: control || 'none', ...missingEnd },
    );
  } catch (err) {
    log.error({ err }, 'smoke errored');
    results.push({ id: 'ERROR', name: 'smoke errored', pass: false, detail: String(err) });
  } finally {
    try {
      await worker?.close();
      await queue?.close();
      await closeTaskQueue();
      await db.delete(schema.users).where(eq(schema.users.id, userId));
      await db.delete(schema.taskTypeDefinitions).where(eq(schema.taskTypeDefinitions.slug, TYPE));
      await rm(dir, { recursive: true, force: true });
    } catch (cleanupErr) {
      log.warn({ err: cleanupErr }, 'cleanup failed');
    }
    const failed = results.filter((r) => !r.pass).length;
    const evidence = {
      smoke: 'prompt-step',
      control: control || 'none',
      finishedAt: new Date().toISOString(),
      failed,
      checks: results,
    };
    if (process.env.EVIDENCE_FILE) {
      await writeFile(process.env.EVIDENCE_FILE, `${JSON.stringify(evidence, null, 2)}\n`);
    }
    console.log(JSON.stringify(evidence));
    try {
      await closeRedis();
    } catch (closeErr) {
      log.warn({ err: closeErr }, 'redis close failed');
    }
    process.exit(failed > 0 ? 1 : 0);
  }
}

void main();
