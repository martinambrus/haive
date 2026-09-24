# Found-not-fixed sweep: every open entry gets a fix, an owner or a recorded reason

> **IN PROGRESS** since 2026-09-24. PRs 1-5 merged (#267-#271); PR 5c (rollback restores edits) is
> in review. Tracked in the status table of `docs/plans/README.md`, which each PR updates.

## Context

The running list (`found_not_fixed_running_list` memory) has grown across four series: attachments,
agent-rules, its follow-ups, and the parallel session's recovery/context series. The parallel plan
(`~/.claude/plans/refactored-roaming-petal.md`, "Found, not fixed") keeps five more of its own. The
user asked on 2026-09-24 for a plan that fixes all of it.

Three exploration passes re-checked every entry against main, and two design passes stress-tested the
fixes. Main is `4dca716c` (#264 merged). Several entries changed on inspection:
- The backfill bug also sits in a second writer. The upgrade's obsolete-delete path removes whole
  files without a hash check.
- RTK-off leaves hooks as well as the AGENTS.md block.
- Two GET routes and two WebSocket handshakes boot runtimes.
- The "release never ran" entry is really two untested action bumps.
- The web suite's `undefined` line is pnpm's own reporter output.

**User decisions (2026-09-24):**
- The seven recovery items that build on #257/#263 go to the parallel session.
- The isolation scan resolves an `@` import the way the CLI will, in container space.
- The two untested release-action bumps wait for the next real release's rc; nothing is published
  now.

Repo copy for the record: `docs/plans/found-not-fixed-sweep.md` (NOT this file's slug; that name
is the shipped agent-rules plan), with a README status row that each PR updates.

## Every PR

- Worktree under `.claude/worktrees/`, branch, PR, merge commit.
- A test that fails on today's code (the control), then passes.
- Codex rounds until one brings no valid fix, then a thread audit.
- CI green on the full sha, then main CI on the merge sha. Read the conclusion, never the watcher's
  exit code.
- Sync main only with no live task (`libs` after a shared change).
- Zero-token live check on the dev stack, fixtures deleted after.
- Web PRs: browser at 375/768/1280.

## PRs, in order

Dependencies: 7 needs 4-6. 19 needs 18. 24 lands after 2026-09-25 16:19Z. 25 lands after #263.
Everything else is independent. 1-3 go first so later PRs get a trustworthy CI signal.

### CI and e2e signal

1. **ci: every push to main finishes its own run.**
   - `ci.yml:22-24` group becomes `ci-${{ github.event.pull_request.number || github.sha }}`, with
     `cancel-in-progress: true` kept.
   - PR pushes still cancel each other. Main runs never share a group, and GitHub replaces a
     *pending* run in a shared group even without cancel-in-progress.
   - Check: after merge, `gh run list --workflow ci.yml --branch main --event push` shows no
     `cancelled`.
2. **test(e2e): four specs wait for the response they read.** Tests only.
   - `gate-form.spec.ts:39`: await the submit POST (`waitForResponse` registered before the
     click; method plus pathname), then read the event once. The route writes values and event in
     two awaits.
   - `admin/console.spec.ts:121`: await the `/admin/audit` GET, then count alerts inside `main`,
     since Next's route announcer is a `role=alert`.
   - `cli-providers/ui.spec.ts`: an `openEditPage` helper that awaits the provider and catalog
     GETs, used at all seven edit navigations plus the Add page.
   - Controls: a 6 s `page.route` delay on the catalog fails the old spec. `networkidle` before
     the old console assertion fails it every time. `--repeat-each=20` for gate-form.
3. **test(e2e): the sandbox image is warmed once; provider polls fit their timeouts.**
   - A Playwright `setup` project (`*.setup.ts`, a dependency of chromium) creates a claude-code
     provider and waits until its image is ready.
   - `waitForProviderImageReady` goes in `helpers/db.ts`. `api.spec.ts:354-369` gets
     `test.setTimeout(90_000)`, and `ui.spec.ts` polls ready before navigating.
   - Fixes `ui.spec.ts:185/186`, flaky in 5 of 53 runs, and the 45 s poll inside a 30 s default.
   - Check: `docker rmi` the tag locally, then `--repeat-each=3` on `tests/e2e/cli-providers`.

### Upgrade and reset data safety

4. **fix(worker): an upgrade backfill claims only what Haive wrote.**
   - **`classifyEntry`**: a new path whose disk differs from the render (and, for cli-rules, is in
     no recorded render, `loadCliRulesRenderHashes`) is `conflict`, not the pre-selected
     `new_artifact`.
   - **01's backfill records nothing for an offered conflict**, so a skipped one is offered again
     and a rollback never reads it as a file the upgrade introduced. 02 records the path only when
     it writes there, keeping what it replaced as a superseded baseline.
   - **One rule for bytes that are not a render**, `backfillRecord` for whole files and
     `cliRulesRegionRecord` for the region: the bytes as content, so a rollback restores them; the
     render's hash as `writtenHash`, so they are never taken as Haive's; and their own hash as
     `templateContentHash`, so the template reads as not installed. A rollback copies both hashes,
     so a restored file is offered again rather than classified `unchanged`.
   - **Data repair**, a convergent `DATA_MIGRATIONS` entry `unclaimBackfilledEdits`:
     - Pre-fix `backfill` rows with `user_modified` (their `written_hash` equals
       `last_observed_disk_hash`) and their `rollback` copies get `written_hash` and
       `template_content_hash` swapped, which is the shape above.
     - cli-rules rows are excluded (there the column is the region hash).
     - Returned ids are logged. The bug shipped 2026-04-27, so v0.1.6/v0.2.0 installs may carry
       such rows; this install has none.
   - **Controls**: `backfillRecord` returns the disk hash today, and an existing edited file
     classifies `new_artifact` today.
   - **Live**: a new `upgrade-claims-smoke.ts` (in `smoke:ci`) on a blank fixture repo runs the
     real 01, 02 and a 04 rollback. A skipped edit gets no row and is offered again, an overwritten
     one is restored by the rollback and offered again, and the repair swaps 2 rows, then 0,
     leaving cli-rules alone.
   - **Undo**: swap the two columns back,
     `SET written_hash = template_content_hash, template_content_hash = written_hash WHERE id IN
     (logged ids)`.
5. **fix(worker): an upgrade or rollback deletes a file only while it still holds what Haive
   wrote.**
   - 02's obsolete delete (:425-453) calls `removeNoFollow` with no hash check, and 12 records a
     row even for a file 07 skipped. So a user's own file can be offered for deletion.
   - **As built**: a pure `deleteRefusal` over the bytes on disk at APPLY time
     (`pathContentHash`, whole file or rules region), since the form parks between plan and apply.
     02 keeps an edited or foreign file, warns and leaves the row live.
   - 04's undo (:396-421) gets the same test (add `writtenHash` to its select). A refused undo
     still retires the upgrade's row.
   - **Added**: 04 reads only `source = 'upgrade'` rows. The upgrade task's live backfill rows
     record what was already there, and its rollback deleted every adopted file the person had
     declined.
   - **Added** (Codex, #270 round 4): "Keep my edits" persists. On a live row it moves
     `templateContentHash` to the declined version in place. For an untracked path it records a
     non-claiming `backfill` row, which only the filter above makes safe from a rollback.
   - **Added** (Codex, #271 round 3): `deleteRefusalAt` keeps a link or a directory at the path
     the same way, so a rollback retires its row instead of retrying it on every later rollback.
     Round 4's check-then-delete window was deferred with reason: closing it needs a
     held-descriptor delete in `fs-safe`, which the reset's claim-then-remove should share.
   - Control: all three cases are deleted today. Live: smoke 4 adds a second upgrade with retired
     templates and a rollback of it.
5c. **fix(worker): a rollback of an Overwrite restores the edits it replaced.** Found while building
   5. 02 captures a baseline only for a path with no row, so overwriting a live-row conflict
   leaves the old row as the rollback's prior, and it holds what Haive wrote, not the person's
   edits. Capture whenever the disk differs from `baselineWrittenHash`, and break 04's
   `superseded_at` tie by `generated_at` (the insert time; the table has no `created_at`).
6. **fix(api): an onboarding reset takes back the legacy RTK.md files it can prove.**
   - `RTK_SLIM` moves to shared `templates/cli-rules.ts`. It gains `LEGACY_RTK_MD_PATHS` and a
     frozen literal `LEGACY_RTK_MD_SHA256`, pinned by a test with a comment to keep the literal if
     RTK_SLIM is ever re-vendored.
   - `claimPath` supplies the frozen hash for those paths.
   - A new pass before `onboardingResetDirs` (repos.ts ~:2138) removes `RTK.md` and
     `.gemini/RTK.md` only when `claimSatisfied` says `ours` (a 07 `wroteFiles` claim after the reset
     epoch plus the frozen body). Anything else is kept and reported. Content alone never claims.
   - The live-row leg cannot fire: `supersedeRemovedRtkArtifacts` retires those rows every boot.
   - Behaviour change: an edited `.claude/RTK.md` is now kept and reported instead of deleted.
   - Controls (`repo-artifact-reset.test.ts`): a claimed unedited file stays on disk today. Live:
     `smoke:reset-provenance`.
7. **fix: switching RTK off reaches the upgrade (after 4-6).**
   - Items: `rtk.claude-settings` and `rtk.gemini-settings` (whole settings files) plus the AGENTS.md
     block.
   - **01's render context**: the live `rtk_enabled` wins only where the context recorded an
     explicit choice, so pre-rtk repos (01:263-269) stay off. With RTK off, rtk.* rows go
     `obsolete` (safe after 5) and `applicable_template_ids` drop them.
   - **02**: strip the RTK region from AGENTS.md, CLAUDE.md and GEMINI.md, only where present
     (legacy `@RTK.md` regions share the markers). Refuse and report a link, and add the file to
     `writtenPaths`.
   - **upgrade-status**: drop rtk.* from `currentByTemplate`, not `applicableSet`, and flag
     `rtkBlockLeftovers` into `hasUpgradeAvailable` plus a banner clause.
   - **Stale comments fixed**: `tooling-upgrades.ts:475-479` (false claim about the upgrade),
     01:263-268, `_rtk-templates.ts`, 07:976-984.
   - Controls: the api status reports no drift today with RTK off. Live: flip `rtk_enabled` on the
     smoke-4 fixture. The unedited settings file is deleted, an edited one is kept with a warning, and
     the region is stripped; the banner shows in the browser.

### Worker correctness

8. **fix(worker): a CLI completion lands once, on its own run** (`queues/cli-exec/handlers.ts`).
   - One transaction for the invocation completion (:277-307) and the mining write (:362-375), and
     for the catch path.
   - Every mining write also matches `cliInvocationId = row.id`, so a late write cannot overwrite a
     re-rolled row.
   - The `try` ends after that transaction. Model-limit learning, the recap branch,
     `markCliParkBegin` and `resumeStepIfLinked` move out, so a queue error no longer rewrites a
     success as exit -1.
   - The recap summary is written under `SELECT … FOR UPDATE` on the invocation, skipping a
     superseded one, and its ledger entry only when written.
   - With one transaction, the reconcile's status compare-and-swap already rejects a committed row;
     no reconcile change is needed.
   - Control: a new `cli-exec-completion.test.ts`, each assertion failing today. Live: a Postgres tsx
     on the extracted helpers (relinked row untouched; a held supersede makes the summary skip).
9. **fix(worker): a superseded run a restart abandoned gets its end.**
   - A convergent `DATA_MIGRATIONS` entry sets `ended_at = GREATEST(started_at, superseded_at)` for
     started, superseded, unended rows, logging ids. It runs at boot before any worker.
   - It repairs the five 2026-09-05 rows, and `/reliability` then counts them as killed.
   - Check: SELECT shows 5, then restart, then 0. Undo by logged ids.
10. **fix(worker): the DAG ledger carries only what a coder reported.**
    - `dag-executor.ts:2288` records `concerns` only `if (result.parsed)`, as the fix coder does
      (:1151).
    - A new `dag-coder-infra-smoke.ts` (`smoke:ci`) has a coder that dies unstarted (free), one that
      dies after starting (charged) and one that returns prose only (nothing in the ledger).
      `dag-review-smoke` gets the reviewer pair.
    - This covers the untested `isFreeRedispatch` call sites (:1071, :2211).
11. **fix(worker): a coverage repair's agent id fits its column.**
    - `02-plan-coverage.ts` `sectionAgentId` hashes a key over 120 characters, in the style of 08d's
      `verifierAgentId`. `sectionHandled` also accepts the raw form, so ids already stored still
      match.
    - Control: a 400-character legacy source gives more than 128 today. Live: insert raw vs hashed
      (22001 vs ok).
12. **fix(worker): a leftover expansion staging dir is swept once no attachment is left.**
    - `ensureArchivesExpanded(db, taskId, repoRoot?)` runs `sweepStaleAttempts` alone when no row
      gives an anchor. Six callers pass the repo path.
    - The `removeExpansionStagings` docstring stops claiming a sweep that could not run.
    - Control: a planted `.expanding-*` with zero rows survives today.
13. **fix(worker): builds of one image tag coalesce.**
    - An in-flight `Map<tag, Promise>` in the build handler, in the style of
      `ensureSandboxCoreImage`: a job joins a running build of its tag, then does its own provider
      bookkeeping, and only the builder removes the previous image.
    - Measure whether waiting jobs holding cli-exec slots matters. If it does, defer the job
      (`moveToDelayed` + `DelayedError`) instead of awaiting.
    - Control: a mocked two-provider test runs two builds today. Live: rebuild two claude-family
      providers at once; the log shows one build and one join.
14. **fix: every git status Haive runs leaves the index alone.**
    - The api's `gitRead` (plan snapshot) sets `GIT_OPTIONAL_LOCKS=0`.
    - About ten worker `status` call sites get `--no-optional-locks`; a ratchet test fails on a
      status argv without it.
    - Control: an index `stat` changes today after a status on a touched file.
15. **fix(worker): an `@` import is followed where the CLI reads it.**
    - `resolveImport` resolves against `/haive/workdir/<dir of the importing file>` (absolute
      as-is). It follows only what lands inside the mount and scans the resolved target itself with
      `promptNamesAgentPath`.
    - That closes three holes: `@../workdir/.claude/agents/x.md`, `@/haive/workdir/…`, and
      `@docs/../.claude/agents/x.md`.
    - Docstring and AGENTS.md:1614 updated.
    - Controls: the three cases answer false today. Guard: the worktree `@../../../` case stays
      false.
16. **fix(api,web): only the app can boot a runtime.**
    - `GET /tasks/:id/access-urls` and `/db-access` enqueue a runtime ENSURE and become POST.
      `BrowserDirectPanel` and `DatabaseAccessPanel` call POST.
    - The VNC and IDE WebSocket upgrades (which also ensure runtimes) check `Origin` against the
      api's allowed web origins.
    - Control: GET enqueues today. Live: curl GET 404 and POST 200; the panels work in the browser.
    - Out of scope, with reasons: the `/ide` HTTP proxy ensures nothing, and the idempotent config
      self-heals.

### Web

17. **fix(web): dashboard links do not wait for statistics.**
    - Move the link row (`dashboard/page.tsx:440-451`) out of `{summary && …}`.
    - Control: abort `/stats/summary` in `app-layout.spec.ts:79`; the click times out today.
18. **fix(web,shared): markdown fences are read by CommonMark's rules.**
    - New `@haive/shared/markdown-fences` subpath: `scanFences` and `fencedLines`, following the
      opener/closer/indent/tilde/info rules. The nested-list limit is documented.
    - Used by `markdown-segments.ts` (pairs need two closed fences), by `hasCollapsibleContent`
      (moved into that `.ts` so it can be tested), by `quiz-parser.ts`, and by
      `looks-like-markdown`'s tilde case.
    - Controls: a four-backtick sample gets lifted into a before/after pair today. Also: tildes, an
      info string with a space, 4-space indentation, and an unclosed fence.
    - Browser: a seeded gate body at 3 widths.
19. **fix(worker): worker markdown readers use the same fences (after 18).**
    - `buildSpecSummary` and `extractMermaidBlocks` (06), and `ddev-build-guard`'s `MD_FENCE_RE`.
    - `11-final-review`'s `stripOuterFence` gets a regex tweak instead (any length, or tildes); the
      scanner would end it at the first inner fence.
    - Controls in the three existing test files.
20. **fix(web): an image in a plan node survives an edit.**
    - A local inline atom node named `image` in `markdown-extensions.ts`, before `Markdown`.
      tiptap-markdown serializes by that name.
    - `parseHTML` `img[src]` and `span[data-md-image]`. `renderHTML` is a span showing
      `imageLabel(alt)`, exported from `rehype-image-links.ts`, and is never an `<img>` or `<a>`.
      No new dependency.
    - Unit: serialization plus a `toDOM` without img/href; both fail today.
    - e2e (`plan/tree.spec.ts`, long timeouts): edit one character and save. The body keeps the
      image, and a probe URL on `API_BASE` gets zero requests.
21. **fix(web): the task page fits a phone.**
    - **Title strip**: the usage chip is hidden below md, the repo and execution badges below sm, and
      the pace chip's AI segment below sm. The strip stays one line (the StaleBuildBanner measures
      it).
    - **Layout**: the header cluster and step header wrap; the picker grid uses
      `minmax(min(22rem,100%),1fr)` and its selects `min-w-0`.
    - **e2e** `tasks/phone.spec.ts` at 375:
      - Setup: two providers plus a seat preference, so two meters render.
      - Assert: no horizontal scroll, strip children inside the strip, `StepDuration` one line.
    - **Measure 768/1280 before and after** (sidebar expanded and collapsed). If the strip already
      overflows there, a follow-up PR keys its hiding to the strip's own width (`@container`).

### Tooling and dependencies

22. **test: the 501-file archive tests get a measured timeout; AGENTS.md records the smoke rule.**
    - `expand-archives.test.ts` (both 501-file cases): a per-test timeout sized from a
      `--reporter=verbose` measurement.
    - One Build-commands bullet: queue smokes need their own Redis and database, because the dev
      worker consumes their jobs.
23. **build: skip the optional ssh2 and cpu-features native builds.**
    - Move them from `onlyBuiltDependencies` to `ignoredBuiltDependencies`. The JS fallback already
      runs, and Docker is only ever reached over the unix socket.
    - After `pnpm docker rebuild`: `git diff --exit-code pnpm-lock.yaml`, and no gyp lines in the
      install log.
24. **ci(dependabot): grouped updates** (merge after 2026-09-25 16:19Z, once the npm run is clean).
    - **npm**: `tiptap`, `react`, prod minor+patch and dev minor+patch groups; ignore `drizzle-orm`
      and `drizzle-kit`, both hand-bumped because the kit refuses an older orm.
    - **actions**: a `docker/*` group of its own, plus minor+patch.
    - **docker**: minor+patch.
    - Then land the group PRs one at a time. For web-affecting groups, check the task page, the plan
      editor and stats in the browser after `pnpm docker rebuild`. Answer the TS 7 and mermaid 12
      PRs with `@dependabot ignore this major version`.
25. **fix(worker): a wave consumes only the rows its apply folded (after #263).**
    - A `consumeFoldedMiningRows` helper binds each (agentId, invocationId) plus
      `consumed_at IS NULL`. It is used at the wave stamp (`step-runner.ts` ~:2658) and the reopen
      consume (~:2603).
    - `step-runner-mining-retry.test.ts:1047` pins the whole-step stamp today; replace it with the
      folded ids and a relinked sibling left unstamped.

## Parallel session (next PRs of the recovery series; rebase onto #257/#263 first)

Verified on main 2026-09-24. Handover, before any PR here starts:
- If `ListAgents` shows the parallel session, send it this list with the verification report's
  file:line evidence.
- Either way, write it into its series memory (`recovery_context_followups_series.md`) as that
  series' next PRs.

1. **A pass past its epoch guard flips a row after a Retry.**
   - The flip and `markTaskRunningWithStep` go by id with no epoch, and the api reads
     `downstream`/`leftActive` outside its transaction.
   - Fix: epoch plus `status='pending'` in the flip's WHERE (#263's `params.epoch`), an epoch term on
     `markTaskRunningWithStep`, and lock the task row before the api's reads.
   - Same class: `handleResult`'s `waiting_cli` task write goes by id alone.
2. **The loop-resume arm reopens a step without `leftActive`.** Mirror the fan-out arm (#257).
3. **Retry, fan-out resume and loop resume kill before they supersede.** Order them commit, then
   kill, then enqueue.
4. **Nothing re-drives a stalled task between boots.** Boot pass 2's reset branch enqueues once,
   with no retry or hand-back, leaving a `pending` row at a bumped epoch. Fix: an in-process sweeper
   modelled on `CliPriorityDecaySweeper`.
5. **A redelivered job for a `revise`/`loop_back` step that ended `done` walks forward.** It
   silently drops the blocking review, or wedges when the pointer has moved. Re-evaluate the loop in
   the done-duplicate branch; the sweeper covers the lost hand-off.
6. **DAG and merge-fix waits hang on a superseded, never-started run.** Also, the merge fix saves
   `fixInvocationId` after it enqueues, and `merge-resolver.ts` has no unique-violation handling.
7. **The stale-submit wiring (#259) has no harness.** Add drop and re-park cases to
   `fix-loop-smoke.ts`.

## No code (decision recorded)

- **Task description provenance at 03/04**: a fence would make the assignment impossible to carry
  out.
- **`01-advisory-research` has no guard**: a person reads its output at a gate.
- **The hand-rolled untrusted fences at five sites**: deliberate per-site wording.
- **The capability snapshot vs the live uploads dir**: declined twice.
- **Coverage repairs from before #241**: transitional.
- **No attachments notice for resolvers and the replanner**: by design.
- **An attachment name that points at an agent file turns isolation off**: the user chose to fix
  only the dot bug.
- **Codex's 32 KiB AGENTS.md cap**: the rules are injected into every prompt now.
- **New source against old dist after a pull, and syncing before `libs`**: `dev-libs` is a one-shot
  build; the no-live-task check covers the ~10 s gap.
- **Task-list bodies saved loose**: the stored text cannot say which lists the bug made.
- **The web suite's single exit 1**: pnpm's reporter line; next time run
  `pnpm --filter @haive/web test` and keep the log.
- **Toasts stay in the Tab order under the phone drawer**: declined on #265, measured above the
  backdrop.
- **Recording `personaIds` on the mining row**: its one consumer is an attribution label, and 03
  re-offers its roster on every retry.
- **The cli-exec handler's writes by `agentMiningId` alone**: taken into PR 8.
- **TypeScript 7 and mermaid 12**: majors, each its own project.

## Checkpoints

- **Release-action bumps** (`setup-buildx` 4.4.1, `build-push` 7.4.0) and the production image stages
  CI never builds: exercised by the next real release's first rc.
- **Dependabot's npm run**: clean after 2026-09-25 16:19Z. This gates PR 24.
- **Rows already in `onboarding_run_checkpoints`**: the invariant-citation effect, the fs-safe
  workflow checks, the per-run `agent_rules` stamp, and #229's upgrade check.

## Found while planning, not in scope

- A Haive `.claude/settings.json` the user has edited keeps its RTK hook after RTK is switched off.
  PR 7 reports it; removing only the hook entry edits a user's file and needs its own review.
- Line-scanned fences cannot see a fence indented 4+ spaces inside a nested list. This is stated in
  PR 18's docs.

## Verification

- **Per PR**: the control fails before and passes after, CI green on the full sha, Codex looped
  clean, main CI green on the merge sha, and the live check listed with the PR.
- **After the last merge**, with no task running:
  - rerun the three new smokes against the dev database;
  - a browser pass on a task page, a plan node edit and a gate body at 375/768/1280;
  - count every fixture back to zero.
- **Memory**:
  - the found-not-fixed list moves each entry to Closed with its PR;
  - a series memory records the merges;
  - the parallel-session list goes into that session's series memory;
  - the checkpoints are added to `onboarding_run_checkpoints`.

## Rollback

- **Every PR**: a plain revert.
- **The two `DATA_MIGRATIONS` entries (4, 9)**: log the ids they change; each has an id-scoped undo
  UPDATE above.
- **PR 6** deletes only bytes equal to `RTK_SLIM`, so writing that back restores a file.
- **PR 7** deletes only files that pass PR 5's guard. A deleted file's bytes stay in the superseded
  row's `written_content`.
- **PR 23**: revert and `pnpm docker rebuild`.
- No schema migration is added.
