# Project state that travels between installations

> **In progress** (2026-09-26). Track B of `found-not-fixed-sweep-3.md` (plan file
> `compiled-noodling-squid`). Phase 0: B0.1 in review; B0.2 and B0.3 not started.

## Context

Two installs (A, B) share one git remote, each with its own Postgres. Today B can clone but never
upgrade (no rows, no render context: 409 and a 01 throw), a pulled upgrade turns every file A
changed into a conflict on B, the mirror is imported once into NULL columns and never again,
`.haive/install.json` is never read, plan edits can be silently reverted when commits arrive by
any route but plan Pull, and per-user content (rules block, CLI folders) makes installs fight.

The user expects a committed sync file from which a second Haive installation can restore
onboarding, because two people working on one project from their own installs will be common, and
moving a project between installs "must work and be synced correctly and fully".

## Decisions (2026-09-26)

- **Onboarded elsewhere:** not "explain and refuse" — the repository must carry its onboarding so
  another install restores it and stays in sync (Track B).
- **Sync commit policy:** the project-state record rides every commit Haive already makes; at the
  moments Haive already pushes, pending sync files go in a separate `chore(haive)` commit; the
  onboarding and upgrade commit defaults to ON when the repo has an origin (push stays opt-in);
  a "Haive data" panel shows written/committed/pushed with Save and Save & push.
- **Same-key conflicts between installs: ask each time.** A key both installs changed since
  their common base is held as a pending conflict with both values; nothing is chosen for the
  person. Only operations that would WRITE the contested state wait (see B-conflicts); everything
  else keeps running on the local value, and the conflict is shown until answered.
- **AGENTS.md rules block:** repository-level (Haive's default rules plus an optional repository
  override on the tooling page, synced like other settings); personal rules reach Haive's own
  agents through dispatch injection only.
- **CLI folders:** the repository keeps the UNION of its installs' CLIs; a CLI is dropped only by
  an explicit action; no upgrade offers to delete a teammate's CLI folders.

## Design

- **The record:** `.haive-data/state/`, one file per unit so git's merge unit is ours (different
  files never conflict): `format.json` (schemaVersion), `project/environment.json`,
  `project/render.json` (projectInfo, framework, acceptedAgentIds, customAgentSpecs,
  lspLanguages), `cli/<provider>.json` (the repo-level CLI union), `settings/<name>.json` (one per
  portable setting), `artifacts/<slug>~<h8>.json` (one claim per disk path: path, template, kind,
  schemaVersion, templateHash, writtenHash, haiveVersion — never the bytes, which are in git),
  `bundles/<slug>~<h8>.json` (portable bundle descriptors). Canonical form: UTF-8, LF, 2-space,
  sorted keys and sets, trailing newline, no timestamps, no install ids. Portable bundle template
  ids `custom:<gitUrl#branch|zip:name>:<sourcePath>`; an unmapped claim is `foreign` (claims its
  file, never offered). `applicable_template_ids` is recomputed on import, never carried.
- **Columns:** portable — `scope_exclude_globs`, `onboarding_environment`, `rtk_enabled`,
  `rtk_version`, `lsp_servers`, `lsp_server_versions`, `chrome_devtools_mcp_version`,
  `review_dimensions`, `app_auth` shape (not `enabled`), the new `render_context` and
  `agent_rules_override`, `kb_synced_commit`/`plan_synced_commit` (ancestry merge);
  `onboarding_tooling` split (lspLanguages → render; rag model/dims fill-if-absent;
  `mcpSettingsJson` consent-gated; rag connection, ollama, keepRepoMcpServers local);
  machine-local — placement/identity, runtime status, `secret_mask_*` (a committed file must never
  lower another machine's masking), `pr_workflow_enabled`, `step_guidance_enabled`,
  `rag_embed_lexical_only`, `onboarded_at`/`onboarding_reset_at`; derived — detection, file tree,
  applicable ids. Step guidance is not synced for now.
- **Import, `syncProjectStateFromCheckout(db, repoId)`** (worker `src/project-state/`), under a
  per-repo advisory lock: watermark (`synced_head`, `synced_hash` over the state files' blob ids);
  defer while an onboarding/upgrade task is live; read through fs-safe and refuse the whole record
  on conflict markers, schema errors, a newer `format.json`, an unsafe path or a name/path
  mismatch; three-way merge with base = the record at `synced_head` from git (fallback
  `base_snapshot`), local = the DB rendered by the writer's loader, incoming = disk; per key /
  set member / claim: one side changed → that side; both identically → either; **both differently
  → a pending conflict (user decision)**, except a claim whose `writtenHash` equals the bytes on
  disk (the ledger follows the bytes); ledger adoption in one transaction (import rows superseding
  local ones, a remote removal retires an unchanged row, local-only additions kept; retiring every
  base claim stamps the local reset epoch); machine-local columns never written.
- **B-conflicts:** a `project_state_conflicts` table (repo, key, base, local, incoming, detected,
  resolution). Unresolved: the DB keeps the local value; the writer leaves that key's file as
  incoming; upgrades refuse while a claim or render-context key is contested; plan flushes skip a
  contested node; the Haive data panel and a banner on the repo's pages ask "keep mine / take
  theirs" per key; answering applies, rewrites the file and clears the row. Workflow tasks run on.
- **Write, `writeProjectStateRecord`:** sync first (except inside the live onboarding's own
  step 12), render, write only changed files (`writeFileNoFollow`), delete only files it owns that
  the render no longer produces, never touch unknown files. Outbox `markProjectStateDirty(tx)`
  in every mutating transaction (api and worker), flushed by a 10 s sweep on the plan-mirror
  queue and synchronously at 12/02/04.
- **Checkout moves:** `setAsideHaiveProjections` (projection files dirty vs HEAD must equal the
  last-written hash or the move is refused naming the file; the dirty flag is set first; restore
  with `git checkout HEAD --`) before, and the sync after, at `persistDetection`, 00a, the merge
  resolver (same-branch), plan Pull/Save, 13, refresh, and task end; a 60 s sweep catches moves
  Haive did not make (skips MERGE_HEAD/REBASE_HEAD).
- **Plan:** a flush never overwrites a `plan.json` it has not imported and never writes mid-merge;
  a three-way reconcile (base = `plan.json` at `synced_head`) applies remote deletions of untouched
  nodes when a base exists (additive without one); same-field conflicts go to B-conflicts; a
  stage-level resolver (`:1:`/`:2:`/`:3:`) replaces the wholesale `--theirs` in every merge Haive
  drives.
- **Repo-level content:** `render_context.cliTargets` is a union (07 adds the onboarding user's
  CLIs, upgrade offers adding the upgrader's, removal explicit); the cli-rules region renders from
  `agent_rules_override ?? DEFAULT_AGENT_RULES`.
- **Legacy:** `.haive/install.json` retired (stop writing and staging; the first commit carrying
  the record also `git rm --cached` it); `environment/tooling/exclusions.json` no longer written,
  still read as the fallback when no record exists. **Version skew:** a newer `format.json`
  refuses import and write; claims from a newer Haive release block upgrades on the older install
  with a banner. **Kill switch:** `CONFIG_KEYS.PROJECT_STATE_SYNC_ENABLED` (default on).
- **Migrations are reversible by design:** imported claims are `source='backfill'` with
  `source_step_id='project-state-import'` — NOT a new `artifact_source` enum value, which Postgres
  cannot drop; `onboarding_artifacts.task_id` becomes nullable with a CHECK tied to that marker
  (undo: delete the marker rows, `SET NOT NULL`); every backfill reader is audited for the marker
  (`unclaimBackfilledEdits`, 04, `loadCliRulesRenderHashes`, upgrade-status). New tables/columns
  are additive (`project_state_sync`, `project_state_conflicts`, `repositories.render_context`,
  `agent_rules_override`, `plan_mirror_state.synced_*`), declared last.

## PRs (dependencies in brackets)

Phase 0 (live exposure, independent):
- **B0.1 fix(worker,api): imported MCP server definitions are inert until accepted on this
  install.** Import moves `mcpSettingsJson` to `importedMcpSettingsJson`; `loadUserMcpServers`
  ignores it; tooling page banner with 04's opt-in wording; `PATCH tooling
  {acceptRepoMcpServers}`. Control: B's `loadUserMcpServers` returns the repo's server today, `{}`
  after until accepted. Adds the repo doc. **As built:** the PATCH field is
  `repoMcpServersAction: 'accept' | 'discard'`, a compare-and-set on the column; a server counts as
  Haive's only when its definition equals Haive's own under that name; the import strips the three
  consent keys from the committed file; and a boot repair (`holdImportedMcpServerLists`) holds rows
  imported earlier, skipping a record this install's own 04 wrote and a list accepted here (its
  hash is recorded on accept). Control: `smoke:mcp-import-consent` fails 3 of 9 with main's
  `clone.ts`, passes 9 of 9 with the fix.
- **B0.2 fix(worker,api,web): refresh-tree fetches and fast-forwards.** New REFRESH job: fetch,
  refuse on tasks in flight, dirty tracked files, unpushed commits or divergence (naming the
  count), `merge --ff-only` with the `--deepen=50` fallback, then `persistDetection`; with no
  usable checkout, the old tree is moved aside, never `rm -rf`; no-origin sources answer "nothing
  to refresh from". Control: a checkout with one unpushed commit is re-cloned today (commit lost),
  refused after.
- **B0.3 fix(worker): the mirror import reads through fs-safe and applies `rtk_enabled`.**
  Control: a symlinked `tooling.json` is imported today, ignored after; `rtkEnabled:false` in the
  mirror leaves the column true today. `fs-ratchet.json` `clone.ts` 10 → 9.

Phase 1 (the record):
- **B1.1 test(worker): two-install round-trip smoke with a strict known-gap list.**
  `packages/worker/test/two-install-smoke.ts` (+ `test/support/two-install.ts`): two databases
  (`haive`, `haive_h5` on 55432; CI creates `haive_b`), one bare `file://` remote, A's onboarding
  driven through the real 07/12 steps from seeded rows, B via `handleClone`. Each later PR removes
  its gaps (a gap that passes fails the run), which is its control.
- **B1.2 fix(worker): an upgrade adopts a file that already holds the current render.** New
  `adopt` bucket in `classifyEntry` (live row, disk equals the current render); 02 supersedes the
  row with a render-claiming backfill row, outside `writtenPaths`/`createdPaths`/`retiredRowIds`.
  Control: `upgrade-plan-classify.test.ts` (today `conflict`).
- **B1.3 feat(shared): project-state record codec** (pure `packages/shared/src/project-state/`:
  types, canonical render, zod parse, three-way merge returning conflicts, claim naming, id
  mapping, state hash). Control: determinism, round-trip, the merge table, and a `git merge-file`
  property test (edits to different units merge cleanly; the same edits on one pretty JSON file
  conflict).
- **B1.4 feat(worker,api): sync settings and render context; 01 and the gates read them**
  [B1.3]. `project_state_sync` table, `repositories.render_context`; `syncProjectStateFromCheckout`
  replaces `importHaiveDataMirror` (legacy files as fallback); 12/02 write `render_context`; 01's
  `resolveRenderContext` reads it first; POST /tasks and upgrade-status accept a repo with a
  render context. Control (smoke gaps): B's 01 throws today, plans after.
- **B1.5 feat: pending conflicts, asked, never chosen for the person** [B1.4].
  `project_state_conflicts`, the hold rules, `GET/POST /repos/:id/project-state/conflicts`, and
  the panel/banner resolution UI (browser check at 375/768/1280). Control (smoke): two installs
  change one setting differently → a pending conflict, the local value still in effect and that
  setting's file left as incoming (today the second import silently keeps one side); a contested
  render-context key refuses an upgrade; answering applies, rewrites the file and clears the row.
- **B1.6 feat(worker,api): adopt the record's artifact ledger** [B1.5]. Nullable `task_id` + CHECK,
  backfill + marker rows, `foreign` bucket in 01/02, rollback eligibility vs `imported_at`,
  onboarding verdict counts imported claims. Control (smoke): after a fresh clone B has 0 rows, a
  409 and a throw today; after, B's rows equal A's claims and 01 is all `unchanged`; after A's
  upgrade B reads `conflict` everywhere today, `unchanged` after.
- **B1.7 feat(worker): write the record at onboarding, upgrade and rollback; retire install.json**
  [B1.6]. Control: two identical 12 runs leave `git diff` empty (today install.json differs).
- **B1.8 feat(api,worker): keep the record current on every settings edit** [B1.7]
  (`markProjectStateDirty` in PATCH exclusions/tooling, the reset, bundle changes, 02-detection,
  04-tooling, 06_7, bundle resync). Control: PATCH exclusions then a sweep tick updates
  `settings/scope-exclude-globs.json` (today the mirror never changes after 12).

Phase 2 (the plan):
- **B2.1 fix(worker): a plan flush never overwrites a snapshot it has not imported, never writes
  mid-merge.** `plan_mirror_state.synced_*`. Control (plan-canvas-smoke): A's `plan.json` arrives by
  a plain fast-forward, B edits another node: A's change is lost today, both kept after.
- **B2.2 feat(shared,worker): three-way plan reconcile** [B2.1, B1.5]. Control: a local title edit
  is reverted today; an untouched node deleted remotely is kept today (deleted after); a same-field
  edit on both sides becomes a pending conflict.
- **B2.3 feat(worker): Haive-owned files resolve deterministically in every merge Haive drives**
  [B1.3, B2.2]. The stage-level resolver in `mergeOriginInto`, the merge resolver's pending phase
  and 13; the fix prompt leaves those paths alone. Control (`merge.test.ts`): ours changed node X,
  theirs node Y: theirs wins wholesale today, both kept after.

Phase 3 (checkout moves):
- **B3.1 feat(worker): every checkout move Haive makes re-syncs, projections set aside first**
  [B1.7, B2.1, B2.3]; agents' changes to `.haive-data/state/**` on task branches are reverted at
  cleanup with a warning. Control (`00a-sync-base.test.ts`): a dirty Haive-written state file plus
  an incoming commit touching it → `skipped` today; ff + import + re-render after.
- **B3.2 feat(worker,api): catch checkout moves Haive did not make** [B3.1] (60 s sweep, on-read
  triggers). Control (smoke): B's plain `git pull --ff-only` is never learned today; within a tick
  after.

Phase 4 (repository-level content):
- **B4.1 feat: the repository's CLI set is a union** [B1.4] (07, 12/03 stage paths, 01, 02 stubs,
  blank scaffold, api `rulesImportGaps`, `resolveSkillTargetDirs` callers; existing repos seed
  it from their newest snapshot). Control (smoke): A claude, B claude+codex — today B's context
  offers deleting A's folders; after, codex files are new and A's untouched.
- **B4.2 feat: the AGENTS.md rules block is repository-level** [B1.8]. `agent_rules_override` +
  `settings/agent-rules.md` + a tooling-page editor; one `buildRepoCliRulesBlock` for 07/12/01/api.
  Control: two users with different personal rules each see the other's block as drift today;
  quiet and byte-identical after.

Phase 5 (visibility and commit policy):
- **B5.1 feat(api,web): the Haive data panel** [B1.8] (`GET /repos/:id/haive-data`,
  `POST …/save {push}` via a worker SAVE job; generalise `commitPlanSnapshotFiles` to a path
  list; conflict report). Browser check at 375/768/1280.
- **B5.2 feat(worker): project state rides Haive's pushes** [B5.1]: a `chore(haive)` commit of
  dirty projections before the cleanup base push, 13 and plan Save & push; the PR path commits it
  into the feature worktree; 12/03 commit defaults on when an origin exists. Control: cleanup with
  a dirty record and push leaves origin without it today, with it after.
- **B5.3 feat(worker): review watermarks travel, and Haive's own paths leave drift ranges**
  [B1.8] (`settings/review-watermarks.json`, descendant wins via `merge-base --is-ancestor`;
  `_external-drift` drops `.haive-data/state/**` and plan files). Control: B re-reviews A's
  KB-reviewed commits today; empty range after.

Acceptance for Track B: `smoke:two-install` with an empty gap list (onboard A, push, clone B,
quiet 01; concurrent settings edits; same-key conflict asked; A's RTK-off upgrade reaching B;
plan edits on both sides; an external pull; refresh refused on an unpushed commit; version skew;
union and rules block; records byte-identical at the end), and a live two-install check: a second
install beside the dev stack (`HAIVE_INSTALL_ID=haiveb`, own ports and volumes), both on one bare
remote under `/host-fs`, zero tokens, browser at 375/768/1280, everything removed after.

## Appendix: design detail

Verified facts the survey added (2a610d56):
- `onboarding_artifacts.task_id` is NOT NULL with an FK to tasks, so imported rows need the
  nullable change; `artifact_source` is a Postgres enum (`onboarding|upgrade|rollback|backfill`,
  `0000_baseline.sql:40`) — hence the backfill-plus-marker design, not a new value.
- Custom-bundle template ids are install-local UUIDs (`custom.<bundleId>.<itemId>`,
  `template-manifest.ts` `expandCustomBundlesFor`); on B they read as obsolete, hence portable ids.
- `importHaiveDataMirror` restores `tooling.mcpSettingsJson`, which `loadUserMcpServers`
  (`sandbox/mcp-surface.ts` ~223-236) hands to B's CLI — bypassing 04's explicit opt-in (B0.1).
- refresh-tree for `blank`/`upload` sources enqueues CLONE with no `remoteUrl` (clone.ts ~667) and
  the api accepts it on `ready` rows; it `rm -rf`s `.haive/worktrees` and unpushed commits (B0.2).
- `autoResolvePlanFiles` runs only inside plan merges (merge.ts ~217); 00a, cleanup base-sync and
  13 send `plan.json` conflicts to the AI fixer. `writePlanMirror` has no MERGE_HEAD check.
- For in-place `local_path` repos the worker writes `.haive-data/` straight into the person's
  checkout, and the person pulls in their own terminal: most checkout moves are not Haive's, so
  the B3.2 sweep is essential, not optional.
- 03's stage list has KB/learnings but no mirror files; the upgrade workflow has no push step;
  cleanup's `pushBase` defaults off.
- 01-env-detect's project-name fallback is `path.basename(repoPath)` (~1439-1444), a repository
  UUID under Haive storage, which can reach `environment.json` and committed renders.
- Tests: CI's smoke job has one database (ci.yml ~100-172) — the two-install smoke needs a
  `CREATE DATABASE` + migrate step; `clone.ts` is pinned at 10 path-based fs calls
  (`packages/shared/test/fs-ratchet.json`); `HAIVE_INSTALL_ID` already supports a second install
  on one machine (docker-compose.yml header).

Claim file names: slug = the path with `/` → `__` and leading dots dropped, `h8` = first 8 hex of
sha256(path); the parser refuses a name that does not match its path; flat on purpose (mirroring
`.claude/...` under `.haive-data` would plant directories tools scan).

`syncProjectStateFromCheckout(db, repoId, {reason})` — worker `src/project-state/sync.ts`, `db`
explicit (the smoke drives two databases), under
`pg_advisory_xact_lock(hashtextextended('project-state:'||id, 0))`:
1. Watermark: `synced_hash` = sha256 over sorted `relPath NUL gitBlobId`; `synced_head` = HEAD at
   the last successful sync; both match → only the plan step (7).
2. Defer while an `onboarding`/`onboarding_upgrade` task is live (return `deferred`, watermark
   untouched); completion/fail/cancel hooks and the sweep retry it.
3. Read via `readdirNoFollow`/`readTextNoFollow`; refuse whole on conflict markers, schema errors,
   a newer `format.json`, an unsafe claim path (`safeDiskRel`) or a name/path mismatch → DB
   untouched, `last_error` + report in the UI. No record → legacy files, fill-if-absent (+
   `rtkEnabled`, B0.3).
4. Three-way merge. base = the record at `synced_head` read from git objects (fallback
   `base_snapshot` after a re-clone or rewritten history, then none); local = the DB rendered by
   the writer's loader; incoming = disk. Unit = a top-level key of a settings/project file, a
   member of a declared set (globs, CLI targets), or a claim.

   | base→local | base→incoming | result |
   |---|---|---|
   | unchanged | unchanged | keep |
   | changed | unchanged | local |
   | unchanged | changed | incoming |
   | changed | changed identically | either |
   | changed | changed differently | PENDING CONFLICT (user decision); claims: the one whose `writtenHash` equals the bytes on disk wins without asking |
   | no base | — | incoming wins; overwritten local values reported (first import) |

   Base = the record at `synced_head` (not "last imported content") is what makes a teammate's
   revert of your committed change apply correctly.
5. Ledger adoption in one transaction: a claim different from the live row → supersede it, insert
   a marker row (`source='backfill'`, `source_step_id='project-state-import'`, `task_id` NULL,
   `userId` = repo owner, `formValuesSnapshot` = the derived render context, `writtenContent`
   from disk only when its normalised hash equals `writtenHash`); a path in base that incoming no
   longer lists, local row unchanged → retire (remote removal); local-only additions kept; an
   import retiring every base claim stamps `onboarding_reset_at`; settings columns,
   `render_context` and `applicable_template_ids` (via `expandManifestFor` +
   `expandCustomBundlesFor` + `updateApplicableTemplateIds`) in the same transaction;
   machine-local columns never written.
6. Book-keeping: set `synced_head`, `synced_hash`, `base_snapshot`; merged ≠ incoming (local
   pending changes) → mark dirty and re-render.
7. Plan: take the separate plan lock (never nested) and run the plan reconcile.

Version skew: a newer record format refuses import and write; claims with a newer `haiveVersion`
(semver, releases only) block upgrades on the older install ("last changed by Haive vX"); dev
builds compare only to themselves and warn, never block.

`writeProjectStateRecord(db, repoId)`: sync first (skipped only inside the live onboarding's own
step 12, where that run's output wins); render the DB state; write only changed files; delete only
files in `owned_files` the render no longer produces; never touch other files (so an older writer
preserves unknown future settings and not-yet-imported files); update `owned_files`,
`synced_hash`, `written_revision`.

`setAsideHaiveProjections(db, repoId, repoPath)` — a semantic stash, the DB already holds the
state: sync first; each projection path dirty vs HEAD (`.haive-data/state/**`, `plan.json`,
`plan.md`) must equal the last-written hash or the move is refused naming the file; bump the dirty
revision FIRST (a crash re-renders); `git checkout HEAD -- <paths>` for tracked, remove untracked
own files. After the move, the sync (base = the record at the pre-move head) re-renders local
pending changes on top of the new HEAD. Call sites: `persistDetection` (replacing both
importers), 00a (before `ff()`, sync after ff/merge), `resolveMergePhase` when
`mergeDir === ctx.repoPath` (sync in `reachDone`), plan `pull()`/`save()` (before
`landPlanMerge`), 13, refresh, and `markTaskCompleted/Failed/Cancelled` for onboarding and upgrade
tasks. Sweep (B3.2): every 60 s compare `rev-parse HEAD` with `synced_head` and the state-dir hash
with `synced_hash` (mtime/size prefilter), skipping checkouts with MERGE_HEAD/REBASE_HEAD; the
tooling page, upgrade-status and plan overview also enqueue a deduplicated SYNC.

Plan (B2): flush guard in `writePlanMirrorLocked` — if the on-disk `plan.json` blob is neither
`synced_hash` nor the render about to be written, reconcile first; skip (row stays dirty) while
MERGE_HEAD/REBASE_HEAD exists. Three-way reconcile per node and field with the rule table above; a
node in base, missing from incoming and untouched locally is deleted and reported; local-only
nodes kept; edges and code links merge per key; with no base the reconcile stays additive and
never deletes. `resolveHaiveProjectionConflicts(worktree)` replaces `autoResolvePlanFiles`: reads
stages `:1:`/`:2:`/`:3:`, runs the same pure merges for state files and `plan.json`, regenerates
`plan.md`, `git add`s; runs in plan merges, in the merge resolver before any fixer (committing
directly when nothing else conflicts), and in 13; add/add and delete/modify stages tested.

refresh (B0.2): with a usable checkout and an origin — credentialed fetch; refuse on tasks in
flight, dirty tracked files (after set-aside, once B3.1 exists), unpushed commits
(`origin/<b>..HEAD > 0`) or divergence, naming the count; `merge --ff-only` with 00a's
`--deepen=50` fallback; `persistDetection`. Without a usable checkout, today's clone/copy but the
old tree is moved aside (the `extractArchive` pattern); a copy refresh is refused when the volume
copy has commits the host copy lacks; no origin → "nothing to refresh from".

Repo-level content (B4): `deriveRenderTargets(cliTargets, lspLanguages)` in shared (so the api
computes the same) drives agent/skill dirs, `supportsLsp`, the RTK fan-out and the import stubs;
the upgrade form offers "Also maintain files for: <CLI>" (default on); removal on the tooling
page makes the next upgrade offer that CLI's files as obsolete. The rules region renders from
`agent_rules_override ?? DEFAULT_AGENT_RULES`; a region rendered from a personal override becomes a
`clean_update` at the next upgrade because `loadCliRulesRenderHashes` knows it as a prior render.

Adopted defaults (the owner can override at approval): retire `.haive/install.json`; legacy
mirror files read as fallback only; settings classification as in the design summary;
remote plan deletions applied only with a base; agents may not change `.haive-data/state/**` on
task branches (reverted at cleanup); bundle descriptors portable, claims `foreign` until the
bundle exists locally; a remote reset stamps the local reset epoch; step guidance not synced.
