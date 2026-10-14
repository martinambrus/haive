/**
 * A task type a module seeds, from the boot seed to a finished task: the row the worker writes at
 * boot, the api's create path reading it behind MODULE_TASK_TYPES_ENABLED, and the task queue running
 * the module's stub step. Real database and Redis; no CLI runs.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Queue } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
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
import { syncModuleIntent } from '../src/modules/intent.js';
import { registerModuleSteps, type WorkerModuleEntry } from '../src/modules/loader.js';
import { closeRedis, getBullRedis, initRedis } from '../src/redis.js';
import {
  closeTaskQueue,
  setContainerCleanupRunner,
  startTaskWorker,
} from '../src/queues/task-queue.js';
import { registerStepsOnce } from '../src/step-engine/boot.js';
import { stepRegistry } from '../src/step-engine/registry.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';
import { syncStepCatalog } from '../src/step-engine/step-catalog.js';
import { syncTaskTypeDefinitions } from '../src/step-engine/task-type-seed.js';

const log = logger.child({ module: 'module-task-type-smoke' });

for (const k of ['DATABASE_URL', 'REDIS_URL', 'CONFIG_ENCRYPTION_KEY'] as const) {
  if (!process.env[k]) {
    console.error(`[smoke] missing env ${k}`);
    process.exit(2);
  }
}

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  checks += 1;
  if (ok) {
    log.info({ check: name }, 'ok');
    return;
  }
  failures += 1;
  log.error({ check: name, detail }, 'FAILED');
}

const SLUG = 'fx__weekly';
const STEP_ID = 'module.fx.report';
const WAIT_MS = 60_000;

const reportStep: StepDefinition = {
  metadata: {
    id: 'report',
    workflowType: 'x',
    index: 0,
    title: 'Report',
    description: 'module task type smoke stub',
    requiresCli: false,
  },
  async detect() {
    return {};
  },
  async apply() {
    return { ranFor: 'module-task-type-smoke' };
  },
};

const entry: WorkerModuleEntry = {
  packageName: '@haive/module-fx',
  manifest: {
    id: 'fx',
    name: 'Fixture',
    version: '0.0.1',
    schemaVersion: 1,
    taskTypes: [
      {
        slug: 'weekly',
        displayName: 'Weekly report',
        runListStrategy: 'static',
        stepIds: [STEP_ID],
        selectable: true,
        requiresRepository: false,
      },
    ],
  },
  steps: [reportStep],
};

interface CreateDefinition {
  runListSnapshot: string[] | null;
  customSteps: Record<string, unknown> | null;
  repoOptional: boolean;
  preAnswers: Record<string, Record<string, unknown>> | null;
  stepLoopLimits: Record<string, number>;
  simplifyCode: boolean;
}

async function main(): Promise<void> {
  initRedis(process.env.REDIS_URL!);
  await configService.initialize(process.env.REDIS_URL!);
  const db = initDatabase(process.env.DATABASE_URL!);
  await secretsService.initialize(db);
  await userSecretsService.initialize(db, await secretsService.getMasterKek());
  setContainerCleanupRunner(async () => 0);

  const dir = await mkdtemp(path.join(os.tmpdir(), 'haive-module-task-type-smoke-'));
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
      await new Promise((r) => setTimeout(r, 250));
    }
  };

  let repositoryId = '';
  try {
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'module-task-type-smoke@test.local',
      emailBlindIndex: `module-task-type-${randomBytes(4).toString('hex')}`,
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
        name: 'module-task-type-smoke',
        source: 'local_path',
        localPath: dir,
        storagePath: dir,
        status: 'ready',
      })
      .returning();
    repositoryId = repo!.id;

    // The boot sequence of bootStepEngine, with the fixture module in place of the generated registry.
    registerStepsOnce();
    const loaded = registerModuleSteps(stepRegistry, [entry]);
    await syncStepCatalog(db, stepRegistry, new Map());
    await syncModuleIntent(db, loaded);
    await syncTaskTypeDefinitions(db, stepRegistry, loaded);

    const [row] = await db
      .select()
      .from(schema.taskTypeDefinitions)
      .where(eq(schema.taskTypeDefinitions.slug, SLUG));
    check(
      'the boot seed stores the module type as <module>__<local>, source module:<module>, static, the seed step list',
      row !== undefined &&
        row.source === 'module:fx' &&
        row.runListStrategy === 'static' &&
        JSON.stringify(row.stepIds) === JSON.stringify([STEP_ID]) &&
        row.enabled &&
        row.selectable,
      row,
    );

    // Loaded at run time: the worker's typecheck must not pull api source into its program.
    const apiDefinitions = (await import(
      new URL('../../api/src/lib/task-type-definition.ts', import.meta.url).href
    )) as {
      definitionForCreate: (
        handle: unknown,
        slug: string,
        opts: { generic: boolean },
      ) => Promise<CreateDefinition>;
    };

    await configService.set(CONFIG_KEYS.MODULE_TASK_TYPES_ENABLED, 'false');
    const refused = await apiDefinitions
      .definitionForCreate(db, SLUG, { generic: true })
      .then(() => null)
      .catch((err: unknown) => err as { status?: number; message?: string });
    check(
      'with MODULE_TASK_TYPES_ENABLED off, the create path refuses the module type with a 403',
      refused !== null && refused.status === 403,
      refused,
    );

    await configService.set(CONFIG_KEYS.MODULE_TASK_TYPES_ENABLED, 'true');
    const def = await apiDefinitions.definitionForCreate(db, SLUG, { generic: true });
    check(
      'with the switch on, the create path snapshots the seed step list',
      JSON.stringify(def.runListSnapshot) === JSON.stringify([STEP_ID]) && def.repoOptional,
      def,
    );

    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId,
        type: SLUG,
        title: 'Module task type smoke',
        description: 'module task type smoke',
        repositoryId,
        simplifyCode: def.simplifyCode,
        stepLoopLimits: def.stepLoopLimits,
        preAnswers: def.preAnswers,
        autoContinue: true,
        metadata: def.repoOptional ? { anchorRepositoryId: repositoryId } : null,
        runListSnapshot: def.runListSnapshot,
        customSteps: def.customSteps,
        status: 'created',
      })
      .returning({ id: schema.tasks.id });
    const taskId = task!.id;

    worker = startTaskWorker();
    queue = new Queue<TaskJobPayload>(QUEUE_NAMES.TASK, { connection: getBullRedis() });
    await queue.add(TASK_JOB_NAMES.START, { taskId, userId });
    const end = await settle(taskId);
    check(
      'the task runs the module step through the task queue to completed, neither dead nor failed',
      end.status === 'completed' && end.deadAt === null && end.errorMessage === null,
      end,
    );

    const steps = await db
      .select({
        stepId: schema.taskSteps.stepId,
        status: schema.taskSteps.status,
        output: schema.taskSteps.output,
      })
      .from(schema.taskSteps)
      .where(eq(schema.taskSteps.taskId, taskId));
    check(
      'the only step row is the module step, done, with the output the stub returned',
      steps.length === 1 &&
        steps[0]!.stepId === STEP_ID &&
        steps[0]!.status === 'done' &&
        JSON.stringify(steps[0]!.output) === JSON.stringify({ ranFor: 'module-task-type-smoke' }),
      steps,
    );
  } finally {
    await worker?.close().catch(() => undefined);
    await queue?.obliterate({ force: true }).catch(() => undefined);
    await queue?.close().catch(() => undefined);
    await configService.set(CONFIG_KEYS.MODULE_TASK_TYPES_ENABLED, 'false').catch(() => undefined);
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
    await db.delete(schema.taskTypeDefinitions).where(eq(schema.taskTypeDefinitions.slug, SLUG));
    await db.delete(schema.stepCatalog).where(eq(schema.stepCatalog.source, 'module:fx'));
    await db.delete(schema.modules).where(eq(schema.modules.moduleId, 'fx'));
    await db.delete(schema.repositories).where(eq(schema.repositories.userId, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await rm(dir, { recursive: true, force: true });
    await closeTaskQueue();
    await closeRedis();
  }
}

main()
  .then(() => {
    log.info(
      { checks, failures },
      failures === 0 ? 'module task type smoke passed' : 'module task type smoke FAILED',
    );
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    log.error({ err }, 'module task type smoke crashed');
    process.exit(1);
  });
