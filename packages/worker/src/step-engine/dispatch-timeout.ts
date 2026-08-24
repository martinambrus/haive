import type { schema } from '@haive/database';

/** The user's "Retry with longer timeout" value for this step, or the caller's own budget.
 *
 *  `task_steps.cli_timeout_override_ms` is written once, by the retry route, and read by
 *  every invocation the step goes on to dispatch. The step's own CLI already honors it
 *  through resolveDispatchTimeoutMs; this is for the agents a step FANS OUT — DAG coders,
 *  DAG reviewers, the replanner, the merge fix-agents — which passed a hardcoded constant
 *  and silently discarded the number the user chose. Setting a 90-minute budget and watching
 *  the run die at 30 is worse than having no control at all, because it looks like the
 *  control worked.
 *
 *  No PER-AGENT ladder here, and that part still holds: N coders each escalating independently
 *  makes the wall-clock ceiling of a level fan-out impossible to reason about, which is why this
 *  helper stays a flat lookup.
 *
 *  `overrideOrLearned` below is the narrow exception, added 2026-08-24 after a coder needing
 *  ~35 minutes was killed at 30 and then re-dispatched at 30 twice more until
 *  DAG_MAX_INFRA_RETRIES was spent and its work abandoned. The escalation is written to the
 *  STEP, not the issue, so every coder in the level shares one budget and the ceiling is still
 *  computable — N x escalated, bounded to two doublings by DAG_MAX_INFRA_RETRIES.
 *
 *  A non-positive stored value is treated as absent — the API clamps writes to 15..480
 *  minutes, so 0/negative can only mean "cleared".
 *
 *  An undeclared budget stays undeclared when there is no override: the caller's `undefined`
 *  means "whatever the runner defaults to", and substituting a number here would change a
 *  site's behaviour as a side effect of adding override support. */
export function overrideOr(
  step: Pick<typeof schema.taskSteps.$inferSelect, 'cliTimeoutOverrideMs'>,
  declaredMs: number | undefined,
): number | undefined {
  const override = step.cliTimeoutOverrideMs;
  return override && override > 0 ? override : declaredMs;
}

/** Ceiling on a LEARNED budget, in ms (8 hours).
 *
 *  Mirrors the `.max(480)` the retry endpoint enforces on a human-chosen pin
 *  (`stepActionRequestSchema.timeoutMinutes` in @haive/shared) — duplicated rather than imported
 *  because that bound is a zod schema on a request body, not a shared constant. The learned value
 *  can only grow by one ladder-worth per round, so reaching this needs roughly four consecutive
 *  all-timeout rounds; the clamp is what stops it walking any further. */
export const LEARNED_TIMEOUT_MAX_MS = 480 * 60_000;

/** The base a step's ladder should escalate FROM, given what earlier rounds already proved.
 *
 *  A round fork does not reuse rows, so both the user's pin and the ladder's attempt count reset
 *  every round and the step re-paid for the same discovery — a 120-minute pin at round 6 was back
 *  to the base budget at round 7, which then burned five 45-minute kills. `learnedMs` is the
 *  high-water mark across this step's SIBLING rows, and it raises the base rather than replacing
 *  the budget outright: escalation still applies on top, so a round that needs even more time can
 *  still climb.
 *
 *  Returns undefined when neither a declared nor a learned budget exists. Undeclared must stay
 *  undeclared — `escalatedTimeoutMs` reads undefined as "use the configured floor", and inventing
 *  a number here would change every step that never declared one, as a side effect of adding
 *  learning. A non-positive learned value is treated as absent, matching `overrideOr`. */
export function learnedLadderBaseMs(
  declaredMs: number | undefined,
  learnedMs: number | null | undefined,
): number | undefined {
  const learned = learnedMs && learnedMs > 0 ? Math.min(learnedMs, LEARNED_TIMEOUT_MAX_MS) : 0;
  const declared = declaredMs && declaredMs > 0 ? declaredMs : 0;
  const base = Math.max(declared, learned);
  return base > 0 ? base : undefined;
}

/** Budget for a fan-out site that may escalate: explicit human override > learned > declared.
 *
 *  The human pin always wins. Someone who chose 90 minutes on the retry route must not have it
 *  silently replaced by a value the system inferred, in either direction.
 *
 *  `cli_timeout_learned_ms` is the same column the step-runner's mining ladder maintains, reused
 *  rather than duplicated so a step carries ONE learned budget however it fans out. */
export function overrideOrLearned(
  step: Pick<typeof schema.taskSteps.$inferSelect, 'cliTimeoutOverrideMs' | 'cliTimeoutLearnedMs'>,
  declaredMs: number | undefined,
): number | undefined {
  const override = step.cliTimeoutOverrideMs;
  if (override && override > 0) return override;
  const learned = step.cliTimeoutLearnedMs;
  if (learned && learned > 0) return learned;
  return declaredMs;
}

/** The next budget for a step whose fan-out agent was SIGKILLed at its own budget.
 *
 *  Doubling, not a fixed ladder, so the step converges on the work's real cost from whatever it
 *  was actually given. Clamped by LEARNED_TIMEOUT_MAX_MS; returns null when there is nothing to
 *  escalate from, so a caller cannot invent a budget out of an unparseable message. */
export function escalatedTimeoutMs(failedBudgetMs: number | undefined): number | null {
  if (!failedBudgetMs || failedBudgetMs <= 0) return null;
  return Math.min(failedBudgetMs * 2, LEARNED_TIMEOUT_MAX_MS);
}
