# RAG retrieval improvements

> **Not started — a findings register and a ranked plan; nothing approved** (2026-09-30). Seven
> external sources are reviewed so far. The findings were measured read-only on the dev install on
> 2026-09-30. Keep this file current by editing the section a change belongs to: a new source goes
> into Sources reviewed, a re-measured number replaces the old one in Findings, a decision moves from
> Open decisions to Decided. P0 gates every other phase.

## Context

The user is feeding external RAG material (articles, tutorials) to find improvements for Haive's
retrieval: `rag_search`, over the per-repository store and the global KB. Each source is read in
full, and a technique counts only when Haive lacks it or does it worse, measured on Haive's own
chunker and logs. This plan holds what survived that test, so the findings outlive a session.

How retrieval works today (resolve by symbol; line numbers drift):

- **Writers.** `10-rag-populate` (onboarding), `runRagIndexSync` in `_rag-index.ts` (workflow
  `02-pre-rag-sync` and `11c-rag-reindex`) and `global-kb-sync-queue.ts` all chunk through
  `_rag-chunkers.ts`: construct regexes per language (`phpRanges`, `jsRanges`, …), then
  `assembleSections` (the spans between constructs become `chunk-<n>` gap sections), then
  `chunkSection` (2,000 chars, 200 overlap; split at a paragraph break, else at `'. '`, else a hard
  cut), then `capChunks` (`MAX_CHUNKS_PER_FILE`, 80). Every chunk carries a
  `[path > class > function]` header inside `content`, so the header is embedded and indexed, and
  `chunk_hash` covers header and body.
- **Embedding.** `qwen3-embedding:4b` (2,560 dims) through the in-stack Ollama. Documents and
  queries are embedded as raw text (`embedQueryOrNull`).
- **Search.** `ragHybridSearch` fuses three rankers with RRF, k=60: dense (HNSW over `halfvec`, pool
  50, which is 40 on the index path: F14), `english` full text through `plainto_tsquery` (which ANDs
  every term; pool 50), and the identifier ranker (IDF-weighted, at most 3 candidates). The
  knowledge reserve holds up to 2 slots for KB rows, `mergeHits` gives the global KB up to half the
  page, and the SQL `LIMIT` is `top_k`.
- **Telemetry and eval.** `rag_query_log` records counts and score maxima per call, not which
  chunks came back. `packages/worker/scripts/rag-eval.ts` probes one query and reports where an
  expected path ranks. No golden set, recall@k or MRR exists.

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
compression and clustering do not apply. Three carries: the HNSW path returns only `efSearch`
rows, so the configured pool of 50 is 40 (F14, measured); deleted vectors keep their index space
(F15, measured); and an exact search is the recall baseline P0 should hold the HNSW path to.

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
  → D1.
- **F4. Chunks end mid-line.** `chunkSection` has no single-newline level: 32.5% of non-final
  chunks end mid-line after the cap. Before the cap it is 2,194 (29.8%), 955 of them cut at the
  `'. '` prose heuristic inside code. A single-newline fallback between the paragraph and the
  sentence levels (the recursive splitter's order) measured those 2,194 down to 691 (9.5%). → P1.
- **F5. Identical bodies across files.** 1,805 of 21,813 chunks (8.3%) share their body with another
  file's chunk: 651 groups, one body in 40 files, and the custom inspection variants share bodies
  across 15-20 files. They differ only in the path header, so they can fill a page with copies; how
  often they do is unmeasured (F8). → P2.
- **F6. The lexical rankers rarely co-support a hit.** One ranker alone scores at most 1/61 and two
  rankers at ranks ≤ 50 at least 2/110, so `max_rrf` separates them. Of 2,514 logged calls that
  returned code (none with a runbook hit; all on repositories deleted since), 1,700 (67.6%) had
  `max_rrf` exactly 1/61: no hit on the page came from two rankers. Two-ranker pages held at 31-34%
  per day from 09-08 to 09-10; the identifier ranker shipped 09-06 (`63378b26`), so the log cannot
  separate its share. A what-if replay of 150 onboarding queries against the chunks with the
  trigger's exact tsvector: 144 match nothing under the AND, and 65 carry an identifier present in
  the corpus. AGENTS.md already records plain OR and coverage ranking measuring worse. → P2.
- **F7. Queries are embedded raw.** The Qwen3-Embedding model card: "Each query must come with a
  one-sentence instruction that describes the task" (`Instruct: {task}`, a newline, then
  `Query:{query}`), typically worth 1-5%, and no instruction for documents. From neither S1 nor S2.
  → P2.
- **F8. No hit list is recorded.** `rag_query_log` keeps counts and score maxima, so none of the
  3,103 calls can be replayed or labelled. → P0.
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
  full re-embed at AGENTS.md's measured 10.5 s (GPU) or 50-69 s (CPU) per batch of 8 takes 7.2 h
  on GPU and 35-48 h on CPU for 19,845 chunks, or 3.4 h and 16-22 h for 9,197. The global KB holds
  11 entries, 30,464 chars (~8k tokens); a repository's KB plus learnings is ~0.7 MB (~170-210k
  tokens). Ollama 0.33.3 answers `/api/rerank` with 404, the same as an unknown route. Every
  dispatch is a CLI run, and one costs ~22 s and ~34k tokens even for a three-sentence reply
  (AGENTS.md, step summaries).
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
- **F14. On the HNSW path the dense pool is 40, not 50.** `candidatePool` asks each ranker for 50,
  but an HNSW index scan returns at most `hnsw.ef_search` rows, 40 by default. Measured on a
  1,820-row store with the index path forced, the dense query `ragHybridSearch` runs (`LIMIT 50`)
  returned 40 rows; `hnsw.iterative_scan` (`relaxed_order` or `strict_order`) or `ef_search` 100
  returned 50. Left to itself, the planner chose an exact scan and sort at that size, iterative scan
  on or off. `search.ts` records why the default stays: on the modest table it was measured on,
  `ef_search` 100 flipped the planner to a 430 ms sequential scan against a 5 ms index scan, and
  iterative scan would need a `SET LOCAL` inside a transaction. → P0, P3.
- **F15. Deleted vectors keep their index space.** The dev install's shared project store holds 0
  rows and a 0-byte heap, yet 312 MB, 275 MB of it the HNSW index; the vectors of the repositories
  deleted since stay allocated in it. A full re-embed churns the index the same way. → P1.

## Phases

### P0. Retrieval eval (gates everything)

A golden set in the cookbook's shape, each query labelled with the chunk or chunks that answer it,
built on the dev repository: synthetic questions per sampled chunk plus hand-judged real agent
queries. Synthetic questions share vocabulary with their chunk, which flatters lexical matching, so
they never stand alone. Overview questions, the few F12 finds, can be generated as S4 does, from
invented users and tasks and a description of the repository rather than its text; they have no
single gold chunk, so they are judged in pairs instead of scored by recall. A script reports
recall@k and MRR for k in {5, 8, 12, 20} against a store built from the current chunker, and its
numbers are recorded here as the baseline. It also reports the dense pool's recall against an exact
search on the same queries (S7's flat baseline), since the HNSW path returns 40 nearest by
approximation (F14). A nullable `hits` column on `rag_query_log` (source path, section, rank, each
ranker's rank) makes real calls replayable from then on. Rollback: the column is additive and
nullable; stop writing it, and drop it in a later change.

### P1. Chunker corrections, shipped as one reindex

Fix F1 (a docblock attaches only to the construct it immediately precedes, and the file docblock
never makes a function's range swallow it), F4 (split on a line boundary before any prose
heuristic), and F2 as D2 decides. Every change re-hashes the chunks it touches, so they ship
together and the reindex happens once. Verification: chunker unit controls that fail on main, and
the P0 eval before and after on the same queries, and the store's size before and after, since
replaced vectors keep their index space (F15). Rollback: revert the commit; the next `02` or `11c`
sync re-embeds the changed chunks back (one reindex, F11). No schema change.

### P2. Query-side experiments (no reindex)

Each sits behind a config key, off until P0 says on, so the rollback is the key.

- **(a)** The query instruction, for F7.
- **(b)** An IDF-weighted ranker over the query's rare prose terms, for F6, with its candidates
  capped like `identifierCandidates`: an uncapped ranker rewrites the page (AGENTS.md, identifier
  search).
- **(c)** Collapse identical bodies on a page, for F5: compare bodies without their header, keep the
  best, name the others, as `dedupeGlobalByEntry` does for global entries. It needs the SQL pool
  widened past `top_k` so that collapsing does not shrink the page. S3 found retrieved look-alikes
  harder on a reader than random text.
- **(d)** Ranked-list truncation, for S3: end a page at a relative score cliff instead of filling
  `top_k` whenever candidates clear the absolute floors, which today almost never cut a page of 12
  or fewer (F10). The cut needs an absolute signal: `rrf` depends only on ranks, so today it is
  taken on dense similarity, and on a reranker's probability once P3 lands (S5). P0 measures the
  recall it costs against the hits it removes.
- **(e)** Accent-insensitive lexical matching, for F13: unaccent the stored `content_tsv` and the
  query where the store has `unaccent`, and keep today's vector where it does not. A change to how
  `content_tsv` is derived needs a backfill like the identifier one, since an unchanged chunk is
  never re-upserted; it costs a tsvector rewrite, not a re-embed. Inflection stays unhandled by
  the `english` configuration; the dense half is what matches it.

MMR only if P0 shows near-duplicate crowding that (c) leaves.

### P3. Reranker (conditional)

Only when P0 shows recall at 50 well above recall at `top_k`. S3 gives the reason order pays: a
reader uses the first slots best and gains little past 20. A cross-encoder (S5, S6) scores each
candidate against the query and yields a probability. It needs a candidate pool wider than
`LIMIT top_k`, which on the HNSW path also means wider than `ef_search` (F14: iterative scan widens
it without raising `ef_search`, at the cost of a transaction per search), a window that holds a
whole chunk (F11), a model that reads Slovak (F13), and a runtime: Ollama has no rerank endpoint,
and a hosted reranker is a new processor of repository code (D3). It judges each chunk's text
alone, so it follows P1 rather than precedes it (S6). A page has
one ordering key: `mergeHits` re-sorts the merged page by `rrf`, so a rerank applied inside
`ragHybridSearch` would be undone there, and `rrf` is shown to agents and logged, so it keeps
meaning RRF. The reranker's score is a field of its own, and the final sort, after the merge, uses
it.

### P4. LLM-written chunk context (last)

S1's largest code-domain gain, but measured against a baseline with no structural header; what it
adds over Haive's header once P1 lands is unmeasured. Its cost here is the dispatcher: one CLI call
per file (~2,200 files) is ~13 h serial and ~75M tokens before any file content (F11), and no local
generation path exists. The context depends on the whole file, so every edit re-contextualizes that
file's chunks at the next sync.

## Open decisions

- **D1.** F3: keep the 80-chunk cap, raise it, budget per repository, or exempt the directories
  `09_7` selects.
- **D2.** F2 for JS/TS: extract anonymous and object-literal functions, or leave them as gap chunks.
- **D3.** P3: a local runtime only, or a hosted reranker accepted as a new processor of repository
  code.
- **D4.** S1's under-200k advice fits the global KB (~8k tokens today): deliver it whole instead of
  retrieving it, or keep retrieval (it grows, and is faceted per project).
- **D5.** F12: index plan nodes (title and body, with their place in the tree) as a searchable
  source type, so an overview question can land on the plan's own summaries, or leave the plan to
  the steps that already receive it whole. Unmeasured: no plan exists on the dev install.

## Decided

None yet.

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
  `hnsw.iterative_scan` set.
- **F15.** Compare `pg_relation_size('idx_rag_vector_hnsw')` with the table's live row count.
