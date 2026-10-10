# Knowledge reserve in retrieval

**A repo indexes two orders of magnitude more code than KB, so the KB has to be given
slots — it cannot win them.** MEASURED on a live 9197-row index: 9156 code chunks against
41 KB chunks (223:1), and the KB chunk that ANSWERED the query ("major functional areas of
the activit module") sat at dense rank 41 behind 40 code chunks, so a `top_k` of 12 returned
zero KB. 11 of 18 logged queries returned no KB at all. Per chunk the KB was the BETTER
match (avg dense 0.4133 vs code 0.3170); code won on volume alone. Not a floor problem —
`denseFloor` is 0.3 and the best KB chunk scored 0.5926, and two KB rows were already inside
the 50-row candidate pool. They were outranked, not gated. This is the mirror of `b8bcb2af`,
which added `codeDenseFloor` because code was losing to KB prose: a scalar floor tuned
against corpus size flip-flops, so the fix is a QUOTA.

`applyKnowledgeReserve` (`shared/src/rag/search.ts`) holds `knowledgeReserve` (2) slots of
every page for `KNOWLEDGE_SOURCE_TYPES`. A quota rather than an RRF multiplier because a
multiplier cannot close a rank-41 gap without over-promoting the queries where the KB already
surfaces, and the gap varies per query. It is a floor on PRESENCE, never a re-ordering: only
rows the page would otherwise CUT are promoted, so a KB hit that earned rank 2 stays at rank
2, and promoted rows keep the low `rrf` that got them cut rather than a fabricated score
(`rrf` is shown to agents and logged as `maxRrf`). Admission is RELATIVE — `denseSim >=
knowledgeReserveRatio` (0.75) × the best CODE hit's — because MEASURED across 18 real queries
best-KB/best-code ran 0.630-1.043 and the only two under 0.75 were pure symbol lookups
(`CProduct class d_product.inc …`, `PDF certificate generation mPDF …`) where the KB
genuinely has less to say. So no absolute threshold needs re-tuning per corpus. The effective
reserve is `min(knowledgeReserve, floor(topK / 3))`: `top_k` reaches this route as low as 4,
where a flat 2 is half the page.

**`task` is not knowledge**, which is why `KNOWLEDGE_SOURCE_TYPES` names its three members
positively instead of testing `<> 'code'`. `workflow/_task-embedding.ts` writes one row per
task keyed by task UUID rather than a file, for the effort estimator alone, and it has no
counter in `logRagQuery` — one surfacing in an agent's results would be an invisible hit.
The positive form is also what uses `idx_rag_source_type`: MEASURED 1.6 ms against 8.6 ms for
a `<> 'code'` sequential scan on the same index.

Candidates come from a SECOND small query, not another CTE unioned into the ranking SQL: a
row reached only through such a union carries no `d_rank` and no `l_rank`, scores `rrf = 0`,
and the main statement's own `ORDER BY rrf DESC LIMIT` discards it before any caller sees it
— the reserve would have had nothing to draw on. It applies `denseFloor` (never
`codeDenseFloor`), so a promoted row has cleared the same relevance gate the main query holds
its own rows to. The reserve is INERT wherever the dense half is (`usePgvector` false — a
jsonb store, an accepted `rag_embed_lexical_only` repo, or a query that could not be
embedded), since every row there reports `dense_sim = 0` and the ratio has no signal, and
inert on any page with no code hits, which is the global KB store (every row `kb`) — so
neither global caller is perturbed and neither pays for the extra query.

`mergeHits` re-applies it when trimming the local page for the global KB. That is not
belt-and-braces: a promoted hit carries exactly the low `rrf` that got it cut, so a plain rrf
slice drops it FIRST and the reserve would die at the merge. `knowledgeReserve: 0` restores
the previous ranking exactly.

The reserve's candidates come from a query of their own (rrf 0), and it can return a chunk the fusion
already ranked: on a page shorter than topK both copies used to fit (MEASURED: `docs/ARCHITECTURE.md`
twice in all three sampled queries). The reserve keeps one row per chunk, the ranked copy.
