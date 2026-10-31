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
01's own functions (`step-engine/_upgrade-render.ts`); none keeps an id it does not render. 01, 02, 04
and the sync all expand the context through `unionExpandedFor`, so the set holds the custom bundle
items (`custom.*`) and `cli-rules` as well as the manifest's templates: 02 writes it inside its fenced
transaction, 04 from the context it restored. The `cli-rules` entry is the repository's own region:
one helper, `buildRepoCliRulesBlock` (`@haive/shared`), renders it from the repository's rules
override (`agent_rules_override`, read by the worker through `readAgentRulesOverrideRaw`) or else
Haive's default rules, never from a user's providers, and the api's upgrade-status recomputes it
the same way. An override is rendered as written, only shaped (runs of blank lines collapsed, the
blank lines before its first line and the whitespace after its last dropped, so a first line that
opens an indented code block or list keeps its indent, inside the markers), never deduplicated the
way provider rules once were, so a repeated instruction or command survives; the default rules go
through the old merge, which drops nothing from them. An empty override renders no block, which
reads as obsolete. Changing this shaping needs no manifest bump: the region is no manifest item, so
upgrade-status offers the new bytes (a `clean_update`) only to repositories whose render moved. 12
keeps its own rule
for the `cli-rules` region on disk. Its artifact snapshots describe what 07
rendered, while its applicable set reads the live RTK switch at the actual write, under the
project-state lock and a repository row lock: a switch between 07 and 12 leaves the snapshots as
history and the set truthful. 04 captures the column at apply entry and fences its applicable-set
and record writes against it, with the current task still holding the checkout; a newer column or
a released task refuses those writes. It does not extend that fence to the artifact rollback choices
(T310).
upgrade-status compares a claim the set holds against the manifest, and reports a claim the set does
not hold as changed while 02 could still act on one of its paths: one that is absent, one holding the
bytes its row records as Haive's, or an RTK settings file whose hook can come out. A path 02 keeps (a
person's bytes, a link, a file past 1 MiB) stays quiet, since no plan could finish it. Custom bundle
items and the cli-rules region keep their per-repository comparison, and a NULL set reads as the
installed one. A custom item 01 cannot render (an agent with no agent target, a skill with no
skills directory) is current for neither side: it raises no banner of its own, and its live rows go
through the same check as a claim outside the set. A repository with no claim keeps its set until 01's first plan: with no claims a
recomputed set makes every applicable template read as changed. Boot recomputes the set of every
repository with a claim (`recomputeSyncedApplicableSets`): a sync from before the set followed the
column moved the column alone, and a release adds templates no stored set holds, so without it a new
template stayed out of the banner until the next 12, 01, 02 or 04 write. A repository with no column
resolves its context from its snapshots, as 01 does, and keeps its set when none resolves.

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
skip the applicable-template and project state record writes after it. Without the stub a
claude-family CLI never loads AGENTS.md, rules block included, and nothing else ever wrote it back.
`GET /repos/:id/upgrade-status` checks the same files through the same module
(`@haive/shared/rules-files`, with each provider's `rulesFile` in the catalog), so a repository
whose only gap is a missing import still gets the upgrade banner. A rules file linked anywhere but
AGENTS.md is reported apart (`linkedRulesFiles`) and never offers an upgrade, since the restore
refuses to write through a link, and a repository root the api cannot read claims nothing.
`03-upgrade-commit` stages the paths 02 reports writing (`writtenPaths`) and removing (`deletedPaths`),
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
stage runs `git add -f`, since a curated deliverable may sit under an ignored path, which would otherwise commit a personal
CLAUDE.md or settings file the repository deliberately keeps out of history. 12 stages a settings
file only through its live artifact row, never by name, so one Haive did not record stays out. The
check runs after any `git init`, since before it there is no repository to ask. A person's own file
07 left untouched (`leftAsIs` on 07's output: one already standing where a template would go, or a
rules file that is not UTF-8) is never staged by 12's own `git add`, though its row is recorded;
an output from before that field stages as before. A repository 12 had to `git init` is the
exception: its first commit takes the whole working tree on purpose, the person's files included,
since a worktree checks out tracked files only.

**Both commit steps stage by name, from records, and commit only what they staged.** Neither names
a directory: `git add -f` of `.claude/skills/` or `.haive-data/` also took a person's untracked or
git-ignored file beside Haive's. 12 stages (`collectOnboardingStagePaths`,
`steps/onboarding/_stage-paths.ts`) what this task's own step outputs record: 07's `wroteFiles`, its
live artifact rows and `quarantinedAgentFiles`; 08's `written`, `removedPaths` and
`mergedRemoved`, plus the KB `INDEX.md` it rewrites; 09_3's `kbWritten`; 09_5's `written` for each
`mirroredDirs` entry (SKILL.md, the `subSkillSlugs`, the dir's README) and 09_5b's repairs, whose
removals come from git (every file HEAD tracks under a repaired skill's directory that is gone from
disk, since the repair clears the whole directory); and the
files 12 writes itself (the `.haive-data` plan mirror, the project state, the legacy mirrors it writes when no record was written, and the `.haive/install.json` and legacy mirrors it retires), kept
even when a write threw after some of the files landed. The plan mirror reports what it wrote and
removed through an accumulator (`writePlanMirror`'s `changes`), also on a throw, so a plan file the
refresh never reached (a symlink it refused) is not staged, and a mirror that failed before it knew
the plan was empty removes nothing. A
quarantine target under `<agents>-legacy/` is staged only when its source is in HEAD, together with
the source's deletion: an agent git never tracked is the person's file, and its move is theirs to
commit. A removal is staged with `git rm --cached --ignore-unmatch` from a record, and only while the
path is still absent from disk, never with `add -u <dir>`. The legacy knowledge
move (`.claude/knowledge_base` and `.claude/learnings` into `.haive-data/`, done by 08's `detect`) has
no record, so a Retry of 08 cannot lose it: 12 reads it from git and the disk. A file tracked in HEAD
under a legacy directory and gone from disk has its deletion staged, and so is the file now at
`legacy/<rel>` and `<rel>` under the destination (`LEGACY_KNOWLEDGE_MIGRATIONS`), whichever exist: the
migration moves to `<rel>` whenever that slot was free, whatever sits at `legacy/<rel>`. A legacy file git
never tracked is the person's, so its destination is not staged, as with 07's quarantine. A file an
agent writes without reporting it stays uncommitted. The commit is built in a private index, not
with `git commit --only` (which re-reads the named paths from the worktree) and not from the real
index (another writer, the plan-mirror save or a Terminal `git add`, can stage a newer blob there
between our own steps). `commitRecorded` (`_stage-paths.ts`) reads `HEAD` into a private
`GIT_INDEX_FILE`, runs `git add -f` for the recorded files and links and `git rm --cached` for the
removals against it, takes the names that differ from `HEAD` there, and commits them with
`write-tree`, `commit-tree` and a compare-and-swap `update-ref HEAD`. It then sets exactly those
names in the real index to their entries in the CURRENT `HEAD` (`update-index --cacheinfo`), so the
index agrees with the newest commit even when another writer committed on top in between; a `HEAD`
moved to something that does not contain the commit is left alone, and a `HEAD` that moves during
the sync is retried. Every other real-index entry,
a file the person staged included, is neither committed nor unstaged (a blob they staged at one of
those very names is not committed and is reset to `HEAD`). A pathspec is `:(literal)`
and the changed list is read with `--no-renames`, since a detected rename would name only the new
path and leave the deletion out. A merge or cherry-pick in progress is refused, which fails the
step loudly, as `--only` did. The first commit of a
repository 12 or 03 had to `git init` is the one exception, as above.

**The cli-rules row records the region on disk, not the render.** 07 leaves an existing region
alone unless its overwrite flag is on, so `12-post-onboarding` reads the region back and records
it through `cliRulesRegionRecord` (`steps/onboarding/_rules-files.ts`): the region's bytes exactly
as they stand on disk (CRLF, trailing whitespace and blank lines included) as the row's content, and
the hash of their `normalizeContent` form as `templateContentHash`, so a stale region shows as an
upgrade and a rollback, or a retried Keep, restores bytes that were really there. The render is the
repository's block: 07 reads its rules override live when it writes the region and returns it in its
output (`agentRulesOverride`; an output from before the field reads as the default rules), and 12
renders from that value, never from the live column, so the row records what 07 put on disk even if
the override moved since. 12 compares nothing and refuses nothing here, since an error in recording
the rows is swallowed together with all of them. An empty override writes no region (07), records no
row (12) and reads a standing region as obsolete (an upgrade). Every rules
record is raw for the same reason (`pathContent` in 02 too) and every hash over one is taken of the
normalized form; a row an earlier version wrote holds the normalized text and keeps restoring it.
The row claims those bytes as Haive's (`writtenHash` equal to that hash) only when they are a
render, this one or one an earlier `onboarding` or `upgrade` row of the repository recorded; a `backfill` or `rollback` row does not count, since its hash is whatever was
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

**The banner and 01 derive the render targets from one module.** Which agent directories and skills
directories a repository renders to is `project-state/render-targets.ts` in `@haive/shared`
(`deriveRenderTargets`, `originAgentTargets`, `skillTargetDirs`, `agentFilePath`, `bundleItemRenders`,
`rendersAt`), and the worker's 07, 01 and bundle expansion use the same repository membership and
legacy completion, so the two cannot drift (`render-targets-drift.test.ts`). A recorded CLI set,
including an empty one, is authoritative. Legacy contexts recover recorded membership and preserve
an actually recorded agent fallback separately; only unresolved legacy membership uses the old
local-provider completion. Disabling a person's provider does not remove a repository target.
An explicit repository target change can make a live path obsolete, subject to ownership and the
normal Keep choice. A row 02 would keep stays quiet, and no agent kind is judged where no context
resolves.

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
anything but a regular file and a read that fails are `unread`, and so is a file that is not valid
UTF-8 (`undecodable`): decoded leniently, its bad bytes became U+FFFD and a rewrite wrote that back.
`updateFileNoFollow` refuses such a file the same way (`NotUtf8Error`), so 07's rules append and the
knowledge writes report it skipped and leave every byte. The plan used to read a link as
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
`upgrade.revive_refused`. Its statuses are `LIVE_TASK_STATUSES` (`@haive/database`
`repository-task-lock`), pinned by a test. That module also holds the repository lock every
creation and revival of an onboarding, upgrade or rollback takes (advisory key, repository row
`FOR UPDATE`, root claim, the opposing live task): the api's routes and the worker's revival of an
answered form and the allowance auto-resume run `checkRevive`, and for an upgrade or rollback
`upgradeAdmission` (`@haive/shared/onboarding-admission`, which the api re-exports), on the locked
repository row in the transaction that revives. A worker refusal leaves the task failed and records
`upgrade.revive_refused` with its reason. A refused auto-resume does not retry each tick. It takes
the poller's notify path instead: it stamps `allowance_replenished_at` and keeps the provider, so the
person gets the "allowance is back" notice and decides whether to Retry. The stamp is fenced to the
refused watch's `awaiting_provider_since`; a watch from before that column, which a later cleared
one cannot be told from, is dropped without a notice. In the api, `revive-write-ratchet.test.ts`
fails any `.update(schema.tasks)` that may set a live status (a computed one included) unless an
awaited `refuseReviveBesideLive` precedes it on its own path, or it moves only a `created` task. Both
create routes write the task, its event and its move to `queued` in one transaction, since no sweep
starts or ends a `created` task, and one left by a failure part-way would block every later upgrade
and rollback. The migration fails the ones an older release left that way before it builds the
index, and then keeps each repository's newest live one.

**What an upgrade renders from is a context someone recorded.** A row's `form_values_snapshot`
counts as a snapshot only if it decodes as a render context, with the decoder the column uses
(`isRenderContextSnapshot`); `{}` or a shape the catalog no longer knows does not, and the read falls
through to the next row or to the history path. A rollback restores from the first prior snapshot that
decodes and stores null rather than `{}` when none does. A row never records an `rtkEnabled` that was
synthesized rather than chosen: `recordableContext` drops it unless the choice is live, for 01's
backfill rows and every row 02 writes. RTK leftovers (the block and the settings files) are removed only
when `rtkLeftoversToRemove` holds, a recorded choice and the switch off; the banner, 01's plan and 02's
strip all ask it, so the banner offers exactly what the upgrade will do.

**Switching RTK off reaches the upgrade.** 01's render context takes the repository's live
`rtk_enabled` wherever the choice is recorded (`isRtkChoiceRecorded`): the context recorded one, or a
person switched RTK on this install (`repositories.rtk_choice_made_at`, stamped by the Tooling page's
PATCH when the value changes and by either answer to the RTK question). A context the
project-state sync filled records one only from a record that carries `settings/rtk-enabled.json`
(below). A context from before RTK recorded none and, unless a person switched RTK since or a record
carrying the setting was imported, stays off, since the column defaults on. The RTK settings files
(kind `rtk-config`) then read as
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
two, and so is a plan that did not follow the switch once a person has switched RTK since
(`rtk_choice_made_at` set): the record already carries the setting, so applying that plan would leave
the installed files behind it. Retrying the plan step plans either afresh, and a plan made with the
stamp set always follows the switch. The "off" synthesized for a context from before
RTK was nobody's choice and is never compared. A plan is refused the same way once the render
context column holds another context than 01 read (`renderContextColumn`): a sync that began before
the upgrade task existed reads no live upgrade, and can commit after 01 planned from the old column,
which 02 would otherwise write back. 02 reads the column under the sync's own lock
(`lockProjectState`): a sync still in flight commits first, and one that starts later sees the live
upgrade and defers. A cleared column is no sync, which always writes one. The same check runs again inside each later write that would undo a newer sync, in the same locked transaction as that write (`refuseMovedColumn`): the applicable-template set 02 writes, and its record write (`expectedColumns`), whose files are then written under the lock as well. A Cancel releases the checkout while 02 is still applying, so a refresh can sync in that window; a write that finds the column moved refuses with the same message and leaves the newer column, set and record as they are. A sync that commits after one of those writes recomputes for itself. The record write also refuses once 02's own task no longer holds the checkout, and a refresh
re-checks for a holding task and fast-forwards under that same lock (`repo/refresh.ts`), so a Cancel
cannot let a fast-forward land between 02's check and its files. 02 also stops at a Cancel before
its record write. The rules override is stamped the same way: 01 records the one it read
(`agentRulesOverride`, NULL for the default rules, `''` for an empty override), and 02 reads it
under that lock before any write and refuses the plan (`PLAN_NO_LONGER_HOLDS`) once it moved, since
it writes the region from the plan's text and renders nothing again. NULL and `''` are different
overrides, and a plan from before the stamp is not compared. 07 has no plan to go stale and 12
compares nothing (above). One residual: the record write at the end of 02 first imports a checkout
it has not read (`writeProjectStateColumn`), and only an imported render context sends that writer
back to plan, so an import that moves the override can land after the region was written. The next
upgrade then offers the region as a `clean_update`, and a retry of 02 refuses its plan and needs a
re-plan. The RTK block is no manifest item, so 02 takes it
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
renders from read its file (`RTK_SETTINGS_READERS`, `@haive/shared`, the list 07 renders from too):
for a context recovered from the last onboarding, the providers its step 07 recorded.
Both resolve that context in one order (`renderContextOrigin`, `@haive/shared/project-state`).
A writer (12, 02, 04) whose record write fails clears the column, so that order falls back to the
snapshot its own rows carry rather than to a column it could not move (`writeProjectStateRecord`).
The step does not fail: it keeps a warning and reports `recordWrite: 'failed'` in its output
(`'written'`, or `'skipped'` when it had nothing to record), which tests read instead of the wording.
A fenced write (02's) clears it only while it still holds a context 02 planned against: a sync
that took the lock after the failed write and before the clear is newer than both, and stays.
First comes the repository's render context column, whose RTK choice is its stored
`rtkChoiceRecorded` or a person's switch (`rtk_choice_made_at`), as everywhere the choice is read,
and whose providers derive from the repository's recorded `cliTargets`, including an empty list.
A legacy context without membership uses its recorded provider metadata, then the owner's enabled
providers only while membership is still unresolved. Then comes the newest snapshot that
recorded the choice, ahead of one from before RTK (`pickSnapshotRow`, by `newestArtifactsFirst`),
since an upgrade replaces only the paths it writes and rows from several runs stay live side by
side. Once a person has switched RTK, the switch is the choice, so the newest snapshot is read
whatever it holds and an older row that recorded RTK no longer hands the plan an older framework
or older targets. A rollback that takes the live rows' context picks the same way, and expands its
applicable set with the live switch wherever the choice is recorded, as every reader renders it: the
flag it writes, which is the plan of the upgrade being undone having followed the switch (read
before the expansion), or a person's switch. So the banner and the plan read the
same context, and a repository whose snapshots all predate RTK stays quiet.

**Maintained CLIs belong to the repository.** `render_context.cliTargets` is the union of stable
provider names, carried by the existing `cli/<provider>.json` member units. It never changes a
person's enabled providers or carries their provider ids or credentials. Shared
`deriveRenderTargets` drives agent targets/formats, rule readers, LSP, RTK fan-out and skill
directories from that set; shared directories are deduplicated. Unknown names remain in the record
without acquiring destinations an older install does not know. An explicit `[]` is authoritative.

The convergent boot repair `seedRepositoryCliTargets` runs before applicable sets are recomputed.
It uses the actual context/snapshot decoder, skipping malformed rows and snapshots with no
membership information, but stopping at a recorded empty list. Membership comes from the newest
valid snapshot that records it; an existing authoritative column stays as it is. Recovering the
rest of a missing context retains the RTK-aware `pickSnapshotRow` policy described above. The repair
holds the ordered repository/project-state locks and repository row, defers for live root claims,
onboarding/upgrade holders or a journal, and marks a real change dirty in that transaction. It adds
no schema migration. Ordinary planning, writer admission and sync also complete recorded legacy
membership under their existing exact column/task/reset guards, so a held boot repair does not
require another worker restart after the task completes.
When neither the maintained context nor valid snapshot history records membership, a validated
caller snapshot can complete it from its recorded metadata. Current/history precedence, including
explicit empty sets, remains authoritative; the writer does not query today's enabled providers.

Old onboarding also wrote a Claude-format agent fallback when no provider had an agent directory,
including Amp-only and zero-provider contexts. The internal `legacyAgentFallback` context/snapshot
flag preserves that actually recorded target without inventing Claude membership. It does not
travel in the portable render unit. Unchanged target choices and unrelated tooling saves retain
it; a real target change clears it for the normal upgrade preview. New contexts and genuine
explicit empty selections have no fallback merely because stale target metadata exists.

07 adds the onboarding user's enabled CLIs to the repository set and carries its original-column
fence through 12. Blank INIT writes the record through the same journaled writer and includes its
returned paths in the initial commit. 01 offers missing locally enabled CLIs as a default-on
"Also maintain files for" choice, then recomputes the plan. The repository-card banner offers an
upgrade when these additions are the only pending change; checking status or starting the task does
not adopt them. Declining the choice after a removal keeps that
removal authoritative, even while the CLI is enabled locally.
The Tooling read completes recorded membership without writing it; a missing, refused or
unresolved current context displays those names read-only until setup or configuration completion.
Its explicit `POST /repositories/:id/cli-targets/remove` action still requires a valid current
context and compares canonical recorded membership against the observed set under bounded
ordered locks and records the dirty revision atomically; a stale list, active root claim,
onboarding/upgrade holder or journal holds it. A no-op does not clear legacy fallback or dirty the
record. This action leaves files and ledger rows in place: the next upgrade offers owned obsolete
files with its usual Keep choices. 04 restores files while preserving current repository membership.
Before restoring or retiring snapshots, 04 captures that membership and normalizes only the
CLI-derived facts of new rollback snapshots; if no explicit current authority or surviving or
assured replacement proof can preserve it, rollback refuses before any mutation and requires
configuration completion and a fresh plan.

The sync merges CLI members three ways with the record's base; the writer owns a removed CLI unit
only when a validated previous base named it. Legacy records with no CLI units preserve recorded
local/snapshot membership unless a populated prior base proves removal. A fresh NULL context with
no recorded membership starts with `[]`, rather than today's local providers. Legacy foreground
snapshots inherit an authoritative repository set under the writer's existing gates. Exact caller
column/task/reset fences remain in force: an explicit list that omits maintained members is refused,
as is an unfenced differing list. A persisted legacy 02 plan whose original recorded membership
differs from the newest valid artifact history must be planned again before any product file or
ledger changes; a newly planned snapshot records the chosen membership for its own retries.
Likewise, 12 completes a saved legacy 07 payload before publishing snapshots while retaining its
actual rendered-file scope; when an immutable saved column fence cannot recognize that completed
own result, it refuses before mutation and requires generation again, leaving matching retries
and payloads without the old fence compatible. The
complete raw watermark, journal and final checkout checks are unchanged. 12 and 03 consume the
writer's reported paths for scoped staging.

For bundled skills, 12 records main and sub-skill claims at the destinations saved by 09_5's
generation detect, preserving an explicit empty list and the legacy Claude default only when the
destination field is absent. Completing repository membership does not claim files at additional
destinations; an ordinary upgrade can offer missing maintained bundle paths later.

**A key both installs changed is held for an answer, never settled for the column's side.** The
project-state sync merges the checkout's record against the base it last synced from. A render key
both sides changed since that base, differently, becomes one pending row in `project_state_conflicts`
(migration 0188; `base`, `local` and `incoming` as `{"v": value}`, NULL for a side with no such unit;
one pending row per repository and unit by a partial unique index), written in the sync's own
transaction. The column keeps the local value and the sync row keeps the OLD base for that key. A repeat
sync of the same files writes nothing; a changed incoming value moves the same row; a pending render
row whose unit no longer conflicts (the teammate went back to the base or took this side's value) is
stamped `resolution = 'converged'`. A writer (12, 02, 04: `writeProjectStateRecord`) renders
`project/render.json` with each contested key at its row's `incoming` value and records the row's
`base` for it in `base_snapshot`, reading the rows under the lock, while the column stays the
writer's own. Without that the writer settled the conflict silently: the file and the base both
became the local value, so the next sync saw no difference and a teammate's value was gone.
`upgradeAdmission` refuses (`contested`, with the units) while a row that holds upgrades is pending
(`blocksUpgrade`: render, claim and RTK units; a contested setting or environment unit does not), so
POST /tasks, the rollback, the banner, and every revival in the api and the worker hold, and
upgrade-status returns `contestedUnits` and offers nothing. Workflow tasks keep running on the local value. The
reset deletes the repository's rows with its sync row.

**A conflict is answered by the worker, one key at a time.** `GET /repos/:id/project-state/conflicts`
lists the pending rows (a side is `{present: true, value}` or `{present: false}`, so a JSON null is a
value and an absent side is marked; `key` is the render key, null for the whole file),
`GET .../conflicts/:conflictId` returns one row answered or not, with its `resolution` (how the
banner tells, after a 202, whether the answer it sent is the one that closed the row), and
`POST .../conflicts/:conflictId` takes `{answer: 'keep_mine' | 'take_theirs'}`. The api never touches
the checkout: it enqueues `RESOLVE_PROJECT_STATE` on the plan-mirror queue and waits for the result
(`resolveProjectStateConflict`, `project-state/resolve.ts`), because the worker owns every write to
the record files. One transaction takes `lockProjectState`, the repository row and the conflict row
`FOR UPDATE`, then: a closed row answered the same way returns itself (200), answered otherwise is
`settled` (409); a live onboarding or upgrade (the sync's own `CHECKOUT_HOLDING_TASK_STATUSES` query)
is `busy`; the key is read from `project/render.json` with strict fs-safe reads, and a file that no
longer holds the row's `incoming` is `moved`, which re-syncs the checkout (the row then carries the
new value) and refuses the answer. Keep mine leaves the column, writes this install's value into the
file and into the base for that key; take theirs sets that key in the column (validated by
`renderContextColumnSchema`), recomputes the applicable template ids (`writeApplicableTemplateIds`)
and sets the base for the key to the incoming value, leaving the file as it is. Only the answered key
moves in the file and the base, so every other pending key stays at the teammate's value and at its
old base, and still holds the upgrade. The row is stamped `resolution`, `resolved_at`,
`resolved_by`, and `last_error` is recomputed from what is still pending (a refusal reason there is
left alone). A cleared column with a per-key row is rebuilt as the sync rebuilds it
(`rebuildLocalRender`); a whole-file row has no local value, so only take theirs applies and keep
mine is refused (`no_local`). Keeping mine rewrites a tracked file: it stays uncommitted until the
person commits and pushes it, as with any record change. The file is rewritten after every database
write, so only the commit follows it; the bytes read for the `moved` check are put back
(`writeFileNoFollow`) if the transaction then fails, and the row stays pending. A render file
the checkout deleted never makes a conflict: the sync returns `absent` before its transaction when
`project/render.json` or the state directory is gone (`readCheckout`), so no row has an absent
`incoming`, and the one a deleted file leaves pending stays `moved` until the file is back.

**One question is not a render key: an imported RTK-off this install never applied.** A repository
imported before the mirror import set `rtk_enabled` from the tooling it read holds the column's
default `true` beside imported tooling that says `rtkEnabled: false`. Before `rtk_choice_made_at`
(0208) the tooling page wrote the column alone, so nothing says whether a person switched RTK back on
before then, and a migration would have to choose. `needsRtkQuestion` (`project-state/rtk-conflict.ts`, pure) asks exactly when
this install recorded no RTK choice (no `rtk_choice_made_at` and no `rtkChoiceRecorded` in its render
context: a recorded choice is this install's own, and it travels), the
stored tooling says off, the column says on, no local `04-tooling-infrastructure` output equals that
tooling (the test `holdImportedMcpServerLists` uses) and no row of the unit exists in any state, so
an answered question is never asked again. The legacy `tooling.json` import takes the blob's
`rtkEnabled` only under the same condition. `persistDetection` calls it after the project-state sync and the fallback mirror import, which supply
the tooling and the choice it weighs, and
the boot entry `raiseRtkQuestions` (convergent) calls it for every repository. Every successful
project-state sync runs the same lifecycle through `raiseRtkQuestionLocked` inside its import
transaction, after the tooling, choice and conflict rows have moved: adopting an RTK-on choice
closes a pending question immediately, as adopting RTK-off already does, and imported tooling
without a recorded choice can raise one without waiting for a boot. Each writes one
pending row of unit `settings/rtk-enabled.json` (`RTK_ENABLED_UNIT`; base and local `{"v": true}`,
incoming `{"v": false}`) under `lockProjectState`, `ON CONFLICT DO NOTHING` on the pending index, and
there is no migration. The unit is no render unit: the writer overlay, the sync's converge pass and
`loadPendingRenderConflicts` skip it, while the api list and one-row reads, the `RESOLVE_PROJECT_STATE`
job and `upgradeAdmission` take it (`isConflictUnit`, `blocksUpgrade`). The worker answers it
under the same locks and the same busy, closed-row and different-answer rules, and writes no file
itself. Either answer is this install's choice and stamps `rtk_choice_made_at`, so the next record
write carries `settings/rtk-enabled.json` with it and a teammate's file can no longer override it:
keep mine leaves the column; take theirs sets `rtk_enabled = false` through `rtkEnabledUpdate` (the
columns the tooling page's PATCH writes, `rtk_enabled` and `updated_at`, which that route uses too).
Both stamp the row. Neither recomputes the applicable ids nor touches the rules files, since the
PATCH does not: after take theirs, the next upgrade, which the answer releases, removes the RTK
settings files and block as it does after any switch off; after keep mine, RTK stays on and the
upgrade renders it on. A pending row stops asking once RTK is off
here by any route: every writer of `rtk_enabled = false` (the tooling page's PATCH, 04's save, the
mirror import) stamps it `converged` in the transaction that writes the column
(`convergeRtkQuestion`), and `raiseRtkQuestion` and the boot entry do the same for a column that is
already off or whose choice is recorded (`rtk_choice_made_at` set, or `rtkChoiceRecorded` in the
render context), which closes a row raised
before the question read the stamp. The banner words it from the unit, since its
key is null like the whole render file's (`isRtkConflict`).

**The ledger follows the record: another install's claims are imported as markers.** The record
carries one claim file per live row (`artifacts/<claimFileName(path)>`: path, portable template id,
kind, schema version, template and written hashes, Haive version), written by 12, 02 and 04 through
`writeProjectStateRecord`. A claim names a relative, canonical path with no segment git reads as
`.git` (`isClaimablePath` through `namesGitData`, which mirrors git's NTFS and HFS+ checks: `.git`
or `git~1` in any ASCII letter case, followed only by dots and spaces or by a `:` stream name, and
`.git` with HFS+'s ignorable code points; a `\` separates segments as `/` does, and the check is linear in
the path's length): a record never imports a claim to git data, 02's `safeDiskRel` refuses such a
path as a backstop, and 01 neither lists nor reads a ledger row imported before the
rule. A claim file at such a path that an earlier release wrote, under its own file name, does not
refuse the record: the codec reads it apart (`gitDataClaims`), the sync keeps it in the base for the
writer to remove at the next write (and marks the record due), and no merge, import or set-aside
check reads it as a claim. Any other claim at a path no claim may name still refuses the whole
record. The writer removes only a claim file the previous `base_snapshot` named
and the new render no longer produces, so a teammate's unsynced file is never touched, and it
returns `{written, removed}` for 12 and 03 to stage. The sync reads those files back: it loads the
live rows as claims (`loadRecordClaims`), merges the whole record (render and claims) three ways
against `base_snapshot`, and moves the ledger to the merge inside its one transaction. A path whose
merged claim differs from the local one, or that this install held none for, has its live row
superseded (`imported_at` stamped) and an **import marker** inserted: `task_id` NULL, `source =
'backfill'`, `source_step_id = 'project-state-import'` (`isImportMarker`), `imported_at` and
`generated_at` the import instant, the claim's hashes and Haive version, `written_content` only when
the bytes on disk hash to the claim's `writtenHash`, and the render snapshot of the merged column.
That snapshot names the marker's own agent in `acceptedAgentIds`, since the boot repair
(`supersedePhantomAgentArtifacts`) retires an agent row its snapshot does not accept. A claim the
other install removed while this one left it unchanged retires the row (`superseded_at` and
`imported_at`); a claim only this install holds, and a live row that renders no claim (a custom item
whose bundle is gone), stay. Migration 0189 lets the table hold them: `task_id` is nullable, and a
CHECK allows a NULL task only for a marker, which must carry `imported_at`. A claim both sides
changed is settled by the bytes on disk: the side whose `writtenHash` the file holds wins, and
incoming when it holds both, since the two then differ in metadata only. Bytes that hold neither
leave one pending row of unit `claimFileName(path)`, which the writer overlays and
`upgradeAdmission` counts as it does a render key; a pending claim row is answered like one (keep
mine writes the claim file and the base at the live row, take theirs retires it and inserts the
marker). The import runs before the pending rows are settled, so a row is never closed `converged`
when the right outcome was to import their claim. A checkout with no claim file while the base holds
some is a record from before it carried claims, and retires nothing. The sync's base keeps the
checkout's claims, each conflicted one at its old base, so a second sync of the same files writes
nothing and the writer keeps owning its claim files. It defers while a reset holds the root claim
and stands down when `onboarding_reset_at` moved after it read the checkout; a clone's or a
refresh's own claim does not stop it, since they call it. The applicable set is written after the
ledger and the settings have moved, whenever the column or the ledger did (a flip of the RTK flag
is a column move), so it renders the live RTK switch as the sync leaves it.

**A bundle's source travels as a descriptor, and is never merged.** The record also carries one
`bundles/<bundleFileName(source)>` file per portable bundle source (`{source, name}`), so another
install can name a source a claim points at (`bundleDescriptors`, shared). Two local bundles at one
source (`custom_bundles` has no unique index on it) collapse to the smallest name in code-unit order,
since the codec refuses a source listed twice and would fail the whole write. A descriptor in the
previous `base_snapshot` that no local bundle holds is kept while a claim's template id starts
`custom:<encodeURIComponent(source)>:`, and removed (reported in `removed`) once none does; a
descriptor file the base never named is not touched, like a claim file. A descriptor for a bundle
that has no installed item can flap across pushes between two installs that disagree on holding the
bundle: each write adds or removes it. The ledger is unaffected. The sync reads the descriptors
into the base as the checkout holds them and leaves them out of the merge: a conflict row on one could
not be answered by anybody, and `upgradeAdmission` would hold every upgrade for it.

**A record writer imports unseen checkout bytes before replacing them.** Migration 0213 appends
`project_state_sync.synced_hash`, separate from `base_snapshot`: the base deliberately keeps the old
side of a contested key, while the watermark acknowledges the raw, complete checkout read. It uses
`projectStateHash` over the files' `gitBlobId`s, including unknown files and the original whitespace;
`absent` means no files, empty directories included. A writer reads the bounded checkout under the
project-state lock. An unstamped or changed valid record goes through the sync's same three-way
import (`syncProjectStateLocked`) there, with no nested pool transaction. A context that import moved
commits as the newer context and refuses the stale writer, which must plan again. Pending conflict
rows still overlay incoming values in the files and retain their previous base. A refused or unread
record is held, never stamped or overwritten; files with no render unit hold too, while a truly empty
record can be created. Rejected settings still follow the ownership rules above, including manual
repair of an unowned malformed RTK file. That case keeps its warning and dirty revision after writing
the other units, since no writer supplied a replacement. Sync stamps only after the checkout is
re-read just before its commit, and rolls its imports back if it moved. A successful writer stamps
only the exact expected complete output, after comparing the original bytes again on each parked
rewrite or removal (new files use exclusive creation). Answer writers and HEAD-base rebases
invalidate the watermark rather than acknowledge sibling files they did not import. The working-tree
`rebaseProjectStateOnCheckout` and its `rebaseLocked` wrapper still have only test callers; they are
retained deliberately, and the set-aside production path uses `rebaseProjectStateOnHeadLocked`.

**A separate observer learns checkout changes Haive did not make.** The plan-mirror queue keeps
its 10-second dirty-projection sweep and adds a 60-second checkout sweep. It keyset-pages every
ready repository with a checkout, including repositories with no outbox row, and queues one
`sync-checkout` job per repository. A Stop without a worker hook, a dead task, a capped cancel
re-drive or a failed first import therefore does not remove the repository from later checks.
The tooling page, upgrade banner and plan overview also send a best-effort authenticated
`POST /repos/:id/sync-checkout` hint through the same deduplicated queue path. GETs stay read-only;
the hint is asynchronous and does not promise that the first GET already contains imported data.

The observer reads the actual named checkout and hashes the complete bounded raw record on every
pass. It never uses timestamps or the configured repository branch as proof: a different named
branch may import, while a detached or unborn HEAD, unreadable Git state, no usable Git root of
its own, an open Git operation, a live root claim or a checkout holder defers observation. It does
not fetch, switch branches or copy from a folder import's source; those still require Refresh.
Recovery precedes record import. The observer passes the expected ref and HEAD through the
existing admission, recovery, sync and writer transactions, which recheck them before committing.
Plan import/reconciliation uses its separate lock and admission checks, even when HEAD and the
state hash have not changed, since a person can edit plan.json at the same HEAD.

Migration 0214 appends nullable `project_state_sync.synced_head`. A checked observer records only
a still-named HEAD whose complete raw record has been accepted; NULL means no such observation.
Writers, conflict answers and rebases invalidate that HEAD rather than acknowledge a checkout they
did not inspect. The HEAD is neither a file-ownership proof nor a replacement for `synced_hash` or
the normalized three-way base. A record with a prior diagnosis passes through refresh again even
when its bytes match the accepted hash, so restoring the exact valid bytes can clear a stale
refusal through the normal sync rules. `PROJECT_STATE_SYNC_ENABLED` defaults on and gates the
observer's scan, page hints and queued execution. Turning it off leaves existing sync-before-write,
recovery and dirty-projection flushing enabled, preserving their overwrite and crash protections.

**A filesystem attempt has a committed undo journal before changing the public record.** The writer takes
`lockRepositoryTasksKey` then `lockProjectState`, checks the column and its own task (or, for a
background refresh, opposing live onboarding/upgrade tasks and a reset claim), and commits a dirty
outbox revision with `write_intent` (0213). Both phases hold the repository row too: root claims
update that row without taking either advisory lock, so a reset claiming just after the last check
must wait until the writer's files and transaction finish. This bounded journal contains only changed record paths,
their before/planned bytes and original mode and owner; both sides obey the record reader's entry
and byte limits. Before that intent commits, fs-safe prepares complete before/after images in a
unique worker-owned 0700 capability directory under `.haive-data/.state-writes/`, outside the public
state tree. The intent records the directory and image identities. Preparation never publishes
record bytes: a crash or failed intent transaction may leave an unreferenced private directory,
while the public record and database remain unchanged. The worker-controlled staging parent has
its own exact `*` ignore file so these artifacts are excluded from ordinary Git status and staging.
An existing different parent/ignore file is refused rather than replaced. It then reacquires the same ordered locks, checks the checkout,
reset epoch (including the epoch refresh read with its column, so a completed reset cannot be
resurrected through the otherwise-compatible NULL column fence), column, holder, journal identity and database inputs again, and holds them through the
last file and database write. A refusal before preparation creates no intent. A new holder or changed
checkout after preparation leaves only that dirty intent, with no file, column, applicable-set or
base write by the record transaction. All pool operations are between transactions; code inside one
uses its `tx` only. A successful transaction consumes its journal with the watermark and revision
stamp, so a crash after COMMIT cannot undo committed output.

The sweep first undoes an uncommitted journal, then runs its normal sync/write. Every path must
still hold either its before or planned bytes before any undo begins, and every individual restore
uses a stable intent-private park and exclusive hard-link publication of a complete prepared image.
Forward create/rewrite/remove and undo recreate/rewrite/remove all use this protocol: no post-intent
public fill can be partial, and no random sibling park can become an unrecognized record entry.
Private before/after images and forward/undo parks remain addressable across a kill after rename,
after publication, or between the link and unlink of exclusive restoration. Every public CAS read
is capped before allocation. Rewrites refuse an actual parked owner/mode that differs from the
prepared replacement, restoring the actual inode without reverting a concurrent chmod/chown.
An undo recreation likewise refuses changed source metadata. Unrecognized bytes hold all paths
during preflight; metadata changes or edits after preflight can hold an already partially restored
journal at the individual CAS, and retry repeats that undo. A held journal retains a named error; exclusive restoration never overwrites a new public entry. A primary failure and a
failed restoration are both retained. Private capability/image substitution, links and unknown
artifacts are refused. Image bytes may alias a published public file, so recovery verifies their
raw contents and requires the exact before image whenever restoration needs it. Inspection bounds
each private artifact by the larger recorded before/planned length for that path, before allocation;
growing many published hard links cannot multiply the 1 MiB cap into unbounded aggregate reads.

Each preparation is bounded by the two ordinary record sides (at most 32 MiB of image content),
plus at most two stable parked entries per changed path, each read with the 1 MiB cap. Private
artifacts are conservatively retained after success and failed preparation; there is currently no
automatic garbage collector, so repeated writes can accumulate private disk usage. They never count
against the public record's limits. This retention avoids deleting bytes still reachable by a
concurrent editor. An older intent without prepared images first commits an image manifest under
the same admission locks, then reacquires those locks for undo; it never mutates public files using
an uncommitted staging capability.
Recovery reads only journal-owned paths through strict fs-safe reads after validating each recorded
before/planned side against the unchanged record entry, per-file and aggregate byte limits. A valid
claim rename can temporarily hold 4,097 entries (or more than 16 MiB) when the new file lands before
the old one is removed, even though both complete records fit. Applying the ordinary whole-tree
reader to that intermediate union would strand its undo forever. Recovery instead recognizes every
changed path before any undo, bounds the two-side payload and each read, and compares raw bytes
again in each removal/rewrite CAS; unrelated files are never read or rewritten by that undo. The
ordinary reader and final writer output still enforce 4,096 entries, 1 MiB per file and 16 MiB total. Both parked undo CAS reads carry the same 1 MiB cap before allocation, including a larger editor
file installed after recognition. New journals also record planned ancestor directories that were
absent before preparation. Recovery checks those paths and their bounded known-child listings before
any undo, then removes eligible directories with atomic, nonrecursive `rmdir` under a held, verified parent.
There is no directory rename/park artifact to strand when the process dies. Preexisting directories are never eligible; links and foreign children hold the
intent, including children arriving during removal. An identical empty replacement is the same
semantic planned footprint, as identical file bytes are under file CAS. An identity mismatch present at the attempt's check refuses it; an identical empty replacement
racing after that check is semantically equivalent and may be removed. The atomic syscall never
follows a leaf link or removes a file/nonempty directory. Failures propagate their original errors,
with no secondary restore path that could hide the first cause. Directory cleanup repeats after a crash, and a bounded
ordinary footprint read must succeed before the journal is consumed. Older journals without directory
history still undo their files; unknown directories are preserved, and an unreadable leftover footprint
keeps that older intent for explicit repair rather than claiming recovery succeeded.
Another crash during the undo can repeat it. A live holder, reset or open git operation holds recovery
as it holds a write. Removed files regain their recorded mode and owner; rewritten files preserve the actual CAS
metadata or defer when it changed after preparation. Direct sync producers defer while a journal exists, including one that appeared while
they waited for the lock, so they cannot import partial writer output. Pending conflict answers for
render, claims, settings/environment and RTK also return the existing busy/defer result while a
journal exists. They check only after owner/conflict authorization and hold the same project-state
lock from the journal read through any answer write: answering another render key could otherwise
rewrite a journal-owned file beyond both recognized versions and permanently hold recovery. The
answer leaves files, columns, conflict rows, bases and hashes untouched; after recovery or a committed
write consumes the journal it can be retried normally. Plan answers use their separate plan mirror,
whose files are outside the record journal. Dirty journal rows are swept
even with a NULL render column, which a failed foreground writer may leave under the existing
failure-clear rule. Recovery never publishes the abandoned target context or base: it restores the
prior files and leaves a NULL column NULL; the step's Retry can then write its snapshot. An actual
process death leaves the previously committed column in place, so normal refresh can finish after
undo. The failed foreground writer still preserves the attempted local side of pending conflicts,
as before. A CAS or final-hash refusal before the writer's first successful filesystem mutation
remains a moved-checkout refusal with no semantic cleanup. After an actual mutation it is a partial
`ProjectStateWriteError`, with the reached paths and the same foreground failure-clear/pending-local
cleanup as a SQL rollback; background writers keep their column. Merely listing an unchanged file
for staging does not count as a mutation, and an editor-owned refused path is never reported as
written. The journal intentionally does not track or undo another writer's database mutations.

**The record is kept current by an outbox, not only by 12, 02 and 04.** `project_state_outbox`
(migration 0194, one row per repository, mirroring `plan_mirror_state`) carries `revision`,
`written_revision` and `last_error`. A mutation of something the record holds calls
`markProjectStateDirty` (`@haive/shared/project-state-outbox`, a subpath of its own so the web's
import of `project-state` stays free of drizzle) in its own transaction: a bundle created, deleted
or uploaded (api `bundles.ts`), the items an ingest removed (`bundle-ingest.ts`), and 01's backfill
rows. The reset deletes the row, and the boot marks every repository with a render context dirty
once (`markProjectStatesDirtyAtBoot`), since a release that writes more of the record has no other
signal. The writer reads the row's `revision` under `lockProjectState`, before it looks at the
database, and stamps `written_revision` to what it read when it finishes, so 12, 02 and 04 leave the
row clean and a mutation that lands during a write stays dirty. The 10 s plan-mirror sweep calls
`sweepDirtyProjectStates` (`project-state/refresh.ts`, at most 25 rows with a render context, each
sweep in its own try): it skips a checkout with `MERGE_HEAD` or `REBASE_HEAD`, and looks again once it
holds the project-state lock, for the sync and for the write (`refuseDuringGitOperation`), since a
merge can open while it waits there: the sync then answers `held`, imports nothing it read and leaves
`last_error` alone, as the first check does, and the write refuses. Admission refused by the
earlier recovery fence also reports the live onboarding/upgrade/reset hold on a dirty row, without
changing its revisions, journal, files or semantic state; a clean row stays untouched. The error
distinguishes that admission hold from an open git operation, whose prior diagnostic stays alone. The under-lock git guard runs after the repository row is held and takes priority even when a live
holder or reset also appeared; both writer phases classify a live reset as an admission hold. A
missing row or a completed reset's changed epoch still refuses as a moved context, without a hold
diagnostic. Every sync producer also reads the checkout
again under the lock and answers `superseded` when the two reads differ, including a clone scan
and the re-sync after a moved answer, which do not request the optional git-operation guard. A
merge that opened and was given up while it waited cannot pass its intermediate record in. It runs the sync first, writes
nothing and keeps the row dirty with `last_error` when the sync was refused (a record in a
newer format included), deferred (a live onboarding task) or superseded, and otherwise writes with
`expectedColumns` set to the column it read, a column that moved waiting for the next tick. It
writes and never commits; 12, 03 or the person carries the files. `writeProjectStateRecord` keeps
its signature and is the column check around `writeProjectStateColumn`. The writer reads a file
through fs-safe and does not rewrite one holding the bytes, but still lists it in `written`, since a
commit step stages from that list and the file may never have been staged.

**A checkout move sets Haive's own pending files aside, then re-syncs.** The files the outbox and the
plan flush write (`.haive-data/state/**`, `plan.json`, `plan.md`) are projections of rows, so a move
of the checkout (`git merge --ff-only` in 00a and in refresh) must not be stopped by one, nor lose
one. A pending record undo journal defers the move even when the checkout is clean: a writer may
have committed its intent before its first file. The shared final move check reads that journal
under the project-state and plan locks before its clean fast path, so refresh, plan Pull/Save/confirm
and checkout merges cannot turn its recognized before/planned bytes into a third version. Set-aside
also checks before its first pass, and both state judgment and state restore repeat the check under
the project-state lock before marks, base changes or files. A put-back that includes state paths
refuses under those locks too, before index or byte changes; it throws naming the kept paths, since
silently dropping a staged put-back could lose the person's index state. Plan-only put-backs touch
no record-journal path. The journal remains dirty and intact for ordinary fenced recovery; after
that drain the caller can retry its move. No move resolves manual divergence or rolls the abandoned
writer's context forward. `setAsideHaiveProjections` (`project-state/set-aside.ts`) lists the projection paths that differ
from HEAD or are untracked and, when a state file is among them, runs the sync first. Each state
file must then equal what the sync base renders there (`renderProjectState` over `base_snapshot`,
which the writer sets to what it wrote and the sync to what it read; the raw checkout watermark
is separate and never substitutes for this per-file ownership comparison), and
`plan.json` must hash to `plan_mirror_state.synced_hash` while the database holds a plan; `plan.md`
is rendered from it on every flush and is never judged. A file that is not what Haive last wrote
(one the sync could not take, such as an unreadable edit, or one held back by a pending conflict)
refuses the move and is named in the caller's own outcome (00a `skipped`, refresh's status
message). Otherwise the revision is bumped first, under the domain's lock (`markProjectStateDirty`,
`markPlanMirrorDirty`), so a crash leaves the files stale and the sweep re-renders them. Each path
then returns to HEAD as a compare-and-swap on what the capture recorded: the file is rewritten,
re-created from HEAD or removed through a parked fs-safe judge only while it still holds the captured
bytes, mode and owner (`rewriteFileIfNoFollow`, `removeFileIfNoFollow`), and its index entry moves to
HEAD's through `git apply --cached` of a full-context patch whose preimage is the captured entry, which
git checks and writes under its own index lock, so a `git add` landing meanwhile refuses the swap
instead of being overwritten. Because git matches hunk context only, the entry the apply leaves is
compared with HEAD's and undone unless it is exactly that; an intent-to-add entry, which a diff cannot
show, refuses the move by name. Anything that moved sends the set-aside round again, and a path still
moving after `MOVE_ATTEMPTS` refuses it. Any directory the removals leave empty under
`.haive-data/state` goes too. The reader treats a tree holding no files (empty subdirectories
included) as absent, so the sweep can rebuild it; any file still requires a valid format file
and the usual complete, bounded record. A link or refused read is never treated as an empty tree. A removed
file and each directory its removal empties keep the owner and mode captured with them, which
whatever re-creates them, the put-back or the writer during the re-sync after a move, gets back while
the writer still owns it (`restoreKeptMetadata`, best-effort, as fs-safe's inherited owner is); a group
someone set meanwhile is kept, and so is a file mode other than the 0644 the writer gives a new file. The
put-back is the same steps in reverse under the same rules (the stored patch applied with `-R`), and
every put-back 00a triggers runs under its checkout's merge-dir lock (`inMergeDirUnlessClaimed`) and
is refused while another task's claim holds it. Each restore runs under the domain's lock, after the
caller's fence (`CheckoutFence`: refresh passes the checkout-holding task count) has read zero there,
and a task that started meanwhile answers `held` with the files untouched; 00a runs that restore and its move in its claim's merge-dir section (`withMergeDirSection`, fenced on the pass's epoch), so a Stop or a cancel refuses both; and the sync base is pointed at
the record HEAD now commits (`rebaseProjectStateOnHeadLocked`, read from HEAD's commit once before the transactions, each of
which checks only that `rev-parse HEAD` still names it; a HEAD with no record gets an EMPTY base rather than none, so an incoming record is three-way merged against the pending state and
a clash is asked about, never imported over it, and one whose record cannot be read keeps the old
base and answers in `last_error`), because the writer's base already holds the pending change and
a sync against it would read the incoming head as the other side's revert. The plan needs no such
step: its base (`synced_snapshot`) is only ever the plan.json last read in. A valid hand edit is
not refused: the sync that runs first imports it, so the database holds it and the set-aside loses
nothing. After the move, `resyncHaiveProjections` runs the sync, writes the record if the outbox is
dirty, reconciles the plan and flushes it, each in its own try; it reads nothing in while a merge or
rebase is open or while git cannot say whether one is, and looks again under the lock as the sweep does. The revision is bumped again after
the restore, since a sweep that ran between the two would have stamped it written. 00a calls it
only when the base is the checked-out branch (a ref-only update moves no file), and again after a
merge it drove; `persistDetection` keeps its two importers, because the legacy mirror files
(`environment.json`, `tooling.json`, `exclusions.json`) still restore repositories no record
covers; only its plan block moved into `syncPlanFromCheckout`, which the re-sync shares. A plan Pull,
Save & push and the `01-plan-merge` confirm set aside the same way around their fast-forward
(`integrateOrigin`): their fence is the checkout-holding task count (the confirm leaves out its own task
and counts only tasks working in the checkout itself), a Save sets aside only once the remote is ahead,
so a Save with nothing to land is never stopped by a waiting task, and a Pull refuses, by name, an
untracked file under `.haive-data/state/` that Haive did not write. A merge the resolver drives on the
checkout itself (00a's merge, 12 when the parent checkout is on the base branch, 13) sets aside after
it seeds the plan base and checks again under the projection locks right before `openMerge`, where a
file Haive rewrote since the set-aside sends it round again, up to `MOVE_ATTEMPTS`. Every outcome that
did not merge puts the files back and, once no merge or rebase is open, re-syncs them, a throw from
the merge section recovers them before it reaches the caller (put back while HEAD is still where the section started, re-synced once it moved or cannot be read), and reaching done re-syncs. The owner
and mode a set-aside captured ride in the merge state (`keptMetadata`, never the bytes), so the
call that ends a merge restores them even when an earlier call set the files aside; a merge left
open keeps them for its end. They are restored, and cleared, only after a re-sync that completed:
`resyncHaiveProjections` answers whether both halves re-synced, and one that returned early (a merge
or rebase open) or failed leaves `keptMetadata` in the state. Only a later call that ends the same
merge settles it. A merge that reached done, or a cancel that found the merge gone, settles nothing
again, so the projection sweep recreates those files with its own owner and mode. Every other
set-aside caller whose re-sync fails loses them the same way. A cancelled task's merge ends elsewhere, and each ending restores them
too: the abort job, a cancel that finds the merge already gone, or the next task's merge that
clears it, which takes them into its own state first. That clearing reads the checkout-holding count first, as a merge it opens does, and a state file edited by
hand halts it by name even when the incoming commit leaves that file alone, as it halts a refresh or
a Pull. An onboarding or upgrade that ends re-syncs at once
(`resyncAfterTaskEnd`): the sync defers while such a task holds the checkout, so a change pending in
the database, or an incoming record a move landed meanwhile, waited for the sweep. It runs once the
ending has committed: on completion after the bookkeeping, on failure after the containers are
cleaned, on a cancel once no sandbox is left, and on every path that marks the task dead. The API's
Stop has no worker hook; the sweep covers it. A task marked dead holds no checkout: every
checkout-holder check requires `dead_at IS NULL`, and its writer is refused as released.

A task branch carries Haive's projection files only as its base had them. Before 12 merges a task
branch (`merge_remove` or `create_pr`, same-branch or cross-branch), before 11a or 99 push it, and when
12 keeps or removes it, Haive puts back every `.haive-data/state/` and plan projection the branch
changed since it forked (`project-state/branch-revert.ts`); the knowledge base, the learnings and the
dependency-ownership files stay as the branch has them. One commit built from a scratch index moves
the branch ref, and only while its tip is still the one judged; worktree files that still equal the
old tip are restored and handed back to the sandbox user, and a file a person edited keeps its bytes
with only its index entry moved. Each put-back is a `branch.projections_put_back` task event (its
paths, commit, the tip before and the fork point), written before the ref moves and taken back only
when the move is refused, and the step's warning is rebuilt from those events on every pass, so a
Retry shows it again; 12's form lists the paths before the choice. A pass first finishes the last
put-back this task recorded for the branch: a ref still at the old tip moves to the recorded commit,
and a moved ref gets the worktree sync it never had, for the paths whose index entry still holds the
old tip, and the hand-back again for the paths an earlier pass restored. The record notes when the
worktree is done, so a later pass touches nothing. A record whose commit the branch no longer contains is dropped, and a git failure in any of
this, a worktree status or HEAD read included, and a restored file the pass cannot hand back, fail
the step rather than leave the worktree unsynced. 99's
push stays best effort but its put-back does not: a put-back that fails fails 99, and with a push
asked for, the Retry that then finds nothing left to commit still puts back and pushes. The
fork point is taken from the local base first: a record the local base holds ahead of origin is in
the branch's history, and origin's copy would undo it. A pass that finds the feature's merge already
open puts nothing back, since that merge's tip must not move.

**The record carries the portable settings and the environment.** `portableSettingsOf`
(`@haive/shared/project-state`, `settings.ts`) maps the repository row to `settings/<name>.json`:
`scope-exclude-globs`, `rtk-enabled`, `rtk-version`, `lsp-servers`, `lsp-server-versions`,
`chrome-devtools-mcp-version`, `review-dimensions` and `agent-rules`, and nothing else. `app_auth`
and `verify_commands` stay on the machine, since a committed login URL or command would be typed or
run on a teammate's. `agent-rules`, the repository's AGENTS.md rules override
(`agent_rules_override`), is the one setting whose file is its value: `settings/agent-rules.md`
holds the Markdown itself, not JSON (`TEXT_SETTINGS` and `settingFileName` in `raw-text.ts`, a leaf
that imports nothing because the web bundle reads `conflicts.ts`). A file is the canonical file of a
setting only under that name, so `settings/agent-rules.json` and `settings/<other>.md` belong to no
setting and are listed as ignored files (`settingNameOfFile`). It needed no format bump: a release
that does not know the file ignores it as an unknown one. `settings/rtk-enabled.json` is written,
named in the base and counted as this install's value only
while the choice is recorded (`withoutUnchosenRtk`, `isRtkChoiceRecorded`): the render column's
`rtkChoiceRecorded`, or `rtk_choice_made_at`, which a person's switch on the Tooling page and either
answer to the RTK question stamp, so that choice travels at the next record write. `rtk_enabled` is NOT NULL default true, so a default
nobody chose must not travel or outvote a teammate's choice. Until then the sync takes the checkout's
value with no conflict, and the writer neither writes the file nor removes one the base names. A
record that carries a valid file records the choice for the install that imports it, in the
transaction that imports it: a column the sync creates gets `rtkChoiceRecorded` true, and an install
whose column holds the flag false and no stamp adopts the team's value (`rtk_enabled` takes it, the
flag flips, rendering and the banner follow the live switch from then on). A record without the file
records none, so a clone's default never enters the record, and answering a render question into a
NULL column records none either. A stamped install adopts nothing, since its switch is its own choice.
The base keeps the checkout's valid value whatever the install recorded, a rebase included: an
unrecorded install drops it on read, and the writer owns no file while the flag is false. Adoption is
recorded by the flag alone, so a rollback whose plan predates it can write the flag back to false, and
the next sync adopts again while the file stands. The first sync after a switch, on a sync row whose
base never held the setting, keeps this install's value with no question and records the checkout's
in the base, so later changes merge three-way as any setting does; with no sync row at all, the
checkout's value still wins, even over a stamped choice (running-list item `FNF[rtk-first-import]`). A column holding nothing has no file (a NULL `scope_exclude_globs` is "never chosen",
not an empty list; a NULL `agent_rules_override` follows the default rules, while `''` is an
override that renders no block and travels as a 0-byte file, never as NULL), and
`environmentUnitOf` gives `project/environment.json` from
`onboarding_environment` without its schema version. The writer plans them into the record and the
base, and removes a file the base named that the record no longer holds. `settings/rtk-enabled.json`
is also the name of the RTK question's conflict unit; the writer takes the value from the column
and never overlays a pending row there, so the question stays open until it is answered. The marks are in `PATCH /repos/:id/exclusions`, `PATCH
/repos/:id/tooling` (a portable key only) and `POST .../tooling-upgrade`, 02 and 04, 09_7 (and 01g,
which runs its apply), `initializeRagSyncPrefs`, the clone import and the RTK answer.

The Tooling page edits the rules in a card of its own, with its own save. `GET .../tooling-config`
returns `agentRulesOverride` (NULL follows the default), and the card's save sends the key alone to
the tooling PATCH: text, `''` included, or null to follow the default again, the key absent leaving
it. The PATCH validates the text before any write (`normalizeAgentRulesOverride`, a 400 with the
reason otherwise; a body that is not a JSON object is refused 400 `invalid_body`, and one that is
not JSON `invalid_json`, before any field is read; a field of the wrong type, an unknown
`ragEmbedAction` or an unknown `repoMcpServersAction` is refused 400 `Validation failed` with the field
in `issues[].path`, before any lock or write), stores the normalised text, marks the outbox in the same transaction and answers
with what it stored. "Save tooling" never sends the key, so an unrelated save can neither pin the
default text as an override nor erase one. Choosing Override starts from the default text rather
than an empty editor, since an empty override is a choice that writes no block (the card says so),
and a change reaches AGENTS.md through the next upgrade, which offers it as a `clean_update` while
the region is unedited. The list, detail, create (the upload routes included) and exclusions
payloads leave the column out, as they do the render context, since it can be large (up to 64 KiB).

**The sync imports the settings and the environment, and asks when both installs changed one.**
`mergePortable` (`project-state/sync.ts`) merges the columns (local), the checkout's files (incoming)
and the base's settings and environment three ways, in the sync's own transaction, and writes the
columns it moved. A set (`scope-exclude-globs`) moves member by member; every other setting is one
value; the environment merges per key (`project/environment.json#envDetectData`, `#confirmedValues`).
A value is normalised before it merges, by the rules of the routes that store it
(`normalizeSetting`, shared: `stripManagedKnowledgeGlobs` and sorting for the scope list, the LSP key
set, `normalizeReviewDimensionIds`, trimmed non-empty versions, `normalizeAgentRulesOverride` for
the rules text: a leading byte-order mark dropped, CRLF and CR read as LF, trailing whitespace
stripped per line, blank-line runs collapsed, one final newline, and text of only whitespace read as
`''`; the environment loses the `__` prompt-only fields and gets
`ONBOARDING_ENVIRONMENT_SCHEMA_VERSION` back in the column). A value the column could not hold is
refused for that setting alone: this install's value stands, the base keeps the old one, the sync
logs it and the next write replaces the file where this install owns the setting. For the rules
text, that is a Haive region marker comment (`<!-- haive:name -->` or its closing form, which would
end or start a region early) or more than 64 KiB (`MAX_AGENT_RULES_BYTES`) once normalised; the
tooling PATCH refuses the same with a 400. The codec refuses the whole record for what would damage
it, and the PATCH refuses that too, so no save writes a record every reader would refuse: a lone
surrogate, a NUL (the writer's undo journal keeps file text in a jsonb column, which cannot hold
one) and a line the record reads as a merge conflict marker, a setext underline of seven `=`
included. An invalid `rtk-enabled.json` on an install that recorded no choice is left alone:
its writer owns no RTK file and cannot replace it with a default nobody chose. The repeated
warning and dirty mark remain until a valid file or a recorded choice supplies an owned value;
automatically repairing that case still needs a user decision about ownership. A column the merge left as it was
is not rewritten, so a legacy list in another order stays as it is. The checkout is read as _absent_
for a setting that is never unset (`rtk-enabled`, a NOT NULL column, and `scope-exclude-globs`, NULL
meaning "never chosen") and for the environment, so a missing file leaves the column alone and marks
the record dirty for the writer; any other missing file unsets its column where nobody changed it
here, so deleting `settings/agent-rules.md` resets the override to the default rules. **A base that
holds no setting and no environment (no sync row, or one written before the record
carried them) merges them as no base at all**: the checkout's value wins over a column nobody chose
(`rtk_enabled` is NOT NULL default true, and would otherwise push B's default back over A's choice on
B's first sync), except a switched `rtk-enabled` on an existing sync row, as above, and a set joins
both lists. An RTK-off import closes the RTK question as converged
(`convergeRtkQuestion`); the sync's own converge pass skips that question, whose base equals its local
side (`isRtkQuestion`), since no merge contests that unit (a boolean cannot differ from base and both
sides). When the merge leaves a value the checkout's file does not hold, the repository is marked dirty
(`markProjectStateDirty`), except for a contested unit, whose file is meant to differ. A contested
setting or environment key is one pending row (`settings/<name>.json`, `settings/agent-rules.md` for
the rules text, `project/environment.json#key`): the column keeps this install's value, the base
keeps the old one, and the writer renders the file at the row's `incoming` and the base at its
`base` (`overlaySettings`, `overlayEnvironment`), except for the RTK question. The writer also
settles the rows it passes (`recordLocalSide`): a column that comes
to hold the other side's value converges the row. Only an RTK row holds upgrades (`blocksUpgrade`,
D6), so an open rules question holds none; the api and the banner list every unit `isConflictUnit`
names, which is every unit admission can see; a plan question (`plan/<nodeId>#<field>`,
[plan canvas](plan-canvas.md)) is one too and never holds an upgrade. The banner shows each side of
a rules question as one fenced Markdown block, never as live Markdown, and an empty side in words.
The worker answers one under the same locks as a render key (`answerSettingsQuestion`,
`resolve.ts`): keep mine writes the column's value into the unit's own file and the base, take
theirs applies the row's value to the column through `settingColumnUpdate` and the base and rewrites
no file, and an answer reads as moved when the file no longer holds the row's `incoming` (it reads
the rules file as text and any other as JSON). A setting
this install has no value for cannot be kept (`no_local`), and one that is never unset cannot be taken
as absent (`invalid`). Bundle descriptors still do not install a local bundle.

**`.haive/install.json` is retired, not written.** Nothing read it, and a second 12 run changed it
(`appliedAt`, `lastTaskId`) so an identical re-run dirtied a clean checkout. 12, 02 and 04 now delete
it through `retireInstallManifest` (`_retire-install-manifest.ts`) only after their
`writeProjectStateRecord` succeeded, so the record always exists before the file that duplicated it
goes. The delete is judged on the inode removed (`removeFileIfNoFollow`, read capped at 8 MiB): only
a JSON object with `schemaVersion` 1, a string `templateSetHash` and a `templates` array goes, and
anything else at that name is the person's, kept and reported in the step's warnings. It returns
`removed`, `absent` or `kept`, and never throws. 12 lists the path in `ownRemoved` unless it was
kept, `absent` included, so a Retry after a failed commit still stages a deletion an earlier attempt
made; 02 lists it in `deletedPaths` only when this task removed it, now or in an earlier attempt
that recorded the removal as an `upgrade.haive_file_retired` task event, so a Retry after a later
failure still stages it, even one whose own record write fails and so retires nothing new (it lists
each such path that is gone, and says so when it cannot look them up), while a person's own
deletion of a file this task never judged is never claimed. An earlier record stops counting once
a retry sees anything at that path again, and that retry deletes it, so a later retry after a crash
does not count it: if the file then vanishes, the deletion is the person's and is not listed. The event is written after a read of the file at its own name passes the shape check and
before fs-safe parks it for removal, so no database wait happens while the file is parked; a file whose event cannot be written is kept and
reported, and an event whose file is not removed after all (replaced or deleted during that wait, or
a removal that failed) is taken back by its id, a failed take-back reported as a warning. A worker
killed between the event and the removal leaves the event standing, so a Retry that finds the file
gone, because the person deleted that judged Haive file meanwhile, stages the deletion the removal
would have made; 03 stages it like any removal.
04 writes no commit, so a tracked copy is left as an unstaged deletion. A reset still removes the
file, for installs that hold one.

**The legacy `.haive-data/environment.json`, `exclusions.json` and `tooling.json` are retired per
unit.** The record carries their values (`project/environment.json`,
`settings/scope-exclude-globs.json`, `settings/onboarding-tooling.json`) and the sync imports them,
so a 12 whose record write succeeded no longer writes any of the three files. A 12 with no render
context, or whose record write failed, writes them exactly as before and stages them: a mirror
is retired only by a successful record write. After a successful `writeProjectStateRecord`, 12 and
02 delete each one through `retireLegacyMirrors` (the same `retireHaiveFile` as `retireInstallManifest`,
`_retire-install-manifest.ts`), and only while the record file that carries its value exists: a
repository whose column holds nothing keeps its legacy file, which stays the only copy. The shape
check is the mirror's own (`schemaVersion` 1, the environment's two objects, a list of strings for
the globs, a `tooling` object); anything else at the name is the person's, kept and reported in the warnings. 12 lists the
path in `ownRemoved` unless it was kept, 02 lists it in `deletedPaths` only when this task removed it
(the same task event), 04
does not touch them. The clone import (`importHaiveDataMirror`) decides per unit too: a column is
left to the sync when the record's unit file exists in the checkout (`lstatNoFollow`, a stale legacy
file never outranks it); a column the sync then left empty (it threw, or refused, deferred,
superseded or found no record) is filled from the legacy file afterwards, still fill-if-absent. A
repository with no record unit is filled from the legacy file as
before, with B0.1's MCP consent hold on the tooling import.

**The tooling is one whole-value unit, never merged.** `settings/onboarding-tooling.json` holds the
`tooling` object of `repositories.onboarding_tooling` (`toolingUnitOf`, shared) without
`ragConnectionString` and `ollamaUrl` and without `ONBOARDING_TOOLING_CONSENT_KEYS`
(`withoutMachineLocalTooling`, which 12's legacy `tooling.json` write uses too): it is the name of
no portable setting, so `isSettingUnit` is false for it, no conflict row can name it and the
three-way merge never sees it, as for a bundle descriptor. A server list this install holds for
consent (`importedMcpSettingsJson`) is written as `mcpSettingsJson`, the key the other installs read,
so that holding a teammate's list here does not take it out of the record the next sweep writes. A
column of another `schemaVersion` or a unit past the 1 MiB file limit writes no unit; the value must still live
somewhere, so 12 then writes and stages `tooling.json` as before and neither 12 nor 02 retires it
(`toolingOutsideRecord`). The sync
imports it with the legacy importer's semantics and nothing wider: only a NULL column is filled
(`toolingColumnFromUnit`, `project-state/tooling-import.ts`), a column holding tooling is never
overwritten, and the machine-local and consent keys are dropped from an incoming unit, so a record
cannot claim an acceptance. The legacy `tooling.json` import drops the same keys through the same
helper (`withoutMachineLocalTooling`): a committed file never chooses this install's RAG connection
or Ollama endpoint. Every imported server list goes through `holdImportedMcpServers`, the
function the legacy import and the boot hold use, and is inert until a person accepts it on the
tooling page; `rtk_enabled` is not read from the tooling, since `settings/rtk-enabled.json` carries
it. The sync base keeps the checkout's unit, and the sync marks the repository dirty when the unit
the column would write differs from the checkout's, so the next sweep brings the file to this
install's tooling. Writers that change the column mark the outbox in their transaction: 04, the
clone import, `initializeRagSyncPrefs`, the MCP consent PATCH (`repoMcpServersAction`) and the boot
hold (`holdImportedMcpServerLists`). The reset removes the file with the other settings files.

**A row this install cannot manage is `foreign`.** `foreignReason` (shared) names a `custom:` id (a
bundle item this install holds no bundle for, stored verbatim, never as `foreign`), a marker from a
release strictly newer than this one (only plain `major.minor.patch` strings are ordered; a dev
build is never newer), and a marker of an agent or skill kind at a directory this install renders
no CLI for. A known removed CLI target can enter ordinary obsolete/Keep handling when its import
marker carries a valid explicit repository membership snapshot and its owned path matches this
install's catalog. The snapshot may already hold the reduced list, including `[]`: the portable
claim retains ownership, so cleanup does not reconstruct or re-add old members. Existing proof of
prior targets, including a recorded legacy fallback, remains valid. Unknown paths, newer releases
and unavailable custom bundles stay
foreign. 01 classifies it first, 02 skips a foreign row whatever the form sent, the form names such paths in
one note, and upgrade-status leaves them out of every comparison. A cli-rules row is judged on its
bytes like any other, whoever recorded it: a region an earlier release rendered from its owner's
providers, as a row of this install or an imported marker, plans a `clean_update` while it holds the
bytes its row claims and its template moved, is adopted when it already holds the new render, and
stays a `conflict` once edited. An imported marker used to read `conflict` here, since the region
rendered from this user's providers and an imported baseline proved nothing about them; the region
is the repository's own now, the same for every install, and that clause of `classifyEntry` is gone.
A marker is no upgrade's output, so an upgrade completed before an
import cannot be rolled back (`ledgerImportedSince`): the banner offers none, the route answers 409
and 04's detect refuses; a rollback that puts back a retired marker restores it as a marker.

**An upgrade offers the RTK block back, unticked.** 07 is the only writer of the block, so once an
upgrade took it out, only a re-onboarding used to restore it. 01 now lists `AGENTS.md` in
`rtkBlockRestorable` when ALL hold: the context recorded an RTK choice and RTK is on
(`rtkBlockToRestore`, the mirror of `rtkLeftoversToRemove`); a provider is enabled, as 07 requires;
AGENTS.md reads as text and holds no RTK marker (a link or an unreadable file is not offered); and
Haive's newest record for AGENTS.md is a strip (`RTK_BLOCK_RECORD`), not a put-back
(`RTK_BLOCK_RESTORE_RECORD`). The strip record is the proof that Haive took the block out: a file
with none is left alone, since a person may have deleted the block on purpose. Only AGENTS.md is
ever offered, because 07 writes the block nowhere else, so a strip record for CLAUDE.md or
GEMINI.md offers nothing. 02's checkbox (`restoreRtkBlock`) defaults to unticked, since the block
is text in a file the person owns and may have judged it unwanted. A ticked box records what the
file held and what the append leaves (`RTK_BLOCK_RESTORE_RECORD`, superseded like a strip record)
before it writes, then appends the block the way 07 does, through `rewriteFileIfNoFollow` and only
while no marker stands (`appendRtkBlock`). A retry takes the earlier attempt's record while the file
still holds what that attempt left, so the block is never appended twice. The output carries
`rtkBlockRestores`, and a refusal is a warning, never a throw. A rollback writes the recorded
bytes back (`takeOutRestoredRtkBlock`) only while the file still holds what the restore left; a file
edited or removed since is kept and named, and one already holding the recorded bytes counts as taken
out. A rollback records what it did to the block (a strip record when it takes the block out, a
restore record when it puts it back), so the newest record is always Haive's last action on it. The
banner (`upgrade-status`) does not count this offer: it is unticked, so an upgrade applied
as offered would change nothing, and the banner promises changes.

**"Keep my edits" is a decision; Skip is not.** Both leave the file alone. Keep also records the
version declined, so the next upgrade offers only a newer one. On a live row it moves
`templateContentHash` in place. An untracked path gets a `backfill` row whose `writtenHash` is the
render, so it claims nothing, and a rollback, which reads only `upgrade` rows, never takes the file
for one it introduced. A Retry clears the form, so a conflict a failed attempt answered with
Overwrite can be answered with Keep: while the path still holds that attempt's render, Keep first
writes back the bytes the attempt recorded before writing (the whole file, or the rules region),
so the version kept is the person's and not the render. Those bytes are the person's own, so the
restored path is not reported as written and the upgrade commit does not stage it. The check and the write run on one held
file (`rewriteFileIfNoFollow`), so a save landing meanwhile stays. When that attempt had committed,
its own row is retired and the row the plan saw comes back carrying the decision. The pre-image
is deleted in its own statement as soon as the held file is settled, whether or not it was written
back and before the Keep's transaction, so no later failure leaves it for a retry to write over a
save that happens to match the render. Skip records
nothing, so the path is offered again. An obsolete Haive file
has no newer version to decline, so it is kept by "Keep these files, and stop tracking them": its row
is superseded and the file left, and neither the plan nor the banner offers it again until a rollback
of that upgrade puts the row back. Removal wins when one file is picked for both.
`unclaimBackfilledEdits` (`data-migrations.ts`) brings the rows written before into that shape: only
such a row has `user_modified` with `written_hash` equal to `last_observed_disk_hash`, and it and its
rollback copies get the two hashes swapped.
