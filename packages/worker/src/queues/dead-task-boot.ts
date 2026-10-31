import { and, desc, eq, inArray, isNotNull, isNull, notInArray, sql, type SQL } from 'drizzle-orm';
import { schema, type Database, type DbTx } from '@haive/database';
import { logger, TASK_DEAD_EVENT, type WorkflowType } from '@haive/shared';
import { resyncAfterTaskEnd } from '../project-state/set-aside.js';
import { stepRegistry, type StepRegistry } from '../step-engine/registry.js';
import { TERMINAL_TASK_STATUSES } from '../step-engine/step-ownership.js';
import { newWorkHeldUnderFence } from './_revive-check.js';
import {
  parseCustomSteps,
  resolveRunList,
  resolveTaskStep,
  taskTypeRuntimeFor,
  type ResolvedTaskContext,
} from './run-list.js';
import {
  deadReasonFor,
  enqueueRedrive,
  enqueueStart,
  markTaskDead,
  REDRIVE_RETRY_DELAYS_MS,
  retrying,
  supersedeDeadTaskRuns,
} from './task-queue.js';

const log = logger.child({ module: 'dead-task-boot' });

type DbHandle = Parameters<Parameters<Database['transaction']>[0]>[0];
type TaskStatusValue = (typeof schema.tasks.$inferSelect)['status'];

export interface DeadTaskBootDeps {
  enqueueStart: (taskId: string, userId: string) => Promise<void>;
  enqueueAdvance: (
    taskId: string,
    userId: string,
    stepId: string,
    round: number,
    epoch: number,
  ) => Promise<void>;
  /** Waits before each further attempt at queueing a job. */
  redriveRetryDelaysMs?: number[];
}

const defaultDeps: DeadTaskBootDeps = { enqueueStart, enqueueAdvance: enqueueRedrive };

export const DEAD_TASK_REVIVE_RETRY_MS = 30_000;

/** A task as the pass read it; the revive swaps on this state. */
export interface DeadTaskView {
  id: string;
  userId: string;
  epoch: number;
  currentStepId: string | null;
  currentRound: number;
  deadAt: Date | null;
  deadReason: string | null;
}

export interface DeadTaskResolution {
  /** Ids the task names that this install does not register. */
  unresolved: string[];
  /** The step a static task is on when it is registered but not in its run list: its hand-off finds no successor. */
  outsideList: string | null;
}

/** Pure: resolveTaskContext makes scratch workspaces and throws on a deleted repository. */
export function deadTaskResolution(
  task: {
    id: string;
    type: string;
    currentStepId: string | null;
    runListSnapshot: string[] | null;
    customSteps: unknown;
    /** The step ids its last task.dead event named. */
    deathNamed?: readonly string[];
  },
  strategy: ResolvedTaskContext['runListStrategy'],
  registry: StepRegistry = stepRegistry,
): DeadTaskResolution {
  const scope = {
    taskId: task.id,
    workflowType: task.type as WorkflowType,
    runListSnapshot: task.runListSnapshot,
    customSteps: parseCustomSteps(task.customSteps),
  };
  const isStatic = strategy === 'static';
  const unresolved = isStatic ? [...resolveRunList(scope, registry).unresolved] : [];
  // A task with no snapshot keeps no list to re-check, so the record of its death says what was missing.
  if (task.runListSnapshot === null) {
    for (const id of task.deathNamed ?? []) {
      if (!unresolved.includes(id) && !resolveTaskStep(scope, id, registry)) unresolved.push(id);
    }
  }
  const current = task.currentStepId;
  if (current === null) return { unresolved, outsideList: null };
  if (!resolveTaskStep(scope, current, registry)) {
    return {
      unresolved: unresolved.includes(current) ? unresolved : [...unresolved, current],
      outsideList: null,
    };
  }
  return {
    unresolved,
    outsideList:
      isStatic && task.runListSnapshot !== null && !task.runListSnapshot.includes(current)
        ? current
        : null,
  };
}

type ReviveJob = { kind: 'start' } | { kind: 'advance'; stepId: string } | { kind: 'none' };

/** A saved answer (the submit route cleared its park marker) is owed the advance the dead guard dropped; a parked form is owed none. */
async function jobAfterRevive(
  tx: DbHandle,
  c: DeadTaskView,
  status: TaskStatusValue,
): Promise<ReviveJob> {
  if (status === 'queued') return { kind: 'start' };
  const stepId = c.currentStepId;
  if (stepId === null) return { kind: 'none' };
  if (status === 'running') return { kind: 'advance', stepId };
  if (status !== 'waiting_user' && status !== 'waiting_pr') return { kind: 'none' };
  const [step] = await tx
    .select({
      status: schema.taskSteps.status,
      waitingStartedAt: schema.taskSteps.waitingStartedAt,
      formValues: schema.taskSteps.formValues,
    })
    .from(schema.taskSteps)
    .where(
      and(
        eq(schema.taskSteps.taskId, c.id),
        eq(schema.taskSteps.stepId, stepId),
        eq(schema.taskSteps.round, c.currentRound),
      ),
    );
  const answered =
    step?.status === 'waiting_form' && step.waitingStartedAt === null && step.formValues !== null;
  return answered ? { kind: 'advance', stepId } : { kind: 'none' };
}

/** Compare-and-swap on the state read under the task row's lock, after the shared new-work fence: while new work is held, or its state cannot be read, nothing is written and the answer is `held`; a job that cannot be queued puts the dead state back for the next boot, keeping the bumped epoch so a job sent despite the error stays stale. */
export async function reviveDeadTask(
  db: Database,
  c: DeadTaskView,
  deps: DeadTaskBootDeps,
): Promise<ReviveJob['kind'] | 'held' | null> {
  const revived = await db.transaction(async (tx) => {
    if (await newWorkHeldUnderFence(tx)) return 'held' as const;
    const locked = await tx
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, c.id))
      .for('update');
    if (locked.length === 0) return null;
    const [row] = await tx
      .update(schema.tasks)
      .set({
        deadAt: null,
        deadReason: null,
        orchestrationEpoch: sql`${schema.tasks.orchestrationEpoch} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.tasks.id, c.id),
          isNotNull(schema.tasks.deadAt),
          notInArray(schema.tasks.status, [...TERMINAL_TASK_STATUSES]),
          eq(schema.tasks.orchestrationEpoch, c.epoch),
          sql`${schema.tasks.currentStepId} IS NOT DISTINCT FROM ${c.currentStepId}`,
          eq(schema.tasks.currentRound, c.currentRound),
        ),
      )
      .returning({ epoch: schema.tasks.orchestrationEpoch, status: schema.tasks.status });
    if (!row) return null;
    const job = await jobAfterRevive(tx, c, row.status);
    const named = await deathNamedSteps(tx, c.id);
    await tx.insert(schema.taskEvents).values({
      taskId: c.id,
      taskStepId: null,
      eventType: 'task.revived',
      payload: {
        epoch: row.epoch,
        deadAt: c.deadAt?.toISOString() ?? null,
        unresolved: named,
        action: job.kind,
      },
    });
    return { epoch: row.epoch, job };
  });
  if (revived === 'held') return 'held';
  if (!revived) return null;

  const delays = deps.redriveRetryDelaysMs ?? REDRIVE_RETRY_DELAYS_MS;
  try {
    if (revived.job.kind === 'start') {
      await retrying(() => deps.enqueueStart(c.id, c.userId), delays);
    } else if (revived.job.kind === 'advance') {
      const { stepId } = revived.job;
      await retrying(
        () => deps.enqueueAdvance(c.id, c.userId, stepId, c.currentRound, revived.epoch),
        delays,
      );
    }
  } catch (err) {
    await db
      .update(schema.tasks)
      .set({ deadAt: c.deadAt, deadReason: c.deadReason, updatedAt: new Date() })
      .where(
        and(
          eq(schema.tasks.id, c.id),
          eq(schema.tasks.orchestrationEpoch, revived.epoch),
          isNull(schema.tasks.deadAt),
        ),
      );
    throw err;
  }
  log.info(
    { taskId: c.id, epoch: revived.epoch, action: revived.job.kind },
    'revived a dead task: the steps it was missing are registered again',
  );
  return revived.job.kind;
}

/** The step ids the task's last task.dead event named as missing. */
async function deathNamedSteps(db: Database | DbTx, taskId: string): Promise<string[]> {
  const [lastDead] = await db
    .select({ payload: schema.taskEvents.payload })
    .from(schema.taskEvents)
    .where(
      and(eq(schema.taskEvents.taskId, taskId), eq(schema.taskEvents.eventType, TASK_DEAD_EVENT)),
    )
    .orderBy(desc(schema.taskEvents.createdAt))
    .limit(1);
  const named = (lastDead?.payload as { unresolved?: unknown } | undefined)?.unresolved;
  return Array.isArray(named) ? named.filter((id): id is string => typeof id === 'string') : [];
}

const readCandidates = (db: Database, extra: SQL | undefined) =>
  db
    .select({
      id: schema.tasks.id,
      userId: schema.tasks.userId,
      type: schema.tasks.type,
      epoch: schema.tasks.orchestrationEpoch,
      currentStepId: schema.tasks.currentStepId,
      currentRound: schema.tasks.currentRound,
      runListSnapshot: schema.tasks.runListSnapshot,
      customSteps: schema.tasks.customSteps,
      deadAt: schema.tasks.deadAt,
      deadReason: schema.tasks.deadReason,
    })
    .from(schema.tasks)
    .where(and(notInArray(schema.tasks.status, [...TERMINAL_TASK_STATUSES]), extra));

type Candidate = Awaited<ReturnType<typeof readCandidates>>[number];

async function judgeCandidate(db: Database, c: Candidate) {
  const { runListStrategy } = await taskTypeRuntimeFor(db, c.type);
  const deathNamed =
    c.deadAt !== null && c.runListSnapshot === null ? await deathNamedSteps(db, c.id) : undefined;
  const found = deadTaskResolution({ ...c, deathNamed }, runListStrategy);
  return { found, resolves: found.unresolved.length === 0 && found.outsideList === null };
}

/** One pass over the dead tasks whose steps are registered again: each is revived, counted as held while new work is held, or counted as failed when judging or reviving it throws. */
export async function reviveDeadTasks(
  db: Database,
  deps: DeadTaskBootDeps = defaultDeps,
): Promise<{ revived: number; held: number; failed: number }> {
  let revived = 0;
  let held = 0;
  let failed = 0;
  for (const c of await readCandidates(db, isNotNull(schema.tasks.deadAt))) {
    try {
      if (!(await judgeCandidate(db, c)).resolves) continue;
      const outcome = await reviveDeadTask(db, c, deps);
      if (outcome === 'held') held += 1;
      else if (outcome) revived += 1;
    } catch (err) {
      failed += 1;
      log.error({ err, taskId: c.id }, 'dead task reconciliation failed for a task');
    }
  }
  if (held > 0) {
    log.info({ held }, 'dead tasks not revived: new work is held or its state cannot be read');
  }
  return { revived, held, failed };
}

/** Tries the revivals again every interval until a pass holds none back and fails none; the returned function stops it. */
export function retryHeldRevivals(
  db: Database,
  deps: DeadTaskBootDeps = defaultDeps,
  intervalMs = DEAD_TASK_REVIVE_RETRY_MS,
): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    reviveDeadTasks(db, deps)
      .then(({ held, failed }) => {
        if (held === 0 && failed === 0) clearInterval(timer);
      })
      .catch((err) => log.warn({ err }, 'retrying the held dead-task revivals failed'))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

export async function reconcileDeadTasks(
  db: Database,
  deps: DeadTaskBootDeps = defaultDeps,
): Promise<{ marked: number; revived: number; held: number; failed: number }> {
  let marked = 0;
  const live = await readCandidates(
    db,
    and(isNull(schema.tasks.deadAt), isNotNull(schema.tasks.runListSnapshot)),
  );
  for (const c of live) {
    try {
      const { found, resolves } = await judgeCandidate(db, c);
      if (!resolves) {
        const landed = await markTaskDead(
          db,
          c.id,
          deadReasonFor(found.unresolved, found.outsideList ?? undefined),
          {
            epoch: c.epoch,
            unresolved: found.unresolved,
            stepId: c.currentStepId ?? undefined,
            round: c.currentStepId === null ? undefined : c.currentRound,
          },
        );
        if (landed) {
          marked += 1;
          await resyncAfterTaskEnd(db, c.id);
        }
      }
    } catch (err) {
      log.error({ err, taskId: c.id }, 'dead task reconciliation failed for a task');
    }
  }
  const { revived, held, failed } = await reviveDeadTasks(db, deps);
  // No sandbox survives boot, so a run a dead task still has open is an orphan, and its requeued job would run it again.
  await db
    .transaction((tx) =>
      supersedeDeadTaskRuns(
        tx,
        inArray(
          schema.cliInvocations.taskId,
          tx
            .select({ id: schema.tasks.id })
            .from(schema.tasks)
            .where(
              and(
                isNotNull(schema.tasks.deadAt),
                notInArray(schema.tasks.status, [...TERMINAL_TASK_STATUSES]),
              ),
            ),
        ),
      ),
    )
    .catch((err) => log.error({ err }, 'ending the runs of dead tasks failed'));
  return { marked, revived, held, failed };
}
