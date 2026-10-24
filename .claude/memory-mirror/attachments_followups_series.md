---
name: attachments-followups-series
description: 'DONE 2026-09-24: 12-PR series (#226-#241) fixing the attachments found-not-fixed list; all merged, live-verified at zero tokens; decisions not to re-litigate and the declined review findings'
metadata:
  node_type: memory
  type: project
  originSessionId: 4a63120c-9dc0-4fa4-9b6c-fc8a25973f1c
  modified: 2026-09-24T03:52:23.684Z
---

Plan: `/home/activit/.claude/plans/refactored-roaming-petal.md` (approved 2026-09-23). Follows
[[attachments-fix-series]]; what it left open is in [[found-not-fixed-running-list]].

| PR      | merge      | what                                                                                       |
| ------- | ---------- | ------------------------------------------------------------------------------------------ |
| 1 #226  | `1ef01276` | reserved names everywhere, `.tar.gz` kept whole in ` (n)`                                  |
| 2 #227  | `d8e821d7` | generated files (manifest, index, sidecars) never fail a finished write; `replaceLeafLink` |
| 3 #228  | `86b1cce8` | `withTaskAttachmentsLock` advisory lock shared by api + worker                             |
| 4 #230  | `02e442f7` | archive expansion all-or-nothing, crash-safe (`placed-as` intent), one winner              |
| 5 #237  | `df712f6a` | deleting an archive's last extracted file removes the archive; confirm names it            |
| 6 #233  | `2a6e7f7a` | notice on every mining fan-out, DAG coder/reviewer/fix coder/advisor                       |
| 7 #238  | `a7ee05bd` | migration 0164: recovered mining agent keeps role_key/capabilities/prefer_vision           |
| 9 #234  | `fe361fa2` | notice counts top-level files past 40 in the COVERAGE sentence                             |
| 10 #236 | `91d9573c` | retention sweep ages never-ended (superseded) invocations                                  |
| 8a #239 | `a56ace65` | `currentPlanInputs`: late attachments prepared + recorded by CAS; settle re-read           |
| 11 #240 | `95d00b00` | dead `writeTaskAttachment`, stale comments                                                 |
| 8b #241 | `9fa33824` | 02 drafts from live inputs; sections keyed `doc:<rowId>:<line>`                            |

**Live verification PASSED 2026-09-24 on the dev stack at `9fa33824`, zero CLI invocations**:
throwaway blank repo + deferred greenfield plan build parked at "Plan depth". Verified: second
`spec.tar.gz` stored as `spec (2).tar.gz` and both expanded; `_PLAN_INPUTS.md.zip` into
`_PLAN_INPUTS.md (2)/`; folder `_ATTACHMENTS.md/` stored as `_ATTACHMENTS.md (2)/`; a symlink
planted at `_ATTACHMENTS.md` (root, api container) replaced by a regular node-owned file on the next
upload, target untouched; two concurrent `ensureArchivesExpanded` gave one tree, no staging left;
notice counted 61 = 40 named + 9 in folders + 12 unnamed top-level, INCOMPLETE ARCHIVES present; a
late `.docx` extracted, indexed and recorded by `currentPlanInputs`; browser folder-delete of
`race/` confirmed "This also removes race.tar.gz." and both went; 20 concurrent uploads + a folder
delete all 2xx in 0.41s, manifest == rows (76). Everything deleted and proved by counts.

Decisions NOT to re-litigate (each came from an adversarial review or a review round):

- **User decisions:** deleting an archive's LAST extracted file removes the archive; the
  boot-recovery reset of mining steps gets its OWN plan.
- **Lock** = `pg_advisory_xact_lock` + `SET LOCAL lock_timeout`, SHORT sections, every query via
  `tx`, never across a stream/extraction, never call `ensureArchivesExpanded` inside one.
- **Expansion** = ONE locked section with an intent file; the two-phase design was rejected
  (overlapping calls are real at task-queue concurrency 5).
- **Late plan inputs** recorded by compare-and-set on 00's output, pruned by attachment ROW;
  `currentPlanInputs` re-reads after any pass that PREPARED something (max 3 passes).
- **Coverage section key** is `doc:<rowId>:<line>` (not name+row: `agent_id` is varchar(128),
  paths reach 400); a name-only repair record keeps its old meaning.
- **Recovered mining prompts replay verbatim** (runner-internal flag).

Declined review findings (reasons on the threads): #239 r3, the ms window between the final read
and the notice read — only a frozen per-dispatch uploads copy closes it (same as #225's).

Traps met: a symlinked node_modules resolves the MAIN checkout's libs — every worktree needs its
own `pnpm install --frozen-lockfile --prefer-offline` ([[worktree-resolves-shared-from-main-checkout]]);
run the full `pnpm typecheck` (a database test typecheck failed CI once); Chrome MCP reports an
already-answered `confirm` as open — `handle_dialog dismiss` clears it.
