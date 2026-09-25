/**
 * redriveStalledTasks against a real database, exercising the real WHERE and the transactional
 * fence's race-closing re-check. Throwaway users/tasks, deleted after.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { schema } from '@haive/database';
import { logger } from '@haive/shared';
import { initDatabase, getDb } from '../src/db.js';
import { redriveStalledTasks } from '../src/queues/stalled-redrive.js';

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
        taskStatus?: 'running' | 'waiting_user';
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
    const failures: { taskId: string; message: string; epoch: number }[] = [];
    const deps = {
      failTask: async (_db: unknown, taskId: string, message: string, epoch: number) => {
        failures.push({ taskId, message, epoch });
        return true;
      },
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
      queuedTaskIds: async () => {
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
        return new Set([withJobTaskId]);
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
    check(
      'a stale failed current row fails its task at its epoch, with the step error',
      JSON.stringify(failures.filter((f) => f.taskId === failedRowTaskId)) ===
        JSON.stringify([
          { taskId: failedRowTaskId, message: 'cli invocation failed: boom', epoch: 3 },
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
