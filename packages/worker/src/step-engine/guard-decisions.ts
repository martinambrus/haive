import { createHash } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { lockStepRows, schema } from '@haive/database';
import {
  executionContractPaths,
  parseExecutionContract,
  type ExecutionContract,
} from '@haive/shared/modularity';
import { TaskCancelledError, type StepContext, type StepDefinition } from '@haive/shared/step';
import { z } from 'zod';
import { FIX_LOOP_REQUESTED } from './steps/workflow/_fix-loop.js';

const generation = z.number().int().nonnegative();
const reference = z.strictObject({
  stepRowId: z.uuid(),
  spanId: z.string().min(1).max(128),
  generation,
});
const boundary = z.strictObject({
  stepRowId: z.uuid(),
  stepId: z.string().min(1).max(128),
  round: generation,
  generation,
});
const decisionSchema = z.strictObject({
  version: z.literal(1),
  taskId: z.uuid(),
  round: generation,
  spanId: z.string().min(1).max(128),
  generation,
  contractHash: z.string().regex(/^[a-f0-9]{64}$/),
  boundary: boundary.nullable(),
  predicate: z
    .strictObject({ id: z.string().min(1).max(128), result: z.boolean(), source: reference })
    .nullable(),
  required: reference.nullable(),
  run: z.boolean(),
});
export type GuardDecision = z.infer<typeof decisionSchema>;
type Predicate = NonNullable<StepDefinition['guardPredicates']>[string];
type TaskRow = typeof schema.tasks.$inferSelect;
type StepRow = typeof schema.taskSteps.$inferSelect;
type Span = ExecutionContract['guardedSpans'][number];

/** A protocol refusal; only explicitly transient reasons may retry. Never expose a predicate's error text or substitute false. */
export class GuardDecisionError extends Error {
  readonly code = 'guard-decision-invalid';
  constructor(
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(`guard-decision-invalid: ${reason}`, options);
    this.name = 'GuardDecisionError';
  }
}
export function parseGuardDecision(raw: unknown): GuardDecision {
  const parsed = decisionSchema.safeParse(raw);
  if (!parsed.success) throw new GuardDecisionError('malformed-state');
  return parsed.data;
}
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
const ref = (row: StepRow | undefined, span: Span) => {
  if (!row) throw new GuardDecisionError('shared-decision-unavailable');
  return { stepRowId: row.id, spanId: span.id, generation: row.rerunGeneration };
};
const producerRef = (row: StepRow) => ({
  stepRowId: row.id,
  stepId: row.stepId,
  round: row.round,
  generation: row.rerunGeneration,
});
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/** Server deadlines bound SQL (including rollback queued behind a query); the JS
 * deadline also covers a predicate that never issues or finishes a database query. */
export const GUARD_DECISION_BOUNDS = {
  statementTimeoutMs: 5_000,
  lockTimeoutMs: 1_000,
  predicateTimeoutMs: 5_000,
} as const;
type Bounds = { [K in keyof typeof GUARD_DECISION_BOUNDS]: number };
export function validateGuardBounds(limits: Partial<Bounds> = {}): Bounds {
  const bounds = { ...GUARD_DECISION_BOUNDS, ...limits };
  for (const ms of Object.values(bounds))
    if (!Number.isSafeInteger(ms) || ms <= 0 || ms > 2_147_483_647)
      throw new GuardDecisionError('invalid-deadline');
  return bounds;
}
const unavailable = (): never => {
  throw new Error('guard predicate capability unavailable');
};

/** Canonical identity of the pinned list and contract, independent of object key order. */
export function guardContractHash(ids: readonly string[], contract: ExecutionContract): string {
  return createHash('sha256').update(canonical({ ids, contract })).digest('hex');
}

/** Validate the locked task and declarations without reading or writing a store. */
export function prepareGuardDecision(
  ctx: StepContext,
  task: TaskRow | undefined,
  spanId: string,
  predicates: ReadonlyMap<string, Predicate>,
) {
  if (
    !task ||
    task.userId !== ctx.userId ||
    task.status !== 'running' ||
    task.deadAt != null ||
    task.orchestrationEpoch !== ctx.epoch ||
    task.currentRound !== ctx.round
  )
    throw new GuardDecisionError('task-fence-lost');
  const contract = parseExecutionContract(task.executionContract);
  const ids = task.runListSnapshot;
  if (!ids || new Set(ids).size !== ids.length)
    throw new GuardDecisionError('missing-run-list-pin');
  // Validate guard declarations without inventing a capability catalog. Admission
  // and the fix router own target capability checks.
  executionContractPaths(ids, new Map(), { ...contract, fixTarget: undefined }, predicates);
  const spans = [...contract.guardedSpans].sort(
    (a, b) => ids.indexOf(a.firstStepId) - ids.indexOf(b.firstStepId),
  );
  const span = spans.find((s) => s.id === spanId);
  if (!span) throw new GuardDecisionError('unknown-span');
  const hash = guardContractHash(ids, contract);
  return {
    task,
    ids,
    spans,
    span,
    hash,
    fixTarget: contract.fixTarget,
  };
}

/** The predicate receives only structural identity and the supplied transaction capability. */
export function buildGuardPredicateContext(
  ctx: StepContext,
  tx: StepContext['db'],
  task: TaskRow,
  producer: StepRow,
  signal: AbortSignal,
): StepContext {
  return Object.defineProperties(
    {
      taskId: task.id,
      taskStepId: producer.id,
      userId: task.userId,
      round: producer.round,
      rerunGeneration: producer.rerunGeneration,
      db: tx as unknown as StepContext['db'],
      logger: ctx.logger,
      signal,
      throwIfCancelled() {
        ctx.throwIfCancelled();
        signal.throwIfAborted();
      },
    },
    {
      repoPath: { get: unavailable },
      workspacePath: { get: unavailable },
      sandboxWorkdir: { get: unavailable },
      emitProgress: { value: async () => unavailable() },
    },
  ) as unknown as StepContext;
}

/** Decide from already-loaded held rows with the supplied predicate capability.
 * Persistence and SQL locking remain in evaluateGuardDecision. */
export async function decideLoadedGuardDecision(
  ctx: StepContext,
  prepared: ReturnType<typeof prepareGuardDecision>,
  rows: readonly StepRow[],
  predicates: ReadonlyMap<string, Predicate>,
  tx: StepContext['db'],
  bounds: Bounds,
): Promise<{ decision: GuardDecision; entry: StepRow; replay: boolean }> {
  const { task, ids, spans, span, hash, fixTarget } = prepared;
  // The same structural event as isFixRound, loaded once under the held transaction.
  const fixRounds = new Set(
    fixTarget && ctx.round > 0
      ? (
          await tx
            .select({ payload: schema.taskEvents.payload })
            .from(schema.taskEvents)
            .where(
              and(
                eq(schema.taskEvents.taskId, ctx.taskId),
                eq(schema.taskEvents.eventType, FIX_LOOP_REQUESTED),
              ),
            )
        ).map((r) => (r.payload as { round?: number } | null)?.round)
      : [],
  );
  const reuseEarlierDecision = fixRounds.has(ctx.round);
  let decisionRound = ctx.round;
  if (reuseEarlierDecision) {
    // A revise round may have changed the branch, or reached it for the first time.
    // Only this span needs a baseline; its references name its dependencies.
    // Fix receipts are never baselines.
    decisionRound = -1;
    for (let round = ctx.round - 1; round >= 0; round--) {
      if (round > 0 && fixRounds.has(round)) continue;
      if (
        rows.some((r) => r.stepId === span.firstStepId && r.round === round && r.guardState != null)
      ) {
        decisionRound = round;
        break;
      }
    }
  }
  const spanId = span.id;
  const entry = (s: Span) =>
    rows.find((r) => r.stepId === s.firstStepId && r.round === decisionRound);
  const current = rows.find((r) => r.stepId === span.firstStepId && r.round === ctx.round);
  if (
    !current ||
    current.id !== ctx.taskStepId ||
    (current.status !== 'pending' &&
      !(current.status === 'skipped' && current.guardState != null)) ||
    current.rerunGeneration !== ctx.rerunGeneration ||
    task.currentStepId !== span.firstStepId
  )
    throw new GuardDecisionError('entry-fence-lost');
  const predecessor = (s: Span, round = decisionRound) => {
    const id = ids[ids.indexOf(s.firstStepId) - 1];
    const row = rows
      .filter((r) => r.stepId === id && r.round <= round)
      .sort((a, b) => b.round - a.round)[0];
    if (!row || row.status !== 'done') throw new GuardDecisionError('producer-not-settled');
    return row;
  };
  const referencedEntry = (s: Span, savedRef: GuardDecision['required'], round: number) =>
    reuseEarlierDecision
      ? rows.find((r) => r.id === savedRef?.stepRowId && r.round === round)
      : entry(s);
  const loaded = new Map<string, GuardDecision>();
  const read = (s: Span, row: StepRow | undefined): GuardDecision => {
    if (!row || row.guardState == null) throw new GuardDecisionError('shared-decision-unavailable');
    if (row.taskId !== task.id || row.stepId !== s.firstStepId)
      throw new GuardDecisionError('stale-decision');
    const known = loaded.get(row.id);
    if (known) return known;
    const saved = parseGuardDecision(row.guardState);
    if (
      saved.taskId !== task.id ||
      saved.round !== row.round ||
      saved.spanId !== s.id ||
      saved.generation !== row.rerunGeneration ||
      saved.contractHash !== hash
    )
      throw new GuardDecisionError('stale-decision');
    const requiredSpan =
      s.requiresSpan === undefined ? undefined : spans.find((p) => p.id === s.requiresSpan)!;
    const requiredRow = requiredSpan
      ? referencedEntry(requiredSpan, saved.required, row.round)
      : undefined;
    const required = requiredSpan ? read(requiredSpan, requiredRow) : null;
    if (!same(saved.required, requiredSpan ? ref(requiredRow, requiredSpan) : null))
      throw new GuardDecisionError('stale-required-decision');
    if (required?.run === false) {
      if (saved.run || saved.predicate !== null || saved.boundary !== null)
        throw new GuardDecisionError('invalid-dependent-decision');
    } else {
      if (
        !saved.predicate ||
        saved.predicate.id !== s.predicateId ||
        saved.run !== (saved.predicate.result === (s.when ?? true))
      )
        throw new GuardDecisionError('invalid-predicate-decision');
      const sourceSpan = spans.find((p) => p.id === saved.predicate!.source.spanId);
      const sourceRow =
        sourceSpan?.id === s.id
          ? row
          : sourceSpan
            ? referencedEntry(sourceSpan, saved.predicate.source, row.round)
            : undefined;
      if (
        !sourceSpan ||
        sourceSpan.predicateId !== s.predicateId ||
        ids.indexOf(sourceSpan.firstStepId) > ids.indexOf(s.firstStepId) ||
        !same(saved.predicate.source, ref(sourceRow, sourceSpan))
      )
        throw new GuardDecisionError('stale-predicate-source');
      if (sourceSpan.id === s.id) {
        if (!same(saved.boundary, producerRef(predecessor(s, row.round))))
          throw new GuardDecisionError('stale-producer');
      } else {
        const source = read(sourceSpan, sourceRow);
        if (!same(saved.predicate, source.predicate) || !same(saved.boundary, source.boundary))
          throw new GuardDecisionError('shared-result-mismatch');
      }
    }
    loaded.set(row.id, saved);
    return saved;
  };
  if (reuseEarlierDecision) {
    let original: GuardDecision;
    try {
      // The latest earlier non-fix decision's generation and references remain
      // authoritative; a fix cannot reinterpret its branch against the changed tree.
      original = read(span, entry(span));
    } catch (err) {
      if (!(err instanceof GuardDecisionError)) throw err;
      throw new GuardDecisionError('fix-round-decision-unavailable', { cause: err });
    }
    if (
      !original.run &&
      fixTarget &&
      ids
        .slice(ids.indexOf(span.firstStepId), ids.indexOf(span.lastStepId) + 1)
        .includes(fixTarget.stepId)
    )
      throw new GuardDecisionError('fix-target-suppressed');
    // Keep a current-round receipt for the existing skip/reopen protocols, while
    // retaining the baseline source, dependency and predecessor references.
    const decision = { ...original, round: ctx.round, generation: current.rerunGeneration };
    if (current.guardState != null && !same(parseGuardDecision(current.guardState), decision))
      throw new GuardDecisionError('stale-decision');
    if (current.status === 'skipped' && decision.run)
      throw new GuardDecisionError('entry-fence-lost');
    return { decision, entry: current, replay: current.guardState != null };
  }
  if (current.guardState != null) {
    const decision = read(span, entry(span));
    if (current.status === 'skipped' && decision.run)
      throw new GuardDecisionError('entry-fence-lost');
    return { decision, entry: current, replay: true };
  }
  const requiredSpan =
    span.requiresSpan === undefined ? undefined : spans.find((s) => s.id === span.requiresSpan)!;
  const required = requiredSpan ? read(requiredSpan, entry(requiredSpan)) : null;
  let predicate: GuardDecision['predicate'] = null;
  let settled: GuardDecision['boundary'] = null;
  if (required?.run !== false) {
    // A dependency-suppressed earlier span has no predicate result to reuse.
    const earlier = spans
      .slice(0, spans.indexOf(span))
      .filter((s) => s.predicateId === span.predicateId)
      .map((s) => read(s, entry(s)));
    const shared = earlier.find((d) => d.predicate !== null);
    if (shared) {
      predicate = shared.predicate;
      settled = shared.boundary;
    } else {
      const producer = predecessor(span);
      let result: unknown;
      const lifetime = new AbortController();
      const signal = AbortSignal.any([ctx.signal, lifetime.signal]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Do not spread the runner context: its paths are agent-writable and its
        // progress closure uses the pool, self-waiting on this transaction's locks.
        const context = buildGuardPredicateContext(ctx, tx, task, producer, signal);
        const deadline = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            const err = new Error('guard predicate deadline exceeded');
            lifetime.abort(err);
            reject(err);
          }, bounds.predicateTimeoutMs);
        });
        result = await Promise.race([
          predicates.get(span.predicateId)!.evaluate(context, structuredClone(span.args)),
          deadline,
        ]);
      } catch (err) {
        if (err instanceof TaskCancelledError) throw err;
        ctx.logger.warn({ err, taskId: task.id, spanId }, 'guard predicate evaluation failed');
        throw new GuardDecisionError('predicate-evaluation-failed', { cause: err });
      } finally {
        clearTimeout(timer);
        lifetime.abort();
      }
      if (typeof result !== 'boolean') {
        const err = new GuardDecisionError('predicate-non-boolean');
        ctx.logger.warn({ err, taskId: task.id, spanId }, 'guard predicate evaluation failed');
        throw err;
      }
      predicate = { id: span.predicateId, result, source: ref(current, span) };
      settled = producerRef(producer);
    }
  }
  ctx.throwIfCancelled();
  const decision: GuardDecision = {
    version: 1,
    taskId: task.id,
    round: ctx.round,
    spanId,
    generation: current.rerunGeneration,
    contractHash: hash,
    boundary: settled,
    predicate,
    required: requiredSpan ? ref(entry(requiredSpan)!, requiredSpan) : null,
    run: required?.run !== false && predicate!.result === (span.when ?? true),
  };
  return { decision, entry: current, replay: false };
}

/** Decides a guarded span at its ENTRY, before any admission or step work. Called from the
 * span-entry hook in guard-entry.ts. The caller must already
 * have its pending entry row and an epoch/generation. This only writes guard_state;
 * it neither skips a member nor moves a pointer, records output/recaps or queues work.
 *
 * All extant step rows are held in the reset protocol's id order, then the task fence.
 * Trusted predicates do bounded, read-only structural queries through the supplied
 * transaction. Their context identifies the settled predecessor (including its exact
 * taskStepId, round and generation), so task-only DAG lookups are unnecessary. They
 * must throw for absent/unreadable producer data. There is no false-on-error path.
 *
 * A failed transaction may evaluate again; only committed decisions are exactly once.
 * Recovery epochs reuse them; explicit resets invalidate forward decisions.
 * Stored suppressed decisions also replay on their skipped entry. Stale states fail closed.
 */
export async function evaluateGuardDecision(
  ctx: StepContext,
  spanId: string,
  predicates: ReadonlyMap<string, Predicate>,
  limits: Partial<Bounds> = {},
): Promise<GuardDecision | null> {
  const initial = await ctx.db.query.tasks.findFirst({ where: eq(schema.tasks.id, ctx.taskId) });
  if (!initial) throw new GuardDecisionError('task-unavailable');
  if (initial.executionContract == null) return null;
  const initialContract = parseExecutionContract(initial.executionContract);
  if (!initialContract.guardedSpans.length) return null;
  if (ctx.epoch == null || ctx.rerunGeneration == null)
    throw new GuardDecisionError('missing-fence');
  ctx.throwIfCancelled();
  const bounds = validateGuardBounds(limits);
  return ctx.db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${bounds.statementTimeoutMs}ms'`));
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${bounds.lockTimeoutMs}ms'`));
    // Never wait for or update an unheld step after taking the task lock.
    const held = await lockStepRows(tx, eq(schema.taskSteps.taskId, ctx.taskId));
    const [task] = await tx
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, ctx.taskId))
      .for('share');
    const prepared = prepareGuardDecision(ctx, task, spanId, predicates);
    const rows = (
      await tx.select().from(schema.taskSteps).where(eq(schema.taskSteps.taskId, ctx.taskId))
    ).filter((r) => held.some((h) => h.id === r.id));
    const {
      decision,
      entry: current,
      replay,
    } = await decideLoadedGuardDecision(
      ctx,
      prepared,
      rows,
      predicates,
      tx as unknown as StepContext['db'],
      bounds,
    );
    // A replay does not issue an UPDATE.
    if (replay) return decision;
    const written = await tx
      .update(schema.taskSteps)
      .set({ guardState: decision })
      .where(and(eq(schema.taskSteps.id, current.id), isNull(schema.taskSteps.guardState)))
      .returning({ id: schema.taskSteps.id });
    if (written.length !== 1) throw new GuardDecisionError('decision-write-lost');
    return decision;
  });
}
