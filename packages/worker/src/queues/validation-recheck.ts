import { and, desc, eq, lte, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import type { StepDefinition } from '../step-engine/step-definition.js';
import {
  affectedValidationFiles,
  readValidationSnapshot,
  type ValidationSnapshot,
} from '../step-engine/steps/workflow/_validation-snapshot.js';
import type { ResolvedTaskContext } from './run-list.js';

const VALIDATE = '07b-phase-4-validate';
const RECONCILE = '07c-ddev-reconcile';
export const VALIDATION_RECHECK_EVENT = 'validation.recheck_requested';

export class ValidationSnapshotError extends Error {
  constructor() {
    super(
      'Cannot snapshot final changes after two read attempts. Retry this step; if it repeats, check Git access and workspace readability.',
    );
    this.name = 'ValidationSnapshotError';
  }
}

export interface ValidationSuccessor {
  next: StepDefinition | undefined;
  round: number;
  recheck?: { resumeStepId: string | null; affectedFiles: string[] };
}

/** A successful late fixer is not a defect: use fresh rows for 07c/07b, then resume AFTER it.
 * The return address is committed with the task pointer, so crash recovery and Retry need no
 * in-memory cursor. The ordinary fix loop still handles real findings and owns its own budget.
 * Revalidation conservatively reviews the whole final task change, including the affected paths. */
export async function validationSuccessor(
  db: Database,
  ctx: ResolvedTaskContext,
  stepId: string,
  round: number,
  steps: readonly StepDefinition[],
): Promise<ValidationSuccessor> {
  const ids = steps.map((s) => s.metadata.id);
  const index = ids.indexOf(stepId);
  const validateIndex = ids.indexOf(VALIDATE);
  const commitIndex = ids.indexOf('10-gate-3-commit');
  const ordinary = { next: steps[index + 1], round };
  if (validateIndex < 0 || index < validateIndex || (commitIndex >= 0 && index >= commitIndex)) {
    return ordinary;
  }
  if (stepId === VALIDATE) {
    if (round === 0) return ordinary;
    const event = await db.query.taskEvents.findFirst({
      where: and(
        eq(schema.taskEvents.taskId, ctx.taskId),
        eq(schema.taskEvents.eventType, VALIDATION_RECHECK_EVENT),
        sql`${schema.taskEvents.payload}->>'round' = ${String(round)}`,
      ),
      orderBy: [desc(schema.taskEvents.createdAt)],
    });
    if (!event) return ordinary;
    const resume = (event.payload as { resumeStepId: string | null }).resumeStepId;
    if (resume === null) return { next: undefined, round };
    const next = steps.find((s) => s.metadata.id === resume);
    if (!next) throw new Error(`Validation return step ${resume} is not in the run list`);
    return { next, round };
  }
  // Only declared code/test editors can make a successful late fixer require revalidation.
  // This also bounds static lists with no commit gate: learning/skill writes are excluded.
  if (steps[index]?.editsCodeOrTests !== true) return ordinary;
  const validated = await db.query.taskSteps.findFirst({
    where: and(
      eq(schema.taskSteps.taskId, ctx.taskId),
      eq(schema.taskSteps.stepId, VALIDATE),
      eq(schema.taskSteps.status, 'done'),
      lte(schema.taskSteps.round, round),
    ),
    orderBy: [desc(schema.taskSteps.round)],
  });
  // A type may intentionally omit or skip validation. Do not introduce it off-list.
  if (!validated) return ordinary;
  const before = (validated.output as { validationSnapshot?: ValidationSnapshot | null } | null)
    ?.validationSnapshot;
  const after = await readValidationSnapshot({ db, taskId: ctx.taskId });
  if (after === null) throw new ValidationSnapshotError();
  const affectedFiles = affectedValidationFiles(before, after);
  if (before && affectedFiles.length === 0) return ordinary;
  return {
    next:
      ids.indexOf(RECONCILE) >= 0 && ids.indexOf(RECONCILE) < validateIndex
        ? steps[ids.indexOf(RECONCILE)]
        : steps[validateIndex],
    round: round + 1,
    recheck: { resumeStepId: ordinary.next?.metadata.id ?? null, affectedFiles },
  };
}
