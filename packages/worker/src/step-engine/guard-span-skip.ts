import { isDeepStrictEqual as same } from 'node:util';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { CLEAR_STEP_USAGE_STAMP, hasPgCode, lockStepRows, schema } from '@haive/database';
import { parseExecutionContract } from '@haive/shared/modularity';
import type { StepContext, StepDefinition } from '@haive/shared/step';
import {
  GuardDecisionError,
  decideLoadedGuardDecision,
  evaluateGuardDecision,
  prepareGuardDecision,
  validateGuardBounds,
  type GuardDecision,
} from './guard-decisions.js';

type StepRow = typeof schema.taskSteps.$inferSelect;
type Predicate = NonNullable<StepDefinition['guardPredicates']>[string];
type SkipInput = {
  ids: readonly string[];
  span: { firstStepId: string; lastStepId: string };
  decision: GuardDecision;
};
const pristine = (row: StepRow): boolean =>
  [
    'detectOutput',
    'formSchema',
    'formValues',
    'output',
    'summary',
    'applyReceipt',
    'mergeResolveState',
    'startedAt',
    'endedAt',
    'waitingStartedAt',
    'integrationWait',
    'aiFixContext',
    'errorMessage',
    'errorHint',
    'degradedNote',
  ].every((k) => row[k as keyof StepRow] == null) &&
  (row.iterations?.length ?? 0) === 0 &&
  (row.iterationCount ?? 0) === 0;

/** Pure validation on held rows. A skip receipt binds each non-entry member's own
 * generation to the stored entry decision, so an unrelated skip is never adopted. */
export function planGuardSkip(input: SkipInput, rows: readonly StepRow[]) {
  const { ids, span, decision } = input;
  if (decision.run) throw new GuardDecisionError('span-not-suppressed');
  const first = ids.indexOf(span.firstStepId);
  const last = ids.indexOf(span.lastStepId);
  if (first < 0 || last < first) throw new GuardDecisionError('invalid-span');
  const entry = rows.find((r) => r.stepId === span.firstStepId && r.round === decision.round);
  if (!entry) throw new GuardDecisionError('member-not-pristine');
  const receipt = (r: StepRow) =>
    r.id === entry.id
      ? decision
      : {
          version: 1,
          kind: 'guard-skip',
          taskId: decision.taskId,
          round: decision.round,
          spanId: decision.spanId,
          entryRowId: entry.id,
          entryGeneration: decision.generation,
          contractHash: decision.contractHash,
          generation: r.rerunGeneration,
        };
  const pending: StepRow[] = [];
  for (const id of ids.slice(first, last + 1)) {
    const row = rows.find((r) => r.stepId === id && r.round === decision.round);
    if (!row || row.taskId !== decision.taskId || !pristine(row))
      throw new GuardDecisionError('member-not-pristine');
    if (row.status === 'skipped' && same(row.guardState, receipt(row))) continue;
    if (
      row.status !== 'pending' ||
      (row.id === entry.id ? !same(row.guardState, decision) : row.guardState != null)
    )
      throw new GuardDecisionError('member-not-pristine');
    pending.push(row);
  }
  return { pending, receipt, nextStepId: ids[last + 1] ?? null };
}

/** DORMANT: no production caller. All members must already exist; never create
 * rows after the lock batch. Atomic across the entire span, with no output,
 * recap, event, task pointer or queue write. The existing finished-row handoff
 * protocol can recover a lost enqueue from the unchanged entry pointer. */
export async function skipGuardSpan(
  ctx: StepContext,
  spanId: string,
  predicates: ReadonlyMap<string, Predicate>,
  limits: Parameters<typeof validateGuardBounds>[0] = {},
): Promise<{ nextStepId: string | null } | null> {
  const initial = await ctx.db.query.tasks.findFirst({ where: eq(schema.tasks.id, ctx.taskId) });
  if (!initial) throw new GuardDecisionError('task-unavailable');
  if (initial.executionContract == null) return null;
  const contract = parseExecutionContract(initial.executionContract);
  if (!contract.guardedSpans.length && !contract.fixTarget) return null;
  if (ctx.epoch == null || ctx.rerunGeneration == null)
    throw new GuardDecisionError('missing-fence');
  const bounds = validateGuardBounds(limits);
  ctx.throwIfCancelled();
  return ctx.db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${bounds.statementTimeoutMs}ms'`));
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${bounds.lockTimeoutMs}ms'`));
    const held = await lockStepRows(tx, eq(schema.taskSteps.taskId, ctx.taskId));
    const [task] = await tx
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, ctx.taskId))
      .for('share');
    const prepared = prepareGuardDecision(ctx, task, spanId, predicates);
    const rows = held.length
      ? await tx
          .select()
          .from(schema.taskSteps)
          .where(
            inArray(
              schema.taskSteps.id,
              held.map((r) => r.id),
            ),
          )
      : [];
    if (rows.find((r) => r.id === ctx.taskStepId)?.guardState == null)
      throw new GuardDecisionError('missing-decision');
    // Only the replay branch is permitted: this writer never evaluates a predicate.
    const { decision } = await decideLoadedGuardDecision(
      ctx,
      prepared,
      rows,
      predicates,
      tx as unknown as StepContext['db'],
      bounds,
    );
    const plan = planGuardSkip({ ...prepared, decision }, rows);
    // A pending member with agent work is not pristine, even before it wrote step output.
    const memberIds = rows
      .filter(
        (r) =>
          prepared.ids
            .slice(
              prepared.ids.indexOf(prepared.span.firstStepId),
              prepared.ids.indexOf(prepared.span.lastStepId) + 1,
            )
            .includes(r.stepId) && r.round === ctx.round,
      )
      .map((r) => r.id);
    if (memberIds.length) {
      const [run] = await tx
        .select({ id: schema.cliInvocations.id })
        .from(schema.cliInvocations)
        .where(
          and(
            or(
              inArray(schema.cliInvocations.taskStepId, memberIds),
              inArray(schema.cliInvocations.summaryForStepId, memberIds),
            ),
            isNull(schema.cliInvocations.supersededAt),
          ),
        )
        .limit(1);
      const [agent] = await tx
        .select({ id: schema.taskStepAgentMinings.id })
        .from(schema.taskStepAgentMinings)
        .where(inArray(schema.taskStepAgentMinings.taskStepId, memberIds))
        .limit(1);
      if (run || agent) throw new GuardDecisionError('member-not-pristine');
    }
    ctx.throwIfCancelled();
    for (const row of plan.pending) {
      const written = await tx
        .update(schema.taskSteps)
        .set({ status: 'skipped', guardState: plan.receipt(row), ...CLEAR_STEP_USAGE_STAMP })
        .where(
          and(
            eq(schema.taskSteps.id, row.id),
            eq(schema.taskSteps.status, 'pending'),
            eq(schema.taskSteps.rerunGeneration, row.rerunGeneration),
          ),
        )
        .returning({ id: schema.taskSteps.id });
      if (written.length !== 1) throw new GuardDecisionError('skip-write-lost');
    }
    return { nextStepId: plan.nextStepId };
  });
}

export const isRetryableGuardError = (err: unknown): boolean =>
  err instanceof GuardDecisionError || hasPgCode(err, '55P03') || hasPgCode(err, '57014');

/** Unwired caller seam. A failed handoff propagates so the owner retries; a crash
 * before/after enqueue replays committed skips without predicate or step work.
 * `handoff` must implement the normal epoch/pointer-fenced finished-row handoff. */
export async function advanceGuardSpan(
  ctx: StepContext,
  spanId: string,
  predicates: ReadonlyMap<string, Predicate>,
  handoff: (nextStepId: string | null) => Promise<void>,
): Promise<{ kind: 'ordinary' | 'run' | 'skipped' | 'retry' }> {
  let skipped: Awaited<ReturnType<typeof skipGuardSpan>>;
  try {
    const decision = await evaluateGuardDecision(ctx, spanId, predicates);
    if (!decision) return { kind: 'ordinary' };
    if (decision.run) return { kind: 'run' };
    skipped = await skipGuardSpan(ctx, spanId, predicates);
  } catch (err) {
    if (isRetryableGuardError(err)) return { kind: 'retry' };
    throw err;
  }
  if (!skipped) return { kind: 'ordinary' };
  await handoff(skipped.nextStepId);
  return { kind: 'skipped' };
}
