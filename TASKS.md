# Haive task board

One shared list of open work for every agent and every machine. It lives in `TASKS.md` at the root
of `main` (moved there from the old `tasks` branch on 2026-10-24). Board edits are direct commits to
`main` that touch this file only: no PR, and they start no CI run (`ci.yml` ignores a push that
changes only `TASKS.md`; T419).
A task's number (`T323`) is the number its commits and PRs already cite (`#323`).

## Protocol (read before touching anything)

**Read the board**

```
git fetch origin main && git show origin/main:TASKS.md
```

**Edit the board** (claim, release, add, update, close). Keep one detached worktree on `main` for
it, outside any other work, so a board commit never carries code and a reset never touches yours:

```
git fetch origin && git worktree add --detach <repo>/.claude/worktrees/tasks-board origin/main  # once per machine
cd <repo>/.claude/worktrees/tasks-board
git fetch origin && git rebase origin/main      # ALWAYS first
# edit TASKS.md
git commit -m "tasks: claim T323 (<owner>)" -- TASKS.md   # one change per commit, message says what
git push origin HEAD:main                       # the push is the lock
```

If the push is rejected, someone else pushed to `main`. Run `git fetch origin && git rebase
origin/main` and push again. If the rebase conflicts on the task you touched, or that task now shows
another owner, you lost: drop your change (`git rebase --abort && git reset --hard origin/main`, in
this worktree only) and pick something else. Never force-push `main`.

**Claim before you start.** A task is yours only once your claim commit is on `origin/main`.
Set `status: taken`, `owner: <session-name>@<host>`, `since: <UTC>`. Do no work before the push
succeeds. Refresh `last:` (UTC) when you make real progress (PR opened, round finished), so others
can tell a live claim from a stale one.

**Stale claims.** A `taken` task whose `last:` is older than 48 h may be stale. Do not take it
over silently: ask the user, then set `owner:` to yourself with a note naming the old owner.

**Release** a task you stop working on: `status: open` (or `parked: <reason>`), clear `owner`,
and write where the work stands (branch, PR, evidence path) in its body.

**Finish**: when the PR is merged and main CI is green, delete the task's block and add one line to
`## Done` (`T323 — <title> — PR #N (<merge sha>), <date>`).

**Found something outside your task?** Search the board first (`grep -n "<file>\|<symbol>\|<slug>"`).

- It shares files or a rule with an open task: append it to that task's body as a numbered item
  (what, file:line, PRE-EXISTING or REGRESSION, fix direction) and bump the `(+N)` in its title.
  If that task is `taken`, append anyway; its owner reads the board before shipping.
- Nothing fits: add a new task with the next free number (highest `T` on the board or in `## Done`,
  plus one). If your push is rejected and the rebase shows the number taken, renumber and retry.
- A design item (needs a decision or a new mechanism) is its own task, `kind: design`, never folded
  into a fix bundle.

**Areas owned by one session.** Before claiming, check `## Areas`. Work touching another session's
area needs a heads-up to that session first.

**Keep the session's task list in sync.** The board is the shared sync point, not a replacement for
the Claude Code task tool: the user watches progress in each session's CLI task list. Every board
change you make (claim, progress, release, new task, new item, done) is mirrored in your session's
TaskCreate/TaskUpdate the same turn, and every task you create or finish in the session goes onto the
board. At session start, load the board's tasks you own or will work on into the session task list.

**Status values**: `open` · `taken` · `parked` (waits on the user or on data; the reason says which) ·
`blocked` (waits on another task; `blocked-by:` names it).

## Areas

- Session **modular-haive-plan** PAUSED 2026-10-24 and holds no files: merge-resolver.ts is free, and its
  "heads-up to modular-haive-plan" notes need no heads-up until that session says it is back.

## Decisions and prerequisites

Owner allowance policy 2026-11-02 (codex-queue, latest): monitor actual weekly allowance. At60% remaining, stop admitting new tasks, finish all tasks already in progress, save handoff and pause. This latest explicit owner instruction supersedes the40% and earlier near-zero checkpoints, reserving allowance for other projects. Do not reset or purchase automatically; preserve evidence and parked-task fences.

Execution PAUSED 2026-11-02T22:24:51.792316+00:00 after the owner's60% weekly allowance checkpoint. T330 and T336 finished all required delivery gates and owned cleanup; reconciled queue132 completed,0in progress,124open (parked/blocked included). No new task admissions until the owner resumes. Remaining allowance at pause: 49%. Handoff and receipts: .claude/tmp/codex-run/queue-exec-20261101/. No automatic reset or purchase; historical receipts retained.

Owner resource update 2026-11-02: the C-drive test reserve is5GiB by explicit owner instruction, superseding the inherited20GiB. Keep4GiB RAM reserve and serialize heavy checks. Saved runner policy: `.claude/tmp/codex-run/queue-exec-20261101/resource-policy.json`. Do not prune project volumes or unknown/user data.

Owner review-gate update 2026-11-01: Greptile will not run until November9. Skip Greptile requests and waits before2026-11-09; Codex review and CI remain required.

Owner triage 2026-11-10 (AskUserQuestion, 8 rounds; register `.claude/tmp/codex-run/triage-20261110/answers.md`). Recorded on the blocks: T300, T541, T552, the parks (T144, T147, T560, T585 and the diminishing-returns set) and T326 closed.

- Activate (ready, owner-approved): T373, T570, T523, T505, T386, T443, T492, T504, T460, T286, T318, T484, T271, T291, T310, T329, T270, T497, T334, T317, T440, T512, T487, T435, T323, T554, T343, T532, T145, T199, T446, plus T541 and T552 per their decisions.
- Bounded check first (one pass, at most 3 cases, about 30 min; nothing confirmed means park): T308, T450, T451, T490, T508, T562, T543, T510, T482, T483, T516, T309, T499, T500, T501, T515, T495, T526, T486, T472, T518, T519, T345, T369, T312, T316, T319, T511, T528, T563, T566 (T566 also covers T575).
- Kept open over a park recommendation (owner): T557 (items 2-4, 10, 11, 13-15), T540, T542, T533, T538, T550, T569, T571, T572, T551, T553, T582, T577, T545, T576, T561, T392.

T524's 2026-11-01 owner round answered 42 questions. Decisions are recorded on the affected task blocks; the durable local answer register is `.claude/tmp/codex-run/backlog-decisions-20261101/decisions.json`. No unanswered owner-policy question remains from this round.

- T402: operator script with dry run, before-image and undo. The owner subsequently requested indefinite development-record retention: transcripts changed from 90 to 0/forever through the audited admin API; prompts were already 0. Historical expiry estimates no longer govern this install. Missing old logs remain unrecoverable.
- T300: one owned validation attempt before feature work; stop at 90 minutes or $50 notional usage, whichever comes first, or on an unexpected failure. No automatic retry loops.
- T331: live Google OAuth intentionally remains parked; prepare setup instructions when its turn comes. T358 stays deferred until its first real provider-pinning consumer.
- T299 needs T300 evidence; T293's code fix shipped in PR986 without a paid validation retry; T298 additionally needs graded evaluation data. T332 needs T359; T275's Track B dependency is complete (PR988); the broad audit remains parked under the bounded-work rule.
- Routine diminishing-return work remains parked. Risk-bearing exceptions are verification candidates, not confirmed production bugs or permission for broad audits.
- T487: ask at each Replace ZIP whether to preserve the old bundle until success or remove it first to free disk. Explain rollback loss for remove-first. This supersedes the initial keep-old-only answer.
- T376's shipped strict sign-in audit behavior remains in force; no new break-glass or best-effort policy change was requested.

---

# Open tasks

The prior seven-task delivery is complete. The following is the reconciled queue; member-level execution fences, prerequisites and owner decisions govern each future batch.

## Execution priorities — owner decisions reconciled 2026-11-01

The owner chose new functionality first, with demonstrated operational bugs alongside it, after concrete security/data-loss issues. A verification candidate is not a confirmed defect. Decisions dated2026-11-01 supersede older alternatives and needs-decision wording preserved in historical task evidence. Do not expand an executing task to its parked members or assume a new queue entry authorizes implementation now.

1. **P0 — protect time-limited evidence and trust boundaries.** T402 targeted dry-run inventory/script first (owner requested keep-forever retention, before-image/undo). Then T387's measured unsafe imported Git configuration. Other trust-boundary candidates (including T308/T347/T399/T450/T451/T508/T511) remain bounded P2 verification; escalate a confirmed security/data-loss consequence immediately. Completing every unconfirmed investigation is NOT a prerequisite for the functionality lane.
2. **P1 — explicit prerequisites and a short enabling change.** T300's single 90-minute/$50-capped validation attempt BEFORE new feature implementation. T488's bounded CI-job split then shortens the repeated PR/main feedback cycle. T338 route removal and T467 endpoint retirement/body limit are bounded named security work.
3. **P1 — next after owner resumes.** T121/T122 shipped in PR988 and T456 in PR987. Resume with T521 member 5 (empty-origin push), then T434 (preserve working credentials), T362 (readiness after failed reset) and T496 (vendor-call deadlines), alongside the next approved functionality slice. Preserve each member-level scope fence and obtain its current failing control before implementation.
4. **P2 — next product slices and bounded correctness work.** Integration reasons/create gate/picker/reconnect and visibility: T359/T356/T357/T332/T333/T339/T360/T361. Module/channel delivery: T330/T336/T337, then T351 build → T353 boot gate → T352 publish → T335 install/upgrade. Other open operational/UX/audit tasks follow their recorded policies; verification bundles are not blanket repairs. T319 batching rises only if its current measured gain is material.
5. **P3 — evaluated retrieval and small polish.** T144/T145/T147 retain retrieval-evaluation gates; T298 needs graded data. T199 favicon and T446 documentation are ready but do not displace a feature slice. T275's broad review remains parked; completing its dependencies does not activate a full audit.
6. **P4 — intentionally parked work.** Resume only on the task's stated evidence/consumer trigger or a fresh explicit request. Do not reopen cosmetic, coverage-only, unused parser forms or generic helper consolidation merely because a neighboring task finished.

Verification fence: one short pass, at most three supported cases per candidate, normally 30 minutes without product/model runs. If no concrete consequence is established, record that and park; request a larger scope only for a new consequential finding. Implementation keeps the existing one-build/two-fix-round preference, fresh paired review, feature-level full-suite cadence and PR/main gates. T524 itself performed no fixes or live runs. On2026-11-01 the owner subsequently authorized T402 plus continued execution of the reconciled ready queue, preserving deliberate parks and bounded verification gates.

### T323 · FNF[uploads-3] · finished upload rows are never deleted; the reaper's removal is not identity-checked (+1)

status: open · kind: fix · user decision: resolved 2026-11-01 · priority: P2
All PRE-EXISTING.

4. PARKED (user): `complete` rows in repo_uploads/custom_bundle_uploads and `consumed` db_uploads rows are never deleted — needs a retention rule.
5. Latent, minor: the reaper removes a path without checking it is still the file it lstat'ed (upload-reaper.ts removeFile); fs-safe's lstatNoFollow returns numeric Stats, so dev/ino cannot be compared losslessly. Cannot bite today (upload names are fresh UUIDs). Fix: a bigint lstat identity export in fs-safe, compared before the unlink.

User decision 2026-11-01: Retain complete/consumed upload metadata 90 days; protect active or retry-needed rows. Item5 identity-hardening remains parked until reachable impact.

### T286 · FNF[root-work] · a task at the root after 01 was skipped escapes the fences (+3)

status: open · area: touches finishMerge — heads-up to modular-haive-plan first · #278 (fnf/278-merge-dir-reads) LANDED as PR #884 (c48df1953) 2026-10-24: git-operation.ts, set-aside.ts, git-merge.ts, merge-projections.ts, merge-baseline.ts and left-open-merge.ts are free · priority: P2
All PRE-EXISTING; notes .claude/tmp/track-b/b3/b31c/analysis/guard.md.

1. checkoutHoldingTasks({rootOnly}) (repo/refresh.ts:32-46) misses a task whose latest 01 round was skipped; count it in SQL like decideTaskWorktree.
2. 99-run-app-ready builds its preview at detect but commits `git add -A` at submit; can commit unseen files incl. Haive state.
3. Low, verify first: a root `git add -A` racing a projection writer can stage its temp file.
4. DECIDED D22: fence the whole open-merge window — refuse/delay a root task's START while a same-branch merge is open, under lockRepositoryTasksKey.

### T271 · FNF[dag] · the DAG level merge never settles Haive's own files

status: open · priority: P2
dag-executor.ts (~681, ~951) aborts level merges without resolveHaiveProjectionConflicts, so a conflict only in Haive files goes to a fixer. Fix: run B3.1c's revert helper on each DAG issue branch before its level merge. (#274 merged, so unblocked.)

### T291 · FNF[fs-park] · a process death mid-park leaves the file under its park name (+2)

status: open · priority: P2
All PRE-EXISTING.

1. fs-safe.ts ~1115-1262 parks as `.<leaf>.haive-park-<pid>-<uuid>`; a kill between rename and settle leaves it there; nothing sweeps it. Fix: boot/temp sweep puts it back when the name is free, else reports.
2. _rules-files.ts stripRtkBlocks (~180) / appendRtkBlock (~336) await 02's DB insert while AGENTS.md/CLAUDE.md is parked; record before the park.
3. plan/mirror.ts ~287/~316 await git while plan.json is parked — deliberate; item 1 covers it.

### T308 · FNF[worktree-aliases] · hard links planted into .haive/worktrees before #800 survive

status: open · priority: P2 · gate: bounded verification
A file under `.haive/worktrees` sharing an inode with a name in the writable checkout stays writable through the alias. Fix: a one-time background sweep (recorded per repository) that copy-replaces files whose st_nlink exceeds their names under that tree, via fs-safe. Measure the walk on a large repo first.

Execution fence 2026-11-01: first establish an affected legacy/current supported case in owned fixtures. The recorded risk is not a confirmed production incident and does not make completing an unbounded inventory a prerequisite for new functionality. Escalate a reproduced security/data-loss consequence.

### T309 · FNF[cancel-cap-2] · a capped cancel with no claim row never finishes (+8)

status: open · gate: bounded verification · user decision: recheck risk-bearing members, 2026-11-01 · priority: P2
All PRE-EXISTING, low.

1. abandonCancelledTeardowns selects only tasks with merge_dir_claims rows; a DAG-mode capped cancel never gets cancel_finished, and worktreeSharer keeps counting it. Select also recorded mid-merge / DAG activeConflict within the re-drive window.
2. task-left-merge-banner.tsx polls /events every 3 s forever for a cancel that never finishes.
3. Nothing in the web reads cancel_finished's abandoned/reason; show one line.
4. A task whose recordLeftOpenMerges keeps throwing is reselected every pass (LIMIT 20 can starve the rest); write a cooldown event.
5. The abandon pass skips cleanupTaskContainers and cleanupTaskScratchWorkspace (task-queue.ts ~1012); verify a reaper doesn't cover it, then call them best-effort.
6. No real-DB coverage for the refund on a refused enqueue or the sandbox guard; ~25 lines in stalled-redrive-smoke.ts.
7. merge-resolver `halt` keys "own merge" on ref/sha, so a cancelled task's same-ref open merge reads as this step's (area: modular-haive-plan).
8. (T458 review, 2026-10-31) PRE-EXISTING, minor: `runTaskJob`'s catch (worker task-queue.ts ~:4164) fails the open task of any job that throws, a CANCEL included, so a transient error in `markTaskCancelled` fails the task it was cancelling instead of leaving it for the cancel re-drive.
9. (T458 fix round, 2026-10-31) PRE-EXISTING, minor: the Cancel action, the step abort and `DELETE /plan/merge` clear the pause after the cancel commits and before they queue the CANCEL job (api routes/tasks/index.ts ~:1297, steps.ts, plan.ts), so a database error in `clearTaskPause` answers 500 with the task cancelled, no job queued and, for the abort, no `step.abort` event; the stalled sweep queues the lost teardown five minutes later.

Executable verification scope: Cancellation completion/capacity and starvation: prioritize1/4/8/9; cosmetic, isolated coverage and cleanup members remain deferred. No automatic full-bundle repair: prove a supported current consequence, then scope the fix; park the remainder.

### T312 · FNF[rag-own-paths][verify-first] · customCodePaths can name missing directories

status: open · priority: P2
Eval repo 0e72847d names `sites/all/modules/custom/` + `sites/all/themes/custom/` (neither exists; real code is `sites/all/modules/activit`), so D1's own-code exemption never applies. Verify where customCodePaths comes from and how many dev repos name a missing path; then detection verifies candidates and the RAG build warns when an own-code path matches no file.

### T316 · FNF[merge-resolver-2] · resolver follow-ups (+8)

status: open · area: modular-haive-plan (heads-up first) · #278 (fnf/278-merge-dir-reads) LANDED as PR #884 (c48df1953) 2026-10-24: git-operation.ts, set-aside.ts, git-merge.ts, merge-projections.ts, merge-baseline.ts and left-open-merge.ts are free · gate: bounded verification · priority: P2

1. Dead code: the origin-keeps-advancing halt and MAX_BASE_SYNC_ROUNDS never fire (baseSyncRounds never passes 1). Re-enter prePushSync from a base-sync round, or delete both and update merge-conflicts.md.
2. A person's commit on an unrecorded squash: reported as "Squash skipped"; walk first-parent for the squash.
3. Reset/commit recovery still require ORIG_HEAD even with squashMergeSha (git-merge.ts ~1345-1356).
4. Trivial: two throws in squashMergeCommit with no recovery clause.
5. Lock hold: C1/C2/C3 (reopen, captureFixBaseline, openMerge hand-back out of the lock); crash window on baseShaBefore. Analyst marked three variants UNSAFE — see the task's history in .claude/tmp/fnf-run/.
6. handBackWritten ~2.2 ms CPU per path (git-merge.ts:226-228); a directory-grouped primitive.
7. CLOSED by #873. 8. CLOSED by #877.
8. left-open-merge.ts:61-65 peekOpenMerge reads an unreadable dir as gone (may be covered by fnf/278); merge-resolver.ts:686-691 countAhead reads a failed count as 0 and skips the pre-push sync.

Execution fence 2026-11-01: Reconcile closed and overlapping members first. Focus on a supported recovery/commit consequence in2/3/5; dead-code cleanup, throw wording and micro-optimizations stay parked. Failed-read overlap goes through T495 rather than a second repair.

### T144 · RAG F6 · the lexical half rarely co-supports a hit

status: parked · reason: no retrieval evaluation exists (owner triage 2026-11-10); resume when one does · kind: ranking change (gated on the retrieval eval) · priority: P3
shared/src/rag/search.ts:449/:560 plainto_tsquery ANDs every term; 67.6% of logged searches with code hits had no two-ranker hit. TRAP: plain OR and coverage ranking measured WORSE (AGENTS.md "Identifier search"). Plan P2(b): a capped IDF ranker.

### T145 · RAG F13 · Slovak text matches only verbatim

status: open · kind: feature · user decision: resolved 2026-11-01 · priority: P3
_rag-connection.ts:130 update_content_tsv uses to_tsvector('english') without unaccent ("kotolna" misses "kotolňa"). Needs a backfill (like backfillIdentifierTsv) and a fail-open path without the extension. Plan P2(e).

User decision 2026-11-01: Approve bounded Slovak accent-insensitive retrieval with a backfill and extension-unavailable fallback; retain retrieval-evaluation gates for T144/T147.

### T147 · RAG F5 · identical chunk bodies across files are never collapsed

status: parked · reason: no retrieval evaluation exists (owner triage 2026-11-10); resume when one does · kind: ranking change (gated on the eval) · priority: P3
8.3% of chunks share a body with another file's chunk. A query-time collapse needs the SQL LIMIT widened past top_k. Plan P2(c).

### T149 · RAG F15 · deleted vectors keep their HNSW space

status: parked · reason: diminishing returns (2026-11-01 scan): Index-space reclamation needs measurement; no current user-facing failure described; resume when resume when index growth causes measured storage or search problems · priority: P4
A 0-row project store still holds a 275 MB HNSW index (_rag-connection.ts:69); nothing runs REINDEX. Measure index size before/after the next full reindex (ride T311's reindex).

### T275 · full-repo review pass after Track B

status: parked · reason: diminishing returns · priority: P3
A full-repository review in the style of the Codex PR reviews once Track B is merged; file findings by bundle.

Reconciled 2026-11-01: Track B shipped in PR988. The dependency is resolved, but a broad full-repository audit remains parked under the owner's bounded-work/diminishing-returns rule. Resume only for an explicit owner request or a concrete bounded risk that warrants its scope; no automatic audit follows this delivery.

### T300 · live re-checks owed at the next real onboarding + workflow run

status: parked · reason: corrected capped attempt stopped after confirmed T293; remaining checks need a future authorized run · kind: capped validation · priority: P1
Owner decision 2026-11-10: second capped run approved, same budget (one owned repository, one attempt, 90 min or $50 notional, no automatic retries); house-rules checks first. T298 and T299 stay blocked on it.
Items 1-20 (each with its memory file): skills per CLI after 09_5; frontmatter YAML; agent_rules stamp; declared verify commands; invariants-doc lever; prompt guard/fence (07_7); onboarding artifacts; plan breadth refusals; agent isolation 1/2/4; fs-safe live verification; #169 DDEV runner boot-subpath; #241 Terminal cwd; AGENTS.md split citations; parked experiments (Astra vs Sol, container-cleanup race, global KB purge, haive_rag_ddevtest drop); T293; #287 EROFS on state; #800 mounts; #751 set-aside on a real merge; #806 put-back; #815 reindex spot-check; T375 gate 3 on a worktree holding an untracked nested repo, with and without a commit (#909); T395 Stop offered for a running task whose current row is pending, and the "Nothing was running to stop." notice (no such task on the dev install; pressing Stop changes a real task) (#908); T363 New Task with one failed upload, the plan starter and the task page Start, each with confirm yes and no (#913). Full list: task #300 text in the fnf-run ledger / memory. Also owed (T427): replay the raw attach bytes of one real `claude setup-token` run through the OAuth capture and pin its wrap, newline and escape shapes in a fixture.

User decision 2026-11-01: schedule one dedicated capped validation run BEFORE feature work. Precise cap is being selected; one owned fixture/attempt, no automatic retry loops. A run does not by itself prove enough graded data for T298; report unverified members at the cap.

Final budget: One owned fixture/attempt; stop at90 minutes or $50 notional usage, whichever comes first, or at an unexpected failure. No automatic retry loops. Run before new feature implementation as requested. Prioritize T293/T298/T299 evidence in one fresh onboarding/workflow attempt. Owned fixtures only; no unrelated Astra/Sol benchmarking, real-user Stop/authentication, global-KB purge or legacy database deletion is implied. If a cap or unexpected failure stops the run, report the unresolved checks rather than retrying or declaring them verified. T298 still needs graded evaluation evidence before similarity is enabled.

Execution 2026-11-01T15:21Z: read-only preflight begins under the90minute/$50notional cap. One owned fixture/attempt; do not start live onboarding or spend on CLI/model probes until the session confirms final P0 worker source is loaded. No automatic retries; stop at cap or unexpected failure and preserve unverified members.

Stopped 2026-11-01T15:52Z: selector fixture was checked before Git initialization, producing changedFiles:null and unreadable-change fallback. No product selector defect established; no onboarding/workflow or model calls ran (0invocations/$0notional). Owned task cancelled, own rule unenforced, records retained, watcher exited. All26checks remain unverified; original no-retry rule honored. A fresh owner decision is pending for one corrected attempt within unchanged16:51UTCdeadline/$50ceiling($40stop). Evidence T300/report.md/finalreceipt.json/member-results.json; do not treat scenario failure as demonstrated product bug.

Owner approval 2026-11-01T16:32Z: one corrected attempt in SAME retained fixture, normal onboarding before selector check; original16:51:08UTCdeadline and$50ceiling/$40stopthreshold unchanged. No further automatic retries. Initialattempt/stoprecords retained, no productdefect inferred. Local heavytests held during livephase.

Corrected attempt stopped 2026-11-01T16:55Z: T293 reproduced during normal09_3. Agentuid1000 facedroot:root0755KBdirectory/0644files, honestfailedwrites/kbWrites[]; Haive stilldone/correctedCount1/noerror andunchangedKBhash.9finalizedinvocations/$1.0203736notional; stopped16:45:41 beforedeadline, no newround/retry/thirdattempt, allownedtasks cancelled/dataretained/rulecleared/watcherexited.1agent-rulesPASS,1T293FAIL,24UNVERIFIED(includingT298/T299; Git12notreached). Userfirstquestionapprovedexactlyonecorrectedattempt, nowconsumed. Evidence T300/corrected-report.md/corrected-finalreceipt.json/member-results.json; no morepaidvalidationwithoutnewapproval.

### T298 · house rules PR8 · switch similarity on with per-rule floors

status: blocked · blocked-by: T300 and graded evaluation data · priority: P3

Validation scheduling decision 2026-11-01: attach to the dedicated capped T300 run before feature work; actual evidence/data prerequisites remain, and no successful live result is inferred.

The owner scheduled one capped validation attempt; this block is an evidence dependency, not an unanswered policy question.

### T299 · verify-first · house rules PR7a zero-token live check

status: blocked · blocked-by: T300 · priority: P1
Read .claude/tmp/house-rules/ledger for a PR7a live-check entry; if absent, run it per the house_rules_series memory against repo hr6-live-d7 (3e2c0533), then decide whether hr6-live-d7 is still needed.

Validation scheduling decision 2026-11-01: attach to the dedicated capped T300 run before feature work; actual evidence/data prerequisites remain, and no successful live result is inferred.

The owner scheduled one capped validation attempt; this block is an evidence dependency, not an unanswered policy question.

### T199 · /favicon.ico answers 404 on every page

status: open · kind: feature · user decision: resolved 2026-11-01 · priority: P3
Add an icon via the Next app-router convention (src/app/icon.svg or favicon.ico).

User decision 2026-11-01: Use a simple Haive H favicon.

### T270 · FNF[plan] · a child insert can take a parent's path from before a concurrent move

status: open · kind: fix · user decision: resolved 2026-11-01 · priority: P2
applyPlanPatch's loadNode reads the parent path unlocked (shared/src/plan/apply-patch.ts:415). FOR SHARE on the parent is not enough (a move rewrites descendants in one UPDATE). Direction: a per-repository plan-patch advisory lock first in applyOps; lock-order analysis owed.

User decision 2026-11-01: Serialize conflicting edits; bound waits and return explicit retryable busy responses. Lock-order analysis remains required.

### T310 · FNF[kept-metadata-moves] · captured owner/mode lost when a re-sync does not finish

status: open · kind: fix · user decision: resolved 2026-11-01 · priority: P2
A: six non-merge move paths drop the kept map after a re-sync that may have returned false. B: projection writers create files as root (verify on dev). C: persisted keptMetadata never settled again. D: reachDone / settleGoneMerge after a failed re-sync. Options: inherit owner from parent dir; persist the kept map per repo; retry the re-sync before restoring.

User decision 2026-11-01: Preserve captured owner/mode until recovery completes; never silently discard metadata.

### T317 · FNF[rtk-first-import] · a stamped RTK choice loses to the first record import

status: open · kind: fix · user decision: resolved 2026-11-01 · priority: P2
sync.ts:514 (`row !== null`) and :528; pinned by project-state-sync.test.ts:1850 and onboarding-upgrades.md. Fix if approved: drop `row !== null`, flip the test.

User decision 2026-11-01: A stamped local RTK choice wins against first imported record.

### T318 · FNF[task-lock-wait-2] · remaining unbounded waits on start paths (+9)

status: open · kind: fix · user decision: resolved 2026-11-01 · priority: P2

1. /clarify takes the creation lock for a live task (api tasks/steps.ts:821). 2. Worker revival wait unbounded (_revive-check.ts:86); needs a soft-fail path first. 3. reviveDeadTask takes no creation lock. 4. mergeInScratch uses the pool inside the plan-merge transaction. 5. New-work fence and the advisory start's plan_nodes lock wait unbounded. 6. Ten waiting starts can starve the api pool for 30 s.

From the T355 build (2026-11-07), PRE-EXISTING: 7. api middleware/maintenance.ts ~:45-54 fence read sits inside the start path with no bound of its own beyond the config store's 2 s. 8. worker `_revive-check.ts` ~:60 revival read: decide hold vs fail now that the read can reject.

User decision 2026-11-01: Bound conflicting task-start waits and report a clear retryable busy response; do not proceed from stale state.

From the T346 build (2026-11-08), PRE-EXISTING: 9. `claimTaskStart` accepts `created` (worker task-queue.ts:351, 355, 390); dormant, no producer sends START for a created task. 10. A losing concurrent Start reports a stale `status: "created"` (api tasks/index.ts:1343-1344).

### T319 · FNF[set-aside-batch] · set-aside spends 20-24 git spawns per dirty path (+1)

status: open · kind: performance · user decision: resolved 2026-11-01 · priority: P2

1. set-aside.ts:264/:281/:474/:574 per-path git reads (prototype: 6,620 spawns → 20). 2. readStateTree one cat-file per file (projection-merge.ts:157); batch with `cat-file --batch`.

User decision 2026-11-01: Re-measure current batching gain and keep scope bounded; behind functionality unless current delay is material.

### T329 · FNF[cancel-merge-commit] · cancel reports a merge left COMMITTED on local base + one-click undo (+2)

status: open · was modular #3 · priority: P2
DECIDED by the user 2026-10-12: cancel reports a merge left COMMITTED on the local base, plus a one-click Undo. The Undo resets only if the base is still at that merge commit and no claim is live. Never auto-undo.
Two PRs:

- A (report): baseShaAfter/landedOn recorded at merge time, a merge.left_committed event, and a banner.
- B (undo): UNDO_LEFT_MERGE job, root claim, merge-dir lock, 00a fence and containment, `reset --keep` with a sha CAS or update-ref CAS.
  Defaults: step 12 only. Undo re-creates a deleted feature branch (create-only). Pushed merges and /host-fs get the report only. Agree the merge-resolver hunks with the owner of merge-resolver.ts before building.

1. (PRE-EXISTING) A cancel between the merge commit and reachDone leaves merged:false, so onboarding-reset provenance (api repos.ts ~:1103-1150) misses a merge that is on the base. A's baseShaAfter makes this cheap to fix.
2. (PRE-EXISTING) A cancelled task's failed step 12 still says "retry the push", although a cancelled task cannot be retried. The comment at api routes/tasks/index.ts ~:1201-1203 wrongly says step retry has no status guard (steps.ts guards it).

Dependency reconciliation 2026-11-01: B3.1c landed and modular-haive-plan is paused with no files held; old peer-ownership notes are not a current blocker. Existing user-decided report/explicitUndo semantics remain.

### T331 · I7 · modules/integration-google (Drive, Docs, Gmail)

status: parked: needs a real GCP OAuth client from the user · was modular #42 · priority: P4
Plan I7: REST by default, remote MCP opt-in. Blocked until the user provides an OAuth client.

User decision 2026-11-01: keep live Google connection parked; prepare setup instructions when its turn comes. A live OAuth client is still an external prerequisite; never request a secret in chat.

### T334 · FNF[builtin-order-hazards] · built-in workflow runs 07b before 07c, and 08b fixer edits after both

status: open · kind: fix · user decision: resolved 2026-11-01 · priority: P2
All PRE-EXISTING.

1. 07b-phase-4-validate boots and uses the runtime (07b:787) against a DDEV container that has not yet applied the implementation's .ddev change; 07c-ddev-reconcile runs after it in registry order (steps/workflow/index.ts).
2. 08b-test-management writes tests and fixer edits after 07b validated and 07c reconciled; nothing re-validates or reconciles them.
3. orderWorkflowRunList (execution-paths.ts:165) runs 00a-sync-base before the env prelude, so a merge-fix agent dispatched on a divergent base runs before the env image and LSP checks exist.
   Decide:

- whether to put 07c before 07b in the built-in workflow (then composable-core gets "07c precedes validation");
- whether 08b's fixer edits need a re-check;
- what to do about 06-run-config: it is the only writer of tasks.pre_answers and is not in the composable catalog, so custom types park forms that have no defaults.

User decision 2026-11-01: Reconcile runtime before validation; revalidate affected final changes after a later fixer edits code or tests

### T531 · FNF[module-sources] · install-source fetch/pin follow-ups from T337 and T531 reviews (+6)

status: parked · reason: diminishing returns (owner triage 2026-11-10); resume on a user report, a measured failure, or a change in the same code · kind: fix · found: T531b reviews 2026-11-06 · priority: P4

8. The SHA-pin guard keys on lowercase 40-hex only (packages/worker/src/modules/source-fetch.ts ~:281). An uppercase 40-hex ref is a plain name: it fails closed unless someone has created a branch or tag with that uppercase name, which is then built without the `module_source_ref_ambiguous` refusal. PRE-EXISTING, low (needs ref-write access plus an uppercase paste). Fix direction: compare case-insensitively and refuse a named ref that differs from the lowercased value, or document lowercase-only.
9. Rows pinned before PR #1024 whose 40-hex ref resolved to a same-named branch keep building that `resolved_sha` until Refresh (source-fetch.ts ~:277 runs the guard only when `resolvedSha` is null). PRE-EXISTING, near-zero exposure. Fix direction: refuse when the ref is 40 hex and `resolvedSha` differs from it.
10. Test gaps: the ambiguous-ref refusal test does not assert `checkout.transfers` is empty (packages/worker/test/module-source-git.test.ts ~:225); no tag-only conflict case without a same-named branch (~:178-195). Nit.
11. The entry poll lists a directory whole before counting (`readdirSizesNoFollow`, packages/shared/src/fs-safe.ts ~:674), so one flat directory of many files costs one full lstat pass per poll before the limit fires (documented in modules.md). PRE-EXISTING. Fix direction: a `limit` option that stops before the lstat loop, with the fs-ratchet check.
12. A raw SHA that is an annotated tag object ID reports `module_source_ref_moved` (source-fetch.ts ~:309), a misleading message; safe. PRE-EXISTING.
13. packages/worker/src/modules/source-pin.ts ~:53 embeds literal `5000` and `64 * 1024 * 1024` in the Python pin helper, untied to `MODULE_TREE_ENTRIES`/`MODULE_TREE_BYTES`. PRE-EXISTING. Fix direction: interpolate the constants.

### T533 · FNF[build-channel] · build-channel.mjs, channel-gate, channel-boot-check and publish-channel follow-ups from T351/T353/T352 (+1)

status: open · last: 2026-11-06 · kind: fix · found: T351 reviews 2026-11-05 · priority: P3

24. build-channel stops only the direct `docker` child (scripts/build-channel.mjs ~:69, `capture`); no process-group kill, and whether BuildKit stops the solve server-side when the CLI dies is unverified. PRE-EXISTING; found T533d review. Fix direction: spawn detached and signal the group, then measure a killed build on a live daemon.

### T538 · FNF[updater-manifest] · release manifest read and refusal-row leftovers from T534/T537 (+1)

status: open · kind: fix · found: T534 review 1 2026-11-06 · priority: P4

4. Some refusals still write no attempt row: argv errors, missing `DATABASE_URL`/`REDIS_URL`, failures before the journal or the lock, and a failed insert. The admin page then shows only the launch box. PRE-EXISTING. Fix direction: an api-side follow of the container's exit code for the cases the updater cannot record.

### T539 · FNF[installer-manifest-reader] · installer manifest reader leftovers from T536 (+3)

status: parked · reason: diminishing returns (owner triage 2026-11-10); resume on a user report, a measured failure, or a change in the same code · kind: fix · found: T536 reviews 2026-11-06 · priority: P4

2. install.ps1 ~:408 `ConvertFrom-Json` rejects a valid 513-digit numeric value in an unknown key that the sh reader accepts. PRE-EXISTING, low; no published manifest carries one. Fix direction: parity control and a pre-scan, or document the difference.
3. `quoted()` in the Docker-context reader (install/install.sh ~:270) accepts a literal newline or an unknown escape inside a JSON string. PRE-EXISTING; fails closed downstream. Found T539b review. Fix direction: reject both, with a parity case.
4. The context reader tests run on the host awk only (scripts/test/install-context.test.mjs); mawk and busybox parity was measured by hand. Found T539b review. Fix direction: run the context cases under the pinned mawk/busybox images like the manifest tests.

### T540 · FNF[stop-settle-sweep] · no sweep re-drives a lost settle or Cancel job

status: open · kind: design · priority: P3
PRE-EXISTING, from the T393 build (2026-11-07). A `settle-stopped-task` job that was never queued (Redis down past the 2 s bound) or exhausted its attempts has no re-drive; `redriveCancelledTasks` (worker queues/stalled-redrive.ts ~:586) covers cancelled tasks only. Backstops by what is held: task auth volumes, the boot reaper only; terminal shells, the idle reaper; onboarding re-sync, the 60 s checkout sweep (project-state/watch.ts ~:121); embed model, the boot reconcile; Ollama CLI models, keep_alive; a kb_author 'enriching' entry, none. Decide: a sweep over failed tasks with unsettled holdings, or accept the backstops.

From the T355 build: `enqueueCancelJob` (api lib/cancel-task.ts ~:125, ~:145) is now bounded and can return without queueing; the same sweep would cover a Cancel whose job never reached Redis.

### T541 · FNF[kb-author-failed-then-cancel] · a Stop-settled kb_author entry stays 'failed' after a later Cancel

status: open · kind: design · priority: P3
Owner decision 2026-11-10: Cancel deletes a failed kb_author entry (restore the earlier behaviour).
PRE-EXISTING for worker-failed tasks; since T393 (PR #1026) a Stop then Cancel also leaves the entry 'failed' where it was deleted before. worker `_global-kb-promote.ts` ~:744-783 reconciles only skeleton and enriching entries. Decide whether a Cancel deletes a failed entry too.

### T542 · FNF[settle-members-recheck] · settle members act on a task without re-reading its status after the job-start fence

status: open · kind: fix · priority: P3
PRE-EXISTING, from the T393 build (2026-11-07); cost is a cold start or lost shell state when a Retry races a settlement.

1. Members that do not re-check: worker task-queue.ts ~:2045-2052 (the 'superseded' branch), cli-exec/handlers.ts ~:584-631 (`cleanupAuthAfterTerminalSummary`, status only), terminal-session-reaper.ts ~:161-193, ollama-provision.ts ~:292-349, embed-residency.ts ~:87-103.
2. `cleanupTaskContainers` (task-queue.ts ~:1239, 1280, 1303) appends audit events on every run, so a Stop with a pass in flight (two settlements) can log a duplicate `auth_volumes.destroyed`. Informational.
3. `defaultContainerCleanup` (task-queue.ts ~:1460-1474) is dead in production: nothing writes a task-bound containers row. Informational; do not delete without checking module consumers.

### T543 · FNF[task-auth-volume-lifecycle] · task auth volume teardown leftovers (+1)

status: open · kind: fix · priority: P3
PRE-EXISTING, from the T393 build (2026-11-07).

1. The boot reaper removes failed-task volumes without syncing a rotated single-use token back (worker auth-volume-reaper.ts ~:19, 125, 148).
2. `clearTaskAuthPreparationState` without a provider drops in-flight locks (task-auth-volume.ts ~:293-302).
3. Concurrent auth syncs share the `.haive-tmp` name (task-auth-volume.ts ~:1363-1366); likelier now that a Stop with a pass in flight runs two settlements.

From the T346 build (2026-11-08), PRE-EXISTING: 4. `failedMcpAddNames` (task-auth-volume.ts:962) can race a sibling run of another surface on the same volume and fall back to the general cause; `clearTaskAuthPreparationState` shares the in-flight state.

### T545 · FNF[updater-found-state-fallback] · updater residual double failure and unbounded version wait

status: open · kind: fix · priority: P3
PRE-EXISTING, from the T355 build. 1. updater run.ts ~:394-395: a rollback whose found-state read and write both fail leaves no record of the hold. 2. run.ts ~:115-130 `awaitVersion` has no timeout.

### T547 · FNF[config-write-unknown-outcome] · a write that times out may still land

status: parked · reason: diminishing returns (owner triage 2026-11-10); resume on a user report, a measured failure, or a change in the same code · kind: design · priority: P3
PRE-EXISTING class, sharper since T355 bounds writes at 2 s. A rejected SET may have reached Redis; callers report failure (or roll back audit rows) for a value that is live. Sites: api maintenance.ts ~:91-93, admin.ts ~:471, ~:1233, ~:1270; modules loader.ts ~:580, ~:598; global-kb.ts ~:499, ~:747-763. Same for a bounded `Queue.add` that lands after its race: a retried request can queue the job twice. Decide: read-back after timeout, idempotent job ids, or accept and document. Since T549 the api's shared `getRedis()` is bounded too (503 `redis_unavailable`), adding these sites where a timed-out write may land while the route answers 503 and skips its follow-up: api routes/tasks/index.ts ~:1658 (steer publish: no event persisted, the steer can still reach the CLI), cli-providers.ts ~:955, ~:978 (usage-auth state set and take), integrations.ts ~:199, ~:224 (OAuth attempt put and take), lib/integration-device.ts ~:72, ~:102 (device-flow state). (lib/auth-throttle.ts was fixed in #1034: the `zrem` is queued on rejection.) Residual of the sync-lock release (shared rag/sync-lock.ts ~:121-126): a SET sent just before the connection drops, with the release then refused on the closed connection, can still hold the key up to its 120 s TTL. (T546 run) cli-exec `deferJob` (queues/cli-exec/defer-job.ts ~:35) retries a refused `moveToDelayed`; a defer that landed with a lost reply could then run the job twice (theoretical: a lost reply on BullMQ's connection hangs rather than rejects). A `job.isDelayed()` probe before each retry would close it.

### T548 · FNF[config-blip-tolerance] · a sub-second Redis blip now fails requests

status: parked · reason: diminishing returns (owner triage 2026-11-10); resume on a user report, a measured failure, or a change in the same code · kind: design · priority: P3
From the T355 build. With no offline queue, a reconnect window fails every config read at once (503 or held work). Decide whether a short retry inside the bound is worth it, measured against a restarted Redis. Since T549 the same holds for every request-path `getRedis()` call in the api (retryable 503 `redis_unavailable`); boot is safe because bootstrap awaits `configService.initialize` after `initRedis`. (T544 run) Flaky timing test shared config-service-outage.test.ts ~:224 (800 ms bound; `FakeRedis.refuse()` ~:50-57 waits a fixed 100 ms) failed once under heavy concurrent load. (T546 run) A watch armed on a typed outage while the stored mode is 'off' (task-queue.ts ~:1862) resolves or notifies if the admin later turns the mode on; inert while 'off'.

### T550 · FNF[queue-add-unbounded-rest] · about 34 api `Queue.add` sites still unbounded

status: open · kind: fix · priority: P3
PRE-EXISTING, from the T355 build. Use `boundedAdd`/`addBestEffort`/`addOrRefuse` (api lib/queue-bounded.ts) and check each failure path. Sites: repos.ts ~:228, ~:560, ~:831, ~:3605; bundles.ts ~:360, ~:434, ~:697, ~:920, ~:965; cli-providers.ts list paths; plan-mirror.ts; browser-access.ts; browser-vnc.ts ~:225; cli-login-banner.ts; ide.ts ~:453; ddev-control.ts ~:55; modules/sources.ts ~:194; loader.ts ~:389; project-state-resolve.ts ~:14; cli-version-refresh.ts; reprice-cli-jobs.ts ~:38; cli-job-poll.ts ~:26.

### T551 · FNF[outage-503-web-copy] · web shows a generic error for 503 config_unavailable

status: open · kind: fix · priority: P4
From the T355 build, cosmetic. The web client renders the 503 as a generic failure; name it as a temporary outage with a retry hint. Nits for the same pass: `readTolerant` duplicated in worker 08c ~:129 and 08d ~:140; dead `runtimeOccupancyMb` at runtime-admission.ts ~:438 (mention only, pre-existing). The custom tool Start gate (T346) answers the same 503 on a config outage. Since T549: the same for 503 `redis_unavailable`, and `/admin/health` reports `redis: 'up' | 'down'` that the admin page does not show (web app/(app)/admin/page.tsx ~:356; `AdminHealthResponse` in lib/api-client.ts ~:1596 lacks the field).

### T552 · disabled provider in task terminal shells (design)

status: open · kind: design · priority: P3
Owner decision 2026-11-10: block in the server: refuse a task terminal for a disabled provider; the web follows.
PRE-EXISTING, from T406 item 2. The shell sockets check ownership only, never `enabled` (api terminal-shell.ts ~:495-531; worker terminal-container.ts ~:173-196), while web deliberately keeps a disabled task-bound CLI in its terminal (web page-cli-fallback.test.tsx ~:353, tasks/[id]/page.tsx ~:2677). Decide whether a disabled provider may still open a task terminal; then enforce it server-side or document the web-only rule.

### T553 · FNF[disabled-task-cli-2] · leftovers after the disabled-provider hold

status: open · kind: fix · priority: P3
From the T406/T408 build (2026-11-07).

1. Disabling a provider gives no warning that it now holds tasks and steps pinned to it (api cli-providers.ts PATCH ~:441-512). Introduced by the hold's semantics.
2. A provider-hold park shows the "runtime slot" list badge: `deriveSlotWait` (shared step-engine/slot-wait.ts ~:97) has no structural column for a provider wait. Cosmetic, introduced.
3. The hold copy names only enabling the provider, not switching the step's CLI (worker orchestrator/provider-hold.ts).
4. A step held on a disabled provider shows "usage not connected": the usage poll covers enabled providers only (worker usage-poll-queue.ts ~:424). PRE-EXISTING, widened.
5. The recap filters `summaryCliProviderId` to enabled only and falls to the step CLI; a recap whose resolved CLI is a disabled explicit pick is skipped silently (worker step-runner.ts ~:3999-4000). PRE-EXISTING.
6. The module-schema-wins precedence of the hold is untested.
7. Nits: `step-context-usage.ts` ~:51 throws "invs is not iterable" under mock-DB unit runs (harmless); stale "web package has no vitest config" header in web lib/step-cli-providers.ts ~:20; `providerLabel` in provider-hold.ts shares a name with sandbox/mcp-surface.ts ~:389.

### T555 · FNF[egress-guard-hardening] · remaining egress guard gaps: local NAT64 and Teredo, probe details (+2)

status: parked · reason: diminishing returns (owner triage 2026-11-10); resume on a user report, a measured failure, or a change in the same code · kind: fix · found: T347 run · priority: P2

Three items (metadata addresses, IPv4-compatible form, required fetchFn) shipped in PR #1040 (4dceda71f), the Azure host address in PR #1041 (aa529e991) and item 7 (local NAT64, Teredo) in PR #1048 (82343cc60), 2026-11-09. Items 3 to 6 and 8 stay parked as before.

3. Hostname entries consult the hosts file only when DNS fails, so a name public in DNS but overridden in /etc/hosts dials the DNS answer (shared egress/probe-egress.ts:96,127,186,319). Accepted behaviour; revisit only on a report. NEW-LIMIT.
4. `deflate` maps to `createInflate` (probe-egress.ts:158), so a raw-deflate body fails. PRE-EXISTING (moved code).
5. The guard sends `accept-encoding: identity` by default (probe-egress.ts:219). PRE-EXISTING (low).
6. A `[::1]` host in a RAG DSN reports `ENOTFOUND [` (`dsnDialHost`, shared rag/connection.ts:119; postgres.js parses the host as `[`); still refused, only the message is wrong. PRE-EXISTING (low).
7. Shipped in PR #1048 (local NAT64 and Teredo cannot be lifted by a hostname entry).
8. (T555 run) `isUnliftableByHostname` returns false for a non-address string while the base table blocks it. Unreachable today, since resolvers return address literals. PRE-EXISTING, theoretical.
9. (T555 item 7 review) Tests only: the 'explicit entry still lifts' cases in shared test/probe-egress.test.ts ~:335-348 assert only that the code is not ENOTFOUND, so any other failure passes (house style, the link-local test beside them does the same), and no test pairs a built-in host with an answer in the tunnel ranges. NEW, minor.

### T556 · FNF[ollama-pull-relay] · pull stream relay edges

status: parked · reason: diminishing returns (owner triage 2026-11-10); resume on a user report, a measured failure, or a change in the same code · kind: fix · found: T347 run · priority: P3

1. The pull route has no `stream.onAbort` (api routes/tooling.ts, `activePulls` ~:222); a closed tab frees the upstream only through the idle and size caps. PRE-EXISTING.
2. Pull progress `status`/`digest` strings are relayed uncut (tooling.ts:370-371). PRE-EXISTING (low).
3. `armIdle` re-arms only on upstream reads (tooling.ts:279-335), so a client that stops reading for 10 minutes can trip a misleading idle stop. NEW-LIMIT (edge).
4. A late `fetchFn` resolve after an idle stop leaves its body unconsumed for a custom `fetchFn` that ignores `signal`. NEW-LIMIT (edge).

### T557 · FNF[unguarded-dial-audit] · dials that still bypass the egress guard (design) (+10)

status: open · kind: design · found: T347 run · priority: P2
Each needs a per-dial decision (guard, admin-trust, or remove).

1. Shipped in PR #1049 (provider Test connection guarded by the owner role). Correction: api routes/cli-providers.ts:664 only enqueues and cli-adapters/zai.ts only sets env for the sandboxed CLI; neither is a dial.
2. Admin-trusted by decision: Global KB external DSN (shared global-kb/connection.ts:172,177), `POST /global-kb/test-db`, vendor/module admin config. PRE-EXISTING; confirm or guard.
3. Dead SMTP keys (shared config/config.service.ts:40-44,666): defaults exist, nothing outside tests reads them. PRE-EXISTING; remove or wire.
4. `integration_provider_configs.api_base_url` is unused (database schema/integrations.ts:51); a future dial must use the guarded fetch. PRE-EXISTING.
5. Shipped in PR #1055 (caa59abf2): a non-admin's git remote (clone, refresh, bundle sync, task-step fetch/push) is resolved by the egress guard before git starts and the checked address is pinned; admin remotes unchanged. The remaining check-to-spawn window is T585.
6. Shipped in PR #1050 (a non-admin's call tests the stored settings and ignores the body; an admin keeps the typed URL).
7. Shipped in PR #1049 (the OpenRouter compat probe, same guard).
8. Shipped in PR #1054 (13db14a66): the Ollama and OpenRouter probes and the Z.AI poll read at most 64 KiB (`readBounded`, `readForgeJson`).
9. Shipped in PR #1054 (13db14a66): the Z.AI usage poll takes its transport from the shared owner-role `resolveProbeFetch` (worker cli-adapters/probe-fetch.ts).
10. (PR #1049 review) For the exempt in-stack names a non-admin sees the transport text with the container address and open port (`describeTransportError`, ollama-probe.ts ~:62-72). PRE-EXISTING, minor, narrower than before.
11. (PR #1049 review) The refused warning says "refused by the egress guard" also when a built-in host's DNS is down, and no test drives `ConfigUnavailableError` into the Ollama result. NEW, minor.
12. [parked: user decision 2026-11-10] (PR #1050 review) `POST /tooling/pull-ollama-model` with the exempt in-stack host lets any signed-in user make the shared Ollama pull an arbitrary model (api routes/tooling.ts pull stream). Whether onboarding needs this for non-admins is unverified. PRE-EXISTING, possibly consequential (disk, bandwidth); needs a decision. Non-admin callers are by design: OllamaTestButton (web components/connection-tester.tsx ~:103,147, task page step forms) and ollama-model-download.tsx ~:37 (cli-provider-form), so admin-only would break them. Resume when disk or bandwidth use is reported; fix direction then: a non-admin may pull only a model a setting or form already names.
13. (PR #1050 review) Minors: a stored Ollama URL with userinfo is returned to every role and echoed in the test message (global-kb.ts `configResponse`); the Test's `ollamaEmbed` passes no timeout, so a hung Ollama holds a non-admin page load up to 240 s (global-kb.ts, tooling.ts ~:117); the non-admin test path decrypts the external connection string only to read three fields (`resolveGlobalKbSettings`); that path's not-configured branch is unreachable with the real resolver and its spelling matrix left the shared table in probe-targets.test.ts. PRE-EXISTING or NEW, minor.
14. (PR #1054 review) Usage poll minors, all PRE-EXISTING or by decision: the poll resolves the transport (one `users` read) for every usage provider with a hand-set URL though only zai consumes it, and `Promise.allSettled` (usage-poll-queue.ts ~:443) drops a rejection with no log; the poll reads only `ANTHROPIC_BASE_URL` while the Z.AI run adapter prefers `Z_AI_API_URL` (cli-adapters/zai.ts ~:63,106), so such a provider is polled at the default origin; a `ConfigUnavailableError` from the guard's allowlist read lands as `Configuration store unavailable` row text, not the quiet retry error-diagnostics.md describes for ticks; a non-admin's public `http://` origin that redirects to https now stores `http 301` (the guard never follows redirects, by decision). Minor.
15. (item 5 follow-ups, PR #1055) Minors of the git remote owner guard, PRE-EXISTING or by design unless noted. a) (moved to T585) b) The config scan refuses for keys of any scope and of unrelated hosts (an external checkout with a corporate `http.<url>.sslverify`), and an ssh-only origin is scanned although it needs neither key family; the message says "repository's git config" even when the key is global or included (git-push.ts ~:105-118; minor UX). c) The scan's `gitRun` drops the caller's `io` (`signal`, `timeout`) (git-push.ts ~:106; minor). d) "Guarded" is signalled implicitly by a nonempty argv plus `{}` env (clone.ts ~:96, git-push.ts ~:126; hygiene). e) ssh pins only the first checked address (repo/git-remote-guard.ts ~:58; minor). f) Operator scripts `worker/scripts/advance-bundle-items.ts:52`, `reset-bundle-to-commit.ts:83` never initialise ConfigService, so the allowlist reads empty for a non-admin bundle owner (minor). g) `gitClone` still honours the worker's own global `url.*.insteadOf` / `http.<url>.*` (operator-controlled; the image has none). h) Pre-spawn re-check controls cover a fetch only: no control pins the fail-closed catch (a re-read that throws or returns an unsafe URL), an insteadOf change, the push and ls-remote paths, or the scan-before-URL order (git-push.ts ~:131-150; test gap). i) The `generic-resolve` structural control plants a name host, not the public IP literal of the finding, and one key spelling only; the shared key assertion is now case-insensitive for every kind, loosening subsection-case checks (git-remote-guard.test.ts ~:340-420; test gap).

### T585 · git transport re-reads a config the user can change (design)

status: parked · reason: accepted limit (owner triage 2026-11-10): owner accepts the residual risk; no network sandbox; resume only on a reachable exploit report · kind: design · found: T557 item 5 (PR #1055 Greptile P1) · priority: P3
`originGitRun` checks the origin URLs and the checkout's transport config, resolves and pins, re-reads both right before spawning, and git then reads `.git/config` again itself (worker repo/git-push.ts). A writer in that millisecond window defeats the guard: the repo-scope Terminal keeps a writable `.git` by design (docs/architecture/sandbox-masking.md), and `POST /repos/:id/remote` rewrites origin. No `-c` neutralizes it: a URL-scoped key or `url.*.insteadOf` written mid-run outranks or adds to command-line config, and `-c remote.origin.url=` resets the list only on git >= 2.46 (MEASURED: 2.43 appends, 2.54 resets). A full fix needs git network operations that cannot read a config the user can change during the run, or run where private addresses are unreachable (the deferred option B: a network namespace or container with deny-private egress). PRE-EXISTING class; the PR narrowed it from an attacker-controlled DNS wait to milliseconds.

### T584 · FNF[nested-repo-commit-leftovers] · nested repository edge cases left after the commit-site work (+5)

status: parked · reason: diminishing returns (owner triage 2026-11-10); resume on a user report, a measured failure, or a change in the same code · kind: fix · found: T578 review 2026-11-09 · priority: P4

1. Own change, minor. A directory name that is not UTF-8 evades the flatten refusal: callers decode the status as UTF-8 and `lstatNoFollow` then finds no such name (`_gitlink-registration.ts` `refuseFlattenedRepositories`). `fs-safe` takes string paths, and failing closed would refuse legitimate legacy names.
2. PRE-EXISTING. A merge that conflicts nowhere brings in an unregistered gitlink unchecked (`merge-resolver.ts` clean path).
3. Own change, minor. A merge-side nested repository refusal is logged only: the fixer's next round gets the same prompt and the person reads "auto-resolution exhausted" (`git-merge.ts` `completeMergeHostSide`). A gitlink under a conflict partner path (directory/file conflict) can still cost retry attempts, though the fixer did not make it; telling them apart needs MERGE_HEAD's tree.
4. Own change, minor. The DAG nothing-staged warning names the path, not the issue, and two issues sharing a path collapse to one note (`dag-executor.ts` `commitIssueWork`, `step-ownership.ts` `addStepWarning`). The warning cannot fire for edits in a gitlink directory holding no `.git`. Not run.
5. Coverage. The unregistered-gitlink branch of `completeMergeHostSide` is not reached by a test, since a directory at a conflicted path is refused earlier by the marker read. New import cycle `_gitlink-registration` to `branch-revert` to `git-merge`, uses are all inside functions. `gitCommitStaged` and the DAG commit treat a nonzero commit exit as failure even if HEAD moved (unreachable today: pre-commit checks fail first on a malformed `.gitmodules`).

### T582 · FNF[global-kb-delete-ui-followups] · small Global KB delete page gaps (+5)

status: open · kind: fix · found: T579 review 2026-11-09 · priority: P4

1. PRE-EXISTING. An admin's Cancel on another user's enrichment is dead, and so is the cancel after an admin deletes that entry: the task route scopes to the task's owner (`routes/tasks/index.ts:1304-1306`) and answers 404 while `page.tsx` ~:2119 shows Cancel and ~:1120 promises it.
2. Own change, cosmetic. After a refused delete the page shows the 403 but keeps the Delete button until a reload (`page.tsx` ~:1144); a non-admin owner also gets no explanation for a missing Delete on a lapsed or paused row.
3. PRE-EXISTING, minor. Re-scoping an entry and deleting one rewrite `supersedes_entry_id` on entries of other owners, which that actor may not change (`routes/global-kb.ts` ~:1217, ~:1324). Fix direction: decide whether link repair is exempt from the change rule, and say so in `docs/architecture/global-kb.md`.
4. Coverage. The activation target's `FOR UPDATE` row lock is not pinned by a test: the fake DB ignores it. The advisory lock serializes API writers, so no live race is known.
5. PRE-EXISTING, minor. PATCH and DELETE call `enqueueSync` after the store (and, for an admin lapse, the audit row) committed; a Redis failure there answers 500 for a change that applied (`routes/global-kb.ts` PATCH ~:1357, DELETE ~:1408). Fix direction: log and let the worker reconciler repair, as the comment already says for upserts.
6. Coverage. `smoke:house-rules-enforcement` races PATCH, DELETE and activation but asserts nothing about `audit_events` (one `global_kb.house_rule.lapse` row per lapse). From the T492 review.

### T583 · FNF[global-kb-draft-owner-blind-link] · a non-admin's draft that replaces another owner's entry needs an admin to activate

status: parked · kind: design · found: T581 review 2026-11-09 · priority: P3 · user decision 2026-11-09: leave as is; revisit when a non-admin hits it
PRE-EXISTING link, new consequence of #1044. Auto-link picks the entry a draft replaces without looking at its owner or approval (`steps/_global-kb-promote.ts`, `steps/kb-author/01-enrich.ts:673`), so a non-admin's draft can be linked over an entry they may not change. Since #1044 Activate refuses it with "Activating this entry would archive an entry you may not change; an admin is required", and only an admin can finish it. Needs a decision: leave it, let the author drop the link and publish beside the original, or skip auto-link on entries the author may not change.

### T577 · FNF[global-kb-config-untrimmed-write] · an admin's Ollama URL and embed model are stored untrimmed

status: open · kind: fix · found: T558 run 2026-11-09 · priority: P4
PRE-EXISTING, minor. `configSchema` (api routes/global-kb.ts ~:292-293) accepts `ollamaUrl`/`embedModel` with surrounding whitespace and `putConfig` writes them as sent; the non-admin compare trims, so only the stored value and its dials see the whitespace. Fix: trim in the schema.

### T580 · plan[sleep-paper-lessons] · calibrate effort estimates on the LLM's recorded estimate; keep learnings reachable past 60

status: parked · reason: diminishing returns (owner triage 2026-11-10); PR 1 shipped #1047 884f5c074; resume when step 11 changes or a repository nears 60 learnings · kind: fix · found: SLEEP paper assessment 2026-11-09 · priority: P3
Plan: `docs/plans/sleep-paper-lessons.md`. PR 1: `hydrateAnchors` and `GET /tasks/estimation-accuracy` read the latest `estimate.recorded.aiHours` instead of the column `06b-sprint-planning` overwrites. PR 2 (low urgency, when step 11 is next touched or a repository nears 60 learnings): list every learning id and title, not an unsorted first 60. Both PRE-EXISTING. P3 of the plan, the backtest, waits for its trigger query.

### T559 · FNF[gated-test-hygiene] · gated test addresses and the gated-list check in driver gates (+1)

status: parked · reason: diminishing returns (owner triage 2026-11-10); resume on a user report, a measured failure, or a change in the same code · kind: fix · found: T347 run · priority: P3

1. api test/task-integration-admission-db.test.ts is hard-wired to 127.0.0.1:45553 (or CI with localhost:5432), so a generic scratch beside the dev stack cannot run it. PRE-EXISTING.
2. `scripts/test/ci-gated-list.test.mjs` is the only definition of "gated"; add `pnpm test:scripts` to the review and feature gates whenever a test file or ci.yml changes (it caught a `pathname !==` guard the list did not recognise). Process.
3. The backwards-clock throttle control in shared test/probe-egress-log.test.ts passes on unchanged source (a guard, not a red-able test). NEW-LIMIT (hygiene).
4. AGENTS.md is 32767 of 32768 bytes and its topic index lacks api-auth.md; needs an equal cut to add it. PRE-EXISTING (docs, session).
5. worker test/upgrade-cli-addition-db.test.ts fails 7/28 against a scratch database; not in the CI gated list, so CI never runs it. PRE-EXISTING.

### T560 · FNF[postgresjs-closed-rejections] · patched postgres.js leaves unattributed CONNECTION_CLOSED rejections (third-party, needs approval)

status: parked · reason: owner left as is (owner triage 2026-11-10): third-party log noise only; resume on a user-facing effect · kind: third-party · needs approval · found: T347 run · priority: P3

1. The patched postgres.js 3.4.9 (`patches/postgres@3.4.9.patch`) still emits unattributed unhandled `CONNECTION_CLOSED` rejections. Extend the patch or report upstream. PRE-EXISTING.
2. worker package.json has no `postgres` dependency (the guarded DSN host goes through shared `dsnDialHost`); adding it changes the lockfile and needs `pnpm docker rebuild`. PRE-EXISTING.

### T561 · FNF[npm-cache-hardening] · shared npm cache base: pruning, retries, races, warm input

status: open · kind: fix · found: T354 run · priority: P3

1. Seed warning says "empty private cache" but a partial copy is not empty (worker sandbox/npm-cache.ts:51). NEW-LIMIT (wording).
2. The read-only base is never pruned; seed time grows with it (0.36 s at 47 MB). PRE-EXISTING.
3. A failed align or wipe retries only at the next worker boot (npm-cache.ts:87-125). PRE-EXISTING.
4. Two workers booting together could race the one-time wipe; a seed can race a concurrent warm. PRE-EXISTING (latent).
5. `warmNpmPackage` accepts any spec (npm-cache.ts:184-214); warm runs without `--prefer-offline` (mcp-config.ts:257). PRE-EXISTING.
6. `purgeNpxTrees` leaves corrupt `_cacache` blobs (npm-cache.ts:149-172). PRE-EXISTING.
7. Other npx/npm users not reviewed for the same shared-cache rule: 08b-test-management, 06a-db-migrate, _test-env-guard, ddev-playwright, resolvers, codex-app-server-probe.ts:322, 01b-install-plugins.ts:286, cli-versions/codegen.ts. Audit.

### T562 · FNF[tooling-version-pins] · stored tooling version pins are not revalidated at their sinks

status: open · kind: fix · found: T354 run · priority: P3

1. Stored `chrome_devtools_mcp_version` rows written before the PATCH validation reach `npx` and Dockerfile `RUN` sinks unchecked: exec-core.ts:543, mcp-config.ts:295, env-replicate/01-declare-deps.ts:847, 02-generate-dockerfile.ts:800-801. Fix: call `normalizeChromeDevtoolsMcpVersion` at each sink (or one reader). PRE-EXISTING.
2. Upgrade-apply writes the feed's `latest` unchecked (tooling-upgrades.ts:127). PRE-EXISTING.
3. `rtk-version` validation is loose (settings.ts:236, tooling-upgrades.ts:843). PRE-EXISTING.

### T563 · FNF[custom-tool-start-gate] · start gate leftovers from the T346 build (+1)

status: open · kind: fix · found: T346 run · priority: P3

1. The Start gate does not check `CONFIG_ENCRYPTION_KEY`, which the runner does (worker step-runner.ts:621; api lib/custom-tools-start-check.ts:43-50). PRE-EXISTING scope gap.
2. The refusal names only the first failing step, in string-id order rather than run order (custom-tools-start-check.ts:19-21, 30-42). Cosmetic.
3. An unparseable or over-cap tool hides problems of the step's other tools; a step whose non-tool fields do not parse is dropped by `parsePinnedCustomSteps` (shared modularity/prompt-steps.ts:125-136), so Start passes. Same as the runner; hand-edited JSON only. PRE-EXISTING.
4. The Start gate does not check an unparseable template (only dispatch does, prompt-step.ts:72).
5. A gone task type row reads `requiresRepository: true` (custom-tools-start-check.ts:28, pinned-tools.ts). Verify whether such a task can exist.
6. A broken tool in a step the user would skip still blocks Start (inherent to all-required).
7. Refusal copy says "start the task" / "create a new task" on a full-Retry refusal too; the switch refusal text is duplicated in api and worker (custom-tools-start-check.ts:39, 47; step-runner.ts:616-619; resolvers.ts:283; custom-mcp.ts:195). Copy only.
8. The admin PUT `saveConfig` tuple carries its own default `true` (api routes/admin.ts:1673). PRE-EXISTING.
9. `start-entry-points.test.ts` catches only known writer shapes of `status = 'queued'`, not raw SQL.
10. [verify-first] Can an admin type reuse a builtin slug and carry `custom_steps` on plan, kb or upgrade tasks (task-types.ts:246, 272)? The plan-link refusal (spawn-plan-task.ts:71) is code-read only.
11. A CLI that prints a line exactly `haive-mcp: add X failed` is listed as a failed server (worker sandbox/task-auth-volume.ts ~1098-1105). Diagnostic text only.
12. The admin "Custom tools" card still says "Off: a step that declares tools fails with a clear reason" (web app/(app)/admin/page.tsx:2651-2653); since T346, Start (and full Retry) is refused first. Copy only; found in the T346 browser check.

### T564 · per-tool optional flag for custom tools (design)

status: open · kind: design · found: T346 run · priority: P4
Custom tools have no required/optional flag, so the Start gate treats every declared tool as required (user decision 2026-11-08). An `optional?: boolean` per tool, modelled on integration requirements (prompt-steps.ts:57), would need the schema, a tool-editor control, a dispatch rule that drops an unusable optional tool (and what the agent is told when its template names it), a `custom_tool.unusable` task event at Start, and docs. Resume when a task type needs a tool it can run without.

### T565 · FNF[module-runtime-report-gaps] · worker module report misses a few runtime transitions (+2)

status: parked · reason: diminishing returns (owner triage 2026-11-10); resume on a user report, a measured failure, or a change in the same code · kind: fix · found: T350 run 2026-11-08 · priority: P4
PRE-EXISTING limits of the per-module `runtime` in the worker report (`haive:modules:loaded:worker`), all minor.

1. A module held back at boot (deactivated, or its schema ensure outlived the boot wait) is skipped by `runtimes()` (worker modules/loader.ts ~:431, index.ts ~:288-293), so the report has no `runtime` for it until the first pass (15 s at most).
2. A start that fails after boot went on without it sets only `pending` and a log (loader.ts ~:551-558): no `failures` entry, so the report reads pending with reason null until the first pass tries, and that try is not one of the 3 attempts.
3. The report is rewritten only on a runtime-signature change or after a failed write (loader.ts ~:745-767): a lost Redis key (flush, restart without data) stays lost until the next boot or runtime change, and `/admin/modules` loses the worker half meanwhile. Fix direction: rewrite on each pass when the key is absent, or a periodic refresh.

### T566 · FNF[worker-redis-bound] · the worker's shared Redis client is unbounded

status: open · kind: fix · found: T549 run 2026-11-08 · priority: P3
PRE-EXISTING. T549 bounded the api's `getRedis()`; the worker's (worker src/redis.ts) still has no command deadline and keeps an offline queue: 44 call sites in 16 files under packages/worker/src, not classified. Consequential if any of them decides a gate during an outage. Classify each (gate, best-effort, blocking reader, subscriber) the way T549 split the api into `getRedis()` and `getPatientRedis()`; raw Redis commands, not config reads, so not T546. (T546 run) LOADING makes raw `getRedis()` commands wait in the offline queue: gate-1 `reserveAgentSlot` (queues/cli-exec/agent-lease.ts ~:129, caught at handlers.ts ~:1391 "agent-lane reserve failed; allowing job") and the slot heartbeat, which bounds what the T546 defer retry can protect.

### T567 · FNF[api-redis-shutdown] · api shutdown never closes its Redis clients

status: parked · reason: diminishing returns (owner triage 2026-11-10); resume on a user report, a measured failure, or a change in the same code · kind: fix · found: T549 run 2026-11-08 · priority: P4
PRE-EXISTING. `closeRedis` (api src/redis.ts ~:101) has no production caller and the api has no SIGTERM or SIGINT handler, so shutdown never quits the three clients. `quit()` on a silent patient or bull client can wait forever; `closeRedis` falls back to `disconnect()` only for a non-ready client or a rejected `quit()`. (T544 run) The api also runs node as PID 1 without `init: true` (api Dockerfile ~:90; the worker has it), so `docker stop` waits out the grace period, now also during T544's boot retry wait.

### T568 · FNF[terminal-open-late-replay] · a shell open request can reach the worker after its reply timeout (+1)

status: parked · reason: diminishing returns (owner triage 2026-11-10); resume on a user report, a measured failure, or a change in the same code · kind: fix · found: T549 run 2026-11-08 · priority: P4
PRE-EXISTING. terminal-shell.ts `openSession` (api routes ~:439-476) publishes the open request on the patient client, whose offline queue can deliver it after the 15 s `OPEN_REPLY_TIMEOUT_MS` (~:35) and the session's cleanup, so the worker may open a session nobody waits for.

1. PRE-EXISTING (since ff4927bb6), seen in the T549 live check 2026-11-09 with Redis up. When the WebSocket closes during the open window (React StrictMode double-mount on every dev load, or a reload or tab close), `runShellSession` quits the reply subscriber (api terminal-shell.ts ~:186-200, logged "shell ws closed before refcount acquired" then "open-session request failed: worker did not reply within timeout" 15 s later), yet the worker still opens the PTY (`tmux new-session -A`) and replies to nobody (worker terminal-session-manager.ts ~:181-187). Nobody sends `close` for that sessionId, so the PTY and its `terminal:out:<sid>` publishing live until the container reap (~2 min after the last tab): 8 sessions torn down by `pty-end` at one reap. Bounded, but each dead tmux client stays attached while a tab keeps the container up. Fix direction: when the open resolves after the socket is gone (or after the timeout), publish `{op:'close', sessionId}`; the same closes the late-replay case above.

### T569 · FNF[configservice-wedged-connection] · ConfigService never recycles a wedged connection

status: open · kind: fix · found: T544 run 2026-11-08 · priority: P4
PRE-EXISTING. shared config.service.ts `CONFIG_REDIS_OPTIONS` (~:785) and `redisCall` (~:1068): after repeated 2 s command timeouts on a socket that stays open but loses bytes, ioredis keeps the timed-out commands queued and reply pairing can desync until the socket is destroyed. A drop, a restart-like drop and `docker pause` recover on the same client; only the lossy black-hole does not, and T544's boot retry then waits as long as it lasts. Related T548.

### T571 · FNF[global-kb-boot-store-stall] · worker boot waits forever on a stalled global KB store

status: open · kind: design · found: T544 run 2026-11-08 · priority: P3
PRE-EXISTING. shared global-kb/client.ts `withGlobalKb` (~:121) via `recomputeAliasedTopicKeys` (worker data-migrations.ts ~:134, ~:599, ungated, every boot): a store that accepts and then stalls, or a held schema advisory lock, has no deadline. A plain `deadlineMs` skips the shared schema ensure (global-kb.md, "A call with a deadline never starts the shared schema ensure"), so it needs its own design. (T546 run) Same class: `dropHeadingOnlyGlobalKbChunks` (worker data-migrations.ts ~:1079, destructive, updater-only, documented best-effort) swallows a typed outage internally.

### T572 · FNF[boot-failure-dead-watcher] · a Postgres outage past 30 s at boot still exits

status: open · kind: fix · found: T544 run 2026-11-08 · priority: P4
PRE-EXISTING. database wait-for-ready.ts ~:75-76 (called from api and worker bootstrap.ts) throws a plain error after its 30 s budget and `main().catch` exits 1 (api index.ts ~:167-169, worker index.ts ~:385-387): a dead `tsx watch` app in dev, a crash loop in production. T544 retries only `ConfigUnavailableError`. The worker's post-bootstrap awaits on its offline-queue Redis and BullMQ connections (worker index.ts ~:88-246) also wait silently during an outage; worker half beside T566.

### T573 · FNF[redis-client-error-listeners] · Redis clients without an 'error' listener spam stderr

status: parked · reason: diminishing returns (owner triage 2026-11-10); resume on a user report, a measured failure, or a change in the same code · kind: fix · found: T544 run 2026-11-08 · priority: P4
PRE-EXISTING. No `'error'` listener on the api's patient and bull clients (api redis.ts ~:68, ~:71; shared utils/redis-factory.ts ~:18, ~:29 attach none) or the worker's two clients (worker redis.ts ~:11, ~:14): ioredis prints "[ioredis] Unhandled error event" per reconnect, 16 lines per 12-14 s outage. Log noise only. Api half beside T567, worker half beside T566. (T546 run) A BullMQ Worker emits a flood of 'error' events during a LOADING reply (17 in a real restart, ~31k in 8 s through a fault proxy); the log side belongs here, any BullMQ-side change needs approval.

### T574 · FNF[step-failure-outage-hint] · a step that fails on a config store outage looks like a code defect

status: parked · reason: diminishing returns (owner triage 2026-11-10); resume on a user report, a measured failure, or a change in the same code · kind: design · found: T546 run 2026-11-08 · priority: P3
PRE-EXISTING, accepted by T355. A step that meets a typed `ConfigUnavailableError` fails fast through `rethrowIfConfigUnavailable` (worker step-engine/step-runner.ts ~:462, ~:554, ~:5167, ~:5227) and ends as a plain failure with Retry; the UI cannot tell it from a code defect. Needs a structured outage hint (shared type plus web copy; overlaps T551), or a short retry inside the bound if T548 chooses one.

### T575 · FNF[worker-queue-add-unbounded] · a failed step's watch-arm enqueue waits out a Redis outage

status: parked · reason: diminishing returns (owner triage 2026-11-10); folded into the T566 bounded check; resume on a user report, a measured failure, or a change in the same code · kind: fix · found: T546 run 2026-11-08 · priority: P3
PRE-EXISTING, unmeasured. `recordFailedStepHint` awaits `enqueueUsagePollTick()` (worker task-queue.ts ~:1905, ~:1907, ~:1922) on the BullMQ connection, which queues through a transport outage, so `finishFailedStep`'s remaining writes wait for the store. The api side is bounded (`queue-bounded.ts`); the worker has no equivalent. Related T566.

### T576 · FNF[agent-reserve-stale-held-marker] · the reserve's held marker survives a fail-open defer

status: open · kind: fix · found: T546 run 2026-11-08 · priority: P4
PRE-EXISTING. `markHeld` (worker queues/cli-exec/agent-reserve.ts ~:133, set ~:414) is not cleared when "agent reserve defer failed; allowing job" falls open (~:346, ~:431); only its TTL prunes it. Also trivial while there: the header comment ~:35 still says "fail-open on everything", and handlers.ts ~:1317-1341 holds an orphaned pause-gate doc block above the `LIGHT_JOB_LANE` doc.

### T532 · D4b · registry-kind install sources cannot be fetched (design)

status: open · kind: design · user decision: resolved 2026-11-05 · found: T337 run 2 · priority: P3
`@haive-module/<id>` registry packages ship `dist` only, while the own-module builder rebuilds from sources, so T337 refuses registry fetch with 409 `registry_fetch_unsupported` (api modules/sources.ts ~:174). Options: publish sources in the package (a `files` change in the packaging script), teach the builder to accept prebuilt dist packages, or drop the registry kind from the form.

User decision 2026-11-05: Drop the registry kind (form, api, schema); git sources cover the need. Re-add it only when a customer asks.

### T342 · FNF[mcp-token-file] · rag/ddev task tokens in the server env defeat the cli-merge skip (measure first) (+4)

status: parked · kind: design · was modular #146 · reason: diminishing returns (2026-11-01 scan): Bundle concerns merge efficiency, stale wiring, helper cleanup, and orphan-directory hygiene; resume when resume when measured overhead or stale wiring disrupts invocations · priority: P4

1. The rag and ddev tokens carry a per-second exp inside their MCP server env (worker orchestrator/mcp-surface.ts:108, :186), so the codex/grok/gemini merge key (task-auth-volume.ts:889-905) changes on every invocation. Measure first, then move the tokens to the token file.
2. The step-summary pass skips MCP wiring, so the auth volume keeps listing per-run servers until the next wiring.
3. The cli-merge helper's marker write does not reach its exit status.
4. The rag and ddev routes parse the bearer header by hand; use the shared parse in lib/task-call-auth.ts.
5. Per-run `<uuid>` dirs in the wrappers volume are removed only by runInSandbox's finally. Add a boot or periodic sweep.

### T343 · FNF[a11y-sweep] · links wrap buttons at 17 sites; sidebar rename input sits inside a button; plan panel close and tabs lack names (+12)

status: open · was modular #151 · priority: P2
All PRE-EXISTING unless marked.

1. Base items:
   - links wrap buttons at 17 sites;
   - the sidebar rename input sits inside a button;
   - the plan panel's close button and tabs lack names and state.
2. web-kit tabs.tsx TabNav sets no aria-current on the active tab.
3. Three overlays bypass the shared Dialog: cli-auth-banner-modal.tsx:445, tasks/[id]/page.tsx:2308 ("Login successful"), and task-history.tsx:289.
4. A dialog opened from an ActionMenu row loses its opener, so focus goes to BODY.
5. A nested Dialog mounted in the same commit as its parent paints under it. Fix: z-index by depth.
6. In a none-checked radio group, Tab can leave the trap. Fix: a focusin guard.
7. 13 web tests fake React hooks by hand. Fix: use real React or one shared helper.
8. An overflowing scroll region (code-preview-dialog.tsx ~:156) is not keyboard-scrollable. Fix: tabIndex={0} plus a name.
9. A positive tabindex escapes the trap.
10. REGRESSION from #774 (rare): an opener that a keyed reorder moves reads as body.
11. The sidebar labels a `created` task "queued" (lib/task-tone.ts:69). Fix: "not started".
12. plan-starter.tsx inputs (~:316, :399, :509) rely on placeholders as names, and the state and progress text sits outside a live region.
13. (T454 review, 2026-10-31) PRE-EXISTING, minor, by code reading: the GitHub repo picker on /repos/new is not keyboard-operable and lacks combobox semantics (web components/new-repo-form.tsx ~:317, ~:325-327, ~:339); its blur timer closes the list 150 ms after Tab.

### T344 · FNF[task-type-e2e] · task-type e2e specs need no instance-wide switch flip and cover the unsaved-changes guard (+2)

status: parked · reason: diminishing returns · user confirmed routine coverage stays parked, 2026-11-01 · priority: P4

1. tests/e2e/tasks/new-task-type.spec.ts flips the instance-wide custom-types switch. Use a fixture that does not need it.
2. Add a Playwright spec for the task-type editor's unsaved-changes guard: dirty, then a link click, then the dialog; cover Keep, Discard and Escape, and that Discard through a sidebar task keeps its Back origin.
3. worker test/prompt-step-smoke.sh has no package script and is not in CI. Wire it like smoke:type-draft.
4. No e2e covers a call-only task panel (loggedCallCount → showsToolUsage in tasks/[id]/page.tsx).

Resume the isolated member when a current required validation gate fails, when this same task-type flow changes, or when a supported behavior lacks a decisive control. Do not launch an independent four-item coverage project without that trigger.

### T345 · FNF[admin-stop-surfaces] · best-effort kills, kill-after-stop error paths, stop error text, left-task kill, urgent loop deadline, created sandboxes, 50-stop cap, statistics links, duplicate title components

status: open · was modular #158 · gate: bounded verification · priority: P2
Items 1-2 merged (#816). All PRE-EXISTING. 3. killTaskSandboxes (api lib/sandbox-kill.ts) is best-effort. Stop (lib/task-control.ts ~:40) and the retry, resume, skip and CLI-switch paths in steps.ts report a clean count when docker is unreachable. 4. maintenance.ts `stop` and POST /:id/cancel-active-cli commit the stop and then kill. A kill that throws answers 500 and skips the event and the audit row. 5. activation.ts errorText shows drizzle's "Failed query ..." text; err.cause is dropped. 6. activation.ts kills sandboxes for a `left` dependent and drops that kill's error. 7. The urgent loop awaits one stopTask per dependent, each with up to 13 s of deadlines, up to the 200 cap. 8. The api lists sandboxes with `docker ps -q` (running only), so a sandbox that was created but not started is missed. 9. STOP_EVENTS_READ = 50 (lib/task-stop.ts ~:20) loses a task's reason after 50 or more stops. Fix: pick it in SQL by failedAt = completedAt. 10. The statistics pages link /tasks/<id> without an owner check (latent). 11. The owner-only title rule lives in two components; share one TaskTitleLink.

Execution fence 2026-11-01: Prioritize current Stop/kill correctness in3/4/7/8 only when reproduced. Error wording, statistics links and duplicate title components do not automatically join that fix.

From the T393 build (2026-11-07):

12. REGRESSION, accepted and bounded: urgent deactivation (api modules/activation.ts ~:217) waits up to 2 s per task serially for `enqueueStopSettle` while Redis is down. Fix direction: queue the settlements after the loop, or in parallel under one deadline.
13. PRE-EXISTING: maintenance.ts ~:395 and activation.ts ~:234 write `task.stopped` only when a run ended or a step failed, and the owner's `cancel-active-cli` route writes none. Fix direction: one event rule for all three Stop producers.

### T358 · J6e · provider-pinned requirements (pin table, grants.provider_id, resolver tiers, drop the dispatch refusal)

status: parked: deferred until the first module that pins a provider · was modular #189 · priority: P4

Decision reconciliation 2026-11-01: Remain deliberately deferred until a real module needs provider pinning; do not invent a consumer to unblock this infrastructure work.

### T364 · FNF[test-coverage-gaps] · optional coverage controls after correctness and test-hygiene splits

status: parked · reason: diminishing returns · user confirmed routine coverage stays parked, 2026-11-01 · priority: P4

1. MOVED to T528 for bounded verification of a concrete false-green case; not generic coverage work.
2. task-create-path.test.ts has no case where the type is refused inside the create transaction.
3. No real-store test covers withVectorWidthLock (api global-kb.ts ~:298).
4. No gated audit test asserts the pino audit line is absent on a refusal and present once on success. The device-poll and /github-oauth/poll routes lack refused-audit tests.
5. The "Stop lands inside an ADVANCE or START pass" windows are covered only by an uncommitted script. Promote it to a gated smoke.
6. GET /usage-window has no route test, and the fake DB has no innerJoin.
7. Two flush and sweep test files use fake-DB Proxy workarounds, and K5/M11c count git reads. Replace both with behaviour assertions.
8. MOVED to parked T513 (test environment/hygiene); re-open only when blocking dependable validation.
9. PRE-EXISTING: a gate row healed by 0210 with no saved schema (the old per-step switch nulls formSchema, steps.ts:1855) has no real-worker check, only the SQL test. Also 0210.sql:14 sets pause_form_on_retry on no-schema rows too, which costs one extra stop at that step's form; narrow it to `pause_form_on_retry OR form_schema IS NOT NULL` if wanted. From #263 (PR #887).
10. From the T407 review (2026-10-24), PRE-EXISTING, minor: no runner-level test pins that `applyArgs.llmInvocationId` is the run that produced `llmOutput` for a post-form LLM step (worker step-runner.ts ~:3148, ~:3231; only the preForm path is pinned, step-runner-auto-continue.test.ts ~:296-339). Plan chat attribution, 07b, 08c2, 07_7 and prompt steps rest on it.
11. Same source, minor: the "no agents directory" branch (provider amp) has no test: the `_active-agents-target.ts` null return, 07_5-verify-files.ts ~:57-64, 11-final-review.ts ~:86-93, `collectReviewFindings(repo, null)`.
12. (T378 review) PRE-EXISTING, minor: `useDeviceSignIn` has no test of its own; the attempt counter, the unmount bump (web lib/use-device-sign-in.ts ~:25-30) and its `live()` guards are exercised only through `runDeviceSignIn` with an injected `live`.
13. MOVED to T528 for bounded verification of a concrete false-green case; not generic coverage work.
14. MOVED to T528 for bounded verification of a concrete false-green case; not generic coverage work.
15. (T363 review) PRE-EXISTING, minor: no e2e spec creates a task with attachments or presses Start on a created task (the only Start click is Run app, tests/e2e/tasks/new-task-type.spec.ts ~:232), so the attachments confirm flow is checked by hand only.
16. FIXED by PR #941 (f07e4ecec, 2026-10-30: the capacity test has its own 120 s bound). (T431 review, 2026-10-30) PRE-EXISTING, moderate: worker test/upload-reaper.test.ts ~:1412 (T323 "keeps remembered failures at capacity across repeated passes", 1001 sequential orphan files) times out at the 20 s test timeout in a full worker-package run, and its leftover fails the next test (~:1444, expected 2, got 3). Red at base 0a7b8d405 in 3 of 3 local full runs; passes alone (238/238); CI's unit job is green. Give it its own timeout or a smaller fixture, and isolate its state from the next test.
17. MOVED to parked T513 (test environment/hygiene); re-open only when blocking dependable validation.
18. MOVED to parked T513 (test environment/hygiene); re-open only when blocking dependable validation.
19. MOVED to parked T513 (test environment/hygiene); re-open only when blocking dependable validation.
20. (T429 review, 2026-10-30) PRE-EXISTING, minor: nothing enforces that `allowFileTransport` is the one opt-in of the default `protocol.file.allow=never`: a caller's own later `-c protocol.file.allow=always`, or a `GIT_ALLOW_PROTOCOL` that lists `file` in a production source, lifts it silently (shared git-args.ts ~:130-132 passes the caller's argv verbatim; the env takes precedence, MEASURED). Production has none (only git-push.ts ~:147,155 set `http:https:ssh`). Pin it with a source-scan guard like git-exec-guard.test.ts.
21. MOVED to parked T513 (test environment/hygiene); re-open only when blocking dependable validation.
22. MOVED to parked T513 (test environment/hygiene); re-open only when blocking dependable validation.
23. MOVED to parked T513 (test environment/hygiene); re-open only when blocking dependable validation.
24. (T349 review, 2026-10-31) PRE-EXISTING, minor: of the four step actions that write the clicked row before they move the task (loop Resume, `retry_ai`, the CLI switch, Skip), only Skip has a committed lock-order control; no case tells `cancelStillOpen` locking every row of the task from locking only the open ones; and the cancel route's control (K7) now passes from the Stop batch alone, so the step abort's (K8) is the only one that pins `cancelStillOpen`.
25. (T445 review, 2026-10-31) PRE-EXISTING, minor: since T445 the node-free guard fails on Node globals read as values, but it covers only the project-state subpath the web imports; shared naming/index.ts ~:63 (`process.env` as a default parameter) and forge/bitbucket-cloud.ts ~:33 (`Buffer.from`) are unguarded. The web never calls them today. Extend the guard to every shared subpath the web bundles.
26. (T455 review, 2026-10-31) PRE-EXISTING, hardening: nothing enforces T455's `requireJsonObject` guard, so a new `(await c.req.json()) as {...}` in an api route brings the `null`-body 500 back. A ratchet test over api routes (as `fs-ratchet.test.ts` does for path-based fs calls) would catch it; it should also cover WebSocket `message` listeners that read a field off a parsed frame (the CLI login banner's was one, fixed by T463).
27. MOVED to parked T513 (test environment/hygiene); re-open only when blocking dependable validation.
28. (T461 review, 2026-10-31) PRE-EXISTING, minor: no test covers the 404 the per-step CLI switch answers for a step row that vanished (api routes/tasks/steps.ts ~:1914).
29. (T458 review, 2026-10-31) PRE-EXISTING, minor: no cancel-route case (api plan-merge-cancel-db.test.ts, task-cancel-guard-db.test.ts) for a `waiting_user` merge or task; packages/api/test/task-cancel-lock-order-db.test.ts ~:67-70 still describes the pre-T349 bulk UPDATE in the present tense.
30. (T459 review, 2026-10-31) PRE-EXISTING, minor: no route-level late-sweep control for loop Resume, `retry_ai`, Skip, the CLI switch or the fan-out Resume (only the Retry route has one); no control for the second sweeps or for the fan-out Resume with downstream rows; the hand-rolled unit fakes absorb the new lock selects and cannot see their removal (the gated controls do).
31. MOVED to parked T513 (test environment/hygiene); re-open only when blocking dependable validation.

Reconciliation: T528 owns the potentially false-green members; T513 owns environment/fixture flakes. Item16 was already fixed by PR #941. Remaining coverage-only members are not an authorized blanket testing project.

### T366 · FNF[shutdown-deadline] · the worker shutdown's per-part limits are summed by hand

status: parked · kind: design · was modular #219 · reason: diminishing returns (2026-11-01 scan): Internal shutdown-budget refactoring; no demonstrated deadline failure; resume when resume when measured shutdown exceeds Docker's grace period · priority: P4
worker index.ts runShutdown budgets each part separately against Docker's 10 s grace.
Fix: one deadline object that hands each part the time left, plus a test that sums the budgets.

### T367 · FNF[tool-usage-cancel-signal] · a run cancelled in flight never moves the tool usage panel's refresh signal

status: parked · kind: design · was modular #222 · reason: diminishing returns (2026-11-01 scan): Minor usage-panel refresh issue; current behavior still needs verification; resume when resume when cancellation demonstrably leaves the usage panel stale · priority: P4
A cancel writes ended_at and superseded_at together, so the run never joins the rollup.
Fix direction: the revision also hashes the in-flight ids. Re-verify against main first (#830 changed the rollup).

### T368 · FNF[grok-usage-gap][verify-first] · grok runs report fewer prompt tokens than their tool results (+2)

status: parked · was modular #231 · reason: diminishing returns (2026-11-01 scan): Token discrepancy is unexplained; several hypotheses remain unmeasured; resume when resume when recorder evidence establishes incorrect reported usage · priority: P4
In 9 grok runs, tool-result chars/4 come to 1.14-2.25x the recorded prompt tokens; e.g. run e3d08fb4… (09-qa).
Candidates:

- usage under-reports;
- chars/4 overstates;
- grok drops old tool results.
  Measure with the CLI context-capture recorder before any code.

1. The killed-run fallback dedupes by message.id; check whether grok reuses ids across messages.
2. grok reports no context window; the 256k table entry is one old measurement.

### T369 · FNF[usage-fallback-verify] · ollama/antigravity live usage fallbacks unverified; zai/muse killed runs store zero usage (+7)

status: open · was modular #237 · gate: bounded verification · priority: P2

1. ollama puts message_start values on assistant events, so a killed run under-reports output.
2. Whether antigravity's running usage is per-step or cumulative is unmeasured.
3. The killed-run fallback stores zero usage for zai and muse. Fix: all-zero means null.
4. amp's multi-turn semantics are unmeasured.
5. MODERATE, fix first: a steered claude run keeps only the last result's usage next to a cumulative cost (worker cli-exec/stream.ts ~:241). Fix: sum per result.
6. gemini and antigravity could prove a single request, but nothing reads it (usage-extract.ts ~:120). sumTokenUsage treats a missing peak as 0.
7. amp's `usage.max_tokens` (272k) may be its context window. Measure.
8. ollama's per-message prompt and result prompt disagree (display only).

Execution fence 2026-11-01: Check the current steered-run usage/cost contract first; only a supported incorrect total justifies the fix. Unmeasured provider semantics, table guesses and display-only discrepancies remain measurement-gated.

### T371 · FNF[docker-spawn-dedup] · twelve hand-rolled docker spawn helpers re-implement collect, deadline and kill (+1)

status: parked · kind: design · was modular #240 · reason: diminishing returns (2026-11-01 scan): Helper consolidation and consistent timeout contracts lack a demonstrated user-facing failure; resume when resume when divergent helpers cause an observed runtime failure · priority: P4
Sites:

- worker task-queue.ts:1225, :1245;
- composed-image-reaper.ts:89;
- cli-container-reaper.ts:103, :140;
- sandbox-kill.ts:9, :71;
- sandbox-image-reaper.ts:32;
- auth-volume-reaper.ts:52;
- egress-gateway.ts:165;
- api maintenance.ts:555;
- api lib/sandbox-kill.ts:78.
  On a timeout they return different things: partial stdout, [], null, or "timed out".
  Fix: one shared runDockerCommand(args, {timeoutMs}) returning {stdout, stderr, exit, timedOut}, plus a test that kills a hung child.

### T373 · FNF[audit-strict-admin-actions] · strict-audit leftovers after #1058/#1059 (+9)

status: open · was modular #246 · priority: P3 · sites + items 1-4 shipped in PR #1058 (1f1064268); items 5-7 shipped in PR #1059 (8a56956d9), 2026-11-10

8. `PATCH /cli-providers/:id` leaves `enabled` and `model` unaudited (api cli-providers.ts ~:548). PRE-EXISTING, minor. From the #1058 review.
9. A PATCH on a draining module writes two `module.deactivate` rows for one request: `setModuleActive` (activation.ts ~:120-126) and the loader (loader.ts ~:354). PRE-EXISTING, minor.
10. `POST /cli-providers/:id/sandbox-image/build` (cli-providers.ts ~:666-700) queues a rebuild with no row. PRE-EXISTING, minor (no security state changes).
11. `module.settings` save holds a pooled connection and an advisory lock across Redis reads and writes (loader.ts ~:597-655). PRE-EXISTING, minor to moderate; its row must still roll back with the savepoint.
12. `cli_provider.create` metadata lists fields the request sent, not fields it set to a non-empty value. New in #1058, minor.
13. The launch-compensation block (row committed first, effect, delete by id on failure) is copied three times (maintenance.ts upgrade, loader.ts teardown, cli-providers.ts sign-out) and logs through the root logger; one helper would do. New in #1058, minor.
14. Stale test names in the #1058 tests still describe the old bounded-enqueue behaviour; no gated PG test covers the upgrade's compensating delete. Minor, coverage.
15. A launch row is visible on /admin/audit while its effect runs and vanishes if the effect fails (routes/admin.ts ~:192-275); release.md ~:157 and modules.md ~:28 document the lost-reply case (lost Redis reply, docker 300 s kill), where the effect can run with its row deleted. By design, minor.
16. The strict module rows written by shared `modularity-server/module-drain.ts` (`audit()` ~:171-176: `module.drain` ~:192, graceful `module.deactivate` ~:218, `module.drain_cancel` ~:253; callers loader.ts DELETE `/:id/drain` ~:303, graceful PATCH ~:314-335, the `finalizeModuleDrains` sweep) log no pino line after commit, while the same actions from activation.ts now do. PRE-EXISTING, minor. From the item 5-7 review.

### T379 · FNF[git-tree-readers] · gitlink readers and literal-pathspec helpers duplicated with different failure contracts (+5)

status: parked · was modular #257 · reason: diminishing returns (2026-11-01 scan): Reader duplication and contract cleanup have no concrete consequence established in this entry; resume when resume when a reader failure demonstrates lost or incorrect state · priority: P4

1. Readers in set-aside.ts:168-184 and :1066-1078, _commit-diff.ts:97-128, merge-prior.ts:50-69 and projection-merge.ts:129. The `:(literal)` helper is copied 4 times.
2. A duplicate runGit exists in advance-bundle-items.ts and reset-bundle-to-commit.ts.
3. set-aside.ts ~:250 headOid, ~:1113 headEntry and projection-merge.ts ~:32 readBlob count a failed read as absent.
4. git-merge.ts ~:632, :636, :1356, :1373, :1419: resolvingPaths and `rev-list --parents` failures.
5. (T375 review) _commit-diff.ts checkedOutCommit ~:133-161 is one more gitlink reader with its own failure contract.
6. (T425 run, 2026-11-09) worker `_gitlink-registration.ts` is one more gitlink and index reader, fail-closed.
   Fix: one shared reader module with an explicit failure contract. Do this after T396.

User reconciliation 2026-11-01: helper/read-contract consolidation (members1/2/5) stays parked. Failed-read members3/4 transfer to T495 correctness verification and must be deduplicated against its members4/5/6/7/8 and the completed T397 work; no second refactoring batch.

### T386 · FNF[upgrade-early-death-hold] · an upgrade that dies before recording its found state restores normal and lifts an admin's hold

status: open · kind: fix · user decision: resolved 2026-11-01 · priority: P2
A run that dies between startRun (updater cli.ts ~:161) and recordFoundState (run.ts ~:181) has no metadata.foundState, so a later restore writes `normal`.
Needs a marker that tells an older updater's run apart from a new run that died early.

User decision 2026-11-01: Keep maintenance/hold on unknown prior state; report uncertainty instead of silently restoring normal

### T389 · FNF[repo-loose-objects] · Haive's git no longer triggers auto-maintenance (#256), so busy repos accumulate loose objects

status: parked · kind: design · was modular #270 · reason: diminishing returns (2026-11-01 scan): Loose-object growth is unmeasured; no current operational impact established; resume when resume when measured repository growth warrants safe maintenance · priority: P4
`maintenance.auto=false` closes gc.recentObjectsHook. An explicit gc still runs that hook.
Measure growth, then find a safe repack/prune under hardened args.

### T392 · FNF[start-check-provider] · the persona start check names only the first dispatch candidate (+1)

status: open · kind: fix · found: T392 driver 2026-11-06 · priority: P4

1. `providerNameFor` in the persona start check (packages/worker/src/queues/task-queue.ts ~:2737) takes the first `dispatchCandidates(...)` entry. It ignores subagent and MCP eligibility, and since PR #1025 also a first implicit candidate that fails to build while dispatch lands on the next one. Advisory only (records an unresolved-persona event). PRE-EXISTING. Fix direction: resolve the provider through `resolveDispatch` or share its candidate filter.
2. `resolveTaskDispatch` calls `resolveDispatch` a second time with the codex extras (packages/worker/src/orchestrator/dispatcher.ts ~:436), so the new "provider could not build a command" warning logs twice per dispatch for the same implicit candidate. REGRESSION (log volume only). Fix direction: warn only on the outer call, or dedupe by provider id.

### T394 · FNF[stop-noop-missing-current] · Stop still answers 0 when the current row is missing, finished, or an unparked answered form

status: parked · kind: design · was modular #276 · reason: diminishing returns (2026-11-01 scan): Stop behavior concerns exceptional missing, finished, or already-answered current rows; resume when resume when these shapes obstruct a real Stop request · priority: P4
See worker task-queue.ts ~:1806-1813, ~:356. Decide per shape: fail the task, or answer a named 409.

### T403 · FNF[context-window-truth] · wrapper CLIs report the binary's 200k default; killed runs fall to the static table

status: parked · kind: design · was modular #285 · reason: diminishing returns (2026-11-01 scan): Context-window precedence and killed-run display fallbacks need a policy, without consequential impact established; resume when resume when incorrect windows affect an actual workflow decision · priority: P4
The LiteLLM max_input_tokens value is fetched and dropped (shared model-pricing.ts ~:137-145). OpenRouter's context_length still outranks the CLI figure. Decide the precedence per adapter family.

### T405 · FNF[sandbox-image-failure-routing] · an image-build failure while 08/08b resolve the sandbox image may loop the implementer back to "fix" it

status: parked · was modular #287 · reason: diminishing returns (2026-11-01 scan): Suspected image-failure misrouting remains unmeasured and explicitly requires a real failure; resume when resume when an image failure demonstrably enters the implementation loop · priority: P4
isDdevAgentFixableFailure (ddev-build-guard.ts ~:467) matches "failed to solve". 08 (~:954) and 08b (~:755) are fixLoopOnError; build errors are thrown at images.ts ~:122, :140 and composed-image-cache.ts ~:130.
Fix: classify by error type. Measure a real failure first.

### T409 · FNF[pause-attribution] · whose pause stands is derived from the task_events log (+2)

status: parked · kind: design · was modular #291 · reason: diminishing returns (2026-11-01 scan): Attribution storage cleanup, stale pause time, and timestamp precision are minor leftovers; resume when resume when attribution errors change pause enforcement · priority: P4

1. Add a `paused_by_admin` column written under the row lock, with a backfill (api tasks/_helpers.ts ~:1153).
2. After a takeover the owner's banner shows the owner's original pause time.
3. clearTaskPause compares against a JS millisecond date.

### T410 · FNF[merge-resolver-crash-window] · a crash after a clean merge drops the ticked squash; reopen never ensures the base worktree (+1)

status: parked · area: modular-haive-plan owns merge-resolver.ts landing sections — heads-up first · (T396 landed as PR #884) · was modular #292 · reason: diminishing returns (2026-11-01 scan): Crash-window recovery and reopen hardening lack a demonstrated current failure; resume when resume when recovery loses a requested squash or cannot reopen · priority: P4

1. merge-resolver.ts ~:1320-1322, ~:1362: persist baseShaBefore before the merge.
2. reopen (~:1642) never calls ensureBaseWorktree.

### T435 · FNF[web-api-cookie-transport] · different web/API hostnames cannot establish the server-rendered session

status: open · kind: feature · user decision: resolved 2026-11-01 · priority: P2

PRE-EXISTING, verified during T382/T432 recovery review. API cookies are host-only (`packages/api/src/auth/cookies.ts`), while the web proxy/layout require cookies at the web hostname; `packages/web/src/lib/api-origin.ts` accepts a different explicit API hostname. Login against that API cannot establish the SSR web session. CORS does not transfer cookies between hostnames; different sites also face SameSite=Lax. Same hostname/different ports is supported and tested. Decide on web-origin API proxying or an explicit cookie/SSO deployment contract before changing transport. Evidence: `.claude/tmp/board-run/T382/codex-review-session-recovery-fix-2.md` F2 and branch session-recovery.md. Keep single-use refresh rotation; this is separate from the current T382 correction.

User decision 2026-11-01: Route browser/session traffic through the web origin API proxy when web and API hostnames differ.

### T436 · FNF[attachment-count-lifecycle] [design] · persisted attachment counts have no live reader or restart reconciliation

status: parked · kind: design · scope: queued broader finding, not approved implementation · reason: diminishing returns (2026-11-01 scan): Attachment counts have no operational consumer; affected worker helpers are dormant; resume when resume when a live consumer needs reliable attachment counts · priority: P4

PRE-EXISTING, rechecked during T423 integration review. F1: dormant worker helpers in `packages/worker/src/sandbox/container-manager.ts:194,204` still read then write attachment counts and have no callers. F3: API process death leaves `containers.attached_ws_count` stale, and there is no boot reconciliation or operational consumer (live uses are the API writers plus a web type). Decide whether the count should be retained with a lifecycle contract, or removed with the unused helpers; make dormant helpers atomic before any reuse. This does not undo T423's live API atomic-write and cleanup correction. Evidence: `.claude/tmp/board-run/T423/codex-review-integrated.md` F1/F3. No implementation started; separate design decision.

### T439 · FNF[auth-url-resend] [design] · a pause of 1 s or more inside the login URL still sends its head

status: parked · reason: diminishing returns (2026-11-01 scan): Incomplete login URL chunking has never been observed; resume when resume when real output pauses produce truncated authentication links · priority: P4
From the T433 review (2026-10-30). Residual of T433's fallback: api routes/cli-login-banner.ts `offerAuthUrl` (~:689-707) takes the end of the output as the URL's end once `AUTH_URL_SETTLE_MS` (1 s) has passed since the URL first showed, so output that stops inside the URL for that long (or an event-loop stall of that length) sends the head with nothing to correct it. T433's other option, re-send when the URL grows, would cover it: keep extracting after a deadline send and send a second `auth-url` frame when the URL grew (the web re-applies `setAuthUrl` per frame; verify, and decide how amp's flow choice and the device code behave on a second frame). Real chunking inside the URL has never been observed: decide whether it is worth the mechanism.

Cross-reference (T438, 2026-10-30): the device code now waits within the same deadline, so a code cut at the deadline goes out as it stands (cli-login-banner.ts ~:716) and is never corrected either; success text in output that arrives while the frame is held is evaluated only at the next chunk (`canDetectAuth` needs `authUrlSent`, ~:838-840; a human cannot approve before the link shows); and the login modal shows nothing about the code when the frame carries none (web cli-auth-banner-modal.tsx ~:634, now rarer). A re-send mechanism would cover the first and the last.

### T440 · FNF[refresh-result-unrecorded] · a refresh's failed sources are never recorded, so a scheduled refresh's or a timed-out manual refresh's failures show nowhere

status: open · kind: feature · user decision: resolved 2026-11-01 · priority: P2
From the T428 review (2026-10-30). PRE-EXISTING, moderate. T428 shows the `ok: false` sources only on the page that started a refresh and only while its poll is open. A scheduled tick or boot refresh, and a manual refresh whose 10-minute poll window ends, surface nowhere; the poll-timeout copy even promises "reopen this page later to see the result" (web lib/cli-jobs.ts ~:33-38), which no page can show. FX has no durable trace at all: `fx_rates` has no error column (database schema/pricing.ts ~:126-135), a failure is only `log.warn` plus `ok: false` (worker cli-versions/model-prices.ts ~:329-332), and dispatch just returns the result (worker queues/cli-exec/handlers.ts ~:1529-1531). Decide between a last-result row per source, an FX fetch-state table, or one last refresh-run record the pages read; fix the timeout copy with it.

User decision 2026-11-01: Persist the latest refresh result and per-source failures so the UI can reopen them later.

### T442 · FNF[runner-launch-spec] [design] · a running app runner is reused whatever image, caps, ports or debug env it was created with

status: parked · reason: diminishing returns (2026-11-01 scan): Runner launch-spec mismatch is explicitly minor with unmeasured consequences; resume when resume when changed launch settings cause a demonstrated runtime problem · priority: P4
From the T431 review (2026-10-30). PRE-EXISTING, minor, consequence unmeasured. worker sandbox/app-runner.ts ~:326-333 reuses a running app runner when its workspace subpath matches and compares nothing else, so the image tag, resource caps, publish args and debug env chosen at create never reach a running runner (the class T431 fixed for the editor). Unlike an editor, recreating a runner stops the running app, so decide when a changed launch may replace it (idle only, on the next explicit start, or never with a notice) before stamping a spec label as T431 did (`haive.ide.spec`).

### T443 · FNF[rules-override-retry] · a 02 retry after the record write moved the repository rules override refuses and the region stays at the old override until the next upgrade

status: open · kind: fix · user decision: resolved 2026-11-01 · priority: P2
From the T119 review (2026-10-30). Introduced by T119, fails closed. worker onboarding-upgrade 02-upgrade-apply.ts ~:924-932 refuses the plan (`PLAN_NO_LONGER_HOLDS`) when `repositories.agent_rules_override` differs from the value 01 stamped; it has no counterpart of the render-context `ownRecordColumn` exemption (~:915-921). The writer-embedded import at 02's own record write (worker project-state write.ts ~:818) can import another install's override after 02 wrote the region, so the committed AGENTS.md block keeps the old override until the next upgrade heals it as `clean_update`, and a 02 retry needs a re-plan. Decide: defer the settings import while an upgrade is live, re-render the region on retry, or accept and document (the docs record it as a residual).

User decision 2026-11-01: Defer imported repository-rules overrides until the running upgrade finishes, then reconcile.

### T444 · FNF[agent-rules-size-cap] [design] · the repository rules override may be 64 KiB, but codex reads only the first 32 KiB of AGENTS.md

status: parked · reason: diminishing returns (2026-11-01 scan): Explicitly minor oversized-override edge requires unusually large rules; resume when resume when actual repository rules exceed Codex's readable limit · priority: P4
From the T119 review (2026-10-30). Minor. shared project-state limits.ts ~:12 `MAX_AGENT_RULES_BYTES` is 64 KiB, while codex reads only the first 32 KiB of AGENTS.md (the reason AGENTS.md itself is kept under 32 KiB), so a large override silently truncates what codex sees, and the rest of the file after the block with it. Decide: a 24-32 KiB cap, or a size hint on the Tooling editor.

### T446 · FNF[bundle-descriptor-removal] · document the chosen claim-based descriptor-removal rule in upgrade commits

status: open · kind: documentation · user decision: resolved 2026-11-01 · priority: P3
From the T119 review (2026-10-30). Verified 2026-10-31 by the T446 driver (evidence in .claude/tmp/sonnet-run/T446/): INTENDED by the documented rule in docs/architecture/onboarding-upgrades.md ~:662-671. A descriptor that the previous base names but no local bundle holds is kept while a claim names its source, and is removed and reported in `removed` once none does; it "can flap across pushes". Measured on real git with a two-install smoke harness (packages/worker/test/two-install-smoke.ts): B's record writer (worker project-state/write.ts ~:684-711, run by 12, 02, 04, the 10 s dirty sweep and the checkout watcher) removes A's claim-less descriptor; Haive's own 02+03 with the commit box ticked commits that removal; A writes the file again at its next record write. Nothing reads an unclaimed descriptor, and A's bundle row, storage, items and ledger are untouched, so nothing is lost.

Question for the owner: keep the rule (recommended, adding to the docs that 12 and 03 stage the removal when their commit box is ticked), or make a claim-less descriptor team-wide. Option 2: a descriptor exists only while a claim names its source. Option 3: the sync adds a checkout descriptor to the base only if a local bundle, a claim or the previous base names it. The flip lists are in the driver report. If flipped, also make the two-install smoke assert the rule across installs: it commits B's deletion (~:2477) and `treesDiffer` skips `bundles/` (~:2879).

User decision 2026-11-01: Keep current claim-based descriptor rule; document that12/03 can commit automatic descriptor removal. No team-wide descriptor policy change.

### T450 · FNF[install-ownership-of-runners] · the runtime-runner reaper removes runners this install's database does not know, volumes included

status: open · priority: P2 · gate: bounded verification
From the T441 review (2026-10-30). PRE-EXISTING, consequential on a host whose Docker daemon serves two installs; read from code, not reproduced. worker sandbox runtime-runner-reaper.ts ~:515-526 lists every `haive.ddev` and `haive.apprunner` container on the daemon with no install-ownership test; ~:64 (`if (!task) return 'orphan'`) treats a runner whose task this install's database does not know as an orphan, and `sweep` (~:342-366) and the preemption path (~:461-466) then run `docker rm -f -v` on it, its volumes included. Runners carry no `haive.install` label (only docker-runner.ts ~:422 stamps one). Fix direction: stamp `haive.install` on every runner at create, list by it, and leave an unlabeled runner alone (never reap what this install cannot prove it owns); keep docs/plans/solitary-partitioning-lampson.md's pending two-install check (S4) in step.

Execution fence 2026-11-01: first establish an affected legacy/current supported case in owned fixtures. The recorded risk is not a confirmed production incident and does not make completing an unbounded inventory a prerequisite for new functionality. Escalate a reproduced security/data-loss consequence.

### T451 · FNF[runner-liveness-probe] [verify-first] · a failed docker inspect of a runner's existence still reads as "no"

status: open · gate: bounded verification · user decision: recheck risk-bearing members, 2026-11-01 · priority: P2
From the T441 review (2026-10-30). PRE-EXISTING, minor. `isRunning` and `containerExists` read a failed `docker inspect` as "not running" or "absent" (worker sandbox ide-runner.ts ~:87-105, app-runner.ts ~:76-93, the same shape in ddev-runner.ts ~:888, callers not traced), and `startIdeRunner` (ide-runner.ts ~:259) and `startAppRunner` (app-runner.ts ~:154) open with an unconditional `docker rm -f -v`, so a transient failure of that first probe still recreates a live runner. T441 closed only the workspace-label probe. Needs a tri-state existence read and a decision per call site. Cross-reference: T371 [verify-first] FNF[docker-spawn-dedup].

Executable verification scope: Tri-state existence/inspect failure before destructive runner recreation; trace supported callers before a fault-injection control. No automatic full-bundle repair: prove a supported current consequence, then scope the fix; park the remainder.

### T453 · FNF[auth-prehydration-click] [design] · a click or Enter on the sign-in form before React attaches drops what was typed

status: parked · reason: diminishing returns (2026-11-01 scan): Minor pre-hydration input loss requires a broader replay mechanism; resume when resume when cold-load submissions or password managers reproduce recurring losses · priority: P4
From the T449 review (2026-10-30; was T449 item 2). PRE-EXISTING, minor.

Before React attaches `handleSubmit`, a click on Sign in (web components/auth-form.tsx ~:189) or Enter is the browser's native POST to the same page (`method="post"`, ~:154, from T448), answered with a fresh server render: the form comes back empty and what was typed is gone. Options measured or weighed by the T449 driver: React's own replay (a function `action`) keeps it but emits no `method`, which T448's JavaScript-off fallback needs; an inline script that queues the submit and replays it with `requestSubmit()` after attach is possible (the CSP has no `script-src`) but is a new hydration handshake; echoing the POST body back into the page would put the password into HTML. A button disabled until hydration breaks the JavaScript-off fallback. Decide whether it is worth a mechanism (for example only if autosubmitting password managers on cold loads are observed).

Also (T454 review, 2026-10-31): `/repos/new` has the same pre-attach click (web components/new-repo-form.tsx ~:247, `method="post"` since T454); whatever replay mechanism is chosen here should cover every server-rendered form, not the sign-in form alone.

### T457 · FNF[cli-login-post-cleanup-chunks] [design] · a sign-in line that arrives after the login session ended still starts a probe

status: parked · reason: diminishing returns (2026-11-01 scan): Minor teardown-only probe scheduling; desired completion behavior remains undecided; resume when resume when late probes cause observed incorrect provider state · priority: P4
From the T452 review (2026-10-31). PRE-EXISTING, minor; reachable only when output arrives during teardown.

In api routes/cli-login-banner.ts `onStreamData` (~:876-882), a success or error line in a chunk that arrives after `cleanupSession` still reaches `detectAuthResult` and starts `runProbeAndSave`, which queues a probe job for a session that is gone: `canDetectAuth` (~:666) has no `cleanedUp` check, while `captureClaudeOauthToken` and `offerAuthUrl` do. Codex, grok and amp take this branch (grok measured by the T452 driver with a scratch test: probe jobs 0 -> 1 after `ws.close()` and a "Signed in" chunk). Decide whether a login that completes during teardown should still be verified (the CLI has stored its credentials either way, so a skipped probe leaves Haive's provider state stale until the next check). If not, one `if (session.cleanedUp) return;` at the top of `onStreamData` closes it and makes T452's gate on the antigravity URL step redundant.

### T460 · FNF[retry-repo-deleted] · a Retry revives a failed task whose repository was deleted (+1)

status: open · kind: fix · user decision: resolved 2026-11-01 · priority: P2
From the T349 review (2026-10-31). PRE-EXISTING. A failed task whose repository was deleted still passes `checkRevive` (database repository-task-lock.ts ~:109), while the repository delete's `cancelOpenTasksForRepo` (api lib/cancel-task.ts ~:130) skips failed tasks; a Retry then sets it `running` with no repository and the worker's next advance throws. Decide: refuse that Retry (say why on the page), or have the delete cancel failed tasks too. Cross-reference T393, T394, T409.

Also (T349 fix-round review, 2026-10-31, reasoned from the code, not reproduced): since T349 the delete takes the task-creation key a Retry takes, but a Retry already waiting on the key when the delete commits goes on: `checkRevive` returns null after the wait without reading the repository again (database repository-task-lock.ts ~:109-113), so the task is revived to `running` with a NULL repository. Whichever way this is decided, the Retry must read the repository again after its wait.
Note (T458 fix round, 2026-10-31): the repository delete's cancel (`cancelOpenTasksForRepo`, api routes/repos.ts ~:3384) clears no pause, while Cancel, abort and the plan merge discard now do; if a revival of such a task stays possible, it would be parked again by the stale `paused_at`.

User decision 2026-11-01: Refuse Retry for a deleted repository with a clear explanation; re-read repository existence after waiting for its lock.

### T462 · FNF[project-state-notices] [design] · the repository page cannot say a sync replaced or refused a value (+3)

status: parked · reason: diminishing returns (2026-11-01 scan): Bundle adds notices and visibility for existing conservative sync behavior; remaining consequences are minor; resume when resume when hidden refusals materially block repository state synchronization · priority: P4
From the T445 review (2026-10-31; was T445 item 2). PRE-EXISTING.

1. A checkout value the sync refuses (over its cap, holding a region marker) is only logged (worker project-state/sync.ts ~:953, names only); since T445 a first sync's replaced units are only logged too. No api route serves `project_state_sync`, and project-state-conflicts.ts (~:59-77) lists pending two-answer questions only. Proposed by the T445 driver: one nullable jsonb column, declared last, on `project_state_sync` holding the refused units with their reasons (from `SettingCheck.reason`, which `intakeSettings`, shared settings.ts ~:253-286, drops today), written in the sync's own upsert (~:983-1004) and cleared by the next clean sync, served beside `conflicts` and shown as one banner gated on the array being non-empty. A replaced value is an event rather than a state, so it may stay log-only unless an acknowledged notice is wanted. Needs a migration, api and web tests and wording.
2. Minor: the sync's warns (~:933, ~:953, and T445's first-sync warn) are emitted before the writer that called the sync may roll back (worker project-state/write.ts ~:818, throws at ~:848 and ~:850): one extra line for a sync that did not commit, repeated by the retry. A stored notice would replace them.
3. Minor: shared plan/projection-merge.ts ~:289, the other `mergeProjectState` caller, drops `merge.overwritten` for a plan merge with no merge base (`--allow-unrelated-histories`, plan/merge.ts ~:232), per that resolver's documented "takes theirs" rule.
4. (T466 review, 2026-10-31) PRE-EXISTING, minor: `project_state_outbox.last_error` is written (worker project-state/refresh.ts ~:24-42: a deferred, moved or missing checkout, a refused newer format) but nothing in api, web or shared reads it, so a held record is invisible to a person; the same notice could carry it.

### T464 · FNF[ssr-controlled-values] [design] · controlled inputs a page renders on the server lose what is typed before hydration

status: parked · reason: diminishing returns (2026-11-01 scan): Minor text loss occurs only before hydration and needs a general mechanism; resume when resume when users repeatedly encounter pre-hydration input loss · priority: P4
From the T454 review (2026-10-31). PRE-EXISTING, minor (typed text is lost; nothing reaches a URL).

T449 and T454 made the sign-in form and /repos/new keep pre-hydration input (uncontrolled fields read with FormData). The rest of the class is not the same small change:

1. /tasks/new (web app/(app)/tasks/new/page.tsx ~:875; fields ~:1106, ~:1131, ~:1147) loses its title, description and estimate typed before attach: the plan fill is guarded by `titleTouched`/`descriptionTouched` refs that only an `onChange` sets, the block unmounts when the type switches to run_app, and HoursMinutesInput keeps its own state. It has no native submit before attach (its submit button is disabled in the server HTML).
2. Controlled inputs outside any form on seven pages (admin/users, admin/pricing, admin/audit, global-kb, rag-playground, the tasks list, github-client-card) lose typed text the same way.
3. The Source select on /repos/new (web components/new-repo-form.tsx ~:263) stays controlled because it decides which sections render, so a Source chosen before attach is reset at the first re-render.

Decide whether the class is worth a general mechanism (copy DOM values into state on hydration, a shared hook) or is left as is.

### T468 · FNF[ledger-imported-since-path] [design] · a retired git-data import marker still blocks an upgrade's rollback

status: parked · reason: diminishing returns (2026-11-01 scan): Minor conservative rollback refusal depends on retired legacy import markers; resume when resume when a retired marker blocks a needed rollback · priority: P4
From the T421 review (2026-10-31). PRE-EXISTING, minor, conservative direction. worker/api onboarding-admission.ts `ledgerImportedSince` (~:128-144) counts every import marker imported after an upgrade, path-blind and including the superseded ones, so a marker at a git-data path that T421's boot migration retired still blocks that upgrade's rollback. Decide whether a retired git-data marker should count (it was never a real import) or the conservative block stays.

### T472 · FNF[git-data-claim-sweep] [verify-first] · an onboarding reset leaves a git-data claim file that neither a ledger row nor the sync base names

status: open · gate: bounded verification · user decision: recheck risk-bearing members, 2026-11-01 · priority: P2
From the T469 review (2026-10-31). PRE-EXISTING, minor (narrow window).

api routes/repos.ts `resetOnboardingArtifacts` (~:2615-2625, the claim-file loop) takes back the claim files a live row, a retired git-data row (`supersededGitDataPaths`, T421) or a git-data claim in the sync base (`baseGitDataPaths`, T469) names. A git-data claim file that reached the checkout after the last sync (or that `applyRebase` dropped from the base, sync.ts ~:1131, until the next sync re-adds it) is in none of them, so it stays, and the record then reads `refused` ("format.json is missing") until someone removes it by hand: the sync cannot read it in once the reset removed `format.json`. Measured by the T469 driver (C4a/C4b). Direction (a decision, since it adds a read path to a destructive route): list `artifacts/` through the fs-safe primitives under a cap and take back each file the codec itself classes as a git-data claim (a canonical path that names git data and `claimFileName(path)` equal to the file name, codec.ts ~:374-379).

Executable verification scope: Reproduce the recorded unsynced-claim reset refusal; cleanup must recognize owned codec-valid claims and preserve unknown files. No automatic full-bundle repair: prove a supported current consequence, then scope the fix; park the remainder.

### T475 · FNF[ci-unit-tests-job] [design] · a format or typecheck failure skips the unit tests in lint-typecheck-test

status: parked · reason: diminishing returns (2026-11-01 scan): Earlier CI failures already make the gate red; remaining issue is diagnostic completeness; resume when resume when skipped diagnostics materially delay resolving CI failures · priority: P4
From the T470 review (2026-10-31). PRE-EXISTING, minor to moderate.

`lint-typecheck-test` (ci.yml ~:55-110) runs Format check, Typecheck, Unit tests, Module scripts, Shellcheck and Installer boot-failure paths with no `if:`, so a 41 s format error hides the 591 s unit tests, and shellcheck and the installer test need only the checkout. A guard there would hold the job's red verdict until the unit tests end; the alternative is giving Unit tests their own job, which renames a required check (a decision for the owner). The e2e job's "Typecheck the suite" (~:677) before the stack boot is deliberate and stays.

Notes (T474 review, 2026-10-31; PRE-EXISTING): `lint-typecheck-test` has a 20-minute limit (ci.yml ~:38, pinned at ci-browser-budget.test.mjs ~:44) against a slowest green run of 1017 s, leaving 183 s; and Module scripts, Shellcheck and Installer boot (~:71, ~:93, ~:108) run after the slow unit tests, so guarding only them would not delay the red verdict.

### T477 · FNF[sweep-held-slots] [design] · held outbox and mirror rows still take the sweep's 25 slots; the two sweeps share one job

status: parked · reason: diminishing returns (2026-11-01 scan): Measured sweep delays are minor and rotation already drains held rows; resume when resume when healthy projection delays exceed an acceptable operational bound · priority: P4
From the T466 review (2026-10-31). PRE-EXISTING, minor.

Since T466 a row whose checkout is gone costs 3-5 statements a tick, but every held row still takes one of the 25 batch slots (worker project-state/refresh.ts ~:182-183, queues/plan-mirror-queue.ts ~:608-614, ~:637-645), so a newer healthy row waits floor(N/25) ticks behind N held rows (MEASURED: N = 30 gave tick 2, N = 125 tick 6), and the mirror sweep runs before the outbox sweep in one job (`sweepAll`), so a slow mirror sweep delays outbox rows (14 dead rows of 20,000 nodes: sweeps of 3.6-5.3 s). `plan-canvas-smoke` C4 pins the rotation as designed. Direction (a decision): scan past held rows without counting them, or run the two sweeps as separate jobs.

### T481 · FNF[git-data-legacy-files] [design] · files an earlier release wrote under a git-data name stay, and an alias spelling on disk fails every later git add

status: parked · reason: diminishing returns (2026-11-01 scan): Explicitly minor legacy or hand-edited paths; current writers no longer produce them; resume when resume when retained legacy files block an actual upgrade or commit · priority: P4
From the T473 review (2026-10-31). PRE-EXISTING, minor (stored legacy or hand-edited input only).

Since T469 and T473 no writer records or writes a path that names git data, but files an earlier release already wrote there (07's agent files under a stored `.git/hooks`-style target dir, skill trees under a stored skills dir) stay, nothing cleans them, and an alias spelling on disk (`.GIT./x`, `git~1/x`) still fails `git add -A` in 12's init branch (`12-post-onboarding.ts` ~:958) and any later whole-tree add with "invalid path". A cleanup removes files in the repository, so it needs a decision: find them (by the stored targets or a tree walk), report them, or remove them with an explicit confirmation.

Note (T480 review, 2026-10-31): the KB walkers still list a git-data-named page into prompts while 08's `scanExistingKb` now skips it: 09-qa.ts ~:93-114 and 09_5-skill-generation.ts ~:296-322 (also feeding 09_5b ~:388 and 11d ~:371 through `listKbFiles`), so a prompt can name a KB page `applyKbWrites` then refuses; reachable only with such a page already inside the KB (this task's leftovers).

### T482 · FNF[lock-order-leftovers-2] · second sweeps wait holding step rows; the late sweep refuses a benign hold; planner-dependent id lists (+6)

status: open · gate: bounded verification · user decision: recheck risk-bearing members, 2026-11-01 · priority: P2
From the T459 review (2026-10-31). Minor; items 1 and 4-7 PRE-EXISTING, item 2 an accepted trade-off of T459.

1. The second sweeps still wait while holding step rows (and the task row, for a Stop): api routes/tasks/steps.ts ~:252, worker `_step-reset.ts` ~:171, api lib/task-control.ts ~:66. A young live agent run held by `releaseStepAgents` can close a cycle with them; a Stop must not fail, so NOWAIT is no answer there.
2. Since T459 the late sweep's NOWAIT (api steps.ts ~:135-150) answers 503 for a millisecond-scale benign hold of a late row's live run or agent row, where a wait would have succeeded; a `SET LOCAL lock_timeout` of about 250 ms (under `deadlock_timeout`) waits out a benign hold and still refuses a cycle. Apply to T349's `rowsActivatedMeanwhile` too, or neither.
3. The fan-out Resume with downstream or left-active rows still writes the clicked step's agent rows before it sweeps those rows' runs (api steps.ts ~:1236-1249); peers are a worker reset of the same range and a Retry-family action on a task with no repository. No control.
4. `writeLoginHint` (worker cli-exec/handlers.ts ~:495) runs inside a catch: a 40P01 there replaces the original CLI error and skips `markCliParkBegin` and `resumeStepIfLinked`.
5. `id IN (...)` statements are planner-dependent (api steps.ts ~:1236-1245, worker `_step-reset.ts` ~:327, task-queue.ts ~:3553-3563, step-runner.ts ~:1531, data-migrations.ts ~:298): a Bitmap Heap Scan at T459's seed (ctid order), a plain pkey Index Scan would lock in id order. No named peer.
6. Theoretical: the provider delete (api cli-providers.ts ~:557) runs `ON DELETE SET NULL` over every run and agent row of the provider in heap order; a Retry holding the task row and sweeping a run the delete holds could close a cycle. Not reproduced.
7. Two passes that each `insertOwnedRun` a fan-out run for one step hold KEY SHARE on the step row and then both want it FOR UPDATE (worker step-ownership.ts ~:111-119): measured 40P01; the second waiter survives.

Executable verification scope: Reproduce consequential reachable lock cycles before changing locking; accepted brief-busy trade-offs, speculative peers and coverage-only cases stay deferred. No automatic full-bundle repair: prove a supported current consequence, then scope the fix; park the remainder.

### T483 · FNF[plan-delete-cycle] · update-only plan writers can still deadlock with a repository delete

status: open · kind: fix · policy: covered by accepted bounded-wait/consistency rules · priority: P2
From the T459 review (2026-10-31). PRE-EXISTING, minor to consequential. Cross-reference T270 and T318 item 5.

Since T459 a plan patch that may insert takes the repository row FOR KEY SHARE first, but an update-only patch takes no repository lock (a project-state write holds that row FOR UPDATE for 0.4-2 s, see T484), so it can still deadlock with a repository delete at the fresh-baseline cascade order, or when two node updates run opposite to the delete's scan; the same shape is in `answerPlanQuestion` (worker plan/answer.ts ~:48-132), `markPlanCodeLinksStaleForPaths` (worker plan/code-link-staleness.ts), the mirror reconcile and flush (plan/mirror.ts ~:1498, ~:1710) and the set-aside marks (set-aside.ts ~:607, ~:830, ~:933). Also: a Retry or revival of an onboarding or onboarding_upgrade task holds the repository row FOR UPDATE for its whole transaction (`repository-task-lock.ts` ~:31-49) and then deletes agent rows, while 10_8-plan-build's `applyAgentPatchOnce` (`_plan-prompt.ts` ~:330-359) holds a mining row and asks for the repository KEY SHARE (T459 moved that edge earlier). Options: the delete removes the plan rows itself, mirror row last; lock the mirror row first (serialises patches); or accept the 40P01 on a delete.

Note (T459 fix round): 01-plan-build (~:882, and 10_8 with it), 02-plan-coverage (~:793), 03-plan-sequence (~:630) and 01-plan-chat (~:318) catch every fold error alike, so a repository deleted under them is stamped as a failed apply rather than failing at once; minor, since the repository delete cancels the task's open steps first.

Engineering scope derived from the accepted policy (2026-11-01), not a new owner decision: Use the selected serialization/bounded-wait policy for reachable plan/delete conflicts; prove lock order with current callers before a locking change. Existing data consistency stays intact.

### T484 · FNF[project-state-row-hold] · the project-state writers hold the repository row FOR UPDATE across file and git work

status: open · kind: fix · policy: covered by accepted bounded-wait/consistency rules · priority: P2
From the T459 review (2026-10-31). PRE-EXISTING, consequential (latency).

The project-state writers take the repositories row FOR UPDATE (`watch-admission.ts` ~:24, `sync.ts` ~:733, through the write gate in write.ts ~:727-731) and keep it across file and git work: MEASURED by T459, 26-52 ms per foreground write with no claim files, 1.0-1.3 s with 150, and about 2 s per sweep write. Every child INSERT of the repository (a task start, a plan node, a mirror row) needs KEY SHARE on that row and waits as long. Decide whether the writers need FOR UPDATE (it also excludes the FK checks of every insert) or FOR NO KEY UPDATE (still excludes a delete and another writer), or a shorter hold.

Engineering scope derived from the accepted policy (2026-11-01), not a new owner decision: Reduce or bound row holds under the accepted short-wait policy, preserving writer/delete exclusion and atomic project-state semantics. SQL lock strength is an implementation choice requiring a measured control.

### T485 · FNF[credential-connection-leftovers] · credential and connection edges T341 left: a drifted row still reads connected, the delete dialog names only the connection (+6)

status: parked · reason: diminishing returns (2026-11-01 scan): Entire credential-connection bundle is explicitly minor, cosmetic, or harmless; resume when resume when connection drift causes a consequential user failure · priority: P4
From the T341 review (2026-10-31). Minor; PRE-EXISTING unless stated.

1. A reconnect into a linked credential stored under a replaced key throws (api lib/integration-sign-in.ts ~:95-96, `decryptDek` via ~:119), while an unreadable orphan is skipped (~:87-93).
2. `usernameEncrypted` is never rewritten after a vendor login rename, while `account_label` follows (integration-sign-in.ts ~:95-107, ~:156).
3. web components/repos/github-oauth-connect.tsx ~:33 `findGithubOauthCredential` keys on the label prefix; `repo_credentials.sign_in_account_id` (0216) is now the real marker but the credential list does not expose it, so a renamed sign-in credential is not pre-selected.
4. The delete confirmation (web credential-delete-dialog.tsx) names only the connection; deleting also unlinks repositories (`repositories.credentials_secret_id` SET NULL) and custom bundles (`custom_bundles.git_credentials_id` SET NULL).
5. Connections whose credential drifted to another host or forge before T341 still read `connected` (api `toConnectionSummary`, integration-sign-in.ts ~:40); the readers throw, the resolver skips them and a reconnect repoints. Recommended default: derive the state in the summary rather than repair rows.
6. New with 0217, harmless: `needsReauth` (shared integrations/access-token.ts ~:158-161) leaves a stale `refresh_refused_at` (the status shows, and a sign-in clears it).
7. Cosmetic: web credential-modal.tsx ~:19 `HOST_PRESETS` is a second hand-written host list (no codeberg.org); derive it from `AUTO_DETECT_HOSTS`.
8. The 400 "That account does not fit this task's repository" (api integration-choice.ts ~:125) does not say the credential moved to another forge.

### T486 · FNF[aside-trees] · a kept-aside repository tree is never swept, reported or named on failure (+7)

status: open · priority: P2
From the T479 review (2026-10-31). PRE-EXISTING, minor (needs a crash between two renames or two consecutive failures).

1. `.haive-extract-*` stages (worker repo/clone.ts ~:543) are never swept, reported or documented: upload-reaper.ts (~:408-452) sweeps `_uploads` only and scratch-workspace.ts (~:167-196) `_scratch` only. Since T479 a stage kept after a failed restore holds the only copy of the previous tree, and a crash between the swap's two renames leaves one too. Decide whether a sweep reports or removes them (removal must never take the only copy).
2. `rebuild` (worker repo/refresh.ts ~:282-311): after `moveAside` a failed `copyTree` or `gitClone` throws without naming the aside folder; only the success note carries it, and the repo queue records the clone error alone, although repository-refresh.md (~:24) promises the old tree is never removed. Name the aside folder in the failure text the repository page shows.
3. (T397 fix round 4, measured on git 2.43 and 2.54) `usableCheckout` (worker repo/refresh.ts, at T397's head) proves a `.git` dead only when an entry is absent or HEAD or the gitfile has the wrong bytes; shapes git also refuses with exit 128 stay `unknown` and end `error` with "Retry cannot help": HEAD `ref: heads/main` (no `refs/` prefix), `objects` or `refs` as a file or a dangling symlink, `gitdir: ` with an empty path. An interrupted copy cannot produce them; PRE-EXISTING class, minor. Prove them structurally too, after T397 lands.
4. (T397 fifth review, traced, PRE-EXISTING since a1a74f596; consequential, rare) `rebuild` copies into `dest` in place and names only the last aside: a worker killed inside `cp -a` leaves a partial tree at `dest`; the next attempt moves that partial tree to a second aside and names only it, so the first aside (the real old tree) is named nowhere and the recorded undo restores the partial copy; a kill after `.git` was complete reads usable and ends `ready` with files missing. Fix direction: copy into a staging sibling and `renameNoFollow` it into place, and keep every aside path in the text.
5. (T397 fifth review, PRE-EXISTING, minor) deleting a repository leaves its `<repoId>.aside-*` siblings: the cleanup removes only the repository directory (worker task-queue.ts ~:4025) and an upload archive (~:4034), and no code lists or removes an aside.

6. (T397 fix round 6) After a good rebuild a `persistDetection` throw is retried by BullMQ; the retry reads a usable checkout and writes a null note over the one that named the aside, so nothing names it any more (worker repo/refresh.ts ~:511 against ~:563). PRE-EXISTING, minor.
7. (T397 fix round 6, a trade-off T397 chose) Since T397 every failure after the old checkout is moved aside ends the job with `UnrecoverableError` naming the aside, so a transient clone failure that left nothing at the destination needs a manual Retry where BullMQ's retry used to recover it. Making that case retryable again needs the aside's name carried into the retry's note (item 6), or the person loses the only pointer to the kept tree. Minor, consequential on flaky networks.

8. T397 round7 introduces a unique <repoId>.rebuild-<uuid> staging sibling for folder refreshes. A kill or refused cleanup retains it, and repository deletion/sweeps do not list it. REGRESSION-adjacent retention limit, minor; include these exact owned siblings in this task's eventual report/sweep design, never remove the only copy blindly. Item4's partial folder-destination defect is fixed by staging; the equivalent remote clone path still writes directly at dest and remains open. A clone checkout failing after HEAD resolves may then be accepted as usable on Retry (code trace verified, git interruption order still unmeasured).

Reconciled 2026-11-01: item2 is RESOLVED by T397: failedAfterMove names the kept aside on rebuild failure. Item4 is RESOLVED for folder copies by staging; the remote-clone equivalent remains a verification candidate as item8 records. Never count the folder case as an open defect or sweep the only remaining copy. Retention/reporting design remains open.

### T487 · FNF[bundle-replace-zip-tree] · ask whether to preserve the old bundle or remove it first to free disk

status: open · kind: feature · user decision: resolved 2026-11-01 · priority: P2
From the T479 follow-up review (2026-10-31). PRE-EXISTING, minor.

The Replace ZIP route (api routes/bundles.ts ~:895-907; the removal at ~:906, inside the bundle-then-upload transaction) deletes the bundle's `extracted/` tree before it enqueues the ingest job (`attempts: 1`, ~:921), so the worker's `extractArchive` finds no destination and a corrupt replacement zip leaves a failed bundle (bundle-ingest.ts ~:173-176) whose item rows stay (worker-restarts.md ~:130-131) with no tree behind them. Since T479 the swap restores the previous tree on failure, so the route's removal no longer buys atomicity; but the comment at bundles.ts ~:896-897 ties it to the stale-complete guard and the docs record it as intended. Decide whether the route keeps the tree and lets the swap replace it.

User decision 2026-11-01: Ask the user at Replace ZIP: keep old until replacement succeeds, or remove old first to free disk. Explain that remove-first sacrifices automatic rollback; do not silently select a mode.

This explicitly SUPERSEDES the earlier keep-old-only answer. Ask at each Replace ZIP operation, explain the disk-space/rollback trade-off, and require a deliberate mode choice before destructive removal. Never silently infer remove-first from low disk space. The UI must distinguish the uploaded archive and extracted tree when presenting what will be removed.

### T490 · FNF[error-text-paths-2] [verify-first] · other surfaces still show raw worker error text with server paths (+8)

status: open · gate: bounded verification · priority: P2
From the T478 fix rounds (2026-10-31). PRE-EXISTING, minor. T478 added `scrubErrorPaths` (@haive/shared logger) and passed the plan snapshot error, the plan Save/Pull 409 bodies, `repositories.status_message` and 12's plan-mirror warning through it.

1. The set-remote responses keep raw filesystem and git diagnostics (api routes/repos.ts ~:2752); found from source, not exercised.
2. Other step failure and warning sinks keep paths: worker step-engine/step-runner.ts ~:3722 and 12-post-onboarding.ts ~:808; found from source, not exercised.
3. Stored 12 warnings in `task_steps.output` from before T478 keep their paths (not repaired; the task page shows them behind "Show output").
4. The scrubber's known misses (errors.ts ~:73): it replaces `/proc/self/fd` in fs-safe's refusal text, HTTP route paths and glob tails, drops a sentence's final period with an unquoted path, and leaks the tail of an unquoted path with a space and a second path directly after a colon. Accepted for T478; revisit if a surface shows one.
5. (T478 review 3) READY repositories keep server paths in `repositories.status_message`: the refresh job stores its refusal text with `status: 'ready'` (`persistDetection`, repo/clone.ts ~:251, called at repo/refresh.ts ~:306, ~:328, ~:341, ~:359): `git remote get-url origin failed in <checkout path>`, a HEAD read's git stderr, `... it was kept at <absolute aside path>.` (deliberate, so scrubbing it is a product decision) and `the checkout could not be examined (...)`; the repos page renders the column for every status. Item 1 is now verified by reading (repos.ts ~:2688-2795: `lstat` text and `git rev-parse`, `git remote add` and `git config` stderr in the 409).
6. (T365 review 4, by reading) Upload and import routes put a filesystem failure's own message into a 500 reply with no `scrubErrorPaths`: api routes/bundles.ts ~:576, ~:668, routes/repos.ts ~:674, ~:873, routes/db-dumps.ts ~:223, routes/tasks/attachments.ts ~:313, routes/user-settings.ts ~:419. error-diagnostics.md says a filesystem failure shown to a person goes through it. PRE-EXISTING, minor.
7. (T365 review 4) The bundle composer's other failure branches (web components/bundle-composer.tsx ~:303, ~:321, ~:348, ~:364, ~:372, ~:414, ~:455, ~:471, ~:479) throw `<what> failed (<status>)` and drop the answer's reason, so "archive exceeds N bytes limit" (api bundles.ts ~:453, ~:776) reads "upload init failed (413)" and "an import of this bundle is already running" (~:956) reads "resync failed (409)". Show the reason as T365 does for the file listing (trimmed, status fallback), but only after item 6, so no unscrubbed path reaches the page. PRE-EXISTING, minor.
8. (T397 fix round 6, latent) `safeErrorForTransport` (shared logger/index.ts ~:33-38) turns any error with a bound-query error in its cause chain into a plain `Error`, so an `UnrecoverableError` with such a cause would lose its class and be retried. Unreachable on every current `UnrecoverableError` path. Keep the class (or the name) when rewrapping. Minor.
9. (T120 PR1b fix round 1) The plan snapshot error (api routes/plan.ts ~:435) is path-scrubbed but not URL-redacted, while the Haive data status now passes the same columns through `redactGitText(scrubErrorPaths(x))`; a git error naming a remote with userinfo reaches the plan page as is. PRE-EXISTING, minor.

Execution fence 2026-11-01: Prioritize a supported credential-bearing error transport or misleading operational failure. Cosmetic scrubber spellings, unreachable exception classes and hypothetical text shapes remain parked.

### T493 · FNF[audit-retention] [design] · audit_events has no retention and the admin audit page counts the whole table

status: parked · reason: diminishing returns (2026-11-01 scan): Retention and full-table counting have no measured current performance consequence; resume when resume when audit growth causes measured latency or storage pressure · priority: P4
From the T376 review (2026-10-31, C1). `GET /admin/audit` runs `count(*)` and two `SELECT DISTINCT` over the whole table on every page view (api admin.ts ~:191-261), and `audit_events` keeps every row forever; since T376 every sign-in attempt writes one (throttled ones bounded per window). Decide a retention period (delete or archive), and bound the page's counts (an estimate, or indexed filters).

Decision reconciliation 2026-11-01: Keep the audit-retention/performance redesign parked until measured growth or latency justifies it; no automatic audit-row deletion is authorized by the90-day upload-metadata decision.

### T494 · FNF[stored-targets-leftovers] · 07's quarantine checks a name's shape, not its membership; T480's leftover pins (+5)

status: parked · reason: diminishing returns (2026-11-01 scan): Bundle concerns hand-edited payloads, dormant guards, minor warnings, and test hygiene; resume when resume when a supported producer reaches the unsafe stored-target shapes · priority: P4
From the T480 reviews (2026-10-31). PRE-EXISTING and minor unless stated (each needs a hand-edited 07 detect payload).

1. 07's quarantine accepts any one-segment name with the catalog extension, so `files: ['README.md']` moves the index 07 just wrote to `<dir>-legacy/README.md`, overwrites it with the legacy README, and 12 records an `agents-index` row for a file that is gone (worker 07-generate-files.ts ~:459-483 lists, ~:496-499 accepts, ~:1017-1027 moves). Skip `README.md` and the names of the agents just written; claimed paths need a ledger read.
2. 12's refusal of a stored skills directory is only logged (12-post-onboarding.ts ~:329-334), while a refused agent directory shows in its warnings.
3. `recordable` (12 ~:298-302) is now a dead backstop with no control: no input reaches it with a git-data path since T480. Pin it with a direct unit test or delete it.
4. The quarantine's extension comes from the catalog, never the stored target's format (07 ~:487-488), but no test pins it: a stored `{ dir: '.codex/agents', format: 'markdown' }` beside an `x.md` name would.
5. [verify-first] The upgrade path passes stored agent targets through `originAgentTargets` unfiltered when the 07 payload records neither `cliTargets` nor `enabledCliProviders` (worker _upgrade-render.ts ~:314-330, shared render-targets.ts ~:223-226), and 02's `safeDiskRel` does not refuse an off-catalog canonical dir; trace whether such a target reaches a write.
6. Test hygiene from the first T480 review: repository-skill-empty-targets.test.ts ~:298-314 pins nothing new; 09_6-skill-verification.ts ~:147 hides a skill directory whose name holds `\`.

### T495 · FNF[failed-read-answers-2] · more git reads read a failure as "absent" (+11)

status: open · gate: bounded verification · priority: P2
From the T397 review (2026-10-31). Same class as T397 (git's exit code, never its wording); PRE-EXISTING, minor. See also T379 (git-tree readers).

1. 03-upgrade-commit.ts ~:91 (`headLacksImport`) and ~:114 (`agentsRulesVerdict`): any non-zero `rev-parse --verify -q HEAD` except no-answer reads as "no HEAD" and stages the whole file, taking unrelated edits; only exit 1 means no HEAD.
2. 10-gate-3-commit.ts ~:200: a failed `show --name-only` (non-zero, not no-answer) yields `[]`, so `task.changedPaths` silently misses the commit's files.
3. [verify-first] _dependency-policy.ts ~:159 and ~:214: `git show <base>:<file>` exit 128 means absent or failed; a failure drops the baseline Drupal protection and `ownedPaths`. `rev-parse -q --verify <base>:<path>` (exit 1) tells absent apart.
4. [verify-first] project-state/set-aside.ts ~:264-267 (`headOid`) and ~:1147-1152 (`headEntry`): a failed read reads as "HEAD lacks the path" (used for `untracked` ~:519 and in `putBackIndex` ~:1251); guarded by earlier successful reads in the same transaction.
5. [verify-first] plan/projection-merge.ts ~:34-37 `readBlob` returns null for every failure, and set-aside.ts ~:621 (`restoreFromHead`) and ~:1038 (`putBackProjections`) read null as "HEAD lacks the path": a failed `cat-file` removes the pending working file instead of restoring HEAD's bytes, and the put-back's create-exclusive hits EEXIST (swallowed). The raised marks let the sweep reconcile. From the T397 follow-up review.
6. git-merge.ts ~:256 `handBackWritten`: `lstatNoFollow(plan.anchor, rel).catch(() => null)` skips a changed path whose stat failed even when `strict` is true (project-state/branch-revert.ts ~:282, ~:476 pass `true`), while a failed chown throws; the same shape T397 removed from `handBackPlan`. From the T397 third review.
7. git-merge.ts ~:970-973 (fixer leftovers): `lstatNoFollow(..., { strict: true }).catch(() => null)` leaves `owner` undefined, so the `if (owner)` branches (~:1090, ~:1101) skip giving restored files back to the sandbox user. From the T397 third review.
8. plan/projection-merge.ts ~:415-416: a plan.md-only conflict reads `cat-file blob :.haive-data/plan.json` and treats any non-zero exit as "no plan" (exit 128 covers an absent entry and a failed read), so plan.md takes the incoming side with a warning that blames plan.json; an `ls-files` probe tells them apart. From the T397 third review.
9. step-engine/steps/onboarding/_stage-paths.ts ~:336-337: `commitRecorded` keeps the loose HEAD read (any non-zero exit means unborn) and ~:330-335 its own ref-resolving MERGE_HEAD/CHERRY_PICK_HEAD probe, a second definition of "operation open" beside `gitOperationInProgress`; a misfiring HEAD read skips the index repair silently. T397 changes that HEAD read; re-check after it lands. From the T120 PR1a second review.
10. repo/refresh.ts `usableCheckout` (~:117 at T397's head): `rev-parse --verify --quiet HEAD` exit 1 reads as an unborn HEAD and the checkout is moved aside and rebuilt, but exit 1 also covers a branch ref that could not be read (`--quiet` removes the only text that tells them apart; not measured). Fix direction: tell unborn from unreadable by a positive read (for example `symbolic-ref HEAD`, then `for-each-ref` of that ref: exit 0 with no output is unborn; anything else is unknown). Nothing is deleted (the old tree goes aside). From the T397 fourth review. Since T397 a remote with no commits (a clone with no stored branch exits 0, HEAD exits 1), which used to be rebuilt on every refresh with one aside each, ends `error` after its first rebuild instead of `ready`.
11. (T397 fix round 5) The local-folder import and the folder browser accept a dead checkout: `isGitRepository` (api lib/filesystem.ts ~:31-38, called from routes/repos.ts ~:513 and routes/filesystem.ts ~:27, ~:54) answers yes for any `.git` directory or file, through a symlink too (`stat`, a path-based node:fs call), and no for every error. A folder whose `.git` git refuses imports as a repository that every refresh then reads as unusable; since T397 a refresh refuses it, but the import is where it should be refused. Fix direction: the same usable-checkout answer the worker gives (`.git` read without following a link, git asked, an unknown answer refused rather than read as no), through fs-safe. PRE-EXISTING, minor.

12. T397 final review: git-merge.ts revParse (~:86-94) accepts GIT_NO_EXIT/ENOENT as absence when its lenient lstatNoFollow returns null, including non-absence filesystem failures. PRE-EXISTING, connected; the prior doc claim that this was a strict probe was corrected. Fix direction: strict stat with a missing-anchor proof, preserving genuine absent-worktree behavior. No change to the current seven-task scope.

Reconciled 2026-11-01: item9's failed-HEAD-read defect is RESOLVED by T397 (current _stage-paths.ts344-349 permits only exit0/1); remaining open-operation helper duplication is refactoring and stays parked with T379. Failed-read candidates imported from T379 require deduplication and a current supported reproduction before repair. No full twelve-item audit by default.

Execution fence 2026-11-01: Deduplicate the resolved T397 paths and T379 overlap first. Select at most three current consequential caller cases; no twelve-item generic Git-read audit. The fixed item9 HEAD probe must not be reimplemented.

### T497 · FNF[plan-merge-failed-visibility] · after a reload a failed plan merge leaves no trace on the plan page

status: open · kind: feature · user decision: resolved 2026-11-01 · priority: P2
From the T491 review (2026-10-31). `GET /plan/merge` lists open merges only (api plan.ts ~:447-459) and `plan_merge` tasks are hidden from the task list (tasks/index.ts ~:289-292), so once the page that saw the failure is gone, a FAILED merge (which keeps its worktree for a Retry) cannot be found from the plan page. Options: the route also returns the newest failed merge not followed by a successful one, shown with its Retry link; or a plan-page notice from the task events. Recommended: the first.

User decision 2026-11-01: Show the latest unresolved failed plan merge with its Retry/task link after reload.

### T499 · FNF[parks-accounting] · verify whether a parked current row beside another active row can stall recovery

status: open · gate: bounded verification · executable members: 4 · priority: P2
From the T385/T348 driver (2026-10-31). PRE-EXISTING, minor.

1. RESOLVED by T471, PR #981 (3078d9758): the retained run is carried, its live span is cleared, and the next claim opens a fresh span. Both reoffer and START-settle paths have passing real-Postgres controls.
2. MOVED to T525 (parked optional recovery coverage/display/diagnostics); original evidence retained there.
3. MOVED to T525 (parked optional recovery coverage/display/diagnostics); original evidence retained there.
4. A parked current row beside another `running`, `waiting_cli` or `waiting_form` row: every advance is dropped by the other-step guard (task-queue.ts ~:2813-2859), `foldAbandonedPark` unparks the row and the sweep re-drives it every 5 minutes with an epoch bump (T385 adds an overdue park as one more way in). See also T393/T394.
5. MOVED to T525 (parked optional recovery coverage/display/diagnostics); original evidence retained there.
6. MOVED to T525 (parked optional recovery coverage/display/diagnostics); original evidence retained there.
7. RESOLVED by T471, PR #981 (3078d9758): the retained run is carried, its live span is cleared, and the next claim opens a fresh span. Both reoffer and START-settle paths have passing real-Postgres controls.

Reconciled 2026-11-01: only member4 remains a candidate for execution. Reproduce it through a supported producer before changing recovery; a synthetic impossible row is not enough. Members1/7 are resolved,2/3/5/6 are parked in T525.

### T500 · FNF[handoff-silent-writes] · three handleResult neighbours write silently or re-fail a stopped task (+5)

status: open · gate: bounded verification · user decision: recheck risk-bearing members, 2026-11-01 · priority: P2
From the T385/T348 driver (2026-10-31). PRE-EXISTING, minor. Same family as T385 item 6 (the lost hand-off log).

1. MOVED to T525 (parked optional recovery coverage/display/diagnostics); original evidence retained there.
2. MOVED to T525 (parked optional recovery coverage/display/diagnostics); original evidence retained there.
3. `routableFixLoopTarget` (~:882-905) calls `writeTaskFailed` (~:670), which is epoch-fenced only; a Stop fails a task without moving the epoch, so a source row left `done` lets it re-fail a Stop-failed task and rewrite `error_message` and `completed_at`.
4. (T498 builder, by reading) When `enqueueCliInvocation` throws in worker step-runner.ts (~:1175, ~:1363), the run it recorded stays live on the failed row; the `prepareWorkspace` failure path just above (~:1164-1174) supersedes its run, these two do not. PRE-EXISTING, minor.
5. MOVED to T525 (parked optional recovery coverage/display/diagnostics); original evidence retained there.

Executable verification scope: Only members3/4: Stop-failed state overwritten and live run left after enqueue failure. Members1/2/5 moved to parked T525. No automatic full-bundle repair: prove a supported current consequence, then scope the fix; park the remainder.

### T501 · FNF[redrive-apply-idempotence] [verify-first] · is apply() idempotent for a re-driven running deterministic step?

status: open · gate: bounded verification · priority: P2
From the T385/T348 driver (2026-10-31). Unaudited: the stalled sweep (T348), BullMQ stalled redelivery and the boot reset can all run a deterministic step's `apply()` a second time. Audit the steps whose apply writes files, commits or external state, and record which are safe; fix or fence the rest.

Execution fence 2026-11-01: Bound verification to at most three current apply paths with meaningful external/file/commit side effects and a real redelivery producer. Do not audit every step speculatively.

### T502 · FNF[ci-step-limits-rest] · six more CI jobs bound a hang only by their job limit; helper scripts are not scanned for swallowed failures (+2)

status: parked · reason: diminishing returns (2026-11-01 scan): Additional timeout granularity and hypothetical helper or pub/sub gaps lack demonstrated gate failure; resume when resume when a hang or cross-step interference defeats current job bounds · priority: P4
From the T489 review (2026-10-31). PRE-EXISTING, minor to moderate.

1. No step-level `timeout-minutes` in lint-typecheck-test (ci.yml ~:35, 20 min), browser-runtime (~:114, 20), compose-boot (~:581, 30), e2e (~:721, 45), cli-adapters-arm64 (platform-checks.yml ~:39, 60) and macos-boot (~:116, 45): a hang costs the job limit. Size each from measured run times, as T489 did for four jobs, and extend the pin.
2. The swallowed-failure pin reads workflow `run` texts only; the helper scripts they call (packages/database/scripts/schema-parity.sh, scripts/ci-retry.sh, scripts/check-web-image.mjs) are never scanned (schema-parity.sh ~:34 has a legitimate `|| true` in an EXIT trap, so a scan needs an allowance).
3. Redis pub/sub is not database-scoped, so T489's database split does not isolate channels: module-activation-watch.test.ts ~:85, ~:93 publishes `haive:module-activated` in a later step and api modules/loader.ts ~:79 publishes it from app code a gated row may reach. Use a per-run channel prefix in tests, or check no gated row publishes it. From the T489 reviews.

### T503 · FNF[plan-chat-start-race] · a chat remounted during a pending start stays blind to the conversation it started

status: parked · reason: diminishing returns (2026-11-01 scan): Explicitly minor chat race requires switching nodes during the start request; resume when resume when users repeatedly create duplicate conversations through this race · priority: P4
From the T491 follow-up review (2026-10-31). PRE-EXISTING, minor (needs a node switch and back inside the POST). The old instance's post-send reload updates only its own unmounted state (web plan-chat.tsx ~:347 against the guard ~:160-167) and `onPatched` refreshes the page, not the chat; the start route has no guard against a second live conversation for the node (api plan.ts ~:1406-1450, lib/spawn-plan-task.ts), so a second Send can start another. Fix: re-read the node's conversations when the remounted chat sees a send in flight, and refuse a second live start for the node.

### T506 · FNF[plan-panel-codes] · the plan chat's End and the detail panel's stale edit still read error messages; small T491 control gaps (+5)

status: parked · reason: diminishing returns (2026-11-01 scan): Entire bundle is minor error presentation, coverage gaps, or currently unreachable callback behavior; resume when resume when recovery failures materially prevent plan interaction · priority: P4
From the T491 third review (2026-10-31). PRE-EXISTING unless stated; minor.

1. PlanChat `finish()` prints the raw 409 ("No step awaiting form submission ...") when End is refused with `step_form_not_waiting`, and neither re-reads the transcript nor restarts the poll (web plan-chat.tsx ~:375-377), while `send()` handles the same code (~:353-358).
2. plan-detail-panel.tsx ~:213 detects a stale-version edit with `/modified by someone else/i` on the message, although the api sends `code: 'plan_conflict'` (api plan.ts ~:129-138); a reworded message drops the tailored banner (~:529-534).
3. The api `DELETE /:id/plan/merge` comment (plan.ts ~:1383-1384) says the checkout has not moved and names only a live conversation; the worker also keeps the worktree for a newer failed one and a cancel after the land leaves a moved checkout. Comment only.
4. New with T491, control gap: nothing pins the `clearTimeout` in the merge panel's recovery cleanup (plan-merge-panel.tsx ~:153); and the recovery's `try` also wraps `setNotice` and `onSettledRef.current()` (~:138-148), so a synchronous throw from the page callback would count as a failed read and retry (cannot happen today).
5. New with T491: the plan chat retries a persistently failing transcript read forever with no backoff (plan-chat.tsx ~:264-272); the task-type creator stops on 404 (task-type-creator-panel.tsx ~:178-186). Also the chat keeps its own literal of the three ended statuses (~:259-262).

### T507 · FNF[fake-db-uuid-writes] · the test fake stores UUIDs as written, so it can hold case-variant duplicates PostgreSQL cannot (+2)

status: parked · reason: diminishing returns (2026-11-01 scan): Test fidelity and uncovered fake-database shapes only; resume when resume when fake behavior masks a concrete production regression · priority: P4
From the T385 F7 round 2 review (2026-10-31). PRE-EXISTING; minor (test fidelity only). Lines are at the T385 branch (PR #972).

1. `insertRow` rejects a duplicate only by `r.id === row.id` (database src/testing/fake-db.ts ~:481): the same id upper-cased inserts a second row. The same `===` class sits at the ON CONFLICT target match (~:509 `onConflictDoUpdate` leaves both rows; ~:530 `onConflictDoNothing({ target: id })` inserts a second), the FK cascade (~:574-575: a child whose FK is spelled upper-case survives its parent's delete) and the test-side `patch` (~:583 throws "no row"). Since T385 (3412f10f1) `where eq(id)` matches both variants. Fix direction: canonicalize UUID values to lower case on write (`Object.assign(row, values)` ~:476, `compileSet`, `patch`), one control per site.
2. `ne`, `inArray` and `notInArray` on timestamp columns compare Date objects by reference (~:335, ~:343-346; `eq` handles Date at ~:314-317): for an equal-time distinct Date, ne is true (PostgreSQL false), inArray false (true), notInArray true (false).
3. Optional: the negated correlated EXISTS gate keeps 8 of 19 shape checks unpinned (`ch.length === 2`, `text(ch[0]) === 'not '`, `is(ch[1], SQL)`, `sub.length === 11`, `is(sub[3], PgUUID)`, `is(sub[5], PgUUID)`, `is(sub[7], Column)`, `is(sub[9], Column)`); no current input differs.

### T508 · FNF[relink-commit-unknown] [verify-first] · after a lost COMMIT acknowledgement the relink restores git blindly, leaving the row new and git old

status: open · gate: bounded verification · user decision: recheck risk-bearing members, 2026-11-01 · priority: P2
From the T376 fifth review (2026-10-31). PRE-EXISTING on the T376 branch (80cb7aa97), documented, minor (needs a connection loss at COMMIT).

The remote relink (api routes/repos.ts, the outer catch after `db.transaction`) restores git's remote after a COMMIT failure or a lost connection without learning whether the transaction committed. A COMMIT whose acknowledgement was lost leaves the row's `remote_url` and credential binding new, the `repository.remote.update` audit row present, and git on the old remote. Fix direction: after a connection-class error, read the row on a fresh connection and align git to it instead of restoring blindly. Related, third-party (needs approval, not started): postgres.js 3.4.9 keeps running an abandoned transaction callback after `onclose` rejects `begin`, and its `tx` handle can write through a connection the pool has re-opened (`index.js` ~:243-246, ~:291-296, ~:421-427), so a late `UPDATE` could land outside its transaction.

Also (T376 sixth review, by reading): the relink has no hard deadline and no process-death recovery. A git child in uninterruptible I/O (a `localPath` repository on 9p) survives SIGKILL, so the request, the repository row lock and a pooled connection stay held; and an api restart or crash between BEGIN and COMMIT leaves git on the new URL with the row old and no audit row. The reconcile-on-read direction above repairs the drift; a hard deadline on the helper that fails the request and logs the stuck pid bounds the hold.

T376 review9 carry-forward: a mutating git child killed after its config rename but before exit returns exitedClean:false, so restoration may not be armed (repos.ts ~:2791-2807). PRE-EXISTING, narrow; internal git ordering unmeasured. Share the reconcile-to-database direction above rather than another branch-local restore rule.

Executable verification scope: Bounded COMMIT-acknowledgement and process-death drift reproduction, then a reconciliation design. Third-party dependency changes require their own reviewed scope; no broad transaction rewrite. No automatic full-bundle repair: prove a supported current consequence, then scope the fix; park the remainder.

### T509 · FNF[swallow-rule-shape] [design] · the CI swallow pin lists failure-masking shapes instead of judging what follows `||`

status: parked · reason: diminishing returns (2026-11-01 scan): Hypothetical failure-masking spellings do not occur in pinned jobs today; resume when resume when a real workflow uses an unrecognized masking form · priority: P4
From the T489 fourth review (2026-10-31). PRE-EXISTING, minor (none of these occurs in the pinned jobs today).

The swallow rule in scripts/test/shell-source.mjs (`swallowedFailure`) rejects a fixed list of forms (`|| true`, `|| :`, `|| exit 0`, `set +e` and a few spellings), so every other way to mask a failure passes: `cmd || echo ...`, `cmd || { echo warn; }`, `cmd || { ...; exit 0; }`, `|| return 0`, `|| continue`, `|| break`, `|| exit "0"`, `|| exit 00`, `|| \true`, `|| command true`, `|| builtin :`, `|| /usr/bin/env true`, `|| $(true)`, `|| test 1`, `|| [ 1 ]`, `|| true>/dev/null`; and `set` changes in a later option group or position: `set -u +e`, `set -eu +e`, `set +x +e`, `set +eo pipefail`, `set -o pipefail +o errexit`, `(set +e)`, `if set +e`, `! set +e`, `time set +e`. Decision needed: judge the right side of `||` (allow only a handler that ends in a non-zero exit, or an explicit allow-list with a reason) instead of extending the list. Single.

### T510 · FNF[fs-safe-resource-errors] · lenient fs-safe reads take running out of descriptors for an absent entry (+4)

status: open · gate: bounded verification · priority: P2
From the T365 fix round 1 (2026-10-31), verified against cx-365. PRE-EXISTING.

1. Consequential but silent: `readResult` (packages/shared/src/fs-safe.ts ~:304-319) returns `null` in lenient mode for every errno that is not a containment refusal, EMFILE and ENFILE included, unless the caller passes a `rethrow` set (only the T365 walks do). So `openFileNoFollow`, `readFileNoFollow`, `readdirNoFollow` and `lstatNoFollow`, called leniently by many worker steps, read a descriptor shortage as "the entry is not there" and act on it. Needs a caller audit before the default flips: list the lenient callers, decide per caller whether a resource error should throw, then make `RESOURCE_LIMITS` rethrow by default.
2. Minor: the bundle file listing (api routes/bundles.ts ~:980-1015) bounds files, depth and descriptors but not directory count, so a bundle of millions of empty directories is walked to the end.
3. (T365 review 3, by reading) Four lenient checks ahead of a strict read misread running out of descriptors, so T365's 500 for EMFILE/ENFILE never fires there. PRE-EXISTING, minor. api routes/tasks/files.ts ~:240-253 `openEditableKnowledgeFile` keeps its own containment mapping and answers 400 "File cannot be opened for editing" (rethrow `isResourceLimitError` before ~:253; the release is in a `finally`); routes/user-settings.ts ~:477-478 a lenient `lstatNoFollow` before the strict open answers 404 "Sound file missing on disk" (drop it and take the size from `fh.stat()` as tasks/files.ts ~:162-169 does); lib/upload-complete-claim.ts ~:174-176 `isWholeFile` reads it as "not whole" and the three complete routes answer 409 "archive size mismatch on disk" (a retry succeeds; the message is wrong); routes/tasks/_helpers.ts ~:1103 `resolveWorkspaceRoot` answers 409 "worktree ... was removed".
4. (T365 review 3, design direction) api lib/fs-http.ts ~:33 still answers 400 "Path cannot be read" for every errno it does not map (EIO, ENOMEM, ESTALE, ETIMEDOUT), with no error line: a host fault blamed on the client. Allow-list the errnos that are about the path (EACCES, EPERM, ELOOP, ENAMETOOLONG, EISDIR) for the 400 and let the rest reach the 500. Minor.
5. (T365 review 3, latent) shared fs-safe.ts ~:524 `readdirNoFollow`'s `maxEntries` overflow is a plain `Error` known only by its wording, which fs-safe.test.ts ~:176-178 matches; no production caller passes `maxEntries` yet. Give it a code (as `WalkDepthError` has) when a caller appears. Minor.

Execution fence 2026-11-01: Start with a named current caller that mistakes a resource/read failure for absence; require a supported consequence before changing lenient defaults or broadening to every caller.

### T511 · FNF[bounded-vendor-bodies] · vendor and user-supplied endpoint bodies are read whole before they are cut or parsed (+4)

status: open · gate: bounded verification · user decision: recheck risk-bearing members, 2026-11-01 · priority: P2
From the T365 fix round 1 (2026-10-31), verified against cx-365. PRE-EXISTING, memory only (no secret path). See also T496 (vendor-call deadlines).

1. User-supplied Ollama URLs: api routes/tooling.ts ~:89 and ~:191 (`resp.json()` of `/api/tags`, `/api/show`, bounded in time only); shared rag/embed.ts ~:108 (`resp.text()` then a cut), ~:111, ~:179, ~:210 (`resp.json()`); worker cli-adapters/ollama-probe.ts ~:107 (`resp.text()` of the error body).
2. Fixed vendor hosts: claude-oauth.ts ~:158-162, grok-oauth.ts ~:140-145, usage-window/fetchers/claude-code.ts ~:54 and codex.ts ~:75, cli-versions/model-prices.ts ~:96, cli-versions/ruby-versions.ts ~:94, sandbox/integrations-mcp-server.ts ~:51/~:76, sandbox/rag-mcp-server.ts ~:71-74.
3. Two private chunked bounded-read copies (shared forge/base-forge.ts ~:106, api lib/module-vendor-client.ts ~:102) beside the exported `readForgeJson` and `readForgeErrorExcerpt` that T365 adds.
4. Fix direction: reuse T365's `readForgeJson` / `readForgeErrorExcerpt` everywhere (bounded read, stream cancelled past the bound, fixed message without the body), after T365 lands.
5. (T365 review 3) api github-oauth.ts ~:119: a bare `catch` words a timeout or network failure as "answered something other than a repository list". Key the message on the error class (timeout, abort, parse) instead. Minor.
6. (PR #1054 review) Worker user-set sites shipped (ollama-probe.ts, openrouter-compat.ts, zai usage fetcher; `readBounded` now exported from `@haive/shared/forge`). Left: fixed-vendor usage bodies claude-code.ts ~:55, codex.ts ~:79, gemini.ts ~:48, grok-oauth.ts ~:175,180 (member 2); api module-vendor-client.ts ~:102 now duplicates the exported `readBounded` (member 3); the probes return on 2xx (OpenRouter on any non-400) without cancelling the body, holding the socket to the 20 s abort; an OpenRouter 400 body whose read fails mid-way still returns `compatible: false`. Minor.

Executable verification scope: Prioritize user-supplied endpoint bodies and a safe bounded over-limit reproduction. Trusted-vendor generalization, helper deduplication and error wording remain deferred. No automatic full-bundle repair: prove a supported current consequence, then scope the fix; park the remainder.

### T512 · FNF[retry-cannot-help] · the repositories page offers Retry on an errored repository whose message says Retry cannot help

status: open · kind: feature · user decision: resolved 2026-11-01 · priority: P2
From the T397 fix round 4 (2026-10-31). Minor (UX); arrives with T397.

After T397 a refresh that finds a `.git` git refuses (exit 128) but that no structural read proves dead ends `error` with a message saying Retry cannot help until the checkout is repaired and that removing and re-adding the repository rebuilds it. The repositories page still offers Retry for every `error` row, and it must not key on the message text (AGENTS.md: a message is display copy). Decision needed: a structural signal (for example an error code column on `repositories`, written with the status) that the page reads to hide Retry and offer remove-and-re-add, or keep Retry (it is harmless, three attempts) and only reword. Single.

User decision 2026-11-01: Add a structural repair-needed error code and a dedicated recovery action; do not gate on message text.

User explicitly selected the structural-code/recovery-action option rather than copy-only cleanup. State is gated on a structural column/code, never status_message text. Preserve repository data through the recovery flow.

### T513 · FNF[test-env-hygiene] · test environment, fixture cleanup and measured flake leftovers

status: parked · reason: diminishing returns (2026-11-01 scan): Entire bundle concerns test environment dependence, temporary files, duplication, and load-sensitive fixtures; resume when resume when these failures block required CI or dependable local validation · priority: P4
From the T498 builder and the T365 fix round 2 (2026-10-31). PRE-EXISTING, minor (test hygiene only).

1. `computeBuildStamp outside a checkout` ("with a release version", "with a release candidate", worker test/build-stamp.test.ts ~:312) answer `unknown` instead of `release:0.2.0` / `release:0.3.0-rc.1` on this host, on the unchanged base too and with the default TMPDIR (T498 evidence `buildstamp-BASE-unchanged-code.log`); CI is green. Find what the host differs in (a git checkout above the temporary directory, an environment variable) and make the test independent of it.
2. api test/onboardable-source.test.ts ~:8 and test/repo-artifact-reset.test.ts ~:1829, ~:1849 create `mkdtemp` directories they never remove (seventeen left after one run). Remove them in `afterEach`.
3. (T376 seventh review) `answeredWithin` has six copies (api test/auth-throttle.test.ts ~:211, repo-link-remote.test.ts ~:72, repository-security-audit-db.test.ts ~:66, integration-mcp-db.test.ts ~:514, integration-mcp-module-db.test.ts ~:407, integration-mcp-module-extras-db.test.ts ~:359); move it into the shared gated helper (`security-audit-db.ts`). Minor.
4. (T498 fix round 1) worker test/project-state-write-bounds.test.ts ~:145 (4,090 claims) takes 55-97 s alone and hit its 120 s timeout in 3 of 3 full worker runs at default parallelism on a host at load average 30-47; it passes alone. Not yet shown failing on unchanged code under the same load. Shrink the fixture or give the file its own timeout. Minor.

5. T376's concurrent allow-list PUT bound control (api repository-security-audit-db.test.ts) failed once under load and passed alone/later; its 2000/300/1000ms wall budgets are timing-sensitive. PRE-EXISTING test limit, reproduce before changing deadlines.

6. From T364 item8: worker repo/worktree-changes.test.ts:191 failed once in a full run under load (expected 1, got 0); 65 replays could not reproduce. Flake, cause unknown.

7. From T364 item17: (T119 review, 2026-10-30) PRE-EXISTING, minor: worker scripts upgrade-claims-smoke.ts ~:382,387,392,781 find the conflict radio by its human label, because `conflictFieldId` (02-upgrade-apply.ts ~:402) is not exported; export it and key the smoke on the id. Item 16's upload-reaper timeout also showed in T119's full worker run.

8. From T364 item18: (T119 review, 2026-10-30) PRE-EXISTING, minor: the two-install smoke fixture's shared record names agents nobody wrote, so a fresh clone's plan offers 3 unrelated entries; make the fixture's record match what its installs wrote.

9. From T364 item19: (T401 review, 2026-10-30) PRE-EXISTING, minor: tests/e2e/helpers/auth.ts ~:46 `recordRegisteredUser` is module-private, so a user minted by `POST /admin/users` (as in forced-password.spec.ts) is unknown to the global teardown and the `users` fixture; a timed-out run leaks it until the CI database is dropped. Export it (or a registration helper for admin-minted users) and record such users.

10. From T364 item21: (T119 fix review, 2026-10-30) PRE-EXISTING, minor: api test/repo-artifact-reset.test.ts ~:1829,1849 create temp dirs under `os.tmpdir()` and never remove them; clean them up in an `afterEach`.

11. From T364 item22: (T448 review, 2026-10-30) PRE-EXISTING, minor: the UI-login e2e specs click submit right after `fill` with no hydration signal (tests/e2e/auth/forms.spec.ts ~:32,69,99,124 and harness/session-recovery/session-ordering.spec.ts); a click that beats hydration is a native navigation (a POST since T448), so the race remains. Wait for a hydration marker before submitting. Since T449 (PR #946) only a click that beats hydration remains, and its helpers `holdScripts`, `reactAttached` and `waitForReact` (tests/e2e/auth/prehydration-submit.spec.ts ~:89-107) now live in tests/e2e/helpers/hydration.ts (moved by T454) for this fix to import.

12. From T364 item23: (main CI on 02a25e357, 2026-10-30) PRE-EXISTING since T118, flaky: worker test/onboarding-recorded-membership.test.ts `tree()` (~:287) reads every file under the fixture repository, `.git` included, right after the fixture's `git commit` (~:340-345, ~:442-445), and the detached `git maintenance run --auto` that commit starts creates and removes `.git/objects/maintenance.lock` in between: `ENOENT ... open '.../.git/objects/maintenance.lock'` (run 41136606433). Give the fixture's git calls `-c maintenance.auto=false` (or skip that lock in the walk), and grep the other tests that walk a git fixture after a commit for the same race.

13. From T364 item27: (T454 review, 2026-10-31) PRE-EXISTING, minor, dev hosts only: tests/e2e/repos/create.spec.ts ~:17 `findFirstGitDir` counts hidden git directories while the UI hides them, so the local_path case fails on a host with e.g. `~/.nvm` (identical before T454).

14. From T364 item31: (T376 sixth review, PRE-EXISTING, test hygiene) eight older gated files create a refusal trigger with a plain `CREATE TRIGGER`, no `DROP TRIGGER IF EXISTS` and no leftover guard in `beforeAll`: admin-security-audit-db.test.ts ~:42, admin-config-pool-db.test.ts ~:212, integrations-audit-db.test.ts ~:76/~:92, maintenance-routes-db.test.ts ~:145, repo-credentials-audit-db.test.ts ~:40, tooling-app-auth-atomic-db.test.ts ~:53, integrations-broker.test.ts ~:1352, module-deactivation-db.test.ts ~:1181 (global-kb's `refuse_store_write` is dropped only in `afterEach`). A killed run fails the next run once in a persistent database; T376 fixed its five files with `CREATE OR REPLACE FUNCTION` plus `DROP TRIGGER IF EXISTS`.

### T514 · FNF[sweep-redrive-budget] [design] · the stalled sweep re-drives a step with nothing live every cutoff, with no budget

status: parked · reason: diminishing returns (2026-11-01 scan): Minor defensive redrive scenario has no known looping producer; resume when resume when a real step repeatedly redrives without progress · priority: P4
From the T498 review (2026-10-31). PRE-EXISTING design, minor. No sweep shape counts its re-drives: a step that re-parks `waiting_cli` (or stays `running`) with nothing live gets its row and task stamps refreshed by handleResult (worker task-queue.ts ~:2029-2041) and `markCliParkBegin`, so the sweep takes it again every cutoff, each time with an epoch bump and a `step.waiting_cli` event. No in-tree producer is known to loop this way (the DAG `!issue.cliInvocationId` branch, dag-executor.ts ~:2813-2817, is defensive), but T499 item 4 is one way in. Design direction: count consecutive sweep re-drives per (task, step, round) in a task event and stop at N with a visible failure, as `CANCEL_REDRIVE_MAX` does for cancels.

### T515 · FNF[advance-epochs] · two advances still carry no epoch: the auto-continue toggle's, and the one after an auto-resume that bumped none (+3)

status: open · gate: bounded verification · user decision: recheck risk-bearing members, 2026-11-01 · priority: P2
From the T498 review (2026-10-31). PRE-EXISTING, minor. Same class as T498 item 4 (the usage poller's advance now carries the task's epoch).

1. api routes/tasks/index.ts ~:1210-1225: the auto-continue toggle queues an advance for the current form step with no epoch; `advanceChainHasMoved` (worker task-queue.ts ~:2772) drops one whose pointer moved, not one a Retry of the same step made stale.
2. worker queues/_step-reset.ts ~:222-400 `autoResumeFailedStep` reopens a failed task without bumping the epoch, while every api reopen does (`moveTaskToStep`, api steps.ts ~:356), although its header says it mirrors them. A same-epoch job left from before the failure is not made stale by the auto-resume. Fix direction: bump the epoch with the reopen (and return it, so the poller's T498 stamp need not read it back).
3. (T471 fix round 1) A second submit to a parked form whose wait is already closed (`waiting_form`, NULL marker, not yet picked up) is accepted: it writes its form values over the first answer's and queues another advance (pinned as accepted by T471's control C3). PRE-EXISTING, minor. Fix direction: an answered marker the submit can test, or refuse when the step already has form values for this round.
4. (T498 fix round 1) The PR-wait auto-finalize advance (worker queues/pr-poll-queue.ts ~:276) carries no epoch either; since T498 it is at least retried in the process. PRE-EXISTING, minor.

Executable verification scope: Current epoch/stale-submit producers and accepted-answer race. User decided first accepted answer stands; identical retries are harmless and conflicting replacements are refused. No automatic full-bundle repair: prove a supported current consequence, then scope the fix; park the remainder.

### T516 · FNF[relink-row-hold] · writers of a repository row wait behind a relink that holds it across git, bounded only by the relink's own git deadlines (+3)

status: open · kind: fix · policy: covered by accepted bounded-wait/consistency rules · priority: P2
From the T376 seventh review (2026-10-31). REGRESSION of the T376 branch (origin/main's relink took the row only for its final update), minor to moderate, by reading and PostgreSQL semantics, not reproduced. Arrives with T376.

1. The relink holds the repository row `FOR NO KEY UPDATE` across its git calls (api routes/repos.ts). T376 bounds four explicit row takes, but plain `UPDATE repositories` statements still queue behind it with no bound: repos.ts ~:240 (`addRepoJobOrMarkError`), ~:3138 (mark-onboarded stamp), ~:3410 (artifact reset), ~:3679 (refresh-tree), tooling-upgrades.ts ~:284, ~:780, and the root claims (database src/repo-root-claim.ts ~:102, ~:144, ~:192, taken by mark-onboarded, the onboarding-artifacts DELETE and every repository-root file save). Worker transactions take the task-creation and project-state keys and then the row `FOR UPDATE` unbounded (project-state/write.ts ~:714-727 and ~:1319-1392, 04-upgrade-rollback.ts ~:1092-1103, 12-post-onboarding.ts ~:424-434), so an api task start answers 409 busy while a relink holds the row. 02-upgrade-apply.ts ~:826-843 is the bounded exception. Today the wait ends with the relink's git deadlines (10 s plus a 2 s grace per call) and not at all for a git child in uninterruptible I/O (T508). Design direction from the review: serialize relinks with a per-repository advisory key taken in `boundedLockWait`, hold the row `FOR KEY SHARE` through git (it blocks the delete, which takes `FOR UPDATE`), and take `FOR NO KEY UPDATE` only for the final UPDATE; the audit metadata (`credentialsChanged`, `branchChanged`) then needs a re-read at the end. Note (session): `FOR KEY SHARE` removes the plain-UPDATE waits only; it still conflicts with the worker's and the four writers' `FOR UPDATE` takes, so those would need `FOR NO KEY UPDATE` or the bound.
2. Test pin: api test/repository-lock-ratchet.test.ts lists helper names only, so a direct `.for('update')` select of `schema.repositories` outside `boundedLockWait` is pinned only by gated controls. Extend the AST walk to flag one.

3. T376 post-commit RAG Retry probe can find pending hash rows after the save cleared degradation. Its bounded restore returns200 if a relink holds the row, leaving dense search enabled until a sync repairs the flag. Accepted branch trade-off, documented; preserve correctness across relinks in this design. A non-busy restore error instead returns500 after the save committed and skips the audit log (durable audit row exists); a Retry no longer has the old degraded stamp to trigger that restore (tooling-upgrades.ts ~:1047-1070).
4. During forceRagReembed, only each repository update is locked: a remote relink can occur while external batches execute (tooling-upgrades.ts ~:954-964). PRE-EXISTING integration limit; revalidate the relevant stored settings or serialize the operation when designing the broader row hold change. The bounds are per statement, not a whole-request deadline.

Engineering scope derived from the accepted policy (2026-11-01), not a new owner decision: Follow the selected bounded-wait and data-preservation policy. Shorten row holds only with proven audit/restore, delete and project-state invariants; do not turn this into an unbounded repository-writer audit.

### T517 · FNF[web-updater-side-effects] · the sidebar's filter and collapse toggles send their PATCH from inside a state updater

status: parked · reason: diminishing returns (2026-11-01 scan): Development-only duplicate PATCHes are harmless absolute-value writes; resume when resume when updater side effects cause production-visible incorrect writes · priority: P4
From the T365 sixth review (2026-10-31). PRE-EXISTING, minor (development only).

1. web components/sidebar-nav.tsx ~:116-120 (`toggleFilter`) and ~:128-132 (`toggleCollapsed`) call `void patchUiPrefs(...)` inside a `setState` updater, the shape T365 removed from the bundle composer. React's StrictMode (on in next.config.mjs) calls an updater twice in development, so each click sends two PATCHes; harmless because `patchUiPrefs` writes an absolute value (api-client.ts ~:2360-2364), and use-persisted-toggle.ts ~:41-58 documents the same trade on purpose. Fix direction: compute the next value from the closure and PATCH after the `set` call.

### T518 · FNF[composer-poll-races] · the bundle composer's poll can write back a stale answer, overlap itself, and miss a reload after a click

status: open · gate: bounded verification · priority: P2
From the T365 close-out (PR #974, 2026-11-01). PRE-EXISTING, minor, found by reading: web components/bundle-composer.tsx, lines as on main after #974.

1. `fetchOnce` (~:256-318) compares a poll answer computed at request time with the value it reads after its awaits, so a poll in flight when the person accepts a Resync or Replace ZIP writes the older server status over the newer local `syncing` and starts the listing reload early (T365 review 6). A Codex round that fixed it was cut off by a crash; its partial patch is `.claude/tmp/codex-run/T365/codex-7/interrupted-uncommitted.patch` on the machine that ran it. Fix direction: drop an answer whose request started before the last local status change (a counter bumped on Resync and Replace).
2. The interval (~:320-322) starts a new `fetchOnce` while a slow one still waits, so two polls can both see a sync end and each reload the listing before the next render (T365 Codex review 7). Fix direction: skip a tick while a poll is in flight, or record handled transitions per bundle.
3. Theoretical: `toggleExpanded` (~:215) decides "load needed" from its render closure's `filesByBundle`, while the poll's drop is dispatched from a promise continuation on React's Default lane, so a click between that continuation and its render can skip the reload (T365 review 6, D6-2). Fix direction: a loader driven by an effect on the expanded and dropped state.

Execution fence 2026-11-01: Prove a supported stale/overlapping poll result and its visible consequence. The theoretical render-lane click edge does not automatically join a fix.

### T519 · FNF[redrive-connected-leftovers] · verify PR-poller error visibility and refusal settlement guards

status: open · gate: bounded verification · executable members: 2,3 · priority: P2
Queued connected findings from T498 PR #977; not part of the authorized seven-task delivery. PRE-EXISTING unless stated; minor.

1. MOVED to T525 (parked optional recovery coverage/display/diagnostics); original evidence retained there.
2. worker queues/pr-poll-queue.ts ~:127-135: early re-drive runs outside try/catch; runPrPollTick discards Promise.allSettled results, hiding a failure. Catch/log per-task refusal or inspect settled results.
3. worker step-engine/dag-executor.ts ~:2726-2739: refusal UPDATE lacks an outcome='pending' guard; add the same CAS guard as sibling settlement.
4. MOVED to T525 (parked optional recovery coverage/display/diagnostics); original evidence retained there.
5. MOVED to T525 (parked optional recovery coverage/display/diagnostics); original evidence retained there.

Reconciled 2026-11-01: no automatic follow-up coverage or cosmetic changes. Members1/4/5 moved to parked T525; verify current caller reach and consequence for2/3 before implementation.

### T520 · FNF[shell-scanner-limits] · CI shell scanner cannot see several unused wrapper forms (+4)

status: parked · reason: diminishing returns; none of these shapes occurs in the scanned workflows; resume when a real workflow needs one or a masking failure is measured · priority: P4
Queued broader findings from T489 PR #975, review-6 and codex-rev-6/last.txt. PRE-EXISTING, minor; no additional implementation authorized.

1. scripts/test/shell-source.mjs: generated shell input such as bash -c "$(cat <<'EOF'...)" or bash < <(cat <<...) is not inspected as executable shell.
2. Combined bash -ce / sh -ce options hide the command string.
3. su -lc and absolute /usr/bin/ssh wrappers are not recognized.
4. Escaped whitespace before # can be mistaken for a comment (~:154).
5. The suffix rescan (~:23) can be quadratic for a long script. Keep the scanner proportional to the fixed first-party workflow corpus; avoid building a general shell parser.

### T522 · FNF[git-text-redaction-limits] · unusual URL delimiters and pathless query-at-signs evade text redaction (+1)

status: parked · reason: diminishing returns (owner triage 2026-11-10); resume on a user report, a measured failure, or a change in the same code · priority: P2
Queued connected findings from T376 review10, verified with synthetic pure-node inputs on both parent and final shared dist. PRE-EXISTING, low; neither measured git2.43.0 nor2.54.0 emits the whitespace placeholder shape. No broader implementation authorization.

1. shared schemas/git-url.ts ~:252-270: an ordinary prefix ending in colon followed by whitespace/quotes or a placeholder with inner whitespace can keep username and trailing query text. Structural ambiguity with prose needs a caller-backed design; do not match a literal placeholder word.
2. Authority search ends at slash/next scheme but not ?/#, so a pathless URL with @ in its query can misidentify the host and show a query suffix as host. Terminate authority at URL grammar boundaries. Existing git remotes in measured paths carry a path; establish actual caller reach before a new fix round.

### T523 · FNF[git-config-environment] · API readers and worker writers do not share one explicit ambient Git configuration policy

status: parked · kind: security · user decision: resolved 2026-11-01; parked by owner 2026-11-10 · priority: P2
Reproduction gate 2026-11-10 found no current trigger: api readers (haive-data-status.ts ~:54-58, routes/plan.ts ~:166) pass only PATH, HOME and GIT_CEILING_DIRECTORIES; the worker's `gitEnv` (worker repo/git-exec.ts ~:83-99) passes its full environment, but neither container sets any XDG_* or GIT_* variable and the only system config is /etc/gitconfig (`safe.directory=*`). A scratch repro shows the two diverge only once such a setting exists (e.g. `status.showUntrackedFiles=no` via XDG or GIT_CONFIG_COUNT). Resume when a container, deploy or user setup adds an XDG__/GIT_CONFIG__ setting or a reader/writer mismatch is observed. Evidence: .claude/tmp/codex-run/T523-S/gate.md (local).
Queued design split from T521 item4; no additional implementation authorized. PRE-EXISTING, narrow compatibility issue. HOME handling was aligned in T120 PR1b, but XDG_CONFIG_HOME and GIT_CONFIG_* can still make API status readers and worker writers resolve different configuration. Decide whether the supported contract preserves selected ambient configuration for both or supplies an isolated explicit configuration. Establish a current caller/reproduction before changing global Git policy. Executable repository filters remain T387, not a member of this decision.

User decision 2026-11-01: Use one explicit isolated Haive Git configuration for API readers and worker writers, allowing only deliberately supported settings.

T387 closure scope 2026-11-01: new archive imports now sanitize config/refuse partial or unsafe layouts. Its original env-only-lever observation (GIT_ALLOW_PROTOCOL/GIT_NO_LAZY_FETCH propagation) is not claimed fixed for other host Git callers; preserve it as context for this explicit configuration-policy decision. Existing current-caller/reproduction gate remains, with no new broad audit or retroactive repository sweep implied.

### T525 · FNF[recovery-polish] · optional recovery coverage, display and diagnostic leftovers

status: parked · reason: diminishing returns · user confirmed 2026-11-01 · priority: P4
Split from T499/T500/T519 so correctness work does not automatically authorize these members. Resume a member only for a demonstrated production consequence, a blocking required check, or a related change that makes its control necessary. Original member IDs are preserved below; do not execute this as a blanket cleanup batch.

1. From T499 item2: The worker's `autoResumeFailedStep` (_step-reset.ts ~:338-350) re-opens a row without `startIfNeverStarted`; the helper would move into @haive/database first. Not reachable in practice.

2. From T499 item3: Other writers still book a pre-run park the old way (terminal rows, nothing mis-billed): api lib/cancel-task.ts ~:92, worker task-queue.ts ~:3993, api task-control.ts ~:207-215 `settleActiveStepsIn`.

3. From T499 item5: Cosmetic: slot-wait-badge.tsx ~:40 unreachable fallback "Queued for a slot"; the "Waiting for slot" filter wording now also lists module-setup parks (web tasks/page.tsx ~:498, shared schemas/tasks.ts ~:440-441, api tasks/index.ts ~:250); cli-park-timing.ts ~:15 still calls the marker the runtime park's signature; stalled-redrive.test.ts ~:463-469 titles read as sweep rules though they test `redrivableRow`; the handleResult 'deferred' enqueue is pinned by no control (it must stay free of the dedup id); a module step that declared `needsRuntime` reads as module (slot-wait.ts ~:126).

4. From T499 item6: (T498 review) The stalled sweep's new `waiting_cli` re-drive does not restamp the park marker as boot does (`foldOrphanedCliParkOnBoot`, worker cli-park-timing.ts ~:216-243): a row with no marker (the handler died between the run-end write and `markCliParkBegin`) bills the gap until the re-drive as work (shared timing.ts ~:77-85). Statistics only, minor.

5. From T500 item1: `markTaskDeadOnStep` (worker task-queue.ts ~:812-829) does not log a lost write.

6. From T500 item2: The revise selfLoop `markTaskFailed` (~:2323-2330) ignores its return.

7. From T500 item5: (T498 review) worker queues/cli-exec/handlers.ts ~:501-502: in the failure path `await resumeStepIfLinked(...)` runs before `throw err`, so a refused continuation add replaces the CLI's own error in the job's failure record. Keep the CLI error (attach the add failure as its cause, or log it and rethrow the original). PRE-EXISTING, minor.

8. From T519 item1: COVERAGE ONLY for the new T498 path, not a confirmed production defect: worker step-engine/dag-executor.ts ~:2791-2794 claim-lost half has no direct pin. Existing recovery behavior is reviewed; extend a control when changing that path.

9. From T519 item4: worker queues/task-queue.ts retrying: warning says boot re-drive for non-boot callers; cosmetic, name the enqueue operation.

10. From T519 item5: worker queues/usage-poll-queue.ts: provider-recovery polling pays up to four seconds per refused task, serially. Consider a bounded batch if measured latency matters.

### T526 · FNF[save-index-candidates] · verify stale staging and plan-deletion index-repair retries

status: open · gate: bounded verification · priority: P2
Split from T521 items1/2, 2026-11-01. Establish a current supported reproduction and preserve unrelated staged changes before implementation; do not expand to generic Git/index cleanup.

1. From T521 item1: onboarding/_stage-paths.ts known-path staging can retain stale index entries during a committing-path save. Recompute the owned path set and compare held HEAD before declaring index sync complete.

2. From T521 item2: project-state/commit.ts plan-file removal/no-op repair (~:105) rebuilds deletion intent from current disk and HEAD, so a prior removed projection can be absent from both after an index-sync failure; verify plan.json/plan.md removal retries separately from the fixed state-record case.

### T527 · FNF[save-index-guard-gap] · a concurrent HEAD move can follow the index-sync completion guard

status: parked · reason: diminishing returns · user confirmed routine/theoretical work stays parked, 2026-11-01 · priority: P4
Split from T521 item3. Existing synchronization promises a checked boundary, not a permanently atomic filesystem/Git transaction. Resume only for a caller-backed stronger contract or a supported reproduction with an incorrect user-visible result.

1. From T521 item3: syncRealIndex completion can still report indexSynced after HEAD changes immediately after its guard (~:297). Re-check the accepted commit boundary before reporting success; no stronger atomicity is currently promised.

### T528 · FNF[validation-false-green] · verify whether current checks can pass after a lost audit, missing fake table or unlisted gated file

status: open · gate: bounded verification · priority: P2
Split from T364 items1/13/14, 2026-11-01. This is three candidate ways validation could hide a defect, not three confirmed current false-green tests. First find a current failing control that goes green for the wrong reason. Stop and park if bounded verification finds no current case; no general fake-database framework or scanner expansion.

1. From T364 item1: recordAuditEvent catches a failed insert, so route tests over a fake DB pass with the audit lost. Fix: a shared helper that fails a test on a logged audit failure.

2. From T364 item13: (T306 review) PRE-EXISTING, minor to moderate (class hazard): database testing/fake-db.ts ~:169 throws a plain Error for a table the fake was not given, which a route turns into a 500 or a caught failure, so a test that expects a throw or a 500 can pass on the miss (proven for revive-beside-live, fixed in T306; not scanned for others). Fix: a sentinel error class and an afterEach check of misses.

3. From T364 item14: (T363 review) PRE-EXISTING, consequential: scripts/test/ci-gated-list.test.mjs ~:12 recognises a Postgres-gated test only by `pathname.startsWith(` or `CREATE|DROP DATABASE`, so a gated file with another guard idiom is invisible to the "every gated file has a GATED row" check and skips green in CI for ever (T363's DB file was the live case, fixed there). Fix: detect by `skipIf` plus a `*_URL` env var.

### T529 · FNF[metadata-comment-polish] · stale worker metadata explanation after task-level route retirement

status: parked · reason: diminishing returns; comment only, no runtime consequence · kind: documentation · priority: P4
Source: route-retirement follow-up review 2026-11-01, packages/worker/src/step-engine/steps/index.ts:119. The unchanged startup-assertion JSDoc describes task-row invalidation through providerSensitive metadata, while the task-level switch route is being retired by T338. The assertion itself still correctly checks metadata/list equality. Preserve as low documentation debt; update only on the next related documentation/source touch. No extra implementation/review round or runtime audit is authorized by this note. Evidence .claude/tmp/codex-run/queue-exec-20261101/route-retirement/review-comments.md.

### T530 · FNF[new-task-mobile-header] · New Task header overflows at375px

status: parked · kind: queued broader finding · reason: diminishing returns · priority: P3

Moved from T362 member2 so shipping the readiness fix does not mark this layout work complete.

2. QUEUED broader finding, PRE-EXISTING; not authorized for T118 or the design fix above: at 375px on an onboarded repository, the New Task header with Re-run onboarding + Cancel overflows horizontally and squeezes the description into a narrow column. `packages/web/src/app/(app)/tasks/new/page.tsx:817` uses a non-wrapping header/action row. Fix direction: responsive stacking/wrapping with a viewport control for both actions. Source is byte-identical to main; evidence `.claude/tmp/board-run/T118/browser-reset-cli/before-reset-375.png` and `T118/fnf-mobile-header.json`. Leave queued when T118 pauses.

Resume for an explicit owner priority change, a real mobile task-creation usability report, or a feature deliberately changing this header. The owner currently prioritizes functionality and demonstrated operational bugs; no broad UI audit is authorized.

### T587 · Cancel, step abort and plan discard clear an administrator's pause with no audit row (owner confirm)

status: open · kind: decision · found: #1058 review 2026-11-10 · priority: P4
PRE-EXISTING. Cancel (api tasks/index.ts ~:1379), step abort (tasks/steps.ts ~:1756) and plan merge discard (routes/plan.ts ~:1406) clear any pause, an administrator's included, with no `byAdmin` event or audit row. release.md ~:120 documents that they clear any pause; decide whether the audit trail should record it (a best-effort row like the Retry resume) or stay as documented.

### T588 · FNF[worker-audit-writer] · worker audit writer follow-ups (+5)

status: open · kind: fix · found: #1057 reviews 2026-11-10 · priority: P4

1. No worker mapping for a lock timeout: gate 4's bounded lock take and 02-upgrade-apply.ts ~:834-840 end the step with the raw PostgreSQL message; `isLockNotAvailable` exists in @haive/database (used by attachments/expand-archives.ts ~:687). PRE-EXISTING pattern, minor.
2. `packages/worker/src/audit.ts` duplicates the api's `insertAuditEvent`, `logAuditEvent` and `AuditEvent`, and metadata summaries are computed in both (worker audit.ts ~:78-91, api repos.ts ~:996-998); @haive/shared could host one copy. Minor, drift risk.
3. Worker rows carry `source`, `actorKind`, `fields`, keys no api row for the same action has; a consumer filtering on `source` sees only worker rows. The admin list reads metadata generically. Minor.
4. Gate 4's no-origin path replaces a saved remote and credential with the typed values (11a-gate-4-push.ts `persistPushOrigin` with `addOrigin`); audited and stated in the form since #1057, unchanged behaviour. PRE-EXISTING, minor; decide whether it should refuse instead.
5. `repository.scope.update` from the worker reports `addedCount` 0 when a null list becomes `[]`. Nit.

### T589 · FNF[encryption-key-and-seed-store] · boot key and seed store leftovers (+3)

status: open · kind: design · found: #1060 reviews 2026-11-10 · priority: P3

1. With no `CONFIG_ENCRYPTION_KEY` and an empty Redis (flush, new volume) `ensureEncryptionKey` (shared config.service.ts ~:939-967) generates a fresh key with only a warn, which orphans every secret encrypted under the lost key; it cannot tell a first install from a lost store. PRE-EXISTING, consequential, by design today; decide whether a non-empty secrets table should refuse to generate.
2. `getEncryptionKey` caches `null` for 30 s via `get()` before throwing (config.service.ts ~:1098-1117), so a recovered key stays unseen for up to the cache TTL when no env key is set. PRE-EXISTING, minor.
3. The seed's Redis compare-and-set runs inside the Postgres transaction but outside its rollback: a timed-out or ambiguous Redis write, or a COMMIT failing after it, leaves the grant applied with its audit row rolled back (worker private-endpoint-seed.ts ~:410-435). Same shape as the earlier `setIfAbsent`. PRE-EXISTING, minor.
4. Seed attempts count seed runs, not distinct boots (bootstrap retries and crash loops count), and a malformed `bootstrap:privateEndpointSeed` blocks the seed until deleted; both documented in api-auth.md. Accepted, minor.

### T590 · FNF[cli-auth-lock-followups] · CLI auth lock and sign-out follow-ups (+13)

status: open, owner-approved 2026-11-10 for items 1, 3, 5 (next session; handoff 2026-11-10g) · kind: fix · found: #1061 reviews 2026-11-10 · priority: P3

1. `DELETE /:providerId/usage-auth` and `DELETE /:providerId/secrets/:secretName` (api cli-providers.ts ~:1165-1230) take no auth lock, so a usage refresh that read the secret before the delete can write it back. PRE-EXISTING, moderate. Fix: take the lock (`withCliAuthLock`) like the writers.
2. A task's sync-back waits 30 s for the lock, then the task copy is removed (worker sandbox/task-auth-volume.ts ~:1312-1323); an open login dialog on the same CLI (up to 10 min) loses the token the task rotated. Accepted and documented (sandbox.md); waits are sequential per provider inside a step-summary slot. REGRESSION, minor.
3. The web stops polling a sign-out after 10 min (web lib/cli-jobs.ts ~:37) while the job's contention cap is 30 min, so the failure text never reaches the page and "Still queued behind running CLI jobs" is not the reason. PRE-EXISTING window, minor.
4. No lock-loss detection on the dedicated lock connection (database cli-auth-lock.ts): after a PG restart or `pg_terminate_backend` during a long login the holder still believes it holds the scope; migrate/lock.ts re-asserts the backend pid. REGRESSION, minor.
5. A busy scope answers the login WebSocket upgrade with 409, which the modal shows as "WebSocket error" (web components/cli-auth-banner-modal.tsx ~:234). New triggers: a second tab, a quick retry during teardown, a sign-out executing. REGRESSION, minor.
6. Dedicated lock connections are not capped; before a login container exists no session timer bounds the hold (api cli-login-banner.ts ~:318, ~:546). REGRESSION, minor.
7. `teardownContainer` (api cli-login-banner.ts ~:1459-1477) has no timeout around `docker remove` and now holds the auth lock while it hangs. PRE-EXISTING hang, minor.
8. `handleProbeJob` writes an `authStatus` computed before a sign-out that ran meanwhile (worker cli-exec/handlers.ts ~:705). PRE-EXISTING, minor.
9. LOGIN_CREATE's `chown -R` helper mounts the auth volume outside the lock (handlers.ts ~:1097); a sign-out can then fail with "volume in use". PRE-EXISTING, minor.
10. `job.updateData` in the sign-out contention path (handlers.ts ~:1158) is outside `deferJob`'s refusal retry; a Redis LOADING/OOM fails the sign-out with the raw error. Minor.
11. `dropCopiedSecretLikeProviderEnv` fails the destructive migration on a busy lock with no bounded wait (worker secrets/move-secret-env.ts ~:37-39, ~:105). Minor.
12. `GET /cli-providers` and `/:id` return `authGeneration` (api cli-providers.ts ~:224, ~:335). REGRESSION, minor (opaque, own-user).
13. Tests: the PATCH stale-read refusal for an unchanged present value (`|| authSettingsRequested`, api cli-providers.ts ~:616) has no test; api writer and move-secret-env unit tests mock `tryCliAuthLock` without asserting its scope (gated PG tests cover it); harvest's `lockWaitMs = 0` is not pinned; usage-auth complete and `writeProviderSecret` lock rows secret-then-provider while others go provider-then-secret (safe under the advisory scope; add a comment). Minor.
14. The sign-out scope-change retry (worker cli-exec/handlers.ts, after the lock) has no own attempt cap; only repeated settings changes inside the read-to-lock window keep it looping. Minor.

## Done

- T586 — a late CLI sign-out no longer deletes a newer login's credential: `cli_providers.auth_generation` (migration 0224) stamped at login and secret writes, the sign-out job skips a superseded login; one advisory lock per auth scope held by login, sign-out, sync-back, refresh and PATCH, with scope recheck after the lock — PR #1061 (f715e40a7), 2026-11-10. Follow-ups T590.
- T570 + T554 items 1-3 — encryption key SET NX winner (checked on every production read); private endpoint seed retries unresolved names (cap 10, admin save ends seed ownership); one shared allowlist lock name; item 4 invalid (egress guard already warns), item 5 no change — PR #1060 (5f90d186a), 2026-11-10. Leftovers T589.
- T373 sites + items 1-7 — strict admin audit rows (module, task-type, upgrade, CLI provider create/update/sign-out/login, admin pause lift), password-change throttle and failure row (400 `current_password_incorrect`), mixed RAG tooling save refused, module rows logged after commit — PRs #1058 (1f1064268), #1059 (8a56956d9), 2026-11-10. Leftovers 8-16 stay open under T373.
- T504 + T505 — worker writes of repository settings (project-state sync and resolve, clone import, 09_7 RAG scope) leave strict audit rows with source and actor; gate 4 binds the remote with a bounded row lock, an in-transaction row, add-only origin and restore, repairs on Retry and refuses an origin changed since the form — PR #1057 (b7309577c), 2026-11-10. Follow-ups T588.
- T492 — a house rule's approval lapse writes an audit row — PR #1056 (c58365e78), 2026-11-10
- T326 — an unreadable house-rules fingerprint reads as unread (could-not-verify) — commit 941e23608; closed at owner triage 2026-11-10
- T578 — nested repositories at the remaining commit sites — PRs #1042, #1045 (63aad40c2), #1046 (df288e668), 2026-11-09
- T581 — restrict who may change a Global KB entry — PR #1044 (0d73cb579), 2026-11-09
- T579 — restrict who may delete a Global KB entry — PR #1043 (4d7904a75), 2026-11-09
- T425 — gate 3 refuses an unregistered nested repository instead of committing a gitlink with no url — PR #1039 (435cc78c9), 2026-11-09
- T558 — FNF[global-kb-ollama-url-write]: Global KB Ollama URL, embed model, dimensions and archive retention admin-only — PR #1037 (dd9d5a733), 2026-11-09
- T546 — config-outage readers hold instead of defaulting open: the reaper keeps runners whose grace it cannot read, refused defers retry for 60 s, boot migrations rethrow a typed outage into the boot retry — PR #1036 (9d55b622c), 2026-11-09
- T544 — a config store outage at boot: initialize fails typed within 10 s and api and worker retry boot instead of exiting — PR #1035 (1ffea2665), 2026-11-08
- T549 — the api's shared Redis client is bounded (503 when Redis is down); /admin/health reports Redis (merged without bot review) — PR #1033 (79eecd7b7), 2026-11-08
- T350 — module runtime status: Failed/Starting on the Modules tab with Retry (merged without bot review) — PR #1032 (bbea8d105), 2026-11-08
- T346 — Start refuses a task whose pinned custom tools are unusable (`assertCustomToolsUsable` in `markQueuedForStart` and the full-Retry branch; 409 `custom-tool-invalid` / `custom-tools-switched-off`, 503 on a config outage); every declared tool counts as required (user decision 2026-11-08, no optional flag); one reader `resolveCustomToolsEnabled`; `POST /custom-mcp/call` re-validates every pinned tool kind; pinned-tool re-checks use the type's `requiresRepository`; an unparseable pinned template fails as `custom-template-invalid`; the unwired failures name the server whose `mcp add` failed; docs task-types.md, integrations.md — PR #1031 (d79572701), 2026-11-08. CI green; merged without bot review. Follow-ups T563, T564 (design), T318 (+2), T543 (+1), T551 note.
- T354 — the shared npm cache volume is mounted read-only in every sandbox (`npmCacheMount()`), and each invocation seeds a private writable copy under `/tmp` that dies with its `--rm` container; only the worker's warm, purge and align containers write the volume; the first align after upgrade empties a volume written while read-write (`.haive-cache-ro-migrated`); chrome-devtools-mcp version pin accepts only a plain npm version or dist-tag (tooling PATCH 400); docs sandbox.md, onboarding-upgrades.md — PR #1030 (0d5190e56), 2026-11-07. CI green; merged without bot review. Behaviour change: agent-fetched npm content no longer persists between runs. Follow-ups T561-T562, T559 (+1).
- T347 + T399 — stored targets (Global KB Ollama URL, repository RAG stores and embedder URLs, forge hosts) and non-admin probes dial through one egress guard in `@haive/shared/egress`; admin private-endpoint allowlist (`config:security:privateEndpointAllowlist`, audited GET/PUT and data-tab card; hostname entries never lift link-local or unspecified addresses; read lazily); built-ins are the in-stack Ollama names and exactly `http://host.docker.internal:11434`; forge requests never follow redirects (a renamed repository's 301 is now a `ForgeError`); Ollama pull relay bounded; one-time idempotent upgrade seed lists the private hosts an install already stores; docs api-auth.md, integrations.md, global-kb.md, rag-embedding-failures.md, error-diagnostics.md, task-types.md — PR #1029 (02af88738), 2026-11-07. CI green; merged without bot review. Follow-ups T554-T560.
- T406 + T408 — a listed-but-disabled explicit CLI provider (task, step or saved choice) holds a fresh CLI-consuming or provider-sensitive step (30 s poll; START too) and the dispatcher refuses it with a named skip instead of the next-oldest CLI; `task_steps.detect_cli_provider_id` (migration 0223) re-detects a parked provider-sensitive step when the implicit default moved; api and web keep a disabled pick listed and disable its effort dropdown; docs cli-adapters.md, worker-restarts.md, step-summaries.md — PR #1028 (e241910fa), 2026-11-07. CI green; merged without bot review. T406 item 2 moved to T552; follow-ups T553.
- T355 — ConfigService Redis calls bounded (own connection, 2 s commandTimeout, no offline queue) and reject with `ConfigUnavailableError`; the api answers 503 `config_unavailable`; 17 request-path `Queue.add` sites bounded (`api/src/lib/queue-bounded.ts`); worker and updater readers hold or fail rather than guess (pause and caps read as held, runtime not admitted, maintenance tri-state, 08c/08d settings read in detect, updater leaves a hold it never recorded); docs error-diagnostics.md, release.md, worker-restarts.md — PR #1027 (13f92a753), 2026-11-07. CI green; merged without bot review. Follow-ups: T318 (+2), T540 (+1), T544-T551.
- T393 — an api Stop (owner, admin, urgent module deactivation) queues one `settle-stopped-task` job after its commit and kill (`enqueueStopSettle`, 2 s bound, never throws); the worker settles only while the task still reads failed at the Stop's `failedAt`; the job never fails the task and holds no stalled redrive; docs worker-restarts.md — PR #1026 (eb925108b), 2026-11-07. CI green; merged without bot review. Follow-ups: T345 items 12-13, T355 (+1), T540-T543.
- T392 — an implicit dispatch candidate whose adapter throws `ProviderBuildError` is logged and skipped for the next one; an explicitly selected provider rethrows; no candidate building throws the first error; docs cli-adapters.md — PR #1025 (e2e8ffd42), 2026-11-06. CI green; merged without bot review. Sonnet driver (one build round, red control confirmed on unchanged code, full worker suite green). Follow-ups filed under the same id. Evidence .claude/tmp/sonnet-run/T392/.
- T531 items 1-3, 5-7 — module source fetch counts entries while git writes; a 40-hex ref with no same-named ref is fetched by object on first resolution, and one whose branch or tag points at another commit refuses (`module_source_ref_ambiguous`); a no-answer by-SHA fetch fails instead of falling back; v-flag-safe module id pattern exported from shared; millisecond `updated_at` compare-and-swap (required gated CI row); real-git tests; docs modules.md. Item 4 disproved (no path records a namespace that does not point at the pin) — PR #1024 (5a597ee7e), 2026-11-06. CI green; merged without bot review. Sonnet reviews: FIX (1 M security, fixed in one round), then ACCEPT (4 L, filed as items 8-10). Evidence .claude/tmp/sonnet-run/T531b/.
- T539 items 3-5 — sh installer context reader linear (mawk 29.04 to 0.26 s, busybox 87.27 to 1.05 s); both readers bounded on one long line (busybox ~20 s to ~1.2 s); split-token rejects shared with ps1 — PR #1023 (d20349a2d), 2026-11-06. CI green; merged without bot review. Sonnet review ACCEPT (3 L; filed as T539 items 3-4). Evidence .claude/tmp/sonnet-run/T539b/.
- T533 item 23 — build-channel image builds get a 2 h deadline; `capture` stops every child by SIGTERM then SIGKILL after a 30 s grace on deadline, output overflow and abort; a timed-out command or gate is a failure even on exit 0 — PR #1022 (9ced42f3c), 2026-11-06. CI green; merged without bot review (Codex and Greptile out of allowance). Sonnet review ACCEPT (5 L; L1, L2, L4, L5 folded in one round). Evidence .claude/tmp/sonnet-run/T533d/.
- T539 items 1, 3 — sh installer manifest reader linear under mawk (20.78 to 1.54 s) and busybox (77.32 to 2.43 s), 142 parity cases identical; installer tests use per-fixture HOME and DOCKER_CONFIG — PR #1021 (42715eac0), 2026-11-06. CI green; merged without bot review. Sonnet review ACCEPT (1 M pre-existing, 3 L; filed as items 4-6). Evidence .claude/tmp/sonnet-run/T539/.
- T538 items 1, 2, 3, 5 — the release manifest image is kept after a read (no probe, no removal race); a failed container cleanup after a failed read emits a `warning`; the dead `--no-rollback` hint is gone; cli-diagnostics test gets a 30 s timeout; docs modules.md — PR #1020 (9daabf579), 2026-11-06. CI green; merged without bot review. Sonnet review FIX (1 M docs, session-written). Evidence .claude/tmp/sonnet-run/T538b/.
- T538 item 4 — upgrade History caps real runs (20) and preflight attempt rows (10) apart; `recordAttempt` prunes attempt rows beyond the newest 50 in the insert transaction, never the row it just wrote; docs release.md — PR #1019 (83a94fa62), 2026-11-06. CI green; merged without bot review (Codex and Greptile out of allowance). Sonnet review FIX (1 M docs, 4 L), all applied in one round. Evidence .claude/tmp/sonnet-run/T538/.
- T533 item 22 — publish-channel accepts a saved archive with one platform-less manifest when its sha256-verified config os/arch match the record; every other shape still exits 2 before any push — PR #1018 (0bfee4355), 2026-11-06. CI green after one rerun (unrelated updater timeout, T538 item 6); merged without bot review. Sonnet review ACCEPT (3 L, no change). Evidence .claude/tmp/sonnet-run/T533c/.
- Dependabot alert 118 (minimatch GHSA-g3hv-75wg-m249, via archiver -> readdir-glob) — pnpm override minimatch ^11.0.5 — PR #1017 (8317ecc31), 2026-11-06. CI green; merged without bot review (Codex and Greptile out of allowance). Alert state fixed. Dev stack needs `pnpm docker rebuild` for the lockfile.
- T531 — module source fetch resolves the worker image before any git process; the 64 MiB tree limit is enforced while git writes (fetch counts packed objects, checkout the work tree, exact check on exit) and the git group is stopped and awaited before cleanup; the pinned namespace is recorded in `resolved_ref` (migration 0222) so a by-SHA fallback never reads a tag as a same-named branch; one module id constant across the TypeScript sites with the SQL CHECK pinned; `gitRun` moved to spawn with abort, keeping the no-exit shape, real exit codes at the timeout boundary and exact `maxBuffer` truncation — PR #1016 (73d91b2c8), 2026-11-06. CI green; merged without bot review (Codex and Greptile out of allowance). Three Sonnet reviews (review-3 FIX L4, fixed in a third round, checked by the session). Abort test's PG half added to the CI GATED list. Follow-ups: T531 items 1-7 (reopened as FNF), T539 item 3. Evidence .claude/tmp/sonnet-run/T531/.
- T533 items 9-21 — channel-boot-check labels every resource it creates (`haive.boot-check=<name>`), aborts into cleanup on SIGINT/SIGTERM/SIGHUP (repeat signals do not interrupt it, EPIPE/EIO on stdout never kills it), tracks a dependency image only once proven absent before the pull, names the last fetch error on a stage timeout and removes a create killed by timeout; publish-channel rethrows an abort, restores or removes a local destination tag when a push fails, counts plural transport words and prints recovery lines after a failed manifest push; both scripts share `scripts/channel-capture.mjs` and one volatile not-found constant — PR #1015 (6b4ae3ebe), 2026-11-06. CI green; merged without bot review (Codex and Greptile out of allowance). Sonnet reviews (review-2 ACCEPT, fixed). Closed without change: 10 (an image's own printed secrets have no known value to scrub), 11 (no caller needs an overall deadline; per-stage bound documented), 21 (already covered, controls added). Item 22 awaits owner approval; 23 open. Evidence .claude/tmp/sonnet-run/T533b/.
- T533 items 1-8 — build-channel pulls the stock web before the builds, writes streamed output raw (one newline at the end), drops a partial token tail, counts local modules the way gen-modules does (path named on a malformed package.json), re-reads the repo digest after the gate, refuses a missing `packages/api/package.json`, npmrc mount or production stage with exit 2, and channel-gate reports every missing image while still scanning the present ones — PR #1014 (c68c57093), 2026-11-06. CI green; merged without bot review (Codex and Greptile out of allowance). Sonnet review ACCEPT (3 L, fixed). Items 9-22 continue in the second PR. Evidence .claude/tmp/sonnet-run/T533a/.
- T537 — the updater records every refused or failed upgrade start that began no run as an `upgrade_runs` attempt row (status `refused`/`failed`, capped error text, refusal code, zone-aware timestamps), and the admin maintenance page shows the latest attempt newer than the last completed run as a banner with reason and remedy, listed in History too; `.env` is read at lock time — PR #1013 (eb13a5427), 2026-11-06. CI green; merged without bot review (Codex and Greptile out of allowance). Sonnet reviews (review-1 FIX H1 M2 L5, fixed in two rounds). PG-gated tests added to the CI GATED list. Follow-ups: T538 items 3-5. Evidence .claude/tmp/sonnet-run/T537/.
- T536 — channel installer follow-ups (sh and ps1 together): explicit version required for a channel; selected Docker contexts copied by hash and kept in the final `.docker`; `DOCKER_HOST` pinned on every updater/builder container that reads the install `.docker` (both helpers, POST /upgrade, own-module builder); exclusive `.docker` claim with run-owned cleanup; bounded awk scanner (5.86 s to 0.44 s on 1 MiB); ps1 reader parity and argument forwarding; docs modules.md — PR #1012 (04a24a4c1), 2026-11-06. CI 17/17 green; merged without bot review (Codex and Greptile out of allowance). Sonnet reviews 1-3, last ACCEPT (1 L, documented). Leftovers T539. Evidence .claude/tmp/sonnet-run/T536/.
- T534 — updater channel-upgrade follow-ups: partial pins refuse; the release manifest is read as a capped tar stream (checked against real `docker cp` output); digest-form rollback inventory for public digest overrides (incl. `repo:tag@digest`); one shared channel/prefix pattern; `--check` removes only a release image it pulled by tag; first error kept over cleanup; public `--dry-plan` exits 2 — PR #1011 (9166a6efa), 2026-11-06. CI green; merged without bot review. Sonnet review ACCEPT (3 L: 2 fixed, pax header checked live and dropped). Leftovers T538. Evidence .claude/tmp/sonnet-run/T534/.
- T535 — the updater pins an install to the channel of its last completed upgrade (`upgrade_runs.channel`, no schema change) and refuses a changed `.env` channel with `channel-changed` before any manifest read; a deliberate move needs `--change-channel <recorded>`, exact match — PR #1010 (280b96763), 2026-11-06. CI green; merged without bot review (Codex and Greptile out of allowance). Sonnet review ACCEPT (3 L). Follow-ups: PowerShell helper argument forwarding and usage text ride in T536; admin refusal visibility is T537. Evidence .claude/tmp/sonnet-run/T535/.
- T335 — channel install and upgrade (plan D2b), in three PRs. PR A #1007 (4d4193768): builder + `haive-<channel>-release` manifest image. PR B #1008 (d71934772): the updater reads `--manifest-image` with pins bound to `HAIVE_CHANNEL_REGISTRY` and an install-local `DOCKER_CONFIG`; the api passes the channel. PR C #1009 (d94aafc00), 2026-11-05: install.sh/install.ps1 `--channel`/`--channel-registry`/`--registry-user`, login and verified manifest before any write, channel `./haive upgrade`, uninstall removes `.docker`; public path fixes (ps1 `HAIVE_INSTALL_ID` order, updater secrets by name). CI 17/17 green (one macOS GitHub-API flake re-run); merged without bot review (Codex and Greptile out of allowance); Sonnet reviews 1-3, last ACCEPT; real throwaway-registry runs per PR. Docs modules.md "Installing a channel". Follow-ups T534, T535, T536. Evidence .claude/tmp/sonnet-run/T335/.
- T352 — scripts/publish-channel.mjs publishes a gated channel build. It re-checks the ids and runs the boot check, then proves tag absence fail-closed (Bearer-token aware, anchored daemon line, `--confirm-absent`). It pushes the platform manifest only, copies the web by digest, verifies the digests, and writes release.json last from record.commit — PR #1006 (65063fc37), 2026-11-05. CI green; merged without bot review (Codex and Greptile out of allowance). Three Sonnet reviews (review-3 ACCEPT). Real throwaway-registry run: dry-run 0, publish 0, repeat 1. ghcr.io anonymous 401/DENIED measured. Follow-ups: T533 items 16-19 and T335 inputs. Evidence .claude/tmp/sonnet-run/T352/.
- T353 — scripts/channel-boot-check.mjs live boot check of a channel build (no docker.sock), /modules/loaded vs entitled set in api and worker — PR #1005 (e81805a35), 2026-11-05; CI 13/13 green, merged without bot review (Codex and Greptile out of allowance); three Sonnet reviews ACCEPT; real scratch-channel run exit 0, extra-statistics negative exit 1 in both halves, pre-existing postgres/redis images kept, all resources removed. Follow-ups T533 items 9-15, T352 note. Evidence .claude/tmp/sonnet-run/T353/.
- T351 — scripts/build-channel.mjs per-customer channel build from a final tag, no push — PR #1004 (0ec2c9f00), 2026-11-05; PR CI 13/13 green after a child_process ratchet baseline entry, merged without bot review (Codex and Greptile out of allowance); two Sonnet reviews (review-2 ACCEPT); real throwaway-registry run gate exit 0 with record; GHCR 0.2.0 platform pull + gate save verified. Follow-ups T533 (FNF), T352 notes. Evidence .claude/tmp/sonnet-run/T351/.
- T337 — module_sources install sources with fetch and pin (git; registry refused pending T532) — PR #1003 (9a8d8a3c7), 2026-11-05; PR CI 13/13 green, merged without bot review (Codex review allowance exhausted); full suite at feature end green bar two load-timing flakes in untouched files (pg-startup-storm positive control, project-state-write-bounds 4,090 claims); migration 0221 applied to dev; admin Modules page shows Install sources with source-checkout read-only note. Follow-ups T531, T532. Evidence .claude/tmp/sonnet-run/T337/.
- T336 — Own-module container builder and upgrade image recovery — PR #1001 (c4f4768900), 2026-11-02; exact-HEAD reviews/full candidate/PR CI/main CI41534422031 green; Own-modulebuilder actualpublic/customercontainerproof plusquotedsettingsreadonlyCompose/preflight/journalrestoreproof andentitlement/tokennegativecontrols passed; completeworkspace8packagesunits/types/rootformat/scripts passed, exactHEADnative/hosted/allPRCI/allmainCI green; reviewedoperator/updater/sharednaming source loaded,serializedlibs/watchers/compilednamingartifact/APIwebhealth/idle/userfiles verified. EightownedDockerfixturetags/inputscratchcleaned.. Evidence .claude/tmp/codex-run/queue-exec-20261101/T336/.

- T330 — Module-only graceful shutdown and dependents preflight — PR #1000 (59f48d98cc), 2026-11-02; exact-HEAD reviews/full candidate/PR CI/main CI41514316829 green; PrimaryModules/NewTask1280/768/390 passed15scopedprobes/screenshotsallparentviewed;9browserlocalPATCHDELETEs0forwarded; realreadonlymodules+dependents200; preflight503/lateA-B/busy/duplicate/Escape/draining/cancel+automaticrequiredblockedvsoptionalallowed verified. MainCI41514316829/allchecks/sourcewatchers/APIwebhealth/idle green; normal219+220applier beforewatchedsource plusjournal/physicalcolumns/keys/cascades/emptyadditivetables verified.. Evidence .claude/tmp/codex-run/queue-exec-20261101/T330/.

- T361 — Preview and purge module-owned integration data with counted transactional cleanup — PR #999 (fa1dcd14d8), 2026-11-02; exact-HEAD reviews/full candidate/PR CI/main CI41493981640 green; Modules/purge browser1280/768/390 passed21scopedprobes/screenshots inspected;12fakePOSTs0forwarded; delay/503/wrongtarget/incomplete/15stimeout/targetswitch/Escape/retry/duplicate andactualreturnedcounts verified; mainCI41493981640/allchecks/source-watchers/health/idle green. Evidence .claude/tmp/codex-run/queue-exec-20261101/T361/.

- T360 — Module categories and provider availability in Settings/admin/preferences/defaults — PR #998 (835b58ecfd), 2026-11-02; exact-HEAD reviews/full candidate/PR CI/main CI41490277684 green; Settings/preferences/admin browser1280/768/390 passed18 scoped probes/screenshots inspected;12 synthetic writes locally captured/0forwarded; readonlydeployedAPI200/provider state+module fields; actualPG164; mainCI41490277684/allchecks/source-watchers/health/idle green. Evidence .claude/tmp/codex-run/queue-exec-20261101/T360/.

- T332 — required integration reconnect waits, missing-provider recovery and current-row continuation ownership — PR #997 (d764679dc8), 2026-11-02; exact-HEAD reviews/full candidate/PR CI/main CI41477323495 green; actual task page browser1280/768/390 passed reconnect/disabled/deactivated/schema/runtime/dead/completed states;9scopedcaptures inspected,0writes forwarded; realPG37,mainCI41477323495,live0218normalapplier/physicalnullableJSONB-last/source-watchers/health/idlechecks green. Evidence .claude/tmp/codex-run/queue-exec-20261101/T332/.

- T333 — composer integration requirement and provider install-state overview — PR #996 (38b75516cf), 2026-11-02; exact-HEAD reviews/full candidate/PR CI/main CI41454594533 green; actual authenticated composer browser create/edit/readonly at1280/768/390 passed18probes; draft edits retained through delayedmetadata/error/retry/refused409,15screenshots inspected,3PATCH locallycaptured/0forwarded; actual readonly catalog API200 and watcher/health/activity checks green. Evidence .claude/tmp/codex-run/queue-exec-20261101/T333/.

- T339 — task-page integration overrides, explicit remembered preferences and reset — PR #995 (69f3f237fb), 2026-11-02; exact-HEAD reviews/full candidate/PR CI/main CI41449928905 green; actual task-page browser1280/768/390 save/explicitremember/refuseddraft/refresh/reset/explicitforget/unavailablegrantreset and completedreadonly with lateolderpoll passed;9screenshots inspected,18writes locallycaptured/0forwarded; actualPG37 and source/APIwatcher/health/activity checks green. Evidence .claude/tmp/codex-run/queue-exec-20261101/T339/.

- T357 — New Task account picker and prompt integration authoring — PR #994 (0d5de5bc6c), 2026-11-02; exact-HEAD reviews/full candidate/PR CI/main CI41444429959 green; actual browser New Task and existing type editor1280/768/390 passed, all6 screenshots inspected; pending/required admission, explicit unavailable account clear/draft preservation and integration-only raw repair PATCH checked with0 forwarded mutations; authenticated deployed preview200 and actualPG19/source-load checks green. Evidence .claude/tmp/codex-run/queue-exec-20261101/T356-T357/.

- T356 — required integration create admission and read-only preview — PR #994 (0d5de5bc6c), 2026-11-02; exact-HEAD reviews/full candidate/PR CI/main CI41444429959 green; actual browser New Task and existing type editor1280/768/390 passed, all6 screenshots inspected; pending/required admission, explicit unavailable account clear/draft preservation and integration-only raw repair PATCH checked with0 forwarded mutations; authenticated deployed preview200 and actualPG19/source-load checks green. Evidence .claude/tmp/codex-run/queue-exec-20261101/T356-T357/.

- T359 — preserve module provider resolution reasons and core-category compatibility — PR #993 (e0ed6fba7b), 2026-11-02; exact-HEAD reviews/full candidate/PR CI/main CI41430501569 green; real scratch PostgreSQL live state/ownership acceptance and unchanged C7b34 passed; deployed API/worker resolver checks pass with synthetic contexts; appactivityunchanged. Evidence .claude/tmp/codex-run/queue-exec-20261101/T359/.

- T496 — bound usage vendor requests and classify Grok rejection structurally — PR #992 (081bb553e7), 2026-11-02; exact-HEAD reviews/full candidate/PR CI/main CI41423875746 green; native Node HTTP stalled-body deadlines and subsequent recovery passed with synthetic local fixture; deployed worker ready/reviewed source hashes match; app activity unchanged. Evidence .claude/tmp/codex-run/queue-exec-20261101/T496/.

- T362 — refresh New Task readiness after a failed onboarding reset (member1; mobile T530 parked) — PR #991 (51240c0b0b), 2026-11-02; exact-HEAD reviews/full candidate/PR CI/main CI41421355760 green; actual merged New Task browser with synthetic reset/read/task route fixtures passed pending/failed/retry readiness and preserved inputs; zero writes forwarded. Evidence .claude/tmp/codex-run/queue-exec-20261101/T362/.

- T434 — probe captured CLI token before atomic promotion — PR #990 (c234388ac6), 2026-11-02; exact-HEAD reviews/full candidate/PR CI/main CI41416018770 green; real route/component/worker controls and real PostgreSQL atomic promotion passed; deployed API-to-worker synthetic crypto roundtrip and owner refusal passed; primary activity unchanged. Evidence .claude/tmp/codex-run/queue-exec-20261101/T434/.

- T521 — member5 only: verified empty-origin first push; retained stale-ref and nonforce protections — PR #989 (3778949f02), 2026-11-02; exact-HEAD reviews/full candidate/PR CI/main CI41409986755 green; actual browser Plan firstpush to emptyA and Haive-data firstpush to emptyB with stale tracking ref passed; barehistory/portableplanstate verified; fixtures removed, primaryactivityunchanged. Evidence .claude/tmp/codex-run/queue-exec-20261101/T521/.

- T122 — portable independent KB/plan review watermarks and filtered drift — PR #988 (42577ae961), 2026-11-01; exact-HEAD reviews/full candidate/PR CI/main CI41348129256 green; core browser/two-install acceptance with explicit supplemental-B-UI limit; corrected real-Git controls/fullworker15037 and SQL218 green; merged source loaded healthy with activity unchanged. Evidence .claude/tmp/codex-run/queue-exec-20261101/T121-T122/.

- T121 — project state rides normal Haive pushes in a scoped commit — PR #988 (42577ae961), 2026-11-01; exact-HEAD reviews/full candidate/PR CI/main CI41348129256 green; core browser/two-install acceptance with explicit supplemental-B-UI limit; corrected real-Git controls/fullworker15037 and SQL218 green; merged source loaded healthy with activity unchanged. Evidence .claude/tmp/codex-run/queue-exec-20261101/T121-T122/.

- T456 — optional JSON bodies validate before effects; empty body retains defaults — PR #987 (a8fdd5ebb0), 2026-11-01; exact-HEAD reviews/full candidate/PR CI/main CI41343957973 green; actual browser/web-origin API acceptance:9 invalid400 no effects and3 valid200 controls; owned fixture removed; main CI green. Evidence .claude/tmp/codex-run/queue-exec-20261101/T456/.

- T293 — hand KB files to the sandbox identity and verify actual corrections without false success — PR #986 (0e20ea848b), 2026-11-01; exact-HEAD reviews/full candidate/PR CI/main CI41335516748 green; actual root fixture controls and loaded-source validation passed; post-fix live model run not repeated. Evidence .claude/tmp/codex-run/queue-exec-20261101/T293/.

- T467 — retire buffered repository uploads and bound raw sound uploads, preserving supported chunked Retry sources — PR #985 (d86a7f014d), 2026-11-01; exact-HEAD reviews/full candidate/PR CI/main CI41334261157 green; scoped live acceptance passed. Evidence .claude/tmp/codex-run/queue-exec-20261101/route-retirement/.

- T338 — remove the unused task-level CLI switch while preserving step switching — PR #985 (d86a7f014d), 2026-11-01; exact-HEAD reviews/full candidate/PR CI/main CI41334261157 green; scoped live acceptance passed. Evidence .claude/tmp/codex-run/queue-exec-20261101/route-retirement/.

- T488 — split PostgreSQL integration checks from API/worker/Redis smokes, preserving all115 rows and11otherchecks — PR #984 (af13ab26d),2026-11-01; exact-HEAD reviews, scripts1160 and PR/mainCIgreen; one observed pair30m47s combined versus concurrent16m08s(smokes)/14m31s(PG), not a general benchmark.
- T387 — sanitize new uploaded Git config before publication; preserve history and refuse unsupported metadata — PR #983 (0cdffe9d2),2026-11-01; fresh source/correction reviews, root39/worker14981/scripts1073 and PR/mainCI green; ambient-only lever coverage remains T523. Evidence .claude/tmp/codex-run/queue-exec-20261101/T387/.
- T402 — repair historical context badges with reversible bounded operator;528 rows repaired,37 immutable before-images,0 further repairable rows; transcript/prompt retention0 forever — PR #982 (940878aa2),2026-11-01; exact-HEAD reviews, PRCI and mainCI41319760904 green; undo/digests verified; missing/ambiguous data preserved. Evidence .claude/tmp/codex-run/queue-exec-20261101/T402/.
- T524 — reconcile backlog decisions, mixed bundles and priorities;42 owner questions answered, corrected T487 policy retained, T402 expiry verified — board-only commits b1305a4f2/965b87a7e/c6ccc177e and closure,2026-11-01; no product implementation or live validation run started; TASKS-only changes need no PR/CI

- T471 — atomically fold parked waits and re-check held state; preserve retained-run timing and one form marker — PR #981 (3078d9758), 2026-11-01; exact-HEAD review, all PR checks and main CI41300414474 green; full database/API/worker suites and real Postgres/Redis controls pass; follow-ups T499/T515/T519

- T120 — B5.1 Haive data status, Save/custom message, confirmed push and conflict resolution panel — PRs #973/#976/#979 (final79f5edd2d), 2026-11-01; all approved criteria,2644web tests, real browser375/768/1280 and same-history push passed; exact-HEAD review and PR/main CI green; empty-origin first-push limitation queued T521, Git config design T523

- T376 — audit credential/security changes and successful/failed sign-ins with transactional controls — PR #978 (d3b7b9b33), 2026-11-01; exact-HEAD review and PR/main CI green; item6 remains deferred as T492, prototype branch preserved; follow-ups T508/T516/T522

- T397 — preserve failed Git reads as unknown/errors across refresh, merge completion and workflow steps — PR #980 (6e63562d5), 2026-11-01; exact-HEAD review and PR/main CI green; full suites and isolated 214-check refresh/Redis smoke pass; follow-ups T486/T495

- T498 — recover lost waiting_cli continuations without reboot; preserve epoch/hold/live-run fences, re-read a DAG level with no coder dispatched, retry continuation/poller enqueues — PR #977 (0e0077525), 2026-11-01; exact-HEAD automated Codex review clean; all PR checks and main CI green; follow-up T519 and existing T499/T500/T515

- T365 — bounded repository and bundle pickers, actionable bounded failures, sync-completion cache invalidation — PR #974 (ea016541a), 2026-11-01; main CI green; live dev Resync fetched new commit and refreshed expanded files without reload; picker verified at375/768/1280 with synthetic vendor results; follow-ups T517/T518

- T489 — CI steps and jobs have independent limits and guards; gated-loop failures remain loud; shell scanner reduced and pinned against real workflows — PR #975 (221514334), 2026-11-01; main CI green; follow-ups T520 and existing T509; no further scanner expansion without a real failing workflow

- T348 — the stalled sweep re-drives a running step that no job drives and no run waits on (the allowance auto-resume's post-commit enqueue could strand it), leaves a step a pass of this process is on, and excludes live runs (neither ended nor superseded) in the statement that bumps the epoch, before the task lock — shipped with T385 in PR #972 (d47433f7e), 2026-10-31; main CI green
- T385 — the stalled sweep re-drives a park whose poll chain stopped; a recovery re-drive's advance carries a BullMQ deduplication id per (task, step, round, epoch) (park ticks, continuations and the forward hand-off do not); a Retry's re-offer and a Stop book a park from before the run to carried_idle_ms; Resume, retry_ai and the fan-out Resume of a never-started row stamp started_at and carry its idle time; a module step parked for its schema setup shows "waiting: module setup" (structural columns only); handleResult logs why a hand-off write found no row; the test fake compares UUID values without case and evaluates the sweep's negated correlated EXISTS — PR #972 (d47433f7e), 2026-10-31; main CI green; badge checked live on the dev stack at 1280 and 390 px; delivered with sonnet-sonnet (driver) then codex-sonnet (2 fix rounds) plus session fixes (a merge-time CI step limit, a CodeQL test helper); follow-ups T498, T499, T500, T501, T507
- T491 — the plan merge panel says how a merge it was watching ended (landed, cancelled by someone else, or failed with its scratch worktree kept and a link to Retry its task), never for a Discard it asked for itself; the panel and DELETE /plan/merge share a pinned ?taskId= contract; a Discard or answer that settles after the panel moved to another merge is dropped; a failed Discard after the page removed the merge restarts the recovery read and shows its error; the plan chat keeps one draft per node — PR #971 (bb2d4673c), 2026-10-31; main CI green; delivered with codex-sonnet (3 fix rounds, one from the PR's Codex review); follow-ups T497, T503, T506
- T480 — the KB path validator refuses a git-data name (08, 09_3 and the legacy KB writer); 09_5, 09_5b and 11d read stored skill dirs and ids through a positive check (the catalog's skills dirs, single-segment ids) beside the git-data denylist, so no agent is dispatched or prompted for a refused dir, and a dropped dir or id sets one degradedNote per run; 07's agent targets and quarantine groups and 12's recorded agent dirs keep to the catalog, quarantine file names are validated, and 07's description and count leave out a refused group — PR #970 (1e02dd1fb), 2026-10-31; main CI green; delivered with codex-sonnet (2 fix rounds); follow-up T494
- T478 — git and filesystem errors reach the plan page, the api's Save and Pull 409 bodies, repositories.status_message and 12's warnings without the server's absolute paths: one shared scrubber (`scrubErrorPaths`) hides absolute POSIX, drive and UNC paths and keeps the diagnosis and URLs (linear, one alternative per quote kind: CodeQL clean); convergent boot repairs rewrite stored mirror errors and errored repositories' messages (compare-and-swap, logged with counts and ids); one warn per sweep tick for a stuck row — PR #969 (f193c6b78), 2026-10-31; main CI green; delivered with codex-sonnet (2 fix rounds, session CodeQL fix); follow-up T490
- T476 — the plan merge panel reads the DELETE's `cancelled` answer: a discard that cancelled nothing keeps a neutral status notice (completed, cancelled or failed; nothing discarded) that survives the refresh, is cleared by the next merge, Discard or answer, and Discard stays disabled while its own discard settles; the panel sends the displayed task id (`?taskId=`) and the route cancels nothing when a different merge is open — PR #968 (0177599c3), 2026-10-31; main CI green; delivered with codex-sonnet (1 fix round, session Direct guard); follow-up T491
- T479 — an archive extract whose swap fails restores the previous destination tree before the stage is removed (the old tree was deleted with the stage); a failed restore keeps the stage and logs the absolute path of the kept tree; a failed stage removal after a good swap warns instead of failing silently; the comment says what a crash between the two renames leaves — PR #966 (a1a74f596), 2026-10-31; main CI green; delivered with codex-sonnet (1 fix round); follow-ups T486, T487
- T474 — schema-parity, the web checks of production-images and macos-preflight run each check on !cancelled() && steps.<setup>.conclusion == 'success'; the smokes job's gated step and Redis-script steps have their own limits (25, 10, 5 minutes) and the job 45 minutes, pinned by a budget model of the GATED list (907 s plus 7.5 s a row; fails at 134 and 160 rows); the gated step's errexit comes from the runner's bash -e (comment only) — PR #967 (6bad0f036), 2026-10-31; main CI green with every guarded check run (PR run and main); ci-smokes.md; follow-ups T488, T489, T475 notes
- T341 — a credential delete confirms and names the connection the cascade takes (audited with its id), a re-sign-in takes back the account's earlier credential by (user, host, account id: repo_credentials.sign_in_account_id, 0216) instead of adding one, a backing credential's host or forge cannot be edited (409), the resolver and task choice compare a forge connection's credential forge, hosts compare case-insensitively, a refused OAuth refresh is recorded and shown (refresh_refused_at, 0217), a rename follows into the token connection's label, and delete and edit lock the connection before the credential (a late link NOWAIT, 503) — PR #965 (e880cf343), 2026-10-31; main CI green; checked live on the dev stack with throwaway credentials; follow-up T485; item 14 (device poll retry on 5xx) is an owner question
- T459 — measured first: run and agent-row statements lock in heap order (Bitmap/Seq scans at 96k runs), so no scan-order deadlock and no id-ordered batch; fixed the six measured lock-tier cycles instead (requeueAbandonedOrphan runs first, fan-out Resume supersede before agent marks, the reopened form's agent rows before its step row, the late sweep's runs and agent rows NOWAIT to the existing 503, the CANCEL step sweep in a short lockStepRows transaction) and a plan patch that may insert takes the repository row FOR KEY SHARE first (repository_gone: 404, clarify fails at once; update-only patches take no lock, since a project-state write holds that row 0.4-2 s) — PR #964 (823b83cf1), 2026-10-31; main CI green incl. all smokes; follow-ups T482, T483, T484, T478 +1, T364 +1
- T473 — 07's writeIfAllowed and quarantine move, 09_5, 09_5b and 11d refuse a stored directory or skill id that names git data, listSkillDirs lists no git-data directory (a nested repository's .git in a skills directory was deleted by 09_5b's repair), and 12's stage plan hands git no recorded git-data path (an alias spelling made every Retry of 12 fail with invalid path) — PR #963 (868cae25f), 2026-10-31; main CI green; follow-ups T480, T481
- T458 — the worker's CANCEL job decides under the task row's lock (markTaskCancelled): a completed or vanished task is left as it is with no teardown, an already-cancelled one keeps its stamps, anything else (failed included) is cancelled; DELETE /plan/merge and the step abort stop the live run, cancel through cancelTaskIfOpen and clear the pause only when the cancel applied, as Cancel does — PR #962 (f8eea8b66), 2026-10-31; main CI green incl. all smokes; live cancel/abort/discard UI paths not driven (they need a running CLI task or a conflicted remote pull); follow-ups T476, T309 +2, T364 +1, T460 note
- T466 — verified first: a dirty outbox or plan-mirror row whose checkout is gone never starved healthy rows but redid 14-35 statements, failing opens and git spawns and logged a 2-3 KB warning on every 10 s tick forever (about 18-27 MB of log per row per day); now such a row is held before anything is read (checkoutMissing, a strict lstat), last_error says so, it stays dirty and is written on the first tick after the checkout is back; a plan-less mirror row still retires — PR #961 (f55d6d546), 2026-10-31; main CI green; checked live on the dev stack (plan page at 1280 and 375); follow-ups T477, T478, T479, T462 +1
- T470 — every check of the smokes job (the Postgres-gated tests, the api, worker and migration smokes, the six Redis scripts) runs on !cancelled() && steps.migrate.conclusion == 'success', so one red check no longer skips the others while a failed setup step or a cancel still stops them; pinned by scripts/test/ci-step-independence.test.mjs; ci-smokes.md CI steps and Limits (about 275 s of headroom) updated — PR #960 (09c9d725a), 2026-10-31; main CI green, every check ran (PR run 41178244171, main run 41180026196); follow-ups T474, T475
- T469 — the onboarding reset also takes back a git-data claim file only the sync base names (baseGitDataPaths; left behind, the record read refused and the next record write threw); 12, 01's lazy backfill and the manual bundle helper refuse a path that names git data — PR #959 (68af9d174), 2026-10-31; main CI green; follow-ups T472, T473
- T461 — every carried_* fold reads the row after it holds it and folds from that read (a delta computed from a pre-transaction read lost a concurrent fold or idle write): resetRowsForRerun, the per-step and the task-level provider switch (now one transaction under T349's batch), resetStepAndDownstream, requeueAbandonedOrphan and writeFencedPark's first park — PR #958 (ffa1c2d0c), 2026-10-31; main CI green; follow-ups T471, T459 note, T364 item 28
- T465 — smoke:ci of api, worker and database runs through scripts/run-smokes.mjs: each smoke in its own process group under its own limit (default 120 s; repo-refresh 480, two-install 240, from 8 green main runs), a hung one killed and named, the chain going on with a summary and exit 1; the worker and migration smoke steps run after a failed api smoke — PR #957 (1d14f60cf), 2026-10-31; main CI green with the runner on a real Actions run; docs/architecture/ci-smokes.md; follow-up T470
- T421 — a convergent boot data migration (supersedeGitDataArtifacts, the real namesGitData) retires every live ledger row at a git-data path at every worker boot, setting only superseded_at and updated_at, ordered before seedRepositoryCliTargets; the onboarding reset takes back a retired git-data row's claim file (a leftover made the record unreadable and the writer throw); take_theirs/keep_mine at a non-claimable path answer invalid and 04's untracked put-back skips a git-data row — PR #956 (54f846e0d), 2026-10-31; main CI green; follow-ups T468, T469
- T463 — a form read of a request that is not a form answers 400 invalid_form (formBodyErrors maps the TypeError class), the CLI login banner ignores a WebSocket frame that is not a JSON object, PUT /user-settings/ide and /ui-prefs refuse a settingsJson that is not an object, and five sources added 100755 are 100644 — PR #955 (98e0f3762), 2026-10-31; main CI green; follow-ups T467, T364 item 26 note
- T349 — every multi-row step writer locks its step rows in one id-ordered batch first (lockStepRows; 11 api and 2 worker writers, after the run, mining and DAG statements); a repository delete takes the task-creation key a Retry takes, and the plan advisory takes it before its node row; the single cancel and the step abort lock, re-check and cancel only a task that is not completed or cancelled, ending only the step rows they locked (a later row is the CANCEL job's); the claim-race smoke pins the new rule (a pass waits for an in-flight Retry; the 503 covers a row created after the batch) — PR #951 (a767e7ffa), 2026-10-31; main CI green incl. all smokes; follow-ups T458, T459, T460, T461, T364 item 24, T465, T466
- T454 — /repos/new keeps a display name, branch and writable-copy choice typed before React attaches: uncontrolled fields read with FormData before the first await, the branch also written through a ref by the GitHub picker and a Source switch, and the form declares method=post now that its fields have names; the survey found /tasks/new (design, T464) and no other server-rendered form; the pre-hydration helpers moved to tests/e2e/helpers/hydration.ts — PR #954 (cfc0c37e6), 2026-10-31; main CI green; checked on the dev stack; follow-ups T464, T453 note, T365 +2, T343 +1, T364 +1
- T455 — a JSON body that is not an object answers 400 invalid_body in the twelve handlers that read fields off it, through one shared guard (requireJsonObject; the Ollama pull SSE route answers an error event); PATCH tooling parses its body with a zod schema, so a field of the wrong type answers 400 Validation failed naming it and an unknown ragEmbedAction never reaches the RAG lock — PR #953 (dbc091f20), 2026-10-31; main CI green; checked on the dev stack; follow-ups T463, T456 +1, T364 item 26
- T437 — repository responses carry no credential: the create and exclusions PATCH responses answer redactEditableGitUrl(remote) like list and detail, and no repository response (list, detail, create, upload, upload-complete, exclusions) carries the onboarding tooling or environment mirror, which held the RAG connection string with its password and MCP env values; a failed clone or refresh was already stored redacted (pinned) — PR #952 (52985ee80), 2026-10-31; main CI green; checked on the dev stack (78 list rows, detail)
- T445 — a project-state sync with no base logs one warn naming the units whose held value the checkout's replaced (at most ten, settings and environment first, never a value); the web-bundle guard also fails on Node globals read as values (Buffer.byteLength became TextEncoder); the conflict-sides comment moved onto conflictSide; item 2 (the page saying a value was refused or replaced) moved to T462 [design] — PR #950 (9d8c78f58), 2026-10-31; main CI green; docs also record T446's verdict; follow-ups T462, T364 item 25
- T452 — the 150 ms Enter after a token paste is one of the login session's tracked one-shot timers and cleanupSession clears it; a chunk after cleanup starts no antigravity URL step or menu-advance timer — PR #949 (fc7789288), 2026-10-30; main CI green; follow-up T457
- T447 — PATCH /repositories/:id/tooling answers 400 invalid_body for a JSON body that is not an object and invalid_json for one that is not JSON, writing nothing; refresh-tree reads only the eight repository columns it uses; an AGENTS.md rules override keeps its first line's indent while the default block stays byte-identical (no manifest bump) — PR #948 (8330687b8), 2026-10-30; main CI green; checked on the dev stack; follow-ups T455, T456
- T119 — the AGENTS.md rules block is the repository's: repositories.agent_rules_override (migration 0215), settings/agent-rules.md in the project-state record, a Tooling page card with its own save, and buildRepoCliRulesBlock for 07, 12, 01 and the api's upgrade-status — PR #940 (5b6467e9c) and the editor fix PR #947 (1989f1f2a), 2026-10-30; main CI green; browser-checked at 1280, 768 and 375; follow-ups T443, T444, T445, T446, T447
- T449 — values typed or autofilled into the sign-in form (login, register, setup) before React attaches are what gets submitted: the inputs are uncontrolled and read with FormData before the first await — PR #946 (6d9f6daf3), 2026-10-30; main CI green; item 2 moved to T453 [design]; follow-ups T454, T364 item 22 note
- T438 — the login frame of a device-code provider waits, within the one settle deadline, for its code and what ends it; an escape with intermediate bytes such as ESC ( B is stripped whole; the dead terminal oauth_prompt scanner is removed; cleanupSession clears antigravity's two resize timers; item 3 (a wrapped URL's last piece sharing its line with text) is left as is, since no rule tells it from prose without reopening T433's terminator rules and no measured banner prints it — PR #945 (02a25e357), 2026-10-30; main CI green after one rerun of the T364 item 23 flake; follow-ups T452, T439 note
- T441 — a running editor or app runner is recreated only when docker inspect proves a mismatch (a failed inspect keeps it), the editor's debug lookup no longer fails a booted editor's ensure, and editors from before T431 are registered for the idle reaper — PR #944 (b4a901a37), 2026-10-30; main CI green; follow-ups T450, T451
- T448 — the sign-in form (login, register, setup) submits by POST before React attaches its handler, so no field value reaches the URL (measured: urlencoded POST answered 200 with the page, multipart 409, never set encType) — PR #943 (28e5c840b), 2026-10-30; main CI green; follow-ups T449, T364 item 22
- T429 — every hardened git argv refuses the file transport by default (protocol.file.allow=never; allowFileTransport the one opt-in, used by the host-folder refresh); the unused gitSetOriginUrl removed — PR #942 (b8025f92e), 2026-10-30; main CI green; follow-up T364 item 20, T387 cross-reference
- T401 — the app shell holds its recurring requests back while the password must change (gated on the layout's flag, no refused request at all) and resumes them after the change without a reload; e2e specs for the forced flow and the sign-in throttle's 429 — PR #939 (d240c9e4a), 2026-10-30; main CI green; follow-ups T448 (shipped as #943), T364 item 19
- T431 — a running editor launched with another image or flags is replaced once idle (image on the host first, removed right before the launch); a socketless task editor is registered and reaped; an api restart ages no held editor or terminal session — PR #938 (82bf479fa), 2026-10-30; main CI green (rerun after the known upload-reaper flake, #941); live check passed (ensure registers, launch label stamped, reaped after the grace); follow-ups T441, T442
- T428 — a version or price refresh lists the sources it could not update (catalog poll result admin-only) — PR #937 (1207521d4), 2026-10-30; main CI green; follow-up T440; browser acceptance owed (dev stack)
- T433 — the login banner sends the auth URL only once it has ended (1 s deadline from first sight, stream-end flush, nothing after sign-in) — PR #936 (d7b4c605a), 2026-10-30; main CI green at 1207521d4; follow-ups T438, T439; browser acceptance per provider owed (dev stack)
- T118 — repository CLI set is a union — PR #934 (110bb4933), 2026-10-26; final reviews/gates recorded in T118 evidence, all8 main CI green, dev libs/API/web/worker verified; finish-then-pause boundary complete.

- T117 — observe external named checkout and record changes safely — PR #933 (46fe58b2), 2026-10-26; exact-head review/all12 CI clean, main CI40310628973 all8 + CodeQL green, dev0214/libs/API/web/worker/60s observer verified.

- T266 — fence record writers and raw checkout imports; recover interrupted file mutations through durable bounded journals; live RTK applicability — PR #931 (e25d26193), 2026-10-26; main CI40280294006 all8 green. Migration0213 and libraries applied, runtime verified. Private recovery artifacts retained; automatic GC remains outside this change.

- T413 — preserve literal/comment, language owner, JSX/TSX, Unicode, line-ending and Ruby section boundaries — PR #930 (01377885f), 2026-10-26; main CI40243774694 all8 green.

- T303 — resumable ZIP replacement, bounded duplicate admission, stall allowance, periodic recovery and visible bundle failures — PR #932 (0294c9033), 2026-10-25; main CI40238774156 all8 green.

- T416 — real proxy/parser/sanitizer/CSP browser checks and same-built production web image boot; independent browser CI budget — PR #928 (15f532bea), 2026-10-25; main CI40232945840 all8 green.

- T412 — bound remaining clone/operator Git, root-anchored reset writes, independent push choice and truthful missing-SHA learning — PR #929 (89752556c), 2026-10-25; main CI40232785502 green; T397 separate.

- T288 — locked stale-import checks, empty state directories and atomic RTK question convergence — PR #927 (0dbad8dc6), 2026-10-25; main CI40230306594 green. Unowned malformed RTK settings remain for manual repair with accepted warnings; T317 separate.

- T340 — Git destination-bound credentials, retained PR remote, safe URL state and diagnostic forwarding — PR #922 (e487dfee5), 2026-10-25; main CI40226900960 green; migration0212 applied and shared libraries rebuilt.

- T423 — failed terminal/login attach startup closes owned resources; atomic clamped attachment counts and safe failure frames — PR #925 (e2c2e9874), 2026-10-25; main CI40222956422 green.

- T424 — exclude unborn nested repositories from outer commits and retain review boundary metadata — PR #926 (9df65b116), 2026-10-25; main CI40222131082 green.

- T415 — upload Retry uses durable same-repository archive source; unavailable-source capability and recovery copy stay truthful — PR #924 (f96c58cb1), 2026-10-25; main CI40221151472 green; bot timeout explicitly unreviewed, fresh local reviews clean.

- T426 — Safe bound-query diagnostics in logs, replies and new stored failure/warning text — PR #921 (7ac3bfc74), 2026-10-25; main CI40217648438 green.

- T430 — Scope knowledge/skill commits, including deleted roots and refused-path safety — PR #923 (555c138e5), 2026-10-25; main CI40215378653 green.

- T382 — Atomic auth writes, uniform refusal and authorization sweeps — PR #918 (972ae3d48), 2026-10-25; main CI40213257994 green.
- T432 — Browser-owned session recovery and ordered cookie writers — PR #918 (972ae3d48), 2026-10-25; main CI40213257994 green.

- T427 — Claude OAuth token capture fails closed across wrapped and split CR boundaries — PR #920 (a04601009), main CI 40198900044 green, 2026-10-25

- T398 — IDE proxy header/cookie hardening and disabled port proxy — PR #917 (b504c18b8), main CI green, 2026-10-25

- T417 — stored clone URL checks, relink push URLs, helper syntax and origin probes — PR #916 (d6efc7923), main CI b504c18b8 green, 2026-10-25

- T414 — patched next, dompurify, markdown-it and zod; alerts #108–#116 now confirmed fixed — PR #891 (b1a791b52), main CI green, 2026-10-25

(One line per finished task: `T<n> — <title> — PR #<n> (<merge sha>), <date>`.)

- T418 — an empty commit is decided by the staged diff's exit code (submodule ignore and open merge handled), never by git's wording (leftovers in T397, T430) — PR #915 (ab398f836), 2026-10-25
- T420 — the pricing page waits for its refresh job; cli-exec retention is by age so no job trims a pollable result early (browser-checked; leftovers in T428) — PR #914 (d6b37bac3), 2026-10-25
- T363 — the expected attachment count is recorded at create and Start confirms "N of M attachments are missing" (migration 0211; live flow owed, T300) — PR #913 (f5bbce839), 2026-10-25
- T400 — one WebSocket upgrade authenticator and refusal; a deactivation, reset or password change closes the user's open and pending sockets (1008); upgrade sockets cannot crash the api (live probe passed) — PR #912 (eb54d0f3a), 2026-10-25
- T306 — step 12's written runs guarded, 04's rollback runs seeded with the snapshot they need, the revive fake given its table (test-only; fake-db class hazard in T364) — PR #911 (adad1b8d8), 2026-10-25
- T395 — Stop offered for a running task whose current row is pending; "Nothing was running to stop." on an empty Stop (browser-checked; running-task case owed, T300) — PR #908 (2f39fa5fd), 2026-10-25
- T422 — no credential text in the login banner's logs or errors (sanitized error class and code); the modal handles an unexpected close (+1; leftovers in T426, T427) — PR #910 (dc444c013), 2026-10-25
- T388 — host git re-validates a stored origin URL and refuses the file transport for pack commands (follow-ups in T417) — PR #906 (da043a2aa), 2026-10-25
- T375 — an untracked nested repo previews as git add records it (gitlink, or unborn with a reason); an empty investigation file is not new (gate 3 live view owed, T300) — PR #909 (d35333489), 2026-10-25
- T378 — a failed finishSignIn revokes the vendor token; the device poll's cleanup cannot 500; the GitHub connect poll stops once cancelled — PR #905 (134a27e13; main green at 7eb1938af), 2026-10-24
- T372 — fence-order test budget; stepIds named for what they hold (picker label shipped with T391) — PR #904 (7fe56b9e0), 2026-10-24
- T404 — a re-opened step clears its context and allowance stamp; the page shows stamps on done rows only (browser-checked; ratchet budget follow-up #907) — PR #903 (6e9daa2e6), 2026-10-24
- T391 — pickers preselect the oldest enabled provider; create refuses a disabled one (+2, with T372's picker label) — PR #902 (a4bb484eb), 2026-10-24
- T407 — plan chat records the provider that answered (+1) — PR #899 (525098023), 2026-10-24
- T374 — house-rule enforce/un-enforce write audit rows (+1) — PR #900 (42c518d8c), 2026-10-24
- T304 — .git refusal catches NTFS aliases (+1) — PR #901 (0fce71181), 2026-10-24
- T381 — AGENTS.md size test; requireAuth exceptions and the PUBLIC register named — PR #898 (4f91759b1), 2026-10-24
- T380 — version refresh coalesces, poll routes check job ids, dead force flag gone (leftovers in T420) — PR #895 (892f3ea30), 2026-10-24
- T411 — module, RAG and global-KB pools open every connection with client_connection_check_interval, so statements end with the pool — PR #893 (bce6d8a7b), 2026-10-24
- T419 — CI skips pushes that change only TASKS.md (pull requests keep every check) — PR #894 (0a63e34c0), 2026-10-24
- T370 — a refused or failed plan Pull or Save records last_error (recovery awaited) — PR #890 (b948852af), 2026-10-24
- T311 — RAG chunker reads constructs only outside comments, strings and inline HTML (16 Codex rounds; leftovers in T413) — PR #889 (74eba9317), 2026-10-24
- T328 — bundle git bounded; 01 refuses an unknown base; gate 3 keeps an earlier sha — PR #888 (214b76b1f), 2026-10-24
- T383 — fix-loop gate re-offer follow-ups (was modular #263) — PR #887 (e5c41e2ec), 2026-10-24
- T384 — module lifecycle bounds (was modular #264) — PR #885 (a9e51e265), 2026-10-24
- T390 — a task with no CLI picked runs its steps as the default provider (was modular #271) — PR #882 (c59fb005e), 2026-10-24
- T396 — a failed merge-dir, open-merge or HEAD read is unknown, not an answer (was modular #278) — PR #884 (c48df1953), 2026-10-24
- T377 — auth hardening: forced password, non-admin probes, IDE session strip, login throttle (was modular #253) — PR #886 (acf66d5c1), 2026-10-24
- modular #241 — upgrade start guard and history fail on a failed journal read — PR #868 (5901e1c73), 2026-10-24
- modular #242 — upgrade restores the found state; kept maintenance drains on running work only — PR #868 (5901e1c73), 2026-10-24
- modular #205 — module ensure deadline; steps park until the schema is ready — PR #867 (fcc9f4021), 2026-10-24
- modular #256 — twelve more hardened git -c overrides plus a child_process ratchet — PR #870 (f95e3b71b), 2026-10-24
- modular #266 — a rollback that throws leaves the upgrade run running and records the error — PR #871 (78c2d3b98), 2026-10-24
- modular #244 — no-CLI steps run on one stable default provider — PR #872 (8025c4bc0), 2026-10-24
- modular #255 — failed origin, worktree-list and HEAD reads throw or read unknown — PR #873 (8c49b1291), 2026-10-24
- modular #262 — Stop fails a pending current row — PR #874 (e1a67774d), 2026-10-24
- modular #274 — the job-level catch fails only an open task, so a Stop error survives — PR #875 (31c5d7e13), 2026-10-24
- modular #248 — the context badge divides by the CLI-reported window — PR #881 (4e39cca4d), 2026-10-24
- modular #243 — an admin pause takes over an owner pause; maintenance lists parked tasks — PR #883 (63228e68d), 2026-10-24
- T327 — Attachments tab note for read-only and repo-less tasks — PR #880 (128efe0f4), 2026-10-24
- T325 — must-not-fail steps note a git that gave no answer — PR #879 (c1a55c613), 2026-10-24
- T324 — attach controls hidden for read-only local repos — PR #878 (1a23f4fd4), 2026-10-24
- T322 — a git that gave no answer is unknown, never "no" — PR #877 (8bc89b15a), 2026-10-24
- T320 — New Task names a refused deferred start — PR #876 (0a1ffef0c), 2026-10-24
- T305 — upload cleanup follow-ups — PR #869 (11c6cf9ca), 2026-10-24
