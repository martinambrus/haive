import { STEP_CLI_ROLES } from '@haive/shared';

/** Human label for the step a task is parked on — "Phase 4: Implementation validation
 *  (fix loop 7)" rather than the raw `07b-phase-4-validate` slug.
 *
 *  Computed SERVER-side and returned on both the listing and the detail endpoint, so the
 *  list badge and the task header render the identical string by construction. They used to
 *  disagree: the header built a label from the step rows it had, while the listing had no
 *  step titles at all and fell back to printing the step id. Two surfaces naming the same
 *  thing differently is the bug; one derivation both consume is the fix.
 *
 *  Keyed on `tasks.current_step_id` + `current_round` — the orchestrator's own pointer, and
 *  the same pointer deriveSlotWait and currentStepParkedSql already use — rather than a
 *  scan for the first row in a live-looking status. One authoritative notion of "the current
 *  step" across every surface beats three heuristics that agree most of the time. */

/** A step row reduced to what the label needs. */
export interface StepLabelRow {
  stepId: string;
  round: number;
  title: string;
  iterationCount: number;
}

/** Steps that a NEW round re-enters at when a spec gate sends the work back. Every other
 *  round-0 boundary is the auto-fix loop re-entering at the implementation step. */
const SPEC_REVISION_ENTRY_STEP_IDS = new Set([
  '04-phase-0b-pre-planning',
  '03b-business-requirements',
]);

/** Compact per-round suffix ("fix loop 7", "spec rev 2") for any row in that round.
 *
 *  Numbered per KIND, not by the raw round integer: spec revisions and fix loops interleave,
 *  so round 5 may be the 2nd spec revision. Requires steps in RUN ORDER (round, run_seq,
 *  created_at, step_index) because it names a round group by the step that opens it. */
export function deriveRoundSuffixes(orderedSteps: readonly StepLabelRow[]): Map<number, string> {
  const byRound = new Map<number, string>();
  let specN = 0;
  let fixN = 0;
  for (let i = 0; i < orderedSteps.length; i++) {
    const step = orderedSteps[i]!;
    if (step.round > 0 && (i === 0 || orderedSteps[i - 1]!.round !== step.round)) {
      if (SPEC_REVISION_ENTRY_STEP_IDS.has(step.stepId))
        byRound.set(step.round, `spec rev ${++specN}`);
      else byRound.set(step.round, `fix loop ${++fixN}`);
    }
  }
  return byRound;
}

/** In-place loop counter for a round-0 step that has re-run passes. A step whose CLI work is
 *  split into roles does several passes per round, so its passes are reported as rounds. */
export function iterationSuffix(step: StepLabelRow): string {
  const loopPassesPerRound = STEP_CLI_ROLES[step.stepId]?.length ?? 1;
  return loopPassesPerRound > 1
    ? `round ×${Math.ceil(step.iterationCount / loopPassesPerRound)}`
    : `iter ×${step.iterationCount}`;
}

/**
 * Label for the task's current step, or null when it has none (never started, or the
 * pointer names a row that is not present).
 *
 * Round context wins over the in-place counter: a step on its 7th fix loop is "(fix loop 7)",
 * not "(iter ×7)". Neither applies on an untouched first pass, and the suffix is omitted
 * entirely then so no empty "()" is ever rendered.
 */
export function currentStepLabel(
  orderedSteps: readonly StepLabelRow[],
  currentStepId: string | null,
  currentRound: number,
): string | null {
  if (!currentStepId) return null;
  const current = orderedSteps.find((s) => s.stepId === currentStepId && s.round === currentRound);
  if (!current) return null;
  const suffix =
    current.round > 0
      ? (deriveRoundSuffixes(orderedSteps).get(current.round) ?? null)
      : current.iterationCount > 0
        ? iterationSuffix(current)
        : null;
  return suffix ? `${current.title} (${suffix})` : current.title;
}
