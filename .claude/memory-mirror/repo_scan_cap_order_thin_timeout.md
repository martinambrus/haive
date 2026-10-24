---
name: repo-scan-cap-order-thin-timeout
description: 'repo-scan-cap-order.test.ts timed out at 5007ms under full-suite load; CONFIRMED and fixed with an explicit 30s timeout'
metadata:
  node_type: memory
  type: project
  originSessionId: db976326-79c1-4b6d-a36f-0b838f225222
  modified: 2026-09-20T17:07:54.824Z
---

**CONFIRMED and FIXED on 2026-09-20** (PR #182, commit `c83758c7`): given an explicit 30s
timeout.

`packages/worker/test/repo-scan-cap-order.test.ts`'s symbol case failed twice in full-suite runs
and never in isolation. The first failure could not be diagnosed because that run's output had
been filtered to a summary line; the second was captured by a verify wrapper that tees the whole
log, and it said exactly what the hypothesis here predicted:

    Error: Test timed out in 5000ms.   (duration 5007ms)

MEASURED alone on the dev host it takes **1432ms**, and the repo has **no vitest config at all**,
so `testTimeout` is the **5000ms** default. It attempts reads for more paths than the symbol cap
admits — that volume IS the thing under test and cannot shrink — so inside 353 files on parallel
forks the 3.5x margin does not hold.

**How to apply:** the lesson that generalises is not about this test. Never filter a verification
run down to its summary line: a failure you cannot name is a failure you cannot diagnose, and the
first occurrence here cost a full round of guessing. Tee the log, print the summary, and print
the failing lines on a non-zero exit. See [[found-not-fixed-running-list]].
