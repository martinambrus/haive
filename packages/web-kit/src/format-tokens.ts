/** Compact token count: 1.2k / 2.5M, raw under 1000. Shared by the per-step
 *  token badge, the task total-time card, and the per-invocation terminal header
 *  so token figures format the same everywhere. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

const AT_LEAST = '≥ ';

/** Output tokens that may be unknown: a dash for null, a lower bound mark when runs are unknown. */
export function formatOutputTokens(output: number | null | undefined, unknownRuns = 0): string {
  if (output === null || output === undefined) return '—';
  return (unknownRuns > 0 ? AT_LEAST : '') + formatTokens(output);
}

/** A total that leaves out the output of `unknownRuns` runs, so it is a lower bound. */
export function formatTokensAtLeast(total: number, unknownRuns = 0): string {
  return (unknownRuns > 0 ? AT_LEAST : '') + formatTokens(total);
}

/** Full-precision count for tooltips. */
export function fullTokens(n: number | null | undefined, unknownRuns = 0): string {
  if (n === null || n === undefined) return 'unknown';
  return (unknownRuns > 0 ? 'at least ' : '') + n.toLocaleString();
}
