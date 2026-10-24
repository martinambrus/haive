---
name: modularity-series
description: 'Modular Haive series (module system + data-driven task types + integrations) — merged plan twinkling-frolicking-toast, ledger .claude/tmp/modularity/; resume from the ledger'
metadata:
  node_type: memory
  type: project
  originSessionId: f5017f4f-0dce-49e2-af7e-9b3e0ca76aaf
  modified: 2026-10-13T12:20:00.000Z
---

Started 2026-10-12 in session haive-e7 under /opus-sonnet. Merged `serialized-chasing-thacker` +
`rippling-wibbling-puffin` into `twinkling-frolicking-toast` (approved; archive in docs/plans/).
Shape: P0 shared contracts (serial) → tracks P (task types), M (modules), I (integrations) in
parallel → joints J2-J8 → D (distribution, in scope in full).

**Why:** neither source plan was independent; both assumed the step registry is filled during
bootstrap() (it is lazy, in startTaskWorker).

**How to apply:** resume from `.claude/tmp/modularity/ledger.md` (decisions, task-id map, verdicts,
FNF). User decisions there are locked — notably integrations are declared-only and
category-resolved (DI, like CLI choice), module-seeded types have their own switch, core /stats
moves into modules/statistics (DONE 2026-10-13, #642-#648: module host contract, @haive/web-kit,
stats-server, dashboard widget slot, nav order). Composable core catalog (P9b #641) DONE after 23 Codex
rounds; user chose free order + token rules (precedes/removes/entails/entailsWhen), not a rank — the
built-in guard test validates orderWorkflowRunList's real list. P10 (#649-#651) and P7 (#653-#659, 2026-10-13) DONE and live-checked on dev; the user accepted leaving two custom task types + tasks (live-spec-check, live-worktree-check) in dev data, custom switch back off. Peer session git-data-readonly-containers routes overlapping items to
this series ([[haive-e7-module-refactor-handoff]]). See [[haive-opus-sonnet-workflow]],
[[haive-pr-workflow]].
