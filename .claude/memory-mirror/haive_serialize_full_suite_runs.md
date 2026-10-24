---
name: haive-serialize-full-suite-runs
description: 'Every full test-suite run on this host takes one host-wide lock, flock /tmp/haive-full-suite.lock; parallel suites from several sessions saturated 8 cores and produced false timeouts'
metadata:
  node_type: memory
  type: feedback
  originSessionId: 3813bbf6-9261-4b06-870d-404ed90866bb
  modified: 2026-10-17T12:53:48.866Z
---

Run every full test-suite run on this host under one host-wide lock:
`flock -w 1800 /tmp/haive-full-suite.lock <command>`.

**Why:** the user approved it on 2026-10-09, after the tests bundle (#465). Several sessions and their
builders ran full vitest suites and Playwright at the same time. Load reached 36-100 on 8 cores with swap
exhausted, about 15 unrelated tests timed out (git-merge, sync-bounds, credential-scan,
plan-mirror-integrate and others) although each passed alone, and unchanged e2e specs failed 5 of 10.
Every false red cost a rerun and tokens.

**How to apply:**

- A full suite is a repo-wide or whole-package vitest run (`pnpm test`, `pnpm --filter <pkg> test`, any
  `--shard=i/n`), a full Playwright project (`pnpm test:e2e`, or more than a few specs), or the queue
  smokes (`smoke:ci`, `smoke:all`). Single test files, `pnpm typecheck` and `pnpm format:check` stay
  unlocked.
- A foreground tool call dies at 10 minutes, wait included. Shard the worker suite so each hold stays
  short, or run the locked command in the background. Shard with
  `pnpm --filter @haive/worker exec vitest run --shard=i/6` (MEASURED 2026-10-17: 109 files, 45 s).
  `pnpm --filter @haive/worker test -- --shard=i/6` does NOT shard: each of six "shards" ran all 653
  files (326-340 s each), holding the lock ~34 min instead of ~6.
- `flock` timing out exits 1 with no test output. That means busy: try again. Never run the suite
  unlocked instead.
- Copy the rule into every builder brief that runs a full suite (the /sonnet-sonnet and /opus-opus briefs). Tell a
  running session by message, because its loaded MEMORY.md is a snapshot.
- Measured 2026-10-09: `/usr/bin/flock` is util-linux 2.39.3; a contended `-w 1` exits 1, and the
  lock frees when its holder exits.

Related: [[haive-opus-sonnet-workflow]], [[found-not-fixed-running-list]].
