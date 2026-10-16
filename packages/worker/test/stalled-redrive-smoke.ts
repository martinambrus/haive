/**
 * redriveStalledTasks against a real database, exercising the real WHERE and the transactional
 * fence's race-closing re-check, and the pass that gives up on a cancelled task's teardown.
 * Throwaway users/tasks, deleted after.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { schema, type MergeResolveState } from '@haive/database';
import { logger } from '@haive/shared';
import { initDatabase, getDb } from '../src/db.js';
import {
  abandonCancelledTeardowns,
  redriveCancelledTasks,
  redriveStalledTasks,
  type FailedStep,
} from '../src/queues/stalled-redrive.js';
import { liveClaimHolder } from '../src/step-engine/merge-dir-claim.js';

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

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

function gitTry(dir: string, ...args: string[]): void {
  try {
    execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  } catch {
    // a conflicted merge exits non-zero by design
  }
}

/** A repository with a merge of `feat/a` into `main` left open on a conflict in conflict.txt. */
async function conflictedRepo(root: string, name: string): Promise<string> {
  const dir = path.join(root, name);
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  git(dir, 'config', 'gc.auto', '0');
  git(dir, 'config', 'user.email', 'smoke@test.local');
  git(dir, 'config', 'user.name', 'smoke');
  await writeFile(path.join(dir, 'conflict.txt'), 'base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'feat/a');
  await writeFile(path.join(dir, 'conflict.txt'), 'feature\n');
  git(dir, 'commit', '-q', '-am', 'feature');
  git(dir, 'checkout', '-q', 'main');
  await writeFile(path.join(dir, 'conflict.txt'), 'main\n');
  git(dir, 'commit', '-q', '-am', 'main');
  gitTry(dir, 'merge', '--no-ff', 'feat/a');
  if (!existsSync(path.join(dir, '.git', 'MERGE_HEAD'))) throw new Error('fixture merge not open');
  return dir;
}

async function main(): Promise<void> {
  initDatabase(process.env.DATABASE_URL!);
  const db = getDb();
  const userId = randomUUID();
  const now = new Date();
  let tmp: string | undefined;

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
    const cancelled = async (
      title: string,
      events: {
        type: 'task.cancelled' | 'task.cancel_finished' | 'task.cancel_redriven';
        at: Date;
      }[],
      status: 'cancelled' | 'running' = 'cancelled',
    ) => {
      const [task] = await db
        .insert(schema.tasks)
        .values({
          userId,
          type: 'workflow',
          title,
          status,
          currentStepId: 'smoke-step',
          currentRound: 0,
          orchestrationEpoch: 3,
          createdAt: longAgo,
          updatedAt: longAgo,
        })
        .returning({ id: schema.tasks.id });
      for (const e of events) {
        await db
          .insert(schema.taskEvents)
          .values({ taskId: task!.id, eventType: e.type, createdAt: e.at });
      }
      return task!.id;
    };
    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
    const lostCancelId = await cancelled('lost-cancel', [
      { type: 'task.cancelled', at: minutesAgo(10) },
    ]);
    const finishedCancelId = await cancelled('finished-cancel', [
      { type: 'task.cancelled', at: minutesAgo(10) },
      { type: 'task.cancel_finished', at: minutesAgo(9) },
    ]);
    const freshCancelId = await cancelled('fresh-cancel', [
      { type: 'task.cancelled', at: minutesAgo(1) },
    ]);
    const queuedCancelId = await cancelled('queued-cancel', [
      { type: 'task.cancelled', at: minutesAgo(10) },
    ]);
    const crashedCancelId = await cancelled('crashed-cancel', [
      { type: 'task.cancelled', at: minutesAgo(30) },
      { type: 'task.cancelled', at: minutesAgo(29) },
    ]);
    const rerunningCancelId = await cancelled('rerunning-cancel', [
      { type: 'task.cancelled', at: minutesAgo(10) },
      { type: 'task.cancelled', at: minutesAgo(1) },
    ]);
    const ancientCancelId = await cancelled('ancient-cancel', [
      { type: 'task.cancelled', at: new Date(Date.now() - 8 * 24 * 60 * 60_000) },
    ]);
    const exhaustedCancelId = await cancelled('exhausted-cancel', [
      { type: 'task.cancelled', at: minutesAgo(10) },
      { type: 'task.cancel_redriven', at: minutesAgo(8) },
      { type: 'task.cancel_redriven', at: minutesAgo(6) },
      { type: 'task.cancel_redriven', at: minutesAgo(4) },
    ]);
    const retriedCancelId = await cancelled('retried-cancel', [
      { type: 'task.cancelled', at: minutesAgo(10) },
      { type: 'task.cancel_redriven', at: minutesAgo(8) },
    ]);
    const notCancelledId = await cancelled(
      'not-cancelled',
      [{ type: 'task.cancelled', at: minutesAgo(10) }],
      'running',
    );
    const cancels: { taskId: string; userId: string }[] = [];
    const mine = new Set([
      lostCancelId,
      finishedCancelId,
      freshCancelId,
      queuedCancelId,
      crashedCancelId,
      rerunningCancelId,
      ancientCancelId,
      exhaustedCancelId,
      retriedCancelId,
      notCancelledId,
    ]);
    const cancelDeps = {
      enqueueCancel: async (taskId: string, cancelUserId: string) => {
        cancels.push({ taskId, userId: cancelUserId });
      },
      // A CANCEL completed in history is not listed, so the crashed teardown above is re-driven.
      queuedCancelTaskIds: async () => new Set([queuedCancelId]),
    };
    await redriveCancelledTasks(db, cancelDeps, { staleMs: STALE_MS });
    const cancelsFor = (id: string) => cancels.filter((c) => c.taskId === id);
    check(
      'a cancelled task with no cancel_finished gets one CANCEL, carrying its owner',
      cancelsFor(lostCancelId).length === 1 && cancelsFor(lostCancelId)[0]?.userId === userId,
      cancels,
    );
    check(
      'a cancelled task whose first teardown crashed, its job gone from the waiting states, gets one',
      cancelsFor(crashedCancelId).length === 1,
      cancels,
    );
    check(
      'finished, fresh, still-queued, re-running, ancient and not-cancelled tasks get none',
      [
        finishedCancelId,
        freshCancelId,
        queuedCancelId,
        rerunningCancelId,
        ancientCancelId,
        exhaustedCancelId,
        notCancelledId,
      ].every((id) => cancelsFor(id).length === 0),
      cancels.filter((c) => mine.has(c.taskId)),
    );
    const redrivenEvents = await db
      .select({ taskId: schema.taskEvents.taskId, payload: schema.taskEvents.payload })
      .from(schema.taskEvents)
      .where(
        and(
          eq(schema.taskEvents.taskId, lostCancelId),
          eq(schema.taskEvents.eventType, 'task.cancel_redriven'),
        ),
      );
    check(
      'a re-drive is recorded, so a teardown that keeps failing stops after the cap',
      redrivenEvents.length === 1 &&
        (redrivenEvents[0]?.payload as { attempt?: number } | null)?.attempt === 1,
      redrivenEvents,
    );
    const retriedEvents = await db
      .select({ payload: schema.taskEvents.payload })
      .from(schema.taskEvents)
      .where(
        and(
          eq(schema.taskEvents.taskId, retriedCancelId),
          eq(schema.taskEvents.eventType, 'task.cancel_redriven'),
        ),
      )
      .orderBy(asc(schema.taskEvents.createdAt));
    check(
      'a second re-drive counts the first: its event records attempt 2',
      cancelsFor(retriedCancelId).length === 1 &&
        retriedEvents.length === 2 &&
        (retriedEvents[1]?.payload as { attempt?: number } | null)?.attempt === 2,
      retriedEvents,
    );

    // The pass that gives up on a teardown the re-drive no longer retries, run beside the re-drive
    // as the sweeper runs it, both reading the same CANCEL queue.
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60_000);
    const ancient: Parameters<typeof cancelled>[1] = [{ type: 'task.cancelled', at: eightDaysAgo }];
    const capped = (lastRedriveMinutesAgo: number): Parameters<typeof cancelled>[1] => [
      { type: 'task.cancelled', at: minutesAgo(40) },
      { type: 'task.cancel_redriven', at: minutesAgo(30) },
      { type: 'task.cancel_redriven', at: minutesAgo(20) },
      { type: 'task.cancel_redriven', at: minutesAgo(lastRedriveMinutesAgo) },
    ];
    const dirRoot = `/smoke/${randomBytes(4).toString('hex')}`;
    let dirCount = 0;
    const hold = async (
      taskId: string,
      opts: { mergeDir?: string; mergeResolveState?: MergeResolveState } = {},
    ) => {
      const n = (dirCount += 1);
      const mergeDir = opts.mergeDir ?? `${dirRoot}/${n}--base`;
      const [step] = await db
        .insert(schema.taskSteps)
        .values({
          taskId,
          stepId: `merge-${n}`,
          stepIndex: n,
          title: 'merge',
          status: 'failed',
          ...(opts.mergeResolveState ? { mergeResolveState: opts.mergeResolveState } : {}),
        })
        .returning({ id: schema.taskSteps.id });
      await db.insert(schema.mergeDirClaims).values({ mergeDir, taskId, taskStepId: step!.id });
      return { taskId, taskStepId: step!.id };
    };
    const eventsOf = (taskId: string, type: string) =>
      db
        .select()
        .from(schema.taskEvents)
        .where(and(eq(schema.taskEvents.taskId, taskId), eq(schema.taskEvents.eventType, type)))
        .orderBy(asc(schema.taskEvents.createdAt));
    const claimsOf = (taskId: string) =>
      db
        .select({ mergeDir: schema.mergeDirClaims.mergeDir })
        .from(schema.mergeDirClaims)
        .where(eq(schema.mergeDirClaims.taskId, taskId));
    const canon = (v: unknown) =>
      JSON.stringify(Object.entries(v as object).sort(([a], [b]) => (a < b ? -1 : 1)));
    const untouched = async (id: string) =>
      (await claimsOf(id)).length === 1 &&
      (await eventsOf(id, 'task.cancel_finished')).length === 0;
    const abandonedAs = async (id: string, reason: string) => {
      const finished = await eventsOf(id, 'task.cancel_finished');
      return (
        (await claimsOf(id)).length === 0 &&
        finished.length === 1 &&
        canon(finished[0]!.payload) === canon({ source: 'worker', abandoned: true, reason })
      );
    };

    const c1 = await cancelled('c1 capped, last re-drive had its time', capped(10));
    const c1Claims = [await hold(c1), await hold(c1)];
    const c2 = await cancelled('c2 capped, last re-drive recent', capped(1));
    const c2Claim = await hold(c2);
    const c3a = await cancelled('c3a capped, CANCEL queued', capped(10));
    await hold(c3a);
    const c3b = await cancelled('c3b cancelled long ago, CANCEL queued', ancient);
    await hold(c3b);
    const c4 = await cancelled('c4 cancelled long ago, never re-driven', ancient);
    const c4Claim = await hold(c4);
    const c5a = await cancelled('c5a capped, no claim', capped(10));
    const c5b = await cancelled('c5b cancelled long ago, no claim', ancient);
    tmp = await mkdtemp(path.join(tmpdir(), 'haive-abandon-'));
    const c6Dir = await conflictedRepo(tmp, 'c6');
    const c6Head = git(c6Dir, 'rev-parse', 'HEAD');
    const c6MergeHead = git(c6Dir, 'rev-parse', 'MERGE_HEAD');
    const c6 = await cancelled('c6 merge left open', capped(10));
    await hold(c6, {
      mergeDir: c6Dir,
      mergeResolveState: {
        mode: 'same-branch',
        phase: 'resolving',
        baseBranch: 'main',
        featureBranch: 'feat/a',
        mergeDir: c6Dir,
        sandboxMergeDir: c6Dir,
        fixInvocationId: null,
        conflictRetries: 1,
        pendingQuestion: null,
        pushAfterMerge: false,
        merged: false,
        skipReason: null,
        pushed: false,
      },
    });
    const x1 = await cancelled('x1 cancelled a minute ago', [
      { type: 'task.cancelled', at: minutesAgo(1) },
    ]);
    await hold(x1);
    const x1b = await cancelled('x1b cancelled a day ago, never re-driven', [
      { type: 'task.cancelled', at: new Date(Date.now() - 24 * 60 * 60_000) },
    ]);
    await hold(x1b);
    const x2 = await cancelled('x2 re-driven twice, its second CANCEL ran a minute ago', [
      { type: 'task.cancel_redriven', at: minutesAgo(30) },
      { type: 'task.cancel_redriven', at: minutesAgo(20) },
      { type: 'task.cancelled', at: minutesAgo(1) },
    ]);
    await hold(x2);
    const x3 = await cancelled('x3 not cancelled', capped(10), 'running');
    await hold(x3);
    const x4 = await cancelled('x4 teardown finished', [
      ...capped(10),
      { type: 'task.cancel_finished', at: minutesAgo(9) },
    ]);
    await hold(x4);
    const x5 = await cancelled('x5 another task holding a dir', [], 'running');
    await hold(x5);
    const x6 = await cancelled('x6 capped, cancelled long ago', [
      { type: 'task.cancelled', at: eightDaysAgo },
      ...[1, 2, 3].map(
        (n) =>
          ({ type: 'task.cancel_redriven', at: new Date(+eightDaysAgo + n * 60_000) }) as const,
      ),
    ]);
    await hold(x6);
    const x7 = await cancelled('x7 cancelled long ago, re-driven once', [
      { type: 'task.cancelled', at: eightDaysAgo },
      { type: 'task.cancel_redriven', at: new Date(+eightDaysAgo + 60_000) },
    ]);
    await hold(x7);
    const x8 = await cancelled('x8 cancelled long ago, re-driven twice', [
      { type: 'task.cancelled', at: eightDaysAgo },
      ...[1, 2].map(
        (n) =>
          ({ type: 'task.cancel_redriven', at: new Date(+eightDaysAgo + n * 60_000) }) as const,
      ),
    ]);
    await hold(x8);

    const queuedCancels = new Set([c3a, c3b]);
    const sweptCancels: string[] = [];
    const sweepCancels = async (queued: Set<string> | null) => {
      const sweepDeps = {
        enqueueCancel: async (taskId: string) => {
          sweptCancels.push(taskId);
        },
        queuedCancelTaskIds: async () => queued,
      };
      await redriveCancelledTasks(db, sweepDeps, { staleMs: STALE_MS });
      return abandonCancelledTeardowns(db, sweepDeps, { staleMs: STALE_MS });
    };

    check(
      'C1 precondition: a cancelled task without task.cancel_finished is a live holder of each claim',
      (await liveClaimHolder(db, c1Claims[0]!)) !== null &&
        (await liveClaimHolder(db, c1Claims[1]!)) !== null,
    );
    const unreadable = await abandonCancelledTeardowns(
      db,
      { queuedCancelTaskIds: async () => null },
      { staleMs: STALE_MS },
    );
    const keptWhileUnreadable =
      unreadable === 0 &&
      (await claimsOf(c1)).length === 2 &&
      (await eventsOf(c1, 'task.cancel_finished')).length === 0;

    await sweepCancels(queuedCancels);

    // A control that expects a task left alone also expects the pass to have released its twins, so
    // it cannot pass merely because the pass did nothing.
    const released =
      (await abandonedAs(c1, 're-drive cap reached')) &&
      (await abandonedAs(c4, 'cancelled before the re-drive window'));

    check('C1: the claim rows are gone', (await claimsOf(c1)).length === 0, await claimsOf(c1));
    check(
      'C1: one task.cancel_finished flagged abandoned, with the re-drive cap as its reason',
      await abandonedAs(c1, 're-drive cap reached'),
      await eventsOf(c1, 'task.cancel_finished'),
    );
    check(
      'C1: liveClaimHolder no longer counts the task as a holder',
      (await liveClaimHolder(db, c1Claims[0]!)) === null &&
        (await liveClaimHolder(db, c1Claims[1]!)) === null,
    );
    check(
      'C2: a capped teardown whose last re-drive is newer than the cutoff is untouched, its twin released',
      released && (await untouched(c2)) && (await liveClaimHolder(db, c2Claim)) !== null,
    );
    check(
      'C3: a teardown with a CANCEL still queued is untouched, capped or cancelled long ago, its twins released',
      released && (await untouched(c3a)) && (await untouched(c3b)),
    );
    check(
      'C4: a task cancelled before the re-drive window and never re-driven is released, saying so',
      (await abandonedAs(c4, 'cancelled before the re-drive window')) &&
        (await liveClaimHolder(db, c4Claim)) === null,
      await eventsOf(c4, 'task.cancel_finished'),
    );
    check(
      'C5: a task holding no claim gets no event, capped or cancelled long ago, its twins released',
      released &&
        (await eventsOf(c5a, 'task.cancel_finished')).length === 0 &&
        (await eventsOf(c5b, 'task.cancel_finished')).length === 0,
    );
    const leftOpen = await eventsOf(c6, 'merge.left_open');
    const c6Finished = await eventsOf(c6, 'task.cancel_finished');
    check(
      'C6: the merge the task left open is reported during the give-up',
      leftOpen.length === 1 &&
        canon(leftOpen[0]!.payload) ===
          canon({ dir: c6Dir, ref: 'feat/a', head: c6Head, mergeHead: c6MergeHead }),
      leftOpen,
    );
    check(
      'C6: ...before the finish record, the merge itself left open and the claim released',
      c6Finished.length === 1 &&
        leftOpen.length === 1 &&
        leftOpen[0]!.createdAt <= c6Finished[0]!.createdAt &&
        existsSync(path.join(c6Dir, '.git', 'MERGE_HEAD')) &&
        (await claimsOf(c6)).length === 0,
    );
    check(
      'X0: with the CANCEL queue unreadable nothing is given up, and a later pass gives up',
      keptWhileUnreadable && released,
    );
    check(
      'X1: a cancel inside the re-drive window, fresh or never re-driven, is left to the re-drive',
      released && (await untouched(x1)) && (await untouched(x1b)),
    );
    check(
      'X2: a teardown re-driven fewer times than the cap is left to the re-drive',
      released && (await untouched(x2)),
    );
    check('X3: a task that is not cancelled is untouched', released && (await untouched(x3)));
    check(
      'X4: a teardown that finished keeps its one record and is not touched again',
      released &&
        (await eventsOf(x4, 'task.cancel_finished')).length === 1 &&
        (await claimsOf(x4)).length === 1,
    );
    check("X5: another task's claim is untouched", released && (await claimsOf(x5)).length === 1);
    check(
      'X6: a capped teardown cancelled before the window is given up as capped',
      await abandonedAs(x6, 're-drive cap reached'),
      await eventsOf(x6, 'task.cancel_finished'),
    );
    check(
      'X7: no given-up task was also sent a CANCEL',
      released && [c1, c4, c6, x6, x7, x8].every((id) => !sweptCancels.includes(id)),
      sweptCancels,
    );
    check(
      'X8: a teardown re-driven once or twice whose cancel left the window is given up as cancelled before it',
      (await abandonedAs(x7, 'cancelled before the re-drive window')) &&
        (await abandonedAs(x8, 'cancelled before the re-drive window')),
      [await eventsOf(x7, 'task.cancel_finished'), await eventsOf(x8, 'task.cancel_finished')],
    );

    const snapshot = async () =>
      JSON.stringify(
        await Promise.all(
          [c1, c4, c6, x6].map(async (id) => [
            (await eventsOf(id, 'task.cancel_finished')).length,
            (await eventsOf(id, 'merge.left_open')).length,
            (await claimsOf(id)).length,
          ]),
        ),
      );
    const afterFirst = await snapshot();
    // A claim that committed after the release read the task's claims: its finish record makes it stale.
    const lateClaim = await hold(c1);
    const afterLate = await snapshot();
    const second = await sweepCancels(queuedCancels);
    check(
      'C7: a second sweep gives up nothing and writes nothing new, a late claim of a finished task included',
      second === 0 &&
        afterFirst ===
          JSON.stringify([
            [1, 0, 0],
            [1, 0, 0],
            [1, 1, 0],
            [1, 0, 0],
          ]) &&
        afterLate ===
          JSON.stringify([
            [1, 0, 1],
            [1, 0, 0],
            [1, 1, 0],
            [1, 0, 0],
          ]) &&
        (await snapshot()) === afterLate &&
        (await liveClaimHolder(db, lateClaim)) === null,
      { second, afterFirst, afterLate, afterSecond: await snapshot() },
    );
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true });
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
