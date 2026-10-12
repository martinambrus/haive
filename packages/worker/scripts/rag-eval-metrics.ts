export function rankOfExpected(hits: { sourcePath: string }[], expected: string): number | null {
  if (expected === '') return null;
  const i = hits.findIndex((h) => h.sourcePath.includes(expected));
  return i >= 0 ? i + 1 : null;
}

/** `anchor` absent is the legacy file-level gold: `path` is a source_path substring. */
export interface Gold {
  path: string;
  anchor?: string;
}

export interface SetQuery {
  query: string;
  kind: string;
  expected?: string;
  gold?: Gold[];
}

function parseGold(g: unknown, where: string): Gold {
  const e = g as { path?: unknown; anchor?: unknown };
  if (typeof e?.path !== 'string' || typeof e?.anchor !== 'string') {
    throw new Error(`${where}: "path" and "anchor" must be strings`);
  }
  if (e.path === '' || e.anchor === '') {
    throw new Error(`${where}: "path" and "anchor" must not be empty`);
  }
  return { path: e.path, anchor: e.anchor };
}

export function parseQuerySet(raw: unknown, path: string): SetQuery[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`${path}: expected a non-empty JSON array`);
  }
  return raw.map((q: unknown, i: number) => {
    const e = q as { query?: unknown; expected?: unknown; kind?: unknown; gold?: unknown };
    const kind = typeof e?.kind === 'string' ? e.kind : 'all';
    if (typeof e?.query !== 'string' || e.query.trim() === '') {
      throw new Error(`${path}[${i}]: "query" and "expected" must not be empty`);
    }
    if (e.gold !== undefined) {
      if (!Array.isArray(e.gold) || e.gold.length === 0) {
        throw new Error(`${path}[${i}]: "gold" must be a non-empty array`);
      }
      return {
        query: e.query,
        kind,
        gold: e.gold.map((g, j) => parseGold(g, `${path}[${i}].gold[${j}]`)),
      };
    }
    if (typeof e.expected !== 'string') {
      throw new Error(`${path}[${i}]: "query" and "expected" must be strings`);
    }
    if (e.expected === '') {
      throw new Error(`${path}[${i}]: "query" and "expected" must not be empty`);
    }
    return { query: e.query, expected: e.expected, kind };
  });
}

export function goldsOf(q: SetQuery): Gold[] {
  return q.gold ?? [{ path: q.expected ?? '' }];
}

/** The chunk text after its `[path > ...]` context header line; a legacy chunk has none. */
export function chunkBody(content: string, sourcePath: string): string {
  const nl = content.indexOf('\n');
  const first = nl < 0 ? content : content.slice(0, nl);
  if (!first.startsWith(`[${sourcePath}`) || !first.endsWith(']')) return content;
  return nl < 0 ? '' : content.slice(nl + 1);
}

/** Best 1-based rank of any hit holding the gold (two overlapping chunks may both), else null. */
export function goldRank(
  hits: { sourcePath: string; content: string }[],
  gold: Gold,
): number | null {
  if (gold.anchor === undefined) return rankOfExpected(hits, gold.path);
  const anchor = gold.anchor;
  const i = hits.findIndex(
    (h) => h.sourcePath === gold.path && chunkBody(h.content, h.sourcePath).includes(anchor),
  );
  return i >= 0 ? i + 1 : null;
}

export interface GoldOutcome {
  rank: number | null;
  inStore: boolean;
}

export interface QueryScore {
  recall: number;
  mrr: number;
  hit: boolean;
}

/** Null when no gold of the query is in the store: there is nothing to retrieve. */
export function scoreQuery(outcomes: GoldOutcome[], k: number): QueryScore | null {
  const live = outcomes.filter((o) => o.inStore);
  if (live.length === 0) return null;
  const ranks = live.flatMap((o) => (o.rank !== null && o.rank <= k ? [o.rank] : []));
  return {
    recall: ranks.length / live.length,
    mrr: ranks.length > 0 ? 1 / Math.min(...ranks) : 0,
    hit: ranks.length > 0,
  };
}

export interface ScoreSummary {
  n: number;
  recall: number;
  mrr: number;
  hit: number;
}

export function summarizeScores(scores: QueryScore[]): ScoreSummary {
  const n = scores.length;
  const mean = (f: (s: QueryScore) => number) => scores.reduce((a, s) => a + f(s), 0) / (n || 1);
  return {
    n,
    recall: mean((s) => s.recall),
    mrr: mean((s) => s.mrr),
    hit: scores.filter((s) => s.hit).length,
  };
}

/** Nearest-rank percentile, p in (0, 100]. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i] ?? 0;
}

export function fmtScoreSummary(label: string, k: number, s: ScoreSummary): string {
  return (
    `${label.padEnd(16)} k=${String(k).padEnd(3)} n=${s.n} recall@${k}=${s.recall.toFixed(3)} ` +
    `MRR@${k}=${s.mrr.toFixed(3)} hit@${k}=${s.hit}/${s.n}`
  );
}
