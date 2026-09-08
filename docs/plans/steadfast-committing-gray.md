# steadfast-committing-gray — Core upgrade: release, transactional apply, maintenance mode

> **PROPOSED, 2026-09-07. Slice 1 SHIPPED 2026-09-08; Slices 2-5 not started.** The migration
> runner, the frozen baseline, the adoption classifier and the `data-migrations.ts` split are in the
> tree and are the applier everywhere. Still absent: `git tag` returns zero tags,
> `.github/workflows/ci.yml` publishes no images, `docker-compose.yml` gives api/worker/web no
> `image:` tag, and there is no maintenance mode, no updater and no version stamp.
>
> Owns the follow-up `frictionless-bootstrapping-otter` named and deferred — "Auto-update of a
> running install ... the pinned-tag compose bundle makes `haive upgrade` a later, well-defined
> step, but it is not this plan." That plan owns the FIRST install; this one owns every install
> after it. Its RUN-IT prerequisites (published images, compose `run` overlay) are shared, so
> whichever ships first builds them.

## Context

Haive has no way to upgrade an install it does not own. The onboarding-upgrade machinery
(`template-manifest.ts`, `onboarding_artifacts.haive_version`, plan/apply/rollback with stored
bytes) upgrades a customer's REPOSITORY artifacts well, and is the model to copy — but nothing
upgrades Haive itself. Measured on the tree, 2026-09-07:

| Gap | Evidence |
|---|---|
| No published images | `ci.yml` has three jobs — `lint-typecheck-test:27`, `smokes:62`, `compose-boot:134`. Zero occurrences of `publish`, `ghcr`, `registry`, `build-push`. |
| No image tags to swap | `docker-compose.yml:74,116,168` — api/worker/web are `build:` contexts only. `docker compose pull` has no target; no `docker-compose.run.yml` exists. |
| No real version | `packages/shared/src/constants/index.ts:4` hardcodes `APP_VERSION = '0.1.0'`; all five package.json files say the same. `getHaiveVersion()` (`:12`) prefers a `HAIVE_VERSION` env whose comment says "CI release builds stamp this" — no job stamps it. `/health` (`api/src/index.ts:59`) returns `{status, service}` with no version. |
| Schema applier is `push --force` | `docker-compose.dev.yml:62` and `ci.yml:122`: `pnpm --filter @haive/database push --force`. It synchronises the live DB to the schema barrel and will DROP a column removed from `packages/database/src/schema/`. **As built (Slice 1):** fixed — the runner is the applier at both sites; `push` survives only as the interactive dev escape hatch. |
| The SQL files are not wired | 151 hand-written guarded migrations exist in `packages/database/src/migrations/`, but there is no `meta/_journal.json`, so the `migrate` script (`packages/database/package.json:24`) cannot run them. AGENTS.md calls them "a parity record". **As built (Slice 1):** they never became the input — there is no genesis migration and 19 are unsafe to replay, so they moved to `migrations/pre-baseline/` and a generated `0000_baseline.sql` is the genesis. See Slice 1. |
| Migrator needs a source tree | the `db-migrate` service runs `pnpm install` into the bind-mounted repo. A published-image install has no source tree. **As built (Slice 1):** the runner ships in the api and worker images and was verified building a database from inside one; the dev `db-migrate` service still installs, which is a dev-path cost only. |
| No maintenance mode | `CONFIG_KEYS.GLOBAL_PAUSE` (`config.service.ts:95`, gate at `orchestrator/pause.ts:28`, read at `routes/system.ts:16`) is a queue hold plus a banner. It does not refuse task creation, does not 503, and does not stop anyone using the app. The four 503s in `api/src/routes/` are IDE start, VNC start and GitHub-OAuth-unconfigured. |

## The migration corpus is already transaction-clean

This is the measurement the whole design rests on, so it is stated before the design. Across all
151 files in `packages/database/src/migrations/`, on Postgres 18 (transactional DDL):

- `CREATE INDEX CONCURRENTLY`: **zero**. The single grep hit is a comment at
  `0147_stats_and_retention_indexes.sql:29` stating it is used nowhere in this repo.
- `CREATE DATABASE`: zero.
- `BEGIN` / `COMMIT` inside a file: zero — the runner owns the transaction, no file fights it.
- `ALTER TYPE ... ADD VALUE`: 15 files, and **none uses the new value later in the same file**.
  (`0126_ollama_price_feed.sql:57` looks like a counterexample and is not: the `'ollama'` on line 61
  is the `provider` column, a different enum, not the `price_feed` value just added.)

So every migration in the tree today can run inside a single transaction. The atomic half of a
transactional upgrade is available now, not aspirational.

Two classes stay outside any transaction and must never be assumed covered: `ensureRagSchema` issues
DDL against per-repo RAG stores (internal/external/ddev), and a module's `./ensure-schema`
(`serialized-chasing-thacker`) owns a separate database. Both are convergent-on-boot by design and
are not part of the core migration path.

## Release model — the tag is the version

Main is the working branch and stays that way: 39 commits landed on 2026-09-07 alone, against a
single branch plus dependabot, and the project rule is to commit straight to main. Making
merge-to-main the release trigger would mean either 39 releases a day or a second long-lived branch
— so the release event is a **tag**, not a merge.

- `git tag v0.2.0 && git push --tags` is the whole release. Every other push to main is CI-gated and
  publishes nothing, so a broken commit on main is invisible to users.
- The tag IS the version. No version-bump commit, and no drift across five package.json files. CI
  reads `github.ref_name` into a `HAIVE_VERSION` build arg, which becomes an env var in the image;
  `getHaiveVersion()` already prefers it.
- `APP_VERSION` becomes `0.0.0-dev`. An unstamped build must never report a release version — a
  version string is what the upgrader compares against, so a dev build claiming `0.1.0` is a
  wrong answer, not a cosmetic one.
- Each tag publishes a **release manifest**: version, image digests, `minFrom` (the lowest version
  that may upgrade directly to it), and the migration head. `haive upgrade` reads it and refuses an
  illegal jump rather than discovering the problem mid-migration.
- The manifest is per **channel**, because a module customer does not run the public images.
  `serialized-chasing-thacker` decided (2026-09-07) that a published-image install with modules gets
  per-customer api+worker images built by the vendor and DERIVED from a base release; web stays the
  stock public image, since nav and pages are runtime-fetched. So an install reads the manifest for
  ITS channel — public for a module-free install, per-customer otherwise — and never the public one
  by default, or a module customer would upgrade themselves out of their modules. `minFrom` and the
  migration head come from the base release either way, so only the digests differ and no second
  migration story is created.
- An install carrying the user's OWN modules builds api+worker locally from a `haive-builder` image
  (same plan, "A user's OWN module must not require DEV-IT"), so its running images have local tags
  with no digest in any manifest. **Phase 0 gains a build for those installs**: pull the new base
  and the matching builder, rebuild locally, and only then proceed — an install still running images
  built against the PREVIOUS base is precisely the half-upgraded state this plan exists to prevent.
  A build that fails there aborts with nothing stopped, exactly like a failed pull, which is why it
  belongs in Phase 0 and not later.
- `v0.2.0-rc.1` publishes to a `next` channel. Not optional: the only way to test an upgrade
  mechanism is to perform an upgrade, and that cannot be rehearsed on users.
- `release/0.2.x` maintenance branches are NOT created now. They are the answer to "patch an old
  version while main moves on", a problem that does not exist yet.

## Distribution — image-tag swap

The upgrade unit is a published image tag, not source. `haive upgrade` re-pins the tag in `.env`
and runs `docker compose pull && up -d`; rollback re-pins the previous tag. Two alternatives were
considered and rejected:

- **git pull + build** (the Hermes model). Requires source, toolchain and a build on the customer
  machine — that is DEV-IT with extra failure modes, and it is the model
  `serialized-chasing-thacker` already rejected for closed-source distribution.
- **npm-distributed core.** Haive is six containers plus Postgres, Redis and Ollama, not one
  process. `frictionless-bootstrapping-otter` is explicit about that asymmetry with dsh.

## Transactional upgrade

**Container swap and Postgres commit are two systems, and no transaction spans them.** Pretending
otherwise is where this design would go wrong. The property wanted — never a half-working Haive on
the system — is bought by three mechanisms instead of one:

1. **Atomic per migration.** One transaction per file, with the `schema_migrations` insert INSIDE
   that transaction. File N fails, file N never happened.
2. **Instant image rollback.** The previous image is still on disk; rollback is a tag re-pin.
3. **Expand/contract, so 1 and 2 never need coordinating.** An additive-only migration leaves the
   schema valid for BOTH versions, so rolling containers back requires no schema rollback at all.
   This is what makes the two-system problem disappear rather than get solved.

Batch atomicity comes from (3) plus a snapshot, NOT from one transaction wrapping every pending
file. A mega-transaction is worse on two counts: a single failure costs the whole batch on retry,
and it breaks the moment a migration adds an enum value in one file and uses it in a later one —
which is legal today only because each file is applied and committed separately.

### The additive-first rule

A column is added in migration N and dropped no earlier than N+2. Stated as a rule rather than a
hope because it is the precondition for mechanism 3: the moment a release contracts the schema, a
container rollback stops being free and needs the snapshot. Contract-phase migrations are allowed,
but a release containing one is flagged in its manifest so `haive upgrade` knows the snapshot is
load-bearing for that upgrade and not merely insurance.

### Migration runner contract

- Applies pending `.sql` in filename order, one transaction each, recording `(id, checksum,
  applied_at)` in `schema_migrations` in the same transaction.
- A file whose recorded checksum no longer matches its bytes is a HARD FAILURE, not a re-apply.
  An edited applied migration means two installs have different schemas under one version number.
- A per-file `-- haive:no-transaction` escape exists, and a file that needs it without declaring it
  FAILS LOUD. Zero files need it today; the enum-add-and-use case will appear eventually, and a
  runner that silently splits a transaction is precisely how the half-applied migration this design
  exists to prevent gets created.
- `drizzle-kit push --force` stays, for DEV-IT only. It never runs against an install we do not own.

### The one-way door: `runDataMigrations`

`packages/worker/src/data-migrations.ts:18` runs on EVERY worker boot — which in the sequence below
is the verification phase, before the upgrade is committed. It is not all read-only:
`dropHeadingOnlyGlobalKbChunks` (`:296`) issues a raw `DELETE FROM ai_rag_embeddings` (`:307`)
against the global KB store on a separate connection via `withGlobalKb`. That is outside the core
DB's transaction and outside a core-DB snapshot. A rollback at the verification gate would restore
the old images onto data the new version had already destroyed.

The file splits in two, structurally and not by comment, since entries are added routinely:

- **convergent** — idempotent and non-destructive, the current majority. Safe at boot, unchanged.
- **destructive** — runs only after the upgrade is committed, or behind an explicit flag.

A new entry must declare which it is; there is no default.

### Sequence

Prose, because the order is the mechanism.

**Phase 0 — pre-flight, nothing touched.** Pull the target images and the updater image; verify
digests against the release manifest; check `minFrom`; confirm the CURRENT images are still present
locally (`docker image prune` is a documented hazard in this project — AGENTS.md already records it
breaking the sandbox image — and an upgrade that cannot roll back is not an upgrade); check disk for
the snapshot; acquire the upgrade lock. *Rollback: nothing to roll back.*

**Phase 1 — maintenance.** Enter `draining`, then `maintenance` (below). *Rollback: return to
`normal`.*

**Phase 2 — snapshot.** Stop postgres, copy the volume. The escape hatch for contract-phase
migrations, which is exactly why it must exist even though expand/contract usually makes it
unnecessary. *Rollback: restore the volume.*

**Phase 3 — migrate.** Run the migration runner. A failure at file N rolls N back atomically; files
1..N-1 are committed but additive, so the OLD version still runs against them. Abort, re-pin the old
tag, leave maintenance. *No restore needed.*

**Phase 4 — boot the new containers, queues still held.** Gate on more than `/health`, which today
returns `{status, service}` and would pass on a badly broken build: a `/version` asserting running
== target, plus a DB round-trip smoke. Failure: re-pin the old tag, boot, leave maintenance. The
schema stays — additive means the old code ignores the new columns. *This is the phase mechanism 3
exists for.*

**Phase 5 — commit.** Run the destructive data migrations, release the queue hold, leave
maintenance, write the new pin. Only now has the upgrade been taken.

## Maintenance mode

`GLOBAL_PAUSE` is a queue hold and a banner, not a maintenance mode, so this is net-new. Three
states:

- **`draining`** — banner to every user, new task creation refused with a named reason, in-flight
  work continues. The admin sees the blocking set.
- **`maintenance`** — non-admin requests get 503 and a maintenance page; admin and updater endpoints
  stay live.
- **`normal`**.

### Admin task control — net-new, and it belongs here

`POST /tasks/:id/action` (`api/src/routes/tasks/index.ts:1111`) resolves its task with
`and(eq(tasks.id, id), eq(tasks.userId, userId))`; `POST /tasks/:id/cancel-active-cli` (`:1305`) and
the task listing (`:141`) have the same shape. Roles are `admin | user`
(`database/src/schema/auth.ts:20`) and tasks are per-user, so **an admin acting on — or even
listing — another user's task gets nothing today.** Haive has never had cross-user task control, and
nothing else plans it. It lands here because a drain is the first thing that needs it: an admin who
cannot see or stop other people's work cannot run a maintenance window on a multi-user install.

Precise about the primitives, because the names differ from the plans that discuss them: the task
actions are `cancel | retry | pause | resume | start`
(`packages/shared/src/schemas/tasks.ts:252`). There is **no `stop` action** — what
`serialized-chasing-thacker` calls STOP is the separate `cancel-active-cli` endpoint,
kill-the-CLI-keep-the-environment. That is the force-stop this plan wants; `cancel` is destructive
by comparison and is not it.

**Reads and writes take different routes, deliberately.**

- **Read (the blocking set) rides the existing `allUsers` convention**, not a new endpoint. The
  stats query parser already carries an `allUsers` flag (`api/src/routes/stats/_query.ts:32,42,111`)
  that **each route re-checks against the caller's role**, because the parser has no access to it.
  The task listing takes the same flag with the same per-route re-check. One convention for
  cross-user reads, already established and already documented in AGENTS.md.
- **Write goes to a separate admin-scoped route**, never to a predicate relaxed in place. Widening
  `eq(tasks.userId, userId)` on the existing handler would silently broaden every read and write
  sharing that path, turning any future role-check slip into cross-tenant access; a distinct route
  behind `requireAdmin` is explicit and greppable. This is also the reasoning `routes/system.ts:6-11`
  already writes down for `GLOBAL_PAUSE` — everyone may READ the system state, flipping it stays on
  the admin route.

**Scope is pause / resume / cancel-active-cli. NOT `cancel`.** A drain never needs to destroy
someone's task — it needs the CLI stopped and the task held — and adding a destructive cross-user
action for a use case that does not require one is scope creep with a permanent blast radius.

**Two logs, because they have two audiences.** Every admin write appends BOTH:

- an `audit_events` row (`database/src/schema/audit.ts`) — the append-only, FK-free trail whose
  docstring already names "admin user actions" as its purpose. Actions namespaced
  `task.admin_pause` / `task.admin_stop_cli`, `targetType: 'task'`, the maintenance window id in
  `metadata`. No new table.
- an ordinary task event via `appendTaskEvent`, naming the admin — so the OWNER opening their task
  sees who paused it and why, rather than finding it mysteriously stopped. An audit row they cannot
  read does not answer that question.

### Drain policy

A workflow task runs for hours and this is a multi-user system, so an unbounded wait is how
maintenance windows get skipped:

- A deadline with a declared fallback (`drain, wait 30m, then force`), chosen by the admin at the
  point of upgrade, never implicit.
- The blocking list names **owner, task and current step**, so the admin asks a person instead of
  guessing.
- Force-stop must cost a resume, not the work. The project ships worker-restart orphan recovery and
  fan-out Resume (`splendid-foraging-lynx`, `d4fedf0` / `7ed0378`) — but that was built for a worker
  RESTART, not an image SWAP, so it is verified against this path (verification 7) rather than
  assumed.

Reuse, not reinvention: `serialized-chasing-thacker`'s module lifecycle already designed this exact
choice at module scope — a preflight lists the dependent running tasks and forces the operator to
pick **urgent** (stop now) or **graceful** (pause, drain, then act). Same decision, system scope,
one implementation and two callers.

## The updater

A running Haive cannot upgrade itself: api, worker and web are the things being replaced, and a
process cannot `compose up -d` itself out of existence and survive to verify the result or roll it
back. So the swap runs in a container that outlives it.

**Ephemeral one-shot, NOT a long-lived sidecar.** A permanent updater would hold
`/var/run/docker.sock`, which this project already documents as host-root-equivalent; adding a
second permanently-running root-equivalent container for a job that runs monthly doubles that
surface for nothing. The one-shot shape already exists in the repo — `db-migrate` and `dev-libs` are
exactly this, gated on via `service_completed_successfully`.

- Its own pinned image `haive-updater:<target>`, pulled and verified in Phase 0, before anything
  stops. Cannot pull it, abort with zero impact.
- Mounts docker.sock and the install dir. Holds BOTH tags, so it can roll forward or back.
- Not a member of the api/worker/web set, so it is never replaced mid-swap.
- Writes phase-by-phase progress to Postgres, which stays up throughout, so the new web renders live
  upgrade status and the maintenance page reads the same rows. No separate channel.
- **Two entry points into the same container.** The admin UI (the worker spawns it detached, then
  dies as part of the upgrade) and a host-side `haive upgrade`, sibling of the one-line installer.
  The CLI path is not optional: when the stack is down, nothing inside it can start the recovery.

### The updater's own death is the terminal case

If the updater dies mid-swap, nothing else is alive to fix it.

- A `pg_advisory_lock` gives single-writer and frees on connection death — necessary, and NOT
  sufficient: a freed lock lets a second updater start against a half-upgraded system.
- So it is paired with a journal row written BEFORE each phase, plus a heartbeat. Any updater that
  starts reads the journal and **resumes or reverses**; it never starts fresh. Every phase
  idempotent.
- The manual escape is printed on the maintenance page and written to a file on disk: the previous
  images are still present, so worst-case recovery is re-pinning the old tag and `compose up -d`.
  An upgrade path whose recovery is undocumented is one that gets recovered by guessing.

## Slices

Each is independently reviewable, and each states its undo first.

### Slice 1 — Migration runner + `data-migrations.ts` split — **SHIPPED**
*Rollback: delete the runner and restore the two `push --force` command strings.*

- `schema_migrations` table; runner applying `packages/database/migrations/*.sql` in order, one
  transaction per file, checksum-recorded, with the `-- haive:no-transaction` escape and its
  fail-loud guard.
- Split `runDataMigrations` into convergent (boot) and destructive (post-commit), with a declared
  kind per entry and no default.

**As built.** The original verification here was impossible and is corrected rather than left to
mislead: *"the runner applies all 151 files to an empty DB and produces a schema byte-identical to
`push --force`"*. Those files cannot build a database — **there is no genesis migration**. Nothing
in the corpus creates `users`, `tasks`, `repositories`, `cli_providers`, `task_steps` or
`cli_invocations`; only 17 tables are ever `CREATE TABLE`'d, and `0001` opens with `UPDATE tasks`.
Replaying them is also unsafe: 19 of the (now 152) files are not re-runnable, `0006` would delete
the live `grok` provider that `0116` re-added and narrow the enum back to five labels, and `0094`
declares its own `UPDATE` a one-time backfill.

So the runner starts from a **baseline squash**. `0000_baseline.sql` is generated by `drizzle-kit
export --sql` — structurally the same differ `push` uses, against the same empty prior state — and
the corpus moved to `migrations/pre-baseline/`, where nothing executes it. The proof is END-STATE
equivalence (`scripts/schema-parity.sh`, a CI job), not a byte comparison of files, because the
baseline legitimately falls behind the barrel as later migrations land. MEASURED: both paths produce
identical 3512-line dumps.

Existing databases are **adopted**, not replayed: a quorum over every table the baseline creates,
with `legacy` also checked for column drift. Only the extremes are safe verdicts — a partial schema
is what an interrupted `push` leaves behind and is refused outright.

Two things the plan did not anticipate, both now handled: `drizzle-kit export` swallows its own
errors and exits 0 with empty stdout, so the generator validates its output against the barrel's
table and enum counts; and PG18's `pg_dump` emits a fresh random `\restrict` token per dump, which
the parity filter must strip alongside the version banner.

Verified: 53 unit tests, a 28-check live-Postgres smoke, and the runner building a database from
inside the shipped api image with no source tree.

### Slice 2 — Version stamping + release manifest
*Rollback: revert the constant and the CI step; images simply stop carrying a version, as today.*

- `APP_VERSION` to `0.0.0-dev`; `HAIVE_VERSION` build arg threaded to env; `/version` endpoint on
  api and worker reporting the running version and the migration head.
- Release manifest schema + generator.
- Verify: a locally built image reports `0.0.0-dev`; one built with the arg reports the tag.

### Slice 3 — CI publish + compose run overlay
*Rollback: delete the release workflow and the overlay. Neither is referenced by the dev path.*

- Tag-triggered workflow building and pushing multi-arch `ghcr.io/<org>/haive-{api,worker,web}` and
  `haive-updater`, stamping `HAIVE_VERSION`, publishing the manifest, `next` channel for `-rc`.
- `docker-compose.run.yml`: `image:` at pinned tags instead of `build:`.
- Verify: a `v0.0.1-rc.1` tag publishes four images; the run overlay boots a stack from them with no
  source tree; `docker history` shows no baked secret.

### Slice 4 — Maintenance mode + admin task control
*Rollback: the middleware is a no-op when the state is `normal`; revert leaves `GLOBAL_PAUSE`
behaving exactly as it does now.*

- Maintenance state (`normal` / `draining` / `maintenance`), api middleware, web maintenance page,
  banner for `draining` reusing the existing `GET /system/pause` surface's shape.
- Cross-user task READ via an `allUsers` flag on the task listing, re-checked against the caller's
  role in the route (the `stats/_query.ts` convention); blocking-set view showing owner, task and
  current step.
- Admin-scoped WRITE routes behind `requireAdmin` for pause / resume / cancel-active-cli only, each
  writing an `audit_events` row and an owner-visible task event.
- Drain deadline with an explicit force fallback, chosen at the point of upgrade.
- Verify: a non-admin gets 503 under `maintenance` while an admin does not; an admin can list and
  force-stop another user's task and both logs are written; a non-admin passing `allUsers` still
  sees only their own; no admin route can `cancel` another user's task; a drained task resumes with
  its work intact.

### Slice 5 — Updater + `haive upgrade`
*Rollback: the updater is a separate image nothing else depends on; not invoking it leaves the stack
exactly as before.*

- Updater image, journal table, advisory lock, the six phases, resume-or-reverse on restart.
- Worker-spawn entry point and the host CLI entry point.
- Verify: the end-to-end matrix below.

## Verification

1. `v0.0.1-rc.1` to `v0.0.2-rc.1` upgrade completes and `/version` reports the new version on api
   and worker.
2. A migration that fails mid-file leaves that file unapplied, earlier files applied, and the OLD
   images running and serving.
3. A new image that fails its health gate rolls back to the previous tag with the schema left in
   place, and the app serves normally afterwards.
4. Killing the updater mid-Phase-3 and re-running it resumes from the journal rather than
   restarting, and reaches a consistent end state.
5. A second updater started while one holds the lock refuses, and names the running upgrade.
6. Under `maintenance`, a non-admin request gets 503 and the maintenance page; admin and updater
   endpoints answer.
7. A task force-stopped by the drain deadline resumes after the upgrade with its steps and forms
   intact — the specific check that orphan recovery covers an image swap and not only a worker
   restart.
8. An upgrade attempted from below `minFrom` refuses in Phase 0 with nothing changed.
9. `docker image prune` before an upgrade is detected in Phase 0 and refuses, rather than
   discovering the missing rollback target at Phase 4.
10. A destructive data migration does NOT run when the upgrade rolls back at Phase 4, and DOES run
    at Phase 5.
11. The whole DEV-IT path (`pnpm docker:dev`) is unchanged: `push --force`, no maintenance mode, no
    updater.

## Out of scope

- Zero-downtime upgrade. This is a single-machine self-hosted stack with one worker instance pinned
  by compose; a maintenance window is the honest model and a blue/green swap would need a second
  Postgres story.
- Downgrade across a contract-phase migration by any route other than the snapshot. A generated DOWN
  migration is a promise this project cannot keep, and the additive-first rule exists so the promise
  is rarely needed.
- Module upgrade. `serialized-chasing-thacker` owns it — bump the dependency version and rebuild.
  Its joint with published images is decided (per-customer images built by the vendor); what that
  costs THIS plan is one field, recorded under the release model, not a slice.
- Backing up per-repo RAG stores and module databases. The volume snapshot covers them only when the
  whole Postgres volume is copied; a dump-based snapshot would not, and the difference must be
  stated wherever the operator picks. `db_uploads` (`database/src/schema/db-dumps.ts`) is NOT
  reusable for this — it is a user's project dump uploaded into a task's ephemeral DB.

## Cross-plan

- `frictionless-bootstrapping-otter` shares Slice 3 exactly: published images plus the compose run
  overlay are its RUN-IT prerequisite and this plan's Phase 0 prerequisite. Whichever ships first
  builds them; neither should build them twice.
- `serialized-chasing-thacker` shares the urgent/graceful drain choice (Slice 4 generalises it from
  module scope to system scope), and its published-image joint with this plan is **decided**
  (2026-09-07): a module customer receives per-customer api+worker images built by the vendor, so
  the customer still performs no build. What that costs this plan is the per-customer channel in the
  release model above — one manifest axis, not a slice. That plan owns the decision and its
  alternatives.
