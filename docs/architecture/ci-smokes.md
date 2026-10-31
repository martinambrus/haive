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
repo-refresh 206-270 s (limit 480) and two-install 50-81 s (limit 240). The job's 1800 s leaves about 350 s over a
green run (1305-1445 s), and a hung smoke costs its whole limit, so every limit has to fit inside that. A new smoke
needs an override only if it can take more than about 40 s; one that exceeds its limit fails by name.

`smoke:all` is the local chain and stays a plain `&&` chain: beside other suites on one host, CI's limits would time
out falsely, and Ctrl-C works there.

## CI steps

In `.github/workflows/ci.yml` the worker and migration smoke steps run after a failed api smoke step, but not after a
failed install, build or migrate step and not when the job is cancelled. `scripts/test/run-smokes.test.mjs` pins the
runner and that every `smoke:ci` goes through it.
