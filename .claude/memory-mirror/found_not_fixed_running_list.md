---
name: found-not-fixed-running-list
description: Deliberate omissions carried across sessions; surface during review-loop wait windows and in every final report
metadata:
  node_type: memory
  type: project
  originSessionId: dc11f5ec-28cf-424a-91d6-7d4fd9d94812
  modified: 2026-10-17T14:09:03.557Z
---

Running list of things found and deliberately NOT fixed. Surface it (a) whenever the user is
waiting on something long-running, and (b) in every final report. One line each: what it is,
REGRESSION or PRE-EXISTING, why it was left. Most consequential first.

**Why:** every non-trivial task turns up defects outside its scope. Deciding "not now" is
usually right; deciding it silently is not, and an unverified entry is worse than no entry.

**How to apply:** verify each entry against the code before writing it down, and move an
entry to Closed (with its PR) once it lands.

Consolidated 2026-09-26 after sweep 2 ([[found-not-fixed-sweep-2-series]], #301-#325). Each open
entry was verified when recorded (2026-09-22 to 2026-09-26); sweep 2 rewrote much of the task
queue and the upgrade steps, so re-verify an entry against main before acting on it. Smoke
containers for queue smokes:
`h1-smoke-pg` (127.0.0.1:55432, user `haive`, trust auth, DBs `haive`/`haive_h5`) and
`h1-smoke-redis` (127.0.0.1:6392).

## Bundles (one PR each; agreed 2026-10-03, in planned order)

The rule is [[fnf-items-as-tasks]]. In session 3813bbf6's task list every member's subject reads
`FNF[<slug>]:`, and the lowest open id heads the bundle. A single carries no slug until a second item
joins it.

1. `tests` — SHIPPED 2026-10-09 as #465 (merge eb000497, main CI green); see Closed 2026-10-09 below.
2. `upgrade-status` #165 #166 #233 #235 #237 — CLAIMED 2026-10-09 by session 3813bbf6 (worktree
   `fnf-upgrade-status`, ledger `.claude/tmp/upgrade-status/`): `api/routes/upgrades.ts`, `api/lib/onboarding-state.ts`,
   the POST /tasks gate (`routes/tasks/index.ts`) and `upgrade-available-banner.tsx`. #233 is 01's
   side of the banner's removable rule.
3. `snapshot` #205 #210 #232: what `pickRenderSnapshot` (`_upgrade-render.ts:96`) takes as recorded
   (`{}`, a synthesized `rtkEnabled: false`, a missing key), and one rtkEnabled predicate for the
   banner and 01.
4. `upgrade-apply` #176 #180 #236: an `undecodable` outcome for `readUpgradeFile`
   (`shared/src/rules-files.ts:32` decodes lossily) and the region rewrites, plus a retried 02's leftovers.
5. `onboarding` #167 #175 #186 #200: 07, 12's staging, `repo/blank-scaffold.ts`, `01-env-detect`'s
   name fallback. It may fold into B1.6/B1.7 (#110/#111), which touch 12 and install.json.
6. `worktree` #214 #221 #222 #223: `01-worktree-setup` (claim by directory, `carryUntrackedForTask`)
   and the task's worktree columns after a removal.
7. `runners` #213 #215 #216 #219 #224: `ddev-runner`, `app-runner`, the reaper, 08b's preflight.
   Re-check #219 first: the #170 it waited on landed in #390.
8. `git-merge` #174 #184 #185 #187 #189: `git-merge.ts`, the merge resolver, the `-z` path-list sweep.
9. `plan-merge` #172 #173 #182 #188: `01-plan-merge.ts`, `plan/merge.ts`.
10. `files` #202 #217 #220: fs-safe overwrite-in-place and replace-atomic temps, the upload chunk claim.
11. `images` #177 #178: sandbox image removal versus builds.
12. `lifecycle` #171 #195: DONE — #195 merged #517; #171 moved to Decided 2026-10-12.
13. `plan` #198 #238 — CLAIMED 2026-10-09 by session 3813bbf6 (worktree `fnf-plan`, ledger
    `.claude/tmp/plan-bundle/`): `03-plan-sequence`'s asked count, the plan-mirror import error on a rescan.

- a644756a's #19 (global-kb-retry route.fetch outliving its test) CLOSED: already fixed on main by
  51190eee (2026-10-05, `unrouteAll({ behavior: 'wait' })` in the finally); the tests-bundle builder
  reproduced it 5/5 on the file before that commit and 0/5 after.
- Single, NEW 2026-10-09: #240 (session 3813bbf6) Next 16 deprecates `packages/web/src/middleware.ts` in
  favour of the proxy convention (boot log warns; no proxy.ts on main). Design first: runtime and export
  change on a delicate file.

14. `test-noise` #239 (session 3813bbf6, NEW 2026-10-09): one full worker pass logs 633 warnings;
    135 are accidental (71 "global KB could not be read for a dispatch", ConfigService not
    initialized; 64 "failed to load finding recurrence"), the rest are scenarios under test.
    PRE-EXISTING; same rule as #231, but a sweep across many test files.

- Singles, design first: #181 fan-out refusal, #190 RTK block on switch-on (deferred), #197 09_6
  CLI pick, #218 DAG coder app reach, #228 release-added template (NULL column), #230 sync/upgrade
  window, #234 per-path obsolete removal.
- RAG, ordered by [[rag-retrieval-plan]]: chunker #142+#143; store #149+#196 (#196 may close as
  decided); #144 #147; #145 alone. (#140, #148, #183 merged 2026-10-12: #589/#590, #591, #596.)
- Track B pairs: B1.6+B1.7 (#110+#111), B2.1+B2.2 (#113+#114), B3.1+B3.2 (#116+#117), B4.1+B4.2
  (#118+#119), B5.2+B5.3 (#121+#122). B1.5, B1.8, B2.3 and B5.1 go alone.
- Need the user: #194 (delete 5 invites, local), #199 (favicon choice).
- Session f3f0c544's list ([[house-rules-series]], live): #1-#3 are its PR1-PR3. Its FNFs fit here:
  #13 → `tests`, #10 → `runners` (08b into `ddevExecOnce`), and #11+#12 → one bundle `dag-prompts`
  (dag-executor `reviewerPrompt`). #9 stays a single, since that series left it out on purpose (the
  slot shape is persisted and rendered). New 2026-10-03: #15 (+1) → bundle `gkb-merge` (09_6_4), #18 (+1) → bundle `gkb-web` (settings page), #16 and #17 singles, #19 single (needs the user).
  FOLDED 2026-10-09 (one task per bundle, members appended to the head): `runners` = #10 (+3, incl. ex-#24 gitRun
  timeout); `tests` = #13 (+2, incl. ex-#25 fake-db orderBy); `git-merge` = #14 (+1, ex-#27 parsePorcelainZ);
  `gkb-web` = #18 (+4, incl. ex-#21 stale admin save, ex-#26 375 px overflow); `review-scope` = #28 (+1, ex-#29
  gate-2 coverage); `dag-prompts` = #11 (+1); `gkb-merge` = #15 (+1). Singles: #9, #16, #17, #20, #23; #19 needs the
  user. #22 closed by #458. 2026-10-09: #19 CLOSED AS DECIDED (user keeps the embedder settings open); NEW `rag-embed` = #32
  (+1); singles #33 (08b "no spec recorded"), #34 (runtime admission before skip); #28 gained item 3 (07b stale file list).
  PAUSED 2026-10-09 ~20:45 (user, allowance), nothing running; ledger `.claude/tmp/fnf-f3f0/ledger.md` has every
  verdict. Open branches at the pause: #28 `review-scope` PR #462 has 3 LOCAL commits (658beb99 77b642ae 605b2e3a,
  folding #39 items 1+2) — fix their wording regression in `_gate-house-rules.ts` first (detect-time scanFailed says
  "re-read after a fix"), add review-scope.md docs, push, answer Codex 4232884313; #16 PR #467 has one valid Codex
  P2 to fix (`hasLeadingHaiveBlock` must take `\n</haive_x>` as a close only when '\n' or the end follows);
  #20 `fnf-report-slice` LOCAL (f8c1c5d7 07a411cc 9f995d70; docs fix-loop.md, then PR); #40 `fnf-ddev-config`
  LOCAL (02fb452d 1b971f20; two regressions to fix first, or parse with the existing `yaml` dep); #15 brief ready
  (`gkb-merge/brief.md`). NEW 2026-10-09: #48 single (truncation retry reads its notice anywhere), #49 single
  (`excerptDiagnosis` marker formatting), #50 heads `gate2-slices` (+1). Full suites run under
  [[haive-serialize-full-suite-runs]].
- Session 28d6c55c's list ([[aide2-first-wave-series]]): #5 is T5's design single (PR-A, the `guidance`
  field); `fix-prompt` (PR-B) is #11 (head) + #12 #15 #16 #17 (`_fix-loop.ts`, 07's framing, 07b's honored
  block, the digest, the cap gate); #13 joins `plan`; #6 #7 #8 #9 #14 #18 #19 #20 are singles.
- Session 77d92749's list (second-install test, 2026-10-03; the `blank` install was removed 2026-10-08): #5
  `install-names` CLOSED by PR #433; #9 heads bundle `sandbox-net-leftovers` (`config.service.ts` dead key,
  `egress-discover.ts` fallback) CLOSED by PR #434; #10 closed by the user (Codex part unverified); #11
  `migrate-install-names` (migration runner store-name refusal, guard root for `packages/database/src`) CLOSED by
  PR #435. Nothing from this session is open.
- Session a644756a's list (task fdd57e6b, PR #403): #13-#18 are singles; they share no code. The one
  Codex raised on #403 (partial LSP install read as ready) was fixed in the PR, so it is not listed.

- Session 3813bbf6, 2026-10-16 update (same ledger):
  - USER DECIDED: D17 #282 a same-branch merge HALTS beside other root tasks like 00a's ff; D18 #289
    release claims when the cancel re-drive gives up (task.cancel_finished abandoned); D19 #269 a
    deliberate Tooling RTK toggle travels (analyst running: the column flag also drives 01's render
    origin); D20 #194 DONE (5 stranded invites deleted on dev, local-only).
  - IN REVIEW: #751 B3.1b-2 (round 6; r5's two P2 = #266 item 8, deferred + doc corrected 7f716b919);
    PR #796 #264 (claims never name `.git`; 01 skips pre-rule rows); PR #797 #302 (recordWrite field on
    02/04/12 outputs, guard keys on it). BUILDING: #285 fix-1 (D10 regression: a Retry after the dump
    was reaped must fail loudly, + 3 reaper gaps); #289 (D18).
  - NEW FNF: #304 FNF[claims-2] (NTFS `.git` aliases; 02 refusal wording); #305 FNF[uploads-2]
    (failed-extract archive kept forever; chunk cursor unguarded; empty dirs/cancelled rows); #306
    FNF[test-fakes-12] (12's written/skipped runs unguarded; 04's skipped runs). #266 now (+7): item 8
    = #751 r5's reachDone/settleGoneMerge paths.
  - WATCHER FIXED: .claude/tmp/backlog/pr_watch.sh now paginates reviews/comments/reactions (a review
    past the first 30 read as none; #751 r5 timed out while Codex had answered).
  - LATER 2026-10-16: MERGED #800 (#301 root-mounted agents see `.haive/worktrees` read-only;
    9c0c8ee77; #308 = pre-boundary hard links, one-time sweep owed). #751 r8 fixed (kept metadata taken
    before the abort, own committed write). #796 r3 = REGRESSION (a legacy `.git` claim file refused the
    whole record: refresh + projection-merge blocked), fix-3 in flight. #289 judged, fix-1 in flight
    (abandon pass blocked the sweeper = REGRESSION; aged-out 1-2x re-driven gap; report before release).
  - NEW FNF: #309 FNF[cancel-cap-2] (+3): a capped cancel with no claim row never finishes (DAG
    integration merge unreported, worktreeSharer refuses a shared path's abort); banner polls every 3 s
    forever; web never shows the `abandoned` note; a persistently failing report can occupy the
    LIMIT 20 batch. PRE-EXISTING / by design.
  - CLOSED 2026-10-16: #278 (B3.1b-2, #751 → 73387da84), #301 (#800 → 9c0c8ee77), #264 (#796 →
    4a589b3a3, 4 Codex rounds; a legacy `.git` claim file is read apart and removed by the writer;
    set-aside's `stateOffender` renders the base without such claims). All main CI green, dev synced.
  - NEW single #310 FNF[kept-metadata-moves][design] (#751 r9, PRE-EXISTING since 9de145b4c): the five
    non-merge move paths restore kept owner/mode right after the re-sync and drop the map even when the
    re-sync returned false.
  - IN REVIEW: PR #802 (#289 abandon pass, D18); PR #798 r3 → fix-3 in flight ('reaping' dump state;
    replace tail fully unclaimed on failure). BUILDING: B3.1c #274, #269 (migration 0208), #282 (D17),
    RAG P1 harness (#142/#143).
  - DEDUPED 2026-10-16: #310 now holds #266 items 4, 7, 8 (same kept owner/mode mechanism: writers
    inherit the parent's owner, and/or a persisted kept map settled by the sweep, or a retried re-sync).
    #266 is (+4): items 1, 2, 3, 5, 6. Item 5 (dead `rebaseProjectStateOnCheckout`) = #288 item 4:
    MENTION in the PR, delete only if the user asks. #802 r1: 2 P1 (re-drive count kept on a failed
    enqueue + no sandbox guard; finish record written after the release) → fix-2 in flight.
    #270 lock-order analyst running (notes .claude/tmp/track-b/b3/p270/analysis/lock-order.md).
  - PARK (user, 2026-10-16): finish in-flight only ([[series_parked_for_skill_test]]); #270 analyst
    stopped. NEW FNF from the RAG P1 harness: #311 FNF[rag-chunker-2] (+3: "class" in comments →
    563 wrong method owners; false sections in strings/comments; braces in strings; MIN_GAP_CHARS
    comment) and #312 FNF[rag-own-paths][verify-first] (customCodePaths name dirs absent in the
    eval tree, so D1's own-code exemption never applies). #309 now (+5): abandon pass skips
    cleanupTaskContainers/scratch cleanup; no real-DB coverage for refund/guard. #798 r4: 2 P1
    REGRESSIONS (row-before-move strands repo/dump sessions; bundle claim not exclusive) → fix-4.
  - CLOSED 2026-10-16: #289 (#802 → 57d6c4786, 2 Codex rounds; abandon pass: sandbox guard → report →
    finish record → release; refused re-drive refunded; re-drive `attempt` count fixed). Main CI green.
- Session 3813bbf6, SYNCED 2026-10-15 (Track B B3 tail; ledger `.claude/tmp/track-b/b3/ledger.md`
  "OPEN WORK INDEX"; the task list mirrors this block):
  - CLOSED today: #267 (02 retry stages its retirement) merged #754 abb153483 after 12 Codex rounds;
    #292 (343 legacy bundle schedulers + 1 cli-exec, pruned at boot) merged #772 e44e31fde, live-verified;
    #295 (boot schedulers close their Queue) merged #778 a58ba0fd3, live-verified; #296 (bundle list polls
    only while syncing) merged #779 a047693f1, browser-verified; #287 (.haive-data read-only to agents,
    refuses a non-directory root/.haive-data and a hard-linked protected file; step 11 KB rule) merged
    #777 5ada96b56 after 3 Codex rounds (live check = #300 item 16).
  - NEW today: #301 FNF[root-mount-worktrees] design single (root mounts expose .haive/worktrees/* RW;
    docker volume-subpath follows a relative in-volume link, MEASURED); #302 FNF[test-fakes-04] (04's
    sibling tests swallow its record-write failure, 17 runs; + structural record-write field); #280 +1
    (squash folds a person's base commit after a halt); #266 +1 (item 7: a failed re-sync loses the
    captured owner/mode). In flight: #290 = PR #782, #264 builder, #751 fix-7 judged (worktree regression
    fixed by me), #284 builder.
  - In flight: #278 B3.1b-2 = PR #751 (round-3 Codex: ff hand-back gives projections to uid 1000;
    settleProjections drops keptMetadata after a failed re-sync — both introduced by the PR, fix-7);
    #294 = PR #775 (Codex showed the change wrong: 12's failure path must not stage install.json's
    deletion without the record in the same commit → repurposed to docs; gap self-heals at the next
    successful 12); #287 = PR #777 (.haive-data read-only for agent sandboxes, D4-D7 + D12; step 11's
    root investigation no longer fakes the KB marker) in review; #284 (bundle create crash-safety, D8)
    building.
  - Open bundles/singles (head task id): #264 `claims` (+1: an imported claim can name `.git/...`);
    #266 `record-writer` (+5); #288 `sync-reader` (+3: out-of-tree git dir, re-syncs without a merge
    check, empty state dir stalls the sweep, stale doc name); #290 `test-fakes` (+2); #291 `fs-park`
    (+2; its lenient-lstat item fixed by #754); #286 `root-work` (+2); singles #269, #271 (after
    #274), #280, #293 (verify-first: 09_3 vs a root-owned KB), #295 (Queue never closed), #296 (web
    bundle polling); designs #270, #282, #285 (DECIDED D9-D11, after #284), #289.
  - Outside FNF: #275 full review pass (last); RAG #140 P0 (MERGED #589/#590), #148 F3 (D1, MERGED
    #591/#597/#598) and #183 F14 (MERGED #596) were stale and are closed (2026-10-15); still open
    #142+#143 (P1, one reindex; F2's JS half waits on D2), #144 #145 #147 (P2), #149 F15; house rules #297 PR7b ALREADY MERGED #486 (stale task closed 2026-10-15), #298 PR8 (parked on
    data), #299 PR7a live check (verify-first; needs a fixture enforced files rule); #300 live re-checks at the next real onboarding + workflow run; #117 B3.2
    (DECIDED D13-D16), #274 B3.1c (after #751), #118-#122 B4/B5. Waiting on the user: #194, #199.

## Open, most consequential first

### 2026-10-18 /codex-sonnet pilot 1 on #229 (modularity session task numbers) — new items

- **#232 FNF[diff-file-read]** (PRE-EXISTING, moderate, bundle head): `buildFileEntry` (`_commit-diff.ts:150-166`) leaves oldContent '' when `cat-file -s`/`show HEAD:<path>` fails, so a modified file renders all-added / a deletion empty in the gate viewer; needs a per-file unreadable flag + viewer render.
- **#233 FNF[plan-status-fail-open]** (+1, PRE-EXISTING, minor, bundle head): `plan-mirror-queue.ts:457` treats a failed status as clean before integrateOrigin; `api/routes/plan.ts:363` reports "nothing uncommitted" + pushed state on a failed status.
- `git-merge.ts:44` `mergeCommitted` unchecked status (minor) — folded into peer session git-data-readonly-containers #280 (+5), not filed here.

### 2026-10-17 #307 closed (#835, 7ebdf8392) — new and appended items

- **#313 FNF[rtk-question][design]** (+3, PRE-EXISTING; item 1 more reachable since D25): needsRtkQuestion
  (rtk-conflict.ts:21-28) ignores the column flag, so a recorded install can be asked about a stale OFF blob;
  "keep mine" stamps nothing (resolve.ts:203-211), so D25 adoption can override it — DECIDED D27 2026-10-18: YES,
  "keep mine" sets rtk_choice_made_at (counts as a person's choice); old-rule clone columns (flag true, no stamp) keep emitting their default
  (write.ts:504-507); persistDetection asks before the tooling import (clone.ts:292-309).
- **#314 FNF[task-lock-wait][design]** (split from #280 item +3 on 2026-10-18; PRE-EXISTING, widened by #805): nothing bounds
  the wait for the task-creation advisory lock (repository-task-lock.ts lockRepositoryTasksKey). Checkout moves hold it across
  git work, while each waiting start holds an api pool connection (max 10). DECIDED D26 2026-10-18: every start gets one
  bounded wait (lock_timeout 30s, the same as withDatabaseSnapshotLock), and a timeout answers 409 "the repository is busy,
  try again". Move git work out of the lock where it can move. NOT started.
- #280 FNF[merge-resolver] CLOSED 2026-10-18: MERGED #837 (1a82a3bf3). It covers items 1, +1, +2, +4, +5 (peer), the +6 unpinned push, and the +7 plan-push siblings.
  Leftovers were filed: #314 (D26 lock wait), #315 (git exit codes), #316 (+3, squash/claim residuals), #309 item 7.
- **#315 FNF[git-exit-codes]** (+1, 2026-10-18, #280 reviewer): gitRun maps a spawn failure (e.g. a missing cwd) to `code: 1` (repo/git-exec.ts:114),
  so a `code === 1` reader treats "could not start" as "git said no", PRE-EXISTING, consequential; 00a countCommits returns 0 when rev-list fails
  (00a-sync-base.ts:109-114), minor. #309 item 7 (same day): halt's "own merge" is keyed on the ref, so a cancelled task's merge of origin/<base>
  keeps another step's claim, which then refuses its Abort button.
- 2026-10-23: #313 MERGED #847 (93699577b). New: #317 FNF[rtk-first-import][design] (a stamped choice loses to the first import with no sync row, sync.ts:514; needs a decision); #288 item 7 (a sync outside persistDetection leaves an RTK question pending until boot).
- #266 item 9: 12-post-onboarding.ts:345 stores the applicable set from 07's rtkEnabled (low).
- #288 items 5-6: invalid rtk-enabled.json warns every sync, never repaired (sync.ts:790-794, write.ts:522);
  import markers record a synthesized rtkEnabled false (import-marker.ts:44-49), harmless today.

### Synced 2026-10-17: open items the list lacked (session 3813bbf6 task list is the full text)

- **#286 FNF[root-work]** (+3, all PRE-EXISTING): (1) `checkoutHoldingTasks({rootOnly})` (refresh.ts:32-46)
  counts root work by `worktree_path IS NULL`, so a task whose 01 ran, was retried, then skipped works at the
  root uncounted by 00a's ff fence, the plan-land fence and the same-branch merge fence; fix: count a latest-01
  `skipped` round, in SQL, as `decideTaskWorktree` does. (2) run_app's 99 previews at detect but commits
  `git add -A` at submit, so the commit can carry files never shown (Haive state files included). (3) verify
  first: a root `git add -A` racing a projection writer can stage its temp file. (4) only the OPENING of a
  same-branch merge is fenced (#805, D17): a root task can START while a fixer holds the merge open.
  **DECIDED D22 (user, 2026-10-17): cover the whole open-merge window** — refuse or delay to queued a root
  task's START while a same-branch merge is open in the checkout, under `lockRepositoryTasksKey`; the landing
  sections (finishMerge) are peer modular-haive-plan's, so heads-up first. Not started (park).
- **#280 FNF[merge-resolver]** (+4): (1) prePushSync fetches inside a DB transaction (merge-resolver.ts:540-543).
  (2) the squash resets to a base tip measured once at the first open, so a person's base commit between a halt
  and a Retry is folded into the squash (fix: squash only when HEAD's first parent is the recorded base).
  (3) a halt that opened nothing keeps the step's merge-dir claim until Retry/end (00a skips its sync meanwhile).
  (4) WIDENED by #805: nothing bounds the wait for the task-creation lock (no `lock_timeout`); a checkout move
  holds it across git work while each waiting start holds a pooled api connection (pool 10); a pinned-DB create
  carries `SET LOCAL lock_timeout '30s'` and gives up with 55P03 while others wait forever. Fix (product call):
  one bounded wait answering 409 "repository busy". (5) trivial: repository-task-lock.ts:17-18 detached JSDoc.
- **#303 FNF[bundles-2]** (all PRE-EXISTING, from the #284 builder): (1) replace complete is not resumable after
  its move, and a death before the bundle row update leaves the bundle `active` with a new archive and an old or
  missing extracted tree (still true after #798's one-transaction replace); (2) the bundle worker keeps BullMQ's
  default maxStalledCount (repo worker: 10); (3) `reconcileStrandedCloningRepos` runs at boot only; (4) POST
  /bundles/:id/sync does not refuse a bundle already `syncing`; (5) web never shows `lastSyncError`.
- **#307 FNF[rtk-choice][design]** (design single, PRE-EXISTING; notes .claude/tmp/track-b/b3/p269/analysis/rtk-travel.md):
  F1 the sync fills a NULL render-context column with `rtkChoiceRecorded: true` (sync.ts:674), so a fresh clone
  records its own default as a choice and can later override a teammate's travelled toggle (candidate rule: a
  clone records a choice only when the record carries settings/rtk-enabled.json; changes pinned tests). F2 an
  install that never recorded a choice keeps pre-RTK rendering after importing a teammate's value, so its banner
  keeps offering to remove the teammate's RTK files. F3 FIXED in #807. F4 (low) answering a render question
  while the column is NULL also records true (resolve.ts:762,:777). F5 02 applies a plan made before the first
  toggle with the old flag while the writer carries the new setting (files lag until the next upgrade). F6
  `needsRtkQuestion` ignores `rtk_choice_made_at`. F7 (low) 04 expands its applicable set from the restored
  context's own RTK value in the unstamped case. [CLOSED by #835 7ebdf8392 on 2026-10-17] **DECIDED (user, 2026-10-17): D24 (F1) the candidate rule —
  a clone records an RTK choice only when the imported record carries settings/rtk-enabled.json; D25 (F2) a
  never-chosen install ADOPTS a teammate's recorded value.** F4-F7 follow from them. Not started (park).

### Filed 2026-10-16/17 at the park (session 3813bbf6; tasks #305 and #311)

**#305 CLOSED 2026-10-24: merged #869 (11c6cf9ca), items 1-9 fixed (0209 index applied on dev). Leftovers in #323 FNF[uploads-3].**

- #305 item 8 (uploads-2, low, by the round-6 rule): a removal that fails forever leaves its upload row
  `reaping` and logs a warning every 15 min (`finishReaping`, worker `repo/upload-reaper.ts`). Cap or escalate.
- #305 item 9 (uploads-2, cosmetic): the four complete routes' early `status === 'cancelled'` check
  ignores `reaping`; a late complete answers `incomplete: x/y bytes` instead of `session cancelled` (both 409).
- #311 item 5 (rag-chunker-2, trade-off of #815): a short span holding a closer and the next head goes
  whole to the next section (`},\n },\n customize:` in `function-customize`); split at the first worded line.
- #311 item 6 (rag-chunker-2, PRE-EXISTING reader shape): `.rb` sections stop before `end`, so a short
  `end` plus a constant now lead the next method's section (they were dropped before #815).
- #311 item 3 annotated: a `}` in a string still ends a section early, but since #815 its rest is kept.

- **[2026-10-14 Track B B3, session git-data-readonly-containers; ledger .claude/tmp/track-b/b3/ledger.md]** filed by bundle:
  - **FNF[root-mount-worktrees] task #301 (design single, 2026-10-15):** every repository-root invocation mounts `.haive/worktrees/*` read-write, so a root agent can rewrite or delete any other task's worktree, or swap it (or its `.haive-data`) for a link. MEASURED: docker's volume-subpath follows a relative in-volume link. #777 refuses a non-directory root/`.haive-data` at lookup time; a swap between that lstat and docker's mount remains. Fix: `.haive/worktrees` read-only (or empty ro tmpfs) for root invocations. PRE-EXISTING.
  - **FNF[merge-resolver] task #280:** prePushSync runs a network fetch inside a DB transaction (merge-resolver.ts:540-543). PRE-EXISTING.
  - **FNF[merge-resolver] task #280 (+1, 2026-10-15, peer modular-haive-plan's finding 1, VERIFIED on main 8299f18ff):** the squash resets to `baseShaBefore` measured once at the first open (merge-resolver.ts:908-914, saved :937; a Retry keeps it, ZERO_MERGE_RETRIES only zeroes conflictRetries); after the exhausted-retries halt (:1121-1126) a person's commit on the base (or a pull into it) before "Retry with AI" (reopen :1133-1160) or a by-hand finish (:1117-1119) is folded into the task's squash commit by `reset --soft` (git-merge.ts:1272-1300, no ancestry check) and leaves the branch history (content kept; an already-pushed commit makes the next push non-ff). The failed step keeps its merge-dir claim (released only :385), so no other Haive task moves the base meanwhile. Fix: squash only when HEAD is the feature's merge commit whose first parent is the recorded base, else keep the merge commit and say why. PRE-EXISTING.
  - **FNF[record-writer] task #266 (+3):** 04's set/record writes unfenced; refreshProjectState no live-task re-check after its sync (refresh.ts:87-93); crash mid-write leaves files ahead of a rolled-back DB; projection writers create NEW files/dirs as the worker (root) in a uid-1000 checkout, so a projection the sweep re-creates after a deferred move re-sync loses its owner/mode (verify-first; fix: inherit the nearest parent's owner). PRE-EXISTING.
  - **B3.2 task #117 (+4):** sweep is the backstop for API Stop with no worker job, a dead task never cancelled, a first state record whose re-sync failed (no outbox row, so no mark), and the cancel re-drive cap of 3.
  - FIXED #739 (e21f888c, 2026-10-14): FNF[b3-tests] #281 — merge.test same-second fixture flake (identical commits on both sides only collapse within one second) + plan-canvas smoke marker PLAN_CANVAS_OK.
  - Riding planned tasks: pull busy check outside tx, save without a holding fence, landPlanMerge wording → #273 (B3.1b-1).
  - Riding #278 (B3.1b-2), VERIFIED 2026-10-14, FIX IN PR 2026-10-15 (handBackAfterMove after 00a ff, refresh move, landPlanMerge): every root fast-forward left the files it rewrote root-owned; only openMerge handed back (#504). Dev evidence: repo a2315e10 README.md uid 0, mtime = reflog Fast-forward second. PRE-EXISTING.
  - FIXED #735 (b243c590, 2026-10-14): #283 FNF[plan-mirror] — plan.json canonical order (tree pre-order, sorted edges/links, id tie-breaks).
  - #270 is now a DESIGN single: the child-insert/move path race needs a per-repo plan-patch lock (FOR SHARE on the parent is not enough: the move's descendant UPDATE keeps its statement snapshot). PRE-EXISTING.
  - **FNF[uploads] task #285 (design single, 2026-10-15):** abandoned upload sessions (status uploading) and their `_uploads/<user>/*.partial` files are never reaped, for repos, db-dumps and bundles (only the routes' chunk/complete/cancel handlers touch them; 2 GiB cap each); the three cancel handlers' comments (repos.ts:816, db-dumps.ts:275, bundles.ts:573) promise a sweeper that does not exist. Needs a TTL decision. PRE-EXISTING.
  - **FNF[bundles] task #284 (design single):** a crash mid-create leaves a `syncing` bundle with no job; a `/complete` retry after it duplicates the bundle. PRE-EXISTING.
  - FIXED #746 (427f93e1, 2026-10-15, live-checked on the dev api): #268 bundle create + the four upload-session inits insert storage_root / their path in the one INSERT.
  - Single #282 (design): a same-branch merge (resolveMergePhase: 00a diverged, 12 merge_remove, 13 push) moves the checkout with no holding-task fence, unlike 00a's ff, refresh and 01's confirm. Needs a decision: hard halt (an open plan chat would block 12) vs. status quo vs. warn. PRE-EXISTING.
  - FIXED #733 (ac0b0753, 2026-10-14): an onboarding/upgrade that ends re-syncs at once (resyncAfterTaskEnd), so a sync it deferred no longer waits for the sweep.
  - FIXED #733 (ac0b0753, 2026-10-14): a dead task holds no checkout (dead_at IS NULL at every holder site; its writer is refused as released).
  - Dropped with reasons: in the B3 ledger, "Consolidated found-not-fixed (2026-10-14 reconcile)".
- **[2026-10-12 modularity series, session haive-e7; ledger .claude/tmp/modularity/ledger.md]** handed over from session git-data-readonly-containers, filed in haive-e7's task list:
  - **FNF[cancel-merge-commit]** (peer #259, DECIDED 2026-10-12): cancel reports a merge left COMMITTED on local base and offers one-click Undo (reset only while base still points at that merge commit and no live claim holds the dir; never auto-undo). Pattern of #594's left-open-merge.ts. Single (feature).
  - **FNF[cancel-fence]** (peer #262): one lock/epoch shared by handleCancelTask's sandbox listing and cli-exec's docker create, so a create cannot land after the cancel's empty listing. PRE-EXISTING (residual of #575). Single.
  - FIXED #655 (P7d): web TYPE_LABELS plan_sequence/plan_merge + task-class comment.
  - FIXED #656: secret masking skipped a repo-less task's mounted scratch workspace (kb_author too).
  - open (P11): New Task form repository picker for repo-less custom types; P7 live tasks left in dev data by user decision.
  - **[2026-10-13] bundle FNF[task-type-ui] (haive-e7 task #66):** editor unsaved-changes guard; /tasks/last-cli nulls without repositoryId (api tasks/index.ts:847) so repo-less custom tasks start at "(none)"; admin Settings Workflow sub-tab only via ?tab=workflow; new-task-type e2e flips the instance custom switch. All PRE-EXISTING/trade-off.
  - **[2026-10-13] single FNF[task-type-concurrency] (haive-e7 task #68, design):** PATCH /admin/task-types/:slug has no version precondition, so two admins editing the same field are last-writer-wins. #671 r8-r10 narrowed it in the editor (dirty fields only, composition only when changed, state rebased on response). Fix: updated_at precondition, 409 + current row, reload prompt. PRE-EXISTING since P10.
  - **[2026-10-13] bundle FNF[test-hygiene] (task #67):** web `test` script skips gen-modules (packages/web/package.json:11) PRE-EXISTING; task-job-epoch "fails the task" cases log settle warnings (REGRESSION test-only, P8a #663).
  - **[2026-10-13] folded into J4 (#45):** a dead task (P4b) keeps running/queued status and holds admission/RAM/repo lock until cancel or revive.
  - **[2026-10-13]** FNF[cleanup-dirty-tree] (task #64, single): 12-worktree-cleanup removes a worktree with uncommitted changes (e.g. 11b commit unticked loses learnings); fix = detect `git status --porcelain`, warn/refuse remove. PRE-EXISTING. Fix first.
  - **[2026-10-13]** FNF[builtin-order-hazards] (task #65, design): built-in order runs 07b before 07c (validates stale DDEV), 08b fixer edits after both, and 00a's merge fixer before the env prelude; 06-run-config not in the composable catalog. Audit: .claude/tmp/modularity/analysis/composable-order-audit.md. PRE-EXISTING.
  - **[2026-10-13]** FNF[ci-images] (task #63, single): CI builds only the api production image (ci.yml:257); web+worker first built at release. PRE-EXISTING.
  - low: `/stats` redirect stays when the statistics module is removed (404 at /m/statistics); module settings page shows the module name twice (bundled into M7 #30). PRE-EXISTING / low.
  - **[2026-10-14]** FIXED #684: FNF[ci-images] #63 — CI now runs all 14 Postgres-gated test files (pgvector service for the 3 HAIVE_GKB_TEST_DB_URL ones) with a ran-in-full JSON assertion, and builds the worker + web production images.
  - **[2026-10-14]** in review: #686 = FNF[kb-enrich-txn] #54 (cross-database, so COMPENSATE: delete the skeleton only after a lookup proves the task row absent; ambiguous keeps it); #687 = FNF[usage-auth] #87 (typed OAuth `error` code instead of message text; its state-skip and get-then-del halves DROPPED as deliberate: bare pasted code tolerated, PKCE verifier server-held, stash kept for re-paste); #688 = REGRESSION from P13f #685 (open prompt-step editor collapsed on a type-slug rename; keyed by prompt slug now). #64 cleanup-dirty-tree: Light builder in flight.
  - **[2026-10-14]** FNF[task-type-ui] #66 now 8 items (adds: refreshStatus stale guard, selectable=false wording, deferStart for attachments P1, composer row label column narrow at 390 px). Split it at build time: web-only small items vs deferStart api+web.
  - **[2026-10-14]** folded into planned tasks (verified): /github-oauth/poll redeems an unbound device_code (github-oauth.ts:151-159) + no timeout on GitHub fetches -> I3b #80; Integrations "Clear" shows "not configured" while the env var wins (settings/integrations/page.tsx:121-135) -> I3d #82; SECRET_KEYS.GITHUB_CLIENT_ID/SECRET unused -> I3c #81; .env.example:82 wrong fallback -> I3a #79; module id length unbounded (manifest.ts:174, DB name > 63 bytes truncates) -> M11a #75; read-only composer labels unknown rows "Built-in step" + public list drops step ids -> J3a #85.
  - **[2026-10-14 pm]** MERGED #693 (#66a: unsaved-changes guard + composer rows at 390; Discard replays the clicked link so its own onClick runs). #66b keeps items 2,4,5,7,10,11,12; item 12 now also: closing a Dialog leaves focus on BODY (measured on dev).
  - **[2026-10-14 pm]** NEW single FNF[pending-fail-path] (task #107): advanceStep's generic catch cannot fail a fresh `pending` row (updateRow refused), so a throwing shouldRun leaves it pending + returns superseded. PRE-EXISTING, scratch-PG evidence .claude/tmp/modularity/m11a/evidence/fix1-fnf-shouldrun-throw-superseded.txt. Fix = openPendingStep pattern from M11a.
  - **[2026-10-14 pm]** NEW bundle FNF[token-audience-2] (task #108): git-credential token (shared/src/git/token.ts) still two-part/raw-secret; drop /rag legacy fallback + signRagToken one TTL after #695 deploys; plan docs still cite signRagToken.
  - **[2026-10-14 pm]** NEW bundle FNF[api-errors] (task #109): api errorHandler answers HTTPException as 500 (measured); MCP merge dedupe keys on server lists with expiring tokens (task-auth-volume.ts). PRE-EXISTING.
  - **[2026-10-14 pm]** NEW bundle FNF[module-web-gates] (task #110): apiRequiresAdmin module pages render for non-admin (api modules/loader.ts ~118-127); three inline getModules effects should use useModules. PRE-EXISTING; after M11b.
  - **[2026-10-14 pm]** appended: #67 item 6 web/test/** outside tsconfig include (TS2353 test/form-validation.test.ts:46); #85 J3a: skipped module seeds (conflicts/invalid) show in no UI.
  - **[2026-10-14 eve]** MERGED #694 (M11a+J3b+M11b, browser-checked admin+user 390/768/1280) and #697 (D1c). REGRESSION found + fix in flight (task #114, branch fix/main-test-clashes): main CI red since #692 — stale fixtures api/test/task-type-definition.test.ts:276 (tools: [] default from #698) and shared/test/module-task-type-seed.test.ts:127 (100-char id vs M11a's 23 cap); turbo had cancelled api/worker unit suites in those runs.
  - **[2026-10-14 eve]** NEW single FNF[toast-stack] (task #113): attention toasts (components/notifications/toast-stack.tsx:53) have no cap/max-height; with 10 waiting tasks at 1280x900 they covered the Modules tab's Deactivate button and a click opened a task. PRE-EXISTING. #66 item 12 extended: shared Dialog has no initial focus either (measured on the Modules 409 dialog). #85 item "skipped module seeds on /admin/modules" MOVED to #78 (M11d-2, same page).
  - **[2026-10-14 night]** MERGED #715 (FNF[usage-auth-state] #115: atomic Lua take of the PKCE stash, a paste without its state refused; live-checked on dev). #716 (FNF[teardown-silent] #116) in CI. J3 parent #44 closed (J3a+J3b); the uninstalled-provider reason now lives on J8 #48.
  - **[2026-10-14 night]** OPEN singles/bundles (modularity session): #118 FNF[toast-a11y] (toast-stack.tsx role=button nests the X button; no live region) — building; #121 FNF[park-fold-nonpending] (step-runner.ts deactivated guard folds the park only for pending rows; waiting rows bill the wait as work; comment drift cli-park-timing.ts:51, timing.ts:62) — building; #122 FNF[uninstall-truth] (+4: install.ps1's uninstall.ps1 still swallows volume failures + unconditional "gone"; uninstall.sh says gone with no daemon, swallows down/rm/rmi, default mode ignores NETWORKS_LEFT, exit 0 always; dev.sh ignores .env COMPOSE_PROJECT_NAME) — brief ready, after #716; #120 FNF[git-cred-token-refresh] (repo shell past 12 h loses push creds, terminal-container.ts mints only on create) — design DECIDED (0600 token file re-minted on reuse + reaper sweep), not built. All PRE-EXISTING.
  - **[2026-10-14 late]** MERGED #716 (#116), #717 (J4b), #719 (J4a), #720 (#118), #721 (P15A), #722 (#67 +item 10), #723 (I3d), #724 (#121), #725 (#142). NEW OPEN (all PRE-EXISTING unless noted): #123 FNF[task-cli-provider-route] uncalled task-level PATCH /tasks/:id/cli-provider resets running rows without epoch/kill — USER decision delete vs fix; #135 FNF[maintenance-truth] (+4: admin pause "Paused by you", drain only on POST /tasks, /blocking counts held-back runs, Stop logs nothing-stopped, dead tasks listed as running); #136 FNF[dead-task-gaps] (cli-exec ignores dead_at, snapshot-less tasks never revive, dead runner not preemptible) — building; #137 FNF[handoff-double-step-done] (handleResult re-appends step.done, task-queue.ts ~:1681; peer owns end-of-task fns); #138 FNF[pr-poll] (+1: local_path repo PR never polled; 13-pr-wait auto-finalize leaves form wait open); #139 FNF[nested-interactive] (plan-detail-panel.tsx:840, plan-card-grid.tsx:74); #140 FNF[credential-connection-coupling] (+3: credential delete silently cascades the connection, re-sign-in duplicates the credential, host edit of a backing credential); #141 FNF[secret-audit] (tooling-upgrades.ts:805-806 app-login secrets unaudited); #143 FNF[dead-task-display] (running filter, clocks, plan pollers treat dead as live). Notes folded into tasks: #92 P14d token-file + requiresMcp + guard allow-list + rag/ddev merge churn; #41 I6 remote-MCP access class + dotted provider ids vs proxy.ts; #34 module jobs keep running after deactivation; #98 P15D PATCH stored-defaults carry-over.
  - **[2026-10-15 early]** MERGED #729 (#68), #730 (P14c), #731 (#120), #732 (#136, after peer #733). PR OPEN #734 (P15B + scratch-workspace EPERM fix: create without owner, best-effort chown), #736 (#141). NEW singles: #147 FNF[test-flake-agent-pool-cap] (beforeEach re-imports the handler graph, 5-10 s vs 10 s hook; pre-existing via resolvers.ts -> task-queue); #148 FNF[secret-audit-2] (Global KB connection string unaudited, global-kb.ts ~:418); #149 FNF[app-auth-clear] (tooling page cannot clear stored credentials, page.tsx ~:322). FOLDED: P15B catalog-reader x3 + slug-taken warning -> #97 P15C; FormSchema hidden field + creator-mode docs -> #98 P15D; I4a ssh port + test re-export -> #129 I5b; providers N queries -> #125 I4b; raw category ids -> #126 I4c; P14d-1 invalidTools reaching save/availability + unbounded names -> #92 P14d-2; #136 started runs after dead mark -> #144. DROPPED with reason: paused+dead listed under Paused (true; badge says dead); emoji with U+FE0F refused in tool text (house-rules set); global-only tool < topK after dedupe; crash-replay duplicate type_draft turn (plan-chat precedent).
  - **[2026-10-15 morning]** MERGED #737 (I4a, 0206), #738 (docs dead tasks), #740 (#148), #741 (P14d-1), #742 (M12-U1), #743 (#143), #744 (#139), #745 (#147, first PR after Codex returned: clean round). NEW: #150 FNF[admin-pause-resume] (owner can resume an admin maintenance pause; DESIGN single, user Q); #151 FNF[a11y-sweep] (17 Link-wraps-Button sites, sidebar rename input inside a button, plan panel close/tabs names+state); #152 FNF[gkb-conn-clear] (Global KB connection string can be replaced but never cleared; single); #153 FNF[task-type-e2e] and #154 FNF[dialog-focus] split from #66. FOLDED into in-flight fixes: #135 fix-1 (updater liveTaskCount counts dead tasks = REGRESSION of item 5; start/retry while draining; pause + event in one txn; admin link 404 for other owners); #149 fix-1 (per-field credential flags, error inside the dialog, save sets one flag). DROPPED with reason: #144 item 2 (by design boot order); #148 other GKB config fields unaudited (non-secret, admin-gated; enforce stamps enforced_by); #143 parked panel stops polling (by design); #139 summary under overlay in a 2-line clamp and copied test helpers; #147 config-push retune untested (the 30 s poll it shortcuts is tested); P14d-1 withTaskCustomSteps slug check (hand-written rows only).
  - **[2026-10-15 evening]** (modularity session, task numbers are that session's) MERGED #765 (integrations.md), #768 (#108 item 2), #769 (#166), #771 (task-types.md + AGENTS.md index), #770 (I5c broker; shared connections refused at the broker, r7 short-secret marker finding judged invalid). PRs OPEN: #773 (#144 bounded module stops), #774 (#154 Dialog focus; r2 opener hand-over fix pending push), #759 (#135). NEW: #169 FNF[forge-egress] DESIGN single (forge fetch follows redirects; any credential host incl. internal addresses; MEASURED Node 26.7 fetch drops Authorization cross-origin; user Q). FOLDED: #138 item 5 (Gitea/Bitbucket Server open-PR lookup reads only page 1); #132 note (stale `running` integration_calls rows, same as #94's custom-tool rows); #146 +3 (rag/ddev routes hand-parse the bearer); #165 item 2 widened + 2b (no deadline on a runtime ensure/jobs start; shutdown awaits pass then stopAll, worst case ~2x10 s vs ~10 s Docker grace); #168 +1 (failed runtime re-ensure never retried); #159 item 5 (pinned-tool re-check uses requiresRepository:true); #167 +3 (resolveFixLoopGate closes the gate before the reopen; admitReopen status read unlocked); #151 +4 (three overlays bypass Dialog; ActionMenu row unmounts its opener; TabNav no aria-current; nested Dialog mounted with its parent paints under it). DROPPED with reason: creator-mode tool restriction (product decision; empty sandbox, no repo, no egress); control-worker injection test (typed deps + scratch check); tornDown retains ids (bounded); stuck-hook refusal (documented trade-off); DOM test env dep (shim works); radio-group trap gap (no radios in dialogs); A1/A2 title-prefix collision (select by file); stop() throwing synchronously untested (wrapper unchanged).
  - **[2026-10-15 late]** (modularity session) MERGED #773 (#144 bounded module job stops + bounded reactivation). IN FLIGHT: #170 FNF[lock-order-repo-delete] (repo delete cancels task row before its steps, reverse of Retry/Stop/worker claim; fix = lock active steps first) and #168 FNF[module-schema-boot] (boot skips deactivated modules' ensure, single deactivated read, failed reactivation retried x3). NEW: #171 FNF[admin-config-audit] (38/39 admin PUT /admin/config/* switches write no audit event; single). FOLDED: #138 item 6 (git transport credential helper serves the token for any host; bind checks ownership only); #151 +2 (Chrome none-checked radio group tab rule; module-dialogs-flow hook-mock fragility); #165 item 3 (a reactivation that outlived its wait is not in `stops`, so SIGTERM cannot stop a late success); #167 +2 (checkProviderRecovery rethrows; PUT audit outside the txn); #66 item 15 (custom-tool editor lacks timeout/response-cap fields); #3 +2 (`merged:false` gap; stale 'retry the push' text + tasks/index.ts:1201-1203 comment). DROPPED with reason: answer-first lock order (same order, cannot deadlock); commit flag unpinned (Fast Refresh only); Chrome Tab from an unchecked radio (browser rule); 13 queries vs pool 10 (sequential); thacker:342 plan wording (merged plan supersedes).
  - **[2026-10-16 early]** (modularity session) MERGED #776 (P14e tool editor, browser-checked 1280/768/390), #781 (#138a forge credential host + one-read decrypt; #138 back to pending with items 1,2,5,6), #784 (#170 repo delete locks open step rows by id FOR NO KEY UPDATE, then re-reads and locks the still-open tasks), #787 (D1b .npmrc scope + BuildKit secret; smoke 25/25 incl. revoked token 401 keeping the previous image; D1 complete). PRs OPEN: #759 (#135; fix-10 fenced admitReopen fails closed, fix-11 per-task catch in the auto-resume tick), #774 (#154; fix-4 stacked dialog focus fallback), #780 (P14f+I5e; fix-3 refetch on running/logged call counts), #785 (#168; fix-1 activation seen by modules.updated_at), #786 (I5d-1; fix-1 SECURITY, PRE-EXISTING on main for haive-custom tokens: every sandbox mounted the whole wrappers volume, so another live run's token file was readable; amp stamped run fails unwired). NEW: #172 FNF[stalled-answered-form] (stalled sweep never re-drives an answered waiting_form row on a running task); #173 FNF[lock-order-step-rows] (+2: Retry locks rows in list order; Retry vs repo delete unserialized; single-cancel route has no status guard); #174 FNF[module-runtime-status] (+1: no admin surface for an exhausted reactivation; unseen toggle closed by #785 fix-1). FOLDED: #66 items 15/16 (Max length field has no max; commit() announcement counts undeduped issues); #103 (release.yml + non-dev compose pass no npmrc secret); #106 (module add bump that changes web exports exits 1); #151 +9 (code-preview-dialog scroll region; positive tabindex escape; 13 hand-mocked React test files; keyed-reorder opener -> body, rare); #153 +2 (no e2e for a call-only task / page wiring); #167 item 8 (Redis outage: getFresh never rejects, so the fenced read hangs holding the shared fence; item 6 being fixed by #759 fix-11). DROPPED with reason: barrel import (W7 guard); grouped-count poll cost; nameless params collapse; unit fake same rows (gated controls pin the re-read); iframe last stop; nested editing hosts; BuildKit cache revocation (inherent, documented); .env.example out of contexts (by design); runTaskJob re-stamps an already-failed task's message after a refused reopen (the message says why; same for any reopen error); unknown stored maintenance state parses as normal (by design).
  - **[2026-10-16 day]** (modularity session) MERGED #786 (I5d-1 + SECURITY: sandbox mounts the wrappers volume only by subpath; null MCP config = unwired), #785 (#168 boot skips the schema ensure of deactivated modules; activation stamp = modules.updated_at), #780 (P14f + I5e usage panel groups), #774 (#154 Dialog focus), #789 (#183 REGRESSION from D1b fixed: compose builds need BUILDX_BAKE_ENTITLEMENTS_FS=0 for the npmrc build secret; dev.sh exports it, CI compose jobs set it), #788 (D2a-1 web image names its modules). P14 LIVE-CHECKED (kb_lookup rag-query tool, 1 call, panel counts match). PRs OPEN: #759 (#135 fix-13 in flight: dead-task boot revival during maintenance; admission lock order fence-before-repo), #790 (#171 admin config audit; fix-1 in flight: per-route advisory lock + partial audit), #791 (I5d-2 dispatch wiring). NEW: #180 FNF[npm-cache-shared] (DESIGN single: shared npm cache volume mounted read-write into every sandbox); #181 FNF[tool-usage-live-runs] (low); #182 FNF[dockerignore-nested] (low: nested dist/.next/tsbuildinfo enter local builds). FOLDED: #104 D2b +3 (compose bundle never refreshed on upgrade; host upgrade hard-codes the public manifest; fetch ignores HTTP status; digests unused; -suffix compare); #178 +3 (release.yml has no --min-from; manifest output never validated; release smoke should read the web module list); #146 +4 (wrappers per-run dirs never swept after a worker kill); #167 (item 5 closed by #759 fix-12 on merge; item 6 partly by fix-11; item 8 Redis-outage hang open); #172 +1 (auto-resume enqueue after commit can strand a task); #163 +1 (global-kb config 8 keys unaudited). DROPPED: FK-race message quality; unlocked connection/preference windows (broker re-checks per call); resolution before prepare (custom-tools precedent); prompt write filter trivially true (broker re-checks); prompt/stamp mismatch race (accepted, documented); /app/modules/.gitkeep in images (by design); #774 iframe finding (not applicable). D2a-2 leak gate: harness 10 controls + round 2 (N9 web list, N10 version) in flight.
  - **[2026-10-16 evening]** (modularity session) MERGED #804 (#156 malformed-id bundle: 22P02 path ids 404 at warn, WS upgrade guards incl. both terminal shells lowercase-only, query uuids/provider 400, one isUuid in the api). FIXED in open PRs: #759 fix-22 (unbounded recount loop, REGRESSION from fix-20), fix-23 (CLI choice inside the fenced txn, Codex r11); #801 link-only registry module with no readable version is an offender; #803 fix-2 RUNNING (account text vs stamped binding; truncation notice inside the cap, all prompt-step value kinds). FOLDED: #198 +1 (phaseDraining writes draining unconditionally, relaxing an admin maintenance set before the upgrade; same decision as item 1); #159 item 6 (templateTokens returns [] for an unparsable stored template, so the 64 KiB budgets skip it). DROPPED: #156 p3 zod uuid schemas (request-body idiom) and statistics module parseUuid (separate package); shell 401->404 for a malformed id (matches the other upgrade guards); Codex #759 r11 running-answered-form deadlock (invalid: running path locks only the task row; doc clarified e52a90981).
  - **[2026-10-16 late]** (modularity session) MERGED #759 (#135), #801 (D2a-2), #808 (#138 items 2+5), #809 (#182), #810 (I6b), #813 (#66 items 7+17; attachments start order live-checked). OPEN NEW (all that session's task numbers): #200 FNF[shutdown-races] (shutdown reap's docker deadlines exceed the remaining grace; PRE-EXISTING); #201 FNF[tool-usage-panel] (footer counts in-flight runs as "ran before this record existed"; PRE-EXISTING); #202 FNF[new-task-attachments] (New Task silent on a failed attachment upload and skips later files; a deferred task whose start never arrives stays created = #813's own accepted trade-off); #203 FNF[new-task-reset-verdict] (DESIGN single: after a failed reset the page keeps the pre-reset verdict); #204 FNF[new-task-none-cli] (DESIGN single: "(none — deterministic steps only)" still runs steps with a saved per-step CLI; observed Opus 5.5 Max ~30 s on a live check; precedence by design per step-summaries.md:53-55, label wrong). Dead code noted, not filed: api/src/redis.ts closeRedis and ConfigService.close() have no production callers. Later the same night: #205 FNF[module-ensure-wait] (DESIGN single: no deadline on a module schema ensure, holds teardown until restart; REGRESSION accepted in #811: a late boot ensure fails the module's steps with Retry instead of waiting); #158 grew items 9-11 (50-stop cap loses the failing stop's reason; statistics module links other users' tasks under allUsers, latent; owner-only title rule in two components); #201 narrowed by #812 r1 (only a run cancelled in flight remains unseen, plus the footer copy).
  - **[2026-10-17 early]** (modularity session; Codex paused since 2026-10-16 ~21:45Z, so these merged on green CI without a bot review) MERGED #811 (#165), #812 (#181), #816 (#158 items 1-2), #818 (#162), #819 (#202), #821 (#163), #822 (#167), #823 (#206). PR OPEN #824 (#207: per-run module ids + purge 30 s timeout + the store race test runs under its own install id; before the fix, a run of create-database-race.test.ts DROPPED a planted haive_kb_global WITH (FORCE), so pointing RACE_PG_URL at a server holding a real install's global KB lost it). OPEN NEW (that session's task numbers): #208 FNF[created-task-start-partial] (DESIGN single: Start on a created task starts with whatever attachments landed; nothing records how many were expected); #209 FNF[attachments-ui] (+2: delete-failure message wiped by the 5 s poll; failed-upload list markup twice; no task-page render harness); #210 FNF[test-flake-mcp-surface] (two surfaces' RAG tokens minted a second apart; red when the calls straddle a second; seen on #819 CI); #211 FNF[test-coverage-gaps] (+1: route tests that audit pass when the audit insert fails; gated create-path suite lacks an in-txn type refusal case); #212 FNF[audit-atomicity] (+1: audit rows written after their change or swallowed inside a txn at maintenance/admin/module routes; consequential); #213 FNF[repo-picker-caps] (+2: picker filter searches only the 1000 loaded; UI hard-codes the 1000/5000 caps; a 5000-file bundle browser takes ~8.8 s, fs-safe walk per file); #214 FNF[gated-test-isolation-2] (+1, low: pg-connection-drop-smoke kills backends by server-wide markers; migrate-smoke step 10 ensures fixed store names, create-if-absent so no data loss, parallel copies can fail each other). ACCEPTED in #824: a killed run leaves its suffixed module databases behind (they touch no other run).
  - **[2026-10-17 later]** (modularity session, Codex still paused) MERGED #824 (#207), #825 (#209), #826 (#212), #827 (#210+#214), #828 (#200), #831 (#213 items 1-2, b529a16b8). PR OPEN #830 (#201 in-flight runs; its CI went red once on an e2e spec that pinned the old coverage shape, fixed in the PR), #832 (#217: a failed attachment delete re-reads the list + a newest-read guard in the attachments panel AND the admin maintenance page, where a 5 s poll answering late put the old list/state back). IN FLIGHT #218 (strict audits for security actions, user decision). OPEN NEW (that session's numbers): #219 FNF[shutdown-deadline] (DESIGN single: shutdown part limits summed by hand); #220 FNF[spawn-timers] (+1, low: docker spawn helpers never clear their SIGKILL timers); #213 keeps item 3 (bundle browser 8.8 s for 5000 files) + picker dropdown 100-row cut + /user/repos error body unbounded in the 502 + one extra empty page at multiples of 100 (minor). #223 FNF[audit-strict-integrations] (+5: integration provider config/OAuth client secret, category default, GitHub client id, link credential, write switch, sign-in still audit best-effort after commit; within the user's strict-for-security-actions decision); #224 FNF[audit-strict-gkb] (DESIGN single: Global KB connection string/config audits best-effort after a secrets-service + Redis write); #222 FNF[tool-usage-cancel-signal] (DESIGN single, split from #201 item 2: a run cancelled in flight never moves the panel's refresh signal); #151 +1 (minor: the sidebar row calls a never-started deferred task 'queued', task-tone.ts:69). MERGED later the same session: #830 (#201 item 1), #832 (#217). DROPPED: guidance-context.ts SCAN_LIMIT 100 / _global-kb-digest.ts DIGEST_SCAN_LIMIT 400 'possibly more' at exactly the limit (by design: omission-count.ts says a filled scan never read the rows past it, so the notice hedges and never claims a row was left out; the original #206 driver dropped it the same way); 'a proxy that strips GitHub's Link header makes a full 10th page read not truncated' (by design, documented GitHub contract).
  - **[2026-10-17 replay matrix 2]** (modularity session; found by blind-graded replay runs, each re-checked on main 616cc9bf1, both PRE-EXISTING, Light, own bundle heads) NEW #226 FNF[kb-diff-truncated]: `_knowledge-diff.ts:61` cuts the KB diff list at MAX_FILES 500 yet `:80-81` writes `fileCount: files.length, truncated: false`, so the viewer (`commit-diff-viewer.tsx:524`) never says "list truncated" on a >500-file knowledge gate; fix = `_commit-diff.ts:211-224`'s shape. NEW #227 FNF[plan-starter-start-fail]: `plan-starter.tsx` sets `draftTaskId` only on an upload failure (:202), so a `startTask` throw after every upload landed (:208) makes the next press `buildPlan` a SECOND plan build with no attachments (done rows skipped, :174) while the first stays `created`; fix = keep the draft id once the deferred create returns. NEW #228 FNF[gate-retry-wedge] (DESIGN single, consequential, PRE-EXISTING, more reachable since #822 parks refused gate answers): a Retry re-offers a parked fix-loop gate as `pending` WITH its saved answer (`task-control.ts:125-151`); the advance reads it (`readFixLoopGateAction` falls back to `existing.formValues`, `task-queue.ts:2276-2277`) and `resolveFixLoopGate` no-ops because `owned()` excludes `pending` (`step-ownership.ts:36-40`); the stalled sweep re-drives the no-op forever and Stop is a silent no-op (`task-control.ts:184-190, 217-224`). Decision: drop the answer on Retry (re-ask) or claim the pending gate and re-apply it. Read on main, not reproduced; Cancel unchecked. Design note, NOT filed (graded BY-DESIGN): `POST /global-kb/test-ollama` lets any signed-in user make the api fetch a URL, matching the documented non-admin Ollama URL setting (`global-kb.md:111-112`) — whether non-admins should set/test the instance-wide embedder is a product question.
  - **[2026-10-17 pilot 1: Opus max session + /sonnet-sonnet on #226]** (modularity session; Sonnet max driver, its items verified by main against 08568d738) #226 MERGED #834 (ba51bf50c, CI-only, dev synced): 08568d738 counts the cut entries and sets `truncated`; b7fc06f0d adds `--untracked-files=all` to the KB diff's status in the same PR (driver item 1, PRE-EXISTING, consequential: a new KB directory showed as ONE empty entry with an `editPath` at the directory, `_knowledge-diff.ts:53-60` vs `_commit-diff.ts:204`). NEW #229 FNF[diff-status-exit] (minor, PRE-EXISTING, Light, own bundle head): neither `buildKnowledgeDiffArtifact` nor `buildCommitDiffArtifact` (`_commit-diff.ts:197-206`) checks `git status`'s exit code, so a failed status reads as "No changes to show" (`commit-diff-viewer.tsx:488`); gate 3 (`10-gate-3-commit.ts:226-230`) and `_dependency-policy.ts:233` throw instead; read each caller's error handling before choosing a throw or an unreadable mark.
  - **[2026-10-17 from session haive-2a]** (measured on dev for docs/plans/refactoring-economics-lessons.md, 0fdbf9c9a; filed in the modularity session at the user's request; code + named rows re-checked by main) NEW #230 FNF[killed-run-usage] (PRE-EXISTING, low-medium, Light, own bundle head): the live fallback `getTokenUsage()` (`cli-exec/stream.ts:490-511`), used when a transcript has no `result`, sums input/output/cache_creation once per assistant stream EVENT (`:317-324`; one message spans several events, 239 events / 139 messages in a sample) and keeps cache_read as the running MAX (`:323`, comment `:113-116`), whereas the CLI's `result` equals the per-message SUM; 25 killed claude-family runs, totals cache read stored 2,837,445 vs 83,722,123 summed (e.g. 4ba6ff42 stores 354,106 = its last turn, exit 137); fix = dedupe by message.id, sum all four once per message, rewrite the comment; recomputing stored rows is a separate decision (`cost` is an immutable snapshot). NEW #231 FNF[grok-usage-gap] (PRE-EXISTING, low, verify-first single, may not be a defect): 9 finished grok runs show tool-result chars/4 × later turns at 1.14-2.25x their recorded prompt tokens (e.g. e3d08fb4 09-qa 2.25x); tell apart under-reported cache, a chars/4 overestimate, or dropped old tool results with the context-capture recorder before any code. Repro scripts: `.claude/tmp/read-cost/{usage-audit,read-cost}.mjs`.
  - **[2026-10-14 night 2]** MERGED #726 (M11d-2), #727 (J4c), #728 (#122). PR OPEN #729 (#68), #730 (P14c, both security rounds + driver fix-2). #92 SPLIT: #145 P14d-1 (per-tool parse with invalidTools, hidden chars at save, executeRagSearch scope) then #92 P14d-2 (wiring); NEW single #146 FNF[mcp-token-file] (rag/ddev tokens with per-second exp in server env defeat the cli-merge skip, mcp-surface.ts:108/:186; measure first, then move to the token file). DROPPED with reason: c-ares skips /etc/hosts so hosts-only names fail as request-failed (fail-closed); 2001:20::/28 ORCHIDv2 not blocked (identifiers, not routed); task-type promptSteps whole-map overwrite without precondition (only production caller sends it); ms version-token collision (by design).
  - **[2026-10-14 pm]** DROPPED: DAG cleanupLevelWorktrees force-remove (accepted issues are `add -A` + committed before merge; rejected discarded by design); module seed composition validation (module types may use non-composable steps, decided).
  - **[2026-10-14]** DROPPED: a module-seeded selectable:false type has no creation path (module route ctx has only db) — by design until a module needs a spawn API.

- **[2026-10-12 close of session f3f0c544's FNF run]** CLOSED this run: #9 #34 #42 #56 #62 #64 #65 #66 #67 #68 #69 #70 #71 (PRs #560-#572). OPEN, filed as tasks:
  - **#73 DESIGN** concurrent RAG syncs of one repository are not serialized (`_rag-index.ts` runRagIndexSync, `10-rag-populate.ts`, api Retry): degraded-flag race, interleaved upserts/orphan sweep, re-derive reset. PRE-EXISTING; #572 added a post-clear recheck that narrows only the Retry race. Needs wait-vs-skip decision for a per-repo lock.
  - **#74** the worker never sees a changed global KB connection string until restart: `SecretsService.get` (shared/config/secrets.service.ts:35-56) caches per process with no TTL. PRE-EXISTING. #570 added `getFresh` for the dims path only. Fix: TTL or pub/sub invalidation; audit other secret readers.
  - **#72 DESIGN (user)** per-repository declared verify commands for repos whose tooling is not at the root (Drupal recommended-project). #566 only explains what was declined.
  - low: the RAG embed note never shows on a Retry that clears, because the health section unmounts once healthy (`repos/[id]/tooling/page.tsx` ~575). PRE-EXISTING.
  - low: a definition chunk whose body never contains its own name is invisible to every lexical ranker (getMultiPages, compareOldSettings) — chunker gap, RAG plan F1/F9/F16.
  - low: global KB sync bumps `updated_at`, so healing re-embeds reorder the entries list. PRE-EXISTING.

Every open entry carries the task that tracks it (`[task #N]`) and, from 2026-10-03, its bundle, per
[[fnf-items-as-tasks]]. A new entry gets its task, or joins a bundle's task, when it is written.
Close the task and move the entry to Closed when its PR merges.

- **[task #10, session 77d92749, single, needs the user]** [NEW 2026-10-08, MEASURED in the worker log since its
  07:34:20Z boot] usage-poll has paused every Claude Code and Codex provider: `usage OAuth refresh rejected
(invalid_grant)` for claude-code f78e9f21, 29d21537, 07660e12 and 4af759e0, and `http 401 ... past the strike
threshold` for codex e64adc65, 3cfa45ca and 8fd6d231. `cli_providers.auth_status` still reads `ok` from
  September, so the UI may not show it. Cause UNPROVEN: refresh-token rotation when the temporary `blank` install
  logged into the same accounts, or expiry over the 5 days the stack was down. Not checked whether real CLI runs
  fail too. Remedy: re-login per provider. UPDATE 2026-10-08 08:31Z: the 4 Claude usage meters were reconnected
  by the user and read `ok` (fetched 08:23:56-08:24:48Z). Codex is still `error` (hidden chip by design,
  `fetchers/index.ts:59-65`): its shared volume's `auth.json` dates from 2026-09-12, the last Codex run was
  2026-09-13 (exit 0), and no task copy is newer. It heals on the next Codex run IF that refresh token still works
  (unverified), or on a Codex re-login. The Claude CLI logins are a separate token, untouched since 2026-09-23, untested.
- **[task #19, session a644756a, bundle `tests`]** [NEW 2026-10-03, MEASURED on main run 37145965955 attempt 1
  (2bfa4426), job log read in full] `tests/e2e/settings/global-kb-retry.spec.ts:41` awaits `route.fetch()` for
  `GET /global-kb/entries` and the test ended first ("route.fetch: Test ended"). Playwright then prints `1 error
was not a part of any test` and `1 did not run` and exits 1 although the other 161 tests passed, which turned
  main's CI red. Attempt 2 of the same run passed, and so did the 7 earlier main runs, so it is intermittent.
  PRE-EXISTING (the spec dates from 09-27; no other spec calls `unrouteAll`). Left: outside #403 (worker-only).
  Fix, test-only: `await page.unrouteAll({ behavior: 'ignoreErrors' })` at the end of that test. Not checked:
  which test was the one that "did not run".
- **[task #17, session a644756a, single, design]** [NEW 2026-10-03, MEASURED on task fdd57e6b, verified
  `01c-ddev-env.ts:215-223,319`] 01c proposes a `.ddev/config.yaml` only when none exists and skips otherwise,
  so a config it generated on a first run (untracked, mariadb 17, mtime 14:16:34) outlived the corrected env
  template and failed the re-run at 14:26:32 (`unsupported database type/version: 'mariadb:17'`). Worked
  around by deleting the file and a Retry. PRE-EXISTING. Design: mark or hash what Haive generated.
- **[task #16, session a644756a, single]** [NEW 2026-10-03, verified `01-declare-deps.ts:621-627,818-819`] the
  database version is a free-text field stored unchecked, so `mariadb` + `17` was accepted; DDEV supports
  mariadb 5.5-12.3, mysql 5.5-8.4, postgres 9-18 and says so only at `ddev start`, ~10 minutes in on a fresh
  install. PRE-EXISTING. Fix: a select per kind, or validate the version against the kind.
- **[task #18, session a644756a, single, design]** [NEW 2026-10-03, MEASURED on fdd57e6b] a Retry during a long
  `ddev start` queues behind the old pass (Retry 14:19:50, new pass 14:26:27) with a `pending` row and no text:
  the old pass's `emitProgress` is refused on the reset row (`step-ownership.ts:65`, 159 warnings in 15 min) and
  the exec only ends at its 900 s timeout (`ddev-runner.ts:2030-2047`). PRE-EXISTING. Design: interrupt the
  runner exec on Retry, or show "waiting for the previous pass".
- **[task #13, session a644756a, single, design]** [NEW 2026-10-03, verified by reading `01b-install-plugins.ts`
  apply] any non-zero plugin command throws and fails the step and the task, so an unreachable marketplace host
  (`Piebald-AI/claude-code-lsps`) would kill a task over an optional extra. PRE-EXISTING; a policy decision.
- **[task #14, session a644756a, single, design]** [NEW 2026-10-03, DERIVED from code, not run] since `56e58d34`
  an invocation mounts only the task worktree, and a worktree holds committed files only, so the PHP LSP tree
  that 07 wrote into a repo onboarded with commit off is absent from it. It failed 01b before #403; it skips
  with a reason now. PRE-EXISTING. Design: copy it in, or document.
- **[task #15, session a644756a, single]** [NEW 2026-10-03, code verified `task-auth-volume.ts:375-377,610-611`]
  `isTaskVolumeReady` reads any probe exit other than 0 and 2 (a docker failure, the 15 s timeout) as
  `not_ready`, and the caller then tries to remove the volume. Seen once as "exists but not ready, recreating"
  at 13:48:19 on fdd57e6b, mid-invocation, no error logged; whether a probe failure caused it is UNPROVEN, and
  the volume is gone with the task. PRE-EXISTING.
- **[task #5, session 77d92749, bundle `install-names`]** CLOSED 2026-10-08 by PR #433 (merge 89c005e3, main CI
  green, Codex clean round); move to Closed at the next consolidation. [NEW 2026-10-03, MEASURED with `docker compose
config` under `HAIVE_INSTALL_ID=blank`] `docker-compose.yml:182-183` and `docker-compose.dev.yml:153-154`
  default `SANDBOX_NETWORK`, `SANDBOX_MODELS_NETWORK`, `SANDBOX_IMAGE` and `SANDBOX_WRAPPER_HOST_VOLUME` to
  literal `haive-*` names, so a non-default install's worker names the default install's network, volume and
  image; `install.sh:355-380` sets none of them either, and `resource-naming-guard.test.ts` scans source, not
  YAML. Not exercised on a running second install. Also the local `.env:55` holds `SANDBOX_NETWORK=haive-network`
  (`.env.example:60`: `haive-sandbox`); `sandbox-runner.ts:433-440` puts it on every sandbox as a second NIC and
  `haive-network` holds postgres and redis (`docker network inspect`), against the compose comment. Not observed on
  a live sandbox. PRE-EXISTING. Fixed by 74a05761 (branch `fix/compose-sandbox-names-follow-install-id`, worktree
  and branch removed after the merge): nested defaults in both compose
  files, `.env.example:60` commented out, a compose/env guard in `resource-naming-guard.test.ts` (red on the five
  lines before the fix, green after; worker typecheck clean). The local `.env:55` line was removed and the worker
  recreated 2026-10-08; MEASURED with throwaway containers that `postgres` and `redis` resolve from
  `haive-network` and not from `haive-sandbox`. Its two leftovers moved to task #9 below.
- **[task #9, session 77d92749, bundle `sandbox-net-leftovers`]** CLOSED 2026-10-08 by PR #434 (merge 11cc9792,
  main CI green, Codex clean round); move to Closed at the next consolidation. [NEW 2026-10-08, verified by git grep]
  `shared/src/config/config.service.ts:141,660` defines `config:sandbox:network` with default
  `networkName('network')` (the main network, which holds postgres and redis) and nothing reads it; and
  `worker/test/egress-discover.ts:37` falls back to a literal `haive-sandbox`. PRE-EXISTING. Fix: remove the key
  (check stored config rows first) or point it at `networkName('sandbox')`; use `networkName('sandbox')` in the
  script. FIX BUILT 2026-10-08, NOT COMMITTED: worktree `/home/activit/haive-sandbox-net` (branch
  `fix/sandbox-net-leftovers` off 89c005e3) removes the key, its default and the unused import; egress-discover's four
  install-resource literals (squid volume, sandbox/upstream networks, container name) go through the naming module,
  byte-identical for the default install. Config lives in Redis via `seedDefaults` SETNX, read/listed by nothing, so
  existing installs keep an inert `config:sandbox:network` key (left on purpose, no cleanup mechanism added).
  Committed as 38881566 + 626c00b1, PR #434 opened 2026-10-08.
- **[task #11, session 77d92749, bundle `migrate-install-names`]** CLOSED 2026-10-08 by PR #435 (merge 9bfb7827,
  main CI green, Codex round 2 clean); move to Closed at the next consolidation. [NEW 2026-10-08, MEASURED on a throwaway
  Postgres] `database/src/migrate/client.ts:9` refused only `^haive_rag_` / `^haive_kb_global$`, so on another
  install a misdirected `DATABASE_URL` built the core schema inside that install's store (old runner: exit 0,
  64 tables in `blank_kb_global`). Also, smoke case 10 never created `haive_kb_global`, and a missing database exits
  1, so it passed on CI only because an earlier CI step had created it. PRE-EXISTING. PR #435 (worktree
  `/home/activit/haive-migrate-names`, branch `fix/migrate-refuses-any-install-store`): 09a2c77f install-agnostic
  patterns, a self-contained case 10, the guard reading `database/src`; Codex round 1 raised one VALID P2 (`*` let a
  33+ character prefix be refused; ids are 1-32), fixed in 977c6200 with `{0,31}` and boundary checks both ways.

- **[task #1, session f3f0c544]** CLOSED 2026-10-03 by PR #398 (e754b51f), live-verified; move to Closed at the next consolidation. Was planned as [[house-rules-series]] PR1. [NEW 2026-10-02, MEASURED with the
  real `extractProjectFacets`+`facetsMatchProject` on elmont_rs_test] 01-env-detect emits framework
  `drupal7` for D7 (`01-env-detect.ts:521,593`), no alias exists, so a global KB entry scoped
  `{framework:['drupal']}` (the active "no inline svgs" rule) reaches NO D7 project, and
  `drupal`+`frameworkMajor:['7']` matches nothing at all. All 8 Drupal repos on the dev install are D7.
  PRE-EXISTING. Workaround until it lands: scope `{framework:['drupal','drupal7']}`.
- **[task #2, session f3f0c544]** CLOSED 2026-10-03 by PR #402 (acc09ef8; four Codex rounds: hunkless files, phpcs exit 0, gate-2 NOT RUN rows); move to Closed at the next consolidation. Was planned as [[house-rules-series]] PR3. [NEW 2026-10-02, verified
  `08-phase-5-verify.ts:187-194,501-517`] verify's lint runs unscoped (bare phpcs / composer script) and
  any failure blocks the fix loop, so a Drupal-standard phpcs.xml on a legacy codebase burns rounds on
  pre-existing violations. PRE-EXISTING.
- **[task #3, session f3f0c544]** CLOSED 2026-10-03 by PR #399 (2b3b62f1); move to Closed at the next consolidation. Was planned as [[house-rules-series]] PR2. [NEW 2026-10-02, verified
  `_global-kb-digest.ts:97-148`] the digest keeps the 40 newest matching titles and states no omission;
  titles also interpolated raw (`:144`). PRE-EXISTING, low (3 active entries).
- **[task #10, session f3f0c544, bundle `runners`, CLOSED 2026-10-09 by PR #463 (merge 301fc67c, main CI green)]** [NEW 2026-10-03, found by the house-rules plan reviewer, verified
  `08b-test-management.ts` runTestCommand ~550 + `ddev-runner.ts` ddevExecOnce ~1101-1105] 08b joins the
  tester agent's reported test paths unquoted into `cd <dir> && ddev <args>` run by `bash -lc` in the
  runner; `TEST_FILE_RE` (~148) anchors only the END of a path. PRE-EXISTING; left: outside the plan.
- **[task #10 (+2), session f3f0c544, bundle `runners`, CLOSED 2026-10-09 by PR #463]** [NEW 2026-10-03, house-rules T3 fixer, verified]
  (a) a ddevExec timeout SIGKILLs only the local `docker exec` client (`ddev-runner.ts` ~2187-2190), so the
  command keeps running in the runner; (b) 08b's DDEV-unavailable selective run (~1019-1029) sets no
  degradedNote, so written-but-unrun tests read as a quiet skip. PRE-EXISTING, both.
- **[task #11, session f3f0c544, head of bundle `dag-prompts`]** CLOSED 2026-10-10 by PR #481 (merge ee943186). [NEW 2026-10-03, verified `dag-executor.ts` reviewerPrompt ~920-950] the
  DAG per-issue reviewer gets only the coder-reported file list: no line notes, no scope fence, no
  INSIGHTS route, and `fix_required` goes straight to the fix coder. PRE-EXISTING; impact unmeasured.
- **[folded into task #11, session f3f0c544, bundle `dag-prompts`]** CLOSED 2026-10-10 by PR #481. [NEW 2026-10-03, house-rules T2 builder, verified] DAG issue titles
  reach prompt lines raw: `dag-executor.ts` reviewerPrompt ~924 and buildUpstreamDebt ~261, `07b` ~646 and
  `08d` ~950 debt lines; fixCoderPrompt ~964 already uses safeTitle, 08c fences its debt. PRE-EXISTING.
- **[task #13, session f3f0c544, bundle `tests`, CLOSED 2026-10-09 by the peer's PR #465 (merge eb000497, main CI green; count exact at 184)]** [NEW 2026-10-03, low] `prompt-agent-paths.test.ts` floor `>= 186`
  (MEASURED 2026-09-22) while 189 build; three silent drops would pass. PRE-EXISTING.
- **[task #14, session f3f0c544, bundle `git-merge`]** [NEW 2026-10-03, house-rules T3 builder, verified
  in a throwaway repo] `_impl-changes.ts` dirtyWorktreeFiles reads `git status --porcelain` without `-z`, so a
  path with a space stays quoted (`?? "has space.php"`) in every reviewer file list. PRE-EXISTING.
- **[task #9, session f3f0c544, single]** [NEW 2026-10-03, verified `08-phase-5-verify.ts` resolveSlots ~270-279]
  verify has ONE lint slot at the root (JS script > composer script > phpcs config), so a root
  package.json lint script hides phpcs. PRE-EXISTING; left: slot shape is persisted + rendered.
- **[task #16, session f3f0c544, single]** [NEW 2026-10-03, PR5 model analyst, verified `sandbox/mcp-surface.ts:461`,
  `repo/worktree-git-boundary.ts:40`] prompt blocks skip themselves when their marker appears ANYWHERE in the prompt
  (`prompt.includes(MARKER)`), so quoted repo/task/retrieved text suppresses the MCP-surface contract or the git
  boundary; six such blocks. PRE-EXISTING; left for its own PR (house-rules PR6 sets the position-0 rule for its block).
- **[task #15 (+1), session f3f0c544, bundle `gkb-merge`]** [NEW 2026-10-03, house-rules T4 fixer, verified in 09_6_4
  after 7e8fbd18] the merged body overwrites a draft body edited since detect (guard is status only); a DB error that
  aborts apply reports unreached pairs as "no usable merged article". PRE-EXISTING; outside PR4's scope.
- **[task #17, session f3f0c544, single]** [NEW 2026-10-03, PR5 api analyst, code verified `global-kb/connection.ts`
  ~124-137, Postgres error class NOT verified] two simultaneous first uses of a fresh store race on CREATE DATABASE;
  only an "already exists" message is ignored, so the loser may 500. PRE-EXISTING, low.
- **[task #18 (+1), session f3f0c544, bundle `gkb-web`]** [NEW 2026-10-03, house-rules T4b builder, verified in a
  browser] Settings → Global KB: Enter/Space on a list card's action button opens the dialog instead of acting
  (card onKeyDown); any dialog save resets the Diff/Full toggle. PRE-EXISTING; outside PR4's scope.
- **[task #23, session f3f0c544, CLOSED 2026-10-09 by PR #460 (merge 7fd0dd71, main CI green): the api logs a stray rejection and keeps running, like the worker; the postgres.js root cause stays (backstop)]** [NEW 2026-10-08, house-rules T6b, verified: no api unhandledRejection
  handler] postgres.js 3.4.9 `connection.js` ~574 calls `fetchArrayTypes()` unawaited; a KB connection lost during it
  rejects with nobody awaiting it and would exit the api under Node 26's default. PRE-EXISTING. Fix: extend
  `patches/postgres@3.4.9.patch`, or an api handler that logs.
- **[folded into task #10 (ex-#24), CLOSED 2026-10-09 by PR #463 for the house-rules reads; the global default timeout is task #36]** [NEW 2026-10-08, verified `repo/git-exec.ts:31-59`] gitRun has
  no timeout; PR6 adds a git read to every opted dispatch with a files rule. PRE-EXISTING.
- **[folded into task #13 (ex-#25), session f3f0c544, bundle `tests`, CLOSED 2026-10-09 by PR #465]** [NEW 2026-10-08] fake-db keeps only the first `orderBy` key; dag-
  executor tests leak queued mock implementations. PRE-EXISTING, low.
- **[folded into task #18 (ex-#26), session f3f0c544, bundle `gkb-web`]** [NEW 2026-10-08, browser evidence] at 375 px the global KB page
  scrolls 6 px sideways (Connection card's "Ollama server" select). PRE-EXISTING, low.
- **[folded into task #14 (ex-#27), session f3f0c544, bundle `git-merge`]** [NEW 2026-10-08, probe] `parsePorcelainZ` (`_commit-diff.ts`
  ~96) misreads a worktree-column rename and emits a bogus path. PRE-EXISTING, low (no `git add -N` in Haive flows).
- **[task #28, session f3f0c544, bundle `review-scope`]** [NEW 2026-10-08, review-scope.md:32-40] in a DAG task an
  unreported committed EDIT reaches no reviewer (PR6 added committed deletions only). PRE-EXISTING; fix: union the
  fork-point diff's paths into `collectImplementationFiles`.
- **[folded into task #28 (ex-#29), session f3f0c544, bundle `review-scope`]** [NEW 2026-10-08, verified 09:540-555/:829] gate 2's
  Implementation validation row ignores 07b's capped file list (`changedFilesCoverage`, recorded since PR6), while the
  code-review rows use `readCoverage`. PRE-EXISTING, cheap now.
- **[folded into task #18 (ex-#21), session f3f0c544, bundle `gkb-web`]** [NEW 2026-10-08, house-rules fix-8 fixer, verified `global-kb.ts`
  PUT /config after 921e5df3] an admin's save writes every field the page sends, so a page loaded before another
  admin's change of namespace/enabled/mode writes the old value back (last-write-wins). Non-admins no longer can.
  PRE-EXISTING, low; fix: send only changed fields, or compare-and-swap on a settings revision.
- **[task #32, session f3f0c544, head of bundle `rag-embed`, CLOSED 2026-10-09 by PR #466 (merge e09c0bfc): both halves lexical-only on a failed or wrong-width embed, both bounded (3 s connect, 3 s statement, 6 s deadline), identifier statistics in a savepoint, embed and store from one settings snapshot]** [NEW 2026-10-09, verified `rag.ts:373`, `embed.ts:274-296`]
  (1) rag_search's global half embeds with `embedQuery`, whose hash-vector fallback feeds noise into the dense half
  when Ollama fails (the local half uses `embedQueryOrNull` and goes lexical-only); (2) `embedQueryOrNull` never checks
  the vector length against `dimensions`, so a mismatch reaches pgvector (22000) and the local rag_search answers 500.
  PRE-EXISTING; found by the PR7 analysts.
- **[task #33, session f3f0c544, single]** [NEW 2026-10-09, verified `08b-test-management.ts:903,:980`] quick_bugfix's
  08b tester is told "(no spec recorded)" while 07/07b fall back to the task title + description. PRE-EXISTING.
- **[task #34, session f3f0c544, single]** [NEW 2026-10-09, verified `task-queue.ts:2066-2087`] steps declaring a
  concrete `needsRuntime` ('ddev'/'app': 01a, 01c, 01c1, 06a, 07c, gate 2) pass pool admission before their own skip
  decision, so on a full pool a step that would only skip parks. PRE-EXISTING, low.
- **[task #28 item 3, session f3f0c544, bundle `review-scope`]** [NEW 2026-10-09, found in the PR6 live run ea88adcf]
  07b computes `implementationFiles` once in detect (`07b:720`): the re-validation scope list (`:928`) omits files the
  fixer CREATED and `changedFilesCoverage` (`:1026`) records the detect-time count (live: 2/2 while the change had 3).
  List PRE-EXISTING; the coverage claim is PR6's.
- **[task #45, session f3f0c544, single, DESIGN, HIGH]** [NEW 2026-10-09, review-scope fixer, measured] gate 3's
  commit-message context masks secrets by PATH: a deny-listed file moved to an allowed name without git pairing the
  rename (status.renames=false, or rewritten below the similarity threshold) sends its content to the commit-message
  model. PR #462 closed the worktree-column variant. PRE-EXISTING; needs a blob/content check.
- **[task #46, session f3f0c544, head of bundle `prompt-names`]** CLOSED 2026-10-10 by PR #494 (merge df123379), all three items. [NEW 2026-10-09] five prompt-line name filters use
  `isSingleLine` without `survivesFence` (01-plan-build, 04, _lint-scope, attachments-context, 00-plan-inputs); 01e/01f
  print git-log paths unfenced; 00b joins changedPaths. PRE-EXISTING; `isListableName` (#462) is the predicate.
- **[task #44, session f3f0c544, single, low]** [NEW 2026-10-09] `applyKnowledgeReserve` returns a knowledge chunk twice
  on a short fused page. PRE-EXISTING.
- **[task #41, session f3f0c544, single, DESIGN]** [NEW 2026-10-09, rag-embed builder, measured] 23 `withGlobalKb`
  callers (9 api, 14 worker) are unbounded; against a store that hangs up on postgres.js's first type query the
  primitive opened 867-1331 connections in 4 s and never settled; even a bounded call's schema ensure has no statement
  timeout. PRE-EXISTING. Options: fetch_types:false everywhere (array literals), bounds on lock-free callers, a patch.
- **[task #42, session f3f0c544, single]** [NEW 2026-10-09, measured] `ragHybridSearch`'s lexical-only branch runs no
  identifier ranker, so every degraded search (failed embed, lexical-only repo, jsonb store) loses identifier matches.
  PRE-EXISTING; a ranking change, calibrate first (rag-retrieval-improvements.md).
- **[task #43, session f3f0c544, single, low]** [NEW 2026-10-09] packages/worker/scripts/*.ts are outside
  tsconfig.typecheck.json and never type-checked. PRE-EXISTING.
- **[task #39, session f3f0c544, head of bundle `change-read`]** [NEW 2026-10-09, review-scope fixer] a failed dirty
  scan is never disclosed (coverage reads full, no notice) to 07b/08c/08c2/08d or gate 2; a failed committed-path read
  counts as "none"; `.txt` counts as documentation (CMakeLists.txt, requirements.txt get 07b's docs protocol);
  `fixerFiles` reads only the latest fixer pass. PRE-EXISTING.
- **[task #40, session f3f0c544, head of bundle `ddev-config`]** [NEW 2026-10-09, runners fixer probes] 07c
  `classifyDrift` compares raw `.ddev/config.yaml` text (a quote-only edit plans a same-version migration; a quoted
  `'postgres'` baseline skips the PostgreSQL guard); `_ddev-config.ts` reads `"10.11" # lts` as null. PRE-EXISTING.
- **[task #38, session f3f0c544, single, DESIGN, HIGH]** [NEW 2026-10-09, runners fixer] when a project is not on
  DDEV, 08b's selective run execFiles the repository's own test runner (npx vitest/jest/playwright/cypress,
  vendor/bin/phpunit, pytest; `runTestCommand` ~577) INSIDE the root worker, which holds the docker socket: repository
  code runs with the worker's privileges. Needs a design (run host-kind tests in the task sandbox). PRE-EXISTING.
- **[task #37, session f3f0c544, head of bundle `shell-splices`]** CLOSED 2026-10-10 by PR #490 (merge bb9c9d11); _app-auth also on shellQuote; ide-runner targetHost dropped (uuid container name). [2026-10-09] '${appUrl}'/'${url}' spliced into
  probe commands inside single quotes without escaping `'` (08a ×6, gate 2 ×2, 99-run-app-ready ×2,
  runtime-ensure-queue ×2; values from the browser form or raw .ddev name/tld); plus the five private quoting helpers
  to fold into `sandbox/shell-quote.ts`. PRE-EXISTING. Lands after the runners PR.
- **[task #35, session f3f0c544, single, DESIGN]** [split from `runners` 2026-10-09] a timed-out DDEV command keeps
  running: the timeout kills only the local `docker exec` client, and `ddev exec` drives the daemon into the web
  container, so the phpcs/test process lives on there. Needs a mechanism (timeout inside the web container, or a kill
  by marker) measured on a throwaway DDEV project. PRE-EXISTING.
- **[task #36, session f3f0c544, single, DESIGN]** [split from `runners` 2026-10-09] host git calls have no default
  timeout (gitRun, 219 call sites in 42 files); the runners PR bounds only PR6's dispatch change read and the gate
  fingerprint (30 s per call). Gate 3's own git calls, the collector, merges, fetch/push stay unbounded. PRE-EXISTING.
- **[task #19, session f3f0c544, CLOSED AS DECIDED 2026-10-09: the user keeps the embedder settings open (invite-only instance)]** [NEW 2026-10-03, house-rules T5b builder, verified
  `global-kb.ts` ~335] any signed-in user can make the api fetch an arbitrary URL: POST /global-kb/test-ollama takes the
  URL from the body, and the stored Ollama URL is open to every user. PRE-EXISTING; decision: admin-only Ollama URL and
  embed model, or accept on an invite-only instance.
- **[task #200]** [NEW 2026-10-01, B1.4a harness agent, verified by reading `repo/blank-scaffold.ts` ~55-100]
  `buildBlankRenderContext` repeats 07's render-target derivation (one target per agents dir, first
  provider wins, adapter rulesFile/rulesFileMode in row order). Identical today; two copies drift, and
  `blank-scaffold.test.ts` does not pin rulesFile/rulesFileMode. PRE-EXISTING; left: route it through
  B1.4a's `renderTargetsFor` once that lands (blocked by #161).
- **[task #202]** [NEW 2026-10-01, #179 harness agent, measured EPERM after 200 new bytes; verified by
  reading `fs-safe.ts` ~1436-1442] overwrite-in-place writes the bytes before its strict chmod/chown,
  so a refusal rejects with the new bytes on disk. PRE-EXISTING; no production caller, so low.
- (#176 widened 2026-10-01: the primitive `updateFileNoFollow` decodes and re-encodes too, so every
  caller turns a non-UTF-8 byte into U+FFFD on a SUCCESSFUL write; measured e9 -> ef bf bd.)
- (#202 widened 2026-10-01: since #179, overwrite-in-place reads the whole existing file to have bytes
  to put back, with no cap. REGRESSION in an uncalled path; left with the rest of #202.)
- **[task #210]** [NEW 2026-10-01, #384 round-2 fixer, verified by reading `01-upgrade-plan.ts` ~296-311,
  ~653, ~191-209] 01's pre-RTK fallback stores a synthesized `rtkEnabled: false` in its backfill rows
  with no mark; a later upgrade's `pickRenderSnapshot`/`resolveRenderContext` read it as a recorded
  choice. PRE-EXISTING; left: needs 01 to stop storing it (pre-RTK repositories only).
- **[task #165]** **Neither upgrade gate reads the reset epoch**, so a repository whose onboarding completed
  BEFORE a reset is still offered an upgrade, and accepts one that recreates the files the reset
  removed. `upgrades.ts:446-469` and `tasks/index.ts:445-463` ask only for a completed onboarding
  task, which outlives the reset; `repos.ts:2746-2748` states the opposite ("with no live rows the
  banner already reads not onboarded"). PRE-EXISTING. Left because the fix changes what every
  already-reset repository sees, so it wants its own PR after B1.4 adds its acceptance term.
- **[task #166]** **An upgrade can start beside a live onboarding** once step 12 has written rows, and 13 can park
  on its conflict form for a long time. `tasks/index.ts` refuses a second ONBOARDING task but not
  an upgrade. PRE-EXISTING. Same PR as the entry above.
- **[task #167]** **With no file-based agents directory enabled (amp only), 07 writes `.claude/agents` as a
  fallback (`07-generate-files.ts:843-848`) while 12 records `agentTargets: []`
  (`12-post-onboarding.ts:186`)**, so no upgrade ever manages those files. PRE-EXISTING. Left for
  B1.4, which starts recording the render context from 12's snapshot and is where the written
  target belongs.

Sweep 3 ([[found-not-fixed-sweep-3-series]], plan `docs/plans/found-not-fixed-sweep-3.md` and
`docs/plans/two-install-project-sync.md`) tags each entry with the PR planned for it.

- **[task #213]** [NEW 2026-10-01, #169/#170 analyst] Tier-3 preemption reads "no live CLI run" as
  settled (`runtime-runner-reaper.ts` :162-170), exactly when 06a/08/08b exec into the runner, so a
  higher-voted task can reap it mid-migration or mid-suite. PRE-EXISTING; needs a "runner busy" signal.
- **[task #217]** [NEW 2026-10-01, #208/#209 harness, probed on main] Two concurrent PUTs of one upload
  chunk both pass the claim (it only sets `updated_at`); a failed one's rollback cuts the other's bytes.
  PRE-EXISTING; needs an in-flight marker.
- **[task #220]** [NEW 2026-10-01, #208/#209 harness; low] fs-safe replace-atomic temps
  (`.<leaf>.haive-tmp-<pid>-<uuid>`) left by a process death are never swept. PRE-EXISTING for every
  replace-atomic writer; newly reachable for the notification sound (#209). Needs a scoped sweep.
- **[task #214]** [NEW 2026-10-01, #169/#170 analyst] A run_app Retry then Skip of 01 leaves
  `worktree_branch` set: agents mount the abandoned worktree while DDEV/IDE serve the root. PRE-EXISTING.
- **[task #215]** [NEW 2026-10-01, #169/#170 analyst] 08b's preflight reads "runner container up" as
  "project usable" and any failed enumerate as a BLOCK. PRE-EXISTING; measure `ddev exec` on a stopped
  project first.
- **[task #218]** [NEW 2026-10-01, #169/#170 analyst] DAG issue coders' app reach is the integration
  tree's runner (per-task reach ignores `worktreeRel`). PRE-EXISTING; design question.
- **[task #216]** [NEW 2026-10-01, #169/#170 analyst; low] `staleHandleNote` never reaches a streaming
  DDEV exec. PRE-EXISTING; diagnostic only.
- **[task #219]** [NEW 2026-10-01, #169/#170 analyst; latent] Runner boot coalescing keys on taskId only.
  PRE-EXISTING; re-check once #170's PR A lands.
- (#169/#170 DECIDED 2026-10-01, analysis `.claude/tmp/fnf-169-170/analysis.md`: #170 is the root cause
  of the subpath divergence -> PR A, `resolveDdevWorkspace` reads `tasks.worktree_path` (root only when
  01 is `skipped`); #169 is really LIVENESS -> PR B, 06a and 08 exec only through an ensured handle;
  the other ten handle sites are probes and stay.)
- **[task #169]** [NEW, found 2026-09-27 while fixing a 2026-09-27 fix, verified by reading] **Eleven call sites build a
  runtime-runner handle from `runnerHandleForTask`/`appRunnerHandleForTask` rather than through
  `ensureDdevStarted`/`ensureAppRunnerStarted`, so none of them sees the boot-subpath check**
  (`08b-test-management`, `08-phase-5-verify`, `06a-db-migrate`, `_browser-runtime`,
  `ddev-control-queue`, `app-reach`). While the runners mounted the whole volume any subpath
  resolved; since `610b7cbd` they mount ONE, so a handle naming another lands in the empty
  mount-point directory docker creates and `ddev` answers "not a DDEV project". A failed exec now
  names the mismatch (`staleHandleNote`), which is a diagnostic and not the fix. PRE-EXISTING
  shape, made reachable by a 2026-09-27 fix. Fix: see the DECIDED note above (only 06a and 08 need an ensure).
- **[task #142]** [NEW, found 2026-09-30 by the Opus review of the RAG article pass, MEASURED; the RAG entries
  below are F1-F8 of `docs/plans/rag-retrieval-improvements.md`, see [[rag-retrieval-plan]]]
  **The RAG chunker drops the FIRST function of nearly
  every PHP file into a path-only gap chunk.** `phpRanges`' funcRe has a lazy optional docblock group
  (`(\/\*\*[\s\S]*?\*\/\s*)?`) that stretches from the `@file` docblock to the first function, and
  `assembleSections` then drops that range for strictly containing the `file-docblock` range. Probe:
  with a file docblock the first of two functions becomes `chunk-0(gap)`, without one both extract.
  On the elmont_rs tree (env-detect excludes) 1,213 of 1,292 PHP files with a leading docblock lose
  their first function; Drupal requires `@file` docblocks. PRE-EXISTING. Left: the fix (a docblock
  group that cannot span another `*/`) re-hashes those chunks, so it ships with one planned reindex,
  measured by a retrieval eval. THE ONE I WOULD FIX FIRST in RAG.
- **[task #142]** [NEW, found 2026-09-30, MEASURED] **Remaining construct misses in `_rag-chunkers.ts`**: of 11,803
  PHP functions with bodies, 469 have a parenthesized default (`= array()`), 77 a return type and 23
  a by-ref `&`, all but 5 of them missed; JS/TS anonymous or callback functions (228 files with nothing else) and named JS/TS
  constructs the regexes miss (52 files) index as gaps. Of 981 files with no extracted construct, 457
  have no function at all, so that share is not a miss. PRE-EXISTING; same reindex reason.
- **[task #144]** [NEW, found 2026-09-30, MEASURED] **The lexical half rarely co-supports a hit.** Production: of
  2,514 logged queries that returned code hits, 1,700 (67.6%) had max_rrf exactly 1/61, so no hit on
  the page was found by two rankers (two-ranker rrf is at least 2/110 with pools of 50). Replay of 150
  onboarding queries against the scoped chunks: 144 match nothing under `plainto_tsquery`'s AND.
  PRE-EXISTING (AGENTS.md: 17 of 18 on an older index). Left: plain OR and coverage ranking already
  measured worse (AGENTS.md); a capped IDF ranker needs a retrieval eval, and none exists.
- **[task #143]** [NEW, found 2026-09-30, MEASURED] **`chunkSection` cuts code mid-line because its split order has
  no single-newline level**: paragraph break, then the prose `'. '` heuristic, then a hard cut at
  `maxSize` (`_rag-chunkers.ts:563-575`). 32.5% of non-final chunks end mid-line on the scoped tree
  (29.8% before the per-file cap), and 955 of those cuts land on `'. '` inside code. A
  single-newline fallback between the paragraph and sentence levels (LangChain's recursive-splitter
  order) takes it from 2,194 to 691 (9.5%). PRE-EXISTING; ships with the planned reindex. Retrieval
  impact unmeasured.
- **[task #148] CLOSED 2026-10-12 by D1 (#591, #595): own code + KB exempt, 2 MB backstop** [NEW, found 2026-09-30 reviewing the SciPy 2024 RAG tutorial, MEASURED] **`MAX_CHUNKS_PER_FILE`
  (80) leaves most of the repo's own core class unindexed.** On the elmont_rs tree (env-detect
  excludes) the cap drops 1,968 of 21,813 chunks (9.0%) across 29 files. 8 of them are the custom
  `activit` module (557 chunks), led by `_classes/inspection.class.inc` (331 of 411 dropped) and
  `activit.install` (97 of 177); the rest is mostly vendored jQuery copies and views. By design and
  logged (`_rag-chunkers.ts:80-85`), PRE-EXISTING. Left: reshaping the budget (per repo, or exempting
  09_7-selected dirs) changes embed cost and wants the retrieval eval.
  (+1, 2026-10-12, session a7cfa69f task #8 `FNF[rag-budget]`, VERIFIED) `MAX_FILE_BYTES` 512,000
  (`_rag-chunkers.ts:78`, enforced `10-rag-populate.ts:822,887`) skips a whole file before chunking:
  `sites/all/modules/activit/d_inspection.inc` (712,170 bytes) is not indexed at all, plus vendored
  ckeditor.js and datatables.js. PRE-EXISTING. Same decision (plan D1); the P0 eval now measures it.
- **[task #9 session a7cfa69f, single `FNF[rag-dense]`]** [NEW 2026-10-12, MEASURED] On the 20,839-row
  `haive_rag_p0_eval` the default HNSW dense pool (40 rows) shares NO row with an exact top 50 on 3 of
  296 golden queries, and < 0.5 overlap on 20 (`.claude/tmp/rag-plan/t6/hybrid.json`). PRE-EXISTING;
  cause unmeasured (ef_search / iterative scan / near-duplicate vectors). Plan F14 → P3.
  INVESTIGATED same day (plan F14, ff33e602): ef 40 search lands in the wrong graph region; bulk
  REINDEX identical; iterative scan no help; ef 200 ≈ exact at ~6 ms warm. Exact dense: r@8 0.681→0.727.
  Planner refuses HNSW at ef≥100 → fix must SET LOCAL ef_search + force index (like denseRead).
  Open as DESIGN task #13 (session a7cfa69f), needs the user's go. GO given 2026-10-12; built
  (ef 200 + cpu_operator_cost 0.1 per-repo; r@8 0.681→0.719), PR pending.
- **[CLOSED 2026-10-12: #9/#13 merged #596, #11 merged #592, #14 merged #597, #15 merged #596, #8 merged #591]**
- **[task #15 session a7cfa69f, single FNF[rag-dense]] CLOSED by #596** [NEW 2026-10-12, MEASURED on a simulated
  5-repo store] filtered HNSW on a SHARED store returns short dense pools: a 20%-share repo got 8/50
  (default), 50 and 22 after #13. PRE-EXISTING. Try hnsw.iterative_scan on the per-repo read (+6 ms
  single-repo); measure on a rebuilt shared scratch store first.
- **[task #11 session a7cfa69f, FNF[rag-mask], PR #592]** [NEW 2026-10-12, VERIFIED] onboarding
  10-rag-populate applied no secret-mask policy (untracked settings.php/secrets.* embedded until the next
  workflow sync). PRE-EXISTING, security. MERGED #592 (df7c0341).
- **[task #147]** [NEW, found 2026-09-30, MEASURED] **No collapse of identical chunk bodies across files**: 1,805 of
  21,813 chunks (8.3%) share their body with another file's chunk (651 groups; one body in 40
  files; the custom `activit` inspection variants share bodies across 15-20 files). They differ only
  by the path header, so they can fill a page with copies; page-level frequency unmeasured (no hit
  list). PRE-EXISTING gap. Left: a query-time collapse (strip the header, hash, keep the best, like
  `dedupeGlobalByEntry`) needs the SQL LIMIT widened past top_k; MMR only if the eval shows
  near-duplicate crowding.
- **[task #145]** [NEW, found 2026-09-30, MEASURED; plan F13] **The lexical half matches Slovak text only verbatim**:
  the `english` tsvector keeps diacritics and does not stem Slovak, so `kotolna` misses `kotolňa`
  and `kotolne`. Agents write both spellings (172 calls `kotolna`, 18 `kotolňa`), and the corpus
  splits by kind (unaccented in identifiers, accented in labels). At least 10.7% of chunks and 6.3%
  of calls carry Slovak diacritics. PRE-EXISTING. Left: `unaccent` (available, not installed) needs
  a tsvector backfill and a fail-open path for stores without it; plan P2(e).
- **[task #183 after #140]** [NEW, found 2026-09-30, MEASURED; plan F14] **On the HNSW path the dense pool is 40, not the
  configured 50**: an HNSW index scan returns at most `hnsw.ef_search` (default 40) rows, measured
  40 for `LIMIT 50` with the index path forced; iterative scan or ef_search 100 give 50.
  `candidatePool`'s comment ("pulled from each of the dense and lexical rankers") overstates it.
  PRE-EXISTING. Left: the fix (iterative scan) needs a transaction per search, which `search.ts`
  deliberately avoided; plan P3/P0. Its comment half
  shipped in #372; the pool itself stays 40 until plan P3.
- **[task #149]** [NEW, found 2026-09-30, MEASURED; plan F15] **Deleted vectors keep their HNSW index space**: the
  shared elmont project store holds 0 rows and a 0-byte heap but 312 MB, 275 MB of it the HNSW
  index. PRE-EXISTING. Left: a REINDEX reclaims it; a full re-embed (plan P1) churns it the same
  way, so size it before and after.
- **[task #140]** [NEW, found 2026-09-30, verified by reading `routes/rag.ts` `logRagQuery`] **`rag_query_log` keeps
  counts and score maxima but not which chunks were returned**, so no past query can be replayed or
  labelled: 3,103 logged queries and no result lists. PRE-EXISTING. Left: a `hits jsonb` column is a
  migration, wanted by the retrieval-eval work.
- **[task #172]** **Plan merge: "Change something first" after a resolved merge never re-runs the agent** (found
  2026-09-26 on #338 R10, asserted by a throwaway test). The answer pass COMMITS the merge in the
  scratch worktree, so the next detect finds no conflicts and `mergeOriginInto` is "Already up to
  date": the guidance is recorded and the same form comes back. PRE-EXISTING.
- **[task #173]** **Plan merge discard leaves the merge for the next conversation** (read 2026-09-26): DELETE
  `/plan/merge` only queues CANCEL, `discardPlanMerge` has no caller, and the route comment says it
  removes the worktree. The next plan merge resumes the discarded merge; a Save/Pull aborts it and
  removes the worktree instead (`refuseWhileMergeOpen` ignores failed/cancelled tasks, so Save/Pull
  also throws away a FAILED conversation a Retry could have resumed). PRE-EXISTING.
- **[task #174]** **A cancel during a same-branch-root merge fixer leaves its changes unreported, merge open**
  (found 2026-09-26 on #338 R19; the cancel path runs no step code and no cancel path aborts a
  merge: only merge-resolver, dag-executor and plan Save/Pull call `abortMerge`). Nothing is lost or
  committed (the root stays as the fixer left it, visible to `git status`); a task worktree is
  removed whole by design and a plan scratch worktree is settled by its next pass or Save/Pull.
  PRE-EXISTING; left: a cancel-time relocation needs the cancelled step's merge state read from the
  cancel path. Documented in AGENTS.md by #338.
- **[task #175]** [NEW, found 2026-09-27 on A3.3 #342, verified by reading] **12 stages every live artifact row,
  including a path 07 SKIPPED because the person's own file stood there.** `recordOnboardingArtifacts`
  inserts a row per manifest rendering without consulting `wroteFiles`, and `resolveStagePaths`
  stages every live row's path under `git add -f`, so an untracked, unignored file of the person's
  own (a `.claude/settings.json`, a slash command) enters the onboarding commit when they tick commit.
  A3.3 narrowed it (no by-name gemini staging; ignored settings files stay out). PRE-EXISTING; left:
  staging only what 07 wrote changes what onboarding commits for every manifest item.
- **[task #176]** [NEW, found 2026-09-27 on A3.4 #343, verified by reading each site] **Every rules-file region
  rewrite decodes the WHOLE file leniently and writes the text back**, so a byte sequence that is
  not valid UTF-8 anywhere in AGENTS.md/CLAUDE.md/GEMINI.md becomes U+FFFD (EF BF BD):
  `readTextNoFollow` is `toString('utf8')` (`fs-safe.ts:454`), used by 02's region write (~885-913);
  `data.toString('utf8')` then `Buffer.from(...)` in 02 `removeIfHaives` (~219-225), 04
  `restoreRemoved` (~763-770) and 04 `restoreIfUpgrades` (A3.4 kept the old behaviour there);
  and 07 `appendOrCreate` likewise. The RTK hook strip refuses a non-UTF-8 file, and so do
  `stripRtkBlocks` and `restoreRtkBlocks` since A3.7 (#346). PRE-EXISTING; fits A3.5's single
  upgrade reader (an `undecodable` outcome beside `oversized`, kept and reported), but 07 sits
  outside it.
- **[task #177]** [NEW, found 2026-09-27 on A4.2 #348, verified by reading `images.ts`/`handlers.ts`] **Nothing
  reaps a sandbox image no provider names.** Removal happens only at the moments a row moves off a
  tag (a build's claim, a superseded build, a provider delete, a provider that stops needing one), so
  an image whose `docker image rm` failed, or one left by a release before #348, stays for good.
  PRE-EXISTING; left: an image sweep needs a "no provider names it and no run uses it" rule of its
  own, like A4.3's for volumes.
- **[task #178]** [NEW, found 2026-09-27 on A4.2 #348, verified by reasoning over `removeOnceBuilt`/`claim`]
  **A removal that starts before a build of its tag can still take the new image**, if that whole
  build finishes inside the removal's check-to-`rmi` window (milliseconds, so only a fully cached
  build). The claim then finds the image gone and the build fails saying so, never a row naming a
  missing image. REGRESSION of A4.2 in principle (the row used to name the tag during the build);
  left: closing it means holding the tag's turn across the whole build.
- **[task #180]** [NEW, found 2026-09-27 on A3.6 #345, verified by reading `api/routes/tasks/steps.ts` ~140 and 02's
  keep branch] **A 02 retried with different answers keeps what the failed attempt wrote.** A step
  Retry clears `formValues`, so the retried form is answered afresh while the failed attempt's
  writes stand: switching a conflict from Overwrite to Keep records the template's bytes as kept
  (the keep branch reads the disk at apply), and the person's bytes survive only as an unreferenced
  record row (#345 writes it ahead of the write; before, an in-transaction failure lost them).
  PRE-EXISTING. Left: undoing a failed attempt's writes, or Keep putting the recorded bytes back,
  is its own design.
- **[task #181]** [NEW, found 2026-09-27 while updating `docs/plans/kind-riding-dream.md`, verified by reading
  `step-runner.ts` mining barrier, `dag-executor.ts` `pickFatalProviderError`, `exec-core.ts`
  `interpretCliFailure`, `handlers.ts` mining-row write] **One content-filter refusal fails a whole
  fan-out step.** The barrier's fail-fast (`59b67fe5`, 2026-08-20) keys on `isFatalProviderFailure`;
  `content_filter` joined `ProviderFatalClass` in `8f09775d` (2026-08-24) and no consumer was
  touched (barrier and exec-core comments still name only rate-limit/auth/5xx). So one refused 08c
  or 08d seat fails the step (siblings' rows stay `done`; CLI switch + fan-out Resume re-runs only
  the refused one, nothing lost), and one refused DAG coder cancels every in-flight sibling coder.
  Not yet observed: 0 content-filter rows on the dev install (2026-09-27). PRE-EXISTING (side
  effect of `8f09775d`). Left: changes 08c/08d gating behaviour, so its own PR; designed as the
  first new core change in `kind-riding-dream.md` (degrade like any failed agent, keep the retry
  veto, DAG coder fails its own issue without escalation).
- **[task #182]** **Plan merge prompt keeps a VALID name holding U+FFFD off its conflict list** (found 2026-09-26
  on #338 R17; `01-plan-merge.ts` `fitsPromptLine`, from #337). The persisted `conflicts` holds
  utf8-decoded names, where U+FFFD is both a real character and what an undecodable byte reads as.
  PRE-EXISTING; left: prompt only (the prompt counts unlisted files and says to find them by their
  markers), and telling the two apart needs a persisted detect-shape change. #338 fixed the same
  misdetection in the relocation and `completeMergeHostSide`.
- **[task #184]** **Git path lists read without `-z` where the names are USED** (verified 2026-09-26 by reading
  each site): `_impl-changes.ts` `dirtyWorktreeFiles` (review scope, `status --porcelain -uall`),
  `10-gate-3-commit.ts:87` (`show --name-only`), `_external-drift.ts` (`log --name-only`),
  `11b-kb-commit.ts` (KB status), and the staged-path REPORTS in 12 and 03 (`diff --cached
--name-only`). A name holding a quote or non-ASCII byte comes back C-quoted there. PRE-EXISTING;
  a different functionality from the merge readers (A2.1 #336, A2.1b #337 fixed those). Sites that
  only count or test for emptiness are fine (`10-gate-3-commit.ts:151`, `99-run-app-ready.ts:160`,
  `01-worktree-setup.ts:219`, `dag-executor.ts:438`, `plan-mirror-queue.ts:307`).
- **[task #185]** **Nothing resets `merge_resolve_state`** (`task_steps.merge_resolve_state`; the api's
  `resetRowsForRerun` and retry_ai leave it, and the runner skips its AI-fix phase for merge steps).
  After "auto-resolution exhausted after 4 attempts", a Retry and "Retry with AI" re-read
  `conflictRetries: 4` and halt again at once, though the message offers both. PRE-EXISTING, found
  2026-09-26 on A2.1. #336 makes a merge finished BY HAND finish the step on Retry (committed check
  first); the budget itself still never resets. Fix needs a pass marker in the state or a reset of
  the budget by the step Retry; not planned yet.
- **[task #111 #113 #115; item 5 #186]** [sweep 3: Track B] **`.haive/install.json` is written by three steps and read by none; plan edits
  can be reverted by a flush after a non-Pull checkout move; a plan flush can write mid-merge;
  `autoResolvePlanFiles` runs only in plan merges; 01-env-detect's project-name fallback can put
  the repository UUID into committed files.** PRE-EXISTING.

- **[task #187]** **Every git write the worker makes in a sandbox tree leaves root-owned files** (MEASURED
  2026-09-26 on git 2.54 as root in a uid-1000 tree: after `git merge`, the conflicted file AND the
  cleanly merged file are `0:0`; `git restore` and `merge --abort` write the same way).
  `ensureSandboxWritableTree` and `ensureRepoMountWritable` check only the tree ROOT, so nothing
  hands them back. Whether an agent's edit then fails is unmeasured: 0 of 127 recorded runs on merge
  steps (23 `01-plan-merge`, 104 `06c-dag-execute`) show "permission denied"/EACCES in raw_output,
  which suggests the CLIs' writes replace the file. PRE-EXISTING; A2.2 hands back only what its own
  relocation restores (#338, 66a3359e). Left: which writes to hand back (every merge, every abort)
  and at what cost is a design, and no failure has been observed.
- **[task #188]** **The plan-merge agent works from the repository root, not its scratch worktree** (verified
  2026-09-26: `01-plan-merge.ts` buildPrompt says the merge is in `.haive/worktrees/plan-merge`
  "RELATIVE TO YOUR WORKING DIRECTORY"; the step's llm phase gets the task's mount, the root). A
  stray it writes outside the scratch worktree lands in the person's checkout, where A2.2's
  relocation (which diffs the scratch worktree) cannot see it. It is not committed by the merge
  (that commit is in the scratch worktree, and `commitPlanSnapshotFiles` stages plan files by
  name), but it stays. PRE-EXISTING. Left: a step's llm phase cannot name a worktree mount today
  (the merge resolver passes `worktreeRel` itself).
- **[task #189]** [sweep 3: A2.2 limitation, #338] **A new file hidden by an ignore rule a merge fixer added OUTSIDE
  the conflict stays in the tree.** The second snapshot judges files new since the baseline by the
  rules the fixer leaves; the relocation then restores that non-conflicted `.gitignore`, so the file
  becomes an untracked stray. Never committed (the commit stages only unmerged paths), no loss.
  Not on main (A2.2 is new). Left: needs a second snapshot after the restore.
- **[task #163 +#110]** [sweep 3: Track B B1.4/B1.6] **upgrade-status and POST /tasks disagree with the repos page about a repository onboarded
  elsewhere** (`routes/upgrades.ts` `isOnboarded`, the `onboarding_upgrade` gate in
  `routes/tasks/index.ts`, vs `lib/onboarding-state.ts`). A repo cloned in with committed markers
  has no task and no rows, so the repos page calls it onboarded while the banner stays hidden and
  POST /tasks answers 409 to an upgrade. PRE-EXISTING, found on #324. Product decision.
- **[task #190]** **Switching RTK back on writes the AGENTS.md block only on re-onboarding** (DEFERRED: with no
  row Haive cannot tell a block it stripped from one a person deleted). The restored `@AGENTS.md`
  stubs stay on a rollback by design (AGENTS.md loading needs them).
- **[checkpoint, no task]** **Checkpoints, not defects**: Dependabot's npm jobs: runs at 2026-09-25 12:31Z and 12:55Z failed
  as expected (next 16.3.6 inside pnpm's 3-day maturity window until 16:19Z); none has run since,
  and the schedule is weekly with no day (GitHub's default Monday, ~2026-09-28). Pass = green and
  opens GROUP PRs (#300's `*` catch-alls). The release actions (setup-buildx 4.4.1, build-push
  7.4.0) have never run: next `-rc` tag. The invariant-citation effect (#203) needs a live run
  ([[prompt-guard-fence-verification]]); the fs-safe checks needing a workflow task (`00-triage`,
  KB editor at 11/11b, `12-worktree-cleanup`, cancel) are in [[onboarding-run-checkpoints]].
- **[task #191]** [NEW, found 2026-09-27 on A5.1 #352 and A5.2, measured] **phone.spec "fits the screen, and the
  title strip keeps to one line" fails when it is the first browser hit on a freshly started
  `next dev`**: `[title*="subscription usage"]` counts 4 against the expected 2, while the a11y
  snapshot shows only 2 (the other pair is hidden). Warm it passed 8/8 on two unrelated branches, and
  CI is green. Its sibling tests wait for `html[data-shell-hydrated="true"]` before counting; this
  one counts right after the heading. PRE-EXISTING; left: the hidden pair's source is unproven (the
  title strip mounting before hydration settles is a guess), and a wait added on a guess could hide a
  real double render.
- **[task #192]** [NEW, A5.5 #358, deliberate scope] **Only the specs that seed running tasks use the teardown
  fixture** (tasks/phone, tasks/actions-api, tasks/create). The rest still clean up in their own
  `finally`, and the per-run global teardown removes what a timed-out one leaves, but only at the
  end of the run: a Retry/submit spec (tasks/actions, tasks/detail, tasks/gate-form) that times out
  leaves a task the dev worker keeps driving until then. Left: the plan says "first"; migrate on
  next touch.

- **[task #193]** [NEW, found 2026-09-27 on A5.6, seen once] **create.spec's happy path can lose to a cold
  `/tasks/[id]` compile**: `waitForURL` timed out at 10 s while `POST /tasks` had answered 201 in
  47 ms; warm it passed 10/10. Same class as the phone.spec cold hit above. PRE-EXISTING; left: a
  longer wait on a guess would hide a real slowdown.
- **[task #194]** [NEW, found 2026-09-27 on #358's live check] **5 stranded `user_invites` rows on the dev install**:
  4 consumed on 2026-09-26 whose consumer is gone (`consumed_by_user_id` NULL, `created_by` NULL, the
  e2e seeding shape) and 1 unconsumed, expired, from 2026-09-11. `cleanupUser` deletes an invite
  before its user, so these came from another delete path or an older helper. PRE-EXISTING; left:
  deleting rows on the user's install needs their approval.

- **[task #195]** [NEW, found 2026-09-27 on #358 Codex R5, by reading] **A cancel whose queue write fails is never
  retried**: the api's cancel action commits `cancelTaskRow` and then queues CANCEL; a throw there
  answers 500 with the task already `cancelled`, every later cancel answers 200 without queuing, and
  nothing else re-drives the teardown, so the task's runners, worktree and env image stay (the repo
  DELETE's post-commit enqueues have the same shape). PRE-EXISTING; left: a retry must not start a
  second teardown beside one queued or running, and `enqueueCancelJob` sets no jobId, so it needs a
  dedupe design of its own. The e2e teardown keeps such a user (safe direction) rather than deleting
  rows the missing teardown would need.
- **[task #196]** [NEW, 2026-09-27, trade-off of #359's d14ae697] **A per-repo RAG store's two first creates now
  fail a step instead of choosing jsonb**: `ensureRagSchema` takes no lock (the global ensure
  does), so two first `CREATE EXTENSION`s on one fresh store raise a non-capability error, and
  that step fails where it used to create the jsonb table for good. Only two onboardings of
  different repos sharing one external store reach it. Left: rare, visible and cleared by a Retry;
  the global ensure's advisory lock is the fix if it is ever seen.
- **[task #197]** [NEW, found 2026-10-01 while fixing D7's Codex round 3, verified by reading
  `09_6-skill-verification.ts` `resolveGateCliChoice` and `resolvePreferredCli`] **09_6's "CLI for
  the fix" pre-selects the task's model, while leaving it there runs the fix on the target step's
  own CLI.** The default is `ctx.cliProviderId` and the field says "Defaults to the task's current
  model", but an unchanged pick writes nothing, so the repair (09_5b) or regeneration (09_5) runs on
  whatever that step resolves to, which a CLIs-tab choice in the task or a saved preference can make
  differ from what the dropdown shows. PRE-EXISTING (the saved-preference case predates #373). Fix:
  pre-select the target step's resolved CLI (it differs per decision), or write the choice whenever
  a fix is picked.
- **[task #198]** [NEW, found 2026-10-01 while fixing F16 (#375), verified by reading `03-plan-sequence.ts`
  `stampMiningError` and `sequence-progress.ts` `askedParents`] **A sequencing reply rejected at
  apply still counts its group as asked.** `stampMiningError` writes only `error_message`, the row
  stays `done`, and `askedParents` takes any `done` row from another pass as answered, so a group
  whose order never landed (no patch in the reply, or a patch the applier refused) is never asked
  again and drops out of the plan page's Order count. MEASURED: 1 of 400 stored replies parsed to no
  ops. PRE-EXISTING. Fix: count a row as answered only when its reply applied.
- **[task #199]** [NEW, found 2026-09-27 on A5.6's Chrome check] **`/favicon.ico` answers 404 on every page**, on
  main's `haive-web` too; it shows as the only console error in browser checks. PRE-EXISTING,
  cosmetic; left: no icon asset exists to serve.

Backfilled 2026-10-03: these tasks were created on 2026-10-01/02 without the entry the rule requires.
Each was verified when its task was written. #205 was re-read on main 9beb7507.

- **[task #205, `snapshot`]** [B1.4a judging] 04 stores `formValuesSnapshot: snapshot ?? {}`
  (`04-upgrade-rollback.ts:623`), and `pickRenderSnapshot` counts `Boolean({})` as a snapshot, so a
  repository with pre-2026-04-27 rows can plan from `{}`. PRE-EXISTING. Fix: skip a snapshot missing
  a portable field, and have 04 write null.
- **[task #221, `worktree`]** [#170 harness] `tasks.worktree_path` and 01's output outlive the
  worktree that 12 or a cancel removed, so `resolveDdevWorkspace` answers a missing directory.
  PRE-EXISTING. Design: clear the column on removal, or check it at resolve time.
- **[task #222, `worktree`]** [#212 harness, read not run] `findBranchClaimant` keys on the branch
  name, but `worktreeDirName` flattens `feature/x` and `feature-x` to one directory, so two tasks share
  one tree. PRE-EXISTING. Fix: claim by directory as well.
- **[task #223, `worktree`]** [#212 harness, MEASURED in a test] `carryUntrackedForTask` promises
  never to throw, but reads config outside its try, so a config failure fails 01's apply after the
  worktree exists. PRE-EXISTING, cheap.
- **[task #224, `runners`]** [#169 PR B] a Stop cannot cancel an app runner's slot wait:
  `ensureAppRunnerStarted` takes no signal, while the DDEV path does. PRE-EXISTING.
- **[task #228, single]** [design-227 FNF 2] a release-added template stays out of the banner until
  the next 12/01/02/04 write. #393's boot recompute covers repositories with a column, not ones with
  a NULL column. PRE-EXISTING.
- **[task #230, single]** [B1.4d design FNF 7, practically unreachable] an upgrade created inside
  the sync's transaction window plans from the old context, and 02 writes that context back. Task
  creation takes no project-state lock. PRE-EXISTING, low.
- **[task #231, `tests`]** [#169 commit C harness] 07b's apply tests leave `recordLedgerEntry`
  unmocked, so each run logs 5 TypeError warnings. Noise only. PRE-EXISTING; one `vi.mock` fixes it.
- **[task #232, `snapshot`]** [B1.4c harness, pinned both ways by its grid] with a pre-RTK snapshot
  and the switch off, the banner offers the RTK block removal (`!repo.rtkEnabled`), but 01's plan does
  not (`=== false` misses `undefined`). PRE-EXISTING. Fix: one shared predicate.
- **[task #233, `upgrade-status`]** [design-227 FNF 3] 01 lists an obsolete file for deletion after
  it stopped holding its row's bytes, and 02 always keeps that file. PRE-EXISTING. Fix: the plan does
  not offer it, or says why.
- **[task #234, single]** [design-227 FNF 5] upgrade-status compares templates, not paths, so the
  banner misses a per-path obsolete removal of a template that still renders at another path.
  PRE-EXISTING; it needs a per-path record.
- **[task #235, `upgrade-status`]** [design-227 FNF 6] 01 offers a custom bundle item it cannot
  render (invalid spec, no target) as obsolete, while the banner counts it as current. PRE-EXISTING.
- **[task #236, `upgrade-apply`]** [design-227 FNF 7] `readUpgradeFile` decodes lossily
  (`rules-files.ts:32`). An RTK settings file that is not valid UTF-8 therefore reads as strippable,
  02 keeps it, and the offer never clears. PRE-EXISTING; same fix as #176.
- **[task #237, `upgrade-status`]** [design-227 FNF 9-10, wording] the banner says "N template(s)
  changed" for obsolete removals. Dangling custom rows stay off the banner by design. PRE-EXISTING.
- **[task #238, `plan`]** [B1.4d harness, seen in the two-install smoke log] every rescan of a
  repository with a plan records "Plan snapshot not imported: repository already has a plan" as
  `plan_mirror_state.last_error`. PRE-EXISTING; whether the UI shows it is unchecked.
- **[task #5, session 28d6c55c, design single]** PLANNED as AIDE² F18, T5 PR-A (plan
  fancy-kindling-flurry, user-approved 2026-10-03: a separate `guidance` field): Haive's own fixer instructions (08c `VALIDATE_THEN_ACT` and "Already tried", 08b "Decide per
  failure") ride inside the diagnosis 07 fences as agent text (08c ~:950/~:1051, 08b ~:687, 07's agent
  defect block). PRE-EXISTING; effect unmeasured.
- **[task #11, session 28d6c55c, `fix-prompt` head]** CLOSED 2026-10-08 by PR #437 (merge e3cf9409). 07's human framing ("A developer tested the running
  application and REJECTED it") renders for a `fix-loop-gate` directive on an agent check and for 08d2
  rounds (`HUMAN_REJECT_SOURCES`, `_fix-loop.ts` ~:466). PRE-EXISTING, wording.
- **[task #12, session 28d6c55c, `fix-prompt`]** CLOSED 2026-10-08 by PR #437 (merge e3cf9409). `loadHonoredConstraints`' head-slice (`_fix-loop.ts`
  ~:633) can close a BEGIN banner into an empty fence (1 of 1,000 pad lengths probed). PRE-EXISTING, low.
- **[task #13, session 28d6c55c, `plan`]** CLOSED 2026-10-08 by PR #441. 03 lists its own children twice on a wide run: the context's
  "Existing child" lines (10,207 of 31,755 chars on a 250-child run) repeat `## Your node`. The helper's
  3-arg output must stay byte-identical for 01/02, so this needs an option. PRE-EXISTING, low.
- **[task #6, session 28d6c55c]** CLOSED 2026-10-08 by PR #442. fix-loop fingerprints hash the last 6,000 chars of a diagnosis
  (`FINGERPRINT_TAIL_LIMIT`, `task-ledger.ts`), so a head-first diagnosis (gate 2, 08c) is deduped and
  oscillation-checked on its least important part. PRE-EXISTING; design single (stored ones are
  compared, so it needs a versioned fingerprint).
- **[task #7, session 28d6c55c]** `PLAN_PATCH_CONTRACT` (`_plan-prompt.ts` ~:45) promises node versions
  03's prompt never shows (AIDE² D9). PRE-EXISTING since #374; design single.
- **[task #8, session 28d6c55c]** CLOSED 2026-10-08 by PR #438. gemini's argv cap (65,536) is below every 03 prompt (~107k) and 01/02's
  largest (~108k); the dispatcher's provider loop reportedly fails the dispatch rather than trying the next
  provider (`dispatcher.ts` ~:434-438, analyst claim, unverified). PRE-EXISTING; design single.
- **[task #9, session 28d6c55c]** CLOSED 2026-10-08 by PR #443. 08b's `priorPassNotes` keeps only the last 400 chars of each pass's
  notes (`08b-test-management.ts` ~:663); whether those notes lead with their point is unmeasured.
  PRE-EXISTING; single until measured.
- **[task #14, session 28d6c55c]** CLOSED 2026-10-08 by PR #443. the root-cause request and the repeat fact (AIDE² P2) reach only 07's
  fix prompt; 08b's fix pass, 07b's fixer and the DAG fix coder carry neither. PRE-EXISTING scope;
  design single.

- **[task #15, session 28d6c55c, `fix-prompt`]** CLOSED 2026-10-08 by PR #437 (merge e3cf9409). 07b's honored-constraints block renders machine
  diagnoses unfenced under "Do NOT recommend reverting them" (07b:719/:855). PRE-EXISTING (T5 analyst).
- **[task #16, session 28d6c55c, `fix-prompt`]** CLOSED 2026-10-08 by PR #437 (merge e3cf9409). the cap escalation gate shows the raw stored diagnosis
  unbounded (task-queue.ts:1673 -> `buildFixLoopEscalationSchema`); #395 bounded only the oscillation
  gate. PRE-EXISTING.
- **[task #17, session 28d6c55c, `fix-prompt`]** CLOSED 2026-10-08 by PR #437 (merge e3cf9409). `HONORED_CONSTRAINT_SOURCES` still names 08d, which has
  not looped back since ef9b253e. PRE-EXISTING, dead entry.
- **[task #18, session 28d6c55c]** CLOSED 2026-10-08 by PR #439. Retry with AI puts the prior error (DDEV output, container logs, repo
  file names) unfenced into an editing agent's prompt (step-runner.ts ~:1005). PRE-EXISTING; single.
- **[task #19, session 28d6c55c]** CLOSED 2026-10-08 by PR #439. the learning prompt embeds the task digest unfenced
  (11-phase-8-learning.ts ~:1124-1126). PRE-EXISTING; single (the house-rules session edits that file).
- **[task #20, session 28d6c55c]** CLOSED 2026-10-08 by PR #440. 08a's `formatInteractiveReject` is unreachable (shouldRun false unless
  mode mcp). PRE-EXISTING dead code; low.

## Decided, not to re-open without new evidence

- 2026-10-12 (#171): task activation for task types other than onboarding/upgrade does not read the repository
  root claim. Documented trade-off (AGENTS.md writer 1): a refresh's window loses nothing and can cost a git lock
  collision a Retry clears; the abandoned task-queue gate costs installation-wide concurrency. Onboarding/upgrade
  revivals (#472) and workflow creation (#558) already refuse under a live claim; the ratchet #541 covers future
  inline revivals. Sub-items decided: the api's early upgradeAdmission/refuseReviveBesideLive pre-checks STAY (an
  immediate 409 to the person; the in-lock checks stay authoritative); the CLI switch's preference write before the
  guarded redrive STAYS (the preference is the person's choice either way); cancelled tasks from before
  task.cancelled events are a closed historical set the #195 sweep need not reach.
- 2026-10-08 (#451): a 07b detect output stored before the provenance mark drops its pre-rendered honored-constraints
  block at prompt build instead of re-deriving it: buildPrompt is synchronous, the stored text cannot be split into person
  and machine entries, and fencing it whole would fence the operator's words. Transient (steps detected before the deploy).
- 2026-10-09 (#456): a merge fixer whose refund and re-dispatch are split by a worker crash is re-sent without the
  shrink notice once; self-limiting (a second cut-off is charged). A truncated resolver fixer's partial `uncertain` JSON is
  not routed to the guidance question (its run did not finish cleanly).

Added 2026-10-01 by the #201/#203/#204 harness (verified by a probe there):

- `updateFileNoFollow` sizes its read by fstat, so bytes another writer appends in between are lost
  by the write-back. The documented no-lock trade: concurrent updaters are serialized at step level.

Added 2026-10-01 by the backlog triage (two Sonnet agents checked every open entry against main 42617650):

- GitHub Copilot Autofind findings on PRs: a repository setting with no file in the tree, and no run since PR #361 (2026-09-27).
- The main repo's auto-gc was paused: cleared (1,989 loose objects, below gc.auto; the gc.log is past gc.logExpiry).
- Storage the app never takes back: pruning empty per-user storage dirs is tidiness only and races creators (sweep-3 plan, not planned); the rest is done or unreachable.
- Codex reads only the first 32 KiB of AGENTS.md: not planned (largest here 16.4 KB; Haive injects the rules itself, #235).
- The untrusted fence is hand-rolled at five sites: decided, merging them flattens deliberate per-site wording.
- An upgrade removing template A and writing B at one path rolls back to A's row: inert, template-manifest.test.ts:167 forbids two items on one path.
- Each long line of a before/after pair scrolls on its own: decided (w-max pushes "after" off-screen).
- Dev stack sync order between a pull and the libs build: a workflow note with its own recipe; #350 made the watchers poll.
- The web unit suite exited 1 once with every test passing: no reproduction (if seen again, read vitest's Errors line: Node 26 FileHandle GC).
- GitHub's "Code scanning AI findings" workflow: external, no run since 2026-09-27.
- Every local commit warned "too many unreachable loose objects": the worktree it named is gone and loose objects are below gc.auto.
- A worker-suite vitest fork outlived its worktree by 36 h: seen once, not reproduced (re-checked 2026-10-01, no stray process).
- Task DESCRIPTION provenance at `03`/`04`: do NOT fence the description, with or without a
  provenance signal; the description IS the assignment. Only a plan built before #217 remains
  exposed, and its remedy acts on node BODIES.
- `01-advisory-research` has no guard: its output is read by a person at a gate; no variant fits.
- The dispatch-time capability snapshot vs the live uploads dir (declined on #225 and #239).
- Coverage repairs recorded before #241 keep their name-only meaning (transitional).
- No attachments notice for the merge-resolver, `retry_ai`, the DAG replanner and merge-fix agent.
- An attachment name that names an agent path turns isolation off for that call (user's call,
  2026-09-24, dot-bug-only fix #244).
- H5's gate event logged twice after a crash: cosmetic REGRESSION, dropped (needs a migration).
- A superseded run's completion still writes its exit/output: deliberate (real spend); the reader
  audit found only deliberate superseded-but-parsed reads.
- upgrade-status blind to a rowless rendering beside a sibling row: DEFERRED (needs per-repo
  (template, path) pairs; the plan still offers the path).
- Line-scanned fences cannot see a fence indented 4+ spaces in a nested list: scanner trade-off.
- Task-list bodies saved loose by the old editor bug stay loose (#220 fixed the bug).
- Before/after pair keeps its 36rem floor at 768px beside the sidebar: deliberate (#320 measured a
  viewport breakpoint leaving 138px halves).

## Closed 2026-10-16/17 (session 3813bbf6, finished in flight before the park; Codex off for the last rounds)

- #285 uploads: merged #798 (61481e19b) — complete-claim lease, `reaping` for cancels and the reaper, bundle
  replace's row moved with its claim, a pre-claim drain read; boot reaper pass live-checked. #305 items 4, 7 closed by it.
- #274 B3.1c put-back: merged #806 (f5b849a50) — 99's put-back fails the step and its Retry pushes; strict
  hand-back and a HEAD-read failure fail the pass. #116 (B3.1) complete.
- #282 same-branch merge fence (D17): merged #805 (7ba88a943). Its open-merge-window P1 is #286 item 4.
- #269 RTK toggle travels: merged #807 (610c2e6ba).
- #142/#143 RAG P1 chunker: merged #815 (83af0e675) — short spans join a neighbour (uncovered text 0.35% ->
  0.0035%); eval measured on the pre-fix chunker, not re-run. #311 item 4 closed by it.

## Closed 2026-10-10 (session c7414b8d; ledger in that session's scratchpad fnf-c741/)

- Bundle `plan-provider`, PR #502 (merge 79bcb4d0): #8 a disabled CLI picked for a plan task is
  refused (409, `loadUsableProvider`); #6 `resolveProvider` falls back to an ENABLED provider from
  this repo's latest task, else the user's latest anywhere, else the oldest; plan chat and merge
  pickers preselect from `GET /plan/build/clis`. Browser-checked: fresh repo preselects the user's
  latest CLI, plan chat preselects the repo's. Merge picker not browser-reached (needs a conflict).
- Bundle `clarify-followups`, PR #503 (merge 5fb65cb8): #7 questioner re-asks an open answer under
  its own id; #9 plan-canvas smoke checks one row per (task, round), root delete nulls `root_id`,
  task delete cascades rounds (121 checks; negative control with the index dropped fails).

## Closed 2026-10-09 (bundle `tests`, session 3813bbf6; ledger .claude/tmp/fnf-tests/ledger.md)

- #465, merge eb000497, main CI green (the e2e job logged the warm-up: 36 pages, 38 s cold, 3 s warm;
  171+6+6 passed). Codex: round 1 two valid P2s (warm-up list missed five pages; C collation vs the
  deployed en_US.utf8), round 2 👍. Greptile: no check run within 15 min on either push.
- Tasks #191 #192 #193 #231 (3813bbf6), f3f0c544's #13 with its folded fake-db `orderBy` and dag-executor
  stub-leak items (prompt-agent-paths count now exact at 184), plus in-flight additions: the shared
  text-files timeout, the credential-scan heap test's input (16 x 49,152 lines, uncapped still OOMs),
  the api unhandled-rejection seam's logger subpath, fake-db text/NULL/boolean ordering pinned to a
  measured Postgres 18 en_US.utf8 order, the global teardown failing loudly, and 12 more specs onto the
  users fixture. a644756a's #19 was already fixed by 51190eee. The sync-bounds hook needed no change.
- Decisions not to re-litigate: per-test timeout over a shared package-wide one (the only other slow
  shared test sets its own); the warm-up derives every page from the app dir; e2e specs that leave only a
  user or repo row (no worker-driven work) stay on the backstop; 71 files importing logger from the
  shared barrel stay (same instance).

## Closed 2026-10-08/09 (FNF round 5, session 28d6c55c; ledger .claude/tmp/fnf4/ledger.md)

- #22 dispatch error aborting a fan-out — #450. #27 queued fan-out agents run on after a failed step — #455 (9 Codex
  rounds: release after the terminal write, runs-before-agents order with retry, ownMiningRow in-flight guard).
- #26 legacy person-source text unfenced (digest, 07, 07b, gates, 08d2 provenance) — #451.
- #7 plan patch versions (D9) and #34 delete label — #452 (applier checks each op against the patch-start version;
  coalesce removed; one read snapshot for 11f/01f).
- #35 advisor fix coder re-sent as a level coder — #459 (re-sent as a fix coder with retry_context; keeps the raised
  time budget, pass-wide; a coder failing with no result keeps the issue's filesModified; spawnReviewAgent's agent row +
  claim run in one owned-step transaction). #36 unconsumed fix-coder agent row — dropped, harmless (no reader picks it up).
- #28 ollama provider without a model — #453. #31 worker testTimeout 20 s — #458. DAG docs — #457.
- #30/#32/#33 truncation bundle — #456 (grok/codex/amp detection; one smaller retry on step, fan-out, every DAG role,
  merge fixers; capability retry keyed on per-class remedy VALUES in `cli_invocations.limits_snapshot`, migration 0177;
  row-locked monotonic limits learn).

## Closed 2026-10-01 (backlog triage: already fixed on main 42617650)

- The environment mirror carried 01's prompt-only fields into a committed file: #381 (F17, 21c9d88c; 0170 applied, 0 of 10 mirrors keep a `__` key).
- A Retry of a failed upgrade or rollback runs beside another live one: #339 (A3.1: index tasks_one_live_upgrade_per_repo_idx, 0168).
- A fixer working at a repository root can run git: a 2026-09-27 fix (610b7cbd: a root .git is mounted read-only).
- A discarded merge attempt kept what the fixer left outside the merge: #338 (A2.2: captureFixBaseline + relocateFixerChanges on all three callers).
- The global KB page's Retry was dead on an entry whose `kb_author` task was cancelled: #355 + #357 (A5.3/A5.3b: Retry only while the source task is failed).
- The tasks list does not fit a phone: #352 (A5.1: @container row, phone.spec guards it).
- `InteractiveShell`'s "task has ended" view cannot render: #353 (A5.2: the Terminal tab stays open and says why).
- Cosmetic/inert code leftovers: #351 + #339 (comment folded, rollback reads latestUpgradeToRollBack, 0 stale queue keys).
- E2e plan fixtures read "Snapshot updating…" forever: #356 (A5.4: snapshotState answered; the e2e fixture seeds plan_mirror_state).
- postgres.js 3.4.9 killed the process when a transaction's connection dropped: #376 (postgres.js patch, smoke:pg-drop in smoke:ci).
- A sibling run too wide for one agent's reply failed the sequencing step: #375 (F16: tooWideToSequence, the step note names the run).

## Closed 2026-10-01 (sweep 3 tail, [[found-not-fixed-sweep-3-series]])

- Task #212, a Retry of 01 forked the task off its own worktree — #391 (3afc040): detect proposes
  `tasks.worktree_branch` while it exists locally (the form says it re-enters the task's worktree), apply
  records the columns as soon as the worktree exists (before the steps that can fail it), and both branch
  listings use `%(refname:lstrip=2)` (Codex round 1 P2, MEASURED: `refname:short` prints a branch a
  same-named tag shadows as `heads/<name>`; 12's issue-branch sweep had the same flaw). Round 2 👍;
  main CI green. Follow-ups: #222, #223.
- Task #170 (PR A of #169/#170) — #390 (80866cc): `resolveDdevWorkspace` reads `tasks.worktree_path` before
  01's output (a Retry nulls the output while the worktree and everything mounting it stay; the root answered
  then re-targeted the DDEV runner with `rm -f -v` and rooted the IDE at the main checkout); a `skipped` 01
  still answers the root; an out-of-root path clamps the workspace as well as the subpath. Codex round 1 👍;
  main CI green. #169 (PR B: 06a and 08 exec only through an ensured handle) still open.
- Task #211, task-job-epoch timed out on a CI runner — #389 (1fcc29e): the failed-task teardown ran 17 real
  `docker volume inspect` calls against the host daemon per test (a 0.3 s shim delay reproduced the 5000 ms
  timeout). A per-file census of all 420 worker test files found two that reach docker (task-job-epoch 208,
  incl. a `volume rm --force`; task-result-epoch 17); both now stub the teardown. Codex round 1 👍; main CI green.
- Tasks #208, #209 — #387 (22d0ea3): the three chunked-upload routes write through the handle they opened
  at the session offset (`writeBodyToHeld` gained a start), capped at the declared length, and roll back with
  `fh.truncate` on that handle (`truncateUploadFile` removed); the notification sound writes replace-atomic
  (temp + rename), so a failed re-upload keeps the previous sound and its row. Codex round 1 👍; main CI
  green. Follow-ups: #217 (concurrent same-range PUTs), #220 (replace-atomic temps never swept).
- Task #164, 7 Dependabot alerts on transitive lockfile pins — #386 (747679a): override floors
  `@grpc/grpc-js` ^1.14.5, `brace-expansion` ^5.0.12, `dompurify` ^3.4.16, new `markdown-it` ^14.3.1, lockfile-only
  regen (only those 4 moved). Codex round 1 👍; main CI green; dev stack rebuilt (all three containers on the
  new versions, worker ready); live browser check: mermaid renders (dompurify) and the tiptap editor round-trips
  a task list, table and code fence (markdown-it); Dependabot reports all 7 `fixed`, 0 open.
- Tasks #201, #203, #204, #206, #207 — #385 (d9b9fd9a): a failed write into a file the call CREATED
  is taken back judged on the created INODE (`fileIdentity` via bigint stat, `removeFileIfIdentityNoFollow`
  parks the name and lstat-compares dev/ino, reads nothing), used by createExclusive, fillCreated,
  `copyFileNoFollow`, the repo upload and the attachment claim/stream/finalize, each removing BEFORE
  its descriptor closes (`writeBodyToHeld`, api lib: a FileHandle write stream closes the fd at finish,
  measured on node 26); the knowledge editor fstats and answers 413 over the cap with a bounded read;
  `ParkedFileError` carries the judge's error; the park leaf is capped at 100 bytes on a UTF-8
  boundary. Also retires the decided 0o200 stub trade (the inode judge reads nothing). Codex rounds
  1-2 one valid each, round 3 clean; main CI green. Follow-ups: #202, #208, #209, #211.
- Task #179, an in-place rewrite that failed part-way left the file truncated or half-written — #383
  (756033d): `replaceHeldBytes` puts the bytes it read back on the same inode and rethrows (both
  errors when the put-back fails too), used by `rewriteFileIfNoFollow`, `updateFileNoFollow`,
  overwrite-in-place and the api knowledge editor (which also stopped ignoring a short write).
  Codex round 1 clean; main CI green. Follow-ups: #201, #202, #203, #204.
- Task #168, a typed branch name reached `git fetch` unfenced (00a's `base`, 01's legacy base) — #382
  (d3dbb5a, public PR by the user's choice): `isBranchName` mirrors `git check-ref-format --branch`,
  and every named-branch fetch passes `--end-of-options` + `refs/heads/<name>` (00a, merge-resolver,
  13, plan merge, refresh). Codex round 1 clean; main CI green.
- D8, learned guidance states what its cap dropped — #368.
- The mermaid test's real import gets its own timeout — #369.
- F15, `omitLinks` also drops the derived `blocked by` — #370.
- Literal NUL bytes in three source files, plus a guard over every tracked text file — #371.
- F14 (RAG plan), the dense pool comment names `hnsw.ef_search` — #372 (comment only, see Open).
- D7, a step's CLI picked during a task belongs to that task ("Also for my later tasks" opt-in,
  migration 0169, and 09_6's "CLI for the fix" writes the task choice) — #373. Codex rounds 1-3
  valid, round 4 past its allowance, landed on CI.
- F14 (AIDE² plan), an agent's plan patch carries every changed or deleted node's version, and an
  agent deletes leaf by leaf — #374. Codex round 1 one valid P1, round 2 past its allowance, landed
  on CI.

## Closed 2026-09-26/27 (sweep 3, [[found-not-fixed-sweep-3-series]])

- **Git output past execFile's 1 MiB buffer killed git; a bundle resync stalled on unread
  output**: closed by #360 (A2.3, merged 5a116d43, live-verified: both controls pass inside the
  worker container on git 2.54.0 / Node 26.10.0).
- **A CLI picked on the New Task form while the remembered choice loaded was overwritten**: closed
  by #361 (A5.6, merged ba3fe766, live-verified: the control spec 3/3 against haive-web on main,
  2/3 failing on the old page; row counts back to baseline).
- **The global KB schema ensure raced itself** (500 `tuple concurrently updated` on the first
  calls): closed by #359 (A5.7, merged def640f0, live-verified: 8 concurrent first calls after an
  api+worker restart all 200, no errors). Review also fixed: pgvector fallback only on SQLSTATE
  0A000/58P01/42501 (both ensures), and the memo is per store.
- **A timed-out e2e spec left its fixture user and a `running` task for the dev worker to drive**,
  and `removeUser` deleted tasks by SQL before the api repo delete: closed by #358 (A5.5, merged
  578ccd64, live-verified on main with no simulator: harness + actions-api + create + phone 25/25,
  the real worker's `cancel-task` jobs completed, all eight row counts back to baseline). Failed
  tasks are cancelled too, and a user is kept while a cancel is unfinished or refused. The
  repo-cleanup job now carries each env template's image tag, so a template row gone with its user
  no longer strands the image (was the "does not wait for `cleanup-repo-resources`" entry).
- **Isolated-provider (`p_<id>`) and deleted-user auth volumes were never reaped**: closed by #349
  (A4.3, live-verified: the first boot removed exactly the 12 approved orphans, 63 -> 51), a login
  session still holding one included.
- **`ensureTaskScratchWorkspace` never created its anchor** (a user's first repo-less task failed
  ENOENT): closed by #347 (A4.1, live-verified: the scratch dir was created on the real volume).
- **A failed rebuild to a new tag left the previous image with no row naming it**: closed by #348
  (A4.2, live-verified with scratch images on real Postgres and docker): a row names a tag only
  once its image is built, and every write a build makes waits on the provider's config.
- **RTK leftovers: the block strip was never rolled back, and the settings paths were spelled out
  in 07 and the reset**: closed by #346 (A3.7) and #342 (A3.3).

- **A 02 retried after a failure past its transaction loses what the first attempt created**: closed by #345 (A3.6): 02 records what stood before each write, and a retry reuses those records.

- **A double Roll back click rolls one upgrade back twice, and an upgrade parked on its form can apply over a rollback.**: closed by #339 (A3.1): one live upgrade or rollback per repository, and a rollback names the upgrade it undoes.

- **Upgrade write-branch reads are lenient**: closed by #344 (A3.5): a path the upgrade did not read is `unread`, never absent.

- **A rollback restores a target's bytes over whatever the path holds now**: closed by #343 (A3.4): a restore replaces only what the upgrade left there.

- **The onboarding upgrade reads repository files with no size cap**: closed by #344 (A3.5): one 1 MiB cap on every upgrade read.

- **The upgrade banner cannot see a body change to a template REFERENCE_CONTEXT renders empty**: closed by #341 (A3.2): gated templates carry their own reference context.

- **The plan merge read its conflicted names quoted** (A2.1 missed `plan/merge.ts`
  `conflictedPaths`): closed by #337 (A2.1b, 881ed64a, live-verified on the worker's git 2.54).
  The plan-merge prompt now lists only names that fit on one line and counts the rest.

- **Merge fixer: quoted unmerged names committed conflict markers, a refused merge read as a
  conflict, a refused `merge --abort` left a half merge for the next fixer, and the `/host-fs`
  comment claimed ro**: closed by #336 (A2.1, 9152b594, live-verified: the helper tests and both
  merge controls pass on the worker's git 2.54, and the dev worker runs the merged source).

- **Under a pause a retried walk ran a `failed` row, and an advance could run one**: closed by
  #330/#331 above (the Retry resets the row; an advance finishes a failed row as the re-driver does).
- **A zombie ADVANCE held the stalled re-driver off a task for its 30-min lock**: closed by #332
  (A1.3, 6ed0c61f, live-verified with a real worker restart: requeued at boot, ran within ~10 s).
- **A POST /tasks whose START was lost stayed `created`**: closed by #333 (A1.4, 230e80e9,
  live-verified under the global pause: 201 `queued`, START claimed, first step parked, 0 runs).
- **Recovery hints could land on a row a Retry had reset** (`recordFailedStepHint`, the fan-out
  timeout hint, the login hint): closed by #334 (A1.5, 318d98db, live-verified: the outage hint
  landed on its failed row; 0 hints on pending/skipped rows install-wide).
- **`autoResumeFailedStep` locked task, runs, steps**: closed by #335 (A1.6, a8714bce,
  live-verified in the worker: a failed task resumed with every write; a running one untouched).
- **Another install's committed MCP server list reached every CLI with no opt-in**: closed by #326
  (B0.1, merged ce255ca5, live-verified): held as `importedMcpSettingsJson` until accepted on the
  tooling page; acceptance is an install-keyed HMAC; boot holds rows an older import stored.
- **Refresh could destroy unpushed commits and `.haive/worktrees`**: closed by #327 (B0.2,
  69369fee, live-verified): fetch + `merge --ff-only`, refusals named, an unusable tree renamed.
- **The mirror import followed links and ignored `rtk_enabled`**: closed by #328 (B0.3, a52ece09,
  live-verified). Rows imported before it: a B1.5 obligation (asked, not migrated).
- **04's MCP opt-in never reached the runtime**: closed by #329 (B0.1b, 902d6af0, live-verified);
  apply now refuses a server file changed after the form.
- **Task-level Retry never reset a `failed` row, replayed stored loop_back verdicts from START, and
  its epoch bump had no status check**: closed by #330 (A1.1, 634accc6, live-verified under the
  global pause: row pending and parked, no re-fail after 6 min) and #331 (A1.2, 56385908,
  live-verified: an advance onto a failed row fails the task, row untouched, 0 runs).

## Closed 2026-09-25/26 (sweep 2, [[found-not-fixed-sweep-2-series]])

- Nothing enforced the lockfile: #301.
- A redelivered START ran with none of the advance guards; a Retry under a pause dropped START's
  advance: #302.
- A run a stale pass inserted after a Retry's reset escaped it: #303.
- Nothing re-drove a lost START (`queued`) or a `waiting_cli` step whose cli-exec job was lost: #304.
- The allowance watch was armed by task id alone, and the task Retry did not clear it: #305.
- A Stop was not one transaction: #306.
- An advance queued before a restart could re-run a row boot requeued: #307.
- Skip, Retry and the fan-out Resume revived a cancelled or completed task: #308 (refuse, user's call).
- A merge fixer that failed on its own had its half-resolved merge committed: #309.
- Upgrade/rollback delete was check-then-act, and 02 committed an empty AGENTS.md: #310; the reset
  twin: #316.
- The merge fix prompt never asked for the JSON the resolver parses: #311.
- A bundle zip whose only top-level entry is `agents/` parsed to 0 items: #312.
- A non-forced build marked a tag ready mid-rebuild: #313.
- `DELETE /repos/:id` took no root claim; the e2e create spec deleted by SQL: #314.
- Storage-root prefix checks missed another spelling of the root: #315.
- A rollback could not restore absence: #317.
- Deleting a provider never removed its image (and a delete mid-build): #318.
- H6's test gaps (four `assertOwnsStep` sites, the level coder's free re-dispatch): #319.
- The repos page, the plan page's actions and a before/after pair did not fit a phone: #320.
- The task page's two usage chips polled separately: #321.
- An edited `.claude/settings.json` kept its RTK hook with RTK off: #322 (offered, unticked).
- Switching RTK back on had no banner: #323.
- A blank scaffold's seeded RTK files survived RTK off; a rollback never put back a removal: #324.
- A rollback that put back a removal said "nothing to revert": #325 (REGRESSION of mine from #324,
  found by its live check; merged 2026-09-26 as `2a610d56`, live-verified: a removal-only
  upgrade's rollback now reports `warnings: []`, `revertedCount: 1`).

## Closed 2026-09-24/25 (found-not-fixed sweep 1, [[found-not-fixed-sweep-series]])

- CI concurrency, e2e read-before-landed specs, sandbox-build timeouts: #267, #268, #285, #269, #280.
- Upgrade backfill claiming edits, unproven deletes, Keep = Skip, Overwrite rollback: #270-#272.
- Legacy `RTK.md` after a reset, RTK off never reaching the upgrade: #273, #276.
- Completion/mining writes apart, late completions, recap over a reset row: #277. Abandoned
  superseded runs with no end: #274. DAG ledger parse-failure text: #275.
- Coverage `agent_id` overflow: #278. Staging dir sweep: #279. `git status` writing the index:
  #282. `@` import root: #283. GET/WebSocket booting a runtime from any page: #284.
- Three-backtick fence regexes: #286, #288. Plan node image lost on edit: #289.
- Task page phone fit: #290, #294. Archive test timeouts and queue smokes on the dev Redis: #291.
- `ssh2`/`cpu-features` compiling on every install: #295. Dependabot grouping: #299, #300.
- A wave consuming every mining row: #296. Loop-resume `leftActive`: #287.

## Closed earlier

- Recovery series (2026-09-24/25): boot recovery of mining steps #248/#251/#259/#263; recovered
  agent setup #247; `extractArchive` anchor #264; DAG ledger/terseness/CI retry/dot #243-#246;
  `mergeCommitted` read an aborted merge as committed #297.
- Follow-ups (2026-09-24): remote images #249, outbound fetches #250, force-added rules files #252,
  RTK block on reset #254, secrets typing #255, ledger comment #253, cli-rules region row #256,
  worktree-anchored reads #258, missing `@AGENTS.md` banner #260, INSIGHTS at gate 2 #261, Escape
  handler #266, phone sidebar #265, three flakes #262.
- Agent rules (2026-09-24): rules injection #235 (a real run's stamp still owed), upgrade stubs
  #229 (end-to-end check still owed), default rules rewrite #232.
- Attachments (2026-09-23/24): #221-#225, #233, #237-#241.
- Earlier: guards #215, ledger fence #216, plan writers #217, AGENTS.md architecture #218,
  Dependabot batch #219, tight task lists #220.

See [[haive-pr-workflow]] and [[own-post-step-verification]].

- **[session 28d6c55c, single, PRE-EXISTING]** [NEW 2026-10-08, verified in every full worker run of PRs #436/#437] CLOSED 2026-10-08 by PR #444.
  `onboarding/_credential-scan.test.ts` "scans oversized inventories under a 64 MiB heap" (100,001 entries, child
  `node --max-old-space-size=64`) fails under full-suite load on the dev host (~75-92 s) and passes alone; CI green.
  Fix: raise its heap limit or its timeout, or run it serially.
- **[session 28d6c55c, single, PRE-EXISTING]** [NEW 2026-10-08, `queues/task-queue.ts` oscillation park] CLOSED 2026-10-08 by PR #440. the
  oscillation gate shows Haive's guidance for the current verdict only; side B's is not returned by
  `detectFixLoopOscillation`.
- **[task #22, session 28d6c55c, design single]** [NEW 2026-10-08, cited `dispatcher.ts:438-444`, `step-runner.ts:1956`]
  a dispatch error while building one provider's dispatch aborts the provider loop instead of trying the
  next, and one fan-out agent's dispatch error fails the unsent rest. PRE-EXISTING; needs a fallback decision.
- **[task #23, session 28d6c55c, design single]** [NEW 2026-10-08, `dag-executor.ts:1266-1274`, dev DB 36/36]
  the DAG stuckCount never resets, so STUCK_LIMIT 3 always ends the loop before MAX_REVIEW_ITERS 5. PRE-EXISTING.
- **[task #24, session 28d6c55c, single]** [NEW 2026-10-08] 08a's headless probe branch and the interactive
  copy (08a, 08a-browser-setup header) are unreachable too, follow-up to #440. PRE-EXISTING dead code.
- **[task #25, session 28d6c55c, single]** [NEW 2026-10-08, `step-runner.ts:752`, builder claim UNVERIFIED]
  a truncation retry at loop iteration 0 sends the iteration builder's prompt (08b writer gets the fix-pass
  prompt). PRE-EXISTING; verify first.
- **[task #26, session 28d6c55c, single]** [NEW 2026-10-08, Codex on #439] gate-2 events before 2026-09-22 and
  08d2 events before 2026-10-03 carry unfenced machine text; the digest keeps a person-source diagnosis as
  written. No structural marker; ages out. PRE-EXISTING.
- **[task #7, session 28d6c55c]** still OPEN (D9 design single; not picked in the 2026-10-08 round).

- **[session f3f0c544, 2026-10-10]** CLOSED: #53 digest/updated_at tiebreak at all five limited global-KB reads by PR #491 (merge 690b88cc); #55 cutMiddle `framed` param removed by PR #493 (merge d83365af). OPEN from the #37 builder, PRE-EXISTING, low: `99-run-app-ready` navigates to the string `null` when appUrl is null (best-effort, kept byte-identical). In flight: #50 gate2-slices, #51 ddev-yaml (built + judged, suites running).

- **[session f3f0c544, 2026-10-10/11]** CLOSED: #50 gate2-slices (#497, 3 rounds: 08 stores both ends; env classified on raw output); #36 host git default timeout 10/30 min, code 124 (#501); #45 denied-rename (#499, 5 rounds: any denied path under any status, or a capped list, withholds every other file's content); #43 worker scripts type-checked (#495; three scripts were broken at runtime); #39 change-read (#505; item 2 "union fixer passes" REVERTED — each fixer pass re-collects the whole change; null gate fingerprint now reads unread); #17 CREATE DATABASE race (#506: measured 23505 on pg_database_datname_index via drizzle .cause; isDuplicateDatabase in @haive/database pg-errors); #57 pg-error-shape (#507: 55006 DROP retry and 40P01 release retry were dead under drizzle; hasPgCode exported). #54 DROPPED (no Date.now floor over a real wait remains). #48 reclassified DESIGN (dispatch can wrap a prompt, so the notice is not always last; needs a structural column). IN FLIGHT: #51 ddev-yaml PR #498 (10 Codex rounds of YAML edge cases: aliases, merge keys incl. tags, merge-chain stack/rescan, first document only, nulls).
- **Remaining open after 2026-10-11 (all PRE-EXISTING):** design singles #9 (lint list of runners), #34, #35, #38 (unsandboxed host test run, high), #41, #42 (needs retrieval eval), #47, #48, #56; #18 gkb-web (browser checks); #8 moved to [[house-rules-pr8-resume]].

- **[session f3f0c544, 2026-10-11]** CLOSED: #51 ddev-yaml (#498, 10 Codex rounds; r10 !!binary key DECLINED -> #58); #58 07c refuses an unfaithfully read .ddev/config.yaml (#512, plus !!merge symbol fix); #18 gkb-web (#509, browser-verified with fetch interception); #57 pg-error-shape (#507); #17 create race (#506); #38 host exec (USER DECIDED 2026-10-11: sandbox else refuse; 01a host path removed; checks count in the agent pool) -> #514 (pm via ddev exec + guard marker + ddevSlot; 01a removed) and #515 (Redis agent lease via Lua, runStepCommandInSandbox with no auth/provider env, app reach, npm cache; 08/08b host branches) — LIVE-CHECKED post-merge: uid 1000, no socket/key/DATABASE_URL, lease 1->0.
- **New open (2026-10-11):** #59 01b-sandbox (no task label, provider env into plugin code); #60 agent-admission cross-lane race (DESIGN, bounded by min(5,cap)); #61 app-reach-tests (localhost-configured suites in sandbox; PRE-EXISTING). Still open design: #9, #34, #35, #41, #42, #47, #48, #56; #8 moved to [[house-rules-pr8-resume]].
- **[session f3f0c544, 2026-10-11, later]** CLOSED: #47 re-embed bound (#520); #48 truncation retry column 0184 (#522); #35 ddev exec deadline (#519, 9 Codex rounds: ddev quotes a non-raw word with spaces → `--raw -- timeout … bash -c '<quoteArgs line>'` built in TS; only a plain word list is wrapped, any shell operator/comment/expansion/glob runs unwrapped as before; web container only; head read by a word scanner + pflag rules); #60 agent admission (#527: one Lua counter for INVOKE `invoke:<job>:<token>` + `lease:<uuid>`, reserved as the processor's FIRST call for priority order, 1 s retry window for slots a gate-refused holder frees). Dev stack synced to 511c776e (0184 applied).
- **New open (2026-10-11, later):** #62 cap-source skew (gate's 30 s cached cap vs lease's fresh read; DESIGN). CLOSED #41 gkb-connections (#535 059e3419; dev stack rebuilt) — was DECIDED: extend postgres@3.4.9 patch to bound consecutive startup closes — fetch_types:false alone does NOT stop accept/startup hang-up storms; plus SET LOCAL lock/statement timeout on a bounded call's ensure). Still open: #9, #34, #42, #56, #59 env half, #61; #8 moved to [[house-rules-pr8-resume]].
- **[session f3f0c544, 2026-10-11, late]** CLOSED: #41 gkb-connections (#535: postgres.js patch hunk bounds startup closes hosts×3; bounded global-KB ensure SET LOCAL lock/statement timeout; dev stack `pnpm docker rebuild`). #59 provider env secrets (#539, 7 Codex rounds: shared splitSecretLikeEnv on API create/update/clone; Z.AI secret alias via spec.secretTokenAlias; boot COPY convergent + committed DROP destructive (copy-then-drop, failures propagate); destructive CLI now initializes secretsService — this ALSO fixed dropHeadingOnlyGlobalKbChunks, which never worked from the CLI; updater commit-phase failure now forward-only per decideResume). Live-verified on dev stack.
- **Open after this (2026-10-11):** #59 remainder → new task: 01b egress domains + 3 duplicate upsert-secret helpers. Still open: #9, #34, #42, #56, #61, #62; #8 moved to [[house-rules-pr8-resume]].
- **[2026-10-11] #8 house-rules PR8 MOVED OUT of the open list:** it waits on data, not on a fix. Its resume condition, query, prerequisite (an enforced `files` rule) and constraints live in [[house-rules-pr8-resume]], triggered from the `07` row of [[onboarding-run-checkpoints]]. Do not list #8 as open again; the checkpoint owns it.
- **[session f3f0c544, 2026-10-12] CLOSED — task list EMPTY.** #72 declared verify commands (#580 col 0187, #584 worker: one shell string, 126/127 NOT RUN only when a `command -v`/`-x` probe of the first word fails, declared test classified by Playwright error IDs, fenced form text; #583 Tooling UI — browser-checked live); #73 per-repo RAG sync lock (#579: Redis owner token, 2 h wait, api 409/503, `fenceRagStore` on every statement — LIVE 409 verified); #74 secrets TTL (#578); #75+#77 cleanup under the sync lock (#586, 10 Codex rounds: deferral = UnrecoverableError subclass, attempt counted before enqueue, refund consumes the claim stamp, every sweep write CAS on stamp, DROP checks lock per attempt, tx/tagged/commit fenced, per-path claim xact lock; fake db compares Dates by value); #76 narrowed to agent-written step guidance → InlineMarkdown (#587; static JSX help is UI copy, not a body). Decision: `haive_rag_rs_final` is KEPT as the RAG eval corpus. Residual by design (documented in rag-embedding-failures.md): one statement in flight when the lock is lost still lands — closing it needs a fencing token the store checks.
