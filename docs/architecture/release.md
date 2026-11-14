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

The manifest schema also accepts an optional `bundle` field while `manifestVersion` stays 1.
Its `files` record maps only `docker-compose.yml`, `docker-compose.run.yml`,
`docker-compose.gpu.yml` and `docker-compose.vulkan.yml` to `sha256:` followed by 64 lowercase
hex digits. The target `files` must include `docker-compose.yml` and `docker-compose.run.yml`;
the GPU and Vulkan overlays are optional. Each historical record in `known` may omit files absent
from that tree, including base or run. Unknown file names are rejected by both records.
`known` contains the historical bundle hash records; it will
let the updater recognise an unmodified older install that predates a local bundle record.
An older manifest still parses without `bundle`, and an older reader's plain zod `z.object`
strips the new field. Targets without a bundle retain the existing upgrade behavior and emit `bundle-absent`.

`node scripts/build-release-manifest.mjs --version <tag> --bundle-dir <tree>` hashes the required
base/run files and any allowed overlays present in `<tree>`. It validates
`<tree>/install/bundle-env.json` with the shared env schema before embedding the parsed `bundle.env`.
It reads the invoking checkout's `v*` tags merged into `HEAD`, except the target tag, in refname
order and hashes their blobs with `git show`. Missing historical files are omitted; tags with no
bundle files contribute no record. Duplicate records are retained only at their first occurrence,
and file keys follow the fixed allowlist order. RC tags remain eligible because pristine installs
made from an RC need the same legacy recognition as stable releases.

With `--bundle-dir`, a shallow checkout always fails with a non-zero exit, a clear stderr message
and no stdout. Use a complete checkout with the release tags and their trees available. An empty
merged `v*` tag list also fails unless `--allow-no-history` explicitly declares a first release;
that opt-out permits `known: []` only in a non-shallow checkout and must not be used to hide missing
tags on an existing project. Any git read failure aborts generation. The bundle tree may be an
archive without its own `.git`; the generator's own tree must carry the shared schema source and
its dependencies. Without `--bundle-dir`, no bundle metadata, shared schema or git history is read
and the original JSON format is unchanged, including property order and final newline.

`install/bundle-env.json` is a declaration of required keys, not a store of values. A `hex` entry
permits later generation and requires an integer `bytes` from 16 through 64. A `never` entry
requires an existing value and forbids `bytes`, even when explicitly undefined. Keys follow shell
environment-name syntax and must be unique across the declaration. Unknown optional fields on
either kind of env entry are stripped so future metadata does not reject an otherwise valid manifest.
Only `MAILPIT_UI_PASSWORD` is `hex` (24 bytes, matching both installers): the run overlay consumes
it as `MP_UI_AUTH`, so adding it enables an inbox login. `POSTGRES_PASSWORD` is `never` because
the base/run files use it to connect to an already-initialised database; `JWT_SECRET` is `never`
because the API uses it for existing sessions; `CONFIG_ENCRYPTION_KEY` is `never` because the API
and worker use it to decrypt stored credentials. The consistency control parses the installers'
generation assignments and `.env` mappings, pins their matching byte counts, and checks that each
key allowed to be generated is referenced by the compose bundle. A change outside the recognised
assignment grammar fails the control and requires updating its extractor.

The release job checks out complete history and release tags (`fetch-depth: 0`, `fetch-tags: true`),
uses Node 26 and installs the shared schema dependencies. After the service images and their
multi-platform indexes are published, it snapshots the four allowlisted compose files and
`install/bundle-env.json`, then passes that snapshot as `--bundle-dir` to the manifest generator.
Base and run are required; GPU and Vulkan overlays may be absent. The env declaration is removed
after generation, so the payload context contains only `release.json` and `bundle/<allowed files>`.
The Dockerfile lives outside that context; `.env` and other checkout files never enter it.

Before `gh release create`, the job builds and pushes
`ghcr.io/<owner>/haive-release:<version>` for `linux/amd64,linux/arm64` with buildx and re-reads its
pushed digest from the registry. A failed build, push, inspect or malformed digest stops the release.
The image is `FROM scratch`, with `/release.json`, `/bundle/<allowed files>` and the label
`org.haive.release=1`. The manifest hashes the same staged bytes sent to BuildKit, and the GitHub
Release attaches the same `release.json`. Existing service images and their tags are unchanged.

Channel publication archives the compose files, env declaration, generator, migrations and shared
schema source from `record.commit`. It uses the invoking checkout's installed schema dependencies
and release history, then hashes and publishes the archived bundle in the channel's release image.
The release image remains last, after every runtime push and digest verification. If it fails after
the local manifest is written, `<out>/release.json.image/` retains the complete payload context and
its separate Dockerfile; the printed, shell-quoted recovery command rebuilds and pushes that context.
The context is removed after success or a failure before the local manifest write. See
[Modules](modules.md#publishing-a-channel-scriptspublish-channelmjs) for the channel gates.

The updater now reads and prepares the bundle before `startRun` or any maintenance hold. Channel
manifests and their files come from one release-image container. Public manifests still come from
the requested HTTPS URL or an operator-controlled local file, which supplies the hash trust anchor;
files come from `<registry>/haive-release:<version>` or `--release-image <ref>`. An HTTP manifest
that declares a bundle refuses with `bundle-manifest-insecure`, including when
`--replace-modified-bundle` is supplied. An HTTPS redirect ending on HTTP is also refused. Local
manifest files are allowed and involve no manifest fetch.
Each allowlisted `/bundle/<name>` is copied separately from the same never-started container.
The bounded tar reader accepts exactly one regular entry of that exact name, with no prefix,
links or additional entries, and caps each bundle file at 256 KiB. Missing, malformed, oversized
or hash-mismatched files refuse with `bundle-invalid` before install files are changed. The public
image's own manifest never replaces the supplied manifest's hashes. A target without `bundle` needs no public
release-image pull and introduces no classification or required-key refusal.

`bundle.ts` classifies the installed base/run files and installed GPU or Vulkan overlay. A valid
`.haive-bundle.json` record whose files match is `pristine`; a differing or malformed record is
`modified`. Without a record, an entry in `bundle.known` matching the installed file list is
`legacy-known`; otherwise it is `legacy-unknown`. Historical hashes for an uninstalled overlay do
not require that overlay to exist. Modified and unknown installs refuse with `bundle-modified`,
exit 3, and a preflight attempt naming the first differing file and `--replace-modified-bundle`.
For unknown legacy installs, the updater picks the known record with the fewest differing installed
files and names its first difference; ties retain historical record order. With no known records,
it compares against the target bundle instead.
`--replace-modified-bundle` acknowledges replacement intent and is recorded in run metadata; it does not swap
files in this PR. `--check` validates classification and required keys without generating keys,
staging files, pulling service images, recording an attempt or starting a run.

After classification, `envkeys.ts` checks every `never` declaration before writing anything.
A missing, empty or commented-out `never` key refuses with `env-key-missing` and the key's name.
A declared key (`never` or `hex`) whose unquoted or double-quoted value holds a `$` reference
refuses with `env-key-interpolated`: Compose substitutes it when it reads `.env`, so
`${MAIL_PASSWORD:-}` would pass as non-empty text and reach Mailpit empty. A single-quoted value
and `$$` are literal and pass. Replace a refused value with what `docker compose config` resolves
for it today, not the written text: Compose has been passing the substituted value, and a changed
`CONFIG_ENCRYPTION_KEY`, `JWT_SECRET` or `POSTGRES_PASSWORD` no longer matches the data it protects.
Missing or empty `hex` keys get `crypto.randomBytes(bytes).toString('hex')`; existing non-empty
values are retained. The updater appends the additions through an exclusively created
`.env.haive-tmp`, applies the original uid/gid with `fchown` and the original mode, fsyncs it and
renames it over `.env`. Before the exclusive open it unlinks any stale temp entry, ignoring only
ENOENT; a leftover symlink is removed without touching its target. A second run adds nothing.
The key writer emits names only and discards write error details; journal `metadata.envAdded`
also contains names only. Added keys intentionally remain after a later failure or rollback,
because removing them could reopen missing auth.

Verified files are staged in `<install>/.haive-upgrade/pending/new/`, with the install directory's
owner/group and file mode 0644. The installed overlay selects its target counterpart when present.
`prepareImages` pulls using staged absolute compose paths with `--project-directory <install>`;
then the updater runs `docker compose ... config -q` against the target pins and updated `.env`,
before starting a run. A config refusal uses `bundle-config-invalid`. Only this validation call
discards Compose output and error details. Pull, up and stop retain their original process errors,
including exit status, signals, timeouts and stderr. Docker Compose can echo `.env` fragments in
those errors; that pre-existing third-party behavior remains outside this change.
Staging and key additions can remain after a later preparation failure. Published bundles need
Docker Compose 2.24 or later for the existing `!reset` tags.

The installed bundle and `.haive-bundle.json` remain unchanged: PR5 adds backup, swap, rollback,
resume restoration and pruning; PR6 adds the installer's initial record. Verification and rollback
continue to use the installed compose context until the swap implementation lands. See the
approved [compose bundle plan](../plans/release-compose-bundle.md).

To run a published release instead of building from source:

```bash
HAIVE_VERSION=0.2.0 docker compose -f docker-compose.yml -f docker-compose.run.yml up -d
```

That overlay swaps `build:` for `image:` (via `!reset`, because compose MERGES and would otherwise
still build) and adds the `db-migrate` one-shot that `docker-compose.yml` lacks — the dev stack gets
it from the dev override, so a published-image install would otherwise boot against an unmigrated
database. `HAIVE_VERSION` has no default so the command fails rather than silently resolving
`latest`; which version an install runs is the question every upgrade and rollback turns on.

The updater preserves the GPU overlay already present in the install directory. Every deployment
compose call uses `docker-compose.yml`, then `docker-compose.run.yml`, then
`docker-compose.gpu.yml` when present, otherwise `docker-compose.vulkan.yml` when present. NVIDIA
wins if both files exist, matching the installer's selection order for the generated helper.
Without either file the updater uses only base and run. It resolves that list once per invocation
and shares it across image pulls, snapshot stop/restart, verification, rollback and interrupted-run
recovery; it never probes for a GPU inside the updater container. The separate synthetic Compose
model used to parse image settings from `.env` does not load the deployment files.

## The drain an upgrade runs first

`haive upgrade` (the updater) reads `MAINTENANCE_STATE` under the fence described below and writes
`draining` over `normal` only: a `draining` or `maintenance` an administrator already set stays as it
is (the `draining` log line carries what it `found`). It keeps that state in the run's journal row
(`upgrade_runs.metadata.foundState`, written once, before the `draining` write) and puts it back when
the run ends, on the commit and on the rollback alike: an upgrade over `maintenance` ends in
`maintenance`, over `draining` in `draining`, over `normal` in `normal`. A restarted updater reads it
from the journal, so a resumed run puts back the same state; a resumed run with no record puts back `normal` only when an older updater started it; a run this
updater started carries `metadata.foundStateRequired` from its insert, so one that died before the
record keeps whatever state stands (an administrator's hold included), logs the skip and records
`metadata.restoreSkipped: 'found_state_unknown'` on the run. A run still in its own draining phase
that has not recorded the found state (its first read, the fence or the record failed) has written
nothing, so its rollback leaves the stored state alone. The updater's state writes retry only on
`ConfigUnavailableError`: 20 attempts, 3 s apart, with the fence released between attempts. It then waits until no work is live,
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
for, and under `maintenance` a parked task is not in `tasks` and holds nothing. The same response lists
those tasks apart, in `parked` (`nonBlockingTaskStatuses`, in `@haive/shared`: the complement of
`drainTaskStatuses`), together with every live (not dead) failed task an administrator's pause holds, so
an administrator can still Pause or Resume them from the page, where they show as "Parked". Whose pause
stands is decided first, by `findAdminPausedTaskIds` over the ids of the failed tasks that carry one,
and the list is cut after that, so failed tasks under an owner's pause cannot crowd the others out.
`parked` counts toward neither `total` nor `capped` (`parkedCapped` says its own cut-off), and the
updater never waits for it. It does not filter by owner role: an administrator's own parked task (who
passes the gate and could still answer it) is listed there too, though it is not waited for. A page
newer than its api reads a response without `parked` as an empty list.
Every api route that starts such work refuses with 503 while the state is `draining` or
`maintenance`: the task routes, and every route that writes a job's in-progress status (repository
create, upload and refresh, bundle create, upload, replace and sync, provider create, clone and image
build, and a provider edit that rebuilds the image or downloads a model). Not fenced and not counted,
since none holds a window open: interactive runtimes (IDE, browser, DDEV control, terminal and login
containers), cleanup, the plan mirror outbox (it resumes) and the price refresh. The refusal's
authority is `admitNewWork`: a read of the state past ConfigService's 30 s cache inside the
transaction that records the work, under a shared
database fence (`lockNewWorkFenceShared`, an advisory lock on `NEW_WORK_FENCE_KEY`); most routes
also answer an early 503 from the same fresh read before they start (`assertNewWorkAllowed`). A state that cannot be read within the bounded
wait refuses new work with a retryable 503 rather than admitting it. An
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
administrator's writes nothing. The newest `task.paused` event says who made the pause in force
(`byAdmin`, `findAdminPausedTaskIds`). Events are ordered by `created_at`, then `id`, and both writers
(`appendPauseEvent`) stamp `created_at` with `clock_timestamp()` once they hold the row lock, so it
follows the order the lock was held in, which the default (the transaction's start) does not; the id is
a random uuid, so it only makes a tie stable. The page's rows carry the answer as `pausedByAdmin`: an
owner's pause offers Resume and Take over pause, an administrator's only Resume. While it is an
administrator's, the owner's Resume answers 409 `paused_by_admin` and keeps the pause, judged after the
clear inside the resume's transaction so that a pause placed since the route read it is the one refused.
An owner's Retry of a failed task revives it but leaves that pause standing (a refusal would leave its
owner nothing to do until an administrator acts); it lifts the hold it read only after judging whose it
is again under the task row lock (`liftReadPause`), since a takeover keeps the stamp the Retry read.
Cancel, the step abort and the plan merge discard still clear any pause, and an administrator may lift it from either route. When the pause they clear is an administrator's (judged under the task row lock), they write the same `task.resumed` event and `task.admin_resume` row as Retry's resume, best effort: a savepoint keeps a row that cannot be written from undoing the cancel. One who owns the task
and lifts an administrator's pause through the owner route gets the same `byAdmin` `task.resumed` event
and `task.admin_resume` row as from the page (`recordAdminResume`, in the resume's transaction, so a row
that cannot be written undoes it); lifting their own owner pause stays an owner action with neither, and
a Retry that clears an administrator's pause for an administrator also records that same
resume event and audit row inside its Retry transaction, for both START replay and a step retry.
`GET /tasks/:id` carries `pauseLocked` (the pause is an administrator's and the viewer is not one), which
hides the task page's Resume and changes its banner.
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

The API's upgrade launch commits its `maintenance.start_upgrade` row (metadata `from`, `to`,
`force`) in its own short transaction before it starts the updater container, so no main-database
connection is held while Docker pulls and starts it (up to 300 s). A refused row starts no container.
A failed launch deletes that one row by id and answers the launch error (a failed delete is logged);
the pino line follows a successful launch only. The admin audit log can therefore show the row while
the launch is in flight and lose it if the launch fails. A launch whose outcome is ambiguous (the
300 s deadline kills the Docker client after the daemon may already have started the container)
deletes the row as a failure, so such an upgrade can run without one.

A start that ends before any run exists also leaves a row, so an administrator sees why an upgrade
did not happen, from the admin page or from `./haive upgrade`, after the api that launched it is
gone. When the updater held the database and the lock, then neither created nor resumed a run, and
the start was not `--check` or a dry plan, its last step (`recordAttempt`) writes one row with
phase `preflight`: status `refused` with `metadata.refusal` (channel-changed,
rollback-images-missing, a preflight refusal), or `failed` for an error. `error` is capped at 2048
characters, `channel` is the resolved one, and an unusable `--version` is stored as `unknown`. In
the same transaction, after the insert, it deletes the attempt rows beyond the newest 50 (ordered
`started_at DESC, id DESC`, never the row it just wrote), so repeated refusals cannot grow the
table. An attempt row is exactly `phase = 'preflight' AND status IN ('refused', 'failed')`; no real
run ends that way (`finishRun` writes only `done` or `rolled_back`, and a failed rollback leaves the
run `running`). That predicate lives twice, as `attemptRow` in the api and in the updater's prune,
and the two must change together. No
reader of a run matches these rows: `findLiveRun` wants `running`, `lastDoneChannel` wants `done`,
and the one-live index covers only `running`. A failed insert is reported as `attempt-record-failed`
and changes neither the exit code nor the outcome. A busy lock writes nothing. A start that fails
before the database or the lock (bad argv, missing `DATABASE_URL`/`REDIS_URL`), an updater killed
before its last step, and a target release older than this updater all leave no row.

`GET /admin/maintenance/upgrade` returns the newest such row as `lastAttempt` only while no `done`,
`running` or `rolled_back` run is newer (`lastUpgradeAttempt`, read apart from the history so
repeated refusals cannot hide a real run); a tie goes to the real run. The history
(`listUpgradeRuns`) caps the two kinds apart: the 20 newest real runs and the 10 newest attempt
rows, merged newest first, so refusals never push a completed run out of it. The admin page shows it as
a banner (`upgradeAttemptBanner`, gated on status and time, the error rendered as markdown) that
replaces the launch box once it is newer than the launch, and History lists the rows. Every instant
in that response is ISO 8601 with an offset: the columns are `timestamp` holding the session's wall
clock, and a zone-less string would be parsed as browser-local time.

## Own-module images

The release matrix also publishes `haive-builder` from the repository-root context using
`docker/own-module-builder/Dockerfile`. It is stamped with the same release version. Published
installs can override api/worker/web image references independently through `HAIVE_API_IMAGE`,
`HAIVE_WORKER_IMAGE`, and `HAIVE_WEB_IMAGE`; db-migrate follows the API reference. The updater
rebuilds configured own modules during preflight, before draining, and journals both old and target
references for rollback and recovery. See [Modules](modules.md#own-modules-on-a-published-install)
for the prepared-source and per-customer builder contract. Channel selection and customer builder
publication remain the vendor pipeline's responsibility; a public builder contains public core only.
