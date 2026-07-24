/** Ordering of step rows in a task's step list.
 *
 *  The list renders — and the engine runs — ordered by `round` FIRST, then `run_seq`. run_seq
 *  alone is not an ordering key: the same step recurs once per fix-loop round carrying the SAME
 *  run_seq, so a later round's early step (round 3, run_seq 25) compares "before" an earlier
 *  round's late step (round 0, run_seq 31) even though it renders far below it.
 */
export interface StepOrderKey {
  round: number;
  /** Position in the run list. Null on legacy rows the worker never stamped. */
  runSeq: number | null;
}

/** Is `step` rendered below `frontier` — i.e. has the run not reached it yet?
 *
 *  Compared lexicographically on (round, run_seq). A null run_seq is unorderable and answers
 *  false, so such a row is never treated as downstream (it keeps its own actions rather than
 *  silently losing them).
 */
export function isAfterFrontier(step: StepOrderKey, frontier: StepOrderKey): boolean {
  if (step.round !== frontier.round) return step.round > frontier.round;
  if (step.runSeq == null || frontier.runSeq == null) return false;
  return step.runSeq > frontier.runSeq;
}
