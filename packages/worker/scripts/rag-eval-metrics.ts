export interface RankSummary {
  n: number;
  mrr: number;
  hit1: number;
  hit5: number;
  hitK: number;
}

export function rankOfExpected(hits: { sourcePath: string }[], expected: string): number | null {
  const i = hits.findIndex((h) => h.sourcePath.includes(expected));
  return i >= 0 ? i + 1 : null;
}

/** Ranks are 1-based, null for a miss; hit counts are counts, not fractions. */
export function summarizeRanks(ranks: (number | null)[], k: number): RankSummary {
  const within = (r: number | null, limit: number): r is number => r !== null && r <= limit;
  return {
    n: ranks.length,
    mrr:
      ranks.reduce<number>((sum, r) => sum + (within(r, k) ? 1 / r : 0), 0) / (ranks.length || 1),
    hit1: ranks.filter((r) => within(r, 1)).length,
    hit5: ranks.filter((r) => within(r, 5)).length,
    hitK: ranks.filter((r) => within(r, k)).length,
  };
}
