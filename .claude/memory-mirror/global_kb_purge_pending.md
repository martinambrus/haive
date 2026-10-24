---
name: global-kb-purge-pending
description: 'Three promoted global-KB entries kept as benchmark data for the TASK-185 re-test onboarding runs; retrieval is already observed, purge through the API once those runs are past the global-KB merge and review steps'
metadata:
  node_type: memory
  type: project
  originSessionId: 7b103635-8824-4e07-9760-f6a4061bf2b8
  modified: 2026-09-15T13:38:05.134Z
---

The instance global KB (`haive_kb_global`) holds 3 auto-promoted entries, deliberately NOT cleared on
2026-09-11 so the TASK-185 re-test has live global-KB data to observe:

- `317ab83c` active, tech_pattern, "Auto-numbered report sections…", `{language:[php], phpMajor:[8]}`
- `f853c40b` archived, same title (the superseded half)
- `5e684095` active, best_practice, "PostgreSQL 17 Transaction Boundaries", `{dbMajor:[17], database:[postgres]}`

They match the elmont_rs repos' facets (php 8, postgres 17), so they surface during the runs. That is
the point of keeping them, and also why they are a variable to remove before any CLEAN benchmark.

**The user's rule (2026-09-15):** remove them once we have the information they are kept for;
otherwise wait for the onboarding step they are saved for.

**Checked 2026-09-15, retrieval IS observed.** Since 09-11 both articles were in the global-KB digest
of real prompts across 8 tasks (onboarding 06_5, 07_7, 08, 09, 09_1, 09_2; a workflow 07b; plan chat;
kb-enrich); 193 of 220 `rag_search` queries returned global hits while these were the only active
global entries; and agents cited them in some 06_5 outputs.

**Still kept, because the steps that ACT on existing entries had not run in any re-test run:**
`09_6_4-global-kb-merge` (LLM-merges a task's own promoted drafts, selected by `source_task_id`, into
the entry each supersedes) and `09_6_5-global-kb-review`. Parked on 09-15: 603cf7f6 codex_sol,
2e49fa91 grok, e33d3c4b astra, b01cad43 glm and 726613f7 claude at `09_2-qa-resolve`; fe14b042 opus at
`09_5-skill-generation`; 8276aa2c muse at `04-tooling-infrastructure`, before every digest-heavy step,
so deleting early would give that model different conditions. Purge once the runs are past 09_6_5.

The 09-15 re-scope ([[global-kb-entries-rescoped]]) already cleared `3c9a07ee → 5e684095`, the codex_sol
run's only merge pair into a benchmark entry, so that run's 09_6_4 will not merge into it.

Purge through `DELETE /global-kb/entries/:id`, never SQL: the route removes the vectors in its own
transaction and, since #102, rewires any entry that superseded the deleted one.

Related: [[haive-task-185-benchmark]], [[ddev-rag-test-db-cleanup]]
