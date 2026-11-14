import { and, eq, inArray } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { loadTaskStepFlags } from './step-flags.js';
import { enrichStepsWithCliPreferences } from '../routes/tasks/_helpers.js';

/** Remaining fresh step bindings, not a prediction of shouldRun: the worker alone can
 * evaluate repository-dependent skips. Like providerHoldFor, inspect only the default
 * slot of CLI-consuming or provider-sensitive steps; continuations are never held.
 * An implicit default is deliberately NOT resolved here: it moves when disabled. */
export async function providerDisableImpact(db: Database, userId: string, providerId: string) {
  const tasks = await db
    .select()
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.userId, userId),
        inArray(schema.tasks.status, [
          'created',
          'queued',
          'running',
          'paused',
          'waiting_user',
          'waiting_pr',
        ]),
      ),
    );
  if (tasks.length === 0) return { taskCount: 0, stepCount: 0 };
  const rows = await db
    .select()
    .from(schema.taskSteps)
    .where(
      inArray(
        schema.taskSteps.taskId,
        tasks.map((t) => t.id),
      ),
    );
  let taskCount = 0;
  let stepCount = 0;
  for (const task of tasks) {
    const flags = await loadTaskStepFlags(db, task);
    const runList =
      task.runListSnapshot ??
      [...flags.values()]
        .filter((f) => f.workflowType === task.type)
        .sort((a, b) => (a.stepIndex ?? Infinity) - (b.stepIndex ?? Infinity))
        .map((f) => f.stepId);
    const currentIndex = task.currentStepId ? runList.indexOf(task.currentStepId) : -1;
    const candidates = [...new Set(runList)]
      .filter((stepId) => {
        const f = flags.get(stepId);
        if (!f?.dispatchesStepCli && !f?.providerSensitive) return false;
        if (currentIndex >= 0 && runList.indexOf(stepId) < currentIndex) return false;
        const row = rows.find(
          (r) => r.taskId === task.id && r.stepId === stepId && r.round === task.currentRound,
        );
        return !row || row.status === 'pending';
      })
      .map((stepId) => ({ stepId }));
    const steps = await enrichStepsWithCliPreferences(
      db,
      flags,
      userId,
      candidates,
      task.id,
      task.ignoreSavedStepClis,
    );
    const count = steps.filter(
      (s) => (s.preferredCliProviderId ?? task.cliProviderId) === providerId,
    ).length;
    if (count > 0) taskCount++;
    stepCount += count;
  }
  return { taskCount, stepCount };
}
