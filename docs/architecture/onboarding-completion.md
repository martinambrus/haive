# Onboarding completion

**"Onboarded" is the RUN's verdict, not the artifacts'.** The API checks four logical marker
categories: agents, skills, `.claude/workflow-config.json` and `KB_DIR`. A required agent or skill
category accepts its directory from any CLI in the catalog; a Codex-only run needs no
`.claude/agents`. A category with no destination in the repository's recorded CLI set is
inapplicable: fresh Amp-only needs skills but no agent directory, while explicit empty or
unknown-only maintained sets without a legacy fallback export neither. A genuinely recorded legacy agent fallback keeps
the agent category applicable. Unknown or decoder-refused provenance keeps the legacy four-marker
requirement. KB and workflow configuration remain required.

`checkRepositoryOnboardingMarkers` (`shared/src/onboarding-admission.ts`) uses the current
explicit membership, then newest strictly valid live snapshot membership, then recorded legacy
metadata. It never infers membership from local providers or directories. Required categories
keep their existing any-catalog presence check: adding a CLI deliberately defers generated skill
mirrors until later generation, repair or sync, so completion does not require every mirror.
Marker labels stay stable: existing directories remain `present`, while an absent inapplicable
category is left out of `missing`.
Provenance is read in batches only when a missing CLI category could change the result. The
repository list also skips that read when missing KB or configuration already forces its verdict
false, and keeps large context columns out of its primary query and response.

The run writes these artifacts from `07-generate-files`, the 8th of 27 registered onboarding
steps, with the KB following at 08 and skills at 09_5. From a third of the way in, a cancelled run
and a run executing RIGHT NOW can leave a tree indistinguishable from a finished one: a task
created against such a repo was typed `workflow` and aimed at a knowledge base nobody finished
building, and the repos list offered "Create task" for a repository mid-onboarding.

`resolveOnboardingVerdict` (`api/src/lib/onboarding-state.ts`) is the one reader, shared by
`GET /repos` and `GET /repos/:id/onboarding-status`:

```
onboarded = applicable markers present
            AND no live onboarding task (created|queued|running|paused|waiting_user|waiting_pr)
            AND (repositories.onboarded_at IS NOT NULL
                 OR a completed onboarding task exists
                 OR no onboarding task was ever started here)
```

`waiting_user` counts as LIVE deliberately — parked on a form is the normal state of
onboarding for most of its life, and it is the state the misreading happened in.

The last clause is what makes this deployable with NO backfill: a repo cloned in already
onboarded, and every repo onboarded before the column existed, keeps the verdict it had. It is
also why nothing re-derives the stamp at boot — a data migration that re-stamped from task
history would resurrect a repo whose artifacts were just reset.

**A repository created blank can finish onboarding through its first workflow.** INIT seeds the
deterministic templates but has no code to mine for a KB or generate skills from.
A completed `workflow`, including `quick_bugfix`, counts as onboarding completion for a `blank`
repository with no onboarding task history and no reset. This path requires no on-disk markers:
setting up DDEV alone writes no KB, agents or skills, and scaffold seeding is best-effort.
The next task must remain a workflow after those first files appear. `loadOnboardingTaskFacts` reads
completed workflows separately from onboarding history, so an earlier setup task also receives
the same verdict without a backfill. Workflow history is aggregated with `max(completed_at)` for blank repositories
only, returning one row per repository on each poll instead of transferring every finished task.
Workflow completion evidence lives only in task
history, and never stamps `onboarded_at`: such a stamp would outlive a later onboarding attempt
and make its failed run read as complete once its markers existed. A plan build, a failed
or cancelled workflow, and a workflow on an imported repository provide no such evidence.
Starting an actual onboarding run or explicitly resetting artifacts restores the full onboarding
gate; a later workflow cannot cover for an abandoned onboarding run or answer a reset.

`onboarded_at` is stamped by `stampRepositoryOnboarded` from the worker's `markTaskCompleted`
(`onboarding` type only), the same hook and the same reason as `completePlanNodesForTask`:
cancel and fail write through their own functions, so an abandoned run can never stamp a repo.
Cleared by `DELETE /repos/:id/onboarding-artifacts`, since the stamp must not outlive the files
it vouches for. `POST /repos/:id/mark-onboarded` is the manual route, for a run that did all
the work and then failed at a late step (13-onboarding-push against a repo with no remote); it
refuses when an applicable marker is missing or a run is live.

**One rule admits an upgrade, and a rollback.** `upgradeAdmission`
(`api/src/lib/onboarding-state.ts`) is what POST /tasks, upgrade-status's banner and
`POST /repositories/:id/rollback-upgrade` all ask. It refuses while an onboarding of the repository
is live, naming the task, since an upgrade or a rollback beside it would race 07's writes. It also
refuses while a project state conflict is pending (`contested`, naming the units): see
[Onboarding template versioning](onboarding-upgrades.md). Then it admits on a completed onboarding
since the reset epoch (`onboarding_reset_at`), or an onboarding-written artifact row since it. An upgrade's own rows do not count: before this rule an
upgrade could start on a reset repository, so its rows prove nothing. The banner alone still shows
an upgrade on a repository with no reset and any earlier upgrade task, which POST /tasks then
refuses. A rollback is gated alike
because it puts back files a reset removed. Each refusal has its own 409 text
(`upgradeRefusalMessage`). An onboarding and an upgrade or rollback of one repository are created
under one lock (`withRepositoryTaskLock`, taken after the new-work fence), each refusing the other inside it, so two requests at the
same moment cannot both start. The lock also takes the repository row and refuses while a reset holds
the root claim ([Onboarding reset](onboarding-reset.md)), and an upgrade or rollback re-runs
`upgradeAdmission` inside it, so a reset epoch stamped after the early check still refuses.

**A clone is admitted by its render context column.** A repository cloned from another install's
onboarded commit has neither a completed onboarding task nor an artifact row, only the column the
project-state sync filled from the checkout's record. `renderContextAdmitsUpgrade` is a third term,
tried only after both fail. It requires that the column decodes (a refused one reads as NULL, as 01
reads it), that the repository is `ready` with a root, and that the verdict above calls it
onboarded. For a clone the column admits and no artifact row records, nothing on this install can
say what changed. upgrade-status therefore offers it the first upgrade (`firstUpgradeOnThisInstall`)
until a row records it, because the banner is the only place one starts. The offer outlives an
upgrade task: one cancelled at 02's form has written no row.

**A claim imported after a reset answers it.** The sync imports another install's ledger as import
markers (`task_id` NULL, `imported_at` set; [Onboarding template versioning](onboarding-upgrades.md)),
and a marker is step 12's output from elsewhere: `loadNewestLiveArtifactAt` counts a live marker,
dated by `imported_at`, beside an `onboarding` row dated by `generated_at`. `resolveOnboardingVerdict`
therefore reads a repository as onboarded when a live marker is newer than `onboarding_reset_at`
(`importedSinceReset`, ORed beside `onboarded_at` and a completed onboarding), and a repository whose
only rows are markers can be marked onboarded. A marker older than the reset cannot, since the reset
superseded it; an ordinary `upgrade` or `backfill` row after the reset still only offers the button.
A live onboarding still blocks, as for every term.
