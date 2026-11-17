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
  id?: string;
  topic?: string;
  language?: string;
  split?: string;
  rubric?: { fact: string; evidence: Gold[] }[];
  reason?: string;
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
  const ids = new Set<string>();
  return raw.map((q: unknown, i: number) => {
    const e = q as {
      query?: unknown;
      expected?: unknown;
      kind?: unknown;
      gold?: unknown;
      id?: unknown;
      topic?: unknown;
      language?: unknown;
      split?: unknown;
      rubric?: unknown;
      reason?: unknown;
    };
    const kind = typeof e?.kind === 'string' ? e.kind : 'all';
    if (typeof e?.query !== 'string' || e.query.trim() === '') {
      throw new Error(`${path}[${i}]: "query" and "expected" must not be empty`);
    }
    const metadata: Partial<SetQuery> = {};
    for (const key of ['id', 'topic', 'language', 'split'] as const) {
      if (e[key] !== undefined) {
        if (typeof e[key] !== 'string' || !e[key].trim())
          throw new Error(`${path}[${i}]: invalid ${key}`);
        metadata[key] = e[key];
      }
    }
    if (metadata.id) {
      if (ids.has(metadata.id)) throw new Error(`${path}[${i}]: duplicate id ${metadata.id}`);
      ids.add(metadata.id);
    }
    if (metadata.split && !['tuning', 'held-out'].includes(metadata.split)) {
      throw new Error(`${path}[${i}]: invalid split`);
    }
    if (kind === 'no-answer') {
      if (
        e.gold !== undefined ||
        e.expected !== undefined ||
        e.rubric !== undefined ||
        typeof e.reason !== 'string' ||
        !e.reason.trim()
      )
        throw new Error(`${path}[${i}]: no-answer needs a reason and no positive labels`);
      return { query: e.query, kind, ...metadata, reason: e.reason };
    }
    if (kind === 'overview') {
      if (
        e.gold !== undefined ||
        e.expected !== undefined ||
        !Array.isArray(e.rubric) ||
        e.rubric.length < 2
      ) {
        throw new Error(`${path}[${i}]: overview needs a multi-fact rubric, not gold`);
      }
      const rubric = e.rubric.map((r: unknown, j: number) => {
        const fact = r as { fact?: unknown; evidence?: unknown };
        if (
          typeof fact?.fact !== 'string' ||
          !fact.fact.trim() ||
          !Array.isArray(fact.evidence) ||
          !fact.evidence.length
        ) {
          throw new Error(`${path}[${i}].rubric[${j}]: invalid fact/evidence`);
        }
        return {
          fact: fact.fact,
          evidence: fact.evidence.map((g) => parseGold(g, `${path}[${i}].rubric[${j}]`)),
        };
      });
      return { query: e.query, kind, ...metadata, rubric };
    }
    if (e.rubric !== undefined)
      throw new Error(`${path}[${i}]: rubric only supported for overview`);
    if (e.gold !== undefined) {
      if (!Array.isArray(e.gold) || e.gold.length === 0) {
        throw new Error(`${path}[${i}]: "gold" must be a non-empty array`);
      }
      return {
        query: e.query,
        kind,
        ...metadata,
        gold: e.gold.map((g, j) => parseGold(g, `${path}[${i}].gold[${j}]`)),
      };
    }
    if (typeof e.expected !== 'string') {
      throw new Error(`${path}[${i}]: "query" and "expected" must be strings`);
    }
    if (e.expected === '') {
      throw new Error(`${path}[${i}]: "query" and "expected" must not be empty`);
    }
    return { query: e.query, expected: e.expected, kind, ...metadata };
  });
}

export function goldsOf(q: SetQuery): Gold[] {
  if (q.kind === 'overview' || q.kind === 'no-answer') return [];
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

/** Every original gold stays in the denominator, including spans lost by the indexer.
 * Null only for an empty label list (overview/no-answer are scored separately). */
export function scoreQuery(outcomes: GoldOutcome[], k: number): QueryScore | null {
  if (outcomes.length === 0) return null;
  const ranks = outcomes.flatMap((o) =>
    o.inStore && o.rank !== null && o.rank >= 1 && o.rank <= k ? [o.rank] : [],
  );
  return {
    recall: ranks.length / outcomes.length,
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
