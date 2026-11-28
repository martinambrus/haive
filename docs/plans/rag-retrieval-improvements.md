# RAG retrieval improvements

> **Partially implemented; reviewed 2026-11-12 at `3426c8c34`.** P0 was an untracked historical
> eval; P1 chunk corrections, own-file budgets, the dense-search settings and accent-insensitive
> lexical configuration have since shipped. P2(c) was measured on 2026-11-28 and does not win (T147,
> not shipped); P2(b) remains parked (T144), as does index-space
> work (T149); P3 has two local GPU measurements below, neither recommended to ship, and P4 remains conditional. The committed shared-source eval below supplies a reproducible baseline; ranking
> changes still require held-out comparisons, including negative and overview results. The original status was stale. Seven external
> sources are reviewed so far. The findings were measured read-only on the dev install on
> 2026-09-30, and the P0 numbers on 2026-10-12. Keep this file current by editing the section a
> change belongs to: a new source goes into Sources reviewed, a re-measured number replaces the old
> one in Findings, a decision moves from Open decisions to Decided. P0 gates every other phase.

## Context

The user is feeding external RAG material (articles, tutorials) to find improvements for Haive's
retrieval: `rag_search`, over the per-repository store and the global KB. Each source is read in
full, and a technique counts only when Haive lacks it or does it worse, measured on Haive's own
chunker and logs. This plan holds what survived that test, so the findings outlive a session.

How retrieval works today (resolve by symbol; line numbers drift):

- **Writers.** `10-rag-populate` (onboarding), `runRagIndexSync` in `_rag-index.ts` (workflow
  `02-pre-rag-sync` and `11c-rag-reindex`) and `global-kb-sync-queue.ts` all chunk through
  `_rag-chunkers.ts`: construct regexes per language (`phpRanges`, `jsRanges`, …), then
  `assembleSections` (a span between constructs of 120 trimmed characters or more becomes a
  `chunk-<n>` gap section, and a shorter one that is not blank joins a neighbouring section), then
  `chunkSection` (2,000 chars, 200 overlap; split at a paragraph break, else a line end, else at `'. '`,
  else a hard cut), then `capChunks` (`MAX_CHUNKS_PER_FILE`, 80). Every chunk carries a
  `[path > class > function]` header inside `content`, so the header is embedded and indexed, and
  `chunk_hash` covers header and body.
- **Embedding.** `qwen3-embedding:4b` (2,560 dims) through the in-stack Ollama. Documents and
  queries are embedded as raw text (`embedQueryOrNull`).
- **Search.** `ragHybridSearch` fuses three rankers with RRF, k=60: dense (HNSW over `halfvec`, pool
  50, which is 40 candidates on the index path: F14), `english` full text through
  `plainto_tsquery` (which ANDs every term; pool 50), and the identifier ranker (IDF-weighted, at
  most 3 candidates). The knowledge reserve holds up to 2 slots for KB rows, `mergeHits` gives the
  global KB up to half the page, and the SQL `LIMIT` is `top_k`.
- **Telemetry and eval.** `rag_query_log` records counts and score maxima per call, and since
  0180 the final page (`result_hits`). `packages/worker/scripts/rag-build-store.ts` builds a
  scratch store the way onboarding does, and `rag-eval.ts` scores a golden set by recall@k and MRR
  (P0).

## Sources reviewed

### S1. Anthropic, "Contextual Retrieval" (article) and its cookbook

**Article** (anthropic.com/engineering/contextual-retrieval, checked with verbatim quotes). An LLM
(Claude 3 Haiku) writes a 50-100 token context for each chunk from the whole document. That context
is prepended before embedding and before BM25, and the top 150 are reranked (Cohere) to 20. Failure
is 1 − recall@20, averaged across four domains (codebases, fiction, ArXiv, science papers) with
Gemini Text 004: 5.7% baseline, 3.7% with contextual embeddings, 2.9% adding contextual BM25, 1.9%
adding rerank. One-time cost $1.02 per million document tokens with prompt caching. Under 200k
tokens it advises putting the whole KB in the prompt.

**Cookbook** (platform.claude.com/cookbook/capabilities-contextual-embeddings-guide; the printed
outputs re-read from the raw notebook in `anthropics/claude-cookbooks`). Code only: 9 codebases,
737 chunks from basic character splitting (no structural header), 248 queries with one golden chunk
each. `voyage-2` embeds queries and documents alike; `claude-haiku-4-5` writes the context over the
raw API (~$2.85 for 737 chunks with caching); BM25 runs in Elasticsearch, fused 0.8/0.2 over 150
candidates from each side; rerank is `rerank-english-v3.0` over k×10 candidates, without BM25
(~$0.002 and 100-200 ms per query).

| Pass@ | baseline | + context | + context + BM25 | + context + rerank |
|---|---|---|---|---|
| 5 | 80.92 | 88.12 | 88.86 | 92.15 |
| 10 | 87.15 | 92.34 | 92.31 | 95.26 |
| 20 | 90.06 | 94.29 | 95.23 | 97.45 |

On code, failure at 20 falls 43% from context alone, 52% with BM25 (+0.94 points over context) and
74% with rerank (+3.16 points). The notebook's own summary table (hybrid 86.43 / 93.21 / 94.99) and
its "47%" sentence disagree with its printed outputs; the printed outputs are used here.

**Verdict.** The direction transfers and the magnitudes do not: different embeddings, a baseline
with no structural header (which Haive's chunks already carry), and 737 chunks against ~20,000.
Feeds P0, P3 and P4; the global-KB half of the 200k advice is D4.

### S2. UW SSEC, "Generative AI Copilot for Scientific Software – a RAG-Based Approach" (SciPy 2024)

`github.com/uw-ssec/tutorials`, `Archive/SciPy2024` at `b73a4c2`, read in full: three modules (eight
notebooks), three appendix notebooks, every markdown page, the helper package
`uw-ssec/ssec_tutorials` at `98ca4cf`, and the embedding "evaluation" it links (issue #6). An
introductory LangChain demo: 100,000 sampled arXiv astro-ph abstracts plus 311 Astropy `.rst`
pages, `all-MiniLM-L12-v2` (384 dims; input past 256 word pieces is truncated) in local Qdrant, MMR
retrieval with k=2, OLMo-7B-Instruct (Q4_K_M) through llama.cpp, and a Panel chat app that shows the
retrieved documents. No hybrid search, no reranking, no eval.

**Verdict.** Two techniques apply: MMR-style diversity (F5, P2) and the recursive splitter's
single-newline level (F4, P1). Its document handling is not one to copy:
`fetch_and_process_github_rst_files` (`ssec_tutorials/setup.py`) stores each page whole with no
splitter, so the model embeds only each page's head. Haive's chunks stay far inside
`qwen3-embedding:4b`'s reported 40,960-token context. The linked "evaluation" is a planning issue
with no comparison data in it.

### S3. Liu et al., "Lost in the Middle: How Language Models Use Long Contexts" (TACL 2023)

arXiv 2307.03172 v3, read in full from the PDF (18 pages, appendices A-G). It studies how a reader
model uses retrieved text, not how to retrieve it. The main task is multi-document QA on
NaturalQuestions-Open: 2,655 questions, passages of at most 100 tokens, one answering passage among
Contriever-retrieved distractors listed in decreasing relevance, with 10, 20 and 30 documents (~2K,
~4K and ~6K tokens). A synthetic key-value lookup is the second task. The models are from mid-2023:
GPT-3.5-Turbo (4K and 16K), Claude-1.3 (8K and 100K), MPT-30B-Instruct and LongChat-13B, with GPT-4
and Llama-2 in the appendices.

- Accuracy is U-shaped in the answer's position. GPT-3.5-Turbo with 20 documents scores 75.8% with
  the answer first, 53.8% tenth and 63.2% last; at the 10th and 15th positions it falls below its
  56.1% closed-book score. GPT-4 (a 500-question subset) is higher throughout and still U-shaped;
  Claude-1.3 is flatter (59.9%, 56.8%, 60.1%).
- Retrieved distractors hurt more than random ones (Appendix B), and telling the model the results
  are unordered does not remove the curve (Appendix C).
- Reader accuracy saturates long before retriever recall: past 20 documents it gains ~1.5%
  (GPT-3.5-Turbo) and ~1% (Claude-1.3). The authors name reranking (relevant text first) and
  ranked-list truncation (fewer documents when appropriate) as the directions.
- Placing the query both before and after the documents fixes the key-value lookup but barely moves
  multi-document QA.

**Verdict.** No new retrieval technique; it is evidence about how a page is read. Its models are
three years older than the CLIs Haive dispatches, so the magnitudes do not transfer, and only a
reader-side test could measure the effect for them, which P0 does not do. It supports order and
precision over depth (P2c, P2d, P3) and argues against echoing the query in `rag_search` output,
which the proxy does not do. The same effect bears on long step prompts that bury their instructions
mid-prompt; that is prompt assembly, not retrieval, and is not planned here.

### S4. Edge et al., "From Local to Global: A Graph RAG Approach to Query-Focused Summarization" (v1)

arXiv 2404.16130 v1 (Microsoft, 2024-04-24), read in full from the PDF (15 pages). v2 (2025-02-19)
states the same headline in its abstract, with "conventional" where v1 says "naïve" RAG, and was
not read further. GraphRAG answers global questions about a whole corpus ("What are the main
themes in the dataset?"), which the authors frame as query-focused summarization rather than
retrieval. An LLM (the paper's figures use gpt-4-turbo) extracts entities, relationships and claims
from every chunk, with optional extra "gleaning" rounds; Leiden clustering groups the entity graph
into a hierarchy of communities; and the LLM writes a report for each community. A question is
answered map-reduce: the reports are shuffled into context-sized batches, each batch yields a
partial answer with a 0-100 helpfulness score, zero scores are dropped, and the rest are reduced
into the final answer.

- Two corpora: podcast transcripts (1,669 chunks of 600 tokens, ~1M tokens) and news articles
  (3,197 chunks, ~1.7M tokens), with 125 LLM-generated questions each. The LLM invents 5 users, 5
  tasks per user and 5 questions per pair from a short description of the corpus, so the questions
  are written from a description, not from the text.
- An LLM judges pairs of answers (five runs each, no gold answers). Against naive vector RAG the
  graph conditions win comprehensiveness 72-83% (podcast) and 72-80% (news), and diversity 75-82%
  and 62-71%; naive RAG wins directness, the control. Root-level reports use over 97% fewer tokens
  than map-reducing the source text and still win 72% comprehensiveness and 62% diversity against
  naive RAG.
- A 600-token chunk yielded almost twice as many entity references as a 2,400-token chunk in one
  extraction round.
- Naive RAG answered best from the smallest context tested: 8k beat 16k, 32k and 64k on
  comprehensiveness (58.1% average win).
- The authors report that map-reducing the source text without a graph "performed competitively"
  in many cases, state no indexing cost, and limit the claim to sensemaking questions over two
  corpora of about a million tokens.

**Verdict.** Not for `rag_search` as it stands. Its target is the global question, and Haive's
traffic is local (F12). Its index costs an LLM pass per chunk plus a report per community, the same
dispatcher wall as P4 (F11). Haive already builds LLM-written global layers, the KB and the plan
tree, and its plan build is itself a top-down fan-out over the repository, one agent per frontier
node per wave; but no plan node can be found through `rag_search` (F12, D5). Two smaller carries:
the description-based question generation suits P0's overview questions, and the small-context
result corroborates P2(d). Code also has a graph of its own (calls, includes, classes) that needs no
LLM to extract, and agents already walk it with LSP and grep.

### S5. Nogueira and Cho, "Passage Re-ranking with BERT" (2019)

arXiv 1901.04085 v5 (2020-04-14, the latest), read in full (5 pages). The founding cross-encoder
reranker: BERT-Large reads the query (truncated to 64 tokens) and one passage together, 512 tokens
at most, and a single layer over the `[CLS]` vector gives the probability that the passage is
relevant. Each passage is scored on its own, and the list is re-sorted by that probability. It
reranks the top 1,000 BM25 results.

- MS MARCO passage ranking, MRR@10 on the eval set: BM25 16.5, the previous best 28.1, BERT-Large
  35.8 (the 27% relative gain). TREC-CAR, MAP: tuned BM25 15.3, BERT-Large 33.5.
- Fine-tuned on 12.8M query-passage pairs (under 2% of MS MARCO's training set) in about 30 hours
  on a TPU v3-8. 100k pairs (under 0.3%) already beat the previous best by 1.4 points, and training
  longer did not help.
- It reports no inference cost or latency.

**Verdict.** The mechanism behind P3, and behind the cookbook's rerank gain on code (S1). Three
things carry into Haive. The magnitudes do not: its first stage is BM25, and Haive's is a dense
first stage (`qwen3-embedding:4b`) that leaves less for a reranker to fix, so S1's code-only rerank
gain (+3.16 points at 20, over context) is the closer prior. The window does: 512 tokens with the
query's 64 deducted holds roughly 1,500-1,800 chars of code (at 3.5-4 chars a token), and a quarter
to a third of Haive's chunks are longer (F11), so the reranker chosen must hold a whole chunk or it
judges a chunk by its head. And it outputs an absolute relevance probability, the signal P2(d)'s
truncation needs and `rrf` cannot give. Its model was trained on web questions; nothing here
measures a reranker on code questions, and Haive has no labelled pairs to fine-tune one (F8).

### S6. Sentence-Transformers, "Retrieve & Re-Rank" (documentation)

sbert.net's page, read from its source in the library's repository
(`examples/sentence_transformer/applications/retrieve_rerank/README.md`, identical under both
GitHub organisations) together with everything it links: the Simple Wikipedia notebook and its
printed outputs, the in-document search script, and the MS MARCO bi-encoder and cross-encoder model
tables. The recipe: retrieve a candidate set (about 100 in the text, 32 in the notebook) lexically
or with a bi-encoder, score every (query, passage) pair with a cross-encoder, and keep the top few
(3 to 5). For a small set, skip retrieval and score everything.

- Cross-encoders trained on MS MARCO (English web search), as TREC DL19 NDCG@10 / MS MARCO dev
  MRR@10 / documents per second: TinyBERT-L2 69.84 / 32.56 / 9,000; MiniLM-L6 74.30 / 39.01 /
  1,800; MiniLM-L12 74.31 / 39.02 / 960. The in-document script puts that speed on a V100 GPU. No
  CPU speed is given for any cross-encoder; the bi-encoder table gives CPU encoding speeds (MiniLM-L6
  2,800 documents a second on the GPU, 180 on an 8-core Xeon).
- The notebook's cross-encoder ranks "It has about 110,000 people living there." first for "How
  many people live in Toronto?": a paragraph with no subject, scored on its shape. A cross-encoder
  judges the passage text alone, so a passage that has lost its context can win.
- It lists multilingual community rerankers (`BAAI/bge-reranker-v2-m3` and
  `Alibaba-NLP/gte-multilingual-reranker-base` among them) with no numbers for them.

**Verdict.** The practical form of P3; nothing in it changes P3's gate. The tabled models are
English, and part of Haive's code and queries is Slovak (F13), so they are out, and a multilingual
reranker is the candidate class, unmeasured here. A reranker scores the chunk text alone; the
notebook's own output shows what it does with a passage that lost its context, and F1 and F9 are
such chunks, so P1 lands before P3. No source so far gives a CPU figure for a cross-encoder, so D3's
latency question stays open until it is measured on this host.

### S7. FAISS wiki, "Guidelines to choose an index"

`github.com/facebookresearch/faiss/wiki/Guidelines-to-choose-an-index`, read from the wiki's raw
markdown. A decision guide, mainly for L2 distance. For few searches (1,000-10,000) brute force is
the most efficient option, because building an index is never paid back. Only a flat index
guarantees exact results, and it is the baseline the others are measured against. For a small
dataset or ample RAM, HNSW is the best option: M links per vector (4 to 64), speed traded for
accuracy through `efSearch`, (d × 4 + M × 2 × 4) bytes per vector, and no support for removing
vectors. Compression (OPQ, PQ, RaBitQ) and IVF clustering ladders are for memory pressure and for
collections from a million vectors up.

**Verdict.** Haive does not use FAISS, but its dense half answers the same questions through
pgvector, and at ~10⁴ vectors per repository it sits at the bottom of the guide's ladder, where
compression and clustering do not apply. Three carries: the HNSW path ends after `efSearch`
candidates, so the configured pool of 50 is 40 (F14, measured); deleted vectors keep their index
space (F15, measured); and an exact search is the recall baseline P0 should hold the HNSW path to.

## Findings

Corpus: the dev install's Drupal 7 repository (the `activit` custom module), collected with its real
`01-env-detect` excludes. `09_7-rag-source-selection` never ran there, so a real index would be
narrower. The dev install's code indexes are gone, so the chunker ran read-only over the tree inside
`haive-worker`; AGENTS.md's live index of the same code held 9,197 rows. Query evidence is
`rag_query_log`: 3,103 calls from 2026-09-05 to 2026-09-13.

- **F1. The first PHP function of nearly every file lands in a path-only gap chunk.** `phpRanges`'
  function regex has an optional docblock group that can stretch from the file's `@file` docblock
  to the first function, and `assembleSections` then drops that range because it strictly contains
  the file-docblock range. A two-function file loses its first function only when it has a file
  docblock. 1,213 of 1,292 PHP files with a leading docblock lose their first function, and Drupal
  requires `@file` docblocks. → P1.
- **F2. Other construct misses.** Of 11,803 PHP functions with bodies, 469 have a parenthesized
  default (such as `= array()`), 77 a return type and 23 a by-ref `&`, and all but 5 of those are
  missed. Separately, 1,479 plain signatures are missed, most of them F1. JS/TS files holding only
  anonymous functions or callbacks (228) and files whose named constructs the regexes miss (52)
  index as gaps. 457 of the 981 files with no extracted construct contain no function at all, so
  that share is not a miss. → P1, D2.
- **F3. The per-file budget leaves most of the largest custom files unindexed.**
  `MAX_CHUNKS_PER_FILE` drops 1,968 of 21,813 chunks (9.0%) across 29 files. 8 of them are
  custom-module files (557 chunks), led by `_classes/inspection.class.inc` (331 of 411 dropped) and
  `activit.install` (97 of 177); most of the rest are vendored jQuery copies. By design, and logged.
  Before that cap, `MAX_FILE_BYTES` (512,000) keeps a whole file out: three code files in scope, two
  of them vendored libraries and one a 712 KB custom-module file that real agent queries ask about,
  which is therefore not indexed at all and is not counted in the 1,968. → D1.
- **F4. Chunks end mid-line.** `chunkSection` has no single-newline level: 32.5% of non-final
  chunks end mid-line after the cap. Before the cap it is 2,194 (29.8%), 955 of them cut at the
  `'. '` prose heuristic inside code. A single-newline fallback between the paragraph and the
  sentence levels (the recursive splitter's order) measured those 2,194 down to 691 (9.5%). → P1.
- **F5. Identical bodies across files.** 1,805 of 21,813 chunks (8.3%) share their body with another
  file's chunk: 651 groups, one body in 40 files, and the custom inspection variants share bodies
  across 15-20 files. They differ only in the path header, so they can fill a page with copies; how
  often they do was unmeasured (F8): 1 of the 29 logged pages that kept their hits holds one
  (P2(c)). → P2.
- **F6. The lexical rankers rarely co-support a hit.** One ranker alone scores at most 1/61 and two
  rankers at ranks ≤ 50 at least 2/110, so `max_rrf` separates them. Of 2,514 logged calls that
  returned code (none with a runbook hit; all on repositories deleted since), 1,700 (67.6%) had
  `max_rrf` exactly 1/61: no hit on the page came from two rankers. Two-ranker pages held at 31-34%
  per day from 09-08 to 09-10; the identifier ranker shipped 09-06 (`63378b26`), so the log cannot
  separate its share. A what-if replay of 150 onboarding queries against the chunks with the
  trigger's exact tsvector: 144 match nothing under the AND, and 65 carry an identifier present in
  the corpus. On the P0 golden set the AND matches no row for 269 of 296 queries (63 of 71 real
  ones), so the hybrid page is in practice dense plus at most 3 identifier candidates. AGENTS.md
  already records plain OR and coverage ranking measuring worse. → P2.
- **F7. Queries are embedded raw.** The Qwen3-Embedding model card: "Each query must come with a
  one-sentence instruction that describes the task" (`Instruct: {task}`, a newline, then
  `Query:{query}`), typically worth 1-5%, and no instruction for documents. From neither S1 nor S2.
  → P2.
- **F8. No hit list is recorded.** `rag_query_log` kept counts and score maxima, so none of the
  3,103 calls logged before 0180 can be replayed or labelled. 0180 adds the final page
  (`result_hits`); 40 of the 17,065 rows on the dev install hold it (2026-11-28). → P0.
- **F9. Context-poor chunks.** 36.2% of chunks carry a path-only header. 32.4% are continuation
  chunks, and 52.4% of those are path-only; the rest keep their `class > function` breadcrumb.
  → P1, then P4.
- **F10. Page size, fill and order.** Callers pass `top_k` 1-8 on 42.3% of calls, 9-20 on 55.6%
  and above 20 on 0.7%; 1.4% omit it (default 8). On calls that searched a real code index, pages of
  up to 8 come back full 99.7% of the time and pages of 9-12 97.8%, so the relevance floors almost
  never shorten a normal page; 13-20 fill 59.5% (15.4 of 17.1 on average) and above 20 never (17.6
  of 27.5). Across all calls an average page holds 5.3 code, 3.1 KB and 1.0 global hits, and 89%
  carry a global hit. The proxy lists hits best-first by `rrf` with the knowledge reserve's
  promotions last, and nothing caps a page's size beyond `top_k` ≤ 50 (global entries expand within
  a 12,000-char budget); it does not echo the query. The global KB can take up to half the page.
  Calls split 49% onboarding, 50% workflow; 37% fell inside `10_8-plan-build`.
- **F11. Sizes and costs.** 19,845 chunks after the cap, 21.3M chars (5.3-6.1M tokens). A chunk
  runs to 2,161 chars (median 967, p90 2,041); 25.2% are over 1,800 chars and 34.7% over 1,500. A
  full batch of 8 embeds in ~2.6 s on the dev host's GPU (an RTX 3050) and 50-69 s on an 8-core
  CPU. MEASURED end to end on the GPU, embedding per file as onboarding does (~3,870 calls of up to
  8), the 20,839-chunk P0 store took 81 min, 0.23 s per chunk; at the CPU rate the same corpus is
  36-50 h. The global KB holds 11 entries, 30,464 chars (~8k tokens); a repository's KB plus
  learnings is ~0.7 MB (~170-210k tokens). Ollama 0.33.3 answers `/api/rerank` with 404, the same
  as an unknown route. Every dispatch is a CLI run, and one costs ~22 s and ~34k tokens even for a
  three-sentence reply (AGENTS.md, step summaries).
- **F12. Overview questions are rare, and the plan tree is not searchable.** A stable sample of 40
  of the 2,581 distinct logged queries, read by hand (the split is a judgement): 35 are local
  lookups by identifier, field or function; 2 ask for a repository-wide enumeration (committed
  secrets, Symfony usage), which grep answers exhaustively and ranked retrieval cannot; 1 asks for an
  overview outright ("activit module structure main areas …") and 2 survey several areas at once.
  All three overview queries, and 19 of the 40, came from `10_8-plan-build`. The plan mirror
  (`.haive-data/plan.{json,md}`) sits outside `KNOWLEDGE_SOURCE_PREFIXES`, and the code collector
  skips `.haive-data`, so no plan node reaches `rag_search`. The dev install holds no plan today, so
  what that costs is unmeasured. → D5.
- **F13. Part of the corpus and the queries is Slovak, and the lexical half matches it only
  verbatim.** At least 10.7% of chunks (2,133, in 202 files, 1,573 of them in the custom module)
  and at least 6.3% of calls (197 of 3,103) contain Slovak diacritics; both are lower bounds,
  because Slovak written without them is not counted. The `english` configuration leaves such words
  accented and unstemmed: it stores `Kotolňa nová revízia plynové` as `'kotolňa' 'nová' 'plynové'
  'revízia'`, so a query for `kotolna` matches neither `kotolňa` nor the inflection `kotolne`.
  Agents write both spellings: 172 calls contain `kotolna` and 18 `kotolňa`, 6 `revizi` and 22
  `revízi`. The corpus splits the same way: `kotolna` is in 55 chunks, 51 of them inside
  identifiers, and `kotolňa` in 5 prose labels; `revízi` is in 235 chunks and `revizi` in 28. So
  each spelling misses part of the corpus lexically. The `unaccent` extension ships with the stack's
  Postgres (1.1) but is not installed; external and DDEV stores are unchecked. → P2(e), P3.
- **F14. On the HNSW path the dense pool is 40 candidates, not 50.** `candidatePool` asks each
  ranker for 50, but an HNSW index scan ends after `hnsw.ef_search` candidates, 40 by default, and
  identical vectors share one. Measured on a 1,820-row store holding 1,634 distinct vectors, with
  the index path forced, the dense query `ragHybridSearch` runs (`LIMIT 50`) returned 40 rows for
  one query vector and 41 to 50 for eight others; `hnsw.iterative_scan` (`relaxed_order` or
  `strict_order`) or `ef_search` 100 returned 50. Left to itself, the planner chose an exact scan
  and sort at that size, iterative scan on or off. `search.ts` records why the default stays: on
  the modest table it was measured on, `ef_search` 100 flipped the planner to a 430 ms sequential
  scan against a 5 ms index scan, and iterative scan would need a `SET LOCAL` inside a
  transaction. The GLOBAL store's dense reads now do exactly that (`denseRead`), because its
  `embed_model` filter runs after the scan; per-repo reads are unchanged. On the 20,839-row P0 store
  the planner picks the HNSW index by default for all 296 golden queries, and the forced index path
  returned exactly 40 rows for every one. Against an exact search's top 50 those 40 overlap 0.749 on
  average (0.8 is the ceiling, so ~94% of the 40 are true top-50 neighbours), but 20 queries fall
  below 0.5 and 3 share no row with the exact top 50. On those 20 the default search settles in the
  wrong region of the graph: its best hit can sit at cosine distance 0.50 where the exact nearest
  is 0.15. A fresh bulk-built index gives identical results, so this is not an artefact of building
  row by row, and `hnsw.iterative_scan` does not help, because it widens the same region.
  `ef_search` 200 recovers 45-50 of the exact 50 on 19 of the 20, at ~6 ms warm against ~3 ms at
  40. What the approximation costs end to end, measured with exact dense search: recall@8 0.681 →
  0.727 overall, 0.590 → 0.700 on paraphrased questions, 0.554 → 0.575 on real ones, recall@50
  0.809 → 0.866. The planner will not take that path by itself: with `ef_search` 100 or more set,
  it switches to a sequential scan or the `repository_id` btree plus a sort (590-830 ms), so a fix
  must raise `ef_search` and force the index path inside the dense read's transaction, as
  `denseRead` does for the global store. DECIDED and built (user, 2026-10-12): a per-repo dense read
  sets `hnsw.ef_search` 200, `cpu_operator_cost` 0.1 and `hnsw.iterative_scan` `relaxed_order` for
  its own statement, and puts the prior values back afterwards, because the api runs the search
  inside its own transaction and `SET LOCAL` would otherwise reach the knowledge-reserve query. The
  cost knob is what keeps the planner on HNSW for a repository that fills its store, while a
  repository holding 5% or less of a shared store keeps its exact btree/bitmap sort; `enable_sort =
  off` also reached HNSW but cut a 5% repository's pool to 8 rows. The iterative scan fills a shared
  store's pool: on a simulated 5-repository copy of the P0 store, a repository holding 20% of the
  rows got 34-39 of 50 candidates with the wider search alone and 50 on all 41 queries with it
  (overlap with an exact top 50 0.829 → 0.988). On the P0 store: recall@8 0.681 → 0.719 overall,
  0.590 → 0.680 paraphrased, 0.554 → 0.568 real; search p95 at k=8 48 → 65 ms. → P3.
- **F15. Deleted vectors keep their index space.** The dev install's shared project store holds 0
  rows and a 0-byte heap, yet 312 MB, 275 MB of it the HNSW index; the vectors of the repositories
  deleted since stay allocated in it. A full re-embed churns the index the same way. → P1.
- **F16. The identifier ranker scores mentions, not the definition.** The lexical-only branch
  gained the hybrid branch's identifier ranker (FNF #42), measured read-only on a 1,820-row store
  with the identifier lexemes computed on the fly: 14 identifier queries whose gold chunk is the
  function's definition went from MRR 0.143 (hit@8 2/14) to 0.595 (11/14), and 8 prose queries kept
  byte-identical pages. Three of the remaining misses (`CheckAdminLogin`, `getMultiPages`,
  `compareOldSettings`) were lost because callers tie with or outrank the definition on the summed
  IDF. The ranker now puts a chunk whose `section_id` names a query term (`function-<name>`,
  `method-<Owner>-<name>`, `class-<name>`) ahead of its mentions: identifier MRR 0.595 → 0.821 on the
  lexical-only branch and 0.512 → 0.643 on the hybrid one, prose and negative pages identical, and
  `CheckAdminLogin` from a miss to rank 1. `getMultiPages` and `compareOldSettings` still miss: their
  definition chunk's body never contains the name, so no lexical ranker selects it. That is the
  chunker gap F1/F9 describe, not a ranking one. → P1.

## Phases

### P0. Retrieval eval (gates everything)

The committed public fixture uses authored identifier questions, paraphrases without identifiers,
judged overview questions and no-answer questions over the pinned Haive shared-source tree.
Identifier questions share vocabulary with their source, which flatters lexical matching, so they
never stand alone. Overview questions have multi-fact source rubrics and pair judgments, not a
single gold chunk; their evidence coverage is reported separately from recall. Private logged
queries remain outside the committed set. A script reports
recall@k and MRR for k in {5, 8, 12, 20} against a store built from the current chunker, and its
numbers are recorded here as the baseline. It also reports the dense pool's recall against an exact
search on the same queries (S7's flat baseline), since the HNSW path keeps 40 candidates by
approximation (F14). The existing nullable `result_hits` column on `rag_query_log` (migration 0180) (source path, section, rank, each
ranker's rank) records final hit identity/order; it does not by itself freeze the historical corpus or
reproduce search. Keep it; do not add a second `hits` column or replay migration 0180.

**Reproducible baseline (2026-11-17).** The committed, non-private Haive fixture is
[`packages/worker/test/fixtures/rag-eval/`](../../packages/worker/test/fixtures/rag-eval/).
`manifest.json` pins the corpus/config; `queries.json` fixes labels, languages and splits;
`baseline-{hybrid,lexical}.json` retains compact per-query scores; report summaries are recomputed;
`baseline-provenance.json` records precisely which code and runtime produced them.
The old private 2026-10-12 table below is history, not a grading set.

The store held 2,141 code chunks, zero hash-fallback rows, from the scoped Haive shared source
at `b8a2dde4def9b442d85c426ce771c72ae7c8ffee`. The dry run preceded the 161-second local
Ollama build. The scratch database `haive_rag_rge_s_codex2_20261117` was dropped after measurement;
`pg_database` verification returned 0. Neither the old P0 database nor any live store was used.
There were no paid model calls, service restarts, app source edits or container artifact rebuilds.
All 180 queries remain present; all 204 source/rubric anchors validate at the pinned commit,
and all 144 positive golds are in the store. Each arm uses production retrieval unchanged.

| group | n | hybrid recall@8 [95% CI] | hybrid MRR@8 | lexical recall@8 [95% CI] | lexical MRR@8 |
|---|---:|---|---:|---|---:|
| all answerable | 144 | 0.861 [0.799, 0.917] | 0.640 | 0.403 [0.319, 0.486] | 0.389 |
| identifier | 72 | 0.972 [0.931, 1.000] | 0.811 | 0.792 [0.694, 0.889] | 0.764 |
| paraphrase | 72 | 0.750 [0.639, 0.847] | 0.469 | 0.014 [0.000, 0.042] | 0.014 |
| English | 48 | 0.875 [0.771, 0.958] | 0.658 | 0.417 [0.271, 0.562] | 0.403 |
| French | 48 | 0.875 [0.771, 0.958] | 0.642 | 0.396 [0.250, 0.542] | 0.382 |
| Slovak | 48 | 0.833 [0.729, 0.938] | 0.619 | 0.396 [0.250, 0.542] | 0.382 |
| tuning | 72 | 0.861 [0.778, 0.931] | 0.679 | 0.431 [0.319, 0.542] | 0.403 |
| held-out | 72 | 0.861 [0.778, 0.931] | 0.600 | 0.375 [0.264, 0.486] | 0.375 |

Every class/language/split cell at k=8 (positive cells: recall / MRR, with recall CI;
overview: judged fact coverage; no-answer: dense-threshold FPR using the globally fixed tuning tau). This exact cell table is emitted by the committed report CLI with `--cells`; all page sizes are recomputed from the compact JSONs.

| class | language | split | n | hybrid metric [95% CI] | lexical metric [95% CI] |
|---|---|---|---:|---|---|
| identifier | en | tuning | 12 | 1.000 [1.000, 1.000] / 0.878 | 0.833 [0.583, 1.000] / 0.778 |
| identifier | fr | tuning | 12 | 1.000 [1.000, 1.000] / 0.836 | 0.833 [0.583, 1.000] / 0.778 |
| identifier | sk | tuning | 12 | 1.000 [1.000, 1.000] / 0.878 | 0.833 [0.583, 1.000] / 0.778 |
| paraphrase | en | tuning | 12 | 0.833 [0.583, 1.000] / 0.590 | 0.083 [0.000, 0.250] / 0.083 |
| paraphrase | fr | tuning | 12 | 0.667 [0.417, 0.917] / 0.441 | 0.000 [0.000, 0.000] / 0.000 |
| paraphrase | sk | tuning | 12 | 0.667 [0.417, 0.917] / 0.451 | 0.000 [0.000, 0.000] / 0.000 |
| identifier | en | held-out | 12 | 0.917 [0.750, 1.000] / 0.757 | 0.750 [0.500, 1.000] / 0.750 |
| identifier | fr | held-out | 12 | 1.000 [1.000, 1.000] / 0.763 | 0.750 [0.500, 1.000] / 0.750 |
| identifier | sk | held-out | 12 | 0.917 [0.750, 1.000] / 0.753 | 0.750 [0.500, 1.000] / 0.750 |
| paraphrase | en | held-out | 12 | 0.750 [0.500, 1.000] / 0.406 | 0.000 [0.000, 0.000] / 0.000 |
| paraphrase | fr | held-out | 12 | 0.833 [0.583, 1.000] / 0.529 | 0.000 [0.000, 0.000] / 0.000 |
| paraphrase | sk | held-out | 12 | 0.750 [0.500, 1.000] / 0.396 | 0.000 [0.000, 0.000] / 0.000 |
| overview | en | tuning | 3 | 0.528 [0.333, 0.750] | 0.000 [0.000, 0.000] |
| overview | fr | tuning | 3 | 0.250 [0.000, 0.500] | 0.000 [0.000, 0.000] |
| overview | sk | tuning | 3 | 0.250 [0.000, 0.500] | 0.000 [0.000, 0.000] |
| overview | en | held-out | 3 | 0.333 [0.000, 1.000] | 0.000 [0.000, 0.000] |
| overview | fr | held-out | 3 | 0.250 [0.000, 0.750] | 0.000 [0.000, 0.000] |
| overview | sk | held-out | 3 | 0.250 [0.000, 0.750] | 0.000 [0.000, 0.000] |
| no-answer | en | tuning | 3 | 1.000 [1.000, 1.000] | 1.000 [1.000, 1.000] |
| no-answer | fr | tuning | 3 | 0.667 [0.000, 1.000] | 1.000 [1.000, 1.000] |
| no-answer | sk | tuning | 3 | 0.000 [0.000, 0.000] | 1.000 [1.000, 1.000] |
| no-answer | en | held-out | 3 | 1.000 [1.000, 1.000] | 1.000 [1.000, 1.000] |
| no-answer | fr | held-out | 3 | 0.000 [0.000, 0.000] | 1.000 [1.000, 1.000] |
| no-answer | sk | held-out | 3 | 0.667 [0.000, 1.000] | 1.000 [1.000, 1.000] |

| k (144 answerable queries) | hybrid recall / MRR | lexical recall / MRR |
|---|---|---|
| 5 | 0.819 / 0.633 | 0.403 / 0.389 |
| 8 | 0.861 / 0.640 | 0.403 / 0.389 |
| 12 | 0.896 / 0.643 | 0.403 / 0.389 |
| 20 | 0.951 / 0.647 | 0.403 / 0.389 |
| 50 | 0.965 / 0.647 | 0.403 / 0.389 |

Overview coverage@8 (18 queries) is 0.310 [0.167, 0.463] hybrid versus 0.000 [0.000, 0.000] lexical.
The unblinded, source-evidence pair judgments in `overview-judgments.json` give hybrid 10 wins,
8 ties where neither page covers a complete rubric fact, and zero lexical wins; this does not
measure generated-answer quality. Secondary any-hit FPR@8 (18 queries) is 1.000 [1.000, 1.000] hybrid versus
0.000 [0.000, 0.000] lexical. Hybrid's mean maximum RRF is 0.016,
mean maximum dense similarity 0.491; these are diagnostics, not
calibrated answerability probabilities. Negative/overview queries never enter recall/MRR.

The paired lexical→hybrid recall@8 delta is 0.458 [0.375, 0.542], 66 wins / 0 losses /
78 ties over 144 positive queries; held-out delta is 0.486 [0.375, 0.597],
35 / 0 / 37 over 72. On the primary dense-threshold FPR at k=8, lexical→hybrid has 8 negative-query wins / 0 losses / 10 ties; any-hit alone has 18 losses.
CIs use 2,000 paired query-bootstrap samples, xorshift32 seed 1729, percentile 95%; translations
are correlated, so these describe this fixture rather than independent topic/population uncertainty.
Ranking knobs stayed fixed; only the answerability threshold below uses tuning positives.

The verified forced-HNSW dense overlap@50 is 0.999 [0.999, 1.000], with 50 index and 50 exact
rows for all 180 queries. The production/default planner chose exact search for 180/180 at this
small size; forced HNSW is a separate diagnostic, not its production plan. Scope limits remain:
this shared-source fixture has no KB/global rows, other programming languages or private traffic,
so it does not establish knowledge-reserve/global-merge or cross-repository quality.



Dense answerability at k=8 (162 answerable, including 18 overview; 18 no-answer).
Tau is fixed using 81 tuning positives, then applied unchanged to 81 held-out positives
and 9 held-out no-answer queries. It is a diagnostic, not a production search threshold.

| arm | tau | AUROC all / tuning / held-out | tuning retention | held-out retention | held-out FPR |
|---|---:|---|---:|---:|---:|
| hybrid | 0.460396 | 0.812 / 0.790 / 0.845 | 0.901 | 0.951 | 0.556 |
| lexical | 0.000000 | 0.500 / 0.500 / 0.500 | 1.000 | 1.000 | 1.000 |

The held-out hybrid no-answer result is **weak**: 5 of 9 negatives accepted
(FPR 0.556; Wilson 95% interval [0.267, 0.811]).
The interval is descriptive; translated queries share topics and are correlated.

Lexical-only scores are all zero: AUROC 0.5, tau 0 accepts everything. Its lack of returned
negative hits therefore does not imply useful dense answerability. The primary no-answer result
is held-out dense-threshold FPR; any-hit FPR is secondary. All queries retain k=8 top-dense
similarity and top-lexical flags. Every manifest byte edit invalidates the fixture fingerprint
and requires fresh baselines.

**Historical baseline (2026-10-12; private, untracked, not reproducible).** A scratch store `haive_rag_p0_eval` built by `rag-build-store.ts` from
the current chunker over the scoped tree plus the repository KB (20,839 chunks, 0 hash vectors).
The golden set (kept untracked, outside git) holds 296 queries and 438 golds, each gold a source
path plus a string from the chunk body: 100 synthetic questions that reuse the chunk's identifiers,
100 that paraphrase without them, 71 real agent queries from `rag_query_log`, and 25 overview
questions. An agent labelled the golds by search; 20 spot-checked against the tree were all valid,
and every gold is in the store. Recall@k / MRR@k, hybrid as shipped:

| kind | n | @5 | @8 | @12 | @20 | @50 |
| --- | --- | --- | --- | --- | --- | --- |
| synthetic, identifiers | 100 | 0.930 / 0.799 | 0.950 / 0.793 | 0.960 / 0.789 | 0.980 / 0.788 | 0.990 / 0.787 |
| synthetic, paraphrase | 100 | 0.540 / 0.429 | 0.590 / 0.436 | 0.620 / 0.438 | 0.660 / 0.441 | 0.750 / 0.443 |
| real | 71 | 0.491 / 0.413 | 0.554 / 0.452 | 0.589 / 0.417 | 0.610 / 0.411 | 0.692 / 0.435 |
| overview | 25 | 0.234 / 0.438 | 0.334 / 0.432 | 0.415 / 0.444 | 0.535 / 0.469 | 0.657 / 0.449 |

The overview row is recall over several golds each, kept for reference rather than as a target.
Search takes p50 33 ms, p95 49 ms. The lexical-only branch (no embedding) scores real 0.352 /
0.383, identifier questions 0.820 / 0.737 and paraphrases 0.010 at every k: with the full-text AND
empty (F6), its page is the identifier ranker's few candidates. MRR can fall as k grows because the
knowledge reserve takes `min(2, floor(top_k / 3))` slots, so a smaller page is not a prefix of a
larger one. The dense pool's numbers are in F14.

**Eval reproducibility gate.** Before changing ranking, commit a non-private fixture corpus,
query/label set and script configuration (or a versioned private-artifact manifest for owner data),
with source commit, exclusions, chunker/embedder versions, model/dimension and index settings.
Label answerable source spans/stable facts, not only a chunk id that a new chunker removes. Keep
all original questions in the denominator: a gold span lost by chunking is a miss, not a query to
delete. Report by query class and language, include no-answer queries, and separate tuning from
held-out grading. Compare the same corpus/config, with paired per-query changes and uncertainty;
20 valid spot checks do not establish every gold's correctness. Public fixtures must not contain
client code or logged private queries. Main `TASKS.md` parked T144/T147 pending such an
eval. The committed shared-source baseline supplies that scoped prerequisite; each ranking PR
still needs the same corpus/config, held-out comparisons, and explicit negative/overview results.

### P1. Chunker corrections, shipped as one reindex

Fix F1 (a docblock attaches only to the construct it immediately precedes, and the file docblock
never makes a function's range swallow it), F4 (split on a line boundary before any prose
heuristic), and F2 as D2 decides. Every change re-hashes the chunks it touches, so they ship
together and the reindex happens once. Verification: chunker unit controls that fail on main, and
the P0 eval before and after on the same queries, and the store's size before and after, since
replaced vectors keep their index space (F15). Rollback: revert the commit; the next `02` or `11c`
sync re-embeds the changed chunks back (one reindex, F11). No schema change.

MEASURED (2026-10-17, the P0 eval set on the eval repository, before = main 9c0c8ee77, after = this
change as merged, 83af0e675; each store built from scratch with the same embedder, own paths and
exclusions):

| Eval set (n) | recall@5 | MRR@5 | recall@12 | recall@20 | MRR@20 |
|---|---|---|---|---|---|
| real (71) | 0.484 → 0.519 | 0.452 → 0.452 | 0.582 → 0.596 | 0.610 → 0.638 | 0.449 → 0.469 |
| synthetic-lex (100) | 0.940 → 0.940 | 0.796 → 0.826 | 0.980 → 1.000 | 0.990 → 1.000 | 0.813 → 0.832 |
| synthetic-para (100 → 99) | 0.630 → 0.616 | 0.481 → 0.473 | 0.730 → 0.697 | 0.775 → 0.773 | 0.498 → 0.488 |
| overview (25) | 0.248 → 0.258 | 0.458 → 0.405 | 0.405 → 0.397 | 0.517 → 0.519 | 0.469 → 0.414 |
| OVERALL hybrid (296 → 295) | 0.667 → 0.672 | 0.578 → 0.582 | 0.752 → 0.750 | 0.786 → 0.796 | 0.590 → 0.594 |
| OVERALL lexical only | 0.365 → 0.366 | 0.342 → 0.353 | | 0.365 → 0.366 | 0.343 → 0.355 |

Real queries gain 3 hits at k=20 (52 → 55 of 71) and keep their MRR@5; the overview set loses MRR (its
25 queries find their files at lower ranks, one fewer within 20). One paraphrase query leaves the after
set because its gold chunk is no longer in the store: finer sections fill the 80-chunk cap of a large
file sooner, so a vendored or bundled file keeps less of itself. Counted as a miss, paraphrase hits@20
go 78 → 77 of 100 and the overall hits@20 253 → 255 of 296. The store grows 20,921 → 23,110 rows
(+10.5%), HNSW 163.4 → 180.5 MiB, database 470.8 → 515.4 MiB; neither store holds a null or
hash-fallback vector.

A review fix stopped dropping a span shorter than 120 characters between sections (a class's fields, a
decorator, the rest of a method a `}` in a string cut short): such a span now joins the section it
continues, or the one it leads into. It takes the text outside every section from 0.35% to 0.0035% of
the non-blank characters (main: 0.16%; what remains is 13 small files with no construct at all), keeps
M1, M2 and M4, finds one more JS construct (M3 176 → 175) and changes 3,838 of the 22,035 code chunk
hashes. A first after store, built before that fix, measured paraphrase hits@20 at 74 of 100, real
MRR@5 at 0.429 and overall MRR@5 at 0.569; the fix brought them back to 77, 0.452 and 0.582.

Chunker follow-up (T413, 2026-10-25): Go/Rust mask strings and comments before matching or
counting braces; Python masks triple-quoted bodies before its indentation scan. PHP methods use the
nearest class/trait/interface/enum owner without inventing names for anonymous owners. PHP
labels retain the byte >= 0x80 rule while JS names use Unicode ID_Start/ID_Continue. JSX text and
attribute text are separate from expressions, so prose punctuation cannot mask later code. CR and
CRLF retain their original bytes in code and Markdown sections and at chunk cuts. Ruby singleton
names and module ancestry are retained; an endless definition has no `end` of its own. Ruby remains
an indentation heuristic, and class bodies keep their existing whole-class sections. These corrections
intentionally change affected section ids, breadcrumbs or bodies (and therefore chunk hashes); no
new retrieval/store measurements or provider runs were made for this follow-up.

### P2. Query-side experiments (no reindex)

Each sits behind a config key, off until P0 says on, so the rollback is the key.

- **(a)** The query instruction, for F7.
- **(b)** An IDF-weighted ranker over the query's rare prose terms, for F6, with its candidates
  capped like `identifierCandidates`: an uncapped ranker rewrites the page (AGENTS.md, identifier
  search).
- **(c) Measured 2026-11-28: no win, not shipped.** Collapse identical bodies on a page, for F5:
  compare bodies without their header, keep the best, name the others, as `dedupeGlobalByEntry`
  does for global entries. It needs the SQL pool widened past `top_k` so that collapsing does not
  shrink the page. S3 found retrieved look-alikes harder on a reader than random text. Copies
  rarely reach a page, so the change has little to do (MEASURED (c) below).
- **(d)** Ranked-list truncation, for S3: end a page at a relative score cliff instead of filling
  `top_k` whenever candidates clear the absolute floors, which today almost never cut a page of 12
  or fewer (F10). The cut needs an absolute signal: `rrf` depends only on ranks, so today it is
  taken on dense similarity, and on a reranker's validated score scale once P3 lands (S5). P0 measures the
  recall it costs against the hits it removes.
- **(e) Shipped; historical design.** Accent-insensitive lexical matching, for F13: unaccent the stored `content_tsv` and the
  query where the store has `unaccent`, and keep today's vector where it does not. A change to how
  `content_tsv` is derived needs a backfill like the identifier one, since an unchanged chunk is
  never re-upserted; it costs a tsvector rewrite, not a re-embed. Inflection stays unhandled by
  the `english` configuration; the dense half is what matches it.

For (a), key the instruction to the selected embedder's documented query contract and include
instruction/version in the query-embedding cache identity. An unrelated model must not inherit
Qwen-specific formatting. For (b)–(d), preserve `applyKnowledgeReserve` on the final page after
candidate expansion/deduplication/reranking; removing reserved KB/learning slots is a different
experiment. Dedupe retains all source locations and chooses deterministically without merging
semantically different bodies that merely normalize alike. A score cliff uses a documented score
scale and a minimum useful page; low RRF alone is not a calibrated relevance probability.

**MEASURED (c) (2026-11-28): no win; do not ship.** Candidate: `collapseIdenticalBodies`, off by
default. Its first statement is main's. Only when that page holds one body twice (same source type
and the same text after the header line, compared exactly; an empty body is never a copy) does a
second statement read `LIMIT top_k + candidatePool`. It keeps the best copy of each body (`rrf`,
then dense similarity, then path), names the rest in `alsoAt`, cuts to `top_k` and runs
`applyKnowledgeReserve` on that page with the absorbed rows counted as ranked: a control caught the
reserve re-adding an absorbed copy until they were. Its 11 controls pass (those for new behavior
failed on main first), and each of 6 mutations of the candidate is caught. The paired arm used the
same store, model digest (`qwen3-embedding:4b`, `df5bd2e3...ff907`, equal to the manifest before
and after) and settings as the baseline re-run. The fixture cannot show a gain: it holds 3
duplicate groups (7 of 2,141 chunks, 0.33%; F5's repository has 8.3%), and 0 of its 180 baseline
pages hold a duplicate body at
k=5, 8 and 12, 1 at k=20 and 2 at k=50 (tuning paraphrases). The arm therefore changed no page at
k <= 12, one at k=20 (refilled to 20) and two at k=50 (9,000 hits became 8,998), and every paired
delta is exactly 0 at every page size, in recall, MRR, overview coverage and the no-answer FPR,
whether a hit counts only through its own path or also through the locations it names. Logged
pages agree: of the 29 pages with code hits that kept their hits on the dev install (268 hits), 1
holds a duplicate body, one redundant hit (0.4%). The held-out effect is 0 by construction, so
default-on has no case and the code would only ever stay off. Nothing shipped: no key, no route
plumbing, no toggle. To revisit it on a repository where copies do crowd a page, rebuild from this
description and keep three properties: a single statement when the page shows no copy, absorbed
rows counted as ranked, and a choice of copy that does not depend on row order. `formatRagHits` is
serialized into the sandbox MCP script and pinned by `rag-mcp-response.test.ts`, so rendering
`alsoAt` must leave a hit without it byte-identical.

MMR only if P0 shows near-duplicate crowding that (c) leaves.

### P3. Reranker (conditional)

Only when P0 shows recall at 50 well above recall at `top_k`. S3 gives the reason order pays: a
reader uses the first slots best and gains little past 20. A cross-encoder (S5, S6) scores each
candidate against the query and yields a model-specific score (often a logit, not a calibrated probability). It needs a candidate pool wider than
`LIMIT top_k`, which on the HNSW path also means wider than `ef_search` (F14: iterative scan can fill a filtered candidate pool, but does not fix the wrong-region
failures F14 measured; retain the shipped `ef_search`/planner policy and restore settings
before returning from a caller-owned transaction), a window that holds a
whole chunk (F11), a model that reads Slovak (F13), and a runtime: the local Ollama 0.40.16
probe below still returns 404 for reranking. D3 permits a local GPU runtime only. It judges each chunk's text
alone, so it follows P1 rather than precedes it (S6). A page has
one ordering key: `mergeHits` re-sorts the merged page by `rrf`, so a rerank applied inside
`ragHybridSearch` would be undone there, and `rrf` is shown to agents and logged, so it keeps
meaning RRF. The reranker's score is a field of its own, and the final sort, after the merge, uses
it.


**MEASURED (2026-11-17): do not ship BGE v2-m3 Q8_0 with this configuration.**
One fixed model/configuration, no tuning or model selection after grading. The decision split is
held-out. A fresh scratch database in `rrk-pg-codex1-20261117` held the same 2,141 code chunks,
zero null vectors/hashes, all 144 positive golds, and the unchanged committed fixture fingerprint
`4d56e5bc11b765f1c6b5539f1fc7de097df7f98d16e54314114c601c1da90068`.
The pinned tree and all 204 anchors verified before the dry run and 157-second build. Every
class/language/split remains in the denominator. The measured hybrid arm's metrics equal the
committed hybrid baseline at all five page sizes, including overview and negative diagnostics.

`haive-ollama` reports 0.40.16. POST `/api/rerank` with a query and documents returned HTTP
404, `Content-Type: text/plain`, `Content-Length: 18`, body `404 page not found`. Therefore the
experiment used a throwaway llama.cpp CUDA server, never a hosted inference endpoint:

- Image `ghcr.io/ggml-org/llama.cpp@sha256:d68ec493c0ff9105ddfe2e909fff304117bc6e1fffbbd8d94182bd455983c264`;
  build 12429, source `9fba51d2c9a1b5cb5f0c47986c031334e2d7663a`.
- Model repo `gpustack/bge-reranker-v2-m3-GGUF`, revision
  `3093af03b1a635e67b084b1d8c03c5f5e020fd05`, file `bge-reranker-v2-m3-Q8_0.gguf`,
  635,676,416 bytes, SHA-256 `a43c7c9b11a4c1517e5bf95151960e1621d1b72f7a493364b01e386cf1aaa1d3`
  (also verified against the pinned Hugging Face LFS oid).
- Selected as a small multilingual cross-encoder, using the
  [BGE model's documented multilingual capability](https://huggingface.co/BAAI/bge-reranker-v2-m3).
  The GGUF reports an 8,192-token trained window. Runtime flags:
  `--reranking -ngl 99 -c 2048 -b 2048 -ub 2048 -np 1 -lv 4`.
  All 25/25 layers offloaded to GPU. Tokenizing **all** 2,141 full header-plus-body chunks
  and 180 queries found maxima of 1,060 and 41 tokens; even adding eight special tokens,
  1,109 is below both runtime limits. No chunk was shortened.
- RTX 4070 Laptop, 8,188 MiB: reranker alone 533 MiB; paired-run total 3,974–3,990 MiB.
  All 21 sampled Ollama `/api/ps` responses retained the pinned `qwen3-embedding:4b` digest
  and reported 3,434,537,287 bytes of embedder VRAM. No live service restart or rebuild.

`packages/worker/scripts/rag-eval-rerank.ts` reads a store built by the existing
`rag-build-store.ts` protocol. It uses production hybrid retrieval at each baseline page size,
then reranks the **merged top 50** by the runtime's `relevance_score`, saved as `rerankScore`.
This pinned runtime emits a raw logit (a diagnostic Slovak pair scored +5.030 and −11.000),
not a calibrated probability. RRF, dense similarity and other shipped fields stay unchanged;
equal model scores retain merged shipped order. Failed/partial/invalid scoring falls back to
the original baseline page for each k. All 180 requests scored all 50 pairs: 9,000 pairs,
zero fallbacks, zero changed candidate sets, zero changed original score fields.

The knowledge quota retains `applyKnowledgeReserve`'s dense-ratio admission, small-page cap,
earned positions and append-only promotions after model ordering, with parity unit controls.
The shared helper sorts by RRF internally, so the experiment copies only its quota selection
rather than fabricating RRF. This fixture has **no KB/global rows**: its merge is the local page
with an empty global arm. The evaluator refuses non-code/mixed-repository stores. This is not
a measurement of global quotas, entry expansion, KB quality, other languages of code, private
queries, large HNSW stores or generated answers.

Recall values below are hybrid → reranked; overview/no-answer never enter recall/MRR.

| group | n | recall@5 | recall@8 | recall@12 | recall@20 | MRR@8 |
|---|---:|---|---|---|---|---|
| all | 144 | 0.819 → 0.736 | 0.861 → 0.778 | 0.896 → 0.847 | 0.951 → 0.889 | 0.640 → 0.518 |
| kind:identifier | 72 | 0.972 → 0.931 | 0.972 → 0.931 | 0.986 → 0.958 | 1.000 → 0.972 | 0.811 → 0.665 |
| kind:paraphrase | 72 | 0.667 → 0.542 | 0.750 → 0.625 | 0.806 → 0.736 | 0.903 → 0.806 | 0.469 → 0.371 |
| language:en | 48 | 0.833 → 0.813 | 0.875 → 0.854 | 0.917 → 0.896 | 1.000 → 0.896 | 0.658 → 0.576 |
| language:fr | 48 | 0.833 → 0.750 | 0.875 → 0.792 | 0.896 → 0.833 | 0.958 → 0.896 | 0.642 → 0.526 |
| language:sk | 48 | 0.792 → 0.646 | 0.833 → 0.688 | 0.875 → 0.813 | 0.896 → 0.875 | 0.619 → 0.452 |
| split:tuning | 72 | 0.819 → 0.764 | 0.861 → 0.792 | 0.889 → 0.819 | 0.931 → 0.833 | 0.679 → 0.578 |
| split:held-out | 72 | 0.819 → 0.708 | 0.861 → 0.764 | 0.903 → 0.875 | 0.972 → 0.944 | 0.600 → 0.458 |

| k | hybrid recall / MRR | reranked recall / MRR | held-out recall delta [95% CI] | held-out MRR delta [95% CI] |
|---|---|---|---|---|
| 5 | 0.819 / 0.633 | 0.736 / 0.512 | -0.111 [-0.208, -0.028] | -0.143 [-0.242, -0.038] |
| 8 | 0.861 / 0.640 | 0.778 / 0.518 | -0.097 [-0.194, -0.014] | -0.142 [-0.240, -0.041] |
| 12 | 0.896 / 0.643 | 0.847 / 0.525 | -0.028 [-0.111, 0.056] | -0.135 [-0.232, -0.037] |
| 20 | 0.951 / 0.647 | 0.889 / 0.527 | -0.028 [-0.083, 0.028] | -0.136 [-0.231, -0.038] |
| 50 | 0.965 / 0.647 | 0.965 / 0.530 | 0.000 [0.000, 0.000] | -0.135 [-0.230, -0.037] |

At k=8 on 72 held-out positive queries, reranking has **3 wins / 10 losses / 59 ties** in
recall and **15 / 31 / 26** in MRR. The primary recall delta is −0.097 [−0.194, −0.014],
and MRR delta −0.142 [−0.240, −0.041]. CIs use the unchanged 2,000 paired query-bootstrap
samples, xorshift32 seed 1729, percentile 95%. Translations share topics, so these intervals
describe the fixture, not independent-topic population uncertainty. Candidate recall@50 is
unchanged at 0.965: the loss is ordering, not missing candidates or fallback. The shipped arm's
pages at k below 50 are their own `ragHybridSearch` calls, while the reranked pages are cut
from the k=50 pool; the first 8 of the two differ for 3 of 180 queries.

Overview fact coverage@8 is 0.310 → 0.264 overall (18 queries), and 0.278 → 0.389 held-out
(9 queries; paired delta +0.111 [−0.028, +0.278]). Any-hit no-answer FPR stays 1.000 in
both arms. The existing dense-on-returned-page diagnostic's held-out FPR is 5/9 → 6/9,
retention 0.951 → 0.926 (each arm fixes its own tuning-positive tau). Separately, using the
maximum **reranker logit** with the same tuning-only 90% retention protocol gives tau −5.217,
held-out FPR 6/9 (Wilson 95% [0.354, 0.879]), retention 0.877 and AUROC 0.833. These are
descriptive answerability diagnostics; no production threshold or abstention was applied.

Warmed serial latency, measured before this task's test suites, with the embedder resident:
rerank-only p50/p95 **909/1,071 ms/query**; amortized **18.17/21.43 ms/chunk** (mean
18.01 ms/chunk, each 50-document request divided by 50). End-to-end embedding + retrieval
+ rerank p50/p95 **991/1,150 ms**, versus **75/89 ms** for embedding + shipped k=8 retrieval.
These totals sum the measured stages and exclude offline gold scoring/report work; they are not
production HTTP response times. API charges: $0, local models only; electricity unmeasured.

**P2(d), descriptive score-cliff look.** Among the first 20 model-ranked hits, the largest
adjacent logit gap averages 1.582; its position has p50 3 and p95 8. Positive/overview maximum
logits have p5/p50/p95 −6.069/−1.089/+2.978; no-answer maxima −7.586/−6.029/−2.621:
the distributions overlap. A post-measurement illustration cutting at that largest gap with a
minimum of three would keep 4.23/20 hits on average and lose another 0.278 held-out recall
[−0.375, −0.181] relative to the full reranked page. No cliff policy was selected or applied.
Neither the ordering result nor the cliff illustration supports shipping this configuration.

Both runs are committed in compact form under
`packages/worker/test/fixtures/rag-eval/rerank-bge-m3/` (`hybrid.json`, `rerank.json`), with the
runtime and model pins in `reranker-pin.json`.
`tsx scripts/rag-eval-compare.ts <dir>/hybrid.json <dir>/rerank.json` recomputes every paired
delta above, including the held-out recall@8 −0.097 [−0.194, −0.014]. To rerun inference: build
the scratch store exactly as the fixture reproduction below describes; start the pinned image
digest with `--reranking -c 2048 -b 2048 -ub 2048 -np 1 -ngl 99` and the pinned GGUF (check its
SHA-256), in a self-named throwaway container on loopback; then run `rag-eval-rerank.ts` with
`RAG_RERANK_URL` and `RAG_RERANK_PIN` pointing at it. Every chunk/query pair fit the 2,048-token
window (largest 1,109). No paid or hosted model call, dev-database write, live-source edit or
haive service restart/rebuild was used.
The scratch database was explicitly dropped (`pg_database` count 0), and both throwaway
containers removed and verified absent. This PR adds only the offline evaluator and its unit
controls. Rollback: revert the experiment commit; no product key, schema, live data or reindex
needs undoing. P3 remains unshipped; a different local model/configuration requires a fresh,
separately declared paired experiment rather than tuning against these held-out results.

**SECOND LOCAL MODEL (2026-11-17): Qwen3 improves held-out early ordering, tuning split flat; do not ship this configuration yet.**
The owner authorized one additional model, fixed before grading: Qwen3-Reranker-0.6B Q8_0.
Held-out remains the decision split. The existing `rag-eval-rerank.ts` is **byte-unchanged**,
as are the BGE runs. A new isolated scratch server held 2,141 code chunks from 252 files,
zero null vectors/hashes, all 144 positive golds and the same fixture fingerprint
`4d56e5bc11b765f1c6b5539f1fc7de097df7f98d16e54314114c601c1da90068`.
All 262 pinned files and 204 anchors verified before the dry run and 173-second build.
The measured hybrid arm's metrics match the committed baseline at all five page sizes.

The local Ollama 0.40.16 probe still returned HTTP 404 for POST `/api/rerank`
(`text/plain`, 18 bytes, `404 page not found`). Native Qwen3 support exists in the **same**
llama.cpp image as the BGE experiment; no newer build or adapter was needed:

- Image `ghcr.io/ggml-org/llama.cpp@sha256:d68ec493c0ff9105ddfe2e909fff304117bc6e1fffbbd8d94182bd455983c264`,
  build 12429, source `9fba51d2c9a1b5cb5f0c47986c031334e2d7663a`.
- GGUF repo `ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF`, revision
  `a02f48bb4f057028298c21fa033da2b30d7742d5`, file `qwen3-reranker-0.6b-q8_0.gguf`,
  639,153,184 bytes; SHA-256
  `22c9979ce4fbcdc5acdc310c6641c32797eff1aa980b8f7a2db8a8ea23429a48`, verified against
  the pinned LFS oid. The 0.6B model fits beside the embedder; no 4B run was made.
- Its embedded `tokenizer.chat_template.rerank` exactly matches the
  [original model card](https://huggingface.co/Qwen/Qwen3-Reranker-0.6B)'s system prefix,
  default English instruction, query/document format and non-thinking assistant suffix.
  The [pinned converter](https://github.com/ggml-org/llama.cpp/blob/9fba51d2c9a1b5cb5f0c47986c031334e2d7663a/conversion/qwen.py)
  extracts LM-head rows for `yes` (9693), then `no` (2152); the graph applies softmax and
  the server returns the first element. Thus `relevance_score` is
  `sigmoid(yes_logit - no_logit)`, in [0,1], **not BGE's raw logit and not a calibrated
  answerability probability**. The exact template and all pins survive in the committed pin file.
- Flags remain `--reranking -ngl 99 -c 2048 -b 2048 -ub 2048 -np 1 -lv 4`.
  All 29/29 layers offloaded. Tokenizing all 2,141 full header-plus-body chunks with the
  complete prompt template and all 180 queries gives a conservative bound of 1,051 tokens,
  including 16 extra boundary tokens, below both 2,048 limits. Runtime logs confirm a maximum
  actual pair length of 1,030 tokens and zero truncated releases across 9,000 pairs plus the
  two warmup pairs. No chunk was shortened.
- Total GPU memory during measurement was 4,562–4,564 MiB of 8,188 MiB, leaving at least
  3,624 MiB headroom. All 24 Ollama residency samples retained the pinned
  `qwen3-embedding:4b` digest and its 3,434,537,287 bytes of VRAM.

One fixed configuration scored all 50 merged candidates for all 180 queries (9,000 pairs),
with zero fallbacks, changed candidate sets, changed original hit fields or missing golds.
The evaluator keeps RRF distinct, stable ties and the same post-ordering knowledge quota.
Baseline k=8 pages differ from the prefix of the baseline k=50 pool for 5/180 queries;
the paired baseline remains the shipped page-size call. This code-only fixture has no
KB/global rows, so it does not measure real knowledge quotas, entry expansion, global merge
quality, other code languages, private traffic, large HNSW stores or generated answers.

Recall values are hybrid → Qwen3; overview and no-answer remain outside recall/MRR.

| group | n | recall@5 | recall@8 | recall@12 | recall@20 | MRR@8 |
|---|---:|---|---|---|---|---|
| all | 144 | 0.819 → 0.882 | 0.861 → 0.917 | 0.896 → 0.938 | 0.951 → 0.944 | 0.640 → 0.696 |
| kind:identifier | 72 | 0.972 → 0.986 | 0.972 → 0.986 | 0.986 → 0.986 | 1.000 → 1.000 | 0.811 → 0.826 |
| kind:paraphrase | 72 | 0.667 → 0.778 | 0.750 → 0.847 | 0.806 → 0.889 | 0.903 → 0.889 | 0.469 → 0.566 |
| language:en | 48 | 0.833 → 0.917 | 0.875 → 0.958 | 0.917 → 0.958 | 1.000 → 0.979 | 0.658 → 0.733 |
| language:fr | 48 | 0.833 → 0.875 | 0.875 → 0.896 | 0.896 → 0.938 | 0.958 → 0.938 | 0.642 → 0.715 |
| language:sk | 48 | 0.792 → 0.854 | 0.833 → 0.896 | 0.875 → 0.917 | 0.896 → 0.917 | 0.619 → 0.640 |
| split:tuning | 72 | 0.819 → 0.889 | 0.861 → 0.931 | 0.889 → 0.944 | 0.931 → 0.944 | 0.679 → 0.655 |
| split:held-out | 72 | 0.819 → 0.875 | 0.861 → 0.903 | 0.903 → 0.931 | 0.972 → 0.944 | 0.600 → 0.737 |

| k | hybrid recall / MRR | reranked recall / MRR | held-out recall delta [95% CI] | held-out MRR delta [95% CI] |
|---|---|---|---|---|
| 5 | 0.819 / 0.633 | 0.882 / 0.690 | 0.056 [-0.014, 0.125] | 0.139 [0.050, 0.228] |
| 8 | 0.861 / 0.640 | 0.917 / 0.696 | 0.042 [-0.028, 0.111] | 0.136 [0.047, 0.224] |
| 12 | 0.896 / 0.643 | 0.938 / 0.698 | 0.028 [0.000, 0.069] | 0.135 [0.048, 0.221] |
| 20 | 0.951 / 0.647 | 0.944 / 0.698 | -0.028 [-0.069, 0.000] | 0.131 [0.045, 0.218] |
| 50 | 0.965 / 0.647 | 0.965 / 0.699 | 0.000 [0.000, 0.000] | 0.132 [0.047, 0.218] |

At k=8, held-out recall improves by **+0.042 [−0.028, +0.111]** (5 wins / 2 losses /
65 ties), while MRR improves by **+0.136 [+0.047, +0.224]** (25 / 9 / 38).
The early-ordering gain is promising, but the primary recall interval includes no gain and
held-out recall@20 falls by 0.028 (two paraphrases about fencing a writer after lock loss
move from ranks 19/17 to 36/23; both are translations of one topic, so the loss is one topic). Candidate recall@50 remains 0.965. CIs use the unchanged
2,000 paired query-bootstrap samples, xorshift32 seed 1729, percentile 95%; translations share
topics, so these describe this fixture rather than independent-topic population uncertainty.
No setting, instruction, threshold, mixing weight or truncation policy was selected after grading.

The MRR gain is a single-split result. On the tuning split MRR@8 is flat to slightly worse,
−0.024 [−0.096, +0.050] (16 / 16), while tuning recall@8 rises +0.069: the reranker pulls more
golds into the top 8 there but orders them worse than the hybrid did. Over all 144 queries MRR@8
is +0.056 [−0.004, +0.117], an interval that includes zero. Bootstrapping by topic (48 topics,
3 translations each) gives held-out +0.136 [+0.027, +0.263] and pooled +0.056 [−0.025, +0.134];
the held-out minus tuning difference, +0.160 [+0.007, +0.321], barely excludes zero. Hybrid MRR@8
was already higher on tuning (0.679 vs 0.600), so the split gap is most likely noise plus
regression to the mean; the per-query label hashes and the fixture fingerprint are unchanged.
Only the model card's default web-search instruction was used; no code-specific instruction was
tried, and no other model size.

Overview coverage@8 is 0.310 → 0.444 overall and 0.278 → 0.370 held-out (9 queries;
delta +0.093 [+0.028, +0.185]). Any-hit no-answer FPR stays 1.000 in both arms.
The existing dense-on-returned-page diagnostic's held-out FPR is 5/9 → 6/9, with retention
0.951 → 0.963. Separately, the maximum **Qwen3 relevance score**, using the same tuning-only
90% retention protocol, yields tau 0.657756, held-out FPR 2/9 (Wilson 95% [0.063, 0.547]),
retention 0.926 and AUROC 0.956. This small, correlated negative set cannot establish an
abstention policy; no threshold was applied to retrieval. The committed records keep ranks and
`topDenseSim` but not the model scores, so this score-based result is a local measurement they
cannot reproduce; `answerabilityReport` on them recomputes the dense-score diagnostic instead.

Warmed serial latency with the embedder resident: rerank-only p50/p95 **1,045/1,208 ms/query**;
amortized **20.91/24.17 ms/chunk** (50-document requests divided by 50).
Embedding + retrieval + rerank p50/p95 is **1,133/1,304 ms**, versus **90/108 ms** for embedding
+ shipped k=8 retrieval. These stage sums exclude offline gold/report work and are not
production HTTP timings. The 180-query evaluator took 252 seconds. Timing finished before
any test suite ran. API charges were $0; inference was local only; electricity was unmeasured.

**P2(d), descriptive only, local measurement (model scores are not committed).** The largest adjacent relevance-score drop in the first 20
averages 0.355, with position p50/p95 4/14. Maximum positive/overview scores have
p5/p50/p95 0.451/0.997/1.000, versus 0.010/0.049/0.927 for no-answer; their ranges overlap.
A post-measurement illustration cutting at that gap, minimum three, keeps 6.14/20 hits on
held-out on average but loses a further 0.069 recall [−0.139, −0.014] relative to the full
reranked page. No cliff policy was selected or used in the paired run.

**Recommendation: do not ship this configuration yet.** The held-out MRR and overview gains
are encouraging, and the model fits comfortably in VRAM, but the primary recall@8 improvement
is uncertain, recall@20 regresses and each query gains about a second of GPU work. That tradeoff
does not yet justify a product reranker key in this experiment. This is a recommendation about
this measured configuration, not a claim that Qwen3 lacks ranking value. No further model run
or tuning is part of the owner's one-additional-model authorization.

Compact paired runs and the exact runtime/model/template pin are committed under
`packages/worker/test/fixtures/rag-eval/rerank-qwen3/`. The existing compare/report CLIs
recompute all marginal, cell and held-out scores from those records, with k=8 dense signals.
Latency, VRAM and residency figures come from the local run; their raw samples are not committed.
Reproduction follows the baseline and BGE protocol above, using this directory's pin and
unchanged `rag-eval-rerank.ts`. The `rrk-qwen-*` self-named runtime satisfies its existing
local-origin allowlist. No paid/hosted inference, dev-database write, live-source edit, or
haive service restart/rebuild was used. The scratch database was explicitly dropped and verified
absent before both throwaway containers were removed with `docker rm -fv` and verified absent.
Rollback is reverting the single experiment commit; there is no product setting, schema, live
data or reindex to undo. P3 remains unshipped.

### P4. LLM-written chunk context (last)

S1's largest code-domain gain, but measured against a baseline with no structural header; what it
adds over Haive's header once P1 lands is unmeasured. Its cost here is the dispatcher: one CLI call
per file (~2,200 files) is ~13 h serial and ~75M tokens before any file content (F11), and no local
generation path exists. The context depends on the whole file, so every edit re-contextualizes that
file's chunks at the next sync.

## Open decisions

- **D2.** F2 for JS/TS: extract anonymous and object-literal functions, or leave them as gap chunks.
- **D4.** S1's under-200k advice fits the global KB (~8k tokens today): deliver it whole instead of
  retrieving it, or keep retrieval (it grows, and is faceted per project).
- **D5.** F12: index plan nodes (title and body, with their place in the tree) as a searchable
  source type, so an overview question can land on the plan's own summaries, or leave the plan to
  the steps that already receive it whole. Unmeasured: no plan exists on the dev install.

## Decided

- **D3** (2026-11-16, user). P3 uses a **local GPU runtime only**, sharing the RTX 4070
  Laptop GPU (8 GB) with the embedder in `haive-ollama` 0.40.16. No hosted reranker. The
  first pinned local configuration was measured 2026-11-17 and is not recommended to ship (P3).

- **D1** (2026-10-12, user). F3: a repository's own code and its KB are exempt from both per-file
  budgets. Files under `01-env-detect`'s `customCodePaths.include` and KB files get no chunk cap
  and a 2 MB backstop against a generated file (`fileBudget`, `MAX_OWN_FILE_BYTES`); vendored and
  contrib code keep 512 KB and 80 chunks. Raising the caps for every file was rejected, because it
  would index vendored bundles as distractors; a per-repository budget was rejected as more
  mechanism for the same outcome. MEASURED with `rag-build-store.ts` (`RAG_OWN_PATHS`) on the eval
  repository: KB 994 → 1,076 chunks, code 19,845 → 22,067 (+2,304 in all, +11%). 1,197 of those
  are `datatables.js`, a vendored library bundled inside the custom module, which the exemption
  treats as own code; `ckeditor.js` (632) stays out. Whether that bundle costs retrieval is for
  P1's before/after eval to show.

## Critical files

- `packages/worker/src/step-engine/steps/onboarding/_rag-chunkers.ts` (`phpRanges`,
  `assembleSections`, `chunkSection`, `capChunks`)
- `packages/worker/src/step-engine/steps/onboarding/10-rag-populate.ts`
- `packages/worker/src/step-engine/steps/workflow/_rag-index.ts`
- `packages/worker/src/queues/global-kb-sync-queue.ts`
- `packages/shared/src/rag/search.ts` (`ragHybridSearch`), `packages/shared/src/rag/identifiers.ts`,
  `packages/shared/src/rag/embed.ts` (`embedQueryOrNull`)
- `packages/api/src/routes/rag.ts` (`logRagQuery`, `mergeHits`)
- `packages/database/src/schema/rag.ts`
- `packages/worker/scripts/rag-eval.ts`

## Re-measuring

- **Chunker numbers.** Run `extractCodeSections`, `chunkSection` and `capChunks` over the
  repository tree inside `haive-worker` (`pnpm --filter @haive/worker exec tsx <file>.mts` from
  `/app`; the `.mts` extension allows top-level await), with the collector options the sync uses:
  `scope_exclude_globs`, `01-env-detect`'s `customCodePaths.exclude` and `09_7`'s selection.
- **F6.** The denominator is the `rag_query_log` rows with `code_hits > 0 AND runbook_hits = 0`;
  F6's share is those among them with `max_rrf <= 0.0164`, the pages where no hit came from two
  rankers. `max_rrf > 0.0164` counts the two-ranker complement instead. Valid while `rrfK` is 60 and
  no candidate pool exceeds 50.
- **Replay.** Load the chunks into a scratch database's temp table, build the trigger's exact
  tsvector (the `english` half plus the identifier lexemes), and apply `plainto_tsquery`.
- **F14.** In one transaction, `SET LOCAL enable_seqscan = off` and `enable_bitmapscan = off`, then
  count the rows the dense query returns for `LIMIT 50`, once as is and once with
  `hnsw.iterative_scan` set. Bind the query vector as a parameter or a scalar subquery: one taken
  from a join cannot use the index.
- **F15.** Compare `pg_relation_size('idx_rag_vector_hnsw')` with the table's live row count.
- **P0 baseline.** Use the committed fixture and rerun protocol below. Keep the source tree,
  query/label set, model/digest, dimensions and index protocol fixed for a paired experiment.

### Reproduce or compare the committed fixture

The public baseline is `packages/worker/test/fixtures/rag-eval/`: `manifest.json` pins the
Haive source tree (`b8a2dde4def9b442d85c426ce771c72ae7c8ffee`), all 262 allowlisted source
hashes, collector/chunker hashes, the local model digest, dimensions, and index/search settings.
`queries.json` holds 180 authored questions, not logged queries: 72 identifier, 72 paraphrase,
18 overview and 18 no-answer; English, French and Slovak are equally represented. Only query
language changes. The corpus is production TypeScript under `packages/shared/src`; tests,
other packages, docs, dependencies, generated files and managed knowledge are excluded.
The materialized tree has no Git index, so the default secret policy also excludes
`config/secrets.service.ts`. Nine collected files yield no chunks; 252 files yield 2,141 chunks.
There are no KB/global rows: this baseline cannot establish knowledge-reserve or global-merge
quality. It tests Haive's shared-source scope, not the historical client-code corpus.

Every positive label is a source path and body anchor. `anchors.json` is a script-generated
snapshot of the 24 distinct path/anchor pairs, with each pinned file hash and context lines.
Unit tests validate all 204 references against this snapshot without Git history. A separate
`skipIf` test checks all corpus hashes and regenerates the snapshot when `git cat-file -e` can
read the pinned commit; otherwise its test name explains the skip and other tests still run.
Regenerate deliberately with `tsx scripts/rag-eval-fixture.ts --snapshot` after fixture edits. A lost indexed span remains a miss. Topic variants, translations and overview
supporting evidence share one split; neither labels nor queries cross from tuning into grading.
Overview uses author-judged multi-fact rubrics, reported as evidence coverage (a fact needs any
supporting anchor in returned bodies), never single-gold recall or generated-answer quality.
For answerability, each query records `signal` at k=8: maximum returned dense similarity
(zero for an empty/lexical-only page), plus whether the first hit has an FTS or identifier rank.
AUROC distinguishes all answerable queries (including overview) from no-answer, with half
credit for ties. Set tau to the highest observed tuning-positive score retaining at least
90% of tuning positives (ceil(0.9*n), score >= tau), then apply it unchanged to held-out.
Report held-out FPR and retention, plus AUROC by split. `answerability[k].groups` grades every
class/language/split/cell using this one globally fixed tau; cells never fit their own cutoff.
Each negative group includes accepted/total counts, bootstrap `fprCI` and `fprWilson95`.
Any-hit FPR in `groups.*[k].noAnswer` remains secondary.
Lexical-only has zero dense scores; its AUROC is 0.5 and tau=0 accepts everything, demonstrating
that it has no dense answerability signal. This is an offline diagnostic, not a production gate. Overview and no-answer never
enter recall/MRR. No paid provider or generation call is needed.

Run from a checkout containing the fixture and its pinned Git history, with dependencies and
libraries built. First validate/materialize, into a newly created empty directory:

```bash
RGE_TREE=$(mktemp -d /tmp/haive-rge-tree.XXXXXX)
pnpm --filter @haive/worker exec tsx scripts/rag-eval-fixture.ts "$RGE_TREE" > /tmp/rge-verified.json
```

Before using the dev embedder, run the idle check below and wait while its count is nonzero.
Never restart services for this eval. `docker exec` runs diagnostics in the existing worker;
it does not install dependencies or rebuild any runtime artifact.

```bash
docker exec haive-postgres psql -U haive -d haive -tAc \
  'select count(*) from cli_invocations where ended_at is null and started_at is not null'
docker exec haive-worker mkdir -p /tmp/rge-eval/tree /tmp/rge-eval/runtime/scripts
docker cp "$RGE_TREE/." haive-worker:/tmp/rge-eval/tree/
docker cp packages/worker/test/fixtures/rag-eval/queries.json haive-worker:/tmp/rge-eval/queries.json
docker cp packages/worker/test/fixtures/rag-eval/manifest.json haive-worker:/tmp/rge-eval/manifest.json
```

If the container cannot see this checkout, copy the five eval scripts into the isolated temporary
runtime and link its dependencies/source to the existing container checkout. The module marker
is necessary for ESM. Check and record the container's actual Git commit, builder/chunker/collector
and shared source **and dist** hashes: a baseline/candidate must use the intended production code.
The measured baseline used main at `c29624d84fd091a9fb8adf4f03d59e3143c9caf4` for builder/production
code (matching the pinned parent in all measured code paths), plus the five eval scripts at
measurement time. `baseline-provenance.json` retains their measured SHA-256 values and separately
records the committed fixture-helper hash: snapshot/drift helpers were added after measurement;
the fingerprint expression is unchanged, now the named export `fixtureFingerprint`. The report was later extended offline for cell FPR,
Wilson intervals and paired threshold diagnostics; the compact measurement records are unchanged.
No live application source was edited.

```bash
docker exec haive-worker ln -s /app/packages/worker/node_modules /tmp/rge-eval/runtime/node_modules
docker exec haive-worker ln -s /app/packages/worker/src /tmp/rge-eval/runtime/src
docker exec haive-worker sh -c 'printf "{\"type\":\"module\"}\n" > /tmp/rge-eval/runtime/package.json'
docker exec haive-worker cp /app/packages/worker/scripts/rag-build-store.ts /tmp/rge-eval/runtime/scripts/
for RGE_SCRIPT in rag-eval.ts rag-eval-fixture.ts rag-eval-metrics.ts rag-eval-report.ts rag-eval-dense.ts; do
  docker cp "packages/worker/scripts/$RGE_SCRIPT" "haive-worker:/tmp/rge-eval/runtime/scripts/$RGE_SCRIPT"
done
```

Check the local Ollama `/api/tags` model digest against the manifest before building; use only
`qwen3-embedding:4b` (2560 dimensions), never a cloud alias. The measured versions were Ollama
0.40.16, PostgreSQL 18.7, pgvector 0.8.7, unaccent 1.1. HNSW uses `halfvec(2560)` cosine,
default construction `m=16, ef_construction=64`; per-repository reads use `ef_search=200`,
`cpu_operator_cost=0.1`, iterative `relaxed_order`. First run the no-write dry run:

```bash
docker exec -e RAG_TREE=/tmp/rge-eval/tree -e RAG_DRY_RUN=1 \
  -e RAG_EXTENSION_SET='[".ts"]' -e RAG_OWN_PATHS='["packages/shared/src"]' \
  -w /app/packages/worker haive-worker ../../node_modules/.bin/tsx scripts/rag-build-store.ts
RGE_STORE="rge_eval_$(date -u +%Y%m%d_%H%M%S)"
RGE_REPO=$(node -p 'require("crypto").randomUUID()')
docker exec -e RAG_TREE=/tmp/rge-eval/tree -e RAG_STORE="$RGE_STORE" \
  -e RAG_REPOSITORY_ID="$RGE_REPO" -e RAG_EXTENSION_SET='[".ts"]' \
  -e RAG_OWN_PATHS='["packages/shared/src"]' -w /app/packages/worker \
  haive-worker ../../node_modules/.bin/tsx scripts/rag-build-store.ts
for RGE_MODE in hybrid lexical; do
  RGE_LEXICAL=0
  if [ "$RGE_MODE" = lexical ]; then RGE_LEXICAL=1; fi
  docker exec -e RAG_QUERY_SET=/tmp/rge-eval/queries.json \
    -e RAG_PROJECT="$RGE_STORE" -e RAG_REPOSITORY_ID="$RGE_REPO" \
    -e RAG_LEXICAL_ONLY="$RGE_LEXICAL" -e RAG_DENSE_CHECK="$((1-RGE_LEXICAL))" \
    -e RAG_OUT="/tmp/rge-eval/$RGE_MODE.json" -w /app/packages/worker \
    haive-worker ../../node_modules/.bin/tsx /tmp/rge-eval/runtime/scripts/rag-eval.ts
  docker cp "haive-worker:/tmp/rge-eval/$RGE_MODE.json" "/tmp/rge-$RGE_MODE.json"
done
```

Dense checking excludes task rows, verifies the forced HNSW plan (disabling the sort as well
as sequential/bitmap scans), and compares its top 50 to an exact halfvec scan. Disabling only
sequential scans can still select the repository btree plus a sort and falsely report perfect
approximation recall. Each diagnostic setting stays in its read-only transaction. The default
production plan is reported independently; a small store can correctly choose exact search.

`rag-eval.ts` computes its fingerprint from the exact manifest and query bytes; `RAG_MANIFEST`
defaults to `manifest.json` beside `RAG_QUERY_SET`. Standalone query sets still run when that
default file is absent; their output has no fixture identity and comparison refuses them with
`not comparable: no fixture manifest`. An explicitly supplied missing `RAG_MANIFEST` fails.
Query/manifest reads and result writes use descriptor-held `@haive/shared/fs-safe` operations;
a symlink in an input or its parent directories is refused. Any manifest edit, including whitespace
or provenance, invalidates both fixture baselines and requires remeasurement. There is no operator-supplied id.

`RAG_OUT` includes all pages (5, 8, 12, 20, 50), source bodies for rubric inspection, per-query
scores and summary cells. Set `RAG_COMPACT=1` to write only minified query records, or use exported
`compactRun` on saved output. Committed baselines are below 150 KB each: all page scores, query
metadata, label SHA-256 and k=8 signals remain; duplicate golds, hit bodies, summaries, milliseconds
and per-query dense-pool dumps are omitted (lost golds alone are retained to preserve missing counts).
Structured `settings` also survives compaction: the embedding model and dimensions used by the
run, page sizes (`ks`), whether the search is repository-scoped, and effective search defaults,
arm (`search.lexicalOnly`) and ranking knobs. Forced lexical-only runs (`RAG_LEXICAL_ONLY=1`) record the
configured embedder but make no query embedding call. Both committed compact baselines had this metadata restored
from their original full-run settings, page keys and recorded model/store/runtime provenance;
query records, scores and fingerprint did not change and no new measurement was made.
Dense-pool aggregate results remain in provenance; full run output stays in external evidence.
The report recomputes class/language/split/cell summaries, CIs, AUROC and the fixed-threshold FPR.
`--cells` emits the exact Markdown cell table above from the same summary code:

```bash
pnpm --filter @haive/worker exec tsx scripts/rag-eval-report.ts \
  test/fixtures/rag-eval/baseline-hybrid.json
pnpm --filter @haive/worker exec tsx scripts/rag-eval-report.ts --cells \
  test/fixtures/rag-eval/baseline-hybrid.json test/fixtures/rag-eval/baseline-lexical.json
pnpm --filter @haive/worker exec tsx scripts/rag-eval-compare.ts \
  test/fixtures/rag-eval/baseline-lexical.json test/fixtures/rag-eval/baseline-hybrid.json /tmp/rge-comparison.json
```

The report also hashes HEAD's committed chunker/collector/builder blobs against
`manifest.chunker.files` and prints a warning on drift or unreadable files. It never fails solely
for drift. This warning is tested; it does not silently update or bless a stale baseline.

The comparison refuses mismatched fingerprints, ids, labels, metadata, metric versions and
missing pages/scores. It also requires observed structured settings and refuses different fixed
`embeddingModel`, `embeddingDimensions`, `ks` or `repositoryScoped`, naming the field. A selected
comparison k must belong to the recorded page protocol. The arm and search ranking knobs are
experiment variables: they may differ deliberately, and the comparison retains both runs' settings
as `settings.before/after` so the change is visible. The lexical/hybrid baseline pair still loads.
Deltas are candidate minus baseline; wins/losses/ties use higher recall,
MRR and coverage, and lower negative dense-threshold `fpr`. Each arm fixes its own global tau
using only its tuning positives; that tau is held fixed across all held-out and cell comparisons.
`answerability[k].before/after` reports each arm’s tau, AUROC, FPR and retention by split and group.
Secondary `anyHit` and `maxRrf` deltas also prefer lower values. The compact baselines retain dense
signals only at k=8: other k values have null answerability and per-query `fpr`, with no grouped
`fpr` metric; any-hit never substitutes for it. It reports every query and every marginal/cell,
with a paired query bootstrap (2,000 samples, xorshift32 seed 1729, percentile 95% CI). Do not use
a new fixture id to hide an indexer's misses. Only change an experiment knob deliberately,
record it, and use the same frozen corpus/labels/model/index protocol. Translations are correlated:
these CIs describe this query set, not independent topics or unseen repositories. Cell-table CIs use the seeded bootstrap;
the primary held-out no-answer result also gives a Wilson 95% interval because n=9 is small.
Small-group CIs and constant-outcome bootstrap intervals are descriptive, not guarantees. Grade held-out separately;
no ranking setting was tuned on either split in this baseline PR.

After saving evidence, close connections and drop **only** the freshly named scratch database:

```bash
docker exec haive-postgres dropdb -U haive "haive_rag_$RGE_STORE"
docker exec haive-postgres psql -U haive -d haive -tAc \
  "select count(*) from pg_database where datname='haive_rag_$RGE_STORE'"
```

The second command must return 0. Never reuse or drop `haive_rag_p0_eval` or any live store.
Rollback is reverting the eval commit; it changes no production search, schema or live data.
