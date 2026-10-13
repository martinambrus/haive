import type { ComposableStepEntry } from './contracts.js';

export type CompositionIssue =
  | { kind: 'unknown-step'; index: number; stepId: string }
  | { kind: 'unmet-need'; index: number; stepId: string; needs: string; reason: string }
  | { kind: 'too-late'; index: number; stepId: string; token: string }
  | { kind: 'unfulfilled'; index: number; stepId: string; token: string }
  | { kind: 'missing-loop-target'; index: number; stepId: string; target: string }
  | { kind: 'duplicate-step'; index: number; stepId: string }
  | { kind: 'loop-after-closing'; index: number; stepId: string; closingStepId: string }
  | { kind: 'empty' };

export const REPOSITORY_TOKEN = 'repository';

/** Tokens no catalog entry provides: the composition starts with them. */
export const IMPLICIT_COMPOSITION_TOKENS: ReadonlySet<string> = new Set([REPOSITORY_TOKEN]);

export function validateComposition(
  stepIds: readonly string[],
  catalog: ReadonlyMap<string, ComposableStepEntry>,
  opts: { requiresRepository?: boolean } = {},
): CompositionIssue[] {
  if (stepIds.length === 0) return [{ kind: 'empty' }];
  const issues: CompositionIssue[] = [];
  const initial = opts.requiresRepository === false ? [] : [REPOSITORY_TOKEN];
  const provided = new Set<string>(initial);
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
    for (const { needs, reason } of entry.requires) {
      if (!provided.has(needs)) issues.push({ kind: 'unmet-need', index, stepId, needs, reason });
    }
    if (entry.loopTargetStepId !== undefined && !seen.has(entry.loopTargetStepId)) {
      issues.push({
        kind: 'missing-loop-target',
        index,
        stepId,
        target: entry.loopTargetStepId,
      });
    }
    if (entry.closes) closing = { stepId, index };
    const targetIndex =
      entry.loopTargetStepId === undefined ? undefined : (seen.get(entry.loopTargetStepId) ?? -1);
    if (targetIndex !== undefined && closing !== undefined && targetIndex < closing.index) {
      issues.push({ kind: 'loop-after-closing', index, stepId, closingStepId: closing.stepId });
    }
    for (const token of entry.provides) {
      provided.add(token);
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
