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
