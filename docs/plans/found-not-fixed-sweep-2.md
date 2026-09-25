# Found-not-fixed sweep 2: the recovery hand-over, and what sweep 1 left

> **IN PROGRESS** since 2026-09-25. PRs 1-11 and 14 merged (#301-#312); PR 15 (a sibling build never
> marks a tag ready while a forced rebuild of it runs) is in review. Tracked in the status table of
> `docs/plans/README.md`, which each PR updates.

## Context

Sweep 1 (`docs/plans/found-not-fixed-sweep.md`, #267-#300) shipped on 2026-09-25. The parallel
recovery session finished the same day (H1-H8, last #297 `1bd479f2`) and, at the user's request,
handed its open list to this session. The consolidated list lives in memory
`found_not_fixed_running_list.md` ("Found during the recovery series" and "Found during the
found-not-fixed sweep"); every entry below was re-verified against `1bd479f2`.

Three exploration passes and three design passes went over the code. What changed on inspection:
- A lost cli-exec job cannot be re-queued from its row (`cli_invocations` stores no spec), so the
  waiting_cli re-driver has to do what boot recovery does: end the orphan, re-drive the step.
- The merge fix prompt never asks for the `{status}` JSON `parseFixResult` reads, so the
  "uncertain → ask the user" path can never fire (NEW).
- The task-level Retry does not clear the allowance watch (NEW).
- e2e `repos/create.spec.ts` clones a real repo and deletes it by raw SQL: that is where the orphaned
  repo storage comes from. Separately, `DELETE /repos/:id` takes no root claim, so a delete during
  a clone can leak the checkout (the clone handlers hold a `rebuild` claim, `clone.ts:286`) (NEW).
- 02's obsolete cli-rules strip creates and commits an EMPTY `AGENTS.md` when the file is absent:
  `readFileOrEmpty` gives `''`, `upsertRegion('', '')` returns `''`, and the path goes to
  `writtenPaths` (`02-upgrade-apply.ts:617-626`, `cli-rules.ts:200-216`) (NEW).
- The `ws` specifier gap does NOT break a frozen install: the root override is what pnpm records, and
  `platform-checks` ran `--frozen-lockfile` green on 2026-09-21 with the same manifests.
- `onboarding_artifacts.task_id` is NOT NULL, so the blank scaffold cannot record a row; its seeded
  RTK files are recognised by their bytes instead, the backfill's existing rule.

Repo copy: `docs/plans/found-not-fixed-sweep-2.md` (NOT this file's slug, which is the shipped
agent-rules plan in `docs/plans`), with a README status row each PR updates.

## User decisions (2026-09-25)

- **Merge fixer:** only a fixer that finished cleanly commits. One that crashed, timed out or failed
  on its own has its merge aborted and is dispatched again, spending an attempt. A clean finish
  commits even with no JSON report. H6's rules for superseded runs stay.
- **Ended tasks:** Skip, Retry and the fan-out Resume refuse a `cancelled` or `completed` task,
  matching the task page, which already hides every step action on both. (First answered "cancelled
  only"; switched once it turned out the UI already refuses completed tasks for a stated reason.)
- **Edited settings.json with RTK off:** the upgrade offers "remove the RTK hook" per file, unticked
  by default; picking it removes only that hook entry, and a rollback restores the bytes.

## Every PR

Same process as sweep 1:
- Worktree under `.claude/worktrees/`, branch, PR, merge commit.
- A control that fails on today's code, then passes.
- Codex rounds until one brings no valid fix, then a thread audit.
- CI green on the full sha, then main CI on the merge sha, read from the API.
- Sync main only with no live task; confirm the worker's ready line after a worker change.
- A zero-token live check, fixtures deleted after. Queue smokes use their own Postgres/Redis
  (`h1-smoke-pg` 127.0.0.1:55432, `h1-smoke-redis` 127.0.0.1:6392, kept from the recovery series).
- Web PRs: a browser check at 375/768/1280.
- A docs commit per PR updating the README status row and this plan's banner.
- Remove the PR's worktree and local branch right after the merge.

## PRs, in order

Dependencies: 3 and 6 need 2. 5 needs 4. 10 needs 9. 12 and 13 need 11. 16 needs 15. 20 goes after
19. Everything else is independent. 1 goes first so every later PR's lockfile is checked; 2-8 are
the silent-failure class and go before the rest.

### CI signal

1. **ci: install from the lockfile as committed.**
   - `ci.yml` (4 installs) and the api, web, worker and updater Dockerfiles switch to
     `--frozen-lockfile`; `COPY pnpm-lock.yaml*` becomes `pnpm-lock.yaml`, so a missing lockfile fails.
     `docker-compose.dev.yml` stays unfrozen: it installs into the developer's own tree.
   - First prove a frozen install passes on a scratch copy (`git archive | tar -x`, then
     `pnpm install --frozen-lockfile --ignore-scripts --offline`), and `docker build --target deps`
     for each image, since api/web/worker copy no updater manifest while the lockfile has that
     importer. If one refuses, copy the manifest in rather than unfreezing.
   - Control: a throwaway commit that bumps a dependency in a manifest alone fails the install step;
     drop it before review.

### Orchestration (worker and api)

2. **fix(worker): START claims the task, or does nothing.**
   - `handleStartTask`: resolve the context, build the run list, then claim in ONE statement:
     `UPDATE tasks SET status='running', started_at=coalesce(started_at, now()), completed_at=NULL,
     current_step_id=:first, current_step_index=:idx, current_round=0 WHERE id=:id AND status IN
     ('created','queued') AND orchestration_epoch=:ctxEpoch RETURNING id`. Nothing claimed → log
     `start-task skipped` and return. `held.ctx`, the `task.running` event and the pause/direct
     branches run only after the claim. The forward walk already takes its round from the finished
     row (`task-queue.ts:1187`), so pointing at `steps[0]`/0 changes no walk.
   - Setting the pointer in the claim also fixes an existing bug: after a task Retry under a pause,
     START's advance for `steps[0]` hit the done branch with the pointer still on the failed step and
     was dropped, leaving the task `running` with nothing queued.
   - The job catch: a START with no `held.ctx` fails the task only while it is `created`/`queued`
     (`markTaskFailed` takes an optional status list), so a stale START can no longer fail and reap a
     task a repo deletion cancelled.
   - Dropping stale STARTs removes START's redelivery as a recovery path, so the stalled re-driver
     also takes a `done`/`skipped` current row older than the cutoff with no job as a lost hand-off
     (candidate `or` and the fence's re-check); its advance takes the existing done/skipped branches.
   - Controls in `task-job-epoch.test.ts` (first make its fake read `=`/`in` as admit and `not in` as
     refuse, and let tests set the task pointer): START on a running/waiting_user/failed/cancelled
     task does nothing; a throwing `resolveTaskContext` on a cancelled task writes nothing; a paused,
     retried task with `steps[0]` done queues its successor. `stalled-redrive-smoke`: a stale `done`
     current row with no job gets one advance at epoch+1.
   - Live: a hand-added START for a throwaway task parked on a form logs the skip and changes nothing;
     with the global pause on, retrying a failed task parks its first unfinished step as paused.
3. **fix(worker): one re-driver for a lost START and a lost cli-exec job (after 2).**
   - The boot branch that ends orphaned unstarted runs and re-drives the step (`task-queue.ts`
     ~2715-2830) moves verbatim into an exported `redriveParkedStep(db, s, queued, deps, bornBefore?)`;
     `bornBefore` adds `created_at < bornBefore` to the unstarted-run read and its end write. Boot
     calls it unchanged; `readQueuedInvocationIds` is exported.
   - `stalled-redrive.ts` gains two candidate sets on the task-queue read it already makes:
     (a) `status='queued'` older than the cutoff with no task-queue job → re-enqueue START (2's claim
     makes a duplicate a no-op); `created` stays excluded, since deferStart and `enqueue:false`
     drafts wait there on purpose. (b) a running task whose current row is `waiting_cli`, both older
     than the cutoff, with an unstarted run older than the cutoff, no live started run and no
     task-queue job → read the cli-exec ids once (skip on a failed read), skip a step whose old
     unstarted runs all still have a job, else `redriveParkedStep(..., cutoff)`. Mining steps behave
     exactly as at boot; delayed holds (pause, agent cap, runtime reserve) count as having a job.
   - Controls in `stalled-redrive-smoke` (all fail today): a stale queued task gets one START, a
     queued task with a job / a fresh one / a stale `created` one get none; a waiting_cli row with an
     old jobless run has it ended, the epoch bumped and one advance queued; a run with a job, a young
     run, or a live started sibling is untouched; a mining step with two lost runs and one with a job
     ends two and queues one advance.
   - Live: a throwaway failed task set `queued` and paused, `updated_at` 10 minutes back, is claimed and
     parks paused; on a paused task parked `waiting_cli`, removing its delayed cli-exec job gets the
     run ended and the step re-driven within one sweep.
4. **fix: a run is inserted only while its pass still owns the step, and a Retry sweeps twice.**
   - New `insertOwnedRun(db, stepRowId, values)` in `step-ownership.ts`: `assertOwnsStep(tx)` plus
     the insert in one transaction. Used at all nine insert sites: step-runner (`insertInvocationOrNull`,
     ai-fix, mining insert; `reserveMiningAgents`' transaction starts with the same check),
     merge-resolver's fixer, dag-executor's merge fixer, reviewer (`spawnReviewAgent`), replanner
     (`spawnReplanner`) and coders. A lost row throws `StepSupersededError` before any enqueue,
     `onInserted`/`saveMergeState` or workspace prep.
   - api `resetRowsForRerun` runs its supersede-and-delete-minings sweep again after the row loop.
     Each row UPDATE waits for a pass holding that row, so its insert has committed before the second
     sweep, and a later pass is refused. Covers Retry, fan-out Resume and `moveTaskToStep`; the worker
     copy (`_step-reset.ts`) mirrors it.
   - `supersededPass` stays as it is: no blanket supersede, since the retried pass reuses the row id.
   - Controls: `step-runner-mining-retry.test.ts` lands a Retry on the first step write before a
     fan-out (today it reserves, inserts and enqueues); an api test on `createFakeDb` (teach
     `compileWhere` `or`) inserts a live run and a mining row from a `beforeUpdate` hook (today both
     survive). Mocks that dispatch gain `transaction` and a `.for()` probe.
   - Live: a `holdOpen` section in `step-retry-claim-race-smoke.ts` (hold a running row, insert a run,
     POST retry, release): the run ends superseded, the mining row gone.
5. **fix(api): a Stop is one transaction (after 4).**
   - `stopActiveCliInvocations`: one transaction of cancel-runs (one UPDATE … RETURNING instead of a
     read and per-run writes), `failStuckSteps`, a second cancel sweep, then the task fail; sandboxes
     killed after commit. Lock order runs → steps → task, as the Retry and the worker's writes.
   - The cli-exec completion write keeps overwriting a Stop's exit/error on purpose: it carries the
     transcript, tokens and cost the run really spent, and every answer-reader skips superseded runs.
   - Controls (api, fake db, kill mocked): a throwing step update leaves the run live and kills
     nothing (today the run stays cancelled); a run inserted mid-Stop ends cancelled (today live).
   - Live: hold the running step row, POST cancel-active-cli; a third connection never reads the run
     superseded while the step still reads `running`.
6. **fix(worker): an advance for a step and round the task has moved past is dropped (after 2).**
   - In `handleAdvanceStep`, right after the epoch guard: no `formValues` and
     `advanceChainHasMoved(ctx, stepId, round)` → fold the abandoned park, log, return. This is what
     stops an advance queued before a restart from claiming a row boot requeued as abandoned.
   - Every enqueuer was checked: hand-offs, park ticks, boot, the re-driver, the api's retry/resume/
     skip/CLI-switch and the allowance auto-resume all target the pointer; submit, pr-poll and gate
     answers carry form values; START targets it after 2. The one mismatch is the api auto-continue,
     which sends no round: it now sends `round: task.currentRound` (at round 2+ it was already being
     dropped or creating a stray round-0 row).
   - A pointer rule rather than a job-timestamp rule: `requeueAbandonedOrphan` leaves no marker, and
     `updated_at` moves on park ticks and under a `holdStepAdvance` deferral, which keeps the job's
     timestamp, so a timestamp rule would drop deferred continuations.
   - Controls: `task-job-epoch.test.ts` with the pointer on a later step and a pending earlier row:
     no `advanceStep`, no task write (today the pointer moves back and the step runs); an api test on
     `createFakeDb`: auto-continue at round 2 queues round 2. `done-duplicate-smoke` stays green.
   - Live: on a paused throwaway task, set an earlier row `pending` and hand-add an ADVANCE at the
     current epoch: the log line, and the pointer does not move.
7. **fix: the allowance watch is armed only on the failure it belongs to, and a task Retry clears it.**
   - Both arm writes in `handleResult`'s `failed` case become
     `WHERE id AND orchestration_epoch = :ctxEpoch AND status = 'failed' RETURNING id`, and the poll
     ticks are queued only when the arm lands. The gap before the arm spans `settleFailedTask`'s
     teardown, so a Retry clicked on the failure lands inside it.
   - The api task-level Retry spreads `CLEAR_ALLOWANCE_WATCH`, as every other exit from `failed`
     already does.
   - Controls: `task-job-epoch.test.ts` moves the epoch after the failure write and the arm lands
     nothing; an api test retries a failed task with an armed watch and every watch column is NULL.
   - Live: `SELECT id, status FROM tasks WHERE awaiting_allowance_provider_id IS NOT NULL AND
     allowance_replenished_at IS NULL AND status <> 'failed'` stays empty.
8. **fix(api): step actions refuse a cancelled or completed task.**
   - The step Retry's and the fan-out Resume's epoch-bump UPDATEs gain
     `status NOT IN ('cancelled','completed')` and throw 409 inside their transaction when no row
     returns, which rolls back the row resets before any kill. Skip stops passing `reviveEnded` to
     `moveTaskToStep`, which already refuses both; the option then has no caller and goes.
   - The task page already hides every step action on both (`tasks/[id]/page.tsx:3507-3522`, because
     worktree-cleanup may have removed the worktree and branch), so the api now matches the UI; a
     failed task stays fully recoverable.
   - Controls: an api test on `createFakeDb`: Retry, Skip and fan-out Resume on a cancelled and on a
     completed task answer 409 and reset nothing; on a failed task they behave as today.
   - Live: a throwaway user from the e2e harness, a cancelled fixture task, each action → 409.

### Merge fixer

9. **fix(worker): a merge fixer commits only when it finished cleanly.**
   - `runFinishedCleanly(inv)` in `run-wait.ts` (`exitCode === 0 && !errorMessage?.trim()`, the test
     already inlined at step-runner, handlers and the api).
   - merge-resolver: `usable = inv.supersededAt != null || runFinishedCleanly(inv)`; the `uncertain`
     question and `completeMergeHostSide` run only when usable, otherwise the existing tail aborts the
     merge and re-dispatches, and the attempt charged at dispatch stays spent (the cap and halt apply).
     H6's refund branch for never-answered runs is untouched.
   - dag-executor `runLevelMerge`: `runFinishedCleanly(inv) && completeMergeHostSide(...)`.
   - Controls: a fixer that removed the markers but exited 1, in `12-worktree-cleanup.test.ts` and
     `dag-executor.test.ts` (today it commits). Fixtures that finished gain `exitCode: 0`.
   - Live: a `dag-auto-resolve-smoke` variant whose first stub resolves but exits 1: a second
     dispatch, then `resolved`.
10. **fix(worker): the merge resolver's fixer can say it is unsure (after 9).**
    - Append the `{status: 'resolved'|'uncertain', question?}` contract in merge-resolver's
      `dispatchFixAgent`, not in the shared `buildMergeFixPrompt` (the DAG merger parses no result
      and cannot ask). `parseFixResult` moves to `parseJsonLooseValidated`, so a JSON decoy the fixer
      echoes before its answer cannot hide it.
    - Control: the captured prompt carries the contract, and a reply with a decoy first parks for
      guidance.

### Upgrade and reset data safety

11. **fix: an upgrade or rollback deletes a file only while it still holds Haive's bytes, checked at
    the delete itself.**
    - New fs-safe `removeFileIfNoFollow(anchor, rel, accept(buf), {maxBytes})` → `'removed' | 'absent'
      | 'kept'`: hold the parent, rename the leaf to a private name inside it, read it through its
      own descriptor, unlink if accepted, else put it back with link+unlink (same inode); a name taken
      meanwhile leaves the file parked and throws naming where.
    - 02 and 04 share one helper replacing `deleteRefusalAt` + the act, with the same messages. The
      cli-rules region goes through `updateFileNoFollow` and strips only while the region's hash still
      matches, which also stops the empty-`AGENTS.md` write.
    - Controls: `fs-safe-write.test.ts` cases; 04's apply against a fake db whose hash call swaps in
      the person's file mid-check (today deleted, then kept); an absent `AGENTS.md` stays absent.
    - Live: `smoke:upgrade-claims`, `smoke:rtk-off-upgrade`.
12. **fix(api): the onboarding reset removes a claimed file through the same primitive.** Its settings
    pass and the single-file removals after `claimSatisfied === 'ours'` accept a file matching the
    row's or the step's hash. Directory removals and hash-less claims keep `removeNoFollow`, stated
    as the remaining window. Control in `repo-artifact-reset.test.ts` with the same swap.
13. **fix(worker): a rollback puts back absence.**
    - 02 records `createdPaths: {path, retiredRowId}[]` in its step output for every write where
      nothing stood before (a file, or a region with no prior region), and the rows it retired.
    - 04 reads 02's output of the rolled-back task: a created path is deleted (under 11's check)
      instead of restored from a "prior" row, and the retired row gets a `rollback` copy, so a
      reinstated file rolls back to "you deleted this". The prior lookup is bounded to rows that
      upgrade retired, so a row an old reset superseded is never picked. Outputs from before fall
      back to today's behaviour. 01's backfill skips a rendering with nothing on disk.
    - No migration. Fallback only if step outputs are ever pruned: an additive
      `absent_before boolean NOT NULL DEFAULT false`, declared last; undo `DROP COLUMN IF EXISTS`.
    - Controls in `upgrade-claims-smoke.ts` (it stores 02's output as the step runner does): a seeded
      file removed before the first plan ends absent after rollback; a deleted-then-reinstated file
      ends absent and plans as `user_deleted` again.
    - AGENTS.md's rollback paragraph is updated.

### Leftovers

14. **fix(worker): a bundle zip with one top-level folder keeps it when that folder is a bundle root.**
    `extractArchive` takes `opts.keepLoneDir(name)`; `classifier.ts` exports `isBundleRootDir`
    (`agents`, `skills`, any dot-dir) and `handleIngestZip` passes it. Repo extraction and attachment
    staging keep the flatten. A `my-bundle/agents/x.md` wrapper still flattens, so item ids do not
    move, and a lone `.gemini/` is now classed gemini. Control in `bundle-ingest.test.ts`: a lone
    `agents/` and a lone `.gemini/` (both fail today) and a wrapper.
15. **fix: a sibling build never marks a tag ready while a forced rebuild of it runs.**
    `handleBuildSandboxImageJob` checks `inFlightBuilds` before the cache-hit inspect; after a failed
    joined build a non-forced job re-inspects and marks only its own row ready when the old image
    still exists. Control in `sandbox-image-build-coalesce.test.ts`.
16. **fix: deleting a provider removes its own image (after 15).** The api DELETE enqueues
    `REMOVE_SANDBOX_IMAGE {providerId, imageTag}` on the cli-exec queue (the api never touches
    Docker); the worker skips a tag with a build in flight and otherwise calls
    `removeOrphanedPreviousImage`, which keeps any tag another row uses. Exempt from the per-invocation
    pickup gates, as builds are. Control in the same test file; live: create a provider with a
    Dockerfile extra, delete it, `docker image ls` shows no `provider-<id>-*` tag.
17. **fix: a repository cannot be deleted mid-clone, and the e2e suite deletes what it clones.**
    `DELETE /repos/:id` refuses while a root claim is live (`readLiveRootClaim`, as refresh-tree and
    the reset do). `repos/create.spec.ts` waits out `cloning` and deletes through the api; the
    provider specs delete their providers through the api before `cleanupUser`. Control: an api test
    for the 409; live: after a run, `/var/lib/haive/repos/<userId>` in the worker is empty.
    AGENTS.md's claim section still says the repo queue sets no `maxStalledCount` and nothing
    reconciles a stranded `cloning` row; both exist now (`repo-queue.ts:60`,
    `data-migrations.ts:277-318`), so that sentence is corrected here.
18. **fix(worker): the two storage-root checks accept any spelling of the root.** A
    `splitRepoStoragePath` beside `splitUploadPath` (rebuild-and-compare); the workspace cleanup uses
    it, and `01c-ddev-env` builds the runner path from `splitUploadPath`. Control in
    `worktree-paths.test.ts` with a trailing-slash root.

### RTK

19. **feat(worker): an upgrade can remove the RTK hook from an edited settings file.**
    - `withoutRtkHookEntry` in `_rtk-templates.ts`: parse, remove only hook items whose command is
      exactly the RTK command, prune what that leaves empty, write back with the file's own indent,
      newline style and trailing newline; null for no hook or non-strict JSON (then today's
      keep-and-warn).
    - 01 offers an edited obsolete rtk-config file that still holds the hook with a stripped preview;
      02 takes a new multi-select, unticked by default, applies the edit with `updateFileNoFollow`
      from the bytes at apply time, keeps the old bytes as a superseded baseline, and records a live
      row whose `writtenHash` stays the template's (no claim). 03 commits it; 04 restores it.
    - Controls: `rtk-templates.test.ts` units; `rtk-off-upgrade-smoke.ts` offers, strips (only the
      person's own key left) and rolls back to the original bytes.
20. **fix(worker): RTK files a blank scaffold seeded are taken back when RTK goes off.** No row can
    exist (`task_id` NOT NULL, and INIT has no task), so 01 renders the rtk-config templates as if RTK
    were on for a repo with no live rows, and a path whose bytes equal that render (or still hold the
    hook, with 19) becomes `obsolete` against that hash. Control: a second blank repo switched off
    before its first upgrade in `rtk-off-upgrade-smoke.ts` (today nothing is offered).
21. **fix(api): the banner offers the RTK files again when RTK is switched back on.** An rtk-config
    template counts as current while RTK is on, the enabled providers need it, and a live row's
    snapshot recorded an RTK choice (so repos from before RTK stay quiet). The claude-family and
    gemini provider lists move to `@haive/shared`; 01 prefers the snapshot that recorded the choice.
    Control in `upgrade-status-rules-imports.test.ts`.

### Web

22. **fix(web): the repos page, the plan page's actions and a before/after pair fit a phone.** Repos
    header `flex-wrap`, card title `min-w-[10rem] md:min-w-[18rem]` (the task page's own pattern), plan
    action group `flex-wrap`, before/after header and rows in one `overflow-x-auto` with
    `min-w-[36rem] sm:min-w-0`. Controls at 375×812: `main.scrollWidth - main.clientWidth <= 1` in
    `repos/list.spec.ts`, `plan/tree.spec.ts`, and `tasks/phone.spec.ts` with a before/after body.
    Browser at 375/768/1280.
23. **fix(web): one usage poller per page.** `lib/use-usage-window.ts` in the `use-global-pause`
    module-level pattern; both `HeaderUsageChip` mounts and `UsageStrip` subscribe, and a repair
    calls `refreshUsageWindow()`. Control: `tasks/detail.spec.ts` counts `/usage-window` requests
    after the strip mounts (2 today, 1 after).

### Tests

24. **test(worker): the DAG ownership checks each have a case.** Hoist `makeDagMergeWaitDb` and add a
    lost-row case for the review loop, replanner, advisor and section C, plus the level coder's free
    re-dispatch with infra retries unchanged. These pass today; deleting any one `assertOwnsStep`
    must turn its case red.

## No code (decisions recorded)

- **Readers of `cli_invocations.ended_at`:** audited. The only readers that take a superseded run's
  parsed result are deliberate: the merge resolver (H6, pinned by `12-worktree-cleanup.test.ts`) and
  the DAG level coder, reviewer and fix coder ("their edits are in the worktree for review",
  `92d15389`). Every reader that takes a run as a step's answer filters superseded runs.
- **The completion write overwriting a Stop's exit and error:** kept. It carries the transcript,
  tokens, cost and duration the run really spent.
- **H5's gate event logged twice after a crash:** dropped. Cosmetic; preventing it needs a read before
  each of three appends or a unique index (a migration).
- **upgrade-status blind to a rowless rendering beside a sibling row:** deferred. A proper fix stores
  per-repo (template, path) pairs in a new column, would hold the banner up for every declined
  sibling, and the upgrade plan itself still offers the path.
- **Writing the AGENTS.md RTK block back when RTK is switched on:** deferred until 21 lands; with no
  row, Haive cannot tell a block it stripped from one the person deleted.
- **Carried over from sweep 1, still decided:** task description provenance; `01-advisory-research`'s
  guard; the five hand-rolled fences; the capability snapshot vs the live uploads dir; coverage
  repairs from before #241; no attachments notice for resolvers and the replanner; an attachment name
  that names an agent path; codex's 32 KiB AGENTS.md cap; loose task-list bodies; line-scanned fences
  in nested lists; the task strip's title trade-off; the dev-only sync-order artifacts; the web
  suite's one unexplained exit 1.

## Found while planning, not in scope

All PRE-EXISTING; they go into the running list.
- A POST /tasks whose START was lost stays `created`: nothing distinguishes it from a deferStart
  draft, which waits there on purpose, so 3 cannot re-drive it.
- Under a pause, a retried walk still runs a `failed` row until its CLI dispatch: the pause gate only
  holds null or `pending` rows.
- `handleResult`'s `errorHint` writes (~1557, ~1650) are unfenced; cosmetic.

## Checkpoints

- **Dependabot's first npm run after 2026-09-25 16:19Z:** it finishes clean and opens the `tiptap`,
  `react`, `production` and `development` group PRs, with no drizzle bump. Then answer the TS 7 and
  mermaid 12 majors with `@dependabot ignore this major version`, land the group PRs one at a time
  (web groups: task page, plan editor and stats in the browser), and run ONE cold
  `pnpm docker rebuild` after they land.
- **Release-action bumps** (`setup-buildx` 4.4.1, `build-push` 7.4.0): the next real rc.
- **Rows already in `onboarding_run_checkpoints`:** the invariant-citation effect, the fs-safe
  workflow checks, the per-run `agent_rules` stamp, #229's upgrade check.

## Verification

- **Per PR:** the control fails before and passes after; CI green on the full sha; Codex looped
  clean; main CI green on the merge sha; the live check listed with the PR.
- **After the last merge, with no task running:**
  - rerun the new and extended smokes on the smoke Postgres/Redis (`step-retry-claim-race`,
    `claim-fence`, `stalled-redrive`, `upgrade-claims`, `rtk-off-upgrade`, the `dag-auto-resolve`
    variant) and count every fixture back to zero;
  - on the dev database, zero live runs on `pending` rows and zero `queued` tasks with no job;
  - a browser pass on the repos page, a plan page, a before/after gate body and a task page at
    375/768/1280.
- **Memory:** each running-list entry moves to Closed with its PR; a series memory records the
  merges and decisions; the checkpoints stay indexed.

## Rollback

- **Every PR:** a plain revert. No schema migration and no data migration in the series.
- **4/5:** reverting restores the old insert and Stop paths; nothing persisted changes shape.
- **13:** the step output field and rows the new code writes are ones the old code ignores or
  already reads, so a revert falls back to today's rollback behaviour.
- **16:** a removed image is rebuilt on demand, as a pruned host already is.
- **19:** the stripped file's previous bytes stay in its superseded baseline row, which a rollback
  restores.
- **1:** revert to the unfrozen installs.
