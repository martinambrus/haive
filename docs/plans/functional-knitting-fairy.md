# Global KB title digest at dispatch

## Context

The global KB is reachable by exactly one route: the `rag_search` MCP tool. `Bash grep`
cannot see it. So how often an agent calls `rag_search` *is* how much global KB reaches it.

Measured across all 58 `Add DDEV` tasks (`rag_query_log` joined to `cli_invocations`):

| provider | rag queries per rag-instructed prompt |
|---|---|
| codex | 3.16 |
| ollama | 0.52 |
| zai | 0.52 |
| claude-code | 0.37 |
| muse | 0.00 |

Tool-call breakdown for two representative tasks (exact `"name":"<tool>"` counts over
`stream_log`):

- claude-code `92afc67b` (79 invocations): Bash 1239, Read 479, Edit 87, ToolSearch 59,
  Write 39, `rag_search` **26** — 1.3% of all tool calls.
- muse `fcf03ead` (113 invocations): Read 511, Bash 260, ToolSearch 138, Edit 44, Write 5,
  `rag_search` **0**.

The muse zero is not a wiring fault. Its init event reports
`{"name":"haive-rag","status":"connected"}` with `permissionMode: bypassPermissions`,
`buildMcpConfigForCli` handles `muse` identically to `claude-code`, 85 of its prompts named
`rag_search`, and no stream contains `rag_search HTTP` or `rag_search request failed`. The
model simply never picks the tool.

The ledger is trustworthy: claude-code emitted 26 `rag_search` tool_use blocks and
`rag_query_log` holds exactly 26 rows for that task.

What the data also shows is that the failure is a **cold start**, not unwillingness. The
08-13 agents queried entries by their exact titles — `DDEV post-start hooks cannot inject
settings into installer-generated co` (entry created 08-06), `installing a PHP extension in
a DDEV web image webimage_extra_packages` (created 07-30), `committing a DDEV project to git
don't blanket-ignore .ddev` (created 07-09). Once a title is visible, the agent reliably
pulls the body. An agent that does not know an entry exists greps instead.

Outcome intended: replace a 0-1.3% volitional hit rate with a deterministic floor by showing
every rag-wired agent the titles of the house standards that apply to its stack.

## Rollback

Written before the change, per the standing rule.

- Flip `config:globalKb:digestEnabled` to `false` in Settings -> Global KB. Takes effect on
  the next dispatch, no deploy, no restart.
- Or revert the commit.

No schema change, no data migration, no write path touched. The change is additive prompt
text plus one config key. There is nothing to undo in any database.

## Design

`resolveTaskDispatch` (`packages/worker/src/orchestrator/dispatcher.ts:97`) is already async,
already holds `db` and `taskId`, and already resolves `mcpSurface` in a `Promise.all` before
handing it to the **synchronous** `adaptPrompt` closure inside `buildCliSidePlan`. The digest
rides that exact lane.

```
resolveTaskDispatch(db, taskId, req)          async
  Promise.all([ hasReadyLspBridge,
                resolveInvocationUsesWorktreeGitBoundary,
                resolveMcpSurface,
                resolveGlobalKbDigest ])       <-- new, 4th entry
  -> resolveDispatch({ ...req, globalKbDigest })
       buildCliSidePlan -> adaptPrompt(prompt)  sync
         adaptPromptForCliCapabilities(...)
         withWorktreeGitBoundary(...)
         withDdevGeneratedBoundary(...)
         withMcpSurface(...)
         withGlobalKbDigest(prompt, digest)    <-- new, 1 site
         withModelCapabilityBoundary(...)
```

This is why `buildPrompt` being sync does not matter: the async work happens upstream and the
splice is sync, exactly as `mcpSurface` already does it. One insertion point covers all 15
`retrievalGuidanceLines()` builders, every sub-agent prompt and the synthesis prompt, for
every provider — muse included — with no per-step changes and no reintroduction of the
multi-site drift `_retrieval-guidance.ts` exists to prevent.

**Gate: `surface.rag.enabled`.** Inject only when the haive-rag server is actually wired for
that invocation. Structural invariant, not prompt copy — a digest is useless where the agent
cannot read the bodies, and this keeps the tokens off dispatches that were never candidates.

**Idempotency: marker-guarded**, copying `withMcpSurface` (`mcp-surface.ts:319`) verbatim in
shape — if the marker is already present the prompt is returned unchanged, so nested builders
and retry paths cannot double-inject.

**Facet scoping** reuses `extractProjectFacets` from `@haive/shared/global-kb/facets.js` and
the empty-dimension-means-universal predicate already used by RAG search
(`packages/shared/src/rag/search.ts:149`):

```sql
(NOT (facets ? 'dim') OR jsonb_array_length(facets->'dim') = 0 OR (facets->'dim') ?| $n::text[])
```

Do **not** reuse `loadActiveGlobalArticlesForStack` (`_global-kb-promote.ts:104`). Its match
requires an explicit tech-token overlap, so it drops entries with empty facets — precisely
the universal house standards a digest most needs. It also fetches bodies.

Rendered block (titles only, grouped by category):

```
<haive_global_kb_index>
House standards on record for this stack. Call rag_search with a title to read one.

tech_pattern:
- DDEV post-start hooks cannot inject settings into installer-generated config
- Installing a PHP extension in a DDEV web image: use webimage_extra_packages
anti_pattern:
- DDEV with docroot at the repo root exposes .ddev/ over HTTP
</haive_global_kb_index>
```

## Files

**New** — `packages/worker/src/step-engine/steps/_global-kb-digest.ts`
(sits beside the existing `_global-kb-similarity.ts` / `_global-kb-promote.ts`):
- `resolveGlobalKbDigest(db, taskId): Promise<string[]>` — resolve facets, query
  `global_kb_entries` where `namespace = settings.namespace AND status = 'active' AND
  superseded_at IS NULL` plus the facet predicate, order `updated_at DESC`, cap at
  `GLOBAL_KB_DIGEST_MAX_TITLES = 40` (module constant, not a config key). Wrapped in
  `withGlobalKb`. Returns `[]` on any failure — this must never fail a dispatch, matching the
  fail-soft contract global KB search already has in `rag.ts:298`.
- `withGlobalKbDigest(prompt, titles): string` — sync, marker-guarded splice.

**Shared** — `packages/shared/src/global-kb/facets.js` (or a sibling): extract the
task-facet resolution currently inline in `packages/api/src/routes/rag.ts:90-170`
(`resolveTaskRagContext`: read `01-env-detect` / `02-detection-confirmation`, fall back to the
repo's newest onboarding task, then `extractProjectFacets`) into a reusable
`resolveTaskFacets(db, taskId)`. Have `resolveTaskRagContext` delegate to it.

This is the one bit of refactor in the plan and it is deliberate: if the digest and the search
compute facets separately they will drift, and a digest advertising titles that `rag_search`
then cannot retrieve is worse than no digest.

**Worker** — `packages/worker/src/orchestrator/dispatcher.ts`: add `globalKbDigest?: string[] |
null` to `DispatchRequest` next to `mcpSurface` (same "computed by resolveTaskDispatch, exposed
on the pure resolver only for deterministic unit tests" comment), add the 4th `Promise.all`
entry, add the `withGlobalKbDigest` call to `adaptPrompt` gated on `req.mcpSurface?.rag.enabled`.

**Config** — `packages/shared/src/config/config.service.ts`: add
`GLOBAL_KB_DIGEST_ENABLED: 'config:globalKb:digestEnabled'` with default `'true'`;
`packages/shared/src/global-kb/connection.ts:66` reads it alongside the other global-KB keys so
`resolveGlobalKbSettings` carries it.

**Admin UI** (required — every `CONFIG_KEYS` global needs a GET/PUT and a toggle):
- `packages/api/src/routes/global-kb.ts`: add `digestEnabled: z.boolean().optional()` to
  `configSchema` (line 129), the matching `configService.set` in the PUT (line 146), and the
  field on `configResponse` (line 120). No new route.
- `packages/web/src/app/(app)/settings/global-kb/page.tsx`: one toggle on the existing card.

## Tasks

1. `resolveTaskFacets(db, taskId)` in shared; `resolveTaskRagContext` delegates to it.
   Verify: existing api rag tests pass; `pnpm test` in shared.
2. `_global-kb-digest.ts` with both functions + unit tests.
   Verify: facet match includes empty-dimension entries, cap honoured, empty KB returns `[]`,
   a throwing `withGlobalKb` returns `[]`, marker prevents double-injection.
3. Config key + `resolveGlobalKbSettings` plumbing.
   Verify: `pnpm typecheck`.
4. Dispatcher wiring.
   Verify: dispatcher unit tests — digest present when `mcpSurface.rag.enabled`, absent when
   not, absent when the toggle is off.
5. API config schema + web toggle.
   Verify: PUT then GET round-trips `digestEnabled`.
6. Live measurement (below).

## Verification

Unit and typecheck per task above. Run `pnpm typecheck` and `pnpm test` inside the containers,
not on the host.

End-to-end, against recorded baselines:

```sql
-- rag_search tool_use blocks actually emitted
SELECT (length(stream_log) - length(replace(stream_log,'"name":"mcp__haive-rag__rag_search"','')))
       / length('"name":"mcp__haive-rag__rag_search"') AS rag_calls
FROM cli_invocations WHERE task_id = '<new task>';

-- queries that reached the API, with the global split
SELECT count(*) AS queries, sum(global_hits) AS global_hits
FROM rag_query_log WHERE task_id = '<new task>';
```

Run one `Add DDEV` task on a `rs_claude_opus5_*` repo and one on `rs_muse_spark_1.2_*`.

Baselines to beat:
- claude-code `92afc67b`: 26 rag calls / 79 invocations = 0.33 per invocation.
- muse `fcf03ead`: 0 rag calls / 113 invocations.

Success criteria:
- muse strictly greater than 0. This is the headline result — it is the provider the current
  design fails completely, and a digest that does not move it has not solved the problem.
- claude-code materially above 0.33 per invocation.
- `rag_query_log.global_hits` greater than 0 on both.

Also record the digest's token cost once against a real task: log the rendered block length at
dispatch for one run and confirm roughly 600-700 tokens at the 40-title cap before leaving the
default on.

## Out of scope

- Per-step or per-provider digest tuning. Measure the flat version first.
- Summaries on entries (needs a new column, generation at enrich time, and a backfill of 66
  rows). Titles-only is the tested-first version.
- Changing `loadActiveGlobalArticlesForStack` or its caller `11-phase-8-learning.ts:727`.
- The `git` MCP server showing `"status":"failed"` in every muse init event. Noticed while
  reading those streams, unrelated to this change, worth a separate look.

## Note

Plan mode restricts writes to this file. First implementation step is to copy this plan to
`haive/docs/plans/` so it survives the 30-day reap of `~/.claude/plans/`.

---

# Amendment — 2026-08-21: shipped

Landed as `e9c2dfe` (`feat(worker,shared,api,web): list global KB titles in agent prompts`). This file is a historical record, not pending work — do not
re-implement from it. Line numbers in the body are as of writing and have since drifted; resolve
any reference by symbol name.
