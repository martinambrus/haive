---
name: smoke-key-by-name-not-line
description: "smoke runners must read CONFIG_ENCRYPTION_KEY from ci.yml by NAME — a line-number sed silently passed an empty key after main's ci.yml grew"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 3813bbf6-9261-4b06-870d-404ed90866bb
  modified: 2026-10-14T18:37:02.450Z
---

Read the smoke encryption key from `.github/workflows/ci.yml` by name, never by line number, and fail loudly when it is missing:
`K=$(sed -n 's/.*CONFIG_ENCRYPTION_KEY: *//p' .github/workflows/ci.yml | head -n 1); [ -n "$K" ] || exit 2`.

**Why:** session 3813bbf6's runners (`rr.sh`, `smoke_tail.sh`, `smoke_full.sh`) used `sed -n '130s/…//p'`. On 2026-10-14 main's ci.yml moved the key from line 130 to 148, the runners passed an EMPTY key, and every smoke still passed, so nothing flagged it. A Sonnet builder on B3.1b-1 caught it. It is the CLAUDE.md "invariants, not ephemeral values" rule: a line number is ephemeral.

**How to apply:** any new scratch runner copies the by-name form. When a smoke result is evidence, check that the runner logged a non-empty key.
