import {
  ExecutionContractError,
  FIX_LOOP_TARGET_STEP_ID,
  executionContractPaths,
  parseExecutionContract,
  type ExecutionPredicateDeclaration,
} from './execution-contract.js';
import {
  REPOSITORY_TOKEN,
  IMPLICIT_COMPOSITION_TOKENS,
  type ComposableStepEntry,
} from './contracts.js';

export type CompositionIssue =
  | { kind: 'unknown-step'; index: number; stepId: string }
  | { kind: 'unmet-need'; index: number; stepId: string; needs: string; reason: string }
  | {
      kind: 'need-out-of-order';
      index: number;
      stepId: string;
      needs: string;
      after: string;
      reason: string;
    }
  | { kind: 'too-late'; index: number; stepId: string; token: string }
  | { kind: 'unfulfilled'; index: number; stepId: string; token: string }
  | { kind: 'missing-loop-target'; index: number; stepId: string; target: string }
  | { kind: 'duplicate-step'; index: number; stepId: string }
  | { kind: 'loop-after-closing'; index: number; stepId: string; closingStepId: string }
  | { kind: 'empty' };

export type ExecutionCompositionIssue =
  CompositionIssue | { kind: 'invalid-execution-contract'; reason: string };
type ExecutionCompositionOptions = {
  requiresRepository?: boolean;
  executionContract?: unknown;
  predicates?: ReadonlyMap<string, ExecutionPredicateDeclaration>;
  maxPredicates?: number;
};

export function validateComposition(
  stepIds: readonly string[],
  catalog: ReadonlyMap<string, ComposableStepEntry>,
  opts: ExecutionCompositionOptions & { executionContract: unknown },
): ExecutionCompositionIssue[];
export function validateComposition(
  stepIds: readonly string[],
  catalog: ReadonlyMap<string, ComposableStepEntry>,
  opts?: { requiresRepository?: boolean },
): CompositionIssue[];
export function validateComposition(
  stepIds: readonly string[],
  catalog: ReadonlyMap<string, ComposableStepEntry>,
  opts: ExecutionCompositionOptions = {},
): ExecutionCompositionIssue[] {
  if (stepIds.length === 0) return [{ kind: 'empty' }];
  if (opts.executionContract != null) {
    try {
      const contract = parseExecutionContract(opts.executionContract);
      const paths = executionContractPaths(
        stepIds,
        catalog,
        contract,
        opts.predicates ?? new Map(),
        opts.maxPredicates,
      );
      const effective = contract.fixTarget
        ? new Map(
            [...catalog].map(([id, entry]) => [
              id,
              entry.loopTargetStepId === FIX_LOOP_TARGET_STEP_ID
                ? { ...entry, loopTargetStepId: contract.fixTarget!.stepId }
                : entry,
            ]),
          )
        : catalog;
      const all: CompositionIssue[] = [];
      // Even mutually excluded duplicate ids would make the persisted run list ambiguous.
      stepIds.forEach((stepId, index) => {
        if (stepIds.indexOf(stepId) !== index) all.push({ kind: 'duplicate-step', stepId, index });
      });
      for (const path of paths) {
        for (const issue of validateComposition(path, effective, {
          requiresRepository: opts.requiresRepository,
        })) {
          all.push('index' in issue ? { ...issue, index: stepIds.indexOf(issue.stepId) } : issue);
        }
      }
      return [...new Map(all.map((issue) => [JSON.stringify(issue), issue])).values()];
    } catch (error) {
      if (!(error instanceof ExecutionContractError)) throw error;
      return [{ kind: 'invalid-execution-contract', reason: error.message }];
    }
  }
  const issues: CompositionIssue[] = [];
  const initial = opts.requiresRepository === false ? [] : [REPOSITORY_TOKEN];
  const provided = new Map<string, number>(initial.map((token) => [token, -1]));
  const everProvided = new Set<string>(initial);
  const seen = new Map<string, number>();
  let closing: { stepId: string; index: number } | undefined;
  const entailed: { index: number; stepId: string; token: string }[] = [];
  stepIds.forEach((stepId, index) => {
    if (seen.has(stepId)) issues.push({ kind: 'duplicate-step', index, stepId });
    if (!seen.has(stepId)) seen.set(stepId, index);
    const entry = catalog.get(stepId);
    if (!entry) {
      issues.push({ kind: 'unknown-step', index, stepId });
      return;
    }
    for (const token of entry.entails ?? []) entailed.push({ index, stepId, token });
    for (const rule of entry.entailsWhen ?? []) {
      if (!everProvided.has(rule.provided)) continue;
      for (const token of rule.entails) entailed.push({ index, stepId, token });
    }
    for (const token of entry.precedes ?? []) {
      if (everProvided.has(token)) issues.push({ kind: 'too-late', index, stepId, token });
    }
    for (const { needs, reason, after } of entry.requires) {
      if (!provided.has(needs)) issues.push({ kind: 'unmet-need', index, stepId, needs, reason });
      if (after !== undefined) {
        const prerequisite = provided.get(after);
        const provider = provided.get(needs);
        if (prerequisite === undefined) {
          if (!entry.requires.some((r) => r.needs === after))
            issues.push({ kind: 'unmet-need', index, stepId, needs: after, reason });
        } else if (provider !== undefined && provider <= prerequisite) {
          issues.push({ kind: 'need-out-of-order', index, stepId, needs, after, reason });
        }
      }
    }
    const loopTarget =
      entry.loopTargetWhenPresent && !stepIds.includes(entry.loopTargetStepId!)
        ? undefined
        : entry.loopTargetStepId;
    if (loopTarget !== undefined && !seen.has(loopTarget)) {
      issues.push({
        kind: 'missing-loop-target',
        index,
        stepId,
        target: loopTarget,
      });
    }
    if (entry.closes && !entry.loopBeforeClose) closing = { stepId, index };
    const targetIndex = loopTarget === undefined ? undefined : (seen.get(loopTarget) ?? -1);
    if (targetIndex !== undefined && closing !== undefined && targetIndex < closing.index) {
      issues.push({ kind: 'loop-after-closing', index, stepId, closingStepId: closing.stepId });
    }
    // A closing gate may branch back before performing its closing action. Later
    // steps must still never loop across a gate that has already closed.
    if (entry.closes) closing = { stepId, index };
    for (const token of entry.provides) {
      if (IMPLICIT_COMPOSITION_TOKENS.has(token)) continue;
      provided.set(token, index);
      everProvided.add(token);
    }
    for (const token of entry.removes ?? []) provided.delete(token);
  });
  for (const { index, stepId, token } of entailed) {
    const later = stepIds.slice(index + 1).some((id) => catalog.get(id)?.provides.includes(token));
    if (!later) issues.push({ kind: 'unfulfilled', index, stepId, token });
  }
  return issues;
}
