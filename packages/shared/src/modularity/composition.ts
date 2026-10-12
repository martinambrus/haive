import type { ComposableStepEntry } from './contracts.js';

export type CompositionIssue =
  | { kind: 'unknown-step'; index: number; stepId: string }
  | { kind: 'unmet-need'; index: number; stepId: string; needs: string; reason: string }
  | { kind: 'missing-loop-target'; index: number; stepId: string; target: string }
  | { kind: 'duplicate-step'; index: number; stepId: string }
  | { kind: 'empty' };

export function validateComposition(
  stepIds: readonly string[],
  catalog: ReadonlyMap<string, ComposableStepEntry>,
): CompositionIssue[] {
  if (stepIds.length === 0) return [{ kind: 'empty' }];
  const issues: CompositionIssue[] = [];
  const provided = new Set<string>();
  const seen = new Set<string>();
  stepIds.forEach((stepId, index) => {
    if (seen.has(stepId)) issues.push({ kind: 'duplicate-step', index, stepId });
    seen.add(stepId);
    const entry = catalog.get(stepId);
    if (!entry) {
      issues.push({ kind: 'unknown-step', index, stepId });
      return;
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
    for (const token of entry.provides) provided.add(token);
  });
  return issues;
}
