import { leftOpenMerges, type MergeLeftOpenOutcome } from '@haive/shared/merge-left-open';
import { parseStepId } from '@haive/shared/modularity';

/** Banner visibility for step cards, invocation terminals and attachment rows.
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

/** Copy for a queued run that never wrote a status line of its own — which is nearly all of
 *  them, and by design.
 *
 *  Nothing is written at enqueue. A mark there used to fire when every slot happened to be busy
 *  at `queue.add`, which split ONE fan-out across two sentences (the jobs that lost that race
 *  got "machine at capacity", the rest got this line) and named a reason it could not know.
 *  This copy is deliberately vague about the REASON instead: a run can be held by the pause
 *  gate, the per-task agent cap or the runtime-holder reserve, and only a gate that actually
 *  deferred the job knows which — so only a gate writes a specific line (markWaiting in
 *  worker queues/cli-exec/agent-reserve.ts), and its words then replace these.
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
 *  or completed task can still hold a marker, and nothing is queued there. `dead` does the same:
 *  nothing drives a dead task's park loop either. */
export function parkBanner(
  step: StepBannerRow,
  opts: { taskEnded: boolean; paused?: boolean; dead?: boolean },
): { text: string } | null {
  if (opts.taskEnded || opts.dead) return null;
  if (step.status !== 'pending') return null;
  if (step.waitingStartedAt == null) return null;
  // Paused overrides the stored queue line. The park marker is still the thing that proves the
  // step is waiting — pause only changes WHY it is waiting, and the stored copy ("Waiting for a
  // free runtime slot — #1 of 2…") would otherwise promise a slot that no one is handing out. The
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

/** The attachment fields the archive rule reads. Both optional: an api that predates them sends
 *  neither, and that has to read as "nothing to say". */
export interface ArchiveBannerRow {
  expandedAt?: Date | string | null;
  expansionNote?: string | null;
}

/** Copy for the amber "this archive did not fully expand" line under an attachment, or null.
 *
 *  Gated on `expandedAt`, the stamp proving the worker ran the expansion the note describes.
 *  Nothing writes a note without it today, since both land in one UPDATE. But a path that cleared
 *  the stamp to force a re-expansion would leave the old line describing a run about to be redone. */
export function archiveExpansionBanner(a: ArchiveBannerRow): { text: string } | null {
  if (a.expandedAt == null || !a.expansionNote) return null;
  return { text: a.expansionNote };
}

/** The event rows the left-open merge banner reads. */
export interface LeftMergeEventRow {
  eventType: string;
  payload: Record<string, unknown> | null;
}

export interface LeftMergeBanner {
  /** One report: its directory and the commit that was being merged. */
  key: string;
  dir: string;
  mergeHead: string;
  /** The branch that was being merged. */
  ref: string;
  /** True while the merge is still reported open: the person may abort it. */
  canAbort: boolean;
  /** Refused attempts so far; a new one means the last request came back. */
  refusals: number;
  /** Markdown. */
  text: string;
}

const LEFT_MERGE_OUTCOME_LABEL: Record<Exclude<MergeLeftOpenOutcome, 'refused'>, string> = {
  aborted: 'Merge aborted:',
  moved: 'Merge left as it is:',
  'aborted-by-next': 'Merge aborted by another task:',
};

function codeSpan(value: string): string {
  const longest = Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${value}${fence}`;
}

/** The merges a cancelled task left open, one banner each: offering the abort while the report is
 *  unsettled, then the settled outcome's words. Gated on the `merge.left_open` events and on a
 *  matching `merge.left_open_settled` one, never on a message column; only a cancelled task has any. */
export function leftMergeBanners(
  events: readonly LeftMergeEventRow[],
  opts: { taskStatus: string },
): LeftMergeBanner[] {
  if (opts.taskStatus !== 'cancelled') return [];
  return leftOpenMerges(events).map((m) => {
    const where = `${codeSpan(m.ref)} in ${codeSpan(m.dir)}`;
    const refusals = m.refused?.count ?? 0;
    if (m.settled === null) {
      const last = m.refused ? ` The last attempt was not carried out: ${m.refused.reason}` : '';
      return {
        key: `${m.dir}\0${m.mergeHead}`,
        dir: m.dir,
        mergeHead: m.mergeHead,
        ref: m.ref,
        canAbort: true,
        refusals,
        text: `A merge of ${where} was left open when this task was cancelled. Aborting it puts that checkout back to how it was before the merge started.${last}`,
      };
    }
    return {
      key: `${m.dir}\0${m.mergeHead}`,
      dir: m.dir,
      mergeHead: m.mergeHead,
      ref: m.ref,
      canAbort: false,
      refusals,
      text: `${LEFT_MERGE_OUTCOME_LABEL[m.settled.outcome]} ${where}. ${m.settled.reason}`.trim(),
    };
  });
}

export interface DeadTaskRow {
  status: string;
  /** Absent on an api that predates the column, which reads as alive. */
  deadAt?: Date | string | null;
}

export interface DeadStepRow {
  stepId: string;
  /** `missing`: the module is not installed; otherwise it is installed without this step. */
  module: { id: string; name: string | null; missing: boolean } | null;
}

/** Structural: `dead_at` set on a task not cancelled or completed. Never `dead_reason`, which is copy. */
export function isTaskDead(task: DeadTaskRow): boolean {
  return task.deadAt != null && task.status !== 'cancelled' && task.status !== 'completed';
}

function codeList(values: readonly string[]): string {
  const spans = values.map(codeSpan);
  return spans.length > 1 ? `${spans.slice(0, -1).join(', ')} and ${spans.at(-1)}` : spans.join('');
}

const DEAD_LEAD = 'This task is dead:';
const DEAD_TAIL = 'and the worker restarts; until then you can only cancel it.';

/** Markdown for a dead task's banner, one sentence per kind of unresolved step; null while alive. */
export function deadBanner(
  task: DeadTaskRow,
  steps: readonly DeadStepRow[],
): { text: string } | null {
  if (!isTaskDead(task)) return null;
  const notInstalled = new Map<string, string>();
  const noLongerProvided = new Map<string, { label: string; stepIds: string[] }>();
  const custom: string[] = [];
  const core: string[] = [];
  for (const { stepId, module } of steps) {
    if (module?.missing) {
      notInstalled.set(module.id, module.name || module.id);
    } else if (module) {
      const entry = noLongerProvided.get(module.id) ?? {
        label: module.name || module.id,
        stepIds: [],
      };
      entry.stepIds.push(stepId);
      noLongerProvided.set(module.id, entry);
    } else if (parseStepId(stepId)?.kind === 'custom') {
      custom.push(stepId);
    } else {
      core.push(stepId);
    }
  }
  const sentences: string[] = [];
  if (notInstalled.size > 0) {
    const one = notInstalled.size === 1;
    const names = codeList([...notInstalled.values()]);
    sentences.push(
      `This task needs the ${one ? 'module' : 'modules'} ${names}, which ${one ? 'is' : 'are'} not installed. ` +
        `Nothing runs on it until ${one ? 'the module is' : 'they are'} installed again ${DEAD_TAIL}`,
    );
  }
  for (const { label, stepIds } of noLongerProvided.values()) {
    sentences.push(
      `${DEAD_LEAD} the module ${codeSpan(label)} no longer provides ${codeList(stepIds)}. ` +
        `Nothing runs on it until the module provides what it needs again ${DEAD_TAIL}`,
    );
  }
  if (custom.length > 0) {
    sentences.push(
      `${DEAD_LEAD} its prompt ${custom.length === 1 ? 'step' : 'steps'} ${codeList(custom)} ` +
        'cannot be read from what the task was created with; cancel it.',
    );
  }
  if (core.length > 0) {
    sentences.push(
      `${DEAD_LEAD} its run list names steps this install does not have: ${codeList(core)}. You can only cancel it.`,
    );
  }
  if (sentences.length === 0) {
    sentences.push(`${DEAD_LEAD} a step it needs is no longer available. You can only cancel it.`);
  }
  return { text: sentences.join('\n\n') };
}
