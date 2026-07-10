import { parseJsonLooseValidated } from '../_fenced-json.js';

/**
 * Is this candidate plausibly a reviewer's own output, rather than some other JSON it
 * happened to print?
 *
 * Every field in the reviewer schemas is optional (a reviewer may legitimately emit
 * `{"verdict":"APPROVE"}` and nothing else), so an unguarded safeParse validates ANY
 * object as an empty, non-blocking, non-approving-but-silent review. Combined with the
 * first-match parse that used to sit under these parsers, a reviewer that fenced a
 * `.json` file as evidence before its verdict had that evidence accepted as its review:
 * a critical REQUEST_CHANGES silently became DISCUSS with zero findings, which does not
 * block, does not mark the review incomplete, and shows OK at gate 2.
 *
 * A review names a verdict or a findings list. Anything else is not one.
 */
export function hasReviewShape(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return 'verdict' in value || 'findings' in value;
}

/**
 * Parse a reviewer/adversary agent's raw output into its validated shape, or null when
 * the output holds no review at all — which is the caller's signal to re-roll that agent
 * (agentMining.retry) and, once its budget is spent, to degrade to a visible
 * non-approving finding.
 *
 * `raw` is `output ?? rawOutput` from the mining row: an already-parsed object when the
 * CLI's whole result text was strict JSON, otherwise the raw text.
 */
export function parseReviewJson<T>(
  raw: unknown,
  accept: (candidate: unknown) => T | null,
): T | null {
  if (!raw) return null;
  const gated = (candidate: unknown): T | null =>
    hasReviewShape(candidate) ? accept(candidate) : null;
  if (typeof raw === 'object') return gated(raw);
  if (typeof raw !== 'string') return null;
  return parseJsonLooseValidated(raw, gated);
}
