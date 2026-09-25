# Plan archive

Durable copies of Claude Code plan files, which are otherwise auto-deleted from `~/.claude/plans`
after 30 days.

## Conventions

- **Revisions are folded into the section they belong to. No `# Amendment` sections.** A plan is
  read by people and by agents, and an amendment splits one subject across two places: the body
  keeps stating a superseded count or budget while a correction sits hundreds of lines below it.
  When something changes, edit the section that is wrong, mark an implementation departure inline as
  **As built**, and put the whole-plan verdict in a blockquote under the H1. `.prettierignore`
  excludes this directory, so formatting never rewrites a body either.
- **Line numbers in a body are as-of-writing and drift.** Resolve every reference by symbol name and
  treat the number as a hint. Several plans predate large refactors; where an anchor's drift would
  mislead an implementer, the corrected anchor is written in beside the original.
- **A shipped plan stays here as a record.** It is marked below and in a status blockquote under its
  own H1. Do not re-implement from a plan marked shipped.

## Status — rows verified 2026-08-21, table completed 2026-09-18

Verified against the tree, not taken from the plan bodies.

**This table is COMPLETE as of 2026-09-18 — every plan file has a row.** MEASURED that day:
`docs/plans/` held 50 plan files against 50 rows, nineteen of them added that day after verifying
each against the tree, plus `plan-patch-drop-measurement` as a not-started follow-up. **Re-measured
2026-09-21: 52 files and 52 rows**, both `comm` directions still empty, so no row names a missing file
and no file lacks a row — `plan-patch-gap-sweep` and `plan-patch-guard-losses` arrived with their
rows, which is the rule below working rather than an exception to it.

An earlier version of this paragraph said 48 files against 29 rows; both counts were stale, and that
is the reason for the rule that follows: **a plan added to this directory adds its row in the same
change.** Nothing else keeps the two in step, and a missing row reads as "unknown" rather than as an
oversight.
Rows are in historical order rather than alphabetical, with those nineteen together ahead of any
later addition.

**A plan's own status line is NOT evidence, in either direction.** `amber-provider-verdict-heron`
read "IN PROGRESS, started 2026-08-24" with its checklist still unchecked while every part of the
work was in the tree — and it shipped at `StepTerminal.tsx`, not the `CliStreamViewer.tsx` its
checklist names, so a grep for the planned component reports the feature missing. Two rows were
found stale in the other direction on the same date (`parsed-churning-yeti`,
`replicated-zooming-beacon`). Re-verify any row here before acting on it.

**Every plan this pass touched now carries a status blockquote.** Fourteen were written on
2026-09-18 — twelve that had none at all (`blank-repo-scaffold`, `cli-prompt-delivery`,
`curious-drifting-lantern`, `curious-drifting-lantern-RESUME`, `glistening-jumping-bee`,
`impact-view-readable-radius`, `plan-build-lost-subtree`, `plan-coverage-check`, `plan-delete`,
`plan-document-import`, `plan-mined-status`, `plan-patch-partial-refs`) and two that recorded theirs
as a bare `STATUS:` line (`plan-chat-unread-badges`, `smooth-sleeping-flute`) — each naming the
evidence its verdict rests on rather than asserting a state. A fifteenth went to
`parsed-churning-yeti`, which is shipped and so wants one under the convention above.

**Five plans carry no blockquote, and that is deliberate rather than an omission:**
`kind-riding-dream`, `patient-pinning-kernighan`, `purring-marinating-peacock`,
`serialized-chasing-thacker` and `translator-module` are all not started, so this table is the whole
record. MEASURED 2026-09-18 by counting blockquote lines in every plan file, so that list is
complete rather than sampled.

**One verdict is "landed differently", which is not the same as shipped.** `plan-document-import`
describes a mechanism that is NOT what reached the tree, so its body must not be implemented as
written; its blockquote says what shipped instead.

**`plan-patch-partial-refs` was corrected from that same verdict to shipped on 2026-09-18**, after
being re-measured against the applier rather than read off two throw sites. Its remedy is its own —
`dropUnresolvableOps`, a pre-flight inside `apply-patch.ts` that every agent path reaches — and its
field outcome was measured the same day by `plan-patch-drop-measurement`: the reply-loss rate went
from 27% to 0 across 393 expansion agents. The lesson generalises:
a verdict read from the PRESENCE of an error path can be exactly backwards, because the path may be
unreachable for the input the plan was about.

| Plan | Subject | Status |
|---|---|---|
| `amber-fencing-hopper` | Onboarding scope + LSP + mirror + retrieval | **In progress.** Slices 1-2 done (`e0bee51`); slice 3 partial (`5ca82ac`, 3b/3d open); slice 4 not started. Per-slice status is in its header blockquote. |
| `bright-doodling-catmull` | Scope-fence the blocking reviewers | **Shipped** `3415278`. Its end-to-end benchmark re-runs are unmeasured. |
| `crispy-dazzling-crane` | Mid-task CLI credential harvest | **Shipped** `56a9cc3` |
| `functional-knitting-fairy` | Global KB title digest at dispatch | **Shipped** `e9c2dfe` |
| `glinting-strolling-magpie` | Browser-verification screenshot gallery | **Shipped** `34df4ef` |
| `glistening-percolating-snowflake` | Relocate KB + learnings to `.haive-data/` | **Shipped** `2b4c3ad`, `16550ae` |
| `jazzy-toasting-frog` | Phase-scoped browser weight + measured agent pool | **Shipped** `8130dcd`, `d65d83f` |
| `splendid-foraging-lynx` | Phantom worker-restart orphans + fan-out Resume | **Shipped** `d4fedf0`, `7ed0378` |
| `tidal-yielding-hoare` | Vote scoring for the runtime (DDEV) pool | **Shipped** `8b6b3a9` |
| `valiant-dancing-parrot` | Task up/down vote scoring | **Shipped** `c4d9acb` |
| `yielding-preempting-dijkstra` | Vote-driven agent-slot preemption | **Shipped** `19bf74e` |
| `external-change-catchup` | KB + plan catch-up for commits made outside Haive | **Shipped** `f177e2f` / `e799f08` / `7a01345`, plus `ca4b64b` for a tree-resolution defect found reviewing slice 2. Repo-page drift badge deferred by design |
| `codex-app-server-steering` | Steer codex through its app-server JSON-RPC protocol | Implemented 2026-09-13 on `feat/codex-app-server-steering` — steerable codex runs use the app-server once a zero-token probe verifies it per task, with `codex exec` as the default and the fallback; verified on live runs against codex-cli 0.154.0 (mid-run steer, probe, same-invocation fallback, admin switch) |
| `frictionless-bootstrapping-otter` | One-line install (RUN-IT) | Not started; extended 2026-09-07 with the install-time channel, macOS as a first-class RUN-IT target, and a Docker Desktop Extension as the no-terminal path |
| `kind-riding-dream` | Deep project analysis — resellable module | Not started; depends optionally on `purring-marinating-peacock` phase 2b |
| `lexical-jingling-dawn` | Learned step guidance (self-improving prompts) | Not started |
| `mcp-per-invocation-config` | Per-invocation MCP config for codex + grok (the per-task race) | **Not started, SHELVED and BLOCKED** on mechanism, 2026-09-18. Every cheap lever was probed against the live binaries and closed: `-c mcp_servers=…` and `-p/--profile` both MERGE rather than replace, so neither can narrow a surface; `--tools`/`--disallowed-tools` are grok-only and built-ins-only; none of codex's 140 feature flags gates MCP; grok has no config override at all. Only `CODEX_HOME`/`GROK_HOME` works, and it relocates the whole state tree (five live SQLite DBs, thread history, memories, `installation_id`, writer locks), so per-invocation isolation would discard cross-invocation state. The defect analysis and the muse `400` invariant still stand; the mechanism does not. gemini out of scope (no image, no provider row); antigravity left the set in #164. **Reopening condition, checkable rather than a judgement:** codex or grok ships a per-invocation config-FILE pointer, any flag that scopes MCP servers for one run, or REPLACE rather than MERGE semantics for `mcp_servers` on `-c`/`-p`. Until one of those appears, relocating the config home is the only mechanism and it discards cross-invocation state, so do not re-probe the closed levers |
| `parsed-churning-yeti` | Project plan canvas | **Shipped** `7a217e57` (2026-08-25, persistence layer + blank repositories). Corrected 2026-09-18: this row still read "Not started" while `packages/database/src/schema/plan.ts` exists and `AGENTS.md` documents the canvas in depth — the row predated the work |
| `patient-pinning-kernighan` | Runtime versions the generator ignores (Go/Rust/Ruby, DDEV node) | Not started; three different failures — Go is frozen, Rust/Ruby drift, DDEV node is detected then dropped — so one blanket fix would trade one for another |
| `nimble-browsing-lovelace` | User-selectable browser type + version | **Shipped** `dde9c36` / `bc1b209` / `abb5609` for Chrome + Edge, each gated on a verified CDP handshake. Opera REJECTED on evidence — release builds do not expose CDP. Firefox excluded as a COST decision, not an impossibility — @playwright/mcp drives firefox and webkit |
| `purring-marinating-peacock` | Multi-model per step (fan-out + consolidator) | Not started; Phases 1-2 BACKLOGGED on a hand-merge measurement that failed its reopening condition. The fan-out unpin is carved out as the one piece worth building |
| `quiet-reaping-ritchie` | DevTools egress hardening follow-ups | **Shipped** `c094102` (item 1, runner `--init`) and `e066d26` (item 2, MCP body diversion), both verified against real traffic. Two browser defects found while verifying, plus a poisoned-npx-cache defect found with them, are fixed in `b7884e6` / `0580c51` / `507cb84`. Both bandwidth caveats are retired: nothing here passes `--no-cache`, and the apt cost is once per host, not once per template |
| `replicated-zooming-beacon` | Agent memory + spec handoff optimisation | Not started, but its EVIDENCE is stale and its verdict is unverified. Corrected 2026-09-18: the header's grounds were "no `task-ledger.ts`, `_doc-view.ts` or `_spec-artifact.ts` exists" and all three DO exist, while `REVIEW_FANOUT_DISTILL` and `condenseSpecForReview` — the mechanism its first defect describes — are absent from the whole tree. Whether the three defects still hold needs its own pass; do not read this row either way |
| `rippling-wibbling-puffin` | Modular (user-definable) task types | Not started |
| `rippling-wibbling-puffin-agent-a233cf7f9b59974f6` | Same feature, half A (data model, `buildRunList`, migration, seed) | Not started; companion to the above, neither supersedes the other |
| `serialized-chasing-thacker` | Haive module system — extension infrastructure | Not started. Delivery to a published-image install DECIDED 2026-09-07: per-customer api+worker images built by the vendor; `frictionless-bootstrapping-otter`, `kind-riding-dream` and `translator-module` inherit it |
| `solitary-partitioning-lampson` | Per-install namespacing (two installs on one machine) | Not started; **next priority after `steadfast-committing-gray`**. Containers, networks, six volumes AND the RAG/global-KB databases all carry global names today, so a second install shares them SILENTLY |
| `steadfast-committing-gray` | Core upgrade — release, transactional apply, maintenance mode | **SHIPPED** 2026-09-08, all five slices. Exercised for real: a published v0.1.0 install was upgraded to v0.1.2, and a deliberately failed health gate rolled back to v0.1.0 with service restored. Four defects were found by running it that reading it did not surface |
| `toasty-percolating-kernighan` | Per-call agent isolation | **SHIPPED** 2026-09-21 in six PRs — #191 `7deb542d`, #192 `bde5722e`, #193 `fe3148a5`, #194 `16f8be37`, #195 `a66a79de`, #196 `0bb6fe45` (planned 2026-09-14, re-verified twice before starting). An invocation that QUALIFIES no longer loads every repository agent definition and gets the assigned persona pasted instead — and read-only is necessary rather than sufficient: `agentIsolationApplies` (`dispatcher.ts:203`) also requires the switch on, a `prompt` input, no `file_write`, no `subagents`, no `agentPool: '*'` (which `07_7-secret-sweep` declares), and that neither the prompt with marker blocks stripped, nor any persona body verbatim, nor the provider's instruction chain names an agent path — a scan that could not be completed counts as naming one. Pasting additionally needs the SELECTED provider to have a `projectAgentsDir` (`:328`, `:557`); one without keeps its inline protocol. `rippling-wibbling-puffin` Phase 3.1 builds on it. Piece 4 shipped WITHOUT the exec-time recheck Decision 1 requires and was reported as built — #196 closed it, and the lesson is recorded in the plan: one writer and no readers is a shipped no-op. Verification item 2 is COMPLETE (#200, then #202 `842012ff` for the prompt-builder scan: 186 built prompts, 13 deliberate positives, 3 database-bound sources named), and it found a defect the plan had not predicted — `adaptPrompt` appends the MCP surface and the global-KB digest AFTER the rule returns, both carrying repository- or author-written text, so the rule gained a SEVENTH condition in #211 `689f842a`. What remains is items 1 and 4 (capture harness, the live 08c check), parked on the next onboarding run |
| `translator-module` | Translator — resellable module | Not started |
| `amber-provider-verdict-heron` | Persistent provider-verdict banner below the CLI terminal | **Shipped**, and its own status line said otherwise — corrected 2026-09-18. `failure-class.ts:215` carries `content_filter: 'Provider refused the prompt (content filter)'` with the refusal pattern at `:295` anchored on refusal-specific wording rather than generic words; `describeInvocationStatus` (`web/src/components/terminal/cli-stream-status.ts`) has its own unit test; `StepTerminal.tsx:536-544` renders the persistent amber block, reading the invocation row rather than the stream so it survives the CLI ending and the 600s stream expiry. It landed at `StepTerminal.tsx`, NOT the `CliStreamViewer.tsx` its checklist names |
| `anointing-gatekeeping-ibex` | First-admin onboarding + registration gating | **Shipped in full** 2026-09-09, verified 2026-09-18: `registration-status` in `api/src/routes/auth.ts`, `CONFIG_KEYS.REGISTRATION_MODE` (`config.service.ts:129`) with `REGISTRATION_MODES` at `:619`, migration `0153_user_invites.sql`, and `/admin/users` |
| `blank-repo-scaffold` | A blank repo arrives ready, and stops asking to be onboarded | **Shipped.** `'blank'` is a first-class repository `source` (`schema/repos.ts:30`) and `repo/clone.ts` scaffolds it; the repo-queue INIT job creates the storage dir, `git init`s it and lands one commit, which is what makes worktrees and the `.haive-data/` mirror work on a project that does not exist yet |
| `calibrating-adversarial-mongoose` | QA reviewer-CLI benchmark: the persona x CLI matrix | **Findings record (part 1); part 2 shipped.** Verifier attribution is in the tree — 08d carries the per-lens verifier panel and `verificationTiers`, and 08d2 folds only findings a verifier actually executed and could not reproduce (`filteredCount`). The xhigh re-run it defers to ~2026-09-01 was never recorded as run |
| `cli-prompt-delivery` | A large prompt must not crash the CLI that receives it | **Shipped.** `cli-adapters/prompt-delivery.ts` holds `MAX_ARG_BYTES = 131_072` (Linux `MAX_ARG_STRLEN`) and the measured failure it exists for — a Codex plan build losing 26 of 47 agents to `E2BIG`, 12 of 12 in two consecutive waves — with oversized prompts routed to stdin |
| `curious-drifting-lantern` | Follow-ups from the agent-memory / spec-handoff verification run | **Not a single-status plan: a findings register, F1-F9, with per-item status inline.** Six fixed (`6e72b08`, `d5162d5`, `1243213`, `53aa478`); F2 NARROWED (`d73bb55`) with one sub-item still open whose fix was attempted and REVERTED (`3ac59bd`) under an explicit do-not-retry note; F3 a coverage gap needing no code change; F5 a process note; F8 root-caused and not fixed. Read the per-item headings, never a whole-plan verdict |
| `curious-drifting-lantern-RESUME` | Resume note for a paused DAG verification run | **Not a plan.** An operational note from a 2026-08-21 power cut recording that global pause was left ON and how to resume. Kept as a record; nothing to implement |
| `dag-timeout-ladder-gap` | DAG executor cannot climb the timeout ladder | **Shipped** 2026-08-24. `overrideOrLearned` and `escalatedTimeoutMs` live in `step-engine/dispatch-timeout.ts` with `dispatch-timeout.test.ts` beside it, consumed by `dag-executor.ts`. The escalation is written to the STEP rather than the issue, so a fan-out's wall-clock ceiling stays computable |
| `glistening-jumping-bee` | Per-agent browser tabs, and reclaiming the tabs agents leave | **Shipped.** `BROWSER_TAB_DISCIPLINE` in `sandbox/mcp-surface.ts`; `closeExtraBrowserTabs` called from `step-runner.ts`, `app-runner.ts` and `ddev-runner.ts`. The tab it keeps is the one RECORDED as the human's, because three separate inference attempts were measured lying |
| `impact-view-readable-radius` | Impact view: a readable radius, and a diagram that fits | **Shipped.** `IMPACT_DIAGRAM_MAX_NODES = 40` at `shared/src/plan/impact.ts:78`, `reversed` threaded through the walk (`:41`, `:157`, `:166`) with `viaNodeId` on each hop; rendered by `plan-impact-section.tsx`, `plan-impact-groups.ts` and `plan-impact-list.tsx` |
| `plan-build-lost-subtree` | A plan build must not lose a subtree in silence | **Shipped.** `01-plan-build.ts` states the fix as an invariant — nodes beyond the cap "are not dropped — they stay on the frontier for the next wave" — with waves riding `MiningWaveError` rather than `loop`, and the reason `loop` cannot work recorded beside it |
| `plan-chat-unread-badges` | Plan chat: unread replies, badges, notification routing | **Shipped** across `2e421548` (read table), `e5e36165` (feed exclusion + unread endpoint) and `6355ae84` (badges, divider, filter). Both tests it names exist: `api/test/plan-chat-surfaces-smoke.ts` and `web/src/components/plan/plan-chat-turn.test.ts` |
| `plan-coverage-check` | Coverage check: what the document says that the plan does not | **Shipped.** `steps/plan/02-plan-coverage.ts` plus `plan-coverage-scan.ts`, with `plan-coverage-scan.test.ts` and `plan-coverage-step.test.ts` beside them. The plan's own warning stands: two of the three "missing identifiers" that prompted it were not gaps |
| `plan-delete` | Delete a plan | **Shipped.** `web/src/components/plan/plan-delete-dialog.tsx` behind a type-the-name confirmation, `deletePlan` in `lib/api-client.ts`. Its stated recovery path still holds — `.haive-data/plan.json` is committed and `importPlanMirror` restores the nodes with their original ids |
| `plan-document-import` | Import a plan document, or describe one | **Landed differently.** `from_md` is RETIRED from `planBuildModeSchema`, now `['from_repo', 'greenfield']` (`shared/src/schemas/plan.ts:443`), and a greenfield build must carry a brief or `deferStart` (`:461`). The plan's subject — reaching document import from the UI — was met by greenfield plus attachments, not by wiring `build('from_md')` |
| `plan-mined-status` | A plan mined from existing code should not read as a to-do list | **Shipped.** `01-plan-build.ts` decides the status a mined node arrives with and returns `status: 'done'` (`:218`), with `minedByThisBuild` at `:174` and `plan-mined-status.test.ts` beside the step |
| `plan-patch-partial-refs` | One bad reference must not cost a whole reply | **Shipped; field outcome confirmed 2026-09-18** — 0 of 393 expansion replies lost to an unresolvable ref since it landed, against 22 of 82 before (measured by `plan-patch-drop-measurement`). Re-measured 2026-09-18, correcting this row: the remedy is this plan's own, `dropUnresolvableOps` (`apply-patch.ts:233`) as a PRE-FLIGHT at `:709`, and every agent path passes `onUnresolvableRef: 'drop'` through `applyAgentPatch` — `01-plan-build.ts:707`, `02-plan-coverage.ts:572`, `01-plan-chat.ts:259`, `03-plan-sequence.ts:508`. `fail` remains the default for human edits and for the deterministic writers, by design. The throws at `:356`/`:692` are reachable only under `fail`, and `:692` is a different rule — it refuses to resurrect a stale uuid as a NEW node. Its one residual, an upsert whose own `nodeRef` is a dead uuid, is fixed in `76e1d542`. Covered by `drop-unresolvable.test.ts` and `plan-canvas-smoke.ts` (`:307`, section 8.5). This row previously claimed a `drop-unresolvable.ts` module, which does not exist |
| `prancing-metering-quokka` | Ollama Cloud is not free local compute | **Shipped** 2026-08-23. `isOllamaCloudModel` (`shared/src/cli-providers/catalog.ts`) keys on BOTH `-cloud` and `:cloud`, and `cli-versions/ollama-model-prices.ts` scrapes configured CLOUD models only, since a stored rate on a local-basis run would be summed as real spend. Its cited migration is `pre-baseline/0126_ollama_price_feed.sql` — the never-run record folded into the frozen `0000_baseline.sql`, so do not look for `0126` among the live migrations |
| `smooth-sleeping-flute` | Honour a declared Ruby version; give the Ruby block its own compiler | **Shipped** 2026-08-23 (`39af246` toolchain, `72ebac5` versioning), verified by BUILDING the rendered Dockerfiles rather than by unit test alone. Ruby handling spans all three env-replicate steps — `01-declare-deps`, `02-generate-dockerfile`, `04-verify-environment` |
| `plan-patch-drop-measurement` | Measure what the unresolvable-ref drop actually saved | **Done 2026-09-18; the fix it led to shipped** `76e1d542` / `0c70ac1b`. **Part B, the rate:** 0 of 393 expansion replies lost to an unresolvable ref since the drop landed (22 of 82 before); the drop engaged 20 times, and the 84 agents at the pre-fix build's scale were clean. Read-only SQL; no fresh build was needed. **Part A held in the smoke and in the field:** four `03-plan-sequence` replies of 16-45 ops were each lost whole to one mistyped uuid in an upsert's OWN `nodeRef`, and never re-asked. Fixed by completing the pre-flight's `refsOf` AND by letting the op loop skip, under `drop`, a ref that fails only at its position (a temp id introduced later, a node deleted earlier in the patch), keyed on a private `UnresolvableRefError`. Two claims in its body were wrong and are corrected there: plan chat did not log patch drops, it discarded them, and 03 never wrote the partial prefix. Both now record, which is the second commit |
| `plan-patch-gap-sweep` | Close the gaps PR #171 found and left alone | **Part A done 2026-09-19** — `066c42f7`, `744ce132`, `24d5245d`, `14928457`. 03 drops an upsert whose ref names no node and stamps a landed reply partial, not "not applied"; 11f/01f count only the approved changes that landed and name the rest (11f gains a curated summary); the chat header reads "A of N plan changes applied"; Postgres notices go to the logger, not stdout. **Part B done 2026-09-19** — all 315 test-file type errors fixed (`5c9d94b2`, `ff4e102c`, `a7054af3`, `025e2d4f`) and enforced by a per-package `tsconfig.typecheck.json` (`9c1e70ac`); the check also surfaced a source type narrower than its data (`3df566b0`), a smoke ReferenceError hidden by `smoke:ci` skipping it (`ca3e2836`) and a duplicate test |
| `plan-patch-guard-losses` | Whole-reply losses to two deliberate guards | **Done 2026-09-19.** `663ef973`: an agent patch loses a malformed code link rather than the whole reply, and stripped links are reported in their own field, `strippedCodeLinks`, never in `dropped`. `38911203`: the breadth guard counts a `node:`-prefixed parent's children. `b9085ad4`: a coverage repair sees its node's existing children and the room left under the cap, and a refused repair is offered again. `a9ec07e1`: a partially applied plan-build wave is no longer re-rolled. Both designs first proposed rested on wrong premises, corrected in the body. No caller re-prompts an invalid patch. And 9 of the 10 breadth refusals were repairs told "no children" about nodes that had 7-19. **Its own leftovers closed 2026-09-20:** `dac734bf` removes the retry translation nothing could act on, `f304136e` records a stripped link as a `plan.code_links_dropped` task event the Activity tab renders, and `cc789f2b` gives a section repair the spec writer's depth-bounded index (shared as `steps/plan/_plan-index.ts`) instead of a 60k slice that stopped at ~300-400 nodes. The fourth, the breadth guard ignoring a move, is DROPPED: 0 move ops in 636 plan-build and coverage replies, with the measuring SQL in the plan body |
| `compiled-noodling-squid` | Agent rules: global rewrite, per-dispatch delivery, upgrade and review-gate fixes | **Shipped 2026-09-24.** Part 1 (the global `~/.claude` files) 2026-09-23; B #229 (upgrade restores `@AGENTS.md` stubs and stages what it wrote), C #231 with follow-up #242 (similar code surfaced at gates 2/3, migration 0165), D #232 (`DEFAULT_AGENT_RULES` rewrite, fence-safe `dedupLines`), Part 5 as local repository commits, A #235 (rules injected at dispatch and stamped per invocation, migration 0166). Departures are marked **As built** in the plan; owed: the end-to-end upgrade check (no repository has finished onboarding) and the stamp on the first real invocation |
| `agent-rules-followups` | Found-not-fixed follow-ups from the agent-rules series (12 PRs) | **Shipped** 2026-09-24: PR 1 #249, PR 2 #250, PR 3 #252, PR 4 #256, PR 5 #254, PR 6 #260, PR 7 #258, PR 8 #261, PR 9 #265, PR 10 #255, PR 11 #262, PR 12 #253. |
| `found-not-fixed-sweep` | The found-not-fixed list cleared: fixes, a handover of seven recovery items, recorded reasons (25 PRs) | **Shipped** 2026-09-25: PRs 1-25, 5c, 21b and 24b (#267-#280, #282-#286, #288-#291, #294-#296, #299, #300). The seven recovery items went to the parallel recovery series. Open checkpoints: the release-action bumps (next rc) and Dependabot's first npm run after 2026-09-25 16:19Z. |
| `found-not-fixed-sweep-2` | The consolidated found-not-fixed list, including the recovery session's hand-over: fixes and recorded reasons (24 PRs) | **In progress** 2026-09-25. PR 1 merged (#301); PR 2 (START claims the task, or does nothing) in review. |

## Cross-plan dependencies

- `kind-riding-dream` and `translator-module` both build on the module system in
  `serialized-chasing-thacker`, and both reference `purring-marinating-peacock`'s multi-model
  fan-out as an optional improvement, never a prerequisite.
- `serialized-chasing-thacker` and `rippling-wibbling-puffin` carry paired rules covering the same
  joint: a module's steps must reach the composable step catalog.
- `glistening-percolating-snowflake` rides `.haive-data/`, which shipped as slice 2 of
  `amber-fencing-hopper`.
- `steadfast-committing-gray` and `frictionless-bootstrapping-otter` share one slice exactly:
  published images plus the compose `run` overlay are otter's RUN-IT prerequisite and gray's Phase 0
  prerequisite. Whichever ships first builds them. Otter owns the FIRST install; gray owns every
  install after it, which is the follow-up otter names and defers. They also share the CHANNEL: gray
  made the release manifest per-channel for upgrades, and otter resolves the same channel at install
  time — an installer that always fetched the public manifest would hand a module customer the wrong
  stack before any upgrade happened.
- `steadfast-committing-gray` generalises `serialized-chasing-thacker`'s urgent/graceful drain
  choice from module scope to system scope.
- `solitary-partitioning-lampson` is what lets a published install and a dev checkout run side by
  side, and therefore what lets `steadfast-committing-gray`'s upgrade path be tested with the worker
  running. Not a prerequisite for that plan — with the dev stack stopped there is nothing to collide
  with — but the reason its install tests have to exclude the worker today. It also closes the
  silent half of the collision recorded in `frictionless-bootstrapping-otter` under "Two installs on
  one machine": containers and networks clash loudly, the six named volumes and the RAG databases
  share without a word.
- **Decided 2026-09-07, spanning four plans:** a published-image install has no source and no build,
  while a module is rebuild-on-install — so such an install could run no modules, including the paid
  ones the module system exists to sell. Resolved in favour of **per-customer api+worker images
  built by the vendor**, derived from a base release, with web left as the stock public image. The
  reasoning and the two rejected alternatives live in `serialized-chasing-thacker` under "DECIDED —
  a published-image install gets PER-CUSTOMER images built by the vendor", because it is that plan's
  locked rebuild-on-install constraint that created the conflict. A user's OWN module is the other
  half of the same decision and does NOT force them into a developer checkout: the stack runs a
  published `haive-builder` image as a one-shot to build api+worker locally. Four-cell delivery
  matrix in that section. `frictionless-bootstrapping-otter` (RUN-IT), `kind-riding-dream` and
  `translator-module` inherit it; `steadfast-committing-gray` carries two consequences — a
  per-channel release manifest, and a Phase 0 local rebuild for installs that carry own modules.
- Authoring a TASK TYPE is unaffected by all of the above: `rippling-wibbling-puffin` makes task
  types data and states at Phase 3.1 that prompt-template steps need no rebuild. Only a module
  contributing steps, routes or jobs requires a build.
- `toasty-percolating-kernighan` ships first and independently, and `rippling-wibbling-puffin`
  Phase 3.1 builds on it: a prompt-template step's `agentPool` and `{{agent:<id>}}` tokens reach
  the same per-invocation agent isolation, and the token widens that plan's persona resolver for
  personas with no inline fallback.
