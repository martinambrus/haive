/** Compact token count: 1.2k / 2.5M, raw under 1000. Shared by the per-step
 *  token badge, the task total-time card, and the per-invocation terminal header
 *  so token figures format the same everywhere. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
