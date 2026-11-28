export interface StepOutputUsage {
  outputTokens: number | null;
  totalTokens: number;
  outputUnknownRuns?: number;
}

/** Task-level output: summed over steps that reported one, null when every step with usage is unknown. */
export function sumStepOutputTokens(usages: ReadonlyArray<StepOutputUsage | null | undefined>): {
  output: number | null;
  unknownRuns: number;
} {
  let output: number | null = null;
  let unknownRuns = 0;
  let any = false;
  for (const u of usages) {
    if (!u) continue;
    any = true;
    if (u.outputTokens !== null) output = (output ?? 0) + u.outputTokens;
    const unknown = u.outputUnknownRuns ?? 0;
    unknownRuns += u.outputTokens === null && u.totalTokens > 0 ? Math.max(unknown, 1) : unknown;
  }
  return { output: any ? output : 0, unknownRuns };
}
