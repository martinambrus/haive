# Haive Module System — Task 1: Extension Infrastructure

## Context

Haive today is fully static and build-time. Every extension point is a hardcoded array or
static-import list: web nav (`BASE_NAV_ITEMS`), API route mounts (`createApiApp`), the CLI adapter
registry, the step registry, the template manifest, the queue starts, and the admin settings page
(1132 lines, one hand-written card per config key). There is no plugin/registry seam anywhere and no
dynamic discovery.

The goal is a module system: a self-contained package (potentially closed-source, cloned from a
private git repo) that plugs in and adds a nav menu item, its own pages (e.g. a Statistics dashboard
plus subpages), global settings, and admin settings — without editing core registration files per
module.

User decisions that scope this plan:
- Attach model = REBUILD ON INSTALL. A module is a build-time workspace package; it is cloned in and
  the images are rebuilt. No runtime hot-load. This sidesteps the Next.js `output: 'standalone'`
  build-time wall and keeps closed-source out of the OSS core (assembled at each customer's build).
- Module UI = GENERIC RENDERER + ESCAPE HATCH. Most modules ship a dashboard SPEC (data) rendered by
  a generic core renderer; a compiled-React path exists for modules that outgrow it.

This plan is Task 1 only — the open-sourceable extension infrastructure. Task 2 (commercialization:
per-user entitlement/license model, extending the `custom_bundles` clone pipeline to deliver module
CODE, paid gating) bolts on top later and is out of scope here. Task 1 leaves a single stubbed seam
for it (`entitlementId`, no-op gate).

## Key architectural facts (grounded in research)

- Workspace discovery is glob-based: `pnpm-workspace.yaml` is one line `packages/*`; turbo auto-orders
  builds by the `workspace:*` dependency graph with zero package references. Adding a `modules/*` glob
  makes any folder under `modules/` a first-class workspace package — one core edit, once.
- The Dockerfiles (`packages/{worker,api,web}/Dockerfile`) enumerate every package by name at three
  stages. This is the real ship-layer blocker. Modules are unknown at core-build time, so the fix is
  wholesale `COPY modules` + `pnpm --filter './modules/*'` glob builds, guarded for the zero-modules
  case.
- The generic UI path means WEB never imports a module. Web fetches nav/pages/settings from the API at
  runtime. Consequence: installing a GENERIC module rebuilds api+worker only; the web image is
  unchanged and surfaces the new nav on its next server render. Only ESCAPE-HATCH (compiled-React)
  modules force a web rebuild.
- Reuse targets (mirror, do not reinvent):
  - `FormRenderer` (`packages/web/src/components/form-renderer.tsx`) + `FormSchema`
    (`packages/shared/src/schemas/form.ts`): a discriminated-union spec + `switch(field.type)`
    dispatcher. The `DashboardRenderer` is a 1:1 structural clone (`switch(widget.type)`), and module
    SETTINGS reuse `FormRenderer` directly (module ships a `FormSchema`).
  - `TemplateItem`/`buildManifest` (`packages/shared/src/templates/manifest.ts`): the versioned
    manifest-item convention (`id`, `schemaVersion`, auto `contentHash`) the `ModuleManifest` mirrors.
  - `BaseCliAdapter` (`packages/worker/src/cli-adapters/base-adapter.ts`): capability-boolean
    declaration style for "this module adds nav? pages? settings? routes? steps? db?".
  - `ConfigService` (`packages/shared/src/config/config.service.ts`): untyped Redis KV that already
    accepts any namespaced key. Module global settings live under `config:module:<id>:<key>`; defaults
    seeded via the existing `SETNX` `seedDefaults` mechanism.
  - Global KB / RAG `ensureSchema` (`packages/shared/src/global-kb/ensure-schema.ts`): the blueprint
    for a module owning its OWN database with an idempotent boot bootstrap. Module tables NEVER go in
    the core Drizzle barrel — `drizzle-kit push --force` treats the barrel as authoritative and can
    drop unknown tables.
  - `@haive/shared` `exports` map: cherry-picked web-safe leaf subpaths out of dirs that also hold
    server code. A module spanning web + server mirrors this so its web-facing code never drags server
    deps into the browser bundle.
  - Uniform Hono router contract (`new Hono<AppEnv>()`): every existing router self-applies
    `requireAuth`. Module routers drop into a mount loop unchanged. IMPROVEMENT over the core
    convention: the module loader mounts module routers behind `requireAuth` (and `requireAdmin` for
    admin-declared bases) BY DEFAULT, so a module cannot accidentally ship an open endpoint.

## Module package contract

A module is `modules/<id>/`, package name `@haive/module-<id>`, `type: module`, `build: tsc`, NodeNext,
`.js` import extensions — mirroring `packages/worker/package.json` + `tsconfig.base.json`. It declares
an `exports` map with these subpaths (all optional except `./manifest`):

- `./manifest` — the `ModuleManifest` (plain web-safe data, no server-side imports). Imported by api
  and worker; serializable.
- `./routes` — a factory returning `Hono<AppEnv>` (server; imported by the api loader).
- `./steps` — `StepDefinition[]` (server; imported by the worker loader).
- `./jobs` — optional BullMQ worker/queue registration (server; worker loader).
- `./ensure-schema` — idempotent own-database bootstrap (server; worker loader), mirroring global-kb.
- `./web` — escape-hatch compiled-React pages/components (web-safe only; consumed ONLY by the web
  build via codegen; never used by the generic path).

Discovery is build-time CODEGEN, not runtime fs-scan: a `scripts/gen-modules.mjs` step scans
`modules/*/package.json` and emits a generated static-import registry per consuming package
(`packages/api/src/modules.generated.ts`, `packages/worker/src/modules.generated.ts`, and for
escape-hatch only `packages/web/src/generated/module-pages.ts`). Static imports are ESM-clean, typed,
and honor the "a module nobody imports never executes" constraint. Generated files are gitignored and
regenerated in each package build (prebuild hook).

## ModuleManifest + DashboardSpec (new, in `@haive/shared`)

`ModuleManifest` (plain object; mirror `TemplateItem` versioning + `BaseCliAdapter` capability booleans):
`id`, `name`, `version`, `schemaVersion`, and optional capability declarations: `nav?` (items:
`{ href, label, icon?, adminOnly?, order? }`), `pages?` (id -> `DashboardSpec`), `apiBasePath?`,
`apiRequiresAdmin?`, `globalSettings?` (a `FormSchema` + key namespace + defaults), `adminSettings?`
(a `FormSchema`), `hasSteps?`, `ownsDatabase?`, `entitlementId?` (Task 2 seam, ignored in Task 1).

`DashboardSpec` (new Zod discriminated-union in `packages/shared/src/schemas/`, sibling of `form.ts`):
`{ title, description?, widgets: Widget[] }`. `Widget` = discriminated union on `type`:
`kpi` (Card + big number/Badge), `table` (hand-rolled `<table>`), `meter` (width-% bar), `markdown`
(`MarkdownView`), `status` (reuse exported `StatusSummary`), `chart` (line/bar/pie/area — the one
widget needing a new dep). Each data-bearing widget carries either inline data or an `endpoint` string
the renderer fetches via `api.get(endpoint)`.

## Slices (ordered, each independently reviewable and verifiable)

### Slice 0 — Workspace + build plumbing
- Add `- "modules/*"` to `pnpm-workspace.yaml`.
- Add `scripts/gen-modules.mjs` (scan `modules/*`, emit generated registries; no-op/empty output when
  none present) and wire it as a prebuild in api/worker/web.
- Update `packages/{worker,api,web}/Dockerfile`: wholesale `COPY modules ./modules` (guarded if
  absent), add `modules/*/package.json` to the deps stage, build `pnpm --filter './modules/*' build`,
  and copy `modules/*/dist` + `node_modules` in the production stage.
- Verify: full `pnpm docker rebuild` (per project ops) boots green with ZERO modules present — no
  regression. `pnpm build` + `pnpm typecheck` clean.
- Rollback: revert the workspace line + Dockerfile hunks; generated files are gitignored. Fully
  additive and reversible.

### Slice 1 — Manifest types + server loaders (api + worker)
- `@haive/shared`: add `ModuleManifest`, `DashboardSpec`/`Widget` schemas, and a `ModuleSettingSpec`.
- API loader: after the `app.route(...)` block in `createApiApp` (`packages/api/src/index.ts:57-79`),
  loop the generated registry mounting `app.route(mod.apiBasePath, withAuth(mod.routes))` (default
  `requireAuth`, `requireAdmin` when `apiRequiresAdmin`). Add generic endpoints: `GET /modules`
  (serve manifests straight from the api registry — no DB cache needed, api imports manifests
  directly), `GET/PUT /m/:moduleId/config` (backed by `ConfigService` namespaced keys, validated
  against the module's declared `FormSchema`; admin-gated for `adminSettings`).
- Worker loader: at startup register each module's `StepDefinition[]` into `stepRegistry`, start module
  queues (`./jobs`), run `./ensure-schema`, and seed module setting defaults (SETNX) via ConfigService.
- Add `entitlementId` no-op gate helper (always-allow) as the Task 2 seam.
- Verify: with a throwaway test module (one route, one setting), `GET /modules` lists it, its route
  responds behind auth, `PUT /m/<id>/config` persists and `GET` reads back.

### Slice 2 — Web data-driven nav + settings
- `packages/web/src/app/(app)/layout.tsx`: server-fetch `GET /modules` alongside the existing
  `/auth/me`, pass module nav items into `SidebarNav`.
- `packages/web/src/components/sidebar-nav.tsx`: extend nav item shape (icon?/order?/adminOnly?), merge
  module items into the rendered list (keep `BASE_NAV_ITEMS` static, append + sort by order, honor
  adminOnly).
- Module settings pages: render the module's `FormSchema` via the EXISTING `FormRenderer` against
  `GET/PUT /m/:moduleId/config` — a generic settings page (e.g. `/settings/m/[moduleId]`) and an admin
  section for `adminSettings`. No per-module settings UI.
- Verify: test module's nav item appears (admin-gated respected); settings save and reload.

### Slice 3 — DashboardRenderer + charts
- Add a charting lib to `packages/web` (recharts — React-native, Next-compatible, tree-shakeable).
- `packages/web/src/components/dashboard-renderer.tsx`: structural clone of `FormRenderer` —
  `spec.widgets.map` + `switch(widget.type)`; kpi/table/meter/markdown/status reuse existing primitives
  and the exported `StatusSummary`; chart uses recharts; data via `api.get(widget.endpoint)`.
- Generic module page route `packages/web/src/app/(app)/m/[moduleId]/[[...page]]/page.tsx`: resolve the
  page's `DashboardSpec` from the module manifest (served by the API) and render it.
- Verify: test module dashboard renders KPI + a chart with live data.

### Slice 4 — Reference module: Statistics + smoke
- Build `modules/statistics/`: manifest (one nav item, one dashboard page with subpages), a `./routes`
  serving aggregate counts read read-only from core tables via `getDb()` (acceptable for a first-party
  reference; a third-party module would use its own ingested DB — documented caveat), a dashboard spec
  (KPI tiles + a chart).
- Add an e2e smoke: nav item appears -> page renders -> KPIs/chart show correct aggregates.
- Verify: Playwright smoke green; manual check via the running stack + chrome-devtools MCP.

### Slice 5 — Escape-hatch scaffold (compiled-React modules)
- `scripts/gen-modules.mjs` also emits `packages/web/src/generated/module-pages.ts` importing each
  module's `./web` pages; a web route mounts them under `/m/:moduleId`. Web rebuild required for these
  modules (acknowledged).
- Keep minimal for Task 1 — the seam + one trivial example or a documented stub; the reference module
  uses the generic path.
- Verify: a stub escape-hatch page renders through the codegen import map.

## Cross-cutting rules

- Module DBs are separate databases with idempotent `ensure-schema` (deployable, re-runnable) — never
  the core barrel. This satisfies the project's "DB changes must be deployable + idempotent" rule and
  removes push --force drop risk.
- Module routers are auth-gated by default at mount (safe-by-default), fixing the core "forgot
  requireAuth = open endpoint" footgun.
- Module web-facing code (`./web`, manifest) must be free of server imports (ioredis/pino/pg), mirroring
  the `@haive/shared` web-safe subpath discipline, so nothing server-side leaks into the browser bundle.
- Every new global config key a module seeds is namespaced `config:module:<id>:*` and exposed through
  the generic `/m/:id/config` endpoint — no hand-written admin cards, no edits to the 1132-line
  `admin/page.tsx` per module.

## Verification (end to end)

1. `pnpm build` + `pnpm typecheck` clean across the workspace (per-container typecheck per project ops).
2. `pnpm docker rebuild` boots green both with zero modules and with `modules/statistics` present.
3. Log in; the Statistics nav item appears; its dashboard page renders KPI tiles + a chart with correct
   aggregates; a module setting saves and reloads.
4. Confirm the WEB image is unchanged by a generic-module install (only api+worker rebuilt) — validate
   the runtime-fetched nav surfaces the module without a web rebuild.
5. e2e Playwright smoke for the nav -> page -> data flow.
6. Adversarial: a module route with no auth declaration is still gated (loader default); a module DB
   bootstrap re-run is a no-op; removing the module + rebuild cleanly drops its nav/routes.

---

# Amendment — 2026-08-20: private module distribution + steps into the task catalog

*Appended after the original plan was archived; the body above is unchanged. Added to support a
resellable third-party module (the deep project analysis scan) that lives in its own private
repository and is cloned into `modules/` against an access key. Four things that Task 1 as written
does not cover, plus one thing it should state out loud.*

## A. Module-contributed steps must reach the composable step catalog

Task 1 exports `./steps` and the worker loader registers them, but the companion plan
(`rippling-wibbling-puffin`) composes task types from a **curated** `composable_step_catalog` — so a
module's steps are registered yet invisible to the composer, and no task type can use them. This is
the exact joint a step-contributing module sits on.

- Manifest gains `composableSteps?: ComposableStepEntry[]` — the same shape the core catalog uses
  (`stepId`, `label`, `group`, `dispatchesCli`, `requires`/`provides` capability tokens,
  `paramFormSchema?`).
- `syncComposableCatalog(db)` unions core entries with every loaded module's entries, namespaced
  `module.<moduleId>.<stepId>` so a module can never shadow a core step id.
- Boot ordering: the module loader must run before `syncComposableCatalog`, which itself already runs
  after `registerAllSteps`.

## B. Distribution: a private npm registry (GitHub Packages), not a git clone

**Decision (2026-08-20):** paid modules are published to a private npm registry and installed as
dependencies. A git clone against a deploy key was considered and rejected: it hands the customer
full source and complete history permanently, and revoking the key claws nothing back — the wrong
default for a closed-source resellable module. Git-based install is not built.

What this costs the plan is almost nothing, because the module *contract* is unchanged: a distributed
module is still a package with an `exports` map exposing `./manifest`, `./steps`, `./routes`. Only
**discovery** generalises.

- `scripts/gen-modules.mjs` scans `modules/*/package.json` **and** installed dependencies matching
  `@haive-module/*`, emitting one registry from the union. `modules/*` remains the path for
  first-party modules developed in this workspace; the registry is the path for distributed ones.
- The published package contains **compiled `dist` only** — `files: ["dist"]`, no `src`, no history.
- Versions are immutable and integrity-hashed into `pnpm-lock.yaml`, so an install is reproducible
  and a swapped artifact is detectable. This is strictly better than a branch tip.
- Root `.npmrc` gains the scope mapping (`@haive-module:registry=https://npm.pkg.github.com`) and
  reads the token from the environment. `.npmrc` stays committed; the token never does.

### The token must be a BuildKit secret, never a build ARG

The api and worker images install dependencies at build time, so the read token has to be present
during `docker build`. Passing it as `ARG`/`ENV` **bakes it into the image layers**, where anyone with
the image can recover it — including, for a distributed product, other customers.

- Use `RUN --mount=type=secret,id=npmrc` in the deps stage and pass `--secret id=npmrc,src=...` from
  compose/build. The token is present for the install and absent from every layer.
- `docker history` on a built image must show no token. Make that an explicit verification step, not
  an assumption.

## C. Install is add-dependency + install + rebuild + restart, and the UI must say so

Discovery is build-time codegen (Slice 0), so a module is only active once the api/worker images have
been rebuilt with it. Pretending a click installs it would produce a silent half-install — the
failure this project keeps designing against.

- Model install as an explicit lifecycle with a visible status:
  `requested → resolved (pending rebuild) → active`, plus `update_available`.
- A `modules` table records **intent**: `moduleId`, `packageName`, `requestedVersion`,
  `installedVersion`, `enabled`, `status`, `entitlementId`. It is not the source of truth for what is
  loaded — the loader's boot report is.
- The mechanical steps (add the dependency to `packages/{api,worker}/package.json`, `pnpm install`,
  rebuild) are a documented operator action driven by a `pnpm module add <pkg>` script, not something
  the admin UI performs silently on a running stack. The UI shows the status and the exact command.
- A module contributing routes/steps/jobs/nav requires an **api + worker** rebuild; web is untouched
  because nav and pages are runtime-fetched — this plan's own verification step 4 already asserts
  that. Only an escape-hatch `./web` module needs a web rebuild, so make that a manifest flag the
  installer reads to say which services to rebuild.
- The row flips to `active` on the **loader's boot report** of the module ids it actually registered,
  never on a successful `pnpm install`. That is the only evidence the rebuilt process loaded it.

## D. Entitlement: the registry token is the licence

`entitlementId` exists in the manifest with nothing behind it. With registry distribution the MVP is
honest and needs no new machinery: **a per-customer read token scoped to the `@haive-module` scope is
the licence.** Revoking it blocks future installs and upgrades, which is real enforcement — unlike a
deploy key, which only stops updates to a repository the customer already has in full.

- Record `entitlementId` and the resolved version on the `modules` row so an admin can see what
  authorises the install and what is running.
- Deliberately NOT in scope: a licence server, phone-home, or runtime key validation. A self-hosted
  product must work offline, and a check that fails closed on network loss would brick a paid install
  — a worse outcome than the piracy it prevents.
- Stated plainly because it is true of any JS product: a customer with `dist` can read `dist`.
  Distribution controls what you *hand over as the normal install path*; it is not obfuscation. If
  stronger guarantees are ever wanted, the honest options are a signed manifest verified against a
  public key pinned in core, or per-customer builds — named here so nobody assumes they exist.

## E. Trust boundary — state it, because Task 1 does not

A module's `./routes`, `./steps`, `./jobs` and `./ensure-schema` run **in-process inside api and
worker**. That is full trust — not the CLI sandbox that untrusted agent code runs in. Installing a
third-party module is a supply-chain decision equivalent to adding any other dependency, and the
admin install UI should say so plainly rather than implying a sandbox.

What does apply, and is worth listing beside that statement: module routers are auth-gated by default
at mount, module databases are separate with idempotent `ensure-schema`, and module config keys are
namespaced. Those are hygiene, not isolation.

## Verification additions

1. Install a private module with a scoped read token: status reaches `resolved (pending rebuild)`,
   and only after an api+worker rebuild does the loader's boot report flip it to `active`.
2. `docker history` on the built api and worker images reveals **no registry token** (proves the
   BuildKit secret mount, not an ARG).
3. An absent or revoked token fails `pnpm install` with a clear message and leaves the previously
   installed version running — a failed upgrade must not disable a paid module already in service.
4. A module's composable steps appear in the task-type composer palette (companion amendment F).
5. Removing the dependency + rebuild returns to the zero-module state, and any task-type definition
   that referenced the module's steps is disabled with a named reason rather than crashing
   (companion amendment G).
6. `pnpm build` + `pnpm typecheck` clean with zero modules present — the union discovery must be a
   no-op when neither `modules/*` nor any `@haive-module/*` dependency exists.

---

# Amendment — 2026-08-25: reversible teardown + loader introspection (from the DeepSeek/Cordis harness)

*Prompted by the DeepSeek `dsh` harness and its Cordis composition kernel (harness.pdf). Read
critically: most of what makes Cordis novel does NOT apply here, and saying why is the point.*

## What does NOT transfer, and why that is the right call

Cordis's headline is hot module replacement for a live agent — edit a plugin's source and the
runtime disposes the old version's effects and installs the new one WITHOUT restarting, rolling
back transactionally if the reload fails mid-way. That directly contradicts this plan's locked
decision (`Attach model = REBUILD ON INSTALL, no runtime hot-load`), which exists to sidestep the
Next.js `output: 'standalone'` build wall and to keep closed-source code assembled at each
customer's build rather than injected at runtime.

It is worth stating that the article's own skeptics land where this plan already stood: the HN
thread called plugin-everything "a pile of footguns," and nobody yet knows whether a harness needs
OSGi-grade dynamic composition "or whether a monolith with good hooks gets you 95% of the way."
This plan chose the monolith-with-good-hooks path deliberately. The harness is the seductive other
road; we are not taking it, and the reasons have not changed.

## A. The one real gap it exposes: removal has no inverse

Cordis's genuinely useful principle is temporal composability — every setup effect carries the
function that undoes it, so "uninstall stops being a prayer and becomes a proof obligation."
Applied to THIS plan (not to hot-reload, but to the removal lifecycle), it names a real hole:

- Install is covered. `ensure-schema` sets up a module's own database idempotently; the loader
  registers routes/steps/nav; config keys are seeded via SETNX.
- Removal is NOT. The plan says "removing the module + rebuild cleanly drops its nav/routes" — but
  that is only true of the in-memory registry. The module's DATABASE persists, its seeded
  `config:module:<id>:*` keys persist, its `onboarding_artifacts`-style rows (if any) persist, and
  its `modules`-table intent row persists. A removed module leaves state behind, and the next
  admin has no record of what to clean.

Fix, in the plan's own grain (data + boot-upsert, no runtime effect system):

- A module MAY declare `./teardown` — an idempotent inverse of `./ensure-schema` (drop its own
  database/schema, delete its namespaced config keys). Explicitly NOT auto-run on rebuild (a
  rebuild without the module is not a request to destroy its data); run only by an explicit
  `pnpm module remove <id>` operator action, the symmetric sibling of `pnpm module add`, which the
  admin UI surfaces as a distinct, confirm-gated "remove and purge data" step separate from
  "disable."
- What has no clean inverse must be declared, not pretended. A module that ingested into a SHARED
  table (the first-party Statistics reference reads core tables read-only, so it has nothing to
  undo; a hypothetical writer would) states so in its manifest, and `pnpm module remove` refuses
  to claim a clean purge it cannot deliver — the same fail-loud-rather-than-half-do discipline the
  rest of this plan uses.

This is temporal composability without the effect runtime: the inverse is a declared, idempotent
teardown script, matched to Haive's rebuild-on-install model.

## B. Loader introspection: make the boot report a real endpoint

The plan already says a module flips to `active` "on the loader's boot report of the module ids it
actually registered" — the only evidence the rebuilt process loaded it. Cordis's `--dump-config`
(print the exact composed plugin tree the running process is made of) is the same idea and worth
building concretely, because a half-install is this plan's stated recurring failure:

- Add `GET /admin/modules/loaded` (requireAdmin): the api and worker each report what they
  ACTUALLY registered at boot — module ids, their routes' base paths, contributed step ids,
  composable-catalog entries, seeded config namespaces, and `ensure-schema` result. Not the
  `modules` intent table (that records what SHOULD load); the live registry (what DID).
- The admin install page diffs intent against this: a row that is `active` in intent but absent
  from the loaded report is a half-install, surfaced with the exact reason (build succeeded,
  process did not register it) rather than a green checkmark that lies.

## Out of scope, stated so nobody assumes it

Runtime hot-swap, transactional mid-session reload, and a general `ctx.effect(do -> undo)` runtime
are NOT adopted — they are the parts of Cordis that presuppose the runtime-load model this plan
rejected. If Haive ever moves off rebuild-on-install (it should not, for the standalone-build
reason), revisit; until then, the declared-teardown script in A is the whole of the idea that fits.

---

# Amendment — 2026-08-25: concrete module lifecycle management (install/uninstall/activate/deactivate, dead tasks, live-task removal)

*Task 1 and the prior amendments cover the module CONTRACT, distribution, and the loader boot
report. They do NOT cover how a human actually manages a module day to day. This fills that in.
Grounded: task actions `cancel`/`pause`/`resume` exist (`routes/tasks/index.ts:881,897,959,979`)
plus STOP (kill-CLI-keep-env) and the GLOBAL_PAUSE+drain flow; `registry.require` THROWS on an
unknown step (`registry.ts:39`), so a removed module currently CRASHES dependent tasks rather than
degrading — the exact hazard sections K-L below close.*

## H. How a user installs a module — UI first, folder-drop for power users

Two entry paths feed the SAME discovery + rebuild; the plan's rebuild-on-install constraint is
unchanged (code cannot appear in a running process without a rebuild), so the UI records intent and
surfaces the rebuild rather than pretending to hot-load.

- **UI install (preferred).** A Modules admin page (own tab, sibling of `admin/pricing`) where the
  user adds a module by SOURCE, and the system fetches it to where it belongs:
  - `git`: a repository URL plus an OPTIONAL access token / deploy key for a private repo. The
    system clones the pinned ref into `modules/<id>/` (or a managed clone dir). The token is stored
    envelope-encrypted (the existing secrets machinery), never in plaintext, never in an image.
  - `registry`: a `@haive-module/*` package name plus a scoped read token (amendment B). This stays
    the path for PAID, resellable, closed-source modules — amendment B's reasoning (git hands over
    full source+history, a revoked deploy key claws nothing back) applies to RESALE specifically and
    is not contradicted here: a user installing a public or their-own module from GitHub has no
    source to protect, so a git URL is legitimate for that case. The UI makes the source type an
    explicit choice so the two models coexist without either pretending to be the other.
  - After fetch, the module is in state `installed (pending rebuild)`. The UI shows the exact next
    step (the `pnpm module add`/rebuild operator action, or triggers a build job if one exists), and
    the row flips to `active` only on the loader's boot report (amendment B/the introspection
    endpoint), never on a successful fetch.
- **Folder-drop (power users, must work, not preferred as the ONLY way).** A developer places
  `modules/<id>/` in the tree and it is picked up by the build-time codegen discovery (Slice 0). The
  Modules page LISTS folder-discovered modules alongside UI-installed ones, marked `source: local`,
  so a power user building their own module or task type sees it in the same management surface and
  can activate/deactivate it. Requiring folder-drop as the only install path is rejected.

## I. Four states, not two — the WordPress model, explicitly

DECIDED: install/uninstall AND activate/deactivate, all four. Drupal's install-destroys-everything
with no deactivate is rejected. The `modules` intent row carries two orthogonal axes:

- **Install axis** — `installed` vs `uninstalled`. Governs CODE PRESENCE, so it is rebuild-gated
  (adding/removing the workspace package or dependency + rebuild). Uninstall has the two data
  choices from the teardown amendment: KEEP data (default, reversible) or PURGE (explicit, runs
  `./teardown`).
- **Active axis** — `active` vs `deactivated`. Governs whether an installed module is USED, and is a
  LIVE DB FLAG the loader/api honor WITHOUT a rebuild: a deactivated module's routes return 404, its
  steps are not offered to the composer, its task types are not selectable, its nav is hidden — but
  its code and data stay in place. This is the WordPress "deactivate" — reversible instantly, no
  data loss, no rebuild. (Deactivation can be live precisely because it only STOPS using code that
  is already loaded; install/uninstall change what code EXISTS, which the standalone-build model
  requires a rebuild for.)

So the four reachable states: installed+active (normal), installed+deactivated (parked, data kept),
uninstalled+data-kept (gone but revivable), uninstalled+purged (gone, `./teardown` ran). The
Modules page exposes all four transitions.

## J. A module removed out from under the system (missing at boot)

The dangerous case: a folder-dropped module is deleted, or a dependency is dropped, and the system
restarts with the module GONE while its rows and tasks remain. `registry.require` throws today, so
this must be made graceful.

- The loader detects the mismatch: a `modules` row is `installed+active` but the code did not
  register at boot (the introspection endpoint's diff). The row is flagged `missing` (distinct from
  `deactivated` — the operator did not choose this).
- Its task types go not-selectable with a named reason (companion plan amendment G — the
  new-task-creation side).
- EXISTING tasks of that module become DEAD rather than crashing (section K).

## K. Dead-task handling — read-only, cancel-only, loudly flagged

A task whose module is missing must not crash the orchestrator or the task page. `buildRunList` must
detect an unresolvable step (its module is `missing`) and mark the task DEAD instead of calling
`registry.require` and throwing.

- The task page STILL RENDERS. Forms and step state live in Postgres (`task_steps`, the tasks row's
  `preAnswers` etc.) and are NOT purged on uninstall by default (section I), so the stored forms
  display. This is why keep-data is the uninstall default: purging would erase a task's own history.
- Everything that would ADVANCE the task is disabled: no retry, no stop, no abort, no CLI retry, no
  auto-continuation, no gate resolution. CANCEL stays enabled — the one action a dead task needs, so
  the user can clean it up. (Cancel tears down; it does not need the module's steps.)
- A RED, unmissable task-level banner renders at BOTH the TOP and the BOTTOM of the task page (a
  long task scrolls, so one placement is not enough), plus on the task in any list view: "This task
  uses the module `<name>`, which has been removed from this system. It cannot continue. You may
  cancel it." This is a task-level banner, distinct from the per-step banners in
  `lib/step-banners.ts`; add it as a `deadModuleBanner` predicate keyed on the task's dead-module
  flag, so the rule lives in one tested place like the others.
- Reinstalling the module (same id) revives the task: its data was kept, the steps resolve again,
  the dead flag clears at the next boot report. This is the payoff of keep-data-by-default.

## L. Lifecycle actions while dependent tasks are RUNNING

Uninstalling OR deactivating a module that live tasks depend on would break those tasks mid-flight
(their steps/routes vanish). The Modules page must never do this silently: before any uninstall or
deactivate, it computes and SHOWS the running/queued tasks that depend on the module, and forces the
operator to choose one of two paths.

- **Urgent (a security flaw — remove now):** STOP the dependent tasks immediately (kill their CLIs
  via the existing STOP), then apply the deactivate/uninstall. This is the "I do not care about
  in-flight work, I need this gone" path — the RAM/exposure risk outranks the lost work.
- **Graceful (wait it out):** PAUSE the dependent tasks, wait for their in-flight CLIs to DRAIN
  (the same started-not-ended drain the operator flow already uses — never a BullMQ queue pause),
  then apply the action. New work for those tasks stays held; running work finishes.

Both paths reuse existing mechanisms (STOP / pause / drain / cancel) — this section adds the
module-scoped ORCHESTRATION and the mandatory operator choice, not new primitives. Deactivate is
included because although it is a live flag, flipping it under a running task is as breaking as an
uninstall for that task; only a module with zero live/queued dependent tasks may be deactivated
without the choice.

## Net-new for this amendment

- Modules admin page (tab) with source-typed install (git URL+token / registry package+token /
  local), the four-state controls, the dependent-tasks preflight + urgent/graceful choice.
- `modules` row gains the two-axis state (install + active) and a `missing` flag; source type +
  encrypted credential ref.
- `buildRunList` degrades on an unresolvable (missing-module) step to a DEAD task rather than
  throwing; a task-level `dead-module` flag.
- `deadModuleBanner` predicate (top+bottom+list) in the step-banners module family.
- Module-scoped stop/pause-drain orchestration behind the uninstall/deactivate preflight.

## Verification additions

1. UI install of a public git module: state goes `installed (pending rebuild)` -> `active` only on
   the boot report; a private git module with a token clones; the token is never in plaintext or an
   image (`docker history` clean, DB value encrypted).
2. A folder-dropped module appears in the Modules list as `source: local` and can be
   activated/deactivated.
3. Deactivate (installed+active -> installed+deactivated) with no dependent tasks: routes 404, steps
   unlisted, task types not selectable, nav hidden, NO data lost, NO rebuild; reactivate restores
   all of it instantly.
4. Uninstall keep-data then reinstall same id: dependent tasks that went dead revive with their
   forms intact. Uninstall purge runs `./teardown` and does not.
5. Remove a module's code and reboot: dependent tasks render DEAD (top+bottom red banner, cancel-only
   — retry/stop/abort/auto-continue all disabled), the orchestrator does not crash, and the task
   type is not-selectable with a named reason.
6. Uninstall/deactivate with a RUNNING dependent task: the preflight lists it and blocks until the
   operator picks urgent (tasks stopped, then action) or graceful (tasks paused, drained, then
   action); neither path silently kills or silently waits.
