// Classifies why a DAG agent (coder / reviewer / fix-coder) failed to produce a
// usable structured result, so resolveDagPhase can route each cause to the right
// recovery instead of a blanket `failed_unrecoverable` hard-halt:
//
//   TRANSIENT   the process was KILLED before it finished (worker restart, SIGKILL/
//               OOM, cancel, timeout) — it never had a chance to emit its result.
//               Recover by RE-DISPATCHING (bounded by task_dag_issues.infra_retries).
//   ENVIRONMENT a real execution-environment problem (unwritable/root-owned worktree,
//               no CLI provider, or transient re-dispatch exhausted). Re-running will
//               not help until it is fixed → HALT with an actionable message.
//   GENUINE     the agent ran to a clean finish but violated the output contract, or a
//               plain non-termination error. The implementation approach is the
//               problem → the escalation path (advisor → replanner) decides.
//
// Keyed on the STABLE exit signal + invariant error phrases (see cli-exec/exec-core.ts
// TERMINATION_EXIT_CODES and the orphan/timeout markers), never on ephemeral wording.

export type DagFailureClass = 'transient' | 'environment' | 'genuine';

/** Exit codes that mean the process was TERMINATED before finishing (SIGINT 130,
 *  SIGKILL 137, SIGTERM 143) — mirrors TERMINATION_EXIT_CODES in cli-exec/exec-core.ts.
 *  A null exit code is the same case (the spawn killed the client on timeout/abort). */
const TERMINATION_EXIT_CODES: ReadonlySet<number> = new Set([130, 137, 143]);

/** Error phrases proving the invocation was killed / orphaned / cut off mid-run rather
 *  than finishing — the recoverable transient case. Sourced from the exact strings the
 *  runtime writes: task-queue.ts (worker-restart orphan), cli-exec/exec-core.ts (stop/
 *  cancel/timeout), cli-exec/stream.ts (premature stream end). */
const TRANSIENT_FAILURE_RE =
  /orphaned by a worker restart|stopped before it finished|stream ended prematurely|cancelled or timed out/i;

/** Stable marker stamped on the issue's `concerns` when transient re-dispatch is
 *  exhausted, so the downstream ENVIRONMENT halt recognises a persistently-killed agent
 *  (typically a runner OOM) without needing the original exit code. */
export const DAG_INFRA_EXHAUSTED_MARKER = 'DAG_INFRA_EXHAUSTED';

/** True execution-ENVIRONMENT problems: re-running will not help until fixed. Mirrors
 *  the pre-existing infra deny-set MINUS the "no result JSON" phrases (those are now
 *  TRANSIENT when killed, or GENUINE when the agent exited clean), PLUS the
 *  transient-exhausted marker. */
const ENVIRONMENT_FAILURE_RE = new RegExp(
  [
    '\\bEACCES\\b',
    '\\bEPERM\\b',
    'permission denied',
    'read-only file system',
    'operation not permitted',
    'root:root',
    'root-owned',
    'workspace[^\\n]{0,80}unwritable',
    'worktree[^\\n]{0,80}unwritable',
    'unable to write',
    'cannot write',
    'no cli provider available',
    DAG_INFRA_EXHAUSTED_MARKER,
  ].join('|'),
  'i',
);

/** Classify a failed agent invocation. `exitCode` is the invocation's exit code at
 *  ingest time; pass `undefined` when classifying from persisted issue text alone (the
 *  halt scan), where transient re-dispatch has already happened or been exhausted, so
 *  the text carries the class. */
export function classifyDagIssueFailure(signal: {
  exitCode?: number | null;
  errorMessage?: string | null;
  concerns?: string | null;
}): DagFailureClass {
  const text = [signal.errorMessage, signal.concerns].filter(Boolean).join(' ; ');
  const killedByExit =
    signal.exitCode === null ||
    (typeof signal.exitCode === 'number' && TERMINATION_EXIT_CODES.has(signal.exitCode));
  // A transient MARKER-exhausted concern reads as ENVIRONMENT, so check that first.
  if (ENVIRONMENT_FAILURE_RE.test(text)) return 'environment';
  if (killedByExit || TRANSIENT_FAILURE_RE.test(text)) return 'transient';
  return 'genuine';
}

/** The infrastructure/environment reason to HALT the DAG on, or null. A failed issue is
 *  halt-worthy only when its cause is ENVIRONMENT (unwritable worktree, no provider,
 *  transient re-dispatch exhausted) — NOT a killed agent (re-dispatched) nor a clean
 *  contract violation (escalated). Replaces the former broad regex that also halted on
 *  any missing result JSON. Text-only (no exit code) because it scans persisted rows. */
export function dagEnvironmentHaltReason(issue: {
  concerns?: string | null;
  errorMessage?: string | null;
}): string | null {
  const detail = [issue.errorMessage, issue.concerns].filter(Boolean).join('; ').trim();
  return detail && ENVIRONMENT_FAILURE_RE.test(detail) ? detail : null;
}
