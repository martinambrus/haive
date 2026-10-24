---
name: vitest-isolate-false-not-viable
description: 'vitest prints a `~11.7s faster with isolate: false` hint on every run; taking it breaks 45 tests across 12 files via shared module singletons'
metadata:
  node_type: memory
  type: project
  originSessionId: 2473f5d2-6a97-4fce-a7e5-4309d4590db1
  modified: 2026-09-09T22:19:46.425Z
---

Do NOT act on the `isolate: false` hint vitest prints at the end of every worker suite run
("808 modules were evaluated 3530 times · ~11.69s faster with isolate: false"). MEASURED
2026-09-09 on the worker suite, same shuffle seed both arms so file order was not a variable:

| arm                                                    | wall | result                               |
| ------------------------------------------------------ | ---- | ------------------------------------ |
| `--sequence.shuffle --sequence.seed=1111`              | 63s  | 300 files, 4041 passed               |
| `--no-isolate --sequence.shuffle --sequence.seed=1111` | 26s  | **12 files failed, 45 tests failed** |

The speedup is real and far bigger than the hint claims (59%, not 11.7s). It is also
irrelevant: dropping isolation shares one module registry per worker, and this suite leans
hard on module-level state.

Failure classes, all leakage rather than flakiness: `db.select is not a function` (9),
`Cannot read properties of undefined (reading 'args')` (7, shared `vi.fn()` state), timeouts
(5), `expected false to be true` (4), `...(reading 'stdio')` (2, spawn mock), guidance/terseness
prompt-body assertions (2), and `ConfigService not initialized. Call initialize() first.` —
the singleton in `packages/shared/src/config/config.service.ts`.

Failing files: `_rag-embed-health`, `08-phase-5-verify`, `_spec-artifact`, `guidance-context`,
`runner-browser-cdp`, `runner-stdin-prompt`, `secret-mask-resolve`, `secret-mask-scan-failure`,
`spawn-interactive`, `step-runner-park-fold`, `terseness-context`, `wrapper-probe-missing-key`
— i.e. exactly the module-singleton-heavy ones.

**Why:** there is no vitest config file in this repo at all (no `vitest.config.*`, no
`vite.config.*`); every package just runs `vitest run` on defaults. So the hint looks like a
free config win, and the only thing standing between it and a merge is having run the
experiment.

**How to apply:** if the ~37s ever becomes worth chasing, the work is refactoring those 12
files off shared singletons/mocks — not a config flag. Re-measure with a fixed
`--sequence.seed` on both arms, or file order confounds the comparison. Related:
[[haive-host-build-restarts-worker]] for why to use
`pnpm --filter @haive/worker exec vitest run` rather than `pnpm test` while a task is live.
