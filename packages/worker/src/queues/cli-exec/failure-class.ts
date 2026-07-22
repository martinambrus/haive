/* ------------------------------------------------------------------ */
/* LLM stream failure classification                                   */
/* ------------------------------------------------------------------ */

/** Classification of a non-success LLM `result` event, derived from its subtype
 *  + error fields. Output truncation (the model hit its OUTPUT-token ceiling and
 *  the turn was cut off) and context overflow (the INPUT exceeded the context
 *  window) need opposite remedies — split/shrink the output vs shrink the prompt —
 *  so they are surfaced distinctly instead of as one generic "stream failed". */
export type CliFailureClass = 'output_truncated' | 'context_overflow' | 'generic';

/** Stable headline for an output-truncation failure message. Used to BUILD the
 *  message (stream.ts) and to DETECT it downstream (step-runner retry) without a
 *  DB column. It is an internal contract we own end-to-end, not a parse of an
 *  upstream/ephemeral string, so matching on it is safe. */
export const OUTPUT_TRUNCATION_HEADLINE = 'LLM output truncated (max output tokens)';

// stop_reason / error tokens that mean the assistant hit its output cap mid-turn.
// Covers Anthropic/Amp/Zai/Qwen stream-json ("max_tokens"), and the explicit
// max_output_tokens spelling. Kept tight — bare "length" is too false-positive.
const OUTPUT_TRUNCATION_RE = /\bmax_tokens\b|max_output_tokens|output[_\s-]?token[_\s-]?limit/i;

// Tokens that mean the INPUT exceeded the model's context window (a different
// failure with the opposite fix). Distinct from output truncation above.
const CONTEXT_OVERFLOW_RE =
  /prompt is too long|context[_\s-]?length[_\s-]?exceeded|model_context_window_exceeded|exceed(?:s|ed)? the (?:model'?s )?context (?:window|length)/i;

/** Classify a non-success stream result from its subtype + error fields. Context
 *  overflow is checked first because such a message can also mention tokens. */
export function classifyStreamFailure(
  subtype: string | null,
  error: string | null,
): CliFailureClass {
  const haystack = `${subtype ?? ''} ${error ?? ''}`;
  if (CONTEXT_OVERFLOW_RE.test(haystack)) return 'context_overflow';
  if (OUTPUT_TRUNCATION_RE.test(haystack)) return 'output_truncated';
  return 'generic';
}

/** True when an invocation errorMessage was produced for an output-truncation
 *  failure (built with OUTPUT_TRUNCATION_HEADLINE by stream.ts). */
export function isOutputTruncationMessage(message: string | null | undefined): boolean {
  return typeof message === 'string' && message.startsWith(OUTPUT_TRUNCATION_HEADLINE);
}

/* ------------------------------------------------------------------ */
/* Transient (recoverable) failures — killed / orphaned / timed out    */
/* ------------------------------------------------------------------ */

/** Exit codes that mean the process was TERMINATED before finishing (SIGINT 130,
 *  SIGKILL 137, SIGTERM 143) — mirrors exec-core's TERMINATION_EXIT_CODES. A null
 *  exit code is the same case (a worker restart orphaned the run, or the spawn
 *  killed the client on timeout/abort, before an exit was recorded). */
export const CLI_TERMINATION_EXIT_CODES: ReadonlySet<number> = new Set([130, 137, 143]);

/** Invariant marker phrases proving an invocation was KILLED / ORPHANED / cut off
 *  mid-run rather than finishing — the recoverable transient case. Sourced from the
 *  EXACT strings the runtime writes: task-queue.ts (worker-restart orphan),
 *  exec-core.ts (stop/cancel/timeout), stream.ts (premature stream end). Stable
 *  internal contracts we own end-to-end, never ephemeral upstream wording. */
export const TRANSIENT_CLI_FAILURE_RE =
  /orphaned by a worker restart|stopped before it finished|stream ended prematurely|cancelled or timed out/i;

/** True when an ended invocation did not finish under its own power — it was killed,
 *  orphaned by a worker restart, cancelled, or timed out — so its "failure" is an
 *  infrastructure event, not the model's fault. The correct recovery is to RE-DISPATCH
 *  the never-completed work (bounded by a per-site attempt cap), NOT to fail the step.
 *  Keyed on the STABLE exit signal + invariant markers. Pass `exitCode: undefined` to
 *  classify from text alone (no exit signal available). */
export function isTransientCliFailure(sig: {
  exitCode?: number | null;
  errorMessage?: string | null;
}): boolean {
  const killedByExit =
    sig.exitCode === null ||
    (typeof sig.exitCode === 'number' && CLI_TERMINATION_EXIT_CODES.has(sig.exitCode));
  return killedByExit || (!!sig.errorMessage && TRANSIENT_CLI_FAILURE_RE.test(sig.errorMessage));
}

/* ------------------------------------------------------------------ */
/* Fatal (non-retryable) provider failures                             */
/* ------------------------------------------------------------------ */

/** A provider-level failure that will NOT recover within this task run, so
 *  retrying or escalating (DAG advisor/replanner, merge-fix loop) only burns
 *  more doomed CLI calls. The right reaction is to fail the task fast; the user
 *  retries (existing Retry resumes the failed step) once the provider is back.
 *  - rate_limit: 429 / quota / weekly-or-monthly usage limit exhausted.
 *  - auth:       persistent 401/403 — credentials invalid/expired, re-auth needed.
 *  - server_error: provider 5xx / overloaded / service unavailable. */
export type ProviderFatalClass = 'rate_limit' | 'auth' | 'server_error';

/** Stable headline per fatal class. Used to BUILD the invocation errorMessage
 *  (exec-core's interpretCliFailure) and to DETECT it downstream
 *  (isFatalProviderFailure) without a DB column — an internal contract we own
 *  end-to-end, exactly like OUTPUT_TRUNCATION_HEADLINE above. The 'auth' headline
 *  intentionally matches the pre-existing "CLI authentication failed —" message
 *  prefix so the established auth-failure copy is preserved while becoming
 *  detectable as fatal. */
export const PROVIDER_FATAL_HEADLINES: Record<ProviderFatalClass, string> = {
  rate_limit: 'Provider rate limit or quota exhausted',
  auth: 'CLI authentication failed',
  server_error: 'Provider server error (service unavailable)',
};

// --- Volatile upstream text -------------------------------------------------
// These patterns match text emitted by third-party CLIs / provider APIs. The
// HTTP status tokens (429 / 5xx / 529) are stable HTTP-contract invariants, but
// the surrounding prose ("Request rejected", "you have reached your…") is upstream
// wording that can change. We therefore (a) anchor on the stable status tokens
// plus a small set of standard phrases, and (b) only classify when the exit code
// is a REAL failure (see classifyProviderFatal's gate) so a coder that merely
// prints a status code in *successful* output (exit 0) is never misclassified.
// Keep tight — bare 5xx is deliberately NOT matched (line numbers, "500ms",
// "$500" are too false-positive); 5xx must carry HTTP context.
const RATE_LIMIT_RE =
  /\b429\b|too[_\s-]?many[_\s-]?requests|\brate[_\s-]?limit(?:ed|ing)?\b|\b(?:usage|session) limit\b|quota[_\s-]?(?:exceeded|exhausted|reached|limit)|\boverage\b/i;
const AUTH_RE =
  /\b40[13]\b|authentication_error|invalid authentication credentials|\bunauthorized\b|\bunauthenticated\b|permission_error|please log.?in|not authenticated|token.*(?:expired|invalid)/i;
const SERVER_ERROR_RE =
  /\b529\b|(?:status|http|error|code|\()[\s:/]*5\d{2}\b|\b5\d{2}\b\s*(?:error|status|service|unavailable|gateway|bad gateway|overloaded)|service unavailable|bad gateway|gateway time-?out|internal server error|\boverloaded\b/i;

/** Classify a fatal (non-retryable) provider failure from an ended invocation's
 *  fields, or null when the failure is ordinary (retry/escalate as before).
 *  Gated on a real failure exit code: exit 0 (success), null/130/137/143
 *  (cancelled/timed-out) are never fatal-provider errors. errorMessage is the
 *  primary signal (stream.ts already surfaces rate-limit/quota there for
 *  stream-json CLIs); the rawOutput TAIL is a fallback for CLIs that only print
 *  the API error to stdout. Auth is checked first (most actionable + preserves
 *  the existing auth-failure message). */
export function classifyProviderFatal(
  exitCode: number | null,
  errorMessage: string | null,
  rawOutput: string | null,
): ProviderFatalClass | null {
  if (exitCode === null || exitCode === 0 || CLI_TERMINATION_EXIT_CODES.has(exitCode)) {
    return null;
  }
  const tail = typeof rawOutput === 'string' ? rawOutput.slice(-2000) : '';
  const haystack = `${errorMessage ?? ''}\n${tail}`;
  if (AUTH_RE.test(haystack)) return 'auth';
  if (RATE_LIMIT_RE.test(haystack)) return 'rate_limit';
  if (SERVER_ERROR_RE.test(haystack)) return 'server_error';
  return null;
}

// agy (Google Antigravity) exits 0 and prints NOTHING on a provider-fatal error,
// writing it only to its --log-file as a glog line, e.g.:
//   E0710 .. log.go:398] agent executor error: RESOURCE_EXHAUSTED (code 429): Individual quota reached .. Resets in 167h.
// We anchor on agy's gRPC status token QUALIFIED by the executor-error/(code NNN) line
// shape — NOT the generic RATE_LIMIT_RE — because the debug log can carry repo file
// text the agent read (a source file discussing "429"/"quota" would false-positive on
// a healthy run). A gRPC token appearing in logged repo content lacks that line shape.
const AGY_FATAL_LINE_RE = /agent executor error:|\(code\s+\d+\)/i;
const AGY_STATUS_CLASS: ReadonlyArray<readonly [RegExp, ProviderFatalClass]> = [
  [/\bRESOURCE_EXHAUSTED\b/, 'rate_limit'],
  [/\b(?:UNAUTHENTICATED|PERMISSION_DENIED)\b/, 'auth'],
  [/\b(?:UNAVAILABLE|INTERNAL|DEADLINE_EXCEEDED)\b/, 'server_error'],
];

/** Classify a provider-fatal error from agy's captured log tail (antigravity only).
 *  agy swallows quota/auth/5xx to its log and exits 0 with empty output, so this is
 *  the only classifiable signal — see interpretCliFailure, which gates the call on
 *  empty output. Returns the fatal class plus the matched line (glog prefix stripped)
 *  for the message detail, or null when the log shows no executor-level fatal status. */
export function classifyAntigravityDiagnostic(
  log: string | null | undefined,
): { class: ProviderFatalClass; detail: string } | null {
  if (typeof log !== 'string' || log.length === 0) return null;
  for (const raw of log.split('\n')) {
    if (!AGY_FATAL_LINE_RE.test(raw)) continue;
    for (const [re, cls] of AGY_STATUS_CLASS) {
      if (re.test(raw)) {
        // Strip the leading glog prefix ("E0710 12:34:56.7 10 log.go:398] ") so the
        // detail reads as the human error ("RESOURCE_EXHAUSTED (code 429): .. Resets in …").
        const detail = raw.replace(/^[EIWF]\d{4}\s+[\d:.]+\s+\d+\s+\S+\]\s*/, '').trim();
        return { class: cls, detail };
      }
    }
  }
  return null;
}

/** The fatal class encoded in a headlined errorMessage (built by interpretCliFailure),
 *  or null when the message is not a fatal-provider message. Inverse of
 *  PROVIDER_FATAL_HEADLINES — lets a consumer derive the UI hint's `reason` from the
 *  stored message without a DB column. */
export function fatalClassFromMessage(
  message: string | null | undefined,
): ProviderFatalClass | null {
  if (typeof message !== 'string') return null;
  for (const cls of Object.keys(PROVIDER_FATAL_HEADLINES) as ProviderFatalClass[]) {
    if (message.startsWith(PROVIDER_FATAL_HEADLINES[cls])) return cls;
  }
  return null;
}

/** True when an invocation errorMessage was built for a fatal provider failure
 *  (prefixed with one of PROVIDER_FATAL_HEADLINES by interpretCliFailure). Lets
 *  looping consumers (DAG escalation, merge-fix retry) fail fast instead of
 *  spawning more agents against a dead provider. */
export function isFatalProviderFailure(message: string | null | undefined): boolean {
  return fatalClassFromMessage(message) !== null;
}
