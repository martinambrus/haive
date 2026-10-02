# Onboarding template versioning

Deterministic onboarding artifacts (agent specs, slash commands, `workflow-config.json`, Drupal LSP plugin files, the `agents/README.md` index) are registered as `TemplateItem`s in `packages/worker/src/step-engine/template-manifest.ts`. Every item has:

- `id`: stable slug (e.g. `agent.code-reviewer`, `command.review`, `workflow-config`).
- `schemaVersion`: integer, bumped only on shape-breaking changes (filename change, new required frontmatter field).
- `contentHash`: sha256 over the rendered reference output, computed on worker boot from `REFERENCE_CONTEXT` and cached per-manifest.
- `render(ctx)`: invokes the existing generator and returns `TemplateRendering[]`; multiple renderings per item when an agent fans out across CLI target dirs.

On worker boot, `syncTemplateManifestCache(db)` upserts the manifest into Postgres (`template_manifest_cache`) so the API can compute the current set hash without importing worker-side generators. Per-repo install state lives in `onboarding_artifacts`, one live row per `(repository_id, disk_path)`, soft-deleted via `superseded_at`.

**The applicable set is what the render context renders, at every writer.** 12, 01, 02 and 04 write
`repositories.applicable_template_ids` from the context they render, and a project-state sync that
changes the render context of a repository with a claim writes it in the same transaction through
01's own functions (`step-engine/_upgrade-render.ts`); none keeps an id it does not render.
upgrade-status compares a claim the set holds against the manifest, and reports a claim the set does
not hold as changed while 02 could still act on one of its paths: one that is absent, one holding the
bytes its row records as Haive's, or an RTK settings file whose hook can come out. A path 02 keeps (a
person's bytes, a link, a file past 1 MiB) stays quiet, since no plan could finish it. Custom bundle
items and the cli-rules region keep their per-repository comparison, and a NULL set reads as the
installed one. A repository with no claim keeps its set until 01's first plan: with no claims a
recomputed set makes every applicable template read as changed. Boot recomputes the set of every
repository with a column and a claim (`recomputeSyncedApplicableSets`), since a sync from before
the set followed the column moved the column alone and no later sync of the same files repairs it.

**An item `REFERENCE_CONTEXT` renders empty carries its own `referenceCtx`.** A hash of nothing
never changes, so the banner could never see such an item's body change: the three PHP LSP plugin
files and the two RTK settings files, gated on PHP LSP and on RTK, hashed `sha256('')` from the day
they shipped. Each now renders in a context that selects it. `agents-index` stays empty on purpose,
since its body is per repository and the upgrade plan compares it per repository. Rows recorded while
an item hashed empty still carry that hash, so `syncTemplateManifestCache` converges them in the
transaction that moves the cache (`convergeReferenceHashes`): a row whose written hash is today's
body takes the new hash and reads as current, and one holding an older body keeps the empty one, so
the banner offers the newer.

## When changing a template

1. **Body-only change (rewording an agent prompt, fixing a typo, updating a command example):** edit the generator in `_agent-templates.ts` / `07-generate-files.ts`. The manifest's `contentHash` recomputes on worker boot and the upgrade-status endpoint starts reporting the template as changed. **Do not bump `schemaVersion`.**
2. **Shape change (rename agent id, change `workflow-config.json` schema, change a command's disk path):** bump the item's `schemaVersion` in `template-manifest.ts`. Rollback across a `schemaVersion` bump restores the prior artifact's stored bytes (migration 0013) and reverts correctly; only legacy rows written before stored content existed refuse to revert across a bump (they have no prior bytes and re-rendering a changed shape is unsafe).
3. **New template:** add the generator, append to `buildTemplateItems()` in `template-manifest.ts`. First upgrade per-repo will surface it in the `new_artifact` bucket.
4. **Removed template:** delete the `TemplateItem`. First upgrade per-repo will surface existing artifacts in the `obsolete` bucket.

Out of scope of onboarding-upgrades: `.claude/skills/` and agents written from LLM discovery (06_5) without a bundle source, `.haive-data/knowledge_base/`, `.claude/mcp_settings.json`, `.claude/onboarding-review.md`. **Skills and agents installed from custom bundles are tracked and upgradable** (each bundle item lands as an `onboarding_artifacts` row with `templateId = "custom.<bundleId>.<itemId>"`; the `bundle_resync` step before `01-upgrade-plan` refreshes git bundles and the upgrade-plan/apply path treats `custom.*` rows the same as Haive templates). LLM-generated skills and KB content are refreshed by the `/workflow` code-change phase. Project knowledge lives under `.haive-data/` — `knowledge_base/` and `learnings/` — not under a vendor dir, because Haive is model-agnostic; the canonical paths are `KB_DIR`/`LEARNINGS_DIR` in `packages/shared/src/knowledge-paths.ts`, and `stripManagedKnowledgeGlobs` makes them impossible to scope-exclude from the folder pickers (06_7/09_7, the api exclusions endpoint, and the repos-page editor). `mcp_settings.json` is user-owned — created on first onboarding, never rewritten.

## Upgrades and rollbacks

**An upgrade also restores the rules delivery 07 set up outside the manifest.** `02-upgrade-apply`
re-creates each currently enabled import-mode provider's `@AGENTS.md` stub (`CLAUDE.md`,
`GEMINI.md`) through `ensureRulesImportStub` (`steps/onboarding/_rules-files.ts`, the helper 07
itself calls), and records a refused link per file instead of throwing, since a throw there would
skip the applicable-template and install-manifest writes after it. Without the stub a
claude-family CLI never loads AGENTS.md, rules block included, and nothing else ever wrote it back.
`GET /repos/:id/upgrade-status` checks the same files through the same module
(`@haive/shared/rules-files`, with each provider's `rulesFile` in the catalog), so a repository
whose only gap is a missing import still gets the upgrade banner. A rules file linked anywhere but
AGENTS.md is reported apart (`linkedRulesFiles`) and never offers an upgrade, since the restore
refuses to write through a link, and a repository root the api cannot read claims nothing.
`03-upgrade-commit` stages the paths 02 reports writing (`writtenPaths`) beside its base list,
because a workflow task checks out HEAD: a refreshed block left uncommitted never reaches one. It
also stages each stub 02 left holding the import whose HEAD copy lacks the line
(`headLacksImport`), and a `CLAUDE.md -> AGENTS.md` link 02 left alone. It stages AGENTS.md itself when
its cli-rules region on disk is missing from HEAD or differs from HEAD's (`agentsRulesVerdict`):
only the region is compared, so an edit elsewhere in the file never triggers it, and a file it
cannot compare (a link, one past 1 MiB) is reported rather than guessed. A write list alone misses
two cases: 02 reports `unchanged` for a stub an earlier attempt of the step wrote before failing,
and for one onboarding wrote with its commit off, so both stayed out of HEAD for good. The HEAD
check greps the blob rather than reading it back, since a read-back is capped by the child
process's output buffer and a file past it would read as "missing"; a check that fails for any
reason other than a missing HEAD stages nothing. It never stages rules files by name beyond that, so a person's uncommitted edits
elsewhere stay out of the upgrade commit; a stub that IS staged goes in whole, the same file-level
granularity AGENTS.md already had. A link is staged through its own check (`isLinkToAgentsMd`),
since `hasWorkspaceEntry` refuses every link. A rules file or an RTK settings file
(`RTK_SETTINGS_PATHS`) git ignores is left out on every route, AGENTS.md included, and reported
(`dropIgnoredRulesFiles`), and `12-post-onboarding` applies the same filter to what it stages: the
stage runs `git add -f` for `.haive/install.json`'s sake, which would otherwise commit a personal
CLAUDE.md or settings file the repository deliberately keeps out of history. 12 stages a settings
file only through its live artifact row, never by name, so one Haive did not record stays out. The
check runs after any `git init`, since before it there is no repository to ask.

**The cli-rules row records the region on disk, not the render.** 07 leaves an existing region
alone unless its overwrite flag is on, so `12-post-onboarding` reads the region back and records
it through `cliRulesRegionRecord` (`steps/onboarding/_rules-files.ts`): the region's bytes and their
hash as `templateContentHash`, so a stale region shows as an upgrade and a rollback restores bytes
that were really there. The row claims those bytes as Haive's (`writtenHash` equal to that hash)
only when they are a render, this one or one an earlier `onboarding` or `upgrade` row of the
repository recorded; a `backfill` or `rollback` row does not count, since its hash is whatever was
on disk. Anything else keeps the render's hash, so the upgrade plan offers the region as a
conflict, whose default is skip. No region on disk means no row, and a live one is retired, since
it would read as the person's deletion. `01-upgrade-plan`'s backfill applies the same rule to the
region: it used to store the whole file, which a rollback could paste into the region.

**Every backfill row claims only a render, whatever its kind.** The backfill used to record the
disk's hash, so an edited file became its own baseline and the next template change pre-selected
overwriting it as a `clean_update`. A path with no row whose bytes no render accounts for (this
render, or for the rules region one recorded earlier) is now a `conflict`, not a pre-selected
`new_artifact`, and on a repository's first upgrade every path has no row. 01's backfill records
nothing for such a path: nothing there is Haive's until 02 writes it, and a row would belong to the
upgrade with no prior, which a rollback reads as a file the upgrade introduced and deletes. 02
records the path only when it replaces the file, keeping what it held as a superseded baseline (the
rules region through `cliRulesRegionRecord`, any other file through `backfillRecord`). It keeps one
for a live row too when the bytes on disk are not what that row records, or a rollback of an
Overwrite would restore Haive's old bytes over the person's edits; 02 retires the row and the
baseline in one instant, and the baseline, written after the row, wins 04's `generated_at` tie. Both apply
one rule to bytes that are not a render: the bytes are `writtenContent`, so a rollback restores
them; the render's hash is `writtenHash`, so they are never taken as Haive's; and their own hash is
`templateContentHash`, so the template reads as not installed. A rollback copies both hashes, so a
restored file is offered again at the next upgrade rather than classified `unchanged`.
`GET /repos/:id/upgrade-status` keeps one row per template, and a rendering that is not current
stands for it, so such a file keeps the banner up beside current siblings. A path with no row at all
is invisible there once a sibling rendering has one; the next upgrade still offers it.

**A file already holding the new render is recorded, never asked about.** A live row whose
template moved while its path already holds the current render (one another install upgraded and
git brought here, or one a person brought up to date by hand) is `adopt`. It used to read as a
`conflict`, since the bytes matched neither the row's baseline nor its render, and asked the person
to choose between two identical files. 02 retires the row and inserts a `backfill` row claiming the
render, writing nothing, and outside `writtenPaths`, `createdPaths` and `retiredRowIds`: 03 stages
nothing for it, and a rollback, which restores only what the upgrade replaced, leaves it. The bytes
are read again at apply, since the form parks between the plan and the apply, and a file changed
meanwhile is left for the next upgrade; a retry finds the row already retired and records nothing
more. A form shown for anything else names the adopted paths in a note, and an upgrade with nothing
else to ask runs without one.

**An upgrade or a rollback deletes a file only while it holds what Haive wrote there, judged on
the bytes it deletes.** `removeIfHaives` (02, shared by 04) hashes them the way the plan compares
them (the whole file, or the rules region alone) against the row's `writtenHash`, at APPLY time,
because the form parks between the plan and the apply. A file is judged on the inode it takes:
`removeFileIfNoFollow` (`@haive/shared/fs-safe`) moves it to a private name in its directory first,
so a save landing meanwhile makes a new file the delete never touches, and puts a refused one back
without replacing a file written since. The rules region is stripped the same way
(`rewriteFileIfNoFollow`): rewritten on the parked inode and put back, since a strip over the file at
its path overwrote a save that landed between its read and its write. A file with no region, or no
AGENTS.md at all, is left as it is; the strip used to write that absence as an empty AGENTS.md,
which 03 then committed. Only a writer that already held the file open can still land between the
judge and the act, and nothing short of a lock it takes too can exclude one. A link or a directory
standing there is kept the same way, since neither is what Haive
wrote; only a read that could not run fails, which leaves the row for the next attempt. A row
alone proves nothing:
`12-post-onboarding` records one even for a file 07 skipped. 02's obsolete removal keeps such a file,
warns, and leaves its row live. 04's undo of a file the upgrade introduced keeps one edited or replaced
since, warns, and retires the upgrade's row all the same. 04 also reads only the rows the upgrade WROTE
(`source = 'upgrade'`). 01's backfill rows belong to the same task, but they record what was already
there, and read as new files they were deleted: on a first upgrade's rollback, that took every
adopted file the person had declined.

**Every upgrade read stops at one cap, and a path it did not read is never taken for nothing
there.** `readUpgradeFile` (`@haive/shared/rules-files`) reads no further than
`RULES_FILE_READ_CAP` (1 MiB) and answers `absent` only for a missing path: past the cap, a link,
anything but a regular file and a read that fails are `unread`. The plan used to read a link as
absent, offer a new file there pre-selected, and the write then threw and failed the whole apply.
01 now marks such an entry `unread` under `UNREAD_HASH`, which matches no record and reads neither
as deleted nor as new, and 02 offers no choice on it: the form names it, with why, in one note, and
the apply skips it whatever the form sent. The form parks between the two, so 02's writes,
removals and hook strips check the cap again on the bytes they touch, and a removal it could not
compare says so rather than that the file was edited. 04 leaves a path it cannot read where a
removed file or region would go back, and says so; a link in the way there used to throw and fail
the rollback. upgrade-status reads the RTK settings files, and 01's rules-import note names only
the stubs the apply can add a line to, the same way, so neither offers what the apply refuses.

**A rollback puts back what stood before, absence included, from what 02 recorded.** Reading it off
the rows failed three ways: a file missing before the upgrade came back from the row that recorded it,
or from a backfill row written while it was missing; a row an old reset superseded was restored over
bytes it never held; and a file already holding the render with no row was deleted as new. So 02
records every path it wrote into nothing (`createdPaths`: no file, or for the rules region no region,
with the live row it retired there) and every row it retired or kept as a baseline (`retiredRowIds`).
04 removes a created path under the check above, an AGENTS.md it created for the region whole while
nothing else was written to it, and puts the retired row back live, so a reinstated file reads as
deleted again. Any other path restores the newest row the upgrade retired there, and a path with none
held the bytes the upgrade wrote, so only its row is retired. 01's backfill records no row for a file
missing from disk. An output from before the record falls back to reading the rows, and only those
retired no later than that upgrade completed: a later upgrade that failed part-way leaves its
records at the same paths.

**02 records what stood at a path before it writes there, so a retried apply records what the first
attempt did.** The record is its own statement ahead of the write, never part of the transaction
that retires the rows, since an apply that fails after writing leaves paths that now hold the
render and show nothing of what stood there. A retry finding the render takes the newest record an
earlier attempt of the step made for that path. Every write gets one: the bytes that stood, recorded
as the row that records them when they match it (its hashes, snapshot and schema version, so
restoring it restores what restoring that row did), or a marker where nothing stood, which carries no
observed hash and, for the rules region, `''` where the file stood without the region. Only a path
with no row that already holds the render records nothing. A marker names its path in
`createdPaths` and is never in `retiredRowIds`. It takes the instant the transaction retires a row
at its path, which is how a retry tells the live row the failed attempt retired where nothing stood
from one something else retired since. An earlier attempt's own rows hold what it wrote, so a retry
drops them from what it reports retired.

A restore replaces only what the upgrade left there (`restoreIfUpgrades`): the file, or the rules
region, is judged on the bytes it replaces against its upgrade row's `lastObservedDiskHash`, else
its `writtenHash` (a hook strip claims none of what it left), read by id at apply so a payload
detected earlier still judges. A file or region edited or removed since is the person's and stays,
reported, and one that cannot be compared (a link, past 1 MiB) stays too. Its ledger reverts all the
same, a `rollback` copy of the row before marked `userModified` with what the disk held, so the next
upgrade judges the file against the version before; it is not counted as reverted. One already
holding the restore is an earlier attempt's, and counts. A save that takes the name while it is
judged keeps it, and the warning names where the parked bytes went.

A path the upgrade REMOVED gets its bytes back the same way. The upgrade wrote no row there, so 04
used to visit only the rows it wrote and never put back an obsolete file it deleted, and a file no
row recorded had nothing to restore from. 02 now keeps what each removal took (the file, or the
rules region with its markers) as a baseline and names the path in `removedPaths`, and 04 puts it
back only where nothing stands now: a file created at the path since, a region written into
AGENTS.md since, or an AGENTS.md removed since is what someone did after the upgrade, and stays.
That baseline is written before the removal it records, from the bytes the plan saw there, because
an absent path says nothing about who removed it: an apply retried after its removal ran finds the
file gone, and so does one whose file a person deleted while the form was parked. Only the first
finds an earlier attempt's baseline, and records the removal; the second drops its own, so a
rollback leaves the file deleted. A removal that keeps the file drops its baseline too. What
already holds the restore is an earlier attempt of the same rollback, which a retry takes as put
back. Such an upgrade, like one that only took RTK blocks out, can leave no live row at all, so
upgrade-status offers its rollback from what 02 recorded (`lastUpgradeRemovedContent`) until a
rollback completes after it. It answers as
onboarded for any repository an upgrade was started on, whether that upgrade is running, failed or
finished, since POST /tasks starts one only on an onboarded repository and the banner shows nothing
for any other. A file a rollback puts back whose template its
snapshot does not render stays out of the applicable set, where upgrade-status reports it while it
holds what its row records, so a file restored after RTK went off is offered for removal again. A
rollback also puts back, live, every row the upgrade untracked (02's `untrackedRowIds`) while no
live row records that path, touching nothing on disk.

**One upgrade or rollback runs at a time, and a rollback undoes the newest upgrade once.** Both are
`onboarding_upgrade` tasks, and two side by side apply and revert the same files: an upgrade parked
on 02's form applied over a rollback that ran meanwhile, and a second Roll back click queued a
second revert of the same upgrade. POST /tasks and the rollback route insert either through
`insertUpgradeTask` (`routes/upgrades.ts`), which refuses with 409, naming the live task, while
another one of the repository is live, under a per-repository advisory lock so two clicks cannot
both pass the check. The rollback step reverts the newest completed upgrade, so the route accepts a
rollback only while that upgrade is the newest completed task of the two kinds
(`latestUpgradeToRollBack`): after a rollback nothing is left to undo until another upgrade
completes, and upgrade-status offers no rollback either. The banner offers the live task
(`inProgressUpgradeTaskId`) whether or not drift is left to review, where "Continue upgrade" used to
start another, and hides Roll back while one runs. A check at creation cannot see a Retry of one
that failed, which revived it beside the next, so the rule is also an index
(`tasks_one_live_upgrade_per_repo_idx`, migration 0168): one live `onboarding_upgrade` task per
repository, whoever writes the status. The api answers its violation 409 in `errorHandler`,
whichever route revived the task. The worker revives one whose parked form is answered, and a
refusal there would drop the answer, so the submit route refuses such an answer before storing it; a
revival the worker still loses to a race reads as the task not pointed and records
`upgrade.revive_refused`. Its statuses are the api's `LIVE_TASK_STATUSES`, pinned by a test. Both
create routes write the task, its event and its move to `queued` in one transaction, since no sweep
starts or ends a `created` task, and one left by a failure part-way would block every later upgrade
and rollback. The migration fails the ones an older release left that way before it builds the
index, and then keeps each repository's newest live one.

**Switching RTK off reaches the upgrade.** 01's render context takes the repository's live
`rtk_enabled` wherever the context recorded a choice. One from before RTK recorded none and stays
off, since the column defaults on. The RTK settings files (kind `rtk-config`) then read as
`obsolete` and go only under the rule above, and 03 records each removal (`deletedPaths`, `git rm
--cached` while the path is still absent), or HEAD would keep the hook and every worktree checked
out from it would restore it. Nothing records the ones a blank scaffold seeds (a row needs a task,
and INIT has none), nor any of a repository with no rows at all, so for those 01 renders the RTK
templates as if RTK were on, for every CLI in the catalog since the scaffold seeded them for the
CLIs enabled then, and offers a file still holding that render, or its hook, as `obsolete` against
the render's hash. A blank repository is probed whatever other rows it has, skipping only the
paths a live row records: onboarding records one for a seeded file only when it renders that
template itself, with RTK on and the file's CLIs still enabled. Any other repository's rows are
taken as the whole record. One someone edited is kept by that rule, so the form offers instead to
take the hook out of it, unticked (`withoutRtkHookEntry`): only hook items whose command is exactly
RTK's go, with the entries and lists they leave empty, and the file keeps its own indent and line
endings. A file that parsing and writing back would change anywhere else (an integer past 2^53,
`1.0`, an escape, a repeated key, spacing of its own), or one nested too deep to write back at
all, is not offered. One that is not valid UTF-8 is kept at apply and says so, since writing its
text back would put U+FFFD where the bytes it could not decode were. What it held becomes a superseded baseline and the new live row claims none of it
(`writtenHash` stays the render's), so a rollback puts the hook back and no later upgrade or reset
takes the file as Haive's. A retry after an attempt that took the hook out and failed before
recording it finds the file holding what the plan's bytes strip to, and records that edit with the
plan's bytes as what it held. A plan whose RTK choice was the repository's live one
(`rtkFollowsLive`) is refused at apply once RTK is switched again, since the form parks between the
two, and retrying the plan step plans it afresh. The "off" synthesized for a context from before
RTK was nobody's choice and is never compared. The RTK block is no manifest item, so 02 takes it
out of AGENTS.md, CLAUDE.md and GEMINI.md by its markers, as a reset does, with the newline 07 wrote
after it (`stripRtkBlocks`). A link is refused and reported, as is a file past the 1 MiB cap the
plan reads with or one that is not valid UTF-8, and a `CLAUDE.md -> AGENTS.md` link is left to
AGENTS.md's own pass. Each strip records what the file held before it changes (`rtkBlockStrips`),
in a superseded row kept apart from the rows a rollback restores (`RTK_BLOCK_RECORD`), and a retry
that finds the block gone takes the record an earlier attempt made while the file still holds what
that strip left: a save that took the name while the strip was parked is not its doing. A rollback puts the blocks back
ahead of the rules region, whose restore would move the file off what the strip left, and only
while no RTK block stands in the file: all of what the file held while it still holds what the
strip left, else the blocks appended the way 07 appends one. The same blocks standing there count
as put back; another block, or a file removed since, is kept and named. The `@AGENTS.md` stubs 02
restores stay, since without them a claude-family CLI never loads AGENTS.md. 03 keeps a stripped
file git ignores out of the commit, whichever provider it belongs to. 01 names the files holding a
block, so the form says what will change. `GET /repos/:id/upgrade-status` reads no RTK settings template as current for such a
repository and reports the files still holding a block (`rtkBlockLeftovers`), and the settings
files no row records that 01 would offer for removal (`rtkSettingsLeftovers`): it looks where 01
looks, reads RTK's choice in the same order, and judges each file by the predicate 01
uses (`holdsRtkSettings`), so the banner offers the upgrade, and never one whose plan offers
nothing. A repository never onboarded gets neither, since POST /tasks refuses it an upgrade.
Switching RTK back on offers the settings files again, and the banner says so: an
upgrade or a sync computed while it was off left their ids out of `applicable_template_ids`, so upgrade-status
counts an RTK template as applicable again while RTK is on and the providers of the context 01
renders from read its file (`RTK_SETTINGS_READERS`, `@haive/shared`, the list 07 renders from too).
Both resolve that context in one order (`renderContextOrigin`, `@haive/shared/project-state`).
A writer (12, 02, 04) whose record write fails clears the column, so that order falls back to the
snapshot its own rows carry rather than to a column it could not move (`writeProjectStateRecord`).
First comes the repository's render context column, whose RTK choice is its stored
`rtkChoiceRecorded` and whose providers are its own or, for a column the project-state sync filled
with the portable fields alone, the owner's enabled ones. Then comes the newest snapshot that
recorded the choice, ahead of one from before RTK (`pickSnapshotRow`, by `newestArtifactsFirst`),
since an upgrade replaces only the paths it writes and rows from several runs stay live side by
side. So the banner and the plan read the same context, and a repository whose snapshots all
predate RTK stays quiet. Only a re-onboarding writes the block.

**"Keep my edits" is a decision; Skip is not.** Both leave the file alone. Keep also records the
version declined, so the next upgrade offers only a newer one. On a live row it moves
`templateContentHash` in place. An untracked path gets a `backfill` row whose `writtenHash` is the
render, so it claims nothing, and a rollback, which reads only `upgrade` rows, never takes the file
for one it introduced. Skip records nothing, so the path is offered again. An obsolete Haive file
has no newer version to decline, so it is kept by "Keep these files, and stop tracking them": its row
is superseded and the file left, and neither the plan nor the banner offers it again until a rollback
of that upgrade puts the row back. Removal wins when one file is picked for both.
`unclaimBackfilledEdits` (`data-migrations.ts`) brings the rows written before into that shape: only
such a row has `user_modified` with `written_hash` equal to `last_observed_disk_hash`, and it and its
rollback copies get the two hashes swapped.
