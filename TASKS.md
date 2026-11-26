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
`### T593 · consumed DB-dump upload rows expire 90 days after their task ended

status: open · kind: fix · found: D1 (#1063) owner decision 2026-11-11 · priority: P3

Owner decision: a consumed `db_uploads` row is deleted once 90 days have passed and every task that names it is completed or cancelled. Today the consumed-row expiry in `worker/src/repo/upload-reaper.ts` (`pin` ~:326-334) keeps the row while ANY task row names it, ended tasks included, so in practice it goes only with its repository.

1. Narrow the `db_uploads` pin to the rule `claimDump` already uses for complete dumps (`keptByTask` ~:363-374): a task not in `ENDED_TASK_STATUSES`, or one updated within the cutoff, keeps the row. `tasks.db_upload_id` is `ON DELETE SET NULL`, so the named tasks lose the link.
2. A Retry or reopen of such a task that reaches `01c1-restore-database` with no dump must fail with a plain sentence saying the dump expired and how to upload a new one, never a generic error. Add that control.
3. Docs: `database-persistence.md` retention paragraph.

### T594 · FNF[repo-recovery-followups] · checkout recovery and revival follow-ups (+7)

status: open · kind: fix · found: F2 (#1065) reviews 2026-11-10/11 · priority: P3
All PRE-EXISTING.

1. C1: a recovery that fails after `moveAside` leaves `dest` missing or partial with the code set; each further recovery moves it aside again, accumulating `.aside-*` siblings (`worker/src/repo/refresh.ts` ~:427-442). Fix: reuse or clean the failed destination before moving aside again.
2. C2: a task that starts after the rename can overlap the minutes-long clone while `dest` is absent (`refresh.ts` ~:509-520); a start does not read the root claim (`repository-refresh.md` :18-19). Fix: task start refuses while a root claim of a rebuild is held.
3. C3: `reconcileStrandedCloningRepos` writes `error_code = null` (`worker/src/data-migrations.ts` ~:478), so a recovery stranded by a worker death becomes an ordinary Retry. Fix: keep the code.
4. C4: the task page offers Retry on a failed task whose repository was deleted until the click returns the 409 (`web/src/app/(app)/tasks/[id]/page.tsx` ~:1948). Fix: hide it on the structural NULL repository.
5. C5: a Rebuild clicked right after Cancel can race the asynchronous teardown touching the worktree under the checkout. Fix: count tasks with a pending teardown as holders.
6. R1: `refreshRepository` flips an ordinary refresh of a `ready` repo to `cloning` unconditionally (`api/src/routes/repos.ts` ~:3606-3620).
7. D4a: dead-task revival polling for transient holds is unbounded (`worker/src/queues/dead-task-boot.ts` `retryHeldRevivals`). Fix: cap or back off, log once.

### T595 · FNF[root-merge-runapp-followups] · run-app commit and root merge fence follow-ups (+15)

status: open · kind: fix · found: E1 (#286, #271) reviews 2026-11-10/11 · priority: P4
All low.

1. An index-refresh failure after a landed run-app commit (`worker/src/repo/git-preview.ts` ~:148-160) fails the step; the Retry that recognises the landed commit skips the refresh, so it is never repaired. Fix: re-run the refresh on that Retry.
2. `99-run-app-ready.ts` ~:440 `catch {}` hides database and git read failures behind a form reopen. Fix: reopen only on a structural mismatch; surface read failures.
3. Each reopen re-runs the whole `detect`, including `ensureAppServing` and the in-runner browser navigation (`99-run-app-ready.ts` ~:113-146), resetting the user's VNC browser to the app root.
4. The DAG put-back throws generically where 12 halts Retry-able (`merge-resolver.ts` ~:1081-1095); `putBackIssueProjections` warns through a fresh row while `m.current` stays stale, so a last-in-pass note can be lost.
5. The `reopenedFormNotice` stays in `form_schema` of a row that later completes (display only).
6. More than 500 changed files: `detect` runs `gitPreview` twice before discovering `truncated` (cost).
7. Test gaps: a frozen legacy run-app form through `advanceStep` end to end; Skip, CLI switch, failed-task form submit and the worker `refuseRevive` branch of the root merge fence; a DAG projection-only conflict on the already-open path.
8. Stale log wording `dead-task-boot.ts` ~:333; misleading test title `branch-revert.test.ts` ~:368; `root-merge-redrive.test.ts` ~:15 mocks into `shared/dist` by a relative path.
9. `ReopenStepFormError` messages in plan steps are internal control text (not shown since the notice is opt-in); reword if ever shown.
10. A branch switch found at the push seam becomes a best-effort "push failed" note whose text says put-back was stopped and to retry, though put-back already ran and the step finished (`99-run-app-ready.ts` ~:506-532). Fix: a push-seam text variant; pin which outcome each seam gives.
11. A Retry after a branch switch that followed a landed commit reopens the form instead of naming the branch the commit landed on.
12. `computeUnregisteredGitlinks` builds `entries`/`mayAddGitlink` in pinned mode and spawns `read-tree`/`diff-index` for an empty scope (`_gitlink-registration.ts` ~:228-269). Harmless cost. No control that a gitlink already in the parent, or one the preview only moves, is not judged.
13. Preview test gaps (verified by emulation only): intent-to-add, `git rm --cached` of a non-ignored file with its copy kept, untracked nested repo, staged gitlink, unmerged, and the Retry rebuild after a commit that removed an ignored tracked file (`repo/git-preview.test.ts`).
14. Gate 3's commit diff (`_commit-diff.ts` ~:213-225) shows work-tree bytes for assume-unchanged or skip-worktree entries while `git add -A` keeps their staged bytes, so gate 3 can commit bytes it did not show. PRE-EXISTING; run app now refuses such a preview, gate 3 does not. Medium-low.
15. One process spawn between the second branch check and the index-only reset stays open (git has no atomic HEAD-and-ref check; documented in workflow-commits.md); at worst a reviewed path's staged entry is reset on the newly checked-out branch.

### T599 · FNF[rules-reconcile-followups] · task-end rules re-render follow-ups (+8)

status: open · kind: fix · found: B (#443, #386, #317) reviews 2026-11-10/11 · priority: P4
All low unless marked. Code in `worker/src/project-state/task-end-rules.ts` and `sync.ts`.

1. The repository path-mismatch refusal (`task-end-rules.ts` ~:62-63) is transient by design but has no test.
2. The `holder`, `reset` and `git` guards are tested for keeping the intent, not for a later successful retry (`upgrade-apply-rules-stamp.test.ts` ~:322-395; `journal` is the only retry control).
3. The no-outbox-row path is covered by the fake DB only; `project-state-writer-postgres.test.ts` is not in CI GATED (`ci.yml` ~:464). PRE-EXISTING.
4. A `deferred` intent whose incoming file is conflicted or rejected keeps the row in the 10 s sweep with no log line (`sync.ts` ~:1197-1205). PRE-EXISTING.
5. Tooling save and conflict resolve owe no rules-region render (`tooling-upgrades.ts` ~:855-861, `resolve.ts` ~:609). PRE-EXISTING.
6. Reset and repository delete clearing the intent have no test; the uncommitted re-render may trip a later `--ff-only` refresh; `sync.ts` and `task-end-rules.ts` import each other.
7. Carried from earlier rounds, not re-verified: an `''` override leaves an empty AGENTS.md region; `loadCliRulesRenderHashes` ignores `backfill` rows; rollback availability after a backfill row.
8. Any successful sync caller may now write AGENTS.md when it drains a ready intent; confirm no caller runs while a checkout write it does not own is in flight.

### T600 · FNF[rag-accent-followups] · accent-insensitive lexical search follow-ups (+8)

status: open · kind: fix · found: K (#145) reviews 2026-11-10/11 · priority: P4
All low unless marked. Code in `shared/src/rag/lexical-config.ts` and the RAG schema ensure.

1. Accented queries miss rows until the backfill has restamped them; no progress or completion signal.
2. Losing the `unaccent` extension later (dropped, privileges revoked) is not detected; the store keeps the accent configuration's mode.
3. The global KB store upgrades to the accent configuration only at worker start (ensure runs once); a repository store on its next ensure.
4. The global retry backfill sweep runs without the store's schema lock.
5. `RAG_TSV_BACKFILL_PREDICATE` scans the whole table each pass (no index can serve it).
6. Restamping every row churns the HNSW and GIN indexes on large stores.
7. Global-store refusal coverage (0A000/58P01/42501) is fake-connection only; no Postgres control.
8. The test of the identifier stamp inside prose checks only the parser, not a stored vector.

### T601 · FNF[revalidation-followups] · validation order, revalidation and 06 in custom types follow-ups (+12)

status: open · kind: fix · found: F4 (#334) reviews 2026-11-10/11 · priority: P4
All low unless marked. Code in `worker/src/queues/validation-recheck.ts`, `07b-phase-4-validate.ts`, `task-queue.ts` and `06-run-config`.

1. 06 reads stored defaults back as presets: answers 06 wrote itself cannot be told apart from a type's presets, so a Retry shows the previous run's stored answers as defaults.
2. 08a's setup and verify answers collapse into one value in the preset mapping.
3. The API pin of 06's catalog entry is not a red control.
4. The merge fixer can run before the env prelude.
5. A fix-loop Accept does not re-run the revalidation hand-off (`task-queue.ts` ~:2702).
6. A stale catalog can be served for a window after a module update.
7. Module and catalog steps cannot declare `editsCodeOrTests`; only built-in and prompt steps can (`validation-recheck.ts` ~:86).
8. Unverified: a prompt step with `tool_use` but no `file_write` may still write into the worktree through a shell tool, and would reach commit unvalidated. Check, then decide.
9. `.ddev` is matched as any path component (`07b-phase-4-validate.ts` ~:1062), so `docs/.ddev/` or `vendor/x/.ddev/` costs a reconcile round.
10. Persisted 07b outputs from before the snapshot field turn the first fixer pass after upgrade into one extra 07c + 07b round (transitional); a missing before-snapshot writes the whole change list into the event payload.
11. The no-07c PG controls prove only the cap-escalation arm (`handle-result-lost-db.test.ts` ~:499 seeds `maxFixRounds: 0`); the `unreadable` arm returns before reading a snapshot, so it does not exercise a read failure.
12. `ValidationSnapshotError` is reused for the missing-07c configuration error (naming only); `step.done` is no longer written before a snapshot failure of the same hand-off.

### T602 · FNF[repair-recovery-followups] · repair-needed checkout recovery follow-ups (+18)

status: open · kind: fix · found: F2 (#460, #512) reviews 2026-11-10/11 · priority: P3
Low unless marked. Code in `worker/src/project-state/refresh.ts`, `worker/src/queues/repo-queue.ts`, `api/src/routes/repos.ts`, `shared/src/repo-rebuild.ts` and `worker/src/project-state/write.ts`.

1. CONSEQUENTIAL, PRE-EXISTING: bases advance before publication of the rebuilt checkout.
2. CONSEQUENTIAL, PRE-EXISTING: a task start after the move-aside can overlap the rebuild's clone (documented window in `repository-refresh.md`).
3. A non-recovery rebuild never settles a pending project-state write intent (PRE-EXISTING).
4. `.rebuild-*` and `.aside-*` folders are never cleaned (see T486).
5. A check-only job queued during a recovery fails on the root claim and flips the row to `error` while the recovery still runs (a second recovery is still refused).
6. A failed recovery or failed enqueue relabels `source_repair_needed` as `checkout_repair_needed` (`repo-queue.ts` ~:62-67, `repos.ts` ~:3680).
7. "Check repair" writes the repair code it read with no compare-and-swap, so a stale tab can re-stamp it on a healthy row.
8. `findWorktreePathClaimant` (`worker/src/repo/worktree-claims.ts` ~:59-70) cannot see a legacy-only worktree sharer (the rebuild refusal now can).
9. `repos.ts` ~:3620 `checkCheckoutOnly || recovery ? repairErrorCode : null` equals plain `repairErrorCode`; the condition hides the invariant (nit).
10. Legacy journal stage regex duplicates `JOURNAL_STAGE_PREFIX`.
11. The intent marker is coupled to `discardWriteIntentOnFailure`.
12. A null-marked intent on a replaced tree refuses forever.
13. The in-transaction intent recheck before the move is untested.
14. Settle lstat errors are not wrapped.
15. The final revival test matrix was only partly shown red.
16. Fence PG race control missing; the mirror holds the task key.
17. Doubled "but" in a refusal message.
18. CI budget: the gated Postgres step is at 134 of 138 rows its 26-minute limit holds; measure before the next raise (`docs/architecture/ci-smokes.md`).

### T604 · docs · document the 5 s start-admission bound against a large claim ledger

status: open · kind: docs · found: F1 (#318) review 2026-11-11 · priority: P4
DECIDED by the owner 2026-11-12: accept the current bound and document it (no publication protocol; T605 closed). A task start waits at most 5 s for the repository task lock and row admission, then answers 409 busy (`repository-task-lock.ts`). The worker project-state writer (`worker/src/project-state/write.ts:747`) holds that lock across preparation and publication, MEASURED 844-2,072 ms at 512 claim files, so a repository near the 4,096-entry cap (`shared/src/project-state/limits.ts`) can answer busy to routine starts while a write runs; retrying the start is the remedy. Document it in the topic file that covers task starts.

### T607 · FNF[a11y-sweep-2] · hand-faked React hooks in web tests (+1)

status: parked · kind: fix · found: H1 (#343) 2026-11-11 · priority: P4

1. 15 web test harnesses still fake React hooks by hand (item 7 of the old T343, partly done in #1073, which moved the touched ones to Testing Library + JSDOM). Move the rest to real React rendering or one shared helper.

[parked: diminishing returns] 2026-11-12: the inventory found 56 hook-faking web harnesses, not 15 (`.claude/tmp/codex-run/Z1-S/T607-inventory.md`). Test-only migration with no product effect; resume when a file is touched for another reason, or when a faked hook hides a real regression.

### T611 · FNF[replace-zip-followups] · Replace ZIP mode and replacement-record follow-ups (+10)

status: done 2026-11-13 #1118 (8c782c68b): item 2, an hourly sweep removes extraction stages, replacement records and superseded archives older than 24 h in active or unnamed bundle directories, never a failed bundle's; items 1, 3-10 done in #1083; lows in T633 · kind: fix · found: J (#487) reviews 2026-11-11 · priority: P3
Owner decision 2026-11-12: item 2: a periodic sweep deletes stages and sidecars no live replacement owns and older than 24 h; a superseded archive is deleted once its replacement has committed.
Low unless marked. Code in api `routes/bundles.ts`, worker `bundle-ingest.ts`, `data-migrations.ts` (stranded-replacement sweep), web `bundle-composer.tsx`.

1. (PRE-EXISTING, consequential) Replacement admission holds a DB transaction open during its Redis job check (`bundles.ts` ~:899). Do the Redis check outside the transaction or bound it.
2. Orphan `.haive-extract-*` stages, superseded archives and `.replacement.json` sidecars accumulate; nothing collects them.
3. The replacement record compares inode only; compare dev and inode.
4. The committed-replay path (record says committed, tree already swapped) has no test.
5. A replacement record path that is a symlink or directory strands the bundle permanently in the sweep.
6. The sweep's count log wording counts attempted rows as recovered.
7. (PRE-EXISTING) `lastSyncError` may keep filesystem or git paths (`bundle-ingest.ts` ~:110).
8. The composer drops the API's refusal reason and shows a generic error.
9. The catalog parse holds a pooled connection while it reads the archive.
10. The fence that keeps the replacement record out of the catalog is not pinned by a test.

### T620 · design · reaper for a live owner's timed-out login container

status: done 2026-11-13 #1120 (9dde1d292): per-attempt Redis lease (60 s TTL, 20 s renewal, compare-and-delete), worker reaper at boot and every 30 s removes a login container whose lease is absent, nothing on an unreadable or silent Redis, 13 min grace for pre-lease containers; lows in T636 · kind: design · found: #1088 review 2026-11-12 · priority: P4
Owner decision 2026-11-12: lease with heartbeat: the holder renews a short Redis lease; the reaper removes the container only after the lease expires.
When an api process that still holds a CLI login's auth lock times out the login container, nothing removes it, and a restart forgets it. A permanent quarantine table was tried in #1088 and reverted: after an api restart it refused the scope forever. Needs a mechanism that tells a dead owner from a live one (lease with heartbeat, or a container label checked at boot) before anything removes the container or blocks the scope.

### T622 · FNF[terminal-close-codes-followups] · terminal close-code follow-ups (+3)

status: open · kind: fix · found: S1 (#1091) review 2026-11-12 · priority: P4

1. `InlineMarkdown inline` mode's phrasing-element allowlist has no test of its own (web components/markdown). Coverage.
2. Inline mode always applies soft line breaks. Minor.
3. (PRE-EXISTING, unverified) The browser VNC and IDE upgrades answer HTTP 503 while their runtime starts; check whether those clients would benefit from a close code.

### T623 · FNF[gated-ratchet-and-bundle-recovery-lows] · gated-file ratchet, bundle recovery and follow-up lows (+12)

status: open · kind: fix · found: #1093, #1094 reviews 2026-11-12 · priority: P4

1. The gated-file ratchet (`scripts/test/ci-gated-list.test.mjs`) does not follow a guard through a helper function, and does not scan `modules/` or `tests/` (no gated files there today). Minor.
2. The T117/T118 test guards no longer refuse the default port; they still need the opt-in env and a dedicated database name. `checkout-watch-queue.test.ts` obliterates its queue on the Redis db the env names. Minor; a comment would do.
3. Bundle recovery (#1094): a Replace complete that resumes the same upload while a claimed restore runs is admitted; the settle refuses, but the restore's renames can overlap the resumed ingest (documented in worker-restarts.md). Fix direction: refuse a resume of a `syncing` row whose `updated_at` is a fresh recovery claim. Minor.
4. Bundle recovery concurrency tests use the fake database (no `FOR UPDATE`); the real-PostgreSQL script the driver used is not committed. Commit it as a gated test.
5. A bundle job failing against a row already `failed` no longer refreshes `lastSyncError` (`worker/src/repo/bundle-ingest.ts` ~:317). Cosmetic.
6. `restoreReplacementBundle` returns true when `recoverBundle` skipped because the id was held (`bundle-recovery.ts` ~:210-222): harmless, but "handled" is not "restored".
7. (#1095) A crash between the plan-merge discard's report commit and its teardown leaves the worktree and merge open with the files already reported; a retry relocates nothing new (same trade as `integrateOrigin`). Minor.
8. (#1095) `worker/test/plan-merge-followups-db.test.ts` runs its pool with a 1 s `statement_timeout` for every statement; a very loaded runner could trip it. Minor.
9. (#1096) The fake database rejects a conflict `setWhere` built from an `excluded.*` SQL fragment (loud by design); a test needing it uses a real database. Minor.
10. (T606 3, 5, 12, report-only) Refresh run ordering uses the worker clock; skipped sources are recorded only for prices and shown as raw tokens; probe and sign-out results are not durable.
11. (#1097) For a standing re-sync reason, the first caller's flow name is the one logged; a later route with the same reason stays silent (intended). T608 items 5 (copied-map judged entry) and 6 (no lifetime bound, 0644 heuristic, design) stay open.
12. Flaky: `worker/test/project-state-write-bounds.test.ts` "writes a ledger of 4,090 claims" timed out at 120 s in two full suite runs under load; passes alone in about 35 s. Fix direction: raise its own timeout or shrink the fixture.

### T612 · FNF[web-origin-proxy-followups] · cross-host web-origin proxy follow-ups (+1)

status: open · kind: fix · found: H2 (#435) review 2026-11-11 · priority: P4
Code in web `lib/api-proxy.server.ts`, `lib/api-base.server.ts`, `app/api/haive/[...path]/route.ts`, api routes serving inline files.

1. DONE #1087. The raw-file browser control (top-level SVG cannot run script) was never shown red against the old headers.
2. The Next standalone server entry is not exercised; the harness runs `next build` + `next start` from source.
3. DONE #1087. An empty-string `HAIVE_PUBLIC_API_URL` in the `resolveServerApiBase` chain: confirm it falls through rather than resolving to an invalid base.
4. DONE #1087. The notification sound route serves inline without `X-Content-Type-Options: nosniff`.

### T613 · design · code-server shares the web origin in cross-host proxy mode

status: done 2026-11-12, all five PRs merged: PR 1 #1100 (3c87c6f02), PR 2 #1102 (24f309b1a), PR 3 #1107 (eb9531bd8, web opens the editor through single-use grants, web /ide relay removed), PR 4 #1108 (4f68bcd9c, /ide accepts only the editor session). Live-checked on main 2026-11-12: the repository editor opens through ensure, grant, bootstrap and redeem with the editor session only; WebSockets connect; reload mints a fresh grant; the app session alone gets 401 on another repository's /ide. PR 5 docs #1109 (6096c4fdd). Residuals (shared editor origin, WS outliving the 8 h session) are in T627; path lows in T626 · kind: design · priority: P2
DECIDED by the owner 2026-11-11: separate editor hostname (e.g. `ide.<domain>`) with a scoped handshake token for cross-host installs.
APPROVED by the owner 2026-11-12 with a constraint: single-host installs (localhost, a company's internal network, one hostname for web and api) must keep working with no new setting. Design draft (M2 map, no code): `.claude/tmp/codex-run/M2-S/codex-1/design.txt` (`HAIVE_EDITOR_ORIGIN`, hashed single-use handshake + editor session tables, editor-host dispatch; cross-host refuses `/ide` without the setting).
In cross-host mode `/ide` is proxied on the web origin, so code-server (which runs repository code) runs with the app's origin and can reach its API session. Options: a separate editor hostname (needs DNS/TLS per install), an API-host editor with its own scoped handshake token, or a sandboxed opaque-origin iframe (code-server may need storage it then lacks). Costs: `.claude/tmp/codex-run/H2-S/codex-2/editor-options.txt`. Needs an owner decision. Same-hostname installs are unaffected.
PLAN 2026-11-12 (approved): same-host installs are NOT unaffected: the host-only session cookie reaches the api port and `trustedOrigins` admits the api origin, so the editor on `:3001` holds the session too. Editor origin = `HAIVE_EDITOR_ORIGIN` if set, else the api's public origin (a separate hostname in cross-host mode, so no new DNS). Layers: editor origin untrusted for app routes; `Sec-Fetch-Site: same-origin` refuses the app session off `/ide`; `/ide` takes only a scoped editor session (Redis single-use grant, derived-key JWT, no migration).

### T614 · FNF[cancel-left-merge-followups] · cancel-left committed-merge report and Undo follow-ups (+21)

status: open · kind: fix · found: E2 (#329) reviews 2026-11-11 · priority: P4
Code in `worker/src/step-engine/left-committed-merge.ts`.

1. Every git no-exit result is treated as "cannot confirm" and reported as nothing, including a signal kill or an `EMFILE`/`EAGAIN` spawn failure that a re-drive could fix (~:65). Kept on purpose: a persistent spawn error that rethrows would hold the abandon pass forever. Narrow to `ENOENT` only if a retry bound for the abandon pass exists.
2. One report per task, from the latest landing only: with landings in two directories the earlier one is never checked (~:40-62). Reachable only with two step-12 landings in different directories.
3. DONE #1090. Undo (`undo-left-merge.ts`, #1081): a branch checked out in a linked worktree between the worktree check and `update-ref` is moved under it (seconds-wide; the update-ref CAS still holds the sha).
4. Undo: worktree paths are compared without resolving symlinks; a symlinked path refuses (fails safe).
5. MOVED to T625 (design). Undo: an `undone` settlement whose projection re-sync then fails is not re-drivable by the person; nor is a recovery still blocked after the queue's retry window.
6. DONE #1090. Undo: a base that switched branch settles as `moved`, not as a retryable refusal.
7. DONE #1090. Undo: git stderr detail is dropped from the refusal reason; no test drives a failed worktree-list read through undo.
8. INVALID (#1099 review): `restoreFeature` errors on a settled report propagate to the queue retry; nothing is swallowed. Residual is item 21.
9. DONE #1099. (#1090 low) The unsupported-git refusal names Git 2.27 for any exit before the `start` ack. Copy.
10. (#1090 low) The real-git transaction tests share a 100 ms deadline with git's own start; can flake on a loaded runner.
11. (#1090 low) The transaction callback has no timer of its own; the git calls inside it keep their bounds.
12. DONE #1099. (#1090 low) No test pins the 10 s post-commit wait or the secret-then-path scrub order.
13. (#1090 low) (PRE-EXISTING) A ref `.lock` left by an external SIGKILL of `update-ref` needs manual removal.
14. (#1090 low) Some interrupted-move detection branches have no test.
15. DONE #1099. (#1090 low) Interrupted-move recovery passes paths on argv; a large touched set can hit the argv limit. Fix: `--pathspec-from-file`.
16. (#1090 low) Recovery does not exempt the projection paths from its clean-against-index check (fails safe: refuses).
17. DONE #1099. (#1090 low) The SIGKILL test does not assert the child is unref'd.
18. DONE #1099. (#1090 low) A failure after `commit: ok` can still be reported as "Git refused". Copy.
19. (#1099 low) A failure after `commit: ok` does not re-create the feature branch until the person retries (`restoreFeature` runs after the throw, `undo-left-merge.ts` ~:845); the retry path restores it.
20. (#1099 low) (PRE-EXISTING) A reply timeout or EOF at `commit` is treated as pre-commit (`git-ref-transaction.ts` ~:159): plain "Git refused", no re-sync, kept projections put back over a tree that may have moved. Redelivery heals it. Fix: report an unacknowledged commit as unknown and run recovery.
21. (#1099 low) (PRE-EXISTING) If `restoreFeature` throws on a settled report and the finally's re-sync also fails, the re-sync error replaces the original and nothing logs it. Fix: warn-log the original in the finally. Also item 11: the 32 KiB recovery batches run inside the lock callback, about 3 git spawns per batch.

### T624 · ops · Lint/Unit CI job runs near its 20-minute limit

status: done 2026-11-13: all batches merged: CI unit matrix #1101 (65dff5ead), rule doc #1103 (d576c1e31), 3a limits at small scale #1104 (f4eb14334; 260 s -> 7 s), 3b fake timers #1105 (c5deec93c; 129 s -> 9 s), 3c git fixtures #1106 (32a2705a5; 133 s -> 116 s; further git batches save under 60 s each, so stopped). Unit jobs on main 3-6 min (d576c1e31, 24f309b1a); close after a third main run under 10 min · kind: ops · found: #1099 CI 2026-11-12 · priority: P3 Closed: five consecutive green main runs (4a716fa22 through 2daca69a7) ran each unit job in 3-6 min. Flake source in T631
Owner direction 2026-11-12: make tests fast and minimal rather than only raising limits; plan approved (`.claude/tmp/codex-run/T624-S/plan.md`): CI unit matrix first, then a testing rule doc, then batches (bounds at small scale, fake timers, git template fixtures). #1098, #1099, #1100 all cancelled at 20 min.
`lint-typecheck-test` (`.github/workflows/ci.yml` ~:36, `timeout-minutes: 20`) took 12-19 min on recent main runs; #1099 and the docs-only #1098 were cancelled at 20 min in "Module scripts", and a re-run passed. Measure per-step time over recent runs, then raise the limit to a measured budget (as the gated step did in #1093) or split the job. Not an outage workaround: the job grew.

### T626 · FNF[editor-proxy-paths] · editor proxy path hygiene (+2)

status: open · kind: fnf · found: #1108 review 2026-11-12 · priority: P4

1. `api/src/routes/ide.ts` `isPortProxyPath` does not see `//proxy/80`, `/%70roxy/80` or `/proxy%2f80` (encoded letters or slash in the first segment); the HTTP side is identical. PRE-EXISTING, minor: `--disable-proxy` is the second guard, and code-server's own decoding is unverified. Fix: decode the first segment as Hono does before comparing, as `apiProxyTarget` does on the web.
2. Five copies of `rawUrl.split(/[?#]/)[0]` (`ide.ts`, `terminal.ts`, `terminal-shell.ts`, `cli-stream.ts`, `browser-vnc.ts`); PRE-EXISTING, minor. Fix: one helper in `lib/upgrade-auth.ts`.

### T629 · fix · learning step retries a valid empty learning list

status: done 2026-11-12 #1112 (ce10052bc): retries only unparseable replies or drafts all rejected by the grounding bar; a genuine empty list keeps its sync proposals; 11b also commits accepted KB sync changes and learning deletions. Open: a sync-only reply that omits `entries` still retries and discards its proposals (11-phase-8-learning.ts ~:496, prompt-contract decision), and a rejected-draft re-roll drops that reply's KB/skill sync proposals (pre-existing) · kind: fix · found: T300 second run 2026-11-12 · priority: P3
`11-phase-8-learning.ts` `shouldRetryPreForm` (~:1345-1350) retries whenever `parseLearningOutput` returns an empty list. A small task can honestly have no learnings: the T300 workflow's learning call exited 0 with valid JSON `entries: []` plus three KB-sync changes and one skill-sync operation, and the step still requested a retry (paid, and it discards the sync proposals). Fix: retry only when the output does not parse (null), not when it parses to `[]`; check the form and apply accept an empty list with sync changes. Evidence `.claude/tmp/codex-run/T300-S/run7/learning-stop-evidence.json`.

### T628 · fix · 07_5 verify-files reports skills missing before they are generated

status: done 2026-11-12 #1114 (6d504d893): 07_5 drops the skills check; 09_6 also checks 09_5's recorded ids and offers Repair only for skills with a directory; 11-final-review counts the task's resolved CLI destinations. Open, unverified: hard-coded `.claude/skills` defaults in 12-post-onboarding.ts ~:333 and _stage-paths.ts ~:14; 09_5 prompt wording names only `.claude/skills` · kind: fix · found: T300 second run 2026-11-12 · priority: P3
`07_5-verify-files.ts` (~:78-84) counts `.claude/skills/**/SKILL.md` and records `skills_dir passed:false, found 0` on every fresh onboarding, because `09_5-skill-generation` writes skills four steps later. `apply` only logs, so onboarding continues, but the step reports a failed check that is always false (the T300 driver stopped on it). Same class as af1845fc3 (the KB assertion moved to where the KB exists). Fix: drop the skills check from 07_5 (09_6 verifies skills), or move it after 09_5; also check that it reads the active CLI's skills destination, not only `.claude/skills/`. Evidence `.claude/tmp/codex-run/T300-S/report5.md`.

### T627 · design · per-runtime editor isolation residuals

status: parked (OWNER DECISION 2026-11-13: accepted for local single-user use, folded into T652) · kind: design · found: T613 PR 2 review 2026-11-12 · priority: P4
All editors share one editor origin, so script in one editor can request another runtime's `/ide/<target>/` while the browser holds that runtime's editor cookie (8 h). A per-runtime hostname would close it but needs wildcard DNS and TLS per install. Separately, an open editor WebSocket is not closed when its 8 h session expires, only on revocation (same as the app's sockets). Both documented in `docs/architecture/sandbox.md` (editor section). Needs an owner decision before any build.

### T625 · design · re-drive an Undo whose re-sync failed after settling

status: done 2026-11-13 #1121 (5db613230): `merge.left_committed_resynced` records a finished re-sync; owed reports show a Retry (`POST /tasks/:id/merges/resync`) that re-syncs only, after a strict hand-back; lows in T637 · kind: design · found: T614 item 5, #1099 drive 2026-11-12 · priority: P4
Owner decision 2026-11-12: build the durable re-sync-owed marker with a visible Retry; P4 queue.
An `undone` settlement whose projection re-sync then fails cannot be re-driven by the person, nor can a recovery still blocked after the queue's retry window (`worker/src/step-engine/undo-left-merge.ts`). The smallest fix needs new state: a durable "re-sync owed" marker on the settled report that the plan-mirror sweep or a person-visible Retry can drain. Needs an owner decision before any build.

## Done` (`T323 — <title> — PR #N (<merge sha>), <date>`).

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

- T334 — 07c reconciles the runtime before 07b validates (migration 0226 reorders stored types), a later code or test edit before gate 3 hands off a bounded revalidation round, and custom task types can include 06-run-config ordered before the steps that read its answers — PR #1069 (1bfa2871b), 2026-11-11; dev 0226 changed 0 of 12 rows (pre-deploy export kept). Follow-ups T601.
- T145 — lexical RAG search is accent-insensitive through a store-local unaccent text search configuration (with a recorded verbatim fallback when the extension is unavailable) and a backfill of existing vectors — PR #1071 (34dbd0bb4), 2026-11-11; dev global KB live-checked. Follow-ups T600.
- T271 + T286 — a DAG level merge settles Haive's project files from the integration branch; root starts, Retry, Resume and revival refuse during another task's open same-branch merge; run-app Finish commits only the reviewed, pinned tree with a parent compare-and-swap and branch checks, and a Retry after a failed put-back pushes its landed commit — PR #1066 (73b7c672b), 2026-11-11. Follow-ups T595.
- T443 + T386 + T317 — a rules-override import is deferred during a live upgrade and the task-end import (onboarding and onboarding_upgrade) re-renders the AGENTS.md region through `project_state_outbox.rules_reconcile_intent` (migration 0227), retried on transient refusals and dropped with one warning on permanent ones; the updater keeps its hold when an upgrade died before recording its found state; a stamped RTK choice wins against the first record import — PR #1064 (0106f9edd), 2026-11-11. Follow-ups T599.
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

status: open (item 5 parked; item 4 done #1063) · kind: fix · user decision: resolved 2026-11-01 · priority: P2
All PRE-EXISTING.

5. Latent, minor: the reaper removes a path without checking it is still the file it lstat'ed (upload-reaper.ts removeFile); fs-safe's lstatNoFollow returns numeric Stats, so dev/ino cannot be compared losslessly. Cannot bite today (upload names are fresh UUIDs). Fix: a bigint lstat identity export in fs-safe, compared before the unlink.

User decision 2026-11-01: Retain complete/consumed upload metadata 90 days; protect active or retry-needed rows. Item5 identity-hardening remains parked until reachable impact.

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

status: parked · reason: second capped run done 2026-11-12 (5 PASS + editor check); the remaining members need dedicated scenarios, not another general run · kind: capped validation · priority: P1
Owner decision 2026-11-12: run it once T613 has shipped (same capped budget), so it also exercises the new editor path.
Second run 2026-11-12, $5.02 notional in total, one repository (426b6077), one completed onboarding (3ad907de) and one workflow (2b333940) through gate 3 (local commit, no push). PASS: T293 (agent-written KB correction, bytes changed, README untouched), T299 (named-file selectForDispatch, zero tokens), 3 (agent_rules stamps on 28 calls), 4 (declared custom test ran, Off lint did not, gate 2 labels it off), 5 (AGENTS.md 12.6 KB with citable rules). Session browser check: the task Editor opens through ensure, grant, editor-origin handshake, redeem and the scoped editor session on a live worktree. Product findings: T628 (07_5 reports skills missing before 09_5), T629 (learning step retries a valid empty list). Five earlier launches stopped on driver harness mistakes or a monitor timeout, all before or around product work ($0.26). Still UNVERIFIED: 1, 2, 6, 7, 8, 9, 10-14, 16-20, T375, T395, T363, T427, T298; each needs its own scenario (all-CLI listing replay, plan build, DDEV, conflicting merge, Stop UI, OAuth bytes, graded data). Evidence `.claude/tmp/codex-run/T300-S/report4.md` to `report7.md`, `member-results7.json`.
Preflight 2026-11-12 (read-only, $0): blocked before GO. Host C: had 18.75 GiB free, under the run's 20 GiB reserve, and the chosen Codex provider's usage poll answers 401 (last successful run 2026-11-01). Needs the owner to free disk (or lower the reserve) and confirm or replace the provider. Evidence `.claude/tmp/codex-run/T300-S/preflight.md`.
Owner decision 2026-11-10: second capped run approved, same budget (one owned repository, one attempt, 90 min or $50 notional, no automatic retries); house-rules checks first. T298 and T299 stay blocked on it.
Items 1-20 (each with its memory file): skills per CLI after 09_5; frontmatter YAML; agent_rules stamp; declared verify commands; invariants-doc lever; prompt guard/fence (07_7); onboarding artifacts; plan breadth refusals; agent isolation 1/2/4; fs-safe live verification; #169 DDEV runner boot-subpath; #241 Terminal cwd; AGENTS.md split citations; parked experiments (Astra vs Sol, container-cleanup race, global KB purge, haive_rag_ddevtest drop); T293; #287 EROFS on state; #800 mounts; #751 set-aside on a real merge; #806 put-back; #815 reindex spot-check; T375 gate 3 on a worktree holding an untracked nested repo, with and without a commit (#909); T395 Stop offered for a running task whose current row is pending, and the "Nothing was running to stop." notice (no such task on the dev install; pressing Stop changes a real task) (#908); T363 New Task with one failed upload, the plan starter and the task page Start, each with confirm yes and no (#913). Full list: task #300 text in the fnf-run ledger / memory. Also owed (T427): replay the raw attach bytes of one real `claude setup-token` run through the OAuth capture and pin its wrap, newline and escape shapes in a fixture.

User decision 2026-11-01: schedule one dedicated capped validation run BEFORE feature work. Precise cap is being selected; one owned fixture/attempt, no automatic retry loops. A run does not by itself prove enough graded data for T298; report unverified members at the cap.

Final budget: One owned fixture/attempt; stop at90 minutes or $50 notional usage, whichever comes first, or at an unexpected failure. No automatic retry loops. Run before new feature implementation as requested. Prioritize T293/T298/T299 evidence in one fresh onboarding/workflow attempt. Owned fixtures only; no unrelated Astra/Sol benchmarking, real-user Stop/authentication, global-KB purge or legacy database deletion is implied. If a cap or unexpected failure stops the run, report the unresolved checks rather than retrying or declaring them verified. T298 still needs graded evaluation evidence before similarity is enabled.

Execution 2026-11-01T15:21Z: read-only preflight begins under the90minute/$50notional cap. One owned fixture/attempt; do not start live onboarding or spend on CLI/model probes until the session confirms final P0 worker source is loaded. No automatic retries; stop at cap or unexpected failure and preserve unverified members.

Stopped 2026-11-01T15:52Z: selector fixture was checked before Git initialization, producing changedFiles:null and unreadable-change fallback. No product selector defect established; no onboarding/workflow or model calls ran (0invocations/$0notional). Owned task cancelled, own rule unenforced, records retained, watcher exited. All26checks remain unverified; original no-retry rule honored. A fresh owner decision is pending for one corrected attempt within unchanged16:51UTCdeadline/$50ceiling($40stop). Evidence T300/report.md/finalreceipt.json/member-results.json; do not treat scenario failure as demonstrated product bug.

Owner approval 2026-11-01T16:32Z: one corrected attempt in SAME retained fixture, normal onboarding before selector check; original16:51:08UTCdeadline and$50ceiling/$40stopthreshold unchanged. No further automatic retries. Initialattempt/stoprecords retained, no productdefect inferred. Local heavytests held during livephase.

Corrected attempt stopped 2026-11-01T16:55Z: T293 reproduced during normal09_3. Agentuid1000 facedroot:root0755KBdirectory/0644files, honestfailedwrites/kbWrites[]; Haive stilldone/correctedCount1/noerror andunchangedKBhash.9finalizedinvocations/$1.0203736notional; stopped16:45:41 beforedeadline, no newround/retry/thirdattempt, allownedtasks cancelled/dataretained/rulecleared/watcherexited.1agent-rulesPASS,1T293FAIL,24UNVERIFIED(includingT298/T299; Git12notreached). Userfirstquestionapprovedexactlyonecorrectedattempt, nowconsumed. Evidence T300/corrected-report.md/corrected-finalreceipt.json/member-results.json; no morepaidvalidationwithoutnewapproval.

### T298 · house rules PR8 · switch similarity on with per-rule floors

status: open (owner approved 2026-11-16 a bounded paid collection of graded selection data on owned fixtures, ~$10-15) · was blocked-by: graded evaluation data · priority: P3

Validation scheduling decision 2026-11-01: attach to the dedicated capped T300 run before feature work; actual evidence/data prerequisites remain, and no successful live result is inferred.

The owner scheduled one capped validation attempt; this block is an evidence dependency, not an unanswered policy question.

### T299 · verify-first · house rules PR7a zero-token live check

status: done 2026-11-12: verified in the T300 second run before onboarding started. Real `resolveGlobalKbContext` + `selectForDispatch` selected the owned files-mode rule for its named path (`why.via: named`, non-null change set, no unscoped fallback, zero invocations). Evidence `.claude/tmp/codex-run/T300-S/run4/t299-selector.json`; hr6-live-d7 no longer needed for this check · priority: P1
Read .claude/tmp/house-rules/ledger for a PR7a live-check entry; if absent, run it per the house_rules_series memory against repo hr6-live-d7 (3e2c0533), then decide whether hr6-live-d7 is still needed.

Validation scheduling decision 2026-11-01: attach to the dedicated capped T300 run before feature work; actual evidence/data prerequisites remain, and no successful live result is inferred.

The owner scheduled one capped validation attempt; this block is an evidence dependency, not an unanswered policy question.

### T319 · FNF[set-aside-batch] · set-aside spends 20-24 git spawns per dirty path (+1)

status: open · kind: performance · user decision: resolved 2026-11-01 · priority: P2

1. set-aside.ts:264/:281/:474/:574 per-path git reads (prototype: 6,620 spawns → 20). 2. readStateTree one cat-file per file (projection-merge.ts:157); batch with `cat-file --batch`.

User decision 2026-11-01: Re-measure current batching gain and keep scope bounded; behind functionality unless current delay is material.

### T331 · I7 · modules/integration-google (Drive, Docs, Gmail)

status: parked: needs a real GCP OAuth client from the user · was modular #42 · priority: P4
Plan I7: REST by default, remote MCP opt-in. Blocked until the user provides an OAuth client.

User decision 2026-11-01: keep live Google connection parked; prepare setup instructions when its turn comes. A live OAuth client is still an external prerequisite; never request a secret in chat.

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

status: done 2026-11-13 #1117 (d60ebc24e): Stop writes a `task.stop_settle_requested` event in its transaction, settlement writes `task.stop_settle_finished`; the stalled sweep re-drives an unfinished request after 5 min, live jobs excluded before the batch of 20, once per 5 min per stamp. Lows in T632 · kind: design · priority: P3
Owner decision 2026-11-12: add a sweep that re-queues settle/Cancel for stopped or cancelled tasks still holding something unsettled.
PRE-EXISTING, from the T393 build (2026-11-07). A `settle-stopped-task` job that was never queued (Redis down past the 2 s bound) or exhausted its attempts has no re-drive; `redriveCancelledTasks` (worker queues/stalled-redrive.ts ~:586) covers cancelled tasks only. Backstops by what is held: task auth volumes, the boot reaper only; terminal shells, the idle reaper; onboarding re-sync, the 60 s checkout sweep (project-state/watch.ts ~:121); embed model, the boot reconcile; Ollama CLI models, keep_alive; a kb_author 'enriching' entry, none. Decide: a sweep over failed tasks with unsettled holdings, or accept the backstops.

From the T355 build: `enqueueCancelJob` (api lib/cancel-task.ts ~:125, ~:145) is now bounded and can return without queueing; the same sweep would cover a Cancel whose job never reached Redis.

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

### T665 · FNF[price-tier-lows] · prompt-size price tier lows, after #1164 (+21)

status: open; context-tiered PR 3 SHIPPED #1245 (6ddda4960, 2026-11-17) and PR 4's Claude Code half #1262 (8422abc06), so the "PR 3 waits" line below is historical (corrected 2026-11-26) (2026-11-15 #1198: items 11 and 14 resolved; items 1 and 10 verified already correct on base (advisory lock and guarded close exist; the collector keeps last usage per message, the 141 output tokens appear only on the result event); OWNER DECISION 2026-11-14: overnight fix prerequisites 10, 11, 14 and 1 only; context-tiered PR 3 still waits for the complete-coverage rate measured on dev runs; the rest parked: diminishing returns (2026-11-14, owner rule: trivial lows park; resume on a user report, a measured failure or a related change; earlier: OWNER DECISION 2026-11-14: fix these prerequisites and measure the complete-coverage rate on dev runs BEFORE context-tiered PR 3 is built; items 1, 3, 4, 6, 7 and 8 done 2026-11-14 #1173 (1735eb64b): measured claude-code 2,941/3,153 and Haiku main 178/191 complete, replay tool `worker/scripts/replay-request-usage.ts`; open: 2, 5, 9, 10 and 11-17) · kind: fix · found: context-tiered pricing PR 1 · priority: P3

1. Two overlapping refreshes can race in `applyDesiredRows` (worker cli-versions/model-prices.ts ~:291): live rows are read outside the transaction and closed by id with no `effective_to IS NULL` guard, so the loser fails on `cli_model_prices_live_idx` and a stale marker can stay live until the next tick (up to 12 h of refused pricing). No corruption (the loser rolls back). PRE-EXISTING mechanism.
2. LiteLLM tiers inherit from the base, not from a lower tier, when buckets use different thresholds (shared cli-providers/model-pricing.ts ~:324). Spec-literal (plan Decision 2) and no mapped entry has differing thresholds today. Latent.
3. `refresh_runs.result` `$type` omits the new `unsupported` field (database schema); the stored JSON carries it.
4. The `unsupported` list (time-window, variable-price models) is persisted in the refresh result but shown nowhere on `/admin/pricing`.
5. A future LiteLLM text-rate key whose base name contains a modality word (audio, image, ...) would be ignored by `LITELLM_NON_TEXT_RATE_FAMILIES` instead of failing loud. Hypothetical.
6. #1167 PR 3 prerequisite: real complete rate per CLI and per main model is unmeasured; replay retained stream logs read-only (`worker/src/queues/cli-exec/stream.ts` getRequestUsage) before pricing from coverage. CONNECTED.
7. #1167 Same-name ledger rule may keep runs whose main model is the titling model (haiku) permanently incomplete (stream.ts billedMatches); if measured, relax to entry >= priced sum per bucket. Safe direction. CONNECTED.
8. #1167 An empty `result.modelUsage` ledger is still accepted as complete when prompt sums match (stream.ts reconcile loop break on size 0). NIT, PRE-EXISTING in design.
9. #1167 `contradictory-request` compares output tokens too (stream.ts ~354); if a binary updates output between content blocks of one message, runs go incomplete. Compare prompt buckets + model only if it shows. LOW.
10. Killed Claude/Ollama fallback under-counts output (stream.ts ~646: fallback output 0 vs completed 141 on the retained fixture). PRE-EXISTING, consequential for token stats.
11. #1173 PR 3 contract: the rate for same-model excess with null cache-write TTL or excess output is undefined (stream.ts ~:659). Define it in PR 3 before pricing excess. CONNECTED, consequential.
12. #1173 The replay counts absent and empty `modelUsage` only; a null, array, string or number ledger is accepted complete with both counters 0 (replay-request-usage.ts ~:178). LOW.
13. #1173 The volatile Haiku titling matcher says "fail loud" but nothing fails loud when it stops matching (replay-request-usage.ts ~:55). NIT.
14. #1173 `refreshModelPrices` can still throw out of the job: `recordSyncError` (model-prices.ts ~:131, ~:206, ~:228) and the post-apply `cli_pricing_sync` upserts (~:264-276) are unguarded; also DB failures outside price application (~:91). PRE-EXISTING, low.
15. #1173 Serialization does not stop an older fetched feed replacing newer data (model-prices.ts ~:334). PRE-EXISTING, minor.
16. #1173 The unsupported-model list on the refresh card is unbounded (web latest-refresh.tsx ~:120). PRE-EXISTING, minor.
17. #1173 Killed-run output undercount (item 10) is not quantified by the replay (~:266). Minor.
18. (#1198 driver, Connected) PRE-EXISTING, consequential: a killed run's output tokens are unobservable when its retained assistant events report output 0 (`worker/src/queues/cli-exec/stream.ts` ~:405); only the missing result event carries them. Needs a source for output usage on a kill (or mark the run's output unknown rather than 0).
19. (#1198 review) The manual `POST /prices` route (`api/src/routes/cli-pricing.ts`) takes no advisory lock, so a manual write can race a refresh on `cli_model_prices_live_idx`.
20. (#1198 review) The browser and Ruby version refreshers swallow a failed error-record write without logging.
21. (#1198 review) New refresh error entries reuse source names, so `refresh-failures.tsx` can show "price:database, price:database". Cosmetic, admin-only.

### T666 · FNF[human-time-lows] · idle-aware human time lows, after #1163 and #1165 (+10)

status: parked: diminishing returns (2026-11-14, owner rule: trivial lows park; resume on a user report, a measured failure or a related change) for items 2-10; item 1 task-page part verified live 2026-11-16 (capped run: gate-2 user_active_ms stopped at the allowance and stayed flat through 65 s of polling, UI matched); still owed: the plan page, `visibleWords` cost and null rate, the maximized and short-form allowances · kind: fix · found: human time PR 1-2 · priority: P3

1. The real-browser check of the task-page timer, and of the plan page (#1165: time accumulates during input, stops at the allowance, keeps counting through a running chat turn up to 15 minutes; `plan_active_time` rows for the hour), is owed (no live non-plan-chat task was parked at a form on 2026-11-14): allowance ~2 min inline spec, ~5 min maximized, ~1 min short form; stops with the mouse still; poll/auto-scroll does not restart; `visibleWords` cost and null rate on a real gate page.
2. A paused task still counts as plan-page pending work: pausing sets `pausedAt` and leaves the status, and the node payload (`GET /plan/nodes/:id` tasks) does not carry `pausedAt` (web plan-detail-panel.tsx ~:106). Bounded by the 15-minute pending window. Add `pausedAt` to the payload and exclude it.
3. The ordering reporter counts only the page's own start request; an ordering pass already running when the page opens does not extend attention, since the overview carries no task status (repos/[id]/plan/page.tsx).
4. The plan page Order button is re-enabled in `finally` before navigation and the route has no duplicate guard.
5. Fail-open lease counting relies on the `foreground` flag that only events update; no test pairs fail-open storage with an unfocused tab (web lib/active-time/use-active-time.ts).
6. `visibleWords` skips (does not prune) offscreen subtrees whose clip is not empty, so only the 50,000-node work bound limits them; its real cost is unmeasured.
7. `onFocus` can drop up to one tick of retained time.
8. Approximations documented in `docs/architecture/human-time.md`: positioned descendants escaping an overflow ancestor are misclipped, `pointer-events: none` text is excluded, range chunks can split a word.
9. #1166 Time tab grid went lg:grid-cols-6 -> 4, so 7 tiles lay out 4+3 (reflows existing tiles); pick a layout. LOW cosmetic.
10. #1166 Plan page tile hint does not say a dash can also mean the selected class excludes plan work (card description does). LOW.

### T664 · FNF[postgres-v4-lows] · postgres.js v4 upgrade lows, after #1159 (+18)

status: parked (items 5 and 10 resolved 2026-11-15 in #1200; the rest parked: diminishing returns (2026-11-14, owner rule: trivial lows park; resume on a user report, a measured failure or a related change)) · kind: fix · found: T655 run · priority: P3

1. Every in-repo `connect_timeout` / `connectTimeoutSeconds` is a positive constant (api rag.ts, tooling.ts, tooling-upgrades.ts, global-kb.ts; worker global-kb-context.ts, data-migrations.ts; database migrate/client.ts, cli-auth-lock.ts), and unset defaults to 30 s. Only a user DSN `connect_timeout=0` or env `PGCONNECT_TIMEOUT=0` disables the bound, and on v4 that means startup retries until the caller's own timeout. Refuse or clamp it in the user DSN guard. Low (admin-supplied DSN).
2. `pg-startup-storm.test.ts` drain waits are bounded by count, not time; the end test restores real timers outside `finally`; one bound (15) is loose. Tests only.
3. No `ssl: false` case pinned for user DSNs. Tests only.
4. `dsnDialHost`: a non-numeric port claims NaN handling the code does not have (comment overclaims); dropped positive password cases; the tests depend on ambient `PGHOST`; the `skipped.invalid` count shrank with the v4 parser. Tests and comment.
5. User Postgres DSN guard (`@haive/shared` egress/user-postgres-dsn.ts): a stored DSN already carrying a refused parameter is hidden on RAG search and re-embed rather than reported, and is not refused at save time in every path. PRE-EXISTING rows, new guard.
6. `userPostgresErrorMessage` collapses distinct error classes into one message. Low.
7. Red evidence was shown on earlier control versions only, not the final ones. Evidence only.
8. `error-diagnostics.md`: the DSN guard's scope (admin vs global KB settings) is not stated. Docs.
9. `worker/scripts/rekey-global-kb.mts` reflow noise. Cosmetic.
10. Nothing fails if a future ^4 release adds another file-reading connection parameter (the guard is a fixed refuse-list). Add a test that diffs postgres.js's parsed option keys against the known set.
11. Third-party record: Node 26 `Socket.end` type mismatch in postgres.js v4 typings (worked around locally). Third-party, needs approval to report.
12. Upgrade guidance for the next major lives in AGENTS.md; `smoke:pg-drop` and `pg-transaction-fence` must be re-run unpatched on any bump. Process note.
13. E2E helpers were missed by the first `sql.array` inventory (packages/ only); a future inventory must include `tests/`. Process note.
14. (#1200) The generic note shown for every global-KB failure has no test of its own. LOW.
15. (#1200) The RAG playground says nothing when the global DSN is refused; results just lack global hits. LOW.
16. (#1200) Admin copy for a refused global DSN could name the refused parameter. NIT.
17. (#1200) A refused local (per-repository) DSN still answers 400/500 depending on path rather than one status. LOW.
18. (#1200) The re-embed "rebuild" flag stays set after a refused DSN aborts it, so the next save retries. LOW.

### T662 · FNF[relink-reconcile-lows] · remote relink reconcile lows, after #1158 (+8)

status: parked: diminishing returns (2026-11-14, owner rule: trivial lows park; resume on a user report, a measured failure or a related change); owner 2026-11-14: items 1-3 relink races parked; item 4 resolved 2026-11-15 in #1200 · kind: fix · found: #1158 reviews and Codex bot 2026-11-14 · priority: P3

1. The sweep's own reconcile is not a registered writer, and the relink route does not wait for an in-process writer before its Git writes (`api/lib/remote-reconcile.ts` `reconcileRemote` ~:110-150, `api/routes/repos.ts` relink). A reconcile whose database connection drops during its Git calls keeps writing the old remote after the row lock is released; a concurrent relink can commit and clear a newer remote first, leaving Git on the older one with no intent left. Needs a connection drop inside a few ms of Git calls plus a concurrent relink of the same repository; the next relink repairs it. Fix direction: register the reconcile callback as a writer through its settlement, and have the route await outstanding writers for the repository before its own Git writes. Codex bot P2 on cbb25ae10.
2. Window between committing the intent and taking the writer fence in the route (the fence begins before the relink transaction, the intent row is written earlier); a sweep tick in between acts on a live request's intent on a folder import. The request answers 409 and a retry restores the origin.
3. Relink vs relink after a dropped connection: the second request takes the released lock while the first's Git writes may still run; the fence only stops the sweep.
4. No log line when the sweep skips a fenced or locked repository; a repository stuck behind a leaked fence would be invisible.
5. `server.close()` is never called in the relink test's fixture server (`api/test/git-relink-probes.test.ts`).
6. A partial `git remote add` (origin added, pushurl write failed) is reconciled only on the next tick; covered by the intent but untested.
7. No real-PostgreSQL probe for the sweep-vs-request race itself (the PG probe covers the lock skip only).
8. Naming: the `skipLocked` option of `reconcileRemote` also means "skip fenced repositories"; rename to `sweep` or split.

### T681 · Insight loop: act on consequential insights during the task, and pick insights at gate 3

status: DONE (plan docs/plans/insight-loop.md, five PRs: PR1 shared loader #1209 7c10887b1; PR2 switch #1212 863a369bf; PR3a journal #1213 7f87aa3b4, PR3b routing #1215 9fe71a666; PR4 automatic mode #1218 56ff28e48; PR5 gate-3 picks, summary report and owner-only gate-2 re-approval #1223 e64a83f33; remaining lows in T687) (OWNER DECISIONS 2026-11-14: separate triage agent classifies; 3 automatic rounds; gate 3 picks go apply -> 08 verify -> 08c review -> gate 3; build after the current overnight queue, plan first in plan mode) · kind: feature · found: owner request 2026-11-14 · priority: P2

Today agents may append `## INSIGHTS` (out-of-scope improvements, `INSIGHTS_INSTRUCTION`); DAG reviewers' withheld findings join them (`loadInsightOutputs`). Step `08e-insights-triage` shows them once as a multi-select and one agent applies the picks; gates 2 and 3 list the unpicked rest as plain text (`_gate-insights.ts`; gate 3 says "needs a follow-up task"). An `Insight` has no severity, and nothing loops.

1. OWNER 2026-11-14: one opt-in switch in the setup step `06-run-config` (beside QA depth, review dimensions and the verify options), OFF by default, stored with the run config like `simplifyCode`; the remembered prior-task form values carry it like the other run-config fields. OFF: no triage agent runs, and every insight is shown as a checkbox (at 08e and at gate 3) for the person to pick. ON: the automatic loop in item 2.
2. Switch ON: each 08e round runs a separate triage agent that classifies every new insight (consequential vs minor/nit, with kind and reason; security, data loss and regression are always consequential), auto-selects the consequential ones, applies them, re-runs 08 verify and 08c review, and returns to 08e. Stops when a round finds no new consequential insight or after 3 rounds. Identity across rounds via `findingIdentity`. Minor items and nits are never acted on and are listed in the end summary with their class.
3. Gate 3: the insight list becomes a multi-select. Ticked items go through the 08e apply path, then 08 verify and 08c review, then back to gate 3 (gate 2 is not asked again unless verify fails).
4. The end summary shows every insight with its class and outcome (applied, left as minor, cap reached).

### T708 · Plan labels in product docs

status: open · kind: docs · found: guarded span prerequisites docs (#1268) · priority: P4

`docs/architecture/task-types.md` (~:780 heading "Pinned execution declarations (P6; admission only)", ~:786, ~:851) and `docs/architecture/worker-restarts.md` (~:766) name an internal plan phase ("P6") in product text. Replace with the behaviour and the PR number (#1222). Docs-only; ride with the next change touching either file.

### T722 · FNF[claude-usage-connection] · Claude usage connection leftovers (+14)

status: open · kind: fix · found: login-set design (T720) 2026-11-19 · priority: P4

All PRE-EXISTING. Paths are under `packages/`. Check each against the shared usage connection (T720) when that lands: one refresher per set may close items 3 and 5.

1. Closed by #1292 once it merges (the POST refuses a value that is not a grant; the DELETE removes the snapshot set-wide). Was: the manual secret POST accepts any string as the usage grant, and the generic secret DELETE leaves the usage snapshot behind (`api/src/routes/cli-providers.ts` ~:1141-1190, ~:1396-1416).
2. Starting a usage connection checks only the CLI name, and the poller polls an api-key claude row that holds a grant (`cli-providers.ts` ~:1207-1230, `worker/src/queues/usage-poll-queue.ts` ~:539-551).
3. A refresh error other than `invalid_grant` goes on with the stale token, and a crash between the refresh response and the secret write loses the rotated token (`usage-poll-queue.ts` ~:212-224, ~:249-258).
4. A snapshot that is not `ok` keeps its preserved windows, which feed the allowance arm, while the recovery probe's verdict needs an `ok` snapshot (`worker/src/queues/task-queue.ts` ~:2017-2036, `usage-poll-queue.ts` ~:679-686, `allowance-watch.ts` ~:58-62, ~:103-109).
5. The providers page loads one usage-auth request per claude row (`web/src/app/(app)/cli-providers/page.tsx` ~:138-155): 41 requests on the dev install.
6. THIRD-PARTY (needs approval before any work): the vendor's refresh semantics are unverified ("single-use" is only a comment at `shared/src/cli-providers/claude-oauth.ts:48`), and the usage endpoint is undocumented (`worker/src/usage-window/fetchers/index.ts` ~:37-41).

Found with the shared usage connection (#1291 poller, #1292 api and web), 2026-11-20:

7. A settings save that changes a row's scope (isolation on or off, another auth mode) drops the row's grant and usage snapshot unconditionally (`api/src/lib/usage-grant-set.ts` ~:251-275, `api/src/routes/cli-providers.ts` ~:879-881). NEW with #1292, by design: two scopes holding one grant would retire each other. Fix direction: keep the grant when the row was alone in its old scope and the new set holds none.
8. A clone of an API-key row copies the usage grant outside the set lock, and into a second scope when the clone is isolated (`api/src/routes/cli-providers.ts` ~:1179-1183). PRE-EXISTING.
9. API-key sets are not seeded on join (the poller side of API-key rows is item 2). Gap.
10. A joiner is seeded with the newest grant stamp, not the live holder's (`api/src/lib/usage-grant-set.ts` ~:215-245), so where copies still differ it can take a dead copy until the next tick converges it. NEW with #1292, self-healing.
11. The auth-strike count is keyed per set and carries over a holder change (`worker/src/queues/usage-poll-queue.ts` ~:75-119, ~:444); the dead-token gates compare the exact token and lift on their own. The fetch context comes from the polled row, not the holder (~:451-457), which for Claude picks only the transport guard. NEW with #1291, minor.
12. Disconnect's confirm says "every row that shares its login" for an isolated row too (`web/src/app/(app)/cli-providers/page.tsx` ~:409-411). NEW with #1292, nit.
13. Test strength, each shown by a surviving mutation: the seed-path lost-lock sweeps do not pin the last check (`api/test/cli-usage-grant-set-db.test.ts` ~:1165-1205; removing it at `usage-grant-set.ts:244` or `:272` stays green); the Claude-only guard is pinned for `DELETE usage-auth` but not the secrets routes; the holder's no-snapshot tier and tie breaks are unpinned in the worker tests (`worker/src/usage-window/usage-grant-set.ts` ~:57-60); the Claude-name check lives at the call sites, not in the library. Test only.
14. Claude's `oauthErrorCode` (`shared/src/cli-providers/claude-oauth.ts` ~:147) reads the `error` code on any refused status, so a gateway 5xx carrying `invalid_grant` would count as a refusal; Grok's `oauthRejectionCode` (`worker/src/cli-adapters/grok-oauth.ts:146`) reads it on 400 and 401 only. Fix direction: the same gate. PRE-EXISTING, low; found by the #1300 driver.

### T723 · FNF[claude-login-set] · Claude login set leftovers (+17)

status: open (owner confirmed 2026-11-22 that a sign-out with a stuck volume fails closed, #1306) for items 18-20 and the left ones; #1306 DONE (9f4e22ed7, deployed 2026-11-21 15:43Z: items 1, 12, 13, 14, 17 fixed; 3 and 16 pinned by controls; 9 and 11 were already on main; 2, 4-8, 10, 15 left: 2 test-only, 4 a large fake refactor, 5-6 end with the plaintext drop, 7 web form, 8 latent, 10 third-party, 15 a disclosed decision) · kind: fix · found: #1282 build and review 2026-11-19 · priority: P4

Paths are under `packages/`. Items 2 to 4 are PRE-EXISTING; item 1 is PRE-EXISTING for the clicked row and reaches the whole set since #1282. Items 5 to 10 were found with #1283: 5 to 7 and 10 are PRE-EXISTING, 8 is NEW and latent, 9 exists since #1282. Items 11 to 13 were found in #1283's review round (lock order against the image job) and are PRE-EXISTING.

1. A sign-out deletes the login tokens of the set even when a credential volume could not be removed, while the status reset is skipped for that case (`worker/src/queues/cli-exec/handlers.ts` `handleSignOutJob`: the token delete runs before the `failed.length === 0` gate). The rows then keep their old status with no token until the sign-out is repeated. Fix direction: gate the delete like the reset, or reset the status too; decide with the retry path in view. Since #1291 the same delete also removes the usage grants and snapshots of the set (`worker/src/queues/cli-exec/handlers.ts` ~:1447-1463).
2. The own-lock branch of `saveCliLoginSecret` takes the auth lock on the scope it read before locking and never re-reads it (`api/src/lib/cli-login-secret.ts` ~:17-39). Production passes `authLockHeld = true`, so only tests reach it.
3. No control covers the auth lock being lost inside the sign-out transaction; the refused-update control covers the rollback only.
4. `api/test/cli-login-banner-secrets.test.ts` (2365 lines) builds a database fake by hand that must follow every query shape of `saveCliLoginSecret`: #1282 broke 417 of its tests until the fake was updated. Move its database-shaped cases to the PostgreSQL-gated files, or derive the fake from the query builder.
5. The boot copy of a legacy plaintext login token in a row's environment (`api/src/lib/move-secret-env.ts` ~:100-115) writes the one row it finds and advances no sibling, so a sign-out queued through another row of the set deletes it with the set's. No row on the dev install holds one (0 of 41).
6. A sign-out deletes secrets only: a row still holding a legacy plaintext login token in its environment stays authenticated through it, and the boot copy re-creates its secret (`worker/src/queues/cli-exec/handlers.ts` ~:1436-1456, `api/src/lib/data-migrations.ts` ~:177). Low; ends when the plaintext drop runs.
7. The web create form is two-step (`web/src/components/cli-provider-form.tsx` ~:687-697): a 409 on the secrets POST leaves the created row without its token, and a second submit creates a second row.
8. `withCliAuthLocks` (`api/src/lib/cli-auth-write.ts` ~:50-54) starts its wait deadline per scope, so N scopes could wait N times the limit; the one caller that waits passes one scope. Its retry loop repeats the worker's `waitForCliAuthLock` (`worker/src/sandbox/cli-auth-lock.ts` ~:4-15); a shared helper beside `tryCliAuthLock` in `@haive/database` would remove the copy.
9. Nothing on the providers pages says that a login, sign-out, pasted token or token delete on a row that is not isolated covers every row of its set (41 rows on the dev install), and after a set-wide delete the sibling rows keep their old status until a Test or run. Add one sentence where those actions are offered. The sentence is in #1292 (first half closed once it merges); the stale sibling status itself stays, a product decision.
10. An API-key Claude row can start a login (the login route reads no auth mode, and the page offers Log in from a Test result in either mode); the token then reaches the user's other API-key rows that are not isolated, and the worker injects it beside the API key (`worker/src/secrets/provider-secrets.ts` ~:19-22). THIRD-PARTY fact to check first: which credential the binary prefers when both are set. Then decide: refuse a login on an API-key row, or stop injecting the login token there. The dev install has no API-key Claude row.
11. `advanceVolumeLoginGeneration` (`shared/src/cli-auth-state.ts` ~:43-51, sole caller `api/src/routes/cli-login-banner.ts` ~:1399) is one autocommit UPDATE over the whole set, which locks rows in scan order. The image job (`worker/src/queues/cli-exec/images.ts` `markProvidersReady`) locks provider rows in id order without the auth lock, so the two can deadlock. Take the set lock in id order first (`lockLoginSet`), in one transaction with the update. Goes in with the rows-joining-a-set change. FIXED #1285 (bb8276fd2): it now takes `lockLoginSet` first (verified 2026-11-20, `shared/src/cli-auth-state.ts` ~:46-53).
12. The same shape in the grok credential refresh (`worker/src/usage-window/credential-refresh.ts` ~:167-181): on `invalid_grant` one autocommit UPDATE marks every row sharing the volume, in scan order. Lock those rows in id order first.
13. A task insert that names both `cliProviderId` and `summaryCliProviderId` (`api/src/routes/tasks/index.ts` ~:751-760, `database/src/schema/tasks.ts` ~:156-160) takes its two foreign-key share locks in constraint order, not id order, so it can deadlock with a holder of `FOR UPDATE` on provider rows in id order (the image job, `lockLoginSet`). Direction: those id-ordered lockers change no key and delete no row, so `FOR NO KEY UPDATE` would stop them conflicting with child-row inserts at all; check first that nothing relies on them blocking a concurrent secret insert. Rare (two share locks microseconds apart), and the loser gets a deadlock error and can retry.

14. NEW with #1285: a settings save that joins a set and types a `CLAUDE_USAGE_OAUTH` secret in the same request. The update (`api/src/routes/cli-providers.ts` ~:827) bumps `authGeneration` to supersede a queued sign-out, then the join seed overwrites it with the source row's generation (`api/src/lib/cli-login-secret.ts` ~:266), so the supersede fails when the source's generation equals the queued sign-out's payload. Narrow; no control covers a join and a typed usage secret in one save. Not reachable (verified 2026-11-20): `SECRET_LIKE_ENV_NAME` (`shared/src/constants/secret-env.ts:3`) does not match `CLAUDE_USAGE_OAUTH`, so a typed entry stays a plaintext env value and never reaches the secret path; a control in #1292 pins it. T721 item 8 stays open.
15. NEW with #1285, a disclosed decision: a clone of a row whose login token sits only in legacy `env_vars` (not yet copied to a secret row by the boot step) ends with no token, where it used to get one. The seed reads secret rows only (`api/src/lib/cli-login-secret.ts` ~:204-226). Reachable only before the boot copy has run on an install.
16. No control pins the seed's tie rule (newest token, then smallest id); a tie needs equal secret `updated_at`, which after a set-wide write means equal logins. Test only.
17. PRE-EXISTING, related: `AUTH_RE` (`worker/src/queues/cli-exec/failure-class.ts:294`) does not match Claude's own "Not logged in · Please run /login" or "Invalid API key · Please run /login" (checked against the real regex). A run on a row whose auth volume exists but holds no token (item 1, a deleted token, item 15) fails with the generic `cli invocation failed: <tail>` and no Log in hint, and the status stays `ok`, so every retry fails the same way until Test or Sign out. Only a missing volume gives `CliLoginRequiredError` and the Log in button. Fix: classify the binary's no-login line as an auth failure, with a negative control for prose that only mentions logging in.

Added 2026-11-21 (#1306 driver):

18. `worker/src/queues/cli-exec/handlers.ts` ~:1427 counts only volumes removed in this run, so after a partial removal a retry reports "Already signed out." (`web/src/lib/cli-jobs.ts`) while it just deleted the tokens. Cosmetic, newly reachable for tokens since #1306.
19. Boot `clearPrunedSandboxImageState` (`worker/src/data-migrations.ts` ~:974-976) does one unordered multi-row `UPDATE cli_providers ... WHERE id IN (...)`: the same hold-high-wait-low hazard. Select the ids `FOR UPDATE` in id order first. PRE-EXISTING; needs two or more stale rows and a concurrent login-set write at boot.
20. Doc drift: `docs/architecture/ci-smokes.md` ~:51 history clause ("raised from 40 ... and again for the 169th") is stale; only the numbers were corrected. PRE-EXISTING.

### T724 · Step 11 review cannot keep one learning the recorder plans to delete

status: open · kind: design · found: agent-memory pilot pair 2 (the treatment task's step 11) 2026-11-19 · priority: P4

PRE-EXISTING, by design today. The step-11 learning review offers `writeFiles` (every planned op or none), the KB and skill sync switches, and an instruction. A planned insert or update can be vetoed alone by emptying its staged draft in the inline editor. A planned delete cannot: a delete op gets no `editPath` (`packages/worker/src/step-engine/steps/workflow/11-phase-8-learning.ts` `learningOpsToDiffFiles` ~:1103, pinned by `11-phase-8-learning.test.ts` ~:528-529). A reviewer who wants to keep one learning the recorder calls stale must reject every op or spend a re-roll through the instruction. Seen on a real run: the recorder planned 2 new, 2 updated and 1 removed learning, and the removal could only be refused by rejecting all five. Needs a decision: a per-op keep for deletes (for example a staged tombstone the reviewer can clear) or a per-op checklist for every op. Interacts with the deletion identity records (#1202) and the replay rules in T672.

### T725 · FNF[translator-render] · Translator render step and artifact lows (+10)

status: open · kind: bug · found: translator assembly milestone (module PR #7) · priority: P4

In `martinambrus/haive-module-translator`; all NEW with the render step, none blocking.

1. `src/render/assemble.ts` (`mdInline`, `delimited`): CommonMark's flanking rules leave emphasis next to a word character, with punctuation or a code span on its inside, as literal asterisks in `translation.md` (fuzzing: 3555 of 20000 paragraphs, and 1500 documents). The HTML is faithful. Documented in the README.
2. `src/render/assemble.ts` (`mdLines`, `codeSpan`): a paragraph that is only a line break, a trailing line break, and a newline inside an inline code value differ between the Markdown and the HTML (the Markdown drops them or writes a space). Documented.
3. `src/db/artifacts.ts:54`: coverage reads `jsonb_array_length(parsed->'blocks')`, which detoasts the parsed source on every detect; the unit inventory count would do.
4. `src/db/artifacts.ts:43-46`: with no review row yet, an unfinished translation answers `review-incomplete`.
5. FIXED module PR #9 (debb7f5, 2026-11-20): the per-task list leaves strays out. Was: `src/routes.ts` artifact list: one artifact recorded for another repository turns the whole list into a 404 (as specified). Same route as T726 item 1.
6. `translation.md` in GFM viewers: bare `http://` runs become links (text only).
7. Guards no control pins: the part-count cap throw in `src/routes.ts`; the review status check and the revision comparison between the two sessions in `src/db/artifacts.ts`; `fenceIn` parts other than blocks and invalidations; the store's marker-list check; manifest bytes in `accounted_bytes`.
8. `src/migrations/0008_artifacts.sql:17`: no index serves the cross-task artifact order of `GET /artifacts` (module PR #9); measured fine at 5,000 artifacts for one owner, more needs a numbered migration. PRE-EXISTING.
9. Translations page and routes (module PR #9): the Blob copy doubles a download's memory peak; `src/routes.ts:13` accepts `.` and `..` as part filenames (unreachable behind the part lookup); the server can return an empty page with a `nextCursor`, which only the page mitigates. PRE-EXISTING.
10. Download memory, measured 2026-11-21 (T735 item 2): a whole file just under the 32 MiB bound peaks at 175 to 196 MiB in the renderer plus 31 to 39 MiB in the browser process, a 4 MB part at about 31 MiB. Each part is held several times while it is read and checked (response body, decoded text, the parsed two-byte `content` string, the encoded copy, the WebCrypto digest copy, the Blob copy) and the leftovers pile up between collections. LOW: a book stays far below the bound (estimate: 10 to 16 MB at the admission limits). Fix direction: serve a part as raw bytes with its hash in a header, hash and append it without keeping intermediate copies, or lower the bound. PRE-EXISTING.

### T726 · FNF[translator-retention] · Translator delete, orphan reconcile and operator leftovers (+11)

status: open · kind: fix · found: translator retention milestone (module PR #8) · priority: P3

In `martinambrus/haive-module-translator`; all NEW with the delete and reconcile slice. Item 1 first: it departs from a host rule.

1. `src/routes.ts:54`: the artifact list GET runs the caller's lazy orphan reconcile unless `Sec-Fetch-Site` is `cross-site`, against the host rule that a GET starts no work. A browser without Fetch Metadata, or a page on the same site (another localhost port, such as the task's own app), can still trigger it. The effect is timing only: the caller's own orphans past the 30-day grace, at most 5 per call, are purged before the next visit would purge them. Fix: move the trigger to a POST, or to the render step, when the module gets its web page.
2. `src/db/retention.ts:70-72` (`deleteTask`): an invocation that never ends (no `ended_at`, not superseded) blocks the owner's delete with 409 `runs-live` until it ends or is superseded. A run that starts after the check is not blocked (documented): the tombstone refuses its module writes, but the core run still costs.
3. `src/teardown.ts:18`: teardown truncates tombstones and receipts with the rest, so a task deleted before a reinstall can be written again after it (the data the tombstone protected is gone by then). Documented.
4. `src/steps/tr-setup.ts:117`: the `setup_attempts` insert takes no owner lock and makes no tombstone check after the entry check in `store()`. Safe only because the purge deletes attempts and, after it, the source foreign key refuses the insert. No race control.
5. `src/db/retention.ts:28,82`: `CANDIDATE_BOUND` examines at most 5000 candidates per call, oldest first, so a user with more than 5000 tasks holding module rows is not examined past the first 5000 until those resolve. No control.
6. `src/migrations/0009_retention.sql:21-26`: the trigger admits the DELETE of any row while the setting names a tombstoned task; it does not compare `OLD.task_id`, since a per-row `to_jsonb(OLD)` would serialise large bytea. Reachable only inside the purge transaction; md5 controls show other tasks' rows survive. Re-examine if the purge ever runs other statements.
7. `src/db/retention.ts:129-150` (`remove()`) with the 0009 trigger: purging a very large task (60 units, 8.4 MB of parts, 30000 review blocks, 30000 seen and 30000 outcome rows) holds the owner advisory lock for about 5 s, mostly the per-row trigger on `pass_seen`, and the same user's other work waits that long. Bounded by the 10 s lock and 60 s statement timeouts. Measured, within limits.
8. `src/db/passes.ts:39,367-392`: the operator view lists at most 200 intents, 200 unbound invocations and 200 audit rows (unresolved and unquarantined first), so thousands of stale invocations need several quarantine rounds to surface. Documented; the scale run belongs to a later slice.
9. Tests: the fake-context unit tests print warn lines from `reconcileQuietly`, and no control pins `CANDIDATE_BOUND`.
10. `src/db/passes.ts:127`: an ended run whose accounting text exceeds 16 KiB makes every later ledger call of that task throw, with no operator path. PRE-EXISTING.
11. `src/steps/tr-render.ts:20`: `reconcileQuietly` writes during detect. PRE-EXISTING.

### T727 · Translator consent reserves no allowance for the rendered files

status: open · kind: design · found: translator assembly milestone (module PR #7) · priority: P4

In `martinambrus/haive-module-translator`, PRE-EXISTING design. Consent reserves allowance for model calls only, so the render step can fail on the allowance after the translation was paid for; each render of changed text stores another artifact, and the operator extension raises calls only. The same question as T718 (c) for review decisions: decide whether consent reserves byte headroom for later phases, or whether rendered files are exempt or replace the previous render.

Related, measured 2026-11-20: `src/db/setup.ts:155-163` (`accountedStorage`) charges 2,048 B per seen row, so about 16,384 runs fill a 32 MiB allowance.

### T728 · FNF[composed-lsp-provider-lock] · composed LSP provider lock and template replacement leftovers (+16)

status: open for coverage items 2-14 and 22; item 21 DONE in #1343 (9b4c358aa, deployed 2026-11-26 via watchers: owner decision keep failing; the reason names disabled set members, at most five; the disable preview lists live tasks whose next CLI step would fail, ids capped at five) and coverage items 2-14; items 15 and 17-20 DONE in #1337 (f2b591b1a, deployed 2026-11-26 with `pnpm docker libs`: shared preferred-provider and image-reference subpaths, composed substitute on step cards and task detail, preview counts the post-lock binding, persona names the substitute, step 01 capability from current rows, malformed pins isolated per task); items 1 and 16 DONE in #1315 (da1f5ed69, deployed 2026-11-21 22:28Z: locked task CLI read under the lock, `resolvePreferredProvider` shared by dispatch and hold) · kind: fix · found: legacy template replacement build and review (#1288) 2026-11-20 · priority: P4

Paths are under `packages/`. NEW means introduced by #1288.

1. DONE (#1315). Step 01's locked decision falls back to the provider resolved before the lock when the task has no default: `locked.cliProviderId ?? ctx.cliProviderId` (`worker/src/step-engine/steps/env-replicate/01-declare-deps.ts` ~:1033, ~:1139). Provider writes never take the task lock. NEW, low.
2. The lock controls pin that the lock is held at each write, not that the summary route and the fix-round path read after it (`api/test/composed-lsp-provider-lock-held.test.ts`, `worker/test/composed-lsp-fix-round-lock-held.test.ts`); the fake database has no read hook. Coverage only.
3. No contention test on a real Postgres for `lockTaskForComposedLsp` (`shared/src/composed-lsp-provider-lock.ts`); the fake database's row-lock model has no isolation levels. Coverage only.
4. Deleting a provider while a holder of the task lock needs that provider's KEY SHARE ends in `40P01` and aborts one side (the summary route PRE-EXISTING, the choice inserts NEW). The state stays consistent; what the aborted request or step shows is unchecked. Fix direction: retry once on `40P01`.
5. `09_6-skill-verification` writes `task_step_cli_choices` with no lock and no rule check. Latent: onboarding tasks never link a template. PRE-EXISTING.
6. `fixRoundOptionProviders` stays an advisory read outside the lock; the write is locked. PRE-EXISTING.
7. Ticking the replacement and editing the dependency selection in the same submit fails step 01 with `selection`; nothing is written and Retry shows the form. Better: re-park the form with a notice through `ReopenStepFormError(msg, { notice: true })` (`worker/src/step-engine/step-runner.ts` ~:4012-4062) and update the replacement controls that pin the typed refusal for that one reason. NEW.
8. The replacement transaction has no step-ownership or epoch fence (`01-declare-deps.ts` ~:1009-1031), like the rest of 01's apply. PRE-EXISTING pattern.
9. A redelivered job reads saved answers without the human-only strip (`step-runner.ts` ~:3690-3697). Theoretical: only a person's submit writes those values. NEW.
10. An adoption demoted to the legacy variant under the task lock is logged, not shown on the task page. NEW.
11. Step 01's new-environment offer does not check the dependency selection (`01-declare-deps.ts` ~:539-552). PRE-EXISTING.
12. `worker/test/step-runner-reuse.test.ts` prints "invs is not iterable" (test noise). PRE-EXISTING.
13. The task page's CLI pickers still list every provider for a contract-2 task; the lock answers 409 `composed_lsp_provider_locked` only when a choice is written. Disable or annotate the refused providers in the pickers. Found by the replacement live check. PRE-EXISTING since #1272.
14. A Retry of step 01 on a contract-2 task rebuilt its image in step 03 with a new id although the row's tag and Dockerfile were unchanged (live check task c858faec, step 7); a legacy row in the same check reused its image. Whether the contract-2 tag rule (#1288) or the contract-2 path causes the rebuild is unchecked.
15. DONE (#1337). The step card's CLI mirrors still name the saved CLI on a locked task, though dispatch skips a saved pick the lock refuses (#1297): `api/src/routes/tasks/_helpers.ts` ~:524-545 and `web/src/lib/step-cli-providers.ts` ~:33-47. Show the CLI that dispatch will run. PRE-EXISTING.
16. DONE (#1315). `providerHoldFor` (`worker/src/queues/task-queue.ts` ~:1720-1747) holds only on the resolver's id. With an enabled saved pick outside the lock's set and a disabled task CLI inside it, the step fails with "is disabled" instead of parking as it does with nothing saved; a disabled saved pick keeps the disabled refusal and hold although the lock would skip it. Mirror the dispatcher's skip in the hold. PRE-EXISTING (the step failed on the lock before #1297). Checked against the code 2026-11-21.

17. DONE (#1337). The api's disable-impact preview (`api/src/lib/provider-disable-impact.ts` ~:101) never modelled the lock's skip of a saved pick, so on a composed task with a saved pick outside the lock it over-counts when the skipped pick is disabled and under-counts when the task CLI is. With item 15 this needs the pure `resolvePreferredProvider` decision (`worker/src/orchestrator/dispatcher.ts`) moved to a shared home. PRE-EXISTING.
18. DONE (#1337). Step 01's `cliSupportsLsp` still derives from the pre-lock `ctx.cliProviderId` (`01-declare-deps.ts` ~:806, ~:910, ~:1035); a stale flag can only refuse, never wrongly accept. PRE-EXISTING, low.
19. DONE (#1337). The persona pin check names the saved CLI, not the substitute the dispatcher runs (`worker/src/queues/task-queue.ts` ~:3270-3290, `providerNameFor`); advisory event only. PRE-EXISTING, low.
20. DONE (#1337). Coverage: no hold-versus-dispatch parity test; no hold cases for a fix-round choice, ignored saved CLIs or non-default roles; step 01's locked decision has no real-Postgres control. Low.
21. Design: a composed task with nothing saved, no own CLI and no enabled provider in the lock's set fails with the lock reason (`dispatcher.ts` ~:789), while a disabled own CLI parks. Whether that should park set-wide is a choice.
22. Low (#1343 review): the disable warning says the listed tasks fail "at their next CLI step" even for a live composed task with no CLI step left.

### T729 · A CLI remembered on another task can be refused at dispatch for a composed LSP task

status: done 2026-11-21 (#1297, 91a9a9d7f, worker deployed 02:48Z); decided by the owner 2026-11-20 (option a) · kind: fix · found: #1288 review 2026-11-20 · priority: P3

Saved CLI preferences ("Also for my later tasks") are user-wide, so a pick remembered on another task is not ordered against this task's composed LSP decision, and `resolvePreferredCli` (`worker/src/step-engine/step-runner.ts` ~:377) applies none of the provider rule. A contract-2 task whose step later resolves a remembered CLI the lock refuses is stopped by the dispatch backstop, and the step fails. The task lock cannot cover it. PRE-EXISTING since #1272.

Options: (a) at dispatch, skip a saved preference the rule refuses, use the task's own allowed CLI, and say so on the step; (b) refuse the remember-pick for tasks under the lock, which blocks a pick that is valid for other tasks; (c) keep refusing and name the remembered pick in the failure. Recommendation (a): the documented rule "work is refused, never moved to another CLI" protects a choice made for this task, and a user-wide remembered pick is a default. Needs the owner, since (a) relaxes that rule's wording.

OWNER DECIDED 2026-11-20: option (a). A saved user-wide choice ("Also for my later tasks") that the lock refuses is skipped at dispatch: the step runs on a CLI the task allows and says so. A choice made for this task, and a fix-round or round choice, is still refused, never moved. The Provider lock text in `docs/architecture/sandbox.md` (~:1357-1370) states the exception.

### T730 · Step 01 suggests the retired PHP language server key, so its form cannot be submitted

status: done 2026-11-20 (#1289, dc2c67edb, worker reloaded 06:27Z) · kind: fix · found: legacy template replacement live check 2026-11-20 · priority: P2

Step 01's detect still suggests `intelephense` for a PHP project that is neither a CMS nor on DDEV (`worker/src/step-engine/steps/env-replicate/01-declare-deps.ts` ~:1401, ~:1518), but the PHP consolidation left `intelephense-extended` as the only option (`LSP_OPTIONS` ~:333-336; stored repository values were normalized by migration 0084, and none on the dev install holds the old key). The suggestion becomes the form default of every such repository without stored `lsp_servers` (83 of 85 on the dev install), the UI renders it as nothing ticked, and the submit fails "lspServers: invalid option intelephense"; ticking the visible option does not remove the hidden value. PRE-EXISTING. Fix: suggest the surviving key for every PHP project, and pin that the form's defaults pass its own validation.

### T732 · FNF[composed-image-launch] · composed sandbox image launch lows (+1)

status: parked 2026-11-26 (session triage, not owner: low, coverage-only or inputs no current path produces); follow-ups 2-3 remain; item 1 DONE in #1312 (21246ebb7, deployed 2026-11-21 20:02Z: one shared base rule with the composer, tags unchanged) · kind: fix · found: legacy composed image fix (T712 build) 2026-11-20 · priority: P4

1. A launch ensures the sandbox core image even when the composition does not build on it (`worker/src/sandbox/composed-image-cache.ts` ~:247-253 calling ~:283-291; hash rule `sandbox/image-composer.ts` ~:126-128). A composition built on its environment image (contract 2, and legacy with a usable environment image) never uses the core image, so that ensure is dead work at every launch. PRE-EXISTING. Fix direction: ensure the core image only when the composition's base is the core image.

Follow-ups found by the #1312 driver:

2. A legacy Dockerfile with no usable environment image that builds on the core under another spelling (`FROM haive-cli-sandbox` without `:latest`) never got the core id in its hash (`worker/src/sandbox/image-composer.ts` ~:131-132 matches the literal tag) and, since #1312, also gets no launch ensure, so on a host whose core was pruned its build fails. Generated Dockerfiles never write that spelling (`02-generate-dockerfile.ts` ~:452). Widening the rule moves hashes. PRE-EXISTING (hash) / narrow REGRESSION (ensure), low.
3. `composed-image-cache.ts` ~:293-295 swallows a core-image ensure failure even for a composition that builds on the core, so the later `docker build` error is what the user sees. PRE-EXISTING, low.

### T733 · FNF[translator-chunk-tail-units] · Translator chunking makes tiny units that each cost a full cycle (+1)

status: done 2026-11-20 (module PR #12, 3493a9e) · kind: fix · found: translator scale and acceptance milestone (module PRs #9, #10) 2026-11-20 · priority: P3

In `martinambrus/haive-module-translator`. 1. DONE module PR #12 (3493a9e). `src/chunking/group.ts:10-19`: there is no minimum unit size and a unit closes at every heading, so 7 of the 14 units of a 6,584-word book hold 3-6 words, and each still costs a full translate and review cycle of 4 calls, about half of the book's ~58 calls. PRE-EXISTING. Fix direction: merge a unit below a minimum size into its neighbour, so a heading starts a new unit only when the unit before it is large enough.

### T734 · FNF[module-db-open] · The module database opener creates databases on request paths (+1)

status: open · kind: fix · found: translator scale and acceptance milestone 2026-11-20 · priority: P4

1. `openModuleDatabase` (`shared/src/module-db/index.ts` ~:32-48) creates the module's database when it is absent, and a module's request handlers call it per request (translator `src/db/passes.ts:87,379`, `src/db/retention.ts:67,79`, `src/db/setup.ts:18`). A GET can therefore run `CREATE DATABASE` when an active module's database is missing; the worker creates it at module load (`worker/src/modules/loader.ts:288`), so only after an out-of-band drop. Each call also builds a new two-connection pool that the caller must close. PRE-EXISTING. Fix direction: a create-free open for request paths, creating only at module load, and one cached pool per module.

### T735 · Translator first paid run and its prerequisites

status: open, ON HOLD by the owner 2026-11-26 until T771 and T772 ship (ae8fb29c: translate done after T768; tr-review failed on the 16-call ceiling after 4 cascading review rounds; resume testing there) (2026-11-26: the calibration sign-off was explained to the owner: evidence, editable style JSON, quality assessment, two ticks for at most 16 translation/review calls on the 2-unit sample, then translate, review, render; waits on the owner), in work 2026-11-20 (the owner approved the first paid run and runs it, guided); UNBLOCKED by the owner 2026-11-22; item 4 done 2026-11-22 (switch ticked, free steps walked); waits on the owner's paid run (provider row, source) and quality sign-off; items 6 and 7 done 2026-11-21 · kind: feature · found: owner decisions 2026-11-20 · priority: P2

In `martinambrus/haive-module-translator`.

1. DONE module PR #11 (7296b0d). The declared call timeout goes from 180 s to 300 s (owner decision 2026-11-20): module PR #11. The host floor `CLI_TIMEOUT_BASE_MINUTES` (45 minutes on the dev install) already decides a step's own call (`escalatedTimeoutMs`, `packages/shared/src/constants/index.ts` ~:863), so the change matters only if that floor is set lower.
2. DONE 2026-11-21, measured, no code change (`.claude/tmp/codex-run/T735/bound-test/results.md`): in Chrome with the module's own download engine, a file just under the bound saved with an equal SHA-256 at 175 to 196 MiB above start in the renderer plus 31 to 39 MiB in the browser process; a 40 MiB file was refused before allocation and its 4 MB part 1 saved at about 31 MiB; an 8 MiB file cost about 47 MiB. Recommendation to the owner: keep 32 MiB (books stay far below it); the README figure is item 6, the memory itself T725 item 10. Original item: validate the 32 MiB page bound (`src/web/download.ts:4` `ASSEMBLY_BOUND_BYTES`; building the Blob holds a second copy, about 64 MiB at peak) with a generated book just under and just over it: the first downloads, the second is refused, and the tab's peak memory is recorded. No model calls (owner decision 2026-11-20).
3. DONE 2026-11-21: T733 merged (module PR #12, 3493a9e), the module loads on the dev stack, its database exists and the type is listed (local uncommitted `selectable: true`). Original item: before the run: T733 merged; the module installed on the dev stack (`external-modules/translator`, `pnpm module add translator`, install, build, `pnpm docker rebuild` while nothing runs); the task type made startable on that install only, by an uncommitted `selectable: true` in `src/manifest.ts`, until the owner's quality sign-off.
4. DONE 2026-11-22: Admin "Allow tasks of module-seeded types" ticked (owner unblock 2026-11-22; persists across reload); free steps walked in the browser with a 659-word sample the session wrote (task ae8fb29c, parked at the step 8 consent form, not submitted): health check, upload, source selection, structure review (16 blocks, 2 units), consent form opened (66 rows with models, 32 MiB default, cap 4 setup + 16 unit calls). Walkthrough corrected for two findings: the health-check step makes one short Claude call (T755), and the empty upload list (T754). Owner decisions 2026-11-22: the paid run uses a Codex row after its weekly reset (21:58 UTC), on the session's sample (task ae8fb29c); the owner does the quality sign-off. Run 2026-11-22 22:05-22:12Z: consent, glossary (names kept, Chapter Three added) and calibration done on `OpenAI Codex 5.6 Med (2)` (gpt-5.6-sol); parked at "Review calibration and approve style" for the owner's quality sign-off. Two detours: (1) the task had no CLI, so the first glossary dispatch went to the user's default Claude row and the module refused it before enqueue (no spend; T754 item 2); (2) every Codex row pins `cli_version` 0.152.0, which cannot run `gpt-6-astra` ("requires a newer version of Codex"), so all six Astra rows fail at their first call (one glossary attempt spent on Astra High). Raising the Codex rows' CLI version is the owner's (provider rows are owner-only); the other Codex 5.6 rows have no explicit model, so the consent screen does not offer them. Original item: a walkthrough for the owner, written after walking the free steps (upload, source approval, consent screen) in the browser. Written 2026-11-21 from the code and README (`.claude/tmp/codex-run/T735/owner-walkthrough.md`); the browser walk waits on the owner ticking Admin "Allow tasks of module-seeded types" (a global config switch the run may not change). Writing it found item 7.
5. After the owner's quality sign-off: unhide in a module PR (`selectable: true`, and the README's hidden-type text).
6. DONE module PR #14 (6b73db6). The README's download memory figure ("about twice the bound plus one part, roughly 70 MiB") is low by 2.5 to 2.8 times (item 2). Correct it in a module docs PR.
7. DONE module PR #13 (c7f7147, deployed 2026-11-21 02:24Z; live probe, counts only: no error, 66 of the owner's 78 enabled rows offered, all 41 Claude Code rows among them). Setup consent blockers: `providers()` (`src/db/setup.ts`) threw for more than 50 enabled CLI rows (the owner has 78), so the consent form never opened; and it never offered a Claude Code row, whose provider form hides and nulls Model (the model is the last `--model` argument). The fix lists up to 200 rows and offers Claude Code rows by that argument, with the consent fingerprint unchanged. Same PR: a reopened consent form pre-selects its providers (`defaults`, not `default`). Deploy: pull the live clone, `pnpm docker libs`.

### T736 · FNF[translator-grouping] · Translator unit grouping and calibration envelope leftovers (+8)

status: open for items 3, 4, 5, 8, 9, 10; items 1, 2, 6, 7 DONE in translator #19 (c3c988d, deployed 2026-11-26: serialized single-block overflow marked exceptional and labelled at source review, one envelope constant bound into SQL, `test:ingest` builds first, acceptance coverage from the unit count) · kind: fix · found: tiny-unit grouping build and review (module PR #12) 2026-11-20 · priority: P4

In `martinambrus/haive-module-translator`.

1. DONE (translator #19). PRE-EXISTING: a single block under the word and character caps that serializes past 9,000 characters (roughly 8,950 to 12,000 characters of text, or heavy escaping) becomes a non-exceptional one-block unit. The ingest review form lists only exceptional units (`src/steps/tr-ingest.ts:84`), and calibration refuses the unit later (`src/db/setup.ts:112`). Fix direction: mark such a block exceptional at ingest, or name it on the review form.
2. DONE (translator #19). PRE-EXISTING duplication, one more copy since module PR #12: the 9,000 envelope is spelled in `src/db/setup.ts:112` (an SQL literal no test pins), `src/steps/tr-setup.ts:98` and `:140`, and `src/ingest/model.ts:6` (`LIMITS.unitEnvelopeChars`, pinned by `test/ingest.test.ts:98`). Fix direction: one constant, passed into the SQL.
3. LOW: a heading that joins a unit below the minimum is stranded when its first paragraph does not fit, so the paragraph starts the next unit (`src/chunking/group.ts:20-27`); the next unit's `headingIds` still names the heading.
4. NEGLIGIBLE: the unit-count limit throws before the final join (`src/chunking/group.ts:28`), so a book whose 1,001st unit would have joined back still fails.
5. COVERAGE, low: the ingest step's replay under a changed grouping (`src/steps/tr-ingest.ts:43-47`) has no step-level test; `saveSource` and the readers are pinned.
6. DONE (translator #19). TEST TRAP, PRE-EXISTING: `test/path.test.mjs:13-19` imports `../dist/...` (`groupUnits` at :19), so `pnpm test:ingest` tests whatever `dist/` was last built. Fix direction: build first in the script, or import the source.
7. DONE (translator #19). TEST FRAGILITY, PRE-EXISTING: `test/acceptance.test.mjs:126` caps at `Math.min(51, ...)` from the old 21-unit book; module PR #12 fixed the same kind at :128 by deriving the bound.
8. COVERAGE REGRESSION from module PR #12, low: the Arabic fixture (`test/acceptance.test.mjs:30`, `targetWords: 60`) is now below the minimum and no longer exercises heading splits (its 4 units are unchanged).
9. Low (#19 review F2): an admitted unit over the serialized envelope can never calibrate (`representative` refuses it), so admission is a dead end until the owner splits it; the review form could say so. PRE-EXISTING in kind.
10. Low (#19 review F3): `serialized` counts UTF-16 units while Postgres `length()` counts code points, so a block heavy in astral characters can be flagged exceptional when calibration would accept it. Conservative.

### T737 · FNF[fresh-worktree-typecheck] · A fresh worktree's worker typecheck fails until the statistics module is built

status: done 2026-11-21 (#1298, 655845a07, docs: `docs/architecture/testing.md` "Running one package") · kind: fix · found: gate-3 parking build (#1296) 2026-11-20 · priority: P4

1. DONE #1298. PRE-EXISTING: in a fresh worktree, `pnpm --filter @haive/worker typecheck` fails on `packages/worker/src/modules.generated.ts` until `@haive/module-statistics` is built (`pnpm --filter @haive/module-statistics build`), and `packages/worker/test/step-integrations-boot.test.ts` failed while `modules.generated.ts` was absent. Fix direction: make the worker's typecheck and test tasks build the generated modules first (a dependency turbo's `^build` follows), or say so in `docs/architecture/testing.md`.

### T738 · FNF[step-warning-atomic-append] · a step warning written from the caller's row snapshot can drop one added since

status: open for follow-ups 3-6; items 1-2 DONE in #1307 (7fc70f310, deployed 2026-11-21 16:31Z: nine snapshot sites and the codex fallback append through `appendStepWarning`; `addStepWarning` removed) · kind: fix · found: #1297 driver 2026-11-21 · priority: P4

1. `addStepWarning` (`worker/src/step-engine/step-ownership.ts` ~:92-100) joins the caller's row snapshot and writes the whole column, so a warning another writer added after the caller read its row is lost. Sites: `merge-resolver.ts` ~:532, 557, 679, 897, 1123, 1598; `left-open-merge.ts` ~:521; `dag-executor.ts` ~:977; `project-state/branch-revert.ts` ~:611. Fix direction: route them through `appendStepWarning` (one UPDATE that adds the text once, added by #1297). PRE-EXISTING; #1297's notice was traced through these flows and is not overwritten.
2. `queues/cli-exec/handlers.ts` ~:387 replaces `warning_message` for a codex app-server fallback. Unreachable on a composed-LSP task today (only claude-code can be in its set). Same fix. PRE-EXISTING.

Follow-ups found by the #1307 driver:

3. The converted merge sites (`merge-resolver.ts` ~:532/557/679/897/1123/1598, `left-open-merge.ts` ~:521, `dag-executor.ts` ~:977) are covered at the helper's fence only; `smoke:left-open-merge` covers one on a real database but was not run. LOW, coverage.
4. `test/cli-exec-completion.test.ts` ~:711 pins that a superseded step still completes, but not the warn log. LOW, coverage.
5. `appendStepWarning` (`step-ownership.ts` ~:100) dedupes by substring (`strpos`, as the old `includes` did), so a short note inside a longer existing sentence is dropped. No caller writes short notes. PRE-EXISTING, LOW.
6. `test/support/step-warning-patch.ts` ~:7 throws a TypeError on an undefined patch; fails loudly, no caller passes one. #1307, harmless.

### T739 · FNF[cli-touched-vestigial] · the touched-CLI marker table has readers and no writer

status: open for item 4; phase 2 (item 3) DONE in #1311 (edd7a7586, migration 0248 applied on dev 2026-11-21 19:32Z, 12 rows dumped first to `.claude/tmp/codex-run/T739-S/dev-task_step_cli_touched-dump.sql`; runner skips dropped baseline tables, roll-forward-only undo once applied); phase 1 (readers removed) DONE in #1309 (21f6fceba, deployed 2026-11-21 17:58Z) · kind: fix · found: #1297 driver 2026-11-21, checked against the code · priority: P4

1. `task_step_cli_touched` is read (`worker/src/step-engine/step-runner.ts` ~:333-343 `isTouched`, `api/src/routes/tasks/_helpers.ts` ~:186-199) but never written. The CLI switch writes the per-task choice first (`api/src/lib/step-cli-choice.ts` ~:87), which the resolver reads before any saved row, so an in-task pick never depends on the marker; under `ignore_saved_step_clis` a saved row is simply never honoured. Dead code, no user-visible effect. Fix direction: drop the readers, then the table in a later two-phase migration, or document why it stays. PRE-EXISTING.

Notes from the #1309 driver:

2. Correction: the table had two writers until 2026-10-01 (the step CLI-provider PATCH route, `433b9c0eb`..`2c7086ec7`, and the 09_6 gate, `ec5c6ae18`..`b5ea25427`), both removed then. The dev install holds 12 rows, all on completed or cancelled tasks (9 with `ignore_saved_step_clis`).
3. Phase 2, after #1309 is deployed: a numbered migration `DROP TABLE IF EXISTS "task_step_cli_touched"` (dump the rows first), drop `taskStepCliTouched` from the schema, the two leftover-row pins and their registrations, the `step-summaries.md` sentence and the schema comment. Rollback text in `.claude/tmp/codex-run/T739-S/ledger.md`.
4. Test gaps, low: no mixed-flag batched listing case, no enrich case with a null taskId and the flag on, no round choice under the flag; the worker fake in `resolve-preferred-cli.test.ts` ~:30-56 keys by role only. `_helpers.ts` ~:1394 still says "any untouched step otherwise" (cosmetic).

### T740 · FNF[agent-description-render] · agent descriptions render wrong for some inputs

status: open for follow-ups 3-8; items 1-2 DONE in #1310 (70ce4c200, deployed 2026-11-21 18:56Z; a bundle item holding a NUL is now dropped on its own; full TOML and YAML escape sets, first-word case rule, renderer v4) · kind: fix · found: #1302 driver 2026-11-21, checked against the code · priority: P4

Either fix changes the rendered body, so the renderer pin (#1302) forces a renderer version bump with it.

1. `tomlBasicString` (`worker/src/step-engine/steps/onboarding/_agent-templates.ts` ~:203) escapes backslashes and quotes but not newlines, so a multi-line description renders invalid TOML for Codex agents (confirmed with Python `tomllib`). PRE-EXISTING.
2. `firstCharLower` (`_agent-templates.ts` ~:88) lowercases an acronym-led description (`API gateway` becomes `aPI gateway`). PRE-EXISTING.

Follow-ups found by the #1310 driver:

3. `worker/src/bundle-parser/decoders/codex-toml.ts` ~:85 finds the multi-line string end with `indexOf('"""')`, ignoring escapes: a body with 5, 8, ... consecutive quotes is written valid but read back truncated. PRE-EXISTING, low.
4. `codex-toml.ts` ~:50-57, ~:87: the multi-line branch drops the backslash of an unknown escape and of a line-ending `\`; only hand-written files a real parser rejects or that use continuation. PRE-EXISTING, low.
5. `worker/src/sandbox/mcp-config.ts` ~:621-623 `tomlString` escapes only `\` and `"`: a user MCP server with a multi-line env value renders a `config.toml` tomllib rejects (probed); the bare key at ~:544 is unescaped too (not probed). PRE-EXISTING, medium-low.
6. `steps/onboarding/09_5-skill-generation.ts` ~:653-654: the long or multi-line skill description branch (folded block scalar) leaves control characters raw, and PyYAML rejects that SKILL.md (probed); descriptions of 120 characters or fewer now parse through the shared fix. PRE-EXISTING.
7. `07-generate-files.ts` ~:303-325: the agents index passes control characters raw into a table cell. Cosmetic, PRE-EXISTING.
8. Coverage: every control varies only the description, so a mutant that stops escaping the name line survives (names are validated slugs). Low.

### T741 · FNF[fix-gate-continue-stale-row] · gate Continue does not reset a stale row at the next round

status: done (#1326 2b78b319d, deployed 2026-11-23: gate Continue and loop_back reset the next round from the first existing row of the target-to-end range, in one transaction with reset-first lock order; duplicate or concurrent handoffs fenced, losers neither reset nor record; item 2 fixed there). Follow-ups: T757 · kind: fix · found: custom fix recovery driver (#1303), code reading only, not probe-verified · priority: P4

1. The fix gate's Continue path (`worker/src/queues/task-queue.ts` ~:3126-3163) does not reset a stale terminal row at the next round, while loop_back does (~:2757-2767). Verify with a probe before fixing. PRE-EXISTING.
2. A direct duplicate loop_back call duplicates fix-loop events (~:2581-2760); production redelivery is already stopped by the advance guard, so only a direct second call shows it. PRE-EXISTING, LOW.

### T742 · FNF[ci-gated-row-bookkeeping] · adding a gated test row needs two hand edits

status: done for follow-ups 2, 4, 5, 6 in #1338 (46e8ee6f1, 2026-11-26: two-leg matrix with the `Postgres-gated tests` aggregate, budget in `scripts/lib/ci-gated-budget.mjs`, every row column checked; first sharded run 722 s and 804 s); follow-ups 1 and 3 parked 2026-11-26 (session triage: low, pre-existing / board-only); main item DONE in #1314 (2026-11-21: derived row check, one limit formula with 25 rows of headroom, limits 50/52 min; accepted by the session, not the owner: a gated file deleted with its row is no longer flagged, a hung run is cancelled 6 min later) · kind: chore · found: custom fix recovery driver (#1303) · priority: P4

`scripts/test/ci-gated-list.test.mjs` ~:208 hard-codes the gated file count, and the gated step and job limits in `.github/workflows/ci.yml` (~:386 and ~:489) sit at exactly 1.5x the modelled row time, so every new row fails `ci-step-independence.test.mjs` until both are raised by hand. Derive the count, or give the limits headroom with the formula in one place. PRE-EXISTING.

Follow-ups found by the #1314 driver:

1. `scripts/test/ci-gated-list.test.mjs` ~:12 `gatedEnvironment` misses a destructured `process.env`, a ternary `describe` choice and a guard inside a function (7 blind idioms in all, same on base). PRE-EXISTING, low.
2. DONE (#1338). `ci-gated-list.test.mjs` ~:97-98 reads only a row's package and file; the env var, database and image columns are never checked, so a wrong value surfaces only in the 40+ minute CI run. PRE-EXISTING, low.
3. Board text elsewhere in this file still describes hand-bumping the count and limits (the entries that cite `ci-gated-list.test.mjs` counts). Board-only; tidy when next edited.
4. DONE (#1338). `scripts/test/ci-step-independence.test.mjs` ~:321: the crowding failure message does not name the minutes to raise. NEW, nit.
5. DONE (#1338). `ci-step-independence.test.mjs` ~:290-294: `rowHeadroom` has no default or guard, so a second gated budget without it prints `NaN`. No such budget exists. NEW, latent.
6. DONE (#1338). Design: shard the postgres-gated job into a matrix. The serial list grows about 3 rows a day and every limit raise lengthens the hung-run bound.

### T743 · FNF[extension-lock-recovery] · the extension's window lock has no stale recovery

status: parked 2026-11-26 (session triage, not owner: low, coverage-only or inputs no current path produces); follow-ups 1-2 remain; main item DONE in #1317 (2026-11-22: the window lock is a lease at the same name; a legacy folder is refused with instructions, never deleted) · kind: fix · found: #1304 driver 2026-11-21 · priority: P4

The sibling `<dir>.extension-lock` (`docker/desktop-extension/bridge/main.go` ~:718, an `os.Mkdir`) stays after a crashed or closed Desktop window and needs manual removal. Reuse the lease record from `stack_lock.go`. PRE-EXISTING.

Follow-ups found by the #1317 driver:

1. A lost lease is silent: `docker/desktop-extension/bridge/stack_lock.go` ~:195 sets `lost`, ~:230 stops the heartbeat, nothing is logged; now also for the window lease. Documented in `release.md`. PRE-EXISTING, low.
2. On Windows `beat()` truncates the lease file (~:198) with no no-follow flag (`stack_lock_windows.go` ~:3) after the ownership read (~:172), so a symlink swapped in between would be followed; the window lease adds a second site beside the install directory. Same-user only, unverified on real Windows. PRE-EXISTING pattern, low.

A killed bridge can leave a Compose or installer child running while both leases lapse after 60 s (the old window folder never lapsed); `release.md` names Start, Stop and Install. Tracked under T744.

### T744 · FNF[orphan-children-vs-lease] · a lock holder's children outlive its lease

status: done for the updater half (#1325 1c6c7b87d, 2026-11-23; updater is not part of the dev stack, so no deploy: one-shots carry install, attempt and role labels; a takeover refuses while another attempt's one-shot runs; cleanup by label when a client dies; no client timeout for labelled one-shots; SIGTERM cleanup bounded to 5 s and stops further launches). Desktop bridge half: T758 (design, owner scope). Lease fencing: T759. Follow-ups: T760 · kind: fix · found: #1304 driver 2026-11-21 · priority: P4

A killed bridge leaves its Compose child running while the install lease lapses after 60 s (`docker/desktop-extension/bridge/main.go` ~:781), and an updater death can orphan the archive and migrate containers (`packages/updater/src/docker.ts` ~:163, ~:208), which no guard sees. PRE-EXISTING.

### T745 · FNF[attempt-row-early-refusals] · early updater refusals record placeholder fields

status: done 2026-11-23 #1321 (3828added): early refusals record the channel and version from a bounded read (`attempt-fields.ts`, `ATTEMPT_ENV_MAX_BYTES` 256 KiB, lstat before open, `not-read` for a non-regular or oversize `.env`); fields recorded after `readInstall()` returns; follow-ups in T756 · kind: fix · found: #1304 driver 2026-11-21 · priority: P4

Refusals raised before `readInstall()` (`install-locked`, `install-file-linked`; `packages/updater/src/cli.ts` ~:243, ~:295, ~:354) record channel `public` and an unknown current version in the attempt row. `release.md` now says so. PRE-EXISTING.

### T746 · FNF[dead-judge-missing-type] · the dead-task judge throws on a live task whose type definition is gone

status: dropped 2026-11-22 (unreachable): both type deletes lock the type row and refuse while any task row of that type exists, any status (`api/src/routes/task-types.ts` ~:869-886 admin delete; `api/src/modules/purge.ts` ~:113-161 module purge, locking type rows in the create path's order); the create path reads the row FOR SHARE. Only a manual SQL delete leaves a live task without a definition. Reopen on a measured occurrence · kind: fix · found: #1305 driver 2026-11-21 · priority: P4

`judgeCandidate` (`worker/src/queues/dead-task-boot.ts` ~:390) reaches `run-list.ts` ~:327, which throws "has no definition" for a live task whose type definition is missing: an error log at every boot and the task is never judged. Same for snapshot-bearing tasks; #1305 also makes it reachable for snapshot-less pinned ones. Admin type delete is refused while tasks exist (`api/src/routes/task-types.ts` ~:880); module-seeded types were not checked, so verify reachability first. PRE-EXISTING.

### T747 · FNF[claude-stream-error-codes] · only one of the Claude CLI's assistant error codes is read

status: open for follow-ups 1-8; main item DONE in #1308 (d52dd3722, deployed 2026-11-21 17:47Z: codes mapped to auth / rate_limit / server_error, steered runs classify) · kind: fix · found: #1306 driver 2026-11-21 · priority: P4

`worker/src/queues/cli-exec/stream.ts` ~:87 and `exec-core.ts` ~:1221 read only `authentication_failed` from the top-level assistant `error` field. Claude CLI 2.1.330 also stamps `oauth_org_not_allowed`, `account_on_hold`, `verification_required`, `cloud_credential_error`, `billing_error`, `rate_limit`, `overloaded`, `server_error`, `invalid_request`, `model_not_found`, `max_output_tokens` and `unknown`; map the ones with a failure class (auth, rate limit, provider outage) to it. A steered run whose later turn fails auth takes the result branch and carries no flag. PRE-EXISTING.

Follow-ups found by the #1308 driver:

1. A steered run's error detail quotes the first turn's answer tail (`exec-core.ts` ~:1284-1289, `formatCliErrorMessage` in the result branch): headline right, excerpt from the wrong turn. PRE-EXISTING, medium-low.
2. The no-result branch still lets the text rules scan the raw stream, so a stamped `rate_limit`/`overloaded` token classifies even from a sub-agent or recovered turn (`exec-core.ts` ~:1022, ~:1358; `failure-class.ts` ~:279, ~:348, ~:359-377). PRE-EXISTING, low-medium.
3. The auth hint says log in again, wrong for `account_on_hold`, `oauth_org_not_allowed`, `verification_required` (`exec-core.ts` ~:297-316); needs a hint variant. PRE-EXISTING, low.
4. `authFailure` is now redundant with `streamFailureClass === 'auth'` (`_shared.ts` ~:99-101, `exec-core.ts` ~:195, ~:264-266). Low, cleanup.
5. No class for `model_not_found` / `invalid_request`: ordinary exit-1 failures with ordinary retries. Design decision. PRE-EXISTING, low-medium.
6. The sequential sub-agent path for amp and grok carries no stream flags (`sub-agent.ts` ~:226-257). PRE-EXISTING, low.
7. `billing_error` files under `rate_limit`, whose watch assumes a resetting window (`task-queue.ts` ~:2022, `failure-class.ts` ~:296); bounded by notify mode and the auto-resume cap of 3. PRE-EXISTING for the text path, low.
8. `api_error_status` on assistant and result events has no reader in `packages/*/src` (null for no-login, 401 for a rejected key): a possible second structural signal. PRE-EXISTING, low.

### T748 · FNF[empty-typed-secret] · the api stores a secret-named env var with an empty value

status: open for follow-up 2 and the FNF below; main item DONE in #1313 (7a7b0c0fd, deployed 2026-11-21: shared schema 400 naming the key, worker skips stored empties; dev has 0 stored empties); follow-ups 1, 3, 4, 5 DONE in #1333 (ec4fc8726, deployed 2026-11-23: clone skips blanks, `keepGeneration` removed, the secrets list excludes exact-empty envelopes by shape (`isEmptyEnvelope`, no decrypt on a GET; a whitespace-only legacy row stays counted and copied, inert), blank = trimmed-empty at every writer, seed stops at the first configured candidate) · kind: fix · found: #1306 driver 2026-11-21 · priority: P4

`api/src/routes/cli-providers.ts` ~:557 (create) and ~:865 (PATCH), via `shared/src/schemas/cli-providers.ts` ~:98 and `shared/src/cli-providers/provider-secret.ts` ~:25, accept a secret-named env var with an empty value and store an encrypted empty string; `worker/src/secrets/provider-secrets.ts` ~:33 then injects it as an empty env var. The web form drops empties, so this is API-only. PRE-EXISTING.

Follow-ups found by the #1313 driver:

1. The clone route copies a legacy empty secret-like entry or stored empty row to the clone (`api/src/routes/cli-providers.ts` ~:1236-1257). Inert at run time through the worker skip. PRE-EXISTING.
2. Worker `copyKeys` (`worker/src/secrets/move-secret-env.ts` ~:90-115) stores a legacy empty plaintext secret-like value as an empty encrypted secret; touches the destructive-migration gate, so its own change. PRE-EXISTING, inert at run time.
3. `keepGeneration` (`api/src/routes/cli-providers.ts` ~:903, `api/src/lib/cli-login-secret.ts` ~:205-269) is unreachable from PATCH now; remove it or keep it as the hook for an "empty token advances the generation" contract. Low.
4. The secrets list (`GET /:providerId/secrets`, the form's "N secrets configured") counts a stored empty as configured. PRE-EXISTING, low.
5. Whitespace-only secret values are accepted (`shared/src/schemas/cli-providers.ts` ~:165 `min(1)`, the new rule tests `=== ''`); a whitespace login token is truthy and spreads set-wide. The web form trims. PRE-EXISTING, low.

Found in #1333 (all low, PRE-EXISTING or accepted):

6. An exact-empty stored row is hidden from the list and so cannot be deleted from the form (the list drives its delete loop, `web/.../cli-provider-form.tsx` ~:581-588). Inert. Retire exact-empty rows with a numbered migration on the envelope shape after item 2 stops `copyKeys` recreating them.
7. A quoted whitespace secret in the form (`KEY="  "`) gets a 400 from the secret POST after that save's PATCH and deletes have committed. Negligible.

### T749 · FNF[step-warning-notes] · attempt-scoped warning writes and the codex fallback's fence

status: done (#1324 fe4deb954, deployed 2026-11-23: notes belong to the attempt, retry notes append, a new attempt (Retry, reset, per-step CLI switch) clears them, RAG banner unchanged on purpose; the codex fallback note is fenced on its invocation; follow-ups T762) · kind: design · found: #1307 driver 2026-11-21 · priority: P4

1. `retryWarning` (`worker/src/step-engine/step-runner.ts` ~:944, ~:3555, ~:4239) replaces the whole `warning_message`, wiping notes appended earlier in the attempt (the codex fallback, merge notes). Attempt-scoped on purpose, but the loss is real; decide whether a retry note should append or whether earlier notes belong to the attempt. PRE-EXISTING.
2. The codex fallback write (`worker/src/queues/cli-exec/handlers.ts` ~:394) is fenced by status only: the cli-exec payload carries no generation, so a late invocation could annotate a retried attempt. The old write had no fence at all. PRE-EXISTING.

### T750 · FNF[migration-rules-docs] · migration rules live only in code

status: done 2026-11-22 #1319 (2c7ab90a9): new `docs/architecture/migrations.md` states never edit, delete or revert an applied migration (ahead vs fork, exit 7), roll-forward rollback, `DROPPED_SINCE_BASELINE`, adoption and exit codes; AGENTS.md migration bullet moved there (32,758 -> 32,055 bytes) and indexed · kind: docs · found: #1311 driver 2026-11-21 · priority: P4

1. No doc says an applied migration must never be deleted or reverted (a database that applied a migration its code lacks is refused as a fork once a later one is pending); the rule lives only in `database/src/migrate/plan.ts` ~:33-36 and `migrate/index.ts` ~:274-281. Rollback after apply is roll-forward only. PRE-EXISTING.
2. Dropping a baseline table needs a `DROPPED_SINCE_BASELINE` entry (`migrate/baseline.ts`, pinned by `baseline.test.ts`), or journal-less adoption refuses the database; documented only in code. AGENTS.md has 10 bytes spare, so this belongs in a new `docs/architecture/` topic file listed in its index (shrink an entry to make room). PRE-EXISTING.

### T751 · FNF[gated-test-local-runner] · no local runner for the CI-only database tests

status: parked 2026-11-26 (session triage, not owner: low, coverage-only or inputs no current path produces); follow-ups 1-3 remain; main item DONE in #1316 (2026-11-22: `pnpm test:gated <file|package|all>`, reads the CI GATED list, throwaway containers removed on every exit) · kind: chore · found: #1313 driver 2026-11-21 · priority: P4

The real-Postgres test files in the CI gated list skip without their env var, so a driver only runs them by hand-building a throwaway Postgres and the right URL per file; a change that breaks one (as #1313's first build did) is caught only by CI or by luck. Add a script that starts a throwaway Postgres 18, migrates it, and runs a named gated file (or all of them) with the env var the list declares. PRE-EXISTING.

Follow-ups found by the #1316 driver:

1. A signal during an in-flight `docker run -d` could let `docker rm -fv` run before the daemon creates the container (`scripts/run-gated-tests.mjs` ~:154-157, cleanup ~:203-216); remove once more after a short pause. NEW, unverified, narrow.
2. Not pinned by a test: the double-signal guard and first-signal exit code (~:91-92), the exit-handler cleanup (~:220), `pg_isready -h 127.0.0.1` (~:172), the Redis PONG and noeviction checks (~:178-187), the `docker port` multi-line parse (~:161). NEW, coverage.
3. `scripts/lib/ci-gated.mjs` ~:3 imports the test helper `scripts/test/workflow.mjs` from non-test tooling. Harmless now. Low.

### T752 · FNF[task-create-path-busy-race] · a task-create test races its sleep against the start lock's timeout

status: DONE in #1318 (2026-11-22: the busy block lowered only the repository-tasks bound; plan, root-merge and global-kb waits kept the real 5 s task-start bound. Both now drop to 400 ms; 65/65 via `pnpm test:gated`) · kind: test · found: #1316 driver 2026-11-22 · priority: P4

`packages/api/test/task-create-path.test.ts` ~:1346 races `sleep(5_000)` against `TASK_START_LOCK_TIMEOUT_MS = 5_000` (`packages/database/src/repository-task-lock.ts` ~:28); the margin is about one poll, so host load flips it. It failed once in a full local gated run and passed 3 of 3 alone. Drive the timeout with an injected or fake clock, or a lock held until released, instead of a real sleep (`docs/architecture/testing.md` "No real waiting"). PRE-EXISTING.

### T753 · FNF[extension-bridge-ci] · no CI job runs the Desktop bridge's Go checks

status: done 2026-11-22 #1320 (8722f1e80): `desktop-bridge-go` CI job (vet linux/windows/darwin, gofmt, tests) on changes under the bridge directory, pinned by `scripts/test/ci-desktop-bridge.test.mjs` · kind: chore · found: #1317 driver 2026-11-22 · priority: P4

No workflow runs `go test`, `go vet`, `gofmt` or the cross builds for `docker/desktop-extension/bridge/`; only the regex pins in `scripts/test/desktop-extension.test.mjs` run in CI (`ci.yml` ~:74). The Go suite runs only when the extension image is built (`docker/desktop-extension/Dockerfile` ~:9-20 via `scripts/build-desktop-extension.sh`). Add a CI job in the pinned golang image that runs vet (linux, windows, darwin), gofmt and the tests on changes under that directory. PRE-EXISTING.

### T754 · Translator source form lists no upload on a new task (+1)

status: done 2026-11-22 haive-module-translator#15 (2e78275), deployed: item 1, with no upload the source form shows only an upload-then-Retry note and an empty submit fails with that remedy; item 2, consent refusals (same conditions and position) name the consented rows and the step-CLI remedy, and the consent form says each translator step's CLI must be a ticked row; README and CHANGELOG updated. Lows: empty form drops the storage note; a PDF-only upload gets the same note without saying it was ignored; host shows Submit on a note-only form · kind: fix · found: T735 free-step walk 2026-11-22 · priority: P3

In `martinambrus/haive-module-translator`.

A task's Attachments tab exists only once the task does, and the task parks on "Select a source document" right after its health check. That form's `Source upload` options come from `detect` (`src/steps/tr-ingest.ts:29`, `detected.sources`), and a parked form schema is frozen, so on every new task the list is empty and the select is required: the user must upload, then click Retry on the step. Measured on the dev stack: empty list after upload and after reload; after Retry the upload is listed and ingest completes. The walkthrough now tells the owner to Retry. Fix direction: when `detected.sources` is empty, park a form that says to upload in the Attachments tab and submit (or Retry) to re-read, with no required select; on submit with no source, throw a message naming that action. Control: a step test with no attachment at detect, then one added before submit.

2. Consent does not route dispatch. A translator task created without a CLI (or with a non-consented one) dispatches its first glossary call to the task's resolved CLI; the module's pre-enqueue hook then refuses it ("Dispatched provider is outside current content consent"), and the user has to set each dispatching step's CLI (`tr-glossary`, `tr-calibrate`, `tr-translate`, `tr-review`) to a consented row and retry. Measured on task ae8fb29c 2026-11-22 (refused before enqueue, no attempt spent). Fix direction: name the remedy in the refusal, and have the consent form state which CLI each step will use (or preselect the consented row through the host's step-CLI choice if the SDK allows it). (+1)

### T755 · The model-health canary probes a provider a module type never uses

status: done (host #1323 77afe801a, migration 0249, deployed 2026-11-22; translator opt-in haive-module-translator#16 899f115, deployed 2026-11-23: the translate type's row has `selects_own_providers = t`; load fails clearly on a host that strips the flag; follow-ups T761) · kind: fix · found: T735 free-step walk 2026-11-22 (owner: file it as its own fix) · priority: P3

In `martinambrus/haive` (host), with a one-line follow-up in `martinambrus/haive-module-translator`.

`packages/api/src/lib/task-type-definition.ts` ~:344-352 prepends `00-model-health-workflow` to every non-built-in static run list that has a step declaring `dispatchesCli` (documented: `docs/architecture/task-types.md` ~:255). The canary probes the task's resolved CLI, which for a task with no CLI is the user's default (`resolveTaskCliProviderId`, `docs/architecture/step-summaries.md` ~:78). The translator never dispatches to that provider: its calls go only to the providers ticked at its setup consent (`src/steps/tr-setup.ts` ~:64-66), and its pre-enqueue hook refuses any other. So on a translator task the canary spends on a provider the user did not choose, before the module's consent, and does not check the provider that will do the work. The module README discloses the call ("can run before module consent"); the owner judged it a defect. Measured: task ae8fb29c, no CLI picked, the canary called claude-code (claude-opus-4-6): 26.6k cached tokens, about $0.27 API-equivalent. Fix direction: a module manifest field saying the type selects its own providers, which the prepend honours (no canary for that type); the translator sets it and its README drops the canary sentence. Controls: a definition test that a module type with the field gets no canary and one without it still does; a task-creation test on the module-seed path.

### T756 · FNF[updater-attempt-fields-followups] · minor follow-ups of the early-refusal fields (+8)

status: open for items 2 and 3; items 1, 4, 5, 6, 7, 8 DONE in #1339 (a1849f0ad, 2026-11-26: attempt note kept within the error cap, one strict env parser, held-directory version read, ordering and edge controls) · kind: fix · found: #1321 reviews 2026-11-22 · priority: P4

1. DONE (#1339). `packages/updater/src/journal.ts` ~:94: truncating the refusal message drops the appended note. REGRESSION, minor.
2. `packages/updater/src/envkeys.ts` ~:48: `literalEnvValues` is exported generically though only the display read uses it. PRE-EXISTING, minor.
3. `envkeys.ts` ~:35: the multiline parser is quadratic on long values (bounded by the 256 KiB cap). PRE-EXISTING, minor.
4. DONE (#1339). `packages/updater/src/run.ts` ~:104-107 parses `.env` differently from `envkeys.ts`; the two can disagree on a quoted value. PRE-EXISTING, minor.
5. DONE (#1339). `.env` is lstat'ed through the held directory, then read by path in `readInstall`. PRE-EXISTING, minor (fs-safe conversion).
6. DONE (#1339). No test pins lstat-before-open for the display read (the FIFO case proves no block, not the order). Minor.
7. DONE (#1339). The disagree and invalid-channel controls were never shown red on the base. Minor.
8. DONE (#1339). The note-joining punctuation regex and literal vs resolved channel inside `readInstall` are untested edges. Minor.

### T757 · FNF[fix-loop-escalation-atomicity] · cap/oscillation escalation is four separate writes (+7)

status: done (#1329 3c14e71c8, deployed 2026-11-23: items 1, 3, 6, 7, 8 and 9's unpinned half fixed; item 4 stale; item 5 recovered by the stalled re-drive, control added; item 2 and 9's pinned half moved to T766 now that PR7b is merged) · kind: fix · found: T741 review 2026-11-23 · priority: P3

1. `packages/worker/src/queues/task-queue.ts` ~:2660 (oscillation) / ~:2742 (cap): parking the row, `recordFixLoopRequest`, `markTaskWaiting` and the `fix_loop.escalated` event are four awaits outside one transaction. A crash after the park leaves a gate with no recorded next-round request and no event; since the duplicate guard refuses a replay at a parked gate, nothing completes the hand-off, and Continue enters a round with no diagnosis. PRE-EXISTING, by code reading (probe first). Fix direction: one transaction under the existing fences.
2. `packages/worker/test/custom-fix-recovery-db.test.ts` ~:441 skips the pinned custom-target leg for the Continue reset (`if (!leg.pin)`); the pinned path is only unit-stubbed (`fix-consumer-router.test.ts` ~:614-628). Minor; dormant while the custom-fix fence is closed (T689 PR7b).
3. `packages/worker/src/queues/insight-continuation.ts` ~:120: the `tx as unknown as Database` cast is redundant now that `resetStepAndDownstream` takes `Database | DbTx`. Minor.
4. `task-queue.ts` ~:3201-3221 `reopen(target, nextRound, record, true)`: bare boolean; a named option reads better. Minor.
5. `task-queue.ts` ~:2869 (Codex connector on #1326): the fix-round handoff enqueues the next job after its transaction commits; a crash between commit and enqueue leaves the pointer moved with no job until the stalled re-drive picks it up. Verify the re-drive covers it before changing anything. PRE-EXISTING, consequential if the re-drive misses it.
6. `task-queue.ts` loop_back losers: a handoff that lost the race may still record its `step.loop_back` event (Codex connector on #1326). PRE-EXISTING, minor.
7. `task-queue.ts` ~:2804-2806 and ~:3237-3240: `steps.slice(steps.findIndex(...))` is unguarded; a -1 would reset only the last step. Unreachable today (the target comes from the same list). Guard it or derive the range from `routableFixLoopTarget`'s list. Low.
8. Revise has the same gap #1326 closed for Continue and loop_back: `task-queue.ts` ~:2965 resets only `result.targetStepId` at the forked round, so after a late editor's validation-only round a Retry of an early card whose gate revises reuses stale downstream rows. Contrived reachability; `successor.recheck` (~:2476) not examined. PRE-EXISTING, related first-party.
9. Test gaps (#1326 review 5): no first-existing control on the pinned custom-target leg; no two-pass or Stop-after-reset control over a validation-only round. Low.

### T758 · Desktop bridge: a killed bridge leaves its Compose child running past its install lease

status: open · kind: design · found: T744 driver 2026-11-23 · priority: P3

A SIGKILLed bridge cannot cancel `docker compose` (`docker/desktop-extension/bridge/main.go` ~:781, `runCommand` ~:795 uses `exec.CommandContext` with no process group or parent-death setup); its install lease (`stack_lock.go`, beats 5 s, broken after 60 s unchanged) lapses while Compose still starts or stops services, and an updater may then snapshot or migrate concurrently. PRE-EXISTING, consequential. Options with costs (design note `.claude/tmp/codex-run/T744-S/codex-1/bridge-design.md`): Linux process group plus `PR_SET_PDEATHSIG`; macOS parent-pipe watcher; Windows kill-on-close Job Object; lease renewal tied to a child-owning supervisor. Compose project labels cannot prove an in-flight client. Recommendation: OS-specific child supervision with group/Job cancellation, the lease held until the supervised command exits; ambiguous interrupted operations keep refusing for manual recovery. Needs an owner decision on scope (all three OSes vs Linux first).

### T759 · Updater: losing the stack lease does not fence the holder's later phases

status: done (#1330 9974653a3, 2026-11-23; updater code, ships with the next release image. Bot round fixed: a failed read no longer enables torn-record tolerance, reverse resume runs in the recovery scope, a loss while pruning keeps done. Ownership proved from the stored record before each phase, write and container start; proven loss `stack-lock-lost` sticks, unproven `stack-lock-unproven` refuses forward work but lets recovery run; residual T765; the postgres-down takeover stays T760 item 1) · kind: design · found: T744 review 2026-11-23 · priority: P3

`packages/updater/src/stack-lock.ts` ~:146-149: lease loss only stops heartbeats. A holder frozen over 60 s that resumes after a takeover keeps running its phases and can start one-shots the new holder's child check (T744) never saw. PRE-EXISTING, consequential. Fix direction: check lease ownership (a fencing token) before each phase and each container start, and abort on loss.

### T760 · FNF[updater-takeover-order] · a takeover may fail before it reaches the child check (+2)

status: open for item 2; items 1 and 3 DONE in #1339 (a1849f0ad, 2026-11-26: connection-class journal bootstrap failures refuse with `updater-bootstrap-failed`, exit 3, naming the code and the one-shot survivor check; boot and other errors pass through; a second cleanup listing) · kind: fix · found: T744 review 2026-11-23 · priority: P4

1. DONE (#1339). `packages/updater/src/cli.ts` ~:336: `ensureJournal` and the database bootstrap run before the lock and the child check, so after an updater killed mid-snapshot (Postgres stopped by `composeStop`) a takeover probably fails at the journal connection with no named refusal. PRE-EXISTING, unverified: probe first.
2. `packages/updater/src/docker.ts` ~:262 `restoreVolume` has no caller. PRE-EXISTING, minor.
3. DONE (#1339). A `docker run` already exec'd when the SIGTERM cleanup marks the attempt stopping (`docker.ts` `stoppingAttempts`, #1325) can create its container after the cleanup's list, so it survives the exit; the next start's child check refuses on it (fails closed). Close it by re-listing once after removal. Low.

### T761 · FNF[T755]: own-provider type follow-ups (+6)

status: open · kind: fix · found: T755 reviews 2026-11-22 · priority: P3

All PRE-EXISTING, minor, unless noted.

UPDATE 2026-11-23: items 1-3 DONE #1331 bc029cbcb (deployed; New Task showed an optional CLI picker and sent unused provider fields, now `dispatchesCli: false` from the stored flag; admin badge; stub test moved into the gated matrix). Lows from its review: the matrix row `own-providers-quiet` (flag true, non-CLI module step) is a valid case but not a control for the exemption (the route rows are); the own-provider predicate lives twice (`api/src/routes/task-types.ts` ~:162-166, `api/src/lib/task-type-definition.ts` ~:347-351), share a helper. Item 6 IN PROGRESS (translator branch `fix/storage-writers`).

1. `GET /task-types` still reports `dispatchesCli: true` for a type with `selects_own_providers` (`api/src/routes/task-types.ts` ~:160-165 `dispatchesCliOf` ignores the flag). Unverified effect: whether the New Task form then shows a CLI picker the module never uses. Check the form first; change only if it does.
2. Admin JSON carries `selects_own_providers` (whole-row spread, `task-types.ts` ~:188,465,559,630,845,855), but `AdminTaskType` (`web/src/lib/api-client.ts` ~:2640-2662) declares neither it nor `executionContract`, so an admin cannot see which module types skip the canary. A read-only badge on the admin task-types list.
3. `api/test/task-type-own-providers.test.ts` ~:30-62 stubs the exact Drizzle select chain; a refactor of `readStepCatalog`/`readModuleStates` breaks it for unrelated reasons. Move the control into the real-Postgres matrix `task-type-definition.test.ts` (`TRAIT_ROWS`) as an own-providers row.
4. DONE (translator #17 ea898f8, deployed 2026-11-23: consent projects accounted + setup + 8 x units x 381,312 B, refuses a short quota before any paid call, measured on real Postgres). OWNER QUESTION open: the reserve caps a document at about 175 units (about 175k words; was 1,000 units) and counts against the 2 GiB owner quota. Translator module (`martinambrus/haive-module-translator`), consequential: `README.md` ~:638 (M6) storage headroom. A tight consent quota can pass setup and then fail translation or render after paid work; the setup form's minimum does not reserve the headroom later passes need.
5. Translator, low: a Retry of consent after spend counts the unspent allowance twice (#17 review 1 D5). PRE-EXISTING.
6. DONE (translator #18 bdb5f87, deployed 2026-11-23, migration 0010: every post-consent writer is bounded and reserved; render output is admitted before consent by a bound the property test checks against the real renderers, nesting included; flat ceiling 130 units, two list levels 93, five 42, ten quote levels 107). Was: translator, PRE-EXISTING (#17 driver): storage written after consent with no lifetime bound in the projection: human review decisions and patch histories (`src/db/review-patches.ts` ~:118), rendered artifacts (`src/db/artifacts.ts` ~:108), repeated metadata rewrites and operator histories (`src/db/passes.ts` ~:348, ~:818). Each can still exhaust the quota after paid work; bound each writer or reserve for it.
7. Translator, low: the full `test:ingest` wrapper's `check:host` needs the module installed in the host worktree (`pnpm module add translator`) and api/worker dist; a driver brief should say so.

### T762 · FNF[T749]: step warning column follow-ups (+3)

status: parked 2026-11-26 (session triage, not owner: low, coverage-only or inputs no current path produces); item 3 and the two test gaps below remain; items 1 and 2 DONE #1327 df46d2875 (deployed 2026-11-23: the history headline no longer reads the warning column; the five RAG banner writes go through `updateOwnedStep`) · kind: fix · found: T749 driver and review 2026-11-22 · priority: P4

All PRE-EXISTING.

1. Consequential: `web/src/lib/task-history.ts` ~:169 keys a headline ("finished with a warning") on `warningMessage` truthiness, against "a message column is display copy, never state" (AGENTS.md). Any stale or informational note becomes a state claim in the history panel. Key it on a structural signal, or drop the claim and show the note as text.
2. Minor: the RAG writers update `task_steps` with a bare `ctx.db.update(taskSteps)` and no ownership fence (`_rag-index.ts` ~:647,1024, `10-rag-populate.ts` ~:443,814,1007), against `worker-restarts.md` (every pass write goes through `updateOwnedStep`). A superseded RAG pass can write its banner onto a retried row.
3. Minor: `stepWarningAppend` (`worker/src/step-engine/step-ownership.ts` ~:92-95) dedups by substring (`strpos`), so a distinct shorter note contained in an earlier one is dropped. Retry notes carry their attempt number, so a clash is unlikely; dedup on whole notes if it bites. #1327's driver found no whole-note rule that keeps the existing append contract (notes are space-joined, so boundaries are lost); a fix needs a separator change and its tests.
4. Low, test: `worker/test/rag-step-warning-db.test.ts` (~:94-100) proves the SET side on real Postgres only for the two degraded onboarding sites; the workflow sites assert only the clear.
5. Low, test: no history control that a note alone yields no entry (`web/src/lib/task-history.test.ts` ~:88-116; the `entry()` helper's default 07 step always matches the fix-pass branch).

### T763 · Flaky tests: global KB empty-body e2e (+1)

status: done 2026-11-26 (#1340, 7c1fa45d0: the e2e clears through the editor keymap after focus and asserts emptiness; the RAG guard fake server answers a terminal `28P01` and asserts one dial; docs `testing.md`) · kind: test · found: #1325 CI 2026-11-23 · priority: P4

`tests/e2e/settings/global-kb-edit.spec.ts:218` ("rejects an empty body and preserves corrections when saving fails") failed on every in-run retry at #1325's head 5f1fc9cc5 (run 45088903767: `dialog.getByText('The article body cannot be empty.')` not visible within 5 s), then passed on a job rerun; main and the PR's previous head were green, and the PR touched only the updater. Find why the validation message can fail to render (an async state the test does not wait on, a debounced validator) and fix the test or the race, not the timeout.

2. `packages/shared/test/rag-connection-guard.test.ts:67` ("dials a loopback store the allowlist covers") timed out at 5 s in the Unit tests (other packages) job on #1328 (run 45094064034), which does not touch RAG; the job's logs show ECONNREFUSED dials just before. Same approach: find the wait, not the timeout.

### T764 · FNF[T689-PR7b] · custom fix target follow-ups (+10)

status: open for items 3, 9 and 11-13 (lows); items 1, 2, 4, 5, 6, 7, 8, 10 DONE in #1341 (764e60442, worker reloaded 2026-11-26: fix-round requests carry the START marker id, claim and marker in one transaction, legacy unstamped requests count as before, one predicate for every fix-round reader; module fix target house rules need `file_write`; fan-out refusals named, withheld steps warned at boot) · kind: fix · found: PR7b reviews 1-4 and bots 2026-11-23 · priority: P4

All low unless noted; PRE-EXISTING means older than #1328.

1. DONE (#1341). `fix_loop.requested` is not scoped to a START generation (`task-queue.ts` ~:427 resets the round, events persist), so a stale event can make a revise round look like a fix round and skip it as a guard baseline. PRE-EXISTING, same exposure as 07's `shouldRun`.
2. DONE (#1341). House rules on the module path are not capability-gated (`worker/src/orchestrator/house-rules.ts` ~:48 returns `write` for a pinned module consumer on every round).
3. A fix round may pair a dependency span's own latest decision with a dependent's older one after a revise flipped it (accepted and documented in `task-types.md`); optional control that pins the pairing.
4. DONE (#1341). No real-Postgres control for a reset named dependency row (`guard-decisions-db.test.ts`; only unit fakes prove the refusal).
5. DONE (#1341). `isFixRound`'s single read still selects whole `fix_loop.requested` payloads (diagnoses included) inside the held transaction; select only the round.
6. DONE (#1341). Stale comment `worker/src/step-engine/fix-consumer.ts` ~:58-62 (says an unregistered target is left to the unresolved-step check; the fence refuses first).
7. DONE (#1341). Two leftover "custom fix target" test labels (`execution-contract-skew.test.ts` ~:124, `dead-task-boot.test.ts` ~:962).
8. DONE (#1341). Refusal text for a mining step with `fixConsumer` does not say "fan-out" (`fix-consumer.ts` ~:81, `run-list.ts` ~:353, `execution-contract-support.ts` ~:47); the loader withholds the capability silently, so log a boot warning per withheld step.
9. Rolling-deploy window: the catalog is synced at worker boot, so availability and create admit a mining target until a capable worker booted (the task dies at START by name). Optional release note.
10. DONE (#1341). `guard-gate-agreement-db.test.ts` ~:605 leaves `module.gg.*` catalog rows (deletes `workflowType = 'gg'`, the loader stamps `module.gg`); the `source:` ternary at ~:539 is dead.
11. Low (#1341 review 2 F3-a): no assertion that a lost START claim writes no `task.running` marker (`task-job-epoch.test.ts` ~:2353).
12. Nit (#1341 review 2 F1-a): the 07 DAG legacy control's START assertion is conditional, so it is vacuous if the predicate leaves `isFixRound`.
13. Nit (#1341 review 2 F5): code comments still describe an unscoped read (`_fix-loop.ts` ~:475, ~:769, ~:1036; `shared/src/step/index.ts` ~:54).

### T765 · Updater: recovery under an unproven lease proof is not time-bounded

status: open for item 5 below; the time bound DONE in #1342 (f3092472f, 2026-11-26: unproven tolerance ends one stale window after the last successful record write, stamped before its I/O; proofs and failed writes never renew; torn-write excuse only after a truncating own overwrite; every write attempt takes a new `seq`; same rules in the Go bridge; reverse-resume, commit and full-disk CLI controls) · kind: design · found: T759 review 2 2026-11-23 · priority: P4

`packages/updater/src/lease-fence.ts` ~:30-36, `stack-lock.ts` ~:141-153 (after #1330): failure recovery tolerates `stack-lock-unproven`, so a takeover whose record this holder cannot read (lock unreadable or absent to it for 60 s or more while another holder took over) is not fenced during rollback, restore or the postgres restart. Narrower than before #1330. Fix direction: bound the tolerance by time since the last good proof or beat (refuse as lost past the stale window). The same holds for the own-write torn-record tolerance after #1330 fix 2 (`stack-lock.ts` ~:153, :220, :236-241: no time bound, and set when `overwrite` fails at `open` before truncating anything). Cross-code (PRE-EXISTING): the Go bridge's beat (`docker/desktop-extension/bridge/stack_lock.go` ~:176-206) sets `failing` on a read error or failed create too and then accepts a non-JSON record as its own and overwrites it, the pattern #1330 fixed in the updater. Also from the same review (D4, low): no control for an unproven proof in the reverse-resume path or the commit phase (`cli.ts` ~:453-463, ~:670), and no CLI-level control for the full-disk trace (torn own record, failing snapshot, postgres restarted); the heartbeat's read-then-overwrite can truncate a lock a contender created between the two (`stack-lock.ts` ~:180-196, PRE-EXISTING); the fence defaults open when no lease scope is bound and docker fencing is an allow-list (`lease-fence.ts` ~:17-19, `docker.ts` ~:194).

5. OPEN (#1342 driver, reproducer `.claude/tmp/codex-run/T765-S/codex-1/stack-lock-race-repro.test.ts`): the heartbeat reads its own record, then opens it with `O_TRUNC`, so a contender that broke the lock and created its own in between is truncated and overwritten (`stack-lock.ts` ~:221, `stack_lock.go` ~:196-219). Fix direction: open `O_RDWR|O_NOFOLLOW` without truncation, compare through that descriptor, then ftruncate and write on it; the Go twin needs a Windows sharing check (FILE_SHARE_DELETE). Estimated 1-2 days for both implementations. Very low real-world frequency (a 60 s stall between read and open).

### T766 · FNF[T757]: fix-loop handoff follow-ups (+5)

status: open for items C1-C3 below; items 1-5 DONE #1332 (eebe8e039, deployed 2026-11-26: pinned-target leg of the recovery controls, structured revise refusal codes, guarded-revise controls, `StepNotInRunListError` with its own dead reason, Accept with a next step accepts findings in the gate transaction) · kind: fix · found: T757 reviews 2026-11-23 · priority: P4

1. T757 item 2 and the pinned half of item 9 (deferred until PR7b): apply the T757 controls to a pinned custom fix target (the `atomic revise` block in `custom-fix-recovery-db.test.ts` runs only `if (!leg.pin)`).
2. A lost revise logs one bare `revise not entered` line with no reason (`worker/src/queues/task-queue.ts` ~:3047-3052); add the refusal reason as loop_back's `logRefusal` does.
3. No revise control with a non-empty `guardedSpans` pin (guarded reset branch, source held at another round).
4. The `findIndex` guards reuse `UnresolvedStepError`, so the dead-task reason says the install does not register a step that is registered but absent from the run list (`task-queue.ts` ~:908-913 `deadReasonFor`).
5. Continue's Accept branch accepts remaining findings outside the transaction; a crash between leaves a window (PRE-EXISTING, informational).

Found in #1332 (PRE-EXISTING, Connected):

C1. Boot can revive a dead task whose registered revise target is still off the run list, so it dies again on the next pass.
C2. The api and web missing-step wording ignores the stored dead reason, so an off-list step still reads as not registered in the UI.
C3. Accept with no next step still writes the findings in a separate statement after the gate closes; a crash between leaves them open on a finished gate.

### T767 · Translator: books of any size with one glossary and one style

status: open, in work 2026-11-26 (design analysis: `.claude/tmp/codex-run/TRBIG-S/`; OWNER DECISION 2026-11-26: one task per book, one glossary and style, batched translation/review with storage reserved per batch) · kind: feature · found: owner decision 2026-11-26 · priority: P2

In `martinambrus/haive-module-translator`. Owner (2026-11-26): "the translator module should be able to translate book of any size, so if we have to update it to do it in parts because of a possible big size, that's fine as well, we just need to keep the vocabulary and terms and the such intact between them".

Today consent reserves worst-case storage for all `8 x U` calls up front (about 3.5 MB per unit, `src/protocol/storage.ts`), and a document's quota tops out at 512 MiB, so flat prose stops at about 130 units (roughly 90,000 to 130,000 words); nesting lowers it. Over that, consent says to split the file, which makes separate tasks with separate paid glossary and calibration, so terms and style can drift. A unit is whole paragraphs up to about 1,000 words (`src/chunking/group.ts`).

1. Design: one task per book with one glossary and one approved style, translated and reviewed in batches with storage reserved per batch (recommended), versus part tasks importing an earlier part's approved glossary and style. Plan in `docs/plans/` before building; review at xhigh (consent, money).

- PR1 review (2026-11-26), found-not-fixed for later PRs: F8 `ownerResources` runs about 25 aggregates per owner task, several times per admission under the owner lock (scale; PR2's bounded lookups). F9 the unused render reserve and control headroom of a completed book stay counted until purge (same order as the old whole-run reservation; PR3). R5 (review 2): batch-mode readers use a per-row correlated `EXISTS` with no batch-mode scale test (PR2).

### T768 · Translator: keep terms refused when the target language declines them

status: done 2026-11-26, module #20 (d8a8db7, deployed with `pnpm docker libs`): literal matches always count; a 5+ letter keep word also matches a same-script stem (word minus 2 letters) where nothing else overlaps; one helper for passes, review and patches; README states the false-accept floor (`Marek` to `Marcel` passes). Owner to Retry `tr-translate` on ae8fb29c · kind: fix · found: owner task ae8fb29c 2026-11-26 · priority: P1

In `martinambrus/haive-module-translator`. The owner's English-to-Slovak run failed at `tr-translate`: unit 0's accuracy pass was accepted, its restructure pass was refused with `Source-present keep term missing`. `keepTermLost` (`src/protocol/passes.ts` ~:115, used ~:142, `review.ts` ~:123, `patch.ts` ~:50) needs the literal keep term in the target as often as in the source, so a declined name (Marek to Marka) fails. One attempt is left on that pass key.

1. Accept a declined form (same stem, up to 2 trailing letters changed on words of 5+ letters) at every keep-term check; a translated name still fails; codes and short words stay exact. Then the owner Retries the step.

### T773 · Translator review: finish without more calls, keeping the current text

status: open, plan approved 2026-11-26 (`docs/plans/translator-review-continuation.md` PR E, after T772's PR D) · kind: feature · found: owner decision 2026-11-26 · priority: P2

The owner wants this built, not optional. On the T772 budget form, review gets a third choice: finish without more calls, keeping all accepted text and already applied corrections. Remaining units stay unreviewed and outstanding proposals stay unapplied; an explicit, unticked acknowledgment records a waiver bound to that exact text snapshot (T772 design section 5).

1. Record the waiver (owner, event, snapshot digest, unreviewed units, waived proposals) without a call; the review step completes with `complete:false` and a factual summary.
2. Render accepts `owner-waived` coverage only for a matching waiver; ordinary incomplete review still refuses. Render form, summary and manifest say "review ended by owner; X/Y reviewed".
3. The choice appears on the budget form only in the release where render accepts it.

### T772 · Translator: an exhausted call budget parks with a decision form instead of failing

status: open, plan approved 2026-11-26 (`docs/plans/translator-review-continuation.md` PRs A2, D; owner: grant bounds min(1000, 8U) per grant and at most +8U over the task's life, one extra attempt per decision and at most two per pass, no in-form Stop) · kind: ux · found: owner task ae8fb29c 2026-11-26 · priority: P1 (owner: showstopper)

`tr-review` (and `tr-translate`) fail the step with the generic `Translation attempt allowance exhausted` (`src/db/passes.ts` ~:240, ~:246, ~:306) when the approved ceiling (`8 x U` plus extensions) or a pass key's two-attempt cap is spent. On ae8fb29c four cascading review rounds of a 2-unit sample spent 16 of 16 calls. The only way on is the admin-only operator `extend` route, which has no UI.

1. Park instead of failing, through the same seams as the T767 PR1 storage wait: a payload-free form naming the case (`TRANSLATOR_CALL_BUDGET_REACHED` for the task ceiling, `TRANSLATOR_PASS_ATTEMPTS_REACHED` for one key's attempts, with the refusal reason), the pass, unit and review round, spent against approved calls, and what the current round still needs.
2. Choices: add calls (prefilled with what the round needs; the task owner decides, audited like `extend`), for review also "finish without more calls" keeping the current text, or stop. Resume continues from cached accepted results.
3. A distinct, specific message everywhere the step reports it.

### T771 · Translator review: ticked corrections continue without a Retry stop

status: open, plan approved 2026-11-26 (`docs/plans/translator-review-continuation.md` PRs A1, C; host PR A1 in work) · kind: ux · found: owner task ae8fb29c 2026-11-26 · priority: P2

OWNER DECISION 2026-11-26: submitting the correction form continues on its own. When applied corrections change text around other units, `tr-review` reopens with a form whose only action is Retry (`buildRetry`, `submitAction: 'retry'`), and Retry is the button a failed step shows. The ticks are the consent to the re-review cost; Retry stays for failures. Nothing ticked already finishes the step.

1. Re-review the changed units automatically after a submit, with a bound on cascading rounds that ends in a form, not a failure. May need a host seam: the reopen re-runs detect and the form but not the pre-form agent loop.
2. Drop the "I have read the outcome" confirm form when the review proposed nothing (recommended to the owner).

### T769 · Task page: no "Show RAG stats" link on a step that made no RAG query

status: open · kind: ux · found: owner request 2026-11-26 · priority: P3

The step card shows `Show RAG stats` for every step that ran an agent (`ranAgent = step.cliInvocationCount > 0`, `web/src/app/(app)/tasks/[id]/page.tsx` ~:3696, link ~:4424). Whether any `rag_search` happened is known only after the click, when `RagStatsPanel` says "No RAG queries recorded for this step." (~:4548). Steps that never query RAG (module steps with tools off, the translator passes) all carry a link to an empty panel.

1. Give the step DTO a RAG query count (or a has-queries flag), attributed the way `RagStatsPanel`'s endpoint attributes queries (by time window), without a per-step request on page load.
2. A finished step with no query shows a muted info line such as "No RAG used" in the link's place, so steps line up with those that have the link; a step with queries keeps the link. A step still running keeps today's link (queries can still arrive).

### T770 · A form note defaulted to null broke the translator review form

status: done 2026-11-26, #1346 (e8a0fa2d4, deployed with `pnpm docker libs`); owner to resubmit the parked review form · kind: fix · found: owner task ae8fb29c 2026-11-26 · priority: P1

`validateFormValues` (`shared/src/step-engine/schemas.ts`) gave every note the page did not send a `null` value, so saved answers gained a key per note and per reopen notice. `parseApproval` in the translator's `tr-review` accepts an exact key set, so every submission came back as "Submit the form as shown". Nothing was recorded, no paid call was spent.

1. Notes and `global-kb-status` fields never enter the answers. After deploy the owner submits the parked review form again.

### T721 · The Claude usage grant reaches sandbox environments

status: open (items 2-5 and 10-12; item 1 done #1281; items 6-9 done by #1300, 9cc4e4382, deployed 2026-11-21 04:30Z) · kind: security · found: login-set design (T720) 2026-11-19 · priority: P3 (was P1 until #1281)

`resolveProviderSecrets` returns every secret of a provider row (`worker/src/secrets/provider-secrets.ts:5-22`). The run path merges them into the container environment (`worker/src/queues/cli-exec/handlers.ts` ~:350-354, `exec-core.ts:732`, `sandbox/docker-runner.ts:474-475`), and so do the probe, the terminal and the image checks. A claude-code row with a usage connection therefore hands `CLAUDE_USAGE_OAUTH`, an OAuth refresh token whose scope includes `org:create_api_key` (`shared/src/cli-providers/claude-oauth.ts:35`), to every sandbox run, where repository code can read it. Only the worker's usage poller needs it. PRE-EXISTING. Live proof on the dev install 2026-11-19, names only: before the fix the env resolver returned `CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_USAGE_OAUTH` for the run row; after it, `CLAUDE_CODE_OAUTH_TOKEN` alone, and the poller's by-name read still returned the grant.

1. DONE #1281 (132d5dfc3, deployed 2026-11-19 10:00Z): `resolveProviderSecrets`, the one resolver every env builder uses, skips the names in `WORKER_ONLY_SECRET_NAMES`; the poller reads its grant by name through `readProviderSecret`.
2. Ask for less: check whether the authorize endpoint accepts `user:profile` alone, the one scope the usage endpoint enforces. Needs a live Connect by the owner.
3. Disconnect and sign-out delete the stored grant but never revoke it at the vendor (`api/src/routes/cli-providers.ts` ~:1346-1382, `handlers.ts` ~:1436-1448).
4. OWNER: reconnect usage once now that item 1 is deployed, so a grant a sandbox could read is replaced. A refresh rotates the token, which should retire the old one; the vendor's behaviour is unverified.
5. Same seam: an api-key claude row that still stores a login token injects it too (`provider-secrets.ts:5-22`, `worker/src/cli-adapters/base-adapter.ts` ~:127-137). Decide which credential such a row should carry.
6. DONE #1300. `WORKER_ONLY_SECRET_NAMES` is a hand-kept list: nothing ties it to the `oauthRefresh` entry in `worker/src/usage-window/fetchers/index.ts:53`, and no test pins that `provider-secrets.ts` is the only place in the worker that decrypts `cli_provider_secrets`. A new worker-only secret, or a second decrypt site, would pass the rule by silently. #1300: a test ties every `oauthRefresh` secret name to the set, and a source ratchet pins the decrypt primitives per worker file with exact counts. The premise was stale: `worker/src/usage-window/usage-grant-set.ts:72` decrypts the grant too (the poller's read, never merged into an env); it is pinned beside `provider-secrets.ts` and `repo/credentials.ts`.
7. DONE #1300. `ClaudeOauthError` embeds up to 200 characters of the token endpoint's error body (`shared/src/cli-providers/claude-oauth.ts:130`, `:163`). The text reaches the Connect HTTP 400 (`api/src/routes/cli-providers.ts` ~:1277-1280) and the poller's warn log (`worker/src/queues/usage-poll-queue.ts` ~:253-256). Whether that body can echo a token is unverified. PRE-EXISTING. #1300: the message keeps the status and a registered RFC 6749 code only; a 200 body that is not JSON throws a fixed message, since the parser's SyntaxError quotes the body.
8. DONE #1300. A hand-typed `envVars` entry named `CLAUDE_USAGE_OAUTH` is not secret-like by name (`shared/src/schemas/cli-providers.ts:98`), stays plaintext and reaches containers. No Haive writer puts the real grant there. PRE-EXISTING, low. #1300: stripped at every builder of a container env (`omitWorkerOnlyEnv`), stored rows untouched; no save-time refusal (item 10).
9. DONE #1300. `isAuthSecret` (`worker/src/secrets/move-secret-env.ts:11-12`) names the usage secret, which can never reach it; that half is dead. PRE-EXISTING, cosmetic. #1300: the dead half is removed.
10. LOW, follows #1300: a typed `CLAUDE_USAGE_OAUTH` entry still saves, shows in the provider form and feeds the composed-LSP provider identity (`worker/src/lsp/composed-evidence.ts:55`), yet is inert, with no feedback. Fix direction: refuse the name at save with a clear validation message. PRE-EXISTING (before #1300 it reached containers).
11. LOW, test: `worker/test/connected-error-params.test.ts:45` mocks `secrets/provider-secrets.js` with `resolveProviderSecrets` only, so a path it loads that calls `omitWorkerOnlyEnv` would throw a mock error. Passes today. Fix direction: spread the original module into the mock.
12. LOW, gap: the decrypt ratchet scans worker source only, so the shared wrappers `decryptCliLoginCandidate` (`shared/src/cli-providers/login-candidate.ts:21`, used at `worker/src/queues/cli-exec/handlers.ts` ~:720 for the login token) and `decryptConnectionTokens` (`shared/src/integrations/connection-tokens.ts:27`) open envelopes outside it. Neither reads `cli_provider_secrets`. Fix direction: pin the wrapper names too. PRE-EXISTING.

### T720 · A Claude login reaches one provider row, its sign-out resets them all

status: done 2026-11-20 (owner decided 2026-11-19); login and sign-out for the whole set merged #1282 (3a7b57ac1) and deployed 2026-11-19 13:10Z; set-wide paste, typed token and delete merged #1283 (5cfe1f86a, with the provider-row lock order against the image job), deployed 2026-11-19 17:32Z; rows joining a set (create, clone, un-isolate, auth mode) merged #1285 (bb8276fd2), deployed 2026-11-20 03:33Z; the usage connection merged with the owner's OK as #1291 (03f9143df, poller) and #1292 (50804c662, api and web), deployed 2026-11-20 17:29Z; the first poll tick at 17:34:38Z replaced the 40 dead usage grants of the dev install (40 `cli_provider.secret.set` audit rows) · kind: design · found: #1280 review 2026-11-19 · priority: P2

A `claude-code` subscription login is a token saved on the one provider row it was made on (`api/src/lib/cli-login-secret.ts` `saveCliLoginSecret`), and each run reads the token of its own row (`worker/src/secrets/provider-secrets.ts`). A sign-out through one row deletes that row's token (`worker/src/queues/cli-exec/handlers.ts` ~:1436-1449) but resets `auth_status` on every row sharing the auth volume (~:1451-1472). The other rows keep their own tokens, which may still work, and read `unknown`.

Seen on the dev install: one sign-out left 40 `claude-code` rows `unknown`, each still holding a token saved between 2026-06-29 and 2026-10-16; the login that followed reached one row. So an account switch needs a login on every row, and a row that was not logged in again keeps running on the token of the earlier account. The providers pages offer **Log in** on each such row (#1280); nothing says the rows are on different accounts.

OWNER DECISION 2026-11-19: one Claude login per user. A login saves the token for every row that shares the auth volume, and a sign-out removes it for all of them. A row with **Isolate auth from other claude-code providers** ticked keeps its own login, apart from the rest. The sign-out's token delete and its status reset must cover the same rows.

OWNER DECISION 2026-11-19: the usage connection (`CLAUDE_USAGE_OAUTH`, refreshed per row by the usage poller) is shared the same way, as its own PR after the login PR. T590 items 32 and 33 are the same gap for the volume-login CLIs.

### T719 · FNF[env-template-lifecycle] · environment template lifecycle leftovers (+15)

status: open · kind: fix · found: legacy template replacement design (T709) 2026-11-19 · priority: P4

All PRE-EXISTING, none blocking the replacement series. Paths are under `packages/`.

1. DONE #1295. Legacy shared forks reuse the name `task-<id8>`, and so the default tag `haive-env-<slug>:latest`, when the acting task also created the source row (`worker/src/step-engine/steps/env-replicate/01-declare-deps.ts` ~:1005-1015, `03-build-image.ts` ~:30-36). Not seen live. Fix: a tag check in 03's detect, or the row-id suffix the replacement series gives contract-2 rows (that changes every legacy tag).
2. The boot reaper counts `completed` and `failed` tasks as dead (`worker/src/sandbox/env-template-reaper.ts:7`), while `pinsEnvTemplate` releases a pin only on `cancelled` (`env-replicate/_shared.ts:91-98`). A failed task that is Retried later can find its non-ready template row reaped.
3. 01 inserts the template row and links the task in two statements, not one transaction (`01-declare-deps.ts` ~:1005-1018). A crash between them leaves an unlinked row.
4. `createTaskSchema` accepts an `envTemplateId` that no route reads (`shared/src/schemas/tasks.ts:92`). Drop the field or wire it.
5. A comment in `api/src/routes/tooling-upgrades.ts` ~:280-284 says the next task re-runs 01 on an existing template; a new task has no link. Comment only.
6. `assertKnownLspInstallContract` throws a bare `Error` that tests match by message (`worker/src/sandbox/lsp-install-contract.ts` ~:12-18). Give it a typed error.
7. Deleting a user cascades `env_templates` rows without removing their images (`database/migrations/0000_baseline.sql` ~:1021; the delete hooks are unchecked).
8. `composedLspImageRefs` of an abandoned contract-2 row keep pinning images after a rollback (`worker/src/lsp/composed-evidence.ts` ~:399-418).
9. A template delete whose `docker image rm` fails because the image is already gone leaves the row behind (`worker/src/queues/task-queue.ts` ~:5011-5019, `worker/src/sandbox/docker-runner.ts` ~:440-448), and the reference count and the delete are not atomic (`task-queue.ts` ~:5001-5021). PRE-EXISTING, found with #1288.
10. 02's relink onto a row with the same hash deletes the row it leaves without removing that row's built image (`worker/src/step-engine/steps/env-replicate/02-generate-dockerfile.ts` ~:171-176), and the env-template reaper lists no images, so the image stays with no row.
11. 04 marks the row ready by id alone (`env-replicate/04-verify-environment.ts` ~:410-413), with no guard that the hash or image it verified is still the row's; a body 02 saved in between would be marked ready on the old image. Narrow.
12. 03 detect probes a ready row's image only when `builtImageId` is set (`env-replicate/03-build-image.ts` ~:78-89); a ready row with a null `builtImageId` is trusted without an existence or identity check.
13. PRE-EXISTING, the harm #1295 closes for 02: an unchanged re-declare of a shared row in 01 still resets it in place (`pending`, hash and `imageTag` null), so its other tasks lose readiness and their tag (`env-replicate/01-declare-deps.ts` ~:1087-1102; `sharedWith` is computed only when `staleDockerfile` is true, ~:1076-1079). Fix: skip the reset when the row is shared and unchanged.
14. Narrow race: the sharer check in 02 (~:214, :221, :260 after #1295) and in 01 is not under a lock with the fork or the in-place write, so a task that relinks onto the row inside that window still has it rewritten; two tasks saving the same new body at once hit `UNIQUE (userId, dockerfileHash)`, and Retry resolves it.
15. TEST-ONLY: the hand-rolled db mock in `worker/test/env-replicate-build.test.ts` ~:173 answers every `envTemplates.findFirst` with the row, so 03's held-tag query sees `defaultTagHeld` true there and nothing asserts it.

### T718 · Translator module lows (review and correction approval) (+12)

status: open · kind: bug · found: translator review milestone (module PRs #5, #6) · priority: P4

In `martinambrus/haive-module-translator`. NEW = a limit of the review feature, none a regression. (a) `src/db/review-patches.ts:95,146`: `page` and `applyRound` load every block version and write about 2.4 statements per proposal. NEW. (b) `src/steps/tr-review.ts:167,178`: a stale or repeated submit after a reopen fails the step (Retry recovers), inherited from the `explicit` pattern in `src/db/setup.ts`. PRE-EXISTING. (c) `src/db/review.ts:32`: `acceptBytes` reserves nothing for decisions or the batch, so near the allowance they can fail after every unit was reviewed. NEW, documented in the README. (d) `src/db/review-patches.ts:174`: seam windows use the target language (equivalent for en and sk). NEW. (e) `src/protocol/patch.ts:87,105,127`: groups built by spread, O(k^2) per block. NEW. (f) `test/review-step.test.ts`: `FakeReviewStore` duplicates `test/support/patch-fakes.ts`. NEW. (g) Documented limits: corrections valid only as a pair are not applied, re-review after a batch needs a Retry, a rejected correction can be proposed again, decisions are final, the reason text is not shown on the page. PRE-EXISTING at `4a2efb8`: (h) `src/manifest.ts:7` `schemaVersion: 4` with 7 migrations; (i) milestone labels in test titles (`test/setup-gates.test.ts:6`, `pass-step.test.ts:12`, `manifest.test.ts:6`, `pass-store.test.ts:20`, `passes.test.ts:8,83`, `setup.test.ts:9`) and the `README.md:14` heading; (j) `src/db/passes.ts:100,105` bookkeeping inserts in read-only sessions; (k) `exactKeys` and duplicate-key pattern (`src/protocol/passes.ts:76,111-128`, `review.ts:88`), and `validateReply` does not check text well-formedness; (l) `test/pass-db.test.mjs:221-233` pins only the allow side of headroom. Added from the assembly and retention milestones (module PRs #7, #8), all PRE-EXISTING: (m) `src/protocol/passes.ts:135-141` `validateReply` does not constrain code or definition blocks or `open:a`/url adjacency, so a word inside a code block still fails `code-block` at the render step, after payment (same function as (k)); (n) `src/db/passes.ts` (session to lineage): the render step checks the live provider policy although it calls no model, while downloads do not; (o) `src/db/passes.ts:131-136` `session()` commits the seen and outcome rows of the task's runs even when the operator action or another `run` is refused (it rethrows after the commit; accounting facts only); (p) `src/db/passes.ts:149` `cap()` throws a plain `Error('Invalid operator extension')` on an unsafe stored total, which surfaces as a 500 instead of a refusal.

From the scale and acceptance milestone (module PRs #9, #10), 2026-11-20: (q) `src/db/passes.ts:107-130`: a ledger call still reads every core run and hashes every ended one in memory, so its CPU grows with the task's runs (296 ms at 20,000 runs) while its statements stay constant. PRE-EXISTING. (r) `src/db/passes.ts:434` and `src/db/review.ts:64`: `rows.find` and `stored.filter` per unit and pass, so the work is O(units x rows). PRE-EXISTING. (s) `src/db/passes.ts:228`: the "Stale unbound intent; operator abandonment required" branch has no harness scenario. PRE-EXISTING. (t) `src/db/review-patches.ts:158-178`, `src/db/review.ts:98-101` and `src/db/artifacts.ts:122-125` run per-row INSERT loops inside ledger or step transactions, bounded by proposals or parts. PRE-EXISTING. (u) `test/support/seam-db-fixture.mjs:81-92`: `countStatements` reports the pass seen and outcome inserts apart from its counted total, which is how per-run recording stayed out of every existing count. PRE-EXISTING. (v) Docs and labels: `README.md:3,5,14,83` carry milestone labels; `README.md:798` says at most two Vitest workers while `package.json` uses `--maxWorkers=1`; `README.md:799` says migrations 0001-0004 are pinned while 0005-0009 exist; `scripts/test-ingest.mjs:13` names its container `translator-m3-`. PRE-EXISTING. (w) The acceptance run builds replies from store parts, so a dispatched prompt is checked but never read to produce the reply, and the review-specific cut points were hit only 3 times. A limit of the new test. (x) REGRESSION (test footprint of module PR #10): `test/scale.test.mjs` needs about 570 MiB of in-memory database and leaves about 125 MB of immutable module rows that later whole-table snapshot tests read in a whole-suite run (`test/artifact-list.test.mjs:53-60`, `test/operator-route.test.mjs:418`); a whole-suite run needs `TRANSLATOR_INGEST_MEMORY` of 1 GiB. Documented in the README, not trimmed. Fix direction: give the scale test its own database.

### T717 · The sandbox image's own uv is unpinned and unused by Haive

status: open · kind: design · found: git MCP warm start (#1279) · priority: P4

The core image and the composer's runtime-tools layer still install uv from `https://astral.sh/uv/install.sh` with no version or hash (`worker/sandbox-image/Dockerfile:45`, `worker/src/sandbox/image-composer.ts:194`). Since #1279 nothing in Haive runs it: the git MCP server uses its own pinned uv at build time only. It costs about 40 MB per image, and agents may still call `uv`/`uvx` in a repository. PRE-EXISTING. Decision needed: drop it, or pin it the way `install-git-mcp.sh` pins its tarball (version plus per-target sha256).

### T716 · Sandbox image supply chain lows

status: open · kind: bug · found: git MCP warm start (#1279) · priority: P4

(a) The filesystem and postgres default MCP servers run unpinned `npx --prefer-offline -y @modelcontextprotocol/server-*` (`worker/src/sandbox/mcp-config.ts:246,257,277`), so an upstream release changes their tool surface mid-experiment; pin them as #1279 pinned git. PRE-EXISTING. (b) Alpine environment templates cannot be composed: the runtime-tools layer runs `apk add uv` (`image-composer.ts:189`), which fails before Alpine 3.21, and the provider install falls back to `apt-get` (`worker/src/cli-versions/codegen.ts:10-12`). PRE-EXISTING. (c) A reused terminal shell container keeps the MCP config it was created with; the git label gate covers creation only (`worker/src/terminal/terminal-container.ts:433-447`). Transitional, REGRESSION-adjacent, clears on the next container. (d) `worker/src/sandbox/npm-cache.ts:76` still says "git pending (uvx)". (e) The first image build after a change needs GitHub and PyPI reachable; no mirror fallback.

### T715 · The git MCP server re-downloads its Python packages on every run

status: done (#1279, 6f88eaaf2, worker reloaded 2026-11-19) · kind: bug · found: agent-memory pilot canary failures 2026-11-18 · priority: P2

Claude-family runs declare the `git` MCP server as `uvx mcp-server-git` (`worker/src/sandbox/mcp-config.ts:276`). The sandbox keeps no uv cache, so every invocation resolves and downloads 32 wheels from PyPI (`queues/cli-exec/resolvers.ts:252` says so). When PyPI CDN throughput drops, the cold start outgrows the CLI's MCP start window and exec-core discards the run: `MCP server failed to start: git`. MEASURED 2026-11-18 in a throwaway `haive-sandbox:6f3507776f7d11b7` container: "Prepared 32 packages in 54.14s" (pydantic-core 2.2 MiB in 38 s, cryptography 4.5 MiB in 54 s), against 4 s four minutes earlier. Python itself comes from the image (`/usr/bin/python3` 3.12.3). Three canary attempts of task f1eab19d failed this way, about $0.19 in all. Fix direction: a shared uv cache volume warmed and owned like the npm cache (`sandbox/npm-cache.ts`), or pin `mcp-server-git` and its dependencies into the image. Pinning also stops a new upstream release (2026.11.18 pulls `mcp` 2.3.0 and `cryptography`) from changing the tool surface in the middle of an experiment.

### T714 · Testing doc: `vitest run -u <file>` runs the whole suite

status: open · kind: docs · found: LSP cold-start guidance driver (#1278) · priority: P4

In vitest 5.0.3 `-u, --update [type]` takes an optional value, so `vitest run -u <file>` reads the file as the update type and runs the whole suite with snapshot update on (hit once, killed after ~3 min, no tracked change). Add one line to `docs/architecture/testing.md`: put `-u` after the file, or use `--update=all`. Third-party behaviour; only the doc note is ours.

### T713 · Custom-bundle agent hashes ignore the rendered body

status: open for follow-ups 1-5; the hash itself DONE #1302 (976d9dd80, deployed 2026-11-21 09:00Z: version bumped 2 to 3 for six unbumped body changes, pin test ties the version to a rendered corpus; follow-ups 1-5 below) · kind: design · found: LSP cold-start guidance driver (#1278) · priority: P3

A custom-bundle agent's manifest hash covers its parsed spec and `AGENT_RENDERER_VERSION`, not the rendered body (`shared/src/templates/manifest.ts:104`, `worker/src/step-engine/template-manifest.ts:468`, `api/src/routes/upgrades.ts:399`, `steps/onboarding/01-upgrade-plan.ts:247`), so a body-only generator change (a retrieval block edit) never reaches an installed custom-bundle agent file until the spec or renderer version moves. Built-in agents follow the render. PRE-EXISTING. Decision needed: hash the rendered body for custom bundles too (offers an upgrade on every generator change) or bump `AGENT_RENDERER_VERSION` whenever a shared block changes.

Follow-ups found by the #1302 driver, all PRE-EXISTING:

1. An unticked `user_deleted` entry in upgrade apply is never recorded (`worker/src/step-engine/steps/onboarding/02-upgrade-apply.ts` ~:180, form default ~:643), so the template reads changed until the file is reinstated. Each renderer bump re-offers it.
2. The built-in agents' `schemaVersion` is `AGENT_RENDERER_VERSION` (`worker/src/step-engine/template-manifest.ts` ~:145), so every bump re-offers every built-in agent in every repository, even where the bytes are current; the built-in `contentHash` covers one reference rendering only (`REFERENCE_CONTEXT`, ~:98). Fix direction: hash every target's rendering, or a fixed version per built-in.
3. Custom-bundle skills carry the bare IR hash with no renderer salt (`template-manifest.ts` ~:508, ~:518; `api/src/routes/upgrades.ts` ~:399), so a skill-renderer change never reaches installed bundle skills.
4. Comment only: `template-manifest.ts` ~:453 says the custom item's hash is the IR hash, but agents use the salted hash (~:468).
5. Untested: step 01 `adopt` and `conflict` for built-in agents, and the api with a bundle item whose own `schemaVersion` differs.

### T711 · Custom fix target lows

status: open · kind: bug · found: custom fix target diagnosis (#1271) · priority: P4

Leftovers, none blocking while custom targets stay refused: (a) `excerptDiagnosis` (`worker/src/step-engine/steps/workflow/_fix-loop.ts:393`) is not idempotent on every oversize shape, pre-existing; (b) the real `loadFixLoopRead` path has no builder-independent control (a stand-in passed all but one case); (c) a module step declaring `agentMining` is refused as a fix target because repair evidence is captured only on the LLM phase (`fix-consumer.ts` `isCapableModuleStep`); lift only together with evidence on the mining path; (d) fix-resolver refusal reasons are sentences with no stable code (`run-list.ts` `resolveFixLoopTarget`); add a code if a consumer ever branches on them; (e) the step-card CLI PATCH accepts `fix:N:default` on any step, not only a fix target (`shared/src/schemas/tasks.ts:332`, `api/src/routes/tasks/steps.ts:2346`); (f) round-CLI copy still says "implementation" for a custom target (`_fix-round-cli-field.ts:25,27`, `_fix-round-cli.ts:107,114,118`).

Added 2026-11-21 (#1303 driver): `loadFixTargetStepIds` (`api/src/routes/tasks/_helpers.ts` ~:261-264) falls back to the implementation step on a malformed pin, against the rule at `worker/src/step-engine/fix-consumer.ts` ~:19-20 that a malformed contract is never read as no target. PRE-EXISTING.

Added 2026-11-21 (#1305 driver), all PRE-EXISTING: the malformed-pin fallback above is DONE in #1305. (f) SETTLED #1322: the placeholder is gone; on a fix round a reused skip whose span contains the pinned target fails as `fix-target-suppressed`, and admission refuses such a pin at round 0. Original: `guard-span-skip.ts` ~:178 writes `skipped` directly, so only the `custom-fix-unavailable` placeholder stops a guard from skipping a pinned target; no test or doc names that placeholder (settle with the T689 item d question). (g) The worker honours an api-written `skipped` row on a pinned target (`worker/src/queues/task-queue.ts` ~:3658); skew only. (h) A deactivation between the route and the advance still enters and counts the round (`task-queue.ts` ~:1056-1090); the named failure at the advance is the backstop. (i) `shared/src/step/index.ts` ~:662 JSDoc names a plan label.

### T710 · Guarded span lows after activation

status: open · kind: bug · found: guarded span activation (#1270) · priority: P4

Leftovers, none blocking: (a) a dependent span re-entered in a later fix round fails closed with `shared-decision-unavailable` (`worker/src/step-engine/guard-decisions.ts:67,202`), design limit, belongs with the custom fix target work; (b) hook refusals in `worker/src/queues/task-queue.ts:3690,3701,3718` go through `failStepTransition` (:2224), which does not call `foldAbandonedPark` (:3429), so a failed parked row keeps `waiting_started_at`; timer effect unverified, helper behaviour pre-existing; (c) `isRetryableGuardError` (`guard-span-skip.ts:198-201`) treats a SQLSTATE anywhere in `.cause` as transient; (d) `dead-task-boot.ts:256` approximates the strategy as derived or static for the revive gate; (e) unverified by review: `validationSuccessor` with a null-output guard-skipped row after 07b, `loop_back` into a suppressed member, and the lock order of `holdReopenedForm` and `reconcileOrphanedSteps` against the entry hook; (f) `guard-gate-agreement-db` logs many expected error-level `task job failed` lines that bury real failures.

### T712 · Legacy composed builds fail on an environment body that copies project files

status: done 2026-11-20 (#1295, 5385c14ba, worker deployed 17:29Z); live check passed 2026-11-21 (task 8e6866b6, cancelled after): a legacy template with `preinstallDeps` on, whose body copies `composer.json composer.lock`, composed its sandbox image on the environment image (the environment image's layers are a prefix of the composed image's), 00b's call ran clean and 01b passed; evidence `.claude/tmp/codex-run/T712L/log.md` · kind: fix · found: composed LSP live check (#1274) · priority: P2

A legacy (absent/1) composed image still pastes the environment Dockerfile body into a build context that holds only the Dockerfile (`sandbox/image-composer.ts` ~:137-140 `resolveBase`, `sandbox/composed-image-cache.ts` ~:283-293 `buildComposedImage`), while `02-generate-dockerfile.ts` ~:941-988 emits a `COPY` of manifest files per package manager when dependencies are preinstalled. Such a legacy environment builds at 03 and then fails its composed build at task launch with "not found". PRE-EXISTING; reproduced through the real launch entry with a fake docker and with real docker (evidence `.claude/tmp/codex-run/LSPB-S/evidence/legacy-copy-launch-base.log`, `from-probe/h.log`). Not fixed with #1274 because moving legacy onto the environment image changes every existing legacy composed tag (a rebuild of each, readiness unaffected since legacy has none), and a body-text COPY heuristic is fragile. Decision needed: move legacy onto the environment image too (one-time rebuild of every legacy composed image) or give the composed build the repository context. Check first how many existing templates carry such a COPY.

Seen again 2026-11-20 in the template replacement live check: a legacy template generated that day with `preinstallDeps` on carried `COPY composer.json composer.lock ./` and failed 01b at its composed build; 00b's call degraded on the same error (task c858faec, `.claude/tmp/codex-run/LSPR-S/live/log.md` 05:22Z; it passed after a resubmit with `preinstallDeps` off). Count 2026-11-20: none of the dev install's 9 legacy rows carries a project-file COPY (7 with `preinstallDeps` on, 49 task links, none of them on a live task), so the failure hits NEW legacy environments: a person's opt-out, or an adoption refused because the task's CLI is not Claude Code. Decision (coordinator, 2026-11-20): compose legacy on the environment image too, as #1274 did for contract 2. The environment image already holds the dependencies, installed with the repository present; a repository context would tie sandbox image tags to repository content. Accept one rebuild of each legacy composed image on its next launch.

### T709 · Composed LSP cutover: writer, template replacement, live check, lows

status: open · kind: feature · found: composed LSP final verification (#1269) · priority: P2

Final verification step shipped (#1269): `01b1-verify-composed-lsp` runs after 01b and is the only source of contract-2 readiness; legacy templates skip it. Contract-2 writer DONE #1272 2cd96e3fd: DEFAULT-ON for new eligible environments (rollout constant `COMPOSED_LSP_NEW_ENVIRONMENT_ADOPTION`, per-task opt-out), 02 installer suppression, provider lock at step-CLI, summary-CLI and fix-round choice plus a dispatch backstop; before the first effective composed image the verified provider dispatches and launches on the provider image, so env builds and their AI repair run. Remaining, in order: (2) explicit replacement of stored legacy templates, never automatic: repository delete now also tears down the repository's own templates, merged #1287 (9388d35b7), deployed 2026-11-20 03:33Z; the replacement itself merged #1288 (b8c7c640d), deployed 2026-11-20 05:05Z, live check PASSED 2026-11-20 (task c858faec: checkbox unticked in the UI, one task moved to a new contract-2 row, the legacy row and image untouched, no second replacement on Retry, the guarded undo returned one row then zero; `.claude/tmp/codex-run/LSPR-S/live/log.md`; the fixture `ledger-export-cli-lsp` is not onboarded, so the UI offers only onboarding and a workflow task must be created through the API); (3) live check on the private ledger-export-cli fixture repository. Lows from the #1269 reviews: (a) `04-verify-environment.ts` `guidance` text is PHP-specific but shown for any unready plugin; (b) `bridgeReady` (`04-verify-environment.ts:390-396`) duplicates the readiness predicate in `configured-lsp.ts`; (c) `api/src/lib/provider-disable-impact.ts:83` counts the final step once more per in-flight workflow task; (d) a task already past 01b at deploy gets a cosmetic `runSeq` tie with 01d on a later Retry; (e) test gaps: no Retry of `01-worktree-setup`, no `advanceStep` over a done final row, the Postgres lock order in `composed-evidence.ts` is untested by the fake DB; (f) the swap of 04 and worktree setup is no longer refused at composition (only the final step's detect refuses that order). Lows from #1272: (g) after a verified reference exists, Retry 02 (regenerated body) then `retry_ai` of 03/04 is refused at launch (`sandbox/composed-image-cache.ts` ~:140, inputs changed) until 04 re-verifies; by design, product decision; (h) if 04 is skipped no effective reference ever exists, so later steps launch on the provider image with LSP not ready instead of failing closed; (i) a step-01 form parked before deploy has a frozen schema without the opt-out checkbox and adopts by default; (j) the opt-out label "Install language servers in the environment image" (default unchecked) needs a copy review; (k) `lsp/composed-evidence.ts:199,228-230` rereads template and task per provider on a contract-2 dispatch; (l) `lsp/configured-lsp.ts:21` Solargraph comment still says "environment image"; (m) `lsp/composed-adoption.ts` reads the task row twice and passes a redundant `defaultProviderId`; (n) DB-gated tests (`fix-round-cli-db`, 18 task-queue files) did not run on the branch; no live acceptance, composed build or browser check of the checkbox and 409 copy yet (part of (3)). Live check 1 (2026-11-18, local copy of the fixture, task 86e0ea65) PASSED adoption (contract 2 written, body without installer) and STOPPED at the first composed build: `"/composer.json": not found`, since the composed build pasted the env body into an empty context. Adoption switched OFF by #1273 215260ffc; contract-2 composed builds moved onto the environment image in PR #1274. Next: deploy #1274, rerun the live check on a new task (adoption is off, so the rerun needs the constant flipped on a branch or a template written at contract 2), flip adoption back on only after it passes. Lows from #1274: (o) `ENV_IMAGE_CHANGED` used at `sandbox/composed-image-cache.ts:85` before its declaration at :104 (works, read at call time); (p) `resolveBaseImageId` (`composed-image-cache.ts` ~:263-271) still best-effort builds the sandbox core image for a contract-2 composition that no longer references it (PRE-EXISTING). Runbook fixes for the rerun: the 01 option value is `intelephense-extended`, and the canary is followed by a step-summary call (2 calls before the probe). Possible low: the 01 `lspServers` default `intelephense` is not an option value (`01-declare-deps.ts:1250,1367`), so the UI may preselect nothing; unchecked in the browser.

UPDATE 2026-11-18: #1274 deployed, adoption back ON #1276 142074660. Live rerun 2 (task 45e15a16): steps 1, 2, 3 and 5 PASS (contract-2 composed tag built FROM the environment image), step 4 INCOMPLETE: three parallel LSP calls within 0.64 s answered "server is starting"/nothing, one cursor on whitespace; verdict cold start, not config (`.claude/tmp/codex-run/LSPL-S/run2/analysis.md`). Owner chose guidance then rerun: cold-start guidance in the retrieval protocol PR #1278. Rerun 3 PASSED 2026-11-18 on main 457604184 (task 0f85cc9b, 4 Haiku calls): contract 2 adopted, composed cache hit on the same tag, 01b and 01b1 ready, and the probe made 4 sequential LSP calls (definition after one 5 s retry, 3 references, hover), Retry controls green (`.claude/tmp/codex-run/LSPL-S/run3/log.md`). The live check (3) is DONE. Remaining: (2) explicit replacement of stored legacy templates, and the lows. Runbook note: 01 to 04 auto-submit from the prior task's values. Lows from rerun 2: (q) a completed custom-type task cannot be retried (`api/src/routes/tasks/steps.ts:574`); (r) cosmetic `.claude.json` stderr warning in 01b; (s) readiness runs only the initialize handshake, no index check (`lsp/composed-probe.ts` ~:94); (t) runbook: environments dedupe, `templateBodyHash` is the evidence hash, Retry of 04 re-parks `01-worktree-setup`. Lows from the guidance driver: (u) two whole-prompt hash pins break on any edit of the retrieval block (`worker/test/07-phase-2-implement.test.ts:796`, `worker/test/discovery-requirements-bytes.test.ts:187`); (v) `shared/src/constants/default-agent-rules.ts:34` says make independent tool calls in parallel while the LSP line says one at a time, effect unmeasured (an edit needs a new `KNOWN_DEFAULT_RULES_HASHES` entry); (w) the rag MCP text says confirm hits with LSP and grep with no cold-start caveat (`worker/src/sandbox/rag-mcp-server.ts:46,66,108`).

### T707 · PHP database driver lows after the generator fix

status: open · kind: bug · found: PHP database driver review (#1267) · priority: P4

Small leftovers, none blocking: (a) an existing PHP template with a SQLite, Postgres or MySQL database and no `ext-*` requirement keeps its saved Dockerfile without the driver until its declared dependencies change or someone edits it; a self-heal like `dockerfileTargetsUnbuildablePhp` would force a rebuild, so only do it if wanted; (b) `04-verify-environment` checks only `php --version`, so an image missing the PDO driver verifies green; add a `php -m` module check for the declared database.

### T706 · Desktop extension lows after the live check

status: open · kind: bug · found: Desktop extension reviews (#1259) · priority: P4

Small leftovers, none blocking: (a) `TestStatusAndStopDoNotRequireMailpitPort` asserts no `.env` bytes before/after; add a busy-8025-without-key refusal case and an invalid `HAIVE_MAILPIT_PORT` Start case; (b) the crash-loop flicker reopens the 5 s window per starting episode (bounded, polling never stalls); (c) Windows `.env` rename retry budget (~150 ms) is unmeasured against antivirus, and a read error during retry refuses rather than retries; (d) drift test takes the first `ENTRYPOINT` line and gives a bare SyntaxError on a non-JSON array; (e) the hung-updater refusal could name the updater's recovery command. Native Windows/macOS acceptance beyond the 2026-11-17 owner check stays manual.

### T705 · Updater and Desktop extension share one lock

status: open for follow-ups 1-4; the lock itself DONE #1304 (718dfd7d4, 2026-11-21: lease file `<install>/.haive-stack-lock`, beat 5 s, stale after 60 s of unchanged bytes, break by rename; follow-ups below) · kind: feature · found: Greptile P1 on #1259 · priority: P3

The extension refuses Install/Start/Stop while this install's updater container runs and re-checks right before `compose up`, but a window remains between that final check and the Compose call: an upgrade launched in that instant can still have PostgreSQL restarted during `phaseSnapshot` (`packages/updater/src/run.ts`). Closing it needs a lock both sides take (the updater and its launchers, plus the extension's `<install>.extension-lock`), honored by the updater from some release onward; older updaters keep today's container-identity guard. Design the lock location (the updater container must see it) and its recovery after a crash.

Follow-ups found by the #1304 driver:

1. `InstallDirectory.read()` (`packages/updater/src/install-files.ts` ~:154) is unbounded for every caller except the lock. PRE-EXISTING, LOW.
2. Cosmetic: `stack-lock.ts` ~:309 emits `stack-lock-lost` also when a failed restore was only the holder re-creating its record. REGRESSION (cosmetic), from #1304.
3. On Windows a delete-pending lock file makes the exclusive create fail with access denied (`docker/desktop-extension/bridge/stack_lock.go` ~:319), read as a transient refusal. Fails closed; reasoned, not run on Windows.
4. Record only: the database advisory lock (`journal.ts` ~:171) is session-scoped and the snapshot's postgres stop severs it (`run.ts` ~:373-375); the file lock now covers this for new updaters. The updater image pull (`api/src/routes/maintenance.ts` ~:648-652, up to 300 s) has no container yet, so the identity guard cannot see it; a lock-aware updater closes it once it starts.

### T704 · Installer port probe matches only the first port of a published range

status: open · kind: bug · found: review of #1260 · priority: P4

`port_in_use` (install.sh) and `Test-PortInUse` (install.ps1) match docker's published ports with `(^|[^0-9])N->`, so a range such as `0.0.0.0:8025-8026->8025-8026/tcp` reports only its first port as taken; 8026 reads free. Pre-existing, unchanged by #1260. Fix: parse `A-B->` ranges and test membership, with a test next to `scripts/test/install-ports.test.mjs`.

### T703 · Check claude-code and grok reported totals on tiered prompts

status: open, Grok half only (Claude half DONE 2026-11-17: Claude Code 2.1.325 reported totals include the tier exactly on two `claude-haiku-5-5` runs over 234k prompt tokens, $0.25 notional, recorded in model-pricing.md (#1262); owner: Grok waits until all plans are finished, then one month of Grok subscription covers this check plus benchmarks)

Plan `docs/plans/context-tiered-pricing.md` "PR 4": `reported` wins for claude-code and grok, so a CLI whose own price table ignores the prompt-size tier would understate tiered runs. Three direct-sandbox attempts on 2026-11-17 spent nothing and measured nothing: the first two stopped on the brief's own gates, the third reached both CLIs, and both answered "not logged in" from the per-task auth copies built outside a normal dispatch (the owner's claude-code auth works through normal dispatch, see the 2026-11-16 capped run). Evidence `.claude/tmp/codex-run/TCK-S/report3.md`. Next: drive one claude-code request over 100,000 prompt tokens on `claude-haiku-5-5` and one grok request at 200,000 or more on `grok-4.6` through a normal dispatch that writes a `cli_invocations` row (a prompt-step task type or a minimal workflow), then compare `total_cost_usd` with the stored `cost` snapshot. Notional only on subscription rows; budget about $5.

Attempts on 2026-11-17 (evidence `.claude/tmp/codex-run/TCK-S/codex-7` to `codex-10`): no task-delete route (owner: keep a trace); the grok task-copy credential failed its read-only usage check (likely rotated); two driver-side helper bugs before START. Claude task-copy auth passed every time. Retained traces, all cancelled before START: task `b7946443` with type `t703-pricing-check-throwaway`, task `97b50f13` with type `t703-haiku-pricing-check-throwaway`. Resume only with a fresh grok credential and a helper dry-run of the whole script first; Grok's largest prompt here (~176k) is under its 200k tier, so Haiku is the one that matters.

### T702 · Guarded composition validation edges

status: parked: diminishing returns (2026-11-17, owner rule: trivial lows park; resume when guarded runtime wiring (predicates through the api) starts, or on a related change) · kind: fix · found: review of #1247 · priority: P4

1. The admin detail and static PATCH routes in `api/src/routes/task-types.ts` pass a stored inert execution contract (no spans, no fix target) to the contract walk instead of the ordinary walk. The verdict matches; issue indexes differ. Fall through to the ordinary walk in `validateComposition` when the contract is inert.
2. `describeIssue` (`api/src/lib/task-type-definition.ts`) prints only kind and step id, dropping a data-edge issue's `message`. Unreachable until the api supplies predicates; print the message then.
3. No data-level control puts a pinned producer and consumer on opposite `when` branches of one predicate, and the scan fixture has no cross-span pinned data edge (only a synthetic control covers `requiresSpan` for data). Add both.
4. A span skipped on every feasible path (`when: false` plus `requiresSpan` on the true branch of the same predicate) validates. Consider refusing it.
5. Guard decision bounds (review of #1249): `limits` accepts any positive safe integer; above 2147483647 ms Node clamps the predicate deadline to 1 ms and Postgres rejects the `statement_timeout` with a raw error. Both fail closed. Bound it to 2147483647 and fail as `invalid-deadline`. When the guard runtime is wired, treat raw 55P03/57014 timeouts from the lock batch as retryable like `GuardDecisionError`, and add a control that a predicate writing through its handle after the deadline is refused.

### T701 · Admin unpriced-run inventory links to tasks the admin may not own

status: parked: diminishing returns (2026-11-17, owner rule: trivial lows park; resume on a user report, a measured failure or a related change) · kind: fix · found: review of #1245 · priority: P4

The admin pricing page lists every invocation whose prompt tier is unknown, across all users, and links each to `/tasks/:id`. That route is owner-only, so on a multi-user install an admin who does not own the task gets "Task not found". Single-owner installs are unaffected. Fix when touched: show the owner, or link to an admin-readable invocation view. An invocation with no proof stays unknown without bounds by design: a finite envelope would trust token totals nothing proves complete.

### T700 · No-change cleanup trusts a remote-tracking ref whose remote is inside the worktree

status: parked: diminishing returns (2026-11-17, owner rule: trivial lows park; resume on a user report, a measured failure or a related change) · kind: fix · found: review of #1243 · priority: P4

The submodule history check accepts any commit reachable from `refs/remotes/*`. That proves the commit reached another store only if the remote is one. A remote URL of `.`, a path inside the worktree or inside `.git/worktrees/<id>/modules/…`, a relative `.gitmodules` URL resolving into the worktree, or a hand-run `git update-ref refs/remotes/...` leaves the only copy in the store that pruning deletes. It needs deliberate setup: the sandbox masks `.git` and the worker creates no such remote. Fix when touched: for each remote, read `git remote get-url --all` (and `--push`); resolve a local path or `file://` URL against the submodule and realpath it; refuse when it lies inside the worktree, its staged path or the common dir's `worktrees/` tree, or cannot be resolved. Control: `remote set-url origin .` with a pushed local branch is refused.

### T699 · No-change cleanup does not check a deinitialized submodule's history

status: parked: diminishing returns (2026-11-17, owner rule: trivial lows park; resume on a user report, a measured failure or a related change) · kind: fix · found: review of #1243 · priority: P4

The cleanup's submodule history check skips a submodule with no `.git` in the checkout. After `git submodule deinit`, its administrative directory still lives under `.git/worktrees/<id>/modules/<name>` and can hold unpushed refs, and `git worktree prune` removes it with the worktree. Reaching it needs a no-change task that committed inside a submodule and then deinitialized it. Fix when touched: also read `.git/worktrees/<id>/modules/*` directly and apply the same retention check, with a real-git control. A submodule pinned to a commit only a remote tag reaches is refused permanently (documented); negating the base gitlink there is unsafe while that commit may exist only in the worktree's own module directory.

### T698 · Change-size measurement edge cases: a git spawn ENOENT read as a deleted file, an invalid nested-repo key freezing the measurement, untested real abort path

status: parked: diminishing returns (2026-11-17, owner rule: trivial lows park; resume on a user report, a measured failure or a related change) · kind: fix · found: review of #1242 · priority: P4

Three narrow items in `packages/worker/src/step-engine/steps/workflow/_change-size.ts`, none reachable in normal runs: (1) the per-file catch treats any `ENOENT` as an absent head file, but the same try also runs `ls-tree`/`cat-file`, so a git spawn ENOENT would count the file as null instead of making the measurement unknown (take the ENOENT branch only for `readFileNoFollow`); (2) `Object.keys(set.nestedRepositories).map(toSafeRel)` sits outside the per-item guard, so one invalid nested key freezes the whole measurement as a non-retryable unknown (normalise it with the files or skip it); (3) no test covers `gitExec` rejecting with a plain error while the signal is aborted (the code handles it through `ctx.throwIfCancelled()`).

### T697 · Change-size projection drops escape sequences inside template literals

status: parked: diminishing returns (2026-11-17, owner rule: trivial lows park; resume on a user report, a measured failure or a related change) · kind: fix · found: review of #1242 · priority: P4

Every JS/TS `template_string` is treated as a composite literal, so its text is discarded, and its named `escape_sequence` children are not counted by the traversal. Changing `` `\n` `` to `` `\t` ``, or an escape inside an interpolated template, records zero exact churn, against the literal-replacement contract in `docs/architecture/review-scope.md`. The measurement is report-only. Fix when touched: emit the escape sequences (or the static template text with interpolations removed) as literal units, with a control per case.

### T696 · Grok's tool exposure measures 148.83% of its prompt exposure in the read-exposure replay

status: parked: diminishing returns (2026-11-17, owner rule: trivial lows park; resume on a user report, a measured failure or a related change) · kind: investigate · found: read-exposure tally (#1241) replay · priority: P4

The SELECT-only replay of stored runs puts grok's all-tool exposure at 148.83% of its weighted prompt exposure (every other provider family is under 35%). Tool output cannot exceed the prompt it was carried in, so either grok's per-request turn counts or its tool-result capture double-counts. Grok is 223 of 5,819 replayed runs, so the headline file share (13.33%, Claude-family plus grok) moves little. Check when touched: compare grok's stream tool results with its reported per-request input tokens on one stored run.

### T695 · Toolchain advisory position mismatch surfaces as developer jargon in the step's failure text

status: parked: diminishing returns (2026-11-17, owner rule: trivial lows park; resume on a user report, a measured failure or a related change) · kind: fix · found: review of #1240 · priority: P4

When exec cannot find the sandbox toolchain advisory at its stamped prompt position, it fails closed with "Sandbox toolchain advisory does not match its stamped prompt position", which becomes the step's `cli invocation failed: ...` text. A Retry restamps and recovers (sandbox.md says so), but the step copy does not. Fix when touched: map that error to user copy that says the prompt changed before the run started and Retry will rebuild it, keeping the technical text in the log.

### T693 · Live notional cost of a running claude-code invocation is unpriced when the provider row's model is set only by `--model`

status: parked: diminishing returns (2026-11-16, owner rule: trivial lows park; resume on a user report, a measured failure or a related change) · kind: fix · found: capped real workflow run 2026-11-16 · priority: P4

While an invocation runs, `token_usage` has no model identity yet; `resolveInvocationCost` then falls back to `provider.model`, which is NULL on rows that pick the model through a saved `--model` CLI argument (the owner's "Claude Code Opus 5.5 High" row). A live read prices it as unknown; once the invocation ends, the stored served model prices it normally. Only a live spend reader (a watcher, a live budget cap) is affected. Fix when touched: fall back to the requested model parsed from the provider's saved `--model` argument before `provider.model`, through the adapter that owns the flag.

### T692 · No-PR workflow fails at 13-pr-wait: the RAG usage review dispatches after cleanup removed the worktree

status: done 2026-11-16 (#1231: 13 skips the review on a removed or non-directory worktree and records why; the guard is unchanged) · kind: fix · found: capped real workflow run 2026-11-16 · priority: P1

A full workflow whose `12-worktree-cleanup` ran `remove_only` (no PR) parks `13-pr-wait` with `pending:false`; the empty-form submit then enters its optional RAG usage-review LLM phase, and `resolveTaskDispatchOnTree` (`orchestrator/dispatcher.ts` ~:386) -> `resolveInvocationUsesWorktreeGitBoundary` -> `resolveTaskWorktree` (`repo/task-worktree.ts` ~:78) throws `WorktreeRemovedError` ("The worktree for branch ... was removed, so this task has no workspace to open."). The step fails before any invocation row, so the task ends `failed` after its work was committed. The guard is right to refuse the main checkout; the review has `disableTools: true` and needs no workspace. Expected per rag-playground.md (finalization review is non-blocking): the review runs without a worktree, or is skipped with a recorded reason, and the task completes. Repro: task `f7ecd064-...` on the dev install (only occurrence so far; earlier capped runs never reached 13). Check every other post-cleanup step with an LLM phase for the same dispatch.

Left from #1231 reviews (lows, parked under the owner rule):

1. On the PR path, the per-step recap after 13's own finalize can record a failed "Step summary" invocation once the worktree is gone (`step-runner.ts` ~:4654); the task completes.
2. "Retry with AI" on a failed 12 or 13 whose worktree is gone fails again (`resolveAiFixPhase`, `step-runner.ts` ~:1468): the guard working, the action just unavailable.
3. A custom prompt step that needs only the repository token can be placed after 12 and would hit the same guard; check the composition validator.
4. Optional LLM dispatch errors other than a prompt-budget overflow still fail the step (`step-runner.ts` ~:1198-1202).

### T691 · Owner's `gpt-5.5` codex provider rows fail with model_not_found; transport pin regex too broad

status: open (item 1 DONE 2026-11-16 on the owner's decision: the four rows now pass `--model gpt-5.6-sol`, edited through the provider API; their labels still say 5.5, left for the owner) · kind: fix · found: message-threads measurement 2026-11-16 (#1230) · priority: P3

1. The four dev-install codex rows labelled "OpenAI Codex 5.5 Low/Med/High/xhigh" pass `--model gpt-5.5`, which codex 0.152.0 refuses on a ChatGPT-account login: `400 invalid_request_error` "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account." (`model_not_found`). Any task step dispatched to them fails at the first turn. These are owner rows: the owner decides whether to repoint them (e.g. to `gpt-5.6-sol`) or disable them; never edit them on the owner's behalf.
2. Low: `packages/worker/test/adapter-transport.test.ts` ~:23-25 matches any codex override containing `transport`, so a legitimate future `-c mcp_servers.<name>.transport=...` would trip it with a misleading "must not override its incremental transport" message. Narrow it to the model-provider transport keys (e.g. `model_providers\.[^=]*transport`) when touched.

### T690 · codex CLI version list never refreshes (full npm document times out)

status: done 2026-11-20 (#1293, 523880e5f, worker reloaded 15:59Z) · kind: fix · found: worker log 2026-11-15 · priority: P3

`cli_package_versions` row `codex` keeps `fetch_error` "Unterminated string in JSON at position 214128" while every other CLI refreshes. `fetchNpmVersions` (`worker/src/cli-versions/fetcher.ts` ~:7-18, ~:62-75) requests the full npm document (`Accept: application/json`, 19.3 MB for `@openai/codex`, 8.4 s from the host) under a 15 s abort, and reads only the `versions` keys and `dist-tags`. Fix: `Accept: application/vnd.npm.install-v1+json` (abbreviated, 5.6 MB, 4.1 s, same two fields); control with a fetch stub asserting the header. Check the same pattern in `tool_package_versions` / runtime fetchers.

Resolution: the diagnosis above did not hold for the live error. Codex read its GitHub releases, not npm, and `per_page=100` answered 504 after 11.3 s (each release carries some 330 KB of assets). #1293 points codex at the npm package it installs from, with an opt-in `releasesOnly` filter (codex republishes every release per platform as `X.Y.Z-<platform>`; amp keeps its hyphenated releases), and every npm source, CLI and tool alike through the shared `fetchVersionsFromSource`, now asks for the abbreviated document. Live 15:59Z: the codex row holds 200 versions, latest 0.171.0, no fetch error and no platform builds.

### T694 · FNF[insight-gate3] · insight-cycle approval exposures beside the gate-3 park (+12)

status: open; items 1, 3 and 4 done by #1294 (2c29b923a, deployed 2026-11-20 17:29Z); items 2 and 10 done by #1296 (0dd72fa79, deployed 2026-11-21 01:48Z; owner decisions 2026-11-20, item 10 option B; the input-variant matrices moved to the fake-database layer in the same PR); item 11 done by #1299 (815216209, deployed 2026-11-21 03:45Z); item 15 done by #1301 (5bddd0d36, deployed 2026-11-21 07:47Z) · kind: fix · found: review of the gate-3 park change 2026-11-16 · priority: P2

1. DONE #1294. Stale-tab attestation: the step submit body carries only `values` and targets the newest `waiting_form` row (`api/src/routes/tasks/steps.ts` ~:902-1017), so any stale tab of the same owner can attest a gate-2 or gate-3 answer for a form it never showed. Bind latched-gate submits to `stepRowId` + `waitingStartedAt`.
2. DONE #1296. A successful second insight cycle (no verify failure, gate 2 skipped) still lets a gate-3 preset commit the refreshed diff (`insight-gate3-return.ts` ~:54-66 settles on the prior done gate 3). Same exposure as the owner's park decision; owner call whether it should park too. OWNER DECIDED 2026-11-20: always park gate 3 after a gate-3 insight cycle, whether or not its verification failed; presets and pre-answers are ignored there. Scope: only cycles a person started by picking insights at a parked gate 3 (`10-gate-3-commit.ts` ~:639); automatic rounds (`autoActOnInsights`, `08e-insights-triage.ts` ~:247) stay as they are. Once the person answers that gate 3, Retry, Resume and worker takeover must not park it again, and the fresh-submission anchor (`freshInsightGateSubmission`, today the latest `gate2_approved` event) moves to the cycle.
3. DONE #1294. Gate 1.5 (08d2) defaults to accept when nothing blocks (`detected.blocking` false), and accept defers to gate 2, but a successful insight cycle skips gate 2 (`task-queue.ts` ~:2410), so accepted QA findings reach no human in that cycle.
4. DONE #1294. `readValidationSnapshot` is not abortable and reads every changed file serially (up to 8 MiB each, two attempts); a cancel waits for it.
5. PRE-EXISTING: `readValidationSnapshot({ db, taskId })` in `worker/src/queues/validation-recheck.ts` ~:127 passes no cancel source (`validationSuccessor` has no `StepContext`), so the queue-level recheck read cannot be cancelled.
6. PRE-EXISTING, bounded: the git `readChangedFiles` call before the first per-file check, and a single in-flight file read of up to 8 MiB, are not interruptible (`worker/src/step-engine/steps/workflow/_validation-snapshot.ts`).
7. BY DESIGN, from #1294: the api's latched-gate predicate (`api/src/routes/tasks/steps.ts` `insightGateLatched`) is a superset of the worker's, with no settled or `approvedRound` exemption, so a later gate-3 park the worker would not latch still refuses old tabs and non-web clients with 409 `step_form_stale` (the web always sends the fields). Fix if it bites: one latch predicate shared through `@haive/shared`. #1296 widens it on purpose: both gates latch on any task that ever ran a gate-3 cycle, or holds a continuation it cannot read, so a non-web client there must send the row id and park stamp (`api/src/routes/tasks/steps.ts:128-153`). The shared predicate stays the fix.
8. LOW, cosmetic, PRE-EXISTING: a second tab racing the same latched park can show `step_form_not_waiting` without a reload until the next poll (`web/src/app/(app)/tasks/[id]/page.tsx` ~:1372).
9. COVERAGE: nothing pins what follows the approval of a gate 2 kept for deferred QA findings (depends on item 2), and no case covers the `run_seq` / `created_at` tie-break of `gate3QaDeferred` (`worker/src/queues/insight-gate3-return.ts`). #1296 pins that an answered QA-kept gate 2 completes. Its approval writes no `insight.check` event (`worker/src/queues/insight-gate3-return.ts:217-222`; only `step.form_submitted` records it), and the step into the following gate 3 is still not pinned end to end. Also no test clicks the api Retry route (`resetRowsForRerun`, `api/src/routes/tasks/steps.ts` ~:345-420) and then submits; #1299's real-Postgres layer resets through the worker's reset.
10. DONE #1296. PRE-EXISTING, decide with item 2: an unlatched gate 2 still honours `preAnswers['09-gate-2-verify-approval']` (`worker/src/step-engine/step-runner.ts` ~:3596; neither gate declares `humanOnlyFormFields`), so a task that pre-answered gate 2 auto-approves the gate 2 that #1294 keeps for deferred QA findings. Explained to the owner 2026-11-20 with four options: A keep; B in a gate-3 insight cycle, a gate 2 kept for deferred QA findings ignores its pre-answer (recommended); C every gate 2 with deferred QA findings ignores pre-answers; D gate 2 approves and gate 3 lists the findings. OWNER DECIDED 2026-11-20: option B; it ships with item 2. On the dev install no task type (0 of 15) and no task (0 of 453) has pre-answered gate 2 or 3.
11. DONE #1299. PRE-EXISTING, relied on by #1296; follows from the owner's always-park decision, so no new decision: a Retry of a step above the pick row in the pick's round bumps the source row's generation, so `latestGate3Request` returns null and the cycle ends (`worker/src/queues/insight-gate3-return.ts:147-148`, used by `openGate3Cycle` and `gate3InsightCycle`). The re-run gate 3 is then ordinary, and a preset can commit the cycle's edits, which stay in the worktree, unseen. A Retry clicked on the pick row itself stops at its form (`pause_form_on_retry`). Reasoned from the code, not reproduced. Fix direction: latch task-wide as the failed path does, so after a gate-3 cycle applied edits the next gate 3 parks until a person answers one. #1299 (815216209): reproduced first (62 worker tests red on the parent); the approval latch reads the cycle task-wide from its event and settles on a later done gate 3 or the pick row's re-answered pass. Accepted and documented, fails closed: a Retry above the pick after the post-cycle gate 3 was answered parks the re-run once more.
12. DROPPED on review: no gate 2 is kept by a runtime recheck. `successor.recheck` sends the run to 07c or 07b first (`worker/src/queues/validation-recheck.ts` ~:131-135), and the return to gate 2 goes through the same skip decision without `recheck`.
13. LOW: gate 2's advance now reads continuation events in every task, so an unreadable event throws a step error. It fails closed, and the check handoff already throws on the same event (`insight-gate3-return.ts:131-141`, `step-runner.ts` ~:3584-3588).
14. LOW: if a cycle's source row were deleted, the park rule would fail open; no code deletes `task_steps` rows today. Moot for the approval latch since #1299 (a missing source row never settles the cycle); routing keeps `!source -> null` (`worker/src/queues/insight-gate3-return.ts` ~:202-217).
15. DONE #1301. PRE-EXISTING, reproduced on the fake-database layer (#1299 driver probe, `.claude/tmp/codex-run/G3L-S/evidence/driver-probe-failed-path-pullback.log`): the failed-verification latch returns false when `approvedRound > row.round` (`worker/src/queues/insight-gate3-return.ts:54`), so a Retry that pulls a failed round's gate 3 below the gate-2 approval round drops it and a preset commits; at the approval round itself it parks. Fix direction: settle on a gate-3 owner `step.form_submitted` newer than the `gate2_approved` event rather than on round order, as #1299 reads the gate-3 cycle task-wide. #1301 (5bddd0d36): the round exit is gone (it had no recorded reason and no test reached it); the latch settles on a done or skipped gate-3 row in the window from the approval's round to below the gate's own that carries the owner's `step.form_submitted` for its current generation, newer than the approval. Accepted and documented, fails closed: an answer below the approval's round settles only its own row, and a completion without a stamped owner answer ends nothing, whereas the gate-3 cycle latch (#1299) settles on any done or skipped gate-3 row in its window.
16. LOW, PRE-EXISTING, fails closed: `reofferParkedSteps` (`api/src/lib/task-control.ts` ~:236-262, called from `api/src/routes/tasks/steps.ts` ~:678) puts `waiting_form` rows back to `pending` and raises `rerunGeneration`. A gate-3 row the owner answered that the worker has not picked up yet is still `waiting_form`, so a restart in that window voids the generation-stamped answer and gate 3 asks again. Found by the #1301 driver, checked against the code.

### T689 · Deep-analysis core runtime: guarded spans (P7) and custom fix target (P8)

UPDATE 2026-11-18: PR6b DONE #1275 75f521201 (round CLI follows a pinned custom target). Before PR7 enables custom targets, these readers still key on `07-phase-2-implement` and must follow the pinned target: `worker/src/step-engine/steps/workflow/_impl-changes.ts:489`, `_similar-sites.ts:94`, `guidance-context.ts:107`, `_prompt-defect.ts:94-112`, `web/src/lib/task-history.ts:46,294`. Next: PR6c (reset, ownership, recovery), then PR7. UPDATE 2026-11-21 (later): pre-enable items a, b, c DONE #1305 (8a6cb2f29, deployed 15:09Z; with T711's malformed-pin fallback). OWNER DECIDED 2026-11-22, item d: the guard REUSES its round-0 decision on fix re-entry (option 2); PR7 unblocked. Original question: when a fix round re-enters a guarded span whose first step is the pinned target, does the guard (1) re-evaluate its predicate at the new round, (2) reuse the round-0 decision, or (3) not apply to fix re-entry? Also: how `requiresSpan` shared decisions carry across rounds, whether a guard-skipped span member may be the fix target, and what `custom-fix-unavailable` (`worker/src/step-engine/guard-decisions.ts` ~:119, a placeholder behind the closed fence) becomes. Session recommendation: (3), with the guard's round-0 decision kept for the rest of the span, because a fix round repairs what already ran and must not let a predicate re-evaluated against a changed tree skip the repair. UPDATE 2026-11-21: PR6c DONE #1303 a7e69f9a2, deployed 10:49Z (recovery proven target-agnostic by equal-trace real-Postgres suites; dead-task judge now checks the pinned target). Before PR7 also: (a) a pinned fix target is not excluded from Skip (`api/src/routes/tasks/_helpers.ts` ~:1028-1040 `isStepSkippable`; `worker/src/step-engine/step-output-contract.ts` ~:43-55 forbids `allowSkip` only with `replaces`; dormant behind the api fence `steps.ts` ~:1320); (b) routing does not read module state, so a deactivated module target's round is entered and counted before the advance fails by name (`task-queue.ts` ~:3935, `step-runner.ts` ~:3310, `run-list.ts` ~:331-378); (c) snapshot-less non-static run lists are not judged at boot (`dead-task-boot.ts` ~:569); (d) guarded spans fail closed with a custom target (`guard-decisions.ts` ~:67, ~:119, ~:202). All PRE-EXISTING.

status: done (PR7b DONE #1328 38741feb7, deployed 2026-11-23: custom fix targets admitted for a capable, non-mining module step on a static pinned run list, one capability rule at every gate; fix-round guards reuse the latest earlier non-fix round's decision, which is round 0 when no revise round intervened (owner item d, generalised; owner CONFIRMED the generalised rule 2026-11-26; strict round 0 would strand tasks whose revise forked before round 0 reached the span), dependencies read at the rows the reused decision names; pinned module target gets house rules in write mode. Follow-ups T764. PR7a DONE #1322 6606e3ec1, deployed 2026-11-23: every fix-round reader follows the pin, guards reuse the round-0 decision on fix re-entry (owner item d), `custom-fix-unavailable` removed, a reused skip containing the target fails as `fix-target-suppressed`; fence still closed. PR7b scope: open the fence, reuse keyed on fix rounds only (session decision: revise/restart rounds re-evaluate as for a no-target pin), static-list requirement for any fix-target pin, module-target scope keys, end-to-end synthetic module target; fence re-entry refusals and admin hold lifting DONE #1237 45cfd88f4; zero-merge cleanup core step `12-no-change-cleanup` DONE #1243 c29624d84 (explicit composition only; lows T699, T700); guarded planner and pinned data-edge validation DONE #1247 c287eceff (fence still closed; lows T702); dormant guard decisions (evaluate and persist, no skipping) DONE #1249 0fb04c06a; dormant owned span skips with guard-aware resets DONE #1261 7da339b20; schema-only predicate registration shared with the api (`./execution-predicates`, worker boot parity) DONE #1263 ea4cc7271; activation prerequisites DONE #1268 61fbeace0 (Resume forward rescan, insight form reconciliation, derived availability refusal, version-skew worker refusal, guarded Resume lock-order controls; fence still closed); guarded spans ACTIVE for supported pins DONE #1270 7697de9d6 (fence open at every gate, custom fix targets still refused, fix-target-only fallback removed, entry Retry offered in the UI; lows T710); custom fix target diagnosis read, router resolution and repair evidence DONE #1271 dafe20284 (dormant, custom targets still refused at every gate; a fan-out step is never a capable target; lows T711); next: PR6b (CLI dispatch and display for a custom target, plus the 07-only consumers it must feed: `_impl-changes.ts:489` reportedFiles, `_similar-sites.ts:94` rounds, `guidance-context.ts:107` and `_prompt-defect.ts:95-111` guidance target, `_fix-round-cli.ts` and `task-queue.ts` round CLI options, api round-slot display), PR6c (reset, ownership and recovery), PR7 (enable). PR5b must also remove the fix-target-only composition fallback in shared `task-types.ts` (~:208) when the fence opens, else an invalid fix target fails open. PR5 prerequisites beyond those in task-types.md: guarded Resume must rescan forward guard state from the clicked producer under the ordered locks even when the initial downstream reset set is empty, else a decision committed before the lock survives (Greptile on #1261, steps.ts ~:1522-1585), with a race test), owner decided 2026-11-16: zero-merge cleanup becomes a NEW CORE STEP (not a conditional `commit` requirement); P7 unblocked (P6 storage/validation/admission fence DONE #1222 6d912f6ce, migration 0245) · kind: feature · found: DPA design 2026-11-15 · priority: P2

Design `.claude/tmp/codex-run/DPA-S/codex-1/design.md` sections 5 and 10, accepted decisions `DPA-S/accepted.md`, plan `docs/plans/kind-riding-dream.md` (Core changes ~:938-1027). P6 pins `execution_contract` at task INSERT and refuses any contract with a guarded span or custom fix target until this runtime lands. Session decision 2026-11-15: a span may declare `requiresSpan` (skipped whenever that earlier span was skipped, host-enforced), so the validator excludes merged-without-planned.

RESOLVED 2026-11-16 (owner: new core step; built in #1243). Original question: the plan runs `12-worktree-cleanup` when issues were planned but none merged (plan ~:542-552), but cleanup requires `commit` (`worker/src/step-engine/composable-core.ts` ~:791-802), which only the skipped commit gate provides; the every-path validator correctly rejects it. Recommended: a new core no-change cleanup step (requires worktree + clean-tree, merges nothing, refuses when the branch has its own commits), guarded to planned-and-nothing-merged, with the normal cleanup moved into the merged span. Alternative: a conditional `commit` requirement on the existing cleanup (weakens a core composition rule).

From #1224 review-3: `definitionForCreate` pins data edges from the full static list and `dataRoleDraftIssues` is guard-unaware; P7 must reconcile a required pinned data input whose producer sits in a skippable guarded span. Before P7 lifts the fence (from the P6 review, `EXC-S/review-1.md`): (1) API refusal covers only START and full-restart Retry; `retryTaskAtStep` (`api/src/routes/tasks/index.ts` ~:1527-1536) and step-level submit/clarify/action revival (`routes/tasks/steps.ts` ~:476-570) reset rows and kill sandboxes before the worker refuses. (2) `resolveTaskTypeAvailability` and the API composition paths call plain `validateComposition` with no predicate map; make them contract-aware. (3) `shared/src/modularity/composition.ts` ~:70 hard-codes `'07-phase-2-implement'`; tie it to the worker constant with a test. (4) No test for boot marking of a live contract-bearing task or for the four creators other than tasks POST. (5) `step-catalog.ts` ~:32-33 comment no longer literally true now that `fixConsumer` is persisted. (6) Nit: import placement in four files (the contract-409 ordering half is fixed in #1222). From #1222 review-3 (`EXC-S/review-3.md`): (7) a derived type with an invalid plan and a live contract answers the derived error, not the named 409 (reachable only by a direct DB edit; no API test of the derived-with-contract path). (8) The locked static path now takes the `step_catalog` SHARE lock and module reads before the contract refusal, and data-edge refusals can precede it (rolled back; consequence of the order fix). (9) task-types.md ~:212-219 does not say the contract refusal is the last `invalid-composition` check and still runs without a synced catalog; it also omits `module-draining` between missing and deactivated (pre-existing). (10) `definitionForCreate` re-evaluates the contract instead of using the availability issue; `scripts/test/module-ci.test.mjs` ~:163 variable still named `contracts`; inert contracts with all-composable steps still pass the contract into `validateComposition` (same verdict).

### T688 · FNF[dag-partial-2] · opt-in DAG hardening lows, after T686 (+6)

status: open (items 1-6 DONE #1221 e741a2fbb; the lows below remain, all opt-in only) · kind: fix · found: #1221 review-1/2 2026-11-15 · priority: P3

Reviews in `.claude/tmp/codex-run/DGL-S/review-1.md` and `review-2.md`. The default `fail-step` policy is unaffected.

1. LOW, coverage: no control pins a blocked reviewer whose recovery budget is spent (the exhausted stalled branch records `review stalled`, `worker/src/step-engine/dag-executor.ts` ~:1930-1937; no test asserts that string). fix-loop.md now states the qualifier.
2. LOW, PRE-EXISTING: advisor (~:2408), replanner (~:2909) and the advisor-started fix coder (section C ~:3441) check the environment before the refusal, so a refusal whose provider detail matches `ENVIRONMENT_FAILURE_RE` counts as a hard fault; reviewer and level coder handle the refusal first (~:1607). Fix: move the refusal test above the environment check in those three places.
3. LOW: a refused fix coder that printed a valid result writes Haive's refusal note into the task ledger (`recordLedgerEntry` ~:3604-3611); later agents read it as a finding. Parity with the level coder.
4. LOW, coverage: the DGL-4 truncation controls for advisor and replanner cannot discriminate (the kill throws before any parse).
5. LOW, maintenance: `retryReviewer` (~:1666-1669) duplicates the two dispatch-branch predicates (~:1698, :1720); a drift restores the consume-before-throw hazard. Fix: one shared helper.
6. NIT, docs: fix-loop.md "advisor, replanner and fix coder" means the section-C advisor-started fix coder; "path-scrubbed" covers only worker storage and host repo roots.

### T687 · FNF[insight-loop] · insight loop lows, after #1215 (+30)

status: open (lows; bundle with the next insight-loop change or park; owner decided 2026-11-16: item 19 gate 3 PARKS after a human gate-2 re-approval of a picked-insight cycle (presets ignored), item 24 all-`not_applied` gate-3 batches SHORT-CIRCUIT the checks with a recorded reason; both DONE 2026-11-16 in #1233 b457672e7; remaining items stay lows) · kind: fix · found: #1215 reviews 2026-11-15 · priority: P3

Reviews in `.claude/tmp/codex-run/INS3B-S/` (review-4.md, review-5.md).

1. PRE-EXISTING: the recovery copy for a static task's immutable run-list snapshot (`worker/src/queues/insight-continuation.ts` ~:21) should recommend creating a new task, since Retry cannot change the snapshot.
2. NIT, PRE-EXISTING: redundant conditional wrapper at `worker/src/queues/run-list.ts` ~:128.
3. LOW: an owned checkpoint at a later round than the evaluating round reads as settled. Retry of an earlier round's verification after the route settled then offers manual triage, where the old earliest-row rule ran an empty checkpoint (`_insight-continuation.ts` ~:82-92). Accept it, or treat `owned.round > round` like the range fallback.
4. NIT: `checkpoint.generation` is written into the continuation payload and never read.
5. NIT: duplicated stepId and selection test in `handleAdvanceStep` (`task-queue.ts` ~:3590), already inside `assertInsightSelection`.
6. LOW, theoretical: `requires[].after` compares the LATEST token provider, while the runtime checks specific step ids. They diverge only if a module step also provides `verification` or `review` (`shared/src/modularity/composition.ts` ~:62, :81-85). None does. Key on the earliest provider if a module ever does.
7. LOW, cosmetic: for `need-out-of-order` the composer shows "Provided by: <review step>" for a step already in the list (`web/src/lib/composition-messages.ts` ~:113-117). Return no providers for that kind.
8. LOW, coverage: no test creates a task from a STORED static type with review before verification (`task-type-definition.ts` ~:91-96, :235-241); the path was read and returns 409.
9. NIT, from #1218 review: the `08e-insights-triage` step id, the `triage` seat name and the auto-mode rule are duplicated as literals in `api/src/routes/tasks/_helpers.ts` (`hidesInsightTriageSeat`, `resolveCurrentStepCliProviderIds`). Import the shared ids and one predicate.
10. LOW, REGRESSION (comment), from #1218 review: `worker/src/queues/_step-reset.ts` ~:326-344 says the auto-resume marker is scoped to the barrier guard's own predicate, but the guard now skips consumed mining rows while `failedAgents` still selects them. Harmless (08e never re-dispatches). Add `isNull(consumedAt)` to that select or reword.
11. LOW, PRE-EXISTING: `recordFailedStepHint` (`worker/src/queues/task-queue.ts` ~:1943-1963) picks the newest outage among the step's unsuperseded invocations, not the failure just written, so after a Resume fold a later non-outage failure can still write a `provider_unavailable` hint and arm the allowance watch. Bounded by the auto-resume counter.
12. NIT: `holdReopenedForm` derives the expected generation as `nextGeneration - 1` (`worker/src/step-engine/step-runner.ts` ~:2246); pass it explicitly and mention the compare in its doc comment.
13. LOW, from #1218 review-6: with more than 30 outstanding human decisions in automatic mode, the next page is offered only through a check continuation (one needs an applied item), so an empty manual page or a batch with nothing applied leaves the rest for gates 2/3 as out-of-scope text (`08e-insights-triage.ts` ~:233-254). Nothing is settled. Fix: accept and document, or rotate pages by items already offered.
14. NIT: one manual form can show two different "more not shown" counts (`insightsOmitted` includes report-only minor/nit; `candidatesOmitted` does not) (`08e-insights-triage.ts` ~:105-136, :314-318).
15. NIT: `GET /tasks/:id/events?insightOffset=N` reports `<key>Omitted` as entries outside the page (before it, at an offset), with no total or has-more field; no API test asserts it at an offset or a 400 for a bad offset (`api/src/routes/tasks/_insight-event-page.ts` ~:27).
16. LOW: `AutoDetect.dependencyPolicy` (`withheldPaths`, `workspaceRoots`, `ownedPaths`) is persisted unbounded in the polled 08e detect output; persisted insights keep full descriptions with no per-item clip. Bound with the same reload approach if sizes matter (measure first).
17. NIT: `syntheticInsightReply` (`step-runner.ts` ~:2255-2267, test bypass only) reads the bounded detect copy.
18. LOW, from #1218 review-8: `loadDependencyPolicy` reads `baseBranch` from the retained 01 output (`worker/src/step-engine/steps/workflow/_dependency-policy.ts` ~:181-190); when that output is gone it falls back to `rev-parse HEAD`, which in the worktree may already hold the task's own commits. Fix: read the base from the durable task columns, or fail closed without it as `review-diff.ts` ~:277-280 does.
19. DONE (#1233). LOW, from #1223 (reviews in `.claude/tmp/codex-run/INS5-S/`, review-4/5 and codex-4/5 last.txt): after a human gate-2 re-approval clears the insight latch, the regenerated gate 3 still accepts a preset `commit` (task pre-answers, type defaults, prior-task reuse), so the refreshed diff can commit without a look. Decide whether a picked-insight cycle should force gate 3 to park like the latched gate 2.
20. LOW: the manual 08e fallback accepts a non-empty preset selection (prior-task reuse drops unknown ids, so reach is narrow).
21. LOW: the module loader does not reject `loopTargetWhenPresent` / `loopBeforeClose` on module entries, and `effectiveReplacementEntry` (`shared/.../derived-task-types.ts` ~:176) spreads a replacement entry's flag onto a role-owned loop target; a trusted module can skip `missing-loop-target` (fails at loop time by name). Reject both flags for module entries.
22. LOW: gate 3 offers the pick field when 08e is present but gate 2 is absent, then refuses every submit with the run-list error (`_gate-insights.ts` ~:74); gate the offer on gate 2 too.
23. COVERAGE: no test of `validateComposition` with a live execution contract AND `loopTargetWhenPresent`; no control through the real submit route followed by the worker for the owner-attested approval; detect paging tests mock `insightPageOffset`.
24. DONE (#1233). LOW: `continuationForOutcome` returns the checks stage for a gate-3 batch even when every pick was `not_applied` (full 08 + 08c for no change). Owner question whether to short-circuit.
25. LOW: the persisted `insightSummary` is bounded but large (30 items x 30 refs x 30 attempts, stored in detect and apply output); no ceiling test. Choices are bounded separately.
26. LOW: summary and choices page on different units (identities vs occurrences), so page 2 can show summary rows for other items; nothing dropped.
27. LOW: a worker pass holding an older row snapshot can re-park a latched gate 2 after the owner's submit (lost click, safe direction); the owner marker payload `{userId, generation, decision}` is duplicated in steps.ts, insight-gate3-return.ts and tests without a shared type (drift fails closed).
28. NIT: two `composable-core.test.ts` titles (~:202, ~:213) say "requires" while asserting `[]`; composer copy (~:609-613) and the type-draft prompt (~:264-266) still describe the gate-3 loop as unconditional; dead `{limit: INSIGHTS_AT_GATE}` branch in `collectInsights` (08e ~:89-97); report back link unstyled; no `/events` paging test for `task.markdown_report`.
29. LOW: `gate2_approved` is recorded before the gate-2 row is written done (`step-runner.ts` ~:4264); a Stop or Retry in between leaves the latch cleared on a real human approval. Narrow.
30. LOW, gap left by #1294: `gate3QaDeferred` (`worker/src/queues/insight-gate3-return.ts` ~:145-167) counts a skipped 08d2 as no deferral, so unreviewed 08d findings stay open while gate 2 is skipped. 08d2 has no `allowSkip`, so only guard skips reach it.

### T680 · DeepPattern module (plan Part B): paused until a fresh 08c baseline

status: open, RESUMED 2026-11-16 (owner: resume once an 08c baseline exists; the 2026-11-16 capped run recorded two clean real-task 08c baselines) · kind: design · found: owner GO 2026-11-14 · priority: P4

Plan: `docs/plans/deeppattern-module.md` Part B.

Measured 2026-11-14, evidence in `.claude/tmp/codex-run/DP0/` (`notes.md`, `bench/grading.md`):

- **Device route.** One device activated (secret file and token location in memory, never re-activate). REST device route: `POST /v1/audits`, then status, result, events and cancel.
- **Benchmark.** 7 audits on first-build diffs of 6 Haive changes, graded against defects our pipeline confirmed:
  - precision 24% (9/37 TRUE), with 0 real defects our pipeline missed;
  - recall 3 of 26 substantive defects;
  - full file contents cut false claims to 0 but did not add recall;
  - standard tier (a 3-model panel) beat fast;
  - 110-263 s per audit; fast costs about $0.23.

**Resume when** the owner has run a full workflow, plus optional artificial step 08 runs on planted-bug diffs. Then compare DE at standard tier with full changed-file contents against that 08c output. Build only as a report-only second opinion, never a gate.

The step SDK seam (prerequisite 2) continues regardless, because deep analysis needs it.

### T679 · FNF[derived-types] · derived task type evaluator lows and PR3 decisions, after #1186, #1190, #1191, #1208 and #1211 (+35)

status: parked (items 1-6 resolved 2026-11-14 in #1190 (96b261c5d); items 10 and 11 resolved 2026-11-15 in #1195; the rest parked: diminishing returns (2026-11-14)) · kind: fix · found: #1186 and DT2 reviews 2026-11-14 · priority: P3 (resolve inside derived types PR3)

Reviews in `.claude/tmp/codex-run/DTY-S/review-1.md` and `DT2-S/review-1.md`.

1. Removing a gate or `07-phase-2-implement` from a derived workflow is allowed whenever `validateComposition` passes (07 removal fails on `missing-loop-target`; gate 1/2 removal is unverified). Admins can already compose static types without gates, so this is no new power, but PR3 should decide and pin it (refuse, or warn in the editor).
2. A `replace` whose target is stale or off the path is skipped before the replacement refusal (`derived-task-types.ts:156-178`), so it is never diagnosed until the base gains the step. PR3: warn on save when an overlay holds any `replace`.
3. Stale-target warnings repeat once per candidate (`derived-task-types.ts:206-208`); the editor must dedupe by `operationIndex`.
4. `createDerivedChangesSchema(maxChanges)` accepts any bound (`:26`), above `MAX_DERIVED_CHANGES` too; PR3 callers must never pass a user value.
5. `OrderedStepCatalogRow.stepIndex` is `number` but `step_catalog.step_index` is nullable; a NULL throws "Invalid base catalog index" (`run-list.ts:129`). PR3's ordered catalog read must map NULL explicitly.
6. PR2's fail-closed refusals throw inside the row map of `GET /task-types` and `GET /admin/task-types` (`availabilityOf`, `shared/src/modularity/task-types.ts:106`): with a derived row present on PR2 code (a PR3 revert) the whole list answers 500. PR3 must replace every refusal in one change; a revert past PR3 must delete derived definitions first.
7. (#1190) `POST /tasks` and `PATCH /tasks/:id` still return the full derived run plan; list and poll strip it. LOW.
8. (#1190) An `UnresolvedStepError` is rethrown raw on one read path instead of failing by name. LOW.
9. (#1190) Read-only endpoints take the catalog lock they do not need. LOW.
10. (#1190) Scan readers throw on a malformed derived row instead of skipping it by name (`api/routes/repos.ts` ~:1305, `api/lib/provider-disable-impact.ts` ~:60), so one bad row fails the whole listing. Consequential.
11. (#1190) CI's gated test list is at 155 of its 156 budget; the next gated test fails CI. Raise or rebalance the budget with a measurement.
12. (#1190) The catalog fingerprint orders with `localeCompare`, which depends on the runtime locale. LOW.
13. (#1190) The admission preflight reads the same rows twice. LOW.
14. (#1191) The create path with a base whose `requiresRepository` is false has no test; only the true base is pinned. LOW, parked.
15. (#1191) `FormRenderer`'s `onSubmit` is now optional; nothing pins that every caller that renders a submit button still passes one. LOW, parked.
16. (#1191) A web test imports the shared derived-overlay fixtures by relative path (`packages/shared/test/derived-overlay-fixtures.ts`) rather than through a package export. LOW, parked.
17. (#1191) The web keeps its own copy of `SAFEGUARD_STEP_IDS` for the gate-removal warning; it can drift from the server's list. LOW, parked.
18. (#1191) Removing a base step when the change list is already at its cap silently does nothing. PRE-EXISTING. LOW, parked.
19. (#1191) The server preview only runs once the slug is valid, and the editor does not say so; live validation still runs. Browser check 2026-11-14. LOW, parked.
20. (#1195 review) `web/src/components/cli-provider-form.tsx` ~:715 would render "0 tasks could not be checked" for `incomplete: true` with an empty `invalidTasks`; unreachable today (the api sets `incomplete` only with entries). Cosmetic.
21. (#1208) The web history labels a step as an audit by `stepId.includes('audit')` (`web/src/lib/task-history.ts` ~:126) rather than by its projected output role; a replacement audit step with another id is labelled wrong. LOW, PRE-EXISTING pattern.
22. (#1208) The "derived definition requires a pinned plan" lookup exists twice, in `api/src/lib/step-output-roles.ts` and the worker reader path; they can drift. LOW.
23. (#1208) Role pin reads (`loadRoleTaskPin`) are not cached per request or per step; gate 2 and the digest read the task row more than once. LOW, perf.
24. (#1208) The step-role fixtures are triplicated across shared, api and worker tests (`step-role-fixtures.ts`). LOW, hygiene.
25. (#1208) The whole-repository role scan reads every candidate file sequentially (~4 s alone, past 20 s on a loaded CI runner, now bounded at 60 s); a substring pre-check or git pathspec would cut it. LOW.
26. Decoder skip guard after #1211: the derived-plan decoder's skip guard has no direct control (DP4R review-2, low).
27. Refusal message wording for an unsupported pinned producer is generic (DP4R review-2, low).
28. Extra plan parses partially fixed at task-queue.ts ~:979; `derivedCandidateIds` still parses the plan again (DP4R review-2/review-3 L1, low).
29. The role source scan walks the tree three times; fold into one pass (DP4R review-2 B-5, low).
30. Contract reference formatting is duplicated in two places (DP4R review-2 B-6, low).
31. Parse-count test title overclaims what it pins (DP4R review-3 L1, coverage); `llm.skipIf` kept by design (L2); one dead guard remains (L3).
32. (related first-party, PRE-EXISTING, low; from the port canvas review) `POST /admin/task-types/preview` and create accept unbounded `stepIds` (`shared/src/modularity/task-types.ts` ~:186 has no `.max`); the ports route now caps drafts at `MAX_PORT_DRAFT_STEPS` (256). Apply the same named bound to preview and create.
33. (port canvas review) the ports draft route (`api/src/routes/task-types.ts` ~:290-295) leaves the draft slug, prompt `title` and `promptSteps` count unbounded since it tolerates save-only errors (the save path bounds the title by `PROMPT_STEP_TITLE_MAX_LENGTH`). Admin-only, echoed as a graph label. Add `.max(PROMPT_STEP_TITLE_MAX_LENGTH)` and a record cap. REGRESSION (marginal), low.
34. (port canvas review) `await c.req.json()` on a non-JSON body throws `SyntaxError`, which `error-handler.ts` maps to 500 (task-types routes ~:336, :447, :575). PRE-EXISTING, low. Map bad JSON to 400 in one place.
35. (port canvas review) derived draft projection yields no candidates when the base is missing or `requiresRepository` differs from the base (`shared/src/modularity-server/derived-task-types.ts` ~:49-66), so the canvas shows "No port graph" for that unfinished draft. PRE-EXISTING, low.

### T678 · FNF[step-sdk] · step SDK seam lows, after #1184 and #1188 (+13)

status: parked: diminishing returns (2026-11-14, owner rule: trivial lows park; resume on a user report, a measured failure or a related change) · kind: fix · found: #1184 reviews 2026-11-14 · priority: P4

Reviews in `.claude/tmp/codex-run/SDK-S/review-{1,2,3,4}.md` and `SD2-S/review-{1,2}.md`.

1. A module's local step id passes `isCoreStepId` (`modules/loader.ts:108`, pattern `contracts.ts:8`), so `_x` or `-x` registers, while the namespaced-id pattern (`contracts.ts:9`) needs an alphanumeric first character. PRE-EXISTING. Validate the local id against the namespaced form.
2. No length bound on a module's local step id (`modules/loader.ts:107-119`); `task_steps.step_id` is `varchar(128)` (`database/src/schema/tasks.ts:514`) and the namespace adds up to 31 characters, so a local id over 97 characters cannot be stored. PRE-EXISTING. Refuse at registration.
3. `step-sdk-module.test.ts:16` mocks `emitsLoop` to return `undefined`; a later fixture with composable steps would take the "does not loop" branch silently. Make the mock throw.
4. `worker/tsconfig.typecheck.json:8` excludes the package `dist` only; a stale ignored `test/fixtures/step-sdk/dist/*.d.ts` on an existing dev tree is still in the `test/**/*` glob. Exclude it.
5. `step-sdk-module.test.ts` throws each control class from module `apply` but has no `PromptBudgetExceededError` case (added to the entry by the #1183 rebase); identity is pinned, the throw path is not.
6. `worker/src/step-engine/dag-executor.ts:1914-1927`: a leftover "moved to" comment block sits after a `/** */` doc that described the old fence definitions and now describes nothing. PRE-EXISTING. Delete both.
7. No test pairs the worker's `isSingleLine && survivesFence` (`_untrusted-repo.ts:177-185`) against shared `isListableName`, and the guard test omits U+0000, U+001C-001E and U+007F. Equivalent by construction; add the pairing and those characters.
8. (#1192) `review-diff.ts` file reads resolve by name, bracketed by a worktree dev+ino check; a swap and restore inside one bracket is not caught. Close with fd-anchored reads (fs-safe can anchor on `/proc/self/fd/N`, as `nested-repository.ts` does).
9. (#1192) The standalone host collector's changed-line notes are not filtered by the deny policy (its contract does not promise withholding; decide).
10. (#1192) Untracked nested-repository metadata is read before the deny checks; an embedded repository's HEAD change does not enter the review hashes.
11. (#1192) The collector's pathspec argv is unbounded; a very large change can fail to spawn (E2BIG) and silently drop line notes.
12. (#1192) Coverage: no test drives `denyContent`/`withheldPaths`→`partial` through `readReviewDiff`; descriptor throw/cancel close paths and the start-of-collection identity check have no failing control; `_impl-changes.ts` ~:414 `scan.nestedRepositories[p]` is unguarded (`constructor`).
13. (#1192) Docs omit the `unreadable` disclosure and the maxBytes partial-coverage behaviour.

### T677 · FNF[composition-catalog] · composable workflow step catalog lows, after #1182 (+3)

status: parked: diminishing returns (2026-11-14, owner rule: trivial lows park; resume on a user report, a measured failure or a related change); item 1 resolved 2026-11-15 in #1195 (06b and gate 2 needs softened to ordering; both read null-safe) · kind: fix · found: #1182 reviews 2026-11-14 · priority: P4

Reviews in `.claude/tmp/codex-run/DT1-S/review-{1,2}.md`.

1. Gate 2 (`09-gate-2-verify-approval`) and `06b-sprint-planning` declare hard needs in `composable-core.ts` that the runtime does not enforce; a composed type that satisfies the catalog but loses the producer at run time would read `null`. Either enforce them where the step reads its input or soften them to ordering.
2. `04a-spec-audit` is ordered before `05` more strictly than its code needs; loosening it widens what a custom type may compose.
3. A private module's task type that holds one of the 23 newly catalogued core steps is now composition-checked at task creation; no external module is installed on the dev install, so the effect on private modules is unmeasured.

### T676 · FNF[external-module-dev] · external module dev install lows, after #1179 (+8)

status: parked: diminishing returns (2026-11-14, owner rule: trivial lows park; resume on a user report, a measured failure or a related change) · kind: fix · found: #1179 reviews 2026-11-14 · priority: P4

Reviews in `.claude/tmp/codex-run/EXM-S/` (review-2.md, review-3.md).

1. The guard's folder-path pattern needs a boundary before `modules/`, so `/app/modules/<x>`, `${{ github.workspace }}/modules/<x>`, `"$ROOT/modules/<x>"`, `join(root, 'modules', id)` and `.github/actions/*/action.yml` are not scanned for a private path (a package name still trips the name check).
2. After a selected module gains a `./web` or `./dashboard` export, web depends on it at once but the link appears only after `pnpm install`; gen-modules' advice for a selected external ("run pnpm module add") is wrong in that branch.
3. `scripts/local-modules.cjs` and `scripts/check-public-modules.mjs` copy the module-id pattern; `packages/shared/test/module-id-pattern.test.ts` does not pin them.
4. Turbo `--no-cache` (used in local mode) is deprecated in 2.11.7 and goes in 3.0; its replacement `--cache=local:r,remote:r` re-enables reads, so the migration needs a no-read-no-write form.
5. Literal `node` replaced `process.execPath` in `scripts/module.mjs`; a PATH node differing from the running one runs gen-modules under another Node.
6. Caller `--force=true`/`--cache=...` mixes with the local-mode policy flags; a caller `--filter=@haive-module/<id>` selects nothing in local mode.
7. A dev-checkout image build copies local clones, `.selection.json` and the local `.lock` into the own-module builder; release builds from a clean checkout are required (documented).
8. `.claude/memory-mirror/haive_next_build_on_dev_tree.md` still says to revert `next-env.d.ts`, which is now ignored.

### T675 · FNF[plan-chat-bound] · bounded plan chat, plan writers and plan write fence lows, after #1178, #1183 and #1193 (+21)

status: open (items 10, 1 and 3 resolved 2026-11-14 in #1193; item 9 owed live check still open: the 2026-11-16 capped run had no plan chat; the rest parked: diminishing returns (2026-11-14, owner rule: trivial lows park; resume on a user report, a measured failure or a related change)) · kind: fix · found: #1178 reviews 2026-11-14 · priority: P4

Reviews in `.claude/tmp/codex-run/PCB-S/` (review-2.md, review-4.md, review-5.md).

1. An oversized original message is kept only in `detect_output`; a reset that nulls step output loses it.
2. `retryPlanConflict` is safe by convention only: nothing stops a caller from passing a closure that reuses a stale read.
3. The 00b, 01-build and 02-coverage ordinal upserts can now hit a version conflict and have no retry.
4. A failed snapshot removal is logged and never retried until the next boot reap.
5. Failed plan jobs are removed, so their failure is visible only in logs.
6. No runner-level test that an oversized edit is refused on the converted edit form (shared and worker unit tests cover it).
7. No multi-chunk test that chunks written before a sequencing conflict drop out of the rebuilt pass (needs more than 500 ops).
8. AGENTS.md is within a few bytes of the 32 KiB Codex limit; any addition must trim first.
9. Owed live checks: each CLI reads the per-turn snapshot from its sandbox path; the Docker file-subpath mount works; rerun a large plan chat on Ollama.

From #1183 (bounded plan writers 11f/01f), reviews in `.claude/tmp/codex-run/PB5-S/review-{1,2,3}.md`:

10. REGRESSION, narrow. A budgeted dispatch no longer drops rules on `PromptTooLargeError` (`dispatcher.ts` ~:842), and the runner degrades only `PromptBudgetExceededError` for optional steps (`step-runner.ts` ~:1147), so a 11f/01f prompt that fits an argv-only adapter only without rules now fails the optional step instead of running; Skip/Retry remain. Degrade that error for optional budgeted steps.
11. A capped, stamped 01f range with no proposal says "the plan already described them" with no omitted counts (`01f` ~:413); append `(+M not listed)` and omitted paths. The `pathsOmitted` form assertion in `plan-writer-bound.test.ts` cannot fail.
12. `warnHold('range_not_measured')` drops `d.reason` and fires with no repository; the `plan_conflict` warn is untested.
13. A dropped-op message numbers ops by position among ticked ops, not the form's option number (`_plan-ops.ts` ~:172).
14. `step-runner.ts` ~:1111 still says "Cannot locate the plan chat prompt" for all three budgeted writers.
15. 01f now holds its watermark on no agent output (base stamped); consistent with 11f, but 01e still stamps.
16. The source-scan test exempts the whole bounded helper file and does not see wrappers outside step sources (`plan-prompt-render-source.test.ts`).
17. The boundary tests now reach 01f/11f's sizing lambdas only through the helper; dropping the `maxChars` argument from a lambda would pass.
18. A losing concurrent dispatch pass can overwrite the winner's checkpointed `detected` (runner checkpoint after `prepare`); safe direction (drops), theoretical.
19. (#1193) A fold reply that carries a caller version on one op and also hits a conflict from a derived write is classified per reply, not per op, so it degrades to a re-ask (`_plan-prompt.ts` ~:330-347, `01-plan-build.ts` ~:892, `02-plan-coverage.ts` ~:799). LOW, parked.
20. (#1193) `step-runner-llm.test.ts` ~:160-176: the mock's `insert().values()` is not thenable, so a bare `await db.insert(t).values(row)` records nothing and the assertion cannot see it. Test strength. LOW, parked.
21. (#1193) The legacy recovery opens a transaction on every advance of 01-plan-chat even when the hook returns null. NIT, parked.

### T674 · FNF[release-bundle-publish] · release bundle publish, read, swap and install lows, after #1180, #1181, #1185 and #1189 (+38)

status: parked (items 16, 26, 27 and 34 resolved 2026-11-15 in #1197; the two-install check's forced verify rollback and crash recovery cases are still NOT RUN and owed after #1197; the rest parked: diminishing returns (2026-11-14, owner rule: trivial lows park; resume on a user report, a measured failure or a related change)) · kind: fix · found: #1180 review 2026-11-14 · priority: P4

Review in `.claude/tmp/codex-run/RBP-S/review-1.md`; installer items in `IN6-S/review-{1,2,3}.md`.

1. `publish-channel.mjs` ~:408 stages files by the invoking checkout's allowlist while the archived generator hashes by its own; nothing asserts the staged names equal `Object.keys(manifest.bundle.files)`. Latent until the allowlist grows. Add one equality check after the manifest parse.
2. A commit without `install/bundle-env.json` or `manifest.ts` (any commit before #1172) fails as a bare `git archive failed (exit N)`; the generator's shallow/tagless refusals also lose their stderr, and `publish-channel` cannot pass `--allow-no-history`. Surface stderr or a named message; say pre-#1172 commits cannot be published.
3. A stale `<out>/release.json.image/` after a hard kill refuses every later publish, and a successful manual recovery leaves it behind. Document the manual delete.
4. The token-holding `release` job now runs `pnpm install` with checkout credentials persisted. `persist-credentials: false` on checkouts of token-holding jobs (release `build`/`merge`/`release` and CI); no workflow sets it today. Related first-party.
5. `release-bundle.test.mjs` always writes all four compose files, so the workflow's overlay-absent branch is untested.

From #1181 (updater reads the bundle), reviews in `.claude/tmp/codex-run/RBR-S/review-{1,2,3}.md`:

6. `setEnvVar` (updater) rewrites `.env` non-atomically, unlike `envkeys.ts`, which writes a temp file and renames it. Use the same exclusive temp + fsync + rename.
7. The dry plan (`--check`) and the real run compute their classification separately; extract one plan function both call.
8. Transport errors (DNS, TLS, reset) while fetching the manifest or bundle surface as refusals; they should be retryable failures, not policy refusals.
9. Writes under the install dir follow links in intermediate components; resolve held descriptors per component as fs-safe does.
10. A symlinked `.env` is replaced by a regular file on rename; refuse a linked `.env` or write through its resolved target.
11. `composeStop` now inherits the 32 MiB `maxBuffer`; harmless, but stop output needs no capture.
12. A third-party Compose error that echoes `.env` fragments reaches the journal through the restored pull/up/stop diagnostics; scrub or bound it.
13. `envkeys.ts` parses only `KEY=`; Docker's env-file syntax also accepts `KEY: value`, so `R=abc` then `R: ${X:-}` passes the interpolation check. Widen to `[=:]` with a test.
14. Single-quote scanning (`envkeys.ts` ~:26) treats `\\` before `'` as an escape; Docker documents only `\'`. Unverified, rare.
15. Tests do not pin a duplicate key (last wins), an `export` prefix, a multiline double-quoted value or the `env-key-interpolated` journal row.
16. (#1185) Rollback leaves containers of services the new release added running: `composeUp` is `up -d` with no orphan removal (`updater/src/docker.ts:124-130`). PRE-EXISTING, consequential now that PR5 swaps compose files. Add `--remove-orphans` on the rollback's compose up, or remove services absent from the restored bundle.
17. (#1185) The raw `err.message` reaches the log and the run journal before a rollback (`cli.ts` ~:541-545 `report('error', {message})`, passed to `undo` as `reason`, stored by `finishRun`); it can hold `/proc/self/fd/N/...` paths and Docker stderr. Scrub with `safeErrorMessage` plus path scrubbing at that call. The Docker stderr part is third-party (Compose may echo `.env` fragments; documented in `release.md`).
18. (#1185) `cleanupInstallTemps` and `requireRegularInstallFiles` run before `resume` (`cli.ts:334-335`): a throw leaves a live run un-rolled-back, and a link refusal exits 3 ("before any hold") while the interrupted run's hold remains. No realistic trigger found. Make both best-effort with an event on the recovery path.
19. (#1185) `readBundleState` sits outside the resume `try` and requires the current allowlist size (`bundle-swap.ts:35`, `cli.ts` ~:365); an older-shaped `metadata.bundle` exits 1 with no rollback advice.
20. (#1185) A stray regular file in `.haive-upgrade` aborts the prune loop with ENOTDIR (`bundle-swap.ts` ~:194); skip non-directories.
21. (#1185) Retention is unbounded in count: every rolled-back retry that carried edits leaves a `modified`/`legacy-unknown` backup, and each later commit logs an event per retained directory. Drop a retained backup whose files hash-equal a newer retained one.
22. (#1185) Recovery's `target` is typed as a full `ReleaseManifest` but holds placeholders (`migrationHead: ''`, `images: {}`, no bundle; `cli.ts` ~:351-361). Narrow `UpgradeContext['target']` on the recovery path so a later read is a compile error. Also no test covers forward-commit recovery without a head.
23. (#1185) `ensureEnvKeys` calls `chown` without the EPERM rule (`envkeys.ts:99`) and leaves a fixed-name `.env.haive-tmp` after a hard kill that the new temp cleanup does not match.
24. (#1185) A linked `.haive-upgrade` or `.haive-upgrade/pending` is not among the names `requireRegularInstallFiles` checks, so `stageBundle` fails with a generic ELOOP instead of a typed refusal (before `startRun`, nothing stranded).
25. (#1185) Tests: no `install-file-not-regular` case, no rolled-back retry leaving a retained backup, no EPERM test for the `child()` path of `preserveOwner` (`install-files.ts:131`), and no case where both overlays are installed and the target omits one (classified conservatively).
26. (#1189) An installer refusal after the first destination write leaves a partial install and the message does not say so: record ownership mismatch after chown, or a directory at a bundle file's name (`install/install.sh` ~:772-781, `install.ps1` ~:620-625). Say what was written and how to retry, or check before the first write.
27. (#1189) PRE-EXISTING, consequential: the generated `haive` helper and `uninstall.sh` writes follow a pre-existing link to an outside file (`install.sh` ~:938, ~:1000; `install.ps1` ~:820, ~:1037), and a dangling `.env` link creates a file outside the install (`install.sh` ~:821). Reuse #1189's stage-and-rename writer.
28. (#1189) A `--force` reinstall of a legacy release keeps a stale `.haive-bundle.json`, and a stale unselected overlay stays on disk, so the updater classifies the install `modified` (`install.sh` ~:765, `bundle.ts:23-30`). Remove a record the new install does not write.
29. (#1189) PowerShell wraps any bundle validation error in `Read-ChannelManifest` into the generic "channel or version differs" text (`install.ps1` ~:435); the sh message names bundle hashes.
30. (#1189) The public PS helper now ignores extra arguments to `up`/`down`/`logs` instead of failing on them (`install.ps1` ~:713-723), and unquoted `--replace-modified-bundle` on PowerShell 5.1 is untested.
31. (#1189) Tests: no base-file hash mismatch control (only run file and GPU overlay) and no public bundle version/channel mismatch case (`scripts/test/install-channel.test.mjs` ~:442).
32. (#1189) A relative `TMPDIR` breaks the public path, since the scratch copy runs after `cd "$INSTALL_DIR"` (`install.sh` ~:758-765). Resolve the scratch dir to an absolute path.
33. (#1189) `install.ps1` reads owners with GNU-only `stat -c` on every non-Windows host (`install.ps1` ~:627-634), so pwsh on macOS fails at the record write. Found by the DeepPattern smoke audit. macOS installs use `install.sh`; add a BSD `stat -f` fallback or refuse pwsh on macOS by name.
34. (two-install check 2026-11-14) The updater's drain and inventory counted work only on the current schema; on a legacy schema without `dead_at` it miscounted queued and running rows before migrating. Resolved in #1197.
35. (#1197 review) `install.ps1` has no test for a dangling `.env` link (the sh installer does).
36. (#1197 review) Rollback `--remove-orphans` also removes a service the user added in a compose override that the restored bundle does not name. Document it or scope the removal to services of the target bundle.
37. (#1197 review) The recovery message names the `upgrade_runs.to_version` journal field, a Postgres table an operator may not reach while the stack is down; also print the value when the updater can read it.
38. (#1197 review) `shared/test/encryption-key-boot.test.ts` ~:203-206: the "inventory fails" case now rejects the catalog query first, so its name overclaims. Rename or add a case that fails the inventory query itself.

### T673 · FNF[next-round-cli] · fix-loop next-round CLI choice lows, after #1175 (+9)

status: parked: diminishing returns (2026-11-14, owner rule: trivial lows park; resume on a user report, a measured failure or a related change); item 9 owed live check still open: the 2026-11-16 capped run had no fix-loop escalation · kind: fix · found: #1175 reviews 2026-11-14 · priority: P4

Reviews in `.claude/tmp/codex-run/NRC-S/`.

1. Clock-stamp precedence between the pick and the park is not pinned; a default pick leaves stale `fix:*` choice rows that should be deleted.
2. A re-park leaves `completed_at` and `error_message` on the row, drops the user's typed text, and has no test for a lost park epoch.
3. The api hard-codes the gate step id and the round slot format with no parity constant shared with the worker.
4. The gate header's meter (review-3, low).
5. The fence regex at `07-phase-2-implement.ts` ~:174-179 is hand-rolled; use `scanFences`.
6. Weak assertions in the round-choice tests; an upsert error in the `.catch` (`task-queue.ts`) masks `FixRoundCliUnavailable`.
7. `steps.find` in the submit-state helpers matches the first row of a step id across rounds.
8. A preset's `appliedValues` can override values after a re-park.
9. Owed live check: the gate UI picks a next-round CLI on a real escalation.

### T672 · FNF[learning-insert-replay] · step 11 insert replay writes a suffixed duplicate learning (+11)

status: parked (item 1 resolved 2026-11-15 in #1194, items 2-3 in #1202; the rest parked: diminishing returns) · kind: fix · found: agent-memory P1.2 driver and review 2026-11-14 · priority: P3

1. PRE-EXISTING, consequential. A re-run of step 11 apply re-reads existing learnings (`11-phase-8-learning.ts` ~:1722) and re-plans, so an insert already written is "taken" and `resolveInsertId` (~:763) returns `<id>-2`: a duplicate learning file, and the staged draft (keyed by the old id) is lost for the copy. Fix direction: make a replayed insert idempotent (match the already-written body or the reconcile event's attempt key) rather than suffixing.
2. (#1194) PRE-EXISTING, consequential. An update then delete, or update then supersede, of a PRE-EXISTING learning resurrects it on replay: the delete leaves no identity on disk, so the replayed plan re-applies the update to a file it no longer finds (`11-phase-8-learning.ts` ~:861). Needs durable deletion identity (a tombstone or the reconcile event's attempt key); the two matrix rows are excluded in `11-phase-8-learning-outcome.test.ts` ~:315-318 with no `it.fails`.
3. (#1194) PRE-EXISTING, narrow. Delete then insert of the same slug with a crash between the two operations can lose the staged draft.
4. (#1194) `prepareForm` plans without an apply key (~:1347), so a replay that re-stages the form computes ids differently from apply; reachable only with a null invocation id (test bypass). LOW, parked.
5. (#1194) No control for two identical entries in one proposal (the `index` key input) or a different task, round or step row. LOW, parked.
6. (#1194) `parseLearningRecord` runs for every existing learning even without an operation id writer. Cost only. LOW, parked.
7. (#1202) A sandboxed agent can write or delete `.haive/learning-deletions/` records in its worktree, forging or erasing deletion identity; apply reads them strictly but trusts their content. LOW.
8. (#1202) The deletion record publish does not fsync the parent directory, so a power loss can drop a record written before unlink. LOW.
9. (#1202) Records are never pruned until the worktree goes; with no worktree row they live in the repository workspace for good. LOW.
10. (#1202) Learnings named `.md` or `..md` pass the relaxed id check; harmless but odd. NIT.
11. (#1202) The repository-root fallback (no worktree row) is untested on real disk. LOW.

### T671 · FNF[check-run-records] · check-run recording lows, after #1170 (+8)

status: parked: diminishing returns (2026-11-14, owner rule: trivial lows park; resume on a user report, a measured failure or a related change); item 8 partly verified live 2026-11-16 (capped run: one passed 08/test row, the task Tests tooltip shows it, an Off lint slot writes none); still owed: 08b rows (needs a fixture with a selective runner) and the Statistics "Time & cost report" for a completed task (the run ended failed at T692) · kind: fix · found: #1170 reviews 2026-11-14 · priority: P4

Reviews in `.claude/tmp/codex-run/TC2-S/` (review-2.md, review-3.md).

1. The aggregate tile hint prints "0 passed · 0 failed · 0 not run · 0 incomplete" when the window holds only tasks from before recording began (statistics `time-cost-report.tsx` ~:85); show only the "Recording began" clause.
2. Row JSON for an unrecorded task carries `testSuiteRuns: 0` and all-zero `testCheckCounts`, so "no rows" and "recorded zero" look the same in the data. No other consumer today.
3. The failed-write warning path (L5) has no test asserting `logger.warn` was called.
4. No committed concurrency test for two replays taking over the same row (a scratch test passed 7/7); step ownership makes it unsupported today.
5. `statement_timeout` is per statement: the start block runs three statements, so the worst case is about 15 s, not the 5 s the comment implies (`_check-runs.ts` ~:9-17). Reword, or add `SET LOCAL lock_timeout`.
6. No test for a 57014 cancel on the finalization write, and the SET-before-write order is not asserted.
7. Residual unbounded waits: pool acquisition (`max: 10`, no client-side timeout), and BEGIN/SET before the timeout applies. Each recording write now holds a pooled connection across its round trips. Unmeasured.
8. Owed live check: a real workflow task records rows for 08 and 08b and the "Time & cost report" tab shows them.

### T682 · FNF[scratch-reaper] · task scratch cleanup lows, after #1206 (+5)

status: parked: diminishing returns (2026-11-15, owner rule: trivial lows park; resume on a user report, a measured failure or a related change) · kind: fix · found: #1206 reviews · priority: P4

Reviews in `.claude/tmp/codex-run/RPR-S/` (review-1.md, review-2.md).

1. The Editor stat (`worker/src/sandbox/ide-runner.ts` ~:160) and the api Editor root check (`api/src/routes/tasks/_helpers.ts` ~:1164) read a repository-less task's scratch without the per-task section; read-only, path-based, ratchet-pinned.
2. The scratch section has no overall wait timeout; a hung docker listing (bounded 10 s) or `rm` holding it stalls `ensure` for that task.
3. Shell and IDE containers are not `haive-cli-` containers, so the clean-sandbox listing never counts them.
4. The fence-versus-removal test relies on completion order rather than an injected barrier (`worker/test/scratch-workspace.test.ts` ~:485).
5. The owner and epoch admission rechecks have no dedicated controls (only status is exercised).

### T683 · FNF[committed-snapshot] · committed snapshot mount lows, after #1210 (+8)

status: parked: diminishing returns (2026-11-15, owner rule: trivial lows park; resume on a user report, a measured failure, a production snapshot issuer or a related change) · kind: fix · found: #1210 reviews · priority: P4

Reviews in `.claude/tmp/codex-run/P5B-S/` (review-1a.md, review-1b.md, review-2.md).

1. The transient-fault classifier (`worker/src/repo/committed-snapshot.ts` ~:55-75) wraps issue and resolve, which touch no database: a git-child `EPIPE`/`ECONNRESET` is rethrown raw without the `SNAPSHOT_INVALID:` text, so the barrier misses it, and the class depends on which event wins a race. It also misses postgres.js `CONNECT_TIMEOUT` and SQLSTATEs 53300, 40001, 40P01, 57014. Fix: classify only around the two `db.query` lookups, drop process codes, add `CONNECT_TIMEOUT`, one control each. REGRESSION, low.
2. `runTool` rejects at once on spawn error, abort or stdin error, so `withObjects` closes the `.git` and owner fds while `use` may still run one fs-safe call on `/proc/self/fd/<n>` (`committed-snapshot.ts` ~:167-226, `tool-spawn.ts` ~:102-126). Fix: await the `use` promise's settlement before closing handles. REGRESSION, low.
3. The dispatcher-level clamp (`orchestrator/dispatcher.ts` ~:355-362) has no control: the mining-retry test mocks the resolver to null. Fix: one dispatcher test with a pinned view and no `toolProfile`, asserting `mcpSurface.ragOnly`. Test gap.
4. `scripts/test/ci-gated-list.test.mjs` ~:200-209 hardcodes `SNAPSHOT_SANDBOX_TEST_IMAGE` instead of deriving it from the test's guard via `gatedEnvironment`; a renamed guard leaves the CI step green and the control skipped. Also the `module-source-pin` exemption still says "smokes" though it runs in `compose-boot` (PRE-EXISTING wording).
5. The `dispatch failed before the agent was queued:` prefix is written in `step-runner.ts` ~:2508 and matched in `committed-snapshot.ts` ~:44 as two literals; a shared constant would make the pair explicit (the writer test pins it today).
6. No production snapshot issuer exists yet, and each issue creates a new inventory and tree that stays until the task scratch is reaped (`committed-snapshot.ts` ~:437, `scratch-workspace.ts` ~:140); re-issuing on a re-offer can leave unused artifacts, and a crash mid-rebuild leaves a `stage-*`/`incomplete-*` directory until then. Decide reuse/collection when the issuer lands.

7. No test sets setuid, setgid or sticky on a tracked file, though the `& 0o7777` mode check refuses them (`committed-snapshot.ts` ~:384); coverage only.
8. `{ ...SNAPSHOT_LIMITS, ...opts.limits }` (~:142) turns an explicit `undefined` limit into `NaN`, which never refuses; no production caller passes `limits` (theoretical, same for every limit).

### T686 · FNF[dag-partial] · record-and-continue DAG policy lows, after #1217 (+3)

status: done (#1219, dce128eaf; follow-up lows in T688) · kind: fix · found: #1217 review-2 2026-11-15 · priority: P2

Reviews in `.claude/tmp/codex-run/P9-S/` (review-2.md, review-3.md).

1. MEDIUM, REGRESSION (opt-in only, unreachable today): a deterministic auxiliary fault (for example a replanner prompt the provider always content-filters) faults again on every Retry, because a fault spends neither `advisorInvocations` nor `replannerInvocations` and `resetDagCurrentLevelForRetry` re-runs the same prompt (`worker/src/step-engine/dag-executor.ts` parseReplanner ~:2133, parseAdvisor ~:2093). The replanner has no `isProviderRefusal` branch, unlike the advisor (~:2246). Fix direction: treat a replanner content-filter refusal like the advisor's (an explicit outcome), and/or bound consecutive hard faults per auxiliary role with a counter separate from the replan budget, ending in a clear non-retry message. Docs (fix-loop.md) currently say Retry does not cure it and to switch the step's CLI.
2. LOW: `dag-executor.test.ts` runs about 10 s, over the 5 s per-file budget (testing.md); split the per-policy provider cases into their own file if it grows.
3. MEDIUM, REGRESSION (opt-in only, #1217 Greptile P1): `ingestReviewRun` (`dag-executor.ts` ~:1564) never calls `assertEscalationEnvironment`, so under opt-in a reviewer or fix-coder run that ended in an environment, outage or interrupted fault is consumed and the review loop continues (another reviewer, or escalation records the issue). Fix direction: call the check after the content-filter branch and before the truncation and re-spawn handling (it returns early for never-answered runs); controls for reviewer and fix coder under both policies.

### T685 · Typed step ports: roles in addition to step ids (series, approved)

status: core done, optional PR7 open (approved 2026-11-15; PR1 DONE #1214 f6fc8fb0e; PR2 DONE #1216 1689a5f57, live canvas checked through the web origin; PR3 DONE #1220 2a2528792, migration 0244 deployed; PR4 split: PR4a module/SDK ports + canvas binding DONE #1224 17157320d, migration 0246 deployed; PR4b prompt `{{role:}}` tokens + structured output DONE #1225 c78b0b921 (session decision: a prompt step may provide only agent-only, no-hostPolicy roles; none qualifies today); PR5 split: PR5a discovery + requirements roles DONE #1226 276870074 (all three mixed, no quote projection); PR5b implementation summary DONE #1227 a46414313 (learning reads by role; the changed-files collector and similar-sites stay physical); PR6 split: PR6a validation/verify/test-management roles DONE #1228 35aca9f33 (house-rules stamps now scoped to the producer's own task row for validation and review; contradictory canonical validator reports stored as incomplete), PR6b browser verification + adversarial QA roles DONE #1229 cff23bb20 (manual checklist never a tested pass; an alternate QA producer waives only its own finding rows). Remaining: PR7 optional (many-valued review-lens fan-in, onboarding context DTOs), only when a concrete consumer needs it) · kind: feature · found: owner request 2026-11-15 · priority: P2

Plan: `docs/plans/typed-step-ports.md` (archived when PR1 starts; session copy `~/.claude/plans/tranquil-hugging-willow.md`). Analysis: `.claude/tmp/codex-run/ROLE-S/codex-1/design.md` + `edge-index.md`. Owner decisions 2026-11-15: ports carry data only (no loop/skip/gate/commit power); spec is a stage chain (04 draft, 05 checked, 05a resolved) plus an effective-spec host adapter; node canvas (`@xyflow/react`) from the first UI PR; spec chain is the first port. PRs: 1 registry + spec chain (xhigh); 2 read-only canvas (high; CSP check); 3 universal v3 per-consumer pins, nullable task column (xhigh; after INS3b); 4 module/SDK/prompt ports + canvas binding (xhigh); 5 discovery/requirements/implementation summary (high); 6 checks and advisory results (xhigh); 7 optional fan-in. Physical step-id reads stay for gate forms, worktree/runtime, receipts/side effects, replay, migrations, insight inventory.

For PR3 (from #1214 review-2): (1) the declaration parity control only checks declarations that exist; before pins bind from them, assert every spec role has exactly one provider with `stepId === legacyStepId`, pin input names and `optional` flags in one table, and decide whether 06-run-config and 08b declare `consumesRoles` (they read spec stages but declare none). (2) Add 08c and a module producer to `spec-port-catalog.test.ts` asserting `outputContract`/`replaces` survive catalog sync; add an `assertStepOutputDeclaration` throw case for a spec ref. (3) `readRole` error text says "host-policy" for an unregistered role too. (4) From the canvas PR review: `validatePortEdges` copies every earlier producer id into each input's `candidates` (O(consumers x producers)); admission must bound its own step count, since the `/ports` cap does not cover it. Its `bindings` argument is now keyed by run position. (5) Low, UX: the task-history canvas is 650 px high and sits above the step cards, so an approval form moves below it.

From PR5b (#1227) review (`.claude/tmp/codex-run/PRT5B-S/review-1.md`): (v) the 06c adapter ignores 06c's `row.output`; a future 06c summary needs a deliberate change there; (w) learning prompt lines for summary/filesTouched are unfenced (`11-phase-8-learning.ts` ~:1529-1532) and an author-bound module can now fill them (trusted code; fence when touched); (x) no test for a DAG task with a 07 fix round or Retry of 06c on a DAG-only list (both reduce to covered cases).

From PR6a (#1228) reviews (`.claude/tmp/codex-run/PRT6A-S/review-1b.md`, `review-2.md`): (y) a module stamp is accepted for any invocation of the producer's own row, including a superseded earlier attempt (no `supersededAt IS NULL`); it still cannot reach ENFORCED; (z) no direct test that the writer-side `loadInvocationStamp`/`givenRuleIds` refuse a cross-row or cross-task id; (aa) the return-shape table types only its base fixtures against the step return types, spread variants go through `unknown`; (ab) the reversed module-seeded 08/08b list's explicit absence has no test of its own; (ac) gate-2 byte fixtures have no fix-round row beyond `round: 1`; (ad) smoke registry overrides (`stepRegistry.override`) are untyped, so a partial stub output reaches the strict contracts only in CI (the fix-loop smoke was typed after it failed; type the others).

From PR6b (#1229) reviews (`.claude/tmp/codex-run/PRT6B-S/review-1a.md`, `review-1b.md`): (ae) a legitimate module browser skip/not-run is rewritten to an incomplete FAIL under the NO EVIDENCE pill with pass-without-screenshots copy, and its method is overwritten (fail-closed, misleading copy); (af) a module's self-asserted browser `passed` with method mcp/interactive demotes a failing HTTP smoke to advisory, since only canonical 08a derives incompleteness from screenshots on disk (same trust grain as a module validator's `passed`); (ag) a module `appLogin.ok` and the truthiness of its `appUrl` choose QA's login paragraph, and `browserOut?.appUrl ?? boot?.appUrl` lets `''` win over the boot URL (no reach, can narrow QA coverage); (ah) no test enforces executable/serialized parity for core `consumesRoles`; (ai) stale ratchet reason on `canonicalCheckResult`; (aj) web `task-history.ts` tested-method set lacks the retired `direct` mode the contract lists; (ak) the history digest mines nothing for QA/browser when a derived pin has no `executionPath`; (al) gate 2 reads 08a a second time for the live-browser URL.

From PR5a (#1226) reviews (`.claude/tmp/codex-run/PRT5A-S/review-1.md` L4-L9, review-2): (r) the effective-requirements adapter shows only when a consumer declares BOTH requirements roles; a consumer declaring only the humanized role gets a direct input and no adapter (no fixture does this); (s) `prompt-port-legacy.test.ts` now replays frozen base nodes, so live declaration drift for 05/07 is pinned only by `step-port-projection-parity` and `spec-role-declarations`; (t) 03b's prompt still shows `discoverySummary` unfenced (`03b-business-requirements.ts` ~:118), which an author-bound module producing `haive.discovery` could now feed (modules are trusted code; no new boundary, but fence it when touched); (u) style: `_business-requirements.ts` export placed between imports and header; new imports above `node:` ones in 03/03b/04.

From PR4b (#1225) reviews (`.claude/tmp/codex-run/PRT4B-S/review-2.md`, `review-3.md`): (k) a structured prompt step under test bypass returns prose (`prompt-step.ts` `bypassStub`) and fails its contract; (l) the unsynced-catalog refusal also fires for an entry holding an empty `consumesRoles: []`/`providesRoles: []` with no tokens (`task-type-definition.ts` ~:302-306), a state the editor produces; (m) the admission half of two refusal controls asserts only 409 (likely `missing-step`, not the role refusal; `task-types-routes-db.test.ts` ~:223, :290), and the runtime `custom.` removal in `assertDataEdgeSupport` has no control; (n) the provider rule is derived twice (`role-port-declarations.ts` ~:46-50 vs `isPromptProvidableRole`) and the `custom.` structured-payload condition is hand-written in three places (`read-role.ts` ~:164, `step-output-contract.ts` ~:123, `core-data-ports.ts` ~:88): one helper each; (o) new benign import cycle `step-output-contract.ts` <-> `prompt-role-output.ts`; (p) no negative control for a module/core producer returning a `{roleOutput: ...}` wrapper (code fails it correctly); (q) editor: rename refusal per keystroke can make a name unreachable by typing when a prefix collides (`prompt-step-roles.tsx` ~:65); "Remove input" leaves its binding (recoverable via Clear); the structured checkbox cannot be unchecked when nothing is providable (~:139); refusal message shadowed by a FormRenderer local error; docs omit the old-name-binding refusal.

From PR4a (#1224) reviews (`.claude/tmp/codex-run/PRT4-S/review-1a.md` L1-L7, review-2a, review-2b, review-3): (a) no committed control pins the compose passthrough of `HAIVE_DATA_EDGE_ADMISSION_ENABLED` (a three-line assertion in `worker/test/rootless-docker.test.ts`); (b) no negative test for the executable-declaration path `step-data-role-invalid` (`step-output-contract.ts` ~:37); (c) docs say "plans that would be pinned" while the guard also blocks `workflow_paths` on an unsynced catalog (conservative); (d) the agent-authorship branch in `module-role-read.ts` ~:59 is unreachable now that host-policy roles are reserved, and hands a module the raw body if a later agent-authored non-host role appears; (e) the `dataOnly` refine reports "host-policy role" for an unknown role too; (f) derived-mode composer memo recomputes every render (`task-type-editor.tsx` ~:632 fresh `stepIds` array); (g) unverified that the server preview serializes candidate `roleBindings`; (h) brief list flicker after clearing the last binding; duplicate stale-binding message; (i) `contentHashOf` (`task-type-seed.ts` ~:54-67) excludes `dataRoleBindings` (no reader depends on it today); (j) deploy note: `pnpm docker migrate` recreates the api, so run `pnpm docker libs` BEFORE migrate when a shared export is new.

For PR4 (from #1220 reviews): (6) input/consumer absent from a valid v3 pin reads canonically (session decision in #1220); the task canvas projects only from the pin, so such an input shows no edge while the worker reads the canonical producer. (7) Review/audit pins for 09-gate-2 and 11 are stored and boot-checked but still read through `readStepRole`; PR4/PR6 must switch the readers or the pins stay decorative. (8) `readSpecStages` parses and fingerprints the plan three times per read. (9) Consumer id lists in `step-ports.ts` (~:121-137) duplicate `SPEC_INPUTS`/`CORE_DATA_INPUTS`; review side has no parity test. (10) `retryHeldRevivals` may retry forever for a permanently malformed pin. (11) Tests: `api/test/data-edge-lifecycle.test.ts` imports worker source across packages and never resets an upstream producer; no route-level test of a static v3 pin with a chosen path. (12) No v3 admission kill switch (rollback needs a deploy); previews build and discard the full plan.

### T684 · Agent isolation for committed-snapshot dispatch (owner decision)

status: decided 2026-11-15 (owner): apply the same `agentIsolationApplies` rule as live dispatch; ship it with the first snapshot-ref issuer, not before (needs tmpfs masks over agent dirs inside the read-only snapshot mount, checked against the snapshot integrity checks; xhigh review) · kind: design · found: #1210 review-1b (B6) · priority: P3

A mining agent dispatched against a committed snapshot runs with per-call agent isolation off (`worker/src/orchestrator/dispatcher.ts` ~:447). The snapshot is read-only and host-owned, and the agent's tool profile is clamped to `rag_only`, so the live checkout is not reachable; isolation would additionally give each call an empty agent directory and a pasted persona (see agent-isolation.md). Question: keep it off for snapshots (simpler, persona read once under the scratch lock), or apply the same `agentIsolationApplies` rule as live dispatch? No production issuer exists yet, so nothing runs this path today.

### T670 · FNF[fix-test-evidence] · repair test-edit evidence follow-ups, after #1171 (+18)

status: parked (items 1 and 3 resolved 2026-11-15 in #1204; item 9 was already shipped in #1171 (`**/.auth/**` default deny), pinned by a control in #1204; the rest parked: diminishing returns) (OWNER DECISION 2026-11-14: one rule for both sinks: run the committed-secret scanner over stored test-edit content and the gate-3 diff viewer, redact matches with a withheld marker; add `.auth/**` to the default deny globs; queued overnight with items 3 and 9; the rest parked: diminishing returns (2026-11-14, owner rule: trivial lows park; resume on a user report, a measured failure or a related change)) · kind: fix · found: #1171 reviews 2026-11-14 · priority: P3

Reviews in `.claude/tmp/codex-run/P6-S/` (review-2.md, review-6/review.md, review-6/review-2.md).

1. An agent can copy a tracked secret (or a protected file outside the test set, such as a root `.env`) into an allowed test file; the copy's content is stored and shown. Same exposure as the gate-3 diff viewer; decide one rule for both. PRE-EXISTING class, low-medium.
2. A moved secret's full-file sha256 is stored in the manifest and shown as the after identity. Low.
3. A superseded or stopped repair pass never reaches `finishFixTestCapture` (step-runner.ts ~:760, ~:775), writes no after event and so does not taint the task; a later edit of the moved file would retain the secret. Low-medium.
4. Withheld same-size `contentUnknown` counting has no negative controls (a withheld file that changed size, a non-withheld same-size edit).
5. Review-2 F3 (design limit, medium-low): provisional before bytes live per worker process (`pending` map, FIFO), so a restart or eviction degrades the whole pass diff to hashes; see P6-S/review-2.md.
6. Review-2 F9 (low): begin derives the workspace via `resolveInvocationWorkerTree` (step-runner.ts ~:1227) while finish prefers the issue/task `worktreePath` (`_fix-test-store.ts`); same directory for a worktree task, unverified for read-only local-path repositories.
7. `/events` is polled every 2 s unpaged. PRE-EXISTING.
8. The event digest loads all payloads. PRE-EXISTING.
9. `.auth/` directories are not in the default secret deny globs. PRE-EXISTING.
10. (#1204) The original sha256 of a redacted blob is kept as its identity, which is a guessing oracle for short secrets; make it a per-task HMAC together with item 2. LOW.
11. (#1204) Blobs and built forms stored before #1204 are not backfilled; they age out after 30 days. LOW.
12. (#1204) `PUT /files/content` has no server-side refusal of marker text; only the viewer stops a withheld preview being saved over a real KB file. LOW, defense in depth.
13. (#1204) `/files/archive`, the editor and live `/files/content` still serve real worktree bytes; the viewer recheck only stops display. Credentials can still be committed with no commit-time warning. LOW.
14. (#1204) An ended pass that still owns its step is re-examined, with a step-row lock, by every begin and load: k ended-not-ingested DAG siblings cost k short transactions per begin. LOW, perf.
15. (#1204) No controls for ownership lost by task status alone (failed/cancelled/completed at the same epoch) or a `skipped` step; the invalid-UTF-8 withholding is covered only by the DB-gated test. LOW.
16. (#1204) Not proven: an ended, owned pass that no flow re-enters never settles or taints; no such path found in step-runner or DAG ingestion, escalation and replan branches not traced. LOW.
17. (#1204) A KB draft that quotes the withheld marker, or holds any scanner candidate, is read-only in the gate viewer. LOW, by design.
18. (#1204) The settlement reason "Invocation lost ownership" is also written for a superseded pass that still owns its step. NIT.

### T669 · External modules: private repositories and a dev install that leaves haive clean

status: done 2026-11-16 · kind: feature · found: owner decision 2026-11-14 (#1174) · priority: P2

Prerequisite for the translator (`docs/plans/translator-module.md`) and deep-analysis (`docs/plans/kind-riding-dream.md`) modules, which are the first external modules and live in private repositories.

1. DONE 2026-11-14: private repositories `martinambrus/haive-module-translator` and `martinambrus/haive-module-deep-analysis` created (README only, default branch `main`).
2. DONE 2026-11-14 #1179 (bd7217c8a). Core: a dev install of an external module (cloned into `modules/<id>/`, then `pnpm module add <id>`) leaves nothing in a haive commit. Today `modules/` is tracked and `pnpm module add` edits tracked `package.json` files and `pnpm-lock.yaml`. Design choice: ignore the folder and keep the dependency entries out of tracked files.
3. DONE 2026-11-14 #1179: `scripts/check-public-modules.mjs` against root `public-modules.json` (install/runtime wiring only; prose and test fixtures exempt). Owed: the first Dependabot lockfile PR after #1179 keeps `pnpmfileChecksum` (a lock without it fails frozen installs).
4. DONE 2026-11-15 #1199: reusable `.github/workflows/module-ci.yml` + `scripts/module-ci.sh` + caller template `scripts/templates/module-repo-ci.yml`; v0.2.0 predates #1179, so callers pin a main SHA until the next tag. Open low: the clean-tree check cannot see changes to gitignored files. Was: Module CI template: check out haive at a pinned release tag, place the module at `modules/<id>/`, build and test there (core packages are unpublished, `pnpm.overrides` pins them to `workspace:*`).
5. DONE 2026-11-16 #1235 (ec3c7f4a0): `npm pack` manifest identity checks for registry installs, legacy-tag preflight and TS7016 hint in the channel build; all three paths exercised live with a stub module (org `haive-module`), stub repo and package deleted after. Was: Release path check: a restricted `@haive-module/<id>` publish to GitHub Packages, the vendor channel build, and a git install source with a token, each exercised once end to end with a stub module.

### T663 · FNF[plan-canvas-smoke-lows] · plan-canvas smoke check lows, after #1161 (+4)

status: parked: diminishing returns (2026-11-14, owner rule: trivial lows park; resume on a user report, a measured failure or a related change) · kind: fix · found: #1161 review 2026-11-14 · priority: P4

1. (connected, PRE-EXISTING, by reading) The check "child added under a node being deleted" most likely never reaches the stray-child guard: the editor's patch holds the plan-patch lock and the reconcile waits on that first (`packages/worker/test/plan-canvas-smoke.ts`, `plan/mirror.ts`). Confirm at runtime; if so, reorder the check so the guard is exercised.
2. The `settling` helper discards the peer's outcome, so an early unrelated peer failure still passes the check (same as the old sleep).
3. The `blocked()` poll loop issues `pg_stat_activity` queries back to back with no pause.
4. The 5 s watchdog's failure message names no fixture or check label.

### T661 · FNF[provider-shell-close-lows] · provider shell revocation lows, after #1156 (+6)

status: parked: diminishing returns (2026-11-14, owner rule: trivial lows park; resume on a user report, a measured failure or a related change) · kind: fix · found: #1156 reviews 2026-11-14 · priority: P4

1. `api/routes/cli-providers.ts` ~:258: `publish` returns the receiver count and it is ignored; a close-provider sent while the worker's subscriber reconnects is lost silently (open shells then outlive the disable). Log or retry on zero receivers.
2. Design, documented: the tmux process tree keeps running in the container for the 2-minute grace plus up to a 30 s sweep after revocation; input is dead and the socket closed.
3. `web/lib/terminal-refusal-message.ts` ~:17 and its tests hold a third copy of the disabled-provider sentence now that `TERMINAL_PROVIDER_DISABLED_MESSAGE` exists in shared.
4. The connect refusal (`closeRefused`, `api/lib/upgrade-auth.ts` ~:42-56) closes with the code only; the revoke path sends the sentence as the reason too. Cosmetic.
5. PRE-EXISTING, connected: a throw between the container ensure and the registry write (`worker/terminal/terminal-session-manager.ts` ~:490-527: turn, trust seed, workdir probe, exec, start) leaves a freshly created container that only the next worker boot/shutdown sweep removes. Write the registry entry right after the ensure.
6. PRE-EXISTING, theoretical: the registry write is `hset` then three `hsetnx` (not atomic); a reaper sweep between them reads no `lastSeenAt`/`refcount` and may remove a just-attached container. Use one MULTI.

### T553 · FNF[disabled-task-cli-2] · leftovers after the disabled-provider hold (+9)

status: open · kind: fix · priority: P3
From the T406/T408 build (2026-11-07).

1. DONE 2026-11-14 #1162: warns before a disable that would hold tasks (impact preview + confirm).
2. DONE 2026-11-14 #1162: a provider hold shows its own badge (`provider_wait_provider_id`, `deriveSlotWait` kind provider).
3. DONE 2026-11-14 #1162: the hold copy names enabling the provider and switching the step CLI.
4. A step held on a disabled provider shows "usage not connected": the usage poll covers enabled providers only (worker usage-poll-queue.ts ~:424). PRE-EXISTING, widened.
5. DONE 2026-11-14 #1162: the recap skip is logged at warn.
6. DONE 2026-11-14 #1162: the hold precedence is tested.
7. DONE 2026-11-14 #1156: a disable that races an open now closes with 4425.
8. From #1145 review: the web task page loads providers once (`tasks/[id]/page.tsx` ~:1220), so a provider disabled in another tab leaves the shell picker stale until the server refuses the next connect. PRE-EXISTING, minor.
9. Nits: `step-context-usage.ts` ~:51 throws "invs is not iterable" under mock-DB unit runs (harmless); stale "web package has no vitest config" header in web lib/step-cli-providers.ts ~:20; `providerLabel` in provider-hold.ts shares a name with sandbox/mcp-surface.ts ~:389.
10. (#1162 review) The impact count runs per-task queries (N+1) over affected tasks (api lib/provider-disable-impact.ts). Low: admin action, bounded by open tasks.
11. (#1162 review) The impact preview's list select is untested against a real DB; 404 and non-JSON preview replies are untested through the real web client. Tests only.
12. (#1162 review) A reset path keeps `provider_wait_provider_id`; masked because the badge also requires `waiting_started_at`. Latent.
13. (#1162 review) Save or Rebuild leaves the form in "building" if both the PATCH and the refetch fail (web cli-provider-form.tsx). PRE-EXISTING.
14. (#1162 review) The deferred-poll control's red run was not isolated from the other changes; stale comment at worker step-engine `_helpers.ts` ~:980. Evidence and comment.

### T555 · FNF[egress-guard-hardening] · remaining egress guard gaps: local NAT64 and Teredo, probe details (+2)

status: parked · reason: diminishing returns (owner triage 2026-11-10); resume on a user report, a measured failure, or a change in the same code · kind: fix · found: T347 run · priority: P2

Three items (metadata addresses, IPv4-compatible form, required fetchFn) shipped in PR #1040 (4dceda71f), the Azure host address in PR #1041 (aa529e991) and item 7 (local NAT64, Teredo) in PR #1048 (82343cc60), 2026-11-09. Items 3 to 6 and 8 stay parked as before.

3. Hostname entries consult the hosts file only when DNS fails, so a name public in DNS but overridden in /etc/hosts dials the DNS answer (shared egress/probe-egress.ts:96,127,186,319). Accepted behaviour; revisit only on a report. NEW-LIMIT.
4. `deflate` maps to `createInflate` (probe-egress.ts:158), so a raw-deflate body fails. PRE-EXISTING (moved code).
5. The guard sends `accept-encoding: identity` by default (probe-egress.ts:219). PRE-EXISTING (low).
6. DONE 2026-11-14 #1159: a bracketed `[::1]` DSN host now parses to `::1` (`dsn-dial-host.test.ts`).
7. Shipped in PR #1048 (local NAT64 and Teredo cannot be lifted by a hostname entry).
8. (T555 run) `isUnliftableByHostname` returns false for a non-address string while the base table blocks it. Unreachable today, since resolvers return address literals. PRE-EXISTING, theoretical.
9. (T555 item 7 review) Tests only: the 'explicit entry still lifts' cases in shared test/probe-egress.test.ts ~:335-348 assert only that the code is not ENOTFOUND, so any other failure passes (house style, the link-local test beside them does the same), and no test pairs a built-in host with an answer in the tunnel ranges. NEW, minor.

### T556 · FNF[ollama-pull-relay] · pull stream relay edges

status: parked · reason: diminishing returns (owner triage 2026-11-10); resume on a user report, a measured failure, or a change in the same code · kind: fix · found: T347 run · priority: P3

1. The pull route has no `stream.onAbort` (api routes/tooling.ts, `activePulls` ~:222); a closed tab frees the upstream only through the idle and size caps. PRE-EXISTING.
2. Pull progress `status`/`digest` strings are relayed uncut (tooling.ts:370-371). PRE-EXISTING (low).
3. `armIdle` re-arms only on upstream reads (tooling.ts:279-335), so a client that stops reading for 10 minutes can trip a misleading idle stop. NEW-LIMIT (edge).
4. A late `fetchFn` resolve after an idle stop leaves its body unconsumed for a custom `fetchFn` that ignores `signal`. NEW-LIMIT (edge).

### T557 · FNF[unguarded-dial-audit] · dials that still bypass the egress guard (design) (+11)

status: open · kind: design · found: T347 run · priority: P2
Owner decision 2026-11-12: item 2 admin-trusted, document it; item 3 remove the dead SMTP keys; item 12 non-admins may pull only models already named in a provider or Global KB config, plus an admin-managed allowlist (admin UI with GET/PUT), admins pull anything.
Each needs a per-dial decision (guard, admin-trust, or remove).

1. Shipped in PR #1049 (provider Test connection guarded by the owner role). Correction: api routes/cli-providers.ts:664 only enqueues and cli-adapters/zai.ts only sets env for the sandboxed CLI; neither is a dial.
2. DONE #1115 (documented in api-auth.md). Admin-trusted by decision: Global KB external DSN (shared global-kb/connection.ts:172,177), `POST /global-kb/test-db`, vendor/module admin config. PRE-EXISTING; confirm or guard.
3. DONE #1110 (ce3dc139c): SMTP keys, defaults, secret name, compose env and .env.example removed; boot deletes the seeded `config:email:*` keys and any `smtp_password` row (live: api logged the removals, Redis scan empty).
4. `integration_provider_configs.api_base_url` is unused (database schema/integrations.ts:51); a future dial must use the guarded fetch. PRE-EXISTING.
5. Shipped in PR #1055 (caa59abf2): a non-admin's git remote (clone, refresh, bundle sync, task-step fetch/push) is resolved by the egress guard before git starts and the checked address is pinned; admin remotes unchanged. The remaining check-to-spawn window is T585.
6. Shipped in PR #1050 (a non-admin's call tests the stored settings and ignores the body; an admin keeps the typed URL).
7. Shipped in PR #1049 (the OpenRouter compat probe, same guard).
8. Shipped in PR #1054 (13db14a66): the Ollama and OpenRouter probes and the Z.AI poll read at most 64 KiB (`readBounded`, `readForgeJson`).
9. Shipped in PR #1054 (13db14a66): the Z.AI usage poll takes its transport from the shared owner-role `resolveProbeFetch` (worker cli-adapters/probe-fetch.ts).
10. (PR #1049 review) For the exempt in-stack names a non-admin sees the transport text with the container address and open port (`describeTransportError`, ollama-probe.ts ~:62-72). PRE-EXISTING, minor, narrower than before.
11. (PR #1049 review) The refused warning says "refused by the egress guard" also when a built-in host's DNS is down, and no test drives `ConfigUnavailableError` into the Ollama result. NEW, minor.
12. DONE #1119 (6dc2ab3a9): a non-admin may pull only a model configured on their providers, the default embedding model, or one on the admin allowlist (GET/PUT `/admin/config/ollama-model-allowlist`, admin card); provider save and boot paths in T634. Was: (PR #1050 review) `POST /tooling/pull-ollama-model` with the exempt in-stack host lets any signed-in user make the shared Ollama pull an arbitrary model (api routes/tooling.ts pull stream). Whether onboarding needs this for non-admins is unverified. PRE-EXISTING, possibly consequential (disk, bandwidth); needs a decision. Non-admin callers are by design: OllamaTestButton (web components/connection-tester.tsx ~:103,147, task page step forms) and ollama-model-download.tsx ~:37 (cli-provider-form), so admin-only would break them. Resume when disk or bandwidth use is reported; fix direction then: a non-admin may pull only a model a setting or form already names.
13. (PR #1050 review) Minors: a stored Ollama URL with userinfo is returned to every role and echoed in the test message (global-kb.ts `configResponse`); the Test's `ollamaEmbed` passes no timeout, so a hung Ollama holds a non-admin page load up to 240 s (global-kb.ts, tooling.ts ~:117); the non-admin test path decrypts the external connection string only to read three fields (`resolveGlobalKbSettings`); that path's not-configured branch is unreachable with the real resolver and its spelling matrix left the shared table in probe-targets.test.ts. PRE-EXISTING or NEW, minor.
14. (PR #1054 review) Usage poll minors, all PRE-EXISTING or by decision: the poll resolves the transport (one `users` read) for every usage provider with a hand-set URL though only zai consumes it, and `Promise.allSettled` (usage-poll-queue.ts ~:443) drops a rejection with no log; the poll reads only `ANTHROPIC_BASE_URL` while the Z.AI run adapter prefers `Z_AI_API_URL` (cli-adapters/zai.ts ~:63,106), so such a provider is polled at the default origin; a `ConfigUnavailableError` from the guard's allowlist read lands as `Configuration store unavailable` row text, not the quiet retry error-diagnostics.md describes for ticks; a non-admin's public `http://` origin that redirects to https now stores `http 301` (the guard never follows redirects, by decision). Minor.
15. (item 5 follow-ups, PR #1055) Minors of the git remote owner guard, PRE-EXISTING or by design unless noted. a) (moved to T585) b) The config scan refuses for keys of any scope and of unrelated hosts (an external checkout with a corporate `http.<url>.sslverify`), and an ssh-only origin is scanned although it needs neither key family; the message says "repository's git config" even when the key is global or included (git-push.ts ~:105-118; minor UX). c) The scan's `gitRun` drops the caller's `io` (`signal`, `timeout`) (git-push.ts ~:106; minor). d) "Guarded" is signalled implicitly by a nonempty argv plus `{}` env (clone.ts ~:96, git-push.ts ~:126; hygiene). e) ssh pins only the first checked address (repo/git-remote-guard.ts ~:58; minor). f) Operator scripts `worker/scripts/advance-bundle-items.ts:52`, `reset-bundle-to-commit.ts:83` never initialise ConfigService, so the allowlist reads empty for a non-admin bundle owner (minor). g) `gitClone` still honours the worker's own global `url.*.insteadOf` / `http.<url>.*` (operator-controlled; the image has none). h) Pre-spawn re-check controls cover a fetch only: no control pins the fail-closed catch (a re-read that throws or returns an unsafe URL), an insteadOf change, the push and ls-remote paths, or the scan-before-URL order (git-push.ts ~:131-150; test gap). i) The `generic-resolve` structural control plants a name host, not the public IP literal of the finding, and one key spelling only; the shared key assertion is now case-insensitive for every kind, loosening subsection-case checks (git-remote-guard.test.ts ~:340-420; test gap).

16. DONE 2026-11-13 #1146 (7d4ba4651): shared registry check on every non-admin pull path; an admin allowlist entry naming a foreign registry stays pullable; live-checked in the api container. OWNER DECISION 2026-11-13: non-admins may pull only from the default Ollama registry (a reference naming another host is refused); admins keep any registry. (PR #1119 review) The pull route constrains the model name but not its registry host: a model reference `host:port/name:tag` makes the in-stack Ollama daemon dial an arbitrary host and port for a non-admin whose provider or the allowlist names it, and for an admin always (api `routes/tooling.ts` pull stream, `lib/ollama-pull-policy.ts` `normalizeOllamaModel`). PRE-EXISTING for admins; decide whether a non-default registry needs admin trust.

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

### T582 · FNF[global-kb-delete-ui-followups] · small Global KB delete page gaps (+6)

status: open · kind: fix · found: T579 review 2026-11-09 · priority: P4

1. PRE-EXISTING. An admin's Cancel on another user's enrichment is dead, and so is the cancel after an admin deletes that entry: the task route scopes to the task's owner (`routes/tasks/index.ts:1304-1306`) and answers 404 while `page.tsx` ~:2119 shows Cancel and ~:1120 promises it.
2. Own change, cosmetic. After a refused delete the page shows the 403 but keeps the Delete button until a reload (`page.tsx` ~:1144); a non-admin owner also gets no explanation for a missing Delete on a lapsed or paused row.
3. PRE-EXISTING, minor. Re-scoping an entry and deleting one rewrite `supersedes_entry_id` on entries of other owners, which that actor may not change (`routes/global-kb.ts` ~:1217, ~:1324). Fix direction: decide whether link repair is exempt from the change rule, and say so in `docs/architecture/global-kb.md`.
4. Coverage. The activation target's `FOR UPDATE` row lock is not pinned by a test: the fake DB ignores it. The advisory lock serializes API writers, so no live race is known.
5. PRE-EXISTING, minor. PATCH and DELETE call `enqueueSync` after the store (and, for an admin lapse, the audit row) committed; a Redis failure there answers 500 for a change that applied (`routes/global-kb.ts` PATCH ~:1357, DELETE ~:1408). Fix direction: log and let the worker reconciler repair, as the comment already says for upserts.
6. From #1148 review, PRE-EXISTING, low: the task-end reconciler's delete of a kb_author entry (`_global-kb-promote.ts` ~:770) removes only the row, while the API delete route also removes its `ai_rag_embeddings` and re-links `supersedes_entry_id` in one transaction (`routes/global-kb.ts` ~:1405-1426). Reach: an entry that held vectors and was demoted by a step retry's detect, effectively legacy only. An orphan chunk stays retrievable. Fix: delete the vectors in the reconciler's transaction as the route does.
7. Coverage. `smoke:house-rules-enforcement` races PATCH, DELETE and activation but asserts nothing about `audit_events` (one `global_kb.house_rule.lapse` row per lapse). From the T492 review.

### T583 · FNF[global-kb-draft-owner-blind-link] · a non-admin's draft that replaces another owner's entry needs an admin to activate

status: parked · kind: design · found: T581 review 2026-11-09 · priority: P3 · user decision 2026-11-09: leave as is; revisit when a non-admin hits it
PRE-EXISTING link, new consequence of #1044. Auto-link picks the entry a draft replaces without looking at its owner or approval (`steps/_global-kb-promote.ts`, `steps/kb-author/01-enrich.ts:673`), so a non-admin's draft can be linked over an entry they may not change. Since #1044 Activate refuses it with "Activating this entry would archive an entry you may not change; an admin is required", and only an admin can finish it. Needs a decision: leave it, let the author drop the link and publish beside the original, or skip auto-link on entries the author may not change.

### T577 · FNF[global-kb-config-untrimmed-write] · an admin's Ollama URL and embed model are stored untrimmed

status: open · kind: fix · found: T558 run 2026-11-09 · priority: P4
PRE-EXISTING, minor. `configSchema` (api routes/global-kb.ts ~:292-293) accepts `ollamaUrl`/`embedModel` with surrounding whitespace and `putConfig` writes them as sent; the non-admin compare trims, so only the stored value and its dials see the whitespace. Fix: trim in the schema.

### T559 · FNF[gated-test-hygiene] · gated test addresses and the gated-list check in driver gates (+1)

status: parked · reason: diminishing returns (owner triage 2026-11-10); resume on a user report, a measured failure, or a change in the same code · kind: fix · found: T347 run · priority: P3

1. api test/task-integration-admission-db.test.ts is hard-wired to 127.0.0.1:45553 (or CI with localhost:5432), so a generic scratch beside the dev stack cannot run it. PRE-EXISTING.
2. `scripts/test/ci-gated-list.test.mjs` is the only definition of "gated"; add `pnpm test:scripts` to the review and feature gates whenever a test file or ci.yml changes (it caught a `pathname !==` guard the list did not recognise). Process.
3. The backwards-clock throttle control in shared test/probe-egress-log.test.ts passes on unchanged source (a guard, not a red-able test). NEW-LIMIT (hygiene).
4. AGENTS.md is 32767 of 32768 bytes and its topic index lacks api-auth.md; needs an equal cut to add it. PRE-EXISTING (docs, session).
5. worker test/upgrade-cli-addition-db.test.ts fails 7/28 against a scratch database; not in the CI gated list, so CI never runs it. PRE-EXISTING.

### T560 · FNF[postgresjs-closed-rejections] · patched postgres.js leaves unattributed CONNECTION_CLOSED rejections (third-party, needs approval)

status: parked · reason: owner left as is (owner triage 2026-11-10): third-party log noise only; resume on a user-facing effect · kind: third-party · needs approval · found: T347 run · priority: P3

1. The patched postgres.js 3.4.9 emitted unattributed unhandled `CONNECTION_CLOSED` rejections. #1159 (2026-11-14) moved to unpatched v4.1.1 and removed the patch; re-measure on v4 before resuming (the api/worker error-level handlers still log any). PRE-EXISTING.
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
Owner decision 2026-11-12: keep parked until a task type needs a tool it can run without.
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

status: done 2026-11-12 #1116 (09338a763): recompute and vector classification run after ready in a background loop (60 s deadline per attempt, 1-60 s backoff, abort on shutdown); alias UPDATE guarded on key, category and facets. Follow-ups in T630 · kind: design · found: T544 run 2026-11-08 · priority: P3
Owner decision 2026-11-12: run the recompute off the boot path with its own deadline; boot completes, the recompute retries in the background with a logged warning.
PRE-EXISTING. shared global-kb/client.ts `withGlobalKb` (~:121) via `recomputeAliasedTopicKeys` (worker data-migrations.ts ~:134, ~:599, ungated, every boot): a store that accepts and then stalls, or a held schema advisory lock, has no deadline. A plain `deadlineMs` skips the shared schema ensure (global-kb.md, "A call with a deadline never starts the shared schema ensure"), so it needs its own design. (T546 run) Same class: `dropHeadingOnlyGlobalKbChunks` (worker data-migrations.ts ~:1079, destructive, updater-only, documented best-effort) swallows a typed outage internally.

### T630 · FNF[global-kb-unbounded-calls] · global KB store calls outside boot still have no deadline (+2)

status: open · kind: fix · found: T571 review 2026-11-12 · priority: P3
PRE-EXISTING, more reachable since #1116 made the bounded path the norm at boot. (1) `withGlobalKb` without `deadlineMs` in steps and the sweep: `_global-kb-promote.ts`, `kb-author/01-enrich.ts`, `09_6_4`/`09_6_5`, `global-kb-sync-queue.ts`; a store that accepts and stalls holds the step or sweep. Fix: pass a deadline and signal as the boot repairs do. (2) shared global-kb/connection.ts `resolveInternal` (~:148-152): the main-db `SELECT 1 FROM pg_database` / `CREATE DATABASE` has no client-side bound, so each timed-out background attempt can leave one query on the worker pool while main Postgres stalls (Greptile P2 on #1116, comment 4556974731). Fix: client-side bound; `SET LOCAL statement_timeout` cannot cover `CREATE DATABASE`. (3) worker data-migrations.ts `dropHeadingOnlyGlobalKbChunks` (~:1253) swallows a typed outage internally; and the recompute is not gated on `resolveGlobalKbEnabled` (the classify migration is).

### T631 · fix · git-template test helper cleanup times out on a loaded runner

status: open · kind: fix · found: #1117 CI 2026-11-12 · priority: P4
worker `test/support/git-template.ts` ~:10 registers a module-scope `afterAll` that `rm`s every template and copy root with `maxRetries: 5`; on run 43322735643 (worker 1/2) it hit the 10 s hook timeout in `git-template.test.ts` while all 8537 tests passed, failing the shard (re-run passed). Fix direction: give the hook its own timeout or remove the roots per file without retries, and measure how long the removal takes on CI.

### T632 · FNF[stop-settle-redrive-lows] · Stop and Cancel re-drive lows (+2)

status: open · kind: fix · found: #1117 reviews 2026-11-12 · priority: P4

1. The throttle compares `task_events.created_at` (timestamp without zone, DB `now()` in the session zone) with a JS UTC cutoff (`stalled-redrive.ts` `redriveStoppedTasks` ~:606 and `redriveCancelledTasks` ~:697, ~:817): in a session zone behind UTC an unfinished Stop or Cancel is re-queued every 60 s sweep instead of every 5 min; ahead of UTC the throttle lengthens by the offset. PRE-EXISTING pattern (Cancel), repeated by #1117. Fix: compare through UTC on both sides or stamp from JS.
2. The Stop re-drive has no count cap (Cancel has `CANCEL_REDRIVE_MAX`): a task whose finish insert keeps failing is re-settled every 5 min with one `task.stop_settle_redriven` row per cycle until a Retry or Cancel. Low.

### T633 · FNF[bundle-orphan-sweep-lows] · bundle orphan sweep lows (+7)

status: open · kind: fix · found: #1118 reviews 2026-11-13 · priority: P4
All in worker `repo/bundle-orphan-sweep.ts` unless named. Low.

1. `.move.json` intent files are never collected by the sweep.
2. The sweep runs inline in the stalled-task sweep, so a slow pass delays the stalled sweep.
3. A directory listing over 1000 entries is never collected (the pass stops at the cap).
4. `reconcileStrandedSyncingBundles` reads `getJobs` unbounded and drops vanished hashes.
5. `refuseLiveBundleJob` is a third copy of the live bundle state list.
6. No control for a stage owned by a different bundle id in the same directory.
7. Stage removal is age-based only; the bundle's status is not rechecked just before the removal.

### T634 · design · Ollama model check on provider save and boot provisioning

status: done 2026-11-13 #1130 (b78611d5a): one shared policy in `@haive/shared` checked at provider create, PATCH, duplicate and boot provisioning, Modelfile FROM base included, owner role rechecked, resident model matched by resolved name; also fixed the Modelfile PARAMETER parser's polynomial regex (CodeQL); lows in T635 · kind: design · found: #1119 review 2026-11-13 · priority: P3
#1119 checks only `POST /tooling/pull-ollama-model`. An in-stack Ollama provider's create, PATCH and duplicate, and the boot re-pull (`ensure`), still provision their model, and a custom Modelfile's `FROM` base, without the pull check, so a non-admin can still make the shared daemon pull an arbitrary model through a provider save. `provisionOllamaProvider` also does not recheck the owner's role. Documented as a known limit in `docs/architecture/api-auth.md` ("Who may make Ollama pull a model"). OWNER DECISION 2026-11-13: same check everywhere. Provider create, PATCH and duplicate refuse a disallowed model (and Modelfile `FROM` base) with a clear message; the boot re-pull skips it with a warning; `provisionOllamaProvider` re-checks the owner's role.

### T635 · FNF[ollama-pull-policy-lows] · Ollama pull policy lows (+4)

status: open · kind: fix · found: #1119 reviews 2026-11-13 · priority: P4

1. An allowlist entry that fails validation when read back (a stored value edited outside the PUT) makes the whole list fail closed with no log or admin-visible reason (api `lib/ollama-pull-policy.ts`). Low.
2. `api/test/probe-targets.test.ts` ~:192 waits on real timers; convert to fake timers (testing.md rule). Low.
3. From #1146 review: the allowlist cannot hold an IPv6-literal registry (the host regex refuses `[`); allowing one is an admin design choice. Note: a Global KB embed model from a foreign registry now needs an allowlist entry for non-admin pulls. Minor.
4. From #1130: a worker policy skip at boot leaves the provider `idle` with no error text, and the provider form hides the idle state, so the owner sees no reason their model never provisioned (worker `sandbox/ollama-provision.ts`, web provider form). Show the skip reason. Low.

### T636 · FNF[login-lease-reaper-lows] · CLI login lease and reaper lows (+8)

status: open · kind: fix · found: #1120 reviews 2026-11-13 · priority: P4
Worker `sandbox/login-container-reaper.ts` and shared `cli-login-lease.ts` unless named. Low.

1. The reaper removes the Docker container, then marks the `containers` row destroyed; if that update throws it logs "will retry" but the container is gone, so the row stays `running` (~:69-79).
2. The reaper lists every container on the host and runs a DB `IN (...)` query every 30 s forever, though the unlabelled legacy containers it serves vanish 13 min after the upgrade.
3. An unremovable container logs a warning every 30 s with no backoff.
4. A legacy container with no labels whose `containers` row is gone (provider deleted) or was never inserted is never reaped. PRE-EXISTING.
5. `onLost` fires on the first heartbeat after the local deadline, up to 20 s after credential writes are already refused; the abort and socket close lag by that much.
6. The lease relies on its caller's Redis command timeout (its only caller, the api's bounded client, has 2 s); an unbounded client would let a stalled renewal hang `stop()` and login teardown. Latent.
7. Each timed-out reaper pass leaves one MGET in the worker client's unbounded offline queue while Redis stalls (worker-wide pattern).
8. Coverage: the reaper's Redis-outage test models a rejection, not the worker client's hang; the fresh-login test never drives the api or auth lock; the lease's catch-past-deadline branch is untested; `login-container.ts` imports `@haive/shared` twice (nit).

### T637 · FNF[undo-resync-lows] · Undo re-sync Retry lows (+7)

status: open · kind: fix · found: #1121 reviews 2026-11-13 · priority: P4
Worker `step-engine/undo-left-merge.ts`, web `task-left-merge-banner.tsx` unless named.

1. MEDIUM, PRE-EXISTING: a settled retry finds the checkout to hand back from the report's directory only (~:556-566), while the first run may have moved the repository root (`holders[0]`, ~:592); when they differ, a retry skips the hand-back and still records completion, leaving root-owned files. Fix: derive the settled checkout from the repository's worktree holders.
2. During every normal Undo, between the settle and the completion, the banner shows "not re-synced" with a live Retry for a few seconds (owed-and-running vs owed-and-exhausted are not told apart).
3. An exhausted Retry leaves no visible reason (`recordUndoFailure` returns false for a settled report); the thrown text reaches only worker logs.
4. A settled, owed report whose directory is unreadable, not contained, pushed or a host checkout throws the generic "cannot settle an already settled report" on every attempt (~:477). PRE-EXISTING.
5. A `rev-parse HEAD` failure on a settled checkout still on its branch blocks the re-sync on every Retry until the repository is repaired. PRE-EXISTING.
6. Event reads order by `createdAt` only, with no tie-break (~:94, api `merges.ts`); the reader is order-sensitive but fails safe (spurious owed).
7. Coverage: the worker test stubs `inMergeDirLock` as a pass-through (no concurrent completion control); no worker case for a settled `moved`/`refused`; no first-run test of the strict hand-back.

### T638 · FNF[runner-ownership-lows] · runtime runner ownership lows (+5)

status: open · kind: fix · found: #1124 reviews 2026-11-13 · priority: P4
Worker `sandbox/runtime-runner-ownership.ts`, `queues/task-queue.ts` unless named. Low.

1. An unlabeled pre-label runner whose task id exists in two installs' databases (one restored from the other's dump) is owned by both (~:42-54). Finite: pre-upgrade runners only.
2. An unlabeled pre-label runner whose task is gone is kept forever and needs manual cleanup; nothing lists them for an admin.
3. The cancel sweep (`killSandboxContainersByTaskLabel`) uses `docker ps` without `-a`, so exited task containers are never removed there. PRE-EXISTING.
4. Admission counts every runner on the daemon while the reaper can now reclaim only its own, so on a shared daemon a waiter can park behind the other install's runners (documented in runtime-capacity.md).
5. Coverage: no control for an exited runner, nor for the real `docker ps` rendering of a missing label (mocked as ''). The real two-install S4 check is pending (docs/plans/solitary-partitioning-lampson.md).

### T639 · sandbox `.git` boundary reads every other failed lookup as no `.git`

status: done 2026-11-13 #1126 (6f1e2223e): the shared boundary lookup uses fs-safe strict mode; only ENOENT/ENOTDIR read as absent, every other failure (EACCES, EIO, a link in the path) refuses the run before a container starts; an IDE boot refuses a worktree subpath with a link or non-directory parent; lows in T641 · kind: fix · found: #1125 review 2026-11-13 · priority: P2
PRE-EXISTING, security. worker `queues/cli-exec/gitfile-mask.ts` ~:58 `lookupInRepoMount` and ~:96-97 `repoGitDataBoundary`: since #1125 only EMFILE/ENFILE rethrow; EACCES, EIO, ENOMEM, ESTALE and a link in the repository path still answer `null`, so the sandbox starts with `.git` unmounted and read-write. Same lookup feeds `.haive-data` and worktrees boundaries. Fix direction: `strict: true` plus a deliberate absence check (ENOENT/ENOTDIR only means no `.git`), every other failure refuses the run; the five consumers already fail closed on a throw (traced in #1125 review 2). Controls per errno.

### T657 · FNF[reset-claim-sweep-lows] · onboarding reset claim sweep lows, after #1151 (+4)

status: parked: diminishing returns (2026-11-14, owner rule: trivial lows park; resume on a user report, a measured failure or a related change) · kind: fix · found: #1151 review 2026-11-13 · priority: P4
api `routes/repos.ts` `resetOnboardingArtifacts`. All minor.

1. Own change: a canonical git-data claim over `maxFileBytes` survives with no log and no `skipped` entry (~:2606 `if (read.truncated) return;`). Safe to keep, but silent. Fix: push a `skipped` entry when the file cap, not the byte budget, truncated it.
2. Own change: the "byte limit reached" warning is pushed when the last scanned file reaches `maxTotalBytes` with nothing left (~:2634-2639). Over-reports, harmless. Fix: report only when another candidate remains.
3. Coverage: no case for a FIFO or other special file at a canonical claim name (code is safe: `entry.isFile()` plus `lstat` before open).
4. PRE-EXISTING: the other reset listings are uncapped, `readdirNoFollow(root, dir, { strict: true })` at ~:2353, ~:2419, ~:2493 on `.claude` and CLI dirs; a planted tree makes the reset allocate an unbounded listing. Fix: the same entry cap the claim sweep uses.

### T640 · FNF[fs-safe-absence-lows] · reads that still take a failure for absence, after #1125 (+10)

status: parked (items 1-2 resolved 2026-11-15 in #1196; the rest parked: diminishing returns (2026-11-14, owner rule: trivial lows park; resume on a user report, a measured failure or a related change)) · kind: fix · found: #1125 reviews 2026-11-13 · priority: P3
PRE-EXISTING unless marked. Worker unless named.

1. Consequential: `queues/cli-exec/ddev-generated-mask.ts` ~:120 skips the `#ddev-generated` protections when a read fails.
2. Potentially consequential: `step-engine/steps/_citation-scrub.ts` ~:280 `repoHoldsCitation` keeps repository-specific blocks when a read fails; downstream consequence untraced.
3. `step-engine/git-merge.ts` relocation: the final `chmodNoFollow` (~:1144) and `giveBack` (~:850) swallow EMFILE, so a replaced 0600 file can stay at git's 0644 or a restored file root-owned, unreported; and a path deferred as occupied (directory stands, or unread since #1125) loses its saved mode, so a later relocation restores it 0644 (Codex P1 on #1125: mode drift only, the baseline blob is already 0444 in `.git/objects`). Fix direction: bounded retry on resource errors, else report "mode not restored"; carry saved modes in the manifest.
4. `sandbox/task-worktree.ts` ~:77: a descriptor shortage can report a worktree as removed. Minor.
5. api `routes/tasks/files.ts` ~:258: other host faults (EIO, ESTALE) still answer 400 "cannot be opened for editing". Minor.
6. `queues/cli-exec/agent-definition-mask.ts` ~:127 fails open by design (C2); revisit only with item 1.
7. `readTextNoFollow` / `readLinkNoFollow` lenient callers were not in the #1125 audit (it covered lstat, readdir, readFile, openFile).
8. (from T510 item 2) api bundle file listing bounds files, depth and descriptors but not directory count.
9. (from T510 item 5) shared `readdirNoFollow` `maxEntries` overflow is a plain `Error` known by wording; give it a code when a caller appears. Coverage: `branch-revert-unknown-reads.test.ts` template copy has no isolation guard.
10. (#1196 review) `global-kb/01-enrich.ts` ~:517, :520 `.catch(() => new Set())` on `collectRepoBasenames`/`collectRepoSymbols` (`08-knowledge-acquisition.ts` ~:1203-1228, which also swallow every failure): the symbol and basename citation backstops silently turn off on EMFILE/EIO, so the shared-draft guarantee #1196 gave the path detector is partial. Fix direction: propagate resource errors like `repoHoldsCitation` now does.

### T641 · FNF[stored-failure-paths] · raw storage paths persist in stored failure text (+5)

status: parked (items 1-2 resolved 2026-11-15 in #1196; the rest parked: diminishing returns (2026-11-15, owner rule: trivial lows park)) · kind: fix · found: #1126 driver and review 2026-11-13 · priority: P3
PRE-EXISTING. Worker unless named.

1. Consequential: `queues/cli-exec/handlers.ts` ~:468 stores `safeErrorMessage(err)` in `cli_invocations.error_message` and the mining row; a filesystem failure (now thrown by the sandbox boundaries on EACCES/EIO/EMFILE) carries the worker storage path `/var/lib/haive/repos/<userId>/<repoId>`, shown in the task UI. Route filesystem failures through `scrubErrorPaths` there (error-diagnostics.md rule).
2. Consequential: `step-engine/step-runner.ts` ~:3813 stores the same raw text in `task_steps.error_message` for step-command and `01b-install-plugins` failures.
3. Minor: `queues/safe-processor.ts` ~:12 keeps raw filesystem errors in the IDE ensure queue transport (the browser answer is already generic).
4. Coverage: `step-command`, `01b-install-plugins` and the IDE ensure path have no errno-refusal control at the boundary lookup; the ENOTDIR absent controls inject at the leaf lstat, which real fs-safe never reaches.
5. (#1196 review) `step-engine/step-runner.ts` ~:3944-3986: a `fixLoopOnError` step's `done` row keeps the raw `safeErrorMessage` as its diagnosis (the scrub runs only on the failed write, by design so the fix-loop predicate reads the original), so a storage path can still show on a `done` row. Fix direction: scrub at the `done` write after the predicate ran.
6. (#1196 review) shared `logger/errors.ts` ~:88-93: the root filter keeps a whole quoted token whose first path is outside a root (`'/usr/bin/git -C /var/lib/haive/repos/u/r status'` passes unchanged). Latent: no caller found that builds such a message. Fix direction: filter path tokens inside the quoted body.

### T642 · DDEV recovery cold-boots a live runner when its health exec fails

status: done 2026-11-13 #1128 (10a97c011): recovery rebuilds a runner only on a definite answer (absent or stopped, another workspace, a working exec that finds no dockerd); a probe without an answer raises the retryable RunnerProbeError; a failed warm start keeps the runner and reports the DDEV output; lows in T643 items 6-8, rebuild action in T644 · kind: fix · found: #1127 driver and reviews 2026-11-13 · priority: P2
PRE-EXISTING, consequential (data loss). Worker `sandbox/ddev-runner.ts`: `ensureDdevStartedInner` reads `ddev describe -j` (~:2210-2233); `runnerDockerdUp` (~:2090-2100) swallows any exec failure to `false`; `decideDdevRecovery` (~:2078-2086) then picks a cold boot, and `startDdevRunner` runs `docker rm -f -v` on the live runner (~:481), dropping its anonymous nested `/var/lib/docker` (images, project containers, database volumes). A daemon timeout during that exec is enough. Fix direction: the same present/absent/unknown split #1127 gave runner existence: an exec that gave no answer (`gitGaveNoAnswer`-style: timeout, no exit status) is unknown and holds the step for retry; only a definite "dockerd not up" answer may cold-boot. Controls: an exec timeout at each probe keeps the runner.

### T643 · FNF[runner-probe-lows] · runner presence leftovers after #1127 (+9)

status: parked: diminishing returns (2026-11-14, owner rule: trivial lows park; resume on a user report, a measured failure or a related change) · kind: fix · found: #1127 reviews 2026-11-13 · priority: P4
PRE-EXISTING unless marked. Worker `sandbox/`.

1. `ide-runner.ts` ~:623 `stopIdeRunner` swallows `docker stop`/`rm` failures and returns `true`, so a surviving editor is reported stopped (reaper deletes its session key; repository cleanup goes on to `volumeRemove`, which fails on an in-use volume).
2. `queues/task-queue.ts` ~:4541 repository cleanup refunds the attempt on every `RunnerProbeError`, so `REPO_CLEANUP_MAX_ATTEMPTS` is never reached while a probe stays unknown (about every 10 min, forever). Same semantics as `RagCleanupDeferredError`. Cap consecutive refunds. (#1127, new instance of the pattern)
3. `ide-runner.ts` ~:424 warm editor reuse never retries a debug setup that failed earlier. Minor.
4. IDE user-data volumes (`ideUserDataVolumeName`, ide-runner.ts ~:669,687) have no orphan sweeper; any path that skips `killRepoIdeRunner` leaks one. Minor.
5. `runner-probe.ts` ~:24 `RunnerProbeError.retryable` is read nowhere; retry is the user's step Retry or the next ensure. Keep it or drop it.
6. `runner-probe.ts` ~:52 maps Docker `paused` to running; a runner paused outside the app (Haive never runs `docker pause`) then fails every exec, and DDEV recovery holds with "Retry when Docker is available", which retrying never clears. Name the pause in the error (Codex bot on #1128). Minor.
7. Coverage: no test runs a failed DDEV warm start (`ddev start failed (runner ... kept;`) through the fix-loop failure classifier to show it still routes as an environment failure. (#1128 review)
8. `ddev-runner.ts` `ddevFailureMessage` keeps only the last 8000 characters of DDEV output; an early root-cause line can be cut. Minor.
9. From #1132 review. The failed-task reaper and a Rebuild DDEV can both remove the same runner: their fences differ (`sandbox/runner-activity.ts` ~:41, `runtime-runner-reaper.ts` ~:370 and ~:460), so one `docker rm` fails and that caller reports a failure for a runner that is gone. Take the task's `ddevBoots` exclusive entry in the reaper, or treat "no such container" after a definite presence answer as removed.

### T644 · no in-app way to rebuild a DDEV runner

status: done 2026-11-13 #1132 (8bdb0f01a): confirmed Rebuild DDEV action (API, exclusive worker job, dialog); owed: a live rebuild of a real DDEV task in the browser (none on the dev install), see T647 item 3 · kind: decision · found: #1128 review 2026-11-13 · priority: P4
Since #1128 a failed warm start keeps the runner; its error names the container and says that removing it rebuilds from the last database snapshot and loses every change since. The only rebuild paths are removing the container by hand or the failed-task reaper (180 min). OWNER DECISION 2026-11-13: add the in-app "Rebuild DDEV" action, confirming the loss.

### T651 · FNF[two-install-isolation-lows] · cross-install sweep leftovers after #1140 (+4)

status: parked: diminishing returns (2026-11-14, owner rule: trivial lows park; resume on a user report, a measured failure or a related change) · kind: fix · found: #1140 review 2026-11-13 · priority: P4

1. Low, PRE-EXISTING. `agent-preemption.ts` ~:255 and `runtime-runner-reaper.ts` ~:238 remove a container they matched by invocation or task id alone, with no `haive.install` filter. Another install matches only on a uuid collision or a database cloned between installs. Add the install label filter.
2. Low, theoretical. `auth-volume-reaper.ts` ~:79 has the same id-only match on auth volumes.
3. Low, transitional. Shells created before #1140 carry no label, and the default install's sweep still claims them from every install until they are gone. It ends once old shells age out; no action unless it is seen.
4. By design, recorded. Legacy unlabelled sandbox cores are kept by every install, because their owner cannot be proven: about one ~1.56 GB core per install until removed by hand.

### T647 · FNF[runtime-wait-outcome] · runtime waits read a finished or missing job as pending or failed (+3)

status: open · kind: fix · found: #1132 reviews 2026-11-13 · priority: P4

1. PRE-EXISTING, low. `waitUntilFinished` with `removeOnComplete`/`removeOnFail: true` rejects for a job that already finished and was removed before the wait attached, and the access-urls, ensure-ide and runtime-ensure handlers (api `routes/tasks/browser-access.ts` ~:69, ~:99, ~:131, ~:219; `lib/ide-target.ts` ~:57) answer that as pending or unavailable. Return the outcome through a structural channel (a short-lived result key, or keep the job briefly) rather than reading a rejection.
2. Low. A job result from an older worker lacks `removed`; the rebuild dialog reads undefined as "already absent". Only a mixed-version deploy hits it.
3. OWED LIVE CHECK. Rebuild an owned DDEV task's runner from the task page: the runner is recreated and the newest snapshot restored; a click while a step runs gets 409 with the busy reason. No DDEV task with a runner existed on the dev install at merge.

### T648 · upgrades never refresh the compose bundle (design)

status: open (PR6 done 2026-11-14 #1189 (80893c133): both installers verify every fetched compose file against `release.json` `bundle.files` before any destination write, write `.haive-bundle.json` through a stage-and-rename that never follows a link, and forward `--replace-modified-bundle`; next the two-install upgrade check from the plan's Verification section, then close. PR5 done 2026-11-14 #1185 (d434485cd): the updater swaps the compose bundle with a journalled backup and selective rollback, refuses linked install files early, retains backups that hold operator edits, and recovers a run from the journal; a bundle release may be cut again; next PR6 installers and docs, then the two-install upgrade check. PR4 done 2026-11-14 #1181 (fd2eadc64): the updater reads and verifies the release bundle and prepares required `.env` keys. OWNER DECISION 2026-11-13: the release manifest image carries the compose bundle; the updater swaps it with backup and rollback alongside the images, and generates any `.env` keys the new bundle needs so it never fails open; PR1 done 2026-11-14 #1157 (1cfbef464): the updater keeps the install's GPU/Vulkan compose overlay on every compose call; PR2-6 plan APPROVED by the owner 2026-11-14 as drafted, with a hand-edited or unknown bundle refused as `bundle-modified` unless `--replace-modified-bundle`; PR2 done 2026-11-14 #1172 (9233cfc97): the release manifest describes the bundle (`install/bundle-env.json`, `build-release-manifest.mjs --bundle-dir`); PR3 done 2026-11-14 #1180 (a08f46568): `release.yml` and `publish-channel.mjs` publish `haive-release:<v>` with `/release.json` and `/bundle/`; owed at the first rc tag: the filtered `pnpm --filter @haive/shared install` runs green and the new GHCR package `haive-release` is public and linked (PR4 pulls it anonymously); PR4 must also refuse a non-https manifest URL when a bundle is present (updater `cli.ts` ~:132 accepts http via operator override); PR4 next) · kind: design · found: #1136 review 2026-11-13 · priority: P2
PRE-EXISTING. The installer fetches the compose bundle once, at install time (`install/install.sh` ~:662-665), and `haive upgrade` only rewrites the `.env` image pin (updater `cli.ts` ~:197-200). Any compose-level change reaches fresh installs only. Measured consequence: an install upgraded past #1136 keeps the Ollama daemon on the models network with no gate, so the T645 fix is absent there (documented in `sandbox.md`). Options: ship the compose bundle inside the release manifest image and have the updater swap it (with rollback alongside the images), or have the updater refuse an upgrade whose bundle hash differs and tell the operator to re-run the installer. Decide before the next release that changes compose.
Also from #1139: an existing install whose bundle predates MP_UI_AUTH keeps an open Mailpit UI after any upgrade, and a refreshed bundle installed over an `.env` with no `MAILPIT_UI_PASSWORD` fails open (empty value = no auth). Whatever refreshes the bundle must also generate missing keys it needs.

### T649 · security · dev override publishes daemon, postgres and redis ports a sandbox may reach (+5) [parked: diminishing returns]

status: parked 2026-11-15 (owner): security scope DONE (#1137, #1138, #1139, #1143); items 4-5 are trivial lows parked as diminishing returns, independent of item 3. Resume on a change to dev.sh's .env handling or the overlay list, or a report of a broken README command. History: (PR 1 done 2026-11-13 #1137 (838709ab2): Redis, Ollama and Mailpit SMTP unpublished, Postgres and the Mailpit UI on 127.0.0.1; live: 172.17.0.1 refuses all, host.docker.internal refuses all but 5432/8085, WSL and Windows localhost reach 5432/8085/3000/3001; PR 2 done 2026-11-13 #1138 (3fc65735a): dev.sh generates POSTGRES_PASSWORD and MAILPIT_UI_PASSWORD into .env (600), syncs the role over the socket, Mailpit UI behind MP_UI_AUTH; live: old password refused via host.docker.internal, Mailpit 401 without auth and 200 with it, host helper URL connects, api/worker healthy; item 2 done 2026-11-13 #1139 (e9b7a270e): release installers generate MAILPIT_UI_PASSWORD, `docker-compose.run.yml` passes it as MP_UI_AUTH, the summary warns when an older bundle has no login; item 3 done 2026-11-13 #1143 (c6dc0467d): owner decision (b), known gap documented in sandbox.md, closing it is T652; items 4-5 (lows) remain) · kind: fix · found: #1136 review 2026-11-13 · priority: P2
PRE-EXISTING, dev stack only, unverified. `docker-compose.dev.yml` ~:6-17 publishes ollama, postgres and redis on host ports. A sandbox under the `full` network policy runs on the default bridge with NAT, and may reach those ports via the host gateway or `host.docker.internal`, bypassing the models gate (T645) and the network separation that keeps the queues and DB away from agents. Verify from an owned throwaway container on the default bridge; if reachable, bind the published ports to 127.0.0.1 only on the WSL host side, or drop the ones nothing on the host needs.

VERIFIED 2026-11-13 (Docker Desktop 29.9.2, WSL2): from the default bridge every published port answered on `172.17.0.1` and `host.docker.internal`; Redis has no requirepass; every provider ships network mode `full`. Docker Desktop forwards `host.docker.internal` to loopback-bound ports too, so binding alone cannot close it. OWNER DECISION 2026-11-13: unpublish what the host does not use (done), credentials for the rest.

1. DONE #1138. Per-install Postgres password generated by `scripts/dev.sh` into `.env` instead of the `haive_dev_password` default (compose, `drizzle.config.ts`, `tests/e2e/helpers/db.ts`, `scripts/visual.sh` read it), and basic auth on the Mailpit UI (`--ui-auth-file`). Existing dev databases keep the old password: the change must `ALTER ROLE` once, idempotently, and tell the owner the new password for their DB clients.
2. DONE #1139. PRE-EXISTING, release installs. `docker-compose.run.yml` ~:133 publishes the Mailpit UI on all interfaces with no auth (also api and web, which are needed and authenticate). Bind it to loopback or put it behind auth with item 1's mechanism.
3. PRE-EXISTING, inferred from the measured rule, not probed. Per-task ports the worker publishes on 127.0.0.1 (DDEV http/https/mailpit/db, `ddev-runner.ts` ~:398-436; app-runner ~:157) are reachable from a `full`-policy sandbox through `host.docker.internal` on Docker Desktop, including another task's DDEV database. Probe with an owned runner, then decide (per-task DB credentials already exist? check). VERIFIED 2026-11-13: an owned container publishing `127.0.0.1::8080` (ephemeral, the app-runner form) and `127.0.0.1:47123:8080` answered 200 from another container via `host.docker.internal`; `172.17.0.1` refused. Scope: only tasks that opt in. The DDEV DB hop starts only on `tasks.exposeDbPort` (`maybeExposeDdevDbPort`, `_app-runtime.ts` ~:420) and serves DDEV's fixed `db`/`db`/`db` (`ddevDbAccess`, `ddev-runner.ts`); router, app and Mailpit ports need the per-task external access mode plus `BROWSER_DIRECT_ACCESS`. Any `full`-policy sandbox (another task's included) can then reach that task's DB with the known login. OWNER DECISION 2026-11-13: (b), accepted for local single-user use and documented as a known security gap in `sandbox.md` (#1143); closing it is T652. Options were: (a) per-exposure random DB role created through `ddev mysql`/`ddev psql` and shown in the DB panel instead of `db`/`db`; (b) accept and document as the cost of the opt-in; (c) also gate the router/app ports (no auth layer exists there today).
4. Low. `rootless-docker.test.ts` hardcodes the overlay list instead of reading `scripts/dev.sh`'s `FILES`; README's `docker exec haive-*` examples assume the default `HAIVE_INSTALL_ID`.
5. Low, from the #1138 reviews. dev.sh `env_value` and compose still differ on a multi-line double-quoted value and on text after a closing quote (neither holds `\` or `$`, so the refusal does not catch them); a reconcile failure in `libs`/`migrate` prints compose's error with no re-run hint; README calls the reconciled set "app services" without naming Mailpit.

### T652 · design · close per-task port reach before web or multi-user use [parked: owner decision]

status: parked until Haive is first made reachable over the web or shared by several users; then it is a blocker · kind: design · found: T649 item 3 2026-11-13 · priority: P2
On Docker Desktop, sandboxes on the default bridge (`full` policy, every provider's default) reach every 127.0.0.1-published port through `host.docker.internal` (MEASURED 2026-11-13). Per-task DDEV ports are therefore reachable from other tasks' agents once a task opts in: the database hop (`exposeDbPort`, fixed `db`/`db` login, `ddevDbAccess`) and the router, app and Mailpit ports (external access mode plus `BROWSER_DIRECT_ACCESS`, no auth). Documented in `docs/architecture/sandbox.md` (#1143). Today's mitigation: turn off `config:sandbox:dbDirectAccess` (prevents new exposure only; runners already exposed must be stopped or recreated). Options: per-exposure random DB role that also refuses `db`/`db` through the hop without breaking DDEV's app connection (probe first); an auth layer in front of router and app ports; root fix: egress filtering so sandboxes cannot reach the host gateway (a DNS override alone is a speed bump). The dev stack's loopback Postgres and Mailpit UI (credentials since #1138) are the same class. Also T627: all editors share one editor origin (script in one editor can reach another runtime's `/ide/<target>/` while its 8 h editor cookie lives; per-runtime hostnames need wildcard DNS and TLS), and an open editor WebSocket outlives its session expiry.

### T650 · FNF[ollama-gate-followups] · gate and release-doc leftovers (+3)

status: parked: diminishing returns (2026-11-14, owner rule: trivial lows park; resume on a user report, a measured failure or a related change) · kind: fix · found: #1136 reviews 2026-11-13 · priority: P4

1. Low. `docker/ollama-gate/server.mjs` logs nothing, not even a refused admin call, and has no SIGTERM handler, so `docker stop` waits out the grace period. The sibling proxies (`ollama-thinking-proxy`, `openrouter-compat-proxy`) are the same. Log refusals (method and path only, never bodies) and close on SIGTERM in all three.
2. Low, PRE-EXISTING. `docs/architecture/release.md` ~:9 and the `docker-compose.run.yml` header are stale about which images a release builds and publishes (now api, worker, web, updater, builder and three proxies).
3. Low. `packages/worker/test/rootless-docker.test.ts` pins the compose `UPSTREAM_HOST` but not the `server.mjs` default (`ollama-daemon`); a bare `docker run` of the image with a changed default would dial the wrong name. Assert the two agree.

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

### T342 · FNF[mcp-token-file] · rag/ddev task tokens in the server env defeat the cli-merge skip (measure first) (+4)

status: parked · kind: design · was modular #146 · reason: diminishing returns (2026-11-01 scan): Bundle concerns merge efficiency, stale wiring, helper cleanup, and orphan-directory hygiene; resume when resume when measured overhead or stale wiring disrupts invocations · priority: P4

1. The rag and ddev tokens carry a per-second exp inside their MCP server env (worker orchestrator/mcp-surface.ts:108, :186), so the codex/grok/gemini merge key (task-auth-volume.ts:889-905) changes on every invocation. Measure first, then move the tokens to the token file.
2. The step-summary pass skips MCP wiring, so the auth volume keeps listing per-run servers until the next wiring.
3. The cli-merge helper's marker write does not reach its exit status.
4. The rag and ddev routes parse the bearer header by hand; use the shared parse in lib/task-call-auth.ts.
5. Per-run `<uuid>` dirs in the wrappers volume are removed only by runInSandbox's finally. Add a boot or periodic sweep.

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

### T369 · FNF[usage-fallback-verify] · ollama/antigravity live usage fallbacks unverified; zai/muse killed runs store zero usage (+10)

status: open (member 3 DONE #1150; the rest measurement-gated) (VERIFIED 2026-11-13, MSC probe, opt-in `MSC_PROBES=1` `worker/test/msc-usage-probes.test.ts` on branch `verify/misc-probes`: member 3 CONFIRMED, a zai or muse run killed before `result` after zero-valued assistant events stores `{0,0,0}` instead of unknown (`cli-exec/stream.ts` ~:519, persisted at `handlers.ts` ~:422), understating statistics; fix: an all-zero assistant fallback means null, authoritative result usage kept. Member 5 NEEDS LIVE EVIDENCE: the parser replaces both values (`stream.ts` ~:237) and a constructed cumulative two-result stream passes; a captured steered claude run with two results must show whether the second result's usage is per-turn or cumulative before summing. Others stay measurement-gated) · executable: 3 · was modular #237 · priority: P2

1. ollama puts message_start values on assistant events, so a killed run under-reports output.
2. Whether antigravity's running usage is per-step or cumulative is unmeasured.
3. DONE #1150 (7c13cd38a): an all-zero assistant fallback records null usage, authoritative result usage kept.
4. amp's multi-turn semantics are unmeasured.
5. DONE 2026-11-14 #1160 (a32e86efe): measured on claude-code 2.1.323 (steer mid-turn and after the first result), each result's usage is per turn while cost, duration_api_ms and modelUsage are cumulative; the collector sums result usage. Stored history not backfilled (5 of 6,444 stream logs had more than one result).
6. gemini and antigravity could prove a single request, but nothing reads it (usage-extract.ts ~:120). sumTokenUsage treats a missing peak as 0.
7. amp's `usage.max_tokens` (272k) may be its context window. Measure.
8. ollama's per-message prompt and result prompt disagree (display only).

9. (#1160 review, PRE-EXISTING, minor) Result usage always wins over the assistant fallback, so a live snapshot between two results, or a steered run killed during its second turn, shows the first turn's tokens beside the cumulative cost (worker queues/cli-exec/stream.ts `getTokenUsage`). Fix direction: add the assistant usage of messages after the last result.
10. (#1160 review, low) Collector tests lack a cache-bucket case, a result without usage, a live snapshot between results and a replay of the measured capture.
11. (#1160 review, nit) `maintenance/context-backfill.ts` ~:97 comment calls the result "cumulative" (it means within one turn).
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

### T389 · FNF[repo-loose-objects] · Haive's git no longer triggers auto-maintenance (#256), so busy repos accumulate loose objects

status: parked · kind: design · was modular #270 · reason: diminishing returns (2026-11-01 scan): Loose-object growth is unmeasured; no current operational impact established; resume when resume when measured repository growth warrants safe maintenance · priority: P4
`maintenance.auto=false` closes gc.recentObjectsHook. An explicit gc still runs that hook.
Measure growth, then find a safe repack/prune under hardened args.

### T392 · FNF[start-check-provider] · the persona start check names only the first dispatch candidate (+2)

status: open · kind: fix · found: T392 driver 2026-11-06 · priority: P4

1. `providerNameFor` in the persona start check (packages/worker/src/queues/task-queue.ts ~:2737) takes the first `dispatchCandidates(...)` entry. It ignores subagent and MCP eligibility, and since PR #1025 also a first implicit candidate that fails to build while dispatch lands on the next one. Advisory only (records an unresolved-persona event). PRE-EXISTING. Fix direction: resolve the provider through `resolveDispatch` or share its candidate filter.
2. `resolveTaskDispatch` calls `resolveDispatch` a second time with the codex extras (packages/worker/src/orchestrator/dispatcher.ts ~:436), so the new "provider could not build a command" warning logs twice per dispatch for the same implicit candidate. REGRESSION (log volume only). Fix direction: warn only on the outer call, or dedupe by provider id.
3. The pick it names ignores the composed-LSP lock: on a locked task it names a saved CLI that dispatch skips since #1297 (`worker/src/queues/task-queue.ts` ~:3256-3269). Advisory and documented; resolving through the dispatcher (item 1's direction) fixes both. PRE-EXISTING.

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

### T436 · FNF[attachment-count-lifecycle] [design] · persisted attachment counts have no live reader or restart reconciliation

status: parked · kind: design · scope: queued broader finding, not approved implementation · reason: diminishing returns (2026-11-01 scan): Attachment counts have no operational consumer; affected worker helpers are dormant; resume when resume when a live consumer needs reliable attachment counts · priority: P4

PRE-EXISTING, rechecked during T423 integration review. F1: dormant worker helpers in `packages/worker/src/sandbox/container-manager.ts:194,204` still read then write attachment counts and have no callers. F3: API process death leaves `containers.attached_ws_count` stale, and there is no boot reconciliation or operational consumer (live uses are the API writers plus a web type). Decide whether the count should be retained with a lifecycle contract, or removed with the unused helpers; make dormant helpers atomic before any reuse. This does not undo T423's live API atomic-write and cleanup correction. Evidence: `.claude/tmp/board-run/T423/codex-review-integrated.md` F1/F3. No implementation started; separate design decision.

### T439 · FNF[auth-url-resend] [design] · a pause of 1 s or more inside the login URL still sends its head

status: parked · reason: diminishing returns (2026-11-01 scan): Incomplete login URL chunking has never been observed; resume when resume when real output pauses produce truncated authentication links · priority: P4
From the T433 review (2026-10-30). Residual of T433's fallback: api routes/cli-login-banner.ts `offerAuthUrl` (~:689-707) takes the end of the output as the URL's end once `AUTH_URL_SETTLE_MS` (1 s) has passed since the URL first showed, so output that stops inside the URL for that long (or an event-loop stall of that length) sends the head with nothing to correct it. T433's other option, re-send when the URL grows, would cover it: keep extracting after a deadline send and send a second `auth-url` frame when the URL grew (the web re-applies `setAuthUrl` per frame; verify, and decide how amp's flow choice and the device code behave on a second frame). Real chunking inside the URL has never been observed: decide whether it is worth the mechanism.

Cross-reference (T438, 2026-10-30): the device code now waits within the same deadline, so a code cut at the deadline goes out as it stands (cli-login-banner.ts ~:716) and is never corrected either; success text in output that arrives while the frame is held is evaluated only at the next chunk (`canDetectAuth` needs `authUrlSent`, ~:838-840; a human cannot approve before the link shows); and the login modal shows nothing about the code when the frame carries none (web cli-auth-banner-modal.tsx ~:634, now rarer). A re-send mechanism would cover the first and the last.

### T442 · FNF[runner-launch-spec] [design] · a running app runner is reused whatever image, caps, ports or debug env it was created with

status: parked · reason: diminishing returns (2026-11-01 scan): Runner launch-spec mismatch is explicitly minor with unmeasured consequences; resume when resume when changed launch settings cause a demonstrated runtime problem · priority: P4
From the T431 review (2026-10-30). PRE-EXISTING, minor, consequence unmeasured. worker sandbox/app-runner.ts ~:326-333 reuses a running app runner when its workspace subpath matches and compares nothing else, so the image tag, resource caps, publish args and debug env chosen at create never reach a running runner (the class T431 fixed for the editor). Unlike an editor, recreating a runner stops the running app, so decide when a changed launch may replace it (idle only, on the next explicit start, or never with a notice) before stamping a spec label as T431 did (`haive.ide.spec`).

### T444 · FNF[agent-rules-size-cap] [design] · the repository rules override may be 64 KiB, but codex reads only the first 32 KiB of AGENTS.md

status: parked · reason: diminishing returns (2026-11-01 scan): Explicitly minor oversized-override edge requires unusually large rules; resume when resume when actual repository rules exceed Codex's readable limit · priority: P4
From the T119 review (2026-10-30). Minor. shared project-state limits.ts ~:12 `MAX_AGENT_RULES_BYTES` is 64 KiB, while codex reads only the first 32 KiB of AGENTS.md (the reason AGENTS.md itself is kept under 32 KiB), so a large override silently truncates what codex sees, and the rest of the file after the block with it. Decide: a 24-32 KiB cap, or a size hint on the Tooling editor.

### T450 · FNF[install-ownership-of-runners] · the runtime-runner reaper removes runners this install's database does not know, volumes included

status: done 2026-11-13 #1124 (710bc6936): every runner creator stamps `haive.install`; sweep, preemption, task-end and cancel sweeps remove only this install's label or an unlabeled runner whose task or repository exists here; by-name editor paths refuse only a foreign label; S4 two-install check still pending; lows in T638 · priority: P2 · gate: bounded verification
From the T441 review (2026-10-30). PRE-EXISTING, consequential on a host whose Docker daemon serves two installs; read from code, not reproduced. worker sandbox runtime-runner-reaper.ts ~:515-526 lists every `haive.ddev` and `haive.apprunner` container on the daemon with no install-ownership test; ~:64 (`if (!task) return 'orphan'`) treats a runner whose task this install's database does not know as an orphan, and `sweep` (~:342-366) and the preemption path (~:461-466) then run `docker rm -f -v` on it, its volumes included. Runners carry no `haive.install` label (only docker-runner.ts ~:422 stamps one). Fix direction: stamp `haive.install` on every runner at create, list by it, and leave an unlabeled runner alone (never reap what this install cannot prove it owns); keep docs/plans/solitary-partitioning-lampson.md's pending two-install check (S4) in step.

Execution fence 2026-11-01: first establish an affected legacy/current supported case in owned fixtures. The recorded risk is not a confirmed production incident and does not make completing an unbounded inventory a prerequisite for new functionality. Escalate a reproduced security/data-loss consequence.

### T451 · FNF[runner-liveness-probe] [verify-first] · a failed docker inspect of a runner's existence still reads as "no"

status: done 2026-11-13 #1127 (7c5d8c50b): tri-state `probeRunner` by exact-name `docker ps -a` listing (no stderr text read); unknown never removes or recreates app or editor runners or the DDEV registry mirror, keeps editor sessions, user-data volumes, the repository cleanup row and the browser surcharge; DDEV cold-boot path is T642, lows in T643 · gate: bounded verification · user decision: recheck risk-bearing members, 2026-11-01 · priority: P2
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

### T490 · FNF[error-text-paths-2] [verify-first] · other surfaces still show raw worker error text with server paths (+8) [parked: fence]

status: parked 2026-11-13 (VERIFIED, MSC probe on 6d5854b19: item 1 already fixed, `repos.ts` ~:2744 redacts URLs and scrubs paths, real-git controls pass; item 7 already fixed, `bundle-composer.tsx` ~:47 shows the API reason, 44 controls pass; item 9 not reproducible, every current origin/fetch/push producer redacts userinfo (`git-push.ts` ~:68, ~:342, `merge.ts` ~:124) though the snapshot sink itself does not; items 2-6 and 8 are path-only or unreachable and stay under the fence. Resume on a credential-bearing transport or a misleading operational failure) · priority: P2
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

### T495 · FNF[failed-read-answers-2] · more git reads read a failure as "absent" (+14)

status: open (items 1, 3, 5, 10 done 2026-11-13 #1129 (8e53558ba): absence needs a positive answer; rules staging and refresh use `provesUnbornHead`, baselines a quiet verify exit 1, projections a tree listing; any other failure is unknown) · gate: bounded verification · priority: P2
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

13. #1129 review: `_dependency-policy.ts` ~:140 absent probe `rev-parse -q --verify <base>:<path>` exits 1 also for a missing commit or tree object (measured), not only an absent path. Normal repos (new file, base without it, shallow clone) behave; an `ls-tree` listing, as item 5 uses, is the stronger probe. PRE-EXISTING, low.
14. #1129 review: `project-state/set-aside.ts` ~:298 `headOid` and ~:1412 `headEntry` still map any non-zero exit to absent (item 4); now mostly shielded because `readBlob` throws first on an unreadable HEAD. Low.
15. #1129 review: eight more sites read quiet `rev-parse HEAD` exit 1 as unborn (list in the review: .claude/tmp/codex-run/FRA-S/review.md); a broken branch ref exits 1 too. Apply `provesUnbornHead` (repo/unborn-head.ts) where the answer drives a write. Untraced.

Reconciled 2026-11-01: item9's failed-HEAD-read defect is RESOLVED by T397 (current _stage-paths.ts344-349 permits only exit0/1); remaining open-operation helper duplication is refactoring and stays parked with T379. Failed-read candidates imported from T379 require deduplication and a current supported reproduction before repair. No full twelve-item audit by default.

Execution fence 2026-11-01: Deduplicate the resolved T397 paths and T379 overlap first. Select at most three current consequential caller cases; no twelve-item generic Git-read audit. The fixed item9 HEAD probe must not be reimplemented.

### T499 · FNF[parks-accounting] · verify whether a parked current row beside another active row can stall recovery [parked: needs live evidence]

status: parked 2026-11-13 (VERIFIED: members 1 and 7 stay resolved, both real-Postgres START-settle/reoffer controls pass on 4a7ac4b55; member 4 has no supported producer: the other-step guard (`task-queue.ts` ~:3179) would refuse the state, but Retry resets other live rows and boot requeues abandoned rows. Resume only on a live trace: the action sequence, task/step/round/epoch snapshots, queue state and repeated refusal logs) · priority: P2
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

### T660 · FNF[apply-receipt-lows] · apply receipt and save generation lows, after #1155 (+5)

status: parked: diminishing returns (2026-11-14, owner rule: trivial lows park; resume on a user report, a measured failure or a related change) · kind: fix · found: #1155 reviews 2026-11-13 · priority: P4

1. `06a-db-migrate.ts` ~:286-298: a project with no DB service (`ddevConfigOmitsDatabase`) gets a non-zero `ddev snapshot`, so its success receipt stays unmarked and a lost-done-write redelivery fails "outcome unknown" instead of replaying. Safe direction; distinguish "no database" from "snapshot failed".
2. `06a` ~:294: the marker write is not retried; a transient DB error after a long migration + snapshot leaves the receipt unmarked, so recovery is a Retry that re-runs the command. Rare.
3. The literal `'11g-save-database'` is repeated in `api/routes/tasks/steps.ts` ~:339, `api/lib/task-control.ts` ~:288 and `worker/queues/_step-reset.ts` ~:86; the worker exports `DATABASE_SAVE_STEP_ID`. Move one constant to `@haive/shared`.
4. `GET /:id/steps` returns raw rows, so `apply_receipt` (up to 2000 chars of command output) ships on every poll (`steps.ts` ~:652). PRE-EXISTING payload shape; project the column out.
5. Coverage: a receipt written between DDEV start and the Drupal probe is unpinned.
6. Related first-party, UNVERIFIED: `07c-ddev-reconcile.ts` ~:474 (`ddev utility migrate-database`) is the same class of external apply with no receipt; check its redelivery safety.

### T502 · FNF[ci-step-limits-rest] · six more CI jobs bound a hang only by their job limit; helper scripts are not scanned for swallowed failures (+3)

status: parked · reason: diminishing returns (2026-11-01 scan): Additional timeout granularity and hypothetical helper or pub/sub gaps lack demonstrated gate failure; resume when resume when a hang or cross-step interference defeats current job bounds · priority: P4
From the T489 review (2026-10-31). PRE-EXISTING, minor to moderate.

1. No step-level `timeout-minutes` in lint-typecheck-test (ci.yml ~:35, 20 min), browser-runtime (~:114, 20), compose-boot (~:581, 30), e2e (~:721, 45), cli-adapters-arm64 (platform-checks.yml ~:39, 60) and macos-boot (~:116, 45): a hang costs the job limit. Size each from measured run times, as T489 did for four jobs, and extend the pin.
2. The swallowed-failure pin reads workflow `run` texts only; the helper scripts they call (packages/database/scripts/schema-parity.sh, scripts/ci-retry.sh, scripts/check-web-image.mjs) are never scanned (schema-parity.sh ~:34 has a legitimate `|| true` in an EXIT trap, so a scan needs an allowance).
3. Redis pub/sub is not database-scoped, so T489's database split does not isolate channels: module-activation-watch.test.ts ~:85, ~:93 publishes `haive:module-activated` in a later step and api modules/loader.ts ~:79 publishes it from app code a gated row may reach. Use a per-run channel prefix in tests, or check no gated row publishes it. From the T489 reviews.
4. The smokes job's Postgres-gated step is 2 rows from its modelled budget: the GATED list has 131 rows since #1062 and `scripts/test/ci-step-independence.test.mjs` (~:62-66, 120 s + 7.5 s a row x 1.5 against the step's 25 min, ci.yml ~:427) fails at 133. The next gated test must raise the step and job limits together. Found T590 review 2026-11-10. Minor.

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

### T509 · FNF[swallow-rule-shape] [design] · the CI swallow pin lists failure-masking shapes instead of judging what follows `||`

status: parked · reason: diminishing returns (2026-11-01 scan): Hypothetical failure-masking spellings do not occur in pinned jobs today; resume when resume when a real workflow uses an unrecognized masking form · priority: P4
From the T489 fourth review (2026-10-31). PRE-EXISTING, minor (none of these occurs in the pinned jobs today).

The swallow rule in scripts/test/shell-source.mjs (`swallowedFailure`) rejects a fixed list of forms (`|| true`, `|| :`, `|| exit 0`, `set +e` and a few spellings), so every other way to mask a failure passes: `cmd || echo ...`, `cmd || { echo warn; }`, `cmd || { ...; exit 0; }`, `|| return 0`, `|| continue`, `|| break`, `|| exit "0"`, `|| exit 00`, `|| \true`, `|| command true`, `|| builtin :`, `|| /usr/bin/env true`, `|| $(true)`, `|| test 1`, `|| [ 1 ]`, `|| true>/dev/null`; and `set` changes in a later option group or position: `set -u +e`, `set -eu +e`, `set +x +e`, `set +eo pipefail`, `set -o pipefail +o errexit`, `(set +e)`, `if set +e`, `! set +e`, `time set +e`. Decision needed: judge the right side of `||` (allow only a handler that ends in a non-zero exit, or an explicit allow-list with a reason) instead of extending the list. Single.

### T510 · FNF[fs-safe-resource-errors] · lenient fs-safe reads take running out of descriptors for an absent entry (+4)

status: done 2026-11-13 #1125 (d62ed5e57): items 1, 3, 4; 31 consequential lenient reads rethrow EMFILE/ENFILE (default unchanged), four api routes and fs-http answer host faults 500, sandbox boundary lookups refuse the run, merge relocation never throws after a move, terminal refusal scrubbed; items 2 and 5 moved to T640 · gate: bounded verification · priority: P2
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
15. `tests/e2e/settings/global-kb-edit.spec.ts:227` "rejects an empty body and preserves corrections when saving fails" failed on both attempts of one CI run (#1288, run 44674787606 attempt 1: "The article body cannot be empty." never shown after `editor.fill('')` on the contenteditable) and passed on the re-run; the spec is unchanged since 2026-11-09 and the PR changed no web code. Likely the fill lands before the editor's input handler is attached, so `bodyEdit` keeps its text. Fix direction: wait for the editor to be editable and clear it with select-all plus Delete, then assert the body text is empty before Save.

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

### T527 · FNF[save-index-guard-gap] · a concurrent HEAD move can follow the index-sync completion guard

status: parked · reason: diminishing returns · user confirmed routine/theoretical work stays parked, 2026-11-01 · priority: P4
Split from T521 item3. Existing synchronization promises a checked boundary, not a permanently atomic filesystem/Git transaction. Resume only for a caller-backed stronger contract or a supported reproduction with an incorrect user-visible result.

1. From T521 item3: syncRealIndex completion can still report indexSynced after HEAD changes immediately after its guard (~:297). Re-check the accepted commit boundary before reporting success; no stronger atomicity is currently promised.

### T528 · FNF[validation-false-green] · verify whether current checks can pass after a lost audit, missing fake table or unlisted gated file [parked: no current case]

status: parked 2026-11-13 (VERIFIED, MSC probe: item 3 already fixed by #1093 (7c790dedb), the gated-list scanner follows guard expressions and aliases; items 1 and 2 found no current false-green control in a bounded pass. Resume when a control is shown green for the wrong reason) · priority: P2
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

### T588 · FNF[worker-audit-writer] · worker audit writer follow-ups (+12)

status: open · kind: fix · found: #1057 reviews 2026-11-10 · priority: P4
Owner decision 2026-11-12: item 4: gate 4 refuses when the repository already has a saved remote or credential and points to the repository settings; typed values only fill an empty slot.

1. DONE #1092. No worker mapping for a lock timeout: gate 4's bounded lock take and 02-upgrade-apply.ts ~:834-840 end the step with the raw PostgreSQL message; `isLockNotAvailable` exists in @haive/database (used by attachments/expand-archives.ts ~:687). PRE-EXISTING pattern, minor.
2. DONE #1092. `packages/worker/src/audit.ts` duplicates the api's `insertAuditEvent`, `logAuditEvent` and `AuditEvent`, and metadata summaries are computed in both (worker audit.ts ~:78-91, api repos.ts ~:996-998); @haive/shared could host one copy. Minor, drift risk.
3. DONE #1092. Worker rows carry `source`, `actorKind`, `fields`, keys no api row for the same action has; a consumer filtering on `source` sees only worker rows. The admin list reads metadata generically. Minor.
4. DONE #1111. Gate 4's no-origin path replaces a saved remote and credential with the typed values (11a-gate-4-push.ts `persistPushOrigin` with `addOrigin`); audited and stated in the form since #1057, unchanged behaviour. PRE-EXISTING, minor; decide whether it should refuse instead.
5. DONE #1092. `repository.scope.update` from the worker reports `addedCount` 0 when a null list becomes `[]`. Nit.
6. Two inline `audit_events` inserts remain outside `@haive/shared/audit`: module drain, and the private-endpoint seed (in a transaction by design). Minor.
7. Gate 4's remote update emits no event when nothing changed; the api remote route emits one with empty `fields`. Nit.
8. (PRE-EXISTING) api `routes/tasks/index.ts` ~:805 calls the unmapped `initializeTaskDatabaseState`, so a lock timeout there surfaces raw. Minor.
9. Nothing stops a new step from importing the unmapped `initializeTaskDatabaseState` instead of the lock-mapped wrapper. Fix: a lint or ratchet test.
10. After a gate 4 refusal (or any `pushed:false`), `12-worktree-cleanup.ts` ~:908 pushes the branch again ("pushed at 11a") through `taskRemoteUrl`, which reads `formValues.push === true`; nothing records that 11a did not push. PRE-EXISTING, harmless today; key it on 11a's output. Found by the T588-4 review.
11. DONE #1111. `LinkOriginDialog` (web `components/.../link-origin-dialog.tsx` ~:59-61, :76) cannot clear a saved credential: "None" omits `credentialsId` and `POST /repositories/:id/remote` (api repos.ts ~:2800) keeps the stored one; it also preselects a GitHub OAuth credential, so a re-point can silently swap the saved credential (only the audit's `credentialsChanged` records it). PRE-EXISTING; reachable for repositories with a remote since Change remote (T588-4). Fix: an explicit keep / change / clear choice, no preselect when a credential is saved.
12. Gate 4 can push with the detect snapshot's credential after that credential was cleared (Change remote) while the remote stays saved and an origin appeared after detect: `persistPushOrigin`'s early return for an existing binding (11a-gate-4-push.ts ~:47) runs before the snapshot-fallback checks. Nothing is written or audited, and `buildCredentialHelper` still refuses a credential that does not fit the row's remote. PRE-EXISTING shape (same gap for a detected origin with no saved remote), widened slightly by #1111; minor. Fix: check `snapshotFallbacks.credentialId` against the stored credential before that early return. Found by the #1111 round 4 review.

### T589 · FNF[encryption-key-and-seed-store] · boot key and seed store leftovers (+36)

status: open (item 5 part B1 done 2026-11-13 #1131 (57bfecc51): safe decrypt of user email/phone, recover-admin CLI and installer helper; B2 SMTP mail done 2026-11-13 #1133 (ddb3d785f): `config:mail:*`, write-only `mail_smtp_password`, admin Mail card with test send, api `lib/mailer.ts`; B3 forgot-password and key-loss claim done 2026-11-13 #1134 (78f056b63): migration 0232 `password_resets`, public `/auth/forgot-password` and `/auth/reset-password`, own `recover`/`reset` throttle scopes, 2-min cooldown, git_email claim gated on the discard audit row, live-checked through Mailpit; B4 admin relink done 2026-11-13 #1135 (e5a6fa1ec): `POST /admin/users/:id/relink` on orphaned active rows only, self-relink refused on the locked row's id, reset mailed or the one-time link shown to the admin, live-checked in the admin UI through Mailpit; item 5 complete; items 19-31 done 2026-11-13: #1141 (21f3391f7) api items 20-24, 26-30 (19 was already fixed), no-store also on create-user and reset_password replies; #1142 (4a0d8dade) web items 25 and 31; item 32 moved to T653; items 33-36 open; item 1 done 2026-11-12 #1113 (2daca69a7): boot refuses to mint a key over existing ciphertext, `HAIVE_DISCARD_UNREADABLE_SECRETS=1` override audited; env-key seeding serialized against a pending discard, stale pending fails boot with the way out) · kind: design · found: #1060 reviews 2026-11-10 · priority: P3
Owner decision 2026-11-12: item 1: boot refuses to generate a new key when encrypted secrets exist and no key is found; an explicit startup override (env setting naming the consequence) lets an operator start anyway, discarding the old secrets, and that choice is logged and audited.

1. With no `CONFIG_ENCRYPTION_KEY` and an empty Redis (flush, new volume) `ensureEncryptionKey` (shared config.service.ts ~:939-967) generates a fresh key with only a warn, which orphans every secret encrypted under the lost key; it cannot tell a first install from a lost store. PRE-EXISTING, consequential, by design today; decide whether a non-empty secrets table should refuse to generate.
2. `getEncryptionKey` caches `null` for 30 s via `get()` before throwing (config.service.ts ~:1098-1117), so a recovered key stays unseen for up to the cache TTL when no env key is set. PRE-EXISTING, minor.
3. The seed's Redis compare-and-set runs inside the Postgres transaction but outside its rollback: a timed-out or ambiguous Redis write, or a COMMIT failing after it, leaves the grant applied with its audit row rolled back (worker private-endpoint-seed.ts ~:410-435). Same shape as the earlier `setIfAbsent`. PRE-EXISTING, minor.
4. Seed attempts count seed runs, not distinct boots (bootstrap retries and crash loops count), and a malformed `bootstrap:privateEndpointSeed` blocks the seed until deleted; both documented in api-auth.md. Accepted, minor.
5. OWNER DECISION 2026-11-13: hybrid. (a) An idempotent host recovery script restores one admin by the email the operator types (re-encrypts the email, recomputes its blind index). (b) Every orphaned row (email unreadable under the current key) has its password cleared, and a new forgot-password email flow lets a typed email that equals exactly one orphaned row's plaintext `git_email` claim it by a reset link sent to that address. (c) The admin relinks any remaining row (no or duplicate `git_email`) by entering its email, which sends the reset link. Bcrypt hashes do not depend on the key; clearing them is the owner's choice. Haive has no forgot-password flow today. Original finding: after `HAIVE_DISCARD_UNREADABLE_SECRETS=1` (item 1's override), nobody can sign in and setup stays closed: the override clears `system_secrets` but keeps `users`, the next boot regenerates `email_blind_index_pepper`, so login (`computeEmailBlindIndex`, api auth.ts ~:249-263) matches no existing user; first-run setup and admin registration need `userCount === 0` (auth.ts ~:103-106, :236; registration.ts ~:51-64) and registration mode defaults to `closed` after a Redis loss. The only in-app way back is deleting users, which cascades to repositories and tasks, the data the override exists to keep. Same dead end existed silently before item 1 (generate-and-warn). Options: document a manual SQL recovery (recompute one admin's blind index and reset the password hash), have the override reopen first-run for one admin, or accept and document. Found by the KEY1 review.
6. A pending discard (Redis `pending` with no TTL) survives when the operator later restores the original env key; on a second key loss with the override set, the same audit id is reused, the audit insert conflicts, the delete is skipped and the key is published anyway, so boot then fails decrypting `master_kek` (shared encryption-key-boot.ts ~:57-65, :115). Needs two key losses plus a crash between commit and publish; minor.
7. Outside production a present but WRONG key still silently orphans secrets: `secretsService.get` returns null on a decrypt failure when `NODE_ENV !== 'production'` (shared secrets.service.ts ~:62-66) and `getMasterKek` regenerates and overwrites the row (~:144-150); the dev compose sets `NODE_ENV: development`. JWT secret and email pepper alike. PRE-EXISTING, consequential on dev installs. Item 1 closes only the no-key case.
8. The env-key path seeds Redis without checking the key decrypts existing rows (config.service.ts ~:953-961). PRE-EXISTING, minor.
9. A pending whose `reservedAt` is later than the seeding process's clock is treated as stale and fails boot (seed Lua in config.service.ts ~:1050): a ms skew between a discard and an env-key boot, or a clock step across hosts, gives a false fatal whose text may lead an operator to delete a live pending. Fix: tolerate about 60 s ahead and use `max(0, now - reservedAt)`. From #1113, low.
10. The stale-pending message offers 'restart without CONFIG_ENCRYPTION_KEY with the override to finish the discard', which cannot work for an unparseable pending (`generateBootEncryptionKey` throws 'Invalid pending encryption key'); only the delete-and-restart way applies there. From #1113, wording, low.
11. The seed Lua's future-dated and negative `reservedAt` branches have no test (unit or real-Redis). From #1113, low.
12. updater cli.ts ~:278 awaits `bootSql.end()` in a `finally`, so a rejecting `end` would replace the original boot error; the journal close guards with `.catch`. From #1113, low.
13. From #1131 review, low: an unreadable user row logs one warning per row per request (api `admin.ts`, `maintenance.ts`); the maintenance page polls every 5 s, so one orphan owner with many tasks floods the log. Dedupe by user id within a request.
14. From #1131 review, low, cosmetic: the maintenance page (`maintenance/page.tsx` ~:91, ~:357) and the audit table's actor cell (`audit/page.tsx` ~:203-205, id only in a tooltip) show an unreadable user without a visible short id; the users page, dialogs and audit filter do.
15. From #1131, unverified live: the `recover-admin` CLI in the real updater image, a real Redis boot in the CLI, `--log-driver none` still printing the password, and native Windows Docker. Run once on a scratch install before the next release.
16. From #1133 (Greptile), low: `sendMail` reads the mail settings and the SMTP password in two separate reads, so a send overlapping an admin save can pair the old relay with the new password (api `lib/mailer.ts`). Both relays are admin-chosen and the window is one save. Fix direction if it matters: read settings and secret under one version.
17. From #1133 review, low: no way to clear a stored SMTP password (a blank save keeps it); after a key-loss discard the admin must re-enter it. Fix direction: an explicit "Clear password" action on the Mail card.
18. From #1133 review, nit: `@types/nodemailer` is a dependency of api but unused, since nodemailer ships its own types. Remove it.
19. B3 note from #1133 review: `sendMail` rethrows `ConfigUnavailableError`; the forgot-password route sends after replying and must catch it so a Redis outage never becomes an unhandled rejection.
20. From #1134 review, low: the claim path's lock order (refresh rows revoked before the key-changing `users` update, `password-resets.ts` ~:199-208) has no regression guard; the DB test uses a non-claim token. Fix direction: a claim variant asserting statement order, or a two-connection test holding a refresh row.
21. From #1134 review, nit: `reserveAuthAttempt(c, scope, account?)` (`auth-throttle.ts` ~:208) has no caller without an account key any more; the zero-key path is unreachable and untested. Make `account` required.
22. From #1134 review, info: redemption runs bcrypt before the claim re-check and the 409 holder check (`password-resets.ts` ~:180-194); move both before hashing. Bcrypt also runs inside the transaction while holding locks (bounded: live token, per-token throttle).
23. From #1134 review, coverage: no direct test of `issuePasswordReset` for a deactivated user (guard ~:43, SQL predicate ~:99 masked by a JS filter in the unit test); the Redis-gated `auth-throttle.test.ts` has no `recover` or `reset` case.
24. From #1134 review, docs: `api-auth.md` "Accepted limits" should say anyone who knows an address can fill its `recover` bucket and silently drop the owner's own request (still 202); grammar slip "login, registration and reset answer 429 ... and has run no bcrypt".
25. From #1134 review, info: the web proxy (`proxy.ts` ~:34-48) probes `/auth/me` (5 s timeout) for every public path with an access cookie, including `/forgot-password` and `/reset-password`, then ignores the result (`route-access.ts` ~:32-33). Wasted wait.
26. From #1134 review, operability: the deferred forgot-password catch (`password-recovery.ts` ~:79-82) logs no error name or SQLSTATE, so a missing migration and a Redis fault look alike; `expires_at` is written from the app clock but compared with DB `now()`. Also nothing prunes `password_resets` or the request audit rows.
27. From #1135 review, info: the reset row issued by an admin relink audits `auth.password_reset.request` with a nil actor (`password-resets.ts` issuance event), so the audit log does not say which admin issued it; the `user.relink` row next to it does. Pass the actor through.
28. From #1135 review, info: the relink reply carrying the one-time link has no `Cache-Control: no-store` (api `admin.ts` relink route); the invite reply is the precedent to check. Separately `GET /admin/users` returns name, git name and git email for every row, which only the orphan rows need.
29. From #1135 review, info: dead branch in `admin-relink.ts` ~:88-90: `issuePasswordResetInTransaction` with `bypassCooldown: true` never returns null, so the `Relink reset issuance was refused` throw cannot run. Drop it or make the type say so.
30. From #1135 review, coverage: `upgrade-auth.test.ts` ~:488-498 lists the writers of the user's email and blind index and lacks the reset-password claim and the admin relink.
31. From #1135 review, UX: the "unreadable, needs relink" labels on the audit, maintenance and settings pages give no path to the Relink action on the users page. Link to it.
32. MOVED to T653 (design).
33. From #1141 review, low, PRE-EXISTING: no test drives the reset claim's unique-violation fence (`password-resets.ts` ~:266-268); since #1141 both bcrypt calls sit between the holder pre-check and the users update. Fix: a fake-DB test throwing `23505` with `constraint_name` from the users update, or a two-connection test.
34. From #1141 review, low, PRE-EXISTING: nothing prunes `password_resets` or the `auth.password_reset.*` audit rows.
35. From #1141 review, low, PRE-EXISTING: `GET /admin/users` returns name, git name and git email for every row; only orphan rows need them.
36. From #1142 reviews, low: the users page scrolls back to the hash row after every action reload; maintenance rows with a null owner link to the list without a highlight; maintenance and audit unreadable labels show no visible short id; the auth-throttle Redis test covers only the account bucket for `recover`/`reset`.

### T590 · FNF[cli-auth-lock-followups] · CLI auth lock and sign-out follow-ups (+38)

status: open (lows 20, 22, 24, 25, 26, 29, 30-38; item 2 accepted) · kind: fix · found: #1061 reviews 2026-11-10 · priority: P3
DECIDED by the owner 2026-11-11: all remaining groups approved (lock correctness 4, 6, 7, 15; sign-out flow 8, 9, 10, 14, 18; web UI 16, 17; tests and minor 11, 12, 13). Item 2 stays accepted and documented. Overnight run authorized.

1. DONE #1062. `DELETE /:providerId/usage-auth` and `DELETE /:providerId/secrets/:secretName` (api cli-providers.ts ~:1165-1230) take no auth lock, so a usage refresh that read the secret before the delete can write it back. PRE-EXISTING, moderate. Fix: take the lock (`withCliAuthLock`) like the writers.
2. A task's sync-back waits 30 s for the lock, then the task copy is removed (worker sandbox/task-auth-volume.ts ~:1312-1323); an open login dialog on the same CLI (up to 10 min) loses the token the task rotated. Accepted and documented (sandbox.md); waits are sequential per provider inside a step-summary slot. REGRESSION, minor.
3. DONE #1062. The web stops polling a sign-out after 10 min (web lib/cli-jobs.ts ~:37) while the job's contention cap is 30 min, so the failure text never reaches the page and "Still queued behind running CLI jobs" is not the reason. PRE-EXISTING window, minor.
4. DONE #1088. No lock-loss detection on the dedicated lock connection (database cli-auth-lock.ts): after a PG restart or `pg_terminate_backend` during a long login the holder still believes it holds the scope; migrate/lock.ts re-asserts the backend pid. REGRESSION, minor.
5. DONE #1062. A busy scope answers the login WebSocket upgrade with 409, which the modal shows as "WebSocket error" (web components/cli-auth-banner-modal.tsx ~:234). New triggers: a second tab, a quick retry during teardown, a sign-out executing. REGRESSION, minor.
6. DONE #1088. Dedicated lock connections are not capped; before a login container exists no session timer bounds the hold (api cli-login-banner.ts ~:318, ~:546). REGRESSION, minor.
7. DONE #1088. `teardownContainer` (api cli-login-banner.ts ~:1459-1477) has no timeout around `docker remove` and now holds the auth lock while it hangs. PRE-EXISTING hang, minor.
8. DONE #1086. `handleProbeJob` writes an `authStatus` computed before a sign-out that ran meanwhile (worker cli-exec/handlers.ts ~:705). PRE-EXISTING, minor.
9. DONE #1086. LOGIN_CREATE's `chown -R` helper mounts the auth volume outside the lock (handlers.ts ~:1097); a sign-out can then fail with "volume in use". PRE-EXISTING, minor.
10. DONE #1086. `job.updateData` in the sign-out contention path (handlers.ts ~:1158) is outside `deferJob`'s refusal retry; a Redis LOADING/OOM fails the sign-out with the raw error. Minor.
11. DONE #1089. `dropCopiedSecretLikeProviderEnv` fails the destructive migration on a busy lock with no bounded wait (worker secrets/move-secret-env.ts ~:37-39, ~:105). Minor.
12. DONE #1089. `GET /cli-providers` and `/:id` return `authGeneration` (api cli-providers.ts ~:224, ~:335). REGRESSION, minor (opaque, own-user).
13. DONE #1089. Tests: the PATCH stale-read refusal for an unchanged present value (`|| authSettingsRequested`, api cli-providers.ts ~:616) has no test; api writer and move-secret-env unit tests mock `tryCliAuthLock` without asserting its scope (gated PG tests cover it); harvest's `lockWaitMs = 0` is not pinned; usage-auth complete and `writeProviderSecret` lock rows secret-then-provider while others go provider-then-secret (safe under the advisory scope; add a comment). Minor.
14. DONE #1086. The sign-out scope-change retry (worker cli-exec/handlers.ts, after the lock) has no own attempt cap; only repeated settings changes inside the read-to-lock window keep it looping. Minor.
15. DONE #1088. The usage poller resolves the token without the lock, fetches, then writes the snapshot unlocked (worker usage-poll-queue.ts ~:351-435, upserts ~:228, ~:419, ~:435): a Disconnect in between deletes secret and snapshot, and the poller re-creates a stale snapshot nothing polls again. PRE-EXISTING, minor. Fix: write the snapshot under the scope lock and skip when the secret is gone.
16. DONE #1089. The provider form deletes removed secrets one by one and refreshes `existingSecrets` only after the whole save (web cli-provider-form.tsx ~:513-519): a mid-loop failure (now also a 409 `cli_auth_busy`) leaves it stale and the retry's DELETE of an already-removed name answers 404 until a reload. PRE-EXISTING, minor.
17. DONE #1089. `runCliSignOut` takes no AbortSignal (web lib/cli-jobs.ts ~:145-157; caller cli-providers/page.tsx ~:293): leaving the page keeps a 2 s poll running, now up to 32 min. PRE-EXISTING, minor.
18. DONE #1086. The sign-out cap counts from the first contention (`authContentionStartedAt`, worker cli-exec/handlers.ts ~:1152), not enqueue, and each deferred retry re-queues behind CLI jobs, so under load the job can fail after the page's 32 min window; a tab stalled more than 15 min after the job finished reads `job_expired` (retention 900 s); `delayed` is also set by pause/outage gates, where the account-wait sentence is not the reason. Minor (copy and window).
19. DONE #1089. Api POST/PATCH credential writers: the `assertHeld` before commit has no test of its own (api cli-providers.ts). Minor, coverage.
20. The last `assertHeld` sits one round trip before COMMIT, so a lock lost in that window still commits. Minor, theoretical.
21. DONE #1089. A usage reconnect refused with 409 tells the user to "Retry", but the OAuth code is single-use and was already spent; the copy should say to reconnect again. Minor, copy.
22. The usage-token refresh is re-posted on every tick, and one catch swallows its error unlogged (worker usage-poll-queue.ts). Minor.
23. DONE #1089. `move-secret-env` reads the scope before taking the lock (worker secrets/move-secret-env.ts). PRE-EXISTING, minor.
24. A refresh token the provider rotated during a refresh is lost when the lock is lost before the write. Minor; the next reconnect recovers it.
25. The volume-login flag path in the login banner is untested (api cli-login-banner.ts). Minor, coverage.
26. A `releaseAuth` rejection in the banner cleanup skips the post-release usage tick. Minor.
27. DONE #1089. The `releasePending` half of the lock-watch guard (`abort.aborted || releasePending`) has no test. Minor, coverage.
28. DONE #1089. A resumed sign-out that reaches the retry cap still says "Nothing was removed" although credentials may already be gone (worker cli-exec/handlers.ts ~:1270). REGRESSION, minor. Fix: use the scope-changed sentence when `signOutStarted`.
29. The superseded-job return runs before the resumed scope compare (handlers.ts). PRE-EXISTING ordering, minor. Also: one over-long line in docs/architecture/sandbox.md (sign-out section).
30. Sync-back reads the scope from its caller rather than re-reading it under the lock (worker sandbox/task-auth-volume.ts). PRE-EXISTING, minor (found #1089 review).
31. Two stale code comments left by #1089 (move-secret-env.ts copy phase, cli-auth-lock.ts wait helper). Cosmetic.
32. For a CLI whose login is a file in the shared auth volume (codex, amp, antigravity, grok), a login or a Test writes `auth_status` only on the row it ran on (worker cli-exec/handlers.ts ~:755-772), while a sign-out resets every row sharing the volume (~:1451-1472). Rows the login never ran on stay `unknown` in the database though the shared login works (seen: 5 never-checked `codex` rows beside 11 `ok` ones). The providers pages now read the shared status (#1280); the stored rows and the usage route's per-row `ok` check (api usage-window.ts ~:117) still do not. PRE-EXISTING, minor. Fix direction: write an `ok` probe to the rows sharing the volume, with the auth generation fences reviewed. `claude-code` is different, see T720.
33. Sign out is offered only on a row whose own stored status is `ok` (web cli-providers/page.tsx `showSignOut`), though for a volume-login CLI any row sharing the auth volume signs the same login out; siblings of the logged-in row offer neither Sign out nor Log in. PRE-EXISTING, cosmetic. Fix: read `storedLoginStatus`, or fix item 32.
34. A sign-out whose volume removal failed has already deleted the login token but skips the status reset, and nothing retries it (worker cli-exec/handlers.ts ~:1436-1451, ~:1477): the row reads `ok` with no token until the sign-out is run again. PRE-EXISTING, minor. The shared Claude login (T720) widens the token delete to every row of the set, so the gap then covers the set.
35. `assertUserAuthReady` flips `ok` to `unknown` with a plain update by id: no auth lock, no compare on the generation or check stamp, and a millisecond JS date as the stamp (worker cli-exec/resolvers.ts ~:1123-1131). A login that lands between its read and its write is overwritten. PRE-EXISTING, minor.
36. The sharing predicate keeps two more copies after T720 folds the SQL ones into one helper: the web's display copy (web lib/usage-reconnect.ts `storedLoginStatus`) and the grok grouping (worker usage-window/credential-refresh.ts ~:100-113). PRE-EXISTING, duplication.
37. A volume login's audit trail is best-effort and writes one row event for a generation advance that covers the whole set (api routes/cli-login-banner.ts ~:1388-1401). PRE-EXISTING, minor.
38. The grok credential refresh writes its set-wide status without a compare-and-set (worker usage-window/credential-refresh.ts ~:167-181), and a comment on the providers page says the probe already wrote the status when the login's candidate probe writes none (web cli-providers/page.tsx ~:128-132, worker handlers.ts ~:754). PRE-EXISTING, minor and cosmetic.

### T592 · FNF[fs-park-recovery] · park recovery runs only where fs-safe writes; legacy truncated parks (+1)

status: open · kind: fix · found: D1 (#1063) Codex and review 2026-11-10 · priority: P4
PRE-EXISTING, minor.

1. Park recovery (worker `fs-recovery.ts`, driven by the write-path temp sweep) visits only directories fs-safe writes into; a park left in a directory nothing writes again stays under its park name. Fix: also visit the dirs that parked a file (record them) or accept and document.
2. A park written before #1063 with a leaf long enough to be truncated in its park name has no `.name` record, so recovery cannot know the original name and only warns. Fix: none needed unless a user reports one; manual restore.

### T596 · FNF[plan-patch-lock-followups] · plan-patch lock and failed-merge notice follow-ups (+9)

status: open · kind: fix · found: G (#270, #497) reviews 2026-11-10/11 · priority: P4
All low unless marked.

1. Update-only patches write `version = readVersion + 1` with no version predicate in the update `where` (`shared/src/plan/apply-patch.ts` ~:856): two concurrent update-only patches, or one beside a move, can both write the same version. PRE-EXISTING. Fix: add the read version to the `where` and retry or refuse on a miss.
2. Legacy mirror rows with no base take the outbox row before the node rows (`convergePlanQuestions` `worker/src/plan/mirror.ts` ~:1004; no-op reconcile `seedBaseFrom` then converge ~:1081-1086): same inversion as the one fixed in the flush, rare, can 40P01. PRE-EXISTING. Fix: take the converge node locks before the outbox row.
3. `patch-lock.ts` ~:32 `SET LOCAL lock_timeout = DEFAULT` clobbers a bound a caller set earlier in the same transaction; no current caller sets one. Latent. Fix: save and restore the previous value.
4. `worker/test/checkout-watch-postgres.test.ts` ~:282 expects `held` but the guard throws `GitOperationUnreadableError` (gated PG test, fails on main). PRE-EXISTING. Fix the expectation or the guard's classification.
5. `writePlanMirror` still maps any 40001 to `PlanMirrorHeldError` (`mirror.ts` ~:300, `hasPgCode` import ~:15); nothing at READ COMMITTED raises it, so it can only mislabel another failure. Remove.
6. Test `commits an automatic reconcile before the flush writes files` (`worker/test/plan-mirror-gone-checkout-db.test.ts` ~:583-599) never asserts its `fsSafe` spies were hit, so it can pass vacuously. Add `toHaveBeenCalled`.
7. Op-set coverage of the lock: no case for `delete` and `depends_on` taking it, nor for `affects`/`unlink`/an ordinal-only upsert not taking it. The retry in `completePlanNodesForTask` (`worker/src/plan/task-link.ts` ~:68) can no longer fire (its patch is update-only); keep or drop.
8. Failed-merge notice edges (display only): cancelling the newest failed conversation surfaces an older failed one; the notice persists after Save/Pull discards its worktree; two reads in `Promise.all` can show one task as both `merge` and `failedMerge` for one poll.
9. `lockPlanPatch` is typed `DbOrTx`, so a pool handle would silently drop the xact lock; the re-entrant call in `reconcilePlanLocked` is redundant; the busy test's 800-2500 ms window can flake on a loaded runner.

- T667 FNF[learning-reconcile-lows]: step 11 reconcile event follow-ups (+6)
  - Replay or Retry inserts a suffixed duplicate learning (`11-phase-8-learning.ts` resolveInsertId ~:763). PRE-EXISTING, consequential: duplicates learnings and inflates the event's insert counts on retried runs.
  - Re-rolled pre-form drafts (`shouldRetryPreForm`) leave no admission-rejection trace; M3 under-counts. PRE-EXISTING, LOW.
  - Real `ON CONFLICT` path has only a fake-store test; add a throwaway-DB smoke (`_learning-outcome.ts`). LOW.
  - A failed row is kept if the same generation+invocation later succeeds (`DO NOTHING`); no path found today; `DO UPDATE ... WHERE status='failed'` if one appears. LOW.
  - 'learning.reconciled' string duplicated in worker `_learning-outcome.ts` and web `activity-events.ts`; move to shared event-type constants (`shared/src/schemas/tasks.ts`). LOW.
  - Live check owed: a real task's step 11 writes the event with nonzero counts (plan P1 verification). OWED.

- T668 FNF[time-cost-lows]: time and cost report follow-ups (+6)
  - Waits parked at fix-loop escalation gates (`task-queue.ts` oscillation ~:2456, cap-reached ~:2527) emit `fix_loop.*` but no `step.waiting_form`, so their later submit is an orphan; `task.paused`/`task.resumed` do not invalidate an open wait (`_helpers.ts` ~:1134). PRE-EXISTING event design; disclosed as unmeasured. Emit `step.waiting_form` at those parks or treat the two events as parks.
  - Provider card and Money tab per-provider rows drop stored costs after a provider is deleted (`shared/src/stats-server/cost.ts` `if (!row.provider) continue;`), so Money total and its rows can disagree. PRE-EXISTING.
  - Money SQL for the report (priced/legacy rule, recap coalesce) has only SQL-substring and proxy-DB tests; add a DB-backed test when a harness exists. LOW.
  - `computeWorkByCategory` shares park suppression structurally only; no test can detect un-sharing today (pre-run parks have 0 work). LOW, note only.
  - Empty report reads "0 of 0 tasks ran a test command · 0 not run · 0 execution not recorded"; show a dash. NIT.
  - Owed: real-browser check of the tab at 1600 px and 900 px plus an empty window (driver checked DOM on a fixture only).

## Done

- Contracted review and audit replacements for derived task types (#1211, 2332a1ba0): a module step declaring `replaces` + a matching output contract can fill the review or audit role in a derived type; v2 plan pins `roleBindings`; host keeps fix/skip policy; bound replacement output validated, failures disclosed incomplete. Lows to T679.
- Committed snapshot mounts (#1210, 103075277): mining agents with a snapshot ref run against an immutable host-owned view verified before reservation and before execution (one held-fd `git cat-file --batch-command` child, shallow clones supported, alternates/links/gitlinks/`.git`/extra files refused, exact 0444/0555 modes, inventory cap shared by issue and resolve); budget starts after the scratch lock; snapshot agents get `rag_only`, no git MCP, no LSP; transient DB faults rethrown; failures fail the step. Every ref is NULL in production until an issuer lands. Lows T683; isolation decision T684.
- Insight batch journal (#1213, 7f87aa3b4): manual 08e picks persist as `insight.batch` task_events (seat `implementer`) with per-item outcomes parsed strictly (`readInsightOutcome`); an outage on a user-requested 08e run settles without the fatal-agent guard only on Resume. T681 PR3a. Open low (accepted, review-4): a crash between the marker clear and apply needs a second Resume to settle (no data loss).
- Insight auto-action switch (#1212, 863a369bf): `tasks.auto_act_on_insights` (migration 0243, default false) written by 06; remembered only from the owner's last completed task on the same repository and type; hidden and inert (`INSIGHT_AUTO_ACTION_AVAILABLE` false, answers clamp to false, only an explicit type preset records true); parked 06 forms upgraded idempotently; 06 no longer writes the empty 08e pre-answer, so insight choices park under auto-continue. T681 PR2. PR4 must replace the already-persisted hidden field when the switch becomes available; `loadLastCompletedFormValues` (step-runner ~:244) still orders NULL `completed_at` first (PRE-EXISTING, minor).
- Shared insight loader (#1209, 7c10887b1): `_insight-loader.ts` owns the parser and source loader; `loadUnactedInsights` (unlimited by default, picked filtered before the limit, exact omissions, `findingIdentity` before clipping, stable occurrence ids, additive `sourceRefs`); both gates persist through one bounded projection byte-identical to base; task-bound host service `ctx.host.loadUnactedInsights`. T681 PR1 and DPA P2.
- Credential redaction in repair evidence (#1204, 2d3e62822): stored test-edit content and every gate artifact that serves diff or file text (gate-3, run-app, learning incl. extra files, KB commit, external KB) run through the committed-secret scanner and are rechecked when served; NUL and invalid-UTF-8 blobs are withheld whole; a pass that can no longer finish taints the task while an ended pass whose owner can still finish keeps its evidence; one exported marker; a change hidden by redaction shows a notice. T670 items 1 and 3. Lows filed in T670. Deploy note: api and worker crashed on the new shared export before libs finished; `pnpm docker restart worker` and `api` fixed it.
- Scratch reaper for repository-backed tasks (#1206, 2cd957697): completed or cancelled tasks (not paused; a stale `dead_at` no longer strands one) have their canonical scratch removed under a per-task in-process fence shared with acquisition and the boot sweep; any unended, unsuperseded invocation or a live CLI sandbox holds it; the missing-task boot branch needs a clean listing. Lows filed as T682.
- Module core-row write rules (#1205, ec16f7281): modules.md "Core-row writes" (ctx.db authority, extension rows, pre_answers merge, no core tables, cross-database intents, owner-scoped routes, review history); single-writer claims in review-findings.md and schema comments now say "core"; stale deep-analysis plan passages corrected.
- Module fan-out seats (#1203, a3f5fe991): optional manifest `miningSeats` on module mining steps, validated in shared and at worker load (a seat id may not reuse a `cliRoles` id); one API resolver replaces the three readers of `STEP_MINING_SEATS`; deactivated modules hide their seats and keep stored choices.
- Postgres DSN guard on save (#1200, 324dc1326): a user Postgres DSN carrying a refused file-reading or unsafe parameter is refused when saved; a refused global DSN degrades RAG search, re-embed and custom MCP to repository hits with a note instead of failing them; a parser test diffs postgres.js's option inventory so a new file-reading parameter fails CI; the relink sweep logs fenced and locked skips. T664 items 5 and 10, T662 item 4. Lows filed in T664.
- Learning deletion identity (#1202, 3de12aa36): every delete in step 11 apply first writes an apply-keyed record under `.haive/learning-deletions/`, then unlinks, so a replay cannot resurrect an updated-then-deleted learning or lose a replacement draft's slug; records are read strictly. T672 items 2-3. Lows filed in T672.
- Learning insert replay (#1194, 9ed6cd004): learning provenance records a stable, apply-keyed operation id; a replay of step 11 apply reuses the file its first run wrote (suffix and staged draft kept) and plans against the pre-apply state, so dropped operations stay dropped (an insert-then-delete no longer erases the learning). T672 item 1 (also T667 item 1).
- Plan chat bound follow-ups (#1193, 587b868a7): budgeted dispatch again drops house rules then agent rules for an argv-only adapter (pre-#1178 contract, required plan chat included); an oversized original is kept durably in `plan_node_messages` in the same transaction as the edit-form park, ordered before its replacement; clarification, build and coverage folds retry unversioned conflicts up to three times and re-ask a stale agent version. T675 items 1, 3 and 10.
- Derived task types PR 4 (#1191, af136c094): the web editor for derived types: "Duplicate and customize" on the built-in workflow (no write until save; other bases show the catalog's reason), an ordered changes editor with a read-only path preview, live shared validation plus a debounced server preview, split skipped/stale warnings, gate-removal warning, overlay-only saves, 403/409 handling. Prerequisite 3 complete. Browser-checked on the dev stack 2026-11-14. Lows filed as T679 items 14-19.
- Derived task types PR 2 (#1187): migrations 0240 (the `derived` run-list strategy) and 0241 (nullable `base_slug`, `changes` and `tasks.derived_run_plan`, named shape CHECKs, a restrictive self foreign key) with every existing row unchanged; readers refuse a derived type explicitly until PR3; the header's guarded manual cleanup refuses while any task uses a derived type. Applied to the dev database 2026-11-14. Its PR3 hazard is filed in T679 item 6.

- Release bundle swap, T648 PR 5 (#1185): the updater installs the release's compose bundle with a journalled backup, restores only the files a run changed on rollback, refuses linked or non-regular install files before any hold, classifies every installed file a swap replaces (all overlays) for edit detection and retention, keeps backups that hold operator edits, cleans abandoned writer temps, and recovers a crashed run from the journal without a migration head. Lows filed in T674.

- Derived task types PR 1 (#1186): `@haive/shared` evaluates a derived type's ordered change list (remove, insertAfter, replace) against every candidate run list of its built-in base (no path plus each execution path, with the environment prelude), with explicit applied/skipped/refused outcomes, stale-target warnings, a protected triage prefix, `replace` refused until output contracts exist, and `validateComposition` on every result; nothing calls it yet. Lows and PR3 decisions filed as T679.

- Step SDK seam, derived task types prerequisite 2 PR 1 (#1184): `@haive/shared/step` carries the step contract (15 interfaces, the seven runtime control classes defined once and re-exported by the worker, `ChatPlanRead`, the form/metadata types), unreachable from every other shared entry; the module loader types `steps` from it; a compiled fixture module proves class identity through the loader. Lows filed as T678. Deploy note: the worker crashed on the pull (new shared entry not built yet) and needed `pnpm docker restart worker`.
- Step SDK seam PR 2 (#1188): `@haive/shared/step/prompts` and `step/review` carry the canonical untrusted-repo fence guards, `fencedAgentBlock`, `changedFilesBlock`, `isListableName` and the diff-hunk parser, defined once and re-exported by the worker; review may import prompts, no other entry reaches another. Lows added to T678. Deploy note: the worker crashed on the libs rebuild and recovered by itself once dist was written.

- Bounded plan writers, AIDE² P5 (#1183): 11f and 01f send a depth-4 plan index plus whole versioned focus nodes; ops with a missing or stale version drop individually; a capped 01f range is reviewed and stamped; the runner persists what `prepare` writes before dispatch (08d now sees 08a's real login outcome). Lows filed in T675.

- Every built-in workflow step is composable, derived task types prerequisite 1 (#1182): 23 catalog entries (58 total) so a composed or derived workflow can hold any built-in step; sprint planning requires both implementation steps, repository writers require a worktree, and every shipped path validates with no issue. Lows filed as T677.

- Updater reads the release bundle, T648 PR 4 (#1181): before an upgrade the updater fetches and hash-checks the release's compose bundle, refuses a modified or unreadable bundle with a typed refusal, refuses plain-http manifests when a bundle is present, and generates missing `hex` `.env` keys atomically; a required key written as a variable reference refuses (`env-key-interpolated`). Lows filed in T674.

- External module dev install, T669 items 2-3 (#1179): private modules cloned into ignored `external-modules/` install through `.pnpmfile.cjs` with a local lockfile, leaving tracked manifests and `pnpm-lock.yaml` unchanged; `pnpm module lock` refreshes the public lock; CI refuses install wiring that names a module missing from `public-modules.json`. Lows filed as T676.

- External module release paths, T669 item 5 (#1235): registry installs verify the packed manifest's name and version, the channel build refuses a legacy tag with entitlements and explains a missing-declarations TS7016; restricted publish, vendor channel build and private git install each passed live once.

- Bounded plan chat, AIDE² P4 (#1178): plan chat sends the answered turn plus the newest earlier turns that fit, reads the plan from a versioned per-turn snapshot outside the tracked tree (removed after the run, reaped at boot), and a plan write retries a version conflict from a fresh read. Lows filed as T675.

- Release bundle image, T648 PR 3 (#1180): every release and channel build publishes `haive-release:<v>` holding `release.json` and the compose bundle, built before the GitHub Release. Lows filed as T674.

- Next-round CLI choice at the fix-loop escalation gates (#1175): the user picks the CLI for the next fix round; an unavailable CLI re-parks the gate. Lows filed as T673.

- Learning provenance (#1177): each learning file records its origin and last five updates as a trailing comment with before/after hashes, stripped from excerpts and RAG chunks.

- Time and cost report PR 3 (#1176): idle time is labelled "Idle" on the statistics tile and "parked" on the task pages, never "waiting on you"; the plan is complete apart from the idle-detection note line.
- Time and cost report note (#1232): "What these figures cover" states the reading allowance, the bounded iframe credit and that older figures are not directly comparable; the plan is complete. Low (review): the note hardcodes the 1-5 and 15 minute figures that live in `activity-clock.ts`; pin them from the constants if they change.

- Time and cost report PR 2 (#1170): every 08/08b check run is recorded in `task_check_runs` (migration 0239) as observation only, with bounded writes; the report counts passed, failed, not run and incomplete runs. Lows filed as T671.

- Fix-pass test edits, AIDE² P6 (#1171): repair passes record before/after images of test files (`fix_test_blobs`, migration 0238) and gates 2 and 3 show the edits; protected paths stay withheld, and a protected move keeps the task contentless. Lows filed as T670.

- Release manifest describes the compose bundle, T648 PR 2 (#1172).

- Context-tiered pricing prerequisites (#1173): read-only request-usage replay with measured coverage, complete-only ledger excess, serialized price refresh that finishes on failure. Remaining under T665.

- Time and cost report PR 1 (#1169): "Time & cost report" statistics tab (test phase, workflow work by category, human active, waiting for a person, billed and at-API-rates) plus the task page tests cell. Live: tab totals equal /summary (50 tasks, work and active ms exact). Lows filed as T668.

- Agent-memory P1.1 (#1168): step 11 records one versioned `learning.reconciled` event per apply (counts only; replay-safe id); docs/architecture/learning-reconcile.md. Lows filed as T667.

- Context-tiered pricing PR 2 (#1167): per-request usage capture (Claude family, codex app-server watermarks, Gemini count) with complete/incomplete coverage; prices nothing yet. PR 3 prerequisites filed under T665.

- Human time PR 3 (#1166): plan page attention as `time.planActiveMs` on the statistics summary and a Plan page tile on the Time tab; lows filed under T666.

- human time PR 2 (`docs/plans/human-time-idle-detection.md`) — plan page time per repository, user and UTC hour (`plan_active_time`, migration 0237), `POST /repositories/:id/plan/user-active` (owner only, atomic upsert clamped to one hour), plan-page pending registry (queued/running work only, no new polls) — PR #1165 (720a0209e), 2026-11-14; 0237 applied, route mounted. Browser check and lows T666.
- human time PR 1 (`docs/plans/human-time-idle-detection.md`) — idle-aware task-page timer: presence epochs on a monotonic clock, reading allowance from visible words (150 wpm, 60 s to 5 min), trusted-input rules, fail-open attention lease, waiting step picked by `isAwaitingFormInput`; topic docs/architecture/human-time.md — PR #1163 (4888d3e15), 2026-11-14; browser check owed, lows T666.
- context-tiered pricing PR 1 (`docs/plans/context-tiered-pricing.md`) — prompt-size tiers stored in the rate jsonb from LiteLLM and OpenRouter, unpriced markers (`time-window`, `variable-price`, unreadable tiers) refused at lookup, negative router rates retired, per-feed `fetch_error`; model-pricing.md corrected (the global switch freezes rates, only the per-CLI switch is enforced at lookup) — PR #1164 (2ee2f6a5c), 2026-11-14; live refresh: 141 tiered rows, 11 markers, 0 negative rows. Lows T665.
- T553 items 1, 2, 3, 5, 6 — impact preview and confirm before a provider disable, provider-hold badge via `task_steps.provider_wait_provider_id` (migration 0236), hold copy names both ways out, recap skip logged, run-list and execution-path selection shared by api and worker — PR #1162 (d7a6a43ad), 2026-11-14; bots clean (Codex none, Greptile 5, P1 fixed and resolved), CI 17 pass; 0236 applied, libs rebuilt, api/worker ready, 0 error logs. Confirm dialog not browser-checked (a 0/0 disable saves at once and would change an owner provider row). Items 4, 8, 9 and lows 10-14 stay open.
- T655 — upgrade postgres.js to unpatched v4.1.1, drop the local patch, guard file-reading DSN parameters — PR #1159 (d82c683fb), 2026-11-14; bots clean (Codex none, Greptile 5), CI 17 pass; deployed via pnpm docker rebuild, postgres@4.1.1 loaded, api/worker ready, 0 error logs. Lows T664, T555 item 6 done.
- T659 — plan-canvas smoke race checks wait on PostgreSQL lock waits or peer settlement instead of sleeps (the CI failure was smoke timing; the merge it saw is correct); lows in T663 — PR #1161 (034003dea), 2026-11-14
- T508 — a remote relink records a durable intent on the row; a fresh locked read reconciles Git's origin after a lost connection, failed COMMIT or process death, on the request path and through a sweep that skips locked and in-process-fenced repositories; lows in T662 — PR #1158 (8305c3d2d), 2026-11-14
- T658 — relink SIGTERM lock-file flake: the test now waits on a FIFO open handshake instead of wall time — PR #1158 (8305c3d2d), 2026-11-14
- T654 — close live provider shells when the provider is disabled — PR #1156 (846c1ee9a), 2026-11-14
- T501 — redelivery-safe deterministic applies (receipts, durable-snapshot replay gate, save generations) — PR #1155 (9fbfad0cc), 2026-11-14
- T519 — PR poller catches each task's poll on its own and logs settled rejections; a failed merged-task re-drive saves prPollError and a later success clears it; member 3 invalid (held by `holdStepAdvance`) — PR #1150 (7c13cd38a), 2026-11-13
- T656 — CI flakes: dev.sh test stub drains psql stdin and pins its env; check-web-image uses referenced, budget-capped request timers — PR #1154 (969cddc24), 2026-11-13
- T526 — Save syncs committed names into the index first and repairs stale owned names separately (bounded, reported via warning and `indexSynced:false`); a staged plan deletion is recovered as a deletion intent — PR #1152 (6a3541ffc), 2026-11-13
- T472 — onboarding reset also takes back unsynced git-data claim files the codec classes as canonical claims, under an entry and byte cap, reporting what it skipped; unknown files stay; lows in T657 — PR #1151 (ee2258d78), 2026-11-13
- T597 — owner decision: Resume on a failed mining step whose agents all finished re-runs only the apply from the saved replies (no agent bought again); a done row with no saved reply is marked failed in the same fenced write and re-dispatched; Retry keeps the full re-run; a fan-out loop step (`iterationCount > 0`) keeps the loop Resume arm; web shows "Resume (apply saved replies)" on structural columns only. Not live-checked: the only eligible steps on the dev install belong to cancelled tasks — PR #1149 (f3ce0c2aa), 2026-11-13.
- T532 — owner decision: module install sources are git-only (API body, client type, admin dialog); stored registry rows stay readable as unsupported, deletable with token and audit, fetch refused with 400 `module_source_kind_unsupported`; `module_sources` CHECK constraints kept for a later two-phase cleanup (migrate or delete remaining registry rows, then tighten in a new migration); api, worker and web reloaded — PR #1147 (548013da4), 2026-11-13.
- T541 — Cancel deletes the task's own skeleton, enriching or failed kb_author entry (Stop or a worker failure alone keeps it failed); both writes match the source task and user and skip approved entries; worker reloaded — PR #1148 (fccc9866a), 2026-11-13. Vector leftover in T582.
- T312 — verified 2026-11-13: detection already checks candidate directories (`01-env-detect.ts` ~:948, commit 257ca270d) and the own-code consumers ignore a missing include; inventory of the dev install (every stored `customCodePaths.include`, checked in the worker filesystem) found none missing. No change needed.
- T552 — owner decision: the server refuses a terminal or task shell for a disabled CLI provider (api and worker, close 4425 with a sentence to enable it); the web offers only enabled providers. Live: api, worker and web reloaded clean; refusal not probed live (no disabled provider on the dev install) — PR #1145 (477c2e00d), 2026-11-13. Open-shell revocation T654; lows T553.
- T653 — owner decision: error lines are not prose, FormError stays plain text; rule stated in markdown-rendering.md — PR #1144 (40233d3f4), 2026-11-13.
- T646 — terminal shells, built sandbox cores, the DDEV registry cache and the cli-sandbox base image carry `haive.install`; the core reaper filters on it and `runner.inspect` handles label-less images; live: worker reloaded, sweeps start clean — PR #1140 (97049b4c1), 2026-11-13. Lows T651.
- T645 — sandboxes reach an `ollama-gate` holding the daemon's names on the models network; only inference and read-only endpoints pass (exact raw method+path), the daemon leaves that network and the gate dials it as `ollama-daemon`; live-checked: admin calls 403 and never reach the daemon, claude-code through the gate succeeds, worker/api embed and tags unchanged, model list unchanged — PR #1136 (f2b1bc8d0), 2026-11-13. Leftovers T648-T650.
- T603 — plan-merge discard runs on its own transaction and commits its leftovers report before a second, re-checked teardown transaction; `integrateOrigin` keys its rethrow on an explicit phase; a busy revival warns; real-git and real-PostgreSQL controls — PR #1095 (d4df23f2c), 2026-11-12. Lows T623.
- T606 — the fake database honours conflict `setWhere`/`<=` and throws on unsupported options; refresh run ordering needs evidence; hidden-tab poll pause; viewer-role read retry; shared trigger labels — PR #1096 (e914dee4a), 2026-11-12. Items 3, 5, 12 recorded in T623.
- T608 — non-directory restore root is a conflict; one deduplicated, diagnosable re-sync warning; Refresh, 00a and Pull keep their outcome; settled count — PR #1097 (6dafbff3a), 2026-11-12. Items 5, 6 in T623.

- T619 + T621 — nine env-gated test files CI skipped now run in the Postgres-gated step (three stale assertions fixed), a ratchet requires a row or a verified workflow step for every env-gated suite, and the gated step is modelled at the measured 10 s per row (step 36 min, job 38) — PR #1093 (7c790dedb), 2026-11-12. Lows T623.
- T618 — no false Git Resync 409 from the sync tick; refused parent paths fail the record; stranded-bundle recovery and ingest rollback hold no transaction across the filesystem (claim, restore, compare-and-settle); one refusal parser; path-scrubbed reasons; composer refusals through MarkdownView — PR #1094 (74c7c7926), 2026-11-12. Lows T623.

- T590 groups C + D and lows 19, 21, 23, 27, 28 — provider form refreshes secrets per delete, sign-out poll aborts on leave, destructive env move waits 30 s for the lock only in its drop phase and re-reads scope under FOR UPDATE, `authGeneration` no longer returned, reconnect copy after a spent OAuth code, resumed sign-out cap copy — PR #1089 (1392c4ad0), 2026-11-12. Lows 20, 22, 24-26, 29-31 open; item 2 accepted.
- T617 + T614 items 3, 6, 7 — Undo merge holds the base branch ref lock across the working-tree move (`update-ref --stdin` transaction, two-tree `read-tree`), refuses old git, re-checks holders under the lock, retryable refusals for a switched base or open git operation, interrupted-move recovery, scrubbed git detail — PR #1090 (a3ce986e2), 2026-11-12.
- T591 — terminal and task-shell refusals after ownership checks accept and close with codes 4420-4424 (login unsupported 4411); the clients show a sentence per code — PR #1091 (c466edcff), 2026-11-12. Follow-ups T622.
- T588 items 1, 2, 3, 5 — lock timeouts map to a plain sentence at five step sites, one audit writer in `@haive/shared/audit`, api events carry `source`/`actorKind`/`fields`, no zero-delta scope events — PR #1092 (00cb73090), 2026-11-12. Item 4 (decision) and 6-9 open.

- T610 — two-install smoke logs why the project-state sweep held (refresh outcome, git operation marker, sync result; each probe bounded at 10 s, bound query errors redacted) on a failed sweep check — PR #1085 (98ac7dc4c), 2026-11-12. Investigation continues only if the hold recurs in CI.
- T612 items 1, 3, 4 — blank `HAIVE_PUBLIC_API_URL` / `HAIVE_API_PORT` fall through to the next source in web and api; nosniff on every inline byte route; raw-file SVG control shown red against the old headers — PR #1087 (a38e37d78), 2026-11-12. Item 2 open.
- T590 groups A + B — lock correctness 4, 6, 7, 15 (lock-loss detection with a 5 s bounded check, capped lock connections and hold bounds, teardown timeout, usage poller under the lock) — PR #1088 (23945153f); sign-out flow 8, 9, 10, 14, 18 (probe after sign-out, chown under the lock, bounded update retries, scope-change cap, window and copy; resumed job keeps its started state and scope) — PR #1086 (c9bf7b732), 2026-11-12. Groups C and D open.
- T329 part B — Undo merge: owner-clicked `POST /tasks/:id/merges/undo` moves a base branch back to `baseShaBefore` only while it is still the task's own merge commit (root claim, merge-dir lock, checkout fence; `reset --keep` in Haive's transient worktree, update-ref CAS otherwise; refusals for pushed merges, other worktrees, staged edits, multi-push remotes) — PR #1081 (a8d6a91e6), 2026-11-12. Race fix T617, lows T614.
- T615 — reset provenance counts a merge only when its `landedOn` equals the checkout branch the worker observes at reset start (migration 0231 `repositories.checkout_branch`) — PR #1082 (b72fd2ac3), 2026-11-12. Lows T619.
- T605 — closed by the owner 2026-11-12: task creation does no git or file work under the key (L1 map); the writer hold is accepted and documented under T604.
- T587 + T616 — Cancel, step abort and plan merge discard write the Retry-style `task.resumed` event and `task.admin_resume` row (best effort, savepoint) when they clear an administrator's pause; the api warns once at boot in cross-host proxy mode with an empty `HAIVE_TRUSTED_PROXIES` — PR #1084 (be18fe456), 2026-11-11. Lows: the api's hostname compare duplicates the web rule; a list of only invalid entries counts as configured.
- T611 items 1, 3-10 — Replace ZIP admission checks the bundle job outside its transaction and re-checks the row generation under the lock; catalogs parse before the write transaction; refused record leaves fail the replacement; stored bundle git failures and upload write/move 500s carry no paths; the composer shows API refusal reasons — PR #1083 (0de15fd1d), 2026-11-11.
- T609 — closed by the owner 2026-11-11: the chmod window between capture and removal is accepted (milliseconds, needs a person chmodding a Haive projection mid-move, result is only the earlier mode); no mechanism
- T329 part A + items 1-2 — a merge a cancel left committed on the local base is recorded (`merge.landed`, in the step-state transaction) and reported once under the merge-dir lock (`merge.left_committed`, banner), never undone; reset provenance counts it; cancelled push copy and step-retry guard comments corrected — PR #1080 (8256fdff6), 2026-11-11; full suite + PR CI green; part B open (E3)
- T435 — different web/API hostnames: browser session traffic goes through the web origin (`/api/haive`, `/ide`), cookies stay host-only; raw task files carry nosniff + CSP sandbox; cross-host throttle operator rule documented — PR #1079 (a51990ce9), 2026-11-11; full suite + PR CI green; editor origin open as T613
- T487 — every Replace ZIP needs an explicit mode; keep-until-success survives crashes through a durable replacement record and the stranded-replacement sweep — PR #1078 (ec585209f), 2026-11-11; migration 0230; full suite + PR CI green
- T310 — captured projection owner/mode stay durable in `project_state_outbox.kept_metadata` until a restore applies them; an absent path stays pending, a conflict warns once and stays owed, an atomic legacy handoff — PR #1077 (306f62e35), 2026-11-11; migration 0229; full suite + PR CI green (two-install rerun, see T610)
- T484 — all nine project-state row takes use `FOR NO KEY UPDATE`, so a child row's FK check (plan node, mirror row, task row) no longer waits for a project-state write (measured: lock timeout at 300 ms before, 3-15 ms after; delete, root claim and row writer still excluded) — PR #1074 (436bd881f), 2026-11-11. The task-creation key held across the same work is T605 (design).
- T343 + T199 — accessibility sweep: navigation actions are `LinkButton`s (no link wraps a button, the statistics module's Advanced statistics included), the sidebar rename input is out of its button, a `created` task reads "not started", plan panel close and tabs are named, `TabNav` sets `aria-current`, three overlays use the shared `Dialog`, dialog focus restore, depth stacking and a focusin trap guard, a keyboard-scrollable code preview, named plan-starter inputs with live progress, a keyboard combobox for the GitHub repo picker; a Haive "H" favicon (`src/app/icon.svg`) — PR #1073 (c8bc4e09d), 2026-11-11. T343 item 7 continues as T607.
- T446 — the claim-based descriptor-removal rule is kept and documented (`onboarding-upgrades.md` ~:739: 12 and 03 stage the removal when their commit box is ticked) — PR #950, verified on main 2026-11-11.
- T440 — the latest version and price refresh run is durable (`refresh_runs`, migration 0228, one row per kind: run id, trigger, start/finish, sanitized per-source errors and kill-switch skips; an older overlapping completion never overwrites a newer run; both writes best-effort); admin-only `GET /cli-pricing/refresh/latest` and `GET /cli-providers/catalog/:name/refresh-result`; `LatestRefresh` on `/admin/pricing` and the provider form (admins poll every 10 s; a page prefers its own job's result; the manual result still shows when the role read failed); docs model-pricing.md, error-diagnostics.md — PR #1076 (5f74b1a71), 2026-11-11. Follow-ups T606 (+12).
- T318 — task start admission (POST /tasks, Start next, spawn-plan, enrich, kb-author, upgrades, plan advisory, root-merge check) waits at most 5 s per repository/plan key or row lock and 1 s for the new-work fence, then answers 409 busy with nothing created (other `boundedLockWait` callers keep 30 s); worker revivals delay 30 s on lock expiry or an unreadable maintenance read, which now counts as held; `claimTaskStart` claims only `queued`; `mergeInScratch` runs on its caller's transaction; Plan Save/Pull report moved-aside merge leftovers in their own committed transaction before the merge; docs worker-restarts.md, merge-conflicts.md, plan-canvas.md — PR #1075 (e7f56b678), 2026-11-11. Follow-ups T603 (+5), T604 (design), T605 (design).
- T460 + T512 — Retry, Resume and dead-task revival refuse a task whose repository was deleted (409 `task_repository_deleted`), and revival applies the Retry/Resume holds whatever the stored status; `repositories.error_code` (migration 0225) classifies a repair-needed checkout, "Check repair" is check only and never rebuilds, and "Rebuild checkout" moves the old checkout aside and restores this install's settings, KB and plan data; recovery keeps the repair code until detection succeeds, stranded preparations keep it, and rebuilds are refused while an unfinished task (legacy setup-output pointer included) has a worktree under the checkout — PR #1065 (2c16ca95e), 2026-11-11; dev 0225 applied, 0 of 79 repositories flagged. Follow-ups T602. Owner check: when this install has no plan rows, recovery keeps the incoming plan files.
- T598 — Claude Code's `.claude/settings.local.json` ("don't ask again" saves the approved command verbatim, secrets included) is kept out of every Haive `git add -A` by a `**/.claude/settings.local.json` entry `ensureGitExcludeEntry` writes to `.git/info/exclude` next to `.haive/`; tracked copies still commit; not via the secret-mask globs, which `carry-untracked.ts` copies into worktrees — PR #1072 (b9482ff32), 2026-11-11.
- T580 — effort estimates calibrate on the LLM's recorded estimate (`hydrateAnchors` and `GET /tasks/estimation-accuracy` read the latest `estimate.recorded.aiHours`, not the column `06b-sprint-planning` overwrites); step 11 lists every learning and skill (sorted by id, up to 500, excerpts on the first 60, ids filtered and titles collapsed at build time, an omission line past the cap, an open-before-update line for title-only entries); the `learning-recorder` persona allows update and delete and defers to the calling step's output — PR #1047 (884f5c074, 2026-11-09) and PR #1070 (7578584bb), 2026-11-11. Item 1 closed, not a defect: the `.haive-data/` move recorded no dual-read, and re-onboarding migrates `.claude/learnings/`. Plan `sleep-paper-lessons` shipped apart from P3; further work continues in `docs/plans/agent-memory-lessons.md`.
- T270 + T497 — path-changing plan patches serialise per repository on a bounded advisory lock (409 `plan_busy`; update-only patches take none; worker callers retry busy; mirror flush keeps its base lock order); a failed plan merge stays visible after a reload (`failedMerge` on `GET /repositories/:id/plan/merge`) — PR #1067 (0df87b7c9), 2026-11-11. Follow-ups T596, T597.
- T291 + T323 item 4 — a file parked by a process death is put back after 24 h (ctime age, worker write-path sweep, bounded warnings, `.name` records for long leaves); RTK strip/append record before parking; complete/consumed upload rows deleted 90 days after `updated_at` (protected states kept) — PR #1063 (a49293f6e), 2026-11-10. T323 item 5 stays parked; follow-ups T592.
- T590 items 1, 3, 5 — CLI login-secret deletes take the auth-scope lock (409 `cli_auth_busy`, no generation advance); sign-out poll window past the shared 30 min cap (`CLI_SIGN_OUT_AUTH_WAIT_MS`); busy or settings-moved login upgrade closes with 4409/4410 and the modal says why — PR #1062 (0f52f236c), 2026-11-10. T590 stays open with items 2, 4, 6-18; follow-ups T591, T502 item 4.
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
