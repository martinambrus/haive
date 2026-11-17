import { and, desc, eq, lte } from 'drizzle-orm';
import { isUniqueViolationOf, schema, type Database } from '@haive/database';
import { logger } from '@haive/shared';
import { parseExecutionContract } from '@haive/shared/modularity';
import { TaskCancelledError, type StepContext } from '@haive/shared/step';
import { guardContractHash, parseGuardDecision } from './guard-decisions.js';
import { advanceGuardSpan } from './guard-span-skip.js';
import { registeredGuardPredicates } from './guard-predicates.js';
import { stepRegistry } from './registry.js';
import type { StepDefinition } from './step-definition.js';
import { upsertRow } from './step-runner.js';

type StepRow = typeof schema.taskSteps.$inferSelect;

/** The task fields the guard hooks read; the worker's resolved context satisfies it. */
export interface GuardTaskScope {
  taskId: string;
  userId: string;
  orchestrationEpoch: number;
  executionContract?: unknown;
  runListSnapshot: readonly string[] | null;
}

export type GuardEntryOutcome =
  | { kind: 'none' | 'run' | 'stale' }
  | { kind: 'retry'; row: StepRow }
  | { kind: 'skipped'; entry: StepRow }
  | { kind: 'refused'; row: StepRow; reason: string };

/** A transient guard refusal; the advance job is retried by the queue. */
export class GuardRetry extends Error {
  constructor() {
    super('guard decision retry');
    this.name = 'GuardRetry';
  }
}

const STALE_REASONS = new Set(['task-fence-lost', 'entry-fence-lost', 'task-unavailable']);
const ROUND_INDEX = 'task_steps_task_step_round_idx';

const parsedPin = (scope: GuardTaskScope) =>
  scope.executionContract == null ? null : parseExecutionContract(scope.executionContract);

async function selectRow(
  db: Database,
  taskId: string,
  stepId: string,
  round: number,
): Promise<StepRow | undefined> {
  const [row] = await db
    .select()
    .from(schema.taskSteps)
    .where(
      and(
        eq(schema.taskSteps.taskId, taskId),
        eq(schema.taskSteps.stepId, stepId),
        eq(schema.taskSteps.round, round),
      ),
    )
    .limit(1);
  return row;
}

async function materialize(
  db: Database,
  taskId: string,
  def: StepDefinition,
  round: number,
  runSeq: number,
): Promise<StepRow> {
  try {
    return await upsertRow(db, taskId, def, round, runSeq);
  } catch (err) {
    if (!isUniqueViolationOf(err, ROUND_INDEX)) throw err;
    const row = await selectRow(db, taskId, def.metadata.id, round);
    if (!row) throw err;
    return row;
  }
}

function entryDecisionRefusal(
  entry: StepRow | undefined,
  span: { id: string },
  scope: GuardTaskScope,
  contract: NonNullable<ReturnType<typeof parsedPin>>,
  ids: readonly string[] | null,
): string | null {
  if (!entry || entry.guardState == null) return 'no-decision';
  if (!ids) return 'no-decision';
  try {
    const decision = parseGuardDecision(entry.guardState);
    if (
      decision.run &&
      decision.taskId === scope.taskId &&
      decision.spanId === span.id &&
      decision.round === entry.round &&
      decision.generation === entry.rerunGeneration &&
      decision.contractHash === guardContractHash(ids, contract)
    )
      return null;
  } catch {
    return 'malformed-state';
  }
  return 'decision-mismatch';
}

export async function decideGuardEntry(
  db: Database,
  scope: GuardTaskScope,
  stepId: string,
  round: number,
  existing: StepRow | null | undefined,
  runList: readonly StepDefinition[],
): Promise<GuardEntryOutcome> {
  const contract = parsedPin(scope);
  const span = contract?.guardedSpans.find((s) => s.firstStepId === stepId);
  if (!contract || !span) return { kind: 'none' };
  if (existing && existing.status !== 'pending') {
    const reason = entryDecisionRefusal(existing, span, scope, contract, scope.runListSnapshot);
    return reason ? { kind: 'refused', row: existing, reason } : { kind: 'none' };
  }
  if (existing?.guardState != null) {
    try {
      const decision = parseGuardDecision(existing.guardState);
      if (
        decision.run &&
        decision.spanId === span.id &&
        decision.round === existing.round &&
        decision.generation === existing.rerunGeneration
      )
        return { kind: 'none' };
    } catch {
      // a malformed receipt falls through to the decision, which refuses it
    }
  }
  const first = runList.findIndex((d) => d.metadata.id === stepId);
  const last = runList.findIndex((d) => d.metadata.id === span.lastStepId);
  const entryDef = runList[first];
  if (!entryDef || last < first) {
    const row =
      existing ?? (entryDef ? await materialize(db, scope.taskId, entryDef, round, first) : null);
    return row ? { kind: 'refused', row, reason: 'span-endpoints' } : { kind: 'stale' };
  }
  const entry = await materialize(db, scope.taskId, entryDef, round, first);
  for (let i = first + 1; i <= last; i++)
    await materialize(db, scope.taskId, runList[i]!, round, i);
  const stepCtx = {
    taskId: scope.taskId,
    taskStepId: entry.id,
    userId: scope.userId,
    db,
    round,
    epoch: scope.orchestrationEpoch,
    rerunGeneration: entry.rerunGeneration,
    signal: new AbortController().signal,
    throwIfCancelled() {},
    logger,
  } as unknown as StepContext;
  let result: Awaited<ReturnType<typeof advanceGuardSpan>>;
  try {
    result = await advanceGuardSpan(
      stepCtx,
      span.id,
      registeredGuardPredicates(stepRegistry),
      async () => {},
    );
  } catch (err) {
    if (err instanceof TaskCancelledError) return { kind: 'stale' };
    throw err;
  }
  if (result.kind === 'ordinary' || result.kind === 'run') return { kind: 'run' };
  if (result.kind === 'retry') return { kind: 'retry', row: entry };
  if (result.kind === 'refused')
    return STALE_REASONS.has(result.reason)
      ? { kind: 'stale' }
      : { kind: 'refused', row: entry, reason: result.reason };
  const after = await selectRow(db, scope.taskId, stepId, round);
  return after && after.status === 'skipped' && after.rerunGeneration === entry.rerunGeneration
    ? { kind: 'skipped', entry: after }
    : { kind: 'stale' };
}

export async function checkGuardMembership(
  db: Database,
  scope: GuardTaskScope,
  stepId: string,
  round: number,
): Promise<{ reason: string } | null> {
  const contract = parsedPin(scope);
  const ids = scope.runListSnapshot;
  if (!contract || !ids) return null;
  const at = ids.indexOf(stepId);
  const span = contract.guardedSpans.find(
    (s) => ids.indexOf(s.firstStepId) < at && at <= ids.indexOf(s.lastStepId),
  );
  if (!span) return null;
  const [entry] = await db
    .select()
    .from(schema.taskSteps)
    .where(
      and(
        eq(schema.taskSteps.taskId, scope.taskId),
        eq(schema.taskSteps.stepId, span.firstStepId),
        lte(schema.taskSteps.round, round),
      ),
    )
    .orderBy(desc(schema.taskSteps.round))
    .limit(1);
  const reason = entryDecisionRefusal(entry, span, scope, contract, ids);
  return reason ? { reason } : null;
}
