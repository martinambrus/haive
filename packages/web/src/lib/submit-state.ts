import type { TaskStep } from './api-client.js';

/** Decide whether the task page should clear its `submitting` state. Returns
 *  true once the in-flight step transitions out of `waiting_form` (success:
 *  form unmounts; failure: retry button replaces form). Keeping the submit
 *  button disabled across the post-submit/pre-state-update gap stops it from
 *  re-enabling for a frame and then immediately disappearing. */
export function shouldClearSubmitting(
  submitting: string | null,
  steps: Pick<TaskStep, 'stepId' | 'status'>[],
): boolean {
  if (!submitting) return false;
  const step = steps.find((s) => s.stepId === submitting);
  return !step || step.status !== 'waiting_form';
}
