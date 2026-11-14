import type { TaskStep } from './api-client.js';

/** Decide whether the task page should clear its `submitting` state. Returns
 *  true once the in-flight step transitions out of `waiting_form` (success:
 *  form unmounts; failure: retry button replaces form), or once the worker parks
 *  it on its form again under a new stamp (an answer it refused, with the form
 *  reoffered in the same transaction, so the status never visibly leaves
 *  `waiting_form`). `submittedPark` is the step's `waitingStartedAt` when the
 *  answer was sent: stamps are compared for identity, never against the browser
 *  clock. Keeping the submit button disabled across the post-submit/pre-state-update
 *  gap stops it from re-enabling for a frame and then immediately disappearing. */
export function shouldClearSubmitting(
  submitting: string | null,
  steps: (Pick<TaskStep, 'stepId' | 'status'> & { waitingStartedAt?: string | null })[],
  submittedPark: string | null = null,
): boolean {
  if (!submitting) return false;
  const step = steps.find((s) => s.stepId === submitting);
  if (!step || step.status !== 'waiting_form') return true;
  const park = step.waitingStartedAt ?? null;
  return park !== null && park !== submittedPark;
}

/** A step parked on its form for an answer. Status alone is not enough: the submit route clears
 *  `waitingStartedAt` and leaves the row `waiting_form` until the worker picks the job up. */
export function isAwaitingFormInput(
  step: Pick<TaskStep, 'status' | 'waitingStartedAt'> | null | undefined,
): boolean {
  return step?.status === 'waiting_form' && step.waitingStartedAt !== null;
}

/** The answer-form error belongs to the step that failed, and stays shown after `submitting`
 *  clears so the form is not just silently clickable again. */
export function submitErrorFor(
  error: { stepId: string; message: string } | null,
  stepId: string,
): string | null {
  return error?.stepId === stepId ? error.message : null;
}
