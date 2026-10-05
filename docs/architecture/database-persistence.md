# Project database persistence

Workflow and run-app tasks can continue from a saved DDEV primary database. After DDEV startup,
`01c1-restore-database` shows the saved checkpoint with its source task and timestamp and waits
for an explicit Restore or Continue without restoring choice, including in automatic mode.
Saving is an explicit choice at the end of each task. An uploaded database dump takes precedence
over the saved checkpoint; without either source, restoration is skipped. This persists the database only: uploaded assets, other
services and their volumes are not included.

## Storage and task selection

Postgres owns the inventory (`database_snapshots`), repository pointer and monotonic revision
(`repository_database_states`), and each task's pinned source, baseline revision and save decision
(`task_database_states`). Dumps live under
`REPO_STORAGE_ROOT/_database_snapshots/<user>/<repository>/<snapshot>.sql.gz`, outside repository
checkouts, worktrees, Git and ordinary task attachments. No `.gitignore` modification is needed.

Task creation records the current project revision before enqueueing START. The restore step
checks availability when it runs, so a checkpoint saved after task creation can still be offered.
Detect pins the offered ready, owned checkpoint under the repository lock before rendering the
form. Another task can replace the project pointer without deleting the version awaiting a
choice. Continuing without restoring releases that pin and immediately sweeps superseded dumps.
Older API clients can still select an exact checkpoint at creation; stale selections return 409.
Internal and older tasks initialise their save state lazily. Initialisation never implies restore.

`01c1-restore-database` runs immediately after `01c-ddev-env` starts DDEV. It verifies the dump’s
size and SHA-256 and checks the effective database engine before import. A saved dump is streamed
from a held file descriptor through `docker exec -i` into the existing runner, with gzip validation
via pipefail. No container recreation, additional mount or temporary dump copy is needed. Uploaded
dumps keep their existing read-only mount. A successful saved import records `imported_at` and
sets the save baseline to the offered revision under step/task ownership fencing; retrying cached
detect data must not re-import over subsequent work. The existing task-local DDEV durability
snapshot supports cold runtime recovery. A saved project dump is never consumed or deleted as
though it were an uploaded dump. Even a consumed upload suppresses fallback to a saved checkpoint.

## Saving and concurrent tasks

`11g-save-database` runs after workflow push approval and before worktree cleanup. It also runs
after the user finishes a run-app session, before completion tears down the runtime. It skips
non-DDEV workspaces. Choosing save for an omitted or confidently empty database records that no
snapshot was saved.

`exportDdevDatabase` streams binary stdout directly from `ddev export-db --gzip` to a held file
descriptor. It validates the entire gzip stream with bounded memory, records compressed size and
SHA-256, fsyncs, then renames a `.partial` file to the immutable dump. Inventory is reserved before
writing bytes, so interrupted exports remain discoverable. Export participates in the runner's
lifecycle flock. Saving never cold-boots a runtime: an unavailable runtime opens a retry/finish
without saving form, avoiding export of an older recovery database.

Short metadata operations take a repository advisory transaction lock. Publishing also locks the
owned step before checking the task epoch, matching Retry/Stop ordering. The pointer advances only
if its revision still equals the revision explicitly approved by the user. Every pending DDEV
save opens a normal step form, even when no other task saved meanwhile. Step metadata
`alwaysWaitForUser` disables every automatic submission path, including pre-answers. The New Task
form has no save setting, and historical `save_enabled = false` rows do not bypass this choice.
Users choose **Save database for the next task** or **Finish without saving** before any export.
If the project revision moved since task creation or the approved restore, the form instead offers **Save and overwrite**,
showing the task that last saved and its timestamp. Declining deletes any candidate from a prior
attempt. Overwriting selects the whole database; databases are not merged.

Approval carries the revision shown in the form. A further save while it is open asks again
before exporting, and a change during export reopens the form with the newest revision. Duplicate
delivery in the same epoch preserves the decision; an upstream retry in a new epoch permits a
fresh export. Restoration is a separate step for both saved snapshots and uploaded dumps, before
migrations. It shares startup’s DDEV eligibility check: an upload alone cannot start DDEV in a
non-DDEV workflow. An explicitly selected saved database reports missing DDEV eligibility rather
than continuing without the requested restore. Already imported saved snapshots and consumed
uploads are skipped on retry.

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
output, failed commands and symlink refusal. Form and step-runner tests verify explicit save/restore choices, automatic-mode pauses and
ordering before teardown. Restore tests cover checkpoints saved after task creation, offered pins
across competing saves, declining cleanup, uploaded-dump precedence and streaming into a running
runner without staging files.
