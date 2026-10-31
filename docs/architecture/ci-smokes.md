# CI smokes

`smoke:ci` of `@haive/api`, `@haive/worker` and `@haive/database` is
`node ../../scripts/run-smokes.mjs smoke:a smoke:b=480 ...`. Every name is a script of that package, and
`=seconds` sets that smoke's limit (default 120 s).

## How a smoke runs

- A smoke is `pnpm run <name>` in its own process group. At its limit the group is SIGKILLed and the smoke is named
  (`run-smokes: <name> hit its <N>s limit and was killed`, an `::error::` annotation under GitHub Actions). After any
  smoke closes, its group is killed again, so a failed smoke leaves no straggler for the next one.
- The chain continues after a failed or timed-out smoke and exits 1 at the end, with a summary naming every smoke that
  did not pass. Stopping at the first failure hid later smokes: in PR #951 one hung smoke cancelled the job at its
  30-minute limit and 46 of 52 smokes never ran.
- SIGINT, SIGTERM and SIGHUP are passed to the running smoke's group, since a detached group gets no terminal Ctrl-C. A
  second signal is SIGKILL; the exit code is 128+n.
- A smoke that leaves its group (setsid, a container from `docker run`) outlives the kill. No current smoke does.

## Limits

The limits are CI numbers, MEASURED over 8 green main runs (2026-10-30/31): 50 of 52 smokes took at most 17 s,
repo-refresh 206-270 s (limit 480) and two-install 50-81 s (limit 240). The job's 1800 s leaves about 275 s over a green run (1221-1525 s over the 13 green main runs to 2026-10-31, the newest the slowest), and a hung smoke costs its whole limit, so every limit has to fit inside that. A new smoke
needs an override only if it can take more than about 40 s; one that exceeds its limit fails by name.

`smoke:all` is the local chain and stays a plain `&&` chain: beside other suites on one host, CI's limits would time
out falsely, and Ctrl-C works there.

## CI steps

In the `smokes` job of `.github/workflows/ci.yml` every step up to `Apply database migrations` (id `migrate`) is setup
and keeps the default condition, so a failed one skips everything after it. Every step after it is an independent
check, run on `if: ${{ !cancelled() && steps.migrate.conclusion == 'success' }}`: a failed check (the Postgres-gated
tests, an api smoke, a Redis script) does not skip the others, the job still fails with it, and a run cancelled by a
newer push stops. A check names `migrate` and never a sibling; a step the checks need goes above `migrate`. A
mistyped step id reads as empty and a mistyped status never matches; either skips the check with the job still green. A
red run no longer ends early, so it takes about as long as a green one.

`scripts/test/ci-step-independence.test.mjs` pins the setup steps (a new one is added to its `SETUP` list), the exact
guard on every check, and that nothing in the job sets `continue-on-error`, which would leave a failed step green or let
the checks run after a failed setup step. `scripts/test/run-smokes.test.mjs` pins the runner and that every `smoke:ci`
goes through it.
