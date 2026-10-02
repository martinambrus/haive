# RAG embedding failures

**A failed embed never becomes a hash vector.** `hashEmbed` is a deterministic SHA-256
vector with no semantic content, so once an index holds real vectors a hash row is NOISE
in the dense half of the RRF fusion — it can outrank a genuine lexical hit, and nothing
downstream can tell the two apart. Every ingest loop used to `catch` any embed error and
substitute one, logging a `warn`. MEASURED on an 8-core CPU-only host with
`qwen3-embedding:4b`: a batch of 8 real code chunks takes 50-69s (10.5s on GPU) against
the old hard 60s budget, so on a CPU host that substitution was the DEFAULT outcome, not
an edge case — and the index it produced looked healthy.

`embedBatch` (`step-engine/steps/_rag-embed-health.ts`) is the one embed path for all three
loops (`workflow/_rag-index.ts` for 02/11c, `onboarding/10-rag-populate.ts`,
`queues/global-kb-sync-queue.ts` — which was also UNBATCHED, sending up to
`MAX_CHUNKS_PER_FILE` 80 chunks in one call). It returns `embedded` / `hashed` / `failed`.
`hashed` is reachable only two ways, and neither is a mid-run accident: the repo has no
embedding endpoint at all (every chunk hashes, which is homogeneous and therefore honest),
or `CONFIG_KEYS.RAG_EMBED_STRICT_ENABLED` is off, which restores the old behaviour byte for
byte and is the no-deploy rollback.

**What a failure does depends on WHEN the step runs.** `10-rag-populate` FAILS — "the index
is populated" is its whole contract and a human is watching onboarding. `02-pre-rag-sync`
and `11c-rag-reindex` leave the chunks UNINDEXED and carry on: 02 runs at the start of every
workflow task, so failing it would block all work on the repo over a broken index. An
absent row is honest; a stale row left by a skipped update still points at the right file.

**Two timeouts, because one call serves both jobs.** `ollamaEmbed` is used by bulk ingestion
AND by the interactive `rag_search` query embed, so a single budget is simultaneously too
tight for a CPU batch and far too loose for a tool call (MEASURED: one query embed is 0.44s
on the same CPU host). `RAG_EMBED_TIMEOUT_MS` (240000) and `RAG_QUERY_EMBED_TIMEOUT_MS`
(20000) split it; `resolveEmbedBudget` falls back to the module constants when ConfigService
is uninitialized, because `worker/scripts/rag-eval.ts` imports the module standalone.
Lowering `RAG_EMBED_BATCH_SIZE` is the better fix for a slow host than raising the timeout.

**Per-repo memory, because a step row does not survive a retry.** `repositories.
rag_embed_degraded_at` is the STRUCTURAL flag every reader gates on;
`rag_embed_degraded_reason` beside it is display copy that outlives the state it describes
(the message-column rule in [AGENTS.md](../../AGENTS.md)'s Conventions). Only a completed run with REAL embeddings clears it — a
hash-mode run proves nothing about whether embeddings work.

**`rag_embed_lexical_only` is the accepted verdict, and it is NOT "keep hashing".** It forces
`ragHybridSearch`'s existing lexical-only branch (the one a jsonb-only store already takes),
so an accepted repo gets honest full-text ranking instead of full-text plus noise — VERIFIED
on a live 9,197-row index: the same query returns 5 hits either way, `maxDense` 0.7233 with
the dense half on and 0.0000 with it off. The api reaches that branch by two routes and both
skip the vector rather than hashing one: the repo flag, and `embedQueryOrNull` returning null
for a single query that could not be embedded. `embedQuery` keeps its hash fallback for
callers that must have a vector of the right width.

Recovery re-embeds only where hash rows can actually exist — leaving lexical-only mode, or
the explicit Rebuild action for a repo indexed before this existed (those carry no
degradation record and have no other route back). A repo that merely failed under strict mode
has no hash rows, so its next incremental sync picks the missing chunks up as ordinary
inserts. `forceRagReembed` nulls `chunk_hash` rather than deleting: rows stay searchable
until they are replaced, and that RECOVERY path issues no DDL of its own.

Do not read that as "Haive never issues DDL against a user-owned store" — it does.
`ensureRagSchema` never reads `conn.mode`, and `ddev` is routed through `resolveExternal`, so
the full path (`CREATE EXTENSION vector`, `CREATE TABLE`, the indexes, `CREATE OR REPLACE
FUNCTION update_content_tsv`, the dedupe `DELETE`) runs against `external` and `ddev` stores
exactly as against `internal`, on every sync. The mode-aware protection is on the DESTRUCTIVE
side only: `cleanupRagForRepository` drops databases and is kept off external/ddev by its
CALLER filtering `projectNames`, not by the function itself.
