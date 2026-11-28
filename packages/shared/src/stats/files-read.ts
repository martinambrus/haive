import { hasEnoughSamples, type SampledRatio } from './deltas.js';
import { normalizeTokens } from './tokens.js';

/**
 * The "Files read" report: which repository files agents read, ranked by how long their content
 * stayed in context, and what share of each step's prompt tokens that is.
 *
 * Source: `cli_invocations.tool_usage.reads` (`InvocationReadExposure`, one record per run), rolled
 * up by `rollupFilesRead` (`@haive/shared/stats-server`) and shaped here, purely, so every rule
 * below is unit-testable without a database.
 *
 * HONESTY RULES, each pinned by a test:
 *  - Unknown is never zero. A run whose turns could not be observed (or whose transcript was
 *    elided) carries `weightedChars: null` everywhere; it still counts toward the exact reads and
 *    characters (floors), and never toward an estimated-token figure or a share.
 *  - Every estimated-token figure and share is computed over the SAME runs: those whose weight is
 *    known (`coverage.weighted`). `share.n` is that count, so `n=` appears under
 *    `MIN_SAMPLES_FOR_TREND`.
 *  - A step's share also needs the run's `result` event (`resultSeen`; M5: a killed run's usage is
 *    wrong) and recorded token usage, and numerator and denominator cover those same runs.
 *  - The ranking, the capped remainder (`otherPaths`), the D1 overflow bucket and the combined
 *    multi-file bucket partition the repository's file-read total, so nothing is dropped silently.
 *  - Estimated tokens are characters / 4: an estimate, labelled as one beside the exact totals.
 */

/** Characters per token of the estimate. The exact figures beside it are characters and `token_usage`. */
export const FILES_READ_CHARS_PER_TOKEN = 4;
/** Paths one response ranks; the cut is reported (`files.count`, `files.truncated`, `otherPaths`). */
export const FILES_READ_ROW_LIMIT = 50;
/** Step rows one response carries; the engine has about 60 step ids. */
export const FILES_READ_STEP_LIMIT = 60;

/** One path summed over the observable runs of the scope: the SQL rollup's per-path row. */
export interface FilesReadPathRow {
  path: string;
  /** Exact over the observable runs that listed the path; a floor where a run's list overflowed
   *  (D1) or its transcript was elided. */
  reads: number;
  chars: number;
  /** Summed over the runs whose weight is known; null when none is. Unknown, never 0. */
  weightedChars: number | null;
  /** Runs `weightedChars` was summed over. */
  weightedRuns: number;
  runs: number;
  tasks: number;
}

/** One (step, provider) group of the scope's runs: the SQL rollup's group row. Sums are over the
 *  population named on each field, so a caller never has to re-filter. */
export interface FilesReadGroupRow {
  /** `task_steps.step_id` of `coalesce(task_step_id, summary_for_step_id)`. */
  stepId: string;
  /** `cli_providers.name`; null when the provider row was deleted. */
  provider: string | null;
  /** Every run in the group, whatever its record. */
  runs: number;
  /** No `reads` record and not ended yet. */
  inFlight: number;
  /** A `reads` object exists (coverage full, partial or none). */
  recorded: number;
  /** coverage full or partial: file reads can be counted. */
  observable: number;
  /** Of `observable`: coverage partial (floors, weights unknown). */
  partial: number;
  /** Of `observable`: `fileReads.weightedChars` is known. */
  weighted: number;
  /** Over `observable`: `fileReads.reads` and `.chars`. */
  fileReads: number;
  fileChars: number;
  /** Over `weighted`: `fileReads.weightedChars`. */
  weightedChars: number;
  /** Over `observable`: `overflow.omitted` (paths one run left off its list), and the runs that had any. */
  overflowOmitted: number;
  overflowRuns: number;
  overflowReads: number;
  overflowChars: number;
  /** Over `weighted`. */
  overflowWeightedChars: number;
  /** Over `observable`: the combined output of a shell call that read several files. */
  multiFileRuns: number;
  multiFileReads: number;
  multiFileChars: number;
  /** Over `weighted`. */
  multiFileWeightedChars: number;
  /** Runs the step share is over: `weighted`, `resultSeen`, and a positive prompt side recorded. */
  shareRuns: number;
  /** Over `shareRuns`: `fileReads.weightedChars` and the RAW `token_usage` buckets. */
  shareWeightedChars: number;
  shareInputTokens: number;
  shareOutputTokens: number;
  shareCacheReadTokens: number;
  shareCacheCreationTokens: number;
}

export interface FilesReadRollup {
  /** The top `FILES_READ_ROW_LIMIT` paths and the number of distinct paths before the cut. */
  paths: { rows: FilesReadPathRow[]; count: number };
  groups: FilesReadGroupRow[];
}

/** How many of the scope's runs the report can speak for. `total = recorded + unrecorded + inFlight`,
 *  `recorded = observable + unobservable`. */
export interface FilesReadCoverage {
  total: number;
  recorded: number;
  observable: number;
  /** Of `observable`: floors, weights unknown. */
  partial: number;
  /** Examined and not observable on this path (coverage none: amp, gemini, a run with no transcript). */
  unobservable: number;
  /** Ended with no `reads` record: an older row, a JSON null, or a backfill that has not reached it. */
  unrecorded: number;
  inFlight: number;
  /** Of `observable`: weight known. The population of every estimated-token figure and share. */
  weighted: number;
}

export interface FilesReadProviderCoverage extends FilesReadCoverage {
  provider: string | null;
}

export interface FilesReadFileRow extends FilesReadPathRow {
  /** `weightedChars / 4`; null exactly when `weightedChars` is. */
  estimatedTokens: number | null;
  /** Of the repository's file-read tokens; `n` = `coverage.weighted`. */
  share: SampledRatio;
}

/** A slice of the repository's file reads that has no path row of its own. */
export interface FilesReadBucket {
  reads: number;
  chars: number;
  /** null when no run's weight is known. */
  estimatedTokens: number | null;
  share: SampledRatio;
}

export interface FilesReadStepRow {
  stepId: string;
  /** Every run of the step in scope. */
  runs: number;
  /** Over the share runs (`share.n` of them): estimated file tokens and exact prompt tokens
   *  (fresh + cache read + cache creation, normalised per provider). null when `share.n` is 0. */
  estimatedTokens: number | null;
  promptTokens: number | null;
  /** `estimatedTokens / promptTokens`; `n` = the share runs. */
  share: SampledRatio;
  /** The estimate exceeds the exact denominator. Impossible for a true share, so it is shown and
   *  flagged, never clamped. */
  exceedsPrompt: boolean;
}

export interface FilesReadReport {
  coverage: FilesReadCoverage & { byProvider: FilesReadProviderCoverage[] };
  /** Exact over the observable runs, the estimate beside them. */
  totals: { fileReads: number; fileChars: number; estimatedTokens: number | null };
  /** Ranked by weighted characters (unknown last), then characters, then path. */
  files: { rows: FilesReadFileRow[]; count: number; truncated: boolean };
  /** Paths beyond the ranked rows. */
  otherPaths: FilesReadBucket & { paths: number };
  /** D1: what runs' own file lists cut off. `omitted` counts a path once per run that omitted it. */
  overflow: FilesReadBucket & { omitted: number; runs: number };
  multiFile: FilesReadBucket & { runs: number };
  /** Ranked by estimated tokens (unknown last), then runs, then step id. */
  steps: { rows: FilesReadStepRow[]; count: number; truncated: boolean };
}

/** Code point order, the order `COLLATE "C"` gives on UTF-8. `<` compares UTF-16 code units, which
 *  puts an astral character (a surrogate pair) before U+E000..U+FFFF. */
const byCodePoint = (a: string, b: string): number => {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i)!;
    const y = b.codePointAt(j)!;
    if (x !== y) return x < y ? -1 : 1;
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
  }
  return Math.sign(a.length - i - (b.length - j));
};

const providerOrder = (a: string | null, b: string | null): number => {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return byCodePoint(a, b);
};

const nullLastDesc = (a: number | null, b: number | null): number => {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
};

function sumCoverage(groups: FilesReadGroupRow[]): FilesReadCoverage {
  const c = { total: 0, recorded: 0, observable: 0, partial: 0, inFlight: 0, weighted: 0 };
  for (const g of groups) {
    c.total += g.runs;
    c.recorded += g.recorded;
    c.observable += g.observable;
    c.partial += g.partial;
    c.inFlight += g.inFlight;
    c.weighted += g.weighted;
  }
  return {
    ...c,
    unobservable: c.recorded - c.observable,
    unrecorded: c.total - c.recorded - c.inFlight,
  };
}

/** Shape a rollup into the report. Pure and total: every rule in the header is applied here. */
export function buildFilesRead(rollup: FilesReadRollup): FilesReadReport {
  const { groups } = rollup;
  const sum = (pick: (g: FilesReadGroupRow) => number): number =>
    groups.reduce((acc, g) => acc + pick(g), 0);

  const coverage = sumCoverage(groups);
  const providers = [...new Set(groups.map((g) => g.provider))].sort(providerOrder);
  const byProvider: FilesReadProviderCoverage[] = providers
    .map((provider) => ({
      provider,
      ...sumCoverage(groups.filter((g) => g.provider === provider)),
    }))
    .sort((a, b) => b.total - a.total || providerOrder(a.provider, b.provider));

  const W = coverage.weighted;
  const T = sum((g) => g.weightedChars);
  const estimate = (part: number | null): number | null =>
    part !== null && W > 0 ? part / FILES_READ_CHARS_PER_TOKEN : null;
  const shareOf = (part: number | null): SampledRatio => ({
    ratio: part !== null && W > 0 && T > 0 ? part / T : null,
    n: W,
    sufficient: hasEnoughSamples(W),
  });
  const bucket = (reads: number, chars: number, weighted: number): FilesReadBucket => {
    const part = W > 0 ? weighted : null;
    return { reads, chars, estimatedTokens: estimate(part), share: shareOf(part) };
  };

  const ranked = [...rollup.paths.rows].sort(
    (a, b) =>
      nullLastDesc(a.weightedChars, b.weightedChars) ||
      b.chars - a.chars ||
      byCodePoint(a.path, b.path),
  );
  const fileRows: FilesReadFileRow[] = ranked.map((r) => ({
    ...r,
    estimatedTokens: r.weightedChars === null ? null : r.weightedChars / FILES_READ_CHARS_PER_TOKEN,
    share: shareOf(r.weightedChars),
  }));

  const overflowReads = sum((g) => g.overflowReads);
  const overflowChars = sum((g) => g.overflowChars);
  const overflowWeighted = sum((g) => g.overflowWeightedChars);
  const multiReads = sum((g) => g.multiFileReads);
  const multiChars = sum((g) => g.multiFileChars);
  const multiWeighted = sum((g) => g.multiFileWeightedChars);
  const fileReads = sum((g) => g.fileReads);
  const fileChars = sum((g) => g.fileChars);
  const rowSum = (pick: (r: FilesReadPathRow) => number | null): number =>
    ranked.reduce((acc, r) => acc + (pick(r) ?? 0), 0);

  const otherPaths = {
    paths: Math.max(0, rollup.paths.count - ranked.length),
    ...bucket(
      Math.max(0, fileReads - rowSum((r) => r.reads) - overflowReads - multiReads),
      Math.max(0, fileChars - rowSum((r) => r.chars) - overflowChars - multiChars),
      Math.max(0, T - rowSum((r) => r.weightedChars) - overflowWeighted - multiWeighted),
    ),
  };

  const stepIds = [...new Set(groups.map((g) => g.stepId))];
  const steps = stepIds
    .map((stepId): FilesReadStepRow => {
      let runs = 0;
      let n = 0;
      let est = 0;
      let prompt = 0;
      for (const g of groups) {
        if (g.stepId !== stepId) continue;
        runs += g.runs;
        if (g.provider === null || g.shareRuns <= 0) continue;
        n += g.shareRuns;
        est += g.shareWeightedChars / FILES_READ_CHARS_PER_TOKEN;
        const t = normalizeTokens({
          provider: g.provider,
          inputTokens: g.shareInputTokens,
          outputTokens: g.shareOutputTokens,
          cacheReadTokens: g.shareCacheReadTokens,
          cacheCreationTokens: g.shareCacheCreationTokens,
        });
        prompt += t.freshInputTokens + t.cacheReadTokens + t.cacheCreationTokens;
      }
      if (n === 0) {
        return {
          stepId,
          runs,
          estimatedTokens: null,
          promptTokens: null,
          share: { ratio: null, n: 0, sufficient: false },
          exceedsPrompt: false,
        };
      }
      const ratio = prompt > 0 ? est / prompt : null;
      return {
        stepId,
        runs,
        estimatedTokens: est,
        promptTokens: prompt,
        share: { ratio, n, sufficient: hasEnoughSamples(n) },
        exceedsPrompt: ratio !== null && ratio > 1,
      };
    })
    .sort(
      (a, b) =>
        nullLastDesc(a.estimatedTokens, b.estimatedTokens) ||
        b.runs - a.runs ||
        byCodePoint(a.stepId, b.stepId),
    );
  const stepRows = steps.slice(0, FILES_READ_STEP_LIMIT);

  return {
    coverage: { ...coverage, byProvider },
    totals: { fileReads, fileChars, estimatedTokens: estimate(T) },
    files: {
      rows: fileRows,
      count: rollup.paths.count,
      truncated: rollup.paths.count > fileRows.length,
    },
    otherPaths,
    overflow: {
      ...bucket(overflowReads, overflowChars, overflowWeighted),
      omitted: sum((g) => g.overflowOmitted),
      runs: sum((g) => g.overflowRuns),
    },
    multiFile: {
      ...bucket(multiReads, multiChars, multiWeighted),
      runs: sum((g) => g.multiFileRuns),
    },
    steps: { rows: stepRows, count: steps.length, truncated: steps.length > stepRows.length },
  };
}
