import { DataEdgePlanError } from '@haive/shared/data-edge-plan';
import { assertDataEdgeSupport } from '../step-engine/data-edge-support.js';
import { assertWorkerExecutionContractSupported } from '../step-engine/execution-contract-support.js';
import { pinnedFixTarget, unsupportedPinnedFixTarget } from '../step-engine/fix-consumer.js';
import {
  ExecutionContractError,
  DerivedRunPlanError,
  parseDerivedRunPlan,
  pinnedTaskStepIds,
} from '@haive/shared/modularity';
import { reviveRefusal } from '@haive/shared/onboarding-admission';
import { taskRootMergeBusy } from '@haive/shared/root-merge-busy';
import { ModuleAdmissionError } from '@haive/shared/modularity-server';
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  schema,
  boundedLockWait,
  TASK_START_LOCK_TIMEOUT_MS,
  isLockNotAvailable,
  type Database,
  type DbTx,
} from '@haive/database';
import { logger, TASK_DEAD_EVENT, type WorkflowType } from '@haive/shared';
import { resyncAfterTaskEnd } from '../project-state/set-aside.js';
import {
  PinnedStepSupportError,
  stepRegistry,
  type StepRegistry,
} from '../step-engine/registry.js';
import { TERMINAL_TASK_STATUSES } from '../step-engine/step-ownership.js';
import { newWorkHeldUnderFence } from './_revive-check.js';
import {
  parseCustomSteps,
  assertPinnedCandidateSupport,
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

import { resolveStepIntegrations } from '@haive/shared/integrations';
import {
  stepIntegrationRequirements,
  invalidRequirementsFailure,
} from '../step-engine/step-integrations.js';

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
export const DEAD_TASK_REVIVE_MAX_RETRY_MS = 5 * 60_000;

// One notice for a continuously held revival, including boot and its later polls.
const heldRevivalNotices = new WeakMap<Database, Set<string>>();
function heldNotices(db: Database): Set<string> {
  let notices = heldRevivalNotices.get(db);
  if (!notices) heldRevivalNotices.set(db, (notices = new Set()));
  return notices;
}

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
  supportReason?: string;
}

/** Pure: resolveTaskContext makes scratch workspaces and throws on a deleted repository. */
export function deadTaskResolution(
  task: {
    id: string;
    type: string;
    currentStepId: string | null;
    runListSnapshot: string[] | null;
    customSteps: unknown;
    derivedRunPlan?: unknown;
    dataEdgePlan?: unknown;
    executionContract?: unknown;
    executionPath?: string | null;
    /** The step ids its last task.dead event named. */
    deathNamed?: readonly string[];
  },
  strategy: ResolvedTaskContext['runListStrategy'],
  registry: StepRegistry = stepRegistry,
): DeadTaskResolution {
  try {
    assertWorkerExecutionContractSupported(
      task.executionContract,
      {
        runListStrategy: strategy,
        runListSnapshot: task.runListSnapshot,
        derivedRunPlan: task.derivedRunPlan,
      },
      registry,
    );
    assertDataEdgeSupport(task, registry);
    const unsupported = unsupportedPinnedFixTarget(task, registry);
    if (unsupported !== null) throw new ExecutionContractError(unsupported);
  } catch (error) {
    if (error instanceof ExecutionContractError)
      return { unresolved: [], outsideList: null, supportReason: error.message };
    if (!(error instanceof PinnedStepSupportError)) throw error;
    return { unresolved: [...error.ids], outsideList: null, supportReason: error.message };
  }
  if (strategy === 'derived') parseDerivedRunPlan(task.derivedRunPlan);
  if (task.derivedRunPlan != null) {
    const plan = parseDerivedRunPlan(task.derivedRunPlan);
    if (plan.version === 2) {
      try {
        for (const candidate of plan.candidates.filter(
          (c) => task.executionPath == null || c.executionPath === task.executionPath,
        )) {
          assertPinnedCandidateSupport(candidate, registry);
        }
      } catch (error) {
        if (!(error instanceof PinnedStepSupportError)) throw error;
        return { unresolved: [...error.ids], outsideList: null, supportReason: error.message };
      }
    }
  }
  const scope = {
    taskId: task.id,
    workflowType: task.type as WorkflowType,
    runListSnapshot:
      task.derivedRunPlan != null ? [...pinnedTaskStepIds(task)!] : task.runListSnapshot,
    customSteps: parseCustomSteps(task.customSteps),
  };
  const isStatic = strategy === 'static' || strategy === 'derived';
  const unresolved = isStatic ? [...resolveRunList(scope, registry).unresolved] : [];
  // A task with no snapshot keeps no list to re-check, so the record of its death says what was missing.
  if (task.runListSnapshot === null) {
    const pinned = pinnedFixTarget(task.executionContract)?.stepId;
    for (const id of [...(task.deathNamed ?? []), ...(pinned ? [pinned] : [])]) {
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
      isStatic && scope.runListSnapshot !== null && !scope.runListSnapshot.includes(current)
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
  let heldReason = 'new-work';
  let refusedReason: string | null = null;
  const reviving = db.transaction(async (tx) => {
    if (await newWorkHeldUnderFence(tx)) return 'held' as const;
    try {
      const refusal = await boundedLockWait(
        tx,
        () => reviveRefusal(tx, c.id),
        TASK_START_LOCK_TIMEOUT_MS,
      );
      if (refusal) {
        const reason = 'refusal' in refusal ? refusal.refusal.reason : refusal.admission.reason;
        heldReason = reason;
        refusedReason = reason;
        return reason === 'root-claim' ||
          reason === 'live-upgrade' ||
          reason === 'live-onboarding' ||
          reason === 'contested'
          ? ('held' as const)
          : null;
      }
    } catch (err) {
      if (err instanceof ModuleAdmissionError) {
        heldReason = 'module-admission';
        return 'held' as const;
      }
      throw err;
    }
    const [current] = await readCandidates(tx, eq(schema.tasks.id, c.id));
    if (
      !current ||
      ((current.derivedRunPlan != null ||
        current.dataEdgePlan != null ||
        current.executionContract != null) &&
        deadTaskResolution(current, current.derivedRunPlan != null ? 'derived' : 'static')
          .supportReason !== undefined) ||
      (await currentIntegrationMissing(tx, current))
    )
      return null;
    if (await taskRootMergeBusy(tx, c.id)) {
      heldReason = 'root-merge';
      return 'held' as const;
    }
    const locked = await boundedLockWait(
      tx,
      async () =>
        tx
          .select({ id: schema.tasks.id })
          .from(schema.tasks)
          .where(eq(schema.tasks.id, c.id))
          .for('update'),
      TASK_START_LOCK_TIMEOUT_MS,
    );
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
  const revived = await reviving.catch((err: unknown) => {
    if (isLockNotAvailable(err)) {
      heldReason = 'busy';
      return 'held' as const;
    }
    throw err;
  });
  const notices = heldNotices(db);
  if (revived === 'held') {
    if (!notices.has(c.id)) {
      notices.add(c.id);
      log.info({ taskId: c.id, reason: heldReason }, 'dead task revival held');
    }
    return 'held';
  }
  if (!revived && refusedReason) {
    if (!notices.has(c.id)) {
      notices.add(c.id);
      log.info({ taskId: c.id, reason: refusedReason }, 'dead task revival refused');
    }
    return null;
  }
  notices.delete(c.id);
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

const readCandidates = (db: Database | DbTx, extra: SQL | undefined) =>
  db
    .select({
      id: schema.tasks.id,
      userId: schema.tasks.userId,
      type: schema.tasks.type,
      epoch: schema.tasks.orchestrationEpoch,
      currentStepId: schema.tasks.currentStepId,
      currentRound: schema.tasks.currentRound,
      runListSnapshot: schema.tasks.runListSnapshot,
      derivedRunPlan: schema.tasks.derivedRunPlan,
      dataEdgePlan: schema.tasks.dataEdgePlan,
      executionContract: schema.tasks.executionContract,
      executionPath: schema.tasks.executionPath,
      customSteps: schema.tasks.customSteps,
      deadAt: schema.tasks.deadAt,
      deadReason: schema.tasks.deadReason,
    })
    .from(schema.tasks)
    .where(and(notInArray(schema.tasks.status, [...TERMINAL_TASK_STATUSES]), extra));

type Candidate = Awaited<ReturnType<typeof readCandidates>>[number];

async function judgeCandidate(db: Database, c: Candidate) {
  const { runListStrategy } = await taskTypeRuntimeFor(db, c.type, c.derivedRunPlan);
  const deathNamed =
    c.deadAt !== null && c.runListSnapshot === null ? await deathNamedSteps(db, c.id) : undefined;
  const found = deadTaskResolution({ ...c, deathNamed }, runListStrategy);
  const integrationMissing = await currentIntegrationMissing(db, c);
  return {
    found,
    integrationMissing,
    resolves:
      found.unresolved.length === 0 &&
      found.outsideList === null &&
      found.supportReason === undefined &&
      !integrationMissing,
  };
}

/** Current declarations and resolver state, including task choices/grants, decide revival. */
async function currentIntegrationMissing(db: Database | DbTx, c: Candidate): Promise<boolean> {
  if (c.currentStepId === null) return false;
  const def = resolveTaskStep(
    {
      taskId: c.id,
      customSteps: parseCustomSteps(c.customSteps),
      runListSnapshot: c.runListSnapshot,
    },
    c.currentStepId,
  );
  if (!def) return false; // The ordinary step-resolution owner judges that case.
  if (invalidRequirementsFailure(def) !== null) return false;
  const requirements = stepIntegrationRequirements(def);
  // Unsupported pins keep the existing named dispatch refusal, before category resolution.
  if (requirements.length === 0 || requirements.some((r) => r.category === undefined)) return false;
  const resolutions = await resolveStepIntegrations(db, { taskId: c.id }, requirements);
  return resolutions.some(
    (r) => r.status === 'unresolved' && !r.optional && r.reason === 'provider-missing',
  );
}

/** Permanent pin corruption is terminal until an explicit operator Retry. Keep the pin
 * unchanged and publish one failure under the same epoch CAS; never hold a retry timer. */
async function failMalformedPin(db: Database, c: Candidate, error: unknown): Promise<boolean> {
  if (!(error instanceof DataEdgePlanError) && !(error instanceof DerivedRunPlanError))
    return false;
  const message = error instanceof DataEdgePlanError ? error.message : 'invalid-derived-run-plan';
  const changed = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.tasks)
      .set({
        status: 'failed',
        deadAt: null,
        deadReason: null,
        errorMessage: message,
        completedAt: new Date(),
        orchestrationEpoch: sql`${schema.tasks.orchestrationEpoch} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.tasks.id, c.id),
          eq(schema.tasks.orchestrationEpoch, c.epoch),
          notInArray(schema.tasks.status, [...TERMINAL_TASK_STATUSES]),
          or(isNotNull(schema.tasks.deadAt), notInArray(schema.tasks.status, ['failed'])),
          c.deadAt === null ? isNull(schema.tasks.deadAt) : eq(schema.tasks.deadAt, c.deadAt),
        ),
      )
      .returning({ id: schema.tasks.id });
    if (!row) return false;
    await tx.insert(schema.taskEvents).values({
      taskId: c.id,
      taskStepId: null,
      eventType: 'task.failed',
      payload: {
        reason: error instanceof DataEdgePlanError ? error.code : 'invalid-derived-run-plan',
      },
    });
    return true;
  });
  if (changed)
    log.error({ err: error, taskId: c.id }, 'task failed permanently: malformed execution pin');
  // Run cleanup holds no task-row lock: Retry takes runs before steps and the task.
  // A failed cleanup is retried by boot and the revival sweep even after deadAt was cleared.
  await db.transaction((tx) =>
    supersedeDeadTaskRuns(
      tx,
      and(
        eq(schema.cliInvocations.taskId, c.id),
        inArray(
          schema.cliInvocations.taskId,
          tx
            .select({ id: schema.tasks.id })
            .from(schema.tasks)
            .where(
              and(
                eq(schema.tasks.id, c.id),
                eq(schema.tasks.status, 'failed'),
                eq(schema.tasks.orchestrationEpoch, changed ? c.epoch + 1 : c.epoch),
              ),
            ),
        ),
      ),
    ),
  );
  await resyncAfterTaskEnd(db, c.id);
  return true;
}

/** One pass over the dead tasks whose steps are registered again: each is revived, counted as held while new work is held, or counted as failed when judging or reviving it throws. */
export async function reviveDeadTasks(
  db: Database,
  deps: DeadTaskBootDeps = defaultDeps,
): Promise<{ revived: number; held: number; failed: number }> {
  let revived = 0;
  let held = 0;
  let failed = 0;
  const seen = new Set<string>();
  for (const c of await readCandidates(
    db,
    or(
      isNotNull(schema.tasks.deadAt),
      and(
        eq(schema.tasks.status, 'failed'),
        inArray(
          schema.tasks.id,
          db
            .select({ taskId: schema.cliInvocations.taskId })
            .from(schema.cliInvocations)
            .where(
              and(
                isNull(schema.cliInvocations.endedAt),
                isNull(schema.cliInvocations.supersededAt),
              ),
            ),
        ),
      ),
    ),
  )) {
    seen.add(c.id);
    try {
      if (!(await judgeCandidate(db, c)).resolves || c.deadAt === null) continue;
      const outcome = await reviveDeadTask(db, c, deps);
      if (outcome === 'held') held += 1;
      else if (outcome) revived += 1;
    } catch (err) {
      failed += 1;
      if (!(await failMalformedPin(db, c, err)))
        log.error({ err, taskId: c.id }, 'dead task reconciliation failed for a task');
    }
  }
  const notices = heldNotices(db);
  for (const id of notices) if (!seen.has(id)) notices.delete(id);
  return { revived, held, failed };
}

/** Retries with capped exponential backoff until no revival is held or failed. */
export function retryHeldRevivals(
  db: Database,
  deps: DeadTaskBootDeps = defaultDeps,
  intervalMs = DEAD_TASK_REVIVE_RETRY_MS,
  maxIntervalMs = DEAD_TASK_REVIVE_MAX_RETRY_MS,
): () => void {
  let stopped = false;
  let delay = Math.min(intervalMs, maxIntervalMs);
  let timer: ReturnType<typeof setTimeout>;
  const schedule = () => {
    timer = setTimeout(async () => {
      try {
        const { held, failed } = await reviveDeadTasks(db, deps);
        if (held === 0 && failed === 0) return;
      } catch (err) {
        log.warn({ err }, 'retrying the held dead-task revivals failed');
      }
      delay = Math.min(delay * 2, maxIntervalMs);
      if (!stopped) schedule();
    }, delay);
    timer.unref();
  };
  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

export async function reconcileDeadTasks(
  db: Database,
  deps: DeadTaskBootDeps = defaultDeps,
): Promise<{ marked: number; revived: number; held: number; failed: number }> {
  let marked = 0;
  const live = await readCandidates(
    db,
    and(
      isNull(schema.tasks.deadAt),
      or(isNotNull(schema.tasks.runListSnapshot), isNotNull(schema.tasks.executionContract)),
    ),
  );
  for (const c of live) {
    try {
      const { found, integrationMissing, resolves } = await judgeCandidate(db, c);
      if (!resolves) {
        const landed = await markTaskDead(
          db,
          c.id,
          integrationMissing
            ? 'A required integration provider is not installed. Ask an administrator to restore its module and restart the worker.'
            : (found.supportReason ??
                deadReasonFor(found.unresolved, found.outsideList ?? undefined)),
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
      if (!(await failMalformedPin(db, c, err)))
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
