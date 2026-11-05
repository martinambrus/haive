# Modules

A module is a package named `@haive/module-<id>` (a workspace folder under `modules/<id>/`) or
`@haive-module/<id>` (published to the registry; `modulePackageId` in `@haive/shared/modularity` is
the one rule: `gen-modules` refuses a package that exports `./manifest` under any other name, and both
loaders refuse at boot a manifest whose id does not match its name), whose
`package.json` exports `./manifest` (which may also declare integration providers and categories, see
[Integrations](integrations.md)) and any of `./routes` and `./integrations` (api, the executors of
those providers), `./steps`, `./ensure-schema`,
`./jobs` and `./teardown` (worker), `./web` and `./dashboard` (web). `scripts/gen-modules.mjs` turns the installed
ones into four gitignored registries (`packages/api/src/modules.generated.ts`,
`packages/worker/src/modules.generated.ts`, `packages/web/src/generated/module-pages.ts` and
`module-dashboard.ts`) plus `packages/web/src/generated/modules.json`, the web parts it compiled in (id,
package, source, version, parts), which the web production image ships at `/app/packages/web/modules.generated.json`
so a build can read back what an image carries; and the `dev`, `build` and `typecheck` scripts of the api, worker and web run
it first, as do the `test` scripts of the api, worker and web.

The integration settings and admin cards identify a provider's contributing module and live
provider state separately from its configured switch; see [Integrations](integrations.md). A
provider enabled by configuration can still be unavailable because its module is deactivated.

## The four states

Two things move independently: whether the code is **installed** (a rebuild moves it) and whether the
module is **active** (`modules.deactivated_at`, a live flag that needs no rebuild). The worker's boot
records every module it loads in `modules` and is the only writer of `missing_at` (`syncModuleIntent`,
`worker/src/modules/intent.ts`): it stamps it on every recorded row it did not load and clears it when
the module loads again.

- **Installed, active.** `pnpm module add <id>` and a rebuild. Everything runs: the module's api
  routes at `/m/<id>`, nav and pages, settings, dashboard widget, worker steps, jobs and database.
  A module whose manifest sets `apiRequiresAdmin` is listed for a non-admin with
  `compiledWeb: false`: its compiled pages answer not-found and its compiled dashboard widgets do not
  render for that user, while its declared pages without data endpoints still do. An admin's save of
  its settings (`PUT /modules/<id>/settings/<kind>`) records `module.settings` with the names of the
  fields that changed, never their values, since a module's setting can hold an API key; the
  instance's own switches (`PUT /admin/config/*`) record `config.<name>` with the values before and
  after. Saves of one switch, or of one module's settings kind, run one at a time under a
  transaction-scoped advisory lock (`admin-config:<route>`, `module-settings:<id>:<kind>`), so each
  row's `from` is what the save before it left; a save that waits longer than 30 s answers 503. The
  read and the audit row share that one transaction's connection, but the values live in Redis, which
  no rollback reaches, so the row goes first: it is written inside a savepoint before the first value,
  and a row that cannot be written fails the save with nothing changed. A save that fails after writing
  some fields rolls the full row back, records the fields it wrote with `partial: true`, and then
  fails. A commit that fails after a value was written still leaves that change without its row.
  Audit rows are stamped with `clock_timestamp()`, the moment they are written, not when their
  transaction began.
- **Installed, deactivated.** The Active column on `/admin/modules`, or `PATCH /modules/:id` with
  `{"active": false}` (admin; audited as `module.deactivate`). It is refused with 409
  `module_tasks_open` while a live task's run list names one of the module's steps or its type is one
  the module seeded; the answer lists up to `MODULE_DEPENDENTS_CAP` (200) of them, each with the step
  it is on, and says `capped` when more exist. The page shows that list and offers **Turn off now**,
  which sends `{"active": false, "mode": "urgent"}`. Urgent mode stamps `deactivated_at` under the
  module row's lock, then stops every task that is in one of the module's steps, listed or not: each
  stop commits on its own (the Stop button's `supersedeLiveRuns`, failing the task as stopped by an
  administrator), then the task's sandboxes are killed, then a `task.stopped` event (reason
  `module_deactivated`) and a `task.admin_stop` audit row are written. A step waiting on a form has
  nothing to stop, so that task is left, as is every task elsewhere in its run list: those fail when
  they next run one of the module's steps. The answer reports `stopped` (with `killError` when,
  after the stop committed, the task's sandboxes could not be listed or one was still listed 3 s after
  a failed removal, and `eventError` when the event or audit write failed), `left` and `failed` (only
  a stop transaction that threw); the page shows the counts and names each
  task it could not stop or whose kill or record failed. The code stays loaded: its api routes and
  settings answer 404 (a non-administrator asking for admin settings gets 403 first, whatever the module), `GET /modules` leaves it out (nav, pages, dashboard widget; compiled module
  pages and widgets render only for modules that list names) and the composer palette drops its steps.
  The worker neither ensures the schema of nor starts any job of a module that is deactivated when it
  boots (so a restart after Tear down leaves the dropped schema dropped; it reads the deactivated set
  at the schema step and again right before starting jobs, and holds back the union), and a reconcile
  every 15 s
  (`MODULE_JOBS_RECONCILE_MS`, `modules/loader.ts`) stops the jobs of one deactivated since. A stop
  still running after `MODULE_JOB_STOP_WAIT_MS` (10 s) is logged once and left running: the pass goes
  on with the other modules, a later pass or the shutdown waits on that same stop instead of calling it
  again, and the module counts as running until it ends. Once the module is active again, the next
  pass ensures its schema and then starts its jobs, once. A reactivation still running after
  `MODULE_JOB_START_WAIT_MS` (10 s) is logged once and left running: the pass goes on, no later pass
  starts the module again meanwhile, and a late success counts as started (until the deadline of a
  job start, below), so a pass that sees the module deactivated by then stops it. A failed
  ensure or start is tried again on the next passes, at most `MODULE_REACTIVATION_ATTEMPTS` (3) per
  reactivation; after the last one only a worker error log says so, until the next deactivation and
  activation. A pass sees an activation by the module row's `updated_at` too, which every activate
  and deactivate moves: when the stamp differs from the previous pass's (the first pass only records
  it), the module counts as activated again, so its attempts start afresh, a start still running from
  before is not counted if it fails, and a module that is not running its jobs is tried again. A
  deactivation and activation that both fall between two passes are seen this way; any other write
  to the row does the same to an idle module. Activating a module also runs a pass at once: the api
  publishes its id on `MODULE_ACTIVATED_CHANNEL` when the activation has committed (never awaited, so
  a Redis outage cannot fail the request), the worker's `startModuleActivationWatch` hears it and its
  `ModulePassScheduler` (`modules/pass-scheduler.ts`) starts the pass without waiting for the
  interval. A request that arrives while a pass runs makes exactly one more pass run right after it,
  since the activation may have committed after that pass read the rows, and the 15 s interval stays
  as the fallback for a message that never arrives. Boot waits the same `MODULE_JOB_START_WAIT_MS` on each
  module's schema ensure and job start: one still running then is named in a warn and boot goes on to
  `haive-worker ready` without it (a failure within the wait still stops boot); a late ensure is held
  back like a deactivated module, so the first pass ensures it again and then starts its jobs. Until an
  ensure of such a module has succeeded (the late one or a pass's), a step of it that is about to
  start parks instead of failing. The flag is in `modules/schema-ready.ts` and `moduleSchemaWaitMessage`
  (`modules/activation.ts`) reads it after the deactivation gate, so a step of a deactivated module
  still fails its row with that module's own message. The row goes `pending` with the park marker
  (`waiting_started_at`) and a line saying the module's schema is being set up, or naming its
  teardown hook while one runs, or saying the setup failed and is no longer retried once the
  attempts below are spent; a delayed advance every `MODULE_SCHEMA_POLL_MS` (5 s) looks again, so the
  step starts by itself once an ensure has succeeded, and no row fails and nothing needs a Retry. It
  is the pause park (`handleAdvanceStep`, see [Worker restarts](worker-restarts.md)), and a pause wins
  over it. The task's badge reads `waiting: module setup` (told apart by the module step id, never by
  the line), and a park whose tick was lost is re-driven by the stalled sweep. A step already past its start (a form answer, a finished CLI run, a fan-out continuation)
  keeps its row as it is, and only its advance is put off by the same delayed job; a START hands its
  first step to the advance path so the park is written there. The park has no time bound, but
  it ends when the setup is spent (the flag reads `failed`, attempts used up): the next poll, or a
  step reaching the gate, fails the row with the setup-failed words (`moduleSchemaFailedMessage`,
  through the deactivation failure path of `advanceStep`), so the task fails and Retry works once
  the module is reactivated; a reactivation resets the flag first, so it never fails a row. The
  runner is the last gate and reads the flag itself, after every await of the admission block
  (`moduleSchemaNotReady`), rather than taking admission's or START's word: a module step whose
  schema is not ready returns `deferred`, writes nothing and is advanced again after
  `MODULE_SCHEMA_POLL_MS` under the same epoch from both callers, so a reset that lands between
  two reads never runs the step on an unready schema. A boot that skips the ensure of a deactivated
  module marks it the same way, so after Activate its steps wait for a pass's ensure too. A schema
  ensure has a deadline, `MODULE_SCHEMA_ENSURE_TIMEOUT_MS` (10 minutes), over the whole
  setup, the open of the module database included, and a setup that runs out of it counts as
  failed. The database it opened is closed first (which drains for up to 5 s) and only then does the
  setup reject; a database that opens after the deadline is closed and the ensure never runs on it;
  a setup that settles late is ignored and never marks the schema ready. What it leaves behind:
  the module stays marked not ready, so its steps keep waiting; the boot's hold (`bootEnsuresRunning`)
  or the pass's claim (`jobsStarted`, `starting`) is released, so a teardown is no longer refused for
  it; the attempt counts toward `MODULE_REACTIVATION_ATTEMPTS`, so the next active pass ensures
  again, at most three times per reactivation, and after the third the flag reads failed (only the
  worker error log and the waiting steps' line say so) until a deactivation and an activation try
  again. On the server a statement the ensure had already sent ends about half a second after the pool
  closes and its transaction rolls back, since no COMMIT arrives: closing the pool alone cancels
  nothing (measured: a `pg_sleep` backend was still running 3 s after `close()`), so
  `openModuleDatabase` opens every connection of the pool with `client_connection_check_interval`
  = 500 ms as a startup parameter (it needs PostgreSQL 14 or later on Linux, which the stack runs;
  pinned by the gated `module-db-abandoned-waiter.test.ts`). That covers a waiter on the schema
  lock, a statement inside `withSchemaLock`, and whatever a module sends through `ctx.sql` or a
  teardown hook's handle. Haive's internal RAG and global-KB pools (`rag/connection.ts`,
  `global-kb/connection.ts`) open with the same parameter; an external store does not get it, since a
  pooler can refuse a startup parameter ([Global knowledge base](global-kb.md)). Whatever the ensure
  committed on its own stays, so an ensure must be idempotent. A job start has the same deadline: `jobs` that has not
  returned by then counts as failed, with its claim released and its attempt counted as an
  ensure's are. The jobs it starts after the deadline are stopped at once and never count as
  started, though the module counts as running, and a teardown of it is refused, until that stop
  succeeds; a stop that fails is called again by each later pass and at shutdown. Nothing can cancel the abandoned call, so the next attempt can run beside it: `jobs` must
  tolerate a second call while an earlier one is still running (`startJobsWithinDeadline`,
  `modules/loader.ts`). At
  shutdown one deadline, `MODULE_SHUTDOWN_WAIT_MS` (5 s), covers the reconcile pass in flight and every
  module stop together, and the terminal manager's stop runs beside it under its own 5 s bound (it
  refuses a terminal open from the moment it begins, and tears down the session of an open that was
  already in flight and answers it refused; any open that fails after adding its session tears that
  session down), so the queue closes and the sandbox reap still
  run inside Docker's ~10 s grace, and the shared Redis connections get 1 s to quit before they are
  dropped;
  a start that succeeds after the stops began stops itself, and a second signal waits on the shutdown
  already running (a third exits at once). A task type that uses the module, as its source or
  through any step, is
  listed unavailable with the reason `module-deactivated`, and creating a task of it is refused with
  409 `module-deactivated`; the create reads the module rows `FOR KEY SHARE`, so a deactivation running
  at the same moment waits and then counts the new task. A task that reaches one of its steps later, after a Retry or a revive,
  fails that step's own row with a message naming the module, without asking the step's `shouldRun`
  or taking a runtime slot; Retry runs it once the module is active again. All data is kept.
- **Uninstalled, data kept (`Missing`).** `pnpm module remove <id>` and a rebuild. Nothing runs: the
  api and worker do not load it and the web build does not import it. Kept: the `modules` row
  (`missing_at` set), the database `haive_module_<id>` (`-` as `_`) and the Redis settings
  `config:module:<id>:*`. A task type that uses the module, as its source or through any step, is
  listed unavailable with the reason `module-missing` naming the module (by its recorded name, or its
  id once no row is left), and creating a task of it is refused with 409 `module-missing`; this
  reason is checked before `module-deactivated` and before `missing-step`.
- **Purged.** "Purge data..." on `/admin/modules`, offered for a `Missing` module only and confirmed
  by typing its id after the admin-only, read-only `GET /modules/:id/purge-preview` has loaded its
  current integration counts. Loading, failed, incomplete or wrong-target previews cannot enable
  Purge; retry reads again, and closing or changing the target discards old replies. The preview
  counts provider configurations, connected accounts, user write settings, saved account preferences
  (installation defaults included), task overrides and task/repository grants. It is a snapshot;
  the purge returns and audits actual deletion counts, never client-supplied counts.
  It is refused while the api or the worker loads the module, before the worker has reported what
  it loaded, and while a live task (a dead one included) uses it, including a direct integration
  choice or grant that would be deleted. It drops the module database without FORCE (a connection
  still on it refuses the purge), deletes the `config:module:<id>:*` settings, deletes owned
  integration configuration and bindings ([Integrations](integrations.md#module-data-purge)),
  deletes the module's task types no task uses (the others are kept and listed) and deletes the
  `modules` row. The main-store changes and required `module.purge` audit insert share one
  transaction: a refused audit or a module that came back rolls those changes back. The latter
  still gets the existing best-effort partial-purge audit with zero integration deletions.
  Type rows lock before the module row. Brief `SHARE ROW EXCLUSIVE NOWAIT` locks on the six
  integration configuration/binding tables prevent an intervening binding or account write.
  They admit `ROW SHARE`, so owned connection rows are then taken `FOR UPDATE NOWAIT`, with
  the same ownership predicate as deletion: a disconnect that selected an account before its
  DELETE refuses cleanup immediately, rather than deadlocking on the later table upgrade.
  An unrelated account's row-only lock does not refuse this fence. Next,
  affected task rows take `FOR NO KEY UPDATE NOWAIT` to stabilize their status, then live direct
  bindings are checked again. A concurrent writer refuses this cleanup immediately rather than
  waiting with the type locks held. Database drop and Redis deletion are outside that transaction:
  a purge that failed after the drop answers 502 `module_purge_incomplete`, and the next one
  finishes it. Every cleanup is safe to repeat. The dialog warns when the module's teardown hook
  never ran, and explains that call/invocation/audit history and Git credentials are retained.

**Graceful drain.** The admin's read-only `GET /modules/:id/dependents` preflights persisted
seeded types, run-list snapshots, known required static module admissions, direct integration choices/grants and live invocation stamps
(`ended_at` and `superseded_at` both NULL). It returns one deduplicated task list and an honest
200-row cap, with no account labels or secrets. A binding Reset can remove the current grant while
an invocation still uses its stamp, so those live stamps are dependency evidence too. An ended mining stamp still linked to a
current step counts while that step has pending/running agent reservations: the last sent agent
may have finished before the next reserved agent was sent. Ended stamps without this current
fan-out evidence are history and do not count.
`PATCH /modules/:id {active: false, mode: "graceful"}` records `draining_at`, the initiating actor
and an uncapped `module_drain_tasks` cohort in one transaction with its required `module.drain`
audit. The module stays active: admitted tasks can answer forms, resume, run its steps and call its
providers; unrelated work continues. New tasks and new module dependencies are refused with
`module-draining`. Guards hold module rows KEY SHARE through admission; a lifecycle action holds
FOR UPDATE. New guards never wait on a row upgrade (`module-busy`, retry), and task revival takes
its integration-choice lock without waiting before discovering dependencies, so a choice cannot
race that discovery and a dispatch cannot deadlock on a revive's step rows.
The worker's existing 15-second module pass rechecks each drain under its row lock, using actual
live dependencies plus the cohort, without a preview cap or task-row locks. A cohort member keeps
blocking even after its binding or invocation ends, until the task ends. The same live/nondead
statuses as ordinary deactivation apply; failed, completed, cancelled and dead tasks do not block.
Only then does the finalizer stamp deactivated_at, clear intent/cohort and insert its required
`module.deactivate` audit together; the normal module job pass stops that module's jobs. SQL waits
on lifecycle actions are bounded to five seconds. Intent survives worker restart and failed passes
are retried; no instance-wide maintenance flag is changed. `DELETE /modules/:id/drain` explicitly
cancels and audits the drain, idempotently. Activate and urgent deactivation also cancel it under
the same row lock, so an older finalizer cannot overwrite a newer admin decision. A failed audit
rolls the new intent, cancellation or finalization back. Urgent stop/kill reporting stays as above.

**Teardown.** "Tear down" on `/admin/modules` (`POST /modules/:id/teardown`, admin, audited as
`module.teardown`) runs a deactivated module's `./teardown` hook in the worker, which drops the module's
own data; it answers 409 `module_active` or `module_missing` for a module in any other state. The
worker refuses it by name while this worker does not load the module, while the module's jobs or its
schema setup still run (jobs normally stop within one reconcile pass of the deactivation, and a stop
that outlives its wait keeps the refusal until it ends; a boot schema ensure that outlived its wait
keeps it until it ends or its deadline runs out, and a job start that does not return keeps it
until the same deadline runs out; the refusal says so), and while an earlier
teardown hook of the module still runs. A teardown with a hook marks the module unready, so after
Activate its steps park while the hook runs (past its timeout it holds the module) and their line
names the hook. A module that has a schema ensure stays unready after the hook until a pass has
ensured the schema again; one with none has no setup to wait for and is released when the hook ends.
The hook has 10 minutes (`TEARDOWN_HOOK_TIMEOUT_MS`); past
that the job fails, the hook may go on, and until it ends the module is held: no schema ensure, no job
start and no second teardown, with one warning per hold in the worker log, and the hook can no longer
open the module database. Only a worker restart frees a hook that never ends. A finished teardown
stamps `torn_down_at`, unless the module was activated again meanwhile (409 `module_active`, nothing
recorded). Activating clears the stamp, and the next active pass ensures the schema again even when
no pass saw the module deactivated. The route waits up to 2 minutes and answers 202 while the hook
still runs.

Purge is an action of the admin page only. `pnpm module` never deactivates or purges anything and never touches
the database or Redis: it moves a module between the first and third states, and nothing it does
loses data. A task whose data names a step of a module this install no longer registers is marked
dead, not failed (`UnresolvedStepError`, `step-engine/registry.ts`). A module this install never
loaded has no row, so removing it leaves nothing for `/admin/modules` to show.

## What the build requires

A module is **installed** when `@haive/api` depends on it (`"@haive/module-<id>": "workspace:*"`
for a folder, `"@haive-module/<id>": "<exact version>"` for a registry module). Each generated entry
records its source (`local` or `registry`) and the worker writes it to the `modules` row at boot. The
same id from a folder and a registry dependency is refused (`gen-modules` exits 1 naming both; keep
one), and a registry dependency whose package is not on disk yet is left out with a notice until
`pnpm install` has run; the worker must depend on it even then. Every installed package in the
`@haive-module` scope must export `./manifest`: `gen-modules` refuses one that does not, rather than
leave out a dependency the api and worker hold. A folder may already carry its registry name
`@haive-module/<id>`; the hosts then depend on it as `"workspace:*"`, because pnpm links a folder only
through the `workspace:` protocol and installs any other spec from the registry, and `gen-modules`
refuses such a folder pinned to a version.
`@haive/worker` must depend on exactly the same modules, and `@haive/web` on exactly the installed
ones that export `./web` or `./dashboard`, so the api and the worker always load the same set. Any
other combination is a half-installed state: `gen-modules` exits 1, naming the side and the
`package.json` to change. It also exits 1 when a registry module's version is a range, or differs
between the `package.json` files that depend on it: pnpm would install a copy per version while the
generated imports follow the api's. And it exits 1 when the installed copy
(`packages/api/node_modules/<name>`) is another version than the declared one, build metadata aside,
since the generated lists would come from that old copy: run `pnpm install` (`pnpm docker rebuild` on
the dev stack). `pnpm module add|remove` skip that one check (`HAIVE_INSTALL_MAY_LAG=1`), because their
lockfile-only install leaves `node_modules` behind on purpose.

A folder under `modules/` that exports `./manifest` and that nobody depends on is **present, not
installed**. `gen-modules` prints `present, not installed: pnpm module add <id>`, leaves it out of
every registry and exits 0, so a module folder you are not using does not break the build. The images
still copy and build every folder under `modules/`; an uninstalled one is dead weight there and is
never loaded.

## Installing and removing from a source checkout

From the repository root:

```bash
pnpm module add <id>      # or: pnpm module remove <id>
pnpm module add @haive-module/<id>@<version>   # a registry module, exact version
pnpm docker rebuild       # no service name
```

`pnpm module add <id>` needs `modules/<id>/package.json`, named `@haive/module-<id>` and exporting
`./manifest`; otherwise it exits non-zero naming what is wrong and writes nothing. It adds the
dependency to `packages/api` and `packages/worker`, and to `packages/web` only when the module
exports `./web` or `./dashboard`, keeping each list sorted. It then runs
`pnpm install --lockfile-only` (a plain host install aborts without a TTY), runs `gen-modules` to
validate, and prints the next step. On a module that is already a dependency everywhere it says so
and writes nothing. `pnpm module remove <id>` takes the same keys out and runs the same two steps;
it never deletes `modules/<id>/` (it may be your own untracked source) and never touches the
database or Redis. If the lockfile step fails the `package.json` edits are put back; if
`gen-modules` rejects the result (another module in a half-installed state) the edits stay and its
message names the fix.

The registry form reads the package's exports with `pnpm view` (the lockfile-only step installs
nothing, so the package is not on disk yet), adds the exact version to the same hosts, and moves a
held dependency of another version in place. The root `.npmrc` points the `@haive-module` scope at
GitHub Packages (`https://npm.pkg.github.com`) and holds no token: the token never lives in the
repository, not even as a `${NPM_TOKEN}` placeholder (an unset one makes pnpm skip the whole file).
On the host, put the auth line in your user `.npmrc` (`~/.npmrc`).

**The image builds read the token from a BuildKit secret.** The api, worker and web deps stages run
`pnpm install` with `--mount=type=secret,id=npmrc,target=/root/.npmrc`, so the token is in no layer,
history entry, image config or build log, and a build with no secret behaves as before. In dev,
`HAIVE_NPMRC` (unset by default) names an `.npmrc` holding the auth line: `docker-compose.dev.yml`
passes it as the `npmrc` build secret to the dev-libs, api, worker and web builds and mounts it
read-only at `/root/.npmrc` in db-migrate, whose install runs at start. It must name an existing
file: Docker creates a missing bind source as a root-owned directory. Compose builds through
buildx bake, which refuses a build secret file outside the project (the `/dev/null` default
included) unless `BUILDX_BAKE_ENTITLEMENTS_FS=0`; `scripts/dev.sh` and the CI compose jobs set it, so
a hand-run `docker compose build` fails on that secret. BuildKit reuses a cached
install layer after the token is revoked or changed, so only an uncached install notices a
revocation. `.dockerignore` keeps every nested `.npmrc`, `.env` and `.git` out of the build
contexts (the root `.npmrc`, which the Dockerfiles copy, stays).

A dependency change reaches the dev stack only through `pnpm docker rebuild` with no service name
(see Build commands in `AGENTS.md`); a restart or a per-service rebuild is not enough. Recreating
the worker interrupts live CLI terminals and running steps, so look at the active tasks first. Once
the worker has booted, `/admin/modules` reads the module as `Loaded` after an add and as `Missing`
after a remove.

## Packaging a registry module

A packed module's `workspace:*` dependencies become `0.1.0`, and the core packages are never
published, so the root `package.json` pins `@haive/shared`, `@haive/database` and `@haive/web-kit` to
`workspace:*` in `pnpm.overrides`: without them pnpm looks the core packages up on registry.npmjs.org
(and could install somebody else's). A registry module ships `files: ["dist"]`, takes `@haive/*`,
`hono`, `drizzle-orm` and `zod` (and `react`/`next` for web parts) as peer dependencies, and is named
`@haive-module/<id>` with `<id>` equal to its manifest id. `gen-modules` checks the name only; the id
is checked when the api and worker load the module, so a mismatch builds and they then refuse to
start, naming the package.

## Published-image installs

An install that runs published images (`docker-compose.run.yml`, see
[Cutting a release](release.md)) has no pnpm and no source checkout, so `pnpm module` does not
exist there. Which modules it carries moves with the images it runs, and `/admin/modules` shows the
same states either way.

**The leak gate.** A per-customer channel's images are checked locally before anything is pushed:
`node scripts/channel-gate.mjs --expect <expect.json> --token-file <file>`. The vendor npm token must
appear nowhere (`scripts/smoke/scan-image.sh`, the token passed in its environment). The module names
found in every layer, registry `@haive-module+<id>@<version>` and folder modules under
`app/modules/<dir>/`, must equal the entitled set for the api and the worker and be a subset of the
modules with web parts for the web image. A folder's `package.json` is read in every layer that
writes it, so a name a later layer overwrote still counts. A non-directory entry under `app/modules/` other than
`.gitkeep` is refused. Every registry module in the expectation names its version (one without is a
malformed expectation, exit 2). The api and worker images must carry exactly that version: another
version, or a module linked in with no version to read, is an offender. The standalone web image has
no `.pnpm` paths, so its versions come from its module list instead: an expected registry module with
web parts must be listed with its expected version. A local module's version is never compared. The generated module
registries, read inside the image with no network, must equal the expected sets; the api and the
worker must carry `HAIVE_VERSION`; and no `.npmrc` in any layer may hold a credential (the D1b rule,
which also finds an indented key). It exits 0 only when every image passed, 1 with one `OFFENDER`
line per finding, and 2 when it could not look, offenders still printed; it never prints the token or
an `.npmrc` value. A multi-platform `docker save` is refused (2): channel images are single-platform.

### Building a channel (`scripts/build-channel.mjs`)

`node scripts/build-channel.mjs --tag vX.Y.Z --channel <name> --modules <file.json> --token-file <file>
[--registry <output-prefix>] [--source-registry <stock-prefix>] [--out <dir>] [--replace]` builds one
customer's images locally and runs the gate on them. It never pushes or logs in; publishing is a separate
step that reads its record.

- Inputs: a final tag only (`vX.Y.Z`, no prerelease), resolved to its commit and exported with `git archive`
  into a temp dir outside the repository; never the working tree. `<file.json>` is a JSON array of exact
  `@haive-module/<id>@<version>` specifications. The channel name is 1-32 lowercase letters, digits or dashes.
- Preflight, before any network use: the tag's tree must hold `scripts/module.mjs`, `scripts/gen-modules.mjs`
  and an `id=npmrc` secret mount in each of the api, worker and web Dockerfiles. v0.2.0 and older are refused
  (exit 2, the missing file named). The working tree's `scripts/channel-gate.mjs` and
  `scripts/smoke/scan-image.sh` must be clean, because the gate runs from this checkout, not from the tag.
- Modules: `module add` runs once per entitled package inside the tree. Every `modules/<dir>/package.json`
  in the tree is expected as a local module, with web parts read from its `./dashboard` and `./web` exports.
- Token: it reaches pnpm and BuildKit only as a private 0600 `.npmrc` in scratch (`--secret id=npmrc`), never
  argv, env or a build ARG. Streamed output is scrubbed of it across chunk boundaries. Scratch, the pnpm cache
  (`XDG_CACHE_HOME`) and the secret are removed on every path; a cleanup failure prints the leftover path and
  keeps the exit code.
- Images: api and worker are built with `--target production`, `--load`, `HAIVE_VERSION` and the build
  platform, tagged `<registry>/haive-<channel>-<host>:<version>`. Web is rebuilt only when an entitled module
  exports web parts. Otherwise the stock `<source-registry>/haive-web:<version>` is pulled for that platform.
  `--source-registry` defaults to `HAIVE_REGISTRY`, then `ghcr.io/martinambrus`. An existing local tag is
  refused unless `--replace` is given. Default BuildKit attestations are kept. The gate's `docker save`
  accepts both a `--load` build and a single-platform pull of a multi-platform index on the containerd image
  store (one manifest entry), measured 2026-11-05.
- Result: the gate's exit code. Only on exit 0 is `<out>/build-record.json` written. A stale record is deleted
  before building, and a failed run leaves its tags for diagnosis. The record carries `"schema": 1`, the tag,
  commit, channel, version, platform, the docker image store, and per image its `ref`, `built`, `id` and, for
  the stock image, its `repoDigest`. Ids are read before and after the gate, and a change is refused. Under
  the containerd store `id` is the index digest; under the classic store it is the config digest.

## Own modules on a published install

`haive-builder:<version>` supplies the core source, Node, pnpm, installed dependencies and pnpm
store. Its Dockerfile is `docker/own-module-builder/Dockerfile` (repository-root context); the
ordinary release matrix publishes it. A vendor builds the same Dockerfile from an entitlement-filtered
context for a customer with paid modules. Only that customer's packages may be installed or present:
the public builder must never contain private packages. Vendor registry credentials use the optional
`npmrc` BuildKit secret, which is not copied into the image. A customer-side rebuild uses the baked
closure and can fetch public npm dependencies without receiving a vendor token. An incomplete private
closure fails the build; there is no credential fallback.

The one-shot accepts prepared module folders under `/input/<id>/` and `HAIVE_BUILD_PLAN` JSON:

```json
{
  "version": "0.2.0",
  "builderImage": "ghcr.io/martinambrus/haive-builder:0.2.0",
  "baseImages": {
    "api": "ghcr.io/martinambrus/haive-api:0.2.0",
    "worker": "ghcr.io/martinambrus/haive-worker:0.2.0"
  },
  "outputImages": {
    "api": "haive-own-api:0.2.0-install",
    "worker": "haive-own-worker:0.2.0-install"
  }
}
```

Run the matching builder with `docker run --rm`, mount `/var/run/docker.sock` at the same path,
mount the prepared module directory read-only at `/input`, and pass that JSON with
`-e HAIVE_BUILD_PLAN=...`. No host Node, pnpm or Haive checkout is needed. Inputs must already be
fetched and pinned, by hand or through the install sources below.
The builder checks its release stamp, refuses collisions with baked modules, adds own packages to
the disposable workspace dependency lists, installs dependencies, and runs existing codegen and
package builds. It derives only api and worker by default. A module exporting `./web` or
`./dashboard` requires `rebuildWeb: true` and web base/output image references; otherwise the build
fails before producing a candidate. Runtime-fetched declarative pages need no web rebuild.

This one-shot has host-root authority through the Docker socket, and module build scripts execute
with that authority. Only use trusted modules and trusted builder images. The input mount is read-only;
all package edits and dependency installation happen inside disposable build stages. Nested `.git`,
`.env`, `.env.*`, `.npmrc`, `node_modules` and the `.haive-source.json` pin marker are excluded
from the own-module build context (`BUILD_CONTEXT_IGNORE`, pinned by its test).

Installation callers run the one-shot before bringing up services, then persist the successful output
references as `HAIVE_API_IMAGE` and `HAIVE_WORKER_IMAGE` (and `HAIVE_WEB_IMAGE` when rebuilt) in `.env`.
The run overlay uses the API override for both api and db-migrate. Keep the source configuration in
that file too: `HAIVE_OWN_MODULES_HOST_DIR` is an absolute **daemon-side** prepared module directory;
`HAIVE_OWN_MODULES_REBUILD_WEB=true` opts into web builds; optional `HAIVE_BUILDER_IMAGE` is a
customer builder reference containing `{version}`. Its default is the install's registry plus
`/haive-builder:{version}`. Keep module selection in that directory exact; removing a folder omits
it from the next derived image without purging its data. An empty own-module directory is refused;
to remove the final own module, select the prebuilt images and clear the own-module configuration.

Upgrade Phase 0 pulls the new bases and matching builder, then repeats this build before draining.
Every attempt uses fresh local output tags, preserving the running images. Local image repositories
use `HAIVE_INSTALL_ID` from the install's `.env`; missing or empty means the default `haive`, even
when the updater's ambient environment names another install. The new image/build settings are
resolved together with Compose's `.env` rules (quotes, comments and interpolation); current installed
version/registry references resolve from the install file rather than the updater image's baked target.
Preflight and the build share that snapshot. Malformed settings fail before any hold or pin write.
A failed pull/build changes
no pins or maintenance state. The journal records the registry and exact previous and target overrides before the first
hold, so migration/commit one-shots use the derived targets and rollback/crash recovery restore the
previous references. Old journal rows without image overrides retain their original registry/tag
behavior. Do not prune previous local images before upgrading: preflight checks those exact references.
Vendor delivery must run the existing channel leak/token/module gate on the complete derived image set;
the builder does not replace entitlement/channel resolution or publication gates.

### Install sources (admin Modules page)

The admin Modules page records where each own module comes from (`module_sources`, migration 0221)
and fetches it into `HAIVE_OWN_MODULES_HOST_DIR`. It is live only on a published-image install:
`HAIVE_PUBLISHED_INSTALL: 'true'` is set for api and worker in `docker-compose.run.yml` and nowhere
else, so a source checkout gets 409 `source_checkout` on every write and the page shows a read-only
note pointing at `pnpm module add`. Saving or fetching never builds or swaps an image: a pinned
module applies at the next upgrade or an explicit build of the one-shot above.

- A row is a git source (https URL without userinfo, query or fragment; a bare branch, tag or
  40-hex SHA as ref) or a registry source (`@haive-module/<id>` at an exact version). The module id
  is unique.
- The access token is install-wide per source, stored by `SecretsService` in `system_secrets`
  under `module_source:<id>:token`, and never returned: responses carry `hasToken`. A blank token
  on edit keeps the stored one; an explicit clear removes it. Every add, edit, delete, fetch and
  refresh writes its audit row in the same transaction and fails with it. Changing a source's
  identity clears `resolved_sha` and its fetch state.
- Fetch (`POST /modules/sources/:id/fetch`) queues a job on its own queue (`QUEUE_NAMES.MODULE_SOURCE`,
  concurrency 1). The worker clones through the hardened git path, resolves the ref to a commit SHA
  once and stores it in `resolved_sha`; later fetches build that SHA. Only Refresh (`refresh: true`)
  re-resolves the ref to a newer commit. Status moves `queued`, `fetching`, then `pinned` or
  `failed` with a scrubbed `last_error`; a 10s sweep re-queues rows left `queued` or `fetching`.
- Registry fetch is refused with 409 `registry_fetch_unsupported`: published packages ship `dist`
  only, which the own-module builder cannot rebuild. Use a git source.
- The worker never resolves the host directory by name. It streams the validated tree (no nested
  `.git`, links or special files; depth, entry and size limits) as tar into a helper container run
  from the worker's own image (`--pull never`) with the directory bind-mounted, which stages it,
  writes `.haive-source.json` (url, ref, sha), and swaps it into `<dir>/<id>` with `renameat2` under
  `flock` LOCK_EX. The builder's snapshot takes LOCK_SH, so a build never reads a half-written pin.
  A module folder without a valid marker (placed by hand) is never replaced. Leftover
  `.<id>.tmp-*` stages are removed by the next pin of that id.
- Deleting a source removes the row and its token but keeps its pinned folder; remove the folder
  by hand to drop the module from the next build.
