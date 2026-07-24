/** Banner visibility for step cards and invocation terminals.
 *
 *  ONE RULE: a message column is display copy, not state. `task_steps.status_message`,
 *  `task_steps.error_message` and `cli_invocations.status_message` all outlive the thing they
 *  describe — a park whose loop ended leaves its last line behind, a step that failed once and
 *  succeeded later keeps its error text, an invocation that got picked up immediately can be
 *  labelled "queued" by a write that lost a race. So a banner must be gated on the STRUCTURAL
 *  column that proves the state, and the message used only as the words inside it.
 *
 *  Rendering off the presence of copy produced three separate bugs in one day: two live
 *  "waiting for a slot" banners on one task, a `done` step showing "cli invocation failed" with a
 *  Retry button, and a running CLI advertising "Queued — machine at capacity". These predicates
 *  exist so that decision lives in one tested place instead of being re-derived per call site.
 */

/** The step fields the banner rules read. Dates accept a `Date` or an ISO string. */
export interface StepBannerRow {
  status: string;
  statusMessage: string | null;
  errorMessage: string | null;
  /** Runtime-slot park marker. Non-null iff the step is queued for capacity right now. */
  waitingStartedAt: Date | string | null;
}

/** Copy for the amber "queued for a runtime slot" panel, or null when the step is not parked.
 *
 *  Gated on the marker, never on the message: the park writes its queue line to status_message
 *  and a loop whose chain ended cannot clear its own line, so a step nothing was driving kept
 *  advertising a live wait next to the real one. `taskEnded` suppresses it outright — a cancelled
 *  or completed task can still hold a marker, and nothing is queued there. */
export function parkBanner(
  step: StepBannerRow,
  opts: { taskEnded: boolean },
): { text: string } | null {
  if (opts.taskEnded) return null;
  if (step.status !== 'pending') return null;
  if (step.waitingStartedAt == null) return null;
  if (!step.statusMessage) return null;
  return { text: step.statusMessage };
}

/** Copy for the red failure panel, or null.
 *
 *  Suppressed once the row has ENDED WELL, where error_message means one of two things and
 *  neither is a failure to show: stale text from an earlier attempt that later succeeded, or —
 *  deliberately — a fix-loop diagnosis. `fixLoopOnError` steps write `status: 'done'` TOGETHER
 *  WITH errorMessage to route a thrown failure back to implementation, so the column is the
 *  payload of a routing decision there. That is also why this rule cannot be a DB constraint or a
 *  nulling trigger: enforcing "done implies no error" would destroy the diagnosis. */
export function failureBanner(step: StepBannerRow): { text: string } | null {
  if (!step.errorMessage) return null;
  if (step.status === 'done' || step.status === 'skipped') return null;
  return { text: step.errorMessage };
}

/** The invocation fields the banner rules read. */
export interface InvocationBannerRow {
  startedAt: Date | string | null;
  statusMessage: string | null;
}

/** Which banner an ACTIVE invocation shows, or null when it has nothing to say.
 *
 *  `queued` strictly before the run begins (`startedAt == null`) and `running` after — the
 *  structural split, so a started invocation can never present itself as waiting for a slot even
 *  if its copy still says so. Callers decide styling (amber vs blue) and whether a `running`
 *  banner is worth the space; this only decides which state the copy belongs to. */
export function invocationBanner(
  inv: InvocationBannerRow,
): { kind: 'queued' | 'running'; text: string } | null {
  if (!inv.statusMessage) return null;
  return { kind: inv.startedAt == null ? 'queued' : 'running', text: inv.statusMessage };
}
