/**
 * A task whose run list names a step this install does not register is dead: no job fails it,
 * completes it or re-drives it, and boot marks one and revives it once the steps resolve again.
 * Real database and Redis; the steps are stubs and no CLI runs.
 * The task state is read through to_jsonb so the same checks run before the dead columns exist.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  CONFIG_KEYS,
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
  enqueueAdvance,
  getTaskQueue,
  handleResult,
  markTaskDead,
  markTaskDeadFromJob,
  processTaskJob,
  reconcileOrphanedSteps,
  recoverParkedStep,
  resolveFixLoopGate,
  setContainerCleanupRunner,
  backfillMissingRunSeq,
} from '../src/queues/task-queue.js';
import { resetStepAndDownstream } from '../src/queues/_step-reset.js';
import { checkProviderRecovery } from '../src/queues/usage-poll-queue.js';
import { closePrPollQueue, runPrPollTick } from '../src/queues/pr-poll-queue.js';
import { defaultDeps, redriveStalledTasks } from '../src/queues/stalled-redrive.js';
import { reconcileDeadTasks, retryHeldRevivals } from '../src/queues/dead-task-boot.js';
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

const applied: Record<string, number> = {};

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
      return { title: id, fields: [{ id: 'note', label: 'note', type: 'text' }] };
    },
    async apply() {
      applied[id] = (applied[id] ?? 0) + 1;
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
  const eventPayloads = async (taskId: string, type: string) =>
    (
      await db
        .select({ payload: schema.taskEvents.payload })
        .from(schema.taskEvents)
        .where(and(eq(schema.taskEvents.taskId, taskId), eq(schema.taskEvents.eventType, type)))
    ).map((r) => r.payload as Record<string, unknown>);
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
    status: 'done' | 'failed' | 'waiting_form' | 'waiting_cli' | 'running',
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

    {
      const id = await makeTask('start-redelivered-running', {
        status: 'running',
        snapshot: ['p4b-a', GONE],
      });
      await run(TASK_JOB_NAMES.START, { taskId: id, userId });
      const v = await view(id);
      check(
        'a redelivered START on a task already running leaves it alive',
        v.deadAt === null && v.status === 'running',
        v,
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
      const id = await makeTask('advance-unknown-answered-moved-past');
      const before = await view(id);
      await run(TASK_JOB_NAMES.ADVANCE_STEP, {
        taskId: id,
        userId,
        stepId: GONE,
        round: 0,
        epoch: 3,
        formValues: { ok: true },
      });
      const v = await view(id);
      check(
        'an ANSWERED ADVANCE for an unknown step the task has moved past is dropped, not dead',
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
      const [payload] = await eventPayloads(id, 'task.dead');
      check(
        'the forward walk records no unresolved id when the finished step is registered',
        JSON.stringify(payload?.unresolved) === '[]' && payload?.stepId === 'p4b-a',
        payload,
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
      const [payload] = await eventPayloads(id, 'task.dead');
      check(
        'the fix-loop gate accept walk records no unresolved id when its step is registered',
        JSON.stringify(payload?.unresolved) === '[]' && payload?.stepId === 'p4b-a',
        payload,
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
      const [payload] = await eventPayloads(id, 'task.dead');
      check(
        'a revise to an unregistered step records that step as unresolved',
        JSON.stringify(payload?.unresolved) === JSON.stringify([GONE]),
        payload,
      );
    }

    // --- the job's catch ------------------------------------------------------------
    for (const c of [
      { name: 'pending-current', row: 'pending', taskEpoch: 3, dead: true },
      { name: 'pending-retried', row: 'pending', taskEpoch: 4, dead: false },
      { name: 'running', row: 'running', taskEpoch: 3, dead: true },
      { name: 'stopped', row: 'failed', taskEpoch: 3, dead: false },
    ] as const) {
      const id = await makeTask(`catch-owned-${c.name}`, { orchestrationEpoch: c.taskEpoch });
      await makeRow(id, 'p4b-a', 'running');
      if (c.row !== 'running') {
        await db
          .update(schema.taskSteps)
          .set({ status: c.row })
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
        `a job's catch on a ${c.name} step row ${c.dead ? 'marks the task dead' : 'leaves the task alive'}`,
        (v.deadAt !== null) === c.dead,
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

    // --- the allowance watcher and the PR poller skip a dead task ----------------------
    const [provider] = await db
      .insert(schema.cliProviders)
      .values({ userId, name: 'claude-code', label: 'dead-task-smoke' })
      .returning({ id: schema.cliProviders.id });
    const armedWatch = {
      status: 'failed' as const,
      awaitingAllowanceProviderId: provider!.id,
      awaitingProviderReason: 'rate_limit' as const,
      awaitingProviderSince: longAgo,
      allowanceResetAt: longAgo,
    };
    const liveArmed = await makeTask('watch-live', armedWatch);
    const deadArmed = await makeTask('watch-dead', armedWatch);
    const livePr = await makeTask('pr-live', {
      status: 'waiting_pr',
      prState: 'merged',
      prFinalizeMode: 'auto',
    });
    const deadPr = await makeTask('pr-dead', {
      status: 'waiting_pr',
      prState: 'merged',
      prFinalizeMode: 'auto',
    });
    for (const id of [liveArmed, deadArmed]) await makeRow(id, 'p4b-a', 'failed');
    for (const id of [livePr, deadPr]) await makeRow(id, '13-pr-wait', 'waiting_form');
    for (const id of [deadArmed, deadPr]) await markDeadRaw(id);
    const watchState = async (taskId: string) =>
      (
        await db
          .select({
            status: schema.tasks.status,
            watch: schema.tasks.awaitingAllowanceProviderId,
            autoResumes: schema.tasks.allowanceAutoResumeCount,
            replenishedAt: schema.tasks.allowanceReplenishedAt,
          })
          .from(schema.tasks)
          .where(eq(schema.tasks.id, taskId))
      )[0]!;
    const stepStatuses = async (taskId: string) =>
      (
        await db
          .select({ status: schema.taskSteps.status })
          .from(schema.taskSteps)
          .where(eq(schema.taskSteps.taskId, taskId))
      ).map((r) => r.status);
    await configService.set(CONFIG_KEYS.ALLOWANCE_WATCH_MODE, 'auto');
    await configService.set(CONFIG_KEYS.PR_WORKFLOW_ENABLED, 'true');
    try {
      await checkProviderRecovery(db);
      await runPrPollTick(db);
    } finally {
      await configService.set(CONFIG_KEYS.ALLOWANCE_WATCH_MODE, 'notify');
      await configService.set(CONFIG_KEYS.PR_WORKFLOW_ENABLED, 'false');
    }
    check(
      'control: the provider recovery check auto-resumes a live failed task and queues its ADVANCE',
      (await watchState(liveArmed)).status === 'running' &&
        (await jobsFor(liveArmed)).includes(TASK_JOB_NAMES.ADVANCE_STEP),
      { state: await watchState(liveArmed), jobs: await jobsFor(liveArmed) },
    );
    check(
      'the provider recovery check leaves a dead failed task alone: still failed, watch kept, step row failed, no job',
      (await watchState(deadArmed)).status === 'failed' &&
        (await watchState(deadArmed)).watch === provider!.id &&
        (await watchState(deadArmed)).autoResumes === 0 &&
        (await watchState(deadArmed)).replenishedAt === null &&
        (await stepStatuses(deadArmed)).every((s) => s === 'failed') &&
        (await jobsFor(deadArmed)).length === 0,
      {
        state: await watchState(deadArmed),
        steps: await stepStatuses(deadArmed),
        jobs: await jobsFor(deadArmed),
      },
    );
    check(
      'control: a PR poll tick queues the ADVANCE for a live merged waiting_pr task',
      (await jobsFor(livePr)).includes(TASK_JOB_NAMES.ADVANCE_STEP),
      await jobsFor(livePr),
    );
    check(
      'a PR poll tick queues nothing for a dead merged waiting_pr task',
      (await jobsFor(deadPr)).length === 0,
      await jobsFor(deadPr),
    );
    // --- the fences refuse a task that went dead after the sweep read it ----------------
    const fenceTargets: Record<string, { id: string; rowId: string }> = {};
    for (const name of ['live', 'dead', 'dead-reset']) {
      const id = await makeTask(`fence-${name}`);
      const row = await makeRow(id, 'p4b-a', 'waiting_cli');
      fenceTargets[name] = { id, rowId: row.id };
      if (name !== 'live') await markDeadRaw(id);
    }
    const fenceAdvances: string[] = [];
    const fenceDeps = {
      enqueueAdvance: async (taskId: string) => {
        fenceAdvances.push(taskId);
      },
      queuedInvocationIds: owedNothing,
    };
    const orphan = (t: { id: string; rowId: string }) => ({
      taskStepId: t.rowId,
      taskId: t.id,
      stepId: 'p4b-a',
      round: 0,
      userId,
      epoch: 3,
      currentStepId: 'p4b-a',
      currentRound: 0,
    });
    const liveRecovered = await recoverParkedStep(
      db,
      orphan(fenceTargets.live!),
      new Set(),
      fenceDeps,
    );
    const deadRecovered = await recoverParkedStep(
      db,
      orphan(fenceTargets.dead!),
      new Set(),
      fenceDeps,
    );
    check(
      'the parked-step recovery fence re-drives a live task and refuses a dead one: epoch unchanged, no advance',
      liveRecovered &&
        !deadRecovered &&
        (await view(fenceTargets.live!.id)).epoch === 4 &&
        (await view(fenceTargets.dead!.id)).epoch === 3 &&
        fenceAdvances.length === 1 &&
        fenceAdvances[0] === fenceTargets.live!.id,
      { liveRecovered, deadRecovered, fenceAdvances },
    );
    const liveReset = await resetStepAndDownstream(db, fenceTargets.live!.id, 'p4b-a', 0, 4);
    const deadReset = await resetStepAndDownstream(
      db,
      fenceTargets['dead-reset']!.id,
      'p4b-a',
      0,
      3,
    );
    check(
      'the step reset fence resets a live task at its epoch and refuses a dead one: epoch unchanged, row unchanged',
      typeof liveReset === 'object' &&
        liveReset !== null &&
        deadReset === 'superseded' &&
        (await view(fenceTargets['dead-reset']!.id)).epoch === 3 &&
        (await stepStatuses(fenceTargets['dead-reset']!.id)).every((st) => st === 'waiting_cli'),
      { liveReset, deadReset, steps: await stepStatuses(fenceTargets['dead-reset']!.id) },
    );

    // --- the boot pass --------------------------------------------------------------
    const jobsOf = async (taskId: string) =>
      (await queue.getJobs(['waiting', 'active', 'delayed', 'prioritized', 'completed', 'failed']))
        .filter((j) => j?.data?.taskId === taskId)
        .map((j) => ({ name: j.name, data: j.data as unknown as Record<string, unknown> }));
    const names = async (taskId: string) => (await jobsOf(taskId)).map((j) => j.name);
    const ADVANCE = TASK_JOB_NAMES.ADVANCE_STEP;
    const START = TASK_JOB_NAMES.START;
    const stepDone = async (taskId: string) =>
      (await eventTypes(taskId)).filter((t) => t === 'step.done').length;

    const revive: Record<string, string> = {};
    for (const [name, over, row] of [
      ['queued', { status: 'queued' as const, currentStepId: null }, null],
      ['running', {}, null],
      ['created', { status: 'created' as const, currentStepId: null }, null],
      ['failed', { status: 'failed' as const }, 'failed'],
      ['waiting-pr', { status: 'waiting_pr' as const }, 'awaiting'],
      ['waiting-pr-answered', { status: 'waiting_pr' as const }, 'answered'],
      ['waiting-awaiting', { status: 'waiting_user' as const }, 'awaiting'],
      ['waiting-answered', { status: 'waiting_user' as const }, 'answered'],
    ] as const) {
      const id = await makeTask(`boot-${name}`, over);
      if (row === 'failed') await makeRow(id, 'p4b-a', 'failed');
      if (row === 'awaiting') await makeRow(id, 'p4b-a', 'waiting_form', { waitingStartedAt: now });
      if (row === 'answered') {
        await makeRow(id, 'p4b-a', 'waiting_form', {
          waitingStartedAt: null,
          formValues: { note: 'kept' },
        });
      }
      await markDeadRaw(id);
      revive[name] = id;
    }
    const cancelledDead = await makeTask('boot-cancelled-dead', { status: 'cancelled' });
    const stillMissing = await makeTask('boot-still-missing', { snapshot: ['p4b-a', GONE] });
    await markDeadRaw(cancelledDead);
    await markDeadRaw(stillMissing);
    const untouchedBefore = [await view(cancelledDead), await view(stillMissing)];

    await reconcileDeadTasks(db);

    for (const [name, jobs] of [
      ['queued', [START]],
      ['running', [ADVANCE]],
      ['created', []],
      ['failed', []],
      ['waiting-pr', []],
      ['waiting-pr-answered', [ADVANCE]],
      ['waiting-awaiting', []],
      ['waiting-answered', [ADVANCE]],
    ] as const) {
      const id = revive[name]!;
      const v = await view(id);
      const advance = (await jobsOf(id)).find((j) => j.name === ADVANCE);
      check(
        `boot revives a dead ${name} task and queues exactly ${jobs.length === 0 ? 'no job' : jobs[0]}`,
        v.deadAt === null &&
          v.deadReason === null &&
          v.epoch === 4 &&
          JSON.stringify(await names(id)) === JSON.stringify(jobs) &&
          (jobs[0] !== ADVANCE ||
            (advance?.data.stepId === 'p4b-a' &&
              advance?.data.round === 0 &&
              advance?.data.epoch === 4)) &&
          (await eventTypes(id)).filter((t) => t === 'task.revived').length === 1,
        { v, jobs: await jobsOf(id) },
      );
    }
    const untouchedAfter = [await view(cancelledDead), await view(stillMissing)];
    check(
      'boot leaves a task cancelled while dead, and one whose step is still missing, exactly as it was',
      JSON.stringify(untouchedAfter) === JSON.stringify(untouchedBefore) &&
        (await jobsOf(cancelledDead)).length === 0 &&
        (await jobsOf(stillMissing)).length === 0 &&
        (await eventTypes(cancelledDead)).length === 0 &&
        (await eventTypes(stillMissing)).length === 0,
      { untouchedBefore, untouchedAfter },
    );

    const epochsBefore = await Promise.all(
      Object.values(revive).map(async (id) => (await view(id)).epoch),
    );
    const jobCountBefore = (await Promise.all(Object.values(revive).map(jobsOf))).flat().length;
    await reconcileDeadTasks(db);
    check(
      'a second boot pass writes nothing and queues nothing',
      JSON.stringify(
        await Promise.all(Object.values(revive).map(async (id) => (await view(id)).epoch)),
      ) === JSON.stringify(epochsBefore) &&
        (await Promise.all(Object.values(revive).map(jobsOf))).flat().length === jobCountBefore,
      epochsBefore,
    );

    {
      const id = await makeTask('boot-race');
      await markDeadRaw(id);
      await Promise.all([reconcileDeadTasks(db), reconcileDeadTasks(db)]);
      check(
        'two boot passes racing for one dead task queue one job',
        JSON.stringify(await names(id)) === JSON.stringify([ADVANCE]) &&
          (await view(id)).epoch === 4,
        await jobsOf(id),
      );
    }
    {
      const id = await makeTask('boot-mark', { snapshot: ['p4b-a', GONE] });
      const row = await makeRow(id, 'p4b-a', 'waiting_cli');
      const [queued] = await db
        .insert(schema.cliInvocations)
        .values({ taskId: id, taskStepId: row.id, mode: 'cli', prompt: 'dead-task-smoke' })
        .returning();
      await reconcileDeadTasks(db);
      const v = await view(id);
      const [after] = await db
        .select()
        .from(schema.cliInvocations)
        .where(eq(schema.cliInvocations.id, queued!.id));
      check(
        'boot marks a live task whose run list names a missing step dead, and supersedes its unstarted run',
        v.deadAt !== null &&
          v.status === 'running' &&
          v.epoch === 3 &&
          after?.supersededAt != null &&
          after.endedAt != null &&
          (await eventTypes(id)).includes('task.dead'),
        { v, after },
      );
    }

    // --- a hold at boot -----------------------------------------------------------------
    {
      const id = await makeTask('boot-held', { status: 'queued', currentStepId: null });
      await markDeadRaw(id);
      const before = await view(id);
      const hold = (state: string) => configService.set(CONFIG_KEYS.MAINTENANCE_STATE, state);
      const stay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const untouched = async () =>
        JSON.stringify(await view(id)) === JSON.stringify(before) &&
        (await jobsOf(id)).length === 0 &&
        (await eventTypes(id)).length === 0;
      let stop = () => {};
      await hold('maintenance');
      try {
        const boot = await reconcileDeadTasks(db);
        check(
          'boot leaves a dead task dead, queues nothing and writes no event while the stored state is maintenance',
          boot.held === 1 && (await untouched()),
          { boot, now: await view(id), jobs: await jobsOf(id) },
        );
        stop = retryHeldRevivals(db, undefined, 100);
        await stay(450);
        check(
          'the retry after boot holds it back as well while the stored state stays maintenance',
          await untouched(),
          { now: await view(id), jobs: await jobsOf(id) },
        );
        await hold('normal');
        for (let waited = 0; waited < 5000; waited += 50) {
          if ((await view(id)).deadAt === null) break;
          await stay(50);
        }
        await stay(450);
        check(
          'the retry revives it once the stored state is normal, queues its job once, and writes one task.revived',
          (await view(id)).deadAt === null &&
            (await view(id)).epoch === 4 &&
            JSON.stringify(await names(id)) === JSON.stringify([START]) &&
            (await eventTypes(id)).filter((t) => t === 'task.revived').length === 1,
          { now: await view(id), jobs: await jobsOf(id) },
        );
      } finally {
        stop();
        await hold('normal');
      }
    }

    // --- a revived task is driven by the real handlers ----------------------------------
    const reviveAndTake = async (id: string) => {
      await markDeadRaw(id);
      await reconcileDeadTasks(db);
      return (await jobsOf(id)).find((j) => j.name === ADVANCE);
    };
    {
      const id = await makeTask('boot-walk-done');
      await makeRow(id, 'p4b-a', 'done', { endedAt: now, output: {} });
      const appliedBefore = applied['p4b-a'] ?? 0;
      const advance = await reviveAndTake(id);
      const threw = await run(ADVANCE, advance!.data);
      const v = await view(id);
      const next = (await jobsOf(id)).filter(
        (j) => j.name === ADVANCE && j.data.stepId === 'p4b-b',
      );
      check(
        'a revived running task whose step is done walks on from the row: the step is not applied again and the task moves to the next step',
        threw === null &&
          (applied['p4b-a'] ?? 0) === appliedBefore &&
          v.currentStepId === 'p4b-b' &&
          v.deadAt === null &&
          next.length === 1,
        { threw: String(threw), v, jobs: await jobsOf(id), applied },
      );
      check(
        'walking a revived done step on records its step.done once',
        (await stepDone(id)) === 1,
        await eventTypes(id),
      );
    }
    {
      const id = await makeTask('boot-walk-answered', { status: 'waiting_user' });
      await makeRow(id, 'p4b-a', 'waiting_form', {
        waitingStartedAt: null,
        formValues: { note: 'kept' },
      });
      const appliedBefore = applied['p4b-a'] ?? 0;
      const advance = await reviveAndTake(id);
      const threw = await run(ADVANCE, advance!.data);
      const [answered] = await db
        .select()
        .from(schema.taskSteps)
        .where(and(eq(schema.taskSteps.taskId, id), eq(schema.taskSteps.stepId, 'p4b-a')));
      const v = await view(id);
      check(
        'a revived waiting_user task with a saved answer applies that answer once and walks on',
        threw === null &&
          answered?.status === 'done' &&
          JSON.stringify(answered.formValues) === JSON.stringify({ note: 'kept' }) &&
          (applied['p4b-a'] ?? 0) === appliedBefore + 1 &&
          v.currentStepId === 'p4b-b',
        { threw: String(threw), answered, v, applied },
      );
    }
    {
      const id = await makeTask('boot-walk-queued', { status: 'queued', currentStepId: null });
      await markDeadRaw(id);
      await reconcileDeadTasks(db);
      const threw = await run(START, { taskId: id, userId });
      const v = await view(id);
      check(
        'a revived queued task is claimed by its START',
        threw === null &&
          (await eventTypes(id)).includes('task.running') &&
          v.status !== 'queued' &&
          v.deadAt === null,
        { threw: String(threw), v, events: await eventTypes(id) },
      );
    }

    // --- revive, then reconcile ---------------------------------------------------------
    {
      const id = await makeTask('boot-order');
      const row = await makeRow(id, 'p4b-a', 'waiting_cli');
      const [orphan] = await db
        .insert(schema.cliInvocations)
        .values({
          taskId: id,
          taskStepId: row.id,
          mode: 'cli',
          prompt: 'dead-task-smoke',
          startedAt: longAgo,
        })
        .returning();
      await markDeadRaw(id);
      await reconcileDeadTasks(db);
      await reconcileOrphanedSteps(db, {
        enqueueAdvance,
        queuedInvocationIds: async () => new Set<string>(),
      });
      const [after] = await db
        .select()
        .from(schema.cliInvocations)
        .where(eq(schema.cliInvocations.id, orphan!.id));
      const epochs = (await jobsOf(id)).map((j) => Number(j.data.epoch)).sort();
      const [stale] = (await jobsOf(id)).filter((j) => j.data.epoch === 4);
      await run(ADVANCE, stale!.data);
      const v = await view(id);
      check(
        'revive then reconcile ends the orphaned run, and the revive advance is left stale for the reconcile one',
        after?.endedAt != null &&
          JSON.stringify(epochs) === JSON.stringify([4, 5]) &&
          v.epoch === 5 &&
          (await stepRowCount(id)) === 1,
        { after, epochs, v },
      );
    }
  } finally {
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
    await db
      .delete(schema.taskTypeDefinitions)
      .where(inArray(schema.taskTypeDefinitions.slug, slugs));
    await db.delete(schema.repositories).where(eq(schema.repositories.userId, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await rm(dir, { recursive: true, force: true });
    await queue.obliterate({ force: true }).catch(() => undefined);
    await closePrPollQueue();
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
