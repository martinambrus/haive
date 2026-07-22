// Classifies why a DAG agent (coder / reviewer / fix-coder) failed to produce a
// usable structured result, so resolveDagPhase can route each cause to the right
// recovery instead of a blanket `failed_unrecoverable` hard-halt:
//
//   TRANSIENT   the process was KILLED before it finished (worker restart, SIGKILL/
//               OOM, cancel, timeout) — it never had a chance to emit its result.
//               Recover by RE-DISPATCHING, bounded per-agent by task_dag_issues:
//               .infra_retries for coders, .review_infra_retries for reviewers.
//   ENVIRONMENT a real execution-environment problem (unwritable/root-owned worktree,
//               no CLI provider, or transient re-dispatch exhausted). Re-running will
//               not help until it is fixed → HALT with an actionable message.
//   GENUINE     the agent ran to a clean finish but violated the output contract, or a
//               plain non-termination error. The implementation approach is the
//               problem → the escalation path (advisor → replanner) decides.
//
// Keyed on the STABLE exit signal + invariant error phrases, delegated to the shared
// isTransientCliFailure classifier (cli-exec/failure-class.ts), never on ephemeral wording.

import { isTransientCliFailure } from '../queues/cli-exec/failure-class.js';

export type DagFailureClass = 'transient' | 'environment' | 'genuine';

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
  // A transient MARKER-exhausted concern reads as ENVIRONMENT, so check that first.
  if (ENVIRONMENT_FAILURE_RE.test(text)) return 'environment';
  // Delegate the transient (killed/orphaned/timed-out) test to the shared classifier,
  // passing the combined error+concerns text so a concern-only marker still matches.
  if (isTransientCliFailure({ exitCode: signal.exitCode, errorMessage: text })) return 'transient';
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
