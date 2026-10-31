# Error diagnostics

A bound query error can include every bound value in its message, stack or detail, including
credential fingerprints, encrypted secret values and container environments. Keep its structure
until choosing the safe representation. The helpers live in `shared/src/logger/errors.ts` and
`shared/src/logger/index.ts`, exported through `@haive/shared/logger`.

`boundQueryError` walks causes and aggregate members with a cycle guard. A nonempty `params`
or `parameters` array establishes the bound-query case; a connection failure with no bound
values keeps its original diagnostics. Decisions use structure rather than message wording.

For logs, `serializeError` keeps the error class, query structure and the associated database
code while omitting bound values, driver detail and stack. Pino's hooks sanitize before its
automatic message extraction; serializers cover both `err` and `error`. Re-serializing a safe
object preserves its class. In a mixed aggregate, an unrelated filesystem member's code must
not replace the bound database member's SQLSTATE.

For replies and stored failure text, use `safeErrorMessage` before losing the original error
structure. Bound queries become `Database operation failed`. An ordinary Error retains its
message byte for byte, and other values retain their String conversion. A site that previously
used `String(error)` must preserve that ordinary conversion, including its class prefix, while
sanitizing bound members; replacing every such conversion with `.message` changes diagnoses.
This matters for fix-loop input, retry guidance and plan-mirror refusal reasons.

Every BullMQ processor uses `safeProcessor`, which passes its job to `safeErrorForTransport`.
The latter logs sanitized structured diagnostics with job identity before replacing a bound
error with safe text and its database code for BullMQ's persisted reason and stack. An ordinary
error is rethrown by identity, preserving BullMQ's special error classes and retry semantics.

The processor catch cannot protect a value already converted to text. Writers of failure
columns and helpers returning a failure inside a successful job result sanitize at that sink,
before persistence or return. This includes the project-state outbox, bundle ingestion, CLI
image probes, Ollama provisioning and the version and price refresh's per-source `errors`, which
the pricing page and the provider form show as returned (`RefreshFailures`): a new refresh source
sanitizes at its own sink. A later safe rethrow does not repair an earlier raw write.

The Git bundle ingest handler first calls `safeErrorMessage` on the original error. Bound errors keep their
fixed safe message and original error object so the queue boundary can log their class and SQLSTATE;
a known password that happens to match a word in that fixed message must not rewrite it. Ordinary
errors then replace known secrets before URL scanning, and only a text-changing scrub replaces
the error with its sanitized message.
Bundle origin cleanup follows the same bound-error rule when its legacy URL update fails.
It continues rebuilding ordinary errors without a raw cause, which could restore a credential to logs.
The upgrade bundle detector and apply warning sanitize their own failure text before storing
it in step output; detection also logs the original error while its structure remains available.

The onboarding and upgrade commit wrappers choose `safeErrorMessage` before adding their
existing staging/commit prefix, and keep the original error as `cause`. Identity resolution
inside those commit blocks reads the database, so a Git-labelled catch can receive a bound
query error. The cause lets the runner persist safe text and log structured diagnostics;
ordinary Git failures retain their prefixed message and fail the step for Retry as before.
The workflow merge's projection-restoration hook can fail on the same identity lookup. Its
catch logs the original structured error and sanitizes before persisting the prefixed
`Nothing was merged` failure through the existing merge halt.

These rules govern new writes and replies. A git or filesystem failure shown to a person also goes through `scrubErrorPaths` (`@haive/shared/logger`): an absolute POSIX, drive or UNC path becomes `[path]`, while the rest of the message and any URL are kept (the URL scheme match is bounded, since an unbounded one is quadratic on a long token). The plan snapshot error (`plan_mirror_state.last_error`), the plan Save and Pull 409 bodies, `repositories.status_message` of a failed repository job and 12's plan-mirror warning use it. Historical error columns retain their existing values unless a data repair says otherwise; two convergent boot repairs (`scrubPlanMirrorErrors`, `scrubRepositoryErrors` in `worker/src/data-migrations.ts`) rewrite stored `plan_mirror_state.last_error` and the `status_message` of repositories in `status = 'error'` through the same helper, touching only rows they change (compare-and-swap on the text and status they read) and logging the count and ids. The rewrite cannot be undone; both columns are display copy that the next failure or success overwrites. Display messages remain copy,
not state: the structural banner rules in `web/src/lib/step-banners.ts` still apply.

A repository-path read answers by what failed, never by the error's wording. A containment refusal keeps the status `containmentHttpError` (`api/src/lib/fs-http.ts`) gives it. Running out of descriptors (EMFILE, ENFILE; `isResourceLimitError`, `@haive/shared/fs-safe`) is the process's condition, not a fact about the path: on the strict path routes and in the walks it reaches the api's 500 and its error log, and it is never folded into absence. The bundle file listing walks the tree with `walkFilesNoFollow`, one held directory descriptor per level, and lists at most `FILES_LIST_CAP` (5000) entries, saying so with `truncated`; a tree deeper than `WALK_MAX_DEPTH` (128) levels is refused with `WalkDepthError` (code `EWALKDEPTH`), which the route answers as 409 `bundle_too_deep` with a warning, since only replacing the bundle helps. What the walk guarantees is narrower than a complete listing: running out of descriptors and the depth bound are thrown, never folded into a short listing, and the cap is reported with `truncated`; a missing, refused or moved directory contributes nothing (the walk has no strict mode), and a root the route cannot place lists as empty. The web panel shows the answer's `error`, trimmed, and falls back to the status.
