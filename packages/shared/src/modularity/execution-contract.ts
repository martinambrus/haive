import { z } from 'zod';
import { MODULE_ID_PATTERN_SOURCE } from './module-id.js';
import type { ComposableStepEntry } from './contracts.js';

const id = z.string().min(1).max(128);
/** Bounds the exponential path walk. Repeated predicate ids consume only one decision. */
export const MAX_EXECUTION_PREDICATES = 8;
/** Canonical legacy fix consumer; planner and worker routing must agree. */
export const FIX_LOOP_TARGET_STEP_ID = '07-phase-2-implement';
export const fixConsumerSchema = z.strictObject({ version: z.literal(1) });
export type FixConsumer = z.infer<typeof fixConsumerSchema>;
const json = z.json();
export const executionContractSchema = z.strictObject({
  version: z.literal(1),
  guardedSpans: z
    .array(
      z.strictObject({
        id,
        firstStepId: id,
        lastStepId: id,
        predicateId: z
          .string()
          .max(128)
          .regex(new RegExp(`^module\\.${MODULE_ID_PATTERN_SOURCE}\\.[a-z0-9_-]+$`)),
        args: z.record(z.string(), json),
        /** Select the false branch of the same durable predicate decision. Omitted means true. */
        when: z.boolean().optional(),
        requiresSpan: id.optional(),
      }),
    )
    .max(32),
  fixTarget: z.strictObject({ stepId: id, capabilityVersion: z.literal(1) }).optional(),
});
export type ExecutionContract = z.infer<typeof executionContractSchema>;
/** Schemas and executable predicates are supplied by trusted module code, never storage. */
export interface ExecutionPredicateDeclaration {
  argsSchema: { safeParse(value: unknown): { success: boolean } };
}
export class ExecutionContractError extends Error {
  readonly code = 'invalid-execution-contract';
  constructor(reason: string) {
    super(`invalid-execution-contract: ${reason}`);
    this.name = 'ExecutionContractError';
  }
}
export function parseExecutionContract(raw: unknown): ExecutionContract {
  const parsed = executionContractSchema.safeParse(raw);
  if (!parsed.success) throw new ExecutionContractError('malformed contract');
  return parsed.data;
}
/** P6 admission fence. Empty declarations are inert; malformed pins never fall back. */
export function assertExecutionContractSupported(raw: unknown): void {
  if (raw == null) return;
  const contract = parseExecutionContract(raw);
  if (contract.guardedSpans.length || contract.fixTarget) {
    throw new ExecutionContractError(
      'guarded spans or custom fix target not yet supported by this worker',
    );
  }
}
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );

/** Enumerates feasible paths only. The returned ids are validation projections, never task snapshots. */
export function executionContractPaths(
  stepIds: readonly string[],
  catalog: ReadonlyMap<string, ComposableStepEntry>,
  contract: ExecutionContract,
  predicates: ReadonlyMap<string, ExecutionPredicateDeclaration>,
  maxPredicates = MAX_EXECUTION_PREDICATES,
): string[][] {
  const spans = contract.guardedSpans.map((span) => ({
    ...span,
    first: stepIds.indexOf(span.firstStepId),
    last: stepIds.indexOf(span.lastStepId),
  }));
  const byId = new Map(spans.map((span) => [span.id, span]));
  if (byId.size !== spans.length) throw new ExecutionContractError('duplicate-span');
  const decisions = new Map<string, string>();
  for (const span of spans) {
    if (span.first < 0 || span.last < 0 || span.first > span.last)
      throw new ExecutionContractError(
        `span-endpoints ${span.id}: ${span.firstStepId}..${span.lastStepId}`,
      );
    const predicate = predicates.get(span.predicateId);
    if (!predicate) throw new ExecutionContractError(`unknown-predicate ${span.predicateId}`);
    if (!predicate.argsSchema.safeParse(span.args).success)
      throw new ExecutionContractError(`predicate-args ${span.predicateId}`);
    const args = canonical(span.args);
    if (decisions.has(span.predicateId) && decisions.get(span.predicateId) !== args)
      throw new ExecutionContractError(`predicate-args-disagree ${span.predicateId}`);
    decisions.set(span.predicateId, args);
    if (span.requiresSpan !== undefined) {
      const required = byId.get(span.requiresSpan);
      // Strictly earlier endpoints also exclude self references and every possible cycle.
      if (!required || required.last >= span.first)
        throw new ExecutionContractError(
          `requiresSpan ${span.id}: ${span.requiresSpan} must name an earlier span`,
        );
    }
  }
  spans.sort((a, b) => a.first - b.first);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i]!.first <= spans[i - 1]!.last)
      throw new ExecutionContractError(`overlapping-spans ${spans[i - 1]!.id} ${spans[i]!.id}`);
  }
  const target = contract.fixTarget;
  if (
    target &&
    (!stepIds.includes(target.stepId) ||
      target.stepId.startsWith('custom.') ||
      catalog.get(target.stepId)?.fixConsumer?.version !== target.capabilityVersion)
  )
    throw new ExecutionContractError(
      `fix-target ${target.stepId} is off-list or not capable at version ${target.capabilityVersion}`,
    );
  const ids = [...decisions.keys()];
  if (ids.length > maxPredicates)
    throw new ExecutionContractError('predicate-count exceeds admission limit');
  const paths = new Map<string, string[]>();
  for (let mask = 0; mask < 2 ** ids.length; mask++) {
    const enabled = new Map(ids.map((id, index) => [id, (mask & (1 << index)) !== 0]));
    const ran = new Map<string, boolean>();
    const skipped = new Set<number>();
    for (const span of spans) {
      const active =
        enabled.get(span.predicateId) === (span.when ?? true) &&
        (span.requiresSpan === undefined || ran.get(span.requiresSpan) === true);
      ran.set(span.id, active);
      if (!active) for (let index = span.first; index <= span.last; index++) skipped.add(index);
    }
    const path = stepIds.filter((_id, index) => !skipped.has(index));
    paths.set(JSON.stringify(path), path);
  }
  return [...paths.values()];
}
