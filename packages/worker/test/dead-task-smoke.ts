/**
 * A task whose run list names a step this install does not register is dead: no job fails it,
 * completes it or re-drives it. Real database and Redis; the steps are stubs and no CLI runs.
 * The task state is read through to_jsonb so the same checks run before the dead columns exist.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq, inArray, sql } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  configService,
  logger,
  secretsService,
  TASK_JOB_NAMES,
  userSecretsService,
  type WorkflowType,
} from '@haive/shared';
import { initDatabase } from '../src/db.js';
import { closeRedis, initRedis } from '../src/redis.js';
import {
  closeTaskQueue,
  getTaskQueue,
  handleResult,
  markTaskDead,
  markTaskDeadFromJob,
  processTaskJob,
  reconcileOrphanedSteps,
  resolveFixLoopGate,
  setContainerCleanupRunner,
  backfillMissingRunSeq,
} from '../src/queues/task-queue.js';
import { defaultDeps, redriveStalledTasks } from '../src/queues/stalled-redrive.js';
import { buildRunList, resolveRunList, type ResolvedTaskContext } from '../src/queues/run-list.js';
import { stepRegistry, UnresolvedStepError } from '../src/step-engine/registry.js';

const log = logger.child({ module: 'dead-task-smoke' });

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

const GONE = 'module.gone.x';
const TYPE = 'p4b_dead_smoke';
const STALE_MS = 5 * 60_000;
const longAgo = new Date(Date.now() - 10 * 60_000);

function stub(id: string, index: number) {
  stepRegistry.register({
    metadata: {
      id,
      workflowType: TYPE as WorkflowType,
      index,
      title: id,
      description: 'dead-task-smoke stub',
      requiresCli: false,
    },
    async detect() {
      return {};
    },
    form() {
      return { title: id, fields: [] };
    },
    async apply() {
      return {};
    },
  });
}

interface TaskView {
  status: string;
  epoch: number;
  deadAt: string | null;
  deadReason: string | null;
  errorMessage: string | null;
  currentStepId: string | null;
  updatedAt: string;
}

async function main(): Promise<void> {
  initRedis(process.env.REDIS_URL!);
  await configService.initialize(process.env.REDIS_URL!);
  const db = initDatabase(process.env.DATABASE_URL!);
  await secretsService.initialize(db);
  await userSecretsService.initialize(db, await secretsService.getMasterKek());
  setContainerCleanupRunner(async () => 0);
  stub('p4b-a', 1);
  stub('p4b-b', 2);
  stub('p4b-c', 3);

  const dir = await mkdtemp(path.join(os.tmpdir(), 'haive-dead-task-smoke-'));
  const userId = randomUUID();
  const now = new Date();
  const queue = getTaskQueue();

  const view = async (taskId: string): Promise<TaskView> => {
    const rows = (await db.execute(sql`
      select status, orchestration_epoch as epoch, to_jsonb(t)->>'dead_at' as "deadAt",
             to_jsonb(t)->>'dead_reason' as "deadReason", error_message as "errorMessage",
             current_step_id as "currentStepId", updated_at::text as "updatedAt"
      from tasks t where id = ${taskId}`)) as unknown as TaskView[];
    return rows[0]!;
  };
  const eventTypes = async (taskId: string) =>
    (
      await db
        .select({ t: schema.taskEvents.eventType })
        .from(schema.taskEvents)
        .where(eq(schema.taskEvents.taskId, taskId))
    ).map((r) => r.t);
  const stepRowCount = async (taskId: string) =>
    (
      await db
        .select({ id: schema.taskSteps.id })
        .from(schema.taskSteps)
        .where(eq(schema.taskSteps.taskId, taskId))
    ).length;
  const jobsFor = async (taskId: string) =>
    (await queue.getJobs(['waiting', 'active', 'delayed', 'prioritized', 'completed', 'failed']))
      .filter((j) => j?.data?.taskId === taskId)
      .map((j) => j.name);
  const runSeqs = async (taskId: string) =>
    (
      await db
        .select({ runSeq: schema.taskSteps.runSeq })
        .from(schema.taskSteps)
        .where(eq(schema.taskSteps.taskId, taskId))
    ).map((r) => r.runSeq);

  const makeTask = async (
    title: string,
    over: Partial<typeof schema.tasks.$inferInsert> & { snapshot?: string[] } = {},
  ): Promise<string> => {
    const { snapshot = ['p4b-a', 'p4b-b', 'p4b-c'], ...rest } = over;
    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId,
        repositoryId,
        type: TYPE,
        title,
        status: 'running',
        autoContinue: false,
        orchestrationEpoch: 3,
        currentStepId: 'p4b-a',
        currentRound: 0,
        runListSnapshot: snapshot,
        ...rest,
      })
      .returning({ id: schema.tasks.id });
    return task!.id;
  };
  const makeRow = async (
    taskId: string,
    stepId: string,
    status: 'done' | 'waiting_form' | 'waiting_cli' | 'running',
    over: Partial<typeof schema.taskSteps.$inferInsert> = {},
  ) => {
    const [row] = await db
      .insert(schema.taskSteps)
      .values({ taskId, stepId, stepIndex: 1, round: 0, title: stepId, status, ...over })
      .returning();
    return row!;
  };
  const ctxFor = (
    taskId: string,
    snapshot: string[],
    over: Partial<ResolvedTaskContext> = {},
  ): ResolvedTaskContext => ({
    taskId,
    userId,
    workflowType: TYPE as WorkflowType,
    repoPath: dir,
    workspacePath: dir,
    cliProviderId: null,
    ignoreSavedStepClis: false,
    executionPath: null,
    metadata: null,
    orchestrationEpoch: 3,
    currentStepId: 'p4b-a',
    currentRound: 0,
    status: 'running',
    completedAt: null,
    runListStrategy: 'static',
    runListSnapshot: snapshot,
    fixLoop: null,
    ...over,
  });
  const job = (name: string, data: Record<string, unknown>) =>
    ({
      id: randomBytes(4).toString('hex'),
      name,
      data,
      timestamp: Date.now(),
      moveToDelayed: async () => undefined,
    }) as unknown as Parameters<typeof processTaskJob>[0];
  const run = async (name: string, data: Record<string, unknown>): Promise<unknown> => {
    try {
      await processTaskJob(job(name, data));
      return null;
    } catch (err) {
      return err;
    }
  };
  const markDeadRaw = (taskId: string) =>
    db.execute(sql`update tasks set dead_at = now(), dead_reason = 'smoke' where id = ${taskId}`);

  let repositoryId = '';
  const slugs = [TYPE];
  try {
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'dead-task-smoke@test.local',
      emailBlindIndex: `dead-task-${randomBytes(4).toString('hex')}`,
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
        name: 'dead-task-smoke',
        source: 'local_path',
        localPath: dir,
        storagePath: dir,
        status: 'ready',
      })
      .returning();
    repositoryId = repo!.id;
    await db.insert(schema.taskTypeDefinitions).values({
      slug: TYPE,
      displayName: 'p4b dead smoke',
      runListStrategy: 'static',
      source: 'smoke',
    });

    // --- the pure split and the typed error ------------------------------------------
    const split = resolveRunList(ctxFor('t', ['p4b-a', 'p4b-b', GONE, 'p4b-c']), stepRegistry);
    check(
      'resolveRunList splits a snapshot into the steps that resolve and the ids that do not',
      JSON.stringify(split.steps.map((s) => s.metadata.id)) ===
        JSON.stringify(['p4b-a', 'p4b-b', 'p4b-c']) &&
        JSON.stringify(split.unresolved) === JSON.stringify([GONE]),
      split,
    );
    let thrown: unknown;
    try {
      await buildRunList(ctxFor('t', ['p4b-a', GONE]), db);
    } catch (err) {
      thrown = err;
    }
    check(
      'buildRunList throws the typed error naming the unresolved ids',
      thrown instanceof UnresolvedStepError &&
        JSON.stringify(thrown.ids) === JSON.stringify([GONE]),
      thrown,
    );

    // --- markTaskDead's fence --------------------------------------------------------
    const fenceOf = async (status: string, over: Partial<typeof schema.tasks.$inferInsert> = {}) =>
      makeTask(`fence-${status}`, { status: status as 'running', ...over });
    for (const status of ['cancelled', 'completed'] as const) {
      const id = await fenceOf(status);
      const landed = await markTaskDead(db, id, 'smoke', { epoch: 3 });
      const v = await view(id);
      check(`markTaskDead refuses a ${status} task`, landed === false && v.deadAt === null, {
        landed,
        v,
      });
    }
    {
      const id = await fenceOf('running');
      const landed = await markTaskDead(db, id, 'smoke', { epoch: 2 });
      check(
        'markTaskDead refuses a task that moved to another epoch',
        landed === false && (await view(id)).deadAt === null,
        landed,
      );
    }
    {
      const id = await fenceOf('failed', { errorMessage: 'boom' });
      const first = await markTaskDead(db, id, 'step gone', { epoch: 3, unresolved: [GONE] });
      const afterFirst = await view(id);
      const second = await markTaskDead(db, id, 'step gone again', { epoch: 3 });
      const afterSecond = await view(id);
      const events = (await eventTypes(id)).filter((t) => t === 'task.dead');
      check(
        'markTaskDead lands on a failed task without changing its status or epoch',
        first === true &&
          afterFirst.deadAt !== null &&
          afterFirst.deadReason === 'step gone' &&
          afterFirst.status === 'failed' &&
          afterFirst.epoch === 3,
        afterFirst,
      );
      check(
        'markTaskDead is idempotent: the second call writes nothing',
        second === false &&
          afterSecond.deadAt === afterFirst.deadAt &&
          afterSecond.deadReason === 'step gone' &&
          events.length === 1,
        { second, afterSecond, events },
      );
    }

    const startedDead: string[] = [];
    // --- START ----------------------------------------------------------------------
    for (const [name, snapshot] of [
      ['only the gone step', [GONE]],
      ['a gone step after live ones', ['p4b-a', 'p4b-b', GONE]],
    ] as const) {
      const id = await makeTask(`start-${name}`, {
        status: 'queued',
        currentStepId: null,
        snapshot: [...snapshot],
      });
      const threw = await run(TASK_JOB_NAMES.START, { taskId: id, userId });
      startedDead.push(id);
      const v = await view(id);
      const events = await eventTypes(id);
      check(
        `START with a snapshot naming ${name} leaves the task dead, unclaimed and not failed`,
        v.deadAt !== null &&
          v.deadReason !== null &&
          v.status === 'queued' &&
          v.currentStepId === null &&
          v.epoch === 3 &&
          v.errorMessage === null &&
          events.includes('task.dead') &&
          !events.includes('task.running') &&
          (await jobsFor(id)).length === 0 &&
          threw === null,
        { v, events, threw: String(threw) },
      );
    }

    // --- ADVANCE --------------------------------------------------------------------
    {
      const id = await makeTask('advance-unknown-current', { currentStepId: GONE });
      const threw = await run(TASK_JOB_NAMES.ADVANCE_STEP, {
        taskId: id,
        userId,
        stepId: GONE,
        round: 0,
        epoch: 3,
      });
      const v = await view(id);
      check(
        'ADVANCE for an unknown step at the current epoch leaves the task dead, not failed',
        v.deadAt !== null &&
          v.status === 'running' &&
          v.epoch === 3 &&
          v.errorMessage === null &&
          (await eventTypes(id)).includes('task.dead') &&
          threw === null,
        { v, threw: String(threw) },
      );
    }
    {
      const id = await makeTask('advance-unknown-moved-past');
      const before = await view(id);
      await run(TASK_JOB_NAMES.ADVANCE_STEP, {
        taskId: id,
        userId,
        stepId: GONE,
        round: 0,
        epoch: 3,
      });
      const v = await view(id);
      check(
        'ADVANCE for an unknown step the task has moved past is dropped, not dead',
        v.deadAt === null &&
          v.status === 'running' &&
          v.currentStepId === before.currentStepId &&
          !(await eventTypes(id)).includes('task.dead'),
        v,
      );
    }
    {
      const id = await makeTask('advance-unknown-stale');
      const before = await view(id);
      await run(TASK_JOB_NAMES.ADVANCE_STEP, {
        taskId: id,
        userId,
        stepId: GONE,
        round: 0,
        epoch: 2,
      });
      const v = await view(id);
      check(
        'ADVANCE for an unknown step at a stale epoch writes nothing',
        v.deadAt === null &&
          v.status === 'running' &&
          v.updatedAt === before.updatedAt &&
          (await eventTypes(id)).length === 0,
        v,
      );
    }
    {
      const id = await makeTask('advance-already-dead');
      await markDeadRaw(id).catch(() => undefined);
      const before = await view(id);
      await run(TASK_JOB_NAMES.ADVANCE_STEP, {
        taskId: id,
        userId,
        stepId: 'p4b-a',
        round: 0,
        epoch: 3,
      });
      const v = await view(id);
      check(
        'ADVANCE on a task that is already dead writes nothing and starts no step',
        before.deadAt !== null &&
          v.updatedAt === before.updatedAt &&
          v.epoch === 3 &&
          (await eventTypes(id)).length === 0 &&
          (await stepRowCount(id)) === 0 &&
          (await jobsFor(id)).length === 0,
        { before, v },
      );
    }

    // --- the forward walks never complete a task whose current step is not in its list --
    {
      const id = await makeTask('walk-missing', { snapshot: ['p4b-b', 'p4b-c'] });
      const row = await makeRow(id, 'p4b-a', 'done');
      await handleResult(db, ctxFor(id, ['p4b-b', 'p4b-c']), 'p4b-a', {
        status: 'done',
        row,
        output: {},
      }).catch((err) => log.info({ err: String(err) }, 'walk threw'));
      const v = await view(id);
      check(
        'the forward walk marks a task dead, and does not complete it, when the finished step is not in its list',
        v.deadAt !== null &&
          v.status === 'running' &&
          (await eventTypes(id)).includes('task.dead') &&
          (await jobsFor(id)).length === 0,
        v,
      );
    }
    {
      const id = await makeTask('gate-missing', { snapshot: ['p4b-b', 'p4b-c'] });
      const gate = await makeRow(id, 'p4b-a', 'waiting_form');
      await resolveFixLoopGate(db, ctxFor(id, ['p4b-b', 'p4b-c']), gate, 'accept', 0, '').catch(
        (err) => log.info({ err: String(err) }, 'gate threw'),
      );
      const v = await view(id);
      check(
        'the fix-loop gate accept walk marks the task dead, and does not complete it, when its step is not in the list',
        v.deadAt !== null &&
          v.status === 'running' &&
          (await eventTypes(id)).includes('task.dead') &&
          (await jobsFor(id)).length === 0,
        v,
      );
    }
    {
      const id = await makeTask('walk-forward', { snapshot: ['p4b-a', 'p4b-b'] });
      const row = await makeRow(id, 'p4b-a', 'done');
      await handleResult(db, ctxFor(id, ['p4b-a', 'p4b-b']), 'p4b-a', {
        status: 'done',
        row,
        output: {},
      });
      const v = await view(id);
      check(
        'control: a finished step in its list hands the task to the next one',
        v.deadAt === null &&
          v.status === 'running' &&
          v.currentStepId === 'p4b-b' &&
          (await jobsFor(id)).length === 1,
        v,
      );
    }
    {
      const id = await makeTask('walk-last', { snapshot: ['p4b-a'] });
      const row = await makeRow(id, 'p4b-a', 'done');
      await handleResult(db, ctxFor(id, ['p4b-a']), 'p4b-a', { status: 'done', row, output: {} });
      const v = await view(id);
      check(
        'control: the last step of its list completes the task',
        v.deadAt === null && v.status === 'completed',
        v,
      );
    }
    {
      const id = await makeTask('revise-gone');
      const row = await makeRow(id, 'p4b-a', 'done');
      await handleResult(db, ctxFor(id, ['p4b-a', 'p4b-b']), 'p4b-a', {
        status: 'revise',
        row,
        targetStepId: GONE,
        sourceStepId: 'p4b-a',
      }).catch((err) => log.info({ err: String(err) }, 'revise threw'));
      const v = await view(id);
      check(
        'a revise to an unregistered step leaves the task dead, not failed',
        v.deadAt !== null &&
          v.status === 'running' &&
          v.errorMessage === null &&
          (await jobsFor(id)).length === 0,
        v,
      );
    }

    // --- the job's catch ------------------------------------------------------------
    for (const [status, expectDead] of [
      ['pending', false],
      ['running', true],
    ] as const) {
      const id = await makeTask(`catch-owned-${status}`);
      await makeRow(id, 'p4b-a', status === 'pending' ? 'running' : status);
      if (status === 'pending') {
        await db
          .update(schema.taskSteps)
          .set({ status: 'pending' })
          .where(eq(schema.taskSteps.taskId, id));
      }
      await markTaskDeadFromJob(db, id, 'gone', {
        epoch: 3,
        unresolved: [GONE],
        stepId: 'p4b-a',
        round: 0,
      });
      const v = await view(id);
      check(
        expectDead
          ? 'a job that still owns its step row marks the task dead from its catch'
          : 'a job whose step row a Retry reset leaves the task alive from its catch',
        (v.deadAt !== null) === expectDead && v.status === 'running',
        v,
      );
    }
    {
      const id = await makeTask('catch-typed', { snapshot: ['p4b-a', GONE] });
      const threw = await run(TASK_JOB_NAMES.ADVANCE_STEP, {
        taskId: id,
        userId,
        stepId: 'p4b-a',
        round: 0,
        epoch: 3,
      });
      const v = await view(id);
      check(
        'an unresolved id met inside a job leaves the task dead, not failed',
        v.deadAt !== null && v.status === 'running' && v.errorMessage === null && threw === null,
        { v, threw: String(threw) },
      );
    }
    {
      const id = await makeTask('catch-plain');
      const threw = await run(TASK_JOB_NAMES.ADVANCE_STEP, { taskId: id, userId, epoch: 3 });
      const v = await view(id);
      check(
        'any other error in a job still fails the task',
        v.deadAt === null && v.status === 'failed' && threw instanceof Error,
        { v, threw: String(threw) },
      );
    }

    // --- the sweeps skip a dead task -------------------------------------------------
    const stale = { updatedAt: longAgo, createdAt: longAgo };
    const liveStalled = await makeTask('sweep-live', stale);
    const deadStalled = await makeTask('sweep-dead', stale);
    const liveUnstarted = await makeTask('sweep-live-unstarted', {
      ...stale,
      status: 'queued',
      currentStepId: null,
    });
    const deadUnstarted = await makeTask('sweep-dead-unstarted', {
      ...stale,
      status: 'queued',
      currentStepId: null,
    });
    const liveParked = await makeTask('sweep-live-parked', stale);
    const deadParked = await makeTask('sweep-dead-parked', stale);
    const parkedRows = [];
    for (const id of [liveParked, deadParked]) {
      const row = await makeRow(id, 'p4b-a', 'waiting_cli', { updatedAt: longAgo });
      await db.insert(schema.cliInvocations).values({
        taskId: id,
        taskStepId: row.id,
        mode: 'cli',
        prompt: 'dead-task-smoke',
        createdAt: longAgo,
      });
      parkedRows.push(row);
    }
    const deadBoot = await makeTask('sweep-dead-boot');
    const deadBootRow = await makeRow(deadBoot, 'p4b-a', 'running');
    const deadBootParked = await makeTask('sweep-dead-boot-parked');
    const deadBootParkedRow = await makeRow(deadBootParked, 'p4b-a', 'waiting_cli');
    const liveBackfill = await makeTask('sweep-live-backfill', { status: 'created' });
    const deadBackfill = await makeTask('sweep-dead-backfill', { status: 'created' });
    await makeRow(liveBackfill, 'p4b-b', 'done');
    await makeRow(deadBackfill, 'p4b-b', 'done');
    for (const id of [
      deadStalled,
      deadUnstarted,
      deadParked,
      deadBoot,
      deadBootParked,
      deadBackfill,
    ]) {
      await markDeadRaw(id).catch(() => undefined);
    }
    const owedNothing = async () => new Set<string>();
    await db
      .update(schema.tasks)
      .set({ updatedAt: longAgo })
      .where(inArray(schema.tasks.id, startedDead));
    const sweepDeps = { ...defaultDeps, queuedInvocationIds: owedNothing };
    await redriveStalledTasks(db, sweepDeps, { staleMs: STALE_MS });
    await redriveStalledTasks(db, sweepDeps, { staleMs: STALE_MS });
    check(
      'control: the stalled-redrive sweep re-drives a live stalled task and queues a START for a live queued one',
      (await view(liveStalled)).epoch > 3 &&
        (await jobsFor(liveUnstarted)).includes(TASK_JOB_NAMES.START),
      { epoch: (await view(liveStalled)).epoch, jobs: await jobsFor(liveUnstarted) },
    );
    check(
      'control: the stalled-redrive sweep recovers a live parked step whose run was lost',
      (await view(liveParked)).epoch > 3,
      await view(liveParked),
    );
    const dead = [deadStalled, deadUnstarted, deadParked, ...startedDead];
    const deadViews = await Promise.all(dead.map(view));
    check(
      'two stalled-redrive sweeps leave a dead running, queued, parked and START-killed task alone: epoch unchanged, no job queued',
      deadViews.every((v) => v.deadAt !== null && v.epoch === 3) &&
        (await Promise.all(startedDead.map(view))).every((v) => v.status === 'queued') &&
        (await Promise.all(dead.map(jobsFor))).every((jobs) => jobs.length === 0),
      { deadViews, jobs: await Promise.all(dead.map(jobsFor)) },
    );
    const reconcileAdvances: string[] = [];
    await reconcileOrphanedSteps(db, {
      enqueueAdvance: async (taskId: string) => {
        reconcileAdvances.push(taskId);
      },
      queuedInvocationIds: owedNothing,
    });
    const bootRows = await db
      .select({ id: schema.taskSteps.id, status: schema.taskSteps.status })
      .from(schema.taskSteps)
      .where(inArray(schema.taskSteps.id, [deadBootRow.id, deadBootParkedRow.id]));
    check(
      'boot reconcile leaves a dead task with a running or parked step alone: epoch unchanged, row unchanged, no re-drive',
      (await view(deadBoot)).epoch === 3 &&
        (await view(deadBootParked)).epoch === 3 &&
        bootRows.find((r) => r.id === deadBootRow.id)?.status === 'running' &&
        bootRows.find((r) => r.id === deadBootParkedRow.id)?.status === 'waiting_cli' &&
        !reconcileAdvances.includes(deadBoot) &&
        !reconcileAdvances.includes(deadBootParked),
      { bootRows, reconcileAdvances },
    );
    await backfillMissingRunSeq(db);
    check(
      'the run_seq backfill stamps a live task and skips a dead one',
      (await runSeqs(liveBackfill)).every((s) => s !== null) &&
        (await runSeqs(deadBackfill)).every((s) => s === null),
      { live: await runSeqs(liveBackfill), dead: await runSeqs(deadBackfill) },
    );
  } finally {
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
    await db
      .delete(schema.taskTypeDefinitions)
      .where(inArray(schema.taskTypeDefinitions.slug, slugs));
    await db.delete(schema.repositories).where(eq(schema.repositories.userId, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await rm(dir, { recursive: true, force: true });
    await queue.obliterate({ force: true }).catch(() => undefined);
    await closeTaskQueue();
    await closeRedis();
  }
}

main()
  .then(() => {
    log.info({ checks, failures }, failures === 0 ? 'dead task smoke passed' : 'FAILED');
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    log.error({ err }, 'dead task smoke crashed');
    process.exit(1);
  });
