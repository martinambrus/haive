import { hasEnoughSamples } from './deltas.js';

/** One invocation's inputs. `outputTokens` null means the CLI reported no usage, so the run
 *  enters neither side; `apiMs` null means the CLI reports no model time (codex, amp). */
export interface ThroughputRun {
  outputTokens: number | null;
  wallMs: number | null;
  apiMs: number | null;
}

export interface ThroughputSide {
  /** Σ output tokens / Σ seconds over the runs on this side; null when there are none. */
  tps: number | null;
  /** Runs this side was computed from. */
  n: number;
  sufficient: boolean;
}

export interface ThroughputSummary {
  /** Output tokens per second of wall clock: tool runs and sandbox time included. */
  wall: ThroughputSide;
  /** Output tokens per second of model time, prompt processing included. */
  api: ThroughputSide & {
    /** Median of the per-run rates, beside the aggregate because one long run dominates Σ/Σ. */
    medianTps: number | null;
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function summarizeThroughput(runs: Iterable<ThroughputRun>): ThroughputSummary {
  let wallTokens = 0;
  let wallMs = 0;
  let wallN = 0;
  let apiTokens = 0;
  let apiMs = 0;
  const apiRates: number[] = [];
  for (const run of runs) {
    if (run.outputTokens === null || !Number.isFinite(run.outputTokens)) continue;
    if (run.wallMs !== null && run.wallMs > 0) {
      wallTokens += run.outputTokens;
      wallMs += run.wallMs;
      wallN += 1;
    }
    if (run.apiMs !== null && run.apiMs > 0) {
      apiTokens += run.outputTokens;
      apiMs += run.apiMs;
      apiRates.push((run.outputTokens / run.apiMs) * 1000);
    }
  }
  return {
    wall: {
      tps: wallN > 0 ? (wallTokens / wallMs) * 1000 : null,
      n: wallN,
      sufficient: hasEnoughSamples(wallN),
    },
    api: {
      tps: apiRates.length > 0 ? (apiTokens / apiMs) * 1000 : null,
      medianTps: median(apiRates),
      n: apiRates.length,
      sufficient: hasEnoughSamples(apiRates.length),
    },
  };
}
