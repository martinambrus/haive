---
name: recovery-context-followups-series
description: '10-PR series (boot-recovery wipes, recovered-agent prompts, DAG ledger/terseness, fd-held extraction, attachment dot bug, CI registry retries) ALL MERGED and live-verified 2026-09-24; #257 merged; H-series DONE 2026-09-25: H1-H7 merged (#281, #287, #292, #298, #297, #293), H8 folded into #297'
metadata:
  node_type: memory
  type: project
  originSessionId: 4a63120c-9dc0-4fa4-9b6c-fc8a25973f1c
  modified: 2026-09-25T13:34:01.533Z
---

Plan: `/home/activit/.claude/plans/refactored-roaming-petal.md` (approved 2026-09-24; it overwrote
the finished attachments-follow-ups plan). Tasks #26-#36 in the session task list mirror it.
Follows [[attachments-followups-series]]; its leftovers go to [[found-not-fixed-running-list]].

Order, all MERGED 2026-09-24: PR 1 CI retry #243 → PR 2 attachment-name dot bug #244 → PR 3 DAG
review loop gets the ledger #245 → PR 4 terseness scoped to replies + applied to every agent #246 →
PR 5 `dispatch_prompt` column #247 (migration **0167**) → 6a boot fence #248 → 6b two-phase fan-out
#251 → 6c fold/reopen safety #259 → 6d behaviour switch #263 → PR 7 fd-held extraction #264.

**A parallel session is landing the agent-rules series** ([[agent-rules-series]]): #231 merged
2026-09-24 07:35Z (0165), #232 and #235 (0166) open. Rebase onto main as they land; never sync or
restart the shared dev stack while either session has a task running.

Decisions NOT to re-litigate:

- **Item 7 = dot bug only (user choice).** A description naming an agent file correctly keeps
  isolation off; other false positives only cost tokens.
- **Stored prompt = the step's OWN prompt** (`AgentMiningDispatch.prompt`, before notice/ledger/
  terseness and before provider adaptation); recovery re-augments and re-adapts. Legacy verbatim
  replays store NULL. A never-dispatched row is re-run only on a user request.
- **Boot recovery needs all four PRs in order**: removing the continuation flip alone makes it
  worse (the flip is accidentally the same-step duplicate guard; partial fan-outs, unqueued
  invocations, 01/02 re-folds, epoch-less submit redeliveries).
- **Pass 2 preserves only rows with CLI evidence** (mining rows, iterations, own invocation);
  deterministic form-bearing steps keep reset-and-re-ask (their apply() is unaudited for re-runs).
- **Terseness** governs replies and returned prose only, never files/code/comments/docs/KB/skills
  or formats; it goes to every DAG role, the merge-resolver and `retry_ai` ("fix it everywhere").
- **Ledger** goes to the reviewer, fix coder and advisor (not replanner/merge-fix); review-loop fix
  coders' `concerns` get recorded like level coders'.
- **6d (#263) ownership model, settled over 5 Codex rounds** (AGENTS.md "Worker restarts"):
  `holdStepAdvance` DEFERS a second advance of one task/step/round (never drops it; taken outside
  runTaskJob's catch). Every write step-runner makes to a pass's row, and every status the DAG
  executor and merge resolver set, goes through `updateOwnedStep` (`step-ownership.ts`): lands only
  while the row is not `pending`/`skipped`, else `StepSupersededError` → `superseded`. The opening
  claim (`openRow`) is a `status='pending'` CAS, then reads the epoch and gives the row back (matched
  on its own `updated_at`) if a Retry overtook it. Recap only after the outcome lands; a recap run
  is queued only while the row still reads `done`. `handleResult` drops a result once the epoch
  moved; `markTaskCompleted` and a step's `markTaskFailed` carry the epoch in their own write.
  `failedTaskRefusesAdvance` drops advances on a `failed` task unless its row is parked at a form.
- **Deliberately NOT in #263:** taking back runs a stale pass inserted after a Retry's reset (see
  found-not-fixed; the merge phase would wedge on a superseded fix run with no `ended_at`).
- **#263 MERGED 2026-09-24 19:03Z as d2a8356d** after 19 Codex rounds (round 19 clean: 👍, 25
  threads resolved). Rounds 12-18 absorbed most of H1: every task write a job makes carries a
  `TaskFence {epoch, reviveFailed?}` (hand-offs, parks, completion, step start), `failed` rows are
  not owned (Stop), a Stop-aborted pass runs `settleFailedTask`, parks go through `writeFencedPark`,
  an undeferrable advance waits in-process for the holder, `/clarify` reopens a failed task, and
  revival is allowed only for a task already failed at pickup (the answer exception).
- **#257's P1 is only partly closed by #263's claim CAS**: a claim whose epoch read lands before the
  Retry commits still activates the sibling, and an epoch-fenced pass leaves it `running`. Still the
  user's call (follow-up PR vs merge as-is).
- **Live checks PASSED 2026-09-24 (dev stack at main 4dca716c, zero CLI invocations):** PR 7 — zip
  (clean, links, nested) and tar.gz repo imports `ready`, 0:0 at 644/755, single top dir flattened,
  link members dropped with the note, no `.haive-extract-*`, archives gone from `_uploads`; a
  two-dir bundle parses agent + skill, 0:0; a greenfield plan build's attachments expand (zip →
  `specs/…`, link dropped + noted), docx/pdf sidecars carry the text, all 1000:1000 at 644/755, no
  `.expanding-*` or `.haive-tool-*` left. PR 2 — `" .claude/agents/x.md"` stored as
  `claude/agents/x.md`. PR 3/4 — the reviewer, fix coder and advisor prompts, composed exactly as
  `spawnReviewAgent` does against task 681f0f99's live ledger and the live terseness level (harness
  script under `packages/worker/test/`, removed after), each carry the ledger block ×1,
  `## Response style` ×1 and the scope sentence ×1. PR 1 — main CI on 4dca716c ran the registry
  pull and the compose build through `scripts/ci-retry.sh`, each passing on attempt 1 (no fetch
  failed, so no retry was exercised live). The `live7-clean` fixture was used for 6d's restart
  check below, then deleted.
- **6d / PR 5 live checks, 2026-09-24 19:13-20:06Z** (dev stack at main d2a8356d, and 3f767df0
  for the item-2 checks; gemma4 cloud and local qwen3 only; every fixture deleted and proved by
  counts):
  - **Restart mid-run PASSED** (task 4bdab2c0). The worker was recreated while 03-plan-sequence's
    agent ran. Its row stayed `waiting_cli` with its answers, and the same agent row was re-rolled
    (attempt 1→2). Boot pass 1 fenced the epoch at exactly 0→1. The orphaned run was ended and
    superseded, and 01's 2 done agents were not superseded. Plan nodes stayed 5→5, and the task
    completed.
  - **Restart under GLOBAL_PAUSE PASSED** (task d93f49cc). A held, never-started re-roll
    invocation kept its row and its link through the restart, and the epoch went 0→1. That task
    later failed on qwen3:1.7b's reply (tool-call JSON, "did not produce a root node"), not on the
    restart.
  - **Item 3 PASSED, with a stand-in** (task 8d37f1c8). Two held wave rows were put into the
    no-provider state by SQL (failed, unlinked, dispatch prompt kept), because disabling all 15
    providers on the shared stack was not an option. The user Resume then re-dispatched both
    (`retriedAgents: 2`). The recomposed prompt equals the original composition, with the stored
    prompt, `## Response style` and the notice each once.
  - **Item 2 PASSED live** (task 5fafeb2a, 20:04-20:06Z). The setup:
    - a `from_repo` build of a zip-imported repo, root run on gemma4;
    - the wave was held on gemma4, with RAG absent, and its prompts said so;
    - the wave stood in as no-provider, as in item 3;
    - a `done` `04-tooling-infrastructure` row was added ON THE FIXTURE TASK
      (`output.tooling.ragMode = internal`, step_index -5, upstream of the Resume's downstream
      reset), which is all `resolveRagMcpConfig` needs;
    - the `expand` seat switched to codex gpt-6-astra (a role row plus a touch marker), then
      Resume.
    - Result: the recovered codex prompts carry the RAG-wired surface line ×1, "No `rag_search`"
      ×0, the rag-on ladder ×1 and the rag-off ladder ×0. The gemma4 originals are the exact
      opposite. Each also carries one surface, one rules block, one `## Response style` and the
      stored step prompt once.
    - The old verbatim replay would have kept gemma4's absent-line: the surface marker skips
      re-adaptation, and the ladder was already rewritten away from its canonical text.
  - **Why a plain provider switch shows NOTHING here** (task 74c3f3a4, same setup without the
    step-04 row): the codex prompts were byte-identical to gemma4's. Every block PR 5 fixes is gated
    on task state, not on the provider alone:
    - the MCP surface and the KB digest need RAG wired, a browser/ddev env, or project servers
      (the last are not emitted under `rag_only`);
    - the LSP arm needs a ready LSP bridge (`hasReadyLspBridge`);
    - the no-vision block needs a learned `modelLimits.vision`, which is null on every provider;
    - `resolveEffectiveRules` gives EVERY provider here the shared `DEFAULT_AGENT_RULES`, since both
      stored rules versions are known old defaults.
    - Incidental: the codex app-server probe ran at that dispatch and recorded `supported` on
      codex 0.156.1.
  - **Side effect, restored:** the live10/11 CLI switches had left the user-wide `01-plan-build`
    default on gemma4. See [[step-cli-switch-is-user-global]]. It is back to claude-code
    `07660e12`, effort NULL.
  - **Live-check lesson:** use the per-task pause. GLOBAL_PAUSE reaches the worker's pickup gate
    up to ~30s late, since `ConfigService.set` clears only the writing process's cache. MEASURED:
    three runs started 11.8-25.9s after it was switched on. The admin card says "within ~30
    seconds", so this is by design.
- **#264 upload paths:** both `splitUploadPath` (worker) and `uploadFileRel` (api) rebuild the stored
  path with `path.join` and require an exact match; the anchor is the root as configured. The two
  other `REPO_STORAGE_ROOT + '/'` prefix checks (01c runner path, repo cleanup) are left, logged.

## Next PRs, handed over by the found-not-fixed sweep (2026-09-24, user's decision)

Seven defects that build on #257/#263, assigned to THIS series; start once both are on main.
Verified on main 42938c55; the full file:line evidence was sent to this session by message
("Hand over 7 recovery items") and is in the sweep plan `~/.claude/plans/compiled-noodling-squid.md`.

1. A pass past its epoch guard flips a row after a Retry (flip + `markTaskRunningWithStep` by id;
   api reads `leftActive`/downstream outside its tx; `handleResult`'s `waiting_cli` write by id).
   PARTLY DONE on #263's branch (per this session, 2026-09-24): `openRow` is a pending-CAS with an
   epoch give-back (478060e0), resets CAS the held epoch (235cd5d0), parks use `updateOwnedStep`
   (ed25b7a5), the job catch fails at its own epoch (0c3fd1b9), stale results/advances drop, and
   (44b09044) `markTaskRunningWithStep` takes an optional epoch: the fix-loop re-entry (pointer +
   `fix_loop.requested` + `started` in one tx) and revise pass it. (08c54800) that tx first
   `lockOwnedStep`s the source row (SELECT FOR UPDATE, ownership predicate; a Retry writes steps
   before the epoch), and boot's `requeueAbandonedOrphan` supersedes+ends the row's live runs.
   (fd2e5a4c) EVERY task write in `handleResult` carries the epoch and stops the hand-off when it
   loses (done/skipped successor, waiting_form + both gate parks via `markTaskWaiting(…, epoch)`,
   waiting_cli write), and `resolveFixLoopGate` (now exported) fences accept/continue and closes
   the gate via `writeOwnedRow`. (7d6bca3e) `failed` is outside the ownership predicate (a Stop
   fails the row with no epoch move), every fenced task write takes `TaskFence {epoch,
reviveFailed?}` and refuses a failed task except the step-start write answering a parked form,
   a Stop-aborted pass that ends `superseded` runs `settleFailedTask`, and both parks go through
   `writeFencedPark` (row write + pointer CAS, or a FOR SHARE hold check on a tick, one tx, rows
   first, rolled back on loss); the step-start write is fenced and returns before `advanceStep`.
   STILL OPEN: the api-side task-row lock before the `leftActive`/downstream reads (#257), and the
   recap summary write keyed on row version (handed to the sweep's S8).
   Also on #263 (f0ab5680): `/clarify` reopens a `failed` task itself before queueing, because its
   answer rides task_events and `failedTaskRefusesAdvance` only excuses an advance carrying formValues.
2. The loop-resume arm (`steps.ts` ~940-1023) reopens without `leftActive`, at the stale epoch.
3. Retry / fan-out resume / loop resume kill sandboxes BEFORE superseding (commit, kill, enqueue).
4. No re-driver between boots; boot pass 2's reset-branch enqueue has no retry and strands a
   `pending` row at a bumped epoch (sweeper modelled on `CliPriorityDecaySweeper`).
5. A redelivered job for a `revise`/`loop_back` step already `done` walks forward, dropping the
   blocking review (re-evaluate the loop in the done-duplicate branch).
6. DAG/merge-fix waits hang on a superseded never-started run; merge fix saves `fixInvocationId`
   after its enqueue; `merge-resolver.ts` lacks unique-violation handling.
7. The #259 stale-submit wiring has no harness (drop + re-park cases in `fix-loop-smoke.ts`).

Status 2026-09-25 (tasks #38-#44; Sonnet agents implement, I review, re-run checks and ship):

- #257 merged; H1 = its follow-up, MERGED #281 (f9c10d03): `openPendingStep` flips then reads the
  task FOR SHARE under the job's fence; api Retry/fan-out reset what a pass activated before their
  bump (`rowsActivatedMeanwhile`, NOWAIT, 503); task retry `settleActiveSteps`; kill after commit.
- H2 MERGED #287 (e92c030b): `moveTaskToStep` for loop Resume, retry_ai, Skip and a CLI switch on a
  failed/parked row; a CLI switch on a `pending` row only invalidates; `currentRound` written with
  the pointer; an ended task answers 409 except for Skip (`reviveEnded`), matching the old
  failed/queued guard's intent (Codex P1). Pause is a `paused_at` COLUMN, never a status, so a
  `running` write does not un-pause.
- H3 covered by #281 + #287.
- H4 MERGED #292 (99351303), clean Codex round, all 9 checks green: `queues/stalled-redrive.ts`,
  boot call (staleMs 0 is safe: no task worker runs yet, and an api advance carries identity +
  epoch only) + 60 s sweeper (5 min stale); the fence locks the task row FOR UPDATE first, then
  re-checks the row. Worktree removed.
- H5 PR #298 (db0c1031), watcher running. The duplicate branch of `handleAdvanceStep` re-drives
  `finishedStepResult(row)` (fixLoop unless suppressed, restartLoop, reviseLoop, fixLoopOnError via
  `errorMessage`) instead of plain `done`; `finishedRoutingVerdict` is shared with the apply tail;
  new `smoke:done-duplicate` (4 cases; case 4 waits on the job's own state). Controls a/e/f
  (smoke) and b/c/d (unit) each bite, per my own run (scratchpad `h5-mutate.py`). A cross-step
  revise FORKS round+1 (task-queue.ts revise case); the reviseLoop JSDoc was corrected.
  `advanceStep`'s own done short-circuit is left alone on purpose (the START path has no
  moved-chain check; see found-not-fixed).
- H6 PR #297 (66702819), watcher running. My first mutation run showed 5 of 8 changes untested,
  so the agent added `runIsLive` (`step-engine/run-wait.ts`, the one-live-per-step index's own
  predicate; sites read `if (!inv || runIsLive(inv))`, no `inv!`) with a unit test, plus a DAG test
  that an enqueue failure leaves the run named. Controls h/c/d/e each fail exactly their tests;
  full worker suite 388/5466 green. The review/replanner/advisor/coder waits have no own test,
  stated in the PR. Mutation script: scratchpad `h6-mutate.py` (restores bytes, not git checkout).
  Codex round 1 (both 👍, VALID): a never-run replanner is ingested as ABORT (parseReplanner's
  default; `resetDagCurrentLevelForRetry` never clears `replanner_invocation_id`), and a never-run
  review-loop fix coder goes straight to a reviewer. The advisor has the same flaw
  (ESCALATE_TO_REPLAN default). My commit message's "what follows each wait already handles a run
  that produced nothing" was TRUE ONLY for the merge waits. Agent adding `isFreeRedispatch` branches:
  replanner clears its cursor by CAS and re-loops; fix coder and advisor re-dispatch free. Pushed
  as 279c6ec5 (fast-forward, no rebase: PR CLEAN, CI builds the merge ref); PR body updated;
  both threads replied. Controls r/x/v each fail exactly their test (my own run). Smokes
  dag-review/dag-escalation now stamp `started_at` in `finish()` (production always does, at
  handlers.ts:207 before anything else, so a null `started_at` means the run never reached a
  worker). Round-2 watcher running.
- H6 #297 later rounds (2026-09-25): (2) VALID — the never-run fix-coder re-dispatch consumed the
  old run first; now the consume is `spawnReviewAgent`'s `claim` (d4c25e0a, control o). (3) BOTH
  VALID, PRE-EXISTING (the run-end write in handlers.ts ~349 is not guarded on `superseded_at`, so
  a Retry-killed run's completion stamped `ended_at` and the old waits ingested it too): a started
  run a Retry/Resume/Stop superseded was read as an answer (replanner → ABORT failed the retried
  DAG) → `runNeverAnswered` = `isFreeRedispatch` or superseded, at all five DAG sites (92d15389,
  control s). (4) P1 VALID: a superseded merge fixer's half-resolved tree was committed by
  `completeMergeHostSide` in the merge resolver AND the DAG merger (`resetDagCurrentLevelForRetry`
  returns before clearing `mergeState` when no issue is stuck-failed) → agent adding "discard
  (`merge --abort`), refund the attempt, re-dispatch" branches. P2 DECLINED (👎, replied): a parsed
  fix-coder result from a superseded run stays used — a DAG Retry only re-attempts stuck-failed
  issues and keeps other issues' progress by design; decisions (replanner/advisor) are re-made,
  edits are reviewed.
  Round 4 fix pushed as f7124f45 (discard/refund/re-dispatch in both mergers; smoke fixer stubs
  stamp `started_at`). Round 5 (both P1, VALID): (a) crash between the abort and the re-merge →
  `mergeCommitted` read the clean tree as committed → folded H8 (task #45) in: `mergeCommitted(dir,
branch)` requires `git merge-base --is-ancestor`, `completeMergeHostSide` takes the branch, all 3
  callers (merge resolver featureBranch incl. `origin/<base>` in base-sync; DAG issue branch;
  01-plan-merge `origin/<branch>`, fetched only while no merge is open), `justAborted` removed;
  (b) a STALE pass proceeded on a superseded run (H6 widened it) → `assertOwnsStep` at all six waits
  when `supersededAt` is set (api Retry supersedes+resets+bumps in ONE tx; the Stop does not →
  ms gap, pre-existing). Pushed 3f4d28ea; mutation script `h6-mutate.py` has 15 controls, all bite.
- H6 MERGED #297 as 1bd479f2 (2026-09-25) after 6 Codex rounds (round 6 clean 👍); main CI green;
  worktree + branch removed; tasks #43/#45 closed. Dev-install check of the abort-as-commit bug:
  the 2 merged merge-resolver states dispatched no fixer (conflictRetries 0); the 2 AI-resolved DAG
  issues are in cancelled task 4905067c whose repo was deleted → no delivered merge affected.
  Main checkout NOT synced (10 tasks parked on forms, 3 busy peer sessions); dev stack runs pre-H5/H6
  worker code until the next sync. Throwaway `h1-smoke-pg` (with DB `haive_h5`) and `h1-smoke-redis`
  still up; remove when no follow-up needs smokes.
- HANDED OVER 2026-09-25 (user's decision): the series' found-not-fixed items went by message to
  the `found-not-fixed-sweep` session, which now owns the one consolidated list (section "Found
  during the recovery series" in [[found-not-fixed-running-list]]). This session picks up no
  further items. The smoke containers and the unsynced main checkout were handed over with it.
- H5 MERGED #298 as bba72fac (2026-09-25), round 3 clean (Codex 👍), all checks green; main CI
  green on bba72fac; worktree and branch removed. Rounds:
  (1) VALID, a regression of H5: `resolveFixLoopGate` writes the gate row `done` before acting, so
  a crash there left a done row and the duplicate branch recomputed the step's verdict over the
  person's answer → the duplicate branch now finishes a persisted gate decision
  (`readFixLoopGateAction`, job values else the row's) through `resolveFixLoopGate` (6142f0e7).
  (2) VALID: on a task that failed BEFORE the answer (Stop while the gate waited), the pickup guard
  refused the redelivered answer once the row was `done` → `failedTaskRefusesAdvance` admits a gate
  answer onto a `done` row when `gateAnswerSentAfterFailure` (`tasks.completed_at` < job timestamp;
  JOB's own values only, since the api submit saves answers on the row); a Stop AFTER the answer
  stands (97d6adce). Naive "move recovery before the guard" would have revived stopped tasks.
  Smoke cases 1/2 raced (checked the target row right after the pointer moved) → they poll now.
  Smoke gotcha: run H5's smokes on their own DB (`haive_h5` in h1-smoke-pg) when DAG smokes run
  concurrently; stalled-redrive scans every running task in its DB.
- H7 MERGED #293 (abbb1742): `fix-loop-smoke.ts` drives `staleSubmitAction`'s drop and re-park
  through the real queue and `handleResult`. Worktree removed. #292's main CI green first.
  The sweep session keeps: cli-exec handler completion writes, the boot sweep of superseded never-ended
  invocations, DAG ledger parse-failure text, DAG `isFreeRedispatch` smokes, and (after #263) narrowing
  the wave consume stamp.
