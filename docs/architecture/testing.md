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
  with a row in the CI GATED list ([CI smokes](ci-smokes.md)); CI fails a gated file that has no row.

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

## Fixtures are built once

A git repository or file tree that several tests read is built once in `beforeAll` and copied per test (a
recursive copy of a template directory), not replayed with `git init` and commits in every `beforeEach`. Each test
still gets its own copy when it writes.

## Budget

A new or changed test file runs in under 5 s locally (`pnpm --filter <pkg> exec vitest run <file>
--reporter=json --outputFile=<tmp>` reports per-file time). A file over that states its reason in the PR.

## How CI runs them

Unit tests run in their own matrix job, separate from lint and typecheck: `@haive/worker` as two vitest shards
and one job for every other package. Each job lists its 15 slowest files in the job summary; the list is report
only, because a timing gate on shared runners would flake. Env-gated real-store tests run in the
**Postgres-gated tests** job.
