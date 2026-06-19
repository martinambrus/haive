/** Extract a human-readable per-step recap from a step's apply output, used to
 *  fill task_steps.summary synchronously for steps that already emit a curated
 *  summary field. Returns the first non-empty of findingsSummary > summary >
 *  notes, or null when the output carries none — the async LLM summarizer then
 *  fills task_steps.summary instead. */
const SUMMARY_KEYS = ['findingsSummary', 'summary', 'notes'] as const;

export function resolveCuratedSummary(output: unknown): string | null {
  if (!output || typeof output !== 'object') return null;
  const obj = output as Record<string, unknown>;
  for (const key of SUMMARY_KEYS) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}
