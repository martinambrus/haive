---
name: node26-filehandle-gc-is-fatal
description: 'A FileHandle reclaimed without an explicit close is a fatal ERR_INVALID_STATE on Node 26, and vitest then reports every test passing while still exiting 1'
metadata:
  node_type: memory
  type: project
  originSessionId: e62dac9c-0a5b-41ca-8f3f-eaec5bb75d8c
  modified: 2026-09-17T06:57:45.524Z
---

`fh.createReadStream()` DOES close its FileHandle when the stream ends or is destroyed —
`Readable.toWeb(...)` read to completion or cancelled included. It leaks only when the stream
is created and then neither consumed nor destroyed, and on Node 26 a FileHandle reclaimed by
the collector is a FATAL `ERR_INVALID_STATE`: "A FileHandle object was closed during garbage
collection."

MEASURED on node v26.7.0, fd tracked through `/proc/self/fd`: fully consumed → closed;
`destroy()` mid-read → closed; created and never read → STILL OPEN and the process dies;
`toWeb` then `cancel()` → closed; `toWeb` read to end → closed. One collector error across the
five cases, from the abandoned one alone.

**Why:** the signature is what makes this expensive to diagnose. In vitest every test PASSES and
the run still exits 1 — `342 files / 4670 passed | 5 skipped`, then `Errors 1 error` — because
the collector raises it outside any test, so vitest attributes it to "the last test to run
before this error" and names a file that may be entirely innocent. It cost a CI round trip on
PR #132: `runExtractStdin` piped an archive into a tool that exited early, and the broken pipe
left the stream neither ended nor destroyed.

**How to apply:** where a FileHandle's stream might not be consumed — a child process that can
exit first, an early return, an error path — use `autoClose: false` plus `await fh.close()` in a
`finally`, and destroy the stream there too. Do NOT add that to a handle handed to a consumer
which reads or cancels it: the api's `c.body(Readable.toWeb(fh.createReadStream()))` in
`routes/tasks/files.ts` and `routes/tasks/attachments.ts` is correct as written (measured), and
closing behind Hono would truncate the response. And when a suite goes red with every test
green, read the `Errors` line rather than the test list.

Related: [[haive_pr_workflow]], [[ci_uid_differs_from_dev_host]], [[gh_run_watch_exit_status_lies]].
