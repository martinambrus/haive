import { parseJsonLooseValidated } from '../_fenced-json.js';

/**
 * Does this candidate name at least one of the keys that identify the agent's OWN
 * output?
 *
 * Every step's schema defaults or optionalises nearly every field — an agent may
 * legitimately emit `{"verdict":"APPROVE"}` and nothing else — so an unguarded safeParse
 * validates ANY object as an empty, successful result. That is what lets a JSON value the
 * agent merely QUOTED stand in for the answer it never gave.
 *
 * Pass the keys the agent cannot omit and still have said anything.
 */
export function hasAnyKey(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return keys.some((key) => key in value);
}

/**
 * Parse an agent's raw step output into its validated shape, or null when the output
 * holds no such shape.
 *
 * Agents fence JSON they did not author: a reviewer quotes `composer.json` as evidence,
 * an adversary fences its JSON exploit payload as proof, a validator shows the config it
 * checked. Anchoring on the first fence — what parseJsonLoose does — takes that quoted
 * value and never sees the answer. parseJsonLooseValidated scans every candidate and
 * takes the LAST one `accept` approves, because the agent prompts all say "when finished
 * emit ONE JSON object": the answer is what it finishes with.
 *
 * `accept` must both shape-guard (see hasAnyKey) and schema-validate; returning null
 * rejects that candidate and moves on to the next.
 *
 * `raw` is the step's `output ?? rawOutput`: an already-parsed object when the CLI's
 * whole result text was strict JSON, otherwise the raw text.
 */
export function parseAgentJson<T>(
  raw: unknown,
  accept: (candidate: unknown) => T | null,
): T | null {
  if (!raw) return null;
  if (typeof raw === 'object') return accept(raw);
  if (typeof raw !== 'string') return null;
  return parseJsonLooseValidated(raw, accept);
}

/** A review names a verdict or a findings list. Anything else is not one. */
const REVIEW_KEYS = ['verdict', 'findings'] as const;

/** True when the candidate is plausibly a reviewer's own report rather than some other
 *  JSON it printed. */
export function hasReviewShape(value: unknown): value is Record<string, unknown> {
  return hasAnyKey(value, REVIEW_KEYS);
}

/**
 * parseAgentJson with the reviewer shape gate applied. Null is the caller's signal to
 * re-roll that agent (agentMining.retry) and, once its budget is spent, to degrade to a
 * visible non-approving finding — never to a silent APPROVE.
 */
export function parseReviewJson<T>(
  raw: unknown,
  accept: (candidate: unknown) => T | null,
): T | null {
  return parseAgentJson(raw, (candidate) => (hasReviewShape(candidate) ? accept(candidate) : null));
}
