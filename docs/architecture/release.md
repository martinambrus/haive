# Cutting a release

The release event is a TAG, never a merge to main. Main takes dozens of commits a day and stays
CI-gated but publishes nothing; `git tag v0.2.0 && git push --tags` is the whole release, and
`.github/workflows/release.yml` does the rest. **The tag IS the version** — nothing in the tree
carries a release number (`APP_VERSION` is the dev sentinel `0.0.0-dev`), so there is no
version-bump commit and no drift across package.json files.

The workflow builds api/worker/web for amd64 and arm64 on NATIVE runners (the repo is public, so
GitHub's arm64 runners are free; macOS is a first-class RUN-IT target and QEMU would cost tens of
minutes), pushes them to `ghcr.io/<owner>/haive-*` by digest, joins each into a manifest list
tagged with the version plus `latest` — or `next` for a `-rc` tag — and attaches a `release.json`
to the GitHub Release. `haive upgrade` reads that manifest: it carries the image digests, the
`migrationHead`, and `contracts` (whether this release removes anything, which decides if a
rollback can simply re-pin the previous tag).

Pass `--min-from` to `scripts/build-release-manifest.mjs` only to declare a REQUIRED STOP ("you must
pass through v0.3 first"). It defaults permissive on purpose: a floor equal to the release blocks
every upgrade to it.

To run a published release instead of building from source:

```bash
HAIVE_VERSION=0.2.0 docker compose -f docker-compose.yml -f docker-compose.run.yml up -d
```

That overlay swaps `build:` for `image:` (via `!reset`, because compose MERGES and would otherwise
still build) and adds the `db-migrate` one-shot that `docker-compose.yml` lacks — the dev stack gets
it from the dev override, so a published-image install would otherwise boot against an unmigrated
database. `HAIVE_VERSION` has no default so the command fails rather than silently resolving
`latest`; which version an install runs is the question every upgrade and rollback turns on.

## The drain an upgrade runs first

`haive upgrade` (the updater) reads `MAINTENANCE_STATE` under the fence described below and writes
`draining` over `normal` only: a `draining` or `maintenance` an administrator already set stays as it
is (the `draining` log line carries what it `found`). It keeps that state in the run's journal row
(`upgrade_runs.metadata.foundState`, written once, before the `draining` write) and puts it back when
the run ends, on the commit and on the rollback alike: an upgrade over `maintenance` ends in
`maintenance`, over `draining` in `draining`, over `normal` in `normal`. A restarted updater reads it
from the journal, so a resumed run puts back the same state; a run with no record (it died before
the drain, or an older updater started it) puts back `normal`. It then waits until no work is live,
recounts under the fence and sets `maintenance` only from that recount: the fresh state must still be
`draining` (or an administrator's `maintenance`, which it leaves as it is) with nothing live. A
recount that finds work admitted after the count, or the state set back to `normal`, writes
`draining` again (over `normal` only) and waits again, at least one poll interval.
One `--drain-timeout` covers the first wait and every re-wait: past it, work still live or
admissions still reopened stop the upgrade with an error, or with `--force` enter maintenance
anyway. The journal (`upgrade_runs.phase`) reads `draining` during a re-wait and `maintenance` again
on entry. Then the updater takes the snapshot. Live work (`liveWorkCount`) is a live task or a
background job a route queued: a repository `cloning`, a bundle `syncing`, a CLI provider whose
sandbox image is `building` or whose model is `provisioning`. `GET /admin/maintenance/blocking` and
the admin maintenance page list both, so what the page shows is what the updater waits for; a job
row stuck in its in-progress status holds the drain until the deadline, and `--force` passes it.
Which tasks count depends on the state in force (`drainTaskStatuses`, in `@haive/shared`). Over
`normal` or `draining` they are `queued`, `running`, `paused`, `waiting_user` and `waiting_pr`: the
owners can still come back to a parked task. Under a `maintenance` the updater kept, only `queued`
and `running` count, plus the background jobs: that state locks non-admin owners out
(`locksOutNonAdmins`), so a task parked on one of them cannot be finished and would hold the drain
until the deadline. The wait counts by the state the draining phase left in force and the recount by
the state it reads under the fence, so the two agree (a recount that counted more would reopen a
drain the wait had ended). `GET /admin/maintenance/blocking` reads the state past the cache and
lists the same statuses through the same function, so the page shows exactly what the updater waits
for, and under `maintenance` a parked task is not listed. An administrator's own parked task is not
told apart from the others, though its owner could still answer it.
Every api route that starts such work refuses with 503 while the state is `draining` or
`maintenance`: the task routes, and every route that writes a job's in-progress status (repository
create, upload and refresh, bundle create, upload, replace and sync, provider create, clone and image
build, and a provider edit that rebuilds the image or downloads a model). Not fenced and not counted,
since none holds a window open: interactive runtimes (IDE, browser, DDEV control, terminal and login
containers), cleanup, the plan mirror outbox (it resumes) and the price refresh. The refusal's
authority is `admitNewWork`: a read of the state past ConfigService's 30 s cache inside the
transaction that records the work, under a shared
database fence (`lockNewWorkFenceShared`, an advisory lock on `NEW_WORK_FENCE_KEY`); most routes
also answer an early 503 from the same fresh read before they start (`assertNewWorkAllowed`). An
upload complete makes that read once more right before it claims its session, since the claim is a
write, so a drain that began after the early check refuses with the session untouched. Every
updater state write (`draining`, the recount's `maintenance`, and the return to the state it found
on commit or rollback), like an administrator's maintenance write, takes the same fence exclusively
(`setMaintenanceState`, `enterMaintenance`):
it waits for every admission in flight, so the live-work count it reads next includes each task or
job admitted before it, every admission after it reads the new state, and no write lands inside an
administrator's write. Lifting the hold therefore needs Postgres: an updater that cannot reach it
leaves its run `running`, and the next `haive upgrade` resumes into the commit or the rollback. A rollback that throws does the same: the updater records the error on the run, keeps it `running`, emits `rollback-failed` and exits 6, and the next `haive upgrade` finds the run and finishes the rollback. The admin
page (`GET /admin/maintenance`) and the app banner (`GET /system/state`) read the state past the
config cache, so a change shows at once; the gate that locks non-admins out during `maintenance`
keeps its cached read, so that lockout can lag by up to 30 s. `PUT /admin/maintenance` writes its
`maintenance.set_state` audit row inside its fenced transaction, before the state: a row that cannot
be written refuses the change. The state itself lives in Redis, so a commit that fails after that
write still leaves the new state without its row. A task the administrator pauses or resumes from that
page gets its `task.admin_pause` or `task.admin_resume` row in the same transaction as the change, so a
row that cannot be written undoes it; Stop's row stays best-effort, since the runs it stopped cannot be
restarted. A pause an administrator makes is theirs to lift, and an administrator's Pause on a task its owner
already paused makes it theirs: under the task row lock (`FOR UPDATE`) it writes a newer `byAdmin`
`task.paused` event and a `task.admin_pause` row marked `tookOver`, in one transaction, and leaves
`paused_at` alone (the stamp anchors the runtime reaper's paused-grace); a pause that is already an
administrator's writes nothing. The newest `task.paused` event (ordered by `created_at`, then `id`; the id
is a random uuid, so a tie is made stable, not chronological) says who made the pause in force (`byAdmin`,
`findAdminPausedTaskIds`), and the page's rows carry it as `pausedByAdmin`: an owner's pause offers Resume
and Take over pause, an administrator's only Resume. While it is an administrator's, the owner's
Resume answers 409 `paused_by_admin` and keeps the pause, judged after the clear inside the resume's
transaction so that a pause placed since the route read it is the one refused. An owner's Retry of a failed
task revives it but leaves that pause standing, since a 409 there would strand a task that
`GET /admin/maintenance/blocking` omits (it lists no failed task); Cancel still clears any pause, and an
administrator may lift it from either route. One who owns the task and lifts an administrator's pause
through the owner route gets the same `byAdmin` `task.resumed` event and `task.admin_resume` row as from
the page (`recordAdminResume`, in the resume's transaction, so a row that cannot be written undoes it);
lifting their own owner pause stays an owner action with neither, and a Retry that clears an
administrator's pause for an administrator records only `task.retried`. `GET /tasks/:id` carries
`pauseLocked` (the pause is an administrator's and the viewer is not one), which hides the task page's
Resume and changes its banner.
In the worker, the allowance auto-resume and an answer to a parked form do not reopen a failed task while
new work is refused (see [Worker restarts](worker-restarts.md)).

While an upgrade run is live, `PUT /admin/maintenance` refuses any change: 409 `upgrade_running`,
naming the run. Right after the exclusive fence is granted it reads `upgrade_runs` for a `running`
row (`findLiveUpgradeRun`, the row the updater's own `findLiveRun` finds and resumes), before it
reads the state or writes anything. The updater inserts that row before its first fenced write, and
a write lands before or after a fenced section, never inside it, so a change that follows the
updater's first write always sees the run. An install that never upgraded has no `upgrade_runs`
table, which reads as no run; any other failed read answers 500 with the state untouched. A refusal
writes no audit row. The row stays `running` until the commit or the rollback finishes it, so an
updater that died keeps the refusal in place until the next `./haive upgrade --version <v>` resumes
it. The admin page disables the three state buttons, and says which run holds them, while
`GET /admin/maintenance/upgrade` lists one `running`. That list and the check in
`POST /admin/maintenance/upgrade` read the journal through the same helpers (`listUpgradeRuns`,
`findLiveUpgradeRun`) and fail the same way: a missing table reads as no run, and any other failed
read answers 500, so a read that failed never enables the start buttons and never starts an updater.

The updater creates the journal table itself, at every start: `ensureJournal` runs
`UPGRADE_JOURNAL_DDL`, which `@haive/database` exports once and the api's tests build the table
from, so nothing keeps a copy of it.
