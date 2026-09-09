# steadfast-committing-gray — Core upgrade: release, transactional apply, maintenance mode

> **PROPOSED, 2026-09-07. Slices 1-5 SHIPPED 2026-09-08.** The migration runner, the frozen
> baseline, the adoption classifier and the `data-migrations.ts` split are the applier everywhere;
> tagging a release publishes six multi-arch images and a manifest; maintenance mode, admin task
> control, the updater and the version stamp are in the tree. An upgrade was exercised end to end
> against a published install, in both directions — see Slice 5's As-built. The `.env` key
> `HAIVE_INSTALL_DIR_HOST` is what an installer must write for the in-app trigger to be offered.
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

## Choosing what to upgrade TO

`install` and `upgrade` are separate verbs and must stay that way. The installer refuses a
non-empty install directory (`frictionless-bootstrapping-otter`) rather than quietly doing an
upgrade instead: re-running an install one-liner is not consent to migrate a database, and an
upgrade that skipped the drain, the snapshot and the health gate would be the silent unrequested
upgrade this whole plan exists to prevent. It detects the existing install and points at
`haive upgrade`.

- **`haive upgrade`** with no version targets the newest STABLE release that is legally reachable
  from here. Prereleases are never selected implicitly; `--version next` asks for one on purpose.
- **`haive upgrade --version 0.3.0`** targets exactly that, subject to the same `minFrom` check.
  Pinning the target is not a lesser form of upgrading — it is the SAFER one, because "whatever
  latest happens to be right now" is the version nobody chose. Forbidding an explicit target would
  ban the careful case and leave only the loose one.
- **Same version is a no-op**, reported and exit 0. Re-running must be safe; making it an error
  punishes the reflex that follows a half-finished window.
- **Downgrade is REFUSED**, and this one is a hard rule rather than a default. A release that
  CONTRACTED the schema cannot be un-run, and older code against a newer schema is undefined
  behaviour, not a slow path. `contracts` in the manifest says whether it is even theoretically
  reversible; the supported way back is the Phase 2 snapshot, taken by the upgrade that moved you.

**A jump that is too far is NAMED, not merely rejected.** This is the real answer to "the target
might be several versions ahead". When `minFrom` refuses a direct hop, the upgrade resolves the
chain of required stops from the intervening manifests and says so — *"0.1.0 to 0.5.0 requires
passing through 0.3.0"* — and can walk it, running the full phase sequence at each stop with its own
gate. A required stop exists because something in it must actually RUN (a destructive migration, a
data conversion that only happens on the way through), so skipping it is not an optimisation and
walking it is not optional. What must never happen is the third option: refusing with "not allowed"
and leaving the operator to work out the path from release notes.

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

### Slice 2 — Version stamping + release manifest — **SHIPPED**
*Rollback: revert the constant and the build args; images simply stop carrying a version, as today.*

- `APP_VERSION` to `0.0.0-dev`; `HAIVE_VERSION` build arg threaded to env; `/version` reporting the
  running version and the migration head.
- Release manifest schema + generator.

**As built.** Three departures, each forced by something the plan did not know:

- **The worker has no HTTP surface** (no `listen()` anywhere in `index.ts`), so "a `/version`
  endpoint on api and worker" is not buildable as written. The worker publishes
  `{version, startedAt}` to a Redis key at every boot and the api's `/version` reports both. The
  key deliberately carries NO TTL and is not a heartbeat: a worker that failed to restart leaves
  the PREVIOUS version and an old `startedAt`, which is exactly the evidence a health gate needs,
  where a TTL would erase it and read as "no worker" either way.
- **`/version` is unauthenticated, beside `/health`**, because an upgrade must verify what came up
  before and without any credential. `/health` cannot answer this — it returns a fixed
  `{status, service}` and would report `ok` from a container still running the previous image.
- **Changing the constant broke a user-visible surface the plan did not account for.**
  `getHaiveVersion()` already feeds the repo upgrade banner, which renders `On v{installed} →
  v{current}`; with the sentinel that reads `On v0.1.0 → v0.0.0-dev`, i.e. a downgrade. The banner
  now renders `(dev build)` instead of a transition. `isDevVersion()` exists so no other surface
  has to string-match the sentinel.

The manifest carries one field the plan did not list: `contracts`. An additive-only release rolls
back by re-pinning the previous tag and leaving the schema alone; one that removes something cannot,
so the flag tells the upgrade its snapshot is load-bearing rather than insurance. The generator
computes it from the corpus, ignoring `DROP`s that appear only in rollback comments — verified both
ways. It also refuses to emit a manifest for the dev sentinel.

Verified: an image built with `--build-arg HAIVE_VERSION=0.2.0-test` reports it and
`isDevVersion()` is false; one built without reports `0.0.0-dev`. `/version` answers live with both
services' versions and the migration head.

### Slice 3 — CI publish + compose run overlay — **SHIPPED (inert until a tag is pushed)**
*Rollback: delete the release workflow and the overlay. Neither is referenced by the dev path.*

- Tag-triggered workflow building and pushing multi-arch `ghcr.io/<owner>/haive-{api,worker,web}`,
  stamping `HAIVE_VERSION`, publishing the manifest, `next` channel for `-rc`.
- `docker-compose.run.yml`: `image:` at pinned tags instead of `build:`.

**As built.** `haive-updater` is NOT built here — it does not exist until Slice 5, and publishing an
empty image would be worse than not publishing one. Three things the plan did not specify:

- **Native arm64 runners, not QEMU.** The repo is public, so GitHub's arm64 runners are free, and
  emulating an arm64 pnpm install plus a Next build costs tens of minutes. arm64 is a requirement
  rather than a nicety because `frictionless-bootstrapping-otter` made macOS first-class.
- **The run overlay ADDS `db-migrate`.** `docker-compose.yml` has no migration step at all — the dev
  stack gets one from the dev override — so a published-image install would have booted against an
  unmigrated database. It runs the same runner from the api image, which already ships the corpus.
  That closes the gap this plan lists under its own risks. `build: !reset null` is required, since
  compose MERGES and an `image:` beside the base's `build:` would still build from a source tree the
  install does not have.
- **`HAIVE_VERSION` has no default in the overlay.** `${VAR:?message}` fails the command rather than
  resolving `latest`, because which version an install runs is what every upgrade and rollback turns
  on.

**A bug caught by testing, worth keeping.** `minFrom` originally defaulted to the release version,
which means only that release may upgrade to itself — every real upgrade refused, and it would have
surfaced at the first one. The floor now defaults permissive (`0.0.0`) in the zod schema, with a
regression test; safety against a destructive release comes from `contracts` and the snapshot, not
from this field.

Verified without publishing: actionlint clean on the workflow, the digest-merge and channel-tag
shell logic simulated locally, the overlay refuses without a pinned version and resolves to
pull-only with correct gating, and the generator's output parses against the schema it will be read
with. The workflow fires ONLY on a `v*` tag, so nothing is published until someone pushes one.

### Slice 4 — Maintenance mode + admin task control — **SHIPPED**
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

**As built.** Two departures worth keeping:

- **A non-admin passing `allUsers` gets a 403, it does not silently see only its own.** The plan
  said the latter; the statistics routes already throw, and a silently ignored parameter is worse
  — it lets a caller believe it is seeing everything when it is not.
- **The gate is global, not per-router, and it fails OPEN.** Mounted once in `createApiApp`
  rather than composed into ~25 routers, because a gate that must be remembered at every mount
  point will be missed at one. It reads its (cached) config first and resolves a role only when
  the system is actually locked, so the normal path costs no database work. An unreadable state
  falls back to `normal`: a wrong guess towards "locked" is a lockout clearable only through an
  admin route the gate itself would be refusing.

`stopActiveCliInvocations` and `clearTaskPause` moved to `lib/task-control.ts` beside
`lib/cancel-task.ts` so both the owner route and the admin route share one copy of the careful
supersede-before-kill ordering rather than duplicating 128 lines.

Verified against the running stack: unauthenticated `/tasks` goes 401 to 503 under maintenance
while `/health`, `/version` and `/auth/login` stay reachable; a real throwaway non-admin account
got 403 on `allUsers` and on the admin routes and saw none of the admin's 34 tasks; draining
refused task creation with a reason while GET still served; admin pause/resume wrote both the
audit row and the owner-visible task event and restored the task to `waiting_user`. Browser-checked
both halves — the draining banner over a working dashboard, and the non-admin lockout replacing the
page — each appearing and clearing on the 15s poll with no reload.

### Slice 5 — Updater + `haive upgrade` — **SHIPPED**
*Rollback: the updater is a separate image nothing else depends on; not invoking it leaves the stack
exactly as before.*

- Updater image, journal table, advisory lock, the six phases, resume-or-reverse on restart.
- Host CLI entry point, and an in-app one so an upgrade does not require shell access.
- **Call `runDestructiveDataMigrations(db)` at Phase 5**, after the health gate has passed and the
  upgrade is committed. It was exported by Slice 1 (`packages/worker/src/data-migrations.ts`) and is
  deliberately called by NOTHING until this slice — it reads as dead code in the meantime, so do not
  delete it. Today it holds one entry, `dropHeadingOnlyGlobalKbChunks`, whose raw
  `DELETE FROM ai_rag_embeddings` runs against the global KB store: a separate database, outside any
  core-DB transaction and outside the Phase 2 snapshot. Running it before the gate is precisely the
  case that makes a Phase 4 rollback restore old images onto data the new version already destroyed.
- Verify: the end-to-end matrix below, plus — a rollback at Phase 4 leaves the destructive set
  UNRUN, and a successful upgrade runs it exactly once.

**As built, and it was exercised for real.** A published v0.1.0 install was upgraded to v0.1.2 on
2026-09-08. All six phases ran and the upgrade delivered a genuine change rather than a synthetic
one: `web /login` went from `000` (the v0.1.0 crash-loop) to `HTTP 200`. Then the health gate was
deliberately failed with a manifest carrying an impossible `migrationHead`; it caught the mismatch —
reporting that it SAW `0.1.2` but head `0000_baseline`, which is what proves the gate checks both —
rolled back, and both services returned reporting `0.1.0` with maintenance lifted.

**Four defects, none of them visible from reading the code.** Every one came from running it:

- **The snapshot severs the updater's own database connection.** It stops Postgres, and the journal
  lives in Postgres, so the next write got `connect ECONNREFUSED` and rolled back a perfectly good
  upgrade. It waits for the database to answer now.
- **The snapshot was written to the wrong machine's filesystem.** Paths in `docker run -v` are
  resolved by the DAEMON on the host, not inside the calling container, so a 9.9 MB dump landed at
  `/snapshots` on the host while the operator's install directory stayed empty — after a
  `snapshot-done` log line. The daemon's view is a separate input now, the same distinction the
  worker already names `HOST_REPO_ROOT_REAL`.
- **Three services in `docker-compose.yml` build from a local context**, which a published install
  does not have, so `up -d` failed — and that broke the ROLLBACK too, since it brings the whole
  stack up. A failed upgrade could not undo itself.
- **The failure message leaked the database password.** Node puts the whole command line into a
  failed exec's message and one-shot containers take credentials as `-e` arguments. Redacted at the
  single place every command goes through.

**Three operating requirements the plan did not anticipate**, all of which will bite an installer:

- `COMPOSE_PROJECT_NAME` MUST be passed to the updater. Compose derives it from the directory, and
  the updater sees the install at its own mount path — so without it the upgrade creates a SECOND
  stack instead of replacing the first.
- The run overlay's default mailpit port self-collides: Haive pins DDEV's global mailpit to
  8025-8026, so any machine running Haive-managed DDEV already holds it.
- The proxy sidecars have to be PUBLISHED, not profiled out. They are runtime features — openrouter
  traffic is rewritten by one, ollama's thinking control by the other — so an install without them
  silently loses two providers. Both are in the release matrix and pulled by the overlay.
  `cli-sandbox` is the one service that stays profiled out, and it loses nothing: the worker builds
  that image for itself at boot (`ensureSandboxCoreImage`), which is also what heals a pruned host.

**The in-app trigger is on the API, not the worker, and the plan had that wrong.** Routing it
through a BullMQ job would have put the trigger inside one of the processes the upgrade replaces:
the worker is stopped and recreated in the same swap, so the job holding the upgrade would be
killed partway through it. The api is replaced too, which is exactly why what it does is spawn a
DETACHED container the daemon owns and then get out of the way — `POST /admin/maintenance/upgrade`
awaits only the `docker run -d` CLIENT, so a bad tag, an unreachable registry or a missing socket
comes back as a 502 instead of vanishing. Shelling out to docker from the api is the seam
`lib/sandbox-kill.ts` already established against the same mounted socket.

Four details that are load-bearing rather than stylistic:

- **Secrets go by NAME, never by value.** `docker run -e DATABASE_URL` (no `=`) takes the value from
  the CLIENT's environment — MEASURED — so the password and the master KEK never enter an argv that
  `ps` and every failure message can read. That is the same leak Slice 5 already had to fix once
  inside the updater; passing them as `-e KEY=value` here would have reintroduced it one layer up.
- **The updater image is the TARGET release's**, not the running one's: the new release is what
  knows how to reach itself. `docker run` pulls it, so a version with no published updater fails
  before anything is held.
- **No `--rm`.** The api is replaced mid-run, so the container's own log is the only narrative an
  operator has when an upgrade goes wrong, and a self-deleting container takes it with it. One
  stopped container per upgrade is a cheap price for `docker logs`.
- **`HAIVE_INSTALL_DIR_HOST` gates the feature and is never inferred.** The api hands that path to
  `docker run -v`, which the daemon resolves on the HOST, so `process.cwd()` or `$PWD` would
  silently bind-mount the wrong directory — the identical mistake that put the first snapshot on the
  wrong filesystem. Unset, `GET /admin/maintenance/upgrade` reports `canUpgrade: false` and the page
  says which line to add; a dev checkout is reported separately, because "there is no release to
  swap to" and "this install was not told where it lives" have different fixes.

**The in-app trigger could not reach a namespaced install before 0.1.6, and the fix is not
retroactive.** The api spawns the updater as a container, and a container boundary does not carry
`HAIVE_INSTALL_ID` for free — an api that does not pass it leaves `networkName()` inside the
updater with no id, so the one-shot MIGRATE container joins the DEFAULT install's network. MEASURED
on an install with id `chan2`: that container resolved `postgres` to a different install's database
and failed on `password authentication failed`, which the health gate rolled back. Two installs
sharing a password would instead have had the wrong one migrated.

Fixed in 0.1.6 on both sides (the api passes the id; the updater resolves through `networkName()`),
but the api that SPAWNS is the one being replaced, so an install at 0.1.5 or earlier still spawns
without it. Those installs take the hop with the HOST-SIDE `./haive upgrade`, which reads `.env`
and passes both `--network <id>-network` and `-e HAIVE_INSTALL_ID` — verified present in the script
the v0.1.5 installer already generated. From 0.1.6 the in-app button works. An install on the
DEFAULT id was never affected, since the fallback and the truth are the same name there.

The admin surface is its own page (`/admin/maintenance`) rather than another card on `/admin`,
which is already 2,500 lines: state control, the blocking-work list with per-task pause/resume/stop,
the version field, and the `upgrade_runs` history. It stays reachable under full maintenance because
`maintenanceGate` lets admins through — locking the door with the key inside is the failure that
list exists to prevent. The drain banner points here rather than at `/admin`, since this is where
the controls now are.

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
