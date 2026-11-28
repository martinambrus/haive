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

Under the upgrade lock and the install stack lock, before reading install settings, pulling images or calling `startRun`,
normal upgrades and interrupted-run recovery check `.env`, all four allowlisted compose files and
`.haive-bundle.json` with `lstat`. Every present file must be a regular file. A symlink refuses with
`install-file-linked`, exit 3, and the filename only; another non-regular entry refuses with
`install-file-not-regular`. This policy also applies to targets without a bundle. Replace linked
files with regular files containing the intended bytes before retrying. The one read before this
check is the attempt row's display read (below): it opens only `.env`, only after `lstat` shows a
regular file, through a held directory descriptor with `O_NOFOLLOW`, and its values reach only that
row, never a decision.

At that same start, the updater removes abandoned `.<name>.<uuid>` files left by the install-file
writer, including `.env` copies. It accepts only the writer's known filenames and exact lowercase
v4 UUID pattern, in the install root, `pending/new/` and run `previous/` directories. Directories
are held open; matching temp symlinks are unlinked without following them, and linked directories
are skipped. Unrelated names are untouched. A standalone `--check` and a dry plan do not clean temps;
recovery of a live run still cleans them.

The updater reads and prepares the bundle before `startRun` or any maintenance hold. Channel
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

`bundle.ts` classifies base/run and every installed GPU or Vulkan overlay, including an inactive
overlay when both exist. Preflight and backup classification derive this list from the installed
hashes through the same swap-candidate function used to plan replacements; Compose still selects
only the GPU overlay when both exist. Recorded files are also checked, so a missing recorded file
still counts as modified. A valid
`.haive-bundle.json` record whose files match is `pristine`; a differing or malformed record is
`modified`. Without a record, an entry in `bundle.known` matching the installed file list is
`legacy-known`; otherwise it is `legacy-unknown`. Historical hashes for an uninstalled overlay do
not require that overlay to exist. Modified and unknown installs refuse with `bundle-modified`,
exit 3, and a preflight attempt naming the first differing file and `--replace-modified-bundle`.
For unknown legacy installs, the updater picks the known record with the fewest differing installed
files and names its first difference; ties retain historical record order. With no known records,
it compares against the target bundle instead.
`--replace-modified-bundle` authorizes replacement of local edits and is recorded in run metadata;
the edited bytes are retained in the run backup before replacement. `--check` validates
classification and required keys without generating keys,
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
Staging and key additions can remain after a later preparation failure. Both the host helper and the updater need
Docker Compose 2.24 or later for the published bundle's existing `!reset` tags. Update the host's
Compose plugin or Docker Desktop before upgrading when it is older.

Immediately after `startRun`, before draining, the updater copies every installed allowlisted
compose file and `.haive-bundle.json` into `.haive-upgrade/<runId>/previous/`. It journals
`metadata.bundle = { from, to, backupDir, overlay }` before changing any installed bundle file:
`from` and `to` contain per-file hashes, with null recording absence, and `backupDir` is relative
to the install directory. A crash before this metadata write has changed no installed bundle file.
The backup contains local edits accepted through `--replace-modified-bundle`, byte for byte.
No database migration is needed for this JSONB metadata.

Verification writes target image pins, swaps the bundle, writes `HAIVE_VERSION`, then starts the
stack and checks its reported version and migration head. Each replacement uses an exclusive temp
file, copies the replaced file's owner/group and mode (or the install directory's owner/group and
0644 for a new file), fsyncs the file, renames it and fsyncs the directory. The mode-0644 local
record is written last. Matching hashes skip replacement, so an interrupted swap is repeatable.
Directories are held open and traversed without following links; linked file targets are refused.
The same writer protects staging, backup, restore and `.env` pin changes. On shares that reject
`chown`, an `EPERM` is tolerated only when `fstat` on the held descriptor verifies that both the
current uid and gid already equal the requested owner. A different owner or another error still
fails the write; ownership preservation remains required.
Only installed GPU/Vulkan overlays are deployed. When the target omits an installed overlay, the
old overlay remains: generated shell helpers bake its filename in at install time. Staged pull
and config validation include that retained installed overlay, and the local record hashes the
actual installed files. An unselected target overlay is never silently enabled.

The version/head gate has one total `VERSION_WAIT_TIMEOUT_MS` budget (180 s, injectable through
`UpgradeContext.versionWaitTimeoutMs`): image pulls and migrations have finished, so this retains
the three-minute allowance for the newly started API to boot and report its migrated schema.
Both the HTTP headers and JSON body race the remaining budget; expiry aborts the request with a
`TimeoutError` DOMException and follows the existing `verify-timeout`/false result into rollback.
Retries and the two-second poll sleeps share that deadline; a stalled request cannot hold the
upgrade indefinitely, and a late matching reply cannot turn a timed-out gate into success.

Before commit, a failure restores the backup files first, then the old image pins and
`HAIVE_VERSION`, restarts on the old compose files, restores the prior maintenance state and marks
the run rolled back. Installed hashes first identify only the files that differ from `from`,
including removing a local record absent before the run. All required backup files are hash-checked
before any restoration starts. Already matching files require no backup; when nothing differs,
rollback never opens `previous/`, so a deleted or tampered backup cannot prevent lifting the holds.
If needed old bytes are missing or invalid, rollback leaves the run running and its recovery advice
names the backup path that must be repaired before retrying.
Generated `.env` keys stay after rollback intentionally; removing them could reopen missing auth.

After an updater crash, recovery loads `metadata.bundle` from the running journal row without
fetching a new release. Recovery constructs its context from journal data without validating a
synthetic release manifest: a missing journalled `migrationHead` cannot block it, because rollback
and forward commit do not repeat the health gate. A crash between file renames therefore restores
the old bytes and finishes rollback. A failed restore leaves the run running for the next invocation
to retry. Launch recovery with `./haive upgrade --version <interrupted-target>` (PowerShell:
`.\haive.ps1 upgrade -Version <interrupted-target>`). The helper needs that version to choose the
updater image even though journal recovery needs no fetched manifest. Once the
journal phase is `commit`, recovery finishes forward and keeps the new files, because destructive
data migrations may already have run. This pivot is unchanged.

Only after a successful commit marks the run done does pruning remove `pending/new` staging and
older backups classified `pristine` or `legacy-known`. The classification is computed from the
saved bytes and durably written as `previous/.haive-backup-kind` before the backup is journalled.
The newest `previous/` is retained. Backups classified `modified` or `legacy-unknown`, plus older
backups with no recognised classification, survive later upgrades until the operator deletes them.
This preserves edits accepted through `--replace-modified-bundle` beyond the next upgrade.
Each retained backup emits `bundle-backup-retained` with its relative path. Once a run is complete
and its saved edits are no longer needed, manually delete that run's
`<install>/.haive-upgrade/<runId>/` directory; never delete the backup of a running upgrade.
Failed commits and rollbacks retain their backup and staging. A pruning failure emits
`bundle-prune-failed` with `safeErrorMessage(err)` and keeps the successful commit (a lost stack lease stops
the pruning the same way); remaining
prunable files may be cleaned by a later successful bundle upgrade.
Rollback alone adds `--remove-orphans` when bringing up the restored bundle, removing services
introduced by the failed target. Forward deployment and the snapshot restart retain their existing
Compose arguments; services removed by a forward release remain a separate follow-up.
Both installers fetch the chosen release's manifest once: public installs download the GitHub
Release asset, and channel installs read it from the authenticated release image. When it declares
`bundle.files`, they require the allowlisted base/run hashes and verify every fetched compose file,
including the selected GPU or Vulkan overlay, before writing anything in the destination directory.
Hash mismatches and a missing hash for the selected overlay refuse with the filename and guidance
to retry and report persistent failures to the publisher. Missing base or run hashes fail during
manifest parsing with the generic manifest message. Both paths remove scratch downloads and leave
a fresh destination absent (or a forced destination's existing files unchanged). Unselected overlays
are neither downloaded nor recorded; Windows continues to install base and run only.
A POSIX install of such a release needs `sha256sum` or `shasum`; the installer checks for one
before any bundle download, and a legacy release does not need either.

After verification, the installers write `<install>/.haive-bundle.json` as
`{ "version": "<version>", "files": { "<installed name>": "sha256:<hex>" } }`, with the install
directory's owner/group and mode 0644 on POSIX; Windows inherits the install directory's ACL.
Both installers check every bundle destination for a directory and stage the complete bundle,
including record ownership and mode checks, before placing the first bundle file. They validate
generated secrets before the first destination write as well. Generated host
helpers and a newly generated `.env` use the same destination-filesystem stage and rename writer,
so a pre-existing link is replaced without writing or changing permissions on its target. Existing
regular `.env` files retain the installer's existing reinstall refusal.
The record contains no secrets and covers only installed files, so the updater classifies a fresh
install as pristine. A release without `bundle` retains the legacy install behavior and writes no
record; the updater later classifies it as `legacy-known` or `legacy-unknown` using the target's
history. The generated host helpers document and forward `--replace-modified-bundle` on their upgrade command.
See the approved [compose bundle plan](../plans/release-compose-bundle.md).

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
Without either file the updater uses only base and run. It resolves the installed list at startup
and refreshes it from the journalled hashes after swap or restore; staged pulls and config validation
use staged counterparts for changed files, while snapshot stop/restart uses the installed list.
It never probes for a GPU inside the updater container. The separate synthetic Compose
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
background job a route queued: a repository `cloning`, with `refresh_pending` set or holding a live
root claim of any kind, a bundle `syncing`, a CLI provider whose
sandbox image is `building` or whose model is `provisioning`. A claim is live while its
`root_claimed_at` is newer than `ROOT_CLAIM_STALE_MS`; both counters compare against a cutoff built
from the caller's clock and never against `now()`, because the column is a UTC wall clock without a
zone and a session time zone would skew the window. `GET /admin/maintenance/blocking` and
the admin maintenance page list both, so what the page shows is what the updater waits for; a
repository listed only for its claim reads `checkout in use (<operation>)`, with `cloning` and
`pending preparation` keeping precedence. A job
row stuck in its in-progress status holds the drain until the deadline, and `--force` passes it. A
claim whose holder died goes stale within `ROOT_CLAIM_STALE_MS` of its last renewal, inside the
default 30-minute `--drain-timeout`.

**Remaining drain gap (T780 PR2 L6, narrowed by PR2b-3 and PR2b-5):** the count and the list include
every live root claim, and attachment, relink/reconciliation, whole-plan-removal, file-editor save
(`PUT /tasks/:id/files/content`, kind `edit`), mark-onboarded (`POST /repos/:id/mark-onboarded`,
`verify`), onboarding-artifacts reset (`DELETE /repos/:id/onboarding-artifacts`, `reset`) and plan
snapshot Save and Pull (`POST /repos/:id/plan/snapshot/save` and `/pull`) requests are admitted under
the fence. The Save and Pull claim is taken by the worker, after the route's admission and its
enqueue, so between the route's fence commit and that claim (the queue pickup) the drain counts
nothing for the request, and an upgrade whose last zero count falls in that span can interrupt the
job. The Haive-data Save takes no claim and is neither admitted nor counted. A lease renews while the API is alive, with no duration cap. Stopping it mid-request leaves its
last stamp live for up to `ROOT_CLAIM_STALE_MS` (15 minutes after the last renewal); new preparations
wait for that expiry, preserving ready and their pending marker. This bound describes abandoned
claims only, not a safe deadline for interrupting a live upload.

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
`maintenance`: the task routes, every route that writes a job's in-progress status (repository
create, upload and refresh, bundle create, upload, replace and sync, provider create, clone and image
build, and a provider edit that rebuilds the image or downloads a model), and each request that takes
a `mutation` root claim for new work (a task attachment write or removal, a remote relink and its
reconciliation, whole-plan removal) or its own claim kind (the editor save into the repository root,
mark-onboarded, the onboarding-artifacts reset), and the plan snapshot Save and Pull, whose job takes
the claim in the worker: the route admits before it enqueues, the worker is not admitted. A write
that takes no claim (an editor save into a worktree, or for a task with no repository) holds nothing
the drain counts and is not refused. Not fenced and not counted,
since none holds a window open: interactive runtimes (IDE, browser, DDEV control, terminal and login
containers), cleanup, the plan mirror outbox (it resumes) and the price refresh. The refusal's
authority is `admitNewWork`: a read of the state past ConfigService's 30 s cache inside the
transaction that records the work, under a shared
database fence (`lockNewWorkFenceShared`, an advisory lock on `NEW_WORK_FENCE_KEY`); most routes
also answer an early 503 from the same fresh read before they start (`assertNewWorkAllowed`). A state that cannot be read within the bounded
wait refuses new work with a retryable 503 rather than admitting it. A claim-taking request
(`withAdmittedCheckoutMutation`) reads the state once before it claims, so a refused request never
reaches the live-work count; it then takes the claim, then the fence in its own short transaction,
released before the work starts and ahead of the work's own locks. An updater that counts after that
transaction commits sees the claim; one that holds the fence first makes the request read the new
state and release its claim. A route that holds its own claim kind takes it through
`acquireAdmittedRootClaim`, in the same order (`new-work-fence-order.test.ts` fails when an api file
other than `admitted-checkout-mutation.ts` calls `acquireRootClaim` or `withCheckoutMutation`); the
worker's callers are not admitted there. The remote reconciliation sweep reads that refusal as
`maintenance` and skips the repository quietly. An
upload complete makes that read once more right before it claims its session, since the claim is a
write, so a drain that began after the early check refuses with the session untouched. Every
updater state write (`draining`, the recount's `maintenance`, and the return to the state it found
on commit or rollback), like an administrator's maintenance write, takes the same fence exclusively
(`setMaintenanceState`, `enterMaintenance`):
it waits for every admission in flight, so the live-work count it reads next includes each task or
job admitted before it, every admission after it reads the new state, and no write lands inside an
administrator's write. Lifting the hold therefore needs Postgres: an updater that cannot reach it
leaves its run `running`, and the next `haive upgrade` resumes into the commit or the rollback. A rollback that throws does the same: the updater records the error on the run, keeps it `running`, emits `rollback-failed` and exits 6, and the next `haive upgrade` finds the run and finishes the rollback. Its
diagnosis write is best effort: a failed found-state read or restoration write still escapes the
rollback, and even if writing its error also fails, the already-inserted `running` row remains the
durable record the next start reads. Neither failure closes the run or authorizes lifting its hold;
no second recovery file is needed. The admin
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

Draining runs against the source release's schema before migration. The counter detects
`tasks.dead_at` in the catalog and excludes dead tasks only when that column exists (0197); older
schemas count every task in the selected live statuses. It also detects `repositories.refresh_pending`
(0250) in the catalog before counting that marker beside `cloning`, so a ready checkout being
refreshed still holds the drain, and `repositories.root_claimed_at` (0162) before counting a live
root claim beside them. The released v0.2.0 schema ends at 0155, so the updater of the target
release meets a source schema without either column; the API and worker always read their own
migrated schema and need no such check. Older source schemas retain the cloning-only count. Deploy the
marker-aware updater with the API/worker that set it; before downgrading, settle pending refreshes
and retain the additive column and migration. Its other repositories, bundles and provider
columns all exist in the first release baseline. If configuration boot needs its encrypted-row
inventory, it detects the integration tables added in 0192 and counts only those present; failed
reads still refuse key generation. The journal is created independently of migrations.

The updater creates the journal table itself, at every start: `ensureJournal` runs
`UPGRADE_JOURNAL_DDL`, which `@haive/database` exports once and the api's tests build the table
from, so nothing keeps a copy of it. That runs before the database lock, the stack lock and the child check, so
when it cannot reach PostgreSQL (an updater killed mid-snapshot can leave it stopped) the start refuses with
`updater-bootstrap-failed`, exit 3, before any lock and with no attempt row. The refusal names the error's code and
tells the operator to look for and remove this install's surviving updater one-shots (labels
`org.haive.updater.attempt` / `org.haive.updater.role`) before starting PostgreSQL again, since the child check
that would catch a still-running volume archive cannot run without the database. Only connection-class failures,
keyed on stable codes (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `ETIMEDOUT`, postgres.js `CONNECT_TIMEOUT` and
`CONNECTION_*`, SQLSTATE class `08` and `57P0x`), become that refusal. Configuration boot runs first and keeps its
own diagnoses (the encryption-key refusals in [Error diagnostics](error-diagnostics.md)), and any other journal
error passes through unchanged.

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
rollback-images-missing, install-locked, updater-child-running, updater-child-check-failed, stack-lock-unproven, a preflight refusal), or `failed` for an error. `error` is capped at 2048 characters with room kept for the sentence appended below, so truncation never drops it, `channel` is the resolved one, and an unusable `--version` is stored as `unknown`. When the
start ends before the install settings were read (`install-locked`, `install-file-linked`, a failure inside
that read), the row records the literal `HAIVE_CHANNEL` and `HAIVE_VERSION` of `.env` instead
(`readAttemptInstallFields`; an empty channel is `public`). A value that is absent, invalid or interpolated is
stored as `unknown`, and a `.env` that is missing, linked, not a regular file, over 256 KiB or unparsable puts
`not-read` in both columns (this display read and the installed-version read use the one strict parser in
`envkeys.ts`, as the required-key check does, and read through the held install directory, never by path); either way a sentence appended to `error` says which. The read runs without the
stack lock in the `install-locked` case, so it shows what `.env` held at that moment. In
the same transaction, after the insert, it deletes the attempt rows beyond the newest 50 (ordered
`started_at DESC, id DESC`, never the row it just wrote), so repeated refusals cannot grow the
table. An attempt row is exactly `phase = 'preflight' AND status IN ('refused', 'failed')`; no real
run ends that way (`finishRun` writes only `done` or `rolled_back`, and a failed rollback leaves the
run `running`). That predicate lives twice, as `attemptRow` in the api and in the updater's prune,
and the two must change together. No
reader of a run matches these rows: `findLiveRun` wants `running`, `lastDoneChannel` wants `done`,
and the one-live index covers only `running`. A failed insert is reported as `attempt-record-failed`
and changes neither the exit code nor the outcome. A busy database lock writes nothing; a busy install
stack lock is the `install-locked` refusal and does write a row. A start that fails
before the database or the lock (bad argv, missing `DATABASE_URL`/`REDIS_URL`), an updater killed before its last step, an updater that lost the stack lock (`stack-lock-lost`; the row would land in the new holder's history) and a target release older than this updater all leave no row.

`GET /admin/maintenance/upgrade` returns the newest such row as `lastAttempt` only while no `done`,
`running` or `rolled_back` run is newer (`lastUpgradeAttempt`, read apart from the history so
repeated refusals cannot hide a real run); a tie goes to the real run. The history
(`listUpgradeRuns`) caps the two kinds apart: the 20 newest real runs and the 10 newest attempt
rows, merged newest first, so refusals never push a completed run out of it. The admin page shows it as
a banner (`upgradeAttemptBanner`, gated on status and time, the error rendered as markdown) that
replaces the launch box once it is newer than the launch, and History lists the rows. Every instant
in that response is ISO 8601 with an offset: the columns are `timestamp` holding the session's wall
clock, and a zone-less string would be parsed as browser-local time.

## The install stack lock

The updater and the Desktop extension exclude each other through one lock file, `.haive-stack-lock`, in the
install directory: the `/install` mount every launcher gives the updater, and the one path the extension's
host bridge shares with it. Neither older guard can do the job alone. The updater's database lock is a session
lock on the database that the snapshot phase stops, so it ends there. The extension's
`<install>.extension-lock` window lock is a sibling of the install directory, outside the mount. The
extension's container check sees only a running updater container, so an upgrade launched after its final
check could still have PostgreSQL stopped by the snapshot while Compose was starting or stopping services.
Advisory file locks (flock, LockFileEx) are not used: host and container are different kernels behind a
file-sharing layer. Only exclusive create and rename are relied on.

The file is a lease. Its single line is JSON in this field order: `v` (1), `token` (32 lowercase hex),
`holder` (`updater` or `extension`), `startedAt` (informational, never compared with a clock) and `seq`. It is
created exclusively at mode 0644 and rewritten in place by its holder every 5 s with a new `seq` (each write attempt takes the next number before it writes and keeps it
when the write fails, so a write that lands always changes the bytes, and `seq` may skip numbers), after a
check that the file still carries the holder's own token; a file that is gone is created again with the holder's
own record, since a contender's break and restore leaves the name absent for a moment. After the holder's own overwrite failed having truncated the file, an empty or partial record is taken as its own torn
write and rewritten instead of reported as a loss, until the deadline below; an overwrite that failed before
truncating (at `open`) excuses nothing. A contender that finds the file reads its
bytes, then polls every 1 s: a missing file is free, changed bytes mean a live holder (busy), and bytes
unchanged across 60 s of polls mean the holder is gone. It counts the sleeps it requested and never reads a
wall or monotonic clock, so host sleep and clock skew between host, VM and container cannot age a live lock;
an empty or partial record is just another byte string, and so is a file longer than 4096 bytes (a record is
about 150): every read takes at most 4097 bytes and those are what is compared. Breaking a stale lock renames
it to a tomb beside it (exactly one breaker wins) and re-reads the tomb: bytes other than the observed ones
mean a fresh lock was displaced, which is put back by exclusive create and reported as busy. A tomb that cannot
be removed after an equal re-read does not stop the acquisition (the updater logs `stack-lock-tomb-left`); the
leftover `.haive-stack-lock.stale.*` file is harmless. At most 3 rounds, then busy. A holder that finds another
token in the file has lost the lock: the updater logs `stack-lock-lost` once (the bridge has no log for it), the
holder stops beating and never removes another holder's file. The updater does not wait for its next beat to
learn that: before each phase, each journal and install-file write, each maintenance-state write and each Docker
call that starts or fetches something (`docker run`, `create`, `pull`, and Compose `up`, `stop` and `pull`) it
proves ownership from the stored record (`StackLock.assertOwned`, waiting out an in-flight beat;
`lease-fence.ts`). A record that parses, carries a token, holder and `startedAt`, and differs in any of them is
a proven loss and sticks: the phase is refused with `stack-lock-lost`, exit 3, and the updater does no rollback,
no journal or attempt write and no release, and removes only its own attempt's labelled children; the run stays
for the new holder to recover. Anything that proves nothing (a read that fails `STACK_LOCK_PROOF_TRIES` times,
100 ms apart; an absent name, which breaking a stale lock briefly leaves; a record that lacks a token, holder or
`startedAt`; an empty or partial record, unless this holder's own overwrite of its record failed after truncating it, when it counts as its own torn write; a failed read or proof never enables that) refuses the forward phase with `stack-lock-unproven` (exit 3 when no rollback is needed
or it succeeds, 6 when it fails; in the commit phase the run stays at `commit`) but marks nothing lost: failure recovery (the snapshot's database restart, rollback, a reverse resume of an interrupted run from its
entry proof on, the attempt row, release) still runs, re-proving before each action and stopping only at a proven loss, since leaving the database
stopped turns a recoverable failure into an outage; the forward commit stays strict and refuses at an
unproven proof. That tolerance is bounded in time. A contender breaks only after
the record's bytes stayed the same for the stale window (60 s), and only this holder's writes change them, so the holder's
deadline runs from its last successful record write (acquisition or beat), stamped before that write's I/O: once the stale
window has passed since then, an unproven proof and the own-torn-write excuse count as a proven loss. Proofs never renew it,
since a proof leaves the bytes, and so the contender's clock, unchanged; a failed write never renews it either. Expiry is the same
sticky `stack-lock-lost` as a takeover, with the same consequences: the run stays half-way (maintenance on, PostgreSQL possibly
stopped) for the next `haive upgrade` to recover, even when no other holder exists; release is then a no-op, so an intact own
record stays and that next start waits out the stale window before it breaks it. A Docker or database action already under
way when the deadline passes is not interrupted; the next fence check refuses. The updater's clock is `performance.now()`, the
bridge's Go's monotonic `time.Now()`, never the record's `startedAt`; a clock that counts a suspended machine only expires early, but the bound cannot see a pause its own clock does not count (a
paused VM).
The bridge cancels its operation immediately on proven lease loss, or after transient renewal errors persist for half the stale window (30 s), terminating its supervised
command before waiting for the stale deadline. Renewal retries continue during cancellation and command Wait;
only expiry or loss stops them for good. An independent timer checks the last successful renewal even
while a heartbeat is blocked in file I/O; its clock uses a separate mutex from that I/O. A frozen
bridge still cannot observe its own missed beats.
A remaining race (T765 item 5): the heartbeat reads its own record and then overwrites it, so a contender that broke the lock and created its own in between is overwritten; closing it
needs a descriptor-held compare before the truncating open, in both implementations. A result already decided (done or rolled back) is not replaced when the beat notices a loss afterwards; a
loss during the pruning after a commit stops the pruning and keeps `done` and exit 0. Release removes the file only when it carries the holder's token, is shared by
every
caller, never throws, and a failed removal leaves a lock that the stale rule clears. A non-regular entry at the
name (a directory or a link) is refused and never followed or deleted. A holder name read from a record reaches
an operator only as a plain token, since the file is writable by anyone with access to the install and
messages render as markdown.

The updater takes it right after its database lock and a first live-run read, before the install-file checks,
and holds it through rollback. That first read only decides whether a `--check` needs the lock. The wait can
outlast the run the read saw: the snapshot's database restart ends the first updater's session lock, so a second
updater can pass it, read the first one's live run and wait while the first finishes. Under the lock the updater
reads the live run again and recovers, cleans and records attempts from that read alone, so a finished run is
never resumed or rolled back. Before that recovery, and before any volume or database action, it checks for a
running container a previous updater started: every one-shot (the volume archive, the restore, a migration, the
module build) carries `haive.install` (the install id), `org.haive.updater.attempt` and
`org.haive.updater.role` labels, and a running one with this install's id and another attempt (an empty attempt
included) refuses the start with `updater-child-running`, exit 3, naming each container id and role, since its
writer may still be touching the volumes or the database. When `docker ps` itself fails, the start refuses with
`updater-child-check-failed` and the error's code or class, never its text: the check fails closed. A `--check`
with no live run skips it. Removing a leftover by hand (`docker rm -f <id>`) is the way forward once it is known
dead or finished. A labelled one-shot has no client timeout: the Docker client forwards a SIGTERM to the container, whose
first process ignores it, so on earlier releases such a timeout never stopped one anyway, and enforcing it now
would kill a long migration in the forward-only commit phase. When the client ends without an exit status of its
own (killed by a signal, or by Node when the output passes its 32 MiB buffer) the container keeps running (the
daemon owns it), so the updater removes that attempt's containers of that role by label before the error
propagates; a removal that fails is checked by listing them again, never by reading Docker's message. When they
cannot be removed it refuses with `updater-child-cleanup-failed` (exit 3, the run's error recorded with the original
failure's code) and does not roll back, which would race the survivor: the run stays for recovery, and the next
start's child check refuses until the container is gone. A SIGTERM to the updater removes this attempt's running
one-shots before it releases the lock and exits 143, waiting at most `STACK_LOCK_SIGNAL_CLEANUP_TIMEOUT_MS` (5 s,
under `docker stop`'s 10 s grace) so a hung daemon cannot keep the lock held; from the moment it starts, that attempt launches no further one-shot (`one-shot attempt is stopping`), so a later phase cannot start a child its list has already missed; after removing what it listed it lists once more within the same bound and removes what the first listing missed, so only
a child created after that second listing can survive, and the next start's check catches it; a removal that fails or overruns is
logged and the lock still released, so the next start's check catches the survivor. A SIGTERM that lands while the
updater is rolling back can end it mid-rollback: the run stays for recovery, and the next start reverses it, as after
any crash. It releases the lock in `finally` on every exit path and on SIGTERM (exit 143), except after a proven loss, when release is a no-op and SIGTERM still removes only this attempt's children. That handler is new: as PID 1
the updater ignored SIGTERM, so `docker stop` waited out its grace period and then killed it, and now it exits
at once and frees the lock. SIGINT stays unhandled, because Ctrl-C is ignored by PID 1 there today. A busy lock
refuses with `install-locked`, exit 3, and an attempt row like any preflight refusal. A dry plan, a `--check`
with no live run (read-only) and a missing install directory take no lock (the last logs `stack-lock-skipped`).
The extension takes it for Start and Stop, after reading the install settings and its first container check,
before the bundle check and the port repick, and holds it through the Compose call. Install never takes it (the
installer refuses a non-empty directory) and Status is read-only. The launchers take nothing: they return
before the dangerous phase and are older-release code for the very upgrade that matters. Both implementations
share the file name, record, beat (5 s), stale window (60 s), poll (1 s), rounds (3) and size cap (4096 bytes),
and the rules that only the holder's own overwrite that failed after truncating excuses a torn record, that the deadline runs
from the last successful record write, stamped before its I/O, and that every write attempt takes a new `seq`
(`packages/updater/src/stack-lock.ts`, `docker/desktop-extension/bridge/stack_lock.go`); a script test pins
the name, the constants and the record's field order equal, and the two test suites pin the rules. Every count, size and time limit is an optional parameter defaulting to a named constant.

No release floor is needed. An updater that predates the lock never takes it: the extension's container-identity
check, kept as it was (both checks), is then the only protection, with the window it always had. An extension
that predates the lock ignores the file, and the updater keeps only what it had. Deploy order is free; full
protection needs the target release's updater image (it runs the upgrade) and the updated extension.

A holder that dies leaves the file. The next contender clears it after 60 s without a change, logging
`stack-lock-waiting` and then `stack-lock-broken` when it is the updater, so a crash never wedges the shared
lock; a lock whose holder lives is never broken, since it changes at least every 5 s. Residual windows: a holder
frozen for more than 60 s (SIGSTOP, a paused VM) while a contender is awake can lose the lock; it learns of it
at its next proof, but a proof cannot fence an action already under way (a Compose or `docker run` call can run
for 30 minutes) or a freeze between the proof and the action it guards; between the rename and the restore of a
displaced fresh lock the name is briefly
absent, so the displaced holder's next beat creates it again and a third party creating it first keeps it. A
holder whose beat cannot be written (a full disk, say) stops refreshing the lock, which then lapses after 60 s;
the bridge cancels a supervised command on proven loss or 30 s without a successful renewal. A killed bridge's host command is terminated by OS supervision, subject to the simultaneous-kill limit below (see [command supervision](#host-command-supervision)); work the Docker daemon
already accepted can still complete after the client dies. Killing the client does not undo a partially
started stack, and an interrupted operation does not authorize automatic cleanup or a retry of an ambiguous
upgrade: inspect status, logs and the updater journal and retain the existing manual recovery refusals.
A container started by an updater killed outright (SIGKILL, OOM)
outlives it; the next updater's child check refuses while it runs, but only for containers labelled by this
release's updater or later (an older updater's children carry no labels); a child started inside the
proof-to-action window above runs next to a new holder already past its own check, and is caught only by the
start after that.
Docker Desktop's file-sharing coherence is not verified: the create is exclusive and no decision rests on a
negative lookup. Delete `.haive-stack-lock` by hand
only when no updater container and no extension operation is running.

## Own-module images

The release matrix also publishes `haive-builder` from the repository-root context using
`docker/own-module-builder/Dockerfile`. It is stamped with the same release version. Published
installs can override api/worker/web image references independently through `HAIVE_API_IMAGE`,
`HAIVE_WORKER_IMAGE`, and `HAIVE_WEB_IMAGE`; db-migrate follows the API reference. The updater
rebuilds configured own modules during preflight, before draining, and journals both old and target
references for rollback and recovery. See [Modules](modules.md#own-modules-on-a-published-install)
for the prepared-source and per-customer builder contract. Channel selection and customer builder
publication remain the vendor pipeline's responsibility; a public builder contains public core only.

## Docker Desktop extension

The local prototype lives in `docker/desktop-extension/`. It reuses the RUN-IT
installers and release compose bundle. The owner began native live acceptance on
Windows with Docker Desktop 4.98; a port clash exposed a frozen failure panel. The
startup and port selection behavior below has unit/build evidence; native acceptance
of these changes is still pending. The extension has not been published.

### SDK contract verified 2026-11-17

Measured: Extensions CLI v0.2.32, server API 0.4.2, Docker client/server 29.9.2.
The JavaScript client and its lockfile-resolved types are 0.4.2; the image declares
`>= 0.4.2, < 0.5.0`. These are measured versions; Docker's web manuals are unversioned.

The [metadata contract](https://docs.docker.com/extensions/extensions-sdk/architecture/metadata/)
requires `/metadata.json`, and permits optional UI, VM and host sections. A VM
backend can use `vm.image` (generated Compose) or `vm.composefile` (supplied Compose).
This extension uses a host executable backend, without a VM section: installation
needs a real host path for the existing updater, and extension uninstall must not
silently destroy an independently managed Haive install.

[Host executables](https://docs.docker.com/extensions/extensions-sdk/guides/invoke-host-binaries/)
are copied from the image, invoked with `ddClient.extension.host.cli.exec`, and removed
with the extension. They run as the Desktop user. The extension uses buffered exec;
installer and Compose output stays in a local operation log, while the UI receives
structured status and errors. The request is one unpadded base64url argument: Desktop's
Windows host-exec command line strips quotes from raw JSON. The helper decodes that
argument without introducing a shell or changing the installer.
`ddClient.host.openExternal` opens the existing app;
`desktopUI.navigate.viewContainerLogs` opens the selected API or worker container.
See [Dashboard](https://docs.docker.com/extensions/extensions-sdk/dev/api/dashboard/)
and [NavigationIntents](https://docs.docker.com/reference/api/extensions-sdk/NavigationIntents/).

The [architecture contract](https://docs.docker.com/extensions/extensions-sdk/extensions/multi-arch/)
uses Linux extension images even on Windows. The local image contains amd64 and arm64
variants; each carries a native Linux, Darwin and Windows helper for that architecture.
No shell runtime beyond the existing installer prerequisites is added to the host.
Windows uses its native PowerShell; macOS and Linux use `sh`. The Windows process uses
execution-policy bypass for that invocation only; it changes no machine policy.

### Installation and lifecycle

`Install` invokes an embedded, byte-for-byte copy of `install/install.sh` or
`install/install.ps1`, with an install id and `--no-start`/`-NoStart`. The installer
resolves latest/next once, pins an exact release, validates the release manifest and
bundle hashes when declared, probes ports, generates secrets and writes its normal
helpers. There is no second version resolver, secret generator, compose definition,
registration route or module entitlement resolver.

The id and Compose project are `haive_desktop`; the host directory is
`~/haive_desktop` (`%USERPROFILE%\haive_desktop` on Windows). Existing directory and
resource collision refusals remain the installer's. The helper refuses other ids,
unpinned settings, linked bundle files and a host Docker CLI pointed at a different
engine from Desktop's SDK. The resolved Compose model must use this install's
resource names and published images before install completes or Start runs. Older
shared-name bundles and source-build services are refused. During Install, a bundle refusal or generic
installer failure names the install folder and says to remove that folder, then install
again; the UI renders this advice in its status message. Start never gives that advice: its
folder holds an established install's `.env` secrets, which its data volumes depend on. The helper deletes no install
files. A failed installer can leave a non-empty partial directory, such as snapshots,
that must be removed before retrying. An unsupported release written with no start
also requires clearing that fresh directory before choosing a newer release. Preserve
an established install's .env and data before any manual cleanup.

`Start` runs the installed base/run bundle and its already selected GPU overlay,
NVIDIA first, then Vulkan, matching the updater. It calls `up -d --no-build --wait`
with a six-minute service wait, without resolving or repinning a release. Initial
missing images are pulled by Compose. The bundle's db-migrate dependency remains the
only migration path. On every Start the helper checks all three configured TCP ports:
`HAIVE_WEB_PORT`, `HAIVE_API_PORT` and `HAIVE_MAILPIT_PORT`. It lists running Docker
containers and reads their structured `NetworkSettings.Ports` bindings in one inspect
call, including IPv4 and IPv6; exposed-only container ports and UDP bindings do not
conflict. It
also probes host availability with IPv4/IPv6 wildcard TCP binds, so native listeners
and Docker-published ports both count. After IPv4 passes, only an IPv6 address-in-use
or access-denied error counts as a conflict; other IPv6 errors mean the family is
unavailable. The platform-specific checks unwrap errors and use native Winsock codes
on Windows. A port published by this Compose project is exempt from the host bind probe, while a foreign binding on that same number still
conflicts. This checks availability rather than reserving ports through Compose start.

A conflict selects the next available port, bounded to 50 candidates including the
configured port and never past 65535, matching the installer's bounded search. Other
configured service ports and ports selected earlier in the pass are reserved so web
cannot take the API's port. All three selections finish before any file write. An
exhausted search refuses Start with `.env` and containers unchanged. Failed or malformed
Docker reads also refuse safely; Stop skips port selection. Status and Stop do not
require `HAIVE_MAILPIT_PORT`; only Start validates it, defaulting to Compose's 8025
when absent or empty. A move still requires a unique existing assignment to rewrite.

For a changed port the helper replaces only the digits in its single `.env` assignment;
it preserves LF/CRLF, comments, whitespace, unrelated bytes and POSIX file mode. It
requires a regular file and a unique assignment, writes a temporary file in the install
directory, syncs and renames it; a changed file observed before rename refuses. On
Windows, a failed rename retries up to four total attempts with 50 ms sleeps between
attempts. Every attempt rechecks the original bytes; an observed edit refuses without
overwriting it. The temporary file is removed on success or refusal. Windows sharing
and antivirus behavior still require native live acceptance. It never prints `.env`. The operation returns messages such as `web moved to 3002 because 3000
is in use`, and the UI retains them alongside status through subsequent polls in that
tab. The new app URL comes from the updated settings. Selection does not rewrite the
release bundle, version pins, generated helpers or secrets. A late listener race can
still fail Compose; refresh and Start repeats selection.

After `up` fails, the helper reads this project's Compose status. A web/API/Mailpit
service still `created` is inspected privately for `State.Status` and `State.Error`.
Docker has no allocation code there, so the named `portAllocationError` constant
recognizes its allocation wording. A match names the port, `.env` keys and operation
log; unknown errors or failed diagnostics retain the generic Compose failure/log
pointer. No raw daemon error is sent to the UI. Start never advises removing an
established install folder. The existing installer selects CPU on macOS and Windows;
Linux keeps its existing GPU detection. The disclosure names both the host-root-equivalent
Docker socket access and the stack's read-write mount of the home folder. Install and
Start require consent in the UI and the literal consent marker in the helper. For
an installed instance, the tick persists in that viewer's localStorage, keyed by
engine identity and install directory, and the checkbox restores it after tab reload.
Reading and writing storage are guarded; missing or denied storage restores unticked.
Unchecking clears the stored tick. A status showing no installed instance clears its
stored tick and requires an explicit new tick before Install. The successful fresh
Install carries that explicit tick into the installed view. No consent is stored in
`.env` or shared across viewers. This is
a guard against a UI regression; a same-user caller able to run the helper can supply
the constant marker and already has the same host authority.

`Stop` calls Compose stop for this project and retains containers, networks and every
volume. It requires valid settings and regular compose files, but does not run the
resolved-model/isolation check. The upgrade guard below still applies to Stop.
Start retains the check. Stop still depends on Compose itself accepting its stop
command. It stops Compose services; worker-created resources follow the existing worker
shutdown behavior. Status is read-only. The UI re-reads it after every Install, Start
or Stop, whether the operation succeeds or fails. Operation errors and service snapshots stay separate;
a failed status read retains the last rows and marks them as last known. Controls
are recomputed after every operation and every poll: Stop requires at least one
`running`, `restarting` or `paused` service; Start requires an installed instance,
consent and at least one service not ready; Open app requires the web service running and reachable. Busy or
unavailable status disables mutations and app opening. Ready means running with
healthy health (or no healthcheck); API and web use the extension probes below. The
exit-0, exited `db-migrate` one-shot counts as ready. Status privately reads the
installed Compose model and adds `missing` rows for active services with no container,
so removed services cannot make a partial stack look ready; inactive profile services
are not required. Stop's own returned snapshot skips model resolution to preserve the
escape hatch, then the UI's normal status refresh resolves it again.

While visible, the tab polls status after five seconds during an operation or when
Compose reports a created/restarting service, a starting health check, or a running
API/web service whose extension probe is negative. Each fast window lasts at most
five minutes; starting Install or Start resets it, and completion resets it again so
Node startup after Compose returns gets fast progress. Continued starting states do
not extend the deadline. Three consecutive status-read errors also switch to thirty
seconds; a successful read resets that error count. Outside the fast window or when
steady, it polls after thirty seconds. Each periodic read finishes before the next
is scheduled. Hiding the tab cancels its poll timer; showing it reads
status immediately. Page teardown disposes the controller, removes the listener and
ignores late replies. An in-flight read is not cancelled. Operation completion
invalidates older polls and reads a fresh snapshot even if a poll is still in flight.
The helper returns only each service's name, state, health, exit code and published
ports (interface, target/host port and protocol); Compose labels, mounts, container
IDs and host paths never cross to the UI. Container IDs needed for late failure
inspection remain private. The table shows those fields, with a `Starting…` summary
and ready/total progress during the fast window while any service is starting,
including negative running API/web probes. After the window expires, the summary
reads `Still not ready (N/M)` and retains the ready count with thirty-second polling.
Idle status and port notices appear only in the summary live region;
the operation region contains distinct progress or error text. The count includes
a successful exit-0 `db-migrate` one-shot. Errors remain visible alongside the
current status until the next manual action. API health is `healthy`/`unhealthy` from a bounded `/health` request
requiring HTTP 200. Web health is `reachable`/`unreachable` from the app URL, accepting
2xx or 3xx without following redirects. Both table values are labelled `extension
probe`; Docker's own missing healthchecks do not leave these rows blank. Each probe
runs only while this project's corresponding service is running; stopped services
cannot borrow another app's response. App opening depends on web reachability and
can remain available while the API or another service is down. The app opens at the actual selected port on `/setup`, whose
existing first-admin/login guards remain authoritative. The extension collects no
administrator passwords, API keys or registry credentials. Its UI installs public
releases only; channel installs retain the existing installer and private credentials.

Data volumes live in Docker Desktop's engine/VM, not in the extension image. Runtime
volumes include `haive_desktop_{postgres,redis,mailpit,ollama}_data`; repositories,
bundles, wrappers, caches, DDEV CA and per-task auth/IDE volumes use the existing
`haive_desktop_` namespace. The host directory holds `.env`, the bundle, bundle record,
normal control/uninstall helpers and snapshots. Keep `.env` while retaining data.
The sibling `haive_desktop.extension.log` records the latest mutation (0600 on POSIX;
Windows uses the profile's inherited ACL). No log is sent to the web UI.

Updating or removing the extension replaces/removes its SDK-owned UI and executables
only. Haive's stack, directory, log and volumes remain; a running stack keeps running.
Upgrade Haive through the existing admin updater, with its drain, backup and rollback
contract. Extension replacement never upgrades Haive. To stop before removing the
extension, use Stop. To remove Haive itself, use its generated uninstaller separately:
the default deletes runtime volumes including PostgreSQL, and purge also deletes work
volumes and owned built images. The directory and pulled release images remain. No
extension removal path calls down -v or prunes volumes.

Before Install, Start or Stop, the host helper checks for a running updater for
`haive_desktop`. This first check precedes the installer, port rewriting and any
Compose command; Start and Stop make a final check immediately before the Compose
call that changes services. An active updater refuses the action with guidance to
wait for completion and refresh. If the updater is hung, stop that updater container
in Docker Desktop, then check the upgrade state in the existing updater journal
before retrying. A failed or malformed Docker listing/inspection retries the whole
list-and-inspect check once with fresh container IDs; a second error refuses the
action. This also covers a container removed between listing and inspection.
Status remains read-only. Install continues to use `--no-start`/`-NoStart`; only
Start invokes Compose up.

The API's in-app upgrade and the generated POSIX/PowerShell `haive` helpers launch
the updater outside Compose, without updater or Compose project labels. The helper
therefore identifies the released image's exact `node packages/updater/dist/cli.js`
entrypoint together with an exact `HAIVE_INSTALL_ID=haive_desktop` or
`COMPOSE_PROJECT_NAME=haive_desktop` environment entry and `State.Running`. It lists
running container IDs and inspects them in one batch. The Docker template projects
these fields to booleans: no environment values, credentials or full inspect output
are returned to the helper or UI. This works while PostgreSQL is stopped for its
volume archive and the API/journal cannot be queried. Other installs and stopped
updaters do not block these actions. This is a check of the released container launch
contract, not an atomic mutex with the updater: a new upgrade can still begin after
the final check, a crashed updater's unfinished journal is not read, and a custom
entrypoint or host-run updater is outside this detection contract. An updater that
includes the [install stack lock](#the-install-stack-lock) closes that window; released
updaters do not take it, so for them this check remains the only protection. Changing the
updater entrypoint or its install
environment requires updating the extension in the same release. A script test pins
the Dockerfile entrypoint to the extension guard and both install identity environment
arguments in the API and generated POSIX/PowerShell upgrade launchers. The updater
launch protocol is unchanged.

A cross-process window lock serializes extension mutations. `~/haive_desktop.extension-lock`, a
sibling of the install directory, is taken for Install, Start and Stop (never Status) before the
operation log is opened and released after everything else. It is a lease: a regular file holding the
install stack lock's record, with the same beat, stale rule, break and release (`acquireLease` in
`stack_lock.go`; controls in `window_lock_test.go`). The stack lock keeps its own file and wire
contract, and the updater never sees this one. Install needs it because the install directory, and so
the stack lock, does not exist yet; Start and Stop take the stack lock inside it. A live holder refuses
a second window with a message that says the lock clears itself, once the contender has seen a beat
(within about 5 s). A hard termination tears down the supervised command and leaves the file; the next
operation clears it after 60 s without a change (up to two minutes when the stack lock was left too); a tomb that cannot be removed stays
beside it, harmless. Normal completion and handled signals release it. Earlier bridges took this name as
a folder, which has no beat and never lapses: the bridge refuses a folder at once, naming it, and never
deletes it or waits on it, since a live older operation cannot be told from a dead one. Its message says
to check this install's containers and delete that folder by hand. An older bridge that meets the lock
file refuses the same way (its `mkdir` finds the name taken), so old and new bridges still exclude each
other. If an older bridge makes its folder at that name in the instant a stale file is being broken, the
break renames the folder back; a file created there first keeps the name.
Keep the tab open during long operations. Processes have a 30-minute deadline; a timeout or close can
leave a completed install or partially started stack, so refresh status and inspect logs before retrying.
No automatic reinstall or deletion is attempted.

### Host command supervision

Host mutations (Compose and the embedded installer) run through a private
`--haive-command-supervisor` mode of the same bridge binary. Docker queries also use supervision,
except Windows `status` and the pre-lease `docker info` engine probe, which run without a Job Object:
they hold no install lease and cannot mutate a stack. The mode receives the command runner's filtered
environment, working directory and output capture/private logging. Arguments remain separate, without
an extra shell; `argv[0]` becomes the resolved executable path. `commandSupervisor` refuses command fields
it cannot preserve (stdin, extra files, process attributes, cancellation hooks, wait delays or a started
command) instead of silently discarding them.

The parent holds the only write end of an anonymous admission/liveness pipe, which never reaches the
command. Admission requires both a random per-launch nonce (matching argument and environment, removed
before the command starts) and a byte from the parent's pipe. Supervisor failures are written to stderr,
which the installer/Compose path captures in the private operation log.

- **Linux:** the command owns a process group and has `SysProcAttr.Pdeathsig = SIGKILL`. Its creating
  goroutine holds its OS thread until Wait finishes. The supervisor is named `haive-cmd-guard` through
  `PR_SET_NAME`, so `pkill haive-desktop` without `-f` does not also kill its watcher.
  `pkill -f haive-desktop` can match and kill both. Both bridge and
  supervisor request child-subreaper status to reap orphaned group members; a refusal logs a warning
  and degrades to ordinary OS reaping instead of refusing every command. Parent-pipe EOF kills the
  command group, covering Compose/installer grandchildren beyond the direct child's parent-death signal.
- **macOS:** the pipe watcher survives bridge death and kills the command group; it needs no Linux-only
  parent-death signal. Orphans are reaped by launchd. On both Unix targets the supervisor reports the
  command's pgid and completion over a separate close-on-exec status pipe. If it dies by signal or
  without reporting completion, the surviving bridge kills that group and waits for it to disappear
  before releasing leases, then reports a distinct uncertain-outcome error with manual recovery advice.
  Normal launcher exit also kills remaining group members: a shell's background jobs are terminated,
  even if the launcher exits successfully. Descendants that deliberately detach into another process
  group remain outside this mechanism. Only ESRCH proves an empty group during cancellation or a
  supervisor-death sweep: EPERM retains an unconfirmed-stop refusal. After a successful command only,
  a non-ESRCH probe error is logged as a warning instead of turning success into exit 125.
  The bridge consumes the pgid report before status EOF and signals it immediately on cancellation,
  including if the supervisor is stalled; a valid completion record skips the redundant bridge-side kill.
- **Windows (amd64/arm64):** the parent creates an unnamed, non-inheritable Job Object with
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, starts the waiting supervisor, assigns it and only then admits
  the command. Descendants inherit membership at creation without breakaway flags. Bridge death closes
  the sole job handle and kills all members. Cancellation calls `TerminateJobObject`; errors are
  retained, and job accounting must reach zero active processes before completion. Install/Start/Stop
  fail closed if assignment fails (including an incompatible enclosing job); the Win32 error is logged
  and the user sees a supervision-policy refusal, rather than a Docker engine-context diagnosis.
  This uses stdlib `syscall` only.

Both leases keep beating through command/group teardown and output draining, including after
cancellation. Proven lease loss cancels immediately; transient heartbeat errors cancel only at
`now - lastGoodBeat >= stale/2` (30 s). Renewal continues until release, and the user sees lease loss
as the cancellation cause. Teardown waits use the named 30 s `commandTeardownTimeout` per phase,
including output draining and group/job polling. If teardown cannot be confirmed within these bounds,
the operation returns a distinct "Could not confirm the command stopped" error requiring manual host
inspection before retrying. Before releasing either held lease, that error and the supervisor-death
uncertain-outcome path atomically write `<install>/.haive-extension-unconfirmed` (0600 on Unix,
profile ACL on Windows). Its JSON contains only `os`, `pgid` (0 when unknown), `operation` and UTC
`time`; it contains no command arguments, environment or secrets. A failed early Install creates a
partial install directory to keep this marker inside the updater's mount. The bridge reports a marker
write failure explicitly; persistence still depends on a writable, functioning host filesystem.
Both leases may then release, but every Install/Start/Stop refuses while the marker exists and keeps
the operation log intact. Status remains read-only and reports the refusal, without clearing it.
A mutating Unix bridge request clears a same-OS marker itself only while holding the window lease
and only when `kill(-pgid, 0)` returns ESRCH. The pre-lease check may refuse or proceed to that lease,
but never removes a marker. Immediately before removal under the lease, the bridge re-reads and
compares the complete record with the one probed; a changed record refuses, even with the same pgid.
A live or reused pgid, EPERM, an unknown pgid or malformed marker keeps refusing. The updater never
clears this marker. It checks the same filename before taking its stack lease (and again before
returning it) and refuses with stable code `extension-command-unconfirmed`; it cannot probe a host pgid
from its Linux container.
Deploy the updated bridge and target updater together for this protection; older versions ignore the marker.
A frozen VM or an unschedulable kernel task cannot offer a hard wall-clock guarantee.

Manual recovery for a marker that cannot clear itself:

1. Preserve `<install>.extension.log` and read `<install>/.haive-extension-unconfirmed`. Refresh
   extension Status, inspect this install's Docker Desktop containers and check the updater journal.
   Stop any still-running updater and let its work finish or follow the existing interrupted-upgrade
   recovery procedure before enabling another mutation. Preserve `.env` and all data volumes.
2. **Linux:** use `cat "$HOME/haive_desktop/.haive-extension-unconfirmed"` and
   `ps -eo pid,ppid,pgid,stat,args`. Find every member of the recorded pgid and this operation's
   detached descendants. If the group still exists and belongs to this command, terminate it with
   `kill -KILL -- -<pgid>`; verify it is absent in `ps` (and `kill -0 -- -<pgid>` reports no such process).
   Never signal a reused group belonging to something else. Once no command/supervisor/descendant
   from this operation remains, remove only the marker with
   `rm -- "$HOME/haive_desktop/.haive-extension-unconfirmed"`, or let the bridge clear an ESRCH pgid.
3. **macOS:** use `cat "$HOME/haive_desktop/.haive-extension-unconfirmed"` and
   `ps -axo pid,ppid,pgid,stat,command`. Identify the group and detached descendants as above;
   for a group verified to belong to this operation, use `kill -KILL -- -<pgid>` and wait until it
   disappears from `ps` (launchd may need time to reap it). Only after all of this operation's
   processes are gone, use `rm -- "$HOME/haive_desktop/.haive-extension-unconfirmed"`, or retry
   for automatic ESRCH clearance. Unknown/reused pgids require process inspection, not a blind kill.
4. **Windows (PowerShell):** run
   `Get-Content -LiteralPath "$env:USERPROFILE\haive_desktop\.haive-extension-unconfirmed"` and
   `Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine`.
   Privately identify this bridge/supervisor, docker.exe, Compose plugin, installer and descendants
   using the recorded operation/time and install path (command lines may contain private data).
   After checking each PID belongs to this operation, use `taskkill /F /T /PID <pid>` if needed;
   repeat the process listing and confirm all those processes exited. Windows has no pgid probe for
   this marker. Then run
   `Remove-Item -LiteralPath "$env:USERPROFILE\haive_desktop\.haive-extension-unconfirmed"`.
5. Refresh Status and resume recovery of any interrupted install/upgrade before retrying normal work.
   Deleting the marker acknowledges the inspection; it neither stops processes nor undoes daemon work.

**Remaining Unix limit:** simultaneous SIGKILL of bridge and supervisor defeats the pipe watcher and
bridge-side group sweep on both macOS and Linux. On Linux Pdeathsig kills only the direct command;
grandchildren can survive. On macOS the whole command can survive. A kill before the pgid report also
leaves the surviving bridge without a group identity to sweep. Leases then stop beating and may expire
while survivors still run. Inspect host processes, status/logs and the updater journal before retrying
an interrupted operation; existing conservative install/start recovery advice remains. OS supervision
also cannot undo work already accepted by the Docker daemon.

Linux real-process controls use fake sleeping payloads only: bridge death, supervisor-only death,
whole-group cancellation, a Pdeathsig-only backstop and lease renewal through blocked output draining.
The supervisor-death control failed before its fix (a grandchild survived and the lease was released);
removing Pdeathsig makes the independent backstop fail. Shared controls cover nonce admission, refusal
of unsupported fields, preserved exit/directory/environment, bounded waits, error mapping and heartbeat
transient/sustained/lost decisions. Windows controls spawn grandchildren, check their process handles
after cancellation and `TerminateProcess` of a helper bridge, and force a real Win32 assignment failure
through the production refusal branch. The macOS bridge-kill control uses `kill(pid, 0)` and `ps` to
observe both command and grandchild. Windows and macOS tests are compiled with `go test -c` and vetted
for amd64/arm64, but **were not executed** here. No real stacks or volumes were touched.

#### Must verify on real hosts before release

- **Windows 10/11 amd64, and arm64 if shipped, launched by Docker Desktop host exec:** verify job
  assignment under its enclosing job and Defender/EDR; Status, Install, Start and Stop; a genuine
  assignment refusal with its Win32 log and truthful UI cause while read-only probes remain usable.
  Run native `TestWindows*`, shared `TestSupervisor*` and lease controls. During Start, test
  `taskkill /F` on the bridge and `taskkill /F /IM haive-desktop.exe`; confirm supervisor, docker.exe
  and Compose plugin exit within seconds and the lease stops beating. Check cancel/timeout reaches
  zero job members and terminating an empty job succeeds. Exercise installer profile paths with spaces,
  console-window behavior and Defender latency. With updater polling over the shared lock file, check
  a transient sharing violation is tolerated, sustained errors cancel at 30 s and proven loss cancels
  at once. Confirm buffered host exec supplies no supervisor admission stdin.
- **macOS arm64 and amd64:** run native tests, including bridge-kill and cancel controls; kill the
  bridge during Start and confirm docker/Compose exit. Kill only the supervisor and check bridge-side
  group cleanup plus the uncertain-outcome refusal. Check `kill(-pgid, 0)` stops seeing the killed
  group promptly after launchd reaping; validate timeout/manual recovery behavior. Verify Gatekeeper
  and quarantine permit re-exec, and Docker credential helpers work in a background process group.
  Treat simultaneous bridge/supervisor SIGKILL as the remaining limit, not a supported recovery path.
- **Linux Docker Desktop:** determine whether window close/host-exec timeout kills just the bridge,
  its process group or its whole tree (the watcher must survive). Confirm the distinct supervisor name,
  supervisor-only cleanup, subreaper-denied warning/degradation, and real Compose Start/Stop. Check
  descendants/background jobs and credential helpers under supervision. Native Desktop/Compose and
  cross-VM lock-file coherence remain unmeasured by container tests.

### Build and validation

Run `bash scripts/build-desktop-extension.sh`. It creates a scratch context with an
explicit file allowlist, embeds the unchanged installers, runs the Go tests, bundles
the pinned JavaScript SDK, and loads a dual-architecture image as
`haive-desktop-extension:dev` and `haive-desktop-extension:0.0.0-dev`. Local multiarch
load requires Docker's containerd image store; the script never changes Desktop
settings. It never starts Haive, installs the extension or pushes any image.

Both builder stages retain their tags and pin the multi-platform index digest resolved
on 2026-11-17 by `docker buildx imagetools inspect node:26-alpine` and
`docker buildx imagetools inspect golang:1.25-alpine`:

- Node: `sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5`.
- Go: `sha256:1ae0735f00daffa3aaf1363a5184c0d2dc55c78e3db4ec70241cdac97bf84b59`.

Dependabot covers the Dockerfile and the UI's independent npm lockfile in separate
Docker/npm update entries, with the existing minor/patch grouping policy.

`docker extension validate docker/desktop-extension/metadata.json` passes. The full
image validator in CLI v0.2.32 additionally applies Marketplace semver and remote
multiplatform checks. The literal dev tag fails semver. The identical 0.0.0-dev alias
passes labels, metadata, semver and SDK compatibility but reports its DockerHub
multiplatform failure even though both local platforms are present. No full-image
validation pass is claimed. `--sdk-compatibility` adds a check and does not disable
publication checks; the CLI has no skip-marketplace flag. See the current
[validation manual](https://docs.docker.com/extensions/extensions-sdk/extensions/validate/).
This gate remains unresolved under the no-push constraint. Do not install a different
CLI, falsify its result or publish to work around it during local development.

Unit controls live in `scripts/test/desktop-extension.test.mjs` (UI, part of
`pnpm test:scripts`) and `docker/desktop-extension/bridge/main_test.go` (installer
byte preservation/delegation, version syntax/pins, bundle/overlay resolution, identity,
consent, concurrency, recovery advice, stop without resolution and legacy-resource refusal).
The delegation test proves bytes are preserved from the embed; the build script's
allowlisted copy supplies the checkout-to-embed identity. A real child-process test
checks that ambient Haive, Compose and secret variables are filtered case-insensitively,
while PATH, Docker context and ordinary variables survive. Health-gating tests pin
literal probe and readiness expectations, including API-only and web-only cases.
Polling and failure regressions cover failed-operation status recovery, recomputed controls,
5s/30s polling with fake timers, reads during Start, hidden/disposed tabs, overlapping
read prevention and stale reply fencing. Go cases cover web/API published-port
clashes, own-project exclusion, unlabelled apps, IPv4/IPv6, exposed-only and UDP
ports, failed/malformed listings, Stop bypass and late allocation/generic mapping.
Port and service controls cover port re-picking from both host and Docker conflicts, sibling
port reservation, own-project exemptions, late-service exhaustion without writes,
65535 and 50-try bounds, byte-preserving LF/CRLF updates and file modes, final
port assignments without a newline, bounded rename success/exhaustion, concurrent
edits and temp cleanup, batched container inspections, IPv6 family failures, and refused
linked/duplicate/missing assignments, status field filtering and missing-service rows.
A real local listener and local HTTP redirect fixture exercise the actual bind/probe
seams; the remaining cases mock I/O. UI tests cover the service control matrix,
consent reload/uncheck/viewer separation/storage failures/fresh install, labelled
probes, restarting/paused Stop controls, move notices surviving polls, bounded fast
polling after Start/Install, expired readiness wording for either negative running
probe, and error-cadence backoff. Upgrade controls cover refusal of all three
mutations for this install's updater, unchanged behavior for other installs/stopped
updaters, failed/malformed Docker reads, one complete retry with fresh IDs, safe
one-element entrypoints even with eager template evaluation, batched boolean
projection without secrets, hung-updater recovery advice, and a new updater observed
on the final pre-mutation check. Go tests run in a throwaway
golang container with copied install/ files, and again inside the extension build
with two scheduler threads and one package worker; no host Go dependency is needed. Native macOS/Windows execution and live stack behavior
have not been measured by the local mocked-UI and unit checks.

Measured 2026-11-17 on Docker Desktop 4.98.0 (245422), with its WSL-integrated Compose
v5.6.1:
a separate two-service fixture using `restart: 'no'` and
`depends_on: { db-migrate: { condition: service_completed_successfully } }` returned
exit 0 from `up -d --no-build --wait --wait-timeout 20`. The one-shot was exited with
code 0 and the dependent service healthy. The fixture had no mounts, volumes or
published ports, and both self-named containers were removed with `docker rm -fv`.
This checks Compose's one-shot treatment, not Haive's actual first boot; repeat the
live first-start check below on the owner's native Desktop version.

### Owner-session acceptance and rollback

1. Confirm this id, its host directory and its volumes are unused. Keep every other
   stack running unchanged. Build the image; record the validation limitation above.
2. From the Desktop host, run `docker extension install haive-desktop-extension:dev`.
   Do not use the validator's install/uninstall flag. If Desktop policy disallows
   unpublished extensions, stop and let the owner decide; do not change settings.
3. In Haive's tab, verify install/start are disabled until the socket/home-mount disclosure is
   accepted. Select a current public release and Install. Confirm an exact pinned
   version and an isolated install directory without copying secret values.
4. With another project publishing a configured web/API/Mailpit port, Start must
   choose the next free port and display the move, leaving the other project alone.
   Repeat with a native host listener. Compare `.env` privately: only conflicted port
   values may change. Own-project running ports must not move. If all 50 candidates
   are occupied, Start must refuse without changing `.env` or running Compose up.
   Watch five-second service progress, including running API/web with negative probes,
   and thirty-second polling after five minutes or three consecutive read failures.
   After the fast window expires, a continued negative API/web probe must read
   `Still not ready (N/M)`, with the ready count preserved.
   Confirm the summary is announced once. Hide/show the tab and confirm polling
   suspends/resumes. A late allocation race retains its reason
   and a Created service's status. Stop stays enabled for running, restarting and paused
   services, and is disabled when none are live; Start is disabled only once all
   services are ready; Open app follows the web probe. Reload
   an installed tab and verify consent stays ticked; uncheck and reload to verify it
   stays unticked. A fresh install must require a new tick. API/web health rows must
   identify the extension probes, with web redirects shown as reachable. On Windows,
   check rename retries under concurrent status reads and antivirus scanning; a refused
   rename must preserve the original file and leave no temporary .env copy. With the
   Mailpit port line absent, status and Stop must still work; Start uses default 8025.
5. Start. Check db-migrate succeeded and the services are running; watch for a false
   "Compose failed" after its exit-0 one-shot on the owner's Desktop/Compose version. Open app; create
   the first administrator through the existing setup page, then verify a later
   visit uses login. Exercise API and worker log links.
6. During an in-app upgrade for this install, try Start and Stop: both must refuse
   with the upgrade message and leave services alone, including while the updater
   archives PostgreSQL. A direct Install request must also refuse before delegation.
   Kill a running updater container of a release that includes the install stack lock:
   Start and Stop must wait about a minute, until its lock is judged abandoned, then
   work. While Start is in flight, an upgrade of this install must refuse with
   `install-locked` instead of snapshotting.
   A Docker inspection failure that persists after one retry must refuse these
   actions, while another install's updater must not block this one. After the updater finishes, Stop; verify this
   project's services stop and its volumes survive. Start again and verify the
   account/data persist. Check other installs remain unchanged.
7. Stop, then `docker extension rm haive-desktop-extension:dev`. Verify the extension
   disappears while the directory and volumes remain. Reinstalling the extension
   must reattach to this same install rather than reinstall it.

Rollback of this code is a git revert, with no database migration. Reverting command supervision restores
its previous orphan-child risk: finish or terminate active host operations before replacing the bridge,
and inspect status/logs and the updater journal before retrying an interrupted operation. The
`.haive-extension-unconfirmed` marker is inert for older code; resolve its command using the OS-specific
manual steps above before reverting, then remove only that marker. A leftover
`.haive-stack-lock` in an install directory is inert for the previous code; delete it
only when no updater container and no extension operation is running. Port values
selected by Start remain in the install's `.env` after rollback; retain those valid
values, or privately restore only the three port lines while stopped after checking
availability. Never replace the file with newly generated secrets. Viewer consent
storage may be cleared independently; no application data depends on it. For a live trial,
stop and remove the extension first; preserve its data and `.env`. Remove the Haive
trial only through its generated uninstall script after separately deciding which
data to discard. Local extension image tags may be removed afterward; do not remove
Haive service images or unrelated Docker resources. Roll back a Haive upgrade through
the existing updater rather than changing version pins by hand.
