/** Health of a live CLI stream: is it retrying, or has it simply gone quiet.
 *
 *  Its own tested module for the same reason lib/step-banners is one — the wording and the
 *  threshold are the whole feature, and both are easy to get subtly wrong in JSX.
 *
 *  Two INDEPENDENT signals, deliberately not merged:
 *
 *  - A retry is EVIDENCE. The claude-family binaries emit one
 *    `{"type":"system","subtype":"api_retry",…}` line per attempt, and the worker forwards it as
 *    a typed frame. The reason comes from the event's own fields, so the badge can say what is
 *    actually wrong rather than guessing.
 *  - A stall is an OBSERVATION: no frame of any kind for a while. It is the only signal available
 *    for the CLIs that emit no retry event at all (codex, gemini, amp, grok), and the only one
 *    that catches a run which never produced a byte in the first place.
 *
 *  The copy keeps that split. A retry says what happened; a stall says only what was observed,
 *  because the CLI being mid-way through one long tool call looks identical from out here. */

/** An `api_retry` event, carried verbatim from the CLI's own stream. `maxRetries`, `errorStatus`
 *  and `error` are all optional because a future event shape may drop any of them, and a missing
 *  field must degrade the wording rather than break it. */
export interface CliRetryInfo {
  attempt: number;
  maxRetries: number | null;
  errorStatus: number | null;
  error: string | null;
}

/** How long a live stream may produce nothing before the badge calls it stalled.
 *
 *  Five minutes because the clock is stamped by EVERY frame, and the chatty
 *  `system`/`thinking_tokens` lines most models emit while reasoning keep it armed on their own —
 *  a thinking model is never silent for this long. What is left on the false-positive side is a
 *  single long tool call (a build, a test suite, a ddev boot), which streams nothing at all
 *  between `tool_use` and its `tool_result`. Hence the deliberately factual stall copy. */
export const STALL_THRESHOLD_MS = 5 * 60_000;

/** `rate_limit` -> `Rate limit`. Fallback path only — used when the status code is one we have
 *  no wording for, so the CLI's own word is better than a number on its own. */
function humanize(word: string): string {
  const spaced = word.replace(/_/g, ' ').trim();
  if (!spaced) return '';
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Why the CLI is retrying, keyed on the HTTP status (a stable contract) and falling back to the
 *  event's own `error` word verbatim for anything we have not seen. A missing status means no
 *  HTTP response arrived at all — that is the transport failure, not a server answer. */
export function describeRetryReason(info: CliRetryInfo): string {
  const status = info.errorStatus;
  const word = info.error && info.error !== 'unknown' ? humanize(info.error) : '';
  if (status === null || status === undefined) {
    return word || 'Connection problem';
  }
  if (status === 429) return 'Rate limited';
  if (status === 529) return 'Provider overloaded';
  if (status >= 500) return `Server error (${status})`;
  return word ? `${word} (${status})` : `HTTP ${status}`;
}

/** `label` is the compact text beside the icon; `detail` is the tooltip / screen-reader sentence. */
export interface StreamHealthCopy {
  label: string;
  detail: string;
}

export function describeRetry(info: CliRetryInfo): StreamHealthCopy {
  const reason = describeRetryReason(info);
  const of =
    info.maxRetries && info.maxRetries > 0
      ? `${info.attempt}/${info.maxRetries}`
      : `${info.attempt}`;
  return {
    label: of,
    detail: `${reason} — the CLI is retrying (attempt ${of}). Output resumes on its own if a retry succeeds.`,
  };
}

/** True once a live stream has been silent past the threshold. `lastFrameAt` is null until the
 *  first frame arrives, in which case the connect time stands in — a run that never produces a
 *  byte is exactly the case worth catching. */
export function isStalled(lastFrameAt: number | null, now: number): boolean {
  if (lastFrameAt === null) return false;
  return now - lastFrameAt >= STALL_THRESHOLD_MS;
}

export function describeStall(lastFrameAt: number, now: number): StreamHealthCopy {
  const minutes = Math.max(1, Math.floor((now - lastFrameAt) / 60_000));
  return {
    label: `${minutes}m`,
    detail: `No output for ${minutes} min. The CLI may be stuck or unable to reach its provider — or it may be part-way through one long tool call, which streams nothing until it finishes.`,
  };
}
