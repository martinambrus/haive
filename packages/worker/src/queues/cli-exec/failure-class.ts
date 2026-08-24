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
  /orphaned by a worker restart|stopped before it finished|stream ended prematurely|cancelled or timed out|exceeded its time budget|preempted for a higher-priority task|MCP server failed to start/i;

/** Stable headline for a run that started without a capability it was configured with.
 *
 *  A declared MCP server that does not connect leaves the agent unable to do the thing the
 *  step exists to do, while the CLI still exits 0 and reports a confident answer. MEASURED: a
 *  browser-verification round whose chrome-devtools server lost a race with a cold npm cache
 *  drove no browser at all, fell back to curl, and reported a clean pass — three rounds in a
 *  row had done the same.
 *
 *  Classed TRANSIENT rather than fatal because the common cause is a package fetch losing a
 *  race, and the same fetch is warm seconds later: re-dispatching usually just works, and the
 *  existing orphan cap converges a persistently broken server to a failed step instead of an
 *  infinite re-drive. Failing the step outright would instead send an npm timeout to a code
 *  fixer with nothing to fix.
 *
 *  Same "internal contract we own end-to-end" convention as CLI_TIMEOUT_HEADLINE — written by
 *  exec-core, matched only by TRANSIENT_CLI_FAILURE_RE above. */
export const MCP_SERVER_FAILED_HEADLINE = 'MCP server failed to start';

/** Stable headline for the ONE transient case that must not be re-run identically: the
 *  CLI burned its whole budget and was SIGKILLed. Every other transient failure (worker
 *  restart, cancel, premature stream end) never got its time, so re-dispatching at the
 *  same budget is correct for them and wrong for this one — a pass that needs 40 minutes
 *  fails at 30 exactly as many times as we retry it (07b burned 3 x 31 min and produced
 *  nothing). Built by interpretCliFailure, detected by isCliTimeoutFailure, and used by
 *  step-runner to pick the next rung of the escalating timeout ladder.
 *
 *  Same "internal contract we own end-to-end" convention as OUTPUT_TRUNCATION_HEADLINE
 *  and PROVIDER_FATAL_HEADLINES — never matched against third-party CLI wording. */
export const CLI_TIMEOUT_HEADLINE = 'CLI process exceeded its time budget';

/** Stable headline for the OTHER transient case Haive inflicts on itself: the agent-preemption
 *  sweeper killed a running CLI so a higher-voted task could take its slot. Transient like the
 *  rest (the work never got to finish, so re-dispatching it identically is correct), but it must
 *  be TELLABLE from a worker-restart orphan, because every retry budget in the step runner counts
 *  orphans and none of them may count this.
 *
 *  Why that matters: MAX_ORPHAN_REDISPATCH is 3, so without the distinction a task preempted three
 *  times would FAIL — silently turning "you deprioritised this" into "this is broken", which is
 *  worse than the first-come behaviour preemption exists to replace. isCliPreemptionFailure is
 *  what every counter uses to skip these rows.
 *
 *  Deliberately NOT a prefix of CLI_TIMEOUT_HEADLINE: a preemption never spent its budget, so it
 *  must not climb the escalating timeout ladder.
 *
 *  Same "internal contract we own end-to-end" convention as CLI_TIMEOUT_HEADLINE and
 *  OUTPUT_TRUNCATION_HEADLINE — written by exec-core, read only by us. */
export const CLI_PREEMPTED_HEADLINE = 'CLI run preempted for a higher-priority task';

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

/** True when an invocation was killed specifically by its own TIMEOUT — the transient
 *  subset that earns a bigger budget on re-dispatch rather than an identical one.
 *
 *  Text-only by design: the exit signal cannot tell a timeout SIGKILL from a cancel or a
 *  worker-restart orphan (all land on a termination code or null), so the headline
 *  interpretCliFailure wrote is the only signal that separates them. */
export function isCliTimeoutFailure(sig: { errorMessage?: string | null }): boolean {
  return !!sig.errorMessage && sig.errorMessage.startsWith(CLI_TIMEOUT_HEADLINE);
}

/** True when an invocation was killed by the agent-preemption sweeper rather than by anything
 *  wrong with the run. Every consecutive-failure budget (orphan re-dispatch, timeout ladder,
 *  capability remediation, mining attempts, DAG infra retries) must SKIP these rows: preemption
 *  is a scheduling decision Haive made, so charging it to a recovery budget would let a busy
 *  machine fail a task that never actually failed.
 *
 *  Skip means skip — not "reset the count". A preemption between two genuine orphans must leave
 *  those orphans adjacent, or repeated preemption would mask a real crash loop.
 *
 *  Text-only for the same reason as isCliTimeoutFailure: the exit signal (137/null) is identical
 *  across every transient kind, so the headline is the only thing that separates them. */
export function isCliPreemptionFailure(sig: { errorMessage?: string | null }): boolean {
  return !!sig.errorMessage && sig.errorMessage.startsWith(CLI_PREEMPTED_HEADLINE);
}

/** Drop preemption rows from a step's invocation history before any consecutive-failure budget
 *  scans it. One helper rather than a skip inside each loop, so the rule is stated (and tested)
 *  once instead of three times — and so a fourth budget added later inherits it by using the same
 *  entry point.
 *
 *  Removing rather than short-circuiting is the whole point: the remaining rows stay ADJACENT, so
 *  a genuine crash loop interrupted by evictions is still counted as a crash loop. A `break` would
 *  have let repeated preemption reset every budget and mask it. */
export function withoutPreemptions<T extends { errorMessage: string | null }>(
  rows: readonly T[],
): T[] {
  return rows.filter((r) => !isCliPreemptionFailure({ errorMessage: r.errorMessage }));
}

/** Minutes an invocation was allowed before the timeout killed it, recovered from the
 *  headline interpretCliFailure wrote. Null when the message is not a timeout headline
 *  or carries no budget — callers fall back to their own knowledge of the budget rather
 *  than inventing one. */
export function cliTimeoutBudgetMinutes(errorMessage: string | null | undefined): number | null {
  if (!isCliTimeoutFailure({ errorMessage })) return null;
  const m = /\((\d+)m\)/.exec(errorMessage!);
  return m ? Number(m[1]) : null;
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
// Billing exhaustion. Checked BEFORE auth, because providers report it on a 403 that
// AUTH_RE already matches via `\b40[13]\b` — xAI's is verbatim:
//   API error (status 403 Forbidden): permission-denied: Your team <id> has either used
//   all available credits or reached its monthly spending limit. To continue making API
//   requests, please purchase more credits or raise your spending limit.
// Left to AUTH_RE that becomes "CLI authentication failed — re-authenticate your CLI",
// which is both wrong and unactionable: the credentials are fine and there is nothing to
// re-authenticate. RATE_LIMIT_RE does not catch it either ("spending limit" is not
// "usage limit", and no `quota` token appears), so it needs its own pattern rather than
// a widening of that one.
//
// VOLATILE by nature — this is human-facing billing prose, not a documented code, so a
// vendor reword silently stops matching. That is contained by design: this check only
// ever RECLASSIFIES a failure that is already fatal, so a miss falls through to exactly
// today's behaviour (auth on the 403) rather than to no classification at all.
const BILLING_EXHAUSTED_RE =
  /used all available credits|purchase more credits|spending limit|insufficient (?:credits|balance|funds)|out of credits|credit balance (?:is )?too low/i;

// `not signed in` is grok's phrasing for a rejected or absent credential. Without it that
// failure matched nothing at all and was passed through as a bare CLI error, so the step
// carried no fatal classification and no actionable hint.
//
// The last alternative's WORD BOUNDARY and same-line bound are load-bearing, not style.
// The haystack includes providerErrorScan (raw stdout+stderr), and for every claude-family
// / grok CLI that stream is NDJSON whose terminal `result` line always carries
// `input_tokens` / `output_tokens` / `cache_read_input_tokens`. A bare `token.*invalid`
// therefore matched that line in ANY failure whose error text happens to contain "invalid"
// or "expired" — measured on grok answering
// `Couldn't set model 'grok-build-0.1': Invalid params: "unknown model id"`, a model
// error reported to the user as "check your XAI_API_KEY". `\btoken\b` cannot match
// `input_tokens` (word char on both sides), and `[^\n]{0,40}?` stops a match bridging a
// whole JSON line. Do not relax either back.
// MEASURED FALSE POSITIVE (2026-08-24): an 08d adversary wrote "I'll trace logged-out privileged
// routes ... and report the unauthenticated login wall as a coverage limit" and the run was
// classified `auth` — "CLI authentication failed, run codex login" — on the strength of the bare
// word `unauthenticated` in the AGENT'S OWN ANSWER. The haystack includes providerErrorScan, i.e.
// stdout, so every adversarial-QA run is exposed: security prose is BUILT from this vocabulary
// ("unauthorized access", "returns 403", "not authenticated").
//
// Fixed by applying the discipline SERVER_ERROR_RE already had and this pattern lacked: a status
// token must carry HTTP context, and the bare adjectives are gone entirely. What remains is
// wording a CLI emits and an agent does not: API error codes, credential phrases, and imperative
// login instructions. `\b403\b` on its own was the worst of them — "all deny rules return 403"
// is a normal sentence in a security report.
//
// The status number and an HTTP reason phrase TOGETHER are specific even without a context word
// ("Unauthorized 401" is what several CLIs print), so that pairing is admitted while either half
// alone is not — "an unauthorized user can enumerate" and "deny rules return 403" both stay out.
export const AUTH_RE =
  /(?:status|http|error|code|\()[\s:/]*40[13]\b|\b(?:unauthor(?:ized|ised)|forbidden)\b[^\n]{0,12}\b40[13]\b|\b40[13]\b[^\n]{0,12}\b(?:unauthor(?:ized|ised)|forbidden)\b|authentication_error|invalid authentication credentials|permission_error|please log.?in|\bnot (?:authenticated|signed in)\b|\btoken\b[^\n]{0,40}?\b(?:expired|invalid|revoked)\b/i;
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
  // Billing first: an exhausted account answers 403, which AUTH_RE would otherwise claim.
  if (BILLING_EXHAUSTED_RE.test(haystack)) return 'rate_limit';
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

/* ------------------------------------------------------------------ */
/* Model-capability failures (auto-remediable)                         */
/* ------------------------------------------------------------------ */

/** A failure caused by a limitation of the selected MODEL rather than by the prompt,
 *  the credentials, or the provider's health. Neither is actionable by the user from
 *  the error text, and both have a mechanical remedy Haive applies itself on the next
 *  dispatch (see cli-adapters/model-capabilities.ts):
 *  - no_image_support:     the model rejects image blocks (a chrome-devtools screenshot,
 *                          an image file read). Remedy: drop the screenshot tool and tell
 *                          the agent it has no vision.
 *  - output_cap_reached:   the turn was cut off at the client's output-token ceiling.
 *                          Remedy: raise CLAUDE_CODE_MAX_OUTPUT_TOKENS one rung.
 *  - max_tokens_too_large: the provider rejected the ceiling we set as above the model's
 *                          own maximum. Remedy: roll the rung back and stop raising.
 *
 *  Distinct from ProviderFatalClass (the provider is unusable for a while) and from
 *  the transient classes (the run never got its chance): here the run genuinely happened
 *  and will fail identically until we change the request. */
export type ModelCapabilityClass =
  'no_image_support' | 'output_cap_reached' | 'max_tokens_too_large';

/** Stable headline per capability class. Built by interpretCliFailure, detected by
 *  capabilityClassFromMessage — an internal contract we own end-to-end, exactly like
 *  PROVIDER_FATAL_HEADLINES and OUTPUT_TRUNCATION_HEADLINE above. */
export const MODEL_CAPABILITY_HEADLINES: Record<ModelCapabilityClass, string> = {
  no_image_support: 'Model does not accept image input',
  output_cap_reached: 'Model hit its output-token ceiling',
  max_tokens_too_large: 'Provider rejected the requested output-token ceiling',
};

// --- Stable signal ----------------------------------------------------------
// The env var NAME is a documented Claude Code contract, so matching it is safe.
// Deliberately NOT matching the number ("32000") or the surrounding prose: both are
// version-bound and would break silently when upstream rewords or changes the default.
const OUTPUT_CAP_ENV_RE = /CLAUDE_CODE_MAX_OUTPUT_TOKENS/;

// --- VOLATILE upstream prose ------------------------------------------------
// These two match wording emitted by third-party providers. There is no stable token
// to anchor on: the HTTP status is a bare 400, which every malformed request shares.
// If upstream rewords, we simply stop matching and the step fails visibly exactly as it
// did before this feature — a loud, already-understood outcome, never a silent wrong
// branch. Revisit these when a real failure stops being auto-remediated.
const NO_IMAGE_SUPPORT_RE =
  /does not support image input|image input is not supported|does not support images\b|no vision support/i;
// Two-part on purpose: "max_tokens" alone appears in ordinary truncation messages, and
// the qualifier alone is far too generic. Both must be present.
const MAX_TOKENS_NAME_RE = /\bmax_tokens\b/i;
const MAX_TOKENS_REJECTED_RE =
  /maximum allowed|too large|must be less than|must be <=|exceeds the maximum/i;

/** Classify a model-capability failure from an ended invocation's fields, or null when
 *  the failure is something else. Gated on a real failure exit code for the same reason
 *  classifyProviderFatal is: exit 0 (success) and the termination codes (cancelled /
 *  timed out) can carry text that merely MENTIONS these conditions.
 *
 *  max_tokens_too_large is checked first: it is the more specific of the two
 *  output-token cases, and it is the one whose remedy is the opposite (lower the
 *  ceiling, not raise it), so a mis-ordered match would push the ladder the wrong way. */
export function classifyModelCapability(
  exitCode: number | null,
  errorMessage: string | null,
  rawOutput: string | null,
): ModelCapabilityClass | null {
  if (exitCode === null || exitCode === 0 || CLI_TERMINATION_EXIT_CODES.has(exitCode)) {
    return null;
  }
  const tail = typeof rawOutput === 'string' ? rawOutput.slice(-2000) : '';
  const haystack = `${errorMessage ?? ''}\n${tail}`;
  if (MAX_TOKENS_NAME_RE.test(haystack) && MAX_TOKENS_REJECTED_RE.test(haystack)) {
    return 'max_tokens_too_large';
  }
  if (NO_IMAGE_SUPPORT_RE.test(haystack)) return 'no_image_support';
  if (OUTPUT_CAP_ENV_RE.test(haystack)) return 'output_cap_reached';
  return null;
}

/** The capability class encoded in a headlined errorMessage (built by
 *  interpretCliFailure), or null when the message is not a capability message.
 *  Inverse of MODEL_CAPABILITY_HEADLINES — lets the step runner decide to remediate
 *  and re-dispatch without re-parsing raw CLI output or adding a DB column. */
export function capabilityClassFromMessage(
  message: string | null | undefined,
): ModelCapabilityClass | null {
  if (typeof message !== 'string') return null;
  for (const cls of Object.keys(MODEL_CAPABILITY_HEADLINES) as ModelCapabilityClass[]) {
    if (message.startsWith(MODEL_CAPABILITY_HEADLINES[cls])) return cls;
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

/** The claude-family binary names a provider-side fault on its result event as
 *  `terminal_reason: "api_error"`, and stream.ts stamps it into the error message as
 *  ` (terminal_reason "...")`. That stamp is OUR OWN format — written by stream.ts, read only
 *  here — which is the same "internal contract we own end-to-end" convention CLI_TIMEOUT_HEADLINE
 *  and OUTPUT_TRUNCATION_HEADLINE use, and the reason this keys on the stamp rather than on the
 *  binary's prose.
 *
 *  MEASURED: the prose is exactly what a pattern cannot hold. "API Error: Connection lost
 *  mid-response" matched nothing at all — TRANSIENT_MINING_TERMINAL_ERROR_RE lists connection
 *  closed/reset/aborted/dropped but not LOST — so four of one round's five dead verifiers were
 *  neither retried nor classified, and their findings reached the gate with no verdict.
 *
 *  Matches the VALUE, not the field: other terminal reasons (a refusal, a turn cap) are the
 *  model's own answer and re-running them is a guess. A caller must still check the fatal
 *  classes first — an api_error can be a 401 or a 429, and neither is worth a retry. */
const TRANSIENT_TERMINAL_REASON_RE = /\(terminal_reason "api_error"\)/;

export function isTransientProviderApiError(message: string | null | undefined): boolean {
  return typeof message === 'string' && TRANSIENT_TERMINAL_REASON_RE.test(message);
}

/** True when an invocation errorMessage was built for a fatal provider failure
 *  (prefixed with one of PROVIDER_FATAL_HEADLINES by interpretCliFailure). Lets
 *  looping consumers (DAG escalation, merge-fix retry) fail fast instead of
 *  spawning more agents against a dead provider. */
export function isFatalProviderFailure(message: string | null | undefined): boolean {
  return fatalClassFromMessage(message) !== null;
}
