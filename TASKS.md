# Haive task board

One shared list of open work for every agent and every machine. It lives ONLY on the `tasks`
branch of `origin` (never merged into `main`, so editing it runs no CI and touches no PR).
A task's number (`T323`) is the number its commits and PRs already cite (`#323`).

## Protocol (read before touching anything)

**Read the board**
```
git fetch origin tasks && git show origin/tasks:TASKS.md
```

**Edit the board** (claim, release, add, update, close). Keep one worktree on the branch, outside
any other work, e.g. `<repo>/.claude/worktrees/tasks-board`:
```
git worktree add <repo>/.claude/worktrees/tasks-board tasks   # once per machine (fetch first)
cd <repo>/.claude/worktrees/tasks-board
git pull --rebase origin tasks        # ALWAYS first
# edit TASKS.md
git commit -am "claim T323 (<owner>)" # one change per commit, message says what
git push origin tasks                 # the push is the lock
```
If the push is rejected, someone else changed the board. Run `git pull --rebase origin tasks`.
If the rebase conflicts on the task you touched, or that task now shows another owner, you lost:
drop your change (`git rebase --abort && git reset --hard origin/tasks`) and pick something else.
Never force-push this branch.

**Claim before you start.** A task is yours only once your claim commit is on `origin/tasks`.
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

**Status values**: `open` · `taken` · `parked` (waits on the user or on data; the reason says which) ·
`blocked` (waits on another task; `blocked-by:` names it).

## Areas

- `packages/worker/src/step-engine/merge-resolver.ts` (resolveMergePhase landing sections,
  finishMerge): session **modular-haive-plan**.
- Branch `fnf/278-merge-dir-reads` (worktree `/home/activit/haive-278`) is another session's live
  work on: repo/git-operation.ts, project-state/set-aside.ts, step-engine/git-merge.ts,
  merge-projections.ts, plan/merge-baseline.ts, left-open-merge.ts. Do not edit those files until it lands.

## Questions waiting on the user

- T317 — should a stamped RTK choice also win on a first import? Recommended: yes.
- T199 — which favicon/icon to use.
- T270, T310, T318, T326 — design decisions (see each task).
- T319 — go-ahead on the scope of set-aside batching (rewrites four helpers).
- T323 item 4 — retention rule for `complete`/`consumed` upload rows.

---

# Open tasks

### T311 · FNF[rag-chunker-2] · chunker false matches, wrong method owners, braces in strings (+5)
status: taken · owner: fnf-run@ACTIVIT21 · since: 2026-10-23 · last: 2026-10-24T06:40Z
branch: fnf/311-rag-chunker-2 · worktree: /home/activit/haive/.claude/worktrees/p311 · evidence: .claude/tmp/fnf-run/p311/
All PRE-EXISTING, measured on the eval tree at 9c0c8ee77 (evidence .claude/tmp/rag-plan/p1/evidence/metrics-main.json). File: `_rag-chunkers.ts`.
1. The PHP class pattern matches "class" inside comments: 563 methods get a wrong owner, 120 lose theirs.
2. Function/arrow patterns match inside strings, comments, inline HTML, template literals (31 PHP + 7 JS false sections).
3. `braceBlockEnd` counts braces inside strings: 5 PHP functions lose their section.
4. FIXED in #815.
5. A short span with a closer plus the next head goes whole to the next section; split at the first worded line.
6. `.rb` sections stop before `end`; Ruby ranges should end after `end`.
Fix: a lexer pass marking comment/string spans shared by PHP and JS. Needs one reindex.

### T328 · FNF[git-noexit-low-2] · bundle git spawns unbounded; 01's 'main' guess under autoContinue; gate 3 NULL sha (+4)
status: taken · owner: fnf-run@ACTIVIT21 · since: 2026-10-24 · last: 2026-10-24T06:40Z
branch: fnf/328-git-noexit-low-2 · worktree: .claude/worktrees/p328 · brief: .claude/tmp/fnf-run/p328/drive.md
All PRE-EXISTING.
1. 00-bundle-resync.ts:37-78 and repo/bundle-ingest.ts:47,77 spawn git with no time bound; move to gitRun.
2. 01-worktree-setup.ts:363 `?? 'main'` still reachable when the branch is unknown; under autoContinue the #879 note is unseen.
3. 10-gate-3-commit.ts:184 writes commit_sha NULL over an earlier round's sha.
4. 99-run-app-ready.ts:338 a plain exit-128 branch read (or old payload) still offers the push, then drops it silently.
5. (display) _kb-commit.ts:75, 11d-skill-sync.ts:525, plan/snapshot-git.ts:31, 99:350 fold a no-answer `rev-parse HEAD` into null.
6. (low) 00-bundle-resync.ts:116-121 swallows a failed local-head read; `hasAny` unread.
7. (low) 12-post-onboarding.ts:466 currentBranch dead; 13-onboarding-push.ts:29 unread `branch?`.

### T323 · FNF[uploads-3] · leftover upload files never cleaned; unlink failures warn forever (+3)
status: taken · owner: fnf-run@ACTIVIT21 · since: 2026-10-24 · last: 2026-10-24T06:40Z
branch: fnf/323-uploads-3 · worktree: .claude/worktrees/p323 · brief: .claude/tmp/fnf-run/p323/drive.md (Codex)
All PRE-EXISTING.
1. repo/clone.ts:678 swallows a failed archive unlink after extract; reaper's liveRepositories keeps every non-error repo, so a ready repo's archive stays.
2. upload-reaper.ts:372 an orphan file that cannot be removed warns every 15 min forever.
3. upload-reaper.ts:418 finished dump files with no db_uploads row are never removed.
4. PARKED (user): `complete` rows in repo_uploads/custom_bundle_uploads and `consumed` db_uploads rows are never deleted — needs a retention rule.

### T288 · FNF[sync-reader] · project-state sync reader defects (+6)
status: taken · owner: fnf-run@ACTIVIT21 · since: 2026-10-24 · last: 2026-10-24T06:40Z
branch: fnf/288-sync-reader · worktree: .claude/worktrees/p288 · brief: .claude/tmp/fnf-run/p288/drive.md (Codex; items A,B,C,D,E)
All PRE-EXISTING.
1. DEFERRED (overlaps fnf/278): gitOperationInProgress (repo/git-operation.ts) reads an out-of-tree git dir as "merge open"; every caller holds forever for such repos.
2. persistDetection's sync (clone.ts ~299) and resolve.ts ~140 re-sync import without the under-lock re-read compare (#751). [in brief as B]
3. An empty `.haive-data/state/` reads as a broken record and stalls the sweep (sync.ts ~185). [A]
4. DEFERRED (overlaps fnf/278): onboarding-upgrades.md names `rebaseProjectStateOnCheckout`, which nothing calls.
5. Invalid settings/rtk-enabled.json warns on every sync (sync.ts ~790) and never repairs. [C]
6. Import markers record a synthesized rtkEnabled:false (import-marker.ts ~44). [D, may be harmless]
7. A sync outside persistDetection that adopts a teammate's rtk-enabled.json leaves the RTK question pending until boot; call raiseRtkQuestion after it. [E]

### T117 · B3.2 · catch checkout moves Haive did not make (+5)
status: open · kind: feature (designed; decisions D13-D16 taken)
Full design: .claude/tmp/track-b/b3/b32/analysis/{detect,backstops}.md and the B3 ledger (2026-10-15).
- D13 detached HEAD holds (no import, no stamp). D14 import a record on a branch other than repositories.branch. D15 host-folder pulls stay a Refresh. D16 kill switch PROJECT_STATE_SYNC_ENABLED default ON.
- Detect: nullable project_state_sync.synced_hash (next free migration number) = projectStateHash over what readCheckout reads (helpers in shared project-state/hash.ts); watchCheckout per repo from a 60 s scheduler on the plan-mirror queue; deduplicated SYNC_CHECKOUT job fired from GET upgrade-status, GET tooling-config, GET plan overview.
- Six watermark rules and backstop items 1-6, controls W1-W8: see the analysis files.
- Order: T266 item 6 lands with it or before.

### T118 · B4.1 · repository CLI set is a union
status: open · kind: feature (user decision taken)
render_context.cliTargets union; deriveRenderTargets in shared; 07, 12/03 stage paths, 01, 02 stubs, blank scaffold, api rulesImportGaps, resolveSkillTargetDirs callers; seed existing repos from the newest snapshot; upgrade offers adding the upgrader's CLI; removal explicit. Control (smoke): claude vs claude+codex.

### T119 · B4.2 · AGENTS.md rules block is repository-level
status: open · kind: feature (user decision taken)
repositories.agent_rules_override + settings/agent-rules.md + tooling editor; buildRepoCliRulesBlock for 07/12/01/api. Control: two users with different personal rules are quiet and byte-identical after.

### T120 · B5.1 · the Haive data panel
status: open · kind: feature
GET /repos/:id/haive-data + POST .../save {push} via a worker SAVE job; generalise commitPlanSnapshotFiles to a path list; conflict report. Browser 375/768/1280.

### T121 · B5.2 · project state rides Haive's pushes
status: open · kind: feature (user decision taken)
chore(haive) commit of dirty projections before the cleanup base push, 13, plan Save & push; PR path commits into the feature worktree; 12/03 commit default on when origin exists. Control: cleanup + push leaves origin without the record today.

### T122 · B5.3 · review watermarks travel; Haive paths leave drift ranges
status: open · kind: feature
settings/review-watermarks.json, descendant wins via merge-base --is-ancestor; _external-drift drops .haive-data/state/** and plan files. Control: B re-reviews A's KB-reviewed commits today; empty after.

### T266 · FNF[record-writer] · 04's set and record writes run unfenced (+5)
status: open
All PRE-EXISTING. Items 4, 7, 8 moved to T310.
1. 04's set and record writes run with no lock and no column fence.
2. refreshProjectState (project-state/refresh.ts:87-93) does not re-check live onboarding/upgrade between sync and write; re-read the holding check under the same lock.
3. Low: a crash mid-write leaves files ahead of the rolled-back DB; mark dirty before writing.
5. Dead code: rebaseProjectStateOnCheckout + rebaseLocked (sync.ts ~797-841) have no caller; mention in the PR, delete only if the user asks.
6. The state writer overwrites an on-disk record it never imported (write.ts:532-545); fix with B3.2's synced_hash (land with or before T117).
9. Low: 12-post-onboarding.ts:345 stores the applicable set from 07's rtkEnabled; a toggle between 07 and 12 leaves it stale.

### T286 · FNF[root-work] · a task at the root after 01 was skipped escapes the fences (+3)
status: open · area: touches finishMerge — heads-up to modular-haive-plan first
All PRE-EXISTING; notes .claude/tmp/track-b/b3/b31c/analysis/guard.md.
1. checkoutHoldingTasks({rootOnly}) (repo/refresh.ts:32-46) misses a task whose latest 01 round was skipped; count it in SQL like decideTaskWorktree.
2. 99-run-app-ready builds its preview at detect but commits `git add -A` at submit; can commit unseen files incl. Haive state.
3. Low, verify first: a root `git add -A` racing a projection writer can stage its temp file.
4. DECIDED D22: fence the whole open-merge window — refuse/delay a root task's START while a same-branch merge is open, under lockRepositoryTasksKey.

### T271 · FNF[dag] · the DAG level merge never settles Haive's own files
status: open
dag-executor.ts (~681, ~951) aborts level merges without resolveHaiveProjectionConflicts, so a conflict only in Haive files goes to a fixer. Fix: run B3.1c's revert helper on each DAG issue branch before its level merge. (#274 merged, so unblocked.)

### T291 · FNF[fs-park] · a process death mid-park leaves the file under its park name (+2)
status: open
All PRE-EXISTING.
1. fs-safe.ts ~1115-1262 parks as `.<leaf>.haive-park-<pid>-<uuid>`; a kill between rename and settle leaves it there; nothing sweeps it. Fix: boot/temp sweep puts it back when the name is free, else reports.
2. _rules-files.ts stripRtkBlocks (~180) / appendRtkBlock (~336) await 02's DB insert while AGENTS.md/CLAUDE.md is parked; record before the park.
3. plan/mirror.ts ~287/~316 await git while plan.json is parked — deliberate; item 1 covers it.

### T293 · FNF[onboarding-kb][verify-first] · 09_3's KB corrections may fail on a root-owned KB
status: parked · reason: needs a fresh onboarding run (see T300)
08-knowledge-acquisition.ts:2058 and its writes pass no owner, so a fresh KB may be root-owned and uid 1000 gets EACCES; 09_3's apply never checks the disk. Dev data disagrees in part. Verify on a fresh onboarding first; then pass the owner in 08, and make 09_3 diff the KB against the agent's claim.

### T303 · FNF[bundles-2] · bundle follow-ups from #284
status: open
All PRE-EXISTING.
1. Replace complete not resumable after its move (bundles.ts ~722-727); set 'syncing' before the move or key on the upload.
2. Bundle worker keeps BullMQ's default maxStalledCount (bundle-queue.ts:45-72); match repo-queue (10).
3. reconcileStrandedCloningRepos runs at boot only; call it from StalledTaskSweeper.sweep().
4. POST /bundles/:id/sync has no already-syncing check (bundles.ts ~792-816); 409 or key the job.
5. Web never shows lastSyncError; show it under a failed bundle (bundle-composer.tsx), browser check 375/768/1280.

### T304 · FNF[claims-2] · .git refusal misses NTFS aliases (+1)
status: open
1. Low: isClaimablePath (shared project-state/names.ts) and 02's safeDiskRel accept `.git.`, `.git `, `git~1`, `.git::$INDEX_ALLOCATION`; one shared predicate mirroring git's is_ntfs_dotgit / is_hfs_dotgit.
2. Cosmetic: 02's refusal warning says "not a path inside the repository" for `.git/...` (02-upgrade-apply.ts ~1295, ~1371, ~1460); reword (check tests first).

### T306 · FNF[test-fakes-12] · 12's apply runs unguarded; 04's skipped runs (+2)
status: open · kind: test-only
1. 12's 24 'written' runs are not wrapped in recordWritten (worker test/support/upgrade-apply-record.ts).
2. 27 of 04's 61 runs report 'skipped' (no render snapshot in their fakes); seed or assert 'skipped'.
3. api revive-beside-live.test.ts (~:530) logs "fake db: task_type_definitions was not given" as an unhandled error; give the fake the table.

### T308 · FNF[worktree-aliases] · hard links planted into .haive/worktrees before #800 survive
status: open
A file under `.haive/worktrees` sharing an inode with a name in the writable checkout stays writable through the alias. Fix: a one-time background sweep (recorded per repository) that copy-replaces files whose st_nlink exceeds their names under that tree, via fs-safe. Measure the walk on a large repo first.

### T309 · FNF[cancel-cap-2] · a capped cancel with no claim row never finishes (+6)
status: open
All PRE-EXISTING, low.
1. abandonCancelledTeardowns selects only tasks with merge_dir_claims rows; a DAG-mode capped cancel never gets cancel_finished, and worktreeSharer keeps counting it. Select also recorded mid-merge / DAG activeConflict within the re-drive window.
2. task-left-merge-banner.tsx polls /events every 3 s forever for a cancel that never finishes.
3. Nothing in the web reads cancel_finished's abandoned/reason; show one line.
4. A task whose recordLeftOpenMerges keeps throwing is reselected every pass (LIMIT 20 can starve the rest); write a cooldown event.
5. The abandon pass skips cleanupTaskContainers and cleanupTaskScratchWorkspace (task-queue.ts ~1012); verify a reaper doesn't cover it, then call them best-effort.
6. No real-DB coverage for the refund on a refused enqueue or the sandbox guard; ~25 lines in stalled-redrive-smoke.ts.
7. merge-resolver `halt` keys "own merge" on ref/sha, so a cancelled task's same-ref open merge reads as this step's (area: modular-haive-plan).

### T312 · FNF[rag-own-paths][verify-first] · customCodePaths can name missing directories
status: open
Eval repo 0e72847d names `sites/all/modules/custom/` + `sites/all/themes/custom/` (neither exists; real code is `sites/all/modules/activit`), so D1's own-code exemption never applies. Verify where customCodePaths comes from and how many dev repos name a missing path; then detection verifies candidates and the RAG build warns when an own-code path matches no file.

### T316 · FNF[merge-resolver-2] · resolver follow-ups (+8)
status: open · area: modular-haive-plan (heads-up first)
1. Dead code: the origin-keeps-advancing halt and MAX_BASE_SYNC_ROUNDS never fire (baseSyncRounds never passes 1). Re-enter prePushSync from a base-sync round, or delete both and update merge-conflicts.md.
2. A person's commit on an unrecorded squash: reported as "Squash skipped"; walk first-parent for the squash.
3. Reset/commit recovery still require ORIG_HEAD even with squashMergeSha (git-merge.ts ~1345-1356).
4. Trivial: two throws in squashMergeCommit with no recovery clause.
5. Lock hold: C1/C2/C3 (reopen, captureFixBaseline, openMerge hand-back out of the lock); crash window on baseShaBefore. Analyst marked three variants UNSAFE — see the task's history in .claude/tmp/fnf-run/.
6. handBackWritten ~2.2 ms CPU per path (git-merge.ts:226-228); a directory-grouped primitive.
7. CLOSED by #873. 8. CLOSED by #877.
9. left-open-merge.ts:61-65 peekOpenMerge reads an unreadable dir as gone (may be covered by fnf/278); merge-resolver.ts:686-691 countAhead reads a failed count as 0 and skips the pre-push sync.

### T144 · RAG F6 · the lexical half rarely co-supports a hit
status: open · kind: ranking change (gated on the retrieval eval)
shared/src/rag/search.ts:449/:560 plainto_tsquery ANDs every term; 67.6% of logged searches with code hits had no two-ranker hit. TRAP: plain OR and coverage ranking measured WORSE (AGENTS.md "Identifier search"). Plan P2(b): a capped IDF ranker.

### T145 · RAG F13 · Slovak text matches only verbatim
status: open · kind: needs plan approval
_rag-connection.ts:130 update_content_tsv uses to_tsvector('english') without unaccent ("kotolna" misses "kotolňa"). Needs a backfill (like backfillIdentifierTsv) and a fail-open path without the extension. Plan P2(e).

### T147 · RAG F5 · identical chunk bodies across files are never collapsed
status: open · kind: ranking change (gated on the eval)
8.3% of chunks share a body with another file's chunk. A query-time collapse needs the SQL LIMIT widened past top_k. Plan P2(c).

### T149 · RAG F15 · deleted vectors keep their HNSW space
status: open
A 0-row project store still holds a 275 MB HNSW index (_rag-connection.ts:69); nothing runs REINDEX. Measure index size before/after the next full reindex (ride T311's reindex).

### T275 · full-repo review pass after Track B
status: blocked · blocked-by: T117-T122
A full-repository review in the style of the Codex PR reviews once Track B is merged; file findings by bundle.

### T300 · live re-checks owed at the next real onboarding + workflow run
status: parked · reason: needs a real onboarding + workflow run (LLM tokens; check running tasks first)
Items 1-20 (each with its memory file): skills per CLI after 09_5; frontmatter YAML; agent_rules stamp; declared verify commands; invariants-doc lever; prompt guard/fence (07_7); onboarding artifacts; plan breadth refusals; agent isolation 1/2/4; fs-safe live verification; #169 DDEV runner boot-subpath; #241 Terminal cwd; AGENTS.md split citations; parked experiments (Astra vs Sol, container-cleanup race, global KB purge, haive_rag_ddevtest drop); T293; #287 EROFS on state; #800 mounts; #751 set-aside on a real merge; #806 put-back; #815 reindex spot-check. Full list: task #300 text in the fnf-run ledger / memory.

### T298 · house rules PR8 · switch similarity on with per-rule floors
status: parked · reason: needs graded data (an ENFORCED `files` rule + workflow tasks reaching 07)

### T299 · verify-first · house rules PR7a zero-token live check
status: open
Read .claude/tmp/house-rules/ledger for a PR7a live-check entry; if absent, run it per the house_rules_series memory against repo hr6-live-d7 (3e2c0533), then decide whether hr6-live-d7 is still needed.

### T199 · /favicon.ico answers 404 on every page
status: parked · reason: user's choice of icon
Add an icon via the Next app-router convention (src/app/icon.svg or favicon.ico).

### T270 · FNF[plan] · a child insert can take a parent's path from before a concurrent move
status: parked · kind: design · reason: user decision
applyPlanPatch's loadNode reads the parent path unlocked (shared/src/plan/apply-patch.ts:415). FOR SHARE on the parent is not enough (a move rewrites descendants in one UPDATE). Direction: a per-repository plan-patch advisory lock first in applyOps; lock-order analysis owed.

### T310 · FNF[kept-metadata-moves] · captured owner/mode lost when a re-sync does not finish
status: parked · kind: design · reason: user decision
A: six non-merge move paths drop the kept map after a re-sync that may have returned false. B: projection writers create files as root (verify on dev). C: persisted keptMetadata never settled again. D: reachDone / settleGoneMerge after a failed re-sync. Options: inherit owner from parent dir; persist the kept map per repo; retry the re-sync before restoring.

### T317 · FNF[rtk-first-import] · a stamped RTK choice loses to the first record import
status: parked · kind: design · reason: user decision (recommended: yes, stamped wins)
sync.ts:514 (`row !== null`) and :528; pinned by project-state-sync.test.ts:1850 and onboarding-upgrades.md. Fix if approved: drop `row !== null`, flip the test.

### T318 · FNF[task-lock-wait-2] · remaining unbounded waits on start paths (+5)
status: parked · kind: design · reason: user decision
1. /clarify takes the creation lock for a live task (api tasks/steps.ts:821). 2. Worker revival wait unbounded (_revive-check.ts:86); needs a soft-fail path first. 3. reviveDeadTask takes no creation lock. 4. mergeInScratch uses the pool inside the plan-merge transaction. 5. New-work fence and the advisory start's plan_nodes lock wait unbounded. 6. Ten waiting starts can starve the api pool for 30 s.

### T319 · FNF[set-aside-batch] · set-aside spends 20-24 git spawns per dirty path (+1)
status: parked · reason: user go-ahead on scope
1. set-aside.ts:264/:281/:474/:574 per-path git reads (prototype: 6,620 spawns → 20). 2. readStateTree one cat-file per file (projection-merge.ts:157); batch with `cat-file --batch`.

### T326 · FNF[house-rules-unread] · a failed fingerprint read skips modifiedAfterCheck
status: parked · kind: design · reason: user decision on the gate wording
house-rules-dispatch.ts:45 → _gate-house-rules.ts:283: a null fingerprint means the gate cannot tell files changed after the check; add an explicit "unread" marker.

---

## Done

(One line per finished task: `T<n> — <title> — PR #<n> (<merge sha>), <date>`.)
- T327 — Attachments tab note for read-only and repo-less tasks — PR #880 (128efe0f4), 2026-10-24
- T325 — must-not-fail steps note a git that gave no answer — PR #879 (c1a55c613), 2026-10-24
- T324 — attach controls hidden for read-only local repos — PR #878 (1a23f4fd4), 2026-10-24
- T322 — a git that gave no answer is unknown, never "no" — PR #877 (8bc89b15a), 2026-10-24
- T320 — New Task names a refused deferred start — PR #876 (0a1ffef0c), 2026-10-24
- T305 — upload cleanup follow-ups — PR #869 (11c6cf9ca), 2026-10-24
