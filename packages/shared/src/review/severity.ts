/** The single severity ladder every review, audit and QA step emits.
 *
 *  Ordered most→least severe. `critical` and `high` are the blocking tier: a
 *  finding at either costs a fix round, so a reviewer must not reach for them
 *  to add emphasis.
 */
export const REVIEW_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;

export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];

/** Severity-weighted scoring, so a critical miss outweighs a low-severity one
 *  instead of both counting as "a finding". Weights follow the published
 *  DoorDash DashBench ladder. */
export const SEVERITY_WEIGHTS: Record<ReviewSeverity, number> = {
  critical: 4,
  high: 2,
  medium: 1,
  low: 0.5,
};

/** The blocking tier. A finding at this severity routes back to implementation
 *  through the fix loop; anything below surfaces as advisory at the gate. */
export function isBlockingSeverity(severity: ReviewSeverity): boolean {
  return severity === 'critical' || severity === 'high';
}

/** Rank for sorting/deduping: lower is more severe. */
export function severityRank(severity: ReviewSeverity): number {
  return REVIEW_SEVERITIES.indexOf(severity);
}

/** Vocabularies that predate the canonical ladder.
 *
 *  This is NOT a convenience shim for sloppy prompts — every prompt we own emits
 *  the canonical ladder. It exists because a reviewer prompt defers to the repo's
 *  own `.claude/agents/<id>.md` when one is present ("follow it; otherwise follow
 *  the protocol below"), and a repo onboarded before this change has personas on
 *  disk that still specify the old vocabulary. Those files are data we do not
 *  control and cannot rewrite without an onboarding upgrade, so their output has
 *  to keep parsing. Dropping the alias table would silently turn every finding
 *  from such a repo into an unparseable review.
 */
const LEGACY_ALIASES: Record<string, ReviewSeverity> = {
  // peer / lens / code-audit: critical|warning|suggestion
  warning: 'medium',
  suggestion: 'low',
  // code-reviewer persona: blocker|major|minor|nit
  blocker: 'critical',
  major: 'high',
  minor: 'medium',
  nit: 'low',
  // spec quality + spec audit: warn|error (+ legacy info)
  error: 'high',
  warn: 'medium',
  info: 'low',
  // spec-quality-reviewer persona: blocking|weak
  blocking: 'high',
  weak: 'medium',
};

/** Coerce any reviewer-supplied severity onto the canonical ladder.
 *
 *  Unknown values fall back to `fallback` rather than being dropped: a finding
 *  with a strange severity is still a finding, and silently discarding it is the
 *  one outcome the review step exists to prevent. Callers pass a fallback that
 *  is safe for their step — never `critical`, which would let a typo burn a fix
 *  round.
 */
export function coerceReviewSeverity(raw: unknown, fallback: ReviewSeverity): ReviewSeverity {
  if (typeof raw !== 'string') return fallback;
  const key = raw.trim().toLowerCase();
  if ((REVIEW_SEVERITIES as readonly string[]).includes(key)) return key as ReviewSeverity;
  return LEGACY_ALIASES[key] ?? fallback;
}
