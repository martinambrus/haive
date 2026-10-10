# RAG playground and usage review

`/settings/rag-playground` is available to ordinary users. Its session-authenticated
`/rag/playground` routes always scope task choices, query history, saved results and
searches to `tasks.user_id`; even administrators receive only their own records.
Task choices and query history are paginated. Every task-step RAG statistics query
links to the playground using its logged query id, restoring the task context,
query and original `top_k` (NULL means the default 8).

Agent `/rag/search` and playground `/rag/playground/search` call the same
`executeRagSearch`: repository connection, embedding degradation, bugfix runbook
boost, identifiers, knowledge reserve, global facets, merging and full-entry
expansion stay identical. Playground runs do not insert telemetry or affect a
step's statistics. They search the current index and settings, so a rerun is
shown separately from the original response.

Migration 0180 adds `rag_query_log.result_hits`, saved after merging and expansion.
NULL means the response was not captured; `[]` means a captured zero-hit response.
Old responses cannot be reconstructed from their counts. The UI states that
limitation and allows a current rerun. `formatRagHits` is shared by the API and the
dependency-free MCP script (embedded using its self-contained function body), so
nonempty human-readable responses have the same source labels, scores and bodies.
Result prose uses `MarkdownView` with enhanced transformations disabled.

The terminal workflow step `13-pr-wait` reviews query usage on both PR and non-PR
paths. The optional LLM runs after the PR wait form, with no tools or MCP servers,
and refreshes and checkpoints its evidence at dispatch because a reopened PR can
have added queries. The checkpoint uses `updateOwnedStep`; a Retry, Skip or Stop
that took the row rejects the superseded pass without restoring its cleared state.
A task with only zero-hit or uncaptured queries, or no timed model prose, skips
the classifier. Preparation can return false after refreshing a parked PR, which
the runner handles before building a prompt, reserving a CLI or enqueueing a job.
Evidence-loading, model and assessment-storage failures never block finalization;
cancellation and superseded-pass errors still propagate.

The review is an inference about recorded actions, not proof of an agent's private
reasoning. Green means the classifier found explicit evidence of use; amber means
zero hits or explicit rejection, and neutral means unclear or not assessed. A
returned hit, a read, or absence of a mention never establishes usage or non-use.
`usage_assessment` stores the status, reason, quoted evidence and assessment time.
Before saving a used/unused claim, the worker verifies that every quote occurs in
a model turn after the query, names a returned source path and belongs to a run
overlapping the query's timestamp. It rejects fabricated quotes, unrelated runs,
duplicate assessments and historical queries without saved hits. The playground
shows the reason and evidence. Raw stream logs are excluded because they contain
tool results: quoting retrieval itself would be circular evidence.
Each new Clean transcript records `proseChunks` offsets and timestamps while
keeping its merged display text. The collector bounds timing metadata to 8,192
fragments across the invocation and removes only their offsets when that budget
is exceeded. Review quotes use the fragment timestamp, not the merged segment's
original timestamp. Legacy segments without fragment timing retain their original
time, conservatively leaving later appended prose unclear.

`rawOutput` is also excluded: it can concatenate pre-query turns, so labeling it
with a run’s completion time would manufacture evidence of later use.

Every recorded query receives an assessment, including unknown when the model
fails or evidence is missing. Apply sets neutral defaults and zero-hit verdicts
for the task in bulk, then saves the validated assessments for selected queries.
The evidence payload is bounded to 80,000 characters before it is returned from
loading, so neither detect nor dispatch checkpoints full article/transcript bodies
in the task-step output that the UI polls. The prompt reuses the same bound,
with result snippets capped at 1,200 characters and run prose limited to the last
eight timestamped model turns (4,000 characters each). Whole query/run records
that do not fit are omitted; omitted evidence leaves usage unknown, never unused.
The prompt fences agent and result text as untrusted data.

An open RAG statistics panel polls until the task ends, then fetches once more.
Query counts stop changing when the step ends, but usage assessments arrive at
finalization and must still become visible.
