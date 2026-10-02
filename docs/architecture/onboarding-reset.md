# Onboarding reset

**The reset (`DELETE /repos/:id/onboarding-artifacts`) takes back what onboarding wrote, and nothing else** (`resetOnboardingArtifacts`).
Its directories are DERIVED from the provider catalog, the same reason `getScaffoldEntries`
gives: the hand list it replaced was `['.claude', KB_DIR, LEARNINGS_DIR]` from when `.claude`
was the only CLI directory, so "start over" left the previous run's agents and skills on disk
for every other CLI and the next run wrote on top of them. It takes back the project-state record
12 writes too: its files under `.haive-data/state/` go by name like `.haive/install.json`, their
directories only once empty, and the same transaction that clears `onboarded_at` nulls
`repositories.render_context` and deletes the `project_state_sync` row, so no later sync can
import the context onboarding was reset from.

**The catalog is the CANDIDATE set, never the removal set.** 07 writes agents to the ENABLED
providers' dirs alone (`agentTargetsByDir`, from `providerRows.filter(p => p.enabled)`) and
`resolveSkillTargetDirs` does the same for skills, so on a repo where only claude is enabled a
`.codex/agents` or `.grok/skills` holds the user's own definitions and NOTHING of ours — and
this action is irreversible. `collectWrittenCliContent` answers it from the RUNS' own records,
never from the currently enabled providers: enablement is mutable global state that says nothing
about what THIS repo's onboarding did, so a CLI enabled afterwards would make its directory
eligible for a removal no run here ever wrote to, while one disabled since would strand the
skills it did write. A candidate outside that union is REPORTED, not removed.

**What it reads is what each step WROTE, not what it planned to.** 07's apply output carries
`wroteFiles`; its detect payload's `agentTargets` is the wrong source twice over, because with
the default `overwrite=false` `writeIfAllowed` SKIPS a pre-existing file — so a user's own
`code-reviewer.toml` is one a SUCCESSFUL apply deliberately left alone, and claiming it by
manifest id would exempt it from the quarantine and delete it with the directory — and because
the detect payload is persisted before the form is even shown, so a run cancelled while parked
there names directories nothing was written to (which is also why the query filters to
`status = 'done'`). `wroteFiles` additionally covers the two cases a target list misses: the
fallback write to `.claude/agents` when NO provider has an agents dir (amp alone, where
`agentTargets` is empty), and the LLM-discovered custom agents, which have no manifest id at
all. 09_5 contributes `written[].mirroredDirs`, each `written[].id` with the `SKILL.md` and
`sub-skills` inside it, and the `README.md` index it rebuilds every pass. `.claude` itself needs
no gate — it is Haive's own directory, and every `ONBOARDING_MARKERS` path lives in it.

Provenance is scoped to runs that started after `repositories.onboarding_reset_at` (migration
0161). A reset supersedes artifact rows but CANNOT touch `task_steps`, so an older run's
`wroteFiles` still names paths it wrote and the reset then DELETED — and if the user recreates
one of those names by hand and a later run SKIPS it under `overwrite=false`, that stale record
claims their new file. Reading only the NEWEST run does not fix it: with no re-onboarding since,
the newest run IS the pre-reset one. NULL there is every repo never reset, which reads exactly as
it always did, so the column needs no backfill.

`09_5b-skill-repair` is the third source and is read on its own terms: `repaired` (skill IDS)
with the target dirs in its DETECT payload. It CLEARS a failing skill's tree before rewriting
it, so 09_5's slug record for that skill is STALE — which is why the rows come back OLDEST
FIRST and a repair RETIRES the earlier claims under that skill before re-claiming it.

**A directory is claimed only when something inside it is named.** `hasDeeperClaims` is what
makes a claimed directory be WALKED, so claiming one with nothing named inside says the
opposite — that it is ours wholesale — and a file the user put there is deleted rather than
moved aside. `sub-skills` is therefore claimed only when the slugs in it were recorded, which
09_5b never does and 09_5 only does for outputs written since `subSkillSlugs` existed.

`11d-skill-sync` is a source ONLY for a task whose worktree was MERGED. It writes into the
task's WORKTREE (`resolveWorktree`), so until the merge its record describes a tree the reset is
not looking at, and claiming from it would delete an untouched ROOT copy of a skill it only ever
changed there. `12-worktree-cleanup` records that verdict as `merged`, set on the `merge_remove`
path and only when the merge actually ran, so the two rows are read together — which is why
`loadProvenanceSteps` also selects `task_id` and loads the cleanup step. Ignoring 11d wholesale
was NOT safe either, and that is the subtler half: an 11d removal leaves 09_5's claim for that
skill standing, so a file the user later recreates at the path is deleted as onboarding output.
A merged sync therefore RETIRES the claims of what it removed and re-claims what it generated.
It records no sub-skill slugs, so `sub-skills` under a skill it wrote stays unclaimed and is
moved aside.

**A claimed DIRECTORY is walked when anything claimed lives beneath it, and taken whole when
nothing does.** That is what separates a generated skill (`<skills>/<id>`, which holds Haive's
`SKILL.md` and `sub-skills` and may also hold a `NOTES.md` a person left there) from
`sub-skills` itself, which Haive renders wholesale. Without the walk the recursive removal took
the person's file along with ours; without the stop, every rendered sub-skill would be moved out
one by one and the directory would never empty. A descendant keeps its shape under the one
`-legacy` sibling (`<skills>-legacy/<id>/NOTES.md`) rather than growing a second quarantine
inside the tree.

**A row and a step hash are CO-EQUAL evidence, not a precedence chain.** `claimSatisfied` answers
a VERDICT — `ours` / `edited` / `unrecorded` — and either record matching the bytes on disk
settles it. It is not "the row wins", and the case that forbids that is live: 07 renders the
agents index through `resolveAgents`, which substitutes `stubCustomAgent` for an accepted id it
cannot resolve, while the manifest renders it through `resolveAgentsForIndex`, which DROPS that
id. Different table, so the `agents-index` row can NEVER match the README 07 actually wrote, and
a row-wins rule quarantines that file out of a directory Haive indisputably owns. The row is
still needed in the other direction: `02-upgrade-apply` rewrites a file and inserts a row
carrying the NEW hash while 07's step hash still names pre-upgrade bytes, so a step-hash-wins
rule would quarantine every upgraded repository's own files.

**`edited` is a claim about AUTHORSHIP and is only made where authorship is PROVEN.** A step
hash proves it alone, because one exists only for a path that step WROTE — `writeIfAllowed`
skips a pre-existing file and records nothing for it, and that absence is load-bearing rather
than an omission. A row does NOT prove it: `recordOnboardingArtifacts` inserts one per manifest
RENDERING, so a file apply skipped carries a row too, holding what Haive WOULD have written. A
row that no longer matches is therefore two different stories — "Haive wrote it and you changed
it" and "this was always yours" — and only the step record separates them. Getting this wrong
tells a person their own untouched file was "edited since Haive wrote it"; the skipped-file case
in `repo-artifact-reset.test.ts` exists for exactly that confusion and catches it.

Dispositions do NOT depend on which of the two refused: a file that fails the claim is
quarantined where it was quarantined and kept where it was kept. Only the REASON travels, using
the wording the settings pass has had since it shipped. That half is the point — with one flat
reason for both, a genuine user edit and a commit hook that reformatted what Haive wrote are
indistinguishable in production, and a gate nobody can measure is a gate nobody can tune.

07, `09_5-skill-generation` and `09_5b-skill-repair` all record hashes. `11d-skill-sync` does NOT,
and must not simply follow: it writes into the task's WORKTREE and those bytes reach the root
through a git merge with AI conflict resolution, so a mismatch there is evidence that a merge
happened, not that anyone edited anything. Its claims stay path-only.

**The skill tables are TOP-LEVEL and keyed by id, never carried on `written[]`.** 09_5's
`written[]` round-trips through `task_steps.iterations`, which is `jsonb`, and jsonb NORMALISES
object key order — so a hash nested in an element would land mid-object on every entry a later
pass carries forward, and could never be kept where the summariser's 4000-char slice cuts. Only
the top level of the returned object survives in declaration order, because that object reaches
`buildStepSummaryPrompt` in memory. `written` itself is declared LAST in 09_5 for the same
budget: at ~700 bytes per skill it alone fills that slice.

ONE hash covers every mirror directory in both steps, because `skillMd` and the sub-skill bodies
are rendered ABOVE the target-dir loop and neither renderer takes a directory. The README is the
exception and is keyed BY dir, since its render interpolates its own path — and in 09_5b it is
also rebuilt from that dir's own on-disk set.

**No claim is re-gated on a hash.** `sub-skills` still turns on the SLUGS, so an output recording
slugs but no hashes keeps exactly the claim it always had; re-gating would drop it for every
pre-existing output and change what happens to a file a person left in that directory.
Directories are claimed with `null` always, having no content to hash.

**A fixture for this is normalise-stable by default, so it pins nothing.** MEASURED twice in one
PR: removing `normalizeContent` from a SKILL.md hash left every step-side test passing, because
the fixture roughened only the sub-skill body. Roughen the OVERVIEW too — inside the text, since
`skillToMarkdown` trims its ends — and assert `normalizeContent(x) !== x` per file before
asserting what the hash is.

Two landmines to know about before extending this, both inert today:
`12-post-onboarding` inserts a row whose `diskPath` is `AGENTS.md` and whose `written_hash` is
the hash of the cli-rules BLOCK rather than the file — an entry in `writtenHashes` that can
never match its own path, harmless only because the sweep never visits a root file. And
`01b-install-plugins` runs CLI plugin commands against `.claude/plugins/drupal-php-lsp`, the
exact paths 07 wrote, so a CLI that ever normalises those JSONs makes them read as edited.

Rejected, so it is not re-litigated: having 07 insert artifact ROWS for the paths the manifest
does not cover would unify the two mechanisms, but a live row with no current rendering
classifies as `obsolete` in the upgrade plan and `02-upgrade-apply` then DELETES the file —
arming the upgrade path against the user's own custom agents. The step payload is the right
carrier.

**A partial reset therefore leaves a residue, and that is the accepted trade.** Where the walk
removed something but an I/O error skipped a generated directory, the epoch still advances —
`resetTouchedNothing` refuses only a run that touched NOTHING, since a second reset over an
already-clean tree legitimately removes nothing. `resolveKeptArtifactPaths` then keeps the live
artifact ROWS for the skipped paths, but the PATH-ONLY claims above are not rows: the epoch
excludes whole step rows by `ended_at`, so a retry reads those surviving files as unowned and
quarantines or keeps them instead of removing them. Both are reported. The two alternatives are
worse in the direction that loses data. Not advancing the epoch re-opens the hazard it exists for
— a stale `wroteFiles` claiming a file the user recreated by hand at a path the reset DELETED —
and exempting the skipped paths needs a new persistent per-path record, which is that same hazard
again with a longer life. So this is clutter, in the direction that loses nothing, the same
bargain `11d-skill-sync`'s exclusion already strikes.

**A live artifact row puts a directory in scope but never claims a file on its own.**
`recordOnboardingArtifacts` inserts one row per manifest RENDERING without consulting
`wroteFiles`, so the file apply SKIPPED has a row too, carrying the hash of what Haive WOULD
have written rather than what is on disk — claiming by row would hand the user's own definition
straight to the deletion the quarantine exists to prevent. The entry-level claim for a row is
therefore a hash check against the bytes on disk (`artifactMatchesDisk`), the same test the
settings files use and for the same reason. Rows still put the directory in scope, which is what
keeps an UPGRADED repo's dirs resettable: `02-upgrade-apply` writes through those rows and never
appears in any 07 `wroteFiles`.

**Inside a proven directory, what Haive cannot claim is MOVED, not deleted.** The quarantine
checkbox at 07 defaults OFF, on the stated grounds that an agent the user wrote by hand is
indistinguishable from one an older workflow left behind — so their own definitions legitimately
sit beside ours, and a recursive removal would take them. The reset therefore runs 07's own
mechanism first, to 07's own destination (`unmanagedAgentsDir`, the `-legacy` sibling a reset
then keeps), and removes the directory once only Haive's entries are left. `noReplace`, because
a name already quarantined is an earlier run's file and which of the two a person wants is not
ours to decide; an entry that could not be moved is reported and its DIRECTORY then survives,
with Haive's own entries removed individually around it. Agent ids for the claim come from the
template manifest rather than the step payload — `acceptedAgentIds` is the user's PICK, so an
agent they deselected would otherwise read as theirs and be quarantined out of its own
directory.

`.claude` is swept entry by entry and removes only what it can CLAIM — what 07's `wroteFiles`
names there (`workflow-config.json`, the slash commands, the Drupal LSP files) or what a live
row verifies by hash. Those claims keep their WHOLE path, never a head segment: the LSP plugin
is `.claude/plugins/drupal-php-lsp/<file>`, and collapsing that to `.claude/plugins` claims a
directory that also holds plugins the user installed. A `.claude` directory Haive wrote INTO but
does not own is WALKED on `hasDeeperClaims`, its claimed leaves removed, and dropped only once
nothing of the user's is left in it. A person's own `commands/`, `settings.local.json` or hooks live there too,
and the blanket removal this replaced took them. They are LEFT and reported rather than moved:
`.claude` survives the reset anyway, so there is nothing to move them out of the way OF, and a
`-legacy` sibling of it would be noise. Three of its entries are kept by name for their own
reasons:
`mcp_settings.json` (created once, never rewritten), any `*-legacy` quarantine (the user's own
agent definitions, which 07 MOVED there), and a `settings.json` whose bytes do not match the
live artifact row's `written_hash` — `writeIfAllowed` SKIPS an existing file, so that row is the
only evidence Haive wrote the one on disk. Each kept file is REPORTED through the same `skipped`
channel a refused link uses; the reset says what it left alone rather than passing it off as
reset. The repo's live `onboarding_artifacts` rows are superseded in the same request, after
those provenance reads: rows naming deleted files must not stay live, and `12-post-onboarding`
inserts without conflict handling, so a re-onboarding would otherwise collide with the
`(repository_id, disk_path) WHERE superseded_at IS NULL` unique index.

**The legacy RTK.md files are taken back on the same evidence.** From e4ea9a61 to bd9b94c0, 07
wrote the RTK body to `RTK.md`, `.gemini/RTK.md` and `.claude/RTK.md` and recorded no hash for
them. A claim for one therefore carries `LEGACY_RTK_MD_SHA256` (`@haive/shared`), the body as it
was written, frozen so a re-vendored `RTK_SLIM` cannot move it. The two outside `.claude` get a
pass of their own, since no directory pass reaches them. Content alone never claims: a file
holding the same bytes with no 07 record is kept and reported, and one edited since is kept as
edited. An edited `.claude/RTK.md` used to be deleted on the path-only claim.

**A claimed file is removed only while it still holds the bytes that made the claim.** The verdict
is read before the removal, so a save landing between the two was deleted as Haive's. Every file the
reset removes on its own, the settings pass included, goes through `removeFileIfNoFollow` against
the row's or the step's hash, as an upgrade's delete does; one that no longer matches is kept and
reported as edited, and its directory stays around it. A file past the read cap never matches: the
part read can normalise to a render the whole file is not. A file a save put at the name while the
old one was judged is kept too, though the old one goes. One whose name a save took while it was judged and
refused cannot go back, so it stays under its private name (`ParkedFileError`, carrying the errno)
and the reset reports where it is and carries on. That is no failure to read the tree, so it never
counts toward the floor below that refuses a walk which touched nothing. A claim with no hash behind
it is still taken by its path, and so is everything in a directory the reset removes whole: a save
into one of those at that moment can still be lost.

Two consequences are refusals, and only two. A SECOND onboarding task on a repo that has a live
one is a 409 at `POST /tasks` — two runs write the same `.claude/` files, the same KB and the
same scope list, so it is a corruption path rather than a queue. Everything else stays the
caller's call: a `workflow` or `run_app` task on a mid-onboarding repo is allowed by the API,
and only the New Task form declines to submit one (its inferred type there is `onboarding`).
Same stance as `computePlanReady` — a rule strict enough to CHOOSE must not REFUSE.

**FOUR writers can touch a repository root, and the live-task read guards one of them.** The
survey that established this is worth not repeating:

1. **A revived task job** writing while the walk runs. Still open, deliberately. Two gate designs
   were built and abandoned: one on the task queue (`task-queue.ts` is concurrency 5 for the whole
   INSTALLATION, `worker/src/index.ts` force-closes with `close(true)`, and a gate throw inside the
   processor's `try` reaches `markTaskFailed`), one on the repo queue (below). Neither buys much —
   between job pickup and `markTaskRunningWithStep` every branch ends in a task-status write and
   none writes a path the reset deletes, so the window carries no data loss.
2. **The repo queue**, which `rm -rf`s the root in THREE handlers (`clone.ts` copy, init and
   clone), reached only when a repository is created or its creation is retried: `refresh-tree`
   fast-forwards instead ([Repository refresh](repository-refresh.md)). Closed by the claim below.
3. **`stampRepositoryOnboarded`**, which no lock can reach: it runs from `markTaskCompleted` AFTER
   `completed` is committed, so every live-task guard has already stopped seeing that run.
4. **`PUT /tasks/:id/files/content`**, whose `EDITABLE_PREFIXES` are `KB_DIR` and `LEARNINGS_DIR`
   — exactly what the reset removes recursively — with no task-status check at all, because it
   exists to review knowledge gates on failed and completed tasks.

**`repositories.root_claimed_at` is a CLAIM, not a lock, and it is RECIPROCAL.** Both the reset
and the three repo-queue handlers that `rm -rf` the root take the same claim
(`claimRepositoryRoot`, `'reset' | 'rebuild'`), so whichever arrives second is refused in either
direction; `refresh-tree` and the knowledge-file editor refuse while it is held. The handlers HOLD
it across their destructive work rather than checking once before it — a one-directional check
leaves the window where a handler has already passed it and the reset claims the row before
`rm(dest)` runs, and both then walk the same tree. `root_claim_kind` exists only so a refusal can
name what it is waiting for; nothing branches on it.

`DELETE /repos/:id` refuses while a claim is live, reading it on the repository row it locks: a
delete during a clone used to let the resource cleanup it queues run before the clone finished
writing, which left the checkout on disk with no row to find it by. A writer that claims after the
lock waits for the delete's commit and then finds no row, so it writes nothing.

**It is a LEASE, not a deadline on the work.** `acquireRootClaim` renews while its caller works
(`ROOT_CLAIM_RENEW_MS`, a third of the window, on an `unref`ed timer so a held claim never keeps a
process alive). A fixed expiry cannot tell a dead holder from a slow one, and both exist here —
`gitClone` has no timeout and `copyTree` is unbounded by repository size — so expiring a live
holder re-admits the concurrent `rm -rf` the claim exists to exclude, i.e. the race returning at
the fifteen-minute mark. With renewal, expiry means "the holder stopped renewing", which is what
abandonment actually is. Use `acquireRootClaim`, not the bare `claimRepositoryRoot`, for anything
that is not certainly shorter than the window.

**Renewal ends at `release()` and NOWHERE else.** An elapsed-time cap was added here and reverted,
so do not re-add it: any deadline eventually expires a holder that is still rewriting the tree,
which is the catastrophe above with extra steps. The worry it answered — a handle never released,
renewing forever — is the lesser failure by every measure: it needs a caller to skip the `finally`
all of them have, it is visible because the repository refuses and names what holds it, and it
ends at the next process restart since the timer is `unref`ed. `root-claim-lease.test.ts` fails if
a cap comes back.

The claim is released with the STAMP it took, and renewal is conditional on it too: a holder whose
lease DID expire and was taken over learns it lost rather than clawing it back or clearing its
successor's claim — silently, and exactly on the slowest trees, which are the ones that reach the
window at all.

The knowledge-file editor (`PUT /tasks/:id/files/content`) HOLDS one for its write, as kind
`edit`. Checking is not enough there: the SELECT can finish just before a reset claims, and the
write then lands in a tree being recursively removed — resurrected as an orphan, or written to an
already-unlinked inode, which returns 200 and silently loses the edit.

It is taken only for a write that lands in the ROOT — `root === anchor`, i.e. the task has no
worktree. Most knowledge edits are on a workflow task, which does have one, and the reset never
touches `.haive/worktrees/`: its targets are the catalog directories, `KB_DIR`, `LEARNINGS_DIR`
and `.haive/install.json`. Claiming for those would refuse an ordinary edit whenever a reset ran,
and refuse a reset whenever anyone was editing, over a collision that cannot happen.

Where it IS taken the claim is per-REPOSITORY, so two root-level knowledge saves in one repository
at the same instant refuse one another with "try again in a moment". Accepted deliberately: the
hold is one file write long, and a per-file lock would not exclude the reset, which is repo-wide
by nature. A task with no repository takes nothing, since there is no root to protect.

A lock must be HELD across the work it protects, and both places to hold one cost more than the
race: the repo worker and the task worker run in ONE process on ONE `max: 10` pool, so a repo job
holding a connection across `rm -rf` + `copyTree` at concurrency 5 deadlocks the pool; and
`repo-queue.ts` keeps BullMQ's 30s `lockDuration`, so a handler blocked past it can be failed as
STALLED without running its catch, stranding `status = 'cloning'` until the boot reconciler in
`data-migrations.ts` releases it (`maxStalledCount` 10 makes that rarer, not impossible). A
`repo_status` enum value
expresses the same claim and was refused because Postgres cannot drop an enum value: an
irreversible migration for a reversible problem. The cost of a row over a lock is that a writer
killed mid-job leaves it set, which `ROOT_CLAIM_STALE_MS` bounds — generously, since expiring
early re-admits the `rm -rf` the claim exists to exclude.

**Absorbing an error means no count taken afterwards is authoritative, and that is where the two
worst bugs on this branch lived.** `guard` reports WHAT it absorbed, and two decisions read it.
`mayRemoveSweptDirWhole`: a top-level directory may go whole unless the sweep hit an `io` failure
— its `left` is then still the initial zero, and removing on that deletes the definitions the
quarantine exists to move aside. `sweepSurvivors`: a NESTED sweep that did not complete reports a
survivor, or the outer `.claude` sweep adds its unfinished zero to its own total and removes
`.claude` whole, taking the user's plugins. The two differ on `refused` deliberately — at the top
level the refused path IS the removal target and removing the LINK is right, while nested it is a
child whose parent would be taken with it. Both are pure, exported and mutation-checked, because
neither difference is reachable from a fixture: a containment refusal is handled inside the sweep,
and a genuine `EIO` cannot be provoked from a temp directory. The other five guarded sites ignore
the result safely — the settings pass leaves its file on disk, so the later sweep counts it as
kept, and the rest only report or remove.

**A filesystem error inside the walk is a per-item outcome, not a route failure.** It used to
rethrow, which aborted the route BEFORE the supersede and BEFORE the epoch stamp — files deleted,
rows live, no epoch. A bad disk reaches that, and so does writer 4: `removeChild`'s final rmdir
rethrows everything but `ENOENT`/`ENOTDIR`, so a file created under a directory being removed
raises `ENOTEMPTY`. Errors now become `skipped` entries carrying their errno; anything that is not
a filesystem error still propagates, because a `TypeError` is a bug. The one tail that needs its
own rule is a walk that did NOTHING and hit an IO failure: superseding and stamping over an intact
tree is UNRECOVERABLE, since the epoch excludes every prior step row from `loadProvenanceSteps`
permanently and the next reset can then claim nothing, remove nothing and keep everything while
the repo still reads onboarded. That case is reported as a failure and touches no rows. The
predicate is "an error occurred", never "nothing was removed" — a second reset over a clean tree
also removes nothing and stays a no-op.

**Every piece of "onboarded" evidence is read against the epoch, not just the column.** Guarding
`onboarded_at` alone was cosmetic: the completed onboarding task row lives forever, so
`hasCompleted` kept answering yes across a reset. `resolveOnboardingVerdict` therefore requires a
completion NEWER than `onboarding_reset_at`, and "no run was ever started here" stops counting
once a reset exists — a reset IS a run started and taken back. `mark-onboarded` gets its own rule
rather than that comparison (it has no task to compare against) and refuses while a reset is
unanswered, because it is the documented escape hatch for a repo whose markers are on disk, which
is precisely what a reset that could not read the tree leaves. Its UPDATE also CARRIES the epoch
it validated (`IS NOT DISTINCT FROM`, so the null case is covered) and refuses under a live root
claim: validating and then writing unconditionally is the same read-then-act shape the claim
exists to remove, and a reset landing in between would have its work undone by hand. With no
epoch every term is byte-identical to what it was, which is why none of this needed a backfill.

Left alone deliberately: `landPlanMerge`'s `git merge --ff-only` in the root, which refuses rather
than overwriting local changes and only touches paths differing between HEAD and target.
