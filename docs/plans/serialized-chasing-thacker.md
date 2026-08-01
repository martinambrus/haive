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
