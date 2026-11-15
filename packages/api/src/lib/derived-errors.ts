import { HttpError } from '../context.js';

/** Shared copy for static and derived composition refusals. */
export function insightRequirementMessage(issue: unknown): string | null {
  if (
    !issue ||
    typeof issue !== 'object' ||
    !('stepId' in issue) ||
    issue.stepId !== '08e-insights-triage' ||
    !('kind' in issue)
  )
    return null;
  if (
    issue.kind === 'missing-loop-target' ||
    (issue.kind === 'unmet-need' &&
      'needs' in issue &&
      (issue.needs === 'verification' || issue.needs === 'review'))
  )
    return '08e-insights-triage requires earlier 08-phase-5-verify and 08c-code-review (or its pinned replacement) for insight continuations';
  return null;
}

export class DerivedTaskAdmissionError extends HttpError {
  constructor(readonly issues: readonly unknown[]) {
    const requirement = issues
      .map((issue) =>
        issue && typeof issue === 'object' && 'issue' in issue
          ? insightRequirementMessage(issue.issue)
          : null,
      )
      .find((message) => message !== null);
    super(
      409,
      requirement ?? 'The derived task type cannot be admitted',
      'derived_admission_refused',
    );
  }
}
