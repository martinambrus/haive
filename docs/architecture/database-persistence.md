# Project database persistence

Workflow and run-app tasks can continue from a saved DDEV primary database. New Task shows the
current snapshot beside the database attachment, with its source task and timestamp. Restoring
is opt-in; saving is enabled by default and can be disabled. A manual database attachment and a
saved database are mutually exclusive. This persists the database only: uploaded assets, other
services and their volumes are not included.

## Storage and task selection

Postgres owns the inventory (`database_snapshots`), repository pointer and monotonic revision
(`repository_database_states`), and each task's pinned source, baseline revision and save decision
(`task_database_states`). Dumps live under
`REPO_STORAGE_ROOT/_database_snapshots/<user>/<repository>/<snapshot>.sql.gz`, outside repository
checkouts, worktrees, Git and ordinary task attachments. No `.gitignore` modification is needed.

Task creation pins the exact selected snapshot and records the current project revision before
enqueueing START. Selection verifies ownership, readiness and that the snapshot is still current;
a stale form returns 409, requiring a fresh selection. A queued task keeps its pinned source even
when another task replaces the project pointer. Internal and older tasks initialise their save
state lazily. No restore is implied by lazy initialisation.

The DDEV runner mounts only the selected dump read-only. `01c-ddev-env` verifies its size and
SHA-256 and checks the effective database engine before import. A successful import records
`imported_at` under step/task ownership fencing; retrying cached detect data must not re-import
over subsequent work. The existing task-local DDEV durability snapshot supports cold runtime
recovery. A saved project dump is never consumed or deleted as though it were an uploaded dump.

## Saving and concurrent tasks

`11g-save-database` runs after workflow push approval and before worktree cleanup. It also runs
after the user finishes a run-app session, before completion tears down the runtime. It skips
non-DDEV workspaces, projects with an omitted database, and confidently empty databases.

`exportDdevDatabase` streams binary stdout directly from `ddev export-db --gzip` to a held file
descriptor. It validates the entire gzip stream with bounded memory, records compressed size and
SHA-256, fsyncs, then renames a `.partial` file to the immutable dump. Inventory is reserved before
writing bytes, so interrupted exports remain discoverable. Export participates in the runner's
lifecycle flock. Saving never cold-boots a runtime: an unavailable runtime opens a Retry/finish
without saving form, avoiding export of an older recovery database.

Short metadata operations take a repository advisory transaction lock. Publishing also locks the
owned step before checking the task epoch, matching Retry/Stop ordering. The pointer advances only
if its revision still equals the task's baseline. A conflict opens a normal step form showing the
task that last saved and the save timestamp. Keeping the current database is the default and
deletes this task's candidate. Replacing selects the whole candidate database; databases are not
merged. Approval carries the revision shown in the form, so a further save while it is open asks
again instead of overwriting an unseen version. Duplicate delivery in the same epoch preserves
the decision; an upstream retry in a new epoch permits a fresh export.

## Cleanup

A snapshot is retained only while it is the current project snapshot, a source pinned by a task
that can still use it, or a pending candidate of such a task. Completed/cancelled tasks release
their pins. Failed tasks keep their pins for Retry. Skipping the exact save step that created a
candidate releases it too; a skipped step from another workflow round must not release it.

Discard immediately runs cleanup. Publication runs cleanup for superseded dumps. A bounded sweep
also runs at worker startup and every minute, covering cancellation, task/repository deletion and
crashes. It marks eligible inventory `deleting` under the same lock as selection/publication,
removes both final and partial files through `fs-safe`, then deletes inventory. A failed removal
keeps its inventory for another sweep. Inventory deliberately survives repository/user deletion,
so cascading metadata deletion cannot orphan files. Provenance is metadata, not a retention pin;
there is no snapshot history accumulating after users decline replacement.

The exporter opens its partial file under the metadata lock after verifying step/task ownership
and inventory. It then writes through that held descriptor outside the transaction. Cleanup may
unlink a superseded export's file, but the exporter cannot create a new path after its inventory
was removed. This permits immediate cleanup of abandoned writing rows without a retention grace.

## Validation

`test/database-snapshots.test.ts` uses a dedicated migrated Postgres database whose name starts
with `snapshot_test`. Set `DATABASE_SNAPSHOT_TEST_URL` to run it; CI creates its own database.
It covers competing saves, stale approvals, queued source pins, rejected ownership/selection,
cancellation/reset fencing, import idempotency, engine/checksum rejection and file cleanup after
discard, skip and repository deletion. Export tests cover binary streaming, invalid gzip, empty
output, failed commands and symlink refusal. Form tests verify explicit conflict choices and
ordering before teardown.
