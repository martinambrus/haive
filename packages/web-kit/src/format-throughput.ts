/** Output tokens per second: one decimal under 10, whole above. A missing rate is a dash, never 0. */
export function formatTps(tps: number | null | undefined): string {
  if (tps == null || !Number.isFinite(tps)) return '—';
  return `${tps < 10 ? tps.toFixed(1) : Math.round(tps)} tok/s`;
}

/** The rate a run produced over one duration; null when either side is missing or zero. */
export function ratePerSecond(tokens: number | null | undefined, ms: number | null | undefined) {
  if (tokens == null || ms == null || ms <= 0) return null;
  return (tokens / ms) * 1000;
}

/** A side of a stats throughput summary: the rate, or `n=3` below the sample floor. */
export function formatSampledTps(side: { tps: number | null; n: number; sufficient: boolean }) {
  if (side.tps == null) return '—';
  return side.sufficient ? formatTps(side.tps) : `n=${side.n}`;
}
