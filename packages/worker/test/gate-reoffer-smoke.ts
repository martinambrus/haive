import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Queue } from 'bullmq';
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
import {
  buildFixLoopEscalationSchema,
  FIX_LOOP_ACTION_FIELD,
} from '../src/step-engine/steps/workflow/_fix-loop.js';
import { redriveStalledTasks, defaultDeps } from '../src/queues/stalled-redrive.js';

// The real worker over a re-offered fix-loop gate: a Retry parks the refused gate on its form again,
// the stalled sweep leaves it alone, a pre-answer or defaults never answer it, Stop fails a wedged
// row, and migration 0210 heals a legacy wedge. Stub steps stand in for the gates, so no CLI runs.

const log = logger.child({ module: 'gate-reoffer-smoke' });

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

/** Polls until the predicate holds or the deadline passes; a miss returns the last value seen so
 *  the caller's check fails with detail and the next scenario still runs. */
async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (val: T) => boolean,
  timeoutMs = 10000,
  intervalMs = 200,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!predicate(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await fn();
  }
  return last;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function createFixtureRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'haive-gate-reoffer-smoke-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'smoke@test.local']);
  git(['config', 'user.name', 'Smoke Test']);
  git(['config', 'gc.auto', '0']);
  git(['commit', '--allow-empty', '-m', 'initial']);
  return dir;
}

// Loaded at run time: the worker's typecheck must not pull api source into its program.
type StepRow = typeof schema.taskSteps.$inferSelect;
interface ApiDb {
  initDatabase: (url: string) => unknown;
}
interface ApiRedis {
  initRedis: (url: string) => unknown;
  closeRedis: () => Promise<void>;
}
interface ApiQueues {
  closeQueues: () => Promise<void>;
}
interface ApiSteps {
  retryTaskAtStep: (
    db: Database,
    taskId: string,
    userId: string,
    target: StepRow,
  ) => Promise<{ epoch: number }>;
}
interface ApiControl {
  stopActiveCliInvocations: (
    db: Database,
    taskId: string,
    opts: { failTask: boolean },
  ) => Promise<{ stopped: number }>;
}

const SRC = '07b-phase-4-validate';
const SRC_INDEX = 7.7;
const VERIFY = '08-phase-5-verify';
const VERIFY_INDEX = 8;
const EPOCH = 3;
const ANSWER = { [FIX_LOOP_ACTION_FIELD]: 'continue', fixLoopInstruction: 'try the other branch' };

interface Snap {
  task: { status: string; epoch: number } | null;
  row: {
    status: string;
    formValues: Record<string, unknown> | null;
    waitingStartedAt: Date | null;
    pauseFormOnRetry: boolean;
  } | null;
}

async function main(): Promise<void> {
  initRedis(process.env.REDIS_URL!);
  await configService.initialize(process.env.REDIS_URL!);
  const db = initDatabase(process.env.DATABASE_URL!);
  await secretsService.initialize(db);
  const masterKek = await secretsService.getMasterKek();
  await userSecretsService.initialize(db, masterKek);

  const apiDb = (await import(new URL('../../api/src/db.ts', import.meta.url).href)) as ApiDb;
  const apiRedis = (await import(
    new URL('../../api/src/redis.ts', import.meta.url).href
  )) as ApiRedis;
  const apiQueues = (await import(
    new URL('../../api/src/queues.ts', import.meta.url).href
  )) as ApiQueues;
  const apiSteps = (await import(
    new URL('../../api/src/routes/tasks/steps.ts', import.meta.url).href
  )) as ApiSteps;
  const apiControl = (await import(
    new URL('../../api/src/lib/task-control.ts', import.meta.url).href
  )) as ApiControl;
  apiRedis.initRedis(process.env.REDIS_URL!);
  apiDb.initDatabase(process.env.DATABASE_URL!);

  let fixtureDir: string | undefined;
  let userId: string | undefined;
  let repoId: string | undefined;
  const taskIds: string[] = [];
  let worker: Awaited<ReturnType<typeof startTaskWorker>> | undefined;
  let queue: Queue<TaskJobPayload> | undefined;
  const applyRecords: { stepId: string; taskId: string }[] = [];

  const stub = (id: string, index: number, autoSubmitDefaults: boolean): void => {
    stepRegistry.override({
      metadata: {
        id,
        workflowType: 'workflow',
        index,
        title: 'smoke stub',
        description: 'smoke stub gate for gate-reoffer-smoke',
        requiresCli: false,
        ...(autoSubmitDefaults ? { autoSubmitDefaults: true } : {}),
      },
      async detect() {
        return {};
      },
      form() {
        return { title: 'smoke stub', fields: [{ type: 'textarea', id: 'note', label: 'note' }] };
      },
      async apply(ctx) {
        applyRecords.push({ stepId: id, taskId: ctx.taskId });
        return {};
      },
    });
  };
  const applied = (taskId: string): number =>
    applyRecords.filter((r) => r.taskId === taskId).length;

  const snap = async (taskId: string, stepId: string): Promise<Snap> => {
    const [task] = await db
      .select({ status: schema.tasks.status, epoch: schema.tasks.orchestrationEpoch })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId));
    const [row] = await db
      .select({
        status: schema.taskSteps.status,
        formValues: schema.taskSteps.formValues,
        waitingStartedAt: schema.taskSteps.waitingStartedAt,
        pauseFormOnRetry: schema.taskSteps.pauseFormOnRetry,
      })
      .from(schema.taskSteps)
      .where(and(eq(schema.taskSteps.taskId, taskId), eq(schema.taskSteps.stepId, stepId)));
    return { task: task ?? null, row: (row as Snap['row']) ?? null };
  };

  const sweep = () => redriveStalledTasks(db, defaultDeps, { staleMs: 0 });

  const makeTask = async (
    title: string,
    stepId: string,
    status: typeof schema.tasks.$inferInsert.status,
    extra: Partial<typeof schema.tasks.$inferInsert> = {},
  ): Promise<string> => {
    const [t] = await db
      .insert(schema.tasks)
      .values({
        userId: userId!,
        repositoryId: repoId!,
        type: 'workflow',
        title,
        status,
        executionPath: 'quick_bugfix',
        currentStepId: stepId,
        currentRound: 1,
        orchestrationEpoch: EPOCH,
        ...extra,
      })
      .returning({ id: schema.tasks.id });
    if (!t) throw new Error(`task insert failed: ${title}`);
    taskIds.push(t.id);
    return t.id;
  };

  const gateRow = async (
    taskId: string,
    stepId: string,
    stepIndex: number,
    over: Partial<typeof schema.taskSteps.$inferInsert>,
  ): Promise<StepRow> => {
    const [r] = await db
      .insert(schema.taskSteps)
      .values({
        taskId,
        stepId,
        stepIndex,
        round: 1,
        title: 'smoke gate',
        detectOutput: {},
        output: { verdict: 'ISSUES_FOUND' },
        formSchema: buildFixLoopEscalationSchema(stepId, 'tests failed', 5),
        ...over,
      })
      .returning();
    if (!r) throw new Error(`step insert failed: ${stepId}`);
    return r;
  };

  const dropTask = async (taskId: string): Promise<void> => {
    await db
      .delete(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .catch(() => {});
  };

  const reparked = (s: Snap): boolean =>
    s.row?.status === 'waiting_form' &&
    s.row.formValues == null &&
    s.row.waitingStartedAt != null &&
    s.task?.status === 'waiting_user';

  try {
    fixtureDir = await createFixtureRepo();
    const now = new Date();
    userId = randomUUID();
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'gate-reoffer-smoke@test.local',
      emailBlindIndex: `gate-reoffer-${randomBytes(4).toString('hex')}`,
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
        name: 'gate-reoffer-smoke-fixture',
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

    // --- S1 / S1b: Retry re-offers a refused gate; the sweep leaves it parked ------------------
    const refused = async (
      label: string,
      stepId: string,
      index: number,
      auto: boolean,
      answer: Record<string, unknown>,
    ): Promise<void> => {
      stub(stepId, index, auto);
      const taskId = await makeTask(`gate-reoffer ${label}`, stepId, 'failed', {
        errorMessage: 'boom',
        completedAt: new Date(),
      });
      const row = await gateRow(taskId, stepId, index, {
        status: 'waiting_form',
        formValues: answer,
        waitingStartedAt: null,
      });
      let retryError: unknown = null;
      await apiSteps.retryTaskAtStep(db, taskId, userId!, row).catch((err: unknown) => {
        retryError = err;
      });
      const parked = await pollUntil(() => snap(taskId, stepId), reparked);
      check(
        `${label}: Retry parks the re-offered gate on its form, answer dropped, task waiting_user`,
        retryError === null && reparked(parked),
        { retryError: String(retryError), parked },
      );
      const epochBefore = parked.task?.epoch;
      for (let i = 0; i < 3; i++) {
        await sweep();
        await sleep(500);
      }
      const after = await snap(taskId, stepId);
      check(
        `${label}: three sweeps leave the parked row and the task epoch as they were`,
        reparked(after) &&
          after.task?.epoch === epochBefore &&
          after.row?.waitingStartedAt?.getTime() === parked.row?.waitingStartedAt?.getTime(),
        { parked, after },
      );
      check(`${label}: the step's apply never ran`, applied(taskId) === 0, applyRecords);
      await dropTask(taskId);
    };
    await refused('S1', SRC, SRC_INDEX, false, ANSWER);
    await refused('S1b', VERIFY, VERIFY_INDEX, true, { [FIX_LOOP_ACTION_FIELD]: 'continue' });

    // --- S2: a gate nobody answered is asked, never answered for the person -------------------
    const asked = async (
      label: string,
      stepId: string,
      index: number,
      auto: boolean,
      extra: Partial<typeof schema.tasks.$inferInsert>,
    ): Promise<void> => {
      stub(stepId, index, auto);
      const taskId = await makeTask(`gate-reoffer ${label}`, stepId, 'running', {
        autoContinue: true,
        ...extra,
      });
      await gateRow(taskId, stepId, index, { status: 'pending', formValues: null });
      await queue!.add(TASK_JOB_NAMES.ADVANCE_STEP, {
        taskId,
        userId: userId!,
        stepId,
        round: 1,
        epoch: EPOCH,
      });
      const first = await pollUntil(
        () => snap(taskId, stepId),
        (s) => s.row?.status !== 'pending' && s.row?.status !== 'running',
      );
      await sleep(1500);
      const final = await snap(taskId, stepId);
      check(
        `${label}: the gate parks on its form with no answer`,
        final.row?.status === 'waiting_form' && final.row.formValues == null,
        { first, final },
      );
      check(`${label}: the step's apply never ran`, applied(taskId) === 0, applyRecords);
      await dropTask(taskId);
    };
    await asked('S2a', VERIFY, VERIFY_INDEX, true, {});
    await asked('S2b', SRC, SRC_INDEX, false, {});
    await asked('S2c', SRC, SRC_INDEX, false, {
      preAnswers: { [SRC]: { [FIX_LOOP_ACTION_FIELD]: 'continue' } },
    });

    // --- S3: Stop fails a wedged row ------------------------------------------------------------
    const wedged = async (label: string): Promise<string> => {
      stub(SRC, SRC_INDEX, false);
      const taskId = await makeTask(`gate-reoffer ${label}`, SRC, 'running');
      await gateRow(taskId, SRC, SRC_INDEX, {
        status: 'pending',
        formValues: ANSWER,
        waitingStartedAt: null,
      });
      return taskId;
    };
    {
      const taskId = await wedged('S3');
      const result = await apiControl.stopActiveCliInvocations(db, taskId, { failTask: true });
      const after = await snap(taskId, SRC);
      check(
        'S3: Stop on a wedged gate row stops 1 step and fails the row and the task',
        result.stopped === 1 && after.row?.status === 'failed' && after.task?.status === 'failed',
        { result, after },
      );
      await dropTask(taskId);
    }

    // --- S4: migration 0210 heals a legacy wedge ------------------------------------------------
    {
      const taskId = await wedged('S4');
      const seed = await snap(taskId, SRC);
      const moved = await pollUntil(
        async () => {
          await sweep();
          return snap(taskId, SRC);
        },
        (s) => (s.task?.epoch ?? EPOCH) > EPOCH,
        15000,
        500,
      );
      const stillWedged = (s: Snap): boolean =>
        s.row?.status === 'pending' &&
        s.row.formValues?.[FIX_LOOP_ACTION_FIELD] === 'continue' &&
        s.task?.status === 'running';
      const moved2 = await pollUntil(
        async () => {
          await sweep();
          return snap(taskId, SRC);
        },
        (s) => (s.task?.epoch ?? 0) > (moved.task?.epoch ?? 0),
        15000,
        500,
      );
      check(
        'S4a: before the heal the sweep re-drives the wedge again and again, row and answer untouched',
        (moved.task?.epoch ?? EPOCH) > EPOCH &&
          (moved2.task?.epoch ?? 0) > (moved.task?.epoch ?? 0) &&
          stillWedged(moved) &&
          stillWedged(moved2),
        { seed, moved, moved2 },
      );

      const text = await readFile(
        new URL(
          '../../database/migrations/0210_heal_wedged_fix_loop_gate_rows.sql',
          import.meta.url,
        ),
        'utf8',
      );
      await db.$client.unsafe(text);
      const healed = await pollUntil(
        async () => {
          await sweep();
          return snap(taskId, SRC);
        },
        (s) => reparked(s) && !s.row?.pauseFormOnRetry,
        15000,
        500,
      );
      check(
        'S4c: after 0210 the next pass parks the gate: no answer, unparked flag cleared, task waiting_user',
        reparked(healed) && healed.row?.pauseFormOnRetry === false && applied(taskId) === 0,
        { healed, applied: applied(taskId) },
      );
      const epochHealed = healed.task?.epoch;
      await sweep();
      await sleep(500);
      await sweep();
      await sleep(500);
      const after = await snap(taskId, SRC);
      check(
        'S4c: two more sweeps leave the healed row and the task epoch as they were',
        reparked(after) && after.task?.epoch === epochHealed,
        { healed, after },
      );
      await dropTask(taskId);
    }

    log.info({ checks, failures }, failures === 0 ? 'gate-reoffer smoke PASSED' : 'FAILED');
    console.log(failures === 0 ? '[smoke] gate-reoffer PASSED' : '[smoke] gate-reoffer FAILED');
  } finally {
    try {
      for (const id of taskIds) await dropTask(id);
      if (repoId) await db.delete(schema.repositories).where(eq(schema.repositories.id, repoId));
      if (userId) await db.delete(schema.users).where(eq(schema.users.id, userId));
    } catch (cleanupErr) {
      log.warn({ err: cleanupErr }, 'cleanup db rows failed');
    }
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true }).catch(() => {});
    if (worker) await worker.close().catch(() => {});
    if (queue) await queue.close().catch(() => {});
    await closeTaskQueue().catch(() => {});
    await apiQueues.closeQueues().catch(() => {});
    await apiRedis.closeRedis().catch(() => {});
    await closeRedis().catch(() => {});
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  log.error({ err }, 'gate-reoffer smoke crashed');
  console.error('[smoke] gate-reoffer FAILED:', err);
  process.exit(1);
});
