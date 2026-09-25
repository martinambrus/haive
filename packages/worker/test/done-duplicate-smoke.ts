import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Queue, type JobsOptions } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  configService,
  secretsService,
  userSecretsService,
  logger,
  QUEUE_NAMES,
  TASK_JOB_NAMES,
  type TaskJobPayload,
} from '@haive/shared';
import { initDatabase } from '../src/db.js';
import { initRedis, getBullRedis, closeRedis } from '../src/redis.js';
import { closeTaskQueue, startTaskWorker } from '../src/queues/task-queue.js';
import { stepRegistry } from '../src/step-engine/registry.js';
import { FIX_LOOP_ACTION_FIELD } from '../src/step-engine/steps/workflow/_fix-loop.js';

// A duplicate ADVANCE_STEP for an already-done row must re-drive its real verdict; the
// two loop/revise targets are stubbed to park on a form so nothing cascades or spends.

const log = logger.child({ module: 'done-duplicate-smoke' });

const REQUIRED_ENV = ['DATABASE_URL', 'REDIS_URL', 'CONFIG_ENCRYPTION_KEY'] as const;
for (const k of REQUIRED_ENV) {
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

async function createFixtureRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'haive-done-duplicate-smoke-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'smoke@test.local']);
  git(['config', 'user.name', 'Smoke Test']);
  git(['commit', '--allow-empty', '-m', 'initial']);
  return dir;
}

/** Stands in for a loop/revise target: detects instantly and parks on a form, no CLI. */
function overrideParkingStub(id: string, index: number): void {
  stepRegistry.override({
    metadata: {
      id,
      workflowType: 'workflow',
      index,
      title: 'smoke stub',
      description: 'smoke stub target for done-duplicate-smoke',
      requiresCli: false,
    },
    async detect() {
      return {};
    },
    form() {
      return {
        title: 'smoke stub',
        fields: [{ type: 'textarea', id: 'note', label: 'note' }],
      };
    },
    async apply() {
      return {};
    },
  });
}

interface TaskRow {
  id: string;
  status: string;
  currentStepId: string | null;
  currentRound: number;
}

async function loadTask(db: Database, taskId: string): Promise<TaskRow | null> {
  const rows = await db
    .select({
      id: schema.tasks.id,
      status: schema.tasks.status,
      currentStepId: schema.tasks.currentStepId,
      currentRound: schema.tasks.currentRound,
    })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
    .limit(1);
  return rows[0] ?? null;
}

async function main(): Promise<void> {
  initRedis(process.env.REDIS_URL!);
  await configService.initialize(process.env.REDIS_URL!);
  const db = initDatabase(process.env.DATABASE_URL!);
  await secretsService.initialize(db);
  const masterKek = await secretsService.getMasterKek();
  await userSecretsService.initialize(db, masterKek);

  let fixtureDir: string | undefined;
  let userId: string | undefined;
  let repoId: string | undefined;
  const taskIds: string[] = [];
  let worker: Awaited<ReturnType<typeof startTaskWorker>> | undefined;
  let queue: Queue<TaskJobPayload> | undefined;

  try {
    fixtureDir = await createFixtureRepo();
    const now = new Date();
    userId = randomUUID();
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'done-duplicate-smoke@test.local',
      emailBlindIndex: `done-dup-${randomBytes(4).toString('hex')}`,
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
        name: 'done-duplicate-smoke-fixture',
        source: 'local_path',
        localPath: fixtureDir,
        storagePath: fixtureDir,
        status: 'ready',
      })
      .returning();
    if (!repo) throw new Error('repo insert failed');
    repoId = repo.id;

    worker = startTaskWorker();
    queue = new Queue<TaskJobPayload>(QUEUE_NAMES.TASK, { connection: getBullRedis() });

    // Must run AFTER startTaskWorker registers the real steps, or override would collide.
    overrideParkingStub('07-phase-2-implement', 7);
    overrideParkingStub('03b-business-requirements', 3.5);
    // 07b's own successor under quick_bugfix (index 7.8, right after 07b's 7.7) — the accept
    // case's forward hand-off target.
    overrideParkingStub('07c-ddev-reconcile', 7.8);

    const makeTask = async (title: string, opts: Partial<typeof schema.tasks.$inferInsert>) => {
      const [task] = await db
        .insert(schema.tasks)
        .values({
          userId: userId!,
          repositoryId: repoId!,
          type: 'workflow',
          title,
          status: 'running',
          autoContinue: false,
          orchestrationEpoch: 1,
          ...opts,
        })
        .returning({ id: schema.tasks.id });
      if (!task) throw new Error(`task insert failed: ${title}`);
      taskIds.push(task.id);
      return task.id;
    };

    const insertDoneStep = async (
      taskId: string,
      stepId: string,
      round: number,
      stepIndex: number,
      output: unknown,
      formValues?: Record<string, unknown>,
    ) => {
      await db.insert(schema.taskSteps).values({
        taskId,
        stepId,
        stepIndex,
        round,
        title: 'smoke',
        status: 'done',
        output,
        endedAt: new Date(),
        ...(formValues ? { formValues } : {}),
      });
    };

    const enqueueDuplicate = (
      taskId: string,
      stepId: string,
      round: number,
      formValues?: Record<string, unknown>,
      jobOpts?: JobsOptions,
    ) =>
      queue!.add(
        TASK_JOB_NAMES.ADVANCE_STEP,
        {
          taskId,
          userId: userId!,
          stepId,
          round,
          epoch: 1,
          ...(formValues ? { formValues } : {}),
        },
        jobOpts,
      );

    // --- Case 1: fix loop -------------------------------------------------------------
    // 07b's fixLoop fires on any non-VALID verdict with no churn files.
    {
      const taskId = await makeTask('fix-loop dup', {
        executionPath: 'quick_bugfix',
        currentStepId: '07b-phase-4-validate',
        currentRound: 0,
      });
      await insertDoneStep(taskId, '07b-phase-4-validate', 0, 7.7, {
        verdict: 'ISSUES_FOUND',
        findingsSummary: 'smoke-forced blocking finding',
      });
      await enqueueDuplicate(taskId, '07b-phase-4-validate', 0);

      const task = await pollUntil(
        () => loadTask(db, taskId),
        (t) => t.currentStepId === '07-phase-2-implement' && t.currentRound === 1,
        'fix-loop case: task re-entering 07-phase-2-implement at round 1',
      );
      check(
        'fix-loop: task points at 07-phase-2-implement round 1 (not the next spine step)',
        task.currentStepId === '07-phase-2-implement' && task.currentRound === 1,
        task,
      );

      const events = await db
        .select({ payload: schema.taskEvents.payload })
        .from(schema.taskEvents)
        .where(
          and(
            eq(schema.taskEvents.taskId, taskId),
            eq(schema.taskEvents.eventType, 'fix_loop.requested'),
          ),
        );
      check(
        'fix-loop: a fix_loop.requested event was recorded for round 1',
        events.some((e) => (e.payload as { round?: number } | null)?.round === 1),
        events,
      );

      // The pointer moves before the target's advance creates its row.
      const targetRows = await pollUntil(
        async () =>
          db
            .select({ status: schema.taskSteps.status })
            .from(schema.taskSteps)
            .where(
              and(
                eq(schema.taskSteps.taskId, taskId),
                eq(schema.taskSteps.stepId, '07-phase-2-implement'),
                eq(schema.taskSteps.round, 1),
              ),
            ),
        (rows) => rows.length > 0,
        'fix-loop case: 07-phase-2-implement round 1 row',
      );
      check(
        'fix-loop: 07-phase-2-implement round 1 row was materialized',
        targetRows.length > 0,
        targetRows,
      );
    }

    // --- Case 2: revise ----------------------------------------------------------------
    // 03c's reviseLoop targets 03b; cross-step revise forks round 1, not the same round.
    {
      const taskId = await makeTask('revise dup', {
        currentStepId: '03c-business-requirements-review',
        currentRound: 0,
      });
      await insertDoneStep(taskId, '03c-business-requirements-review', 0, 3.6, {
        decision: 'reject',
        requirements: 'drafted requirements',
        summary: 'summary',
        feedback: 'please redo the second section',
      });
      await enqueueDuplicate(taskId, '03c-business-requirements-review', 0);

      const task = await pollUntil(
        () => loadTask(db, taskId),
        (t) => t.currentStepId === '03b-business-requirements' && t.currentRound === 1,
        'revise case: task re-entering 03b-business-requirements at round 1',
      );
      check(
        'revise: task points at 03b-business-requirements at round 1 (forked round)',
        task.currentStepId === '03b-business-requirements' && task.currentRound === 1,
        task,
      );

      const events = await db
        .select({ payload: schema.taskEvents.payload })
        .from(schema.taskEvents)
        .where(
          and(eq(schema.taskEvents.taskId, taskId), eq(schema.taskEvents.eventType, 'step.revise')),
        );
      check(
        'revise: a step.revise event names the target step',
        events.some(
          (e) =>
            (e.payload as { targetStepId?: string } | null)?.targetStepId ===
            '03b-business-requirements',
        ),
        events,
      );

      // The pointer moves before the target's advance creates its row.
      const targetRows = await pollUntil(
        async () =>
          db
            .select({ status: schema.taskSteps.status })
            .from(schema.taskSteps)
            .where(
              and(
                eq(schema.taskSteps.taskId, taskId),
                eq(schema.taskSteps.stepId, '03b-business-requirements'),
                eq(schema.taskSteps.round, 1),
              ),
            ),
        (rows) => rows.length > 0,
        'revise case: 03b-business-requirements round 1 row',
      );
      check(
        'revise: 03b-business-requirements round 1 row was reset/materialized',
        targetRows.length > 0,
        targetRows,
      );
    }

    // --- Case 3: plain done --------------------------------------------------------------
    // 04a has no loop hooks and is excluded from quick_bugfix, so the task completes.
    {
      const taskId = await makeTask('plain done dup', {
        executionPath: 'quick_bugfix',
        currentStepId: '04a-spec-audit',
        currentRound: 0,
      });
      await insertDoneStep(taskId, '04a-spec-audit', 0, 4.6, {});
      await enqueueDuplicate(taskId, '04a-spec-audit', 0);

      const task = await pollUntil(
        () => loadTask(db, taskId),
        (t) => t.status === 'completed',
        'plain-done case: task completing',
      );
      check(
        'plain done: task completed (forward hand-off, no loop/revise)',
        task.status === 'completed',
        task,
      );
    }

    // --- Case 4: chain moved -------------------------------------------------------------
    // The task points elsewhere, so nothing may be re-driven regardless of the output.
    {
      const taskId = await makeTask('chain moved dup', {
        currentStepId: '08b-test-management',
        currentRound: 0,
      });
      await insertDoneStep(taskId, '07b-phase-4-validate', 0, 7.7, {
        verdict: 'ISSUES_FOUND',
        findingsSummary: 'would have been blocking, but the chain moved on',
      });
      const before = await loadTask(db, taskId);
      const job = await enqueueDuplicate(taskId, '07b-phase-4-validate', 0);
      const state = await pollUntil(
        () => job.getState(),
        (s) => s === 'completed' || s === 'failed',
        'chain moved case: duplicate advance job settling',
      );
      if (state === 'failed') {
        check('chain moved: the duplicate advance job did not fail', false, state);
      }
      const after = await loadTask(db, taskId);
      check(
        'chain moved: the task pointer is unchanged',
        after?.currentStepId === before?.currentStepId &&
          after?.currentRound === before?.currentRound,
        { before, after },
      );
      const implementRows = await db
        .select({ id: schema.taskSteps.id })
        .from(schema.taskSteps)
        .where(
          and(
            eq(schema.taskSteps.taskId, taskId),
            eq(schema.taskSteps.stepId, '07-phase-2-implement'),
          ),
        );
      check(
        'chain moved: nothing was re-driven at 07-phase-2-implement',
        implementRows.length === 0,
        implementRows,
      );
    }

    // --- Case 5: fix-loop gate accepted on a duplicate delivery -------------------------
    // A duplicate submit carrying the gate's Accept must resolve the gate, not rebuild
    // loop_back from the blocking output the Accept was meant to stand down.
    {
      const taskId = await makeTask('gate accept dup', {
        executionPath: 'quick_bugfix',
        currentStepId: '07b-phase-4-validate',
        currentRound: 0,
      });
      await insertDoneStep(taskId, '07b-phase-4-validate', 0, 7.7, {
        verdict: 'ISSUES_FOUND',
        findingsSummary: 'smoke-forced blocking finding',
      });
      await enqueueDuplicate(taskId, '07b-phase-4-validate', 0, {
        [FIX_LOOP_ACTION_FIELD]: 'accept',
      });

      const task = await pollUntil(
        () => loadTask(db, taskId),
        (t) => t.currentStepId === '07c-ddev-reconcile' && t.currentRound === 0,
        'gate-accept case: task advancing to 07c-ddev-reconcile at round 0',
      );
      check(
        'gate accept: task advanced to the successor at the SAME round (not 07-phase-2-implement round 1)',
        task.currentStepId === '07c-ddev-reconcile' && task.currentRound === 0,
        task,
      );

      const events = await db
        .select({ payload: schema.taskEvents.payload })
        .from(schema.taskEvents)
        .where(
          and(
            eq(schema.taskEvents.taskId, taskId),
            eq(schema.taskEvents.eventType, 'fix_loop.accepted'),
          ),
        );
      check('gate accept: a fix_loop.accepted event was recorded', events.length > 0, events);

      const gateRow = await db
        .select({ status: schema.taskSteps.status })
        .from(schema.taskSteps)
        .where(
          and(
            eq(schema.taskSteps.taskId, taskId),
            eq(schema.taskSteps.stepId, '07b-phase-4-validate'),
            eq(schema.taskSteps.round, 0),
          ),
        );
      check(
        'gate accept: the gate row stayed done (not re-parked)',
        gateRow[0]?.status === 'done',
        gateRow,
      );
    }

    // --- Case 6: gate answer sent after the failure reopens the task --------------------
    // The task failed while the gate waited; the Accept sent afterward still resolves it.
    {
      const taskId = await makeTask('gate accept after failure dup', {
        status: 'failed',
        completedAt: new Date(Date.now() - 60_000),
        executionPath: 'quick_bugfix',
        currentStepId: '07b-phase-4-validate',
        currentRound: 0,
      });
      await insertDoneStep(taskId, '07b-phase-4-validate', 0, 7.7, {
        verdict: 'ISSUES_FOUND',
        findingsSummary: 'smoke-forced blocking finding',
      });
      await enqueueDuplicate(taskId, '07b-phase-4-validate', 0, {
        [FIX_LOOP_ACTION_FIELD]: 'accept',
      });

      const task = await pollUntil(
        () => loadTask(db, taskId),
        (t) => t.currentStepId === '07c-ddev-reconcile' && t.currentRound === 0,
        'gate-accept-after-failure case: task advancing to 07c-ddev-reconcile at round 0',
      );
      check(
        'gate accept after failure: task status is no longer failed',
        task.status !== 'failed',
        task,
      );

      const events = await db
        .select({ payload: schema.taskEvents.payload })
        .from(schema.taskEvents)
        .where(
          and(
            eq(schema.taskEvents.taskId, taskId),
            eq(schema.taskEvents.eventType, 'fix_loop.accepted'),
          ),
        );
      check(
        'gate accept after failure: a fix_loop.accepted event was recorded',
        events.length > 0,
        events,
      );
    }

    // --- Case 7: a failure after the answer stands ---------------------------------------
    // The gate answer was sent before the task failed (a Stop overtook it), so it stays refused.
    {
      const taskId = await makeTask('gate accept before failure dup', {
        status: 'failed',
        completedAt: new Date(),
        executionPath: 'quick_bugfix',
        currentStepId: '07b-phase-4-validate',
        currentRound: 0,
      });
      await insertDoneStep(taskId, '07b-phase-4-validate', 0, 7.7, {
        verdict: 'ISSUES_FOUND',
        findingsSummary: 'smoke-forced blocking finding',
      });
      const job = await enqueueDuplicate(
        taskId,
        '07b-phase-4-validate',
        0,
        { [FIX_LOOP_ACTION_FIELD]: 'accept' },
        { timestamp: Date.now() - 120_000 },
      );
      const state = await pollUntil(
        () => job.getState(),
        (s) => s === 'completed' || s === 'failed',
        'gate-accept-before-failure case: duplicate advance job settling',
      );
      if (state === 'failed') {
        check('gate accept before failure: the duplicate advance job did not fail', false, state);
      }

      const task = await loadTask(db, taskId);
      check(
        'gate accept before failure: task status stayed failed',
        task?.status === 'failed',
        task,
      );
      check(
        'gate accept before failure: pointer stayed at 07b-phase-4-validate round 0',
        task?.currentStepId === '07b-phase-4-validate' && task?.currentRound === 0,
        task,
      );

      const events = await db
        .select({ payload: schema.taskEvents.payload })
        .from(schema.taskEvents)
        .where(
          and(
            eq(schema.taskEvents.taskId, taskId),
            eq(schema.taskEvents.eventType, 'fix_loop.accepted'),
          ),
        );
      check(
        'gate accept before failure: no fix_loop.accepted event was recorded',
        events.length === 0,
        events,
      );
    }

    // --- Case 8: the pickup guard reads the job's own answer, never the row's saved one ------
    // A duplicate carrying no answer must not reopen a failed task through a done row's saved accept.
    {
      const taskId = await makeTask('gate saved-answer ignored dup', {
        status: 'failed',
        completedAt: new Date(Date.now() - 60_000),
        executionPath: 'quick_bugfix',
        currentStepId: '07b-phase-4-validate',
        currentRound: 0,
      });
      await insertDoneStep(
        taskId,
        '07b-phase-4-validate',
        0,
        7.7,
        {
          verdict: 'ISSUES_FOUND',
          findingsSummary: 'smoke-forced blocking finding',
        },
        { [FIX_LOOP_ACTION_FIELD]: 'accept' },
      );
      const job = await enqueueDuplicate(taskId, '07b-phase-4-validate', 0);
      const state = await pollUntil(
        () => job.getState(),
        (s) => s === 'completed' || s === 'failed',
        'gate-saved-answer case: duplicate advance job settling',
      );
      if (state === 'failed') {
        check('gate saved answer: the duplicate advance job did not fail', false, state);
      }

      const task = await loadTask(db, taskId);
      check('gate saved answer: task status stayed failed', task?.status === 'failed', task);
      check(
        'gate saved answer: pointer stayed at 07b-phase-4-validate round 0',
        task?.currentStepId === '07b-phase-4-validate' && task?.currentRound === 0,
        task,
      );

      const events = await db
        .select({ payload: schema.taskEvents.payload })
        .from(schema.taskEvents)
        .where(
          and(
            eq(schema.taskEvents.taskId, taskId),
            eq(schema.taskEvents.eventType, 'fix_loop.accepted'),
          ),
        );
      check(
        'gate saved answer: no fix_loop.accepted event was recorded',
        events.length === 0,
        events,
      );
    }

    log.info({ checks, failures }, failures === 0 ? 'done-duplicate smoke PASSED' : 'FAILED');
    console.log(failures === 0 ? '[smoke] done-duplicate PASSED' : '[smoke] done-duplicate FAILED');
  } finally {
    try {
      if (taskIds.length > 0) {
        for (const id of taskIds) {
          await db
            .delete(schema.tasks)
            .where(eq(schema.tasks.id, id))
            .catch(() => {});
        }
      }
      if (repoId) await db.delete(schema.repositories).where(eq(schema.repositories.id, repoId));
      if (userId) await db.delete(schema.users).where(eq(schema.users.id, userId));
    } catch (cleanupErr) {
      log.warn({ err: cleanupErr }, 'cleanup db rows failed');
    }
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true }).catch(() => {});
    if (worker) await worker.close().catch(() => {});
    if (queue) await queue.close().catch(() => {});
    await closeTaskQueue().catch(() => {});
    await closeRedis().catch(() => {});
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  log.error({ err }, 'done-duplicate smoke crashed');
  console.error('[smoke] FAILED:', err);
  process.exit(1);
});
