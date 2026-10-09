# RAG embedding failures

**A blank repository can initialize RAG at its first workflow's `11c-rag-reindex`.**
Blank INIT seeds templates but runs neither tooling selection nor ingestion. 11c offers
internal storage with onboarding's embedding defaults when both repo mirrors are absent,
no onboarding task exists, and the repo has not been reset. Before ingestion,
`11b1-rag-source-selection` (index 11.6, between 11b and 11c) presents the shared onboarding
RAG directory picker before every configured or offered end-of-task ingestion. It scans the
worktree, using framework marker probes, Composer installer paths and `.gitignore` to
pre-exclude framework/library/generated folders, while keeping managed knowledge immune.
The tree, framework markers, Composer metadata and `.gitignore` all use the repository
root as their filesystem anchor with a relative worktree prefix. A linked worktree or
parent is refused rather than enumerated, and the displayed paths remain worktree-relative.
Framework markers at the root and `web/` are compared using the same match score and
completeness ratio as repository detection, so frontend tooling cannot hide a stronger
backend match in either location.
The winning base also prefixes framework exclusions: a Laravel app in `web/` excludes
`web/storage` and `web/bootstrap/cache`, while already-prefixed Drupal exclusions stay
unchanged. Composer and `.gitignore` metadata from both the repository root and the
winning app base contribute defaults, with each metadata file's paths rebased from its
own directory. Reads keep the repository anchor and relative worktree prefix.
Repository scope edits retain saved exclusions for paths absent from their
current tree. MEASURED on a blank Drupal repo: the picker excluded `web/core` and `vendor`
in the worktree, the main checkout lacked both when the repo editor was opened, and editing
other checkboxes dropped those exclusions. Both folders appeared after installation and
the next 02 sync then counted 10,026 code files. An unseen exclusion remains in force until
its folder is visible and explicitly re-enabled.
Both sync steps re-read the current repository deny list at apply time, so a cached form
cannot re-ingest code excluded after its file count was detected. Scope exclusions also
take precedence over worktree orphan protections when removing old indexed library rows.
Both code and managed KB ingestion also apply `taskSecretMaskPolicy`: untracked secret
paths stay out of the index, using the scan root's own tracked set and the repository's
custom allow/deny rules. An unavailable git listing treats all matches as untracked;
an unresolved task/repository policy fails closed before connecting or embedding.
Previously indexed denied paths are purged within the repository's scope before embedding,
even when missing, protected by a worktree scan, or an embedding endpoint is down.
The picker refreshes its tree on every task and preselects the saved scope, including an
explicit `[]` (include everything). `01g-rag-source-selection` (index 1.95) also precedes
every configured `02-pre-rag-sync` on full, tasklist, and quick-fix paths. It scans the main
checkout, so files installed or edited outside the task worktree are visible before pre-sync;
11b1 scans the same worktree that 11c indexes. Onboarding already presents 09_7 immediately
before population. The shared scope tree collapses the internal `.haive` directory without
enumerating its task worktrees, which ingestion always ignores. Concurrent task copies
therefore do not multiply the displayed source counts or scan cost.
Both workflow pickers park even under auto-continue, since reviewing
new project folders is a current decision rather than a reusable past answer. Saving keeps
exclusions for directories absent from the displayed tree; visible directories can be
explicitly re-enabled. Managed knowledge remains immune to scope exclusions.
Once a repository scope has been saved, it supersedes onboarding's old custom-code
exclusion heuristic and retired directory allow list; those remain fallbacks only for
repositories without a saved scope. The onboarding extension selection still applies.
Quick fixes have no 11c ingestion and skip its end picker (retained in the registry for
compatibility with tasks already parked there). Unconfigured quick fixes defer setup to a
workflow that offers ingestion. Disabled or unconfigured RAG has no pre-sync picker.
`02-pre-rag-sync` waits while that scope is missing; the shared workflow indexer refuses
unscoped blank repositories even when replaying old detect outputs. An already parked 11c
can reach the new picker by retrying 11b. Saving the scope uses the existing repo-level deny
list; subsequent sync removes previously indexed files now excluded. Detect counts the new knowledge
and code without creating storage; selecting the sync persists tooling and a minimal
environment mirror containing the project name before the existing indexer creates the
database/schema. Both `rag_search` and later workflow syncs therefore resolve the same store,
and repository cleanup can identify it. These settings are stored on this install's repository
row; 11c does not commit mirror files. An explicit `ragMode: 'none'`, onboarding history,
or reset prevents this initialization offer. A conditional write followed by re-resolution
preserves settings saved concurrently. `02-pre-rag-sync` still skips an unconfigured repo.

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

In workflow syncs, an unreachable Ollama probe skips model warmup but never selects
hash mode for a configured endpoint. Batches still try that endpoint through `embedBatch`:
under strict mode an outage leaves new chunks absent and records degradation, so a later
healthy sync indexes them normally. This matters especially for greenfield initialization,
whose saved explicit URL does not set `ollamaUrlDerived`; hash rows written there would
otherwise survive every incremental sync after the service recovered.

**What a failure does depends on WHEN the step runs.** `10-rag-populate` FAILS — "the index
is populated" is its whole contract and a human is watching onboarding. `02-pre-rag-sync`
and `11c-rag-reindex` leave the chunks UNINDEXED and carry on: 02 runs at the start of every
workflow task, so failing it would block all work on the repo over a broken index. An
absent row is honest; a stale row left by a skipped update still points at the right file.
Workflow sync upserts a changed key only after embedding succeeds. It also defers removing
old section/chunk keys until every replacement batch for that file succeeds, so renamed
headings and changed chunk boundaries keep their prior searchable rows through an outage.
A partial batch failure retains those old keys until a healthy retry; a deletion-only edit
can remove stale keys immediately because it has no replacements to embed.
If any replacement batch fails, orphan cleanup also retains missing source paths until
a healthy sync: a disappeared path may have been renamed to the failed replacement.
Paths excluded by the saved scope and files still present but outside indexing limits
are removed even during an outage, so an explicit exclusion does not wait for recovery.

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
An unchanged scan also proves nothing: if the repo is already degraded and no file batch
produces a real embedding, workflow sync embeds one short health-check text before clearing
the flag. A failed or hashed check retains degradation and the step warning; a healthy
check permits recovery without requiring a source edit.

**`rag_embed_lexical_only` is the accepted verdict, and it is NOT "keep hashing".** It forces
`ragHybridSearch`'s existing lexical-only branch (the one a jsonb-only store already takes), so an
accepted repo gets honest full-text ranking instead of full-text plus noise — VERIFIED on a live
9,197-row index: the same query returns 5 hits either way, `maxDense` 0.7233 with the dense half on
and 0.0000 with it off. The api reaches that branch by two routes and both skip the vector rather
than hashing one: the repo flag, and `embedQueryOrNull` returning null for a single query that could
not be embedded or came back at the wrong width (a model or dimension change reached pgvector as
SQLSTATE 22000, a 500). The global half of `rag_search`, global KB promotion
(`rankArticleIdsByRelevance`) and `scripts/rag-eval.ts` take the same null the same way. The
global half embeds before it opens the store, so the embed stays outside the store's deadline, and
opens it with the settings it embedded with (`GlobalKbCallOptions.settings`): a model or store
switched in between never meets a vector made for the other.
`embedQuery` keeps its hash fallback for callers that must have a vector of the right width. The
lexical-only branch has no identifier ranker, so a degraded search also loses identifier matches
(MEASURED: an article naming `getUserById` ranks 2nd with a vector and drops out without one). Both
halves of `rag_search` run their search in a transaction for the server-side statement bound, so the
identifier-statistics query runs in a SAVEPOINT: its failure costs only the identifier ranker, never
the whole search (MEASURED: an injected failure answered 500 locally until the savepoint). The local
half takes the same bounds as the global one: 3 s to connect, 3 s per statement, a 6 s deadline that
destroys the pool, and a failure answers the loud local 500 rather than holding the request (a
silent store held it the full 30 s connect default). Forcing a re-embed (`tooling-upgrades.ts`) gets
the connect bound only: resetting the hashes of a large store legitimately takes seconds (MEASURED
9.4-11.3 s for 4,000 chunks, the content trigger re-running on each row), so a 3 s statement bound
would fail every healthy store past about 1,000 chunks.

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
