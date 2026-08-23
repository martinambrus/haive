import {
  fatalClassFromMessage,
  isTransientCliFailure,
  isTransientProviderApiError,
} from '../queues/cli-exec/failure-class.js';
import type { AgentMiningResult } from './step-definition.js';

/** What a fan-out step actually got back for one named agent.
 *
 *  Three states, because two of them used to be one. A step that reads mining results as
 *  "output or null" cannot tell an agent that DIED from an agent that was never dispatched,
 *  and every consumer then treats the dead one as "nothing to report" — which for a reviewer
 *  means APPROVE. Distinguishing them is the whole point:
 *
 *   - `done`    — the agent finished; `raw` is its output (still possibly unparseable).
 *   - `failed`  — the agent was dispatched and did not finish: killed at its budget,
 *                 orphaned by a worker restart, preempted, or refused by every provider.
 *                 Its silence is EVIDENCE OF ABSENCE OF REVIEW, never evidence of approval.
 *   - `absent`  — no row at all: the test bypass, or a lens this QA level did not select.
 *                 Nothing was asked for, so nothing is missing. */
export type MiningOutcome =
  | { kind: 'done'; raw: unknown }
  | { kind: 'failed'; errorMessage: string | null }
  | { kind: 'absent' };

export function miningOutcome(results: AgentMiningResult[], agentId: string): MiningOutcome {
  const r = results.find((m) => m.agentId === agentId);
  if (!r) return { kind: 'absent' };
  if (r.status === 'done') return { kind: 'done', raw: r.output ?? r.rawOutput };
  return { kind: 'failed', errorMessage: r.errorMessage };
}

/** The cli_invocation one agent ran as, for attributing what it produced to the model that
 *  produced it (`review_findings.cli_invocation_id`). Null when the agent is absent from the
 *  batch or never reached dispatch — the recorder treats null as "cannot name one" rather
 *  than guessing. Sibling of miningOutcome so both read the batch the same way. */
export function miningInvocationId(results: AgentMiningResult[], agentId: string): string | null {
  return results.find((m) => m.agentId === agentId)?.invocationId ?? null;
}

/** Copy for the synthetic finding a step reports in place of a review that never happened.
 *
 *  Carries the runtime's own failure text ("CLI process exceeded its time budget (30m).")
 *  rather than a generic "failed", because the reader's next action differs per cause: a
 *  budget kill wants a longer timeout, an orphan wants a plain re-run. */
export function didNotCompleteIssue(what: string, errorMessage: string | null): string {
  const cause = errorMessage?.trim();
  return cause
    ? `${what} did not complete: ${cause} Re-run this step.`
    : `${what} did not complete (the agent produced no output). Re-run this step.`;
}

// A fan-out agent is bounded, re-runnable work, so a dropped provider connection or a killed
// terminal is worth a fresh run. Do NOT burn retries on a known persistent provider failure,
// an intentional stop, or an unavailable provider — those need a user action, not another
// identical terminal.
const NON_RETRYABLE_MINING_TERMINAL_ERROR_RE =
  /\b(?:no cli provider available|cli process was stopped|task cancelled)\b/i;
// Kept alongside the canonical classifier for the failures that never reach exec-core's
// headline vocabulary at all — a provider SDK's own transport wording, which arrives as
// raw agent output rather than as a Haive-stamped error.
const TRANSIENT_MINING_TERMINAL_ERROR_RE =
  /\b(?:connection (?:closed|reset|aborted|dropped|lost|interrupted)|socket hang up|econn(?:reset|refused)|network (?:error|failure)|fetch failed|stream ended prematurely|unexpected end of (?:stream|response)|timed? out|timeout)\b/i;

/** True when a failed fan-out agent deserves a fresh terminal, within its attempts budget.
 *
 *  The veto list is checked FIRST and deliberately overlaps the transient vocabulary: "cli
 *  process was stopped" is a cancel, which reads as transient to the generic classifier but
 *  must never be re-run — the user asked for it to stop.
 *
 *  Anchored on `isTransientCliFailure` rather than prose alone. The prose regex on its own
 *  misses the single most common real failure: a budget kill is stamped "CLI process exceeded
 *  its time budget (30m)." — no "timeout", no "timed out", so a word-boundary match on those
 *  never fires and the reviewer that most needed a retry was the one that never got one.
 *
 *  A failure with no diagnostic text at all stays non-retryable: with nothing to classify,
 *  re-running is a guess, and the degrade path downstream is a safe floor. */
export function shouldRetryMiningTerminalFailure(result: AgentMiningResult): boolean {
  if (result.status !== 'failed') return false;
  const diagnostic = [result.errorMessage, result.rawOutput]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join('\n');
  if (!diagnostic) return false;
  // Fatal classes are NOT uniformly non-retryable, which is why this reads the class rather
  // than isFatalProviderFailure's boolean. `auth` needs a human and `rate_limit` needs a window
  // that has not moved — retrying either burns a run to learn nothing. A 5xx is the opposite:
  // it is usually seconds long, and parking the whole TASK on the outage watch because one
  // agent of twelve caught it is far heavier than trying again. Retry it here first; the watch
  // still arms once the budget is spent, because exec-core stamps the class on the final failed
  // row either way.
  const fatal = fatalClassFromMessage(diagnostic);
  if (fatal === 'auth' || fatal === 'rate_limit') return false;
  if (NON_RETRYABLE_MINING_TERMINAL_ERROR_RE.test(diagnostic)) return false;
  return (
    fatal === 'server_error' ||
    isTransientProviderApiError(diagnostic) ||
    isTransientCliFailure({ errorMessage: diagnostic }) ||
    TRANSIENT_MINING_TERMINAL_ERROR_RE.test(diagnostic)
  );
}

/** True when a fan-out agent that produced nothing usable is worth re-dispatching from
 *  apply() via MiningRetryError.
 *
 *  Two ways an agent produces nothing, and only one is always worth a re-roll. An agent that
 *  RAN and emitted prose the jsonrepair salvage could not read usually parses on a fresh roll.
 *  An agent that DIED is re-rollable only when its failure was transient — exactly the veto
 *  `retryOnInvocationFailure` already applies at the barrier.
 *
 *  apply() used to name both kinds, which made that veto decorative: the barrier refused to
 *  re-run three reviewers killed by a 429, and apply() then asked for the same three through
 *  MiningRetryError and got them, spending a second wave of doomed calls against an exhausted
 *  quota. Callers keep the UNFILTERED list for their "incomplete" flag — an agent that died
 *  non-retryably still leaves the hole its silence must never be read as approval of.
 *
 *  An agent with no row at all is never re-rolled: nothing was asked for, so nothing is
 *  missing (mirrors MiningOutcome's `absent`). */
export function shouldRerollMiningAgent(results: AgentMiningResult[], agentId: string): boolean {
  const r = results.find((m) => m.agentId === agentId);
  if (!r) return false;
  return r.status === 'done' || shouldRetryMiningTerminalFailure(r);
}
