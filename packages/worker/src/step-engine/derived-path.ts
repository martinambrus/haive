import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { ExecutionPath } from '@haive/shared';
import { derivedCandidateIds, parseDerivedRunPlan } from '@haive/shared/modularity';
import { UnresolvedStepError, stepRegistry, type StepRegistry } from './registry.js';
import type { StepContext } from './step-definition.js';
import { lockOwnedStep, StepSupersededError } from './step-ownership.js';
import { resolveTaskStep, parseCustomSteps } from '../queues/run-list.js';

export class DerivedPathPinnedError extends Error {
  readonly code = 'derived_path_pinned';
  constructor() {
    super('derived_path_pinned: Create a new task to change path.');
    this.name = 'DerivedPathPinnedError';
  }
}

/** The only UPDATE of a derived snapshot. Step first, task second, matching Retry/Stop/Cancel. */
export async function pinDerivedWorkflowPath(
  ctx: Pick<StepContext, 'db' | 'taskId' | 'taskStepId' | 'round' | 'epoch'>,
  path: ExecutionPath,
  broadAudit: boolean,
  registry: Pick<StepRegistry, 'get'> = stepRegistry,
): Promise<false | { path: ExecutionPath; broadAudit: boolean }> {
  const initial = await ctx.db.query.tasks.findFirst({
    where: eq(schema.tasks.id, ctx.taskId),
    columns: { type: true, derivedRunPlan: true },
  });
  if (!initial) throw new StepSupersededError(ctx.taskStepId);
  if (initial.derivedRunPlan == null) {
    const definition = await ctx.db.query.taskTypeDefinitions.findFirst({
      where: eq(schema.taskTypeDefinitions.slug, initial.type),
      columns: { runListStrategy: true },
    });
    if (definition?.runListStrategy !== 'derived') return false;
    parseDerivedRunPlan(initial.derivedRunPlan);
  }
  return ctx.db.transaction(async (tx) => {
    if (!(await lockOwnedStep(tx, ctx.taskStepId))) throw new StepSupersededError(ctx.taskStepId);
    const [step] = await tx
      .select()
      .from(schema.taskSteps)
      .where(eq(schema.taskSteps.id, ctx.taskStepId));
    const [task] = await tx
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, ctx.taskId))
      .for('no key update');
    if (
      !task ||
      !step ||
      step.taskId !== task.id ||
      step.stepId !== '00-triage' ||
      step.round !== ctx.round ||
      task.currentStepId !== '00-triage' ||
      task.currentRound !== ctx.round ||
      ctx.epoch == null ||
      task.orchestrationEpoch !== ctx.epoch ||
      !['running', 'waiting_user'].includes(task.status) ||
      task.deadAt !== null
    )
      throw new StepSupersededError(ctx.taskStepId);
    const plan = parseDerivedRunPlan(task.derivedRunPlan);
    if (task.executionPath !== null && task.executionPath !== path)
      throw new DerivedPathPinnedError();
    const stepIds = derivedCandidateIds(plan, path);
    const scope = {
      taskId: task.id,
      runListSnapshot: stepIds,
      customSteps: parseCustomSteps(task.customSteps),
    };
    const missing = stepIds.filter((id) => !resolveTaskStep(scope, id, registry));
    if (missing.length) throw new UnresolvedStepError(missing);
    if (task.executionPath !== null) {
      return { path, broadAudit: task.broadAudit }; // A crash after this commit reuses the exact pin and event.
    }
    const prune = <T>(values: Record<string, T>) =>
      Object.fromEntries(Object.entries(values).filter(([id]) => stepIds.includes(id)));
    await tx
      .update(schema.tasks)
      .set({
        executionPath: path,
        broadAudit,
        runListSnapshot: stepIds,
        preAnswers: task.preAnswers === null ? null : prune(task.preAnswers),
        stepLoopLimits: prune(task.stepLoopLimits),
        updatedAt: new Date(),
      })
      .where(eq(schema.tasks.id, task.id));
    await tx.insert(schema.taskEvents).values({
      taskId: task.id,
      taskStepId: step.id,
      eventType: 'task.derived_path_pinned',
      payload: { path, broadAudit, catalogFingerprint: plan.base.catalogFingerprint },
    });
    return { path, broadAudit };
  });
}
