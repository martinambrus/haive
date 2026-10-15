# Modules

A module is a package named `@haive/module-<id>` (a workspace folder under `modules/<id>/`) or
`@haive-module/<id>` (published to the registry; `modulePackageId` in `@haive/shared/modularity` is
the one rule: `gen-modules` refuses a package that exports `./manifest` under any other name, and both
loaders refuse at boot a manifest whose id does not match its name), whose
`package.json` exports `./manifest` and any of `./routes` (api), `./steps`, `./ensure-schema` and
`./jobs` (worker), `./web` and `./dashboard` (web). `scripts/gen-modules.mjs` turns the installed
ones into four gitignored registries (`packages/api/src/modules.generated.ts`,
`packages/worker/src/modules.generated.ts`, `packages/web/src/generated/module-pages.ts` and
`module-dashboard.ts`), and the `dev`, `build` and `typecheck` scripts of the api, worker and web run
it first, as do the `test` scripts of the api, worker and web.

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
  render for that user, while its declared pages without data endpoints still do.
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
  they next run one of the module's steps. The answer reports `stopped` (with `killError` when the
  kill threw after the stop committed, and `eventError` when the event or audit write failed),
  `left` and `failed` (only a stop transaction that threw); the page shows the counts and names each
  task it could not stop or whose kill or record failed. The code stays loaded: its api routes and
  settings answer 404, `GET /modules` leaves it out (nav, pages, dashboard widget; compiled module
  pages and widgets render only for modules that list names) and the composer palette drops its steps.
  The worker starts no job of a module that is deactivated when it boots; a job already running stops
  at the next worker start. A task type that uses the module, as its source or through any step, is
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
  by typing its id. It is refused while the api or the worker loads the module, before the worker
  has reported what it loaded, and while a live task (a dead one included) uses it. It drops the
  module database without FORCE (a connection still on it refuses the purge), deletes the
  `config:module:<id>:*` settings, deletes the module's task types no task uses (the others are kept
  and listed) and deletes the `modules` row. Every step is safe to repeat: a purge that failed after
  the drop answers 502 `module_purge_incomplete`, and the next one finishes it. The dialog warns
  when the module's teardown hook never ran.

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
generated imports follow the api's.

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
held dependency of another version in place. It resolves only once the `@haive-module` scope has a
registry line in `.npmrc`.

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
