---
name: typecheck-with-package-script
description: "A package's `tsc -p .` leaves test/ out; CI's `pnpm typecheck` uses tsconfig.typecheck.json, which includes it — a smoke's type errors reached CI twice"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 3813bbf6-9261-4b06-870d-404ed90866bb
  modified: 2026-09-24T17:36:55.206Z
---

Typecheck with the package script (`pnpm --filter @haive/worker typecheck`) or the root
`pnpm typecheck`, never `npx tsc --noEmit -p .` inside a package.

**Why:** `packages/worker/tsconfig.json` excludes `test/`; the `typecheck` script runs
`tsconfig.typecheck.json`, which includes `src/**/*` AND `test/**/*`. On PR #270 (2026-09-24) the
new `upgrade-claims-smoke.ts` passed `tsc -p .` locally and failed CI's Typecheck step on two
pushes (optional `detect`, apply args missing `iteration`/`previousIterations`, a `Logger<never>`
where StepContext wants `ReturnType<typeof logger.child>`). Unit tests never see a smoke either —
vitest does not load `*-smoke.ts`.

**How to apply:** before any push that touches a test or smoke file, run `pnpm typecheck` (what CI
runs, turbo across the workspace) and read `Tasks: N successful, N total`. In a smoke's
StepContext, pass `logger: log.child({...})` inline so inference widens the level type, call
`step.detect!(ctx)`, and give apply `{ detected, formValues, iteration: 0, previousIterations: [] }`.
Related: [[own-post-step-verification]].
