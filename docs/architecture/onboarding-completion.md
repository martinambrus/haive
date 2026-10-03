# Onboarding completion

**"Onboarded" is the RUN's verdict, not the artifacts'.** The four markers the API checks —
`.claude/agents`, `.claude/skills`, `.claude/workflow-config.json`, `KB_DIR` — are all written
during the run. The first two stand for the agents and skills directory of any CLI in the
catalog, since a run writes only its enabled CLIs' own directories, and a Codex-only run has no
`.claude/agents`. They are written by `07-generate-files`, the 8th of 27 registered onboarding
steps, with the KB following at 08
and skills at 09_5. So from a third of the way in, a cancelled run and a run executing RIGHT
NOW leave a tree indistinguishable from a finished one: a task created against such a repo was
typed `workflow` and aimed at a knowledge base nobody finished building, and the repos list
offered "Create task" for a repository mid-onboarding.

`resolveOnboardingVerdict` (`api/src/lib/onboarding-state.ts`) is the one reader, shared by
`GET /repos` and `GET /repos/:id/onboarding-status`:

```
onboarded = markers present
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
the corrected verdict without a backfill. Workflow completion evidence lives only in task
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
refuses when a marker is missing or a run is live.

**A clone is admitted to an upgrade by its render context column.** A repository cloned from
another install's onboarded commit has neither of the two things POST /tasks and upgrade-status
gate an upgrade on, a completed onboarding task or a live artifact row, only the column the
project-state sync filled from the checkout's record. `renderContextAdmitsUpgrade`
(`api/src/lib/onboarding-state.ts`) is a third term, tried only after both fail. It requires that
the column decodes (a refused one reads as NULL, as 01 reads it), that the repository is `ready`
with a root, and that the verdict above calls it onboarded, which reads the reset epoch and
refuses beside a live onboarding. The two older terms read neither. For a clone the column admits
and no artifact row records, nothing on this install can say what changed. upgrade-status
therefore offers it the first upgrade (`firstUpgradeOnThisInstall`) until a row records it,
because the banner is the only place one starts. The offer outlives an upgrade task: one cancelled
at 02's form has written no row.
