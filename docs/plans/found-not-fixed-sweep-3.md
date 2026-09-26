# Found-not-fixed sweep 3

> **In progress** (2026-09-26). Phase 0 shipped and live-verified: B0.1 (#326), B0.2 (#327), B0.3
> (#328) and B0.1b (#329, 04's MCP opt-in reaches the runtime). Track A under way: A1 shipped and
> live-verified (A1.1 #330, A1.2 #331, A1.3 #332, A1.4 #333, A1.5 #334, A1.6 #335); A2.1 shipped
> and live-verified (#336); A2.1b shipped and live-verified (#337); A2.2 in review.
> Track B's plan and its Phase 0 status live in `two-install-project-sync.md`.

## Context

Sweep 2 (`docs/plans/found-not-fixed-sweep-2.md`, #301-#325) shipped on 2026-09-26. Its final
report left an open found-not-fixed list (memory `found_not_fixed_running_list.md`). The user
asked for one PR per fixable entry. Every entry was re-verified on main `2a610d56` by three
read-only explorations; all are still present, several are worse than recorded, and a dozen new
defects surfaced (listed under "Found while planning" at the end, each mapped to its PR).

The "onboarded elsewhere" entry turned into a feature request. The user expects a committed sync
file from which a second Haive installation can restore onboarding, because two people working on
one project from their own installs will be common, and moving a project between installs "must
work and be synced correctly and fully". Today it does not: `docs/plans/amber-fencing-hopper.md`
slice 2 built a `.haive-data/{environment,tooling,exclusions}.json` mirror that is imported once
and never re-read, `.haive/install.json` is written but never read, and a second install cannot
upgrade at all. That work is Track B, planned in `docs/plans/two-install-project-sync.md`.

Plan file `compiled-noodling-squid` (2026-09-26), split into this doc and the Track B doc.

## User decisions (2026-09-26)

- **Rollback and later edits:** a rollback keeps a person's later edits (restore only while the
  file still holds exactly what the upgrade left; otherwise keep and warn).
- **Global KB Retry:** hide Retry unless the entry's source task is `failed`; keep the entry and
  its seed notes until the person deletes it.
- **Local cleanup (this machine only, no PR):** remove user `923dd28a`; the two deleted users'
  10 auth volumes and 2 empty `_uploads` dirs; the orphaned `p_99b39acba6d1` volumes; the 6 keys
  of the pre-rename `bull:task-queue:*` queue in the dev Redis. Each re-checked first: no row owns
  it, no container uses it.

Track B's decisions (onboarded elsewhere, sync commit policy, same-key conflicts, the AGENTS.md
rules block, CLI folders) are recorded in `two-install-project-sync.md`.

## Every PR

Same process as sweeps 1 and 2:
- worktree under `.claude/worktrees/`, then `pnpm install --frozen-lockfile --offline` and a
  shared/database build;
- a control that FAILS on today's code, then passes;
- Codex rounds until one brings no valid fix; reply and 👍/👎 on every thread; thread audit;
- CI green on the full sha, then main CI on the merge sha;
- sync main only with no running task, then confirm the restarted process (`etime`, ready line);
  `pnpm docker restart <svc>` when the watcher missed it;
- a zero-token live check with fixtures deleted after; queue smokes on `h1-smoke-pg`
  (127.0.0.1:55432) and `h1-smoke-redis` (127.0.0.1:6392);
- web PRs get a browser check at 375/768/1280;
- a docs commit updating the README row and plan banner; remove the worktree and branch after merge;
- the first PR of the series (B0.1) also adds `docs/plans/found-not-fixed-sweep-3.md` (this plan)
  and `docs/plans/two-install-project-sync.md` (Track B with its design detail), each with its
  README row, and moves the new entries into the running list.

## Order across tracks

1. **Phase 0, live exposure first** (from Track B, independent, small): B0.1 imported MCP servers
   inert until accepted (a security gap: a repository's server list reaches another install's
   CLI without the opt-in onboarding requires), B0.2 refresh-tree fetches and fast-forwards (it
   can destroy unpushed commits today), B0.3 the mirror import reads through fs-safe and applies
   `rtk_enabled`.
2. **Track A** (sweep 3 proper): A1 → A2 → A3 → A4 → A5; tracks interleave freely except where a
   dependency is named. A3 lands before Track B touches 01/02/04; A2 before B's merge-time work.
3. **Track B** phases 1-5 (repo copy `docs/plans/two-install-project-sync.md`).

## Track A1: orchestration (order A1.1 → A1.2 → A1.3 → A1.4 → A1.5 → A1.6)

Files: tq = `packages/worker/src/queues/task-queue.ts`, sr = `.../queues/stalled-redrive.ts`,
h = `.../queues/cli-exec/handlers.ts`, run = `packages/worker/src/step-engine/step-runner.ts`,
apiT = `packages/api/src/routes/tasks/index.ts`, steps = `packages/api/src/routes/tasks/steps.ts`.

- **A1.1 fix(api): a task Retry re-runs the step the task stopped on.** (Was "the pause gate
  gap".) Today the task Retry never resets a `failed` row: the walk reaches it, its first owned
  write is refused, and the task sits `running` with nothing queued until the re-driver fails it
  again. Before that refusal the row can still do real work (detect, a merge and push in
  `12-worktree-cleanup`, a deterministic apply). Replaying from START would also re-derive every
  stored loop_back and re-pay fix rounds. And the epoch bump has no status check, so a Cancel
  racing the Retry is revived.
  - One transaction mirroring the step Retry: end live runs (extract `cancelLiveRuns(tx)` from
    `lib/task-control.ts`, never call `stopActiveCliInvocations`/`settleActiveSteps` inside — a
    second pool connection waits on this transaction's locks, a hang Postgres cannot detect);
    `resetRowsForRerun(tx, …)` for `failed`/`running`/`waiting_cli` rows (+ the target's
    non-pending downstream at its round); other `waiting_form` rows → `pending` keeping their
    form (FOR UPDATE first); runtime-park rows un-parked, not failed; the status-message cleanup;
    bump `WHERE id AND status='failed'` (none → 409) to `running`, pointed at the target, epoch+1,
    clearing error, completion, allowance watch and pause; the NOWAIT post-bump sweep; a
    `task.retried` event. After commit: kill sandboxes only if a reset row was live, queue an
    ADVANCE at the new epoch. A task that never pointed at a step keeps today's START path.
    `moveTaskToStep` gains options instead of a copy. AGENTS.md "Worker restarts" updated.
  - Control: new `packages/api/test/task-retry-failed-step.test.ts` (failed current row → row
    `pending`, task `running`, one ADVANCE, no START — today the row stays failed and START is
    queued; a cancel landing before the bump → 409 and nothing reset — today `queued` + START; a
    runtime-park row is not failed, its marker folded and cleared, detect output kept — today
    failed). Update `tests/e2e/tasks/actions-api.spec.ts` and
    `packages/api/test/task-retry-parked-smoke.ts`.
  - Live: global pause on, a throwaway task with a failed CLI step; Retry parks it paused, no
    invocation, no re-fail after 6 minutes.
- **A1.2 fix(worker): an advance never runs a `failed` row.** Defence in depth for every other
  path: `handleAdvanceStep` finishes a `failed` current row through `finishFailedStep` (what the
  re-driver does five minutes later), and `advanceStep` short-circuits `failed` like done/skipped.
  Every legitimate re-open changes the row's status first (step Retry, both Resumes, `retry_ai`,
  CLI switch, allowance auto-resume). Control: `task-job-epoch.test.ts` (today `advanceStep` runs).
- **A1.3 fix(worker): boot hands a dead worker's active jobs back at once.** New
  `queues/boot-requeue.ts` `requeueOrphanedActiveJobs(queue, accept)`: only when
  `getWorkersCount() === 0` (fail closed on error or any worker), `moveToWait('0')` each active job
  (token '0' skips the lock check; the stale lock is overwritten at next pickup). Task queue: all
  jobs; cli-exec: INVOKE and REFRESH_VERSIONS only. Runs in `index.ts` before any Worker of this
  process starts. Controls: `boot-requeue.test.ts` (fake queue) and `boot-requeue-smoke.ts` on
  Redis 6392 (a job held by a closed worker is picked up in seconds, not 30 minutes; nothing moves
  while a second worker is connected).
- **A1.4 fix(api): a task meant to start is `queued` until START claims it.** New
  `lib/task-start.ts` (`markQueuedForStart`, `enqueueStart`), flipped `created → queued` right
  before each START enqueue and after every write that can fail: POST /tasks, the start action,
  global-kb enrich, the upgrade rollback, `spawnPlanTask` (only when it enqueues). Never insert
  `queued`. After the flip a failed enqueue answers 201 (the re-driver owns the start). Controls:
  `spawn-plan-task-seed.test.ts` order, new `task-create-start.test.ts` (enqueue rejects → 201 +
  `queued`; today 500 + `created`); `tests/e2e/tasks/create.spec.ts` expects `queued`.
- **A1.5 fix(worker): a recovery hint lands only on the failure it describes.** Fence both
  `recordFailedStepHint` writes (row `failed` AND task at the epoch still `failed`), the done-branch
  hint (owned update + task FOR SHARE under `taskWriteTarget`), and the login-required hint in `h`
  (lock the run while not superseded, then the row). Controls: `task-job-epoch.test.ts` (a Retry
  during the teardown gets no stale outage hint), `cli-exec-completion.test.ts` (no login hint for a
  superseded run). Live: `error_hint` on `pending`/`skipped` rows stays 0.
- **A1.6 fix(worker): the allowance auto-resume takes its locks in the documented order.**
  `autoResumeFailedStep` (`queues/_step-reset.ts` ~196-340) writes task → runs → steps, the
  reverse of runs → steps → task, so it can deadlock against a Retry or a Stop. Reorder with the
  task claim last (its `status='failed'` guard still decides; a lost claim rolls the transaction
  back). Control: a fake-db order assertion in the existing auto-resume test.

## Track A2: merge fixer (A2.2 needs A2.1)

Files: GM = `packages/worker/src/step-engine/git-merge.ts`, MR = `.../merge-resolver.ts`,
DE = `.../dag-executor.ts`.

- **A2.1 fix(worker): a discarded merge fixer ends in a clean abort or a clear halt.** No change
  to what a successful merge commits.
  - `unmergedPaths(dir)` with `-z` (today a quoted name reads as deleted and its conflict
    markers get committed); `abortMerge(dir)` (no MERGE_HEAD is success; on refusal restore the
    staged-and-edited paths from the index with `GIT_LITERAL_PATHSPECS=1`, abort again, else
    report the blocking paths); `openMerge(dir, ref)` distinguishes a conflict (MERGE_HEAD equals
    the ref) from a merge git refused (today read as a conflict and sent to a fixer).
  - Every MR and DE abort site uses `abortMerge`; a failed abort halts with a
    `merge.abort_failed` event and never dispatches into a half merge; a stale or foreign
    MERGE_HEAD is aborted before the next merge. Never write when the merge dir is under
    `HOST_REPO_ROOT` (the worker's `/host-fs` mount is read-write; fix the stale comment in
    `resolvers.ts` ~544-546): halt instead.
  - Controls: `git-merge.test.ts` (quoted conflicted name keeps MERGE_HEAD; recovered abort;
    refused merge is `error`), `12-worktree-cleanup.test.ts` (a never-answered fixer that edited a
    cleanly merged file: today the next fixer inherits the half merge), `dag-executor.test.ts`.
    Live: a `smoke:dag-auto-resolve` variant (stub fixers, zero tokens).
- **A2.1b fix(worker): the plan merge reads its conflicted names with `-z`.** Found after A2.1
  merged: `plan/merge.ts` `conflictedPaths` is a second reader of a merge's unmerged paths and
  still reads them quoted, so the plan-merge agent is handed a name that opens no file. Reads
  through `unmergedPaths`; the plan-merge prompt lists only names that fit on one line
  (`isSingleLine`, `survivesFence`, no U+FFFD) and counts the rest, since `-z` no longer
  quotes a newline. Controls: `merge.test.ts` (a quoted conflicted name comes back as itself),
  `plan-merge-passes.test.ts` (a name holding a newline opens no prompt line).
- **A2.2 fix(worker): a fixer's changes outside the merge are moved aside, never committed or
  lost.**
  - `captureFixBaseline(dir)` after the merge (re)opens and before dispatch (untracked set via
    `ls-files -o -z`, capped with an overflow flag; worktree-vs-index blobs via
    `hash-object -w`); stored in `onInserted` beside the invocation id as
    `MergeResolveState.fixBaseline` / `LevelMergeState.fixBaseline` (jsonb shape only, no
    migration; `readMergeState` carries it; cleared where the invocation id is cleared). A capture
    failure never throws.
  - `relocateFixerChanges`: tracked paths changed since the baseline move to
    `<root>/.haive/merge-leftovers/<task>/<inv>/` and are restored; then new untracked paths move;
    a `manifest.json`; `renameNoFollow` from `workspaceAnchor`, `noReplace`; links reported,
    never followed; `ensureGitExcludeEntry` first; under `HOST_REPO_ROOT` report only.
  - Discard: relocate, then `abortMerge`. Success: relocate, then `git add -A -- <unmerged>`
    (chunked, literal; skipped when empty), then `commit --no-edit` — before the DAG pass, the
    squash, the base-sync merge and worktree removal. `removeBaseWorktree` without `--force`
    (a dirty tree is kept and reported). Events `merge.fixer_leftovers` plus a step warning.
  - Controls: `12-worktree-cleanup.test.ts` (discard and success: strays relocated, merge commit
    holds only merge paths — today `add -A` commits them), `dag-executor.test.ts` (baseline
    survives a state round trip), a dirty base worktree kept (today force-removed).
  - Rollback: revert A2.2 before A2.1; leftover folders stay excluded from git and are listed.

## Track A3: upgrade and rollback (order L → G → M(b) → I → J → H → M(a))

Files: 01/02/03/04 = `packages/worker/src/step-engine/steps/onboarding-upgrade/0N-*.ts`,
TM = `packages/worker/src/step-engine/template-manifest.ts`, RF = `.../steps/onboarding/_rules-files.ts`,
UPG = `packages/api/src/routes/upgrades.ts`, DM = `packages/worker/src/data-migrations.ts`.

- **A3.1 (L) fix(api): a rollback names the upgrade it rolls back, and one upgrade or rollback
  runs at a time.**
  - UPG: `latestUpgradeToRollBack(db, repoId, userId)`: newest completed `onboarding_upgrade`
    whose `metadata.mode !== 'rollback'`, filtered in JS (the fake DB refuses `->>`); the route
    (UPG ~601-626) uses it for the 409 and the metadata; `lastUpgradeRemovedFiles` reads it too.
  - The rollback route and POST /tasks `onboarding_upgrade` answer 409 while another
    `onboarding_upgrade` task of the repo is live: today a second Roll back click rolls the same
    upgrade back twice, and an upgrade parked on 02's form can apply over a rollback.
  - Control: `packages/api/test/upgrade-rollback-offer.test.ts` on `createFakeDb`: upgrade then
    rollback → metadata names the upgrade (today the rollback); only rollbacks → 409; a live
    upgrade → 409 (today 201).
- **A3.2 (G) fix: upgrade-status sees body changes to the templates it renders empty.**
  - Five items hash `sha256('')` forever (three `plugin.drupal-php-lsp.*`, two `rtk.*`), so a
    body change never raises the banner. `TemplateItem.referenceCtx?` (shared
    `templates/manifest.ts`), used by `buildManifest`; set on those five only (plugins:
    `lspLanguages: ['php']`; RTK: `rtkEnabled: true`, every CLI). `agents-index` stays exempt
    (`REFERENCE_HASH_EXEMPT`, per-repo body); fix the stale comment at TM ~208-213.
  - DM `convergeReferenceHashes`: for each such rendering, rows (live and superseded) with
    `template_content_hash = sha256('')` AND `written_hash` = today's render hash AND the item's
    schema version get the new hash. Convergent, idempotent, drizzle builder (fake-DB testable),
    registered first; ideally in the same transaction as the manifest-cache sync.
  - Control: `template-manifest.test.ts` (no item hashes `sha256('')` except the exempt list —
    fails on 5 ids today; unique ids; unique disk paths under a maximal context);
    new `reference-hash-convergence.test.ts`.
  - Revert is NOT plain: record the five new hashes in the PR; a revert ships the inverse UPDATE.
- **A3.3 (M(b)) refactor: the RTK settings paths come from `RTK_SETTINGS_FILES`.**
  - 07 writes the manifest's RTK renderings through `writeIfAllowed`; api `repos.ts`
    `ONBOARDING_SETTINGS_FILES = RTK_SETTINGS_FILES.map(...)` (typed `readonly string[]`);
    12's stage list becomes the three rules files (a settings file stages through its live row)
    and its ignore set adds the table's paths; the same ignore set in 03 (~366-370).
  - Control: `packages/shared/test/rtk-settings-paths.test.ts` (no settings-path literal outside
    `rtk-settings.ts`; 5 today); `post-onboarding-stage.test.ts`: an untracked
    `.gemini/settings.json` with no row stays out of the commit, an excluded recorded one is
    reported, not force-added.
- **A3.4 (I) fix(worker): a rollback keeps a person's later edits.** (User decision.)
  - 04 `restoreIfUpgrades(repoPath, rel, kind, leftHash, content)` on `rewriteFileIfNoFollow`
    with the 1 MiB cap: bytes (or the region) hash to `leftHash` → restore; already equal to the
    prior bytes → counts as put back; absent file or region → stays absent (never creates one);
    judge never ran → not compared; else kept. `leftHash` = the upgrade row's
    `lastObservedDiskHash ?? writtenHash`, read by `upgradeArtifactId` in apply (old detect
    payloads keep working). A kept path: warn, retire the upgrade row, put a `rollback` copy of
    the prior row live, not counted in `revertedCount`. Delete `readFileOrEmpty` (no other caller).
  - Control: `upgrade-rollback-undo.test.ts` (edited file kept; deleted file and deleted
    AGENTS.md stay absent — both recreated today; region edit kept; untouched restored; retry
    counted; a save racing the judge survives). Smoke: `smoke:upgrade-claims` extension.
- **A3.5 (J) fix(worker): one 1 MiB cap on every upgrade read.**
  - `RULES_FILE_READ_CAP` is the one cap. `readForUpgrade` → absent | oversized | text via
    `readFileNoFollow({ strict, maxBytes })` (never `readTextNoFollow` with `maxBytes`: it drops
    the truncation flag). 01: oversized/refused → `hash: 'oversized'`, content withheld,
    `oversized: true`; presence keys on `diskHash` (01 ~392, ~464-473); backfill and RTK probe keep
    skipping null content. 02: oversized conflict offers only Keep/Skip; Keep refuses to record;
    `removeIfHaives` and the hook strip pass `maxBytes`; the two write branches skip an
    oversized/refused file with a warning; `restoreRulesImportStubs` threads the cap (07's
    unguarded call stays uncapped). 04 `restoreRemoved` capped. UPG ~132 capped.
  - Control: plan-classify (1 MiB + 1 is never absent), apply-helpers (over-cap Haive bytes
    kept; today removed), `rules-import-stub.test.ts`, upgrade-status (render + 1 MiB of newlines
    not reported).
- **A3.6 (H) fix(worker): 02 records before it writes, so a retried apply reproduces attempt 1.**
  - `earlierRecords` (replaces the removal-only lookup, same filter, also selects
    `writtenContent`); `recordPreimage(entry, bytes | {absent: 'file'|'region'}, claim)`
    inserted superseded BEFORE each write: reuse an earlier record when the disk holds the render;
    a marker (template hash = written hash, so no boot migration matches it) for a created path,
    linked only through `createdPaths` (never `retiredRowIds`: a null `writtenContent` there
    reads as a legacy row); no record only for "no live row and disk already holds the render";
    otherwise a preimage (clean updates included). Re-stamp preimages in the transaction; drop
    this task's own 02 rows from `retiredRowIds` and `createdPaths.retiredRowId` (fall back to
    the plan's `liveArtifactId`). 04's legacy branch filters other tasks' 02 records.
  - Control: new `upgrade-apply-retry.test.ts` (fail once after the transaction via a `.haive`
    link, once inside it; after the retry `createdPaths` and `retiredRowIds` are right — today
    empty / naming attempt 1's rows); `upgrade-claims-smoke.ts` fail-retry-rollback round trip.
- **A3.7 (M(a)) fix(worker): a rollback puts back the RTK blocks 02 stripped.**
  - RF `withoutRtkBlocks` returns `{ text, blocks }`; `stripRtkBlocks` moves onto
    `rewriteFileIfNoFollow` and records each strip (A3.6's `recordPreimage`, kind `rtk-block`)
    inside the parked edit; 02 output `rtkBlockStrips` (declared last); 04 restores only while no
    RTK block stands (an equal block counts as put back; an absent file stays absent); strips
    count toward "reverted" and the rollback offer (`lastUpgradeRemovedFiles` renamed). The
    `@AGENTS.md` stubs are NOT undone (that would break AGENTS.md loading again).
  - Control: `rtk-block-strip.test.ts`; `upgrade-rollback-offer.test.ts` (a strip-only upgrade
    is offered — not today); `rtk-off-upgrade-smoke.ts` (blocks come back; a block deleted while
    the form was parked does not; a standing block is kept).

Shared rules for A3: one "hash the way the plan compares" helper for whole file / rules region;
new top-level output fields declared last; `retiredRowIds` keeps one meaning (rows a rollback may
restore); every payload persisted before a PR still replays.

## Track A4: storage, images, dev tooling

- **A4.1 fix(worker): a repo-less task runs for a user who has no repository yet.**
  `ensureTaskScratchWorkspace` (`packages/worker/src/repo/scratch-workspace.ts`) anchors on
  `<storage>/<userId>`, which `walkDir` never creates (`packages/shared/src/fs-safe.ts` ~207):
  a first-ever `kb_author` task fails ENOENT. Ensure the anchor with
  `ensureDirNoFollow(REPO_STORAGE_ROOT, userId)` first. Control:
  `packages/worker/test/scratch-workspace.test.ts` with a temp root lacking the user dir
  (throws today).
- **A4.2 fix(worker): a provider's row names its image only once the image is built.** Build
  start overwrites `sandbox_image_tag` (`queues/cli-exec/handlers.ts` ~656-666), so a failed build
  to a new tag orphans the old image and a later success removes the FAILED tag as "previous".
  Write only the status at start; on success swap the tag under FOR UPDATE and remove the tag the
  row held before; on failure leave the tag alone. Readers checked: dispatch recomputes the tag
  from config (`images.ts` ~92-129); the removal refcount and `markProvidersReady` read the row;
  boot reset keys on status. Control: `sandbox-image-remove-race.test.ts` `heldBuild` harness
  (fail to a new tag, then succeed: the older image is removed — today it is left).
- **A4.3 fix(worker): the auth-volume reaper also takes volumes whose provider or user is gone.**
  `auth-volume-reaper.ts` only selects per-task volumes, so an isolated provider's `p_<id>`
  volumes and a deleted user's per-user (and `_k_`) volumes keep CLI credentials forever
  (measured: `p_99b39acba6d1` pair, 10 volumes of two deleted users). Select a volume whose id
  slug matches no live provider (for `p_`) or user (per-user/api-key) row, reusing the existing
  stopped-container and remove steps; never a task volume (unchanged path) or a live owner's.
  Control: the reaper's pure selector test (orphan picked, live owner kept, task volume
  untouched).
- **A4.4 chore(dev): the api and worker watchers poll the bind mount.** `tsx watch` misses
  changes over the WSL2 bind mount (seen again after #325's pull). tsx 4.23.12's bundled chokidar
  honours `CHOKIDAR_USEPOLLING`/`CHOKIDAR_INTERVAL`; set them (`true`, `1000`) for api and worker
  in `docker-compose.dev.yml`. Live check: a pull that changes worker source restarts it without
  `pnpm docker restart`; idle CPU of both containers before/after (`docker stats`), reverted if
  the cost is material. Libs/migrations keep their documented steps.
- **A4.5 chore(worker): one copy of the persona-recheck comment in `exec-core.ts`.** Three
  identical paragraphs (~436-450) collapse to one; the agent-mask paragraph (~431-435) moves
  above the masks (~457). No control needed (comment only).

## Track A5: web, e2e harness, KB, plan snapshot

- **A5.1 fix(web): the tasks list fits a phone.** `app/(app)/tasks/page.tsx` row: below a
  36rem card (`@container`), the row and cluster wrap, the title takes `flex-1` with a
  `min-w-[min(8rem,100%)]` floor, the badge group may shrink, repo/step badges truncate inside
  `max-w-full` with a `title`, the repository `<select>` is capped. Desktop classes untouched.
  Control in `tests/e2e/tasks/phone.spec.ts`: at 375 and 768 no page overflow, title ≥ 80px,
  timestamp and badges do not intersect; a 1280 guard. Browser check at 375/768/1280.
- **A5.2 fix(web): the Terminal tab says why it is unavailable.** `InteractiveShell`'s
  "preparing" and "task has ended" views are unreachable: the task page disables the tab and
  jumps off it (`tasks/[id]/page.tsx` ~1128-1130, ~1928). Remove the jump and the disabled
  flag so the existing views render (with the link to the repo terminal); copy "enables
  automatically" → "connects automatically". Control in `tests/e2e/tasks/detail.spec.ts`: a
  completed task's Terminal tab shows the ended view and its link.
- **A5.3 fix: the global KB page offers Retry only while its task can be retried.** (User
  decision.) The entries API adds `sourceTaskStatus` from an owner-scoped query on `tasks` (the
  KB rows live behind `withGlobalKb`, no join); the page shows Retry only for `failed`, keeps
  Go to task and Delete. Controls: an api vitest on the entries route; a web unit or e2e check.
- **A5.4 fix: the plan page says when the snapshot files are missing.** `routes/plan.ts` ~342
  answers `snapshotState: 'updating' | 'missing' | 'written'` (keeping the boolean); the page
  shows "Snapshot missing" (title: Save plan rewrites and commits them) instead of a permanent
  "updating…". `tests/e2e/helpers/plan.ts` `seedPlan` inserts a `plan_mirror_state` row 1/1.
  Controls: an api vitest per state; `plan/tree.spec.ts`.
- **A5.5 test(e2e): fixtures are removed even when a spec times out.** A spec's own `finally`
  never runs after a timeout (Playwright stops awaiting the body). New
  `tests/e2e/helpers/fixtures.ts` on `base.extend`: `users.register()` records each user; its
  teardown (own timeout) deletes the user's tasks, deletes repos and providers through the api,
  then `cleanupUser`. Backstop: `registerUser` appends to a run file and a config-level
  `globalTeardown` purges recorded ids still present. `cleanupTaskFixture` becomes one
  `delete from tasks` (steps and events cascade); fixture tasks seed `updated_at = now()`.
  Migrate the specs that seed running tasks first. Control: an opt-in harness project whose spec
  seeds a user and a running task and then times out; the teardown check asserts both are gone.

## Track B

Planned in `two-install-project-sync.md`: Phase 0 (B0.1-B0.3) first, then phases 1-5 after
Track A where the order above names a dependency.

## Local cleanup (approved; this machine only)

Run once Track A is under way, each item re-checked first (no DB row owns it, no container uses
it), removed by literal name: user `923dd28a` (the e2e `cleanupUser` statements); the 10 auth
volumes of deleted users `0e2b35cd`/`55be667d` and the orphaned `p_99b39acba6d1` pair — ideally
by A4.3's first sweep, which doubles as its live check; the two empty `_uploads/<user>` dirs
(`rmdir`); the 6 `bull:task-queue:*` keys in the dev Redis.

## Not planned (reasons recorded in the running list)

- **Codex reads only the first 32 KiB of AGENTS.md:** measured on this install, the largest
  AGENTS.md is 16.4 KB with the rules region at line 20; Haive's own runs get the rules injected.
- **The untrusted fence at five sites:** decided; merging flattens deliberate per-site wording.
- **The web unit suite's one exit 1:** no reproduction to act on.
- **A before/after pair scrolling as one:** the working fix (`w-max`, no per-cell scroll)
  widens both halves for one long line and pushes "after" off-screen; today's per-cell scroll
  keeps both in view.
- **Pruning empty per-user storage dirs:** tidiness only, and it races concurrent creators
  (uploads, scratch, clones) into ENOENT failures; A4.1 fixes the real bug it exposed.
- **`agents-index` hash:** its body is per repository; the per-repo upgrade plan already sees it.

## Verification

- **Per PR:** the control fails on main and passes on the branch; Codex looped clean; CI green on
  the full sha; main CI green on the merge sha; the live check listed with the PR, zero tokens,
  fixtures removed and counted back to zero.
- **After Track A:** re-run the touched smokes on `h1-smoke-pg`/`h1-smoke-redis`
  (`upgrade-claims`, `rtk-off-upgrade`, `stalled-redrive`, `boot-requeue`, the
  `dag-auto-resolve` variant, `worker-kill-resume`) and count fixtures back to zero; on the dev
  DB: 0 live runs on `pending` rows, 0 `error_hint` on `pending`/`skipped` rows, 0 orphaned auth
  volumes, `template_manifest_cache` holds `sha256('')` only for `agents-index`.
- **After Track B:** `smoke:two-install` with an empty gap list in CI, plus the live two-install
  check above.
- **Memory:** each running-list entry moves to Closed with its PR; a series memory records PR
  numbers, decisions and review outcomes.

## Rollback

- Every PR is a plain revert except: **A3.2** (record the five new reference hashes; a revert
  ships the inverse UPDATE, or reverted code re-syncs `sha256('')` and spurious offers appear),
  **A2.2** (revert before A2.1; leftover folders stay excluded from git and are listed),
  **Track B migrations** (additive; `task_id` nullability undone by deleting marker rows then
  `SET NOT NULL`; no enum values added), and Track B behaviour behind
  `PROJECT_STATE_SYNC_ENABLED` (off = legacy fill-if-absent import only).
- Nothing in this series deletes data a person wrote: moves go to excluded folders, refusals name
  what they refused, and every destructive git operation (`rm -rf` refresh, `--force` worktree
  removal, wholesale `--theirs`) is removed rather than added.

## Found while planning (added to the running list at the first PR; each has a PR above unless noted)

- Task-level Retry: never resets a `failed` row; replays stored fix-loop verdicts from START;
  its epoch bump has no status check (a racing Cancel is revived) — A1.1/A1.2.
- `autoResumeFailedStep` locks task → runs → steps — A1.6.
- Merge: quoted unmerged names commit conflict markers; a refused merge is read as a conflict;
  `merge --abort` itself can be refused; the worker's `/host-fs` mount is read-write while a
  comment says otherwise — A2.1.
- Six manifest items hash `sha256('')` (five fixed in A3.2, `agents-index` exempt by design).
- A double Roll back click, and an upgrade parked on its form applying over a rollback — A3.1.
- Upgrade write-branch reads are lenient (a failed read counts as absent) — A3.5.
- `ensureTaskScratchWorkspace` never creates its anchor — A4.1.
- Isolated-provider and deleted-user auth volumes are never reaped — A4.3.
- The mirror import hands a repository's MCP server list to another install without opt-in —
  B0.1; `refresh-tree` can destroy unpushed commits and `.haive/worktrees` — B0.2; the import
  follows links and ignores `rtk_enabled` — B0.3.
- `.haive/install.json` is written by three steps and read by none; plan edits can be reverted by
  a flush after a non-Pull checkout move; a plan flush can write mid-merge; `autoResolvePlanFiles`
  runs only in plan merges; 01-env-detect's project-name fallback can put the repository UUID into
  committed files — Track B (the last one: B1.4 audits the fallback).

## Checkpoints (events, not PRs)

- Dependabot's first npm run after the 2026-09-25 16:19Z window (weekly, no day set: Monday
  2026-09-28 at the earliest): green, and it opens the group PRs.
- The release actions (setup-buildx 4.4.1, build-push 7.4.0): the next `-rc` tag.
- `onboarding_run_checkpoints` rows (invariant-citation effect, fs-safe workflow checks, per-run
  `agent_rules` stamp, #229's upgrade check).
