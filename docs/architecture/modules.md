# Modules

A module is a workspace package under `modules/<id>/`, named `@haive/module-<id>`, whose
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
  `module_tasks_open`, which the page shows as a list of up to 200 tasks, while a live task's run list
  names one of the module's steps or its type is one the module seeded. The code stays loaded: its api routes and
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
  `config:module:<id>:*`.
- **Purged.** Purge on `/admin/modules`, offered for a `Missing` module only (not built yet: M11d).
  Nothing runs and nothing is kept: the data is deleted.

Purge is an action of the admin page and lands in a later change. `pnpm module` never deactivates or purges anything and never touches
the database or Redis: it moves a module between the first and third states, and nothing it does
loses data. A task whose data names a step of a module this install no longer registers is marked
dead, not failed (`UnresolvedStepError`, `step-engine/registry.ts`). A module this install never
loaded has no row, so removing it leaves nothing for `/admin/modules` to show.

## What the build requires

A module is **installed** when `@haive/api` depends on it (`"@haive/module-<id>": "workspace:*"`).
`@haive/worker` must depend on exactly the same modules, and `@haive/web` on exactly the installed
ones that export `./web` or `./dashboard`, so the api and the worker always load the same set. Any
other combination is a half-installed state: `gen-modules` exits 1, naming the side and the
`package.json` to change.

A folder under `modules/` that exports `./manifest` and that nobody depends on is **present, not
installed**. `gen-modules` prints `present, not installed: pnpm module add <id>`, leaves it out of
every registry and exits 0, so a module folder you are not using does not break the build. The images
still copy and build every folder under `modules/`; an uninstalled one is dead weight there and is
never loaded.

## Installing and removing from a source checkout

From the repository root:

```bash
pnpm module add <id>      # or: pnpm module remove <id>
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

A dependency change reaches the dev stack only through `pnpm docker rebuild` with no service name
(see Build commands in `AGENTS.md`); a restart or a per-service rebuild is not enough. Recreating
the worker interrupts live CLI terminals and running steps, so look at the active tasks first. Once
the worker has booted, `/admin/modules` reads the module as `Loaded` after an add and as `Missing`
after a remove.

## Published-image installs

An install that runs published images (`docker-compose.run.yml`, see
[Cutting a release](release.md)) has no pnpm and no source checkout, so `pnpm module` does not
exist there. Which modules it carries moves with the images it runs, and `/admin/modules` shows the
same states either way.
