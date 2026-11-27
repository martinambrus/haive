# Testing

How tests are written and run. The rule exists because the unit tests outgrew their CI job: on 2026-11-12
three PRs in a row (#1098, #1099, #1100) were cancelled at the job's 20 min limit with no failing test.
MEASURED locally the same day (vitest JSON reporter, 16 cores): 1,687 test files, 1,690 s of summed per-file
time, 1,404 s of it in `@haive/worker`; the slowest 40 files were 63% of the total and 63 files ran over 5 s.
Almost all of that came from two habits, which the rules below replace: proving a limit by building data at the
production limit (one file spent 103 s on 11 tests building 4,096 entries and 16 MiB), and running every input
variant against real git, real timers or a real server.

## Pick the cheapest layer that can fail

- A pure function gets a unit test on in-memory input.
- Logic behind a seam (the git runner, the database, Redis, `fetch`, the clock) gets a unit test with the seam
  faked. Split the decision out of the I/O when it is not already separate, and test the decision.
- Real git, PostgreSQL, Redis, HTTP, WebSockets or Docker only when the behaviour under test IS that
  interaction: git's own semantics (a merge, a ref transaction, a pathspec), SQL locking and constraints, a real
  redirect or upgrade handshake, a child process that must really exit. Then one representative test per
  behaviour; the input variants go to unit tests of the pure part.
- End-to-end and smoke tests (`pnpm test:e2e`, `smoke:*`) cover a user path across services, not a branch of one
  function. A test that needs a database or Redis server is an env-gated file (`describe.skipIf` on its URL)
  with a row in the CI GATED list, or a reasoned exemption in `scripts/test/ci-gated-list.test.mjs` when another
  CI step already runs it with its guard environment (several Redis files run in the smokes job); CI fails a gated
  file with neither ([CI smokes](ci-smokes.md)). `pnpm test:gated <file>` runs a gated file on your machine
  (Running the gated files locally).

## Limits are injectable

Code that enforces a size, count or time limit takes it as an optional parameter (or option) defaulting to the
named production constant. A test proves the bound at a small value (a limit of 4 entries proves the same branch
as 4,096), and one assertion pins the production constant's value. Never build megabytes or thousands of entries
to reach a branch.

## No real waiting

Use fake timers (`vi.useFakeTimers`, `vi.advanceTimersByTimeAsync`) for every timeout, retry, backoff, poll and
debounce. A real deadline only where an external process or socket must actually expire, at the smallest value
that proves it. An assertion on elapsed wall time ("finished within 800 ms") is not a unit test: it fails on a
loaded runner. Assert the order of events or the timer that was armed instead.

A fake server must answer the way the code under test treats as final. postgres.js retries a closed connection
during startup with a randomized backoff, so a listener that accepts and destroys the socket can turn one dial into
several over seconds (`rag-connection-guard.test.ts` timed out that way); answer with a terminal PostgreSQL error
such as `28P01` and assert the number of dials. In an e2e spec, a rich-text editor's deferred autofocus can collapse
a native DOM selection made before it lands, so clear the editor with its own keymap (`ControlOrMeta+a`, `Delete`),
not `fill('')`, and assert it is empty before saving (`global-kb-edit.spec.ts`).

## Fixtures are built once

A git repository or file tree that several tests read is built once in `beforeAll` and copied per test (a
recursive copy of a template directory), not replayed with `git init` and commits in every `beforeEach`. Each test
still gets its own copy when it writes.

## Budget

A new or changed test file runs in under 5 s locally (`pnpm --filter <pkg> exec vitest run <file>
--reporter=json --outputFile=<tmp>` reports per-file time). A file over that states its reason in the PR.

## Running one package

`pnpm typecheck` and `pnpm test` run through turbo, whose `typecheck` and `test` tasks depend on `^build`: every
workspace package the target depends on is built first, `@haive/module-statistics` among them. A package-level run
(`pnpm --filter @haive/worker typecheck`) builds nothing, so in a fresh worktree, or after pulling a change to a
dependency, a server package's generated `modules.generated.ts` cannot resolve `@haive/module-statistics/manifest`.
Run the package's task through turbo instead (`pnpm exec turbo run typecheck --filter=@haive/worker`), or build its
dependencies once first (`pnpm exec turbo run build --filter='@haive/worker^...'`, which builds database, shared,
web-kit and the statistics module).

A direct Vitest run (`pnpm --filter <pkg> exec vitest run <file>`) also skips the package's `test` script, the step
that writes the api's and the worker's gitignored `modules.generated.ts`. After the dependency build, pass the file
to the script instead (`pnpm --filter @haive/worker test <file>` runs `gen-modules.mjs`, then `vitest run <file>`),
or run `node scripts/gen-modules.mjs` once from the repository root.

## How CI runs them

Unit tests run in their own matrix job, separate from lint and typecheck: `@haive/worker` as two vitest shards
and one shared job for all other packages. Each job lists its 15 slowest files in the job summary; the list is
report only, because a timing gate on shared runners would flake. Env-gated real-store tests run in the `postgres-gated` matrix (two legs, each with its own Postgres, pgvector and
Redis), reported under the **Postgres-gated tests** check by the aggregate job `postgres-gated-result`, or in the step
their exemption names. `scripts/test/ci-gated-list.test.mjs` checks every column of a row (package, file, variable,
database, server) against the file's own guard; the admin-URL suites with no database-name predicate are listed in
`unrestrictedDatabases` with a reason. Each row runs vitest with `--maxWorkers=2`.

The **desktop-bridge-go** job runs `gofmt -l`, `go vet` for linux, windows and darwin on amd64 and arm64, and
`go test -p 1 ./...` for `docker/desktop-extension/bridge/`, in the golang image the extension's Dockerfile pins
(`scripts/test/ci-desktop-bridge.test.mjs` keeps the two equal). It always starts and reports; its checks run only
when the bridge, its embedded installers, the Dockerfile or the job's own files changed against the base commit.

## Running the gated files locally

`pnpm test:gated <selection...>` (`scripts/run-gated-tests.mjs`) runs rows of the CI GATED list the way the CI loop
runs them. A selection is a test file (`test/pg-transaction-fence.test.ts`, optionally behind its package:
`database/test/...`), a package name (all its rows) or `all`. No selection, or a name that matches no row, exits 2
before any container starts. Rows run one at a time in list order; a failed row does not stop the later ones. The runner does not shard: it runs every
selected row. The CI step script defaults `GATED_SHARD` and `GATED_SHARDS` to 1, so the script harnesses that run it
without a matrix see the whole list.

The runner keeps no list of its own. `scripts/lib/ci-gated.mjs` reads the rows, the service images and the job and
step env from the `postgres-gated` job of `.github/workflows/ci.yml` through the reader the workflow pins use
(`scripts/test/workflow.mjs`). `scripts/test/run-gated-tests.test.mjs` pins that: it compares the rows with the raw
heredoc text and runs the real CI step script and the runner against stub `docker` and `pnpm`, one row per package
and server. Both must pick the same package, file, variable, database and server, pass the same argv to the row's
migrate and vitest calls, reach the same completeness verdict, and the runner must set every variable the loop adds
to those calls; the job's `migrate` step must run what the runner runs at setup. A change to the loop in `ci.yml`
is a change to the runner too.

Per row it does what the loop does: probe for the database and create it when missing, apply
`pnpm --filter @haive/database migrate` to it, run `vitest run <file>` with the row's variable set to the database
URL, and read the JSON report. A file with no passing test, or any skipped or todo test, did not run in full and
fails the row. The summary lists each file as passed, FAILED, INCOMPLETE or TIMEOUT; the exit code is 0 only when
every row passed, 1 otherwise, and 128 plus the signal number after an interrupt.

It starts its own throwaway containers, `gated-tests-<id>-postgres`, `-pgvector` and `-redis`, never the dev stack's,
and only the servers the selection needs (Redis only for a file that reads a Redis variable of the gated step). Each
uses the image the CI job declares, is published on an ephemeral port of `127.0.0.1` and has a random password.
`docker rm -fv` removes them after success, failure and interrupt (SIGINT, SIGTERM, SIGHUP), and every wait has a
deadline: a row that overruns its limit is killed and reported TIMEOUT. SIGKILL cannot be handled and also leaves the
running test process and a `gated-tests-*` temp directory behind: list the containers with
`docker ps -a --filter name=gated-tests-` and remove them with `docker rm -fv`.

The test process gets the CI job and step env with every Postgres and Redis URL pointed at these containers, or
dropped when that server is not running, so a `DATABASE_URL` or `REDIS_URL` in the developer's shell never reaches
it. Two things differ from CI: every row also gets `<variable minus _URL>_PORT` set to its container's port (the
api task-integration admission test accepts a 127.0.0.1 URL only when its port equals that variable, where CI
relies on `CI=true` and `localhost:5432`), and `CI` is not set.

The CI setup steps are not repeated: run `pnpm install`, build `@haive/shared`, `@haive/database` and
`@haive/web-kit`, build the modules and, for api and worker rows, run `node scripts/gen-modules.mjs` (see Running
one package). Docker must be running.

Repository preparation fixtures that call a handler directly use
`worker/test/support/repo-preparation.ts`: it models API admission with a fresh UUID and enters
the same invocation ownership scope as the queue. It is test-only and never grants production
jobs ownership. Queue/SQL race controls instead use the real queue processor and explicit
admission tokens (`refresh-checkout-holders-db.test.ts`), with promise barriers at detection,
root-claim acquisition and post-ready import; no timed sleeps. That gated file also calls the
actual maintenance list and updater count while the initial import is held. Its cross-package
imports are test-only; the worker runtime imports neither API nor updater code.

`refresh-rebuild-retries.test.ts` runs the real repo worker on its own Redis database.
Its fixture admits a pending UUID before enqueueing that exact `jobId`, and uses the shared
fake database predicate evaluator for owner-qualified reads and updates, including `returning()`.
`repo-completion-retry.test.ts` keeps the queue processor real and models checkout replacement
at the handler seam: a failed completion clear must retain ready, preserve edits made between
attempts and resume imports without calling the destructive handler again.

`api/test/checkout-access-db.test.ts` is in GATED and uses only its throwaway database. Promise
barriers hold a streamed body, real Git reconciliation and plan mirror removal while a competing
root claim tries to rebuild. `checkout-read-rename.test.ts` uses real temporary files with syscall
seams to rename before anchor open, during descriptor verification and after handle acquisition;
input variants and capability rejection stay in fake-database tests. No development checkout,
queues or data stores participate in these controls.

Relink probes must target the fresh client used by the Git transaction, after the separate intent
transaction; intercepting `getDb().transaction` no longer injects a relink failure. Held-row
fixtures also take the mutation lease a real relink holds. A competing relink is now refused
with `checkout_unavailable`; its retry can succeed only after restoration and release. The
process-death probe mounts both route handlers and blocks the final repository UPDATE with a
Postgres trigger and a parent-held advisory lock, after Git but before the client can send COMMIT.
A deferred COMMIT trigger is unsuitable: after client death the server can finish an already
submitted COMMIT. The probe kills the child first, releases the barrier, verifies no early repair,
then models lease expiry on the scratch row before the sweep repairs it. Git fixtures in
`checkout-access-db.test.ts` are built once and copied for each test.
