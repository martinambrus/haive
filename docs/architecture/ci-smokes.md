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

The smoke limits are CI numbers, MEASURED over the 16 green runs of 2026-10-31 that print per-smoke times: 51 of the 53
smokes took at most 19 s, repo-refresh 176-291 s (limit 480) and two-install 50-85 s (limit 240). A new smoke needs an
override only if it can take more than about 40 s; one that exceeds its limit fails by name.

A hung smoke or step costs its limit in place of its usual time, so the job's limit has to cover a green run and the
largest hang. The gated tests grow the job: they take about 7.5 s a row of the GATED list on the slowest runners (the
list had 79 rows on 2026-10-30 and 96 on 2026-10-31), and a green run spent at most 907 s outside them. MEASURED over
the 59 green runs of the `smokes` job from 2026-10-30 through main run 41198565486: the job took 995-1591 s (the
slowest, run 41189804819, was a main push) and the gated step 378-704 s. `budget` in the pin models a green run as 907 s
plus 7.5 s a row (that covers every push run measured, at 79-96 rows) and holds three things:

- The job's limit is at least 600 s over a modelled green run and at most twice it. It is 45 minutes (2700 s): 1109 s
  over the slowest run seen, where 30 minutes left 209 s. Today a runner 1.5 times slower than that run (2386 s) would
  still finish; the pin itself holds 600 s.
- A check that runs to its limit leaves the checks after it room. The gated step's 25 minutes on top of the 907 s
  outside it is 2407 s, 293 s under the limit; any other check's limit goes on top of a whole green run.
- The gated step's limit is at least 1.5 times its modelled time. 25 minutes is 2.1 times the step's slowest green run
  and holds 133 rows; the job's margin lasts to 159 rows. The pin fails one row later, at 134 and at 160: measure
  again, then raise the limits, or move the gated tests into their own job.

Only the list is modelled. The 907 s grew from 629 s in the week to 2026-10-31 (the worker smokes and the auth throttle
script grew), and the pin cannot see that: measure it again whenever a green run comes within 600 s of the limit.

A split into two jobs would shorten the critical path (this job is the longest of the CI jobs in every run: 995-1591 s
against 584-927 s for e2e and 579-1017 s for lint and unit tests) but repeats the setup, services included (54 s median,
62 s at most), conflicts with every open change to the GATED list and adds a job name, so a raise was chosen.

A check that is not a `smoke:ci` chain has its own `timeout-minutes`, set well above its slowest green run (MEASURED over
the same runs): the Postgres-gated tests 378-704 s (25 minutes), the auth throttle script 90-149 s (10 minutes), the
other five Redis scripts at most 10 s (5 minutes). The recovery re-drive script came later and has no CI runs yet: 6 s
locally (5 minutes, as its siblings). Repo refresh retries has a separate five-minute Redis check,
using database 5 so its queue cleanup cannot reach another check's jobs. A new such check gets a limit
the same way.

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

A check that is not a `smoke:ci` chain also has a `timeout-minutes`. A step that reaches it fails (the runner ends it
as failed, not cancelled, so `!cancelled()` stays true) and the checks after it still run; without one a hang burns
the job's limit and cancels them.

The gated step runs as the runner's default `bash -e {0}`: its `set -uo pipefail` adds -u and pipefail and leaves -e
on, so a failed web-kit build, modules build or `gen-modules` ends the step before any gated file runs.

Four more jobs have the same shape, with the id of their last setup step in the guard: `compose-boot` (`runtime`; its
three cleanup steps keep `always()`, `failure()`, `always()`), `schema-parity` (`build`), the web checks of
`production-images` (`build`; the guard also keeps `&& matrix.service == 'web'`) and `macos-preflight` in
`.github/workflows/platform-checks.yml` (`checkout`). Only `e2e` and `lint-typecheck-test` keep the default condition:
`e2e` is one pipeline ending in cleanup steps, and `lint-typecheck-test` would hold its red verdict until its slowest
check ends if guarded.

`scripts/test/ci-step-independence.test.mjs` pins the setup steps of each of the five jobs (a new one is added to its
`setup` list), the exact guard on every check, the cleanup conditions of `compose-boot`, that the `production-images`
matrix still has the `web` leg and no `exclude`, and that nothing in the jobs sets `continue-on-error`, which would
leave a failed step green or let the checks run after a failed setup step. It also pins that no step of the five jobs
(cleanup steps excepted) swallows a command failure (see Workflow scanners). For the `smokes` job it also pins that
every check that is not a `smoke:ci` chain has a `timeout-minutes` of whole minutes, that the Redis databases do not
clash, and the job's limits (`budget`, see Limits): a modelled green run grows with the rows of the GATED list, so the
pin fails when the list outgrows the gated step's limit or the job's. `scripts/test/run-smokes.test.mjs` pins the
runner and that every `smoke:ci` goes through it.

## Workflow scanners

`scripts/test/workflow.mjs` is the one YAML reader of the workflow pins (`ci-step-independence`, `ci-gated-loop`,
`ci-browser-budget`). It uses Prettier's YAML parser, fails on a duplicate key and keeps scalars as strings, so
indentation and comments cannot satisfy a pin. `ci-gated-loop.test.mjs` runs the real gated step script of `ci.yml`
against stubbed `docker` and `pnpm` over a three-row fixture list.

`scripts/test/shell-source.mjs` is a test-only lexical scan of a step's `run` script, used by `ci-step-independence`
for two things: `swallowedFailure` (a command failure that does not fail the step) and `redisDatabases` (the Redis
URLs a check uses). It is not a shell parser and it never runs the script.

- It blanks `${{ }}` expressions and reads comments, quotes, `$()`, backticks, `${}` and arithmetic. Quoted text is
  masked for the failure scan and visible to the Redis URL scan. Each substitution and each `sh -c` or `bash -c`
  string is scanned as a code part of its own, because what ends a script is judged for each part.
- A heredoc needs a quoted delimiter and is classified by the command that consumes it: `cat`, `tee`, `read` and
  `done` take data (inert); `python3`, `node` and `psql` are interpreters (the body supplies Redis URLs only); `bash`,
  `sh`, `dash`, `ksh` and `zsh` take code (scanned).
- It throws, naming the step and the command, instead of guessing: an unquoted heredoc delimiter, a pipe after a
  heredoc operator, an unclassified heredoc consumer, an unterminated quote, heredoc, expansion or expression, `eval`,
  `ssh`, `source` or `.`, `su ... -c`, a pipe or here-string into a shell, and `case` inside a substitution. A new
  workflow shape that trips one of these needs the scanner extended or the script reshaped, not a pin skipped.
- It flags `|| true`, `|| :`, `|| exit 0`, `|| (exit 0)`, `; :`, `&& true` followed by more commands, `set +e`,
  `set +o errexit` and a bare `true` outside the body of a construct.

Limits, which the pins do not cover: a script written to a file and run later, a shell whose name is built at run time,
shell text inside a `${{ 'literal' }}` expression, text returned to a shell (`bash -c "$(cat <<'EOF' ... EOF)"` or
`bash < <(cat <<'EOF' ... EOF)`), `bash -ce` and `sh -ce` (a `c` followed by another flag), `su -lc`, `ssh` spelled
with a path (`/usr/bin/ssh`), and an escaped space before `#` (read as a comment). No workflow script has any of these
today.

The Redis rule in `checkRedisIsolation`: the job-wide `REDIS_URL` (database 0), the databases of the gated step and
each later check need distinct literal databases; a Redis URL whose database is not a literal number fails the pin. The
databases are the `*_REDIS_URL` values in `ci.yml`; read them there. A clash fails the pin naming both steps (main's
recovery re-drive script and the usage-auth script both sat on database 8 until it caught them), and a new Redis check
takes a database no other step uses.
