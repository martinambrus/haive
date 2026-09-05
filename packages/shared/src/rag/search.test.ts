import { describe, it, expect } from 'vitest';
import { DEFAULT_RAG_SEARCH_CONFIG, applyKnowledgeReserve, type RagSearchHit } from './search.js';

const OPTS = {
  topK: 8,
  knowledgeReserve: DEFAULT_RAG_SEARCH_CONFIG.knowledgeReserve,
  knowledgeReserveRatio: DEFAULT_RAG_SEARCH_CONFIG.knowledgeReserveRatio,
};

/** A hit whose only meaningful fields are the ones the reserve reads. `rrf`
 *  defaults to a value derived from denseSim so a plain page is already ranked
 *  the way the fusion would rank it; pass `rrf: 0` for a promoted candidate. */
function hit(
  sourceType: string,
  denseSim: number,
  overrides: Partial<RagSearchHit> = {},
): RagSearchHit {
  return {
    sourcePath: `${sourceType}/${denseSim}`,
    sectionId: 's',
    chunkIndex: 0,
    sourceType,
    content: '',
    denseSim,
    tsNorm: 0,
    hybrid: 0,
    rrf: denseSim / 100,
    ...overrides,
  };
}

const paths = (hits: RagSearchHit[]): string[] => hits.map((h) => h.sourcePath);

describe('applyKnowledgeReserve', () => {
  it('promotes a knowledge candidate the page would otherwise cut', () => {
    // The measured shape: a full page of code, plus a KB chunk that lost on rank
    // (rrf 0 because it never entered the fused candidate pool) but is close on
    // dense similarity.
    const page = Array.from({ length: 8 }, (_, i) => hit('code', 0.78 - i * 0.02));
    const candidate = hit('kb', 0.59, { sourcePath: 'kb/ARCHITECTURE.md', rrf: 0 });

    const out = applyKnowledgeReserve([...page, candidate], OPTS);

    expect(out).toHaveLength(8);
    expect(paths(out)).toContain('kb/ARCHITECTURE.md');
    // The weakest code row made way; the strongest is untouched.
    expect(paths(out)).toContain('code/0.78');
    expect(paths(out)).not.toContain('code/0.64');
  });

  it('stands down when the best knowledge candidate is too far below the top code hit', () => {
    // The symbol-lookup case: measured ratio 0.630, below the 0.75 floor.
    const page = Array.from({ length: 8 }, (_, i) => hit('code', 0.7355 - i * 0.02));
    const candidate = hit('kb', 0.4633, { sourcePath: 'kb/unrelated.md', rrf: 0 });

    const out = applyKnowledgeReserve([...page, candidate], OPTS);

    expect(out).toHaveLength(8);
    expect(paths(out)).not.toContain('kb/unrelated.md');
    expect(out).toEqual(page);
  });

  it('leaves a page that already ranks its knowledge hits exactly as it was', () => {
    // A floor on presence, never a re-ordering: a KB hit that earned rank 2 stays
    // at rank 2 rather than being moved into a reserved slot at the end.
    const page = [
      hit('code', 0.7),
      hit('kb', 0.68),
      hit('code', 0.66),
      hit('kb', 0.64),
      hit('code', 0.62),
      hit('code', 0.6),
      hit('code', 0.58),
      hit('code', 0.56),
    ];

    expect(applyKnowledgeReserve([...page], OPTS)).toEqual(page);
  });

  it('never returns more than topK, and fills spare slots with code', () => {
    const page = Array.from({ length: 8 }, (_, i) => hit('code', 0.78 - i * 0.02));
    // Four eligible candidates, but only two slots are reserved.
    const candidates = [0.6, 0.59, 0.58, 0.57].map((s, i) =>
      hit('kb', s, { sourcePath: `kb/${i}.md`, rrf: 0 }),
    );

    const out = applyKnowledgeReserve([...page, ...candidates], OPTS);

    expect(out).toHaveLength(8);
    expect(out.filter((h) => h.sourceType === 'kb')).toHaveLength(2);
    // The two best by dense similarity, not by rrf (they all share rrf 0).
    expect(paths(out)).toEqual(expect.arrayContaining(['kb/0.md', 'kb/1.md']));
    expect(paths(out)).not.toContain('kb/3.md');
  });

  it('reserves proportionally so a small page is not handed over', () => {
    // topK 4 -> floor(4/3) = 1 slot, not 2. Measured: top_k reaches this route as
    // low as 4.
    const page = Array.from({ length: 4 }, (_, i) => hit('code', 0.61 - i * 0.02));
    const candidates = [0.52, 0.51].map((s, i) =>
      hit('kb', s, { sourcePath: `kb/${i}.md`, rrf: 0 }),
    );

    const out = applyKnowledgeReserve([...page, ...candidates], { ...OPTS, topK: 4 });

    expect(out).toHaveLength(4);
    expect(out.filter((h) => h.sourceType === 'kb')).toHaveLength(1);
  });

  it('is a no-op on a result set with no code, which is the global KB store', () => {
    const page = [hit('kb', 0.7), hit('kb', 0.6), hit('kb', 0.5)];

    expect(applyKnowledgeReserve([...page], OPTS)).toEqual(page);
  });

  it('never promotes a task-embedding row', () => {
    // `task` rows are keyed by task UUID for the effort estimator and are not
    // knowledge; they also have no counter in the api's rag_query_log bucketing,
    // so one surfacing here would be an invisible hit.
    const page = Array.from({ length: 8 }, (_, i) => hit('code', 0.78 - i * 0.02));
    const candidate = hit('task', 0.77, { sourcePath: 'task/uuid', rrf: 0 });

    const out = applyKnowledgeReserve([...page, candidate], OPTS);

    expect(paths(out)).not.toContain('task/uuid');
    expect(out).toEqual(page);
  });

  it('promotes runbook and learning chunks, not only kb', () => {
    const page = Array.from({ length: 8 }, (_, i) => hit('code', 0.78 - i * 0.02));
    const candidates = [
      hit('runbook', 0.62, { sourcePath: 'rb/one.md', rrf: 0 }),
      hit('learning', 0.61, { sourcePath: 'ln/one.md', rrf: 0 }),
    ];

    const out = applyKnowledgeReserve([...page, ...candidates], OPTS);

    expect(paths(out)).toEqual(expect.arrayContaining(['rb/one.md', 'ln/one.md']));
  });

  it('keeps the reserve when the page is trimmed, which is the mergeHits path', () => {
    // mergeHits trims the local page to make room for the global KB. The promoted
    // hit carries the low rrf that got it cut in the first place, so a plain rrf
    // slice would drop it first.
    const page = [
      ...Array.from({ length: 6 }, (_, i) => hit('code', 0.78 - i * 0.02)),
      hit('kb', 0.6, { sourcePath: 'kb/kept.md', rrf: 0 }),
    ];

    const out = applyKnowledgeReserve(page, { ...OPTS, topK: 4 });

    expect(out).toHaveLength(4);
    expect(paths(out)).toContain('kb/kept.md');
  });

  it('restores the previous ranking exactly when the reserve is disabled', () => {
    const page = Array.from({ length: 8 }, (_, i) => hit('code', 0.78 - i * 0.02));
    const candidate = hit('kb', 0.6, { sourcePath: 'kb/one.md', rrf: 0 });

    const out = applyKnowledgeReserve([...page, candidate], { ...OPTS, knowledgeReserve: 0 });

    expect(out).toEqual(page);
  });

  it('returns nothing for a non-positive topK', () => {
    expect(applyKnowledgeReserve([hit('code', 0.5)], { ...OPTS, topK: 0 })).toEqual([]);
  });
});
