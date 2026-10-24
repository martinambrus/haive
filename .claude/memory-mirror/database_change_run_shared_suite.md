---
name: database-change-run-shared-suite
description: a change in @haive/database needs the shared suite too; shared tests pin database lock keys
metadata:
  node_type: memory
  type: feedback
  originSessionId: 3813bbf6-9261-4b06-870d-404ed90866bb
  modified: 2026-10-14T08:33:39.860Z
---

A `packages/database/src` change must be checked with the `@haive/shared` suite as well as database, api and worker. `packages/shared/test/plan-merge-revive-lock.test.ts` pins the exact advisory-lock keys `checkRevive` takes. On #670 r28 (2026-10-14) I skipped shared and CI went red.

**Why:** shared depends on database and its tests use the fake db's `beforeLock` hook to pin the exact lock order.

**How to apply:** after any database edit, run the shared, database, api and worker suites. Related: [[worker-convention-guards]].
