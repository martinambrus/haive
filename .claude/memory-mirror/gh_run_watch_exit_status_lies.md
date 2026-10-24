---
name: gh-run-watch-exit-status-lies
description: "`gh run watch --exit-status` can exit 0 on a FAILED run AND exit 1 having seen no job at all (403 rate limit) — read the run's own conclusion field against the full sha instead, and never read a composite script's exit code as a verdict"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 2b1fbf37-d87b-4176-887f-b36f6fcb247b
  modified: 2026-09-21T20:32:25.707Z
---

Never conclude "CI passed" from `gh run watch <id> --exit-status` exiting 0, and never from the
✓ marks in its output. MEASURED on 2026-09-04, run `33877091705`: the watch exited **0** with
every job line showing ✓, while the run's actual conclusion was **`failure`** — `End-to-end
smokes` had failed, and the watch output I read was the tail of a _different_, later-finishing
job. `gh run list` showed `[FAIL]` for the same run at the same moment.

Read the run's own verdict instead:

```bash
gh api repos/<owner>/<repo>/actions/runs/<id> --jq '{status,conclusion}'
gh api repos/<owner>/<repo>/actions/runs/<id>/jobs --jq '.jobs[] | .name+" -> "+(.conclusion//"pending")'
```

A run is green only when `status` is `completed` AND `conclusion` is `success`. To wait, poll
that first command in a background loop until `status == completed` rather than blocking on
`gh run watch`.

**Why:** a multi-job workflow finishes its jobs out of order, so the watch's trailing output and
its exit code do not describe the run as a whole. Reporting a red build as green is worse than
not checking at all — it hands the user a false all-clear and sends the next change onto a
broken main. `conclusion` is the documented API contract; the CLI's exit code and its ✓ glyphs
are presentation, and presentation is the wrong thing to key on.

**How to apply:** in the watch-CI step of [[haive-ship-cycle]], resolve the run id for the
commit you just pushed (`gh api .../actions/runs --jq '.workflow_runs[] | select(.head_sha=="<sha>")'`),
poll the run's `status`/`conclusion`, then report the per-job conclusions. On `failure`, go to
`gh run view <id> --log-failed` and investigate before saying anything about the outcome.

## `gh run list --commit` needs the FULL 40-char SHA

MEASURED 2026-09-09 on gh 2.92.0, commit `1d8024f4124e476c08625b956e22a963cd5f3adc`: with the
abbreviated sha the filter matched NOTHING and exited 0 —

```bash
gh run list --commit 1d8024f4 --json databaseId --jq 'length'   # -> 0
gh run list --commit "$(git rev-parse HEAD)" --json ...          # -> both runs
```

— while `gh run list --limit 8 --json headSha,...` showed two completed successful runs on that
very sha at the same moment. A poll loop keyed on the short sha therefore reports nothing for the
full timeout and then dies with "Monitor timed out", which reads exactly like a CI system that
never triggered.

**How to apply:** always pass `$(git rev-parse HEAD)`, never `git log --oneline`'s short form, and
treat "zero runs found" as a QUERY failure to disprove — cross-check with an unfiltered
`gh run list --limit N` before reporting anything about whether CI ran.

## An UNFILTERED `gh run list` hands you the previous commit's success

The mirror of the section above, and the more dangerous one: the query returns rows, they say
`success`, and they are not yours.

MEASURED 2026-09-09, right after pushing `d13a4b19`: a poll loop built on
`gh run list --branch main --limit 5` with no sha predicate emitted `CI: success` /
`Push on main: success` within seconds. Those were `cb24f6e9`'s runs. Mine were still
`in_progress` — visible only once `headSha` was printed alongside:

```
d13a4b19  CI            status=in_progress  conclusion=
cb24f6e9  CI            status=completed    conclusion=success   <- what the loop reported
```

I told the user CI had passed. It had not.

**Why:** a branch listing is ordered by recency, not by relevance, and the previous commit's runs
are almost always green and already finished — so the wrong answer arrives FIRST and looks exactly
like the right one. Zero results at least fail loudly; this fails silently and confidently.

**How to apply:** every CI poll must carry the sha as a predicate AND print it back, so the check
is visible in the output rather than assumed:

```bash
SHA=$(git rev-parse HEAD)
gh run list --branch main --limit 15 --json name,status,conclusion,headSha,url \
  | jq -c --arg s "$SHA" '[.[] | select(.headSha==$s)]'
```

Then require BOTH: no run for that sha still non-`completed`, and no run whose `conclusion` is
anything but `success` — and emit an explicit verdict line naming the sha, never a bare
"success". This repo runs TWO workflows per push (`CI` and `Push on main`), so a single green
conclusion is never the answer; wait for the set. See [[haive-ship-cycle]].

## A sha typed from memory matches nothing, and a watch keyed on it never exits

MEASURED 2026-09-16: I completed the short sha `83388db0` by hand into a 40-char string for the
watch script; the real head was `83388db0313a…`. The poll found no run for it, `continue`d every
45 s, hit the tool's 120 s foreground limit, was moved to the background and would have polled
forever — it had to be stopped by hand. The same shape as the short-sha section above, with the
same silent-zero symptom, and no query can catch it because the sha LOOKS complete.

**How to apply:** a sha reaches a command only by `git rev-parse HEAD` in that same command, or
pasted from a tool output that printed it in full. Never type one, never extend one.

## `cancelled` is not `failure` — this repo cancels its own in-progress runs

MEASURED 2026-09-12 on PR #92: a poll loop of mine reduced the verdict to
`[ "$conclusion" = success ] && exit 0 || exit 1`, so it reported run `34697335982` as a
failure. The run's actual conclusion was **`cancelled`**, and only ONE of its five jobs was —
`Lint, Typecheck, Unit Tests`, `End-to-end smokes`, `docker compose up (fresh-host boot)` and
`Schema parity` had all already succeeded; `End-to-end (Playwright)` was killed mid-flight the
moment I pushed a follow-up commit.

**Why:** `.github/workflows/ci.yml` sets `concurrency: { group: ci-${{ github.ref }},
cancel-in-progress: true }`. Any push to the same branch cancels the previous run — so
pushing twice in a row is the NORMAL way to see a `cancelled`, and it means "superseded",
not "broken". Collapsing every non-`success` conclusion into one failure branch turns a
routine second push into a false red, which costs exactly the same trust as the false green
the rest of this file is about.

**How to apply:** branch on the conclusion by name — `success` green, `cancelled` → find the
newer run for the newer sha and watch THAT, anything else red — and always print the per-job
conclusions before calling a run failed, because a cancelled run's other jobs usually carry
the real signal.

## A watcher that scrapes a printed TABLE dies on its own deadline

MEASURED 2026-09-17 on PR #149: my poll loop counted rows with `grep -c -E '^[^\t]+\tpending'`
over `gh pr checks <pr>` output, and required at least one matched row before concluding. In this
environment that command answers with a SUMMARY block instead of the tab table —

```
CI Checks Summary:
  [ok] Passed: 9
  [FAIL] Failed: 0
```

— so both counts matched ZERO, the exit condition was never met, and the loop ran to its
40-minute deadline and exited 3. All nine checks had passed ~25 minutes earlier; the script's own
timeout dump printed every one of them as `pass`. An exit 3 from my own timeout reads exactly like
a CI system that never finished, which is the trap.

**Why:** the text table is PRESENTATION, and presentation here is reformatted or summarized (the
same class as [[rtk-docker-logs-summarized]]). `--json` is the contract. This is the opening
section's lesson one layer out: there the ✓ glyphs and exit code were the wrong thing to key on,
here it is the whole table.

**How to apply:** poll `gh run list --commit "$(git rev-parse HEAD)" --json
databaseId,workflowName,event,status,conclusion` and decide with `jq` on the `status`/`conclusion`
fields — never a grep of a printed table — alongside the full-sha rules above. And when a watcher
reports a TIMEOUT, read its dump before saying anything about CI: the verdict is usually already
in there, as it was here.

## 40 minutes is too short a deadline for haive's main branch

MEASURED 2026-09-17 on main at `ab37316f`: `Perform CodeQL Analysis` (javascript-typescript) sat
in ONE step for ~52 minutes and then **succeeded**, while the 13 preceding CodeQL runs on main
that day ran 3m38s-15m53s end to end and the same job took 1m38s on the PR's own branch. The
correct JSON watcher above therefore timed out at 40m and exited 3 — which reads exactly like a CI
system that died, on a commit whose `CI|push` run had already gone green.

**Why:** this repo runs `CI` and `CodeQL` per push, and the CodeQL analysis has no useful upper
bound — a single step can outlast the whole `CI` workflow by 45 minutes without failing.

**How to apply:** give a watcher 75m+ for a main-branch push, pass the deadline as an argument
rather than hardcoding it, and treat a timeout as "still running", never as a verdict. Cancelling
and rerunning the stalled run is outward-facing on main, so it is the user's call rather than a
reflex — waiting was the right answer here. See [[haive-ship-cycle]].

## A watcher can exit 1 having seen NOTHING — two of them exhaust the REST quota

MEASURED 2026-09-21 on PR #192: two `gh run watch` processes (one on `CI`, one on the CodeQL
run), each polling `/actions/runs/<id>/jobs?per_page=100` every 60 s on top of a session's worth
of `gh` calls, consumed the 5,000-request hourly core quota. Both exited **1** within a second of
each other, and each output file held exactly ONE line:

```
failed to get jobs: HTTP 403: API rate limit exceeded for user ID <id>
```

No job had reported anything. I told the user both watchers had FAILED, which reads as a red
build; what had failed was my own monitoring. `gh api /rate_limit` is EXEMPT from the limit and
answered `core: 5000/5000` one minute later — the hourly window had simply rolled over, and the
403s had landed in its last 60 seconds.

**How to apply:** arm ONE watcher per push, on the gating run only (`CI`), at `--interval 120`,
and read the second workflow's conclusion once at the end with a single
`gh run list --commit "$(git rev-parse HEAD)"`. When a watcher exits non-zero, read its OUTPUT
FILE before saying anything about CI — a 403 there, like a `cancelled` conclusion, is not a
failing build. If `gh` starts answering 403, check `gh api /rate_limit --jq '.resources.core'`
first: it costs nothing and names the reset time.

## `GET /rate_limit` LIES about `core` on this account — read the response headers instead

MEASURED 2026-09-21, three times in one session. After Actions calls started answering
`HTTP 403: API rate limit exceeded for user ID <id>`, `gh api /rate_limit` reported
`core: 5000/5000 used=0` with a reset exactly one hour out — the signature of a freshly rolled
window — so I twice concluded the quota had reset and proceeded. Both times the very next call was
refused again. The per-request headers told the truth:

```
HTTP/2.0 403 Forbidden
X-Ratelimit-Resource: core
X-Ratelimit-Limit: 5000
X-Ratelimit-Used: 5000
X-Ratelimit-Remaining: 0
X-Ratelimit-Reset: 1790008708
```

Same bucket name, opposite answer. So `/rate_limit`'s resource map is not a usable signal here,
even though it is the endpoint documented for exactly this question and is itself exempt from the
limit.

**How to apply.** To learn whether you are throttled and when it clears, make ONE cheap real
request with `gh api -i <endpoint>` and read `X-Ratelimit-Remaining` / `X-Ratelimit-Reset` /
`X-Ratelimit-Used` from the headers. Never decide from `gh api /rate_limit`. Convert the reset
epoch with `date -u -d @<n>` and wait past it rather than retrying into 403s — each refused call
still costs a request. And what exhausts 5,000 in an hour is not one thing: it is `gh run watch`
polling `/actions/runs/<id>/jobs?per_page=100` every 60-120s (~10-20 calls per CI run, per
watcher) stacked on every `gh pr view` / `gh run list` / `gh run view` across several PRs. Arm ONE
watcher per push at most, or better, wait for a known reset and probe once.

## A trailing command in my own script owns the exit code

MEASURED the same day: a background script ran the worker suite, then the shared suite, then
`echo "BOTH SUITES DONE"`. The harness reported **exit code 0** — the echo's. A failing vitest in
the middle would have been invisible, and I had armed that script precisely to catch one. The
verdict came from the JSON reports instead (`numFailedTests`, `success`, and zero
`"status":"failed"` occurrences), which also correctly classified a level-40 `pgvector
unavailable` warn as a fixture's own stub rather than a failure.

**How to apply:** never end a verification script with an unconditional command, and never read a
composite script's exit code as a verdict — give each runner `--outputFile` and grep the counts.
The same lesson as the top of this file, one layer out: an exit code describes the last thing that
ran, not the thing you wanted to know. Related: [[node26-filehandle-gc-is-fatal]], where vitest
reports every test passing and still exits 1.

**A Monitor that polls `gh` can expire having emitted NOTHING, and that is not a verdict either.**
MEASURED 2026-09-20: a 30-minute watch on main's merge commit delivered zero events, while the
runs it was watching had finished GREEN before it was even armed. `gh` itself was the problem —
the same `gh run list` took over 5 minutes in the foreground — so every poll hit the script's own
`|| continue` and the watch aged out in silence. A poll loop that swallows failures cannot tell
"no run" from "no answer", so ALWAYS confirm the run state with one direct query before reporting
either, and never read an empty watch as a missing or failing run.

## My OWN json poller called a 403 blob green — require a POSITIVE reading

MEASURED 2026-09-21, and this is the worst shape yet because the script was written to avoid every
trap above. It polled `/commits/<sha>/check-runs --jq '.check_runs[] | .name + "=" + (.conclusion //
.status)'` and decided with `grep -q -E 'IN_PROGRESS|QUEUED|PENDING|=$'` — "settled when nothing is
pending". The response was `HTTP 403: API rate limit exceeded`, so the payload held an error object
and NO pending marker, the loop broke on poll 1, and it printed:

```
SETTLED after poll 1
=== failures, if any ===
none
```

I had armed it to read main's CI on a merge commit. It reported green having seen zero checks.

**Why:** absence of a pending marker is not evidence of success — the same error as reading an absent
mask as an allowed path. Every rule above says "key on the contract, not the presentation", and an
error body is neither: it is a third state the predicate did not model. Note the exit code was 0 too,
because the last command was a `grep || echo`.

**How to apply:** a CI poller must require a POSITIVE reading before concluding anything — count the
lines that actually carry a terminal conclusion, and require `total > 0 && settled == total`:

```bash
SETTLED=$(grep -c -E '=(success|failure|cancelled|timed_out|action_required|startup_failure|neutral|skipped|stale)$' "$OUT")
TOTAL=$(grep -c '=' "$OUT")
[ "$TOTAL" -gt 0 ] && [ "$SETTLED" -eq "$TOTAL" ] && echo SETTLED
```

Anything else — an error payload, an empty list, a job still running — keeps polling and PRINTS what
it received, so a refusal can never be mistaken for a pass. And when a watcher does finish, read its
output file rather than its exit status.

**The same trap has a second door: the VERDICT LINE.** MEASURED 2026-09-21, third false negative of
one session. A watcher guarded its check-runs poll exactly as above and then read Codex's comments
with `gh api ... --jq '...' --arg head "$SHA"`, which `gh` REFUSES — `accepts 1 arg(s), received 4`,
because `gh api --jq` takes no `--arg` (that is `jq` proper). The error text landed where the comment
list should have been, and the next line printed unconditionally:

```
accepts 1 arg(s), received 4
(nothing between the markers above = no finding against this commit)
```

A reviewer had in fact raised nothing that round, but the script could not have known — and it was one
`&&` away from merging on a query that never ran. **Guard every interpretation line on the query's own
exit status**, not on the absence of matches in its output:

```bash
if gh api ... --jq '...' >"$OUT" 2>&1; then OK=yes; else OK=no; fi
[ "$OK" = yes ] && [ "$(grep -c '=' "$OUT")" -gt 0 ] || echo "VERDICT: UNKNOWN, the query failed"
```

**The fourth flavour is a false RED, and I wrote it into a watcher the same evening I wrote the rule
down.** MEASURED 2026-09-21: three merges landed on main within minutes (`b7625480`, `17ca9100`,
`8ce572a1`), and my watcher on the first printed `VERDICT: FAILURES above` for a run whose every
non-success line was `cancelled` — because its classifier was
`grep -E '=(failure|cancelled|timed_out|…)$'`. `cancel-in-progress` on `ci-<ref>` means each push
killed the previous run; the two CodeQL analyses, which sit outside that concurrency group, both
succeeded, which is the tell. So: separate the two branches, and say SUPERSEDED rather than red —

```bash
if grep -E '=(failure|timed_out|action_required|startup_failure)$' "$OUT"; then echo FAILURES
elif grep -q '=cancelled$' "$OUT"; then echo "SUPERSEDED — watch the NEWER sha"
else echo green; fi
```

A false red costs the same trust as a false green and sends you investigating a diff that is fine.
See [[ci-cancelled-run-is-not-red]] for the original measurement; the lesson here is that knowing the
rule did not stop me re-implementing the bug, so the check belongs in the script rather than in my
head.

**And never `sed -i` a script that is currently RUNNING.** Bash reads a script incrementally from the
file, so an in-place edit shifts the byte offset under the running interpreter and it executes
garbage from the middle of a line. Fixing the `--arg` bug in two live watchers that way corrupted
both and they had to be killed by PID (`ps -ef | grep '[w]atch-199.sh' | awk '{print $2}' | xargs
kill` — never `pkill -f`, which matches the calling shell's own argv). Write a NEW file name instead.
