export interface RankSummary {
  n: number;
  mrr: number;
  hit1: number;
  hit5: number;
  hitK: number;
}

export function rankOfExpected(hits: { sourcePath: string }[], expected: string): number | null {
  if (expected === '') return null;
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

export interface SetQuery {
  query: string;
  expected: string;
  kind: string;
}

export function parseQuerySet(raw: unknown, path: string): SetQuery[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`${path}: expected a non-empty JSON array`);
  }
  return raw.map((q: unknown, i: number) => {
    const e = q as { query?: unknown; expected?: unknown; kind?: unknown };
    if (typeof e?.query !== 'string' || typeof e?.expected !== 'string') {
      throw new Error(`${path}[${i}]: "query" and "expected" must be strings`);
    }
    if (e.query.trim() === '' || e.expected === '') {
      throw new Error(`${path}[${i}]: "query" and "expected" must not be empty`);
    }
    return {
      query: e.query,
      expected: e.expected,
      kind: typeof e.kind === 'string' ? e.kind : 'all',
    };
  });
}

export function fmtSummary(label: string, ranks: (number | null)[], k: number): string {
  const s = summarizeRanks(ranks, k);
  // A cutoff deeper than the page searched would count unretrieved ranks as misses.
  const hits = [
    `hit@1=${s.hit1}/${s.n}`,
    ...(k >= 5 ? [`hit@5=${s.hit5}/${s.n}`] : []),
    ...(k !== 1 && k !== 5 ? [`hit@${k}=${s.hitK}/${s.n}`] : []),
  ];
  return `${label.padEnd(16)} n=${s.n} MRR@${k}=${s.mrr.toFixed(3)} ${hits.join(' ')}`;
}
