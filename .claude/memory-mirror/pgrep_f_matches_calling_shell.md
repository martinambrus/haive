---
name: pgrep-f-matches-calling-shell
description: "`pgrep -f <name>` inside a Bash tool call matches that call's own shell command line, so an exited process reads as still running"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 6d68d1e2-9a2b-4dab-ab87-0b40403cee4c
  modified: 2026-10-01T06:45:04.660Z
---

`pgrep -f creds-once.cjs` in a `bash -c` command that also mentions the file name matches the shell
running it. MEASURED 2026-09-13: a one-shot server logged "served once, exiting" while `pgrep -f`
reported it running; `ps -eo pid,args | grep '[n]ode .*creds-once\.cjs'` showed no such process.

**Why:** a false "still running" invites killing by pattern, and `pkill -f` with the same pattern
kills the calling shell instead — so every command chained after it in that call silently never
runs (MEASURED 2026-09-18: exit 144, and a `curl` probe plus an `rm` after it were both skipped).

**How to apply:** check liveness with `ps -eo pid,args | grep '[n]ame'` (the bracket stops the
pattern matching its own text), or by a PID captured when the process was started. To STOP one,
`kill` the PIDs that listing printed, or TaskStop a harness background task; never `pkill -f`.
Repeated 2026-10-01 while stopping a PR watcher: exit 144 again, and the `gh pr edit` chained
after it never ran.

**A captured PID can be the wrong one too: `$!` after `setsid nohup cmd &` is `setsid`'s.**
MEASURED 2026-09-13: `setsid` forks and exits at once, so a `kill -0 $!` loop reported a CI
watcher dead within seconds while it kept running for 25 minutes. Match the running process by
its own arguments instead (`ps -eo args | grep -q '[s]hip-watch\.py 95'`).
