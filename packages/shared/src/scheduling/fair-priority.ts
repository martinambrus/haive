/** Fair-scheduling priority for the cli-exec queue, plus the up/down vote term that
 *  shifts it. Pure and dependency-free so the worker (which computes a priority at
 *  enqueue) and the api (which re-prices already-queued jobs on a vote) cannot drift
 *  apart — a mismatch there does not throw, it silently mis-orders the queue.
 *
 *  BullMQ priority: LOWER runs sooner. */

/** Composite band layout. `priority = band * FAIR_RANK_MULTIPLIER + userTiebreak`, so a
 *  task's Nth in-flight agent shares a band with every other task's Nth agent — that is
 *  where the round-robin across tasks comes from — and within a band the least-loaded user
 *  sorts first (cross-user fairness). */
const FAIR_RANK_MULTIPLIER = 1000;
const FAIR_USER_TIEBREAK_MAX = FAIR_RANK_MULTIPLIER - 1; // never bleeds into the next band
const FAIR_TASK_RANK_MAX = 2000;

/** Vote score range. A task at +5 already outranks every neutral task's every agent,
 *  because MAX_PARALLEL_AGENTS_PER_TASK defaults to 5 — further levels would only let the
 *  number inflate until it stopped discriminating. */
export const TASK_VOTE_MIN = -5;
export const TASK_VOTE_MAX = 5;

/** Constant offset that gives an UPVOTE somewhere to move. `rank` is clamped at 1, so
 *  without a base every serial (one-agent-at-a-time) task would sit in band 1 and a boost
 *  would be a no-op — which is the common case. Equal to TASK_VOTE_MAX so the band stays
 *  >= 1: priority 0 is special-cased by BullMQ into the `wait` list instead of
 *  `prioritized`, which would take the job out of the ordering entirely. */
const VOTE_BASE = TASK_VOTE_MAX;

/** Reachable band range: [VOTE_BASE + 1 - TASK_VOTE_MAX, VOTE_BASE + FAIR_TASK_RANK_MAX -
 *  TASK_VOTE_MIN] = [1, 2010]. */
const BAND_MIN = 1;
const BAND_MAX = VOTE_BASE + FAIR_TASK_RANK_MAX - TASK_VOTE_MIN;

/** Priority bounds implied by the band range. The upper one is the constraint that matters:
 *  BullMQ scores a prioritized job as `priority * 2^32 + counter` into a Redis ZSET, whose
 *  score is a double — 53 bits of exact integer — so priority must stay under 2^21
 *  (2_097_152). 2_010_999 clears it. */
export const FAIR_PRIORITY_MIN = BAND_MIN * FAIR_RANK_MULTIPLIER;
export const FAIR_PRIORITY_MAX = BAND_MAX * FAIR_RANK_MULTIPLIER + FAIR_USER_TIEBREAK_MAX;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export interface FairPriorityInput {
  /** Count of this TASK's in-flight cli invocations (its position in the round-robin). */
  rank: number;
  /** Count of this USER's in-flight cli invocations across all their tasks. */
  tiebreak: number;
  /** The task's vote score. Clamped here, so a row outside the range cannot break the band. */
  score: number;
}

/** Priority for one cli-exec enqueue. At `score = 0` every band is the pre-vote band plus a
 *  constant VOTE_BASE, and ZSET ordering is monotonic in priority — so a zero-scored fleet
 *  of tasks keeps exactly the ordering it had before votes existed.
 *
 *  The vote offsets `rank` only, never `tiebreak`: a user boosting their own tasks can pull
 *  ahead by at most TASK_VOTE_MAX bands, and within a band an overloaded user still sorts
 *  last. */
export function fairPriority(input: FairPriorityInput): number {
  const rank = clamp(Math.trunc(input.rank), 1, FAIR_TASK_RANK_MAX);
  const tiebreak = clamp(Math.trunc(input.tiebreak), 0, FAIR_USER_TIEBREAK_MAX);
  const score = clamp(Math.trunc(input.score), TASK_VOTE_MIN, TASK_VOTE_MAX);
  const band = clamp(VOTE_BASE + rank - score, BAND_MIN, BAND_MAX);
  return band * FAIR_RANK_MULTIPLIER + tiebreak;
}

/** New priority for a job that is ALREADY queued, after its task's score moved by
 *  `scoreDelta`. Shifting by whole bands is exact — the band clamps are unreachable in the
 *  valid input range, so this lands on the same number a fresh `fairPriority` would, without
 *  needing the job to carry its original rank.
 *
 *  Repricing works because BullMQ's changePriority writes `priority` onto the job hash
 *  unconditionally, and both the prioritized ZSET and the delayed-set promotion read it back
 *  — so a queued job re-sorts and a deferred one picks the new value up when it promotes. */
export function repricedPriority(current: number, scoreDelta: number): number {
  return clamp(
    current - Math.trunc(scoreDelta) * FAIR_RANK_MULTIPLIER,
    FAIR_PRIORITY_MIN,
    FAIR_PRIORITY_MAX,
  );
}

/** Clamp a vote write to the storable range. Shared so the api and any future caller agree
 *  on where the arrows stop. */
export function clampVoteScore(score: number): number {
  return clamp(Math.trunc(score), TASK_VOTE_MIN, TASK_VOTE_MAX);
}
