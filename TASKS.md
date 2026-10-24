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

## Questions waiting on the user

- T402 — context backfill: a numbered migration or a deploy script; stream_log expires ~2026-11-30.
- T338 — the uncalled task-level cli-provider route: delete it (recommended) or fence it.
- T346 — should the custom-tool start hint block the start or only warn.
- T347 — forge egress: are private self-hosted forges on internal addresses allowed.
- T386, T387, T389, T392, T393, T394, T399, T403, T406, T408, T409 — design decisions (see each task).
- T317 — should a stamped RTK choice also win on a first import? Recommended: yes.
- T199 — which favicon/icon to use.
- T270, T310, T318, T326 — design decisions (see each task).
- T319 — go-ahead on the scope of set-aside batching (rewrites four helpers).
- T323 item 4 — retention rule for `complete`/`consumed` upload rows.

---

# Open tasks

### T323 · FNF[uploads-3] · finished upload rows are never deleted; the reaper's removal is not identity-checked (+1)

status: parked · reason: user's retention rule for item 4 · last: 2026-10-24T19:31Z · items 1-3 shipped in PR #892 (42ee32d7c)
All PRE-EXISTING.

4. PARKED (user): `complete` rows in repo_uploads/custom_bundle_uploads and `consumed` db_uploads rows are never deleted — needs a retention rule.
5. Latent, minor: the reaper removes a path without checking it is still the file it lstat'ed (upload-reaper.ts removeFile); fs-safe's lstatNoFollow returns numeric Stats, so dev/ino cannot be compared losslessly. Cannot bite today (upload names are fresh UUIDs). Fix: a bigint lstat identity export in fs-safe, compared before the unlink.

### T288 · FNF[sync-reader] · project-state sync reader defects (+6)

status: open (a Codex attempt was discarded after the 2026-10-24 WSL crash; nothing kept. Previous brief, reusable: .claude/tmp/fnf-run/p288/drive.md on ACTIVIT21 — it scoped items 2,3,5,6,7 and deferred 1/4 for the fnf/278 overlap)
All PRE-EXISTING.

1. DEFERRED (overlaps fnf/278): gitOperationInProgress (repo/git-operation.ts) reads an out-of-tree git dir as "merge open"; every caller holds forever for such repos.
2. persistDetection's sync (clone.ts ~299) and resolve.ts ~140 re-sync import without the under-lock re-read compare (#751). [in brief as B]
3. An empty `.haive-data/state/` reads as a broken record and stalls the sweep (sync.ts ~185). [A]
4. DEFERRED (overlaps fnf/278): onboarding-upgrades.md names `rebaseProjectStateOnCheckout`, which nothing calls.
5. Invalid settings/rtk-enabled.json warns on every sync (sync.ts ~790) and never repairs. [C]
6. Import markers record a synthesized rtkEnabled:false (import-marker.ts ~44). [D, may be harmless]
7. A sync outside persistDetection that adopts a teammate's rtk-enabled.json leaves the RTK question pending until boot; call raiseRtkQuestion after it. [E]

### T412 · FNF[git-noexit-low-3] · gitClone and a few scripts still spawn git unbounded (+3)

status: open
From the #328 driver (2026-10-24). All PRE-EXISTING. (Session fnf-run mirrors it as its task #329.)

1. Unbounded git spawns remain at repo/clone.ts:94,116,687 (gitClone: runs before its dir exists; carries the credential-helper argv, env and secret scrub — needs its own review), steps/onboarding/_credential-scan.ts:173, scripts/advance-bundle-items.ts:25, scripts/reset-bundle-to-commit.ts:43.
2. Low: 99-run-app-ready.ts:315 drops a ticked push silently when the commit box is unticked.
3. Display: 11-phase-8-learning.ts:549,1170 says "No commit recorded"/"(none)" when gate 3's sha read gave no answer after a landed commit.
4. (T388 review) The operator scripts run `fetch --all` with no origin validation (scripts/advance-bundle-items.ts ~:66, reset-bundle-to-commit.ts ~:88); route them through the T388 origin read when they are bounded. Minor.

### T414 · FNF[deps-alerts-2] · 9 open Dependabot alerts on main (3 critical: next, dompurify)

status: taken · owner: codex-run@DESKTOP-IUBG9OP · since: 2026-10-24T17:47Z · last: 2026-10-24T20:52Z (PR #891 merged b1a791b52, main CI green on 4f91759b1; waiting for Dependabot to re-scan: alerts #108-#116 still open although the dependency graph lists only the patched versions)
Seen 2026-10-24 by fnf-run on a push (alerts #108-#116, opened 2026-10-23). (Session fnf-run mirrors it as task #331.)

1. next → 16.4.1 (2 critical, 1 high): Dependabot PR #857 open since before the alerts; needs CI + review, then `pnpm docker rebuild`.
2. dompurify → 3.4.17 (1 critical, 1 high, 1 low) and markdown-it → 14.3.3 (1 high, 1 low): check whether group PRs #838/#839 carry them; else a lockfile-only bump (memory: adding a dependency).
3. zod → 4.6.6 (1 high): Dependabot PR #859.
   Route: one lockfile PR, a web browser check of markdown rendering (MarkdownView) since dompurify + markdown-it sit under it.

### T415 · FNF[upload-retry] · Retry on an errored upload repository can never succeed

status: open
From the T323 review (2026-10-24). PRE-EXISTING, consequential. The repos page Retry (web repos/page.tsx ~:180-187, shown for any `error` repo) posts to refresh-tree, which answers 409 "Nothing to refresh from: this repository has no remote." for an upload repository without a remote (api repos.ts ~:3165-3167); nothing else re-queues an extract. The copy promises it: repos.ts ~:219-221 "Use Retry to try again", data-migrations.ts ~:361-362 "Use Retry to start again", and clone.ts ~:675-677 keeps the archive "for a retry" (the reaper removes an `error` repository's archive after 24 h).
Recommended: Retry on an `error` upload repository re-queues EXTRACT while its archive is still on disk; otherwise the copy says to delete and upload again (no Retry).

### T416 · FNF[web-runtime-tests] · proxy(), DOMPurify and markdown-it run only in a browser; CI never boots the production web image (+2)

status: open
From the T414 review (2026-10-24). All PRE-EXISTING, consequential for dependency bumps (a browser is the only gate today).

1. No test executes `proxy()` (packages/web/src/proxy.ts: auth redirect ~:22, CSP header ~:36, cookie clearing ~:41-42); proxy-matcher.test.ts imports only `config`. The CSP is the control markdown-rendering.md names for never fetching agent-named images.
2. No test sanitizes through DOMPurify or parses through markdown-it: packages/web/vitest.config.mts sets no DOM environment; mermaid-loader.test.ts is import-level; markdown-extensions.test.ts never passes a string to tiptap-markdown (`html: true` path).
3. PR CI builds the production web stage but never starts it (.github/workflows/ci.yml ~:407-430); the first boot is release.yml ~:235-252, after publish, although next.config.mjs ~:8-13 records a standalone MODULE_NOT_FOUND crash loop that shipped once. Fix: boot the built image and curl /login (200 + CSP) and an unauthenticated /dashboard (307 to /login), as the T414 session check did.

### T417 · FNF[origin-url-2] · origin follow-ups after T388: clone URLs, relink push URLs, remote-helper syntax, nested probe (+5)

status: taken · owner: codex-run@DESKTOP-IUBG9OP · since: 2026-10-25T00:55Z · last: 2026-10-25T00:55Z
From the T388 review (2026-10-24). All PRE-EXISTING.

1. gitClone of DB-stored URLs is not re-checked by isAllowedGitRemoteUrl and gets no file guard (repo/clone.ts ~:798, repo/refresh.ts ~:293, repo/bundle-ingest.ts ~:196); needs a legacy row. Minor.
2. A relink (`remote set-url origin <url>`, git-push.ts ensureOrigin and api repos.ts link-remote) replaces only the first fetch URL and leaves `remote.origin.pushurl`, so a leftover push URL keeps receiving pushes (with the bound credential, see T340 item 2) while the UI shows the new remote. Consequential, narrow. Fix: clear push URLs on relink.
3. The rule admits `a.b::x` (shared schemas/git-url.ts ~:44-52, :85), which git reads as remote helper `git-remote-a.b`; inert unless such an executable is on PATH. Minor. Fix: refuse `::` transport syntax.
4. The link-remote probe uses upward `.git` discovery (api repos.ts ~:2547), so a localPath nested inside another repository would set that repository's origin; repo/git-workspace.ts ~:15-48 checks `.git` first. Minor.
5. (T388 fix-round reviews) The two operator scripts run `git fetch --all` (scripts/advance-bundle-items.ts ~:66, reset-bundle-to-commit.ts ~:88), which reaches every remote with neither the origin rule nor `protocol.file.allow=never`. PRE-EXISTING, minor (operator-run). Fix: fetch `origin` through the same validation, or refuse a remote the rule refuses.
6. (T388 third review) Design limit, minor: `protocol.file.allow=never` is added only when the literal token `origin` is in the argv (shared git-args.ts ~:125-128), and the origin exec guard keys on the same token (worker origin-exec-guard.test.ts ~:84), so a future transport written without it (a bare `pull`, `fetch` with no remote, `remote update`) gets neither. Every current call passes `origin`. Fix: harden by verb (fetch, pull, push, ls-remote, remote update) rather than by the remote's name.

### T418 · FNF[git-wording] · "nothing to commit" is still matched by git's English wording

status: taken · owner: codex-run@DESKTOP-IUBG9OP · since: 2026-10-25T01:20Z · last: 2026-10-25T01:20Z
From the T388 review (2026-10-24). PRE-EXISTING, minor. Same class as T388 item 4 (exit code, not wording), another command: steps/workflow/_kb-commit.ts ~:69, 10-gate-3-commit.ts ~:416, 11d-skill-sync.ts ~:527, run-app/99-run-app-ready.ts ~:335. A localized or reworded git turns "nothing to commit" into a failure. Fix: decide by `git diff --cached --quiet` (exit 1 = staged changes) before committing, or by the commit's exit code plus a staged-paths read.

### T420 · FNF[cli-job-polling-2] · the pricing page ignores its refresh job; other jobs can trim a polled result early (+1)

status: taken · owner: codex-run@DESKTOP-IUBG9OP · since: 2026-10-25T00:45Z · last: 2026-10-25T00:45Z
From the T380 review (2026-10-24). PRE-EXISTING, minor.

1. packages/web/src/app/(app)/admin/pricing/page.tsx ~:137-140 ignores the `jobId` "Refresh now" returns and re-reads once after a fixed 4 s, while the refresh can queue behind agents for minutes, so the page can show stale numbers. Poll the job (web lib/cli-jobs.ts) instead.
2. The cli-exec `completed`/`failed` sets are shared by every job and INVOKE jobs trim them by count (worker queues/task-queue.ts ~:1409-1410, also ~:1312, ~:1327), so under load a retained probe, sign-out or refresh result can be reaped before CLI_POLLABLE_JOB_OPTS' 900 s, against its "outlast the poll window" intent.

### T413 · FNF[rag-chunker-3] · Go/Rust/Python readers still read code in strings/comments (+7)

status: open
From the #311 driver (2026-10-24). PRE-EXISTING unless noted. (Session fnf-run mirrors it as task #330.) Evidence/harness (ruler, lexer-diff, oracle-cross, mutants): .claude/tmp/fnf-run/p311/ on ACTIVIT21.

1. Go/Rust readers count braces in strings/comments (goRanges/rustRanges read raw content); verify with a ruler first.
2. Python defRe matches def/class inside triple-quoted strings (verify).
3. PHP trait/interface/enum owners absent; `new class extends X {` names methods method-extends-*.
4. LIMIT introduced by #311: JSX text lexed as JS blanks the rest of a line after an apostrophe, `//` or `/` (30 runs in 3 of 2417 TS files, 0 constructs lost).
   Also: a stray backtick in JSX text that pairs with a LATER real template literal masks the code between them (#889 fixed only the unclosed case; needs a JSX-text signal).
5. PRE-EXISTING (main too, probed 2026-10-24): a function/class/method named with non-ASCII characters (`function café()`, `class Näme`) yields no section in PHP or JS: JS_NAME and the PHP construct patterns are ASCII `\w`. PHP allows any byte >= 0x80; JS allows ID_Start/ID_Continue.
6. PRE-EXISTING: section extraction splits and looks back on LF only (`_rag-chunkers.ts` lastIndexOf('\n') ~780-787, split('\n') ~859, ~999), so a CR-only file's sections may be cut imprecisely; #889's CR controls only check the section ids.
7. Ruby reader: `def self.x` named `self`, `module`, endless def.
8. Doc: docs/plans/rag-retrieval-improvements.md:22-23 chunkSection split order is stale.

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
4. Dead code: rebaseProjectStateOnCheckout + rebaseLocked (sync.ts ~797-841) have no caller; mention in the PR, delete only if the user asks.
5. The state writer overwrites an on-disk record it never imported (write.ts:532-545); fix with B3.2's synced_hash (land with or before T117).
6. Low: 12-post-onboarding.ts:345 stores the applicable set from 07's rtkEnabled; a toggle between 07 and 12 leaves it stale.

### T286 · FNF[root-work] · a task at the root after 01 was skipped escapes the fences (+3)

status: open · area: touches finishMerge — heads-up to modular-haive-plan first · #278 (fnf/278-merge-dir-reads) LANDED as PR #884 (c48df1953) 2026-10-24: git-operation.ts, set-aside.ts, git-merge.ts, merge-projections.ts, merge-baseline.ts and left-open-merge.ts are free
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

### T306 · FNF[test-fakes-12] · 12's apply runs unguarded; 04's skipped runs (+2)

status: taken · owner: codex-run@DESKTOP-IUBG9OP · since: 2026-10-24T21:32Z · last: 2026-10-25T01:30Z · merged PR #911 (adad1b8d8), waiting for main CI · kind: test-only

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

status: open · area: modular-haive-plan (heads-up first) · #278 (fnf/278-merge-dir-reads) LANDED as PR #884 (c48df1953) 2026-10-24: git-operation.ts, set-aside.ts, git-merge.ts, merge-projections.ts, merge-baseline.ts and left-open-merge.ts are free

1. Dead code: the origin-keeps-advancing halt and MAX_BASE_SYNC_ROUNDS never fire (baseSyncRounds never passes 1). Re-enter prePushSync from a base-sync round, or delete both and update merge-conflicts.md.
2. A person's commit on an unrecorded squash: reported as "Squash skipped"; walk first-parent for the squash.
3. Reset/commit recovery still require ORIG_HEAD even with squashMergeSha (git-merge.ts ~1345-1356).
4. Trivial: two throws in squashMergeCommit with no recovery clause.
5. Lock hold: C1/C2/C3 (reopen, captureFixBaseline, openMerge hand-back out of the lock); crash window on baseShaBefore. Analyst marked three variants UNSAFE — see the task's history in .claude/tmp/fnf-run/.
6. handBackWritten ~2.2 ms CPU per path (git-merge.ts:226-228); a directory-grouped primitive.
7. CLOSED by #873. 8. CLOSED by #877.
8. left-open-merge.ts:61-65 peekOpenMerge reads an unreadable dir as gone (may be covered by fnf/278); merge-resolver.ts:686-691 countAhead reads a failed count as 0 and skips the pre-push sync.

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
Items 1-20 (each with its memory file): skills per CLI after 09_5; frontmatter YAML; agent_rules stamp; declared verify commands; invariants-doc lever; prompt guard/fence (07_7); onboarding artifacts; plan breadth refusals; agent isolation 1/2/4; fs-safe live verification; #169 DDEV runner boot-subpath; #241 Terminal cwd; AGENTS.md split citations; parked experiments (Astra vs Sol, container-cleanup race, global KB purge, haive_rag_ddevtest drop); T293; #287 EROFS on state; #800 mounts; #751 set-aside on a real merge; #806 put-back; #815 reindex spot-check; T375 gate 3 on a worktree holding an untracked nested repo, with and without a commit (#909); T395 Stop offered for a running task whose current row is pending, and the "Nothing was running to stop." notice (no such task on the dev install; pressing Stop changes a real task) (#908). Full list: task #300 text in the fnf-run ledger / memory.

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

### T329 · FNF[cancel-merge-commit] · cancel reports a merge left COMMITTED on local base + one-click undo (+2)

status: open · blocked-by: peer B3.1c (merge-resolver hunks) · was modular #3
DECIDED by the user 2026-10-12: cancel reports a merge left COMMITTED on the local base, plus a one-click Undo. The Undo resets only if the base is still at that merge commit and no claim is live. Never auto-undo.
Two PRs:

- A (report): baseShaAfter/landedOn recorded at merge time, a merge.left_committed event, and a banner.
- B (undo): UNDO_LEFT_MERGE job, root claim, merge-dir lock, 00a fence and containment, `reset --keep` with a sha CAS or update-ref CAS.
  Defaults: step 12 only. Undo re-creates a deleted feature branch (create-only). Pushed merges and /host-fs get the report only. Agree the merge-resolver hunks with the owner of merge-resolver.ts before building.

1. (PRE-EXISTING) A cancel between the merge commit and reachDone leaves merged:false, so onboarding-reset provenance (api repos.ts ~:1103-1150) misses a merge that is on the base. A's baseShaAfter makes this cheap to fix.
2. (PRE-EXISTING) A cancelled task's failed step 12 still says "retry the push", although a cancelled task cannot be retried. The comment at api routes/tasks/index.ts ~:1201-1203 wrongly says step retry has no status guard (steps.ts guards it).

### T330 · M12 · module lifecycle L3: dependents preflight urgent/graceful (+J9)

status: open · was modular #35
From the modularity plan, docs/plans/twinkling-frolicking-toast.md (M12, J9).

- U1 and U2 shipped: urgent deactivation and the dependents dialog.
- Remaining: the graceful path through the maintenance primitives, and J9, the preflight that lists dependents (snapshot module.<m>.* ids plus grants).

### T331 · I7 · modules/integration-google (Drive, Docs, Gmail)

status: parked: needs a real GCP OAuth client from the user · was modular #42
Plan I7: REST by default, remote MCP opt-in. Blocked until the user provides an OAuth client.

### T332 · J7 · reconnect park (deactivated provider) / dead (uninstalled)

status: open · blocked-by: T359 (I6c reasons) · was modular #47
Plan J7: a single owner keyed on the connection's `status`. A step that needs a deactivated provider PARKS with a reconnect banner; an uninstalled provider makes the task DEAD.

### T333 · J8 · composer shows integration requirements + provider install state

status: open · was modular #48
Plan J8: for each requirement, the composer shows its category, the providers that can resolve it, and their install state.

### T334 · FNF[builtin-order-hazards] · built-in workflow runs 07b before 07c, and 08b fixer edits after both

status: open · kind: design · was modular #65
All PRE-EXISTING.

1. 07b-phase-4-validate boots and uses the runtime (07b:787) against a DDEV container that has not yet applied the implementation's .ddev change; 07c-ddev-reconcile runs after it in registry order (steps/workflow/index.ts).
2. 08b-test-management writes tests and fixer edits after 07b validated and 07c reconciled; nothing re-validates or reconciles them.
3. orderWorkflowRunList (execution-paths.ts:165) runs 00a-sync-base before the env prelude, so a merge-fix agent dispatched on a divergent base runs before the env image and LSP checks exist.
   Decide:

- whether to put 07c before 07b in the built-in workflow (then composable-core gets "07c precedes validation");
- whether 08b's fixer edits need a re-check;
- what to do about 06-run-config: it is the only writer of tasks.pre_answers and is not in the composable catalog, so custom types park forms that have no defaults.

### T335 · D2b · channel install/upgrade (+3)

status: open · was modular #104
Plan D2: installer flags, an install-local docker config for private pulls, and a host upgrade that reads the channel. Depends on T351-T353.

### T336 · D3 · haive-builder image + run-overlay image vars + pre-flight rebuild + per-customer builder (+1)

status: open · was modular #105
Plan D3. Check: an own module installs on a published-image install with no host toolchain.

### T337 · D4 · module_sources table (git/registry, envelope-encrypted token) + Modules page form

status: open · was modular #106
Plan D4: git and registry install sources drive D1 and D3; the token is stored envelope-encrypted.

### T338 · FNF[task-cli-provider-route] · uncalled task-level PATCH /tasks/:id/cli-provider resets running rows without epoch or kill

status: parked: user decision (delete the route vs make it safe) · was modular #123
PRE-EXISTING. The route at api routes/tasks/index.ts ~:1599-1714 resets running and waiting_cli provider-sensitive rows to pending. It does not bump the orchestration epoch, kill the sandbox or supersede the run; the step-level route in steps.ts does all three. No web, e2e, script or test calls it.
Recommendation: delete the route.

### T339 · I4d · task page Integrations tab (override, "Also for my later tasks", reset) (+2)

status: open · was modular #127
Plan I4, part d. Browser check at 1280, 768 and 390.

### T340 · FNF[pr-poll] · a local_path repository can open a PR its poller can never read (+2)

status: open · was modular #138
Items 2-5 merged (#781, #808).

1. PRE-EXISTING, from reading the code (not reproduced). The PR is opened against the origin read from disk (12-worktree-cleanup.ts ~:226, ~:808-813), but pr-poll needs repositories.remote_url (pr-poll-queue.ts ~:136-142), which is NULL for local_path repos. Fix: record the origin on the PR row and poll from it, or backfill remote_url. Reproduce first.
2. PRE-EXISTING, security-adjacent. The git transport's inline credential helper (repo/git-push.ts ~:68) prints the token for whatever host git asks for. Binding a credential to a repository checks only ownership (api repos.ts ~:379-388, ~:2482-2491). The terminal helper route (api internal.ts ~:18) returns the bound token with no host check.
   Fix:
   - refuse a bind whose credential does not fit the remote;
   - make the helper answer only for the credential's own host;
   - run the fit check before 12's push.
3. (T388 review) PRE-EXISTING, minor: an accepted origin URL is returned raw, userinfo included, into step output (worker repo/git-push.ts getOriginUrl; 11a-gate-4-push.ts ~:111, 12-worktree-cleanup.ts ~:267), so a token embedded in a remote URL reaches the step's detect output. Fix: redact userinfo wherever a URL is shown or stored.

### T341 · FNF[credential-connection-coupling] · deleting a Git credential silently deletes its connection; re-sign-in duplicates the credential (+13)

status: open · was modular #140
All PRE-EXISTING.

1. /settings/credentials deletes a credential without confirmation. The FK ON DELETE CASCADE (0192) then silently deletes the integration connection it backs.
2. Disconnecting and signing in again creates a second Git credential (finishSignIn, api lib/integration-sign-in.ts).
3. PUT /repo-credentials/:id can change the host or provider of a credential that backs a connection.
4. credential-modal.tsx ~:187-189 spells out the auto-detect hosts in prose (cosmetic).
5. The modal's help text does not state the API-base rule.
6. resolveTarget's `fits` check (shared integrations/resolver.ts ~:154-158) never compares the credential's forge with the connection's providerId.
7. A reconnect refreshes only the secret; an edited host or provider stays.
8. After a forge-changing edit the connection still reads "connected".
9. github-oauth.ts:74 compares the host case-sensitively.
10. A refresh the OAuth client refused keeps the connection "connected"; last_error is never shown.
11. A credential rename never updates the connection's account_label (integration-connections.ts:171).
12. Only `credential.delete` is audited; the cascaded connection is not named in the audit row.
    Fix:

- confirm before delete and name the backing connection;
- reuse a credential by (user, host, account);
- refuse host or provider edits on a backing credential;
- one help sentence for the API-base rule;
- compare hosts case-insensitively;
- show last_error;
- sync account_label on rename.

13. (T378 review) PRE-EXISTING, minor, dormant: a failed `finishSignIn` after the vendor issued tokens leaves them valid for a module provider that declares `revokeUrl` (api lib/integration-sign-in.ts ~:150-156, routes/integrations.ts ~:225-243, lib/integration-device.ts ~:149-162), and a device-only provider cannot declare one at all (shared modularity/integrations.ts ~:77-83; `revokeUrlOf` reads oauth2 only, api lib/integration-provider.ts ~:136-139), so even disconnect cannot revoke its tokens. No shipped provider declares one (T378 item 1 INVALID); re-open when the first does.
14. (T378 review) PRE-EXISTING, minor, design: both web device sign-in clients end the attempt on any poll failure (web github-oauth-connect.tsx ~:141-145; lib/device-sign-in.ts ~:36 with use-device-sign-in.ts ~:60-67), so the api's "unavailable vendor keeps the record (502)" never helps a retry and a Redis blip ends a 15-minute sign-in. Pinned as intended by device-sign-in.test.ts ~:144-150; decide whether a 5xx should retry.

### T342 · FNF[mcp-token-file] · rag/ddev task tokens in the server env defeat the cli-merge skip (measure first) (+4)

status: open · kind: design · was modular #146

1. The rag and ddev tokens carry a per-second exp inside their MCP server env (worker orchestrator/mcp-surface.ts:108, :186), so the codex/grok/gemini merge key (task-auth-volume.ts:889-905) changes on every invocation. Measure first, then move the tokens to the token file.
2. The step-summary pass skips MCP wiring, so the auth volume keeps listing per-run servers until the next wiring.
3. The cli-merge helper's marker write does not reach its exit status.
4. The rag and ddev routes parse the bearer header by hand; use the shared parse in lib/task-call-auth.ts.
5. Per-run `<uuid>` dirs in the wrappers volume are removed only by runInSandbox's finally. Add a boot or periodic sweep.

### T343 · FNF[a11y-sweep] · links wrap buttons at 17 sites; sidebar rename input sits inside a button; plan panel close and tabs lack names (+11)

status: open · was modular #151
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

### T344 · FNF[task-type-e2e] · task-type e2e specs need no instance-wide switch flip and cover the unsaved-changes guard (+2)

status: open · was modular #153

1. tests/e2e/tasks/new-task-type.spec.ts flips the instance-wide custom-types switch. Use a fixture that does not need it.
2. Add a Playwright spec for the task-type editor's unsaved-changes guard: dirty, then a link click, then the dialog; cover Keep, Discard and Escape, and that Discard through a sidebar task keeps its Back origin.
3. worker test/prompt-step-smoke.sh has no package script and is not in CI. Wire it like smoke:type-draft.
4. No e2e covers a call-only task panel (loggedCallCount → showsToolUsage in tasks/[id]/page.tsx).

### T345 · FNF[admin-stop-surfaces] · best-effort kills, kill-after-stop error paths, stop error text, left-task kill, urgent loop deadline, created sandboxes, 50-stop cap, statistics links, duplicate title components

status: open · was modular #158
Items 1-2 merged (#816). All PRE-EXISTING. 3. killTaskSandboxes (api lib/sandbox-kill.ts) is best-effort. Stop (lib/task-control.ts ~:40) and the retry, resume, skip and CLI-switch paths in steps.ts report a clean count when docker is unreachable. 4. maintenance.ts `stop` and POST /:id/cancel-active-cli commit the stop and then kill. A kill that throws answers 500 and skips the event and the audit row. 5. activation.ts errorText shows drizzle's "Failed query ..." text; err.cause is dropped. 6. activation.ts kills sandboxes for a `left` dependent and drops that kill's error. 7. The urgent loop awaits one stopTask per dependent, each with up to 13 s of deadlines, up to the 200 cap. 8. The api lists sandboxes with `docker ps -q` (running only), so a sandbox that was created but not started is missed. 9. STOP_EVENTS_READ = 50 (lib/task-stop.ts ~:20) loses a task's reason after 50 or more stops. Fix: pick it in SQL by failedAt = completedAt. 10. The statistics pages link /tasks/<id> without an owner check (latent). 11. The owner-only title rule lives in two components; share one TaskTitleLink.

### T346 · FNF[custom-tool-start-hint] · a broken or switched-off custom tool fails only at its step (+5)

status: open · kind: design · was modular #159

1. A task runs every earlier step and fails only at the prompt step whose custom tool is invalid or switched off. Fix direction: a start-time pass records a task event (custom_tool.unusable) and never blocks. Whether it should block instead needs the user.
2. CUSTOM_MCP_TOOLS_ENABLED is read at three sites (worker step-runner.ts ~:571, cli-exec/resolvers.ts ~:260, api custom-mcp.ts ~:240). Use one shared reader.
3. POST /custom-mcp/call re-validates only http-get tools. Re-check every pinned tool at call time.
4. The custom-tools-unwired failure does not name the server whose `mcp add` failed.
5. The pinned-tool re-checks use requiresRepository: true. Pass the task type's requiresRepository.
6. templateTokens (worker steps/custom/prompt-step.ts:65-68) returns [] for a template that fails to parse. Re-validate at dispatch.

### T347 · FNF[forge-egress] · forge requests follow redirects and reach any credential host, internal addresses included

status: open · kind: design · was modular #169
PRE-EXISTING. BaseForgeProvider.request (shared forge/base-forge.ts) fetches with `redirect: 'follow'`. The host and API base of a self-hosted credential are typed in by the user.
Measured: Authorization is dropped on a cross-origin hop.
Fix direction:

- `redirect: 'manual'`, with a 3xx treated as a ForgeError;
- for self-hosted hosts, P14c's connect-time address guard.
  Decision needed: a corporate GitLab on a 10.x address is legitimate.

### T348 · FNF[stalled-answered-form] · the allowance auto-resume's post-commit enqueue can strand a task (+1)

status: open · was modular #172
PRE-EXISTING. In worker queues/usage-poll-queue.ts ~:612, ADVANCE_STEP is queued outside the transaction after autoResumeFailedStep. If that add is rejected, the task stays `running` with a `running` step and no job. The stalled sweep's redrivableRow never takes a running row.
Fix: the stalled sweep re-drives a running task whose current row is running, with no live invocation and no queued job past the cutoff. Alternatively, write the advance through an outbox.

### T349 · FNF[lock-order-step-rows] · multi-row step writers can deadlock on step rows (+2)

status: open · was modular #173
All PRE-EXISTING.

1. resetRowsForRerun (api steps.ts ~:124) updates rows in click order, while other writers lock them by id. Fix: every multi-row step writer first runs `SELECT … ORDER BY id FOR NO KEY UPDATE`. Control: a gated interleave.
2. A Retry of a failed non-onboarding task is not serialized with a repository delete (repository-task-lock.ts ~:108-111). Fix: the delete takes the same key.
3. The single-task cancel (tasks/index.ts ~:1192-1206) calls cancelTaskRow with no status guard. Fix: lock and re-check first.

### T350 · FNF[module-runtime-status] · a module whose reactivation used every attempt shows active with no schema or jobs (+1)

status: open · kind: design · was modular #174
PRE-EXISTING. publishWorkerBootReport (worker modules/loader.ts) is written once at boot.
Fix direction: publish the per-module runtime state (schema pending/failed/ready, jobs, attempts, reason) to the same Redis report on every reconcile change, and show a failed module on the Modules tab with a "try again" hint. #205's schema state is a natural input.

1. (minor) api modules/activation.ts:8 imports appendTaskEvent from ../routes/tasks/_helpers.js (module→route layering).

### T351 · D2a-3 · scripts/build-channel.mjs: channel build from a final base tag, no push

status: open · was modular #177
Plan D2a-3: a git-archive tree, `module add` per entitled package, `--secret` builds, then the gate.

### T352 · D2a-4 · channel publish (+3)

status: open · was modular #178
Plan D2a-4:

- push only after the full gate;
- refuse existing tags;
- copy unbuilt images by digest;
- write the channel manifest last.

### T353 · D2a-5 · live boot check of a channel build before push

status: open · was modular #179
Plan D2a-5: a throwaway stack with no docker.sock, checking that /modules/loaded equals the entitled set.

### T354 · FNF[npm-cache-shared] · the shared npm cache volume is mounted read-write into every agent sandbox

status: open · kind: design · was modular #180
PRE-EXISTING. haive_npm_cache (worker sandbox/npm-cache.ts:32-34, mounted at cli-exec/exec-core.ts:1575) is read-write in every sandbox. This is deliberate for speed: a cold install takes 146 s, a warm one 4 s.
Options:

- a per-user cache;
- a read-only shared cache with a per-task overlay.
  Measure first whether npm trusts a planted index entry.

### T355 · FNF[redis-outage-hangs] · ConfigService Redis calls never reject during a Redis outage

status: open · kind: design · was modular #184
In redis-factory.ts:18-27, `maxRetriesPerRequest: null` plus `enableOfflineQueue: true` mean ConfigService get/set wait out an outage. Instances:

- the maintenance fence read holds the shared fence;
- admin config saves pin a Postgres connection inside an advisory-lock transaction;
- the dead-task revival's fenced read hangs the same way.
  Fix direction: a per-command deadline (commandTimeout on a dedicated connection, or enableOfflineQueue false), measured against a stopped Redis, with every caller's failure path checked.

### T356 · J6c · create gate for required integration categories + GET /tasks/integration-preview

status: open · was modular #187
Plan J6.

### T357 · J6d · web: New Task integration picker + composer Integrations section

status: open · was modular #188
Plan J6. Browser check at 1280, 768 and 390.

### T358 · J6e · provider-pinned requirements (pin table, grants.provider_id, resolver tiers, drop the dispatch refusal)

status: parked: deferred until the first module that pins a provider · was modular #189

### T359 · I6c · resolver reasons provider-deactivated / provider-missing

status: open · was modular #194
Plan I6: the reasons apply to a choice, a grant, a pinned target and a module category.

### T360 · I6d · web: module categories in every category list, admin provider card, Settings state note

status: open · was modular #195

### T361 · I6f · purge of a provider module deletes its integration rows and reports counts

status: open · was modular #196
DECIDED 2026-10-23: delete only that module's rows and show the counts in the confirmation.

### T362 · FNF[new-task-reset-verdict] · after a failed reset the New Task page keeps the pre-reset verdict

status: open · kind: design · was modular #203
PRE-EXISTING. The reset route removes files before its database transaction (api repos.ts ~:2893, then ~:2935).
Fix direction: after a failed reset, re-ask for the status without clearing the error, and keep Create disabled until the answer lands.

### T363 · FNF[created-task-start-partial] · Start on a created task starts with whatever attachments landed

status: taken · owner: codex-run@DESKTOP-IUBG9OP · since: 2026-10-25T00:05Z · last: 2026-10-25T00:05Z · was modular #208
DECIDED 2026-10-23: record the expected attachment count on the task, and Start confirms "N of M missing". The start claim is in api lib/task-start.ts:10-23.

### T364 · FNF[test-coverage-gaps] · audit-failure blindness and missing gated cases (+14)

status: open · was modular #211

1. recordAuditEvent catches a failed insert, so route tests over a fake DB pass with the audit lost. Fix: a shared helper that fails a test on a logged audit failure.
2. task-create-path.test.ts has no case where the type is refused inside the create transaction.
3. No real-store test covers withVectorWidthLock (api global-kb.ts ~:298).
4. No gated audit test asserts the pino audit line is absent on a refusal and present once on success. The device-poll and /github-oauth/poll routes lack refused-audit tests.
5. The "Stop lands inside an ADVANCE or START pass" windows are covered only by an uncommitted script. Promote it to a gated smoke.
6. GET /usage-window has no route test, and the fake DB has no innerJoin.
7. Two flush and sweep test files use fake-DB Proxy workarounds, and K5/M11c count git reads. Replace both with behaviour assertions.
8. worker repo/worktree-changes.test.ts:191 failed once in a full run under load (expected 1, got 0); 65 replays could not reproduce. Flake, cause unknown.
9. PRE-EXISTING: a gate row healed by 0210 with no saved schema (the old per-step switch nulls formSchema, steps.ts:1855) has no real-worker check, only the SQL test. Also 0210.sql:14 sets pause_form_on_retry on no-schema rows too, which costs one extra stop at that step's form; narrow it to `pause_form_on_retry OR form_schema IS NOT NULL` if wanted. From #263 (PR #887).
10. From the T407 review (2026-10-24), PRE-EXISTING, minor: no runner-level test pins that `applyArgs.llmInvocationId` is the run that produced `llmOutput` for a post-form LLM step (worker step-runner.ts ~:3148, ~:3231; only the preForm path is pinned, step-runner-auto-continue.test.ts ~:296-339). Plan chat attribution, 07b, 08c2, 07_7 and prompt steps rest on it.
11. Same source, minor: the "no agents directory" branch (provider amp) has no test: the `_active-agents-target.ts` null return, 07_5-verify-files.ts ~:57-64, 11-final-review.ts ~:86-93, `collectReviewFindings(repo, null)`.
12. (T378 review) PRE-EXISTING, minor: `useDeviceSignIn` has no test of its own; the attempt counter, the unmount bump (web lib/use-device-sign-in.ts ~:25-30) and its `live()` guards are exercised only through `runDeviceSignIn` with an injected `live`.
13. (T306 review) PRE-EXISTING, minor to moderate (class hazard): database testing/fake-db.ts ~:169 throws a plain Error for a table the fake was not given, which a route turns into a 500 or a caught failure, so a test that expects a throw or a 500 can pass on the miss (proven for revive-beside-live, fixed in T306; not scanned for others). Fix: a sentinel error class and an afterEach check of misses.
14. (T363 review) PRE-EXISTING, consequential: scripts/test/ci-gated-list.test.mjs ~:12 recognises a Postgres-gated test only by `pathname.startsWith(` or `CREATE|DROP DATABASE`, so a gated file with another guard idiom is invisible to the "every gated file has a GATED row" check and skips green in CI for ever (T363's DB file was the live case, fixed there). Fix: detect by `skipIf` plus a `*_URL` env var.
15. (T363 review) PRE-EXISTING, minor: no e2e spec creates a task with attachments or presses Start on a created task (the only Start click is Run app, tests/e2e/tasks/new-task-type.spec.ts ~:232), so the attachments confirm flow is checked by hand only.

### T365 · FNF[repo-picker-caps] · slow bundle file browser, picker 100-row cut, unbounded /user/repos error body, extra empty page (+3)

status: open · was modular #213
Items 1-2 merged (#831). 3. PERF: the bundle file browser runs fs-safe lstat per file (5000 files took 8.8 s). Fix: a walk that holds directory descriptors. 4. new-repo-form.tsx shows only the first 100 matches, with no note. 5. github-oauth.ts:110-111 echoes an unbounded GitHub error body, and a body that echoed the request's token would reach the response and the error log (T378 review, fake-vendor repro). Reuse the forge excerpt helper. 6. The /user/repos loop makes one extra empty request. Fix: stop when the Link header has no rel="next".

### T366 · FNF[shutdown-deadline] · the worker shutdown's per-part limits are summed by hand

status: open · kind: design · was modular #219
worker index.ts runShutdown budgets each part separately against Docker's 10 s grace.
Fix: one deadline object that hands each part the time left, plus a test that sums the budgets.

### T367 · FNF[tool-usage-cancel-signal] · a run cancelled in flight never moves the tool usage panel's refresh signal

status: open · kind: design · was modular #222
A cancel writes ended_at and superseded_at together, so the run never joins the rollup.
Fix direction: the revision also hashes the in-flight ids. Re-verify against main first (#830 changed the rollup).

### T368 · FNF[grok-usage-gap][verify-first] · grok runs report fewer prompt tokens than their tool results (+2)

status: open · was modular #231
In 9 grok runs, tool-result chars/4 come to 1.14-2.25x the recorded prompt tokens; e.g. run e3d08fb4… (09-qa).
Candidates:

- usage under-reports;
- chars/4 overstates;
- grok drops old tool results.
  Measure with the CLI context-capture recorder before any code.

1. The killed-run fallback dedupes by message.id; check whether grok reuses ids across messages.
2. grok reports no context window; the 256k table entry is one old measurement.

### T369 · FNF[usage-fallback-verify] · ollama/antigravity live usage fallbacks unverified; zai/muse killed runs store zero usage (+7)

status: open · was modular #237

1. ollama puts message_start values on assistant events, so a killed run under-reports output.
2. Whether antigravity's running usage is per-step or cumulative is unmeasured.
3. The killed-run fallback stores zero usage for zai and muse. Fix: all-zero means null.
4. amp's multi-turn semantics are unmeasured.
5. MODERATE, fix first: a steered claude run keeps only the last result's usage next to a cumulative cost (worker cli-exec/stream.ts ~:241). Fix: sum per result.
6. gemini and antigravity could prove a single request, but nothing reads it (usage-extract.ts ~:120). sumTokenUsage treats a missing peak as 0.
7. amp's `usage.max_tokens` (272k) may be its context window. Measure.
8. ollama's per-message prompt and result prompt disagree (display only).

### T371 · FNF[docker-spawn-dedup] · twelve hand-rolled docker spawn helpers re-implement collect, deadline and kill (+1)

status: open · kind: design · was modular #240
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

### T373 · FNF[audit-strict-admin-actions] · module/task-type/upgrade-start actions still audit best-effort (+1)

status: open · was modular #246
Sites:

- api modules/loader.ts:261, :291, :324, :411;
- routes/task-types.ts:275, :399, :430;
- task-type-drafts.ts:123;
- maintenance.ts:533.
  The Stop rows are best-effort on purpose.
  Fix: the #212/#224 shape (audit row in the change's transaction; for external side effects, row first, rolled back on failure).

1. A role-admin owner's Retry under an administrator's pause lifts it with no byAdmin event or audit row (api tasks/_helpers.ts ~:1181).

### T375 · FNF[diff-artifact-edges] · an untracked nested repo shows as unreadable although gate 3 commits it as a gitlink (+1)

status: taken · owner: codex-run@DESKTOP-IUBG9OP · since: 2026-10-24T21:07Z · last: 2026-10-25T00:40Z · merged PR #909 (d35333489), waiting for main CI · was modular #250

1. worker steps/workflow/_commit-diff.ts ~:161 returns null when the index has no gitlink. Proposed: show the repo as a new gitlink with its HEAD sha. Show an unborn repo as unreadable with a reason.
2. An empty investigation file reads as `added` (11-phase-8-learning.ts ~:943). Fix: tell absent from empty by the read result.

### T376 · FNF[audit-security-gaps-2] · CLI provider key/token changes, password change, registration, repo security settings, sign-ins write no audit row (+5)

status: open · (T377 landed as PR #886) · was modular #252

1. cli-providers.ts ~:856, :923, :998, :1019; cli-login-banner.ts ~:930.
2. Password change (user-settings.ts ~:127-170) and registration (auth.ts ~:61-170).
3. tooling-upgrades.ts ~:644, repos.ts ~:2488, repository-integrations.ts ~:45-96.
4. DECIDED: audit successful and failed sign-ins; nothing for token refresh or logout.
5. Throttled (429) attempts and the forced password change.
   Fix: the #218 shape, with gated tests.
6. From the T374 review (2026-10-24), PRE-EXISTING, minor: a house rule's approval also lapses with no audit row and no admin: a content PATCH clears `enforcedHash` (api global-kb.ts ~:1124-1127), the store trigger clears it when an active entry leaves `active` (shared global-kb/ensure-schema.ts ~:168-186), and DELETE /entries/:id removes an enforced entry (~:1243-1270); PATCH and DELETE are requireAuth only. global-kb.md:79-85 calls the lapse deliberate, so the open question is only the trail: a `global_kb.house_rule.lapse` row in the same transaction.

### T379 · FNF[git-tree-readers] · gitlink readers and literal-pathspec helpers duplicated with different failure contracts (+4)

status: open · was modular #257

1. Readers in set-aside.ts:168-184 and :1066-1078, _commit-diff.ts:97-128, merge-prior.ts:50-69 and projection-merge.ts:129. The `:(literal)` helper is copied 4 times.
2. A duplicate runGit exists in advance-bundle-items.ts and reset-bundle-to-commit.ts.
3. set-aside.ts ~:250 headOid, ~:1113 headEntry and projection-merge.ts ~:32 readBlob count a failed read as absent.
4. git-merge.ts ~:632, :636, :1356, :1373, :1419: resolvingPaths and `rev-list --parents` failures.
5. (T375 review) _commit-diff.ts checkedOutCommit ~:133-161 is one more gitlink reader with its own failure contract.
   Fix: one shared reader module with an explicit failure contract. Do this after T396.

### T382 · FNF[auth-endpoint-hardening] · refresh rotation not CAS; login timing; no admin-authz sweep (+4)

status: open · (T377 landed as PR #886) · was modular #261

1. api auth.ts ~:280-295: rotate with `UPDATE … WHERE revoked_at IS NULL RETURNING`, in a transaction.
2. Login answers 401 before bcrypt for unknown accounts. Compare against a dummy hash; register's 409 too.
3. No sweep proves admin routes refuse a signed-in non-admin. Extend anonymous-routes.test.ts.
4. Export one app builder for the sweep.
5. PUT /user-settings/password has no CAS on token_version.

### T385 · FNF[parks] · lost park poll chain never recovered; duplicate poll loops; schema park badge; pre-run park booked as idle (+5)

status: open · was modular #265

1. stalled-redrive.ts ~:134-146 skips parked pending rows, and boot reads only waiting_cli and running rows. Fix: re-drive an overdue park.
2. enqueueAdvance has no job id. Fix: a deterministic id per (task, step, epoch).
3. REGRESSION from #205 (cosmetic): the slot badge says "runtime slot" for a schema park (web slot-wait-badge.tsx ~:8, :37).
4. reofferParkedSteps books a pre-run park as idle (api lib/task-control.ts ~:144, :213).
5. Resume on a Stop-failed, never-started loop row leaves started_at empty (api steps.ts ~:1283-1292).
6. PRE-EXISTING: eight hand-off writes in handleResult return with no log when they lose their row or the task (worker task-queue.ts:1838, 1848, 1867, 1936, 1953, 1996, 2013, 2022), the same family as #263's resolveFixLoopGate warning. The log level for a routine Retry race needs choosing. From #263.

### T386 · FNF[upgrade-early-death-hold] · an upgrade that dies before recording its found state restores normal and lifts an admin's hold

status: open · kind: design · was modular #267
A run that dies between startRun (updater cli.ts ~:161) and recordFoundState (run.ts ~:181) has no metadata.foundState, so a later restore writes `normal`.
Needs a marker that tells an older updater's run apart from a new run that died early.

### T387 · FNF[shipped-git-config] · an uploaded repo keeps its own .git/config, so host git still runs filter/merge drivers, the vcs trick and lazy fetch (+1)

status: open · kind: design · was modular #268
PRE-EXISTING, consequential. An upload keeps its whole .git (worker repo/clone.ts ~:547-683). `filter.<d>.*`, `merge.<d>.driver`, `remote.<n>.vcs` and lazy fetch all lack a `-c` lever. Measured: gitRun `add -A` runs the shipped filter.
Decide: sanitise .git/config at import (allow-list keys), or refuse archives that carry .git.

1. Env-only levers (GIT_ALLOW_PROTOCOL, GIT_NO_LAZY_FETCH) reach only gitRun and gitExec.

### T388 · FNF[origin-url-revalidate] · a stored remote.origin.url is never re-validated, so network git can fetch/push file:// paths of other tenants (+3)

status: taken · owner: codex-run@DESKTOP-IUBG9OP · since: 2026-10-24T17:47Z · last: 2026-10-25T00:50Z · merged PR #906 (da043a2aa), waiting for main CI · was modular #269

1. isAllowedGitRemoteUrl (shared schemas/git-url.ts ~:94) guards only typed URLs. Since #255, getOriginUrl is the one read. Validate the URL there and switch the detectOrigin-only callers.
2. `-c` does not reach a local-path transport child. Item 1 closes this.
3. git-push.ts ensureOrigin tests stderr wording, not exit code 3. 11a trusts a cached hasOrigin. The twin is api repos.ts ~:2539.
4. The api repos.ts ~:2530 link-origin route answers 409 with the wrong reason.

### T389 · FNF[repo-loose-objects] · Haive's git no longer triggers auto-maintenance (#256), so busy repos accumulate loose objects

status: open · kind: design · was modular #270
`maintenance.auto=false` closes gc.recentObjectsHook. An explicit gc still runs that hook.
Measure growth, then find a safe repack/prune under hardened args.

### T392 · FNF[dispatch-adapter-build-error] · an adapter build error aborts the whole dispatch instead of trying the next provider

status: open · kind: design · was modular #273
worker dispatcher.ts ~:622 calls buildCliSidePlan outside a try (e.g. ollama.ts ~:106 with no model).
Recommendation: fall through only for the implicit default; an explicit CLI stays loud.

### T393 · FNF[stop-no-settle] · an api Stop with no pass in flight never runs settleFailedTask

status: open · kind: design · was modular #275
Containers, auth volumes, the kb_author entry and the onboarding re-sync wait for a Retry, Cancel or backstop.
Decide: Stop enqueues a settle, or the backstop sweep settles promptly.

### T394 · FNF[stop-noop-missing-current] · Stop still answers 0 when the current row is missing, finished, or an unparked answered form

status: open · kind: design · was modular #276
See worker task-queue.ts ~:1806-1813, ~:356. Decide per shape: fail the task, or answer a named 409.

### T395 · FNF[web-stop-pending-current] · offer Stop for a running task whose current row is pending; notice on stopped:0

status: taken · owner: codex-run@DESKTOP-IUBG9OP · since: 2026-10-24T20:49Z · last: 2026-10-25T01:15Z · merged PR #908 (2f39fa5fd), browser-checked, waiting for main CI · was modular #277
DECIDED 2026-10-24: yes. Sites: web lib/task-state.ts ~:31, tasks/[id]/page.tsx ~:1591, ~:3884, admin maintenance/page.tsx ~:248; the response is dropped at ~:1299-1307. Key the gate on structural columns, in a separate small web commit. Browser check at 1280, 768 and 390.

### T397 · FNF[failed-read-answers] · branch, count, refresh and merge-completion reads still turn a failed git into an answer (+14)

status: open · was modular #279 (T396 landed as PR #884; re-check every item against T322/T325, PRs #877/#879, first)
FIRST re-check each item on main: the #322 and #325 series fixed some of them.

1. `rev-parse --abbrev-ref HEAD` sites: 00a ~:164, 11a ~:106, 12-worktree-cleanup ~:248, 12-post-onboarding ~:464, 13-onboarding-push ~:147, 99-run-app-ready ~:173, 01-plan-merge ~:727, :741.
2. Count reads return 0 on failure: 13-onboarding-push ~:96-101, ~:161-162; merge-resolver countAhead ~:686-691.
3. refresh.ts usableCheckout ~:55-59 and related reads.
4. Copy and UX nits.
5. CONSEQUENTIAL: refresh.ts ~:215 and 00a ~:572-578 read a non-zero `merge --ff-only` as "not moved". Apply the HEAD==before check.
6. completeMergeHostSide (git-merge.ts ~:1287) returns false on failure.
7. `unmergedPaths(...) ?? []` in projection-merge.ts ~:249, :321 and merge-resolver ~:824.
8. differingFrom returns [] on failure.
9. commitMerge returns null if the post-commit HEAD read fails.
10. git-operation.ts ~:31: a git dir outside the checkout.
11. PRE-EXISTING, minor (found by the T388 driver, 2026-10-24): repo/refresh.ts ~:149-158 reads any non-zero `merge-base HEAD <target>` as "no history in common" (exit 1 is the only "none"; 128 is no answer), and ~:151 reads a failed `--is-shallow-repository` as not shallow. Fix: exit-1-only, else "could not be compared".
12. PRE-EXISTING classification, minor (T370 review, 2026-10-24): set-aside `openOperationRefusal` (project-state/set-aside.ts ~:104-120, used by restoreJudged, setAsideOnce, restoreProjectionsInTx) turns a GitOperationUnreadableError into `refused` ("could not be checked for an open merge or rebase"), so callers read a git that gave no answer as a refusal; since T370 (PlanMirrorRefusal) the early Pull set-aside no longer records it in last_error. Fix: a separate unreadable outcome the callers treat as a failure.

### T398 · FNF[ide-proxy-hardening] · the IDE proxy replays forwarded headers and transfer-encoding; serves /proxy/<port> on the api origin (+2)

status: open · was modular #280

1. Drop hop-by-hop and forwarded headers (transfer-encoding gives a 502 on chunked bodies, measured).
2. The editor is on the api origin with code-server's /proxy/<port> enabled (worker ide-runner.ts ~:229-232). Measure, then disable it or move the IDE to its own origin.
3. withoutSessionCookies splits on `;` inside a quoted value.

### T399 · FNF[probe-stored-targets] · stored-target probes still reach any address for non-admins (+1)

status: open · kind: design · was modular #281
Sites: api global-kb.ts ~:623 (release-embed-model); the RAG store and embedder URL (rag.ts ~:324, tooling-upgrades.ts ~:727); forge calls (integration-mcp.ts ~:380-494); the worker counterparts.
Decide which stored targets a non-admin may point at private addresses.

1. The Ollama pull stream relays 200 chars of the remote error and has no size or time cap.

### T400 · FNF[ws-auth-one-copy] · WebSocket handshakes authenticate once; six copies of authenticateUpgrade can drift

status: taken · owner: codex-run@DESKTOP-IUBG9OP · since: 2026-10-24T20:53Z · last: 2026-10-24T20:53Z · was modular #282
Copies: terminal.ts ~:360, terminal-shell.ts ~:614, cli-stream.ts ~:365, cli-login-banner.ts ~:1233, browser-vnc.ts ~:268, ide.ts ~:391.
Fix: one shared authenticator, and close a user's sockets on deactivation or a token_version bump.

### T401 · FNF[flagged-user-web-polish] · a forced-password user sees pollers 403 every 5 s; no e2e for the forced flow or the 429

status: open · (T377 landed as PR #886) · was modular #283

1. REGRESSION (cosmetic): sidebar-tasks.tsx ~:57 and notification-provider.tsx ~:28 keep polling. They should stop on the 403 must_change_password code.
2. Add Playwright specs.

### T402 · FNF[context-backfill] · 237 stored steps keep the old 200k-window badge (143 read 0%)

status: parked: user decision (numbered migration vs idempotent deploy script) · DEADLINE ~2026-11-30 (stream_log 90-day expiry) · was modular #284
The data is recoverable from cli_invocations.stream_log: windows for about 97% of claude-code runs, peaks for 232 of 237 steps. Keep a before-image so the change can be undone.

### T403 · FNF[context-window-truth] · wrapper CLIs report the binary's 200k default; killed runs fall to the static table

status: open · kind: design · was modular #285
The LiteLLM max_input_tokens value is fetched and dropped (shared model-pricing.ts ~:137-145). OpenRouter's context_length still outranks the CLI figure. Decide the precedence per adapter family.

### T405 · FNF[sandbox-image-failure-routing] · an image-build failure while 08/08b resolve the sandbox image may loop the implementer back to "fix" it

status: open · was modular #287
isDdevAgentFixableFailure (ddev-build-guard.ts ~:467) matches "failed to solve". 08 (~:954) and 08b (~:755) are fixLoopOnError; build errors are thrown at images.ts ~:122, :140 and composed-image-cache.ts ~:130.
Fix: classify by error type. Measure a real failure first.

### T406 · FNF[disabled-task-cli] · a disabled own CLI is handled three ways (+2)

status: open · kind: design · was modular #288
step-command.ts ~:62-64 and 01b read it; dispatch drops it (dispatcher.ts ~:583, ~:646-655); the strip shows it (api tasks/_helpers.ts ~:385).
Recommendation: fall back to the default at run time, plus T391's create refusal.

1. (T391 review) PRE-EXISTING, minor: the effort dropdown stays enabled for a step whose effective CLI is the task's own disabled provider and sends that id (web cli-picker-grid.tsx ~:100-139, ~:193; tasks/[id]/page.tsx ~:1452), so an effort change is refused (409 before T391, 400 after) until the CLI is switched.
2. (T391 review) PRE-EXISTING, informational: the shell sockets check ownership only, never `enabled` (api terminal-shell.ts ~:513-531, ~:553-586; worker terminal-container.ts ~:181-186), so "disabled providers are not offered in terminals" is enforced by the web alone.

### T408 · FNF[default-change-provider-sensitive] · disabling/deleting the oldest provider moves the default CLI but parked provider-sensitive steps keep old detect output

status: open · kind: design · was modular #290
PROVIDER_SENSITIVE_STEP_IDS reset only from PATCH /tasks/:id/cli-provider. Decide: re-detect on resume, or freeze the default per task.

### T409 · FNF[pause-attribution] · whose pause stands is derived from the task_events log (+2)

status: open · kind: design · was modular #291

1. Add a `paused_by_admin` column written under the row lock, with a backfill (api tasks/_helpers.ts ~:1153).
2. After a takeover the owner's banner shows the owner's original pause time.
3. clearTaskPause compares against a JS millisecond date.

### T410 · FNF[merge-resolver-crash-window] · a crash after a clean merge drops the ticked squash; reopen never ensures the base worktree (+1)

status: open · area: modular-haive-plan owns merge-resolver.ts landing sections — heads-up first · (T396 landed as PR #884) · was modular #292

1. merge-resolver.ts ~:1320-1322, ~:1362: persist baseShaBefore before the merge.
2. reopen (~:1642) never calls ensureBaseWorktree.

### T421 · FNF[git-data-ledger-rows] · ledger rows recorded at git-data paths stay live forever

status: open
From the T304 review (2026-10-24). PRE-EXISTING, minor. `onboarding_artifacts` rows an earlier release recorded at a git-data path (a literal `.git` segment or, since T304, an NTFS or HFS+ alias of it) are skipped by every reader (01 plan, 02 and 04 writes, 03 staging, the sync), but nothing retires them and they still count in `liveArtifacts` (api upgrades.ts ~:456, ~:723, ~:787). Fix: retire them in a numbered, idempotent data migration (SQL cannot call `namesGitData`, so the migration needs the same rule in SQL, or ship a deploy script), or leave them out of the counts.

### T422 · FNF[cli-login-banner] · the Claude OAuth capture logs the token's first 22 and last 6 characters (+1)

status: taken · owner: codex-run@DESKTOP-IUBG9OP · since: 2026-10-24T21:14Z · last: 2026-10-25T01:00Z · merged PR #910 (dc444c013), waiting for main CI
From the T400 Codex run (2026-10-24), confirmed by the session.

1. PRE-EXISTING, security hygiene: api routes/cli-login-banner.ts ~:674-680 logs `tokenHead: oauthToken.slice(0, 22)` and `tokenTail: oauthToken.slice(-6)` when it captures a Claude OAuth token from stdout, so 15 secret characters of every captured token reach the api log. The only such site (grep of packages and modules). Fix: log the length and, if one is needed, a short hash, never characters of the token.
2. PRE-EXISTING, minor: web components/cli-auth-banner-modal.tsx ~:226, the socket close handler leaves the displayed phase unchanged.

### T423 · FNF[terminal-attach] · a failed attach-count write leaves the docker attach stream open; the count is read-then-write (+1)

status: open
From the T400 review (2026-10-24). PRE-EXISTING, minor.

1. api routes/terminal.ts ~:106-112: `await incrementAttached(...)` throwing (database down) leaves the docker attach stream opened at ~:106 open; the `.catch` at ~:80 closes only the ws.
2. terminal.ts ~:317-343 moves `containers.attached_ws_count` by read-then-write, so concurrent closes lose updates (a revoke now closes several sockets of one container at once). Nothing reads the column for a decision (only these writes and a web type). Fix: one atomic `SET attached_ws_count = greatest(attached_ws_count + $d, 0)`.

### T424 · FNF[nested-repo-worktree] · gate 3 offers a commit that git add will refuse for an unborn nested repo; the review collector calls a nested repo a new file (+1)

status: open
From the T375 review (2026-10-24). PRE-EXISTING, minor.

1. worker 10-gate-3-commit.ts ~:375, ~:407-410: with an unborn nested repo (`git init`, no commit) in the worktree the whole `git add -A` fails, but the form still defaults the commit on and the failure shows only at Finalise. Since T375 the preview says why. Fix: say so in the form, or stage around it.
2. worker `_impl-changes.ts` ~:147-156, ~:447, ~:453: an untracked nested repo enters the review scope as one changed "file" `nested/`, marked 'new file' (`-uall` cannot expand an embedded repo). Downstream effect on reviewers not traced.

### T425 · FNF[orphan-gitlink] · gate 3 commits an agent-left nested repository as a gitlink with no .gitmodules entry

status: open · kind: design
From the T375 review (2026-10-24). PRE-EXISTING, consequential, low frequency. worker 10-gate-3-commit.ts ~:407-410: `git add -A` records an untracked nested repo that has a HEAD as a 160000 entry with no `.gitmodules` URL; the viewer labels it "submodule" and gate 3 reads only the exit code. Later `git submodule` commands and recursive clones meet a gitlink with no URL. Decide: refuse, warn, stage its files, or ask the user.

### T426 · FNF[db-error-params] · a failed query's error message carries its bound params (secret fingerprints, ciphertext, container env) into logs and the browser (+1)

status: open
From the T422 review (2026-10-24). PRE-EXISTING, consequential in kind, rare (mechanism read from source, not triggered).

1. drizzle-orm 0.45.2 builds `DrizzleQueryError.message` from every bound param (drizzle-orm errors.js ~:12). Three writers bind a secret's fingerprint (first 8 and last 4 characters, shared crypto/index.ts ~:87-90) and ciphertext: shared cli-providers/provider-secret.ts ~:26-35, shared config/user-secrets.service.ts ~:92-112, worker usage-window/token-source.ts ~:39-56. api middleware/error-handler.ts ~:59 logs `err` for any unhandled failure, so a failed secret write logs up to 12 characters of the secret.
2. api routes/cli-login-banner.ts ~:328 forwards the worker's Error.message to the browser (worker queues/cli-exec/handlers.ts ~:1040, ~:1088); a failed containers insert binds env_vars (worker sandbox/login-container.ts ~:94-107).
   Fix: one sanitizer for logged and returned database errors (class name and `code` walked through `cause`, never message or params), used by the error handler and every forwarder.

### T427 · FNF[claude-token-extract] · the Claude OAuth capture depends on an exact 95-character token body

status: open
From the T422 review (2026-10-24). PRE-EXISTING, minor, latent. api routes/cli-login-banner.ts ~:199-211 `extractClaudeOauthToken`: run inline, a 100-character body is accepted and cut to 108 characters, and a 90-character body followed by "Store this token securely" is accepted with 5 characters of the prose appended. Today's tokens match; a format change would save a wrong token, which the probe should then reject visibly. Fix: end the token at the first character outside its alphabet, and test the boundary.

## Done

(One line per finished task: `T<n> — <title> — PR #<n> (<merge sha>), <date>`.)

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
