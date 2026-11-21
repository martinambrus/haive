import type { Database } from '@haive/database';
import { logger } from '@haive/shared';
import type { DispatchPlan } from '../orchestrator/dispatcher.js';
import { providerLabel } from '../orchestrator/provider-hold.js';
import { StepSupersededError, appendStepWarning } from './step-ownership.js';

const log = logger.child({ module: 'saved-cli-skip' });

/** Display copy; nothing may key on it. */
export function savedCliSkipNote(
  plan: Pick<DispatchPlan, 'skippedSavedPreference' | 'provider'>,
): string | null {
  const skipped = plan.skippedSavedPreference;
  if (!skipped || !plan.provider) return null;
  const saved = skipped.label ? ` ("${skipped.label}")` : '';
  return `Your saved CLI for this step${saved} cannot launch on this task: its language-server setup only allows another CLI. This step ran on "${providerLabel(plan.provider)}" instead.`;
}

export async function noteSavedCliSkip(
  db: Database,
  stepRowId: string,
  plan: DispatchPlan,
): Promise<void> {
  const note = savedCliSkipNote(plan);
  if (!note) return;
  try {
    await appendStepWarning(db, stepRowId, note);
  } catch (err) {
    // Display copy must never fail a launched run.
    if (err instanceof StepSupersededError) throw err;
    log.warn({ err, stepRowId }, 'could not record the saved CLI skip notice');
  }
}
