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

The cli-exec failure handler treats its login hint as optional display copy: a failed
hint transaction warns with the original structured hint error under `err`, never a string
conversion. It then accounts the CLI park and resumes the step using the CLI failure,
which remains the thrown error. This applies to every hint-write failure, including a
40P01 deadlock; it does not retry the hint or change locking.

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

API sandbox cleanup returns only the fixed reasons `sandbox_listing_failed` and
`sandbox_removal_failed` in `killError`, including the strict urgent-stop helper. Owner
responses, task events and audit metadata never receive Docker stderr or spawn messages.
The Docker runner logs those diagnostics through `safeErrorMessage` before conversion;
confirmation uses exit success and structured container states, never diagnostic wording.

These rules govern new writes and replies. A git or filesystem failure shown to a person also goes through `scrubErrorPaths` (`@haive/shared/logger`): an absolute POSIX, drive or UNC path becomes `[path]`, while the rest of the message and any URL are kept (the URL scheme match is bounded, since an unbounded one is quadratic on a long token). The plan snapshot error (`plan_mirror_state.last_error`), the plan Save and Pull 409 bodies, `repositories.status_message` of a failed repository job 12's plan-mirror warning the worker module report's `runtime.reason` (`failureReason`, worker `modules/loader.ts`) and the Terminal's open refusal (`terminal-session-manager.ts`) use it. Historical error columns retain their existing values unless a data repair says otherwise; two convergent boot repairs (`scrubPlanMirrorErrors`, `scrubRepositoryErrors` in `worker/src/data-migrations.ts`) rewrite stored `plan_mirror_state.last_error` and the `status_message` of repositories in `status = 'error'` through the same helper, touching only rows they change (compare-and-swap on the text and status they read) and logging the count and ids. The rewrite cannot be undone; both columns are display copy that the next failure or success overwrites. Display messages remain copy,
not state: the structural banner rules in `web/src/lib/step-banners.ts` still apply.

CLI invocation, mining, failed step, task and merge-halt display writes hide paths under
`WORKER_REPO_STORAGE_ROOT` and `HOST_REPO_ROOT` through `scrubWorkerErrorPaths`, including
unsent dispatch and recap failures. It calls `scrubErrorPaths` with those roots and retains
container paths such as `/etc/nginx/...` and `/mnt/ddev_config/...` so repair guidance
remains useful. Bound-query sanitization still happens before conversion to display text.
Step failure predicates and fix-loop diagnoses consume the original `safeErrorMessage`;
a `done` fix-loop row keeps that message whole because recovery reclassifies it.
Only failed-row display copy, returned failures and agent-release messages are scrubbed.
Original errors remain available to structured logs and transport; historical rows are unchanged.

A repository-path read answers by what failed, never by the error's wording. A containment refusal keeps the status `containmentHttpError` (`api/src/lib/fs-http.ts`) gives it. Running out of descriptors (EMFILE, ENFILE; `isResourceLimitError`, `@haive/shared/fs-safe`) is the process's condition, not a fact about the path: on the strict path routes and in the walks it reaches the api's 500 and its error log, and it is never folded into absence. A lenient read (one that answers `null` on failure) passes `rethrow: RESOURCE_LIMITS` wherever that `null` would authorize a delete, an overwrite or a mount decision, or would persist an absence verdict. The exception is a read that runs after a mutation whose undo lives only in memory, such as the fixer-change relocation in `git-merge.ts`: there a throw loses the undo, so the read takes the conservative answer instead ([Merge conflicts](merge-conflicts.md)). Archive expansion leaves its stamp unset when descriptors run out, so a later pass retries, and a bundle walk that runs out aborts the catalog publish. The bundle file listing walks the tree with `walkFilesNoFollow`, one held directory descriptor per level, and lists at most `FILES_LIST_CAP` (5000) entries, saying so with `truncated`; a tree deeper than `WALK_MAX_DEPTH` (128) levels is refused with `WalkDepthError` (code `EWALKDEPTH`), which the route answers as 409 `bundle_too_deep` with a warning, since only replacing the bundle helps. What the walk guarantees is narrower than a complete listing: running out of descriptors and the depth bound are thrown, never folded into a short listing, and the cap is reported with `truncated`; a missing, refused or moved directory contributes nothing (the walk has no strict mode), and a root the route cannot place lists as empty. The web panel shows the answer's `error`, trimmed, and falls back to the status.

The PR poller catches per-task failures, including merged-task step lookup failures, and
records their sanitized message with the task id. The tick also inspects every settled
rejection and logs it when the error-recording path itself fails; remaining tasks and later
batches continue.

The API answers a transaction deadlock by SQLSTATE `40P01`, including a wrapped driver
error, with 503 `transaction_retry_required`, `retryable: true` and `Retry-After: 1`.
The response contains fixed retry guidance and no query or bound values. Provider-choice
and summary writers first retry their top-level transaction once; a supplied transaction handle never retries a savepoint while its outer locks stand. The retry log and exhausted busy error retain the original deadlock as `cause`. A second deadlock or a provider
lost before the write raises `ComposedLspWriteBusyError` (`composed_lsp_write_busy`), also
answered 503 with retry guidance. A persistently disabled provider has the distinct stable code `cli_provider_disabled` (API 400); skill verification re-parks on that code. No message text triggers these outcomes.

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
`integration_provider_configs` and `integration_connections` (the integration tables are counted only
when present; the updater may boot before migration 0192 creates them). An empty capability result
keeps the full inventory, and a failed read still refuses key generation. None (a first install,
since no migration seeds those tables): it generates the key as before. Any: boot exits 1 naming the cause, whether
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

**A key that cannot read the stored secrets is refused too, in every environment.** Outside
production `SecretsService.get` used to answer `null` for a `system_secrets` row its key could not
decrypt, and `getMasterKek`, `getJwtSecret` and `getEmailBlindIndexPepper` read `null` as absent:
they generated a new value and upserted it over the stored row. A wrong key (a Redis wiped and
reseeded from a different `CONFIG_ENCRYPTION_KEY`, or a stale key kept in Redis) therefore orphaned
every envelope, user field and pepper-derived login index without a word. `get` now throws
`SecretUnreadableError` (`config/secret-unreadable.ts`; `secretKeys` names the rows, never a value)
for any stored row that `tryDecrypt` cannot read, in every `NODE_ENV`; only an absent row generates,
and a caller decides on the class, never the message. `SecretsService.initialize` also refuses before
any write: `assertKeyReadsSystemSecrets` (`encryption-key-boot.ts`) reads the table and passes when it
is empty (a first install), absent (the updater can boot before the schema exists) or readable by at
least one row; a table in which every row is unreadable is the wrong key. The refusal exits boot 1
(not a `ConfigUnavailableError`, so it never retries) and names where the key came from, the rows and
both ways out: restore the original key (`CONFIG_ENCRYPTION_KEY` only seeds an empty Redis, so delete
a different key stored under `bootstrap:encryptionKey` first), or `HAIVE_DISCARD_UNREADABLE_SECRETS=1`,
the same audited override, now for a present key too. That discard takes
`LOCK TABLE system_secrets IN SHARE ROW EXCLUSIVE MODE`, reads the table again under the lock (a peer
that already discarded and regenerated is left alone, and api and worker booting together record one
audit row), then writes the same `config.discard_unreadable_secrets` audit row (random id,
`keyPresent: true`, the same counts) and deletes the system secrets in that one transaction, so the
recovery claim gates read it as they read the no-key discard. A table with only some unreadable rows,
which the old behaviour could already have left behind, does not refuse boot: each unreadable row
throws at its reader instead of being replaced (`GET /admin/mail` and the global KB connection string
then fail as they already did in production). `recover-admin` reports the refusal as "does not decrypt
the stored system secrets" and never offers the override, which it cannot receive: the helper
forwards only `DATABASE_URL`, `REDIS_URL` and `CONFIG_ENCRYPTION_KEY`.

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
phone ciphertext or other encrypted secrets. With mail enabled, an active user whose email is unreadable can
claim their account through forgot-password only when the typed address matches exactly one active orphan's
`git_email` (see Password recovery in `api-auth.md`). The remaining accounts, including those with
no or duplicate `git_email`, go through **Admin → Users → Relink**: the administrator identifies the
orphan by its name, git name and git email and enters the account holder's email. Relink ends the
old sessions, randomizes the password and issues a reset link; mail delivers it when enabled, or
the dialog reveals it once for manual handoff when mail is disabled or delivery fails. Deactivated
accounts must be reactivated first. See Admin relink in `api-auth.md`. The host `recover-admin` command
restores one administrator without mail or a matching `git_email`. Rollback: revert the code
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
work must be idempotent or guarded by the worker. `QueueAddTimeoutError` identifies an
unknown enqueue outcome by class. Sign-out and module teardown keep their committed launch audit
on that timeout, since the job may still land; a known rejection still removes only that launch's
audit. Both timeout responses use 503 `queue_outcome_unknown`: the action may still complete
and is safe to retry; rejections keep their existing response. `QueueOutcomeUnknownError` takes an
optional message for a site where a repeat is not safe. The web shows the response's own text for that
code, and the same unknown-outcome sentence when it has none. Bundle queue lookups (including replacement job state) share a five-second
read deadline and answer 503 rather than interpreting a failed lookup as an absent job. ZIP replacement
imports answer a timeout with 503 `queue_outcome_unknown` and keep the promoted source for a late ingest.
A known rejection keeps the existing failure response and compensates the owned syncing row,
including ZIP replacement rollback. Other bundle imports retain their failure response and retryable
failed status on both timeout and rejection. A replacement retry accepts a completed job only when the
bundle still points at that upload's archive and is active; a completed no-op or failed import is
refused rather than declaring the upload complete. Provider saves attempt image and model jobs independently and
mark a failed enqueue's still-pending status failed, so a committed provider does not stay building
or provisioning forever; an already-ready worker result is kept. The per-kind UUID in
`sandbox_image_enqueue_id` / `model_provision_enqueue_id` also serves as the BullMQ job id and fences
compensation to its own attempt. The independent nullable columns (migration 0252) are needed because
`updated_at` changes on unrelated edits and worker results, and one shared revision loses image
compensation when only a model save overlaps it. Saving model or Modelfile fields on an enabled
provider retries failed model provisioning even with unchanged inputs, through the same pull policy
and maintenance admission checks. Disabling or editing metadata alone does not retry provisioning,
including a form save that echoes unchanged model fields alongside a metadata change.
Repository create, upload complete and refresh or recover enqueue through `addRepoJobOrMarkError`
(`routes/repos.ts`): a rejection marks the admitted row `error` (fenced by its job id) and rethrows,
as before; a deadline is an unknown outcome, so the row stays `cloning` or pending with its job id for
a late job or for the stranded-preparation sweep (`reconcileStrandedCloningRepos`, at boot and every 60
s, only for rows older than 5 minutes whose job is not queued and that hold no live root claim), and the
request answers 503 `queue_outcome_unknown` with the repository message (reload the list; adding it
again creates a second repository), not the default "safe to retry". No API claim is held across these
adds, so none is left behind. A repeat of a refresh then meets its pending marker (409), a repeat of an
upload complete meets the completed session (409), and a repeat of a create makes a second repository.
Runtime access keeps its 202 pending response, VNC its starting refusal, and plan/data Save and Pull their existing refusal
contracts. Optional wake-ups (plan/project-state sweeps, module-source outbox, global-KB pending
embeds and usage polls) are best effort. The API queue-add ratchet resolves the called BullMQ method declaration
across routes, libraries and modules, `routes/repos.ts` included: `addRepoJobOrMarkError` is trusted at
argument index 2 like `addBundleJobOrMarkFailed`, and a source assertion pins its `await boundedAdd(add`. Optional chaining,
subclasses, mapped types and queue-returning wrappers are covered; any-typed add receivers fail, and
bounding helpers are recognized by declaration rather than identifier spelling. `addBestEffort` never throws and returns a boolean:
use it when committed state already records the work (step actions, cancel, task start, stop-settle).

The api's shared client (`getRedis()`, `api/src/redis.ts`) has the same deadline options as
ConfigService. A failure that is not a server reply (`!(err instanceof ReplyError)`) becomes
`RedisUnavailableError` (`api/src/lib/redis-unavailable.ts`), answered 503
`{ error: 'Service temporarily unavailable', code: 'redis_unavailable' }`; a server reply passes
through. A timed-out write may still have landed, and a command issued while the client connects or
reconnects rejects at once. Request paths use `getRedis()`. Socket-lifetime and boot work (editor and
shell refcounts, their boot resets, subscribers, the CLI stream's `XREAD BLOCK` reader, a shell
socket's publisher) uses `getPatientRedis()`, which keeps the old unbounded options, and duplicates from
it: `getRedis().duplicate()` throws. `getBullRedis()` and the `createRedisConnection` defaults are unchanged.

The worker's shared finite-command client (`worker/src/redis.ts`, `getRedis()`) now uses
`REDIS_COMMAND_TIMEOUT_MS` (2000 ms, injectable through `initRedis`'s `commandTimeoutMs`),
`enableOfflineQueue: false`, `autoResendUnfulfilledCommands: false` and the same capped retry
strategy. A transport failure or command deadline rejects with the worker's
`RedisUnavailableError` (`code: REDIS_UNAVAILABLE_CODE`, original `cause`); a server `ReplyError`
passes through by identity. Pipelines retain typed errors in their result tuples. A command
issued during connect, reconnect or a LOADING ready check rejects without queueing. A write
whose answer timed out may still have landed; it is never automatically replayed on reconnect.
Connection warnings are throttled to one per ten seconds. `REDIS_UNAVAILABLE_CODE` in
`@haive/shared/constants` is the one contract used by every writer and matcher, including the web client.

This changes how long a gate waits while retaining its documented outage policy. INVOKE lane
reservation fails open without a slot. Step-command leases treat `code: redis_unavailable` as
not acquired and keep polling under their existing ten-minute wait and abort signal; one-shot
lease and slot attempts still propagate the failure. A polling acquire reuses one lease UUID,
since a timed-out EVAL may have inserted its field. RAG and agent polls distinguish an unreadable
Redis attempt from a held lock or full pool when publishing progress copy. Agent-slot release stops its heartbeat and
finishes after a failed HDEL, relying on the existing two-minute field expiry. Runtime
reservation/surcharge accounting keeps its live-runners-only fallback. A cold boot's own
reservation check distinguishes unknown from absent: an unreadable HEXISTS polls every two
seconds under the same eight-minute admission read bound as unreadable limits, then throws
the retryable typed outage. This gate also wraps a server refusal as unreadable without
matching its wording; the finite client itself still preserves ReplyError identity. Both bounds are injectable and honor abort. A recovered read of a
held reservation bypasses the local queue. Guessing absent can queue behind the task's own
reservation; guessing held can admit capacity that was never reserved. These decisions use error structure, never message wording. The RAG lock's
polling acquire treats both its own five-second command timeout and `code: redis_unavailable`
as not acquired, retaining the two-hour worker wait and abort signal; one-shot acquire still
throws. A timed-out SET's compensating release can also fail on the finite client, leaving the
key to its existing 120-second TTL.

`getPatientRedis()` keeps the old options for boot and socket-lifetime work: the bootstrap
version SET, initial module report, boot reservation/lease/surcharge clears, boot-requeue
counter, terminal output and registry bookkeeping, and the dedicated mid-run steer subscriber
duplicated from it. Each boot command waits for its own client's ready check, independently of
ConfigService's connection, so a LOADING store cannot silently skip the clears or counter or
abort the module report. Shared clear helpers accept a client and retain the finite default
for other callers. Later module report changes use the finite client; failure clears the
published digest, so the next 15-second reconcile pass retries even without a new change.
The CLI exit frame waits for pending chunk writes before using the patient client and setting
its TTL: an open API stream reader closes on that frame. The drain and exit write share the
injectable `CLI_EXIT_WAIT_MS` (five seconds); expiry logs and lets database finalization proceed.
A patient write already issued may still land later. Other best-effort stream frames,
cache/hint writes and the soft-timeout wind-down publish stay finite and can be dropped during
an outage. Terminal teardown retries a coded Redis outage up to `TASK_TERMINAL_REAP_ATTEMPTS`
(three), separated by `TASK_TERMINAL_REAP_RETRY_MS` (250 ms); both are injectable. Every attempt
uses the finite client because reap holds a Postgres task-row settlement lock. Exhaustion keeps
the worktree. On Cancel, exhaustion defers the whole resource section: merge reports and
claim release, plan-merge discard, task-end re-sync, scratch and no-change directory cleanup,
and worktree removal. Model unloads and KB cleanup still run before the error is rethrown;
`task.cancel_finished` is withheld so the existing capped cancel re-drive repeats the teardown.
A checkout rebuild is refused for that task while its cancellation remains unfinished.
Completion has no automatic retry: only when its ordinary cleanup policy would remove the
worktree does `worktree.cleanup_deferred` in Activity record the retained path and structural
reason `terminal_reap_failed`. A workflow or custom type with its own cleanup step records no
such event. The task stays completed. The cancel-only
task-label sweep may already have removed task shells, but is best effort, and completion
does not run it.

A finite client's `duplicate()` throws so a subscriber or future blocking reader cannot inherit
its deadline. There are no worker BLPOP/XREAD BLOCK consumers today. The terminal manager's
independently constructed subscriber already uses patient factory defaults. All three singleton
clients share the existing one-second shutdown backstop. BullMQ factories, queue connections,
blocking reads and defer retry behavior are unchanged. In particular this does not bound a
BullMQ-owned `moveToDelayed` during a transport outage, nor change the documented fail-open
policies to strict admission. The 2000 ms worker deadline is inherited from the API, not a
measured worker latency budget. Rollback restores the worker client and its consumer injections
together; no schema or persisted-data rollback is needed.

`/admin/health` reports `redis: 'up' | 'down'` from a bounded `ping()` and is in the maintenance
gate's ALWAYS_OPEN by exact path (`/^\/admin\/health$/`), still behind `requireAuth` and
`requireAdmin`, so an unreadable config store does not hide the page that says why. The static
`/health` never touches Redis.
The web client maps 503 `config_unavailable` and `redis_unavailable` to temporary-outage copy
with a retry hint, keyed on the response code rather than its wording; other failures keep their
existing text. This includes the custom-tool Start gate through the same request wrapper.
The admin overview shows Redis health and applies the health response even if another settings
request fails, so the outage does not hide the down status.
The stalled sweep re-drives step, cancel and start work; a lost stop-settle has no re-drive.
`addOrRefuse` throws 503 `queue_unavailable` with a generic body: use it when nothing else will queue
the work and a repeat is safe (auto-continue, merge abort).

## PostgreSQL DSNs supplied through the application

`assertUserPostgresDsn` (`@haive/shared/egress`) runs before postgres.js parses a typed or
stored external/ddev RAG DSN, an external global KB DSN, a tooling probe DSN, or a stored DSN
read by `dsnDialHost`. The rekey script checks an explicit `GLOBAL_KB_DB_URL` override too.
It refuses the presence of `sslrootcert`, `sslcert` and `sslkey` (including empty values and
`sslrootcert=system`), and explicit socket hosts in the authority or `host` query parameter.
postgres.js v4 reads certificate files during construction, before a socket guard can run,
and a CA file without verify-full can disable hostname checking. Refuse these parameters;
never strip them and silently change TLS policy. Install `DATABASE_URL` and pools derived
from it keep their configured policy. Ordinary `sslmode` choices stay supported.

The guard follows the driver's tail/authority split, last-@ userinfo rule, duplicate-query
precedence and authority percent decoding; a WHATWG parse of the entire DSN is different.
The tooling form submission, the worker tooling apply and `PUT /global-kb/config` refuse
these parameters before saving a user DSN. CLI provider configuration has no PostgreSQL DSN
field, and install `DATABASE_URL` is outside this user-DSN policy. A refusal has stable code
`user_postgres_dsn_refused` and names only the parameter. Save and typed Test responses ask
for the parameter to be removed before trying again. Stored per-repo refusals point to
onboarding step 04 (Tooling and infrastructure); stored global refusals point to an admin's
Settings > Global KB. An unchanged refused DSN echoed to the config save is still refused,
explicitly naming the saved setting; the page's blank DSN allows unrelated settings edits.
Local RAG search, re-embed and retry preserve the typed failure as 400. The global search
half stays isolated: both an ordinary outage and a refused global DSN return per-repo hits
with an optional `note` in `/rag/search`. The refusal note names only the parameter and its
admin repair location. The RAG MCP proxy displays that note with hits or an empty result;
custom-MCP `rag-query` includes the same note in its bounded text response, including for
global-only searches. Existing rows stay stored; there is no migration. Seed-host extraction
still returns null before constructing the driver. Tooling saves never log the tooling
object or its DSN.

`postgres-option-coverage.test.ts` resolves the installed ESM parser and its own package
manifest, compares returned options and consumed query selectors with the guard
`USER_POSTGRES_DSN_KNOWN_OPTIONS` inventory, and detects certificate selectors removed
before `sql.options` is returned. The installed version is diagnostic, not pinned: an
unchanged inventory passes a version bump. An added parser option requires a guard security
review; the simulated consumed `sslcrl` selector still fails the inventory comparison.

Both catches in `POST /tooling/test-postgres` and the catch in `POST /global-kb/test-db` use
`userPostgresErrorMessage`: fixed copy for refused parameters, connection refusal, DNS,
connection timeout and authentication codes, with a fixed generic fallback for other
parser, TLS, filesystem and server errors. Never return a raw driver message here, even
when no query parameters were bound: an ENOENT message previously exposed a file-existence
oracle. `safeErrorMessage` keeps its existing contract for other callers.

## User-supplied endpoint bodies

The tooling API's Ollama `/api/tags` and `/api/show` reads and shared RAG residency JSON reads
use `readForgeJson` (`@haive/shared/forge`), with its 8 MiB default bound. `ollamaEmbed` passes
`OLLAMA_EMBED_MAX_BYTES` (32 MiB), leaving headroom for 64 inputs × 8192 dimensions even when a
user-configured proxy emits float64 decimals.
The reader cancels the stream beyond that bound and throws fixed text without the response body;
invalid JSON also produces fixed text rather than a parser excerpt. `ollamaEmbed` error reads use
`readBounded` with `OLLAMA_ERROR_MAX_BYTES` (64 KiB): both short and oversized errors keep at most
the first 200 characters read; an oversized one also appends the size refusal. Timeouts still
cover the request and body read.

When these helpers, tooling routes, or user-set Ollama/OpenRouter compatibility probes need only
the status, they cancel the unread body before returning. Cancellation failure is best effort and
does not change the status verdict. Tests lower the existing bounded-reader seam to 128 bytes
(256 for the embed error prefix) and stream a few hundred bytes from a throwaway loopback server;
held-open replies must also release the upstream socket without waiting for the request's abort
timer. Fixed-vendor bodies and helper deduplication are separate work.

The worker model provisioner is outside this user-set endpoint scope: `provisionOllamaProvider`
settles an external daemon to `idle` before fetching, and its tags, pull and create calls always
target `IN_STACK_OLLAMA_URL`. Loopback oversized-response fixtures confirm that external provider
URLs trigger no request; bounding the fixed in-stack reads remains separate work.

Global KB Ollama Test failures use fixed guidance instead of embedding transport/error-body
text, since either can echo a credential-bearing URL or its password alone. Config response
and audit URL copy show only scheme, host and port for every role, marking userinfo, path, query
and fragment as hidden; the worker's unreachable-embedder warning uses the same shared helper.
The private stored value is used only
for the dial. The interactive embedding deadline returns `ollama_probe_timeout` with
`retryable: true`; it does not log the raw transport failure. See [Global knowledge base](global-kb.md).
