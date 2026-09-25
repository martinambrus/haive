/**
 * redriveStalledTasks against a real database, exercising the real WHERE and the transactional
 * fence's race-closing re-check. Throwaway users/tasks, deleted after.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { schema } from '@haive/database';
import { logger } from '@haive/shared';
import { initDatabase, getDb } from '../src/db.js';
import { redriveStalledTasks, type FailedStep } from '../src/queues/stalled-redrive.js';

const log = logger.child({ module: 'stalled-redrive-smoke' });

if (!process.env.DATABASE_URL) {
  console.error('[smoke] missing env DATABASE_URL');
  process.exit(2);
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

const STALE_MS = 5 * 60_000;
const longAgo = new Date(Date.now() - 10 * 60_000);

async function main(): Promise<void> {
  initDatabase(process.env.DATABASE_URL!);
  const db = getDb();
  const userId = randomUUID();
  const now = new Date();

  try {
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'stalled-redrive-smoke',
      emailBlindIndex: `stalled-redrive-smoke-${randomBytes(6).toString('hex')}`,
      passwordHash: 'smoke-not-real',
      role: 'user',
      status: 'active',
      tokenVersion: 0,
      createdAt: now,
      updatedAt: now,
    });

    const makeTask = async (
      title: string,
      opts: {
        taskStatus?: 'running' | 'waiting_user' | 'queued' | 'created';
        taskUpdatedAt?: Date;
        stepStatus?: 'pending' | 'waiting_cli' | 'done' | 'skipped' | 'failed';
        stepUpdatedAt?: Date;
        waitingStartedAt?: Date | null;
        noStepRow?: boolean;
        stepError?: string;
      } = {},
    ) => {
      const {
        taskStatus = 'running',
        taskUpdatedAt = longAgo,
        stepStatus = 'pending',
        stepUpdatedAt = longAgo,
        waitingStartedAt = null,
        noStepRow = false,
      } = opts;
      const [task] = await db
        .insert(schema.tasks)
        .values({
          userId,
          type: 'workflow',
          title,
          status: taskStatus,
          currentStepId: 'smoke-step',
          currentRound: 0,
          orchestrationEpoch: 3,
          createdAt: taskUpdatedAt,
          updatedAt: taskUpdatedAt,
        })
        .returning({ id: schema.tasks.id });
      if (!noStepRow) {
        await db.insert(schema.taskSteps).values({
          taskId: task!.id,
          stepId: 'smoke-step',
          stepIndex: 0,
          round: 0,
          title: 'smoke-step',
          status: stepStatus,
          errorMessage: opts.stepError ?? null,
          waitingStartedAt,
          updatedAt: stepUpdatedAt,
        });
      }
      return task!.id;
    };

    const redriveTaskId = await makeTask('redrive');
    const withJobTaskId = await makeTask('with-job');
    const freshTaskId = await makeTask('fresh', { taskUpdatedAt: new Date() });
    const missingRowTaskId = await makeTask('missing-row', { noStepRow: true });
    const parkedRowTaskId = await makeTask('parked-row', { waitingStartedAt: new Date() });
    const waitingCliTaskId = await makeTask('waiting-cli', { stepStatus: 'waiting_cli' });
    const waitingUserTaskId = await makeTask('waiting-user', { taskStatus: 'waiting_user' });
    const freshStepRowTaskId = await makeTask('fresh-step-row', { stepUpdatedAt: new Date() });
    const raceTaskId = await makeTask('race');
    const doneRowTaskId = await makeTask('done-row', { stepStatus: 'done' });
    const skippedRowTaskId = await makeTask('skipped-row', { stepStatus: 'skipped' });
    const freshDoneRowTaskId = await makeTask('fresh-done-row', {
      stepStatus: 'done',
      stepUpdatedAt: new Date(),
    });
    const failedRowTaskId = await makeTask('failed-row', {
      stepStatus: 'failed',
      stepError: 'cli invocation failed: boom',
    });
    const freshFailedRowTaskId = await makeTask('fresh-failed-row', {
      stepStatus: 'failed',
      stepUpdatedAt: new Date(),
    });
    const doneRaceTaskId = await makeTask('done-race', { stepStatus: 'done' });

    // Tasks queued to start, whose START may have been lost.
    const unstarted = (
      title: string,
      opts: { taskStatus?: 'queued' | 'created'; taskUpdatedAt?: Date } = {},
    ) => makeTask(title, { taskStatus: 'queued', noStepRow: true, ...opts });
    const lostStartTaskId = await unstarted('lost-start');
    const startQueuedTaskId = await unstarted('start-queued');
    const freshQueuedTaskId = await unstarted('fresh-queued', { taskUpdatedAt: new Date() });
    const draftTaskId = await unstarted('draft', { taskStatus: 'created' });

    // Steps parked on a run, whose cli-exec job may have been lost.
    const stepRowOf = async (taskId: string) =>
      (
        await db
          .select({ id: schema.taskSteps.id })
          .from(schema.taskSteps)
          .where(eq(schema.taskSteps.taskId, taskId))
      )[0]!.id;
    const addRun = async (
      taskId: string,
      opts: { mining?: boolean; createdAt?: Date; startedAt?: Date } = {},
    ) => {
      const [run] = await db
        .insert(schema.cliInvocations)
        .values({
          taskId,
          taskStepId: await stepRowOf(taskId),
          mode: opts.mining ? 'agent_mining' : 'cli',
          prompt: 'stalled-redrive-smoke',
          createdAt: opts.createdAt ?? longAgo,
          startedAt: opts.startedAt ?? null,
        })
        .returning({ id: schema.cliInvocations.id });
      return run!.id;
    };
    const parked = (title: string) => makeTask(title, { stepStatus: 'waiting_cli' });
    const lostRunTaskId = await parked('lost-run');
    const lostRunId = await addRun(lostRunTaskId);
    const owedRunTaskId = await parked('owed-run');
    const owedRunId = await addRun(owedRunTaskId);
    const youngRunTaskId = await parked('young-run');
    const youngRunId = await addRun(youngRunTaskId, { createdAt: new Date() });
    const liveSiblingTaskId = await parked('live-sibling');
    const liveSiblingRunId = await addRun(liveSiblingTaskId, {
      mining: true,
      startedAt: longAgo,
    });
    const liveSiblingLostId = await addRun(liveSiblingTaskId, { mining: true });
    const miningTaskId = await parked('mining');
    const miningLostIds = [
      await addRun(miningTaskId, { mining: true }),
      await addRun(miningTaskId, { mining: true }),
    ];
    const miningOwedId = await addRun(miningTaskId, { mining: true });

    const epochOf = async (id: string) =>
      (
        await db
          .select({ epoch: schema.tasks.orchestrationEpoch })
          .from(schema.tasks)
          .where(eq(schema.tasks.id, id))
      )[0]?.epoch;

    const advances: {
      taskId: string;
      userId: string;
      stepId: string;
      round: number;
      epoch: number;
    }[] = [];
    const starts: { taskId: string; userId: string }[] = [];
    const failures: FailedStep[] = [];
    const deps = {
      failTask: async (_db: unknown, f: FailedStep) => {
        failures.push(f);
        return true;
      },
      enqueueStart: async (taskId: string, startUserId: string) => {
        starts.push({ taskId, userId: startUserId });
      },
      queuedInvocationIds: async () => new Set([owedRunId, miningOwedId]),
      enqueueAdvance: async (
        taskId: string,
        advUserId: string,
        stepId: string,
        round: number,
        epoch: number,
      ) => {
        advances.push({ taskId, userId: advUserId, stepId, round, epoch });
      },
      // Simulates a step claimed by another pass between the candidates SELECT and this pass's
      // fence: flips the race tasks' step rows live, after the SELECT already ran.
      queuedTaskJobs: async () => {
        await db
          .update(schema.taskSteps)
          .set({ status: 'running', updatedAt: new Date() })
          .where(
            and(
              inArray(schema.taskSteps.taskId, [raceTaskId, doneRaceTaskId]),
              eq(schema.taskSteps.stepId, 'smoke-step'),
              eq(schema.taskSteps.round, 0),
            ),
          );
        // A START this pass queued is on the queue for the next one.
        return {
          steps: new Set([withJobTaskId]),
          starts: new Set([startQueuedTaskId, ...starts.map((st) => st.taskId)]),
        };
      },
    };

    await redriveStalledTasks(db, deps, { staleMs: STALE_MS });

    check('a task with no current-step row is re-driven', (await epochOf(missingRowTaskId)) === 4);
    check(
      'the redriven task epoch went up by 1',
      (await epochOf(redriveTaskId)) === 4,
      await epochOf(redriveTaskId),
    );
    const redriveAdvances = advances.filter((a) => a.taskId === redriveTaskId);
    check('one advance was recorded with the new epoch', redriveAdvances.length === 1);
    check(
      'the advance carries the bumped epoch and the task/step identity',
      redriveAdvances[0]?.epoch === 4 &&
        redriveAdvances[0]?.userId === userId &&
        redriveAdvances[0]?.stepId === 'smoke-step' &&
        redriveAdvances[0]?.round === 0,
      redriveAdvances[0],
    );
    check('a task the queue still owes a job is left alone', (await epochOf(withJobTaskId)) === 3);
    check('a task whose rows are fresh is left alone', (await epochOf(freshTaskId)) === 3);
    check('a stale parked pending row is left alone', (await epochOf(parkedRowTaskId)) === 3);
    check('a stale waiting_cli row is left alone', (await epochOf(waitingCliTaskId)) === 3);
    check(
      'a waiting_user task with a stale pending row is left alone',
      (await epochOf(waitingUserTaskId)) === 3,
    );
    check(
      'a stale task whose step row has a recent updated_at is left alone',
      (await epochOf(freshStepRowTaskId)) === 3,
    );
    check(
      'a step claimed between the SELECT and the fence is left alone',
      (await epochOf(raceTaskId)) === 3 && advances.every((a) => a.taskId !== raceTaskId),
    );
    for (const [name, id] of [
      ['done', doneRowTaskId],
      ['skipped', skippedRowTaskId],
    ] as const) {
      const own = advances.filter((a) => a.taskId === id);
      check(
        `a stale ${name} current row, its hand-off lost, is re-driven once at the new epoch`,
        (await epochOf(id)) === 4 &&
          own.length === 1 &&
          own[0]?.stepId === 'smoke-step' &&
          own[0]?.round === 0 &&
          own[0]?.epoch === 4,
        { epoch: await epochOf(id), own },
      );
    }
    check(
      'a done row that finished recently is left to its own hand-off',
      (await epochOf(freshDoneRowTaskId)) === 3,
    );
    const [failedRow] = await db
      .select({ id: schema.taskSteps.id })
      .from(schema.taskSteps)
      .where(eq(schema.taskSteps.taskId, failedRowTaskId));
    check(
      'a stale failed current row fails its task at its epoch, through its own row and error',
      JSON.stringify(failures.filter((f) => f.taskId === failedRowTaskId)) ===
        JSON.stringify([
          {
            taskId: failedRowTaskId,
            epoch: 3,
            stepId: 'smoke-step',
            rowId: failedRow?.id,
            message: 'cli invocation failed: boom',
          },
        ]) && advances.every((a) => a.taskId !== failedRowTaskId),
      failures,
    );
    check(
      'a row that failed recently is left to its own hand-off',
      failures.every((f) => f.taskId !== freshFailedRowTaskId),
    );
    check(
      'a finished row taken live between the SELECT and the fence is left alone',
      (await epochOf(doneRaceTaskId)) === 3 && advances.every((a) => a.taskId !== doneRaceTaskId),
    );

    const startsFor = (id: string) => starts.filter((st) => st.taskId === id);
    check(
      'a task queued to start whose START was lost gets one',
      startsFor(lostStartTaskId).length === 1 && startsFor(lostStartTaskId)[0]?.userId === userId,
      startsFor(lostStartTaskId),
    );
    check(
      'a queued task the queue still owes a job, a fresh one and a draft get no START',
      [startQueuedTaskId, freshQueuedTaskId, draftTaskId].every((id) => startsFor(id).length === 0),
      starts,
    );

    const runOf = async (id: string) =>
      (
        await db
          .select({
            startedAt: schema.cliInvocations.startedAt,
            endedAt: schema.cliInvocations.endedAt,
          })
          .from(schema.cliInvocations)
          .where(eq(schema.cliInvocations.id, id))
      )[0];
    const advancesFor = (id: string) => advances.filter((a) => a.taskId === id);
    check(
      'a run no job owes is ended, and its step re-driven once at the new epoch',
      (await runOf(lostRunId))?.endedAt != null &&
        (await epochOf(lostRunTaskId)) === 4 &&
        advancesFor(lostRunTaskId).length === 1 &&
        advancesFor(lostRunTaskId)[0]?.epoch === 4 &&
        advancesFor(lostRunTaskId)[0]?.stepId === 'smoke-step',
      {
        run: await runOf(lostRunId),
        epoch: await epochOf(lostRunTaskId),
        advances: advancesFor(lostRunTaskId),
      },
    );
    for (const [name, taskId, runIds] of [
      ['a run a job still owes', owedRunTaskId, [owedRunId]],
      ['a run recorded since the cutoff', youngRunTaskId, [youngRunId]],
      [
        'a lost run beside one still running',
        liveSiblingTaskId,
        [liveSiblingRunId, liveSiblingLostId],
      ],
    ] as const) {
      const runs = await Promise.all(runIds.map((id) => runOf(id)));
      check(
        `${name} leaves its step alone`,
        runs.every((r) => r?.endedAt == null) &&
          (await epochOf(taskId)) === 3 &&
          advancesFor(taskId).length === 0,
        { runs, epoch: await epochOf(taskId) },
      );
    }
    const miningRuns = await Promise.all(miningLostIds.map((id) => runOf(id)));
    check(
      'a fan-out with two lost runs and one owed ends the two and re-drives the step once',
      miningRuns.every((r) => r?.endedAt != null) &&
        (await runOf(miningOwedId))?.endedAt == null &&
        (await epochOf(miningTaskId)) === 4 &&
        advancesFor(miningTaskId).length === 1,
      { miningRuns, owed: await runOf(miningOwedId), epoch: await epochOf(miningTaskId) },
    );

    // The fence write above also refreshed the redriven task's updated_at, so a second pass finds
    // it no longer stale rather than losing a compare-and-swap.
    await redriveStalledTasks(db, deps, { staleMs: STALE_MS });
    check(
      'a second pass leaves the redriven task at its new epoch',
      (await epochOf(redriveTaskId)) === 4,
    );
    check(
      'a second pass records no further advance for it',
      advances.filter((a) => a.taskId === redriveTaskId).length === 1,
    );
    check(
      'a second pass queues no second START and re-drives no recovered step again',
      startsFor(lostStartTaskId).length === 1 &&
        advancesFor(lostRunTaskId).length === 1 &&
        advancesFor(miningTaskId).length === 1,
      { starts, advances },
    );
  } finally {
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  }
}

main()
  .then(() => {
    log.info({ checks, failures }, failures === 0 ? 'stalled redrive smoke passed' : 'FAILED');
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    log.error({ err }, 'stalled redrive smoke crashed');
    process.exit(1);
  });
