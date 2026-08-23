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

/** Copy shown in place of a queue/park line while execution is paused.
 *
 *  Pause gates job PICKUP, never work already in flight, so this replaces the copy of things
 *  that are WAITING and nothing else. A run that was already started keeps reporting itself as
 *  running, because it genuinely still is — the sandbox keeps going and its output keeps
 *  streaming. Getting that split backwards in either direction is a lie: relabel a running CLI
 *  and the user thinks their in-flight work stopped; leave a queued one alone and the UI claims
 *  a slot is coming that nothing will hand out until the switch flips. */
export const PAUSED_WAIT_TEXT =
  'Paused — execution is paused, so this will not start until it resumes.';

/** Copy for a queued run that never wrote a status line of its own.
 *
 *  The queued mark is written only when every slot is busy AT ENQUEUE (`queue.add` then a
 *  guarded update in task-queue.ts), so a fan-out enqueued in a burst leaves some of its jobs
 *  queued with no copy at all — nothing is wrong with them, the marker simply never fired.
 *  Deliberately vague about the REASON: a run can also be held by the pause gate, the per-task
 *  agent cap or the runtime-holder reserve, and naming capacity would be a guess.
 *
 *  Supplying words here rather than returning null is what stops a queued run falling through to
 *  whatever a caller shows next — which is how a queued verifier terminal ended up displaying its
 *  STEP's live "Waiting for AI analysis..." in running-blue, i.e. reporting another terminal's
 *  work as its own. */
export const QUEUED_WAIT_TEXT =
  'Queued — this run has not started yet. It begins automatically when a slot frees.';

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
  opts: { taskEnded: boolean; paused?: boolean },
): { text: string } | null {
  if (opts.taskEnded) return null;
  if (step.status !== 'pending') return null;
  if (step.waitingStartedAt == null) return null;
  // Paused overrides the stored queue line. The park marker is still the thing that proves the
  // step is waiting — pause only changes WHY it is waiting, and the stored copy ("Queued —
  // machine at capacity…") would otherwise promise a slot that no one is handing out. The
  // statusMessage guard is skipped here for the same reason: under pause the step is provably
  // waiting whether or not the park ever wrote its line.
  if (opts.paused) return { text: PAUSED_WAIT_TEXT };
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

/** The model-identity fields the banner rule reads. Mirrors `ModelIdentity` in
 *  @haive/shared; declared locally because this package reads the shared barrel only
 *  through subpaths (importing it whole pulls ioredis -> dns into the bundle). */
export interface ModelIdentityRow {
  requested: string | null;
  served: string | null;
  match: 'exact' | 'differs' | 'unknown';
}

/** Copy for the "the model that answered is not the one configured" warning, or null.
 *
 *  Gated on `match`, which is computed once at capture from the two model strings —
 *  never on any message column, and never by re-comparing requested/served here. A
 *  second comparison at the call site is a second place for the rule to drift, and
 *  the whole point of `match` is that the decision was made where the evidence was.
 *
 *  Silent for 'unknown' on purpose. That is the PERMANENT state for codex and amp,
 *  whose CLIs report no model at all — warning there would put a banner nobody can
 *  act on next to every one of those runs, and it would say "we could not check"
 *  in the visual language of "something is wrong". */
export function modelIdentityBanner(
  identity: ModelIdentityRow | null | undefined,
): { text: string } | null {
  if (!identity || identity.match !== 'differs') return null;
  return {
    text:
      `Model mismatch: configured ${identity.requested ?? 'unknown'}, ` +
      `but ${identity.served ?? 'unknown'} answered.`,
  };
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
  opts: { paused?: boolean } = {},
): { kind: 'queued' | 'running'; text: string } | null {
  const queued = inv.startedAt == null;
  // Only the queued half is relabelled — see PAUSED_WAIT_TEXT. A started invocation under pause
  // is still a live sandbox streaming output, so its copy is left exactly as it was.
  if (opts.paused && queued) return { kind: 'queued', text: PAUSED_WAIT_TEXT };
  // A queued run always has something to say, because `startedAt == null` PROVES it is waiting
  // whether or not the queue ever wrote a line for it. Only a STARTED run can be silent: there
  // the message is the whole content, and an absent one means nothing to report.
  if (!inv.statusMessage) return queued ? { kind: 'queued', text: QUEUED_WAIT_TEXT } : null;
  return { kind: queued ? 'queued' : 'running', text: inv.statusMessage };
}
