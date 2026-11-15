import type { PublicTaskType } from '@haive/shared/modularity';

export type DerivedWarningSummary = NonNullable<PublicTaskType['warnings']>[number];
export type DerivedTaskWarning =
  DerivedWarningSummary | { kind: string; stepId: string; field?: string };

export function describeDerivedWarning(warning: DerivedTaskWarning): string {
  if ('operationIndex' in warning) {
    const paths = warning.candidates.map((path) => path ?? 'pre-triage').join(', ');
    return `Change ${warning.operationIndex + 1}, ${warning.stepId}: ${warning.kind === 'stale-target' ? 'Base no longer includes this step; this change will be skipped.' : 'Replacement skipped on this path.'} Paths: ${paths}.`;
  }
  return `The saved default for ${warning.stepId} (${warning.field ?? 'loop limit'}) is obsolete and was omitted from this task.`;
}

export function describeDerivedProblem(issue: { kind: string; [key: string]: unknown }): string {
  const context = [
    typeof issue.operationIndex === 'number' ? `Change ${issue.operationIndex + 1}` : null,
    'executionPath' in issue ? (issue.executionPath ?? 'pre-triage') : null,
    typeof issue.stepId === 'string' ? issue.stepId : null,
  ]
    .filter(Boolean)
    .join(', ');
  const messages: Record<string, string> = {
    'invalid-derived-changes':
      'Complete every change with valid step IDs (up to 128 characters), with at most 64 changes.',
    'replacement-contract-unavailable': 'The role has no available host output contract.',
    'replacement-target-forbidden':
      'Only code review and broad code audit can be replaced. Implementation, gates and the triage prefix are protected replacement targets.',
    'replacement-not-composable': 'This installed step has no composable declaration.',
    'invalid-derived-run-plan':
      'These changes cannot be replayed as a pinned run plan. Keep replacement steps, or remove the original role directly.',
    'replacement-not-declared':
      'This step does not declare this role in its replacement capabilities.',
    'replacement-contract-mismatch':
      'This step must declare the exact host contract and version for this role.',
    'replacement-policy-incompatible': 'This step must preserve the role tokens and host policy.',
    'replacement-role-ambiguous':
      'Each role must have a unique producer; remove the competing step.',
    'target-removed-by-change':
      'An earlier change consumed this target. Use the explicit new step as the anchor.',
    'missing-installed-step': 'This step is not installed.',
    'protected-prefix-edit': 'The model health, base sync and triage prefix must stay unchanged.',
    'duplicate-resulting-id': 'This path would contain the same step twice.',
    'default-key-not-in-steps': 'This default names a step outside the resulting paths.',
    'loop-limit-not-editable': 'This step does not have an editable loop limit.',
    'invalid-loop-limit': 'A loop limit must be an integer from 1 to 50.',
    'catalog-not-synced': 'The step catalog has not been synced yet.',
    'base-lists-unavailable': 'The ordered base paths are unavailable.',
    'ineligible-derived-base': 'This base cannot be customized.',
  };
  const ref = (value: unknown) => {
    if (value && typeof value === 'object' && 'id' in value && 'version' in value)
      return `${String(value.id)}@${String(value.version)}`;
    return 'none';
  };
  const contracts =
    'expectedContract' in issue || 'actualContract' in issue
      ? ` Target: ${String(issue.target ?? issue.stepId ?? '')}. New step: ${String(issue.payload ?? '')}. Expected: ${ref(issue.expectedContract)}. Actual: ${ref(issue.actualContract)}.`
      : '';
  return `${context ? `${context}: ` : ''}${messages[issue.kind] ?? 'This path needs attention.'}${contracts} (${issue.kind})`;
}
