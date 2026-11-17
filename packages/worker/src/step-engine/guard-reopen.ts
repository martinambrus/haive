import { and, eq, inArray, isNull } from 'drizzle-orm';
import { lockStepRows, schema, type DbTx } from '@haive/database';
import { parseExecutionContract } from '@haive/shared/modularity';
import type { StepContext } from '@haive/shared/step';
import { GuardDecisionError, guardContractHash, parseGuardDecision } from './guard-decisions.js';
import { StepSupersededError, taskWriteTarget } from './step-ownership.js';

/** An in-place insight attempt retains the branch already executed. Rebind its
 * identities, including shared/dependent skipped entries, without evaluating or
 * reopening any span. Agent consumption precedes this ordered batch; the caller
 * commits these writes with the generation bump and durable form hold. */
export async function reconcileReopenedGuardGeneration(
  tx: DbTx,
  ctx: StepContext,
  nextGeneration: number,
): Promise<void> {
  if (ctx.epoch == null || ctx.rerunGeneration !== nextGeneration - 1)
    throw new StepSupersededError(ctx.taskStepId);
  const held = await lockStepRows(tx, eq(schema.taskSteps.taskId, ctx.taskId));
  const rows = await tx
    .select()
    .from(schema.taskSteps)
    .where(
      inArray(
        schema.taskSteps.id,
        held.map((r) => r.id),
      ),
    );
  const current = rows.find((r) => r.id === ctx.taskStepId);
  if (
    !current ||
    current.round !== ctx.round ||
    current.rerunGeneration !== nextGeneration - 1 ||
    !['running', 'waiting_cli', 'waiting_form'].includes(current.status)
  )
    throw new StepSupersededError(ctx.taskStepId);
  const [task] = await tx
    .select()
    .from(schema.tasks)
    .where(
      and(
        taskWriteTarget(ctx.taskId, { epoch: ctx.epoch }),
        eq(schema.tasks.userId, ctx.userId),
        isNull(schema.tasks.deadAt),
        eq(schema.tasks.currentStepId, current.stepId),
        eq(schema.tasks.currentRound, ctx.round),
      ),
    )
    .for('share');
  if (!task || !task.runListSnapshot) throw new StepSupersededError(ctx.taskStepId);
  const contract = parseExecutionContract(task.executionContract);
  const hash = guardContractHash(task.runListSnapshot, contract);
  if (
    contract.guardedSpans.some((s) => s.firstStepId === current.stepId) &&
    current.guardState == null
  )
    throw new GuardDecisionError('missing-decision');
  for (const row of rows) {
    if (row.round !== ctx.round || row.guardState == null) continue;
    if ((row.guardState as { kind?: unknown }).kind === 'guard-skip') {
      if (row.id === current.id) throw new GuardDecisionError('reopen-suppressed-span');
      continue; // Its entry generation is unchanged; the entry's references below are rebound.
    }
    const saved = parseGuardDecision(row.guardState);
    if (
      saved.taskId !== task.id ||
      saved.round !== row.round ||
      saved.generation !== row.rerunGeneration ||
      saved.contractHash !== hash ||
      !contract.guardedSpans.some((s) => s.id === saved.spanId && s.firstStepId === row.stepId)
    )
      throw new GuardDecisionError('stale-decision');
    let changed = false;
    const rebind = <T extends { stepRowId: string; generation: number }>(
      ref: T | null,
    ): T | null => {
      if (ref?.stepRowId !== current.id) return ref;
      if (ref.generation !== current.rerunGeneration)
        throw new GuardDecisionError('stale-decision');
      changed = true;
      return { ...ref, generation: nextGeneration };
    };
    if (row.id === current.id) {
      if (!saved.run) throw new GuardDecisionError('reopen-suppressed-span');
      saved.generation = nextGeneration;
      changed = true;
    }
    saved.boundary = rebind(saved.boundary);
    saved.required = rebind(saved.required);
    if (saved.predicate) saved.predicate.source = rebind(saved.predicate.source)!;
    if (changed)
      await tx
        .update(schema.taskSteps)
        .set({ guardState: saved })
        .where(eq(schema.taskSteps.id, row.id));
  }
}
