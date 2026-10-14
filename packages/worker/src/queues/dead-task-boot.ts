import { and, desc, eq, inArray, isNotNull, isNull, notInArray, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { logger, type WorkflowType } from '@haive/shared';
import { stepRegistry, type StepRegistry } from '../step-engine/registry.js';
import { TERMINAL_TASK_STATUSES } from '../step-engine/step-ownership.js';
import {
  parseCustomSteps,
  resolveRunList,
  resolveTaskStep,
  taskTypeRuntimeFor,
  type ResolvedTaskContext,
} from './run-list.js';
import {
  deadReasonFor,
  enqueueAdvance,
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

const defaultDeps: DeadTaskBootDeps = { enqueueStart, enqueueAdvance };

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
    runListSnapshot: string[];
    customSteps: unknown;
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
  const unresolved = isStatic ? resolveRunList(scope, registry).unresolved : [];
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
    outsideList: isStatic && !task.runListSnapshot.includes(current) ? current : null,
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
  if (status !== 'waiting_user') return { kind: 'none' };
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

/** Compare-and-swap on the state read under the task row's lock; a job that cannot be queued puts the dead state back for the next boot, keeping the bumped epoch so a job sent despite the error stays stale. */
export async function reviveDeadTask(
  db: Database,
  c: DeadTaskView,
  deps: DeadTaskBootDeps,
): Promise<ReviveJob['kind'] | null> {
  const revived = await db.transaction(async (tx) => {
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
    const [lastDead] = await tx
      .select({ payload: schema.taskEvents.payload })
      .from(schema.taskEvents)
      .where(and(eq(schema.taskEvents.taskId, c.id), eq(schema.taskEvents.eventType, 'task.dead')))
      .orderBy(desc(schema.taskEvents.createdAt))
      .limit(1);
    const named = (lastDead?.payload as { unresolved?: unknown } | undefined)?.unresolved;
    await tx.insert(schema.taskEvents).values({
      taskId: c.id,
      taskStepId: null,
      eventType: 'task.revived',
      payload: {
        epoch: row.epoch,
        deadAt: c.deadAt?.toISOString() ?? null,
        unresolved: Array.isArray(named) ? named : [],
        action: job.kind,
      },
    });
    return { epoch: row.epoch, job };
  });
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
    'revived a dead task: every step it names is registered again',
  );
  return revived.job.kind;
}

export async function reconcileDeadTasks(
  db: Database,
  deps: DeadTaskBootDeps = defaultDeps,
): Promise<{ marked: number; revived: number }> {
  const candidates = await db
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
    .where(
      and(
        notInArray(schema.tasks.status, [...TERMINAL_TASK_STATUSES]),
        isNotNull(schema.tasks.runListSnapshot),
      ),
    );
  let marked = 0;
  let revived = 0;
  for (const c of candidates) {
    if (!c.runListSnapshot) continue;
    try {
      const { runListStrategy } = await taskTypeRuntimeFor(db, c.type);
      const found = deadTaskResolution(
        { ...c, runListSnapshot: c.runListSnapshot },
        runListStrategy,
      );
      const resolves = found.unresolved.length === 0 && found.outsideList === null;
      if (resolves && c.deadAt !== null) {
        if (await reviveDeadTask(db, c, deps)) revived += 1;
      } else if (!resolves && c.deadAt === null) {
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
        if (landed) marked += 1;
      }
    } catch (err) {
      log.error({ err, taskId: c.id }, 'dead task reconciliation failed for a task');
    }
  }
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
  return { marked, revived };
}
