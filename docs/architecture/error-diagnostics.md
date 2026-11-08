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

These rules govern new writes and replies. A git or filesystem failure shown to a person also goes through `scrubErrorPaths` (`@haive/shared/logger`): an absolute POSIX, drive or UNC path becomes `[path]`, while the rest of the message and any URL are kept (the URL scheme match is bounded, since an unbounded one is quadratic on a long token). The plan snapshot error (`plan_mirror_state.last_error`), the plan Save and Pull 409 bodies, `repositories.status_message` of a failed repository job 12's plan-mirror warning and the worker module report's `runtime.reason` (`failureReason`, worker `modules/loader.ts`) use it. Historical error columns retain their existing values unless a data repair says otherwise; two convergent boot repairs (`scrubPlanMirrorErrors`, `scrubRepositoryErrors` in `worker/src/data-migrations.ts`) rewrite stored `plan_mirror_state.last_error` and the `status_message` of repositories in `status = 'error'` through the same helper, touching only rows they change (compare-and-swap on the text and status they read) and logging the count and ids. The rewrite cannot be undone; both columns are display copy that the next failure or success overwrites. Display messages remain copy,
not state: the structural banner rules in `web/src/lib/step-banners.ts` still apply.

A repository-path read answers by what failed, never by the error's wording. A containment refusal keeps the status `containmentHttpError` (`api/src/lib/fs-http.ts`) gives it. Running out of descriptors (EMFILE, ENFILE; `isResourceLimitError`, `@haive/shared/fs-safe`) is the process's condition, not a fact about the path: on the strict path routes and in the walks it reaches the api's 500 and its error log, and it is never folded into absence. The bundle file listing walks the tree with `walkFilesNoFollow`, one held directory descriptor per level, and lists at most `FILES_LIST_CAP` (5000) entries, saying so with `truncated`; a tree deeper than `WALK_MAX_DEPTH` (128) levels is refused with `WalkDepthError` (code `EWALKDEPTH`), which the route answers as 409 `bundle_too_deep` with a warning, since only replacing the bundle helps. What the walk guarantees is narrower than a complete listing: running out of descriptors and the depth bound are thrown, never folded into a short listing, and the cap is reported with `truncated`; a missing, refused or moved directory contributes nothing (the walk has no strict mode), and a root the route cannot place lists as empty. The web panel shows the answer's `error`, trimmed, and falls back to the status.

## Configuration store outage

ConfigService runs on its own Redis connection with a per-command deadline: `commandTimeout` 2000 ms,
`enableOfflineQueue: false`, `autoResendUnfulfilledCommands: false`,
`retryStrategy: (n) => Math.min(n * 50, 500)`. A stopped or black-holed Redis rejects in about 2 s
instead of hanging. The BullMQ Worker connections (`createBullRedisConnection`) keep
`maxRetriesPerRequest: null` and are untouched.

A failure that is not a server reply (`!(err instanceof ReplyError)`, never `constructor.name` or
message text) becomes `ConfigUnavailableError` (`@haive/shared`; `operation`, `cause`; no `code`). A
server reply passes through. A timeout means the outcome is unknown: a timed-out write may still have
landed. `pipeline().exec()` resolves per-command errors, so `seedDefaults` throws on them. `close()`
falls back to `disconnect()`.

The api answers `ConfigUnavailableError` with 503
`{ error: 'Service temporarily unavailable', code: 'config_unavailable' }` and leaks no key or host.
The maintenance gate matches ALWAYS_OPEN routes before any read. `assertNewWorkAllowed` and
`admitNewWork` fail closed: a state that cannot be read refuses new work. The worker's pre-check
`readMaintenanceState` reads it as `'unreadable'`, and `readStateUnderFence` throws
`MaintenanceStateUnreadable`.

A catch that swallows a config read on purpose calls `rethrowIfConfigUnavailable(err)` first and keeps
its lenient answer for any other error. What a site does with the outage depends on what the read
decides.

- A gate (an answer that lets work through) fails closed. An unreadable global pause setting holds the
  step (`PauseScope` `'unreadable'`, parked with copy that says the setting cannot be read, never
  "paused"). An unreadable runtime limits setting admits no runtime: the waiter keeps waiting under
  its existing deadline (`acquireRuntimeSlot` polls the strict read,
  `RuntimeAdmissionResult.unreadable`). An unreadable agent-reserve switch, runtime-holder reserve or
  per-task agent cap defers the cli-exec job (`moveToDelayed`, `DelayedError`). `reserveAllowsAnyOf`
  answers false, so nothing is evicted on a guess.
- A value that would be a guess fails with the retryable `ConfigUnavailableError`: agent rules, agent
  isolation, runner caps (`resourceLimitsEnabled({ strict: true })` in `resolveRunnerCaps`), the price
  feed, MCP consent, the local-model guard, the steering switch, the dispatch and mining timeouts (no
  default is stamped), and the prompt-cache TTL behind a cost (the cost stays NULL). The 08c and 08d
  review and QA settings are read in `detect()`, before the paid wave, and frozen on the detect
  output. A row persisted by an older build lacks them and falls back to a live read that rethrows.
- The private-endpoint allowlist read (`allowlistFor`, `packages/shared/src/egress/probe-egress.ts`) is a
  gate: it calls `rethrowIfConfigUnavailable` first, so a dial that needs the list (a blocked literal, a
  blocked resolved address or an unresolved name) rejects with `ConfigUnavailableError` while the store
  is down and the cache is cold; any other read error (an uninitialised `ConfigService` included) counts
  as an empty list with a warn. A built-in host and a public-only answer skip the read.
- A documented fail-open contract keeps its contract: the global KB context still settles
  `unavailable` instead of rejecting. `readMaintenanceState` returns `ObservedMaintenanceState`, with
  `'unreadable'` on an outage (`holdsNewWork` is true for it), so a log line names the state as
  unreadable rather than as `maintenance`.
- A background tick (PR poll, usage poll with its provider-recovery check, checkout watch and sweep)
  catches `ConfigUnavailableError` at its first config read, logs a warning and skips the tick. The
  next scheduled tick retries.

A cli-exec gate defers through the job's own `moveToDelayed`. If that call itself fails, the job is
allowed to run, as it was before.

Request-path queue adds use `api/src/lib/queue-bounded.ts` (`QUEUE_ADD_WAIT_MS` 2000). `boundedAdd`
rejects on timeout or on the add's own rejection. The add is not cancelled and can still land, so the
work must be idempotent or guarded by the worker. `addBestEffort` never throws and returns a boolean:
use it when committed state already records the work (step actions, cancel, task start, stop-settle).

The api's shared client (`getRedis()`, `api/src/redis.ts`) has the same deadline options as
ConfigService. A failure that is not a server reply (`!(err instanceof ReplyError)`) becomes
`RedisUnavailableError` (`api/src/lib/redis-unavailable.ts`), answered 503
`{ error: 'Service temporarily unavailable', code: 'redis_unavailable' }`; a server reply passes
through. A timed-out write may still have landed, and a command issued while the client connects or
reconnects rejects at once. Request paths use `getRedis()`. Socket-lifetime and boot work (editor and
shell refcounts, their boot resets, subscribers, the CLI stream's `XREAD BLOCK` reader, a shell
socket's publisher) uses `getPatientRedis()`, which keeps the old unbounded options, and duplicates from
it: `getRedis().duplicate()` throws. `getBullRedis()`, the worker and the `createRedisConnection`
defaults are unchanged.

`/admin/health` reports `redis: 'up' | 'down'` from a bounded `ping()` and is in the maintenance
gate's ALWAYS_OPEN by exact path (`/^\/admin\/health$/`), still behind `requireAuth` and
`requireAdmin`, so an unreadable config store does not hide the page that says why. The static
`/health` never touches Redis.
The stalled sweep re-drives step, cancel and start work; a lost stop-settle has no re-drive.
`addOrRefuse` throws 503 `queue_unavailable` with a generic body: use it when nothing else will queue
the work and a repeat is safe (auto-continue, merge abort).
