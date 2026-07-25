/** Bounds for the user-chosen CLI timeout on "Retry with longer timeout".
 *
 *  Mirrors `stepActionRequestSchema.timeoutMinutes` in @haive/shared. Duplicated rather
 *  than imported because pulling a value out of the shared barrel drags ioredis (and
 *  through it `node:dns`) into the browser bundle; the server still validates, so this
 *  copy only has to keep the UI from posting something it knows will be rejected. */
export const RETRY_TIMEOUT_MIN_MINUTES = 15;
export const RETRY_TIMEOUT_MAX_MINUTES = 480;

/** What to pre-fill the retry prompt with, given the budget that just failed.
 *
 *  Never below what already timed out: offering 120 to a step that just burned 180
 *  would silently propose a SHORTER budget than the one that failed, which is the
 *  opposite of what the button is for. Doubling the last budget is the natural next
 *  guess, floored at 120 so the common 45/60/90 ladder lands somewhere useful. */
export function defaultRetryTimeoutMinutes(lastBudgetMinutes: number): number {
  const doubled = Number.isFinite(lastBudgetMinutes) ? Math.round(lastBudgetMinutes) * 2 : 0;
  return Math.min(RETRY_TIMEOUT_MAX_MINUTES, Math.max(120, doubled));
}

/** Parse what the user typed into the retry prompt.
 *
 *  Returns null for a cancelled prompt (`null` input), blank text, or anything that is
 *  not a number — those mean "don't retry", not "retry with a guessed budget". A number
 *  outside the bounds is clamped rather than rejected: the user's intent is clear and
 *  making them re-type it helps nobody. */
export function parseRetryTimeoutMinutes(raw: string | null): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(
    RETRY_TIMEOUT_MAX_MINUTES,
    Math.max(RETRY_TIMEOUT_MIN_MINUTES, Math.round(parsed)),
  );
}
