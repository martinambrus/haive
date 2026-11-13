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
the pricing page and the provider form show as returned (`RefreshFailures`) and `refresh_runs`
stores as they are: a new refresh source
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

These rules govern new writes and replies. A git or filesystem failure shown to a person also goes through `scrubErrorPaths` (`@haive/shared/logger`): an absolute POSIX, drive or UNC path becomes `[path]`, while the rest of the message and any URL are kept (the URL scheme match is bounded, since an unbounded one is quadratic on a long token). The plan snapshot error (`plan_mirror_state.last_error`), the plan Save and Pull 409 bodies, `repositories.status_message` of a failed repository job 12's plan-mirror warning the worker module report's `runtime.reason` (`failureReason`, worker `modules/loader.ts`) and the Terminal's open refusal (`terminal-session-manager.ts`) use it. Historical error columns retain their existing values unless a data repair says otherwise; two convergent boot repairs (`scrubPlanMirrorErrors`, `scrubRepositoryErrors` in `worker/src/data-migrations.ts`) rewrite stored `plan_mirror_state.last_error` and the `status_message` of repositories in `status = 'error'` through the same helper, touching only rows they change (compare-and-swap on the text and status they read) and logging the count and ids. The rewrite cannot be undone; both columns are display copy that the next failure or success overwrites. Display messages remain copy,
not state: the structural banner rules in `web/src/lib/step-banners.ts` still apply.

A repository-path read answers by what failed, never by the error's wording. A containment refusal keeps the status `containmentHttpError` (`api/src/lib/fs-http.ts`) gives it. Running out of descriptors (EMFILE, ENFILE; `isResourceLimitError`, `@haive/shared/fs-safe`) is the process's condition, not a fact about the path: on the strict path routes and in the walks it reaches the api's 500 and its error log, and it is never folded into absence. A lenient read (one that answers `null` on failure) passes `rethrow: RESOURCE_LIMITS` wherever that `null` would authorize a delete, an overwrite or a mount decision, or would persist an absence verdict. The exception is a read that runs after a mutation whose undo lives only in memory, such as the fixer-change relocation in `git-merge.ts`: there a throw loses the undo, so the read takes the conservative answer instead ([Merge conflicts](merge-conflicts.md)). Archive expansion leaves its stamp unset when descriptors run out, so a later pass retries, and a bundle walk that runs out aborts the catalog publish. The bundle file listing walks the tree with `walkFilesNoFollow`, one held directory descriptor per level, and lists at most `FILES_LIST_CAP` (5000) entries, saying so with `truncated`; a tree deeper than `WALK_MAX_DEPTH` (128) levels is refused with `WalkDepthError` (code `EWALKDEPTH`), which the route answers as 409 `bundle_too_deep` with a warning, since only replacing the bundle helps. What the walk guarantees is narrower than a complete listing: running out of descriptors and the depth bound are thrown, never folded into a short listing, and the cap is reported with `truncated`; a missing, refused or moved directory contributes nothing (the walk has no strict mode), and a root the route cannot place lists as empty. The web panel shows the answer's `error`, trimmed, and falls back to the status.

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

**Boot waits out a configuration store outage instead of exiting.** `initialize` waits for `ready` at
most `READY_TIMEOUT_MS` (10 s): a Redis that stays `LOADING` neither becomes ready nor emits an error,
and the wait never settled. A transport error or that deadline rejects with
`ConfigUnavailableError('initialize')`; a server reply (a wrong password) stays a raw `ReplyError`. A
failed `initialize` disconnects its client, which otherwise reconnected forever, so the same instance
can initialize again. The boot seed and key calls (`seedDefaults`, `reconcileRaisedDefaults`,
`removeRetiredKeys`, `ensureEncryptionKey`) run through `redisCall` like every other read. A key in
Redis or in `CONFIG_ENCRYPTION_KEY` is used as before (an env key seeds an empty store), and the
`CONFIG_ENCRYPTION_KEY` mismatch check runs against the stored key. The api and the worker run
`bootstrap()` through `retryWhileConfigUnavailable` (`config/retry-config-unavailable.ts`): 500 ms
doubling to 5 s, one warn per attempt (`what`, `attempt`, `waitedMs`, `delayMs`, `err`), never giving
up, the same in dev and production. MEASURED before: a refused store exited 1 in about 1.4 s, which
under `tsx watch` leaves the watcher up with the app dead and nothing restarting it, and in production
is a crash loop against a store still down; after, the api served 200 about 2.5 s after the store came
back, same PID. Only `ConfigUnavailableError` is retried (`instanceof`); any other boot error (missing
env var, wrong password, Postgres, key mismatch) still logs and exits 1. Every init step `bootstrap()`
repeats on a retry is a no-op the second time, and the worker's boot data migrations run inside it:
`runOne` (`data-migrations.ts`) rethrows a typed outage so the retry runs them again (the two
global-store repairs are not among them: they run after ready in their own retry loop, see
[Global knowledge base](global-kb.md)) (MEASURED before: the private-endpoint seed and the imported MCP server hold were
logged as failed and left until the next restart); any other migration error is still logged and
skipped. The cost: a permanently wrong `REDIS_URL` retries
forever, one warn per attempt, instead of crash-looping.

**With no key anywhere, boot refuses to mint one over existing ciphertext.** `initialize` now takes
the db and runs after `waitForDatabaseReady`. When neither Redis nor `CONFIG_ENCRYPTION_KEY` holds a
usable key, `generateBootEncryptionKey` (`config/encryption-key-boot.ts`) counts ciphertext rows in
`system_secrets`, `users`, `user_secrets`, `cli_provider_secrets`, `repo_credentials`,
`integration_provider_configs` and `integration_connections`. None (a first install, since no migration
seeds those tables): it generates the key as before. Any: boot exits 1 naming the cause, whether
`CONFIG_ENCRYPTION_KEY` is unset or set but invalid, and asks for the original key back. A lost Redis
volume with no env key used to mint a new key with a warn and orphan every secret. The last resort is
`HAIVE_DISCARD_UNREADABLE_SECRETS=1` (exactly `1`; api and worker): boot deletes every `system_secrets` row (master key,
JWT secret, email pepper, the global KB connection string) in the same transaction as a
system-actor audit row, logs a warn with the row count, then publishes the new key. User fields and
envelopes stay stored. User email and phone reads use `tryDecryptEmail` / `tryDecrypt`: malformed
ciphertext or a failed GCM tag answers `null` with a readability flag instead of failing the request.
The admin user list, audit actors and account settings show "unreadable, needs relink"; a missing
phone is distinct from an unreadable one. Other encrypted secrets retain their existing checks.
A regenerated pepper matches no old email index, and setup stays closed while users exist; recover
one administrator with the host command below. Remove the setting once boot
succeeds. Concurrent boots and a crash between commit and publish reuse one Redis-reserved pending key
and audit id; the reserve and publish Lua scripts run against a real Redis in CI
(`encryption-key-boot-redis.test.ts`). A boot with a usable env key, and the fallback recovery, seed that key only while no pending exists: a pending younger than 10 minutes (`PENDING_ENCRYPTION_KEY_WAIT_MS`, timed by its `reservedAt`) is a discard in progress, so boot waits and retries; an older one, or one without a readable `reservedAt`, is a discard a crash interrupted, and boot exits naming Redis key `bootstrap:pendingEncryptionKey` with the two ways out: restart without `CONFIG_ENCRYPTION_KEY` and with the override to finish it, or, when `audit_events` holds no `config.discard_unreadable_secrets` row whose id is the pending JSON's `id` (the discard did not commit), delete that key and restart to keep the secrets. The updater gives boot its own short-lived one-connection client, since Drizzle rewrites the codecs of the postgres.js client it wraps and the updater's journal needs its own.

**Recover an administrator after key loss.** First let boot finish with the discard override, then
remove the override. New installations created with this release have the recovery subcommand.
The installer writes the helper once; upgrades do not refresh it, so an older installation's
`./haive` cannot run this subcommand. From a new installation's directory, run:

```sh
./haive recover-admin --email admin@example.com
# When there are several administrators, choose one of the ids the command lists:
./haive recover-admin --email admin@example.com --user-id <admin-uuid>
```

For an older installation, run this directly from its directory. It reads `HAIVE_VERSION` from
`.env` and uses the same updater image, network, environment and Docker options as the new helper.
That image must be a release that ships `recover-admin`: on an older `HAIVE_VERSION` the run fails
with "Cannot find module", so upgrade first, or replace `${HAIVE_VERSION#v}` below with such a
release's version. The same applies to the PowerShell fallback.

```sh
(
  unset HAIVE_REGISTRY_TOKEN
  while IFS= read -r line; do
    case "$line" in
      HAIVE_*=*|COMPOSE_PROJECT_NAME=*|POSTGRES_*=*|CONFIG_ENCRYPTION_KEY=*|JWT_SECRET=*|DOCKER_CONFIG=*) export "$line" ;;
    esac
  done < .env
  DATABASE_URL="postgres://${POSTGRES_USER:-haive}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-haive}" \
  CONFIG_ENCRYPTION_KEY="${CONFIG_ENCRYPTION_KEY:-}" \
  docker run --rm --log-driver none -i \
    --network "${HAIVE_NETWORK:-${HAIVE_INSTALL_ID:-haive}-network}" \
    -e HAIVE_INSTALL_ID="${HAIVE_INSTALL_ID:-haive}" \
    -e DATABASE_URL -e REDIS_URL=redis://redis:6379 -e CONFIG_ENCRYPTION_KEY \
    --entrypoint node "${HAIVE_REGISTRY}/haive-updater:${HAIVE_VERSION#v}" \
    packages/updater/dist/recover-admin-cli.js --email admin@example.com
)
```

The PowerShell helper has no recovery subcommand. Its public and channel helpers bind trailing
arguments differently; use this direct PowerShell fallback from the install directory on Windows:

```powershell
$e = @{}
Get-Content .env | Where-Object { $_ -match '^\s*[^#].*=' } | ForEach-Object {
  $k, $v = $_ -split '=', 2; $e[$k.Trim()] = $v.Trim()
}
$id = if ($e['HAIVE_INSTALL_ID']) { $e['HAIVE_INSTALL_ID'] } else { 'haive' }
$network = if ($e['HAIVE_NETWORK']) { $e['HAIVE_NETWORK'] } else { "$id-network" }
$dbUser = if ($e['POSTGRES_USER']) { $e['POSTGRES_USER'] } else { 'haive' }
$dbName = if ($e['POSTGRES_DB']) { $e['POSTGRES_DB'] } else { 'haive' }
$v = $e['HAIVE_VERSION'] -replace '^v', ''
$previousDatabaseUrl = $env:DATABASE_URL
$previousEncryptionKey = $env:CONFIG_ENCRYPTION_KEY
$previousDockerConfig = $env:DOCKER_CONFIG
try {
  if ($e['DOCKER_CONFIG']) {
    $env:DOCKER_CONFIG = $e['DOCKER_CONFIG']
    if ($env:OS -eq 'Windows_NT' -and $env:DOCKER_CONFIG -match '^/([a-z])/(.*)$') {
      $env:DOCKER_CONFIG = $Matches[1] + ':/' + $Matches[2]
    }
  }
  $env:DATABASE_URL = "postgres://${dbUser}:$($e['POSTGRES_PASSWORD'])@postgres:5432/$dbName"
  $env:CONFIG_ENCRYPTION_KEY = $e['CONFIG_ENCRYPTION_KEY']
  docker run --rm --log-driver none -i `
    --network $network -e "HAIVE_INSTALL_ID=$id" `
    -e DATABASE_URL -e REDIS_URL=redis://redis:6379 -e CONFIG_ENCRYPTION_KEY `
    --entrypoint node "$($e['HAIVE_REGISTRY'])/haive-updater:$v" `
    packages/updater/dist/recover-admin-cli.js --email admin@example.com
} finally {
  $env:DATABASE_URL = $previousDatabaseUrl
  $env:CONFIG_ENCRYPTION_KEY = $previousEncryptionKey
  $env:DOCKER_CONFIG = $previousDockerConfig
}
```

Append `--user-id <admin-uuid>` when needed to either fallback command. Both disable container
logging so the temporary password is not retained by the daemon's configured log driver, and
attach stdin without requiring a TTY.

The helper runs the installed version's updater image on this install's network, with its database,
Redis and configuration key. It needs neither the Docker socket nor a repository mount in that
container. In the development stack, after updating dependencies with `pnpm docker rebuild`, use
its existing API container (replace `haive-api` when the install has a different id):

```sh
docker exec -it haive-api sh -lc 'cd /app && pnpm --filter @haive/updater exec tsx src/recover-admin-cli.ts --email admin@example.com'
```

For a host invocation, `DATABASE_URL`, `REDIS_URL` and, when configured, `CONFIG_ENCRYPTION_KEY` must
point to that same install; run `pnpm --filter @haive/updater exec tsx src/recover-admin-cli.ts` with
the same arguments. A missing key still follows the normal boot refusal; this command is not a
second discard override.

The command selects the sole administrator or the explicit `--user-id`, refusing an email held by
another readable account. It reactivates the selected administrator if needed. One transaction repairs the chosen
email and blind index, sets a temporary password, requires a password change and increments the
session token version. Every other account whose email is unreadable gets a bcrypt hash of 32
random bytes, the same password-change flag and its own token-version increment. Existing passwords
stop working; no repositories or tasks are deleted. Before any user write the command prints how
many orphan passwords will be invalidated. Invalidation requires a
`config.discard_unreadable_secrets` audit row in this database; without one it refuses and writes
nothing unless the operator supplies `--force` after verifying the database, Redis and key belong
to this install. Already-cleared accounts do not count again. A collision held only by an unreadable account
is released in that transaction. The only secret printed is the temporary admin password, once,
after commit. Sign in and replace it on the Account page. Token-version changes fence subsequent
requests and refreshes; as with other out-of-band database edits, already-open sockets close when
they disconnect or the API restarts.

Required system-actor audit rows (`user.recover_admin`, `user.recovery.clear_password`) commit with
the user changes; a refused audit undoes the recovery. A clearance row records only the target,
a digest of its ciphertext and the resulting token version. A rerun reissues the administrator's
password but leaves already-cleared orphan rows alone while those markers still match. Repaired
admin email ciphertext is retained on a rerun with the same address. Recovery does not restore old
phone ciphertext or other encrypted secrets. Users whose email is unreadable can then
claim their account through forgot-password by their `git_email` (see Password recovery in
`api-auth.md`); admin relinking is later work. This command restores one administrator independently of them. Rollback: revert the code
change; no schema migration is needed. Committed password resets cannot be undone by a code revert.

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
  next scheduled tick retries. The runtime runner reaper reads an unreadable failed/held grace as 0
  for that pass, so it keeps failed and held runners (a reaped runner cannot be brought back, and the
  operator may have raised or disabled the grace); the exited, orphan and terminal-task reaps still
  run. Any other read error keeps the 180 min default.
- A failed step's provider-outage watch is armed as if the mode were unset when
  `ALLOWANCE_WATCH_MODE` cannot be read (`recordFailedStepHint`, `task-queue.ts`): nothing retries
  the arm once the task is failed, while `checkProviderRecovery` re-reads the mode every tick and
  leaves an armed row alone while it is `off`.

A cli-exec gate defers through the job's own `moveToDelayed`, by way of `deferJob`
(`queues/cli-exec/defer-job.ts`). A defer the store refuses (a server reply such as `LOADING` after a
restart, or OOM) is retried every second for `DEFER_RETRY_WINDOW_MS` (60 s, under the 2 min agent
slot lease, since a held job still owns its slot), and only then is the job allowed to run. MEASURED
before: a `LOADING` refusal let the job run ungated after 390 ms; after, the gate held it 14.2 s
through the restart and it ran on its next pass. A transport outage never reaches the retry: the
BullMQ connection queues the call and resolves it when the store is back.

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
