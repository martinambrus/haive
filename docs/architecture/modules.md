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
  reactivation; after the last one the worker logs an error and its report marks the module failed
  (below), until a Retry or the next deactivation and activation. A pass sees an activation by the
  module row's `updated_at` too, which every activate, deactivate and Retry moves: when the stamp differs from the previous pass's (the first pass only records
  it), the module counts as activated again, so its attempts start afresh, a start still running from
  before is not counted if it fails, and a module that is not running its jobs is tried again. A
  deactivation and activation that both fall between two passes are seen this way; any other write
  to the row does the same to an idle module. Activating a module also runs a pass at once: the api
  publishes its id on `MODULE_ACTIVATED_CHANNEL` when the activation has committed (never awaited, so
  a Redis outage cannot fail the request), the worker's `startModuleActivationWatch` hears it and its
  `ModulePassScheduler` (`modules/pass-scheduler.ts`) starts the pass without waiting for the
  interval. A request that arrives while a pass runs makes exactly one more pass run right after it,
  since the activation may have committed after that pass read the rows, and the 15 s interval stays
  as the fallback for a message that never arrives. The worker's report in Redis
  (`MODULES_LOADED_WORKER_KEY`, read by `GET /modules/loaded`) carries a `runtime` for each loaded
  module that has jobs or an ensure and is not deactivated: `state` (`ready`, `pending`, or `failed`
  once `MODULE_REACTIVATION_ATTEMPTS` are spent), `schema`, `jobs`, `attempts` and the last failure's
  `reason` (through `scrubErrorPaths`, at most `MODULE_RUNTIME_REASON_MAX` = 500 characters). Boot
  writes the report; after that the worker rewrites it, never awaited, when an attempt starts or ends
  and at the end of each pass, only when some runtime changed, and a failed write is tried again at the
  next change; `at` is the last write. A module held back at boot has no `runtime` until the first
  pass. The Active column shows a configured-active module whose `runtime.state` is `failed` as
  **Failed** with the reason and a **Retry**, and one that is `pending` as **Starting** with no Retry;
  it keys on the state, never on the reason, and the page reloads every 5 s while a row that is not
  deactivated is not ready. Retry is `POST /modules/:id/retry` (admin; foreign origin refused): under
  the module row's lock (5 s `lock_timeout`, 503 `module-busy`) it writes a `module.retry` audit row
  and moves only `updated_at` in one transaction (404 unknown, 409 `module_inactive` when
  deactivated, a drain left as it is), then publishes on `MODULE_ACTIVATED_CHANNEL`; the changed stamp
  makes the worker's next pass start the module afresh with its attempts reset. The api's loader
  writes each module's settings defaults with `setIfAbsent` (SET NX) at boot and retries only that
  write, per call, while the configuration store is unavailable, so a blip does not end the boot and
  no route is mounted twice (`installModules` runs once). The worker writes its module report only
  after bootstrap, so `GET /modules/loaded` lacks the worker half while the store is down. Boot waits the same `MODULE_JOB_START_WAIT_MS` on each
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
  again, at most three times per reactivation, and after the third the flag reads failed (the worker
  error log, the waiting steps' line and the module's **Failed** state on the Modules tab say so)
  until a Retry, or a deactivation and an activation, tries again. On the server a statement the ensure had already sent ends about half a second after the pool
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
- Preflight, before any network use: the tag's tree must hold `scripts/module.mjs`, `scripts/gen-modules.mjs`,
  `scripts/own-module-builder.mjs`, `docker/own-module-builder/Dockerfile`, `packages/api/package.json`, and, in
  each of the builder, api, worker and web Dockerfiles, an `id=npmrc` secret mount and a `production` stage
  (whole comment lines ignored, as Docker ignores them). v0.2.0 and older are refused
  (exit 2, the missing or unreadable file or the missing stage named). The working tree's `scripts/channel-gate.mjs` and
  `scripts/smoke/scan-image.sh` must be clean, because the gate runs from this checkout, not from the tag.
- Modules: `module add` runs once per entitled package inside the tree. A `modules/<dir>` counts as a local module
  only as `gen-modules` counts it: its package exports `./manifest` and the tag's api `package.json` depends on
  it. Its web parts are read from its `./dashboard` and `./web` exports; a folder without `package.json` is
  skipped, an unreadable or malformed one stops the build with its path named.
- Token: it reaches pnpm and BuildKit only as a private 0600 `.npmrc` in scratch (`--secret id=npmrc`), never
  argv, env or a build ARG. Streamed output is scrubbed of it across chunk boundaries. Scratch, the pnpm cache
  (`XDG_CACHE_HOME`) and the secret are removed on every path; a cleanup failure prints the leftover path and
  keeps the exit code.
- Images: api and worker are built with `--target production`, `--load`, `HAIVE_VERSION` and the build
  platform, tagged `<registry>/haive-<channel>-<host>:<version>`. The builder
  (`docker/own-module-builder/Dockerfile`) is built the same way from the same prepared tree as
  `haive-<channel>-builder`, always, because a channel install may add own modules later: it is the paid+own
  customer's builder, and it bakes in the entitled packages and their pnpm store but never the token. Web is rebuilt only when an entitled module
  exports web parts. Otherwise the stock `<source-registry>/haive-web:<version>` is pulled for that platform.
  `--source-registry` defaults to `HAIVE_REGISTRY`, then `ghcr.io/martinambrus`. An existing local tag is
  refused unless `--replace` is given. Default BuildKit attestations are kept. The gate's `docker save`
  accepts both a `--load` build and a single-platform pull of a multi-platform index on the containerd image
  store (one manifest entry), measured 2026-11-05.
- Result: the gate's exit code. Only on exit 0 is `<out>/build-record.json` written. A stale record is deleted
  before building, and a failed run leaves its tags for diagnosis. The record carries `"schema": 2`, the tag,
  commit, channel, version, platform, the docker image store, and per image its `ref`, `built`, `id` and, for
  the stock image, its `repoDigest`. Ids are read before and after the gate, and a change is refused. Under
  the containerd store `id` is the index digest; under the classic store it is the config digest. Schema 2
  adds `images.builder`; the boot check still reads a schema-1 record, publish refuses one (exit 2, "record
  has no builder"), since an older publisher would silently drop the builder.
- Gate: the builder is scanned with the api and worker rules (module footprint, `.npmrc`, token bytes, version
  stamp). It has no compiled module registry, so its module set is read from
  `/app/packages/{api,worker}/package.json` dependencies and the installed module metadata.

### Boot check (`scripts/channel-boot-check.mjs`)

`node scripts/channel-boot-check.mjs --record <build-record.json> [--timeout-ms <n>]` boots a built channel
and proves which modules its processes actually load. Plan item 9a requires it once per build, before
publishing, because an image carrying another customer's module is the one defect a later release cannot undo.

- Stack: one throwaway network with Postgres and Redis (the compose images), the migration applier, then the
  api and the worker, each run by its recorded image `id` with `--pull never` and the record's platform. A ref
  that no longer resolves to the recorded id is refused (exit 2). No `docker.sock`, no `--privileged`, no host
  bind mount; the api publishes one ephemeral port on 127.0.0.1. Web is not booted.
- Names are `hbc-<channel>-<random>`, never `haive-*`, and the network, both volumes and every container carry
  the label `haive.boot-check=<that name>`, so anything a killed run leaves is findable (images cannot be
  labelled). Containers, volumes and the network are removed on every path; SIGINT, SIGTERM and SIGHUP abort
  the run into that cleanup, a repeated signal does not interrupt it, and an EPIPE or EIO on stdout (a closed
  terminal) is ignored at any time so the cleanup finishes. A Postgres or Redis image is removed only when this run proved it absent before pulling it;
  a pull that failed leaves nothing to remove.
- Secrets (database password, encryption key, setup token, admin password) are generated per run, passed by a 0600 env file in a
  private temp dir outside the repository, and scrubbed from every printed line, failure logs included.
- Check: it registers the bootstrap admin and polls `GET /modules/loaded` until the worker half has reported.
  The ids each half loaded must equal the record's `modules` (entitled registry packages plus the tree's local
  ones). Exit 0 equal, 1 mismatch with one `OFFENDER` line per extra or missing id per half, 2 could not check
  (bad record, boot failure, timeout). `--timeout-ms` bounds each boot stage, not the whole run.
- Scope: it proves what LOADED, from the baked module registry. A package present in an image but not
  registered is invisible to it; the leak gate (`channel-gate.mjs`) proves what is PRESENT. Publishing must
  run both.

### Publishing a channel (`scripts/publish-channel.mjs`)

`node scripts/publish-channel.mjs --record <build-record.json> [--registry <prefix>] [--out <dir>] [--dry-run]
[--confirm-absent <ref>]... [--timeout-ms <n>]` publishes one gated build. The record exists only when the
leak gate passed; the script runs the boot check itself (the imported `run`, not a second copy) and pushes
nothing unless it exits 0.

- Order: re-check every recorded image `id` against its ref (mismatch exit 2), boot check, prove that EVERY
  destination tag is absent, print the plan, push api, worker and builder, copy the stock web, re-read each
  pushed digest, write `release.json` locally (no-overwrite), then build and push the manifest image LAST.
  `--dry-run` stops after the plan and also refuses an existing `release.json`.
- Destinations: `<registry>/haive-<channel>-{api,worker,web,builder,release}:<version>`, `<registry>` the record's own api
  prefix unless `--registry` says otherwise. What is pushed is the single platform image manifest the gate
  scanned: BuildKit attestation manifests that ride along with a `--load` build are left out, and the stock
  web is copied by the platform digest inside its recorded `repoDigest`.
- Manifest: produced by the `build-release-manifest.mjs` and migrations of `record.commit` (`git archive`),
  not the working tree, so `migrationHead` and `contracts` describe the tagged tree. `images` hold pinned
  `<repository>@sha256:<digest>` refs, because a channel's images live in channel-named repositories a bare
  digest cannot be pulled from. `images.builder` is optional in the schema and set only by a channel publish;
  the public manifest has none. A public updater ignores `images` and composes refs from the version; a
  channel install upgrades to exactly these pins (see "Upgrading a channel install").
- Manifest image: `haive-<channel>-release:<version>` is `FROM scratch` with one file, `/release.json`
  (byte-identical to the local file), and the label `org.haive.release=1`. Its build context is a fresh
  scratch directory holding only that file and the Dockerfile. It gets the same absence proof,
  `--confirm-absent` and digest re-read as the others. An install reads it with `docker create`, `docker cp`
  and `docker rm`, so one registry credential reaches both the manifest and the images.
- Absence proof, fail-closed: a tag counts as absent only when the authenticated
  `docker buildx imagetools inspect` exits 1 with a line that is exactly `ERROR: <ref>: not found` (MEASURED
  on ghcr.io and `registry:3`) AND an anonymous registry GET (with the registry's anonymous Bearer token,
  same https host only, when it answers 401) returns 404 with only `MANIFEST_UNKNOWN`/`NAME_UNKNOWN` errors.
  When that anonymous read is denied (MEASURED: ghcr.io answers 401, and its anonymous token is DENIED for a
  repository that does not exist yet), the daemon's line decides alone. That shape sits in one constant
  marked volatile, so a reworded daemon or a normalized ref refuses rather than overwrites; an unrelated
  `not found` (a missing credential helper) does not count. Any other failure, `failed to authorize`
  included, exits 2. A first publish to a new private repository can prove neither:
  `--confirm-absent <exact ref>` is the operator's statement that it is absent, accepted only for a
  destination whose proof was denied, never for a 5xx, a network error or a tag seen present. UNMEASURED: an
  authenticated inspect of a missing tag in a private ghcr repository.
- Credentials: the operator's docker credential store. The script never runs `docker login`, never takes a
  token flag, and never prints a token or a helper's output.
- Local tags: a destination tagged locally for a push (the manifest image included) is put back as it was when
  anything between the tag and the push fails: the tag that existed before the run is restored, a tag the run
  created is removed; when the removal fails but a re-inspect finds the tag absent, nothing is reported. SIGINT,
  SIGTERM and SIGHUP abort the run, and the boot check inside it, into cleanup.
- Commands both scripts run go through one runner (`scripts/channel-capture.mjs`, `createCapture(<MiB>)`): each
  caller keeps its own output cap, a timeout fails with code `ETIMEDOUT`, and an abort or timeout sends SIGTERM
  then SIGKILL one second later.
- Exit 0 published; 1 a gate said no with nothing pushed (boot-check mismatch, an existing tag); 2 could not
  publish. A failure after a push exits 2 and names every attempted and verified remote ref; nothing remote is
  ever deleted, and a re-run then refuses on the existing tag. A failure before `release.json` is written
  leaves no manifest. A failure building or pushing the manifest image leaves the runtime tags public and
  keeps the local `release.json` (named in the error), with no install able to read it yet. Only then does the
  script print `recovery` lines: inspect the release ref first, then a shell-quoted command that rebuilds the
  manifest image from the retained file and pushes it. They name paths and refs only, never a credential.
- Limits: the absence check and the push are not atomic (registry tag writes are unconditional), so two
  concurrent publishers of one version can race; only registry-side tag immutability closes that. The script
  imports `packages/shared/src/release/manifest.ts`, so it needs the repository's installed dependencies and
  a Node with type stripping.

### Installing a channel

`install/install.sh --channel <c> --registry-user <u> --version <v> [--channel-registry <prefix>]` (PowerShell:
`install.ps1 -Channel <c> -RegistryUser <u> -Version <v> [-ChannelRegistry <prefix>]`, which also takes the GNU spellings and
the base's bare positional order Version, Dir, InstallId, Channel)
installs a channel from its private registry. `<c>` and `<prefix>` follow the build-channel CHANNEL and PREFIX rules;
the prefix defaults to `ghcr.io/martinambrus`. Without `--channel`, or with `public`, nothing below happens and the
public output (`.env`, `./haive`, the uninstall script) is unchanged. A channel has no `latest`: the version is
required and its absence refuses.

- Token: from `HAIVE_REGISTRY_TOKEN` (removed from the environment at once) or a no-echo prompt that restores the
  terminal on every exit. It reaches `docker login --password-stdin` only, never argv, a file the installer
  writes or a message.
- Order: a scratch `DOCKER_CONFIG` (0700, `config.json` 0600, seeded with an empty auth entry so Docker Desktop does
  not pick a credential helper) holds the login. The installer pulls `haive-<c>-release:<version>`, reads
  `/release.json` by `docker create` + `docker cp` + `docker rm -f` (removed on every path), caps it at 1 MiB, and
  parses it with a strict JSON reader in awk (duplicate keys, escapes in keys and nesting past 64 refused). The
  manifest's `channel` and `version` must equal the request, and the `api`, `worker`, `web` and `builder` pins
  must each be `<prefix>/haive-<c>-<host>@sha256:<64 lowercase hex>`. Any failure refuses before the install
  directory is touched; there is no public fallback.
- Contexts: the daemon the user selected (`DOCKER_CONTEXT`, else the user config's `currentContext`) keeps
  working under the install credential. For each non-default name only `contexts/meta/<sha256(name)>` and
  `contexts/tls/<sha256(name)>` are copied, links dereferenced so nothing is changed in the user's store; a
  missing hash tool, a hash that is not 64 lowercase hex or a missing meta dir refuses. Both are kept in
  `<install>/.docker`; `currentContext` is written only when the user config named a non-default one, so a
  context selected by `DOCKER_CONTEXT` alone is used by `./haive` only from a shell that still sets it.
- Written: the keys under "Upgrading a channel install" go to `.env` (0600), and the scratch config becomes
  `<install>/.docker` only after `.env` is written, so a failure before then leaves no credential in the install
  directory and a `--force` retry works. The final `.docker` is claimed by an exclusive `mkdir`, so a destination
  that already holds one (or a link by that name, or a concurrent installer's) refuses; a run that loses the claim,
  fails or is interrupted afterwards removes only the `.docker` and `.env` it created, and `config.json` is 0600
  after the move. The install directory is normalised to the lexical form the updater
  compares (`./x`, `/./` and a trailing slash collapse), and a channel install refuses `..` and characters outside
  letters, digits, spaces, `_`, `-` and `.`. The PowerShell installer re-applies the owner-only DACL (or POSIX
  0700/0600) after the move.
- `--check`: login and manifest read under the scratch config, then removed; writes nothing.
- Generated `./haive`: reads `.env` as data (it never sources it) and exports `DOCKER_CONFIG` for compose, so
  `up` and `pull` use the install credential. `upgrade` runs the updater with `--channel`,
  `--manifest-image <prefix>/haive-<c>-release:<v>`, `--version`, `-e DOCKER_CONFIG=/install/.docker`,
  `-e HAIVE_INSTALL_DIR_HOST` and any extra arguments after the image (`--change-channel <c>`, `--check`). On every install, public included, `DATABASE_URL` and `CONFIG_ENCRYPTION_KEY` pass
  to the updater by name with the values in the docker child's environment only, as the api's POST /upgrade does.
- Uninstall: the generated script also removes `<install>/.docker`.
- Tests: `scripts/test/install-channel.test.mjs` runs both installers against a fake docker that records argv.
  CI's `Module scripts` step runs the shell controls; `platform-checks` `installer-controls` runs both shells on the
  pinned PowerShell image plus the public byte-identity baseline against full git history, and fails rather than
  skips when either is missing. UNMEASURED: native Windows DACLs across volumes and Windows PowerShell 5.1.

### Upgrading a channel install

A channel install's `.env` holds `HAIVE_CHANNEL`, `HAIVE_CHANNEL_REGISTRY`, `DOCKER_CONFIG=<install>/.docker`
and the three `HAIVE_{API,WORKER,WEB}_IMAGE` pins. Absent or `public` means a public install, whose upgrade path
is unchanged. `HAIVE_REGISTRY` stays the public registry: the updater image and the stock services are not
per-customer.

- Trigger: the admin page's POST /upgrade passes `--channel <c>`,
  `--manifest-image ${HAIVE_CHANNEL_REGISTRY}/haive-<c>-release:<version>`, `-e DOCKER_CONFIG=/install/.docker`
  and `-e HAIVE_INSTALL_DIR_HOST`, names only, never a token. It refuses a channel or registry that fails the
  build-channel CHANNEL/PREFIX rules. GET /upgrade reports `channel`. `docker-compose.run.yml` passes the three
  keys to the api.
- Credential: the updater applies the install `DOCKER_CONFIG` to its own docker calls before recovery and
  the manifest read, from the one read of `.env` made under the lock (a dry plan takes no lock and reads it up
  front). It must equal `<host install dir>/.docker` (refused otherwise), translated to
  `/install/.docker` inside the api-launched container. The own-module builder gets that directory mounted
  read-only plus `BUILDX_CONFIG=/tmp/buildx` and `DOCKER_HOST=unix:///var/run/docker.sock`, because buildx refuses a read-only `$DOCKER_CONFIG/buildx`
  (MEASURED: `mkdir ...: read-only file system`). Every updater and builder container that reads the install
  `.docker` (`./haive upgrade` in both shells, POST /upgrade, the builder) pins that `DOCKER_HOST`: a context kept
  for the host points at an endpoint the container cannot reach, and the container reaches the daemon only
  through the mounted socket. A public install's docker calls see no change.
- Manifest: `--manifest-image` and `--manifest` are exclusive, and a channel install requires the image (with
  `--version`); argv errors exit 2. A run with no target still finishes an interrupted upgrade first. The image must be `${HAIVE_CHANNEL_REGISTRY}/haive-<channel>-release:`; the
  updater reads `/release.json` by `docker create` + `docker cp <ctr>:/release.json -` + `docker rm -f` of a temp
  container, removed on every path. The tar stream is capped while it is read (1 MiB payload) and must hold one
  plain `release.json` entry with a valid header checksum; anything else refuses, and nothing is extracted. The
  image is pulled even when cached and kept afterwards (a few KB per version): a presence probe cannot prove this
  read owns it while another process may pull the same ref. A failed container removal after a successful read
  throws; after a failed read the read error wins and the removal failure is reported as a `warning` event naming
  the container. A manifest whose `channel`
  or `version` differs, or an image that cannot be pulled, refuses. There is no public fallback.
- Images: without own modules the overrides are the manifest's pinned api/worker/web; with own modules the base
  images and the builder come from the manifest, and a manifest without `builder` refuses. Every pin must be in
  `${HAIVE_CHANNEL_REGISTRY}/haive-<channel>-<host>`. The `.env` settings are read under the upgrade lock, so
  the journal's previous images are the ones in force; a channel install with no current pins, or with only some
  of the three, refuses (`rollback-images-missing`). Rollback inventory lists digest forms (`repo@digest` and
  `repo:tag@digest`) for a channel install and for a public install whose overrides carry a digest, so digest
  pins pass preflight.
- `--dry-plan` (channel installs only) prints the computed image plan from the manifest and touches no database.
- Revocation: the vendor revokes the token; the next pull fails closed and the running stack keeps running.

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
  concurrency 1). The worker resolves its own image first (the pin helper runs from it), so a
  missing image fails before any git process or transfer. It clones through the hardened git path,
  resolves the ref to a commit SHA once and stores it in `resolved_sha`, with the namespace it came
  from (`refs/heads/<ref>`, else `refs/tags/<ref>`; a branch wins when both exist) in
  `resolved_ref` (migration 0222); later fetches build that SHA, and when a fetch by SHA exits
  non-zero the fallback fetches the recorded namespace, so a tag is never read as a same-named
  branch. A fetch by SHA that gives no answer (timed out, no exit status) does not fall back; it
  fails as "Module git fetch failed". A ref that is itself 40 lowercase hex and names no branch or
  tag on the remote is taken as that SHA on its first resolution: it is fetched by object,
  `resolved_ref` stays NULL, and a server that refuses the object ends `module_source_ref_unavailable`.
  A branch or tag with that name pointing at a different commit refuses
  (`module_source_ref_ambiguous`), so a SHA pin never builds another commit. A row pinned before
  0222 has no namespace: the fallback lists both and takes the one still
  pointing at the pin, else the branch; a ref that moved refuses (`module_source_ref_moved`), a ref
  that exists as neither refuses (`module_source_ref_unavailable`), and a fallback fetch that gives
  no answer (timed out, no exit status) fails as "Module git fetch failed". Only Refresh (`refresh: true`) re-resolves
  the ref to a newer commit, and it clears `resolved_ref` with `resolved_sha`. Status moves
  `queued`, `fetching`, then `pinned` or `failed` with a scrubbed `last_error`; a 10s sweep
  re-queues rows left `queued` or `fetching`.
- Size: the module tree limit (64 MiB) is enforced while git writes, not only afterwards
  (`boundedTransfer`). The fetch counts the packed objects under `.git`, the checkout counts the
  expanded work tree, each polled every 25 ms through no-follow reads and checked once more on
  exit. Past the limit, on a timeout or on overflowing output the git process group is stopped
  (SIGTERM, SIGKILL after 1 s, released after 2 s) and awaited before the temporary tree is removed,
  so no index-pack writes behind the removal; a size breach fails the row with "Module tree exceeds
  size limit". The poll is approximate by one interval; the exit check is exact, and pack overhead
  counts. The poll also refuses a tree deeper than 32 levels or past 5000 entries (files,
  directories and links alike; the same `MODULE_TREE_ENTRIES` limit the finished-checkout
  validation applies), failing the row with "Module tree exceeds entry limit". A single
  directory is listed whole before its entries are counted, so the entry poll is bounded by one
  directory listing rather than one interval.
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
